'use strict';
// Browser scenarios for Today mode, driven with puppeteer against the Today preview container
// (today-preview, 127.0.0.1:7691) — never the live board (:7684; it holds real day notes).
//
//   node scripts/today-e2e.js [base-url] [--phone] [--theme=dark|sepia] T0 [T1 …]
//
// Each scenario first resets the preview (synthetic vault regenerated, container restarted) to its pristine
// state, checks the container really restarted, and waits until a signed-in /api/tasks and /api/today both
// answer 200 (which creates today's note, as the page's first load would). The session cookie comes from the
// preview's mint-cookie.js and is never printed. Every check prints a PASS/FAIL line; the exit code is 1 when
// any check failed, 2 on bad usage. Screenshots go to /tmp/today-shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
// The preview's helpers (reset.sh, mint-cookie.js, and its vault/ for the day notes) and its container. Another
// preview stands in with TODAY_E2E_PREVIEW and TODAY_E2E_CONTAINER (and TODAY_E2E_OTHER_BASE=1 for its URL).
const PREVIEW = process.env.TODAY_E2E_PREVIEW || '/opt/vault/today-preview';
const CONTAINER = process.env.TODAY_E2E_CONTAINER || 'today-preview';
const SHOTS = '/tmp/today-shots';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:7691').replace(/\/$/, '');
const NAMES = args.filter((a) => !/^https?:\/\//.test(a) && !a.startsWith('--'));
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEFAULTS = { phone: args.includes('--phone'), theme: flag('theme') === 'sepia' ? 'light' : 'dark' };
// The one guard between a mistyped URL and live data: an allowlist, not a substring test. Only the
// preview, unless TODAY_E2E_OTHER_BASE=1 says another test server is meant; the live board's port never, either way.
const PREVIEW_BASE = 'http://127.0.0.1:7691';
const basePort = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
if (basePort === '7684') { console.error(`refusing to run against ${BASE}: that is the live board's port (7684)`); process.exit(2); }
if (BASE !== PREVIEW_BASE && process.env.TODAY_E2E_OTHER_BASE !== '1') {
  console.error(`refusing to run against ${BASE}: only the preview, ${PREVIEW_BASE} (set TODAY_E2E_OTHER_BASE=1 for another test server)`);
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
// Opens a page in the context (default: a fresh one) at BASE + path. `before(pg)` runs ahead of the first load
// (for evaluateOnNewDocument hooks).
async function page(p, { phone = DEFAULTS.phone, theme = DEFAULTS.theme, context, before } = {}) {
  const ctx = context || await launch();
  const pg = await ctx.newPage();
  await pg.setViewport(phone ? PHONE : DESKTOP);
  await pg.evaluateOnNewDocument((t) => { try { localStorage.setItem('vaultboard.theme', t); } catch {} }, theme);
  if (before) await before(pg);
  pg.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  // What the page saw, printed only when Today fails to paint (see painted()).
  pg.trail = [];
  pg.on('console', (m) => { if (m.type() === 'error') pg.trail.push(`console: ${m.text()}`); });
  pg.on('requestfailed', (r) => pg.trail.push(`failed: ${r.url().replace(BASE, '')} ${(r.failure() || {}).errorText}`));
  pg.on('response', (r) => { if (r.url().includes('/api/') && !r.ok()) pg.trail.push(`${r.status()}: ${r.url().replace(BASE, '')}`); });
  await pg.goto(BASE + p, { waitUntil: 'networkidle2' });
  return pg;
}
async function waitFor(p, fn, ms = 5000, ...a) {
  try { await p.waitForFunction(fn, { timeout: ms, polling: 100 }, ...a); return true; } catch { return false; }
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
async function shot(p, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const f = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: f });
  return f;
}
const reset = () => execFileSync(path.join(PREVIEW, 'reset.sh'), { stdio: 'inherit' });
// When the preview container last started. reset.sh ends with `docker restart … || true`, so a failed restart is
// silent, and the old server would carry on over a vault directory that reset.sh just deleted.
const startedAt = () => {
  try { return execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', CONTAINER], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
// Waits until the restarted preview serves, to a signed-in session, what the page's startup needs: the board
// (/api/tasks, whose success is what unhides #app) and Today (/api/today). /api/me answers as soon as Express
// listens, which is too early. The signed-in /api/today creates today's note, as the page's first load would.
async function previewReady(ms = 20000) {
  const headers = { Cookie: mintCookie() };
  const end = Date.now() + ms;
  let last = 'no answer';
  while (Date.now() < end) {
    try {
      const rs = await Promise.all(['/api/tasks?ws=personal', '/api/today'].map((u) => fetch(BASE + u, { headers })));
      const bodies = await Promise.all(rs.map((r) => r.text()));
      if (rs.every((r) => r.status === 200)) return { ok: true };
      last = rs.map((r, i) => `${r.status} ${bodies[i].slice(0, 80)}`).join(' / ');
    } catch (e) { last = String(e.message); }
    await sleep(250);
  }
  return { ok: false, last };
}

// Laid out and not hidden (an ancestor's display:none leaves no client rects). null when the element is
// missing, so a check for "hidden" (=== false) can't pass on an element that was never built.
const visible = (p, sel) => ev(p, (s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}, sel);
const text = (p, sel) => ev(p, (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
const themeTag = () => (DEFAULTS.theme === 'light' ? 'sepia' : 'dark');
const sizeTag = () => (DEFAULTS.phone ? 'phone' : 'desk');
const londonWeekday = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long' }).format(new Date());
const HABITS_COUNT = /^\d+\/8 habits( · .+ focus)?$/;
// A mode switch the way a person makes it: the header's mode pill, or the tab bar on a phone.
const modeBtn = (mode) => (DEFAULTS.phone ? `#mobile-nav button[data-for="mode-${mode}"]` : `#mode-${mode}`);
// Today has painted its first payload. When it hasn't, says why (the login screen, an error line, failed
// requests) and loads the page once more: a slow start gets a second chance, and the [retry] line stays in
// the output, so a regression that fails twice still fails the check.
async function painted(p) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ok = await waitFor(p, () => {
      const d = document.getElementById('td-next-date');
      return !!d && d.textContent.trim() !== '' && !document.getElementById('app').classList.contains('hidden');
    }, 15000);
    if (ok) return true;
    const st = await ev(p, () => ({
      login: !document.getElementById('login').classList.contains('hidden'),
      app: !document.getElementById('app').classList.contains('hidden'),
      err: (document.getElementById('td-err') || {}).textContent || '',
    }));
    console.log(`  [not painted] ${JSON.stringify(st)}${p.trail.length ? ' ' + p.trail.join(' | ') : ''}`);
    if (attempt === 2) break;
    console.log('  [retry] Today did not paint; loading the page once more');
    p.trail.length = 0;
    try { await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); } catch (e) { console.log(`  [retry] ${String(e.message).split('\n')[0]}`); }
  }
  return false;
}

const SCEN = {};

// T0: VaultOS lands on Today; the mode, tab bar, day stepping, count and reload state all hold.
SCEN.T0 = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx });
  check('T0 Today painted', await painted(p));
  check('T0 lands on Today: #mode-today.active', await ev(p, () => !!document.querySelector('#mode-today.active')) === true);
  check('T0 #today-view visible', await visible(p, '#today-view') === true);
  check('T0 #board-view hidden', await visible(p, '#board-view') === false);
  const wd = londonWeekday();
  const dow = await text(p, '#td-next-date');
  check(`T0 #td-next-date starts with ${wd.slice(0, 3)}`, typeof dow === 'string' && dow.startsWith(wd.slice(0, 3)), dow);
  check('T0 #td-next-date reads Fri 30 Oct · week N', /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})? · week \d{1,2}$/.test(dow || ''), dow);
  const dayOf = await ev(p, () => document.getElementById('td-next-date').title);
  check('T0 #td-next-date title reads day D of 365|366', /^day \d{1,3} of 36[56]$/.test(dayOf || ''), dayOf);
  const q = await text(p, '#td-quote-text');
  check('T0 #td-quote-text non-empty', typeof q === 'string' && q.length > 0, q);
  check('T0 ZenQuotes attribution link', await ev(p, () => {
    const a = [...document.querySelectorAll('#today-view a')].find((x) => x.textContent.trim() === 'Quotes from ZenQuotes');
    return !!a && a.href === 'https://zenquotes.io/' && /\bnoopener\b/.test(a.rel);
  }) === true);
  check('T0 #count is the habits count', HABITS_COUNT.test(await text(p, '#count') || ''), await text(p, '#count'));
  check('T0 search box hidden on Today', await visible(p, '#search') === false);
  check('T0 #td-nextday disabled on today', await ev(p, () => document.getElementById('td-nextday').disabled) === true);
  check('T0 #td-back hidden on today', await visible(p, '#td-back') === false);
  check('T0 no horizontal scroll', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth),
    await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  if (DEFAULTS.phone) {
    const nav = await ev(p, () => [...document.querySelectorAll('#mobile-nav button')].map((b) => b.textContent.trim()));
    check('T0 phone: #mobile-nav has 5 buttons', Array.isArray(nav) && nav.length === 5, nav);
    check('T0 phone: first tab is Today', Array.isArray(nav) && nav[0] === 'Today', nav);
    check('T0 phone: Today tab active', await ev(p, () => document.querySelector('#mobile-nav button').classList.contains('active')) === true);
    // Every visible header control sits on one row.
    const tops = await ev(p, () => [...document.querySelector('header').children]
      .filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)));
    check('T0 phone: header is one row', Array.isArray(tops) && tops.length > 0 && Math.max(...tops) - Math.min(...tops) <= 4, tops);
  }
  await shot(p, `t0-${themeTag()}-${sizeTag()}`);

  // ‹ steps back a day: Back to today appears, › comes alive; Back to today returns.
  await tap(p, '#td-prev');
  check('T0 ‹ shows #td-back', await waitFor(p, () => {
    const b = document.getElementById('td-back');
    return !!b && b.getClientRects().length > 0;
  }));
  const pastDay = await ev(p, () => document.getElementById('td-next').dataset.day);
  check('T0 ‹ moves off today (#td-next[data-day] is other)', pastDay === 'other', pastDay);
  check('T0 #td-nextday enabled on a past day', await ev(p, () => document.getElementById('td-nextday').disabled) === false);
  check('T0 shuffle hidden on a past day', await visible(p, '#td-shuffle') === false);
  check('T0 #count still today\'s habits on a past day', HABITS_COUNT.test(await text(p, '#count') || ''), await text(p, '#count'));
  await tap(p, '#td-back');
  check('T0 Back to today hides #td-back', await waitFor(p, () => {
    const b = document.getElementById('td-back');
    return !!b && b.getClientRects().length === 0 && document.getElementById('td-next').dataset.day === 'today';
  }), await ev(p, () => document.getElementById('td-next').dataset.day));

  // Board and back.
  await tap(p, modeBtn('board'));
  check('T0 Board shows #board-view', await waitFor(p, () => {
    const b = document.getElementById('board-view');
    return b.getClientRects().length > 0 && document.getElementById('today-view').getClientRects().length === 0;
  }));
  check('T0 Board #count says open', await waitFor(p, () => /open/.test(document.getElementById('count').textContent)), await text(p, '#count'));
  check('T0 search box back on Board', await visible(p, '#search') === true);
  if (DEFAULTS.phone) check('T0 phone: wordmark only on Today\'s header', await visible(p, 'header .brand') === false);
  await tap(p, modeBtn('today'));
  check('T0 Today again restores the habits count', await waitFor(p, (re) => new RegExp(re).test(document.getElementById('count').textContent.trim()), 5000, HABITS_COUNT.source),
    await text(p, '#count'));
  check('T0 Today again shows #today-view', await visible(p, '#today-view') === true);

  // Refresh while on Board comes back on Board; a fresh tab comes back on Today.
  await tap(p, modeBtn('board'));
  await waitFor(p, () => document.getElementById('board-view').getClientRects().length > 0);
  const reloaded = p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null);
  if (await tap(p, '#refresh')) await reloaded;
  check('T0 refresh on Board comes back on Board', await waitFor(p, () =>
    !document.getElementById('app').classList.contains('hidden')
    && document.getElementById('mode-board').classList.contains('active')
    && document.getElementById('board-view').getClientRects().length > 0, 8000),
  await ev(p, () => document.body.dataset.mode));
  check('T0 after refresh #count says open', /open/.test(await text(p, '#count') || ''), await text(p, '#count'));
  const p2 = await page('/', { context: ctx });
  check('T0 fresh tab painted', await painted(p2));
  check('T0 fresh tab lands on Today', await ev(p2, () =>
    document.getElementById('mode-today').classList.contains('active')
    && document.getElementById('today-view').getClientRects().length > 0) === true,
  await ev(p2, () => document.body.dataset.mode));
  await p2.close();
  await p.close();
  await ctx.close();
};

