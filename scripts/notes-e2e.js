'use strict';
// Browser scenarios for capture and Notes mode, driven with puppeteer against the Notes preview container
// (notes-preview, 127.0.0.1:7695) — never the live board (:7684; it holds real notes).
//
//   node scripts/notes-e2e.js [--phone] [--theme=dark|sepia] C1 [C2 … N6]
//
// Each scenario first resets the preview (synthetic vault from scripts/notes-sandbox.js, container restarted)
// and waits for a signed-in /api/notes. The session cookie comes from the preview's mint-cookie.js and is never
// printed. Every check prints PASS/FAIL; the exit code is 1 when any failed, 2 on bad usage.
// Screenshots go to /tmp/notes-shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PREVIEW = '/opt/vault/notes-preview';
const CONTAINER = 'notes-preview';
const BASE = 'http://127.0.0.1:7695';
const SHOTS = '/tmp/notes-shots';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const SMALL = 'Notes/Main/Small steps compound.md';
const TOOLS = 'Notes/Main/Tools shape thinking.md';
const WALKS = 'Notes/Inbox/2026-11-01 0830 Walks help me think.md';
const OLD = 'Notes/Inbox/Old idea.md';

const args = process.argv.slice(2);
if (args.some((a) => /^https?:\/\//.test(a))) { console.error(`this harness only runs against the preview, ${BASE}`); process.exit(2); }
const NAMES = args.filter((a) => !a.startsWith('--'));
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEFAULTS = { phone: args.includes('--phone'), theme: flag('theme') === 'sepia' ? 'light' : 'dark' };

let failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok && typeof ok === 'object' && 'error' in ok) { if (detail === undefined) detail = ok; ok = false; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  if (!ok) { failures++; failed.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mintCookie = () => execFileSync('node', [path.join(PREVIEW, 'mint-cookie.js')], { encoding: 'utf8' }).trim();
const disk = (rel) => path.join(PREVIEW, 'vault', ...rel.split('/'));

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { Cookie: mintCookie(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const inbox = async () => (await api('GET', '/api/notes')).body.inbox;

let browser;
async function launch() {
  if (!browser) {
    const puppeteer = (await import(PUPPETEER)).default;
    browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  }
  const context = await browser.createBrowserContext();
  const url = new URL(BASE);
  await context.setCookie(...mintCookie().split('; ').map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: url.hostname, path: '/', url: BASE };
  }));
  return context;
}
async function page({ phone = DEFAULTS.phone, theme = DEFAULTS.theme, context, url = '/' } = {}) {
  const ctx = context || await launch();
  const pg = await ctx.newPage();
  await pg.setViewport(phone ? PHONE : DESKTOP);
  await pg.evaluateOnNewDocument((t) => { try { localStorage.setItem('vaultboard.theme', t); } catch {} }, theme);
  pg.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  await pg.goto(BASE + url, { waitUntil: 'networkidle2' });
  return pg;
}
async function waitFor(p, fn, ms = 5000, ...a) {
  try { await p.waitForFunction(fn, { timeout: ms, polling: 100 }, ...a); return true; } catch { return false; }
}
async function ev(p, fn, ...a) {
  try { return await p.evaluate(fn, ...a); } catch (e) { return { error: String(e.message).split('\n')[0] }; }
}
async function tap(p, sel) {
  try {
    await p.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await p.click(sel); return true;
  } catch (e) { check(`click ${sel}`, false, String(e.message).split('\n')[0]); return false; }
}
async function shot(p, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(350);   // past the open/fade animations
  await p.screenshot({ path: path.join(SHOTS, `${name}-${DEFAULTS.phone ? 'phone' : 'desktop'}-${DEFAULTS.theme === 'light' ? 'sepia' : 'dark'}.png`) });
}
const text = (p, sel) => ev(p, (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
const modeBtn = (mode) => (DEFAULTS.phone ? `#mobile-nav button[data-for="mode-${mode}"]` : `#mode-${mode}`);
const boxOpen = (p) => waitFor(p, () => { const b = document.getElementById('cp-box'); return !!b && !b.classList.contains('hidden'); }, 3000);
const boxClosed = (p) => waitFor(p, () => { const b = document.getElementById('cp-box'); return !b || b.classList.contains('hidden'); }, 3000);
const toastText = (p) => ev(p, () => { const t = document.getElementById('toast'); return t && !t.classList.contains('hidden') ? t.textContent.trim() : null; });
async function ctrl(p, key) {
  await p.keyboard.down('Control');
  await p.keyboard.press(key);
  await p.keyboard.up('Control');
}
async function typeInBox(p, s) {
  await p.focus('#cp-text');
  await p.keyboard.type(s);
}

async function toNotes(p) {
  await tap(p, modeBtn('notes'));
  return waitFor(p, () => document.querySelectorAll('.nt-row').length > 0 || !!document.querySelector('.nt-empty'), 8000);
}
// Opens a row; on the phone that swaps the list for the note.
async function openRow(p, rel) {
  if (DEFAULTS.phone && await ev(p, () => document.querySelector('.nt-layout').classList.contains('nt-reading'))) await tap(p, '#nt-back');
  if (!await tap(p, `.nt-row[data-path="${rel}"]`)) return false;
  return waitFor(p, (r) => document.getElementById('nt-pane').dataset.path === r && !!document.getElementById('nt-body'), 5000, rel);
}
async function waitForDisk(rel, ok, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (ok(fs.readFileSync(disk(rel), 'utf8'))) return true; } catch {} await sleep(100); }
  return false;
}

const reset = () => execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });
const startedAt = () => {
  try { return execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', CONTAINER], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
async function previewReady(ms = 20000) {
  const end = Date.now() + ms;
  let last = 'no answer';
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE + '/api/notes', { headers: { Cookie: mintCookie() } });
      if (r.status === 200) return { ok: true };
      last = `${r.status} ${(await r.text()).slice(0, 80)}`;
    } catch (e) { last = String(e.message); }
    await sleep(250);
  }
  return { ok: false, last };
}

