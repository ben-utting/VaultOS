#!/usr/bin/env node
'use strict';
// Browser scenarios for the spreadsheet grid in Files mode, driven with puppeteer against the sheet preview
// container (vault-sheet-preview, 127.0.0.1:7690) — never the live board.
//
//   node scripts/sheet-e2e.js [base-url] [--matrix | --viewport=desktop|phone --theme=dark|sepia] E1 [E2 …]
//
// base-url defaults to http://127.0.0.1:7690. Each scenario's main run uses one viewport × theme "cell": by
// default desktop (1600×1000) in the dark theme; --viewport/--theme pick another; --matrix runs the main run
// in all four (desktop and a 390×844 touch phone, dark and sepia), with the cell in front of every check.
// The scenarios' own extra passes (a sepia look, the phone's taps and double-taps) run once, in the
// desktop/dark cell.
//
// Needs the puppeteer and Chrome already on this box (paths below; puppeteer is ESM-only, so it is loaded with a
// dynamic import, which works from Node 18). It resets the preview vault to its synthetic pristine copy first,
// so it is safe to run repeatedly. The session cookie comes from $SHEET_COOKIE or the preview's mint-cookie.js and
// is never printed. Every check prints a PASS/FAIL line; the exit code is 1 when any check failed. Screenshots
// (dark and sepia, 1600×1000 and a 390×844 phone) go to /tmp/sheet-shots/.
//
// Files are opened the way a person does it: the Files button, the name typed into the search box, a click on
// the result.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PREVIEW = '/opt/vault/sheet-preview';
const SHOTS = '/tmp/sheet-shots';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

// The preview vault's synthetic files (scripts/sheet-sandbox.js), all under Sandbox/.
const FILES = {
  actions: 'Environment Build Action List.xlsx',   // F4 = Open (CF red), F5 = Closed; merged bands across A:G
  signoff: 'svc-spp-linux - InfoSec Sign-off Pack.xlsx', // 4 frozen rows; 4 visible sheets + hidden "Lists"
  linux: 'linux.xlsx',                               // 1 frozen column, 14 wide columns, 80 rows
  csv: 'servers.csv',
  unreadable: 'RVTools_export_all.xlsx',             // ExcelJS can't load it
  charts: 'Chart Pack.xlsx',                         // view-only (charts)
  formulas: 'Mimecast_User_Access_Export.xlsx',      // D22 = =SUM(D2:D21); row ops blocked (formulas)
};

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:7690').replace(/\/$/, '');
const SCENARIOS = args.filter((a) => !/^https?:\/\//.test(a) && !a.startsWith('--'));
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
// The viewport × theme cells the main runs go through (theme 'light' is the app's name for sepia).
const CELLS = args.includes('--matrix')
  ? [{ phone: false, theme: 'dark' }, { phone: false, theme: 'light' }, { phone: true, theme: 'dark' }, { phone: true, theme: 'light' }]
  : [{ phone: flag('viewport') === 'phone', theme: flag('theme') === 'sepia' ? 'light' : 'dark' }];
let CELL = CELLS[0];
const cellTag = () => `${CELL.theme === 'light' ? 'sepia' : 'dark'}-${CELL.phone ? 'phone' : 'desktop'}`;
const baseCell = () => !CELL.phone && CELL.theme === 'dark';
const tagged = CELLS.length > 1 || !baseCell();

let failures = 0;
const failed = [];
function check(name, ok, detail) {
  const label = tagged ? `[${cellTag()}] ${name}` : name;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  if (!ok) { failures++; failed.push(label); }
}
// One block of checks; an exception fails it without stopping the rest of the scenario.
async function part(name, fn) {
  try { await fn(); } catch (err) { check(name, false, String(err && err.message || err).split('\n')[0]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookies() {
  const header = (process.env.SHEET_COOKIE || execFileSync('node', [path.join(PREVIEW, 'mint-cookie.js')], { encoding: 'utf8' })).trim();
  return header.split(/;\s*/).filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
  });
}

// A fresh browser context per session: empty localStorage, so the app opens on the Board with no Files tabs.
// `storage`: more localStorage to start with ({ key: value }, values as the app stores them: JSON).
async function session(browser, { theme = CELL.theme, phone = CELL.phone, storage = {} } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(phone ? PHONE : { ...DESKTOP, deviceScaleFactor: 1 });
  await page.setCookie(...cookies());
  await page.evaluateOnNewDocument((t, more) => {
    try {
      if (!localStorage.getItem('vaultboard.theme')) localStorage.setItem('vaultboard.theme', t);
      for (const [k, v] of Object.entries(more)) if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
    } catch { /* */ }
  }, theme, storage);
  const errors = [];
  page.on('pageerror', (err) => { errors.push(String(err.message).split('\n')[0]); console.log('  page error:', errors[errors.length - 1]); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  return { context, page, phone, errors };
}

// The app's own theme setting (Settings → Appearance does the same two things).
async function setTheme(page, theme) {
  await page.evaluate((t) => { PREF.theme = t; applyPrefs(); }, theme);
  await sleep(100);
}

async function tapOrClick(s, selector) {
  if (s.phone) await s.page.tap(selector); else await s.page.click(selector);
}
// The mode buttons: the header's on a desktop, the bottom tab bar's on a phone (it clicks the header's twin).
const modeBtn = (s, mode) => (s.phone ? `#mobile-nav [data-for="mode-${mode}"]` : `#mode-${mode}`);

// Files button → type the name into the search box → click the result.
async function openFile(s, name) {
  const { page } = s;
  if (await page.$eval('#files-view', (el) => el.classList.contains('hidden'))) {
    await tapOrClick(s, modeBtn(s, 'files'));
    await page.waitForSelector('#files-view:not(.hidden)');
  }
  await page.$eval('#search', (el) => { el.value = ''; });
  await page.type('#search', name);
  const hit = `#fx-tree .fx-row[data-path="Sandbox/${name}"]`;
  await page.waitForSelector(hit, { timeout: 8000 });
  if (s.phone) {
    await page.tap('#fx-side-toggle');
    await sleep(450);   // the drawer slides in
  }
  await tapOrClick(s, hit);
  await page.waitForFunction((p) => {
    const tab = document.querySelector('#fx-tabs .fx-tab.active');
    if (!tab || tab.dataset.path !== p) return false;
    return !!document.querySelector('#fx-view .sg-table, #fx-view .sg-big, #fx-view .fx-binary, #fx-view .fx-source, #fx-view .fx-image, #fx-view .fx-doc');
  }, { timeout: 10000 }, 'Sandbox/' + name);
  // On a phone the tree is a drawer that slides away after the pick; until it has, it covers the file bar's left.
  if (s.phone) await page.waitForFunction(() => document.querySelector('.fx-side').getBoundingClientRect().right <= 0, { timeout: 3000 });
  await sleep(150);   // frozen panes are measured after layout
}

const cell = (r, c) => `#fx-view .sg-table tr[data-r="${r}"] > td[data-c="${c}"]`;
// A main run's shots are named …-dark-desktop; in another cell they take that cell's name instead (…-main on a
// phone, so they don't overwrite the touch passes' own …-phone shots).
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name.replace(/-dark-desktop$/, '-' + cellTag() + (CELL.phone ? '-main' : '')) + '.png') });
const style = (page, sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop);
const rect = (page, sel) => page.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return { top: b.top, left: b.left }; });
const nameBox = (page) => page.$eval('#fx-view .sg-name', (el) => el.textContent.trim());
async function scrollGrid(page, { top, left }) {
  await page.$eval('#fx-view .sg-scroll', (el, t, l) => {
    if (t !== undefined) el.scrollTop = t;
    if (l !== undefined) el.scrollLeft = l;
  }, top, left);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
// The active cell's box against the scroll box: `free` is where unfrozen cells can be seen (below the column
// letters and any frozen rows, right of the row numbers and any frozen columns, inside the scrollbars).
async function activeBox(page) {
  return page.evaluate(() => {
    const sc = document.querySelector('#fx-view .sg-scroll');
    const act = sc.querySelector('td.sg-act');
    const s = sc.getBoundingClientRect();
    const head = sc.querySelector('thead th.sg-corner').getBoundingClientRect();
    const a = act.getBoundingClientRect();
    return { name: document.querySelector('#fx-view .sg-name').textContent, top: a.top, bottom: a.bottom, left: a.left, right: a.right,
      headBottom: head.bottom, rnRight: head.right, scrollTop: sc.scrollTop, scrollLeft: sc.scrollLeft,
      viewBottom: s.top + sc.clientHeight, viewRight: s.left + sc.clientWidth };
  });
}
const fullyVisible = (b) => b.top >= b.headBottom - 0.5 && b.bottom <= b.viewBottom + 0.5 && b.left >= b.rnRight - 0.5 && b.right <= b.viewRight + 0.5;

async function clickTab(page, i) {
  // A toast (bottom centre) can sit over the sheet tabs on a phone: put it away first, as a person would wait.
  await page.evaluate(() => document.getElementById('toast').classList.add('hidden'));
  const tabs = await page.$$('#fx-view .sg-tabs [data-i]');
  await tabs[i].click();
}
// The display text of a block of cells, straight from the API, as tab-separated rows.
async function expectedTsv(page, file, r1, c1, r2, c2) {
  return page.evaluate(async (p, a, b, x, y) => {
    const d = await (await fetch('/api/fs/sheet?path=' + encodeURIComponent(p))).json();
    const cells = d.sheets[0].cells;
    const rows = [];
    for (let r = a; r <= x; r++) {
      const row = [];
      for (let c = b; c <= y; c++) row.push((cells[r + ',' + c] || {}).t || '');
      rows.push(row.join('\t'));
    }
    return rows.join('\n');
  }, 'Sandbox/' + file, r1, c1, r2, c2);
}

// ---------------------------------------------------------------------------------------------------------
// E1 — read-only grid: fills, conditional formats, merges, bold header, frozen panes, sheet tabs, CSV
// Grid | Source, keyboard selection, copy as TSV, keeping its place across a mode switch, phone width.
// ---------------------------------------------------------------------------------------------------------
async function E1(browser) {
  const s = await session(browser);
  const { page } = s;
  const RED = 'rgb(192, 0, 0)';
  // Count grid.suspend() calls: it must run when the view really moves away from a grid, never on a re-render
  // of the same grid (in Task 12 it commits the open edit).
  await page.evaluate(() => {
    window.__suspends = 0;
    const create = SheetGrid.create;
    SheetGrid.create = (...a) => {
      const g = create(...a);
      const suspend = g.suspend;
      g.suspend = () => { window.__suspends++; return suspend(); };
      return g;
    };
  });
  const suspends = () => page.evaluate(() => window.__suspends);

  await part('E1a action list', async () => {
    await openFile(s, FILES.actions);
    await page.waitForSelector(cell(3, 5), { timeout: 5000 });
    check('E1a F4 (Open) has the conditional-format red fill', await style(page, cell(3, 5), 'backgroundColor') === RED,
      await style(page, cell(3, 5), 'backgroundColor'));
    const f5 = await style(page, cell(4, 5), 'backgroundColor');
    check('E1a F5 (Closed) has no red fill — white paper in the dark theme', f5 === 'rgb(255, 255, 255)', f5);
    const span = await page.evaluate(() => {
      const td = [...document.querySelectorAll('#fx-view .sg-table td')].find((el) => el.textContent.trim() === 'Environments');
      return td ? td.getAttribute('colspan') : null;
    });
    check('E1a the "Environments" band is one cell with colspan="7"', span === '7', span);
    const head = await page.$eval(cell(0, 0), (el) => ({ w: getComputedStyle(el).fontWeight, bg: getComputedStyle(el).backgroundColor }));
    check('E1a header row is bold with its theme fill (#c0504d)', head.w === '700' && head.bg === 'rgb(192, 80, 77)', head);
    await shot(page, 'e1-actions-dark-desktop');
  });

  await part('E1b sign-off pack', async () => {
    await openFile(s, FILES.signoff);
    const tabs = await page.$$eval('#fx-view .sg-tabs [data-i]', (els) => els.map((el) => el.textContent.trim()));
    check('E1b the 4 visible sheet tabs are listed (hidden "Lists" left out)',
      JSON.stringify(tabs) === JSON.stringify(['Summary', 'Access Controls', 'Evidence', 'Sign-off']), tabs);
    await clickTab(page, 1);
    await page.waitForFunction(() => /Access control review/.test((document.querySelector('#fx-view .sg-table') || {}).textContent || ''), { timeout: 3000 });
    check('E1b clicking the 2nd tab renders that sheet', true);
    await clickTab(page, 2);
    await page.waitForFunction(() => /Evidence register/.test((document.querySelector('#fx-view .sg-table') || {}).textContent || ''), { timeout: 3000 });
    await sleep(150);
    const frozen = `#fx-view .sg-table tr[data-r="3"] > td`;
    const loose = `#fx-view .sg-table tr[data-r="30"] > td`;
    const before = await rect(page, frozen);
    const looseBefore = await rect(page, loose);
    await scrollGrid(page, { top: 600 });
    const top = await page.$eval('#fx-view .sg-scroll', (el) => el.scrollTop);
    const after = await rect(page, frozen);
    const looseAfter = await rect(page, loose);
    check('E1b the grid scrolled 600px down', top === 600, top);
    check('E1b frozen row 4 keeps its viewport top', Math.abs(after.top - before.top) <= 1, { before: before.top, after: after.top });
    check('E1b an unfrozen row moved up 600px', Math.abs(looseBefore.top - looseAfter.top - 600) <= 1, { before: looseBefore.top, after: looseAfter.top });
    await shot(page, 'e1-signoff-scrolled-dark-desktop');
  });

  await part('E1c linux', async () => {
    await openFile(s, FILES.linux);
    const a = cell(5, 0), d = cell(5, 3);
    const aBefore = await rect(page, a), dBefore = await rect(page, d);
    await scrollGrid(page, { left: 400 });
    const left = await page.$eval('#fx-view .sg-scroll', (el) => el.scrollLeft);
    const aAfter = await rect(page, a), dAfter = await rect(page, d);
    check('E1c the grid scrolled 400px right', left === 400, left);
    check('E1c frozen column A keeps its left', Math.abs(aAfter.left - aBefore.left) <= 1, { before: aBefore.left, after: aAfter.left });
    check('E1c column D moved 400px left', Math.abs(dBefore.left - dAfter.left - 400) <= 1, { before: dBefore.left, after: dAfter.left });
    await shot(page, 'e1-linux-scrolled-dark-desktop');
    await scrollGrid(page, { left: 0 });
  });

  // Moving with the keyboard inside a frozen column: the active cell must stay in sight, not under the
  // column letters, and ↓ must not scroll further than it needs to.
  await part('E1c frozen column keyboard', async () => {
    await scrollGrid(page, { top: 0, left: 0 });
    await page.click(cell(4, 0));
    for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowDown');
    const down = await activeBox(page);
    check('E1c A5 then ↓×70: A75 is in sight', down.name === 'A75' && fullyVisible(down), down);
    check('E1c ...at the bottom edge, not scrolled past it', Math.abs(down.viewBottom - down.bottom) <= 1, down);
    for (let i = 0; i < 68; i++) await page.keyboard.press('ArrowUp');
    const up = await activeBox(page);
    check('E1c then ↑×68: A7 is in sight, below the column letters', up.name === 'A7' && fullyVisible(up), up);
  });

  await part('E1d csv', async () => {
    await openFile(s, FILES.csv);
    const w = Number(await style(page, cell(0, 0), 'fontWeight'));
    check('E1d CSV first row is bold', w >= 600, w);
    const bg = await style(page, cell(5, 1), 'backgroundColor');
    const appBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('E1d CSV cells sit on the app background (--bg), not white paper', bg === appBg, { cell: bg, app: appBg });
    await shot(page, 'e1-csv-dark-desktop');
    await page.click('#fx-bar .fx-seg button[data-v="source"]');
    await page.waitForSelector('#fx-view .fx-source', { timeout: 3000 });
    const first = await page.$eval('#fx-view .fx-source .ln', (el) => el.textContent);
    check('E1d Source shows the CSV text', first.startsWith('hostname,ip,'), first);
    await page.click('#fx-bar .fx-seg button[data-v="grid"]');
    await page.waitForSelector('#fx-view .sg-table', { timeout: 3000 });
    check('E1d Grid comes back after Source', !!(await page.$(cell(0, 0))));
  });

  await part('E1e keyboard + copy', async () => {
    await page.click(cell(2, 1));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const name = await nameBox(page);
    check('E1e click B3, →, ↓ puts the Name box on C4', name === 'C4', name);
    check('E1e C4 carries the active-cell outline', await page.$eval(cell(3, 2), (el) => el.classList.contains('sg-act')));
    await page.click(cell(2, 1));
    await page.keyboard.down('Shift');
    await page.click(cell(3, 2));
    await page.keyboard.up('Shift');
    await page.evaluate(() => {
      window.__copied = null;
      document.addEventListener('copy', (e) => { window.__copied = e.clipboardData.getData('text/plain'); });
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    await sleep(100);
    const got = await page.evaluate(() => window.__copied);
    const want = await expectedTsv(page, FILES.csv, 2, 1, 3, 2);
    check('E1e B3:C4 then Ctrl+C copies a 2×2 TSV of the display text', got === want, { got, want });
  });

  await part('E1f keeps its place', async () => {
    await page.click(cell(6, 3));
    await scrollGrid(page, { top: 300, left: 20 });
    const before = { top: 300, left: await page.$eval('#fx-view .sg-scroll', (el) => el.scrollLeft), name: await nameBox(page) };
    const s0 = await suspends();
    await tapOrClick(s, modeBtn(s, 'board'));
    await page.waitForSelector('#board-view:not(.hidden)');
    await sleep(200);
    const s1 = await suspends();
    await tapOrClick(s, modeBtn(s, 'files'));
    await page.waitForSelector('#files-view:not(.hidden)');
    await sleep(200);
    const s2 = await suspends();
    check('E1f leaving Files suspends the grid once; coming back does not', s1 === s0 + 1 && s2 === s1, { s0, s1, s2 });
    const back = await page.$eval('#fx-view .sg-scroll', (el) => ({ top: el.scrollTop, left: el.scrollLeft }));
    check('E1f Board and back: same scroll position', back.top === before.top && back.left === before.left, { before, back });
    check('E1f Board and back: same active cell', await nameBox(page) === before.name && await page.$eval(cell(6, 3), (el) => el.classList.contains('sg-act')), await nameBox(page));
    await page.evaluate(() => {
      window.__viewClass = 0;
      new MutationObserver((ms) => { window.__viewClass += ms.length; }).observe(document.getElementById('fx-view'), { attributeFilter: ['class'] });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(800);   // Files rescans on visibilitychange and re-shows the open file
    check('E1f visibilitychange re-render leaves the view\'s class alone (no full-grid relayout)', await page.evaluate(() => window.__viewClass) === 0,
      await page.evaluate(() => window.__viewClass));
    const vis = await page.$eval('#fx-view .sg-scroll', (el) => ({ top: el.scrollTop, left: el.scrollLeft }));
    check('E1f visibilitychange: same scroll position', vis.top === before.top && vis.left === before.left, { before, vis });
    check('E1f visibilitychange: same active cell', await nameBox(page) === before.name, await nameBox(page));
    check('E1f visibilitychange re-renders the same grid without suspending it', await suspends() === s2, { s2, now: await suspends() });
    await page.click('#fx-bar .fx-seg button[data-v="source"]');
    await page.waitForSelector('#fx-view .fx-source');
    check('E1f switching the CSV to Source suspends the grid', await suspends() === s2 + 1, await suspends());
    await page.click('#fx-bar .fx-seg button[data-v="grid"]');
    await page.waitForSelector('#fx-view .sg-table');
  });

  await part('E1g unreadable + view-only', async () => {
    await openFile(s, FILES.unreadable);
    const msg = await page.$eval('#fx-view', (el) => el.textContent);
    check('E1g an unreadable workbook shows the no-preview panel with the reason',
      !!(await page.$('#fx-view .fx-binary')) && /can't read this workbook/.test(msg), msg.trim().slice(0, 120));
    await openFile(s, FILES.charts);
    check('E1g a view-only workbook still draws its grid', !!(await page.$(cell(0, 0))));
  });

  // The render budget, on a made-up 3000 × 20 sheet (the server's 60,000-cell cap) drawn in a box of its own:
  // the first screenful must be on screen well under a second; the rest arrives a batch a frame, and moving
  // to the far corner (Ctrl+End) draws whatever is still missing at once.
  await part('E1h 60,000 cells', async () => {
    const t = await page.evaluate(async () => {
      const R = 3000, C = 20, cells = {};
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cells[r + ',' + c] = { t: r ? `Value ${r}/${c}` : `Head ${c}`, s: r ? 1 : 0 };
      const payload = { path: 'big.xlsx', name: 'big.xlsx', kind: 'xlsx', mtime: 1, size: 1, editable: false, reason: null, backup: null,
        tooLarge: false, csv: null, active: 0, sheets: [{ index: 0, name: 'Big', rowCount: R, colCount: C, cells,
          styles: ['background:#2f5597;font-weight:700;color:#ffffff', 'white-space:pre-wrap;border-right:1px solid #bfbfbf;border-bottom:1px solid #bfbfbf'],
          colWidths: Array(C).fill(110), rowHeights: {}, defaultRowHeight: 20, hiddenRows: [], hiddenCols: [],
          merges: [{ r1: 240, c1: 2, r2: 270, c2: 3 }],   // runs across where the first screenful would end
          frozen: { rows: 1, cols: 1 }, lists: [], cf: [], cfSkipped: 0, readOnly: null, rowOps: null, tooBig: false }] };
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px;display:flex;z-index:100';
      document.body.appendChild(box);
      const t0 = performance.now();
      const grid = SheetGrid.create(payload, {});
      grid.attach(box);
      const spacer = grid.el.querySelector('.sg-spacer');
      const firstEnd = Number(spacer.previousElementSibling.dataset.r);
      const spacerCells = spacer.cells.length;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const first = performance.now() - t0;
      const drawnAtFirst = grid.el.querySelectorAll('tbody tr[data-r]').length;
      grid.el.querySelector('.sg-sink').focus();
      window.__bigGrid = grid;
      window.__bigBox = box;
      return { first: Math.round(first), drawnAtFirst, firstEnd, spacerCells };
    });
    check(`E1h a 60,000-cell sheet shows its first screen in under a second (${t.first} ms, ${t.drawnAtFirst} rows)`, t.first < 1000, t);
    check('E1h ...without drawing every row up front', t.drawnAtFirst < 3000, t.drawnAtFirst);
    check('E1h the first batch runs on to the end of a merge that starts in it (no rowspan into the spacer)',
      t.firstEnd >= 270 && t.spacerCells === 1, t);
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    const end = await page.evaluate(() => {
      const g = window.__bigGrid;
      const out = { name: g.el.querySelector('.sg-name').textContent, act: !!g.el.querySelector('tr[data-r="2999"] > td[data-c="19"].sg-act'),
        spacer: !!g.el.querySelector('.sg-spacer') };
      g.destroy();
      window.__bigBox.remove();
      return out;
    });
    check('E1h Ctrl+End lands on T3000, drawn and outlined', end.name === 'T3000' && end.act && !end.spacer, end);
  });

  if (baseCell()) await part('E1 sepia desktop', async () => {
    await setTheme(page, 'light');
    for (const [key, file] of [['actions', FILES.actions], ['signoff', FILES.signoff], ['linux', FILES.linux], ['csv', FILES.csv]]) {
      await openFile(s, file);
      await shot(page, `e1-${key}-sepia-desktop`);
    }
    await openFile(s, FILES.actions);
    const paper = await style(page, cell(4, 5), 'backgroundColor');
    check('E1 xlsx paper stays white in sepia', paper === 'rgb(255, 255, 255)', paper);
  });
  await s.context.close();

  // A CSV's header row is frozen. In a window narrow enough that servers.csv is wider than its grid (the tree
  // still beside it), tapping/clicking a header cell already in full view must not scroll the grid, and walking
  // along the header with → and back with ← keeps the active cell in view.
  if (baseCell()) await part('E1i frozen header row, narrow window', async () => {
    const n = await session(browser, { theme: 'dark' });
    await n.page.setViewport({ width: 920, height: 900, deviceScaleFactor: 1 });
    await openFile(n, FILES.csv);
    const pg = n.page;
    const wide = await pg.$eval('#fx-view .sg-scroll', (el) => el.scrollWidth - el.clientWidth);
    check('E1i servers.csv is wider than its grid at 920px', wide > 60, wide);
    await scrollGrid(pg, { top: 0, left: 0 });
    const target = await pg.evaluate(() => {
      const sc = document.querySelector('#fx-view .sg-scroll');
      const right = sc.getBoundingClientRect().left + sc.clientWidth;
      const tds = [...sc.querySelectorAll('tr[data-r="0"] > td')].filter((td) => td.getBoundingClientRect().right <= right);
      return Number(tds[tds.length - 1].dataset.c);
    });
    await pg.click(cell(0, target));
    const clicked = await activeBox(pg);
    check(`E1i clicking header cell ${clicked.name} (already in view) leaves the grid where it was`, clicked.scrollLeft === 0 && fullyVisible(clicked), clicked);
    await pg.click(cell(0, 0));
    let worst = null;
    for (let i = 0; i < 9; i++) {
      await pg.keyboard.press('ArrowRight');
      const b = await activeBox(pg);
      if (!fullyVisible(b) && !worst) worst = b;
    }
    const right9 = await activeBox(pg);
    check('E1i A1 then →×9 keeps every header cell in view, ending on J1, scrolled no further than needed',
      right9.name === 'J1' && !worst && Math.abs(right9.viewRight - right9.right) <= 1, worst || right9);
    worst = null;
    for (let i = 0; i < 8; i++) {
      await pg.keyboard.press('ArrowLeft');
      const b = await activeBox(pg);
      if (!fullyVisible(b) && !worst) worst = b;
    }
    const left8 = await activeBox(pg);
    check('E1i then ←×8 keeps them in view, ending on B1', left8.name === 'B1' && !worst, worst || left8);
    await shot(pg, 'e1-csv-header-walk-dark-920');
    await n.context.close();
  });

  for (const theme of baseCell() ? ['dark', 'light'] : []) {
    await part(`E1 phone ${theme}`, async () => {
      const p = await session(browser, { theme, phone: true });
      const tag = theme === 'light' ? 'sepia' : 'dark';
      await openFile(p, FILES.actions);
      await shot(p.page, `e1-actions-${tag}-phone`);
      const pageScroll = await p.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
      check(`E1 phone (${tag}) no horizontal page scroll`, pageScroll.doc <= pageScroll.vw, pageScroll);
      const grid = await p.page.$eval('#fx-view .sg-scroll', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      check(`E1 phone (${tag}) the grid scrolls sideways inside its own box`, grid.sw > grid.cw, grid);
      await p.page.tap(cell(5, 2));
      await sleep(100);
      const focus = await p.page.evaluate(() => {
        const el = document.activeElement;
        return { tag: el && el.tagName, inputmode: el && el.getAttribute('inputmode'), name: (document.querySelector('#fx-view .sg-name') || {}).textContent };
      });
      check(`E1 phone (${tag}) a tap selects the cell without asking for the keyboard (inputmode=none)`,
        focus.name === 'C6' && (focus.tag !== 'TEXTAREA' && focus.tag !== 'INPUT' || focus.inputmode === 'none'), focus);
      await shot(p.page, `e1-actions-tapped-${tag}-phone`);
      const fbar = await p.page.evaluate(() => {
        const shown = (sel) => getComputedStyle(document.querySelector('#fx-view ' + sel)).display !== 'none';
        const bar = document.querySelector('#fx-view .sg-fbar').getBoundingClientRect(), f = document.querySelector('#fx-view .sg-fval').getBoundingClientRect();
        return { name: shown('.sg-name'), fx: shown('.sg-fx'), fval: shown('.sg-fval'), fill: Math.round(f.width) >= Math.round(bar.width) - 1 };
      });
      check(`E1 phone (${tag}) the formula bar is just its content field, full width`, !fbar.name && !fbar.fx && fbar.fval && fbar.fill, fbar);
      await openFile(p, FILES.signoff);
      const tabs = await p.page.$eval('#fx-view .sg-tabs', (el) => ({ ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth }));
      const wide = await p.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      check(`E1 phone (${tag}) the sheet tabs scroll sideways in their own strip (4 tabs, 390px), not the page`, tabs.ox === 'auto' && tabs.sw > tabs.cw && wide, tabs);
      await shot(p.page, `e1-signoff-${tag}-phone`);
      await openFile(p, FILES.csv);
      await shot(p.page, `e1-csv-${tag}-phone`);
      await p.context.close();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// E2 — editing (nothing is saved): the Edit button, typing, lists, strict-list refusal, undo/redo, the row menu,
// paste, F2 caret moves, locked formula cells, blocked row ops, Esc leaving the grid, Ctrl+A from outside it, the
// editor sitting exactly over a cell in a frozen pane, phone double-tap.
// ---------------------------------------------------------------------------------------------------------

// Every grid SheetFiles creates, by path, so a check can read grid.ops() / changeCount(); onChange calls are
// counted per path in __changes, destroy() calls in __destroyed. `noSave` (E2, which saves nothing) swallows the
// grid's Ctrl+S save requests, counting them in __saveRequests.
async function collectGrids(page, { noSave = false } = {}) {
  await page.evaluate((quiet) => {
    window.__grids = {};
    window.__changes = {};
    window.__destroyed = {};
    window.__saveRequests = 0;
    const create = SheetGrid.create;
    SheetGrid.create = (p, o = {}) => {
      const onChange = o.onChange;
      const g = create(p, { ...o,
        onChange: (grid) => { window.__changes[p.path] = (window.__changes[p.path] || 0) + 1; if (onChange) onChange(grid); },
        onRequestSave: quiet ? () => { window.__saveRequests++; } : o.onRequestSave });
      const destroy = g.destroy;
      g.destroy = () => { window.__destroyed[p.path] = (window.__destroyed[p.path] || 0) + 1; return destroy(); };
      window.__grids[p.path] = g;
      return g;
    };
  }, noSave);
}
const gridCall = (page, file, fn, ...args) => page.evaluate((p, f, a) => window.__grids[p][f](...a), 'Sandbox/' + file, fn, args);
const changes = (page, file) => page.evaluate((p) => window.__changes[p] || 0, 'Sandbox/' + file);
const gridOps = (page, file) => page.evaluate((p) => window.__grids[p].ops(), 'Sandbox/' + file);
const textAt = (page, r, c) => page.evaluate((sel) => {
  const td = document.querySelector(sel);
  return td ? td.textContent : null;
}, cell(r, c));
const bgAt = (page, r, c) => style(page, cell(r, c), 'backgroundColor');
const hasClass = (page, sel, cls) => page.$eval(sel, (el, k) => el.classList.contains(k), cls);
// The toast: cleared before an action so a check sees only what that action said.
const clearToast = (page) => page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; t.classList.add('hidden'); });
const toastText = (page) => page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('hidden') ? '' : t.textContent; });
async function editor(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('#fx-view .sg-editor');
    if (!ed || getComputedStyle(ed).display === 'none' || ed.hidden) return { open: false };
    const b = ed.getBoundingClientRect();
    return { open: true, value: ed.value, focused: document.activeElement === ed, start: ed.selectionStart, end: ed.selectionEnd,
      top: b.top, left: b.left, width: b.width, height: b.height,
      inputmode: ed.getAttribute('inputmode'), enterkeyhint: ed.getAttribute('enterkeyhint') };
  });
}
const tdRect = (page, r, c) => page.$eval(cell(r, c), (el) => { const b = el.getBoundingClientRect(); return { top: b.top, left: b.left, width: b.width, height: b.height }; });
const sameRect = (a, b) => ['top', 'left', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
// The editor sits over the cell: exactly, or on a touch screen (where its text is at least 16px, so iOS won't
// zoom) possibly taller than a short row — same top, left and width.
const overCell = (s, e, b) => (s.phone ? ['top', 'left', 'width'].every((k) => Math.abs(e[k] - b[k]) <= 1) && e.height >= b.height - 1 : sameRect(e, b));
async function combo(page, mods, key) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
}
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el || el.hidden) return false;
  const cs = getComputedStyle(el);
  const b = el.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
}, sel);
const menuItems = (page) => page.$$eval('#fx-view .sg-menu button', (els) => els.map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title })));
const rowHead = (r) => `#fx-view .sg-table tr[data-r="${r}"] > th.sg-rh`;
async function clickEdit(s) {
  await s.page.waitForFunction(() => { const b = document.querySelector('#fx-bar #fx-sheet-edit'); return b && !b.disabled; }, { timeout: 5000 });
  await tapOrClick(s, '#fx-bar #fx-sheet-edit');
  await s.page.waitForSelector('#fx-view .sg.sg-editable', { timeout: 3000 });
  await sleep(100);
}
async function pasteText(page, text) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector('#fx-view .sg-sink').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await sleep(50);
}