// T1: habits card — ticks write the note, past cells backfill, streaks, warning, week %, phone tick size.
const dayFile = (date) => path.join(PREVIEW, 'vault/Personal/Today/days', date.slice(0, 7), `${date}.md`);
const habitsLine = (date) => {
  try { return (fs.readFileSync(dayFile(date), 'utf8').match(/^habits:.*$/m) || [''])[0]; } catch { return null; }
};
const londonDate = (off = 0) => {
  const d = new Date(Date.now() + off * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
};
SCEN.T1 = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx });
  check('T1 Today painted', await painted(p));
  const today = londonDate(0), d2 = londonDate(-2);
  check('T1 #td-habits has 8 rows', await waitFor(p, () => document.querySelectorAll('#td-habits .td-hrow[data-id]').length === 8), await ev(p, () => document.querySelectorAll('#td-habits .td-hrow[data-id]').length));
  check('T1 each row has 7 cells', await ev(p, () => [...document.querySelectorAll('#td-habits .td-hrow[data-id]')].every((r) => r.querySelectorAll('.td-cell').length === 7)) === true);
  check('T1 #td-warn contains Bad Id', (await text(p, '#td-warn') || '').includes('Bad Id'), await text(p, '#td-warn'));
  check('T1 #td-week shows a percentage', /\d+%/.test(await text(p, '#td-week') || ''), await text(p, '#td-week'));
  check('T1 #td-bars has 7 bars', await ev(p, () => document.querySelectorAll('#td-bars > *').length) === 7);
  check('T1 vitamins streak shows 2', await text(p, '.td-hrow[data-id="vitamins"] .td-streak b') === '2', await text(p, '.td-hrow[data-id="vitamins"] .td-streak'));
  check('T1 goal habit shows progress, others not', await ev(p, () => !!document.querySelector('.td-hrow[data-id="read"] .td-prog') && !document.querySelector('.td-hrow[data-id="wake"] .td-prog')) === true);
  check('T1 read progress text', /0 \/ 30 min/.test(await text(p, '.td-hrow[data-id="read"] .td-prog') || ''), await text(p, '.td-hrow[data-id="read"] .td-prog'));
  await shot(p, `t1-${themeTag()}-${sizeTag()}-before`);

  await tap(p, '.td-hrow[data-id="wake"] .td-tick');
  check('T1 wake tick pressed', await waitFor(p, () => document.querySelector('.td-hrow[data-id="wake"] .td-tick').getAttribute('aria-pressed') === 'true'));
  check('T1 today note habits: has wake', /\bwake\b/.test(habitsLine(today) || ''), habitsLine(today));
  check('T1 #count updated', /^1\/8 habits/.test(await text(p, '#count') || ''), await text(p, '#count'));

  const cell = `.td-hrow[data-id="gym"] .td-cell[data-date="${d2}"]`;
  const lbl = await ev(p, (s) => document.querySelector(s).getAttribute('aria-label'), cell);
  check('T1 gym cell for D-2 has label "Wkd D · not done"', /^[A-Z][a-z]{2} \d{1,2} · not done$/.test(lbl || ''), lbl);
  await tap(p, cell);
  check('T1 gym cell D-2 pressed', await waitFor(p, (s) => document.querySelector(s).getAttribute('aria-pressed') === 'true', 5000, cell));
  check('T1 D-2 note habits: has gym', /\bgym\b/.test(habitsLine(d2) || ''), habitsLine(d2));
  check('T1 cell title says done', /· done$/.test(await ev(p, (s) => document.querySelector(s).title, cell) || ''));

  await tap(p, '.td-hrow[data-id="vitamins"] .td-tick');
  check('T1 vitamins streak shows 3 after ticking today', await waitFor(p, () => document.querySelector('.td-hrow[data-id="vitamins"] .td-streak b').textContent.trim() === '3'), await text(p, '.td-hrow[data-id="vitamins"] .td-streak'));

  // Past day: tick backfills.
  await tap(p, '#td-prev');
  check('T1 stepped back a day', await waitFor(p, () => !document.getElementById('td-back').classList.contains('hidden')));
  check('T1 ticks writable on a past day', await ev(p, () => !document.querySelector('.td-hrow[data-id="outside"] .td-tick').disabled) === true);
  await tap(p, '.td-hrow[data-id="outside"] .td-tick');
  check('T1 past-day tick lands in that note', await waitFor(p, () => document.querySelector('.td-hrow[data-id="outside"] .td-tick').getAttribute('aria-pressed') === 'true')
    && /\boutside\b/.test(habitsLine(londonDate(-1)) || ''), habitsLine(londonDate(-1)));

  check('T1 no horizontal scroll', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth), await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  if (DEFAULTS.phone) {
    const sizes = await ev(p, () => [...document.querySelectorAll('.td-tick')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    const al = await ev(p, () => {
      const L = [...document.querySelectorAll('.td-head .td-dl')];
      const C = [...document.querySelector('.td-hrow[data-id]').querySelectorAll('.td-cell')];
      return { n: L.length, vis: L.every((x) => x.getClientRects().length > 0),
        dx: L.map((x, i) => Math.abs(x.getBoundingClientRect().left - C[i].getBoundingClientRect().left)) };
    });
    check('T1 phone: 7 visible weekday letters aligned over the cells', al && al.n === 7 && al.vis === true && al.dx.every((d) => d <= 3), al);
    check('T1 phone: every .td-tick >= 36px square', Array.isArray(sizes) && sizes.length === 8 && sizes.every(([w, h]) => w >= 36 && h >= 36), sizes);
  }
  await shot(p, `t1-${themeTag()}-${sizeTag()}`);
  await p.close();
  await ctx.close();
};

// T2: tasks card — rolled tag, add / tick / delete write the note, [>] row, stale toggle, phone end-of-page clearance.
const WKD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isoWkd = (iso) => WKD[new Date(iso + 'T00:00:00Z').getUTCDay()];
const fileLines = (date) => { try { return fs.readFileSync(dayFile(date), 'utf8').split('\n'); } catch { return null; } };
SCEN.T2 = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx });
  check('T2 Today painted', await painted(p));
  const today = londonDate(0), d4 = londonDate(-4);
  const rows = () => ev(p, () => [...document.querySelectorAll('#td-tasks .td-trow')].map((r) => r.querySelector('.td-ttext > span').textContent));
  const tags = () => ev(p, () => [...document.querySelectorAll('#td-tasks .td-trow .td-tag')].map((t) => t.textContent));
  check('T2 #td-tasks lists the rolled task', await waitFor(p, () => document.querySelectorAll('#td-tasks .td-trow').length === 1), await rows());
  check(`T2 rolled task tag reads from ${isoWkd(d4)}`, (await tags() || []).includes(`from ${isoWkd(d4)}`), await tags());
  check('T2 #td-side sits right of the habits card on desktop', DEFAULTS.phone ? true : await ev(p, () => {
    const h = document.getElementById('td-habits-card').getBoundingClientRect(), s = document.getElementById('td-side').getBoundingClientRect();
    return s.left > h.right - 1 && Math.abs(s.top - h.top) < 4;
  }) === true);
  await shot(p, `t2-${themeTag()}-${sizeTag()}-before`);

  await tap(p, '#td-task-input');
  await p.keyboard.type('Renew car insurance');
  await p.keyboard.press('Enter');
  check('T2 added row appears', await waitFor(p, () => [...document.querySelectorAll('#td-tasks .td-ttext > span')].some((s) => s.textContent === 'Renew car insurance')), await rows());
  check('T2 input cleared after add', await ev(p, () => document.getElementById('td-task-input').value) === '');
  check('T2 note has "- [ ] Renew car insurance"', (fileLines(today) || []).includes('- [ ] Renew car insurance'), fileLines(today));
  const idx = await ev(p, () => { const r = [...document.querySelectorAll('#td-tasks .td-trow')].find((x) => x.querySelector('.td-ttext > span').textContent === 'Renew car insurance'); return r ? r.dataset.index : null; });
  check('T2 added row has a data-index', idx !== null && /^\d+$/.test(idx), idx);

  await tap(p, `#td-tasks .td-trow[data-index="${idx}"] .td-tchk`);
  check('T2 tick: pressed', await waitFor(p, (i) => document.querySelector(`#td-tasks .td-trow[data-index="${i}"] .td-tchk`).getAttribute('aria-pressed') === 'true', 5000, idx));
  check('T2 note has "- [x] Renew car insurance"', (fileLines(today) || []).includes('- [x] Renew car insurance'), fileLines(today));
  check('T2 tick keeps keyboard focus on the checkbox', await ev(p, (i) => document.activeElement === document.querySelector(`#td-tasks .td-trow[data-index="${i}"] .td-tchk`), idx) === true);

  await tap(p, `#td-tasks .td-trow[data-index="${idx}"] .td-tdel`);
  check('T2 delete: row gone', await waitFor(p, () => ![...document.querySelectorAll('#td-tasks .td-ttext > span')].some((s) => s.textContent === 'Renew car insurance')), await rows());
  check('T2 note no longer has the line', !(fileLines(today) || []).some((l) => l.includes('Renew car insurance')), fileLines(today));

  await tap(p, '#td-prev');
  check('T2 D-1 shows the dentist row as moved', await waitFor(p, () => !!document.querySelector('#td-tasks .td-trow.moved')), await rows());
  check('T2 D-1 dentist tag "moved to next day"', (await tags() || []).includes('moved to next day'), await tags());
  check('T2 D-1 dentist checkbox disabled', await ev(p, () => document.querySelector('#td-tasks .td-trow.moved .td-tchk').disabled) === true);
  check('T2 D-1 shows the done task, ticked', await ev(p, () => !!document.querySelector('#td-tasks .td-trow.done .td-tchk[aria-pressed="true"]')) === true);
  await shot(p, `t2-${themeTag()}-${sizeTag()}-d1`);
  await tap(p, '#td-back');
  check('T2 back on today', await waitFor(p, () => document.getElementById('td-next').dataset.day === 'today' && document.querySelectorAll('#td-tasks .td-trow').length === 1));

  // Stale toggle: the file changes under the page, then the old row is clicked.
  // (The note ends with "## Focus", so a bare append would land outside the Tasks section: add the line inside it.)
  fs.writeFileSync(dayFile(today), fs.readFileSync(dayFile(today), 'utf8')
    .replace(/^(- \[ \] )Book dentist check-up/m, '$1Book optician\n- [ ] Added from another device'));
  await tap(p, '#td-tasks .td-trow .td-tchk');
  const MSG = 'This day changed since you loaded it. Refreshed.';
  check('T2 stale toggle: #td-task-msg shows the 409 text', await waitFor(p, (m) => document.getElementById('td-task-msg').textContent.trim() === m, 5000, MSG), await text(p, '#td-task-msg'));
  check('T2 stale toggle: repainted with the file\'s tasks', await waitFor(p, () => {
    const t = [...document.querySelectorAll('#td-tasks .td-ttext > span')].map((s) => s.textContent);
    return t.includes('Book optician') && t.includes('Added from another device') && !t.includes('Book dentist check-up');
  }), await rows());
  check('T2 stale toggle wrote nothing', !(fileLines(today) || []).some((l) => /^- \[x\]/.test(l) && l.includes('optician')), fileLines(today));
  await shot(p, `t2-${themeTag()}-${sizeTag()}-stale`);
  await tap(p, '#td-task-input');
  await p.keyboard.type('Water plants');
  await p.keyboard.press('Enter');
  check('T2 message clears on the next successful write', await waitFor(p, () => document.getElementById('td-task-msg').textContent.trim() === '' && [...document.querySelectorAll('#td-tasks .td-ttext > span')].some((s) => s.textContent === 'Water plants')), await text(p, '#td-task-msg'));

  // Serialised writes: a rapid double submit and a rapid double click each reach the file once.
  const nLines = (txt) => (fileLines(today) || []).filter((l) => l.includes(txt)).length;
  await ev(p, () => { const i = document.getElementById('td-task-input'); i.value = 'Double submit'; const f = document.getElementById('td-task-form'); f.requestSubmit(); f.requestSubmit(); });
  check('T2 (a) two rapid submits write one line', await waitFor(p, () => [...document.querySelectorAll('#td-tasks .td-ttext > span')].some((s) => s.textContent === 'Double submit')) && nLines('Double submit') === 1, nLines('Double submit'));
  check('T2 (a) input empty and enabled after the add', await waitFor(p, () => { const i = document.getElementById('td-task-input'); return !i.disabled && i.value === ''; }));
  await ev(p, () => { const r = [...document.querySelectorAll('#td-tasks .td-trow')].find((x) => x.querySelector('.td-ttext > span').textContent === 'Double submit'); const b = r.querySelector('.td-tchk'); b.click(); b.click(); });
  check('T2 (b) rapid double click leaves the task ticked in the file', await waitFor(p, () => !document.getElementById('td-task-input').disabled)
    && (fileLines(today) || []).includes('- [x] Double submit'), fileLines(today));
  check('T2 no horizontal scroll', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth), await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  if (DEFAULTS.phone) {
    // The end of the page clears the fixed tab bar.
    const g = await ev(p, () => {
      for (const e of [document.getElementById('today-view'), document.scrollingElement, document.querySelector('main')]) if (e) e.scrollTop = 1e6;
      window.scrollTo(0, 1e6);
      return new Promise((r) => setTimeout(() => r({
        inputBottom: Math.round(document.querySelector('#td-tasks').closest('.td-card').getBoundingClientRect().bottom),
        navTop: Math.round(document.getElementById('mobile-nav').getBoundingClientRect().top),
      }), 300));
    });
    check('T2 phone: after scrolling to the end the last card (tasks) is above the tab bar', g && g.inputBottom <= g.navTop, g);
    check('T2 phone: delete button visible without hover', await ev(p, () => {
      const b = document.querySelector('#td-tasks .td-tdel'); return !!b && getComputedStyle(b.parentElement).opacity === '1';
    }) === true);
  }
  await shot(p, `t2-${themeTag()}-${sizeTag()}`);
  await p.close();
  await ctx.close();
};

