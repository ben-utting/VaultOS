'use strict';
// A fresh install of portable VaultOS, end to end, driven with puppeteer against the portable preview container
// (portable-preview, 127.0.0.1:7692) — never the live board (:7684).
//
//   node scripts/portable-e2e.js [base-url] [--with-installs]
//
// It first runs the preview's reset.sh (a blank vault and a new home volume, so the setup window opens again),
// checks the container really was recreated, and waits until it answers as a blank install. F1–F7 then walk that
// one install in order, in one browser profile: setup's five steps, a status change from the drawer, and
// Settings → Features, Boards and Agent. F8 (--with-installs) runs the real Claude Code and Cursor CLI installers
// inside the preview; it needs the network and only runs when asked for. No Install or Sign in button is pressed
// before the page shows the agent the scenario means. Every check prints a PASS/FAIL line, and the last line
// counts the scenarios ("7 passed"). The exit code is 1 when any check failed, 2 on bad usage. Screenshots go to
// /tmp/portable-shots/.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
// The preview: its reset.sh, its container, and the vault folder it mounts (read here to check what the app wrote).
const PREVIEW = '/opt/vault/portable-preview';
const CONTAINER = 'portable-preview';
const VAULT = path.join(PREVIEW, 'vault');
const SHOTS = '/tmp/portable-shots';
const DESKTOP = { width: 1600, height: 1000 };
const WELCOME = 'Work/1. getting-started/01-welcome-to-vaultos/task.md';   // the welcome card setup writes
const FAKE = { label: 'Fake', detect: 'fakeagent', start: "bash -c 'exec -a fakeagent sleep 60' {prompt}" };
const INSTALLS = [['claude', 'Claude Code'], ['cursor', 'Cursor CLI'], ['pi', 'Pi']];
// A new password each run; nobody signs in with it again (the browser keeps the session setup starts).
const PASSWORD = `e2e-${crypto.randomBytes(9).toString('base64url')}`;