async function E2(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page, { noSave: true });
  const RED = 'rgb(192, 0, 0)', ORANGE = 'rgb(237, 125, 49)', WHITE = 'rgb(255, 255, 255)';
  const LIST = 'Open, In Progress, Closed';

  await part('E2a view mode + Edit', async () => {
    await openFile(s, FILES.actions);
    await page.click(cell(3, 5));
    await clearToast(page);
    await page.keyboard.press('x');
    await sleep(50);
    check('E2a a key before Edit → toast "Press Edit to change cells"', await toastText(page) === 'Press Edit to change cells', await toastText(page));
    check('E2a ...and the cell is unchanged, no editor', await textAt(page, 3, 5) === 'Open' && !(await editor(page)).open);
    await clickEdit(s);
    check('E2a Edit pins the preview tab', await page.$eval('#fx-tabs .fx-tab.active', (el) => !el.classList.contains('preview')));
    const spare = await page.evaluate(() => ({
      lastRow: !!document.querySelector('#fx-view .sg-table tr[data-r="86"]'),
      pastRow: !!document.querySelector('#fx-view .sg-table tr[data-r="87"]'),
      lastCol: !!document.querySelector('#fx-view .sg-table th.sg-ch.sg-spare[data-c="8"]'),
      pastCol: !!document.querySelector('#fx-view .sg-table th.sg-ch[data-c="9"]'),
      dataCol: document.querySelector('#fx-view .sg-table th.sg-ch[data-c="6"]').classList.contains('sg-spare'),
      dim: !!document.querySelector('#fx-view .sg-table tr[data-r="70"] > th.sg-rh.sg-spare'),
    }));
    check('E2a edit mode draws rowCount + 20 rows and colCount + 2 columns, spare headers dimmed',
      spare.lastRow && !spare.pastRow && spare.lastCol && !spare.pastCol && !spare.dataCol && spare.dim, spare);
  });

  await part('E2a drafts, Alt keys', async () => {
    await page.click(cell(8, 3));
    await combo(page, ['Alt'], '2');
    await sleep(50);
    check('E2a Alt+2 in edit mode opens no editor and leaves the cell as it was', !(await editor(page)).open && await textAt(page, 8, 3) === 'Identity Team'
      && !(await gridCall(page, FILES.actions, 'hasDraft')), await textAt(page, 8, 3));
    const c0 = await changes(page, FILES.actions);
    await page.keyboard.type('d');
    const c1 = await changes(page, FILES.actions);
    check('E2a opening the editor makes a draft and tells onChange', await gridCall(page, FILES.actions, 'hasDraft') === true && c1 > c0, { c0, c1 });
    await page.keyboard.press('Escape');
    const c2 = await changes(page, FILES.actions);
    check('E2a Esc: no draft, onChange told again, nothing changed', await gridCall(page, FILES.actions, 'hasDraft') === false && c2 > c1
      && (await gridOps(page, FILES.actions)).length === 0, { c1, c2 });
  });

  await part('E2b lists', async () => {
    await page.click(cell(3, 5));
    check('E2b F4 (a list cell) shows the ▾ button', await visible(page, '#fx-view .sg-ddbtn'));
    await combo(page, ['Alt'], 'ArrowDown');
    await page.waitForSelector('#fx-view .sg-list', { visible: true, timeout: 2000 });
    const items = await page.$$eval('#fx-view .sg-list [data-item]', (els) => els.map((e) => e.textContent.trim()));
    check('E2b Alt+↓ opens the list with its items', JSON.stringify(items) === JSON.stringify(['Open', 'In Progress', 'Closed']), items);
    await sleep(200);   // the list fades in
    await shot(page, 'e2-list-dark-desktop');
    await page.click('#fx-view .sg-list [data-item="2"]');
    await sleep(50);
    check('E2b picking Closed sets F4 to Closed', await textAt(page, 3, 5) === 'Closed', await textAt(page, 3, 5));
    check('E2b ...the red conditional fill is gone', await bgAt(page, 3, 5) === WHITE, await bgAt(page, 3, 5));
    check('E2b ...F4 is marked changed', await hasClass(page, cell(3, 5), 'sg-changed'));
    check('E2b ...the list closed', !(await visible(page, '#fx-view .sg-list')));
    check('E2b ...one set op with the list spelling', JSON.stringify(await gridOps(page, FILES.actions)) === JSON.stringify([{ op: 'set', sheet: 0, r: 3, c: 5, v: 'Closed' }]),
      await gridOps(page, FILES.actions));

    await page.click(cell(4, 5));
    await page.keyboard.type('closed ');
    const ed = await editor(page);
    check('E2b typing opens the editor over the cell, focused, with what was typed', ed.open && ed.focused && ed.value === 'closed ', ed);
    check('E2b the editor asks phones for a keyboard: enterkeyhint=done, inputmode not none', ed.enterkeyhint === 'done' && ed.inputmode !== 'none', ed);
    await shot(page, 'e2-editor-dark-desktop');
    await page.keyboard.press('Enter');
    check('E2b F5 "closed " + Enter → Closed (same text: no op, not marked)', await textAt(page, 4, 5) === 'Closed'
      && !(await hasClass(page, cell(4, 5), 'sg-changed')) && (await gridOps(page, FILES.actions)).length === 1, await gridOps(page, FILES.actions));
    check('E2b Enter moved down to F6', await nameBox(page) === 'F6', await nameBox(page));
    await page.keyboard.type('in progress');
    await page.keyboard.press('Enter');
    check('E2b F6 "in progress" → In Progress, orange, changed', await textAt(page, 5, 5) === 'In Progress' && await bgAt(page, 5, 5) === ORANGE
      && await hasClass(page, cell(5, 5), 'sg-changed'), { t: await textAt(page, 5, 5), bg: await bgAt(page, 5, 5) });
    await shot(page, 'e2-changed-dark-desktop');

    await clearToast(page);
    await page.keyboard.type('Nope');
    await page.keyboard.press('Enter');
    await sleep(50);
    const refused = await toastText(page);
    check('E2b "Nope" + Enter → toast lists the values', refused === `“Nope” isn't in the list: ${LIST}`, refused);
    const still = await editor(page);
    check('E2b ...the editor stays open with "Nope"', still.open && still.value === 'Nope' && still.focused, still);
    await page.keyboard.press('Escape');
    check('E2b Esc cancels: editor closed, F7 still Open', !(await editor(page)).open && await textAt(page, 6, 5) === 'Open' && await nameBox(page) === 'F7');

    // Keyboard through the list: Alt+↓, ↓ to In Progress, Enter.
    await combo(page, ['Alt'], 'ArrowDown');
    await page.waitForSelector('#fx-view .sg-list', { visible: true, timeout: 2000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(50);
    check('E2b Alt+↓, ↓, Enter on F7 (Open) picks In Progress', await textAt(page, 6, 5) === 'In Progress', await textAt(page, 6, 5));

    await combo(page, ['Control'], 'z');
    await combo(page, ['Control'], 'z');
    await combo(page, ['Control'], 'z');
    await sleep(50);
    const after = { f4: await textAt(page, 3, 5), f6: await textAt(page, 5, 5), f7: await textAt(page, 6, 5), bg: await bgAt(page, 3, 5),
      changed: await page.$$eval('#fx-view .sg-changed', (els) => els.length), name: await nameBox(page) };
    check('E2b Ctrl+Z ×3 → F4 Open and red again, F6 empty, F7 Open, nothing marked',
      after.f4 === 'Open' && after.bg === RED && after.f6 === '' && after.f7 === 'Open' && after.changed === 0, after);
    check('E2b ...and the active cell goes back to F4', after.name === 'F4', after.name);
    await combo(page, ['Control'], 'y');
    await combo(page, ['Control', 'Shift'], 'z');
    await sleep(50);
    check('E2b Ctrl+Y then Ctrl+Shift+Z redo F4 and F6', await textAt(page, 3, 5) === 'Closed' && await textAt(page, 5, 5) === 'In Progress',
      { f4: await textAt(page, 3, 5), f6: await textAt(page, 5, 5) });
    await combo(page, ['Control'], 'z');
    await combo(page, ['Control'], 'z');
    check('E2b ...and undo again leaves no ops', (await gridOps(page, FILES.actions)).length === 0, await gridOps(page, FILES.actions));
  });

  await part('E2c row menu', async () => {
    await page.click(rowHead(2), { button: 'right' });
    await page.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    const items = await menuItems(page);
    check('E2c right-click row 3 → Insert row above / below / Delete row, Copy, Clear contents',
      JSON.stringify(items.map((i) => i.label)) === JSON.stringify(['Insert row above', 'Insert row below', 'Delete row', 'Copy', 'Clear contents']), items);
    await sleep(200);
    await shot(page, 'e2-rowmenu-dark-desktop');
    await page.click('#fx-view .sg-menu button[data-act="above"]');
    await sleep(100);
    check('E2c the new row 3 is empty and its number is marked new', await textAt(page, 2, 0) === '' && await hasClass(page, rowHead(2), 'sg-newrow')
      && await textAt(page, 3, 0) === 'Review edge gateway 001', { a3: await textAt(page, 2, 0), a4: await textAt(page, 3, 0) });
    check('E2c one insertRows op, like = the clicked row', JSON.stringify((await gridOps(page, FILES.actions)).slice(-1))
      === JSON.stringify([{ op: 'insertRows', sheet: 0, at: 2, n: 1, like: 2 }]), await gridOps(page, FILES.actions));
    await page.click(cell(2, 5));
    check('E2c the new F3 has the ▾ (the list came with the row)', await visible(page, '#fx-view .sg-ddbtn'));
    const band = await page.$eval('#fx-view .sg-table tr[data-r="1"] > td', (td) => ({ span: td.getAttribute('colspan'), text: td.textContent }));
    check('E2c "Environments" (row 2) is still one merged cell', band.span === '7' && band.text === 'Environments', band);
    await combo(page, ['Control'], 'z');
    await sleep(100);
    check('E2c Ctrl+Z → the row is gone', await textAt(page, 2, 0) === 'Review edge gateway 001' && !(await page.$('#fx-view .sg-newrow')), await textAt(page, 2, 0));

    // A three-row selection pluralises.
    await page.click(rowHead(4));
    await page.keyboard.down('Shift');
    await page.click(rowHead(6));
    await page.keyboard.up('Shift');
    await page.click(rowHead(5), { button: 'right' });
    await page.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    const plural = (await menuItems(page)).map((i) => i.label);
    check('E2c rows 5–7 selected → Insert 3 rows above / below, Delete rows 5–7', plural[0] === 'Insert 3 rows above'
      && plural[1] === 'Insert 3 rows below' && plural[2] === 'Delete rows 5–7', plural);
    await page.keyboard.press('ArrowDown');
    const focusedItem = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
    await page.keyboard.press('Escape');
    check('E2c the menu takes ↓ and closes on Esc', !!focusedItem && !(await visible(page, '#fx-view .sg-menu')), focusedItem);
  });

  await part('E2d paste, F2, clear', async () => {
    await page.click(cell(5, 1));
    await pasteText(page, 'a\t"multi\nline"\r\nb\tc');
    const got = [await textAt(page, 5, 1), await textAt(page, 5, 2), await textAt(page, 6, 1), await textAt(page, 6, 2)];
    check('E2d paste at B6 → B6 a, C6 multi⏎line, B7 b, C7 c', JSON.stringify(got) === JSON.stringify(['a', 'multi\nline', 'b', 'c']), got);
    await page.click(cell(5, 2));
    await page.keyboard.press('F2');
    const e1 = await editor(page);
    await page.keyboard.press('ArrowLeft');
    const e2 = await editor(page);
    check('E2d F2 on C6 keeps the text; ← moves the caret inside the editor',
      e1.open && e1.value === 'multi\nline' && e1.start === 10 && e2.open && e2.start === 9 && await nameBox(page) === 'C6', { e1, e2 });
    await page.keyboard.press('Escape');
    // Delete clears the selection in one group; Ctrl+Z puts it back.
    await page.click(cell(5, 1));
    await page.keyboard.down('Shift');
    await page.click(cell(6, 2));
    await page.keyboard.up('Shift');
    const n0 = (await gridOps(page, FILES.actions)).length;
    await page.keyboard.press('Delete');
    const cleared = [await textAt(page, 5, 1), await textAt(page, 5, 2), await textAt(page, 6, 1), await textAt(page, 6, 2)];
    check('E2d Delete clears B6:C7', cleared.every((t) => t === ''), cleared);
    await combo(page, ['Control'], 'z');
    check('E2d ...and one Ctrl+Z restores all four', await textAt(page, 5, 1) === 'a' && await textAt(page, 6, 2) === 'c'
      && (await gridOps(page, FILES.actions)).length === n0, await gridOps(page, FILES.actions));
    // A save in flight: undo stops at its checkpoint; edits after it can still be undone; opsSince = those.
    const mark = await gridCall(page, FILES.actions, 'checkpoint');
    await page.click(cell(9, 3));
    await page.keyboard.type('After the mark');
    await page.keyboard.press('Enter');
    const since = await gridCall(page, FILES.actions, 'opsSince', mark);
    await combo(page, ['Control'], 'z');
    const afterOne = { d10: await textAt(page, 9, 3), since: (await gridCall(page, FILES.actions, 'opsSince', mark)).length };
    await clearToast(page);
    const n1 = (await gridOps(page, FILES.actions)).length;
    await combo(page, ['Control'], 'z');
    const paused = { toast: await toastText(page), n: (await gridOps(page, FILES.actions)).length, b6: await textAt(page, 5, 1) };
    await gridCall(page, FILES.actions, 'release', mark);
    check('E2d checkpoint: opsSince is the later edit; undoing it is allowed', JSON.stringify(since) === JSON.stringify([{ op: 'set', sheet: 0, r: 9, c: 3, v: 'After the mark' }])
      && afterOne.d10 === 'Ops Team' && afterOne.since === 0, { since, afterOne });
    check('E2d ...but undo below the mark says "Saving… undo is paused" and does nothing', paused.toast === 'Saving… undo is paused' && paused.n === n1 && paused.b6 === 'a', paused);
    const rp = await gridCall(page, FILES.actions, 'replay', [{ op: 'set', sheet: 7, r: 0, c: 0, v: 'gone' }]);
    check('E2d replay() of an op for a sheet that is gone reports it skipped', JSON.stringify(rp) === JSON.stringify({ applied: 0, skipped: 1 }), rp);
    // One value pasted over Ctrl+A fills the data, not the spare rows/columns.
    const before0 = (await gridOps(page, FILES.actions)).length;
    await page.click(cell(4, 4));
    await combo(page, ['Control'], 'a');
    await pasteText(page, 'filled');
    const fill = { last: await textAt(page, 66, 6), spareRow: await textAt(page, 70, 0), spareCol: await textAt(page, 4, 7),
      cc: await gridCall(page, FILES.actions, 'changeCount') };
    await combo(page, ['Control'], 'z');
    check('E2d one value over Ctrl+A fills G67 but not the spare rows/columns; undone in one step', fill.last === 'filled' && fill.spareRow === '' && fill.spareCol === ''
      && (await gridOps(page, FILES.actions)).length === before0, fill);
    // Over 32,767 characters: refused, for a paste and for a commit.
    await page.click(cell(9, 3));
    await clearToast(page);
    await pasteText(page, 'y'.repeat(32768));
    check('E2d pasting a 32,768-character value is refused', await toastText(page) === 'A cell can hold at most 32,767 characters'
      && await textAt(page, 9, 3) === 'Ops Team' && (await gridOps(page, FILES.actions)).length === before0, await toastText(page));
    await page.keyboard.type('z');
    await page.evaluate(() => { const e = document.querySelector('#fx-view .sg-editor'); e.value = 'z'.repeat(32768); e.dispatchEvent(new Event('input')); });
    await clearToast(page);
    await page.keyboard.press('Enter');
    const long = await editor(page);
    check('E2d committing 32,768 characters is refused and the editor stays open', await toastText(page) === 'A cell can hold at most 32,767 characters'
      && long.open && long.value.length === 32768 && (await gridOps(page, FILES.actions)).length === before0, { t: await toastText(page), open: long.open });
    await page.keyboard.press('Escape');
    // Over 20,000 cells: refused, nothing changes.
    const before = (await gridOps(page, FILES.actions)).length;
    await clearToast(page);
    await page.click(cell(20, 0));
    await pasteText(page, Array.from({ length: 201 }, () => Array(100).fill('x').join('\t')).join('\r\n'));
    check('E2d a 201 × 100 paste is refused with the limit toast', await toastText(page) === "That's too much to paste at once (max 20,000 cells)"
      && (await gridOps(page, FILES.actions)).length === before && await textAt(page, 20, 0) !== 'x', await toastText(page));
    // Ctrl+S with the editor open commits it.
    await page.click(cell(7, 3));
    await page.keyboard.type('Ops Team');
    await combo(page, ['Control'], 's');
    check('E2d Ctrl+S in the editor commits the edit (and asks to save)', !(await editor(page)).open && await textAt(page, 7, 3) === 'Ops Team'
      && await page.evaluate(() => window.__saveRequests) === 1, { d8: await textAt(page, 7, 3), asked: await page.evaluate(() => window.__saveRequests) });
    // Typing in the formula bar edits the active cell.
    await page.click(cell(8, 3));
    await page.click('#fx-view .sg-fval');
    await combo(page, ['Control'], 'a');
    await page.keyboard.type('From the bar');
    const mirrored = await editor(page);
    await page.keyboard.press('Enter');
    check('E2d typing in the formula bar shows in the cell editor and Enter commits it',
      mirrored.open && mirrored.value === 'From the bar' && await textAt(page, 8, 3) === 'From the bar', { mirrored, d9: await textAt(page, 8, 3) });
    // A spare column grows the sheet.
    await page.click(cell(2, 7));
    await page.keyboard.type('z');
    await page.keyboard.press('Enter');
    const grown = await page.evaluate(() => ({
      h: document.querySelector('#fx-view .sg-table th.sg-ch[data-c="7"]').classList.contains('sg-spare'),
      j: !!document.querySelector('#fx-view .sg-table th.sg-ch.sg-spare[data-c="9"]'),
    }));
    check('E2d typing in spare column H grows the sheet (H no longer dimmed, J now spare)', await textAt(page, 2, 7) === 'z' && !grown.h && grown.j, grown);
  });

  await part('E2e Esc leaves the grid, Ctrl+A from outside', async () => {
    await page.click(cell(2, 1));
    await page.keyboard.down('Shift');
    await page.click(cell(3, 2));
    await page.keyboard.up('Shift');
    await page.keyboard.press('Escape');
    const one = await page.evaluate(() => ({ sel: document.querySelectorAll('#fx-view .sg-sel').length,
      sink: document.activeElement && document.activeElement.classList.contains('sg-sink') }));
    check('E2e Esc with B3:C4 selected collapses to the active cell, grid keeps focus', one.sel === 0 && one.sink && await nameBox(page) === 'B3', one);
    await page.keyboard.press('Escape');
    const out = await page.evaluate(() => document.activeElement === document.querySelector('#fx-bar button'));
    check('E2e a second Esc leaves the grid for the file bar', out);
    const outside = await page.evaluate(() => !document.activeElement.closest('.sg'));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    const all = await page.evaluate(() => ({
      sink: document.activeElement && document.activeElement.classList.contains('sg-sink'),
      sel: document.querySelectorAll('#fx-view .sg-sel').length,
      // The focused sink always holds one selected space, which getSelection() reports; the page has none.
      page: String(window.getSelection()).trim().length,
    }));
    check('E2e Ctrl+A with the grid unfocused focuses it and selects every cell, not the page', outside && all.sink && all.sel > 400 && all.page === 0, { outside, ...all });
  });

  await part('E2f locked formula cell, blocked row ops', async () => {
    await openFile(s, FILES.formulas);
    await clickEdit(s);
    await page.click(cell(21, 3));
    await clearToast(page);
    await page.keyboard.type('5');
    await sleep(50);
    const t = await toastText(page);
    check('E2f typing on the formula cell D22 → a toast saying why, no editor, value kept',
      /formula/i.test(t) && !(await editor(page)).open && await textAt(page, 21, 3) === '292', { t, d22: await textAt(page, 21, 3) });
    await page.keyboard.press('F2');
    check('E2f F2 on it opens no editor either', !(await editor(page)).open);
    await page.click(cell(20, 3));
    await clearToast(page);
    await pasteText(page, '41\r\n42\r\n');
    check('E2f pasting 2 rows over D21:D22 writes D21 and skips the formula', await textAt(page, 20, 3) === '41' && await textAt(page, 21, 3) === '292'
      && await toastText(page) === '1 locked cell was skipped', { d21: await textAt(page, 20, 3), d22: await textAt(page, 21, 3), t: await toastText(page) });
    await page.click(rowHead(2), { button: 'right' });
    await page.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    const items = await menuItems(page);
    const reason = 'This workbook has formulas, so inserting or deleting rows could break them — do that in Excel';
    check('E2f Insert row above is disabled with the formulas reason', items[0] && items[0].label === 'Insert row above' && items[0].disabled && items[0].title === reason, items[0]);
    check('E2f ...and so are Insert row below / Delete row; Copy is not', items[1].disabled && items[2].disabled && !items[3].disabled, items);
    await page.keyboard.press('Escape');
  });

  // An Excel table's header and totals rows come with the payload's `locked` rectangles (the sandbox has no table,
  // so this one is a made-up payload in a box of its own): typing there explains why, typing in the body edits.
  await part('E2f table header and totals rows', async () => {
    const H = 'That cell is part of an Excel table header — edit it in Excel';
    const T = 'That cell is part of an Excel table totals row — edit it in Excel';
    await page.evaluate((H, T) => {
      const said = [];
      const cells = { '0,0': { t: 'Host' }, '0,1': { t: 'Count' }, '1,0': { t: 'alpha' }, '1,1': { t: '1' }, '2,0': { t: 'Total' }, '2,1': { t: '1' } };
      const payload = { path: 't.xlsx', name: 't.xlsx', kind: 'xlsx', mtime: 1, size: 1, editable: true, reason: null, backup: null,
        tooLarge: false, csv: null, active: 0, sheets: [{ index: 0, name: 'T', rowCount: 3, colCount: 2, cells, styles: [],
          colWidths: [120, 120], rowHeights: {}, defaultRowHeight: 20, hiddenRows: [], hiddenCols: [], merges: [], frozen: { rows: 0, cols: 0 },
          lists: [], cf: [], cfSkipped: 0, readOnly: null, rowOps: 'This sheet has an Excel table, so add or remove rows in Excel', tooBig: false,
          locked: [{ r1: 0, c1: 0, r2: 0, c2: 1, msg: H }, { r1: 2, c1: 0, r2: 2, c2: 1, msg: T }] }] };
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px;display:flex;z-index:100';
      document.body.appendChild(box);
      const grid = SheetGrid.create(payload, { editable: true, toast: (m) => said.push(m) });
      grid.attach(box);
      Object.assign(window, { __tGrid: grid, __tBox: box, __said: said });
    }, H, T);
    const tcell = (r, c) => page.evaluateHandle((r, c) => window.__tBox.querySelector(`tr[data-r="${r}"] > td[data-c="${c}"]`), r, c);
    const state = () => page.evaluate(() => ({ said: window.__said.slice(), changes: window.__tGrid.changeCount(), ops: window.__tGrid.ops() }));
    await (await tcell(0, 1)).click();
    await page.keyboard.type('x');
    await sleep(50);
    const head = await state();
    check('E2f typing on a table header cell → its reason, no change', head.said.includes(H) && head.changes === 0, head);
    await (await tcell(2, 0)).click();
    await page.keyboard.type('x');
    await sleep(50);
    const tot = await state();
    check('E2f typing on the totals row → the totals reason, no change', tot.said.includes(T) && tot.changes === 0, tot);
    await (await tcell(1, 0)).click();
    await page.keyboard.type('beta');
    await page.keyboard.press('Enter');
    await sleep(50);
    const body = await state();
    check('E2f typing in the table body edits it', body.changes === 1 && body.ops.some((o) => o.op === 'set' && o.r === 1 && o.c === 0 && o.v === 'beta'), body);
    await page.evaluate(() => { window.__tGrid.destroy(); window.__tBox.remove(); });
  });

  await part('E2g editor over a frozen column after scrolling', async () => {
    await openFile(s, FILES.linux);
    await clickEdit(s);
    await scrollGrid(page, { top: 300, left: 400 });
    await page.click(cell(25, 0));
    await page.keyboard.press('F2');
    const e = await editor(page);
    const b = await tdRect(page, 25, 0);
    check('E2g F2 on A26 (frozen column, scrolled 400px right) — the editor covers the cell exactly', e.open && overCell(s, e, b), { e, b });
    await shot(page, 'e2-frozen-col-editor-dark-desktop');
    await scrollGrid(page, { top: 340 });
    const e2 = await editor(page);
    const b2 = await tdRect(page, 25, 0);
    check('E2g ...and follows it when the grid scrolls', e2.open && overCell(s, e2, b2), { e2, b2 });
    await page.keyboard.press('Escape');
    // A scrolled cell clear of the frozen column (wholly in view on a desktop; on a phone its left part is
    // enough), double-clicked where it shows.
    const target = await page.evaluate(() => {
      const sc = document.querySelector('#fx-view .sg-scroll');
      const s = sc.getBoundingClientRect();
      const frozen = Math.max(s.left, ...[...sc.querySelectorAll('thead th.sg-fc')].map((th) => th.getBoundingClientRect().right));
      const right = s.left + sc.clientWidth;
      const td = [...sc.querySelectorAll('tr[data-r="27"] > td')].find((x) => {
        const b = x.getBoundingClientRect();
        return Number(x.dataset.c) > 2 && b.left > frozen + 4 && (b.right < right - 20 || (innerWidth < 700 && b.left + 40 < right));
      });
      const b = td.getBoundingClientRect();
      return { c: Number(td.dataset.c), x: (b.left + Math.min(b.right, right)) / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(target.x, target.y, { count: 2 });
    await sleep(50);
    const e3 = await editor(page);
    const b3 = await tdRect(page, 27, target.c);
    check('E2g double-click on a scrolled cell opens the editor exactly over it', e3.open && overCell(s, e3, b3), { e3, b3 });
    await page.keyboard.press('Escape');
  });

  await part('E2g editor over a frozen row after scrolling', async () => {
    await openFile(s, FILES.signoff);
    await clickEdit(s);
    await clickTab(page, 2);
    await page.waitForFunction(() => /Evidence register/.test((document.querySelector('#fx-view .sg-table') || {}).textContent || ''), { timeout: 3000 });
    await sleep(150);
    await scrollGrid(page, { top: 600 });
    await page.click(cell(3, 1));
    await page.keyboard.press('F2');
    const e = await editor(page);
    const b = await tdRect(page, 3, 1);
    check('E2g F2 on B4 (frozen row, scrolled 600px down) — the editor covers the cell exactly', e.open && overCell(s, e, b), { e, b });
    await page.keyboard.press('Escape');
  });

  // Screen readers and the keyboard: the grid's role and name, the cells box's name following the selection
  // (once it stops), the list as a listbox pointed at with aria-activedescendant, the row menu's roving focus,
  // names for every file-bar button, and the focus ring on them.
  await part('E2h accessibility', async () => {
    const gridAttrs = () => page.$eval('#fx-view .sg-table', (t) => ({ role: t.getAttribute('role'), label: t.getAttribute('aria-label'), ro: t.getAttribute('aria-readonly') }));
    const sinkLabel = () => page.$eval('#fx-view .sg-sink', (el) => el.getAttribute('aria-label'));
    await openFile(s, FILES.charts);
    const g0 = await gridAttrs();
    check('E2h a view-only sheet: role="grid", named after its sheet ("Tracker"), aria-readonly', g0.role === 'grid' && g0.label === 'Tracker' && g0.ro === 'true', g0);
    await openFile(s, FILES.actions);   // still in edit mode (E2a)
    const g1 = await gridAttrs();
    check('E2h the sheet being edited: role="grid", named "Action List", not read-only', g1.role === 'grid' && g1.label === 'Action List' && g1.ro === 'false', g1);

    await page.click(cell(3, 5));
    await sleep(400);
    const f4 = await textAt(page, 3, 5);
    check('E2h the cells box is named after the active cell and its text ("F4, Open")', await sinkLabel() === `F4, ${f4 || 'blank'}`, { label: await sinkLabel(), f4 });
    await page.evaluate(() => {
      window.__labels = 0;
      new MutationObserver((m) => { window.__labels += m.length; }).observe(document.querySelector('#fx-view .sg-sink'), { attributeFilter: ['aria-label'] });
    });
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
    await sleep(400);
    const at = await nameBox(page);
    const said = { changes: await page.evaluate(() => window.__labels), label: await sinkLabel(), at };
    check('E2h six quick ↓ presses rename it once, where it stopped, not at every step', said.changes === 1 && said.label.startsWith(at + ', '), said);
    await combo(page, ['Shift'], 'ArrowRight');
    await sleep(400);
    const row = at.slice(1);
    check('E2h a range adds itself ("…, F10 to G10 selected")', (await sinkLabel()).endsWith(`, ${at} to G${row} selected`), await sinkLabel());
    await page.keyboard.press('Escape');

    // The list: a listbox; the keyboard stays in the cells box, which points at the highlighted option.
    await page.click(cell(3, 5));
    await combo(page, ['Alt'], 'ArrowDown');
    await page.waitForSelector('#fx-view .sg-list', { visible: true, timeout: 2000 });
    const listState = () => page.evaluate(() => {
      const sink = document.querySelector('#fx-view .sg-sink'), list = document.querySelector('#fx-view .sg-list'), dd = document.querySelector('#fx-view .sg-ddbtn');
      const hi = list.querySelector('.sg-li.hi');
      return { focused: document.activeElement === sink, role: list.getAttribute('role'), controls: sink.getAttribute('aria-controls') === list.id && dd.getAttribute('aria-controls') === list.id,
        id: sink.getAttribute('aria-activedescendant'), hiId: hi && hi.id, hiRole: hi && hi.getAttribute('role'), hiSel: hi && hi.getAttribute('aria-selected'),
        expanded: dd.getAttribute('aria-expanded'), popup: dd.getAttribute('aria-haspopup'), options: [...list.querySelectorAll('[role="option"]')].length };
    });
    const l0 = await listState();
    if (!l0.id) await page.keyboard.press('ArrowDown');   // nothing highlighted yet (the cell isn't one of the items)
    const l1 = await listState();
    check('E2h the open list is a listbox of options; the focused cells box points at the highlighted one (aria-activedescendant)',
      l1.focused && l1.role === 'listbox' && l1.controls && !!l1.id && l1.id === l1.hiId && l1.hiRole === 'option' && l1.hiSel === 'true'
      && l1.expanded === 'true' && l1.popup === 'listbox' && l1.options === 3, l1);
    await page.keyboard.press('ArrowDown');
    const l2 = await listState();
    check('E2h ↓ moves the pointer to the next option', l2.id === l2.hiId && l2.id !== l1.id, { l1: l1.id, l2: l2.id });
    await page.keyboard.press('Escape');
    check('E2h Esc closes the list and the pointer goes', !(await visible(page, '#fx-view .sg-list'))
      && !(await page.$eval('#fx-view .sg-sink', (el) => el.hasAttribute('aria-activedescendant'))));

    // The row menu: menuitems, roving focus.
    await page.click(cell(4, 1));
    await combo(page, ['Shift'], 'F10');
    await page.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    const menuState = () => page.evaluate(() => {
      const m = document.querySelector('#fx-view .sg-menu');
      const items = [...m.querySelectorAll('button')];
      return { role: m.getAttribute('role'), roles: items.map((b) => b.getAttribute('role')), tabs: items.map((b) => b.getAttribute('tabindex')), focus: items.indexOf(document.activeElement) };
    });
    const m0 = await menuState();
    check('E2h the row menu: role="menu" of menuitems, none a Tab stop, the first one focused', m0.role === 'menu'
      && m0.roles.every((r) => r === 'menuitem') && m0.tabs.every((t) => t === '-1') && m0.focus === 0, m0);
    await page.keyboard.press('ArrowDown');
    check('E2h ↓ moves the focus to the next item (roving focus)', (await menuState()).focus === 1, await menuState());
    await page.keyboard.press('Escape');

    // The file bar: every button has a name; Tab through it shows the focus ring on each (Save and Done too).
    const names = [];
    for (const h of await page.$$('#fx-bar button')) {
      const shown = await h.evaluate((b) => b.getClientRects().length > 0);
      if (!shown) continue;
      const node = await page.accessibility.snapshot({ root: h, interestingOnly: false });
      names.push({ id: await h.evaluate((b) => b.id || b.className), name: node && node.name });
    }
    check('E2h every button in the file bar has an accessible name', names.length >= 7 && names.every((n) => n.name && n.name.trim()), names);
    await page.click(cell(4, 1));
    await page.keyboard.press('Escape');                     // one cell selected: Esc hands the keyboard to the file bar
    const ring = [];
    for (let i = 0; i < 14; i++) {
      const f = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || !a.closest('#fx-bar')) return null;
        const cs = getComputedStyle(a);
        return { id: a.id || a.className, fv: a.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth };
      });
      if (!f) break;
      ring.push(f);
      if (/fx-sheet-save/.test(f.id)) {                       // a look at the ring on the filled Save button
        const r = await page.$eval('#fx-bar', (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
        await page.screenshot({ path: path.join(SHOTS, `e2-focus-save-${cellTag()}.png`), clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 } });
      }
      await page.keyboard.press('Tab');
    }
    check('E2h Tab through the file bar: each button shows the 2px focus ring, the sheet buttons included', ring.length >= 5
      && ring.some((f) => /fx-sheet-save|fx-sheet-done/.test(f.id)) && ring.every((f) => f.fv && f.style === 'solid' && f.width === '2px'), ring);
  });

  // The changed corner on any fill: one of its two tones (gold, near-black edge) has ≥ 3:1 contrast with the cell.
  await part('E2h changed mark on fills', async () => {
    await openFile(s, FILES.actions);
    const before = (await gridOps(page, FILES.actions)).length;
    await typeInto(page, 4, 5, 'Open');            // F5 Closed → Open: the red conditional fill
    await typeInto(page, 5, 5, 'In Progress');     // F6: orange
    await typeInto(page, 3, 3, 'Changed owner');   // D4: white paper
    const marks = await page.evaluate((list) => list.map(([r, c]) => {
      const td = document.querySelector(`#fx-view .sg-table tr[data-r="${r}"] > td[data-c="${c}"]`);
      const cs = getComputedStyle(td);
      // The corner is the first gradient: its opaque colours (Chrome writes "gold 0 7px" as two stops).
      const corner = cs.backgroundImage.split(/,\s*linear-gradient/)[0];
      const tones = [...new Set(corner.match(/rgba?\([^)]*\)/g) || [])].filter((x) => !/,\s*0\)$/.test(x));
      return { cell: String.fromCharCode(65 + c) + (r + 1), changed: td.classList.contains('sg-changed'), fill: cs.backgroundColor, tones };
    }), [[4, 5], [5, 5], [3, 3]]);
    for (const m of marks) m.best = Math.max(...m.tones.map((t) => contrast(m.fill, t))).toFixed(2);
    check('E2h the changed corner has a tone with ≥ 3:1 contrast on red, orange and white', marks.every((m) => m.changed && m.tones.length === 2 && m.best >= 3), marks);
    const r = await page.$eval(cell(4, 5), (el) => { const b = el.getBoundingClientRect(); return { x: b.left - 120, y: b.top - 60, w: b.width + 130, h: b.height * 2 + 70 }; });
    await page.screenshot({ path: path.join(SHOTS, `e2-changed-zoom-${cellTag()}.png`), clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.w, height: r.h, scale: 3 } });
    const n = (await gridOps(page, FILES.actions)).length - before;
    for (let i = 0; i < n; i++) await combo(page, ['Control'], 'z');
  });

  if (baseCell()) await part('E2 sepia desktop', async () => {
    await setTheme(page, 'light');
    await openFile(s, FILES.actions);
    await page.click(cell(9, 5));
    await page.keyboard.type('In Progress');
    await page.keyboard.press('Enter');
    await page.click(cell(10, 5));
    await combo(page, ['Alt'], 'ArrowDown');
    await page.waitForSelector('#fx-view .sg-list', { visible: true, timeout: 2000 });
    await sleep(200);
    await shot(page, 'e2-list-sepia-desktop');
    await page.keyboard.press('Escape');
    await page.keyboard.type('Clo');
    await shot(page, 'e2-editor-sepia-desktop');
    await page.keyboard.press('Escape');
    await page.click(rowHead(12), { button: 'right' });
    await page.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    await sleep(200);
    await shot(page, 'e2-rowmenu-sepia-desktop');
    await page.keyboard.press('Escape');
    check('E2 sepia: the changed cell is marked', await hasClass(page, cell(9, 5), 'sg-changed'));
  });
  await s.context.close();

  for (const theme of baseCell() ? ['dark', 'light'] : []) {
    await part(`E2 phone ${theme}`, async () => {
      const p = await session(browser, { theme, phone: true });
      const tag = theme === 'light' ? 'sepia' : 'dark';
      await openFile(p, FILES.actions);
      await clickEdit(p);
      await p.page.tap(cell(6, 3));
      await sleep(80);
      const kb = await p.page.evaluate(() => ({ tag: document.activeElement.tagName, inputmode: document.activeElement.getAttribute('inputmode') }));
      check(`E2 phone (${tag}) a single tap in edit mode opens no editor and asks for no keyboard (inputmode=none)`,
        !(await editor(p.page)).open && kb.inputmode === 'none', kb);
      await sleep(500);
      await p.page.tap(cell(6, 3));
      await sleep(60);
      await p.page.tap(cell(6, 3));
      await sleep(150);
      const e = await editor(p.page);
      const b = await tdRect(p.page, 6, 3);
      check(`E2 phone (${tag}) a double-tap opens the editor over the cell, focused, with a real keyboard`,
        e.open && e.focused && e.inputmode !== 'none' && e.enterkeyhint === 'done' && sameRect(e, b), { e, b });
      await shot(p.page, `e2-editor-${tag}-phone`);
      await p.page.keyboard.press('Escape');
      await p.page.tap(rowHead(8));
      await sleep(100);
      check(`E2 phone (${tag}) tapping a row number in edit mode opens the row menu`, await visible(p.page, '#fx-view .sg-menu'));
      await sleep(200);
      await shot(p.page, `e2-rowmenu-${tag}-phone`);
      const pageScroll = await p.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
      check(`E2 phone (${tag}) no horizontal page scroll in edit mode`, pageScroll.doc <= pageScroll.vw, pageScroll);
      await p.page.keyboard.press('Escape');

      // Sizes for a finger: the formula bar's text (iOS zooms the page on focusing a box under 16px), the ▾.
      const fval = await p.page.$eval('#fx-view .sg-fval', (el) => parseFloat(getComputedStyle(el).fontSize));
      check(`E2 phone (${tag}) the formula bar's text is at least 16px (no iOS zoom on focus)`, fval >= 16, fval);
      await p.page.tap(cell(3, 5));                            // F4, a list cell
      await sleep(150);
      const dd = await p.page.$eval('#fx-view .sg-ddbtn', (el) => {
        const b = el.getBoundingClientRect();
        const hits = [[b.left + 1, b.top + 1], [b.right - 1, b.bottom - 1]].map(([x, y]) => el.contains(document.elementFromPoint(x, y)));
        return { hidden: el.hidden, w: b.width, h: b.height, hits };
      });
      check(`E2 phone (${tag}) the list ▾ is at least 32 × 32 px, all of it tappable`, !dd.hidden && dd.w >= 32 && dd.h >= 32 && dd.hits.every(Boolean), dd);
      await p.page.tap('#fx-view .sg-ddbtn');
      await sleep(150);
      check(`E2 phone (${tag}) tapping ▾ opens the list`, await visible(p.page, '#fx-view .sg-list'));
      await shot(p.page, `e2-list-${tag}-phone`);
      await p.page.keyboard.press('Escape');

      // A row number in edit mode, on a sheet with short (20px) rows: the row being worked on answers to a band
      // at least 32px tall, so a tap a few px into the row above still gets it; a tap well inside that row doesn't.
      await openFile(p, FILES.csv);
      await clickEdit(p);
      await p.page.tap(cell(8, 2));                            // C9
      await sleep(500);
      const rh = await p.page.$eval(rowHead(8), (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, top: b.top, h: b.height }; });
      await p.page.touchscreen.tap(rh.x, rh.top - 4);
      await sleep(150);
      const rowState = async () => ({ menu: await visible(p.page, '#fx-view .sg-menu'), name: await nameBox(p.page),
        r9: await hasClass(p.page, rowHead(8), 'sg-hsel'), r8: await hasClass(p.page, rowHead(7), 'sg-hsel') });
      const near = await rowState();
      check(`E2 phone (${tag}) a ${rh.h}px row: a tap 4px up, on row 8's number, still opens the menu for row 9`, rh.h < 32
        && near.menu && near.name === 'A9' && near.r9 && !near.r8, { ...near, h: rh.h });
      await shot(p.page, `e2-rowband-${tag}-phone`);
      await p.page.keyboard.press('Escape');
      await p.page.touchscreen.tap(rh.x, rh.top - rh.h / 2 - 3);
      await sleep(150);
      const far = await rowState();
      check(`E2 phone (${tag}) ...and a tap in the middle of row 8's number gets row 8`, far.menu && far.name === 'A8' && far.r8 && !far.r9, far);
      await p.page.keyboard.press('Escape');
      await p.context.close();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// E3–E8 — the save lifecycle. These write to the preview vault (never the real one), so every scenario starts
// from reset.sh; files on disk are read back on the host: .xlsx with the worktree's ExcelJS, .csv as bytes.
// ---------------------------------------------------------------------------------------------------------

const VAULT = (file) => path.join(PREVIEW, 'vault', 'Sandbox', file);
const PRISTINE = (file) => path.join(PREVIEW, 'pristine', 'Sandbox', file);
async function xlsxValues(file, addrs, sheet = 0) {
  const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(VAULT(file));
  const ws = wb.worksheets[sheet];
  return Object.fromEntries(addrs.map((a) => [a, ws.getCell(a).value]));
}
// The UK stamp the Restore confirm shows (this host and its Chrome share a timezone).
function ukStamp(ms) {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

const cookieHeader = () => cookies().map((c) => `${c.name}=${c.value}`).join('; ');

// Request interception: POSTs to the save/restore routes are counted (and their statuses), GETs of
// /api/fs/sheet too; while `holding`, saves and restores wait until release() — a save "in flight" on demand.
// `next` decides the fate of the next save only: 'drop' (the connection dies before it reaches the server),
// 'land-then-drop' (the server writes it, the answer is lost on the way back), 'land-then-reload' (the server
// writes it, and the browser gets only the server's "written, but no payload" answer: saved + reload), or
// { status, error } (a made-up error answer).
async function watchWrites(page) {
  const w = { saves: 0, restores: 0, sheetGets: 0, statuses: [], holding: false, held: [], next: null, landed: [], bodies: [] };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const u = new URL(req.url());
    if (req.method() === 'GET' && u.pathname === '/api/fs/sheet') w.sheetGets++;
    if (req.method() === 'POST' && /^\/api\/fs\/sheet\/(save|restore)$/.test(u.pathname)) {
      if (u.pathname.endsWith('/save')) w.saves++; else w.restores++;
      try { w.bodies.push(JSON.parse(req.postData())); } catch { w.bodies.push(null); }
      const fate = u.pathname.endsWith('/save') ? w.next : null;
      if (fate) {
        w.next = null;
        if (fate === 'drop') { req.abort('connectionreset'); return; }
        if (fate === 'land-then-drop' || fate === 'land-then-reload') {
          fetch(BASE + u.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: req.postData() })
            .then(async (r) => {
              w.landed.push(r.status);
              const d = await r.json();
              if (fate === 'land-then-drop') return req.abort('connectionreset');
              return req.respond({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ path: d.path, name: d.name, kind: d.kind, mtime: d.mtime, size: d.size, saved: true, reload: true }) });
            })
            .catch((err) => { w.landed.push(String(err)); req.abort('connectionreset'); });
          return;
        }
        req.respond({ status: fate.status, contentType: 'application/json', body: JSON.stringify({ error: fate.error }) });
        return;
      }
      if (w.holding) { w.held.push(req); return; }
    }
    req.continue();
  });
  page.on('response', (res) => {
    if (/^\/api\/fs\/sheet\/(save|restore)$/.test(new URL(res.url()).pathname)) w.statuses.push(res.status());
  });
  w.release = () => { w.holding = false; for (const r of w.held.splice(0)) r.continue(); };
  w.waitHeld = async (n = 1) => {
    for (let i = 0; i < 150 && w.held.length < n; i++) await sleep(20);
    return w.held.length >= n;
  };
  return w;
}
// Every dialog (confirm, beforeunload) is recorded and answered with `answer` ('accept' or 'dismiss').
function watchDialogs(page) {
  const d = { list: [], answer: 'accept' };
  page.on('dialog', async (dlg) => {
    d.list.push({ type: dlg.type(), message: dlg.message() });
    if (d.answer === 'accept') await dlg.accept(); else await dlg.dismiss();
  });
  return d;
}
// The spreadsheet buttons in the file bar: { edit, save, done, restore } → { text, disabled, title } or null.
// text: the whole label (textContent); shown: what is on screen (a phone shortens Restore); label: aria-label.
const sheetBar = (page) => page.evaluate(() => {
  const q = (id) => {
    const b = document.getElementById(id);
    return b ? { text: b.textContent.trim(), shown: b.innerText.trim(), label: b.getAttribute('aria-label'), disabled: b.disabled, title: b.title } : null;
  };
  return { edit: q('fx-sheet-edit'), save: q('fx-sheet-save'), done: q('fx-sheet-done'), restore: q('fx-sheet-restore') };
});
// How the file bar sits: the rows (distinct tops) its sheet actions (Grid | Source and the sheet buttons) and its
// file tools take, whether the page scrolls sideways, and the bar's height.
const barLayout = (page) => page.evaluate(() => {
  const tops = (els) => [...new Set(els.map((b) => Math.round(b.getBoundingClientRect().top)))];
  const primary = [...document.querySelectorAll('#fx-bar .fx-seg button, #fx-bar .fx-sheet-btn')];
  const tools = [...document.querySelectorAll('#fx-bar .fx-tools button')];
  const right = (els) => Math.max(...els.map((b) => b.getBoundingClientRect().right));
  return { primary: tops(primary), tools: tops(tools), rows: tops([...primary, ...tools]).length,
    primaryRight: right(primary), toolsLeft: Math.min(...tools.map((b) => b.getBoundingClientRect().left)),
    overflow: document.documentElement.scrollWidth > window.innerWidth, barH: Math.round(document.getElementById('fx-bar').getBoundingClientRect().height) };
});
// Tidy: the sheet actions on one row, the tools on one row — after them on the same row, or on the next.
const tidyBar = (l) => l.primary.length === 1 && l.tools.length === 1 && !l.overflow
  && (l.primary[0] === l.tools[0] ? l.primaryRight <= l.toolsLeft : l.primary[0] < l.tools[0]);
