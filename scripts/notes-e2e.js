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

