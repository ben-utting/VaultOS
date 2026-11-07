'use strict';
// Browser scenarios for the terminal UI, driven with puppeteer against the terminal preview container
// (herdr-term-preview, 127.0.0.1:7690) — never the live board (:7684; it would steal the live sessions).
//
//   node scripts/term-e2e.js [base-url] [--phone] [--theme=dark|sepia] S0 [S1 …]
//
// Each scenario first resets the preview (vault, home, container restart) to its synthetic pristine state.
// The session cookie comes from the preview's mint-cookie.js and is never printed. Every check prints a
// PASS/FAIL line; the exit code is 1 when any check failed, 2 on bad usage. Screenshots go to /tmp/term-shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PREVIEW = '/opt/vault/herdr-term-preview';
const SHOTS = '/tmp/term-shots';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:7690').replace(/\/$/, '');
const NAMES = args.filter((a) => !/^https?:\/\//.test(a) && !a.startsWith('--'));
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEFAULTS = { phone: args.includes('--phone'), theme: flag('theme') === 'sepia' ? 'light' : 'dark' };
// The one guard between a mistyped URL and the live sessions: an allowlist, not a substring test. Only the
// preview, unless TERM_E2E_OTHER_BASE=1 says another test server is meant; the live board's port never, either way.
const PREVIEW_BASE = 'http://127.0.0.1:7690';
const basePort = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
if (basePort === '7684') { console.error(`refusing to run against ${BASE}: that is the live board's port (7684)`); process.exit(2); }
if (BASE !== PREVIEW_BASE && process.env.TERM_E2E_OTHER_BASE !== '1') {
  console.error(`refusing to run against ${BASE}: only the preview, ${PREVIEW_BASE} (set TERM_E2E_OTHER_BASE=1 for another test server)`);
  process.exit(2);
}

let failures = 0;
const failed = [];
function check(name, ok, detail) {
  // ev() hands back { error } when the code under test threw: that is a FAIL, never a truthy pass.
  if (ok && typeof ok === 'object' && 'error' in ok) { if (detail === undefined) detail = ok; ok = false; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  if (!ok) { failures++; failed.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mintCookie = () => execFileSync('node', [path.join(PREVIEW, 'mint-cookie.js')], { encoding: 'utf8' }).trim();
const cookieHeader = () => mintCookie();
function cookies() {
  const url = new URL(BASE);
  return mintCookie().split('; ').map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: url.hostname, path: '/' };
  });
}

let browser;
// A browser plus one cookie-set context (a context is one "browser profile": its tabs share localStorage).
async function launch() {
  if (!browser) {
    const puppeteer = (await import(PUPPETEER)).default;
    browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  }
  const context = await browser.createBrowserContext();
  await context.setCookie(...cookies().map((c) => ({ ...c, url: BASE })));
  return context;
}
// Opens a page in the context (default: a fresh one) at BASE + path.
// noGL: no WebGL renderer (xterm falls back to its DOM renderer, which term.js already allows). Headless Chrome with
// --disable-gpu paints nothing from the WebGL canvas at deviceScaleFactor 2, so phone screenshots need it.
async function page(p, { phone = DEFAULTS.phone, theme = DEFAULTS.theme, context, noGL = false } = {}) {
  const ctx = context || await launch();
  const pg = await ctx.newPage();
  await pg.setViewport(phone ? PHONE : DESKTOP);
  await pg.evaluateOnNewDocument((t) => { try { localStorage.setItem('vaultboard.theme', t); } catch {} }, theme);
  if (noGL) await pg.evaluateOnNewDocument(() => { Object.defineProperty(window, 'WebglAddon', { get() { return { WebglAddon: function () { throw new Error('no WebGL'); } }; }, set() {} }); });
  pg.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  await pg.goto(BASE + p, { waitUntil: 'networkidle2' });
  return pg;
}
// Opens the terminal dock in the main page and waits for its first session.
async function dock(p) {
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('vaultboard.term.where', JSON.stringify('dock')); } catch {} });
  await p.evaluate(() => { localStorage.setItem('vaultboard.term.where', JSON.stringify('dock')); });
  await p.reload({ waitUntil: 'networkidle2' });
  await p.evaluate(() => termOpen());
  await waitFor(p, () => typeof TW !== 'undefined' && TW.sessions().length > 0, 10000);
  const id = await p.evaluate(() => TW.sessions()[0].id);
  await sleep(1500);   // the shell's first prompt
  return id;
}
const win = (p) => p.goto(BASE + '/terminal.html', { waitUntil: 'networkidle2' });
const typeIn = (p, id, text) => p.evaluate((i, t) => TW.session(i).handle.type(t), id, text);
// The visible text of a session's xterm buffer.
const screen = (p, id) => p.evaluate((i) => {
  const b = TW.session(i).handle.term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true));
  return out.join('\n');
}, id);
async function waitFor(p, fn, ms = 5000, ...a) {
  try { await p.waitForFunction(fn, { timeout: ms, polling: 100 }, ...a); return true; } catch { return false; }
}
const fake = (p, id, state) => typeIn(p, id, `node /app/scripts/term-fake-agent.js ${state}\r`);
async function list() {
  const r = await fetch(BASE + '/api/term/list', { headers: { Cookie: cookieHeader() } });
  return (await r.json()).sessions;
}
async function shot(p, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const f = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: f });
  return f;
}
const reset = () => execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });
// Polls /api/term/list until pred(session) holds for the id.
async function listWait(id, pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = (await list()).find((x) => x.id === id);
    if (s && pred(s)) return s;
    await sleep(200);
  }
  return null;
}

// The dock page with no terminal in it yet (dock() opens one at the vault root first).
async function bare(p) {
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('vaultboard.term.where', JSON.stringify('dock')); } catch {} });
  await p.evaluate(() => { localStorage.setItem('vaultboard.term.where', JSON.stringify('dock')); });
  await p.reload({ waitUntil: 'networkidle2' });
}
// Opens a terminal in the dock with TW.create(o) and returns its id (null when none was added).
async function openTerm(p, o = {}) {
  const before = await p.evaluate(() => TW.sessions().map((s) => s.id));
  await p.evaluate((x) => { showTerminals(); TW.create(x); }, o);
  await waitFor(p, (b) => TW.sessions().some((s) => !b.includes(s.id)), 10000, before);
  return p.evaluate((b) => (TW.sessions().find((s) => !b.includes(s.id)) || {}).id || null, before);
}
// page.evaluate that reports a thrown error as { error } instead of ending the run (an API that
// isn't there yet makes the check FAIL, not crash). check() fails an { error } passed as its result;
// a check built from an ev() result compares it (=== true, Array.isArray …), never just its truthiness.
async function ev(p, fn, ...a) {
  try { return await p.evaluate(fn, ...a); } catch (e) { return { error: String(e.message).split('\n')[0] }; }
}
// Records every TW.onEvent event in window.__ev, from the first moment TW exists (every load).
const recordEvents = (p) => p.evaluateOnNewDocument(() => {
  window.__ev = [];
  const t0 = Date.now();
  const iv = setInterval(() => {
    try {
      if (typeof TW !== 'undefined' && typeof TW.onEvent === 'function') { TW.onEvent((e) => window.__ev.push(e)); clearInterval(iv); }
    } catch { /* not yet */ }
    if (Date.now() - t0 > 15000) clearInterval(iv);
  }, 5);
});
// The panes on screen in the dock (not .tw-off).
const visiblePanes = (p) => p.evaluate(() => [...document.querySelectorAll('#term-area .tw-pane:not(.tw-off)')].map((el) => el.dataset.id));

const SCEN = {};

// S0: the bench works — dock opens, a shell answers, the fake agent's state reaches the server.
SCEN.S0 = async () => {
  const p = await page('/');
  const id = await dock(p);
  await typeIn(p, id, 'echo e2e-ok\r');
  check('S0 shell echoes', await waitFor(p, (i) => {
    const b = TW.session(i).handle.term.buffer.active;
    for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true).startsWith('e2e-ok')) return true;
    return false;
  }, 5000, id), await screen(p, id));
  await fake(p, id, 'blocked');
  const s = await listWait(id, (x) => x.agent && x.agent.state === 'blocked');
  check('S0 fake agent blocked reaches /api/term/list', !!s, (await list()).find((x) => x.id === id));
  await shot(p, 'S0');
  await p.close();
};

// S0b: a terminal opened in a job folder links to that task; one in a repo reports its branch.
SCEN.S0b = async () => {
  const JOB = 'Personal/1. apps/01-api-refactor';
  const p = await page('/');
  const id = await dock(p);
  const open = async (cwd) => {
    const before = new Set(await p.evaluate(() => TW.sessions().map((s) => s.id)));
    await p.evaluate((c) => TW.create({ cwd: c }), cwd);
    await waitFor(p, (b) => TW.sessions().some((s) => !b.includes(s.id)), 10000, [...before]);
    return p.evaluate((b) => TW.sessions().find((s) => !b.includes(s.id)).id, [...before]);
  };
  const jobId = await open(JOB + '/data');
  const s = await listWait(jobId, (x) => x.taskTitle === 'API refactor');
  const got = s || (await list()).find((x) => x.id === jobId);
  check('S0b task auto-linked', got && got.task === JOB + '/task.md', got);
  check('S0b task title', got && got.taskTitle === 'API refactor', got);
  check('S0b task status', got && got.taskStatus === 'in-progress', got);
  const repoId = await open('Code/DevOps/demo-repo');
  const r = await listWait(repoId, (x) => x.branch === 'feature-x');
  check('S0b git branch', !!r, (await list()).find((x) => x.id === repoId));
  check('S0b plain shell has no task', ((await list()).find((x) => x.id === id) || {}).task === '', (await list()).find((x) => x.id === id));
  await p.close();
};