// The accessible name Chrome computes for an element (what a screen reader says).
async function axName(page, selector) {
  const h = await page.$(selector);
  if (!h) return null;
  const node = await page.accessibility.snapshot({ root: h, interestingOnly: false });
  return node ? node.name : null;
}
// WCAG contrast ratio of two CSS rgb()/rgba() colours (alpha ignored: the tones here are opaque).
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
// Every banner button lies wholly inside the file view (none cut off at a phone's edge).
const notesFit = (page) => page.evaluate(() => {
  const v = document.getElementById('fx-view').getBoundingClientRect();
  const out = [...document.querySelectorAll('#fx-view .sg-note button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, l: r.left, r: r.right }; })
    .filter((x) => x.l < v.left - 0.5 || x.r > v.right + 0.5);
  return out.length ? out : true;
});
const isUnsaved = (page, file) => page.$eval(`#fx-tabs .fx-tab[data-path="Sandbox/${file}"]`, (el) => el.classList.contains('unsaved'));
const hasTab = (page, file) => page.evaluate((p) => !!document.querySelector(`#fx-tabs .fx-tab[data-path="${CSS.escape(p)}"]`), 'Sandbox/' + file);
// The banners above the grid: [{ kind, text, acts: [{ act, text }] }].
const notes = (page) => page.$$eval('#fx-view .sg-note', (els) => els.map((el) => ({
  kind: el.dataset.kind, text: el.textContent.replace(/\s+/g, ' ').trim(),
  acts: [...el.querySelectorAll('[data-act]')].map((b) => ({ act: b.dataset.act, text: b.textContent.trim() })),
})));
// A save (or restore) has finished: its toast is up and the Save button isn't busy.
async function settled(page, toastRe = /^Saved$/) {
  await page.waitForFunction((src) => {
    const t = document.getElementById('toast');
    const b = document.getElementById('fx-sheet-save');
    return !t.classList.contains('hidden') && new RegExp(src).test(t.textContent) && !(b && b.textContent.trim() === 'Saving…');
  }, { timeout: 10000 }, toastRe.source);
  await sleep(100);
}
async function typeInto(page, r, c, text, enter = true) {
  await page.click(cell(r, c));
  await page.keyboard.type(text);
  if (enter) await page.keyboard.press('Enter');
}

// E3 — Save: with the editor open, typing while a save is in flight, double Ctrl+S, Done → Restore offered.
async function E3(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const w = await watchWrites(page);

  await part('E3a Save with the editor open', async () => {
    await openFile(s, FILES.actions);
    await clickEdit(s);
    const b0 = await sheetBar(page);
    check('E3a edit mode: Save (nothing to save yet, disabled) and Done take Edit\'s place',
      !b0.edit && b0.save && b0.save.text === 'Save' && b0.save.disabled && b0.done && !b0.done.disabled && !b0.restore, b0);
    const lay = await barLayout(page);
    check('E3a the bar: Save and Done on one row, the file tools together on one row after them, no sideways page scroll', tidyBar(lay), lay);
    await typeInto(page, 3, 5, 'Closed', false);
    const b1 = await sheetBar(page);
    check('E3a a draft alone makes the tab unsaved and enables Save', (await editor(page)).open && await isUnsaved(page, FILES.actions)
      && !b1.save.disabled, { b1, unsaved: await isUnsaved(page, FILES.actions) });
    await shot(page, 'e3-unsaved-dark-desktop');
    await clearToast(page);
    await page.click('#fx-sheet-save');
    await settled(page);
    const disk = await xlsxValues(FILES.actions, ['F4', 'F5']);
    check('E3a the file on disk has F4 = Closed (read back with ExcelJS)', disk.F4 === 'Closed' && disk.F5 === 'Closed', disk);
    const b2 = await sheetBar(page);
    check('E3a toast "Saved", the tab\'s ● gone, Save disabled again', !(await isUnsaved(page, FILES.actions)) && b2.save.disabled && b2.save.text === 'Save', b2);
    check('E3a the grid shows F4 Closed, no longer marked, editor closed, still in edit mode', await textAt(page, 3, 5) === 'Closed'
      && !(await hasClass(page, cell(3, 5), 'sg-changed')) && !(await editor(page)).open && !!(await page.$('#fx-view .sg.sg-editable')));
    check('E3a one POST', w.saves === 1 && w.statuses[0] === 200, { saves: w.saves, statuses: w.statuses });
  });

  await part('E3b typing while a save is in flight', async () => {
    await typeInto(page, 4, 5, 'Open');                      // F5 Closed → Open; the active cell moves to F6
    check('E3b one change: Save (1)', (await sheetBar(page)).save.text === 'Save (1)', await sheetBar(page));
    w.holding = true;
    await clearToast(page);
    await page.click('#fx-sheet-save');
    const held = await w.waitHeld(1);
    const b = await sheetBar(page);
    check('E3b while it saves the button says Saving… and is disabled', held && b.save.text === 'Saving…' && b.save.disabled && b.done.disabled, b);
    await shot(page, 'e3-saving-dark-desktop');
    await typeInto(page, 5, 5, 'In Progress');               // F6, committed while the save waits
    await page.keyboard.type('Closed');                      // F7, left open as a draft
    w.release();
    await settled(page);
    const disk = await xlsxValues(FILES.actions, ['F5', 'F6', 'F7']);
    check('E3b the save wrote F5 and nothing typed after it was sent', disk.F5 === 'Open' && disk.F6 === null && disk.F7 === 'Open', disk);
    check('E3b F6 survived the reload: In Progress, still marked changed (F5 no longer is)', await textAt(page, 5, 5) === 'In Progress'
      && await hasClass(page, cell(5, 5), 'sg-changed') && !(await hasClass(page, cell(4, 5), 'sg-changed')), await textAt(page, 5, 5));
    const ed = await editor(page);
    check('E3b ...the F7 draft is still open with its text', ed.open && ed.value === 'Closed' && await nameBox(page) === 'F7', { ed, at: await nameBox(page) });
    const b3 = await sheetBar(page);
    check('E3b ...and the tab stays unsaved, Save (1) enabled', await isUnsaved(page, FILES.actions) && b3.save.text === 'Save (1)' && !b3.save.disabled, b3);
    await shot(page, 'e3-after-save-dark-desktop');
  });

  await part('E3c double Ctrl+S', async () => {
    await page.keyboard.press('Enter');                      // commit F7; Save (2)
    const n0 = w.saves;
    w.holding = true;
    await clearToast(page);
    await combo(page, ['Control'], 's');
    await w.waitHeld(1);
    await combo(page, ['Control'], 's');
    await sleep(300);
    const during = w.saves - n0;
    w.release();
    await settled(page);
    await sleep(400);
    const disk = await xlsxValues(FILES.actions, ['F6', 'F7']);
    check('E3c Ctrl+S twice quickly → exactly one POST', during === 1 && w.saves - n0 === 1, { during, total: w.saves - n0 });
    check('E3c ...which saved F6 and F7', disk.F6 === 'In Progress' && disk.F7 === 'Closed', disk);
    check('E3c ...and nothing is left unsaved', !(await isUnsaved(page, FILES.actions)) && (await sheetBar(page)).save.disabled);
  });

  await part('E3d Done → Restore', async () => {
    await page.click('#fx-sheet-done');
    await page.waitForFunction(() => !document.querySelector('#fx-view .sg.sg-editable'), { timeout: 3000 });
    const b = await sheetBar(page);
    check('E3d Done leaves edit mode: Edit is back, with Restore previous version beside it',
      b.edit && !b.edit.disabled && b.restore && !b.restore.disabled && b.restore.text === 'Restore previous version'
      && /^Put back the version from \d\d\/\d\d\/\d{4} \d\d:\d\d/.test(b.restore.title) && !b.save && !b.done, b);
    const lay = await barLayout(page);
    check('E3d the bar: Edit and Restore on one row, the file tools together on one row after them, no sideways page scroll', tidyBar(lay), lay);
    const named = await axName(page, '#fx-sheet-restore');
    check(s.phone ? 'E3d on a phone Restore reads just "Restore", and is still named "Restore previous version"'
      : 'E3d Restore reads, and is named, "Restore previous version"',
    named === 'Restore previous version' && b.restore.shown === (s.phone ? 'Restore' : 'Restore previous version'), { named, shown: b.restore.shown });
    check('E3d every save named itself (saveId: 32 hex characters, a new one each time)', w.bodies.length === 3
      && w.bodies.every((x) => x && /^[0-9a-f]{32}$/.test(x.saveId)) && new Set(w.bodies.map((x) => x.saveId)).size === w.bodies.length,
    w.bodies.map((x) => x && x.saveId));
    await shot(page, 'e3-restore-dark-desktop');
  });

  // Ctrl+S from outside the grid (the file bar has the keyboard) saves too.
  await part('E3e Ctrl+S from the file bar', async () => {
    await clickEdit(s);
    await typeInto(page, 7, 5, 'Open');                      // F8 In Progress → Open
    await page.focus('#fx-sheet-done');
    const n0 = w.saves;
    await clearToast(page);
    await combo(page, ['Control'], 's');
    await settled(page);
    check('E3e Ctrl+S with the file bar focused saves (one POST)', w.saves === n0 + 1 && (await xlsxValues(FILES.actions, ['F8'])).F8 === 'Open',
      { saves: w.saves - n0 });
  });
  await s.context.close();

  // When a save goes wrong: an error answer, a connection that dies before the server, and one that dies after the
  // server wrote the file — the last with a row insert, so a save sent twice would show as two rows.
  const c = await session(browser);
  const cp = c.page;
  await collectGrids(cp);
  const cw = await watchWrites(cp);
  const file = FILES.csv;
  const disk = () => fs.readFileSync(VAULT(file), 'utf8');
  const pristine = fs.readFileSync(PRISTINE(file), 'utf8');

  await part('E3f save failures', async () => {
    await openFile(c, file);
    await clickEdit(c);
    await typeInto(cp, 2, 2, 'almalinux');
    // A made-up 422: its message as the toast, the edit kept, undo free again (the checkpoint was released).
    cw.next = { status: 422, error: 'Saving would have lost the comments — nothing was changed' };
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await cp.waitForFunction(() => /nothing was changed/.test(document.getElementById('toast').textContent), { timeout: 5000 });
    await sleep(100);
    check('E3f a 422 → its message as a toast; the edit stays unsaved, nothing written', await toastText(cp) === 'Saving would have lost the comments — nothing was changed'
      && (await sheetBar(cp)).save.text === 'Save (1)' && await isUnsaved(cp, file) && disk() === pristine, await toastText(cp));
    await cp.click(cell(10, 0));
    await clearToast(cp);
    await combo(cp, ['Control'], 'z');
    const undone = { c3: await textAt(cp, 2, 2), toast: await toastText(cp) };
    await combo(cp, ['Control'], 'y');
    check('E3f ...and undo works again (the save\'s checkpoint was released)', undone.c3 === 'rhel' && undone.toast === '' && await textAt(cp, 2, 2) === 'almalinux', undone);

    // The connection drops before the server sees it: the file is looked at, it hasn't changed, so: try again.
    cw.next = 'drop';
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await cp.waitForFunction(() => /wasn.t saved/.test(document.getElementById('toast').textContent), { timeout: 8000 });
    await sleep(100);
    check('E3f a dropped connection that never reached the server → "It wasn\'t saved — press Save to try again", still unsaved',
      await toastText(cp) === "It wasn't saved — press Save to try again" && await isUnsaved(cp, file) && !(await sheetBar(cp)).save.disabled
      && disk() === pristine && (await notes(cp)).length === 0, { t: await toastText(cp), notes: await notes(cp) });

    // Now insert a row too, and lose the answer after the server has written it.
    await cp.click(rowHead(3), { button: 'right' });
    await cp.waitForSelector('#fx-view .sg-menu', { visible: true, timeout: 2000 });
    await cp.evaluate(() => [...document.querySelectorAll('#fx-view .sg-menu button')].find((b) => b.textContent.trim() === 'Insert row below').click());
    await typeInto(cp, 4, 0, 'srv-new');
    check('E3f a row inserted and filled: Save (3)', (await sheetBar(cp)).save.text === 'Save (3)', await sheetBar(cp));
    cw.next = 'land-then-drop';
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await settled(cp);
    const once = disk();
    check('E3f answer lost after the write: the server names our save as the file\'s last write → "Saved", nothing left unsaved',
      cw.landed[0] === 200 && !(await isUnsaved(cp, file)) && (await sheetBar(cp)).save.disabled && (await notes(cp)).length === 0, { landed: cw.landed, notes: await notes(cp) });
    check('E3f ...the file has the new row once, and the edit', once.split('\n').filter((l) => l.startsWith('srv-new')).length === 1
      && /srv-002,10\.30\.0\.12,almalinux,/.test(once), once.split('\n').slice(0, 7));
    // The next save goes on top of it (200, not a conflict) and doesn't send the row again.
    await typeInto(cp, 6, 2, 'fedora');
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await settled(cp);
    const twice = disk();
    check('E3f ...and the next save is a 200 that doesn\'t add the row again', cw.statuses[cw.statuses.length - 1] === 200
      && twice.split('\n').filter((l) => l.startsWith('srv-new')).length === 1 && twice.split('\n').length === once.split('\n').length,
    { statuses: cw.statuses, lines: twice.split('\n').slice(0, 8) });

    // Written, but the server could only answer { saved, reload }: the sheet is fetched again, nothing resent.
    await typeInto(cp, 7, 2, 'gentoo');
    const gets0 = cw.sheetGets, n0 = cw.saves;
    cw.next = 'land-then-reload';
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await settled(cp);
    const third = disk();
    check('E3f a { saved, reload } answer → the sheet is fetched again, "Saved", clean, written once', cw.landed[1] === 200 && cw.sheetGets > gets0
      && cw.saves === n0 + 1 && !(await isUnsaved(cp, file)) && await textAt(cp, 7, 2) === 'gentoo'
      && third.split('\n').filter((l) => /,gentoo,/.test(l)).length === 1 && third.split('\n').length === twice.split('\n').length,
    { landed: cw.landed, gets: cw.sheetGets - gets0, unsaved: await isUnsaved(cp, file) });
  });

  // Over the 1.9 MB a save may post: refused before sending, the edits kept, undo free.
  await part('E3g too much for one save', async () => {
    await cp.click(cell(1, 0));
    const big = Array.from({ length: 200 }, (_, r) => Array.from({ length: 100 }, (__, k) => `${r}-${k}-`.padEnd(100, 'x')).join('\t')).join('\r\n');
    await pasteText(cp, big);
    await cp.waitForFunction(() => /^Save \(\d+\)$/.test(document.getElementById('fx-sheet-save').textContent.trim()), { timeout: 10000 });
    const n0 = cw.saves;
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await sleep(300);
    check('E3g a save over 1.9 MB → "Too many changes for one save — save in smaller steps", no POST, still unsaved',
      await toastText(cp) === 'Too many changes for one save — save in smaller steps' && cw.saves === n0 && await isUnsaved(cp, file), { t: await toastText(cp), posts: cw.saves - n0 });
    await clearToast(cp);
    await combo(cp, ['Control'], 'z');
    await sleep(300);
    check('E3g ...and undo works (nothing pinned)', await toastText(cp) === '' && !(await isUnsaved(cp, file)), await toastText(cp));
  });

  // Someone else (another window, an agent through VaultOS) saves from the same version first; then our save is
  // refused (409) and that answer is lost. Their write looks like ours from the outside — same base, same kind of
  // backup — so only the save's own id may say it was ours: here it isn't, and nothing may be dropped.
  await part('E3h a lost 409 after someone else\'s save', async () => {
    await typeInto(cp, 9, 2, 'nixos');                        // C10 ubuntu → nixos (ours, unsaved)
    const api = (url, opts = {}) => fetch(BASE + url, { ...opts, headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() } });
    const base = await (await api('/api/fs/sheet?path=' + encodeURIComponent('Sandbox/' + file))).json();
    const theirs = await api('/api/fs/sheet/save', { method: 'POST', body: JSON.stringify({ path: 'Sandbox/' + file, mtime: base.mtime, saveId: 'b0b0',
      ops: [{ op: 'set', sheet: 0, r: 11, c: 2, v: 'freebsd' }] }) });
    const n0 = cw.landed.length;
    cw.next = 'land-then-drop';
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await cp.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]') || /Saved/.test(document.getElementById('toast').textContent), { timeout: 10000 });
    await sleep(200);
    const now = disk();
    check('E3h (their save went in from the same base, ours was refused with a 409 whose answer was lost)', theirs.status === 200 && cw.landed[n0] === 409,
      { theirs: theirs.status, ours: cw.landed[n0] });
    check('E3h our edit is kept and still unsaved, the conflict banner shows, nothing says "Saved"', await toastText(cp) !== 'Saved'
      && await isUnsaved(cp, file) && await textAt(cp, 9, 2) === 'nixos' && (await notes(cp)).some((x) => x.kind === 'conflict'),
    { toast: await toastText(cp), unsaved: await isUnsaved(cp, file), c10: await textAt(cp, 9, 2), notes: await notes(cp) });
    check('E3h ...the file has their change, not ours', /,freebsd,/.test(now) && !/,nixos,/.test(now));
    const banner = (await notes(cp)).find((x) => x.kind === 'conflict');
    check('E3h ...and the banner says the save may have gone through, with the usual two buttons', !!banner
      && banner.text.startsWith("Your save may have gone through — the file changed and VaultOS can't tell whose change it is. Check the sheet before re-applying.")
      && banner.acts.map((a) => a.act).join() === 'reapply,discard', banner);
    await shot(cp, 'e3h-may-have-landed-dark-desktop');
    await cp.click('#fx-view .sg-note [data-act="reapply"]');
    await cp.waitForFunction((sel) => (document.querySelector(sel) || {}).textContent === 'freebsd', { timeout: 5000 }, cell(11, 2));
    await clearToast(cp);
    await cp.click('#fx-sheet-save');
    await settled(cp);
    const after = disk();
    check('E3h Reload and re-apply, Save → both changes, ours once', /,freebsd,/.test(after) && after.split('\n').filter((l) => /,nixos,/.test(l)).length === 1
      && !(await isUnsaved(cp, file)));
  });
  await c.context.close();
}

