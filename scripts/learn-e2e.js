'use strict';
// Browser scenarios for Learn mode, driven with puppeteer against the Learn preview container
// (learn-preview, 127.0.0.1:7696) — never the live board (:7684).
//
//   node scripts/learn-e2e.js [--phone] [--theme=dark|light] L1 [L2 … L11]
//
// Each scenario resets the preview first (synthetic vault from scripts/learn-sandbox.js, container restarted) and
// waits for a signed-in /api/me. The session cookie comes from the preview's mint-cookie.js and is never printed.
// Every check prints PASS/FAIL; the exit code is 1 when any failed, 2 on bad usage. Screenshots go to
// /opt/vault/learn-preview/shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PREVIEW = '/opt/vault/learn-preview';
const BASE = 'http://127.0.0.1:7696';
const SHOTS = path.join(PREVIEW, 'shots');
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const NB = 'Learning/Sample notebook';
const LOG = `${NB}/Notes/2026-11-12 study.md`;
const SRC = `${NB}/Sources/sample.txt`;
const PDF = `${NB}/Sources/doc.pdf`;
const PNG = `${NB}/Studio/old.png`;

const args = process.argv.slice(2);
if (args.some((a) => /^https?:\/\//.test(a))) { console.error(`this harness only runs against the preview, ${BASE}`); process.exit(2); }
const NAMES = args.filter((a) => !a.startsWith('--'));
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const OPTS = { phone: args.includes('--phone'), theme: flag('theme') === 'light' ? 'light' : 'dark' };

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

async function reset(...flags) {
  execFileSync(path.join(PREVIEW, 'reset.sh'), flags, { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { const r = await api('GET', '/api/me'); if (r.body && r.body.authed) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error('preview did not come back');
}

let browser;
const contexts = [];   // closed after each scenario, so no page from one reconnects its terminal into the next
async function launch() {
  if (!browser) {
    const puppeteer = (await import(PUPPETEER)).default;
    browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  }
  const context = await browser.createBrowserContext();
  contexts.push(context);
  const url = new URL(BASE);
  await context.setCookie(...mintCookie().split('; ').map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: url.hostname, path: '/', url: BASE };
  }));
  return context;
}
const errors = [];
async function page({ phone = OPTS.phone, theme = OPTS.theme, context, url = '/' } = {}) {
  const ctx = context || await launch();
  const pg = await ctx.newPage();
  await pg.setViewport(phone ? PHONE : DESKTOP);
  await pg.evaluateOnNewDocument((t) => { try { localStorage.setItem('vaultboard.theme', t); } catch {} }, theme);
  pg.on('pageerror', (e) => { errors.push(String(e.message).split('\n')[0]); console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`); });
  await pg.goto(BASE + url, { waitUntil: 'networkidle2' });
  pg.ctx = ctx;
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
  await sleep(350);
  await p.screenshot({ path: path.join(SHOTS, `${name}-${OPTS.phone ? 'phone' : 'desktop'}-${OPTS.theme}.png`) });
}
const visible = (p, sel) => ev(p, (s) => { const el = document.querySelector(s); return !!el && !!(el.offsetWidth || el.offsetHeight) && !el.closest('.hidden'); }, sel);
const modeBtn = (mode) => (OPTS.phone ? `#mobile-nav button[data-for="mode-${mode}"]` : `#mode-${mode}`);
const toastText = (p) => ev(p, () => { const t = document.getElementById('toast'); return t && !t.classList.contains('hidden') ? t.textContent.trim() : null; });
const row = (rel) => `#ln-list [data-path="${rel}"]`;
const tab = (rel) => `#ln-tabs [data-path="${rel}"]`;
async function toLearn(p) {
  await tap(p, modeBtn('learn'));
  return waitFor(p, () => !document.getElementById('learn-view').classList.contains('hidden')
    && (document.querySelectorAll('#ln-list .ln-nb').length > 0 || !!document.getElementById('ln-first')), 8000);
}
// On the phone the tree is on the Notebook pane: go there before clicking a row.
async function pane(p, v) {
  if (!OPTS.phone) return;
  await tap(p, `#ln-switch [data-v="${v}"]`);
}
async function openFile(p, rel) {
  await pane(p, 'notebook');
  if (!await tap(p, row(rel))) return false;
  return waitFor(p, (r) => { const d = document.getElementById('ln-doc'); return d && d.dataset.path === r && !d.classList.contains('hidden') && !d.querySelector('.ln-loading'); }, 6000, rel);
}

const S = {};

S.L1 = async () => {
  await reset('--off');
  let p = await page();
  check('L1 Learn off: no Learn button', !(await visible(p, modeBtn('learn'))));
  await p.close();
  await reset();
  p = await page();
  check('L1 Learn on: the Learn button shows', await visible(p, modeBtn('learn')));
  check('L1 the Learn view opens', await toLearn(p));
  await shot(p, 'L1-learn');
};

S.L2 = async () => {
  await reset('--empty');
  const p = await page();
  check('L2 opens on the first-notebook box', await toLearn(p) && await visible(p, '#ln-first'));
  await shot(p, 'L2-empty');
  await p.type('#ln-first-name', 'Cloud basics');
  await tap(p, '#ln-first-go');
  const made = await waitFor(p, () => !!document.querySelector('#ln-list .ln-nb[data-nb="Learning/Cloud basics"]'), 6000);
  check('L2 the new notebook is listed', made);
  await pane(p, 'notebook');
  for (const sub of ['Sources', 'Notes', 'Studio']) check(`L2 ${sub} shows`, await visible(p, row(`Learning/Cloud basics/${sub}`)));
  check('L2 the folders exist on disk', ['Sources', 'Notes', 'Studio'].every((s) => fs.existsSync(disk(`Learning/Cloud basics/${s}`))));
  check('L2 the instruction files were written', fs.existsSync(disk('Learning/AGENTS.md')) && fs.existsSync(disk('Learning/CLAUDE.md')));
  check('L2 the empty Sources hint shows', await visible(p, '#ln-list .ln-hint'));
  await shot(p, 'L2-created');
};

S.L3 = async () => {
  await reset();
  let p = await page();
  await toLearn(p);
  check('L3 a study log opens rendered', await openFile(p, LOG) && (await ev(p, () => (document.querySelector('#ln-doc .fx-md h2') || {}).textContent)) === 'Where do rivers start?');
  check('L3 the tab shows', await visible(p, tab(LOG)));
  check('L3 Edit in Files is offered', await visible(p, '#ln-edit'));
  await shot(p, 'L3-log');
  check('L3 a .txt opens as source lines', await openFile(p, SRC) && (await ev(p, () => document.querySelectorAll('#ln-doc .fx-source .ln').length)) > 3);
  check('L3 an image opens', await openFile(p, PNG) && await waitFor(p, () => { const i = document.querySelector('#ln-doc .fx-image img'); return !!i && i.complete && i.naturalWidth > 0; }, 5000));
  check('L3 a PDF offers Open in Files', await openFile(p, PDF) && await visible(p, '#ln-open-files'));
  const before = await ev(p, () => [...document.querySelectorAll('#ln-tabs .fx-tab')].map((t) => t.dataset.path));
  await p.reload({ waitUntil: 'networkidle2' });
  await toLearn(p);
  await waitFor(p, () => document.querySelectorAll('#ln-tabs .fx-tab').length > 1, 5000);
  const after = await ev(p, () => [...document.querySelectorAll('#ln-tabs .fx-tab')].map((t) => t.dataset.path));
  check('L3 the tabs survive a reload', JSON.stringify(after) === JSON.stringify(before), { before, after });
  check('L3 the Terminal tab is first', before[0] === 'terminal');
  await tap(p, `${tab(PDF)} .fx-tab-x`);
  check('L3 a tab closes', await waitFor(p, (s) => !document.querySelector(s), 3000, tab(PDF)));
  await p.close();
  p = await page();
  await toLearn(p);
  await openFile(p, SRC);
  await tap(p, '#ln-edit');
  check('L3 Edit in Files goes to Files with the file open', await waitFor(p, (r) => document.body.dataset.mode === 'files' && (document.querySelector('#fx-tabs .fx-tab.active') || {}).dataset?.path === r, 6000, SRC));
};

S.L8 = async () => {
  if (!OPTS.phone) { console.log('SKIP L8 (phone only: run with --phone)'); return; }
  await reset();
  const p = await page();
  await toLearn(p);
  check('L8 the switch shows on a phone', await visible(p, '#ln-switch'));
  check('L8 the Notebook pane is first', await visible(p, '#ln-side') && !(await visible(p, '#ln-studio')));
  await tap(p, '#ln-switch [data-v="studio"]');
  check('L8 Studio swaps in', await visible(p, '#ln-studio') && !(await visible(p, '#ln-side')));
  await tap(p, '#ln-switch [data-v="notebook"]');
  await tap(p, row(LOG));
  check('L8 opening a file switches to Study', await waitFor(p, () => document.querySelector('#ln-switch [data-v="study"]').getAttribute('aria-selected') === 'true', 3000) && await visible(p, '#ln-doc'));
  await shot(p, 'L8-study');
};

S.L9 = async () => {
  await reset();
  errors.length = 0;
  const p = await page();
  await toLearn(p);
  await openFile(p, LOG);
  fs.rmSync(disk(LOG));
  const gone = await waitFor(p, (s) => !document.querySelector(s), 9000, tab(LOG));
  check('L9 a deleted file\'s tab closes on the next poll', gone);
  check('L9 with a toast naming it', /2026-11-12 study\.md" is gone/.test(String(await toastText(p))), await toastText(p));
  fs.rmSync(disk(NB), { recursive: true, force: true });
  check('L9 a deleted notebook goes back to the list', await waitFor(p, () => !document.querySelector('#ln-list .ln-nb') && !!document.getElementById('ln-first'), 9000));
  check('L9 no page errors', errors.length === 0, errors);
};

// The text in Learn's terminal (xterm draws to a canvas, so read its buffer).
const termText = (p) => ev(p, () => {
  const t = Learn.terminal();
  if (!t || !t.handle) return '';
  const b = t.handle.term.buffer.active;
  let out = '';
  for (let y = 0; y < b.length; y++) out += b.getLine(y).translateToString(true) + '\n';
  return out;
});
const learnTerms = async () => (((await api('GET', '/api/term/list')).body || {}).sessions || []).filter((x) => x.space && x.space.startsWith('learn-'));

S.L5 = async () => {
  await reset();
  const p = await page();
  await toLearn(p);
  await pane(p, 'study');
  check('L5 the start screen shows', await waitFor(p, () => !!document.querySelector('#ln-start:not(.hidden)'), 6000));
  const labels = await ev(p, () => [...document.querySelectorAll('#ln-start [data-start]')].map((b) => b.textContent.trim()));
  check('L5 two buttons: the default agent, then the other one', JSON.stringify(labels) === JSON.stringify(['Start Claude', 'Start Cursor']), labels);
  await shot(p, 'L5-start');
  await tap(p, '#ln-start [data-start="claude"]');
  check('L5 the agent starts with the Learn kickoff', await waitFor(p, () => {
    const t = Learn.terminal();
    if (!t || !t.handle) return false;
    const b = t.handle.term.buffer.active;
    for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true).includes('FAKE-claude started with: Tell me which sources')) return true;
    return false;
  }, 10000), await termText(p));
  check('L5 the start screen goes', await waitFor(p, () => !document.querySelector('#ln-start:not(.hidden)'), 3000));
  const id = await ev(p, () => Learn.terminal().id);
  const list = await learnTerms();
  check('L5 the server knows it as the notebook\'s space', list.length === 1 && list[0].id === id && list[0].spaceName === 'Learn · Sample notebook', list);
  await shot(p, 'L5-running');
  await sleep(6000);   // a sweep, so the server has seen the agent
  await p.reload({ waitUntil: 'networkidle2' });
  await toLearn(p);
  await pane(p, 'study');
  const back = await waitFor(p, (i) => { const t = Learn.terminal(); return !!t && t.id === i; }, 8000, id);
  check('L5 a reload reattaches the same terminal', back,
    await ev(p, () => ({ t: Learn.terminal() && Learn.terminal().id, list: TW.list().map((x) => [x.id, x.space]), mode: document.body.dataset.mode })));
  check('L5 only one terminal was made on the page', (await ev(p, () => document.querySelectorAll('#ln-term-host .xterm').length)) === 1);
  await sleep(4000);
  check('L5 and no start screen over a running agent', !(await visible(p, '#ln-start')));
  check('L5 still one terminal for the notebook', (await learnTerms()).length === 1);
};

S.L6 = async () => {
  await reset();
  const a = await page();
  await toLearn(a);
  await pane(a, 'study');
  await waitFor(a, () => !!document.querySelector('#ln-start [data-start="claude"]'), 6000);
  await tap(a, '#ln-start [data-start="claude"]');
  await waitFor(a, () => !!Learn.terminal(), 6000);
  await sleep(4000);   // the server lists it
  const b = await page({ context: a.ctx });
  await toLearn(b);
  await pane(b, 'study');
  check('L6 a second page attaches to the same terminal', await waitFor(b, () => !!Learn.terminal() && Learn.terminal().id.startsWith('learn-'), 8000));
  check('L6 the first page says it is open elsewhere', await waitFor(a, () => !!document.querySelector('#ln-moved:not(.hidden)'), 8000));
  await shot(a, 'L6-moved');
  await a.bringToFront();
  await tap(a, '#ln-bring');
  check('L6 Bring it here takes it back', await waitFor(a, () => !document.querySelector('#ln-moved:not(.hidden)'), 8000)
    && await waitFor(b, () => !!document.querySelector('#ln-moved:not(.hidden)'), 8000));
  check('L6 no second agent was started', (await learnTerms()).length === 1, await learnTerms());
};

S.L7 = async () => {
  if (OPTS.phone) { console.log('SKIP L7 (desktop dock)'); return; }
  await reset();
  const p = await page();
  await toLearn(p);
  await waitFor(p, () => !!document.querySelector('#ln-start [data-start="claude"]'), 6000);
  await tap(p, '#ln-start [data-start="claude"]');
  await waitFor(p, () => !!Learn.terminal(), 6000);
  const id = await ev(p, () => Learn.terminal().id);
  check('L7 the dock lists it as held in Learn', await waitFor(p, (i) => { const r = TW.rows().find((x) => x.id === i); return !!r && r.where === 'learn'; }, 8000, id));
  await tap(p, modeBtn('board'));
  await ev(p, (i) => TW.goTo(i), id);
  check('L7 going to it from the dock switches to Learn', await waitFor(p, () => document.body.dataset.mode === 'learn', 4000));
  check('L7 and the dock did not take it', await ev(p, (i) => !TW.session(i) && Learn.terminal().id === i, id));
  // A notebook terminal Learn isn't holding (another notebook open) still goes to Learn, not the dock.
  await ev(p, () => Learn.terminal().handle.detach());
  await sleep(500);
  await ev(p, (i) => TW.goTo(i), id);
  check('L7 a detached notebook terminal also goes to Learn', await waitFor(p, (i) => !TW.session(i) && !!Learn.terminal() && Learn.terminal().id === i, 6000, id));
};

(async () => {
  const names = NAMES.length ? NAMES : Object.keys(S);
  const unknown = names.filter((n) => !S[n]);
  if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(', ')}`); process.exit(2); }
  for (const n of names) {
    console.log(`— ${n} (${OPTS.phone ? 'phone' : 'desktop'}, ${OPTS.theme})`);
    try { await S[n](); } catch (e) { check(`${n} ran`, false, String(e.message).split('\n')[0]); }
    while (contexts.length) await contexts.pop().close().catch(() => {});
  }
  if (browser) await browser.close();
  if (failures) console.log(`\n${failures} failed: ${failed.join('; ')}`);
  process.exit(failures ? 1 : 0);
})();