// S3a: a hidden dock never resizes the live pty to 80 columns on reattach; OSC titles are reported.
SCEN.S3a = async () => {
  const p = await page('/');
  const id = await dock(p);
  const cat = () => { try { return execFileSync('docker', ['exec', 'herdr-term-preview', 'cat', `/tmp/cols-${id}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  await typeIn(p, id, 'while :; do tput cols > /tmp/cols-$VAULTOS_TERM_ID; sleep 1; done\r');
  await sleep(2000);
  const C = cat();
  const tc = await p.evaluate((i) => TW.session(i).handle.term.cols, id);
  check('S3a pty cols match xterm and are not 80', C === String(tc) && C !== '80', { C, tc });
  await p.click('#term-min');
  await sleep(500);
  await p.reload({ waitUntil: 'networkidle2' });
  await sleep(4000);
  check('S3a cols unchanged after hidden reload', cat() === C, { now: cat(), C });
  await p.close();
  const q = await page('/');
  const id2 = await dock(q);
  await typeIn(q, id2, 'cd /vault\r');
  const ok = await waitFor(q, (i) => { const h = TW.session(i).handle; return typeof h.title === 'function' && h.title().includes('/vault'); }, 5000, id2);
  check('S3a title contains /vault', ok, await q.evaluate((i) => { const h = TW.session(i).handle; return typeof h.title === 'function' ? h.title() : 'title is not a function'; }, id2));
  await q.close();
};

// S1: split right and down, drag a divider, double-click it even, zoom, close from the ⋯ menu. A reload
// keeps the arrangement. A terminal in another folder is its own space; the hidden one keeps its size.
SCEN.S1 = async () => {
  const p = await page('/');
  p.on('dialog', (d) => d.accept());
  await dock(p);
  // The panes on screen (not .tw-off, visibility visible), as fractions of .tw-panes, left to right.
  const shown = () => p.evaluate(() => {
    const box = document.querySelector('#term-area .tw-panes').getBoundingClientRect();
    return [...document.querySelectorAll('#term-area .tw-pane')]
      .filter((el) => !el.classList.contains('tw-off') && getComputedStyle(el).visibility === 'visible')
      .map((el) => {
        const r = el.getBoundingClientRect();
        const f = (n) => Math.round(n * 1000) / 1000;
        return { id: el.dataset.id, x: f((r.left - box.left) / box.width), y: f((r.top - box.top) / box.height), w: f(r.width / box.width), h: f(r.height / box.height) };
      })
      .sort((a, b) => a.x - b.x || a.y - b.y);
  });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const count = (n) => waitFor(p, (k) => TW.sessions().length === k, 10000, n);
  const settle = () => sleep(400);

  // 1. One terminal, split right, then split down: one left pane and two stacked on the right.
  await p.click('#term-area [data-act="split-right"]');
  await count(2);
  await p.click('#term-area [data-act="split-down"]');
  await count(3);
  await settle();
  let v = await shown();
  check('S1 three panes shown after split right + down', v.length === 3, v);
  const [L, R1, R2] = v;
  check('S1 one left pane and two stacked right panes', v.length === 3
    && near(L.x, 0, 0.01) && L.h > 0.85 && near(L.w, 0.5, 0.02)
    && near(R1.x, 0.5, 0.02) && near(R2.x, 0.5, 0.02) && R1.y < 0.1 && near(R2.y, 0.5, 0.06)
    && R1.h > 0.35 && R1.h < 0.5 && R2.h > 0.35 && R2.h < 0.5, v);
  await shot(p, 's1-three-dark');
  const border = await p.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    const f = document.querySelector('#term-area .tw-pane.focused');
    return { want, got: f ? getComputedStyle(f).borderLeftColor : null };
  });
  check('S1 focused pane border is --accent', border.got === border.want, border);

  // 2. Drag the vertical divider from 50% to 70%.
  const box = await p.evaluate(() => { const r = document.querySelector('#term-area .tw-panes').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const divider = () => p.evaluate(() => {
    const el = document.querySelector('#term-area .tw-split[data-dir="row"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 4 };   // clear of the T where the right-hand split meets it
  });
  let d = await divider();
  check('S1 a vertical divider is there', !!d, d);
  if (d) {
    await p.mouse.move(d.x, d.y);
    await p.mouse.down();
    await p.mouse.move(box.x + box.w * 0.7, d.y, { steps: 8 });
    await p.mouse.up();
  }
  await settle();
  v = await shown();
  check('S1 drag to 70%: left pane width 0.68–0.72', v[0] && v[0].w >= 0.68 && v[0].w <= 0.72, v);

  // 3. A double-click, timed by hand (two clicks under 400ms apart), evens it out again.
  d = await divider();
  if (d) {
    await p.mouse.click(d.x, d.y);
    await sleep(120);
    await p.mouse.click(d.x, d.y);
  }
  await settle();
  v = await shown();
  check('S1 double-click evens the divider to 0.5', v[0] && near(v[0].w, 0.5, 0.02), v);

  // 4. Zoom: one pane fills .tw-panes; again: all three.
  await p.click('#term-area [data-act="zoom"]');
  await settle();
  v = await shown();
  check('S1 zoom shows one pane filling the area', v.length === 1 && near(v[0].x, 0, 0.01) && near(v[0].y, 0, 0.01) && near(v[0].w, 1, 0.01) && near(v[0].h, 1, 0.01), v);
  check('S1 zoom button is pressed', await p.$eval('#term-area [data-act="zoom"]', (b) => b.getAttribute('aria-pressed')) === 'true');
  await p.click('#term-area [data-act="zoom"]');
  await settle();
  check('S1 unzoom shows three again', (await shown()).length === 3, await shown());

  // 5. The ⋯ menu's Close (the confirm is accepted).
  await p.click('#term-area .tw-pane.focused .tw-pane-more');
  const menuUp = await waitFor(p, () => { const m = document.querySelector('#term-area .tw-menu'); return m && !m.hidden && m.offsetHeight > 0; }, 2000);
  check('S1 ⋯ opens the pane menu', menuUp);
  if (menuUp) await p.click('#term-area .tw-menu [data-m="close"]');
  await count(2);
  await settle();
  const before = await shown();
  check('S1 close from the menu leaves two panes', before.length === 2, before);

  // 6. A reload keeps the arrangement.
  await p.reload({ waitUntil: 'networkidle2' });
  await count(2);
  await sleep(1500);
  const after = await shown();
  check('S1 reload keeps the two panes in the same arrangement', after.length === 2 && before.length === 2
    && after.every((r, i) => r.id === before[i].id && near(r.x, before[i].x, 0.01) && near(r.y, before[i].y, 0.01)
      && near(r.w, before[i].w, 0.01) && near(r.h, before[i].h, 0.01)), { before, after });
  const tree = await p.evaluate(() => { try { const o = JSON.parse(sessionStorage.getItem('vaultboard.term.tree')); return o && o.v === 1 && !!o.spaces ? o : null; } catch { return null; } });
  check('S1 sessionStorage vaultboard.term.tree parses', !!tree, tree);

  // 7. A terminal in another folder is another space; the first one stays at its real size while hidden.
  const prev = await p.evaluate(() => TW.activeSpace());
  await p.evaluate(() => TW.create({ cwd: 'Personal/1. apps/02-web-login' }));
  await count(3);
  await settle();
  const now = await p.evaluate(() => TW.activeSpace());
  check('S1 a terminal in another folder makes its space active', !!now && now !== prev, { prev, now });
  const single = await p.evaluate(() => {
    const el = [...document.querySelectorAll('#term-area .tw-pane')].filter((x) => !x.classList.contains('tw-off'));
    if (el.length !== 1) return { n: el.length };
    const strip = el[0].querySelector('.tw-pane-strip');
    return { n: 1, strip: strip ? strip.offsetHeight : 0, border: getComputedStyle(el[0]).borderLeftWidth };
  });
  check('S1 the new space shows one pane, no strip, no border', single.n === 1 && single.strip === 0 && single.border === '0px', single);
  check('S1 only one pane visible in the new space', (await shown()).length === 1, await shown());
  await p.evaluate((k) => TW.showSpace(k), prev);
  await settle();
  check('S1 showSpace(previous) shows its two panes', (await shown()).length === 2, await shown());
  const hidden = await p.evaluate(() => [...document.querySelectorAll('#term-area .tw-pane.tw-off .term-host')].map((h) => h.offsetWidth));
  check('S1 the hidden pane keeps its size (visibility, not display)', hidden.length === 1 && hidden[0] > 0, hidden);

  // 8. Both themes.
  await shot(p, 's1-split-dark');
  await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await settle();
  await shot(p, 's1-split-sepia');

  // 9. A zoom survives a reload, even when the zoomed pane is restored after its sibling.
  const order = await p.evaluate(() => TW.sessions().map((s) => s.id));
  await p.evaluate((i) => TW.focus(i), order[1]);
  await p.click('#term-area [data-act="zoom"]');
  await settle();
  const z = await shown();
  await p.reload({ waitUntil: 'networkidle2' });
  await count(3);
  await sleep(1500);
  const z2 = await shown();
  check('S1 reload keeps a zoom on a pane restored after its sibling', z.length === 1 && order.indexOf(z[0].id) > 0
    && z2.length === 1 && z2[0].id === z[0].id
    && await p.$eval('#term-area [data-act="zoom"]', (b) => b.getAttribute('aria-pressed')) === 'true', { z, z2, order });
  await p.close();
};

// S1b: the tree keeps no stale leaves (a new pane opens at its final size), a split stays in its
// target's space, and a pane added unfocused into too small a space is the one zoomed.
SCEN.S1b = async () => {
  // (a) A pop-out window whose saved tree (sessionStorage and the localStorage mirror) still holds
  // leaves of sessions it handed back: its first pane fills the area from the start, so the very first
  // cols the server hears (the WebSocket URL) are the full width, not the width of a ghost's slot.
  const ghost = JSON.stringify({ v: 1, active: 'd:', spaces: { 'd:': { root: { dir: 'row', r: 0.5, a: { id: 'ghost-a' }, b: { dir: 'col', r: 0.5, a: { id: 'ghost-b' }, b: { id: 'ghost-c' } } }, focus: 'ghost-a', zoom: null } } });
  const ctx = await launch();
  const w = await ctx.newPage();
  await w.setViewport(DESKTOP);
  w.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  await w.evaluateOnNewDocument((t) => {
    try { if (location.pathname === '/terminal.html') { sessionStorage.setItem('vaultboard.termwin.tree', t); localStorage.setItem('vaultboard.termwin.tree', t); } } catch {}
  }, ghost);
  const cdp = await w.createCDPSession();
  await cdp.send('Network.enable');
  const sockets = [];
  cdp.on('Network.webSocketCreated', (e) => { if (e.url.includes('/api/term?')) sockets.push(e.url); });
  await w.goto(BASE + '/terminal.html', { waitUntil: 'networkidle2' });
  await waitFor(w, () => typeof TW !== 'undefined' && TW.sessions().length === 1, 10000);
  await sleep(1500);
  const first = sockets.length ? Number(new URL(sockets[0]).searchParams.get('cols')) : null;
  const now = await w.evaluate(() => ({
    cols: TW.session(TW.sessions()[0].id).handle.term.cols,
    single: !!TW.sessions()[0].pane.dataset.single,
    leaves: JSON.stringify(JSON.parse(sessionStorage.getItem('vaultboard.termwin.tree')).spaces).match(/ghost-/g),
  }));
  check('S1b ghost leaves in a saved tree are dropped before the first pane opens', !now.leaves && now.single, now);
  check('S1b the first pane connects at its full width', first != null && first === now.cols && first > 150, { first, now: now.cols, sockets });
  await w.close();

  // (b) Task terminal T, plain shell P in the same folder (P joins T's space); close T; split P.
  const JOB = 'Personal/1. apps/01-api-refactor';
  const p = await page('/');
  await dock(p);
  const open = async (o) => {
    const before = await p.evaluate(() => TW.sessions().map((s) => s.id));
    await p.evaluate((x) => TW.create(x), o);
    await waitFor(p, (b) => TW.sessions().some((s) => !b.includes(s.id)), 10000, before);
    return p.evaluate((b) => TW.sessions().find((s) => !b.includes(s.id)).id, before);
  };
  const T = await open({ cwd: JOB, task: JOB + '/task.md' });
  const P = await open({ cwd: JOB });
  const joined = await p.evaluate(() => TW.activeSpace());
  await p.evaluate((i) => TW.remove(i), T);
  await p.evaluate((i) => TW.focus(i), P);
  await sleep(300);
  const before = await p.evaluate(() => TW.activeSpace());
  await p.evaluate(() => TW.split('right'));
  await waitFor(p, (n) => TW.sessions().length === n, 10000, 3);
  await sleep(300);
  const after = await p.evaluate(() => ({
    key: TW.activeSpace(),
    shown: [...document.querySelectorAll('#term-area .tw-pane:not(.tw-off)')].map((el) => el.dataset.id),
  }));
  check('S1b a split stays in its target\'s space (after the task terminal closed)', joined === `t:${JOB}/task.md`
    && before === joined && after.key === before && after.shown.length === 2 && after.shown.includes(P), { joined, before, after });

  // (c) A pane added without focus that leaves a pane under 140×70px is the one zoomed.
  await p.evaluate(() => { localStorage.setItem('vaultboard.term.h', '160'); document.body.style.setProperty('--dock-user-h', '160px'); });
  await sleep(300);
  const id = await p.evaluate((t) => TW.add({ cwd: 'Personal/1. apps/01-api-refactor', split: 'down', target: t }).id, P);
  await sleep(500);
  const z = await p.evaluate((nid) => {
    const tree = JSON.parse(sessionStorage.getItem('vaultboard.term.tree'));
    const sp = tree.spaces[TW.activeSpace()];
    return {
      h: document.querySelector('#term-area .tw-panes').clientHeight,
      zoom: sp && sp.zoom, isNew: sp && sp.zoom === nid,
      shown: [...document.querySelectorAll('#term-area .tw-pane:not(.tw-off)')].map((el) => el.dataset.id),
    };
  }, id);
  check('S1b an unfocused add into too small a space zooms the new pane', z.isNew && z.shown.length === 1 && z.shown[0] === id, z);
  await p.close();
};

// S2: spaces come from the server list: a job folder's terminal is its task's space (named by the task
// title, with its status), a repo is named by its folder with its branch, the root is "vault". A rename
// survives a reload.
const JOB = 'Personal/1. apps/01-api-refactor';
const JOB_KEY = `t:${JOB}/task.md`;
SCEN.S2 = async () => {
  const p = await page('/');
  await bare(p);
  const job = await openTerm(p, { cwd: JOB + '/data' });
  await openTerm(p, { cwd: 'Code/DevOps/demo-repo' });
  const root = await openTerm(p, {});
  const want = ['API refactor', 'demo-repo', 'vault'];
  const names = () => ev(p, () => TW.spaces().map((s) => s.name));
  const ok = await waitFor(p, (w) => typeof TW.spaces === 'function' && JSON.stringify(TW.spaces().map((s) => s.name)) === JSON.stringify(w), 8000, want);
  check('S2 spaces after a poll: API refactor, demo-repo, vault', ok, await names());
  const repo = await ev(p, () => TW.spaces().find((s) => s.name === 'demo-repo'));
  check('S2 the demo-repo space detail is feature-x', repo && repo.detail === 'feature-x', repo);
  await p.evaluate((i) => TW.focus(i), job);
  await sleep(300);
  const bar = () => p.evaluate(() => ({
    name: document.querySelector('#term-area .tw-space-name').textContent,
    detail: document.querySelector('#term-area .tw-space-detail').textContent,
  }));
  const b1 = await bar();
  check('S2 the bar shows API refactor / in progress', b1.name === 'API refactor' && b1.detail === 'in progress', b1);
  await shot(p, 's2-spaces');
  const key = await ev(p, (i) => TW.session(i).key, job);
  check('S2 the job terminal is keyed to its task', key === JOB_KEY, key);
  await ev(p, (k) => TW.renameSpace(k, 'Auth'), key);
  await sleep(200);
  check('S2 renameSpace re-renders the bar', (await bar()).name === 'Auth', await bar());
  await p.reload({ waitUntil: 'networkidle2' });
  await waitFor(p, (n) => TW.sessions().length === n, 10000, 3);
  await p.evaluate((i) => TW.focus(i), job);
  const kept = await waitFor(p, () => typeof TW.spaces === 'function' && TW.spaces().some((s) => s.name === 'Auth'), 8000);
  const stored = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('vaultboard.term.spaceNames')); } catch { return null; } });
  check('S2 the rename persists across a reload (vaultboard.term.spaceNames)', kept && stored && stored[JOB_KEY] === 'Auth', { stored, names: await names() });
  check('S2 the bar shows the renamed space', (await bar()).name === 'Auth', await bar());
  check('S2 the root terminal is still here', await p.evaluate((i) => !!TW.session(i), root));
  await p.close();
};

// S2-moved: /done moves the task folder into _done/ while its terminals are open. The space follows
// (its key ends in _done/…), keeping its panes, their split layout and the custom name.
SCEN['S2-moved'] = async () => {
  const p = await page('/');
  await bare(p);
  const job = await openTerm(p, { cwd: JOB + '/data' });
  await openTerm(p, {});
  const linked = await waitFor(p, (i, k) => TW.session(i).key === k, 8000, job, JOB_KEY);
  check('S2-moved the job terminal is keyed to its task first', linked, await ev(p, (i) => TW.session(i).key, job));
  await p.evaluate((i) => TW.focus(i), job);
  await p.evaluate(() => TW.split('right'));
  await waitFor(p, (n) => TW.sessions().length === n, 10000, 3);
  const second = await p.evaluate((i) => TW.focused().id, job);
  await waitFor(p, (i, k) => TW.session(i) && TW.session(i).key === k, 8000, second, JOB_KEY);
  await ev(p, (k) => TW.renameSpace(k, 'Auth'), JOB_KEY);
  const tree = (k) => p.evaluate((key) => { const t = JSON.parse(sessionStorage.getItem('vaultboard.term.tree')); return t.spaces[key] ? JSON.stringify(t.spaces[key].root) : null; }, k);
  const before = await tree(JOB_KEY);
  execFileSync('docker', ['exec', 'herdr-term-preview', 'mv', `/vault/${JOB}`, '/vault/Personal/1. apps/_done/']);
  const DONE = 'Personal/1. apps/_done/01-api-refactor/task.md';
  const moved = await waitFor(p, (i, d) => TW.session(i) && TW.session(i).key.endsWith(d), 6000, job, '_done/01-api-refactor/task.md');
  const got = await ev(p, (i) => {
    const s = TW.session(i);
    const sp = s && TW.spaces().find((x) => x.ids.includes(i));
    return { held: !!s, pane: !!(s && s.pane && s.pane.isConnected), key: s && s.key, name: sp && sp.name };
  }, job);
  check('S2-moved within 6s the held pane is still there', moved && got.held && got.pane, got);
  check('S2-moved the space key ends with _done/01-api-refactor/task.md', got.key === 't:' + DONE, got);
  check('S2-moved the custom name Auth moved with it', got.name === 'Auth', got);
  const after = await tree('t:' + DONE);
  check('S2-moved the split layout is kept', !!before && after === before, { before, after });
  check('S2-moved the second pane moved too', (await ev(p, (i, k) => TW.session(i).key === k, second, 't:' + DONE)) === true, await ev(p, (i) => TW.session(i).key, second));
  await shot(p, 's2-moved');
  await p.close();
};

// S4: another browser profile brings a dock's terminal into its window (a steal, code 4000): the dock
// drops the pane and sees the terminal as "elsewhere". goTo brings it back.
SCEN.S4 = async () => {
  const p = await page('/');
  await recordEvents(p);
  const id = await dock(p);
  const ctxB = await launch();   // the same minted cookie, another profile (no BroadcastChannel between them)
  const b = await page('/terminal.html', { context: ctxB });
  await waitFor(b, () => typeof TW !== 'undefined' && TW.sessions().length > 0, 10000);
  await p.bringToFront();
  await ev(b, (i) => TW.bring({ id: i }), id);
  check('S4 B holds the brought terminal', await waitFor(b, (i) => !!TW.session(i), 3000, id));
  check('S4 within 5s A no longer has the pane', await waitFor(p, (i) => !TW.session(i) && !document.querySelector(`#term-area .tw-pane[data-id="${i}"]`), 5000, id),
    await ev(p, (i) => TW.session(i) && TW.session(i).state, id));
  check("S4 A's where(id) is 'elsewhere'", await waitFor(p, (i) => typeof TW.where === 'function' && TW.where(i) === 'elsewhere', 5000, id), await ev(p, (i) => TW.where(i), id));
  const evs = await ev(p, () => window.__ev);
  check('S4 A emitted a moved event for it', Array.isArray(evs) && evs.some((e) => e.kind === 'moved' && e.id === id && typeof e.name === 'string'), evs);
  check('S4 A shows an "opened elsewhere" toast', await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => /opened elsewhere/.test(t.textContent)), 3000), await toastTexts(p));
  check('S4 A dropped it from its saved sessions', (await ev(p, (i) => !TW.savedSessions().some((m) => m.id === i), id)) === true,
    await ev(p, () => TW.savedSessions()));
  await ev(p, (i) => TW.goTo(i), id);
  check('S4 goTo brings it back to A', await waitFor(p, (i) => TW.session(i) && TW.session(i).state === 'open', 5000, id), await ev(p, (i) => TW.session(i) && TW.session(i).state, id));
  check('S4 B loses it', await waitFor(b, (i) => !TW.session(i), 5000, id), await ev(b, (i) => TW.session(i) && TW.session(i).state, id));
  await shot(p, 's4-back');
  await b.close();
  await p.close();
};

// S4-twotabs: two VaultOS tabs in one profile, each with its own dock terminal. Reloading one takes
// back only its own terminal (sessionStorage-first saved sessions); nothing is stolen, nothing moves.
SCEN['S4-twotabs'] = async () => {
  const ctx = await launch();
  const p1 = await page('/', { context: ctx });
  const p2 = await page('/', { context: ctx });
  for (const p of [p1, p2]) { await recordEvents(p); await bare(p); }
  const a = await openTerm(p1, {});
  const b = await openTerm(p2, {});
  await sleep(1500);
  check("S4-twotabs presence: tab 2 sees tab 1's terminal as 'tab'", await waitFor(p2, (i) => typeof TW.where === 'function' && TW.where(i) === 'tab', 4000, a),
    await ev(p2, (i) => TW.where(i), a));
  await p1.reload({ waitUntil: 'networkidle2' });
  await sleep(4000);
  const held = async (p) => ev(p, () => TW.sessions().map((s) => ({ id: s.id, state: s.state })));
  const h1 = await held(p1);
  const h2 = await held(p2);
  check('S4-twotabs tab 1 holds exactly its own terminal', Array.isArray(h1) && h1.length === 1 && h1[0].id === a && h1[0].state === 'open', { h1, a, b });
  check('S4-twotabs tab 2 holds exactly its own terminal', Array.isArray(h2) && h2.length === 1 && h2[0].id === b && h2[0].state === 'open', { h2, a, b });
  const e1 = await ev(p1, () => window.__ev);
  const e2 = await ev(p2, () => window.__ev);
  const noMoved = (e) => Array.isArray(e) && !e.some((x) => x.kind === 'moved');
  check('S4-twotabs no moved events in either tab', noMoved(e1) && noMoved(e2), { e1, e2 });
  check("S4-twotabs after the reload tab 2 sees tab 1's terminal as 'tab' again", await waitFor(p2, (i) => typeof TW.where === 'function' && TW.where(i) === 'tab', 4000, a),
    await ev(p2, (i) => TW.where(i), a));
  await p1.close();
  await p2.close();
};

// S4-restore: TW.restore() called directly (Task 6 wires it into the page load). A saved session another
// tab holds is left there after the 2s wait; a detached one and one the server no longer has come back.
// popSpace + adopt hand a space between pages without ending its shells.
SCEN['S4-restore'] = async () => {
  const ctx = await launch();
  const p1 = await page('/', { context: ctx });
  await recordEvents(p1);
  const a = await dock(p1);
  const d = await openTerm(p1, { cwd: 'Code/DevOps/demo-repo' });
  await p1.evaluate((i) => TW.remove(i, { kill: false }), d);
  check('S4-restore the second terminal is detached on the server', !!(await listWait(d, (x) => !x.attached)));
  const gone = 'e2e-gone-' + Date.now();
  const p2 = await page('/terminal.html', { context: ctx });
  await recordEvents(p2);
  await waitFor(p2, () => typeof TW !== 'undefined' && TW.sessions().length === 1, 10000);
  const t0 = Date.now();
  const res = await ev(p2, (s) => TW.restore(s, []).then((m) => m.map((x) => x.id)), [{ id: a }, { id: d, cwd: 'Code/DevOps/demo-repo' }, { id: gone }]);
  const took = Date.now() - t0;
  const held2 = await ev(p2, () => TW.sessions().map((s) => s.id));
  check('S4-restore the detached and the gone sessions come back', Array.isArray(held2) && held2.includes(d) && held2.includes(gone), { res, held2 });
  check('S4-restore the one another tab holds is left there (after the wait)', Array.isArray(held2) && !held2.includes(a) && took >= 2000, { took, held2 });
  await sleep(1500);
  check('S4-restore that tab keeps it, no moved event', (await ev(p1, (i) => !!TW.session(i) && TW.session(i).state === 'open' && !window.__ev.some((e) => e.kind === 'moved'), a)) === true,
    await ev(p1, (i) => ({ state: TW.session(i) && TW.session(i).state, ev: window.__ev }), a));
  const leaves = await ev(p2, () => JSON.stringify(JSON.parse(sessionStorage.getItem('vaultboard.termwin.tree')).spaces));
  check('S4-restore no leaf is left for the one not restored', typeof leaves === 'string' && !leaves.includes(a), leaves);
  const key = await ev(p2, (i) => TW.session(i).key, d);
  const metas = await ev(p2, (k) => TW.popSpace(k), key);
  check('S4-restore popSpace returns its metas and drops the panes', Array.isArray(metas) && metas.length === 1 && metas[0].id === d
    && (await ev(p2, (i) => !TW.session(i), d)) === true, metas);
  check('S4-restore the popped shell keeps running (detached)', !!(await listWait(d, (x) => !x.attached)));
  await ev(p1, (m) => TW.adopt(m), metas);
  check('S4-restore adopt takes it in and focuses it', await waitFor(p1, (i) => TW.session(i) && TW.session(i).state === 'open' && TW.focused().id === i, 5000, d));
  await p2.close();
  await p1.close();
};

// S4-restore-focus: restore() ends on one rule, whatever the timing. Each run is a fresh page with the
// same saved dock state (A and F at the root, F focused, the root space active) and R handed back by the
// window (returning, demo-repo). The workspace under test is a second createTermWorkspace (persist: true)
// in a terminal.html page, so the page's own restore (workbench's, until Task 6) can't race it.
//   1. every saved session detached: no 2s wait → F, the saved focus, in the root space;
//   2. A held by another page: the 2s wait runs → the same F, the same space;
//   3. as 2, and the user opens a terminal during the wait → that terminal keeps the focus;
//   4. the saved focus is A, which another page holds (dropped) → R, the returning one, gets the focus.
SCEN['S4-restore-focus'] = async () => {
  const REPO = 'Code/DevOps/demo-repo';
  const ctx = await launch();
  const p1 = await page('/', { context: ctx });
  await bare(p1);
  const A = await openTerm(p1, {});
  const F = await openTerm(p1, {});
  const R = await openTerm(p1, { cwd: REPO });
  const [mA, mF, mR] = await p1.evaluate((ids) => ids.map((i) => { const s = TW.session(i); return { id: s.id, n: s.n, title: s.title, cwd: s.cwd, task: s.task }; }), [A, F, R]);
  for (const i of [A, F, R]) await p1.evaluate((x) => TW.remove(x, { kill: false }), i);
  const allDetached = async () => { for (const i of [A, F, R]) if (!(await listWait(i, (x) => !x.attached))) return false; return true; };
  check('S4-restore-focus A, F and R start detached on the server', await allDetached());
  const run = async ({ holdA = false, focus = F, createDuring = false } = {}) => {
    if (holdA) {
      await p1.evaluate((m) => { TW.add(m); }, mA);
      await listWait(A, (x) => x.attached);
    }
    const p2 = await page('/terminal.html', { context: ctx });
    await waitFor(p2, () => typeof TW !== 'undefined' && TW.sessions().length === 1, 10000);
    const out = await ev(p2, async (o) => {
      const S = 'e2e.restorefocus';
      sessionStorage.setItem(S + '.sessions', JSON.stringify([o.mA, o.mF]));
      sessionStorage.setItem(S + '.focused', JSON.stringify(o.focus));
      sessionStorage.setItem(S + '.tree', JSON.stringify({ v: 1, active: 'd:', spaces: { 'd:': {
        root: { dir: 'row', r: 0.5, a: { id: o.mA.id }, b: { id: o.mF.id } }, focus: o.focus, zoom: null } } }));
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px;z-index:50';
      document.body.appendChild(el);
      const W2 = window.TW2 = createTermWorkspace(el, { store: S, persist: true });
      const t0 = Date.now();
      const done = W2.restore(W2.savedSessions(), [o.mR]);
      let mine = null;
      if (o.createDuring) {
        await new Promise((r) => setTimeout(r, 700));   // inside the 2s wait for A
        const s = W2.create({});
        mine = s && s.id;
      }
      await done;
      return { focused: W2.focused() && W2.focused().id, active: W2.activeSpace(), held: W2.sessions().map((s) => s.id), mine, ms: Date.now() - t0 };
    }, { mA, mF, mR, focus, createDuring });
    // Hand A, F and R back (detached) for the next run; end the extra shells.
    await ev(p2, (keep) => {
      for (const s of [...TW2.sessions()]) TW2.remove(s.id, { kill: !keep.includes(s.id) });
      for (const s of [...TW.sessions()]) TW.remove(s.id);
    }, [A, F, R]);
    await p2.close();
    if (holdA) await p1.evaluate((i) => TW.remove(i, { kill: false }), A);
    await allDetached();
    return out;
  };
  const r1 = await run();
  check('S4-restore-focus (1) all detached: every saved session and R come back, no 2s wait',
    Array.isArray(r1.held) && [A, F, R].every((i) => r1.held.includes(i)) && r1.ms < 2000, { r1, A, F, R });
  check('S4-restore-focus (1) all detached: the saved focus F wins over returning R, root space active',
    r1.focused === F && r1.active === 'd:', { r1, F, R });
  const r2 = await run({ holdA: true });
  check('S4-restore-focus (2) A held elsewhere: the 2s wait ran, A stays there, F and R come back',
    Array.isArray(r2.held) && !r2.held.includes(A) && r2.held.includes(F) && r2.held.includes(R) && r2.ms >= 2000, { r2, A, F, R });
  check('S4-restore-focus (2) A held elsewhere: the saved focus F wins over returning R, root space active',
    r2.focused === F && r2.active === 'd:', { r2, F, R });
  check('S4-restore-focus (1) and (2) end on the same focus and space', r1.focused === r2.focused && r1.active === r2.active,
    { r1: [r1.focused, r1.active], r2: [r2.focused, r2.active] });
  const r3 = await run({ holdA: true, createDuring: true });
  check('S4-restore-focus (3) a terminal the user opens during the wait keeps the focus',
    !!r3.mine && r3.focused === r3.mine && r3.ms >= 2000, { r3, F, R });
  const r4 = await run({ holdA: true, focus: A });
  check('S4-restore-focus (4) the saved focus was dropped: returning R gets the focus and its space',
    Array.isArray(r4.held) && !r4.held.includes(A) && r4.focused === R && r4.active === 'd:' + REPO, { r4, A, F, R });
  await p1.close();
};

// S8: the old Tabs layout is migrated: its keys go, and each space comes back zoomed to its focused
// pane. The saved focus (and so the active space) survives the restore that re-adds the sessions.
SCEN.S8 = async () => {
  const p = await page('/');
  const r0 = await dock(p);
  const repo = await openTerm(p, { cwd: 'Code/DevOps/demo-repo' });
  const r1 = await openTerm(p, {});
  const r2 = await openTerm(p, {});
  const metas = await p.evaluate((order) => order.map((i) => { const s = TW.session(i); return { id: s.id, n: s.n, title: s.title, cwd: s.cwd, task: s.task }; }), [repo, r0, r1, r2]);
  // Seeded before the page's own scripts on the next load, as the old code left it: no tree, a Tabs layout.
  await p.evaluateOnNewDocument((m, f) => {
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    for (const st of [localStorage, sessionStorage]) {
      st.removeItem('vaultboard.term.tree');
      st.setItem('vaultboard.term.sessions', JSON.stringify(m));
      st.setItem('vaultboard.term.focused', JSON.stringify(f));
    }
    localStorage.setItem('vaultboard.term.layout', JSON.stringify('tabs'));
    localStorage.setItem('vaultboard.term.ratios', JSON.stringify([0.6]));
    localStorage.setItem('vaultboard.term.open', 'true');
  }, metas, r1);
  await p.reload({ waitUntil: 'networkidle2' });
  await waitFor(p, (n) => TW.sessions().length === n, 10000, 4);
  await sleep(1000);
  const got = await p.evaluate(() => ({
    layout: localStorage.getItem('vaultboard.term.layout'), ratios: localStorage.getItem('vaultboard.term.ratios'),
  }));
  check('S8 the old layout and ratios keys are gone', got.layout === null && got.ratios === null, got);
  const z = await p.evaluate(() => {
    const t = JSON.parse(sessionStorage.getItem('vaultboard.term.tree'));
    return { active: TW.activeSpace(), focused: TW.focused() && TW.focused().id, zoom: t.spaces['d:'] && t.spaces['d:'].zoom };
  });
  check('S8 the saved focus survives the restore (root space active)', z.focused === r1 && z.active === 'd:', { z, r1 });
  check('S8 the root space is zoomed to its focused pane', z.zoom === z.focused && z.zoom === r1, z);
  const v = await visiblePanes(p);
  check('S8 one pane visible', v.length === 1 && v[0] === r1, v);
  await shot(p, 's8-migrated');
  await p.close();
};

// S11: the server restarts under open pages. The panes reconnect to fresh shells under the same ids;
// the two spaces survive and no row is duplicated.
SCEN.S11 = async () => {
  const p = await page('/');
  await bare(p);
  const a = await openTerm(p, { cwd: JOB + '/data' });
  const b = await openTerm(p, {});
  await waitFor(p, (i, k) => TW.session(i).key === k, 8000, a, JOB_KEY);
  await sleep(1000);
  for (const i of [a, b]) await typeIn(p, i, 'echo pre-restart-mark\r');
  await sleep(800);
  execFileSync('docker', ['restart', 'herdr-term-preview'], { stdio: 'ignore' });
  const back = await waitFor(p, (ids) => ids.every((i) => TW.session(i) && TW.session(i).state === 'open'), 45000, [a, b]);
  check('S11 both panes reconnect', back, await ev(p, () => TW.sessions().map((s) => [s.id, s.state])));
  await sleep(2500);
  for (const i of [a, b]) {
    const txt = await screen(p, i);
    check(`S11 ${i === a ? 'job' : 'root'} pane shows a fresh prompt`, !txt.includes('pre-restart-mark') && /[$#]\s*$/m.test(txt), txt.trim().slice(-200));
  }
  await sleep(3500);   // a poll after the shells are back
  const m = await ev(p, () => ({ spaces: TW.spaces().map((s) => s.key), rows: TW.rows().map((r) => r.id) }));
  check('S11 TW.spaces().length === 2', m.spaces && m.spaces.length === 2, m);
  check('S11 no row ids are duplicated', m.rows && new Set(m.rows).size === m.rows.length && m.rows.length === 2, m);
  await shot(p, 's11-restarted');
  await p.close();
};

// The pty's own size, from `stty size` typed into the pane (works while the pane is hidden): [cols, rows] or null.
async function sttySize(p, id) {
  const mark = 'SZ' + Math.random().toString(36).slice(2, 7);
  await typeIn(p, id, `echo ${mark}-$(stty size)\r`);
  const re = new RegExp(`${mark}-(\\d+) (\\d+)`);
  for (let k = 0; k < 40; k++) {
    await sleep(100);
    const m = re.exec(await screen(p, id));
    if (m) return [Number(m[2]), Number(m[1])];
  }
  return null;
}
const xtermSize = (p, id) => ev(p, (i) => [TW.session(i).handle.term.cols, TW.session(i).handle.term.rows], id);

// S11-hidden: the server restarts while the dock is minimised. The pane reconnects (hidden) to a fresh pty, which
// must still end up at the pane's real size once the dock is shown, not the server's 100x30 default.
SCEN['S11-hidden'] = async () => {
  const p = await page('/');
  await bare(p);
  const a = await openTerm(p, {});
  await sleep(1200);
  const before = await xtermSize(p, a);
  const pty0 = await sttySize(p, a);
  check('S11-hidden to start with, stty size matches the xterm', Array.isArray(before) && JSON.stringify(pty0) === JSON.stringify(before) && before[0] !== 100, { before, pty0 });
  await p.click('#term-min');
  await sleep(500);
  check('S11-hidden the dock is minimised', (await ev(p, () => document.getElementById('term-dock').classList.contains('hidden'))) === true);
  execFileSync('docker', ['restart', 'herdr-term-preview'], { stdio: 'ignore' });
  const back = await waitFor(p, (i) => TW.session(i) && TW.session(i).state === 'open', 60000, a);
  check('S11-hidden the hidden pane reconnects', back, await ev(p, () => TW.sessions().map((s) => [s.id, s.state])));
  await sleep(2000);   // the fresh shell's prompt
  await ev(p, () => showTerminals());
  await sleep(1500);
  const after = await xtermSize(p, a);
  const pty = await sttySize(p, a);
  check('S11-hidden after showing the dock, stty size equals the xterm cols and rows', Array.isArray(after) && JSON.stringify(pty) === JSON.stringify(after), { after, pty });
  await shot(p, 's11-hidden-shown');
  await p.close();
};

// S12-cap: with 12 busy terminals (the server's cap) a 13th create() adds no pane.
SCEN['S12-cap'] = async () => {
  const p = await page('/');
  await recordEvents(p);
  await bare(p);
  for (let i = 0; i < 12; i++) await openTerm(p, { run: 'sleep 600' });
  const end = Date.now() + 20000;
  let l = [];
  while (Date.now() < end) { l = await list(); if (l.length === 12 && l.every((x) => x.cmd)) break; await sleep(300); }
  check('S12-cap 12 busy terminals on the server', l.length === 12 && l.every((x) => x.cmd), l.map((x) => [x.attached, x.cmd]));
  await waitFor(p, () => typeof TW.list === 'function' && TW.list() && TW.list().length === 12, 5000);
  const n = await p.evaluate(() => ({ s: TW.sessions().length, panes: document.querySelectorAll('#term-area .tw-pane').length }));
  const r = await ev(p, () => { const s = TW.create(); return s ? s.id : null; });
  await sleep(1000);
  const n2 = await p.evaluate(() => ({ s: TW.sessions().length, panes: document.querySelectorAll('#term-area .tw-pane').length }));
  check('S12-cap create() returns null and adds no pane', r === null && n2.s === n.s && n2.panes === n.panes && n.s === 12, { r, n, n2 });
  const e = await ev(p, () => window.__ev);
  check('S12-cap a cap event is emitted', Array.isArray(e) && e.some((x) => x.kind === 'cap'), e);
  await shot(p, 's12-cap');
  await p.close();
};

// Waits for the popup a click or call opens in the page's context.
const nextPopup = (p) => new Promise((res) => p.once('popup', res));
const setWhere = (p, v) => p.evaluate((x) => localStorage.setItem('vaultboard.term.where', JSON.stringify(x)), v);

// S3: the dock and the Terminals window hand things over. A card's agent pill opens the window on that
// terminal; Pop out moves the whole active space; closing the window brings everything back; goTo of a
// terminal the window holds is shown there (twAdopt), not taken.
SCEN.S3 = async () => {
  const JOB = 'Personal/1. apps/01-api-refactor';
  const p = await page('/');
  await bare(p);
  const T = await openTerm(p, { cwd: JOB, task: JOB + '/task.md' });
  await sleep(1500);
  await fake(p, T, 'blocked');
  await listWait(T, (x) => x.agent && x.agent.state === 'blocked');
  await ev(p, (i) => TW.remove(i, { kill: false }), T);   // detached: the pill has to find it
  await setWhere(p, 'window');
  check('S3 the card shows the agent pill', await waitFor(p, (i) => !!document.querySelector(`.card-agent[data-term="${i}"]`), 8000, T));
  const popP = nextPopup(p);
  await p.click(`.card-agent[data-term="${T}"]`);
  const w = await Promise.race([popP, sleep(8000).then(() => null)]);
  check('S3 clicking the pill opens the window', !!w);
  if (!w) { await p.close(); return; }
  check('S3 the window holds that terminal', await waitFor(w, (i) => typeof TW !== 'undefined' && !!TW.session(i), 10000, T), await ev(w, () => TW.sessions().map((s) => s.id)));
  check('S3 the window has no old header', (await ev(w, () => !document.querySelector('.term-pop-head'))) === true);
  await shot(w, 's3-window');
  check('S3 the main page does not hold it', (await ev(p, (i) => !TW.session(i), T)) === true);
  await w.close();
  check('S3 closing the window returns it to the dock', await waitFor(p, (i) => !!TW.session(i), 4000, T), await ev(p, () => TW.sessions().map((s) => s.id)));

  // Two terminals in one space, split, then Pop out.
  const A = await openTerm(p, { cwd: 'Code/DevOps/demo-repo' });
  const B = await openTerm(p, { split: 'right' });
  const keyA = await ev(p, (i) => TW.session(i).key, A);
  const keyB = await ev(p, (i) => TW.session(i).key, B);
  check('S3 A and B share a space', typeof keyA === 'string' && keyA === keyB, { keyA, keyB });
  const pop2 = nextPopup(p);
  await p.evaluate(() => document.getElementById('term-pop').click());
  const w2 = await Promise.race([pop2, sleep(8000).then(() => null)]);
  check('S3 Pop out opens the window', !!w2);
  if (!w2) { await p.close(); return; }
  check('S3 the window holds both ids', await waitFor(w2, (a, b) => typeof TW !== 'undefined' && !!TW.session(a) && !!TW.session(b), 10000, A, B), await ev(w2, () => TW.sessions().map((s) => s.id)));
  const wk = await ev(w2, (a, b) => [TW.session(a).key, TW.session(b).key], A, B);
  const shown = await ev(w2, () => document.querySelectorAll('#term-area .tw-pane:not(.tw-off)').length);
  check('S3 the window shows them in one space, 2 panes', Array.isArray(wk) && wk[0] === wk[1] && shown === 2, { wk, shown });
  await sleep(500);
  await shot(w2, 's3-window-space');
  check('S3 the dock gave up both', (await ev(p, (a, b) => !TW.session(a) && !TW.session(b), A, B)) === true);
  await w2.close();
  check('S3 closing the window: the dock holds both again within 3s', await waitFor(p, (a, b) => !!TW.session(a) && !!TW.session(b), 3000, A, B),
    await ev(p, () => TW.sessions().map((s) => s.id)));

  // goTo of a terminal the window holds: the window takes the call.
  const pop3 = nextPopup(p);
  await p.evaluate(() => document.getElementById('term-pop').click());
  const w3 = await Promise.race([pop3, sleep(8000).then(() => null)]);
  if (!w3) { check('S3 reopened the window', false); await p.close(); return; }
  await waitFor(w3, (a) => typeof TW !== 'undefined' && !!TW.session(a), 10000, A);
  await ev(w3, () => { const o = window.twAdopt; window.__adopted = []; window.twAdopt = (m) => { window.__adopted.push(m); return o(m); }; });
  check("S3 the dock sees A as in the 'window'", await waitFor(p, (a) => TW.where(a) === 'window', 6000, A), await ev(p, (a) => TW.where(a), A));
  await ev(p, (a) => TW.goTo(a), A);
  await sleep(1000);
  const ad = await ev(w3, () => window.__adopted);
  check('S3 goTo(X) called twAdopt in the window', Array.isArray(ad) && ad.some((m) => m.some((x) => x.id === A)), ad);
  check("S3 the main page doesn't take X", (await ev(p, (a) => !TW.session(a), A)) === true);
  await w3.close();
  await p.close();
};

// S3-theme: a theme change in the main page reaches an open Terminals window within 1s (storage event).
SCEN['S3-theme'] = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx, theme: 'dark' });
  const w = await page('/terminal.html', { context: ctx, theme: 'dark' });
  await sleep(500);
  await p.evaluate(() => localStorage.setItem('vaultboard.theme', 'light'));
  check('S3-theme the window follows within 1s', await waitFor(w, () => document.documentElement.dataset.theme === 'light', 1000), await ev(w, () => document.documentElement.dataset.theme));
  await shot(w, 's3-theme');
  await w.close();
  await p.close();
};