// E4 — background refreshes (visibilitychange, the 8 s poll, Board and back, a file touched on disk) never reload
// over unsaved edits: the committed change, the open draft and the scroll all survive.
async function E4(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const w = await watchWrites(page);
  const scrollOf = () => page.$eval('#fx-view .sg-scroll', (el) => ({ top: el.scrollTop, left: el.scrollLeft }));

  await part('E4 refreshes keep unsaved edits', async () => {
    await openFile(s, FILES.actions);
    await clickEdit(s);
    await scrollGrid(page, { top: 40 });
    await typeInto(page, 3, 5, 'Closed');                    // F4 committed
    await page.keyboard.type('Clo');                          // F5: typing, not committed
    const before = await scrollOf();
    const gets0 = w.sheetGets;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(9000);                                        // past one 8 s poll
    await tapOrClick(s, modeBtn(s, 'board'));
    await page.waitForSelector('#board-view:not(.hidden)');
    await sleep(200);
    await tapOrClick(s, modeBtn(s, 'files'));
    await page.waitForSelector('#files-view:not(.hidden)');
    await sleep(300);
    const ed = await editor(page);
    check('E4 F4 is still Closed and marked changed', await textAt(page, 3, 5) === 'Closed' && await hasClass(page, cell(3, 5), 'sg-changed'), await textAt(page, 3, 5));
    check('E4 F5\'s editor still holds the text', ed.open && ed.value === 'Clo' && await nameBox(page) === 'F5', ed);
    check('E4 Save (1), the tab unsaved', (await sheetBar(page)).save.text === 'Save (1)' && await isUnsaved(page, FILES.actions), await sheetBar(page));
    const after = await scrollOf();
    check('E4 scroll unchanged', after.top === before.top && after.left === before.left, { before, after });
    check('E4 nothing reloaded the sheet', w.sheetGets === gets0, w.sheetGets - gets0);

    // The file changes on disk (touched, same bytes): the poll must not reload over the edits; it says so instead.
    const now = new Date();
    fs.utimesSync(VAULT(FILES.actions), now, now);
    await page.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]'), { timeout: 12000 });
    const ed2 = await editor(page);
    check('E4 changed on disk while dirty: the conflict banner shows, no reload', w.sheetGets === gets0 && await textAt(page, 3, 5) === 'Closed'
      && ed2.open && ed2.value === 'Clo', { gets: w.sheetGets - gets0, ed2 });
  });
  await s.context.close();
}