const USAGE = 'usage: node scripts/portable-e2e.js [base-url] [--with-installs]';
const args = process.argv.slice(2);
const WITH_INSTALLS = args.includes('--with-installs');
const stray = args.filter((a) => a !== '--with-installs' && !/^https?:\/\//.test(a));
if (stray.length) { console.error(`${USAGE}\nunknown argument: ${stray[0]}`); process.exit(2); }
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:7692').replace(/\/$/, '');
// The one guard between a mistyped URL and the live data: an allowlist, not a substring test. The live board's
// port never, whatever the env says; and only the preview, since reset.sh and the vault paths above are its.
const PREVIEW_BASE = 'http://127.0.0.1:7692';
const basePort = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
if (basePort === '7684') { console.error(`refusing to run against ${BASE}: that is the live board's port (7684)`); process.exit(2); }
if (BASE !== PREVIEW_BASE) { console.error(`refusing to run against ${BASE}: only the portable preview, ${PREVIEW_BASE}`); process.exit(2); }

let failures = 0;
const failed = [];
let scen = '';                 // the scenario running, so check() can count its failures
const scenFails = {};
function check(name, ok, detail) {
  // ev() hands back { error } when the code under test threw: that is a FAIL, never a truthy pass.
  if (ok && typeof ok === 'object' && 'error' in ok) { if (detail === undefined) detail = ok; ok = false; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  if (!ok) { failures++; failed.push(name); scenFails[scen] = (scenFails[scen] || 0) + 1; }
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Node-side polling (files on disk, the container): resolves fn()'s first truthy value, or null.
async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(every);
  }
}
const vaultFile = (rel) => { try { return fs.readFileSync(path.join(VAULT, ...rel.split('/')), 'utf8'); } catch { return null; } };

let browser;
let P = null;   // the one page every scenario drives: setup leads into the app, and the session stays with it
async function openPage() {
  const puppeteer = (await import(PUPPETEER)).default;
  browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  await pg.setViewport(DESKTOP);
  await pg.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('vaultboard.theme', 'dark');
      // Start agent's terminal in this page's dock, not a pop-up window: the card pills are this page's.
      localStorage.setItem('vaultboard.term.where', JSON.stringify('dock'));
    } catch {}
  });
  // No WebGL renderer (xterm falls back to its DOM renderer, as term-e2e.js does): headless Chrome with
  // --disable-gpu paints the WebGL canvas blank, so a terminal in a screenshot needs it.
  await pg.evaluateOnNewDocument(() => { Object.defineProperty(window, 'WebglAddon', { get() { return { WebglAddon: function () { throw new Error('no WebGL'); } }; }, set() {} }); });
  pg.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  await pg.goto(BASE + '/', { waitUntil: 'networkidle2' });
  return pg;
}
async function waitFor(p, fn, ms = 5000, ...a) {
  try { await p.waitForFunction(fn, { timeout: Math.max(ms, 1), polling: 100 }, ...a); return true; } catch { return false; }
}
// page.evaluate that reports a thrown error as { error } instead of ending the run.
async function ev(p, fn, ...a) {
  try { return await p.evaluate(fn, ...a); } catch (e) { return { error: String(e.message).split('\n')[0] }; }
}
// page.click that reports a missing or hidden target as a FAIL instead of ending the run.
async function tap(p, sel) {
  try {
    await p.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await p.click(sel); return true;
  } catch (e) { check(`click ${sel}`, false, String(e.message).split('\n')[0]); return false; }
}
// Replaces what an input holds by typing, so its input listeners run as they would for a person.
async function fill(p, sel, value) {
  await ev(p, (s) => { const el = document.querySelector(s); if (el) el.value = ''; }, sel);
  try { await p.type(sel, value); return true; } catch (e) { check(`type into ${sel}`, false, String(e.message).split('\n')[0]); return false; }
}
// A click that navigates (Finish, Save and reload): waits for the new page to settle.
async function tapAndLoad(p, sel) {
  const nav = p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
  if (await tap(p, sel)) await nav;
}
async function shot(p, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const f = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: f });
  console.log(`  shot: ${f}`);
  return f;
}
// A GET from inside the page, with its session: { status, body }.
const getJson = (p, url) => ev(p, (u) => fetch(u, { cache: 'no-store' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })), url);
// Laid out and not hidden (an ancestor's display:none leaves no client rects). null when the element is
// missing, so a check for "hidden" (=== false) can't pass on an element that was never built.
const visible = (p, sel) => ev(p, (s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}, sel);
const text = (p, sel) => ev(p, (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
const texts = (p, sel) => ev(p, (s) => [...document.querySelectorAll(s)].map((el) => el.textContent.trim()), sel);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- The preview ----------
const reset = () => execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });
// The preview container's id and start time. reset.sh ends with `docker compose up -d`; a container that was not
// recreated would still hold the old install's home volume.
const containerTag = () => {
  try { return execFileSync('docker', ['inspect', '-f', '{{.Id}} {{.State.StartedAt}}', CONTAINER], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
// A blank install that is ready: /health says setup is due, and setup's state is the full five steps with the
// password window open (it opens when the container starts).
// Right after the container restarts, Node 18's fetch can hang on a socket that holds no ref, and node then exits
// quietly with code 0. An abort on an ordinary (ref'd) timer keeps the process alive and ends the hang.
async function fetchT(url, ms = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); } finally { clearTimeout(t); }
}
async function blankInstall(ms = 30000) {
  let last = 'no answer';
  const ok = await until(async () => {
    try {
      const h = await fetchT(BASE + '/health');
      const hb = await h.json().catch(() => ({}));
      const s = await fetchT(BASE + '/api/setup/state');
      const sb = await s.json().catch(() => ({}));
      if (h.status === 200 && hb.setup === true && sb.stage === 'full' && sb.windowOpen === true) return true;
      last = { health: [h.status, hb], state: { stage: sb.stage, windowOpen: sb.windowOpen } };
    } catch (e) { last = String(e.message); }
    return false;
  }, ms);
  return ok ? { ok: true } : { ok: false, last };
}

// ---------- Setup page ----------
const SU = { title: '#su-card .su-title', step: '#su-card .su-stepline', fwd: '#su-card .su-foot button[type=submit]' };
const onStep = (p, title, ms = 8000) => waitFor(p, (sel, t) => {
  const el = document.querySelector(sel);
  return !!el && el.textContent.trim() === t;
}, ms, SU.title, title);
// The error lines of the step's fields, in order.
const fieldErrors = (p) => ev(p, () => [...document.querySelectorAll('#su-card .su-field')].map((f) => (f.querySelector('.su-err') || {}).textContent || ''));

const SCEN = {};

// F1: a blank install's / is the setup page, and step 1 finds the folder mounted and empty.
SCEN.F1 = async () => {
  P = await openPage();
  check('F1 / serves the setup page', await waitFor(P, () => !!document.querySelector('#setup .su-title'), 10000)
    && await ev(P, () => location.pathname) === '/', await ev(P, () => location.href));
  check('F1 step 1 of 5 is Folder', await onStep(P, 'Folder') && await text(P, SU.step) === 'Step 1 of 5',
    [await text(P, SU.title), await text(P, SU.step)]);
  const rows = await ev(P, () => [...document.querySelectorAll('#su-card .su-check')].map((li) => ({
    kind: li.className.replace('su-check', '').trim(), title: li.querySelector('.su-check-t').textContent.trim(),
  })));
  const has = (kind, title) => Array.isArray(rows) && rows.some((r) => (!kind || r.kind === kind) && r.title === title);
  check('F1 says the folder is mounted', has('ok', 'Your folder is mounted'), rows);
  check('F1 says the folder is empty', has(null, 'This folder is empty'), rows);
  await shot(P, 'f1-folder');
};

// F2: confirming with a different password shows the error and sets nothing; a matching one moves to step 3.
SCEN.F2 = async () => {
  await tap(P, SU.fwd);
  check('F2 Next opens step 2, Password', await onStep(P, 'Password'), await text(P, SU.title));
  const pw = await P.$$('#su-card input[type=password]');
  if (!check('F2 the step has a password and a confirm field', pw.length === 2, pw.length)) return;
  await pw[0].type(PASSWORD);
  await pw[1].type(`${PASSWORD}-not`);
  await tap(P, SU.fwd);
  check('F2 mismatched passwords: "Passwords don\'t match" under Confirm', await waitFor(P, () => {
    const f = document.querySelectorAll('#su-card .su-field')[1];
    return !!f && f.querySelector('.su-err').textContent === "Passwords don't match";
  }), await fieldErrors(P));
  const st = await getJson(P, '/api/setup/state');
  check('F2 the mismatch set no password (still on Password, setup state full, signed out)', await text(P, SU.title) === 'Password'
    && st.status === 200 && st.body.stage === 'full' && st.body.authed === false, st);
  await ev(P, () => { document.querySelectorAll('#su-card input[type=password]')[1].value = ''; });
  await pw[1].type(PASSWORD);
  await tap(P, SU.fwd);
  check('F2 a good password moves to step 3, Boards', await onStep(P, 'Boards') && await text(P, SU.step) === 'Step 3 of 5',
    [await text(P, SU.title), await text(P, SU.step), await fieldErrors(P)]);
  const st2 = await getJson(P, '/api/setup/state');
  check('F2 the browser is signed in (setup state: boards, authed)', st2.status === 200 && st2.body.stage === 'boards' && st2.body.authed === true, st2);
};

// F3: boards Work and Home, agent None, Today off, Finish. The app opens on the Board with the welcome card in
// Backlog, the switcher lists both boards, and there is no Today button.
SCEN.F3 = async () => {
  const names = () => ev(P, () => [...document.querySelectorAll('#su-card .su-board input')].map((i) => i.value));
  check('F3 the first board is filled in as Work', same(await names(), ['Work']), await names());
  await tap(P, '#su-card .su-add');
  await P.keyboard.type('Home');   // Add another focuses the new row
  check('F3 boards Work and Home', same(await names(), ['Work', 'Home']), await names());
  await tap(P, SU.fwd);
  check('F3 Create boards opens step 4, Your coding agents', await onStep(P, 'Your coding agents', 10000), [await text(P, SU.title), await text(P, '#su-card .su-err')]);
  const tiles = () => ev(P, () => [...document.querySelectorAll('#su-card .ap-tile')].map((t) => t.dataset.id));
  check('F3 ten agent tiles, tested three first', await waitFor(P, () => document.querySelectorAll('#su-card .ap-tile').length === 10, 8000)
    && same((await tiles()).slice(0, 3), ['claude', 'cursor', 'pi']), await tiles());
  check('F3 it opens on Claude Code, with Install', await waitFor(P, () => /Claude Code/.test((document.querySelector('#su-card .ap-dname') || {}).textContent || '')
    && !!document.querySelector('#su-card .ap-detail [data-act="install"]'), 5000), await text(P, '#su-card .ap-detail'));
  await tap(P, '#su-card .ap-tile[data-id="pi"]');
  check('F3 picking Pi shows Pi and its Install', await waitFor(P, () => /^Pi/.test((document.querySelector('#su-card .ap-dname') || {}).textContent || '')
    && !!document.querySelector('#su-card .ap-detail [data-act="install"]'), 5000), await text(P, '#su-card .ap-detail'));
  check('F3 with no default the button still reads Skip', (await text(P, SU.fwd)).trim() === 'Skip', await text(P, SU.fwd));
  const ag = await getJson(P, '/api/agents');
  check('F3 /api/agents: default none, eight agents', ag.status === 200 && ag.body.default === 'none' && ag.body.agents.length === 8, ag);
  await tap(P, SU.fwd);
  check('F3 Next opens step 5, Extras', await onStep(P, 'Extras'), await text(P, SU.title));
  check('F3 Today is off', await ev(P, () => document.getElementById('su-today').checked) === false);
  await tapAndLoad(P, SU.fwd);
  check('F3 Finish opens the app on the Board', await waitFor(P, () => !document.getElementById('app').classList.contains('hidden')
    && document.getElementById('board-view').getClientRects().length > 0, 15000), await ev(P, () => [location.pathname, document.body.dataset.mode]));
  check('F3 the Backlog column has "Welcome to VaultOS"', await waitFor(P, () => [...document.querySelectorAll('.col-body[data-status="backlog"] .card h3')]
    .some((h) => h.textContent.trim() === 'Welcome to VaultOS'), 8000), await texts(P, '.col-body[data-status="backlog"] .card h3'));
  check('F3 no Today button', await visible(P, '#mode-today') === false, await visible(P, '#mode-today'));
  await tap(P, '#setbtn');
  await waitFor(P, () => document.querySelectorAll('#ws-list .ws-pick').length >= 2);
  check('F3 the switcher lists Work and Home', same(await texts(P, '#ws-list .ws-pick'), ['Work', 'Home']), await texts(P, '#ws-list .ws-pick'));
  await shot(P, 'f3-switcher');
  await tap(P, '#ss-close');
  await shot(P, 'f3-board');
};

// F4: In Progress from the drawer's status menu rewrites the welcome card's task.md on disk.
const CARD = `.card[data-path="${WELCOME}"]`;
SCEN.F4 = async () => {
  await tap(P, CARD);
  check('F4 the welcome card opens in the drawer', await waitFor(P, () => !document.getElementById('drawer').classList.contains('hidden')
    && document.getElementById('d-title').textContent.trim() === 'Welcome to VaultOS' && !!document.getElementById('d-status-select'), 8000),
  await text(P, '#d-title'));
  try { await P.select('#d-status-select', 'in-progress'); } catch (e) { check('F4 pick In Progress', false, String(e.message).split('\n')[0]); }
  const md = await until(() => { const t = vaultFile(WELCOME); return t && /^status: in-progress$/m.test(t) ? t : null; }, 5000);
  check('F4 the welcome task.md on disk has status: in-progress', !!md, ((vaultFile(WELCOME) || '').match(/^status:.*$/m) || [null])[0]);
  check('F4 the card moved to In Progress', await waitFor(P, (s) => !!document.querySelector(`.col-body[data-status="in-progress"] ${s}`), 5000, CARD));
  await tap(P, '#d-close');
  await waitFor(P, () => document.getElementById('drawer').classList.contains('hidden'));
};

// F5: Settings → Features → Today on. After the reload the Today button shows and Today renders.
SCEN.F5 = async () => {
  await tap(P, '#setbtn');
  await tap(P, '#ss-nav button[data-sec="features"]');
  check('F5 Features loads with Today off', await waitFor(P, () => document.getElementById('ft-tz').value !== '' && document.getElementById('ft-today').checked === false),
    await ev(P, () => [document.getElementById('ft-tz').value, document.getElementById('ft-today').checked]));
  await tap(P, '#ft-today');
  check('F5 the Today switch is on', await ev(P, () => document.getElementById('ft-today').checked) === true);
  await tapAndLoad(P, '#ft-save');
  check('F5 after the reload the Today button shows', await waitFor(P, () => !document.getElementById('app').classList.contains('hidden')
    && document.getElementById('mode-today').getClientRects().length > 0, 15000), await visible(P, '#mode-today'));
  if (!await ev(P, () => document.getElementById('mode-today').classList.contains('active'))) await tap(P, '#mode-today');
  check('F5 Today renders', await waitFor(P, () => {
    const d = document.getElementById('td-next-date');
    return !!d && d.textContent.trim() !== '' && document.getElementById('today-view').getClientRects().length > 0;
  }, 15000), [await text(P, '#td-next-date'), await text(P, '#td-err')]);
  await shot(P, 'f5-today');
};

// F6: Settings → Boards → add Notes. It is in the switcher, and AGENTS.md lists it.
SCEN.F6 = async () => {
  await tap(P, '#setbtn');
  await tap(P, '#ss-nav button[data-sec="ws"]');
  check('F6 Boards lists the two boards', await waitFor(P, () => document.querySelectorAll('#bd-list .bd-row').length === 2), await ev(P, () => document.querySelectorAll('#bd-list .bd-row').length));
  await fill(P, '#bd-add-name', 'Notes');
  await tap(P, '#bd-add button[type=submit]');
  check('F6 Notes is in the switcher', await waitFor(P, () => [...document.querySelectorAll('#ws-list .ws-pick')].some((e) => e.textContent.trim() === 'Notes'), 8000),
    [await texts(P, '#ws-list .ws-pick'), await text(P, '#bd-add-name-err')]);
  const line = '- **Notes** → `Notes/`';
  const agents = await until(() => { const t = vaultFile('AGENTS.md'); return t && t.split('\n').includes(line) ? t : null; }, 5000);
  check('F6 AGENTS.md lists Notes', !!agents, ((vaultFile('AGENTS.md') || '').match(/<!-- vaultos:boards -->[\s\S]*?<!-- \/vaultos:boards -->/) || [null])[0]);
  await shot(P, 'f6-boards');
  await tap(P, '#ss-close');
};

// F7: Settings → Agent → Other (Fake). Start agent on the welcome card opens a terminal; the card's pill reads Fake
// and working within 10 s, and idle (AGENT_QUIET_MS of quiet) within 35 s.
SCEN.F7 = async () => {
  await tap(P, '#setbtn');
  await tap(P, '#ss-nav button[data-sec="agent"]');
  await waitFor(P, () => !!document.querySelector('#ag-picker .ap-tile[data-id="custom"]'), 8000);
  check('F7 no Other fields on show before Other is picked', await visible(P, '#ag-custom') === false, await visible(P, '#ag-custom'));
  await tap(P, '#ag-picker .ap-tile[data-id="custom"]');
  check('F7 Other shows its fields', await waitFor(P, () => !!document.querySelector('#ag-picker .ap-custom-slot #ag-custom'), 5000) && await visible(P, '#ag-custom') === true);
  await fill(P, '#ag-f-label', FAKE.label);
  await fill(P, '#ag-f-detect', FAKE.detect);
  await fill(P, '#ag-f-start', FAKE.start);
  await tap(P, '#ag-custom-save');
  check('F7 Save agent: the footer names Fake as the default', await waitFor(P, () => ((document.querySelector('#ag-picker .ap-foot b') || {}).textContent || '') === 'Fake', 8000),
  [await text(P, '#ag-picker .ap-foot'), await text(P, '#ag-custom-err'), await text(P, '#ag-err')]);
  const ag = await getJson(P, '/api/agent');
  check('F7 /api/agent: custom, Fake, the start command with the prompt quoted in', ag.status === 200 && ag.body.profile === 'custom'
    && ag.body.label === 'Fake' && String(ag.body.startCommand).startsWith("bash -c 'exec -a fakeagent sleep 60' 'Catch me up"), ag);
  await tap(P, '#ss-close');
  await tap(P, '#mode-board');
  await waitFor(P, (s) => !!document.querySelector(s) && document.getElementById('board-view').getClientRects().length > 0, 8000, CARD);
  await tap(P, CARD);
  // The guard before anything starts: Start agent is offered, and for Fake (not some other agent).
  const ready = await waitFor(P, () => {
    const b = document.getElementById('d-agent');
    return !document.getElementById('drawer').classList.contains('hidden') && b.getClientRects().length > 0
      && /^Start agent\nOpens Fake in /.test(b.dataset.tip || '');
  }, 8000);
  if (!check('F7 the drawer offers Start agent for Fake', ready, await ev(P, () => document.getElementById('d-agent').dataset.tip))) return;
  check('F7 Start agent shows the default agent\'s mark', await ev(P, () => document.getElementById('d-agent').dataset.mark) === 'custom',
    await ev(P, () => document.getElementById('d-agent').dataset.mark));
  const t0 = Date.now();
  await tap(P, '#d-agent');
  check('F7 Start agent opens a terminal', await waitFor(P, () => typeof TW !== 'undefined' && TW.sessions().length === 1
    && !document.getElementById('term-dock').classList.contains('hidden'), 10000),
  await ev(P, () => [typeof TW !== 'undefined' ? TW.sessions().length : null, document.getElementById('term-dock').className]));
  const pill = () => ev(P, (s) => { const b = document.querySelector(`${s} > .card-agent`); return b ? { text: b.textContent.trim(), state: b.dataset.agent } : null; }, CARD);
  const working = await waitFor(P, (s) => {
    const b = document.querySelector(`${s} > .card-agent`);
    return !!b && b.textContent.trim().startsWith('Fake') && b.dataset.agent === 'working';
  }, 10000 - (Date.now() - t0), CARD);
  check(`F7 within 10 s the card pill reads Fake, data-agent="working" (${((Date.now() - t0) / 1000).toFixed(1)} s)`, working, await pill());
  await tap(P, '#d-close');
  await shot(P, 'f7-working');
  const idle = await waitFor(P, (s) => {
    const b = document.querySelector(`${s} > .card-agent`);
    return !!b && b.textContent.trim().startsWith('Fake') && b.dataset.agent === 'idle';
  }, 35000 - (Date.now() - t0), CARD);
  check(`F7 within 35 s it reads data-agent="idle" (${((Date.now() - t0) / 1000).toFixed(1)} s)`, idle, await pill());
  await shot(P, 'f7-idle');
};

// F8 (--with-installs): Settings → Agent → Claude Code, then Cursor CLI → Install, each until /api/agents reports it
// installed (180 s). These are the real installers, from the network, run inside the preview.
SCEN.F8 = async () => {
  for (const [id, label] of INSTALLS) {
    if (!await ev(P, () => !document.getElementById('setsheet').classList.contains('hidden'))) await tap(P, '#setbtn');
    await tap(P, '#ss-nav button[data-sec="agent"]');
    await waitFor(P, (i) => !!document.querySelector(`#ag-picker .ap-tile[data-id="${i}"]`), 8000, id);
    await tap(P, `#ag-picker .ap-tile[data-id="${id}"]`);
    // Never press Install for an agent the page isn't showing: the name is read again right before the click.
    const shown = await waitFor(P, (l) => ((document.querySelector('#ag-picker .ap-dname') || {}).textContent || '').startsWith(l)
      && !!document.querySelector('#ag-picker .ap-detail [data-act="install"]'), 8000, label);
    if (!check(`F8 Settings → Agent shows ${label} with an Install button`, shown, await text(P, '#ag-picker .ap-detail'))) continue;
    await tap(P, '#ag-picker .ap-detail [data-act="install"]');
    let last = null;
    const done = await until(async () => {
      last = await getJson(P, '/api/agents');
      return last && last.status === 200 && (last.body.agents.find((a) => a.id === id) || {}).installed === true;
    }, 180000, 3000);
    check(`F8 ${label}: /api/agents reports installed:true within 180 s`, !!done, last && last.body && last.body.agents);
    await shot(P, `f8-${id}`);
  }
};

(async () => {
  const names = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', ...(WITH_INSTALLS ? ['F8'] : [])];
  scen = 'reset';
  try {
    console.log(`--- reset ${CONTAINER} to a blank install`);
    const before = containerTag();
    let err = null;
    try { reset(); } catch (e) { err = String(e.message).split('\n')[0]; }
    const after = containerTag();
    if (check('reset.sh recreated the preview container', !err && !!after && after !== before, err || { before, after })) {
      const ready = await blankInstall();
      if (check('the preview answers as a blank install (health setup:true, state full, window open)', ready.ok, ready.last)) {
        for (const n of names) {
          scen = n;
          console.log(`--- ${n}`);
          try { await SCEN[n](); } catch (e) { check(`${n} ran to its end`, false, String(e.message).split('\n')[0]); }
        }
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  // A scenario passes when every one of its checks did; none can when the reset failed.
  const bad = names.filter((n) => scenFails.reset || scenFails[n]);
  const passed = names.length - bad.length;
  console.log(bad.length ? `${passed} passed, ${bad.length} failed (${bad.join(', ')})` : `${passed} passed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