// S12-cap-window: at the cap, window mode opens no popup and adds no pane anywhere.
SCEN['S12-cap-window'] = async () => {
  const p = await page('/');
  await recordEvents(p);
  await bare(p);
  for (let i = 0; i < 12; i++) await openTerm(p, { run: 'sleep 600' });
  const end = Date.now() + 20000;
  let l = [];
  while (Date.now() < end) { l = await list(); if (l.length === 12 && l.every((x) => x.cmd)) break; await sleep(300); }
  check('S12-cap-window 12 busy terminals', l.length === 12 && l.every((x) => x.cmd), l.length);
  await waitFor(p, () => TW.list() && TW.list().length === 12, 5000);
  await setWhere(p, 'window');
  let popped = 0;
  p.on('popup', () => { popped++; });
  const pagesBefore = (await p.browserContext().pages()).length;
  await ev(p, () => termOpen());
  await ev(p, () => termOpen({ cwd: 'Code' }));
  await sleep(2000);
  const pagesAfter = (await p.browserContext().pages()).length;
  const panes = await ev(p, () => document.querySelectorAll('#term-area .tw-pane').length);
  const e = await ev(p, () => window.__ev);
  check('S12-cap-window no popup opened', popped === 0 && pagesAfter === pagesBefore, { popped, pagesBefore, pagesAfter });
  check('S12-cap-window no pane added', panes === 12 && (await list()).length === 12, { panes });
  check('S12-cap-window a cap event is emitted', Array.isArray(e) && e.some((x) => x.kind === 'cap'), e);
  check('S12-cap-window the dock shows the cap toast', await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => /12 terminals open/.test(t.textContent)), 3000), await toastTexts(p));
  // At the cap with the Terminals window already open, termOpen() with no args mints nothing: it just raises
  // the window. No cap event, no new terminal, no popup. (Pop out moves a space there; the count stays 12.)
  const popP = nextPopup(p);
  await p.evaluate(() => document.getElementById('term-pop').click());
  const w = await Promise.race([popP, sleep(8000).then(() => null)]);
  check('S12-cap-window Pop out opens the window at the cap', !!w && await waitFor(w, () => typeof TW !== 'undefined' && TW.sessions().length > 0, 10000));
  if (!w) { await p.close(); return; }
  await waitFor(p, () => TW.rows().some((r) => r.where === 'window'), 6000);
  await ev(w, () => {
    window.__focus = 0; const f = window.focus.bind(window); window.focus = () => { window.__focus++; f(); };
    window.__adopted = []; const o = window.twAdopt; window.twAdopt = (m) => { window.__adopted.push(m); return o(m); };
  });
  const caps = async () => { const x = await ev(p, () => window.__ev.filter((y) => y.kind === 'cap').length); return typeof x === 'number' ? x : -1; };
  const capsBefore = await caps();
  const winBefore = await ev(w, () => TW.sessions().length);
  const pages2 = (await p.browserContext().pages()).length;
  await ev(p, () => termOpen());
  await sleep(1500);
  check('S12-cap-window with the window open, termOpen() raises it', (await ev(w, () => window.__focus)) >= 1, await ev(w, () => window.__focus));
  check('S12-cap-window and emits no cap event', capsBefore >= 0 && (await caps()) === capsBefore, { capsBefore, after: await caps() });
  const l2 = await list();
  check('S12-cap-window and opens no terminal or popup', l2.length === 12 && (await ev(w, () => TW.sessions().length)) === winBefore
    && (await ev(w, () => window.__adopted.length)) === 0 && (await p.browserContext().pages()).length === pages2, { list: l2.length, pages2 });
  await w.close();
  await p.close();
};