// E5 — a CSV changed on disk while edited: the proactive banner, Save → 409, Reload and re-apply, Save → 200;
// then Reload and discard.
async function E5(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const w = await watchWrites(page);
  const dialogs = watchDialogs(page);
  const file = FILES.csv;
  const editDisk = (from, to) => {
    const text = fs.readFileSync(VAULT(file), 'utf8');
    if (!text.includes(from)) throw new Error('not on disk: ' + from);
    fs.writeFileSync(VAULT(file), text.replace(from, to));
  };

  await part('E5a conflict, re-apply', async () => {
    await openFile(s, file);
    await clickEdit(s);
    await typeInto(page, 2, 2, 'almalinux');                  // C3 rhel → almalinux
    const gets0 = w.sheetGets;
    editDisk('srv-004,10.30.0.14,ubuntu,test,', 'srv-004,10.30.0.14,ubuntu,prod,');
    await page.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]'), { timeout: 12000 });
    const n = (await notes(page)).find((x) => x.kind === 'conflict');
    check('E5a the poll shows the banner: changed on disk, re-apply my 1 edit / discard', n.text.startsWith('This file changed on disk since you opened it.')
      && JSON.stringify(n.acts) === JSON.stringify([{ act: 'reapply', text: 'Reload and re-apply my 1 edit' }, { act: 'discard', text: 'Reload and discard my edits' }]), n);
    check('E5a ...without reloading: C3 still almalinux, D5 still test', w.sheetGets === gets0 && await textAt(page, 2, 2) === 'almalinux'
      && await textAt(page, 4, 3) === 'test', { gets: w.sheetGets - gets0, d5: await textAt(page, 4, 3) });
    check('E5a the banner\'s buttons fit in the view (they wrap on a phone)', await notesFit(page) === true, await notesFit(page));
    await shot(page, 'e5-conflict-dark-desktop');
    if (baseCell()) {
      await setTheme(page, 'light');
      await shot(page, 'e5-conflict-sepia-desktop');
      await setTheme(page, 'dark');
    }
    await clearToast(page);
    const n0 = w.saves;
    await page.click('#fx-sheet-save');
    await page.waitForFunction(() => document.getElementById('fx-sheet-save').textContent.trim() !== 'Saving…', { timeout: 5000 });
    await sleep(200);
    check('E5a Save → one POST, 409, the banner stays, the edit stays', w.saves === n0 + 1 && w.statuses[w.statuses.length - 1] === 409
      && (await notes(page)).some((x) => x.kind === 'conflict') && await textAt(page, 2, 2) === 'almalinux' && await isUnsaved(page, file),
    { statuses: w.statuses, notes: await notes(page) });
    await page.click('#fx-view .sg-note [data-act="reapply"]');
    await page.waitForFunction((sel) => (document.querySelector(sel) || {}).textContent === 'prod', { timeout: 5000 }, cell(4, 3));
    await sleep(100);
    check('E5a Reload and re-apply: both changes present, C3 highlighted, D5 not', await textAt(page, 2, 2) === 'almalinux' && await textAt(page, 4, 3) === 'prod'
      && await hasClass(page, cell(2, 2), 'sg-changed') && !(await hasClass(page, cell(4, 3), 'sg-changed')));
    check('E5a ...still dirty: tab unsaved, Save (1), banner gone', await isUnsaved(page, file) && (await sheetBar(page)).save.text === 'Save (1)'
      && !(await notes(page)).some((x) => x.kind === 'conflict'), { bar: await sheetBar(page), notes: await notes(page) });
    await clearToast(page);
    await page.click('#fx-sheet-save');
    await settled(page);
    const lines = fs.readFileSync(VAULT(file), 'utf8').split('\n');
    const want = fs.readFileSync(PRISTINE(file), 'utf8').replace('srv-002,10.30.0.12,rhel,', 'srv-002,10.30.0.12,almalinux,')
      .replace('srv-004,10.30.0.14,ubuntu,test,', 'srv-004,10.30.0.14,ubuntu,prod,').split('\n');
    check('E5a Save → 200; the file has both changes and nothing else', w.statuses[w.statuses.length - 1] === 200 && JSON.stringify(lines) === JSON.stringify(want),
      { status: w.statuses[w.statuses.length - 1], diff: lines.filter((l, i) => l !== want[i]) });
  });

  await part('E5b conflict, discard', async () => {
    await typeInto(page, 3, 2, 'fedora');                     // C4 debian → fedora
    editDisk('srv-005,', 'srv-905,');
    await page.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]'), { timeout: 12000 });
    dialogs.answer = 'dismiss';
    const d0 = dialogs.list.length;
    await page.click('#fx-view .sg-note [data-act="discard"]');
    await sleep(300);
    check('E5b Reload and discard asks first; Cancel keeps the edit and the banner', dialogs.list.length === d0 + 1 && dialogs.list[d0].type === 'confirm'
      && await textAt(page, 3, 2) === 'fedora' && (await notes(page)).some((x) => x.kind === 'conflict'), dialogs.list.slice(d0));
    dialogs.answer = 'accept';
    await page.click('#fx-view .sg-note [data-act="discard"]');
    await page.waitForFunction((sel) => (document.querySelector(sel) || {}).textContent === 'srv-905', { timeout: 5000 }, cell(5, 0));
    await sleep(100);
    check('E5b ...OK: the file as it is on disk, clean, no banner', await textAt(page, 3, 2) === 'debian' && !(await isUnsaved(page, file))
      && !(await notes(page)).some((x) => x.kind === 'conflict') && (await sheetBar(page)).save.disabled, { c4: await textAt(page, 3, 2), notes: await notes(page) });
    // Clean now: a change on disk simply reloads.
    const gets0 = w.sheetGets;
    editDisk('srv-006,', 'srv-906,');
    await page.waitForFunction((sel) => (document.querySelector(sel) || {}).textContent === 'srv-906', { timeout: 12000 }, cell(6, 0));
    check('E5b a clean grid reloads by itself when the file changes', w.sheetGets > gets0 && !(await notes(page)).some((x) => x.kind === 'conflict'));
  });

  await part('E5c conflict with only a draft', async () => {
    await typeInto(page, 7, 2, 'arch', false);               // C8: typing, not committed
    editDisk('srv-008,', 'srv-908,');
    await page.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]'), { timeout: 12000 });
    const n = (await notes(page)).find((x) => x.kind === 'conflict');
    check('E5c an open edit alone counts: the banner offers to reload keeping it', n && n.acts[0].text === 'Reload and keep what I’m typing', n);
    await page.click('#fx-view .sg-note [data-act="reapply"]');
    await page.waitForFunction((sel) => (document.querySelector(sel) || {}).textContent === 'srv-908', { timeout: 5000 }, cell(8, 0));
    await sleep(100);
    const ed = await editor(page);
    check('E5c after the reload the edit is still open with its text, over C8', ed.open && ed.value === 'arch' && await nameBox(page) === 'C8', ed);
    await page.keyboard.press('Enter');
    check('E5c ...and Enter commits it: Save (1)', await textAt(page, 7, 2) === 'arch' && (await sheetBar(page)).save.text === 'Save (1)', await sheetBar(page));
  });

  await part('E5d re-apply onto a file that became view-only', async () => {
    // The file grows past the grid's 60,000-cell cap on disk: it comes back view-only.
    const text = fs.readFileSync(VAULT(file), 'utf8');
    fs.writeFileSync(VAULT(file), text + Array.from({ length: 6100 }, (_, i) => `x-${i},10.9.9.9,linux,dev,team-z,db,1,1,1,active`).join('\n') + '\n');
    await page.waitForFunction(() => !!document.querySelector('#fx-view .sg-note[data-kind="conflict"]'), { timeout: 12000 });
    await clearToast(page);
    await page.click('#fx-view .sg-note [data-act="reapply"]');
    await page.waitForFunction(() => /too big to edit/.test(document.getElementById('toast').textContent), { timeout: 5000 });
    await sleep(100);
    check('E5d the reason as a toast; the edit, the banner and edit mode all stay', await textAt(page, 7, 2) === 'arch' && await isUnsaved(page, file)
      && (await notes(page)).some((x) => x.kind === 'conflict') && (await sheetBar(page)).save.text === 'Save (1)',
    { t: await toastText(page), notes: await notes(page), bar: await sheetBar(page) });
  });
  await s.context.close();
}