// T3: focus card — a session on Read counts down in every mode, survives a reload, logs, auto-ticks Read and
// toasts once per tab; a stale event never toasts; the Focus link and ▶ aim the picker. Preview spm is 1, so a
// session takes 25 s.
const TOAST = 'Read 30m ticked. 50 of 30 minutes today.';
const CHIP = /^(\d{2}):(\d{2}) · Read 30m$/;
const chipSecs = (s) => { const m = /^(\d{2}):(\d{2}) · /.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
// Before each load: record every toast card and chime the page produces, so none is missed between polls.
const recorder = (pg) => pg.evaluateOnNewDocument(() => {
  window.__toasts = [];
  window.__tones = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('tw-toast')) window.__toasts.push(n.textContent);
  }).observe(document, { childList: true, subtree: true });
  // TermToast is a global const from the page's own scripts, there by DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    try { const t = TermToast.tone; TermToast.tone = (k) => { window.__tones.push(k); return t(k); }; } catch { /* not loaded */ }
  });
});
// "Three minutes later" for one tab: its clock and the server's both move on, and its sessionStorage starts empty.
const later = (ms) => (pg) => pg.evaluateOnNewDocument((d) => {
  try { sessionStorage.clear(); } catch { /* no storage */ }
  const now = Date.now.bind(Date);
  Date.now = () => now() + d;
  const get = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await get(...a);
    if (!String(a[0]).includes('/api/today')) return r;
    const j = await r.clone().json().catch(() => null);
    if (!j || typeof j.serverNow !== 'number') return r;
    j.serverNow += d;
    return new Response(JSON.stringify(j), { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}, ms);
const toasted = (p) => ev(p, () => window.__toasts.slice());
const inView = (p, sel) => ev(p, (s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}, sel);
SCEN.T3 = async () => {
  const today = londonDate(0);
  // Seed 25 minutes of Read already logged today. The harness's ready check created the note, which ends with
  // its ## Focus section, so an append lands there; one session then crosses Read's 30-minute goal (25 → 50).
  // Two real sessions can't: at spm 1 both would log the same line in the same minute, which the server drops.
  let note = null;
  try { note = fs.readFileSync(dayFile(today), 'utf8'); } catch { /* checked below */ }
  check('T3 today\'s note ends with its ## Focus section', typeof note === 'string' && /\n## Focus\n*$/.test(note), note);
  fs.appendFileSync(dayFile(today), '- 06:00 25m read\n');

  const ctx = await launch();
  const p = await page('/', { context: ctx, before: recorder });
  check('T3 Today painted', await painted(p));
  check('T3 focus card sits at the top of #td-side', await ev(p, () => document.querySelector('#td-side > :first-child') === document.getElementById('td-focus')) === true);
  const pick = await ev(p, () => {
    const s = document.getElementById('td-target');
    if (!s) return null;
    return { groups: [...s.querySelectorAll('optgroup')].map((g) => g.label), disabled: s.disabled,
      opts: [...s.options].map((o) => [o.value, o.textContent, o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '']) };
  });
  const has = (o) => !!pick && !!pick.opts && pick.opts.some((x) => JSON.stringify(x) === JSON.stringify(o));
  check('T3 picker groups: habits with a time goal, today\'s tasks', !!pick && JSON.stringify(pick.groups) === JSON.stringify(['Habits with a time goal', "Today's tasks"]), pick);
  check('T3 picker: Read 30m (25/30) → read', has(['read', 'Read 30m (25/30)', 'Habits with a time goal']), pick);
  check('T3 picker: only goal habits', !!pick && !!pick.opts && pick.opts.filter((o) => o[2] === 'Habits with a time goal').length === 3, pick);
  check('T3 picker: the open task → task:<text>', has(['task:Book dentist check-up', 'Book dentist check-up', "Today's tasks"]), pick);
  check('T3 picker: last option Just focus → focus', !!pick && !!pick.opts && JSON.stringify(pick.opts[pick.opts.length - 1]) === JSON.stringify(['focus', 'Just focus', '']), pick);
  check('T3 idle: #td-go reads Start, chip hidden, Reset disabled', await ev(p, () => document.getElementById('td-go').textContent.trim() === 'Start'
    && document.getElementById('today-chip').classList.contains('hidden') && document.getElementById('td-reset').disabled) === true);
  check('T3 idle clock reads 00:25 (spm 1)', await text(p, '#td-clock') === '00:25', await text(p, '#td-clock'));
  check('T3 #segTodaySound defaults to on', await ev(p, () => document.querySelector('#segTodaySound button.on').dataset.v) === 'on');
  check('T3 ▶ on today\'s open task, Focus link on goal habits only', await ev(p, () => !!document.querySelector('#td-tasks .td-trow .td-tfocus')
    && document.querySelectorAll('#td-habits .td-hfocus').length === 3 && !document.querySelector('.td-hrow[data-id="wake"] .td-hfocus')) === true);

  // Start a session on Read.
  try { await p.select('#td-target', 'read'); } catch (e) { check('T3 select read in #td-target', false, String(e.message).split('\n')[0]); }
  await tap(p, '#td-go');
  check('T3 Start: #td-go reads Pause', await waitFor(p, () => document.getElementById('td-go').textContent.trim() === 'Pause'), await text(p, '#td-go'));
  check('T3 chip shows mm:ss · Read 30m', await waitFor(p, (re) => {
    const c = document.getElementById('today-chip');
    return !c.classList.contains('hidden') && c.getClientRects().length > 0 && new RegExp(re).test(c.textContent.trim());
  }, 3000, CHIP.source), await text(p, '#today-chip'));
  const s1 = chipSecs(await text(p, '#today-chip'));
  await sleep(1600);
  const s2 = chipSecs(await text(p, '#today-chip'));
  check('T3 chip counts down', s1 !== null && s2 !== null && s2 < s1 && s1 <= 25, [s1, s2]);
  check('T3 #td-clock agrees with the chip', Math.abs(chipSecs(`${await text(p, '#td-clock')} · `) - chipSecs(await text(p, '#today-chip'))) <= 1, [await text(p, '#td-clock'), await text(p, '#today-chip')]);
  check('T3 #td-phase reads Focus', await text(p, '#td-phase') === 'Focus', await text(p, '#td-phase'));
  // Mid-session the server keeps its target, so another choice says it waits for the next session.
  try { await p.select('#td-target', 'business'); } catch { /* checked below */ }
  check('T3 picker changed mid-session: "Applies from the next session."', await visible(p, '#td-fhint') === true);
  try { await p.select('#td-target', 'read'); } catch { /* checked below */ }
  check('T3 picker back on the session\'s target: hint gone', await visible(p, '#td-fhint') === false);
  if (DEFAULTS.phone) await ev(p, () => document.getElementById('td-focus').scrollIntoView({ block: 'center' }));
  await shot(p, `t3-${themeTag()}-${sizeTag()}-running`);

  // Every mode: the chip and the title prefix stay.
  await tap(p, modeBtn('board'));
  check('T3 Board: chip still visible', await waitFor(p, () => document.getElementById('board-view').getClientRects().length > 0
    && document.getElementById('today-chip').getClientRects().length > 0), await text(p, '#today-chip'));
  check('T3 Board: chip still counting', CHIP.test(await text(p, '#today-chip') || ''), await text(p, '#today-chip'));
  check('T3 Board: document.title starts with mm:ss', await waitFor(p, () => /^\d{2}:\d{2} · VaultOS$/.test(document.title), 2000), await ev(p, () => document.title));
  if (DEFAULTS.phone) {
    const tops = await ev(p, () => [...document.querySelector('header').children]
      .filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)));
    check('T3 phone: header with the chip is one row', Array.isArray(tops) && tops.length > 0 && Math.max(...tops) - Math.min(...tops) <= 4, tops);
  }
  check('T3 no horizontal scroll with the chip', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth), await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  await shot(p, `t3-${themeTag()}-${sizeTag()}-board-chip`);

  // Reload in the middle of the session (on Board, so the chip has to come back without Today on screen).
  const before = { t: Date.now(), s: chipSecs(await text(p, '#today-chip')) };
  const reloaded = p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null);
  if (await tap(p, '#refresh')) await reloaded;
  check('T3 reload: back on Board', await waitFor(p, () => !document.getElementById('app').classList.contains('hidden')
    && document.getElementById('mode-board').classList.contains('active'), 8000));
  check('T3 reload: chip back', await waitFor(p, (re) => new RegExp(re).test(document.getElementById('today-chip').textContent.trim())
    && document.getElementById('today-chip').getClientRects().length > 0, 8000, CHIP.source), await text(p, '#today-chip'));
  const after = { t: Date.now(), s: chipSecs(await text(p, '#today-chip')) };
  const want = before.s - (after.t - before.t) / 1000;
  check('T3 reload: countdown continues within ±2 s', before.s !== null && after.s !== null && Math.abs(after.s - want) <= 2, { before, after, want });

  // The chip takes you to Today.
  await tap(p, '#today-chip');
  check('T3 chip click switches to Today', await waitFor(p, () => document.getElementById('mode-today').classList.contains('active')
    && document.getElementById('today-view').getClientRects().length > 0));

  // The session ends: one toast with the server's text, the chime, Read ticked, the log and the file.
  check('T3 toast: Read 30m ticked. 50 of 30 minutes today.', await waitFor(p, (t) => window.__toasts.includes(t), 40000, TOAST), await toasted(p));
  if (DEFAULTS.phone) await ev(p, () => window.scrollTo(0, 0));
  await shot(p, `t3-${themeTag()}-${sizeTag()}-toast`);
  check('T3 toast shown once', (await toasted(p) || []).filter((t) => t === TOAST).length === 1, await toasted(p));
  check('T3 chime: the focus tone played', JSON.stringify(await ev(p, () => window.__tones)) === '["focus"]', await ev(p, () => window.__tones));
  check('T3 Read tick pressed', await waitFor(p, () => document.querySelector('.td-hrow[data-id="read"] .td-tick').getAttribute('aria-pressed') === 'true'));
  const readLines = (fileLines(today) || []).filter((l) => /^- \d{2}:\d{2} 25m read$/.test(l));
  check('T3 file: the session\'s line under the seeded one', readLines.length === 2 && readLines[0] === '- 06:00 25m read', fileLines(today));
  check('T3 file: read ticked in habits', /\bread\b/.test(habitsLine(today) || ''), habitsLine(today));
  const log = await ev(p, () => [...document.querySelectorAll('#td-log li')].map((li) => li.textContent.trim()));
  check('T3 #td-log has both sessions on Read 30m', Array.isArray(log) && log.filter((l) => /Read 30m/.test(l) && /25m$/.test(l)).length === 2, log);
  check('T3 #td-log total 50m · 2 sessions', Array.isArray(log) && log.some((l) => /50m · 2 sessions$/.test(l)), log);
  check('T3 #td-go reads Start break', await waitFor(p, () => document.getElementById('td-go').textContent.trim() === 'Start break'), await text(p, '#td-go'));
  check('T3 #td-target disabled during the break', await ev(p, () => document.getElementById('td-target').disabled) === true);
  check('T3 #td-phase reads Short break', await text(p, '#td-phase') === 'Short break', await text(p, '#td-phase'));
  check('T3 one dot of four on', await ev(p, () => [document.querySelectorAll('#td-dots .on').length, document.querySelectorAll('#td-dots > *').length].join('/')) === '1/4');
  check('T3 chip hidden when idle', await visible(p, '#today-chip') === false);
  check('T3 title restored', await ev(p, () => document.title) === 'VaultOS', await ev(p, () => document.title));
  check('T3 #count: 1/8 habits · 50m focus', await text(p, '#count') === '1/8 habits · 50m focus', await text(p, '#count'));
  check('T3 picker shows today\'s minutes: Read 30m (50/30)', await ev(p, () => [...document.getElementById('td-target').options].some((o) => o.textContent === 'Read 30m (50/30)')) === true);

  // A second tab three minutes later: the event is stale, so no toast.
  const p2 = await page('/', { context: ctx, before: async (pg) => { await recorder(pg); await later(180000)(pg); } });
  check('T3 3 min later: painted', await painted(p2));
  await sleep(2500);
  check('T3 3 min later: no toast', JSON.stringify(await toasted(p2)) === '[]', await toasted(p2));
  check('T3 3 min later: the log still shows the session', /50m · 2 sessions/.test(await text(p2, '#td-log') || ''), await text(p2, '#td-log'));
  await p2.close();
  // The control: a tab opened now gets the toast, once; a reload of that tab doesn't repeat it. Its sound
  // setting is Off, so the toast comes without the chime.
  const quiet = (pg) => pg.evaluateOnNewDocument(() => { try { localStorage.setItem('vaultboard.today.sound', 'off'); } catch { /* no storage */ } });
  const p3 = await page('/', { context: ctx, before: async (pg) => { await recorder(pg); await quiet(pg); } });
  check('T3 another tab now: toast', await painted(p3) && await waitFor(p3, (t) => window.__toasts.includes(t), 5000, TOAST), await toasted(p3));
  check('T3 sound Off: no chime with that toast', JSON.stringify(await ev(p3, () => window.__tones)) === '[]', await ev(p3, () => window.__tones));
  await p3.reload({ waitUntil: 'networkidle2' });
  check('T3 that tab reloaded: painted', await painted(p3));
  await sleep(2500);
  check('T3 that tab reloaded: no second toast', JSON.stringify(await toasted(p3)) === '[]', await toasted(p3));
  await p3.close();
  // Back to the first tab: becoming visible again reloads it (the poll on visibilitychange), so let that land
  // before clicking rows it repaints.
  await p.bringToFront();
  await p.waitForNetworkIdle({ idleTime: 600, timeout: 5000 }).catch(() => {});

  // ▶ on a task and the Focus link on Read aim the picker and bring the focus card into view.
  if (DEFAULTS.phone) check('T3 phone: ▶ visible without hover', await ev(p, () => getComputedStyle(document.querySelector('#td-tasks .td-tfocus').parentElement).opacity) === '1');
  await ev(p, () => window.scrollTo(0, 1e6));
  await tap(p, '#td-tasks .td-trow .td-tfocus');
  check('T3 ▶ sets #td-target to the task', await waitFor(p, () => document.getElementById('td-target').value === 'task:Book dentist check-up'), await ev(p, () => document.getElementById('td-target').value));
  check('T3 ▶ brings the focus card into view', await waitFor(p, () => { const r = document.getElementById('td-focus').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }, 3000), await inView(p, '#td-focus'));
  await ev(p, () => window.scrollTo(0, 0));
  await tap(p, '.td-hrow[data-id="read"] .td-hfocus');
  check('T3 Focus link sets #td-target to read', await waitFor(p, () => document.getElementById('td-target').value === 'read'), await ev(p, () => document.getElementById('td-target').value));
  check('T3 Focus link brings the focus card into view', await waitFor(p, () => { const r = document.getElementById('td-focus').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }, 3000), await inView(p, '#td-focus'));
  await tap(p, '#td-prev');
  check('T3 past day: no Focus link, no ▶', await waitFor(p, () => !document.getElementById('td-back').classList.contains('hidden'))
    && await ev(p, () => !document.querySelector('.td-hfocus') && !document.querySelector('.td-tfocus')) === true);
  await tap(p, '#td-back');
  await waitFor(p, () => document.getElementById('td-next').dataset.day === 'today');

  // The sound setting: Off is stored as 'off', On as 'on'.
  await tap(p, '#setbtn');
  await tap(p, '#ss-nav button[data-sec="look"]');
  check('T3 Settings: Today sound row after Agent sound', await ev(p, () => {
    const r = document.getElementById('segTodaySound').closest('.row');
    return r.previousElementSibling && r.previousElementSibling.contains(document.getElementById('segTermSound'));
  }) === true);
  await tap(p, '#segTodaySound button[data-v="off"]');
  check('T3 sound Off → localStorage off', await ev(p, () => localStorage.getItem('vaultboard.today.sound')) === 'off'
    && await ev(p, () => document.querySelector('#segTodaySound button.on').dataset.v) === 'off');
  await shot(p, `t3-${themeTag()}-${sizeTag()}-settings`);
  await tap(p, '#segTodaySound button[data-v="on"]');
  check('T3 sound On → localStorage on', await ev(p, () => localStorage.getItem('vaultboard.today.sound')) === 'on');
  await tap(p, '#ss-close');
  check('T3 no horizontal scroll', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth), await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  await ev(p, () => document.getElementById('td-focus').scrollIntoView({ block: 'center' }));
  await shot(p, `t3-${themeTag()}-${sizeTag()}`);
  await p.close();
  await ctx.close();
};