// ---- Task 7: the sidebar (window) and the numbered rail (dock) ----
const WEB = 'Personal/1. apps/02-web-login';
const OPS = 'Personal/2. platform/03-ops-dns';
const MARKS = ['×', '◐', '✓', '○', '·'];
// A window page with three spaces (vault root, web-login, ops-dns), settled with their task names.
async function sideWin(theme) {
  const p = await page('/terminal.html', theme ? { theme } : {});
  await waitFor(p, () => typeof TW !== 'undefined' && TW.sessions().length === 1, 10000);
  await ev(p, (c) => TW.create({ cwd: c }), WEB);
  await waitFor(p, () => TW.sessions().length === 2, 10000);
  await ev(p, (c) => TW.create({ cwd: c }), OPS);
  await waitFor(p, () => TW.sessions().length === 3, 10000);
  await waitFor(p, () => { const n = TW.spaces().map((x) => x.name); return n.length === 3 && n.some((x) => x.startsWith('<b>Ops')) && n.includes('Web login flow'); }, 10000);
  await sleep(500);
  return p;
}
const sideRows = (p) => ev(p, () => [...document.querySelectorAll('.tw-side .tw-sp-row')].map((r) => ({
  key: r.dataset.key, text: r.textContent, mark: r.querySelector('.tw-sp-mark').textContent,
  color: getComputedStyle(r.querySelector('.tw-sp-mark')).color, active: r.classList.contains('active'),
  weight: getComputedStyle(r).fontWeight, bg: getComputedStyle(r).backgroundColor, dim: r.classList.contains('dim'), title: r.title,
})));
// The computed colour of a CSS token.
const token = (p, t, prop = 'color') => ev(p, (tk, pr) => { const d = document.createElement('div'); d.style[pr] = `var(${tk})`; document.body.appendChild(d); const c = getComputedStyle(d)[pr]; d.remove(); return c; }, t, prop);