// E6 — closing a dirty tab asks (Cancel keeps it), the page asks before unloading, a dirty preview tab is never
// replaced, OK drops the grid.
async function E6(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const dialogs = watchDialogs(page);
  const file = FILES.csv, P = 'Sandbox/' + FILES.csv;
  const x = `#fx-tabs .fx-tab[data-path="${P}"] .fx-tab-x`;

  await part('E6 close a dirty tab', async () => {
    await openFile(s, file);
    await clickEdit(s);
    await typeInto(page, 2, 2, 'almalinux');
    await page.mouse.move(5, 500);   // not hovering the tab
    const dot = await page.$eval(x, (el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      document.body.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      const b = getComputedStyle(el, '::before');
      return { content: b.content, bg: b.backgroundColor, ink, opacity: getComputedStyle(el).opacity, icon: getComputedStyle(el.querySelector('svg')).display };
    });
    check('E6 an unsaved tab shows a filled dot in the text colour where the × was, always visible', await isUnsaved(page, file) && dot.content !== 'none'
      && dot.bg === dot.ink && dot.icon === 'none' && dot.opacity === '1', dot);
    dialogs.answer = 'dismiss';
    await page.click(x);
    await sleep(200);
    const d = dialogs.list[dialogs.list.length - 1];
    check('E6 closing it asks: "Discard 1 unsaved change to servers.csv?"', d && d.type === 'confirm' && d.message === 'Discard 1 unsaved change to servers.csv?', d);
    check('E6 Cancel keeps the tab and the edit', await hasTab(page, file) && await textAt(page, 2, 2) === 'almalinux' && await isUnsaved(page, file));

    // Reloading the page asks too (beforeunload); staying keeps everything.
    const d0 = dialogs.list.length;
    await page.evaluate(() => setTimeout(() => location.reload(), 0));
    await sleep(800);
    const bu = dialogs.list.slice(d0);
    check('E6 a reload with unsaved edits asks first (beforeunload); staying keeps the edit', bu.length === 1 && bu[0].type === 'beforeunload'
      && await textAt(page, 2, 2) === 'almalinux', bu);

    // A dirty preview tab is pinned rather than replaced by the next single-click open.
    await page.evaluate((p) => { FX.tabs.find((t) => t.path === p).pinned = false; renderTabs(); }, P);
    await openFile(s, 'semicolon.csv');
    const tabs = await page.$$eval('#fx-tabs .fx-tab', (els) => els.map((el) => ({ p: el.dataset.path, preview: el.classList.contains('preview') })));
    check('E6 a single-click open never replaces a dirty preview tab (it is kept, pinned)', JSON.stringify(tabs)
      === JSON.stringify([{ p: P, preview: false }, { p: 'Sandbox/semicolon.csv', preview: true }]), tabs);
    // ...but a clean preview tab is replaced, and its grid dropped.
    await openFile(s, 'no-trailing-newline.csv');
    const gone = await page.evaluate(() => ({ tab: !!document.querySelector('#fx-tabs .fx-tab[data-path="Sandbox/semicolon.csv"]'),
      destroyed: window.__destroyed['Sandbox/semicolon.csv'] || 0 }));
    check('E6 a clean preview tab is replaced and its grid dropped (destroyed)', !gone.tab && gone.destroyed === 1, gone);

    dialogs.answer = 'accept';
    const d1 = dialogs.list.length;
    await page.click(x);
    await sleep(200);
    const closed = await page.evaluate((p) => ({ tab: !!document.querySelector(`#fx-tabs .fx-tab[data-path="${CSS.escape(p)}"]`),
      dirty: SheetFiles.isDirty(p), destroyed: window.__destroyed[p] || 0, any: SheetFiles.anyDirty() }), P);
    check('E6 OK closes the tab and drops its grid', dialogs.list.length === d1 + 1 && !closed.tab && !closed.dirty && closed.destroyed === 1 && !closed.any, closed);
    // A clean tab closes without asking.
    const d3 = dialogs.list.length;
    await page.click('#fx-tabs .fx-tab[data-path="Sandbox/no-trailing-newline.csv"] .fx-tab-x');
    await sleep(200);
    check('E6 a clean tab closes without asking', dialogs.list.length === d3 && !(await hasTab(page, 'no-trailing-newline.csv')));
    const d2 = dialogs.list.length;
    await page.reload({ waitUntil: 'networkidle0' });
    check('E6 with nothing unsaved a reload doesn\'t ask', dialogs.list.length === d2, dialogs.list.slice(d2));
  });
  await s.context.close();
}