// T4: a tab still showing yesterday as "today" never writes to it. The page's Date.now is moved on a day, as if the
// tab had been left open past midnight with no poll getting through: a habit tick or a task add is not sent, the page
// says "New day. Refreshed." and loads today again. (The server's day can't move in the preview, so "the new day" is
// the same date here; what matters is that nothing was written and the page reloaded, once.) A past day stepped to on
// purpose still takes writes, and with the clock back ticks work again. Last, a failed wake-up poll is retried after
// 2 s and then 5 s.
const NEWDAY = 'New day. Refreshed.';
SCEN.T4 = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx });
  check('T4 Today painted', await painted(p));
  const today = londonDate(0), d1 = londonDate(-1);
  const note = (d) => { try { return fs.readFileSync(dayFile(d), 'utf8'); } catch { return null; } };
  // Every app toast, and a Date.now that runs `__skew` days ahead. Each payload takes the clock offset again, so one
  // more day of skew after any payload makes the tab stale.
  await ev(p, () => {
    window.__toastLog = [];
    const t = document.getElementById('toast');
    new MutationObserver(() => window.__toastLog.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    const real = Date.now.bind(Date);
    window.__realNow = real;
    window.__skew = 0;
    Date.now = () => real() + window.__skew * 864e5;
  });
  const sent = [];
  p.on('request', (r) => { if (r.url().includes('/api/today')) sent.push(`${r.method()} ${r.url().replace(BASE, '')}`); });
  const staleClock = () => ev(p, () => { window.__skew += 1; });
  const newDays = async () => ((await ev(p, () => window.__toastLog.slice())) || []).filter((x) => x === NEWDAY).length;
  const settle = () => p.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
  const pressed = (id) => ev(p, (i) => document.querySelector(`.td-hrow[data-id="${i}"] .td-tick`).getAttribute('aria-pressed'), id);

  // (a) A habit tick on a stale "today".
  let before = note(today);
  check('T4 today\'s note exists and wake is not ticked', typeof before === 'string' && !/\bwake\b/.test(habitsLine(today) || ''), habitsLine(today));
  await staleClock();
  sent.length = 0;
  await tap(p, '.td-hrow[data-id="wake"] .td-tick');
  check('T4 stale tick: "New day. Refreshed." shown', await waitFor(p, (m) => window.__toastLog.includes(m), 5000, NEWDAY), await ev(p, () => window.__toastLog));
  await settle();
  await shot(p, `t4-${themeTag()}-${sizeTag()}-newday`);
  check('T4 stale tick: no habit write sent', !sent.some((s) => s.startsWith('POST /api/today/habit')), sent);
  check('T4 stale tick: today\'s note unchanged', note(today) === before);
  check('T4 stale tick: the page reloaded today, once', sent.filter((s) => s === 'GET /api/today').length === 1, sent);
  check('T4 stale tick: wake shows not ticked, card still on Today', await pressed('wake') === 'false' && await ev(p, () => document.getElementById('td-next').dataset.day) === 'today',
    [await pressed('wake'), await ev(p, () => document.getElementById('td-next').dataset.day)]);

  // (b) A task add on a stale "today": not sent, and the typed text stays in the box.
  await staleClock();
  sent.length = 0;
  await tap(p, '#td-task-input');
  await p.keyboard.type('Stale add');
  await p.keyboard.press('Enter');
  check('T4 stale add: "New day. Refreshed." shown again', await waitFor(p, (m) => window.__toastLog.filter((x) => x === m).length === 2, 5000, NEWDAY), await ev(p, () => window.__toastLog));
  await settle();
  check('T4 stale add: no task write sent', !sent.some((s) => s.startsWith('POST /api/today/task')), sent);
  check('T4 stale add: today\'s note unchanged', note(today) === before);
  check('T4 stale add: the page reloaded today, once', sent.filter((s) => s === 'GET /api/today').length === 1, sent);
  check('T4 stale add: the typed text stays in the box', await ev(p, () => document.getElementById('td-task-input').value) === 'Stale add',
    await ev(p, () => document.getElementById('td-task-input').value));

  // (c) A past day stepped to on purpose still takes writes on a stale clock.
  await tap(p, '#td-prev');
  check('T4 stepped back a day', await waitFor(p, () => !document.getElementById('td-back').classList.contains('hidden') && !document.getElementById('td-next').dataset.day === 'today'));
  await settle();
  await staleClock();
  sent.length = 0;
  const pastBefore = habitsLine(d1);
  await tap(p, '.td-hrow[data-id="outside"] .td-tick');
  check('T4 past day on a stale clock: the tick lands in that day\'s note', await waitFor(p, () => document.querySelector('.td-hrow[data-id="outside"] .td-tick').getAttribute('aria-pressed') === 'true')
    && /\boutside\b/.test(habitsLine(d1) || ''), [pastBefore, habitsLine(d1)]);
  check('T4 past day: the write went to that date', sent.some((s) => s.startsWith('POST /api/today/habit')), sent);
  check('T4 past day: no "New day" message', await newDays() === 2, await ev(p, () => window.__toastLog));

  // (d) The clock back to normal: ticks and the task add work again.
  await ev(p, () => { Date.now = window.__realNow; });
  await tap(p, '#td-back');
  check('T4 back on today', await waitFor(p, () => document.getElementById('td-next').dataset.day === 'today'));
  await settle();
  await tap(p, '.td-hrow[data-id="wake"] .td-tick');
  check('T4 clock back: the wake tick shows', await waitFor(p, () => document.querySelector('.td-hrow[data-id="wake"] .td-tick').getAttribute('aria-pressed') === 'true'));
  check('T4 clock back: today\'s note has wake', /\bwake\b/.test(habitsLine(today) || ''), habitsLine(today));
  await tap(p, '#td-task-input');
  await p.keyboard.press('Enter');
  check('T4 clock back: the kept task text adds', await waitFor(p, () => [...document.querySelectorAll('#td-tasks .td-ttext > span')].some((s) => s.textContent === 'Stale add'))
    && (fileLines(today) || []).includes('- [ ] Stale add'), fileLines(today));
  check('T4 no further "New day" message', await newDays() === 2, await ev(p, () => window.__toastLog));
  check('T4 no horizontal scroll', await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth), await ev(p, () => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.close();

  // (e) Waking up: the poll on visibilitychange fails twice, then works. A fresh page, so the 60 s poll stays out of it.
  const w = await page('/', { context: ctx });
  check('T4 wake-up page painted', await painted(w));
  await w.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
  await ev(w, () => {
    const real = window.fetch.bind(window);
    window.__failGets = 2;
    window.__getsAt = [];
    window.fetch = async (u, o) => {
      if (/\/api\/today(\?|$)/.test(String(u)) && !(o && o.method && o.method !== 'GET')) {
        window.__getsAt.push(performance.now());
        if (window.__failGets > 0) { window.__failGets--; throw new TypeError('Failed to fetch'); }
      }
      return real(u, o);
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(9000);
  const at = await ev(w, () => window.__getsAt.slice());
  const gaps = Array.isArray(at) ? at.slice(1).map((t, i) => Math.round(t - at[i])) : at;
  check('T4 wake-up: three tries, 2 s then 5 s apart', Array.isArray(gaps) && gaps.length === 2 && gaps[0] >= 1800 && gaps[0] <= 3000 && gaps[1] >= 4800 && gaps[1] <= 6500, gaps);
  check('T4 wake-up: no error toast for the quiet poll', await ev(w, () => document.getElementById('toast').classList.contains('hidden')) === true);
  await w.close();
  await ctx.close();
};

// T5: a habit tick whose answer comes back after a newer one still shows. The first tick's POST is held back 1.5 s in
// the page, so a second tick is written and painted first and the first answer arrives overtaken; the page fetches the
// day again instead of leaving the first habit looking unticked.
SCEN.T5 = async () => {
  const ctx = await launch();
  const p = await page('/', { context: ctx });
  check('T5 Today painted', await painted(p));
  const today = londonDate(0);
  await ev(p, () => {
    const real = window.fetch.bind(window);
    let held = false;
    window.fetch = async (u, o) => {
      if (!held && String(u).includes('/api/today/habit')) { held = true; await new Promise((r) => setTimeout(r, 1500)); }
      return real(u, o);
    };
  });
  await tap(p, '.td-hrow[data-id="wake"] .td-tick');
  await tap(p, '.td-hrow[data-id="gym"] .td-tick');
  check('T5 the second tick shows first', await waitFor(p, () => document.querySelector('.td-hrow[data-id="gym"] .td-tick').getAttribute('aria-pressed') === 'true', 1400));
  check('T5 the overtaken tick shows too', await waitFor(p, () => ['wake', 'gym'].every((i) => document.querySelector(`.td-hrow[data-id="${i}"] .td-tick`).getAttribute('aria-pressed') === 'true'), 6000),
    await ev(p, () => ['wake', 'gym'].map((i) => document.querySelector(`.td-hrow[data-id="${i}"] .td-tick`).getAttribute('aria-pressed'))));
  check('T5 today\'s note has both', /\bwake\b/.test(habitsLine(today) || '') && /\bgym\b/.test(habitsLine(today) || ''), habitsLine(today));
  check('T5 #count says 2/8', /^2\/8 habits/.test(await text(p, '#count') || ''), await text(p, '#count'));
  await p.close();
  await ctx.close();
};

(async () => {
  if (!NAMES.length) { console.error('usage: node scripts/today-e2e.js [base-url] [--phone] [--theme=dark|sepia] T0 [T1 …]'); process.exit(2); }
  for (const n of NAMES) if (!SCEN[n]) { console.error('unknown scenario: ' + n); process.exit(2); }
  try {
    for (const n of NAMES) {
      console.log(`--- ${n} (${themeTag()}, ${sizeTag()})`);
      const before = startedAt();
      reset();
      const after = startedAt();
      if (!after || after === before) { check(`${n} preview container restarted by reset.sh`, false, { before, after }); continue; }
      const ready = await previewReady();
      if (!ready.ok) { check(`${n} preview serves /api/tasks and /api/today after reset`, false, ready.last); continue; }
      await SCEN[n]();
    }
  } finally {
    if (browser) await browser.close();
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