const SCEN = {
  // C1: the pen opens the box, Ctrl+Enter saves into the inbox, the toast names the folder.
  async C1() {
    const p = await page();
    check('C1 the pen button shows', await waitFor(p, () => { const b = document.getElementById('capture-btn'); return !!b && !b.classList.contains('hidden') && b.offsetWidth > 0; }));
    await tap(p, '#capture-btn');
    check('C1 the box opens', await boxOpen(p));
    check('C1 the textarea has focus', await ev(p, () => document.activeElement && document.activeElement.id === 'cp-text'));
    await shot(p, 'C1-box');
    await typeInBox(p, 'A brand new thought');
    await ctrl(p, 'Enter');
    check('C1 the box closes after saving', await boxClosed(p));
    const t = await toastText(p);
    check('C1 the toast says where it went', !!t && t.startsWith('Saved to Inbox'), t);
    const items = await inbox();
    check('C1 the inbox has 4 notes', items.length === 4, items.map((i) => i.name));
    check('C1 the new note is first', items[0].first === 'A brand new thought', items[0]);
    await shot(p, 'C1-saved');
    await p.close();
  },

  // C2: Ctrl+J opens the box from the Board, but not while typing in a field.
  async C2() {
    if (DEFAULTS.phone) { console.log('  (C2 is desktop only)'); return; }
    const p = await page();
    await tap(p, modeBtn('board'));
    await sleep(300);
    await ev(p, () => document.activeElement && document.activeElement.blur());
    await ctrl(p, 'j');
    check('C2 Ctrl+J opens the box', await boxOpen(p));
    await p.keyboard.press('Escape');
    check('C2 Esc closes it', await boxClosed(p));
    await ev(p, () => { const i = document.createElement('input'); i.id = 'e2e-field'; document.body.appendChild(i); i.focus(); });
    await ctrl(p, 'j');
    await sleep(400);
    check('C2 Ctrl+J in a text field does not open it', await ev(p, () => document.getElementById('cp-box').classList.contains('hidden')));
    await p.close();
  },

  // C3: a closed box keeps its draft; a saved one starts empty.
  async C3() {
    const p = await page();
    await tap(p, '#capture-btn');
    await boxOpen(p);
    await typeInBox(p, 'half a thought');
    await p.keyboard.press('Escape');
    await boxClosed(p);
    await tap(p, '#capture-btn');
    await boxOpen(p);
    check('C3 the draft is still there', (await ev(p, () => document.getElementById('cp-text').value)) === 'half a thought');
    await tap(p, '#cp-save');
    await boxClosed(p);
    await tap(p, '#capture-btn');
    await boxOpen(p);
    check('C3 after saving the box is empty', (await ev(p, () => document.getElementById('cp-text').value)) === '');
    await p.close();
  },

  // C4: a save that can't reach the server keeps the box open with the text and says so.
  async C4() {
    const p = await page();
    await tap(p, '#capture-btn');
    await boxOpen(p);
    await typeInBox(p, 'do not lose me');
    execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
    try {
      await tap(p, '#cp-save');
      await sleep(1500);
      check('C4 the box stays open', await ev(p, () => !document.getElementById('cp-box').classList.contains('hidden')));
      check('C4 the text is kept', (await ev(p, () => document.getElementById('cp-text').value)) === 'do not lose me');
      const msg = await text(p, '#cp-err');
      check('C4 it says what happened', msg === "Couldn't save. Check the connection and try again.", msg);
      await shot(p, 'C4-offline');
    } finally {
      execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
    }
    await p.close();
  },

  // C5: /?capture=1 (the home-screen shortcut) opens the box, then drops the parameter.
  async C5() {
    const p = await page({ url: '/?capture=1' });
    check('C5 the box opens on load', await boxOpen(p));
    check('C5 the URL no longer asks for it', !(await ev(p, () => location.search)).includes('capture'), await ev(p, () => location.search));
    await p.close();
  },

  // C6: two quick presses of Save write one note.
  async C6() {
    const p = await page();
    await tap(p, '#capture-btn');
    await boxOpen(p);
    await typeInBox(p, 'only once');
    await ev(p, () => { const b = document.getElementById('cp-save'); b.click(); b.click(); });
    await boxClosed(p);
    await sleep(500);
    const items = await inbox();
    check('C6 one new note, not two', items.filter((i) => i.first === 'only once').length === 1, items.map((i) => i.name));
    await p.close();
  },

  // C7: the draft is kept while typing, so a reload (or the phone killing the app) doesn't lose it.
  async C7() {
    const p = await page();
    await tap(p, '#capture-btn');
    await boxOpen(p);
    await typeInBox(p, 'typed then reloaded');
    await sleep(800);
    await p.reload({ waitUntil: 'networkidle2' });
    await tap(p, '#capture-btn');
    await boxOpen(p);
    check('C7 the draft survives a reload', (await ev(p, () => document.getElementById('cp-text').value)) === 'typed then reloaded', await ev(p, () => document.getElementById('cp-text').value));
    await p.close();
  },

  // N7: a double press on Done still ends with the Undo toast, and Undo still works.
  async N7() {
    const p = await page();
    await toNotes(p);
    await openRow(p, WALKS);
    let deletes = 0;
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/notes/delete')) deletes++; });
    await ev(p, () => { const b = document.getElementById('nt-done'); b.click(); b.click(); });
    await sleep(1500);
    check('N7 one delete is sent, not two', deletes === 1, deletes);
    const t = await toastText(p);
    check('N7 the toast still offers Undo', !!t && t.includes('Undo'), t);
    await tap(p, '#toast .toast-act');
    check('N7 Undo brings it back', await waitFor(p, (w) => !!document.querySelector(`.nt-row[data-path="${w}"]`), 5000, WALKS));
    await p.close();
  },

  // N8: a refresh that can't reach the server keeps the list on screen.
  async N8() {
    const p = await page();
    await toNotes(p);
    execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
    try {
      await ev(p, () => Notes.refresh());
      check('N8 the list is still there', await ev(p, () => document.querySelectorAll('.nt-row').length === 6), await ev(p, () => document.querySelectorAll('.nt-row').length));
    } finally {
      execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
    }
    await p.close();
  },

  // N1: Notes lists both sections, marks the old rough note, and shows a note with its [[links]].
  async N1() {
    const p = await page();
    check('N1 Notes mode opens', await toNotes(p));
    check('N1 Inbox heading counts 3', (await text(p, '.nt-h[data-sec="inbox"]')) === 'Inbox (3)', await text(p, '.nt-h[data-sec="inbox"]'));
    check('N1 Main Notes heading counts 3', (await text(p, '.nt-h[data-sec="main"]')) === 'Main Notes (3)', await text(p, '.nt-h[data-sec="main"]'));
    check('N1 the 9-day-old note is marked old', await ev(p, (o) => !!document.querySelector(`.nt-row[data-path="${o}"] .nt-old`), OLD));
    check('N1 a recent note is not', await ev(p, (w) => !document.querySelector(`.nt-row[data-path="${w}"] .nt-old`), WALKS));
    await shot(p, 'N1-list');
    check('N1 open Small steps', await openRow(p, SMALL));
    check('N1 [[Tools shape thinking]] is a link', await ev(p, (t) => !!document.querySelector(`#nt-body a.nt-link[data-path="${t}"]`), TOOLS));
    check('N1 [[Missing note]] is muted, not a link', await ev(p, () => [...document.querySelectorAll('#nt-body .nt-link-missing')].some((e) => e.textContent === 'Missing note')));
    await shot(p, 'N1-note');
    await p.close();
  },

  // N2: a link to a main note opens it here; a link to a source note opens Files.
  async N2() {
    const p = await page();
    await toNotes(p);
    await openRow(p, SMALL);
    await tap(p, `#nt-body a.nt-link[data-path="${TOOLS}"]`);
    check('N2 the linked note opens in Notes', await waitFor(p, (t) => document.getElementById('nt-pane').dataset.path === t, 5000, TOOLS));
    await openRow(p, SMALL);
    await tap(p, '#nt-body .nt-link[data-path="Notes/Sources/Books/Sample Book.md"]');
    check('N2 the source note opens in Files', await waitFor(p, () => document.body.dataset.mode === 'files', 5000));
    await p.close();
  },

  // N3: Edit and Ctrl+S save; a change on disk behind the editor gets Load theirs / Keep mine.
  async N3() {
    const p = await page();
    await toNotes(p);
    await openRow(p, TOOLS);
    await tap(p, '#nt-edit');
    check('N3 the editor opens', await waitFor(p, () => !!document.getElementById('nt-text')));
    await ev(p, () => { const t = document.getElementById('nt-text'); t.value = t.value + 'added line\n'; t.dispatchEvent(new Event('input')); t.focus(); });
    await ctrl(p, 's');
    check('N3 saved to disk', await waitForDisk(TOOLS, (s) => s.endsWith('added line\n')));
    check('N3 the pane shows the note again', await waitFor(p, () => !document.getElementById('nt-text') && !!document.getElementById('nt-body')));
    await tap(p, '#nt-edit');
    await waitFor(p, () => !!document.getElementById('nt-text'));
    fs.writeFileSync(disk(TOOLS), 'written elsewhere\n');
    await ev(p, () => { const t = document.getElementById('nt-text'); t.value = 'mine\n'; t.dispatchEvent(new Event('input')); });
    await tap(p, '#nt-save');
    check('N3 the conflict bar shows', await waitFor(p, () => { const b = document.getElementById('nt-conflict'); return !!b && !b.hidden; }));
    await shot(p, 'N3-conflict');
    await tap(p, '#nt-theirs');
    check('N3 Load theirs shows the disk text', await waitFor(p, () => document.getElementById('nt-text').value === 'written elsewhere\n'));
    fs.writeFileSync(disk(TOOLS), 'changed again\n');
    await ev(p, () => { const t = document.getElementById('nt-text'); t.value = 'mine wins\n'; t.dispatchEvent(new Event('input')); });
    await tap(p, '#nt-save');
    await waitFor(p, () => { const b = document.getElementById('nt-conflict'); return !!b && !b.hidden; });
    await tap(p, '#nt-mine');
    check('N3 Keep mine saves over it', await waitForDisk(TOOLS, (s) => s === 'mine wins\n'));
    await p.close();
  },

  // N4: Done removes with Undo; Done on a note already deleted elsewhere says so and refreshes.
  async N4() {
    const p = await page();
    await toNotes(p);
    await openRow(p, WALKS);
    await tap(p, '#nt-done');
    check('N4 the row leaves the list', await waitFor(p, (w) => !document.querySelector(`.nt-row[data-path="${w}"]`), 5000, WALKS));
    check('N4 the file is gone', !fs.existsSync(disk(WALKS)));
    const t = await toastText(p);
    check('N4 the toast offers Undo', !!t && t.startsWith('Removed') && t.includes('Undo'), t);
    await tap(p, '#toast .toast-act');
    check('N4 Undo brings it back', await waitFor(p, (w) => !!document.querySelector(`.nt-row[data-path="${w}"]`), 5000, WALKS));
    check('N4 the file is back', fs.existsSync(disk(WALKS)));
    await openRow(p, OLD);
    fs.unlinkSync(disk(OLD));
    await tap(p, '#nt-done');
    check('N4 an already-gone note says so', await waitFor(p, () => { const t = document.getElementById('toast'); return !t.classList.contains('hidden') && t.textContent.includes('Already gone.'); }));
    check('N4 and the list refreshes', await waitFor(p, (o) => !document.querySelector(`.nt-row[data-path="${o}"]`), 5000, OLD));
    await p.close();
  },

  // N5: the status and tag filters narrow Main Notes; an empty Inbox says how to fill it.
  async N5() {
    for (const f of fs.readdirSync(disk('Notes/Inbox'))) fs.unlinkSync(path.join(disk('Notes/Inbox'), f));
    const p = await page();
    await toNotes(p);
    const empty = await text(p, '.nt-empty');
    const want = DEFAULTS.phone ? 'Nothing waiting. Tap the pen to catch the next thought.' : 'Nothing waiting. Ctrl+J catches the next thought.';
    check('N5 the empty Inbox says how to fill it', empty === want, empty);
    await tap(p, '.nt-seg button[data-status="child"]');
    check('N5 status child leaves one note', await waitFor(p, (s) => { const r = [...document.querySelectorAll('.nt-row[data-sec="main"]')]; return r.length === 1 && r[0].dataset.path === s; }, 3000, SMALL));
    await tap(p, '.nt-seg button[data-status=""]');
    await p.select('#nt-tag', 'work');
    check('N5 tag work leaves one note', await waitFor(p, () => { const r = [...document.querySelectorAll('.nt-row[data-sec="main"]')]; return r.length === 1 && r[0].dataset.path.endsWith('Rest is part of work.md'); }, 3000));
    await shot(p, 'N5-filters');
    await p.close();
  },

  // N6: capture's Open lands on the note; a search pick of a note opens it in Notes; Refresh keeps the note.
  async N6() {
    const p = await page();
    await tap(p, '#capture-btn');
    await boxOpen(p);
    await typeInBox(p, 'Open me next');
    await tap(p, '#cp-save');
    await waitFor(p, () => !!document.querySelector('#toast .toast-act'));
    await tap(p, '#toast .toast-act');
    check('N6 Open goes to the new note in Notes', await waitFor(p, () => document.body.dataset.mode === 'notes' && (document.getElementById('nt-pane').dataset.path || '').endsWith('Open me next.md'), 5000));
    await ev(p, () => SearchPanel.open({ q: 'Tools shape' }));
    check('N6 search finds the note', await waitFor(p, (t) => [...document.querySelectorAll('.sp-row')].some((r) => r.textContent.includes('Tools shape thinking')), 10000, TOOLS));
    await ev(p, () => { const r = [...document.querySelectorAll('.sp-row')].find((x) => x.textContent.includes('Tools shape thinking')); r.click(); });
    check('N6 the pick opens in Notes', await waitFor(p, (t) => document.body.dataset.mode === 'notes' && document.getElementById('nt-pane').dataset.path === t, 5000, TOOLS));
    await tap(p, '#refresh');
    await p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    check('N6 Refresh comes back to the same note', await waitFor(p, (t) => document.body.dataset.mode === 'notes' && document.getElementById('nt-pane').dataset.path === t, 8000, TOOLS));
    await p.close();
  },
};

(async () => {
  if (!NAMES.length) { console.error('usage: node scripts/notes-e2e.js [--phone] [--theme=dark|sepia] C1 [C2 … N6]'); process.exit(2); }
  for (const n of NAMES) if (!SCEN[n]) { console.error('unknown scenario: ' + n); process.exit(2); }
  try {
    for (const n of NAMES) {
      console.log(`--- ${n} (${DEFAULTS.theme === 'light' ? 'sepia' : 'dark'}, ${DEFAULTS.phone ? 'phone' : 'desktop'})`);
      const before = startedAt();
      reset();
      const after = startedAt();
      if (!after || after === before) { check(`${n} preview container restarted by reset.sh`, false, { before, after }); continue; }
      const ready = await previewReady();
      if (!ready.ok) { check(`${n} preview serves /api/notes after reset`, false, ready.last); continue; }
      await SCEN[n]();
    }
  } finally {
    if (browser) await browser.close();
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