// E7 — Restore previous version puts the file back byte for byte, and the grid can save again afterwards
// (it adopted the restored file's older mtime).
async function E7(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const w = await watchWrites(page);
  const dialogs = watchDialogs(page);
  const file = FILES.actions;
  const before = fs.statSync(VAULT(file)).mtimeMs;

  await part('E7 restore', async () => {
    await openFile(s, file);
    check('E7 no backup yet: no Restore', !(await sheetBar(page)).restore, await sheetBar(page));
    await clickEdit(s);
    await typeInto(page, 3, 5, 'Closed');
    await clearToast(page);
    await page.click('#fx-sheet-save');
    await settled(page);
    check('E7 Restore isn\'t offered while editing', !(await sheetBar(page)).restore);
    await page.click('#fx-sheet-done');
    await page.waitForSelector('#fx-bar #fx-sheet-restore', { timeout: 3000 });
    dialogs.answer = 'dismiss';
    await page.click('#fx-sheet-restore');
    await sleep(200);
    const d = dialogs.list[dialogs.list.length - 1];
    const want = `Restore previous version?\n\nThis puts back the version from ${ukStamp(before)}. What's there now becomes the backup, so you can switch back.`;
    check('E7 Restore asks, in full ("Restore previous version?") and naming when that version was saved (dd/mm/yyyy hh:mm)',
      d && d.type === 'confirm' && d.message === want, { d, want });
    check('E7 Cancel changes nothing', w.restores === 0 && !fs.readFileSync(VAULT(file)).equals(fs.readFileSync(PRISTINE(file))));
    dialogs.answer = 'accept';
    await clearToast(page);
    await page.click('#fx-sheet-restore');
    await settled(page, /^Restored/);
    check('E7 the vault file is byte-for-byte the pristine one again', fs.readFileSync(VAULT(file)).equals(fs.readFileSync(PRISTINE(file))));
    check('E7 the grid shows it: F4 Open, red again', await textAt(page, 3, 5) === 'Open' && await bgAt(page, 3, 5) === 'rgb(192, 0, 0)', await textAt(page, 3, 5));
    const b = await sheetBar(page);
    check('E7 Restore is still offered (to switch back)', !!b.restore && !!b.edit, b);
    // Saving again works: the restored file's (older) mtime was adopted, so no 409.
    await clickEdit(s);
    await typeInto(page, 4, 5, 'Open');
    await clearToast(page);
    await page.click('#fx-sheet-save');
    await settled(page);
    const disk = await xlsxValues(file, ['F4', 'F5']);
    check('E7 a save after the restore goes through (200), on top of the restored file', w.statuses[w.statuses.length - 1] === 200
      && disk.F4 === 'Open' && disk.F5 === 'Open', { statuses: w.statuses, disk });
  });
  await s.context.close();
}

// E8 — a CSV round trip keeps every other byte (BOM, CRLF, quoted multi-line fields); Source shows the new text.
// Then the read-only banners: view-only (with Download), colour rules not shown, too large for the grid.
async function E8(browser) {
  const s = await session(browser);
  const { page } = s;
  await collectGrids(page);
  const file = 'bom-crlf.csv';

  await part('E8 csv round trip', async () => {
    await openFile(s, file);
    await page.click('#fx-bar .fx-seg button[data-v="source"]');
    await page.waitForSelector('#fx-view .fx-source');
    check('E8 Source shows the file', /2,Beta,"Line one/.test(await page.$eval('#fx-view .fx-source', (el) => el.textContent)));
    await page.click('#fx-bar .fx-seg button[data-v="grid"]');
    await page.waitForSelector(cell(2, 1));
    await clickEdit(s);
    await typeInto(page, 2, 1, 'Bravo');
    await clearToast(page);
    await page.click('#fx-sheet-save');
    await settled(page);
    const got = fs.readFileSync(VAULT(file));
    const want = Buffer.from(fs.readFileSync(PRISTINE(file), 'latin1').replace('2,Beta,', '2,Bravo,'), 'latin1');
    check('E8 the saved bytes are the pristine bytes with only Beta → Bravo (BOM, CRLF, quotes kept)', got.equals(want),
      got.toString('latin1').slice(0, 80));
    let out = '';
    try { execFileSync('diff', [PRISTINE(file), VAULT(file)], { encoding: 'utf8' }); } catch (err) { out = String(err.stdout); }
    const minus = out.split('\n').filter((l) => l.startsWith('<')), plus = out.split('\n').filter((l) => l.startsWith('>'));
    check('E8 diff against pristine shows only the edited line', minus.length === 1 && plus.length === 1 && /2,Beta,/.test(minus[0]) && /2,Bravo,/.test(plus[0]), out);
    await page.click('#fx-bar .fx-seg button[data-v="source"]');
    await page.waitForSelector('#fx-view .fx-source');
    const src = await page.$eval('#fx-view .fx-source', (el) => el.textContent);
    check('E8 Source view shows the new text', /2,Bravo,"Line one/.test(src) && !/Beta/.test(src), src.slice(0, 120));
    await page.click('#fx-bar .fx-seg button[data-v="grid"]');
    await page.waitForSelector(cell(2, 1));
  });

  await part('E8 read-only banners', async () => {
    // Made-up files in the preview vault (reset.sh removes them): colour rules the grid can't draw, and a CSV over
    // the 60,000-cell cap that is still small enough to have Source.
    const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Scores');
    ws.addRows([['Score'], [1], [5], [9]]);
    ws.addConditionalFormatting({ ref: 'A2:A4', rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFF8696B' }, { argb: 'FF63BE7B' }] }] });
    await wb.xlsx.writeFile(VAULT('cf-scale.xlsx'));
    fs.writeFileSync(VAULT('big.csv'), 'a,b,c,d,e,f,g,h,i,j,k\n' + Array.from({ length: 6000 }, (_, i) => Array(11).fill(i).join(',')).join('\n') + '\n');
    const mx = new ExcelJS.Workbook();
    mx.addWorksheet('Small').addRows([['Name', 'Value'], ['a', 1], ['b', 2]]);
    const huge = mx.addWorksheet('Huge');
    for (let r = 0; r < 601; r++) huge.addRow(Array.from({ length: 100 }, (_, c) => r * 100 + c));
    await mx.xlsx.writeFile(VAULT('mixed.xlsx'));
    // The tree's own Refresh (in the closed drawer on a phone, so there it is called as the button would).
    if (s.phone) await page.evaluate(() => fxRefresh()); else await page.click('#fx-refresh');
    await sleep(500);

    await openFile(s, FILES.charts);
    let n = await notes(page);
    check('E8 a view-only workbook: a banner with the reason and Download', n.length === 1 && n[0].kind === 'readonly'
      && n[0].text.startsWith('Saving here would lose charts — edit it in Excel') && n[0].acts.map((a) => a.act).join() === 'download', n);
    await shot(page, 'e8-readonly-dark-desktop');
    if (baseCell()) {
      await setTheme(page, 'light');
      await shot(page, 'e8-readonly-sepia-desktop');
      await setTheme(page, 'dark');
    }

    await openFile(s, 'cf-scale.xlsx');
    n = await notes(page);
    check('E8 colour rules it can\'t draw: a muted note', n.length === 1 && n[0].kind === 'cf' && n[0].text === "Some colour rules from Excel aren't shown here", n);

    await openFile(s, 'mixed.xlsx');
    n = await notes(page);
    await clickTab(page, 1);
    await page.waitForSelector('#fx-view .sg-big', { timeout: 3000 });
    const big = await page.$eval('#fx-view .sg-big', (el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), dl: !!el.querySelector('button.sg-big-dl') }));
    check('E8 an xlsx with one oversized sheet: no file banner; that sheet says "Too large for the grid" with Download', n.length === 0
      && big.text.startsWith('Too large for the grid') && big.dl && (await sheetBar(page)).edit && !(await sheetBar(page)).edit.disabled, { n, big });
    await shot(page, 'e8-mixed-big-sheet-dark-desktop');
    const fbar = () => page.$eval('#fx-view .sg-fbar', (el) => getComputedStyle(el).display);
    const hugeBar = await fbar();
    await clickTab(page, 0);
    check('E8 the formula bar goes with a sheet too big to draw, and comes back on the next sheet', hugeBar === 'none' && await fbar() !== 'none', { hugeBar, small: await fbar() });

    await openFile(s, 'big.csv');
    await page.waitForSelector('#fx-view .sg-note', { timeout: 5000 });
    n = await notes(page);
    check('E8 over the cell cap: "Too large for the grid" with Show source and Download', n.length === 1 && n[0].kind === 'big'
      && n[0].text.startsWith('Too large for the grid') && n[0].acts.map((a) => a.act).join() === 'source,download', n);
    // Said once: the grid's own panel under the banner gives only the size, no second heading or Download.
    const panel = await page.$eval('#fx-view .sg-big', (el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), buttons: el.querySelectorAll('button').length }));
    const said = await page.$eval('#fx-view', (el) => (el.textContent.match(/Too large for the grid/g) || []).length);
    check('E8 ...said once: the panel below gives only the size ("big: 6,001 rows × 11 columns"), no heading, no Download',
      said === 1 && panel.buttons === 0 && panel.text === 'big: 6,001 rows × 11 columns', { said, panel });
    check('E8 ...with no (empty) formula bar over it, and the banner\'s buttons fit', await page.$eval('#fx-view .sg-fbar', (el) => getComputedStyle(el).display) === 'none'
      && await notesFit(page) === true, await notesFit(page));
    await shot(page, 'e8-big-dark-desktop');
    await page.click('#fx-view .sg-note [data-act="source"]');
    await page.waitForSelector('#fx-view .fx-source', { timeout: 3000 });
    check('E8 Show source switches to the Source view', /^a,b,c/.test(await page.$eval('#fx-view .fx-source', (el) => el.textContent)));
  });
  await s.context.close();

  // Sepia desktop and the phone: the Save (N) bar with an unsaved tab, and the view-only banner.
  if (baseCell()) await part('E8 sepia desktop', async () => {
    const p = await session(browser, { theme: 'light' });
    await openFile(p, FILES.actions);
    await clickEdit(p);
    await typeInto(p.page, 3, 5, 'Closed');
    await shot(p.page, 'e8-save-bar-sepia-desktop');
    check('E8 sepia: Save (1) and the unsaved tab', (await sheetBar(p.page)).save.text === 'Save (1)' && await isUnsaved(p.page, FILES.actions));
    await p.context.close();
  });
  for (const theme of baseCell() ? ['dark', 'light'] : []) {
    await part(`E8 phone ${theme}`, async () => {
      execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });   // each phone run saves: start from pristine
      const p = await session(browser, { theme, phone: true });
      const tag = theme === 'light' ? 'sepia' : 'dark';
      await openFile(p, FILES.charts);
      await shot(p.page, `e8-readonly-${tag}-phone`);
      await openFile(p, FILES.actions);
      await clickEdit(p);
      await p.page.tap(cell(6, 3));
      await sleep(80);
      await p.page.tap(cell(6, 3));
      await sleep(150);
      await combo(p.page, ['Control'], 'a');                  // the double-tap editor keeps the text: replace it
      await p.page.keyboard.type('Phone edit');
      await p.page.keyboard.press('Enter');
      await sleep(100);
      check(`E8 phone (${tag}) the cell reads exactly "Phone edit"`, await textAt(p.page, 6, 3) === 'Phone edit', await textAt(p.page, 6, 3));
      await shot(p.page, `e8-save-bar-${tag}-phone`);
      const bar = await sheetBar(p.page);
      const pageScroll = await p.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
      check(`E8 phone (${tag}) Save (1) and Done in the bar, no horizontal page scroll`, bar.save && bar.save.text === 'Save (1)' && bar.done
        && pageScroll.doc <= pageScroll.vw, { bar, pageScroll });
      await clearToast(p.page);
      await p.page.tap('#fx-sheet-save');
      await settled(p.page);
      check(`E8 phone (${tag}) tapping Save saves "Phone edit" to D7`, !(await isUnsaved(p.page, FILES.actions))
        && (await xlsxValues(FILES.actions, ['D7'])).D7 === 'Phone edit', (await xlsxValues(FILES.actions, ['D7'])).D7);
      await p.context.close();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// E9 — the rest of Files, and the app, still work with the grid in: .md Rendered | Source, a text file (Ctrl+A,
// Ctrl+C, Copy file, Download), an image, upload by a drop onto the tree, the tree's right-click menu, Changed
// recently's ●, the tab marks (unsaved dot vs changed-on-disk ring), the terminal dock on Ctrl+`, and the Board
// and Knowledge Base modes. Uses notes.md, script.ps1 and pixel.png from the sandbox.
// ---------------------------------------------------------------------------------------------------------
async function E9(browser) {
  // Terminals open in the dock, not a window (the desktop default), so Ctrl+` has something to show here.
  const s = await session(browser, { storage: { 'vaultboard.term.where': '"dock"' } });
  const { page } = s;
  const shown = (sel) => visible(page, sel);
  const drawer = async (open) => {                             // the tree, a slide-over drawer on a phone
    if (!s.phone) return;
    if (await page.$eval('#fx-layout', (el) => el.classList.contains('fx-side-open')) !== open) await page.tap('#fx-side-toggle');
    await sleep(450);
  };

  await part('E9a markdown', async () => {
    await openFile(s, 'notes.md');
    check('E9a an .md opens as Source, with Rendered | Source in the bar, and no grid', await shown('#fx-view .fx-source')
      && JSON.stringify(await page.$$eval('#fx-bar .fx-seg button', (bs) => bs.map((b) => b.textContent))) === '["Rendered","Source"]'
      && !(await page.$('#fx-view .sg')) && !(await page.$eval('#fx-view', (el) => el.classList.contains('fx-view-sheet'))));
    await tapOrClick(s, '#fx-bar .fx-seg button[data-v="rendered"]');
    await page.waitForSelector('#fx-view .fx-md', { timeout: 3000 });
    const r = await page.evaluate(() => ({ title: (document.querySelector('#fx-view .fx-title') || {}).textContent,
      h2: [...document.querySelectorAll('#fx-view .fx-md h2')].map((h) => h.textContent.trim()), props: !!document.querySelector('#fx-view .fx-props') }));
    check('E9a Rendered: the title, its heading, the front matter as Properties', r.title === 'Sandbox notes' && r.h2.includes('Checklist') && r.props, r);
    await shot(page, 'e9-md-dark-desktop');
    await tapOrClick(s, '#fx-bar .fx-seg button[data-v="source"]');
    await page.waitForSelector('#fx-view .fx-source', { timeout: 3000 });
    check('E9a Source again shows the text, front matter and all', /^---\s*title: Sandbox notes/.test(await page.$eval('#fx-view .fx-source', (el) => el.innerText)));
  });

  await part('E9b text file', async () => {
    await openFile(s, 'script.ps1');
    check('E9b a CRLF text file: three numbered lines', await page.$$eval('#fx-view .fx-source .ln', (els) => els.length) === 3);
    await page.evaluate(() => {
      document.activeElement.blur();
      window.__copied = null;
      document.addEventListener('copy', (e) => { window.__copied = e.clipboardData.getData('text/plain'); });   // after Files' own handler
    });
    await combo(page, ['Control'], 'a');
    const sel = await page.evaluate(() => {
      const code = document.querySelector('#fx-view .fx-source code');
      const sl = getSelection();
      return { inFile: sl.rangeCount > 0 && code.contains(sl.getRangeAt(0).commonAncestorContainer) || sl.getRangeAt(0).commonAncestorContainer === code,
        text: sl.toString().replace(/\s+/g, ' ').trim() };
    });
    check('E9b Ctrl+A selects the file only, not the page', sel.inFile && sel.text === 'Write-Host "a" Write-Host "b" $x = 1', sel);
    await combo(page, ['Control'], 'c');
    await sleep(100);
    check('E9b Ctrl+C copies its lines exactly', await page.evaluate(() => window.__copied) === 'Write-Host "a"\nWrite-Host "b"\n$x = 1',
      await page.evaluate(() => window.__copied));
    // Copy file: what goes to the clipboard is the file as it is (CRLF kept).
    await page.evaluate(() => {
      window.__clip = null;
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } }); } catch { /* */ }
    });
    await clearToast(page);
    await tapOrClick(s, '#fx-bar #fx-copyall');
    await sleep(150);
    check('E9b Copy file copies the whole file (CRLF kept) and says so', await page.evaluate(() => window.__clip) === 'Write-Host "a"\r\nWrite-Host "b"\r\n$x = 1\r\n'
      && /^Copied script\.ps1/.test(await toastText(page)), { clip: await page.evaluate(() => window.__clip), toast: await toastText(page) });
    // Download: the browser downloads the file (to a temp folder here), byte for byte.
    const dir = fs.mkdtempSync('/tmp/sheet-e2e-dl-');
    const cdp = await browser.target().createCDPSession();     // downloads are the browser's, per context
    const got = [];
    cdp.on('Browser.downloadWillBegin', (e) => got.push({ url: e.url, name: e.suggestedFilename }));
    cdp.on('Browser.downloadProgress', (e) => { if (e.state === 'completed') got.push({ done: true }); });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true, browserContextId: s.context.id });
    await tapOrClick(s, '#fx-bar #fx-download');
    for (let i = 0; i < 40 && !got.some((g) => g.done); i++) await sleep(100);
    const file = path.join(dir, 'script.ps1');
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    check('E9b Download saves the file as script.ps1, byte for byte', !!bytes && bytes.equals(fs.readFileSync(VAULT('script.ps1')))
      && got.some((g) => g.url && g.url.includes('/api/fs/download?path=Sandbox%2Fscript.ps1')), { got, bytes: bytes && bytes.length });
    fs.rmSync(dir, { recursive: true, force: true });
    await cdp.detach();
  });

  await part('E9c image', async () => {
    await openFile(s, 'pixel.png');
    await page.waitForFunction(() => { const i = document.querySelector('#fx-view .fx-image img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 5000 });
    check('E9c an image shows', await page.$eval('#fx-view .fx-image img', (i) => i.naturalWidth) === 16);
  });

  await part('E9d upload by a drop on the tree', async () => {
    await page.evaluate(() => { fxClearSearch(); renderTree(); });
    const folder = '#fx-tree .fx-row[data-dir][data-path="Sandbox"]';
    await page.waitForSelector(folder, { timeout: 5000 });
    await drawer(true);
    await clearToast(page);
    await page.$eval(folder, (row) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped by the e2e\n'], 'dropped.txt', { type: 'text/plain' }));
      const b = row.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + 20, clientY: b.top + b.height / 2 };
      for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, at));
    });
    await page.waitForFunction(() => /^Uploaded 1 file to Sandbox/.test(document.getElementById('toast').textContent), { timeout: 8000 });
    const disk = fs.existsSync(VAULT('dropped.txt')) ? fs.readFileSync(VAULT('dropped.txt'), 'utf8') : null;
    check('E9d a file dropped on the Sandbox folder lands there ("Uploaded 1 file to Sandbox") and opens', disk === 'dropped by the e2e\n'
      && await page.$eval('#fx-tabs .fx-tab.active', (el) => el.dataset.path) === 'Sandbox/dropped.txt', { disk });
  });

  await part('E9e the tree\'s right-click menu', async () => {
    const menu = async (sel) => {
      await page.$eval(sel, (el) => {
        const b = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + b.height / 2, button: 2 }));
      });
      await sleep(100);
      const items = await page.$$eval('.fx-menu:not(.hidden) button', (bs) => bs.map((b) => b.textContent.trim()));
      await page.keyboard.press('Escape');
      return items;
    };
    await drawer(true);
    await page.waitForSelector('#fx-tree .fx-row[data-path="Sandbox/dropped.txt"]', { timeout: 5000 });
    const onFile = await menu('#fx-tree .fx-row[data-path="Sandbox/dropped.txt"]');
    check('E9e right-click on a file: Open, Download, Copy vault path, Upload files to this folder…, Terminal here',
      JSON.stringify(onFile) === JSON.stringify(['Open', 'Download', 'Copy vault path', 'Upload files to this folder…', 'Terminal here']), onFile);
    const onDir = await menu('#fx-tree .fx-row[data-dir][data-path="Sandbox"]');
    check('E9e right-click on a folder: Upload files here…, Copy vault path, Terminal here',
      JSON.stringify(onDir) === JSON.stringify(['Upload files here…', 'Copy vault path', 'Terminal here']), onDir);
    check('E9e Esc closes it', !(await shown('.fx-menu')));
  });

  await part('E9f Changed recently', async () => {
    await page.waitForSelector('#fx-recent [data-path="Sandbox/dropped.txt"] .fx-fresh', { timeout: 10000 });
    const dot = await page.$eval('#fx-recent [data-path="Sandbox/dropped.txt"] .fx-fresh', (el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--brand)';
      document.body.appendChild(probe);
      const brand = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, brand, label: el.getAttribute('aria-label') };
    });
    check('E9f Changed recently lists the new file with its gold ● (changed in the last 10 minutes)', dot.bg === dot.brand && /last 10 minutes/.test(dot.label), dot);
    await drawer(false);
  });

  // An unsaved sheet whose file then changes on disk while its tab is in the background shows both marks:
  // the filled dot in place of the × (unsaved) and the ring after the name (changed on disk) — different in
  // shape, colour and place.
  await part('E9g tab marks', async () => {
    await openFile(s, FILES.csv);
    await clickEdit(s);
    await typeInto(page, 2, 2, 'almalinux');
    await openFile(s, 'script.ps1');
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(VAULT(FILES.csv), t, t);
    const tab = `#fx-tabs .fx-tab[data-path="Sandbox/${FILES.csv}"]`;
    await page.waitForSelector(`${tab}.changed`, { timeout: 15000 });
    await page.mouse.move(5, 600);
    const marks = await page.$eval(tab, (el) => {
      const probe = (v) => { const p = document.createElement('span'); p.style.color = `var(${v})`; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
      const ring = getComputedStyle(el.querySelector('.fx-tab-name'), '::after');
      const dot = getComputedStyle(el.querySelector('.fx-tab-x'), '::before');
      return { unsaved: el.classList.contains('unsaved'), brand: probe('--brand'), text: probe('--text'),
        ring: { style: ring.borderTopStyle, color: ring.borderTopColor, fill: ring.backgroundColor, w: ring.width },
        dot: { fill: dot.backgroundColor, w: dot.width } };
    });
    check('E9g unsaved and changed on disk: a filled dot in the text colour where the × was, a gold ring after the name',
      marks.unsaved && marks.dot.fill === marks.text && marks.ring.style === 'solid' && marks.ring.color === marks.brand
      && marks.ring.fill === 'rgba(0, 0, 0, 0)' && marks.text !== marks.brand, marks);
    const r = await page.$eval('#fx-tabs', (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: Math.min(b.width, 520), h: b.height }; });
    await page.screenshot({ path: path.join(SHOTS, `e9-tab-marks-${cellTag()}.png`), clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 3 } });
  });

  await part('E9h terminal dock', async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await combo(page, ['Control'], 'Backquote');
    await page.waitForSelector('#term-dock:not(.hidden)', { timeout: 3000 });
    check('E9h Ctrl+` opens the terminal dock', await shown('#term-dock'));
    await sleep(300);
    await shot(page, 'e9-dock-dark-desktop');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await combo(page, ['Control'], 'Backquote');
    await page.waitForSelector('#term-dock.hidden', { timeout: 3000 });
    check('E9h Ctrl+` again closes it', !(await shown('#term-dock')));
  });

  await part('E9i Board and Knowledge Base', async () => {
    await tapOrClick(s, modeBtn(s, 'board'));
    await page.waitForSelector('#board-view:not(.hidden) #board .col', { timeout: 5000 });
    check('E9i Board still renders its columns', await page.$$eval('#board .col', (els) => els.length) >= 3);
    await tapOrClick(s, modeBtn(s, 'kb'));
    await page.waitForSelector('#kb-view:not(.hidden)', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#kb-reader').children.length > 0 || document.querySelector('#kb-list').children.length > 0, { timeout: 5000 });
    check('E9i the Knowledge Base still renders', await shown('#kb-view'));
    await shot(page, 'e9-kb-dark-desktop');
    await tapOrClick(s, modeBtn(s, 'files'));
    await page.waitForSelector('#files-view:not(.hidden)', { timeout: 3000 });
    check('E9i back in Files, the tabs are still there (the unsaved sheet still unsaved)', await hasTab(page, FILES.csv) && await isUnsaved(page, FILES.csv)
      && await page.$$eval('#fx-tabs .fx-tab', (els) => els.length) >= 2);
    check('E9 no page errors anywhere in the sweep', s.errors.length === 0, s.errors);
  });
  await s.context.close();
}