SCEN['S2-side'] = async () => {
  const p = await sideWin();
  p.on('dialog', (d) => d.accept());
  const spaces = await ev(p, () => TW.spaces());
  let rows = await sideRows(p);
  check('S2-side a row per space', Array.isArray(rows) && Array.isArray(spaces) && rows.length === spaces.length && rows.length === 3, { rows: rows.length, spaces: spaces.length });
  check('S2-side the window shows the brand', await ev(p, () => !!document.querySelector('.tw-side .brand .brand-os')) === true);
  const active = Array.isArray(rows) ? rows.filter((r) => r.active) : [];
  check('S2-side one active row', active.length === 1, active);
  check('S2-side the active row is bold on --panel-2', active.length === 1 && Number(active[0].weight) >= 600 && active[0].bg === await token(p, '--panel-2', 'backgroundColor'), { active, panel2: await token(p, '--panel-2', 'backgroundColor') });
  check('S2-side every mark is one of × ◐ ✓ ○ ·', Array.isArray(rows) && rows.every((r) => MARKS.includes(r.mark)), rows);
  const headers = await ev(p, () => [...document.querySelectorAll('.tw-side .tw-side-h')].map((h) => h.textContent.replace('+', '').trim()));
  check('S2-side section headers are lowercase spaces / agents', Array.isArray(headers) && headers.join() === 'spaces,agents', headers);
  const web = await ev(p, () => TW.sessions().find((s) => s.key.includes('02-web-login')).id);
  await fake(p, web, 'blocked');
  const marked = await waitFor(p, (k) => { const r = [...document.querySelectorAll('.tw-side .tw-sp-row')].find((x) => x.dataset.key === k); return r && r.querySelector('.tw-sp-mark').textContent === '×'; }, 8000, `t:${WEB}/task.md`);
  rows = await sideRows(p);
  const webRow = Array.isArray(rows) ? rows.find((r) => r.key === `t:${WEB}/task.md`) : null;
  check('S2-side the blocked agent makes its space mark ×', marked && !!webRow && webRow.mark === '×', webRow);
  check('S2-side the × is --review', !!webRow && webRow.color === await token(p, '--review'), { webRow, review: await token(p, '--review') });
  // The command comes with the next list poll (3s), not with the agent event.
  await waitFor(p, () => { const r = document.querySelector('.tw-side .tw-ag-row .tw-ag-line'); return r && /^(claude|node) /.test(r.textContent); }, 8000);
  const ag = await ev(p, () => [...document.querySelectorAll('.tw-side .tw-ag-row')].map((r) => ({
    line: r.querySelector('.tw-ag-line').textContent, space: r.querySelector('.tw-ag-space').textContent, id: r.dataset.id,
    stateColor: getComputedStyle(r.querySelector('.tw-ag-state')).color,
  })));
  check('S2-side the first agent row reads "<cmd> · blocked" with its space under it', Array.isArray(ag) && ag.length > 0 && /^(claude|node) · blocked$/.test(ag[0].line) && ag[0].space === 'Web login flow', ag);
  check('S2-side the state word is --review', Array.isArray(ag) && ag.length > 0 && ag[0].stateColor === await token(p, '--review'), ag);
  // Another space is active (the last created); an agent row in web-login switches to it.
  const before = await ev(p, () => TW.activeSpace());
  await ev(p, () => document.querySelector('.tw-side .tw-ag-row').click());
  const went = await waitFor(p, (k) => TW.activeSpace() === k, 3000, `t:${WEB}/task.md`);
  check('S2-side clicking an agent row in another space activates it', before !== `t:${WEB}/task.md` && went, { before, now: await ev(p, () => TW.activeSpace()) });
  // A fully detached space and its agent dim, with a tooltip.
  await ev(p, (c) => TW.create({ cwd: c }), 'Code');
  await waitFor(p, () => TW.sessions().length === 4, 10000);
  const code = await ev(p, () => TW.sessions()[3].id);
  await fake(p, code, 'working');
  await listWait(code, (x) => x.agent && x.agent.state === 'working');
  await ev(p, (i) => TW.remove(i, { kill: false }), code);
  await ev(p, () => TW.refreshList());
  await waitFor(p, () => !!document.querySelector('.tw-side .tw-ag-row.dim'), 6000);
  const dim = await ev(p, () => ({ ag: [...document.querySelectorAll('.tw-side .tw-ag-row.dim')].map((r) => r.title), sp: [...document.querySelectorAll('.tw-side .tw-sp-row.dim')].map((r) => r.title) }));
  check('S2-side a detached agent row is dim with a "detached" tooltip', !dim.error && dim.ag.length === 1 && /detached|elsewhere/.test(dim.ag[0]), dim);
  check('S2-side a detached space row is dim with a tooltip', !dim.error && dim.sp.length === 1 && /detached|elsewhere/.test(dim.sp[0]), dim);
  // Right-click renames (prompt answered).
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => d.accept('Login work'));
  await ev(p, (k) => document.querySelector(`.tw-side .tw-sp-row[data-key="${k}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), `t:${WEB}/task.md`);
  check('S2-side right-click renames the space', await waitFor(p, (k) => document.querySelector(`.tw-side .tw-sp-row[data-key="${k}"] .tw-sp-name`).textContent === 'Login work', 3000, `t:${WEB}/task.md`));
  // The footer menu.
  await ev(p, () => localStorage.setItem('vaultboard.term.sound', 'true'));
  await ev(p, () => document.querySelector('.tw-side .tw-side-menu').click());
  const menu = await ev(p, () => { const m = document.querySelector('.tw-menu'); return { open: !m.hidden, items: [...m.querySelectorAll('button')].map((b) => ({ t: b.textContent, d: b.disabled })) }; });
  check('S2-side the footer menu lists Go to…, Shortcuts, Sound: On', !menu.error && menu.open && menu.items.length === 3 && menu.items[0].t.startsWith('Go to…') && !menu.items[0].d && menu.items[1].t.startsWith('Shortcuts') && !menu.items[1].d && menu.items[2].t === 'Sound: On' && !menu.items[2].d, menu);
  await p.keyboard.press('Escape');
  check('S2-side Escape closes the menu', await waitFor(p, () => document.querySelector('.tw-menu').hidden, 2000));
  await ev(p, () => document.querySelector('.tw-side .tw-side-menu').click());
  await ev(p, () => [...document.querySelectorAll('.tw-menu button')].find((b) => b.textContent.startsWith('Sound')).click());
  check('S2-side Sound toggles vaultboard.term.sound off (JSON false)', await ev(p, () => localStorage.getItem('vaultboard.term.sound')) === 'false');
  await sleep(300);
  await shot(p, 's2-side-dark');
  await ev(p, () => { document.documentElement.dataset.theme = 'light'; });
  await sleep(600);
  await shot(p, 's2-side-sepia');
  await p.close();
};

SCEN['S2-rail'] = async () => {
  const p = await page('/');
  await dock(p);
  await ev(p, (c) => TW.create({ cwd: c }), WEB);
  await waitFor(p, () => TW.sessions().length === 2, 10000);
  await waitFor(p, () => TW.spaces().length === 2 && TW.spaces().some((x) => x.name === 'Web login flow'), 10000);
  const web = await ev(p, () => TW.sessions().find((s) => s.key.includes('02-web-login')).id);
  await fake(p, web, 'working');
  await waitFor(p, () => [...document.querySelectorAll('.tw-side .tw-sp-mark')].some((m) => m.textContent === '◐'), 8000);
  const geo = await ev(p, () => { const s = document.querySelector('.tw-side'); return { mode: s.dataset.mode, w: s.getBoundingClientRect().width }; });
  check('S2-rail the dock starts as a rail ≤ 48px', !geo.error && geo.mode === 'rail' && geo.w <= 48, geo);
  const rows = await ev(p, () => ({ t: [...document.querySelectorAll('.tw-side .tw-sp-row')].map((r) => r.textContent.trim()), nums: TW.spaces().map((x) => x.num) }));
  check('S2-rail rows read "<n> <mark>" in Alt+N order', !rows.error && rows.t.length === 2 && rows.t.every((t, i) => new RegExp(`^${rows.nums[i]} [×◐✓○·]$`).test(t)) && rows.nums.join() === '1,2' && rows.t.some((t) => t.endsWith('◐')), rows);
  check('S2-rail names are in the title', await ev(p, () => [...document.querySelectorAll('.tw-side .tw-sp-row')].some((r) => r.title.includes('Web login flow'))) === true);
  // Regression: the sidebar's agent colours must not leak onto Board cards' "Claude working" chips.
  const chip = await waitFor(p, () => !!document.querySelector('.card-agent[data-agent="working"]'), 8000);
  const chipColor = await ev(p, () => getComputedStyle(document.querySelector('.card-agent[data-agent="working"]')).color);
  check('S2-rail a Board .card-agent chip keeps its --muted colour', chip && chipColor === await token(p, '--muted'), { chip, chipColor, muted: await token(p, '--muted') });
  await shot(p, 's2-rail-dark');
  await ev(p, () => document.querySelector('.tw-side .tw-side-toggle').click());
  const open = await ev(p, () => { const s = document.querySelector('.tw-side'); return { mode: s.dataset.mode, w: s.getBoundingClientRect().width, ls: localStorage.getItem('vaultboard.term.side') }; });
  check('S2-rail » expands to the sidebar and stores it', !open.error && open.mode === 'side' && open.w > 150 && open.ls === '"side"', open);
  await p.reload({ waitUntil: 'networkidle2' });
  await waitFor(p, () => typeof TW !== 'undefined' && !!document.querySelector('.tw-side'), 5000);
  check('S2-rail the sidebar stays expanded after a reload', await ev(p, () => document.querySelector('.tw-side').dataset.mode) === 'side');

  // ---- A space with no pane here: dimmed, unnumbered, and a click brings it or shows it where it is. Alt+N
  // follows the numbers on screen. The vault-root space comes first in the server's order; detach it and open
  // OPS after WEB, so the held spaces are the 2nd and 3rd rows.
  await waitFor(p, () => TW.sessions().length === 2, 10000);
  const R = await ev(p, () => (TW.sessions().find((s) => s.key === 'd:') || {}).id);
  await ev(p, () => document.querySelector('.tw-side .tw-side-toggle').click());   // back to the rail
  await ev(p, (i) => TW.remove(i, { kill: false }), R);
  const O = await openTerm(p, { cwd: OPS });
  const OPS_KEY = `t:${OPS}/task.md`;
  const WEB_KEY = `t:${WEB}/task.md`;
  await waitFor(p, (k) => TW.spaces().length === 3 && TW.spaces().some((x) => x.key === k && x.name.startsWith('<b>Ops')), 10000, OPS_KEY);
  await ev(p, () => TW.refreshList());
  await waitFor(p, (r) => TW.where(r) === 'detached', 6000, R);
  await sleep(300);
  const railRows = () => ev(p, () => [...document.querySelectorAll('.tw-side .tw-sp-row')].map((r) => ({
    key: r.dataset.key, num: (r.querySelector('.tw-sp-num') || {}).textContent || '', text: r.textContent.trim(), dim: r.classList.contains('dim'), title: r.title,
  })));
  let rr = await railRows();
  const rootRow = Array.isArray(rr) ? rr.find((r) => r.key === 'd:') : null;
  check('S2-rail rows follow the server order: root, web, ops', Array.isArray(rr) && rr.map((r) => r.key).join() === ['d:', WEB_KEY, OPS_KEY].join(), rr);
  check('S2-rail the detached space is dimmed and shows only its mark', !!rootRow && rootRow.dim && rootRow.num === '' && /^[×◐✓○·]$/.test(rootRow.text), rr);
  check('S2-rail its tooltip says detached', !!rootRow && /detached: running in the background/.test(rootRow.title), rootRow);
  const heldRows = Array.isArray(rr) ? rr.filter((r) => r.key !== 'd:') : [];
  check('S2-rail the held spaces are numbered 1, 2 and not dimmed', heldRows.map((r) => r.num).join() === '1,2' && heldRows.every((r) => !r.dim), rr);
  await shot(p, 's2-rail-dim-dark');
  await ev(p, () => { document.documentElement.dataset.theme = 'light'; });
  await sleep(600);
  await shot(p, 's2-rail-dim-sepia');
  await ev(p, () => document.querySelector('.tw-side .tw-side-toggle').click());   // the expanded sidebar, same model
  await sleep(300);
  await shot(p, 's2-sidebar-dim-sepia');
  await ev(p, () => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(600);
  await shot(p, 's2-sidebar-dim-dark');
  const sideRoot = await ev(p, () => { const r = document.querySelector('.tw-side .tw-sp-row[data-key="d:"]'); return r ? { num: r.querySelector('.tw-sp-num') ? r.querySelector('.tw-sp-num').textContent : '', name: (r.querySelector('.tw-sp-name') || {}).textContent } : null; });
  check('S2-rail in the expanded sidebar the detached space has its name and no number', !!sideRoot && !sideRoot.error && sideRoot.num === '' && sideRoot.name === 'vault', sideRoot);
  await ev(p, () => document.querySelector('.tw-side .tw-side-toggle').click());   // the rail again
  // Alt+N activates the row labelled N (each from another space, so a no-op can't pass).
  for (const r of heldRows) {
    const other = r.key === WEB_KEY ? OPS_KEY : WEB_KEY;
    await ev(p, (k) => TW.showSpace(k), other);
    await sleep(300);
    await ev(p, () => TW.focused().handle.focus());
    await p.keyboard.down('Alt'); await p.keyboard.press(`Digit${r.num || 9}`); await p.keyboard.up('Alt');
    check(`S2-rail Alt+${r.num} activates the row labelled ${r.num}`, /^[1-9]$/.test(r.num) && await waitFor(p, (k) => TW.activeSpace() === k, 2000, r.key), { label: r.num, want: r.key, now: await ev(p, () => TW.activeSpace()) });
  }
  // A click on the detached space reattaches it here.
  await ev(p, () => document.querySelector('.tw-side .tw-sp-row[data-key="d:"]').click());
  check('S2-rail clicking the detached space reattaches it here', await waitFor(p, (r) => !!TW.session(r) && TW.activeSpace() === 'd:', 5000, R), await ev(p, (r) => ({ held: !!TW.session(r), active: TW.activeSpace() }), R));

  // A space held by the Terminals window, seen from the dock: dimmed, unnumbered, and a click shows it there
  // (goElsewhere: twAdopt in the window), never taking it.
  await ev(p, (k) => TW.showSpace(k), OPS_KEY);
  await sleep(300);
  const popP = nextPopup(p);
  await p.evaluate(() => document.getElementById('term-pop').click());
  const w = await Promise.race([popP, sleep(8000).then(() => null)]);
  check('S2-rail Pop out opens the window with OPS', !!w && await waitFor(w, (o) => typeof TW !== 'undefined' && !!TW.session(o), 10000, O));
  if (!w) { await p.close(); return; }
  await ev(w, () => { const o = window.twAdopt; window.__adopted = []; window.twAdopt = (m) => { window.__adopted.push(m); return o(m); }; });
  await waitFor(p, (o) => TW.where(o) === 'window', 6000, O);
  await sleep(300);
  rr = await railRows();
  const opsRow = Array.isArray(rr) ? rr.find((r) => r.key === OPS_KEY) : null;
  check('S2-rail a space held by the window is dimmed with no number', !!opsRow && opsRow.dim && opsRow.num === '', rr);
  check('S2-rail its tooltip says it is in the Terminals window', !!opsRow && /elsewhere: open in the Terminals window/.test(opsRow.title), opsRow);
  check('S2-rail the dock numbers its own two spaces 1, 2', Array.isArray(rr) && rr.filter((r) => r.key !== OPS_KEY).map((r) => r.num).join() === '1,2', rr);
  await ev(p, (k) => document.querySelector(`.tw-side .tw-sp-row[data-key="${k}"]`).click(), OPS_KEY);
  await sleep(1200);
  const ad = await ev(w, () => window.__adopted);
  check('S2-rail clicking it hands it to the window (twAdopt)', Array.isArray(ad) && ad.some((m) => m.some((x) => x.id === O)), ad);
  check("S2-rail and the dock doesn't take it", (await ev(p, (o) => !TW.session(o), O)) === true);
  // From the window: the dock's spaces are dimmed and unnumbered, OPS is 1, and a click on one brings it here.
  await waitFor(w, (k) => [...document.querySelectorAll('.tw-side .tw-sp-row')].length === 3, 6000);
  await sleep(500);
  const wr = await ev(w, () => [...document.querySelectorAll('.tw-side .tw-sp-row')].map((r) => ({ key: r.dataset.key, num: r.querySelector('.tw-sp-num') ? r.querySelector('.tw-sp-num').textContent : '', dim: r.classList.contains('dim') })));
  check('S2-rail the window numbers only OPS (1) and dims the dock\'s two', Array.isArray(wr) && wr.length === 3 && wr.every((r) => (r.key === OPS_KEY ? r.num === '1' && !r.dim : r.num === '' && r.dim)), wr);
  await ev(w, (k) => document.querySelector(`.tw-side .tw-sp-row[data-key="${k}"]`).click(), WEB_KEY);
  check('S2-rail clicking a dock-held space in the window brings it there', await waitFor(w, (i) => !!TW.session(i), 6000, web), await ev(w, () => TW.sessions().map((s) => s.id)));
  check('S2-rail and the dock lets it go', await waitFor(p, (i) => !TW.session(i), 6000, web));
  await w.close();
  await p.close();
};

// Review Focus 1: a long, HTML-looking task title is literal text and ends in an ellipsis.
SCEN['S2-escape'] = async () => {
  const p = await sideWin();
  const r = await ev(p, () => {
    const row = [...document.querySelectorAll('.tw-side .tw-sp-row')].find((x) => x.textContent.includes('<b>Ops'));
    if (!row) return null;
    return {
      text: row.textContent, bold: document.querySelectorAll('.tw-side b').length, title: row.title,
      sw: row.scrollWidth, cw: row.clientWidth, to: getComputedStyle(row).textOverflow,
    };
  });
  check('S2-escape the row exists', !!r && !r.error, r);
  check('S2-escape the title renders literally', !!r && r.text.includes('<b>Ops & "DNS"'), r);
  check('S2-escape no <b> element inside the sidebar', !!r && r.bold === 0, r);
  check('S2-escape the row is truncated with an ellipsis', !!r && r.sw > r.cw && r.to === 'ellipsis', r);
  check('S2-escape the tooltip is literal too', !!r && r.title.includes('<b>Ops & "DNS"'), r);
  await p.close();
};

// ---- Task 8: the Go-to picker (desktop modal) and the phone summary + switch sheet ----
const vis = (p, sel) => ev(p, (q) => [...document.querySelectorAll(q)].some((e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; }), sel);

// The focused pane on the phone: its box, its xterm size, what's on its screen, and the key row's top.
const phoneInfo = (p) => ev(p, () => {
  const f = TW.focused();
  const pane = f.pane.getBoundingClientRect();
  const host = f.pane.querySelector('.term-host');
  const hr = host.getBoundingClientRect();
  const scr = f.pane.querySelector('.xterm-screen').getBoundingClientRect();
  const keys = document.querySelector('.tw-keys').getBoundingClientRect();
  const b = f.handle.term.buffer.active;
  let text = '';
  for (let y = 0; y < b.length; y++) text += b.getLine(y).translateToString(true) + '\n';
  return {
    id: f.id, cols: f.handle.term.cols, rows: f.handle.term.rows, text: text.trim(),
    pane: { l: pane.left, t: pane.top, r: pane.right, b: pane.bottom }, host: { w: hr.width, h: hr.height },
    scr: { w: scr.width, h: scr.height }, scrB: scr.bottom, scrR: scr.right, keysTop: keys.top, vw: innerWidth, vh: innerHeight,
    cell: scr.width / f.handle.term.cols,
  };
});
// True when the xterm fills its host (within a cell) and the pty was told that size (stty size in the pane).
async function phoneSized(p, name) {
  const i = await phoneInfo(p);
  check(`S7 ${name}: the pane shows a prompt`, !i.error && /\$/.test(i.text), i);
  check(`S7 ${name}: the xterm fills its box`, !i.error && Math.abs(i.scr.w - i.host.w) < i.cell * 2 + 12 && i.scr.h <= i.host.h + 1 && i.host.h - i.scr.h < 40, i);
  check(`S7 ${name}: the xterm stays inside the pane's border (bottom ${i.scr && i.pane && i.pane.b - 1})`, !i.error && i.scrB <= i.pane.b - 1 + 0.5 && i.scrR <= i.pane.r - 1 + 0.5, i);
  check(`S7 ${name}: the pane's bottom edge is above the key row`, !i.error && i.pane.b <= i.keysTop + 0.5, i);
  check(`S7 ${name}: the pane's right edge is inside the viewport`, !i.error && i.pane.r <= i.vw + 0.5 && i.pane.l >= 0, i);
  await typeIn(p, i.id, 'echo SZ-$(stty size)\r');
  let ok = false;
  for (let k = 0; k < 30 && !ok; k++) { await sleep(100); ok = (await screen(p, i.id)).includes(`SZ-${i.rows} ${i.cols}`); }
  check(`S7 ${name}: the pty size is ${i.rows} ${i.cols}`, ok, { rows: i.rows, cols: i.cols, tail: (await screen(p, i.id)).trim().split('\n').slice(-4) });
}

SCEN['S7'] = async () => {
  const p = await page('/', { phone: true, noGL: true });
  p.on('dialog', (d) => d.accept());
  const id0 = await dock(p);
  await ev(p, (c) => TW.create({ cwd: c }), WEB);
  await waitFor(p, () => TW.sessions().length === 2, 10000);
  await waitFor(p, () => TW.spaces().length === 2 && TW.spaces().some((x) => x.name === 'Web login flow'), 10000);
  await ev(p, () => TW.refreshList());
  await sleep(500);
  const webId = await ev(p, () => TW.sessions().find((s) => s.key.includes('02-web-login')).id);
  await fake(p, webId, 'blocked');
  await waitFor(p, () => TW.rows().some((r) => r.agent && r.agent.state === 'blocked'), 8000);
  await sleep(500);
  check('S7 the phone sets data-phone', await ev(p, () => document.querySelector('.tw-root').dataset.phone) === '1');
  check('S7 no .tw-side is visible', await vis(p, '.tw-side') === false);
  check('S7 no .tw-split is visible', await vis(p, '.tw-split') === false);
  const act = await ev(p, () => TW.spaces().find((x) => x.key === TW.activeSpace()).name);
  const sum = await ev(p, () => { const b = document.querySelector('.tw-summary'); return b ? b.textContent : null; });
  check('S7 .tw-summary shows the active space name', typeof sum === 'string' && typeof act === 'string' && sum.includes(act) && sum.includes(' · '), { sum, act });
  const sw = await ev(p, () => { const b = document.querySelector('.tw-switch'); return b ? b.textContent.replace(/\s+/g, ' ').trim() + ' ' + getComputedStyle(b.querySelector('.tw-mark'), '::before').content.replace(/"/g, '') : null; });
  check('S7 .tw-switch reads "≡ 2" and the rollup mark', typeof sw === 'string' && /^≡ 2 ×$/.test(sw), sw);
  // Key row: Esc types ^[ ; compose sends. Both before the sheet, on the first space's pane.
  await ev(p, () => TW.showSpace(TW.spaces()[0].key));
  await sleep(300);
  const first = await ev(p, () => TW.focused().id);
  await typeIn(p, first, 'cat -v\r');
  await sleep(500);
  await p.tap('.tw-keys [data-k="esc"]');
  await typeIn(p, first, '\r');
  check('S7 the key row Esc still types ^[', await (async () => { for (let i = 0; i < 30; i++) { if ((await screen(p, first)).includes('^[')) return true; await sleep(100); } return false; })());
  await typeIn(p, first, '\x03');
  await p.tap('.tw-keys [data-k="compose"]');
  await ev(p, () => { const t = document.querySelector('.tw-compose textarea'); t.value = 'echo composed-ok'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.tap('.tw-compose [data-c="send"]');
  check('S7 the compose box still sends', await (async () => { for (let i = 0; i < 30; i++) { if (/\ncomposed-ok|^composed-ok/m.test(await screen(p, first))) return true; await sleep(100); } return false; })());
  await p.tap('.tw-keys [data-k="compose"]');
  // The sheet.
  await p.tap('.tw-switch');
  const sheet = await waitFor(p, () => !!document.querySelector('.tw-pick[data-present="sheet"]'), 3000);
  const box = await ev(p, () => { const e = document.querySelector('.tw-pick[data-present="sheet"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight }; });
  check('S7 .tw-switch opens the sheet, full viewport', sheet && !!box && !box.error && box.w >= box.iw - 1 && box.h >= box.ih - 1, box);
  const rowsH = await ev(p, () => [...document.querySelectorAll('.tw-pick .tw-pick-row')].map((r) => r.getBoundingClientRect().height));
  check('S7 sheet rows are at least 44px', Array.isArray(rowsH) && rowsH.length >= 2 && rowsH.every((h) => h >= 44), rowsH);
  check('S7 the sheet has a New terminal button', await ev(p, () => [...document.querySelectorAll('.tw-pick button')].some((b) => b.textContent.trim() === 'New terminal')) === true);
  await shot(p, 's7-phone-dark-sheet');
  await ev(p, (id) => document.querySelector(`.tw-pick .tw-pick-row[data-id="${id}"]`).click(), webId);
  check('S7 tapping a row closes the sheet', await waitFor(p, () => !document.querySelector('.tw-pick'), 3000));
  await sleep(500);
  const shown = await ev(p, () => [...document.querySelectorAll('.tw-pane')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; }).map((e) => e.dataset.id));
  check('S7 that row\'s pane is the only visible one', Array.isArray(shown) && shown.length === 1 && shown[0] === webId, { shown, webId });
  const sum2 = await ev(p, () => document.querySelector('.tw-summary').textContent);
  check('S7 the summary now names Web login flow', typeof sum2 === 'string' && sum2.includes('Web login flow'), sum2);
  await sleep(700);
  await typeIn(p, webId, '\x03');   // the fake agent in that pane: back to a prompt
  await sleep(500);
  await phoneSized(p, 'after the switch');
  await shot(p, 's7-phone-switched-dark');
  // Splitting in phone mode keeps the tree but shows one pane.
  await ev(p, () => TW.split('right'));
  await waitFor(p, () => TW.sessions().length === 3, 10000);
  await sleep(500);
  const shown2 = await ev(p, () => [...document.querySelectorAll('.tw-pane')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; }).length);
  check('S7 two panes in a space still show one on the phone', shown2 === 1, shown2);
  await sleep(1200);
  await phoneSized(p, 'after the split');
  await shot(p, 's7-phone-split-dark');
  // The hidden sibling is drawn at the same full size (spec, Phone): same cols and rows, in xterm and in the pty,
  // and switching between the two refits neither.
  const split = await ev(p, (w) => TW.focused().id !== w && TW.session(w) ? TW.focused().id : null, webId);
  check('S7 after the split the new pane is focused and the sibling is hidden', typeof split === 'string', split);
  if (typeof split === 'string') {
    const xs = [await xtermSize(p, split), await xtermSize(p, webId)];
    check('S7 after the split the hidden sibling has the focused pane\'s cols and rows', JSON.stringify(xs[0]) === JSON.stringify(xs[1]), { focused: xs[0], sibling: xs[1] });
    const ptys = [await sttySize(p, split), await sttySize(p, webId)];
    check('S7 and stty size agrees in both panes', JSON.stringify(ptys[0]) === JSON.stringify(xs[0]) && JSON.stringify(ptys[1]) === JSON.stringify(xs[0]), { xs, ptys });
    await ev(p, (ids) => { window.__rs = []; for (const i of ids) TW.session(i).handle.term.onResize((d) => window.__rs.push([i, d.cols, d.rows])); }, [split, webId]);
    await ev(p, (w) => TW.focus(w), webId);
    await sleep(800);
    const shownNow = await ev(p, () => [...document.querySelectorAll('.tw-pane')].filter((e) => getComputedStyle(e).visibility !== 'hidden').map((e) => e.dataset.id));
    check('S7 switching shows the sibling alone', Array.isArray(shownNow) && shownNow.length === 1 && shownNow[0] === webId, shownNow);
    await phoneSized(p, 'on the sibling');
    await shot(p, 's7-phone-split-sibling-dark');
    await ev(p, (s) => TW.focus(s), split);
    await sleep(800);
    check('S7 switching there and back resizes neither pane', (await ev(p, () => window.__rs.length)) === 0, await ev(p, () => window.__rs));
    const ptys2 = [await sttySize(p, split), await sttySize(p, webId)];
    check('S7 and both ptys keep that size', JSON.stringify(ptys2) === JSON.stringify(ptys), { ptys, ptys2 });
  }
  await p.tap('.tw-pane.focused .tw-pane-more');
  await sleep(300);
  check('S7 tapping the strip ⋯ opens the pane menu and it stays open', await ev(p, () => !document.querySelector('.tw-menu').hidden) === true);
  await p.keyboard.press('Escape');
  await sleep(300);
  await shot(p, 's7-phone-dark');
  await ev(p, () => { document.documentElement.dataset.theme = 'light'; });
  await sleep(600);
  await shot(p, 's7-phone-sepia');
  await p.tap('.tw-summary');
  check('S7 .tw-summary opens the sheet too', await waitFor(p, () => !!document.querySelector('.tw-pick[data-present="sheet"]'), 3000));
  await shot(p, 's7-phone-sepia-sheet');
  await p.close();
};

SCEN['S7-desktop'] = async () => {
  const m = await page('/');
  m.on('dialog', (d) => d.accept());
  await dock(m);
  await ev(m, (c) => TW.create({ cwd: c }), WEB);
  await waitFor(m, () => TW.sessions().length === 2, 10000);
  await ev(m, (c) => TW.create({ cwd: c }), OPS);
  await waitFor(m, () => { const n = TW.spaces().map((x) => x.name); return n.length === 3 && n.includes('Web login flow'); }, 10000);
  await ev(m, () => TW.refreshList());
  await sleep(500);
  // Open a task drawer (the dock stays up under it).
  await ev(m, (c) => openTask(`${c}/task.md`), WEB);
  const drawerOpen = await waitFor(m, () => !document.getElementById('drawer').classList.contains('hidden'), 5000);
  check('S7-desktop the task drawer is open to start with', drawerOpen);
  await ev(m, () => TW.openPicker());
  check('S7-desktop TW.openPicker opens a modal', await waitFor(m, () => !!document.querySelector('.tw-pick[data-present="modal"]'), 2000));
  check('S7-desktop the filter input has focus', await ev(m, () => document.activeElement === document.querySelector('.tw-pick input')) === true);
  const all = await ev(m, () => document.querySelectorAll('.tw-pick .tw-pick-row').length);
  check('S7-desktop all three rows are listed', all === 3, all);
  await shot(m, 's7-picker-dark');
  await m.keyboard.type('web');
  await sleep(200);
  const f = await ev(m, () => [...document.querySelectorAll('.tw-pick .tw-pick-row')].map((r) => r.dataset.id));
  const web = await ev(m, () => TW.sessions().find((s) => s.key.includes('02-web-login')).id);
  check('S7-desktop typing web filters to the web-login rows', Array.isArray(f) && f.length === 1 && f[0] === web, { f, web });
  await m.keyboard.press('ArrowDown');
  await m.keyboard.press('ArrowUp');
  await m.keyboard.press('Enter');
  check('S7-desktop Enter closes the picker and focuses that pane', await waitFor(m, (w) => !document.querySelector('.tw-pick') && TW.focused().id === w, 3000, web));
  // ArrowDown moves the selection, Enter picks it.
  await sleep(400);
  await ev(m, () => TW.openPicker());
  await waitFor(m, () => !!document.querySelector('.tw-pick'), 2000);
  const order = await ev(m, () => [...document.querySelectorAll('.tw-pick .tw-pick-row')].map((r) => r.dataset.id));
  await m.keyboard.press('ArrowDown');
  await m.keyboard.press('Enter');
  check('S7-desktop ArrowDown then Enter picks the second row', Array.isArray(order) && await waitFor(m, (w) => TW.focused().id === w, 3000, order[1]), { order });
  // Escape closes the picker only: the drawer stays open.
  await sleep(400);   // the pick's own queued pane focus must land before the picker re-opens
  await ev(m, () => TW.openPicker());
  await waitFor(m, () => !!document.querySelector('.tw-pick'), 2000);
  await m.keyboard.press('Escape');
  check('S7-desktop Escape closes the picker', await waitFor(m, () => !document.querySelector('.tw-pick'), 2000));
  check('S7-desktop the task drawer is still open after Escape', await ev(m, () => !document.getElementById('drawer').classList.contains('hidden')) === true);
  // Click a non-focusable spot inside the picker (a row's gap, the list padding), then Escape: still only the picker closes.
  for (const where of ['row', 'padding']) {
    await sleep(400);
    await ev(m, () => TW.openPicker());
    await waitFor(m, () => !!document.querySelector('.tw-pick'), 2000);
    const pt = await ev(m, (w) => { const r = document.querySelector(w === 'row' ? '.tw-pick .tw-pick-head' : '.tw-pick .tw-pick-list').getBoundingClientRect(); return { x: r.left + r.width / 2, y: w === 'row' ? r.top + r.height / 2 : r.bottom - 2 }; }, where);
    await m.mouse.click(pt.x, pt.y);
    await sleep(200);
    await m.keyboard.press('Escape');
    check(`S7-desktop Escape closes the picker after clicking the ${where}`, await waitFor(m, () => !document.querySelector('.tw-pick'), 2000));
    check(`S7-desktop and the drawer stays open (after clicking the ${where})`, await ev(m, () => !document.getElementById('drawer').classList.contains('hidden')) === true);
  }
  // Literal, truncated titles.
  await ev(m, () => TW.openPicker());
  await waitFor(m, () => !!document.querySelector('.tw-pick'), 2000);
  const lit = await ev(m, () => {
    const h = [...document.querySelectorAll('.tw-pick .tw-pick-space')].find((x) => x.textContent.includes('<b>Ops'));
    return h ? { text: h.textContent, b: document.querySelectorAll('.tw-pick b').length } : null;
  });
  check('S7-desktop an HTML-looking task title renders literally in the picker', !!lit && !lit.error && lit.text.includes('<b>Ops & "DNS"') && lit.b === 0, lit);
  await m.keyboard.press('Escape');
  await m.close();
};

// S6: Ctrl+Space prefix keys, the mode bar, the ? sheet (dock, desktop).
const ctrlSpace = async (p) => { await p.keyboard.down('Control'); await p.keyboard.press('Space'); await p.keyboard.up('Control'); };
SCEN['S6'] = async () => {
  const p = await page('/');
  p.on('dialog', (d) => d.accept());
  const id = await dock(p);
  const bar = (q) => ev(p, (x) => { const b = document.querySelector('.tw-modebar'); return x === 'hidden' ? (!b || b.hidden || getComputedStyle(b).display === 'none') : !!b && !b.hidden && getComputedStyle(b).display !== 'none'; }, q);
  const printed = async (t) => { for (let i = 0; i < 20; i++) { if ((await screen(p, id)).includes(t)) return true; await sleep(100); } return false; };
  // 1. Ctrl+Space twice sends one NUL.
  await typeIn(p, id, 'cat -v\r');
  await sleep(500);
  await ctrlSpace(p); await ctrlSpace(p);
  await p.keyboard.press('Enter');
  check('S6 Ctrl+Space twice sends NUL (^@)', await printed('^@'));
  // 2. Escape alone still reaches the shell, and does not close the drawer.
  await p.keyboard.press('Escape');
  await p.keyboard.press('Enter');
  check('S6 a bare Escape types ^[', await printed('^['));
  await ev(p, (c) => openTask(`${c}/task.md`), WEB);
  await waitFor(p, () => !document.getElementById('drawer').classList.contains('hidden'), 5000);
  await ev(p, (i) => TW.session(i).handle.focus(), id);
  await sleep(200);
  await p.keyboard.press('Escape');
  await sleep(300);
  check('S6 Escape in the terminal leaves the drawer open', await ev(p, () => !document.getElementById('drawer').classList.contains('hidden')) === true);
  // 3. Armed then Escape: nothing printed, bar hidden.
  await typeIn(p, id, '\x0c');
  await sleep(300);
  const before = await screen(p, id);
  await ctrlSpace(p);
  await p.keyboard.press('Escape');
  await sleep(300);
  check('S6 Ctrl+Space then Escape prints nothing', (await screen(p, id)) === before);
  check('S6 and the mode bar is hidden afterwards', await bar('hidden') === true);
  // 4. The mode bar, then \ splits.
  await ctrlSpace(p);
  check('S6 Ctrl+Space shows the mode bar', await bar('shown') === true);
  const txt = await ev(p, () => document.querySelector('.tw-modebar').textContent);
  check('S6 the bar has PREFIX and split right', typeof txt === 'string' && txt.includes('PREFIX') && txt.toLowerCase().includes('split right'), txt);
  await shot(p, 's6-modebar-dark');
  const n0 = await ev(p, () => TW.sessions().length);
  await p.keyboard.press('Backslash');
  check('S6 backslash splits right (+1 pane)', await waitFor(p, (n) => TW.sessions().length === n + 1, 10000, n0));
  await sleep(800);
  // 5. z zooms, ArrowLeft moves focus left.
  const right = await ev(p, () => TW.focused().id);
  await ctrlSpace(p); await p.keyboard.press('KeyZ');
  await sleep(300);
  check('S6 Ctrl+Space z zooms', await ev(p, () => document.querySelectorAll('#term-area .tw-pane:not(.tw-off)').length === 1) === true);
  await ctrlSpace(p); await p.keyboard.press('ArrowLeft');
  await sleep(300);
  check('S6 Ctrl+Space ArrowLeft moves focus to the left pane', await ev(p, (r) => TW.focused().id !== r, right) === true, right);
  await ctrlSpace(p); await p.keyboard.press('KeyZ');
  await sleep(300);
  // 6. Typing in a Board input: Ctrl+Space is left alone.
  await ev(p, () => { const s = document.getElementById('search'); s.value = 'abc'; s.focus(); });
  await ctrlSpace(p);
  await sleep(200);
  check('S6 in the Board search input the bar stays hidden', await bar('hidden') === true);
  check('S6 and the input value is unchanged', await ev(p, () => document.getElementById('search').value) === 'abc');
  await ev(p, () => { document.getElementById('search').value = ''; document.getElementById('search').blur(); });
  // 7. Alt+2 goes to the second space.
  await ev(p, (c) => TW.create({ cwd: c }), WEB);
  await waitFor(p, () => TW.spaceKeys().length === 2, 10000);
  await sleep(500);
  const keys = await ev(p, () => TW.spaceKeys());
  await ev(p, (k) => TW.showSpace(k), keys[0]);
  await sleep(300);
  await p.keyboard.down('Alt'); await p.keyboard.press('Digit2'); await p.keyboard.up('Alt');
  check('S6 Alt+2 activates the second space', await waitFor(p, (k) => TW.activeSpace() === k, 3000, keys[1]), { keys, now: await ev(p, () => TW.activeSpace()) });
  const webId = await ev(p, () => TW.focused().id);
  // 8. ? opens the sheet; filter; Escape closes only it.
  await ctrlSpace(p); await p.keyboard.down('Shift'); await p.keyboard.press('Slash'); await p.keyboard.up('Shift');
  check('S6 Ctrl+Space ? opens the sheet', await waitFor(p, () => !!document.querySelector('.tw-sheet'), 2000));
  await p.keyboard.type('zoom');
  await sleep(200);
  const rows = await ev(p, () => document.querySelectorAll('.tw-sheet .tw-sheet-row').length);
  check('S6 filtering "zoom" leaves exactly 1 row', rows === 1, rows);
  await ev(p, () => { const i = document.querySelector('.tw-sheet input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  check('S6 the dock\'s sheet lists Ctrl+` (show or hide the terminals)', (await ev(p, () => [...document.querySelectorAll('.tw-sheet .tw-sheet-row kbd')].some((k) => k.textContent === 'Ctrl+`'))) === true);
  await shot(p, 's6-sheet-dark');
  await p.keyboard.press('Escape');
  check('S6 Escape closes the sheet', await waitFor(p, () => !document.querySelector('.tw-sheet'), 2000));
  check('S6 and the drawer stays open', await ev(p, () => !document.getElementById('drawer').classList.contains('hidden')) === true);
  // Escape still closes the sheet, and only it, after a click on a non-focusable spot inside it.
  const openSheetAgain = async () => {
    await ev(p, () => TW.focused() && TW.focused().handle.focus());
    await ctrlSpace(p); await p.keyboard.down('Shift'); await p.keyboard.press('Slash'); await p.keyboard.up('Shift');
    return waitFor(p, () => !!document.querySelector('.tw-sheet'), 2000);
  };
  const clickAt = async (sel, where) => {
    const pt = await ev(p, (q, w) => { const r = document.querySelector(q).getBoundingClientRect(); return w === 'bottom' ? { x: r.left + r.width / 2, y: r.bottom - 2 } : { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel, where);
    await p.mouse.click(pt.x, pt.y);
  };
  for (const [name, sel, where] of [['a row', '.tw-sheet-row', 'mid'], ['the list padding', '.tw-sheet-list', 'bottom']]) {
    await openSheetAgain();
    await clickAt(sel, where);
    await sleep(200);
    await p.keyboard.press('Escape');
    check(`S6 Escape closes the sheet after clicking ${name}`, await waitFor(p, () => !document.querySelector('.tw-sheet'), 2000));
    check(`S6 and the drawer stays open (after clicking ${name})`, await ev(p, () => !document.getElementById('drawer').classList.contains('hidden')) === true);
  }
  // 9. n goes to the pane that needs you.
  await fake(p, webId, 'blocked');
  await waitFor(p, () => TW.rows().some((r) => r.agent && r.agent.state === 'blocked'), 8000);
  await ev(p, (k) => TW.showSpace(k), keys[0]);
  await sleep(500);
  await ev(p, () => TW.focused() && TW.focused().handle.focus());
  await ctrlSpace(p); await p.keyboard.press('KeyN');
  check('S6 Ctrl+Space n focuses the blocked pane', await waitFor(p, (w) => TW.focused().id === w, 3000, webId), { now: await ev(p, () => TW.focused().id), webId });
  // Narrow match: Ctrl+Shift+Space does not arm.
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.press('Space'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
  await sleep(200);
  check('S6 Ctrl+Shift+Space does not arm the prefix', await bar('hidden') === true);
  // 10. The direct keys do nothing under an open overlay: the ? sheet (Alt+2) and the Go-to picker (Ctrl+Shift+`).
  await ev(p, (k) => TW.showSpace(k), keys[0]);
  await sleep(300);
  await openSheetAgain();
  await p.keyboard.down('Alt'); await p.keyboard.press('Digit2'); await p.keyboard.up('Alt');
  await sleep(500);
  check('S6 with the ? sheet open, Alt+2 does not switch space', (await ev(p, () => TW.activeSpace())) === keys[0] && (await ev(p, () => !!document.querySelector('.tw-sheet'))) === true,
    { keys, now: await ev(p, () => TW.activeSpace()) });
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.tw-sheet'), 2000);
  const ctrlShiftTick = async () => { await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.press('Backquote'); await p.keyboard.up('Shift'); await p.keyboard.up('Control'); };
  await ev(p, () => TW.focused().handle.focus());
  const n1 = await ev(p, () => TW.sessions().length);
  await ctrlShiftTick();
  check('S6 Ctrl+Shift+` opens a new pane (no overlay)', await waitFor(p, (n) => TW.sessions().length === n + 1, 10000, n1), { n1, now: await ev(p, () => TW.sessions().length) });
  await sleep(800);
  await ev(p, () => TW.openPicker());
  await waitFor(p, () => !!document.querySelector('.tw-pick'), 2000);
  const n2 = await ev(p, () => TW.sessions().length);
  await ctrlShiftTick();
  await sleep(1500);
  check('S6 with the Go-to picker open, Ctrl+Shift+` opens no pane', (await ev(p, () => TW.sessions().length)) === n2 && (await ev(p, () => !!document.querySelector('.tw-pick'))) === true,
    { n2, now: await ev(p, () => TW.sessions().length) });
  await p.keyboard.press('Escape');
  await p.close();
  // 11. The pop-out window has no dock, so its sheet has no Ctrl+` row.
  const w = await page('/terminal.html');
  await waitFor(w, () => typeof TW !== 'undefined' && TW.sessions().length === 1, 10000);
  await sleep(800);
  await ev(w, () => TW.focused().handle.focus());
  await ctrlSpace(w); await w.keyboard.down('Shift'); await w.keyboard.press('Slash'); await w.keyboard.up('Shift');
  check('S6 the window\'s ? sheet opens', await waitFor(w, () => !!document.querySelector('.tw-sheet'), 2000));
  const wk = await ev(w, () => [...document.querySelectorAll('.tw-sheet .tw-sheet-row kbd')].map((k) => k.textContent));
  check('S6 the window\'s sheet has no Ctrl+` row', Array.isArray(wk) && wk.length > 0 && !wk.includes('Ctrl+`') && wk.includes('Ctrl+Shift+`'), wk);
  await shot(w, 's6-window-sheet-dark');
  await w.close();
};
// S6-sepia: the sheet on sepia.
SCEN['S6-sepia'] = async () => {
  const p = await page('/', { theme: 'light' });
  await dock(p);
  await ctrlSpace(p); await p.keyboard.down('Shift'); await p.keyboard.press('Slash'); await p.keyboard.up('Shift');
  check('S6-sepia the sheet opens', await waitFor(p, () => !!document.querySelector('.tw-sheet'), 2000));
  await shot(p, 's6-sheet-sepia');
  await p.close();
};

// S5: a background agent that needs you / finishes raises a toast; clicking it goes there.
const toastTexts = (p) => ev(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
SCEN.S5 = async () => {
  const p = await page('/');
  await bare(p);
  const A = await openTerm(p, { cwd: 'Code' });
  await sleep(1200);
  const B = await openTerm(p, { cwd: WEB });
  await waitFor(p, () => TW.spaces().length === 2 && TW.spaces().some((x) => x.name === 'Web login flow'), 10000);
  await sleep(1200);
  const keyA = await ev(p, (i) => TW.session(i).key, A);
  await ev(p, (k) => TW.showSpace(k), keyA);
  await fake(p, B, 'working');
  await listWait(B, (x) => x.agent && x.agent.state === 'working');
  check('S5 no toast while the agent only works', (await toastTexts(p)).length === 0, await toastTexts(p));
  await typeIn(p, B, 'b');
  const got = await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => / needs you/.test(t.textContent) && /Web login flow/.test(t.textContent)), 5000);
  const texts = await toastTexts(p);
  check('S5 a toast reads "<agent> needs you" with the space name', got, texts);
  check('S5 the toast sub reads "<space> · pane N"', Array.isArray(texts) && texts.some((t) => /Web login flow · pane 1/.test(t)), texts);
  check('S5 the toast is a button that never takes focus', await ev(p, () => { const t = document.querySelector('.tw-toasts .tw-toast'); return !!t && t.tagName === 'BUTTON' && document.activeElement !== t; }) === true);
  await shot(p, 's5-toast-dark');
  await ev(p, () => { document.documentElement.dataset.theme = 'light'; });
  await sleep(500);
  await shot(p, 's5-toast-sepia');
  await ev(p, () => { document.documentElement.dataset.theme = 'dark'; });
  await ev(p, () => document.querySelector('.tw-toasts .tw-toast').click());
  const keyB = await ev(p, (i) => TW.session(i).key, B);
  check('S5 clicking the toast activates that space', await waitFor(p, (k) => TW.activeSpace() === k, 3000, keyB));
  check('S5 the toast is gone after the click', await waitFor(p, () => document.querySelectorAll('.tw-toasts .tw-toast').length === 0, 2000));
  await typeIn(p, B, 'd');
  await ev(p, (k) => TW.showSpace(k), keyA);
  await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => / finished/.test(t.textContent)), 5000);
  await ev(p, (k) => TW.showSpace(k), keyB);
  const idle = await waitFor(p, (i) => { const r = TW.rows().find((x) => x.id === i); return r && r.agent && r.agent.state === 'idle'; }, 5000, B);
  check('S5 done then looked at goes idle (seen)', idle);
  // Unfocused page: no toast.
  await ev(p, (k) => TW.showSpace(k), keyA);
  await ev(p, () => document.querySelectorAll('.tw-toasts .tw-toast').forEach((t) => t.click()));
  await sleep(300);
  const p2 = await page('/terminal.html', { context: p.browserContext() });
  await p2.bringToFront();
  await sleep(500);
  const unfocused = await ev(p, () => document.hasFocus());
  await typeIn(p, B, 'b');
  await listWait(B, (x) => x.agent && x.agent.state === 'blocked');
  await sleep(1500);
  const n = await toastTexts(p);
  check('S5 an unfocused page shows no toast', unfocused === false && Array.isArray(n) && n.length === 0, { unfocused, n });
  // Literal, truncated text: a long HTML-ish space name in the sub.
  await p2.close();
  await p.bringToFront();
  const O = await openTerm(p, { cwd: OPS });
  await waitFor(p, () => TW.spaces().some((x) => x.name.startsWith('<b>Ops')), 10000);
  await sleep(1000);
  await ev(p, (k) => TW.showSpace(k), keyA);
  await fake(p, O, 'working');
  await listWait(O, (x) => x.agent && x.agent.state === 'working');
  await typeIn(p, O, 'b');
  await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast-sub')].some((t) => t.textContent.startsWith('<b>Ops')), 5000);
  const lit = await ev(p, () => {
    const sub = [...document.querySelectorAll('.tw-toasts .tw-toast-sub')].find((t) => t.textContent.startsWith('<b>Ops'));
    if (!sub) return null;
    return { text: sub.textContent, bEls: document.querySelectorAll('.tw-toasts b').length, sw: sub.scrollWidth, cw: sub.clientWidth, to: getComputedStyle(sub).textOverflow, long: sub.textContent.length };
  });
  check('S5 an HTML-ish long space name renders literally and truncates with an ellipsis', !!lit && !lit.error && lit.text.includes('<b>Ops') && lit.bEls === 0 && lit.sw > lit.cw && lit.to === 'ellipsis', lit);
  // The cap of 4 and the oldest dropped; the same id + kind replaces; lifetimes.
  const caps = await ev(p, () => {
    const t = TermToast.create({});
    for (let i = 0; i < 5; i++) t.push({ id: 'x' + i, kind: 'info', title: 'T' + i, sub: '' });
    const names = [...t.el.querySelectorAll('.tw-toast-title')].map((x) => x.textContent);
    t.push({ id: 'x4', kind: 'info', title: 'T4b', sub: '' });
    const after = [...t.el.querySelectorAll('.tw-toast-title')].map((x) => x.textContent);
    t.clear();
    t.el.remove();
    return { names, after };
  });
  check('S5 at most 4 toasts show and the oldest is dropped', !caps.error && caps.names.join() === 'T1,T2,T3,T4', caps);
  check('S5 the same id + kind replaces the older toast', !caps.error && caps.after.join() === 'T1,T2,T3,T4b', caps);
  await ev(p, () => {
    window.__lt = TermToast.create({});
    window.__lt.push({ id: 'i', kind: 'info', title: 'info', sub: '' });
    window.__lt.push({ id: 'd', kind: 'done', title: 'done', sub: '' });
    window.__lt.push({ id: 'b', kind: 'blocked', title: 'blocked', sub: '' });
  });
  await sleep(4400);
  const l1 = await ev(p, () => [...window.__lt.el.querySelectorAll('.tw-toast-title')].map((x) => x.textContent).join());
  await sleep(1000);
  const l2 = await ev(p, () => [...window.__lt.el.querySelectorAll('.tw-toast-title')].map((x) => x.textContent).join());
  await sleep(3000);
  const l3 = await ev(p, () => { const r = [...window.__lt.el.querySelectorAll('.tw-toast-title')].map((x) => x.textContent).join(); window.__lt.el.remove(); return r; });
  check('S5 lifetimes: info 4s, done 5s, blocked 8s', l1 === 'done,blocked' && l2 === 'blocked' && l3 === '', { l1, l2, l3 });
  // Mouse down on a toast must not pull focus off the terminal.
  await ev(p, () => document.querySelectorAll('.tw-toasts .tw-toast').forEach((t) => t.click()));
  await ev(p, (k) => TW.showSpace(k), keyA);
  await ev(p, (i) => TW.session(i).handle.focus(), A);
  await typeIn(p, B, 'w');
  await typeIn(p, B, 'b');
  await waitFor(p, () => !!document.querySelector('.tw-toasts .tw-toast'), 5000);
  await ev(p, () => { window.__ae = null; document.addEventListener('mouseup', () => { window.__ae = document.activeElement && document.activeElement.className; }, { capture: true, once: true }); });
  const tr = await ev(p, () => { const r = document.querySelector('.tw-toasts .tw-toast').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.click(tr.x, tr.y);
  const ae = await ev(p, () => window.__ae);
  check('S5 mousedown on a toast leaves focus in the xterm until the click', typeof ae === 'string' && ae.includes('xterm-helper-textarea'), ae);
  // Sound key.
  await p.bringToFront();
  check('S5 the sound key is absent by default', await ev(p, () => localStorage.getItem('vaultboard.term.sound')) === null);
  await ev(p, () => document.querySelector('#segTermSound button[data-v="on"]').click());
  check('S5 #segTermSound On stores JSON true', await ev(p, () => localStorage.getItem('vaultboard.term.sound')) === 'true');
  const w = await page('/terminal.html', { context: p.browserContext() });
  await ev(w, () => document.querySelector('.tw-side .tw-side-menu').click());
  const item = await ev(w, () => { const b = [...document.querySelectorAll('.tw-menu button')].find((x) => x.textContent.startsWith('Sound')); return b ? b.textContent : null; });
  check('S5 the window footer menu reads Sound: On', item === 'Sound: On', item);
  await w.close();
  await p.close();
};

// S5-phone: the toast sits at the top on the phone.
SCEN['S5-phone'] = async () => {
  const p = await page('/', { phone: true, noGL: true });
  await bare(p);
  const A = await openTerm(p, { cwd: 'Code' });
  await sleep(1200);
  const B = await openTerm(p, { cwd: WEB });
  await waitFor(p, () => TW.spaces().length === 2, 10000);
  await sleep(1200);
  await ev(p, (i) => TW.showSpace(TW.session(i).key), A);
  await fake(p, B, 'working');
  await listWait(B, (x) => x.agent && x.agent.state === 'working');
  await typeIn(p, B, 'b');
  const got = await waitFor(p, () => !!document.querySelector('.tw-toasts .tw-toast'), 5000);
  const r = await ev(p, () => { const t = document.querySelector('.tw-toasts .tw-toast').getBoundingClientRect(); return { top: t.top, bottom: t.bottom, vh: innerHeight, r: t.right, vw: innerWidth }; });
  check('S5-phone the toast is at the top and inside the viewport', got && !r.error && r.top < r.vh / 3 && r.top >= 0 && r.r <= r.vw, r);
  await shot(p, 's5-toast-phone');
  await p.close();
};

// S5-hidden: a blocked agent in the active space of a hidden dock still toasts.
SCEN['S5-hidden'] = async () => {
  const p = await page('/');
  await bare(p);
  const A = await openTerm(p, { cwd: 'Code' });
  await sleep(1500);
  await fake(p, A, 'working');
  await listWait(A, (x) => x.agent && x.agent.state === 'working');
  await ev(p, () => dockShow(false));
  check('S5-hidden the dock is closed', await ev(p, () => document.getElementById('term-dock').classList.contains('hidden')) === true);
  await typeIn(p, A, 'b');
  const got = await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => / needs you/.test(t.textContent)), 5000);
  check('S5-hidden a blocked agent in the active space toasts while the dock is closed', got, await toastTexts(p));
  await p.close();
};

// S5-phone-pane: on the phone only the focused pane is on screen, so a blocked agent in another pane of the active space toasts.
SCEN['S5-phone-pane'] = async () => {
  const p = await page('/', { phone: true, noGL: true });
  await bare(p);
  const A = await openTerm(p, { cwd: 'Code' });
  await sleep(1500);
  await fake(p, A, 'working');
  await listWait(A, (x) => x.agent && x.agent.state === 'working');
  await ev(p, (i) => TW.create({ split: 'right', target: i }), A);
  await waitFor(p, () => TW.sessions().length === 2, 10000);
  await sleep(1000);
  const foc = await ev(p, () => TW.focused().id);
  check('S5-phone-pane the new pane is the focused one, in the same space', foc !== A && await ev(p, (a, f) => TW.session(a).key === TW.session(f).key, A, foc) === true, foc);
  await typeIn(p, A, 'b');
  const got = await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => / needs you/.test(t.textContent)), 5000);
  check('S5-phone-pane a blocked agent in a non-focused pane toasts', got, await toastTexts(p));
  await p.close();
};

// S12-toast: at the cap, create() shows a toast.
SCEN['S12-toast'] = async () => {
  const p = await page('/');
  await bare(p);
  for (let i = 0; i < 12; i++) await openTerm(p, { run: 'sleep 600' });
  const end = Date.now() + 20000;
  let l = [];
  while (Date.now() < end) { l = await list(); if (l.length === 12 && l.every((x) => x.cmd)) break; await sleep(300); }
  await waitFor(p, () => TW.list() && TW.list().length === 12, 5000);
  await ev(p, () => TW.create());
  const got = await waitFor(p, () => [...document.querySelectorAll('.tw-toasts .tw-toast')].some((t) => /12 terminals open/.test(t.textContent) && /Close one to open another/.test(t.textContent)), 3000);
  check('S12-toast a toast says "12 terminals open"', got, await toastTexts(p));
  await shot(p, 's12-toast');
  await p.close();
};

// S10: under prefers-reduced-motion, no mark animates (working pulse, the alert ring on the header button).
SCEN.S10 = async () => {
  const p = await page('/');
  await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await bare(p);
  const A = await openTerm(p, { cwd: 'Code' });
  await sleep(1200);
  await fake(p, A, 'working');
  await listWait(A, (x) => x.agent && x.agent.state === 'working');
  await waitFor(p, () => !!document.querySelector('.tw-mark[data-agent="working"]'), 5000);
  const r = await ev(p, () => {
    const dot = document.createElement('span'); dot.className = 'agent-dot'; dot.dataset.agent = 'working'; document.body.appendChild(dot);
    const btn = document.getElementById('termbtn'); btn.dataset.alert = 'blocked';
    const out = {
      dot: getComputedStyle(dot).animationName,
      ring: getComputedStyle(btn, '::after').animationName,
      mark: getComputedStyle(document.querySelector('.tw-mark[data-agent="working"]')).animationName,
    };
    dot.remove(); delete btn.dataset.alert;
    return out;
  });
  check('S10 .agent-dot[working] has no animation', r.dot === 'none', r);
  check('S10 #termbtn[data-alert]::after has no animation', r.ring === 'none', r);
  check('S10 .tw-mark[working] has no animation', r.mark === 'none', r);
  await p.close();
};

(async () => {
  if (!NAMES.length) { console.error('usage: node scripts/term-e2e.js [base-url] [--phone] [--theme=dark|sepia] S0 [S1 …]'); process.exit(2); }
  for (const n of NAMES) if (!SCEN[n]) { console.error('unknown scenario: ' + n); process.exit(2); }
  try {
    for (const n of NAMES) {
      console.log(`--- ${n}`);
      reset();
      await sleep(2500);   // the restarted server needs a moment
      await SCEN[n]();
    }
  } finally {
    if (browser) await browser.close();
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