// ---------------------------------------------------------------------------------------------------------
// E10 — long text: the formula bar wraps and grows to show the whole active cell (line breaks too), up to its
// max-height, then scrolls inside; it shrinks back for a short cell. The grid keeps the active cell in view, a
// double-click on a long cell still edits that cell (the bar waits for the clicks to stop before it resizes),
// and typing grows the bar with the editor staying over its cell. Its CSV is written here, after the reset.
// ---------------------------------------------------------------------------------------------------------
const LONG_FILE = 'Long notes.csv';
const LONG = 'The firewall change was approved on the condition that the old rule stays in place for two weeks, so traffic '
  + 'can fall back if the new path fails. After that the old rule is removed, the change ticket is closed, and the '
  + 'runbook is updated with the new subnet, the owner\'s name and the date the rollback window ends. If anything '
  + 'breaks in those two weeks, ring the on-call engineer first, then raise a P2.';
const MULTI = 'Step one: drain the node.\nStep two: patch and reboot.\nStep three: check the health page.\nStep four: put it back in the pool.';
const VERY = [LONG, LONG, LONG].join(' ');
function writeLongCsv() {
  const q = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const rows = [['ID', 'Server', 'Notes', 'Owner', 'Status'], ['1', 'web01', LONG, 'Alex', 'Open'], ['2', 'db01', MULTI, 'Sam', 'Done'],
    ['3', 'app01', 'Short note', 'Alex', 'Open'], ['4', 'files02', VERY, 'Priya', 'Blocked'],
    // Two long cells two rows apart (C6, C8): growing the bar by a long cell's two-odd rows on the first press of
    // a double-click on C8 would put C6, just as tall, under the pointer for the second press.
    ['5', 'files03', LONG, 'Sam', 'Open'], ['6', 'files04', 'Short too', 'Sam', 'Open'], ['7', 'files05', LONG, 'Sam', 'Open']];
  for (let i = 8; i <= 54; i++) rows.push([String(i), `srv${i}`, `Filler row ${i}`, 'Ops', 'Open']);
  rows.push(['55', 'last01', LONG, 'Alex', 'Open']);   // model row 55, at the bottom
  const f = path.join(PREVIEW, 'vault/Sandbox', LONG_FILE);
  fs.writeFileSync(f, rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n');
  fs.chownSync(f, 1000, 1000);
}
// The formula bar's box and its text's extent; `one` is the bar's one-line height (28px, 32px on a phone).
const bar = (page) => page.evaluate(() => {
  const f = document.querySelector('#fx-view .sg-fval');
  const cs = getComputedStyle(f);
  return { value: f.value, h: f.clientHeight, sh: f.scrollHeight, w: f.clientWidth, sw: f.scrollWidth,
    max: parseFloat(cs.maxHeight), lh: parseFloat(cs.lineHeight), oy: cs.overflowY, ws: cs.whiteSpace,
    fbar: document.querySelector('#fx-view .sg-fbar').getBoundingClientRect().height };
});
// On screen top to bottom (a column can be wider than a phone, so only the vertical is the bar's doing).
const rowInView = (b) => b.top >= b.headBottom - 0.5 && b.bottom <= b.viewBottom + 0.5;
const shows = (b) => b.sw <= b.w + 1 && (b.sh <= b.h + 1 || (Number.isFinite(b.max) && b.h >= b.max - 3 && b.oy === 'auto'));

async function E10(browser) {
  writeLongCsv();
  const s = await session(browser);
  const { page } = s;
  const one = s.phone ? 32 : 28;
  const settle = () => sleep(800);   // past the bar's wait for clicks to stop
  await part('E10 open', async () => {
    await openFile(s, LONG_FILE);
    check('E10 the bar starts one line high', Math.round((await bar(page)).fbar) === one, await bar(page));
  });
  await part('E10 a long cell shows in full', async () => {
    await tapOrClick(s, cell(1, 2));
    await settle();
    const b = await bar(page);
    check('E10 the bar holds the whole cell', b.value === LONG, b.value.length);
    check('E10 it wraps, never scrolling sideways', b.ws === 'pre-wrap' && b.sw <= b.w + 1, b);
    check('E10 it grew past one line', b.fbar > one + 10, b.fbar);
    check('E10 every line can be read (all on show, or the bar at its limit and scrolling)', shows(b), b);
    check('E10 the active cell is still in view', rowInView(await activeBox(page)), await activeBox(page));
    await shot(page, 'E10-long-dark-desktop');
  });
  await part('E10 line breaks show as lines', async () => {
    await page.keyboard.press('ArrowDown');
    await sleep(150);
    const b = await bar(page);
    check('E10 the multi-line cell is in the bar', b.value === MULTI, b.value);
    check('E10 all four lines are on show', b.sh <= b.h + 1 && b.h >= 4 * b.lh - 1, b);
    await shot(page, 'E10-multi-dark-desktop');
  });
  await part('E10 a short cell shrinks it back', async () => {
    await page.keyboard.press('ArrowDown');
    await sleep(150);
    check('E10 one line again', Math.round((await bar(page)).fbar) === one, await bar(page));
  });
  await part('E10 a very long cell stops at the limit and scrolls', async () => {
    await page.keyboard.press('ArrowDown');
    await sleep(150);
    const b = await bar(page);
    check('E10 the bar is at its max height', Number.isFinite(b.max) && b.h >= b.max - 3 && b.fbar > one + 10, b);
    check('E10 the rest scrolls inside the bar', b.sh > b.h && b.oy === 'auto', b);
    check('E10 the grid keeps most of the screen', b.fbar <= 140, b.fbar);
  });
  await part('E10 the cell at the bottom stays in view', async () => {
    for (let i = 0; i < 51 && (await nameBox(page)) !== 'C56'; i++) await page.keyboard.press('ArrowDown');
    await sleep(200);
    check('E10 reached the last row', (await nameBox(page)) === 'C56', await nameBox(page));
    check('E10 the bar grew for it', (await bar(page)).fbar > one + 10, await bar(page));
    check('E10 and the cell is still on screen', rowInView(await activeBox(page)), await activeBox(page));
  });
  await part('E10 a double-click on a long cell edits that cell', async () => {
    await scrollGrid(page, { top: 0, left: 0 });
    await clickEdit(s);
    await tapOrClick(s, cell(3, 2));   // the short cell: the bar is one line
    await settle();
    // Where the long cell C8 is now: a person's pointer stays there for both presses, even if the cell moves.
    const at = await page.$eval(cell(7, 2), (el) => {
      const b = el.getBoundingClientRect();
      const rn = document.querySelector('#fx-view .sg-scroll thead th.sg-corner').getBoundingClientRect().right;
      const left = Math.max(b.left, rn);   // the part of the cell on show, clear of the row numbers
      return { x: Math.min(left + 30, (left + Math.min(b.right, innerWidth)) / 2), y: b.top + b.height / 2 };
    });
    if (s.phone) {
      await page.touchscreen.tap(at.x, at.y);
      await sleep(120);
      await page.touchscreen.tap(at.x, at.y);
    } else await page.mouse.click(at.x, at.y, { count: 2, delay: 40 });
    await sleep(300);
    const e = await editor(page);
    check('E10 the editor opened', e.open, e);
    check('E10 on the cell double-clicked', (await nameBox(page)) === 'C8' && e.value === LONG, { name: await nameBox(page), value: (e.value || '').slice(0, 30) });
    await page.keyboard.press('Escape');
    await sleep(100);
  });
  await part('E10 typing grows the bar, and the editor stays over its cell', async () => {
    await tapOrClick(s, cell(3, 2));
    await settle();
    await page.keyboard.type('x');   // opens the editor on the short cell
    await page.keyboard.type(' ' + LONG.slice(0, 260));
    await sleep(250);
    const b = await bar(page);
    check('E10 the bar grew while typing', b.fbar > one + 10, b.fbar);
    const e = await editor(page);
    const td = await tdRect(page, 3, 2);
    check('E10 the editor is still over the cell', e.open && Math.abs(e.top - td.top) <= 1 && Math.abs(e.left - td.left) <= 1, { e, td });
    await page.keyboard.press('Escape');
    await sleep(100);
    check('E10 Escape put the cell back', (await bar(page)).value === 'Short note');
  });
  check('E10 no page errors', s.errors.length === 0, s.errors);
  await s.context.close();
}

const ALL = { E1, E2, E3, E4, E5, E6, E7, E8, E9, E10 };

(async () => {
  if (!SCENARIOS.length) { console.error('usage: node scripts/sheet-e2e.js [base-url] [--matrix | --viewport=desktop|phone --theme=dark|sepia] E1 [E2 …]'); process.exit(2); }
  for (const n of SCENARIOS) if (!ALL[n]) { console.error('unknown scenario: ' + n); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const puppeteer = (await import(PUPPETEER)).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const c of CELLS) {
      CELL = c;
      for (const n of SCENARIOS) {
        console.log(`--- ${n}${tagged ? ` [${cellTag()}]` : ''}`);
        execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });   // E3–E8 write to the preview vault
        await ALL[n](browser);
      }
    }
  } finally {
    await browser.close();
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
