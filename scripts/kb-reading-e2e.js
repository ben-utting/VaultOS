'use strict';
// Browser scenarios for KB reading history and the morning read, driven with puppeteer against the KB
// preview container (kb-preview, 127.0.0.1:7693) — never the live board (:7684; it holds real history).
//
//   node scripts/kb-reading-e2e.js [--phone] [--theme=dark|sepia] K1 [K2 …]
//
// Each scenario first resets the preview (synthetic vault from scripts/kb-sandbox.js, Today's zone at 08:00 so
// the morning window is open, container restarted) and waits for a signed-in /api/kb. The session cookie comes
// from the preview's mint-cookie.js and is never printed. Every check prints a PASS/FAIL line; the exit code is
// 1 when any check failed, 2 on bad usage. Screenshots go to /tmp/kb-shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PREVIEW = '/opt/vault/kb-preview';
const CONTAINER = 'kb-preview';
const BASE = 'http://127.0.0.1:7693';
const SHOTS = '/tmp/kb-shots';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DAY = 86400000;

const LONG = 'Personal/1. apps/01-long-read/article.md';
const SHORT = 'Personal/1. apps/02-short-note/article.md';
const MOVED = 'Personal/1. apps/_done/03-moved-job/article.md';
const DRAFT = 'Personal/2. platform/04-draft-idea/article.md';

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

// The API as a signed-in session, from outside the page.
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { Cookie: mintCookie(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const articleState = async (p, ws = 'personal') => (await api('GET', `/api/kb?ws=${ws}`)).body.articles.find((a) => a.path === p);
// Answers the day's morning card through the API, for scenarios about something else.
async function dismissMorning() {
  await api('GET', '/api/kb/morning?ws=personal');
  await api('POST', '/api/kb/morning', { action: 'later' });
}
const readsOnDisk = () => JSON.parse(fs.readFileSync(path.join(PREVIEW, 'vault/.vaultos/kb-reads.json'), 'utf8'));

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
// A page in a fresh context (or the given one), opened on `workspace`. `before(pg)` runs ahead of the first load.
async function page({ phone = DEFAULTS.phone, theme = DEFAULTS.theme, workspace = 'personal', context, before } = {}) {
  const ctx = context || await launch();
  const pg = await ctx.newPage();
  await pg.setViewport(phone ? PHONE : DESKTOP);
  await pg.evaluateOnNewDocument((t, w) => {
    try { localStorage.setItem('vaultboard.theme', t); localStorage.setItem('vaultboard.workspace', w); } catch {}
  }, theme, workspace);
  if (before) await before(pg);
  pg.on('pageerror', (e) => console.log(`  [pageerror] ${String(e.message).split('\n')[0]}`));
  await pg.goto(BASE + '/', { waitUntil: 'networkidle2' });
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
  await p.screenshot({ path: path.join(SHOTS, `${name}-${DEFAULTS.phone ? 'phone' : 'desktop'}-${DEFAULTS.theme === 'light' ? 'sepia' : 'dark'}.png`) });
}
const text = (p, sel) => ev(p, (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
const modeBtn = (mode) => (DEFAULTS.phone ? `#mobile-nav button[data-for="mode-${mode}"]` : `#mode-${mode}`);
const cardSel = (p) => `#kb-reader .kb-card[data-path="${p}"]`;

async function toKB(p) {
  await tap(p, modeBtn('kb'));
  return waitFor(p, () => document.querySelectorAll('#kb-reader .kb-col-picks .kb-card').length > 0, 8000);
}
async function openFromDash(p, articlePath) {
  if (!await tap(p, cardSel(articlePath))) return false;
  return waitFor(p, () => !!document.getElementById('kb-readline'), 5000);
}
async function back(p) {
  await tap(p, '#kb-back');
  return waitFor(p, () => document.querySelectorAll('#kb-reader .kb-col-picks .kb-card').length > 0, 5000);
}

const cardShown = (p) => waitFor(p, () => { const c = document.getElementById('km-card'); return !!c && !c.classList.contains('hidden'); }, 8000);
const cardHidden = (p) => waitFor(p, () => { const c = document.getElementById('km-card'); return !!c && c.classList.contains('hidden'); }, 3000);
const cardText = (p) => ev(p, () => Object.fromEntries(['eyebrow', 'title', 'excerpt', 'meta', 'reason']
  .map((k) => [k, document.getElementById(`km-${k}`).textContent.trim()])));

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
      const r = await fetch(BASE + '/api/kb?ws=personal', { headers: { Cookie: mintCookie() } });
      if (r.status === 200) return { ok: true };
      last = `${r.status} ${(await r.text()).slice(0, 80)}`;
    } catch (e) { last = String(e.message); }
    await sleep(250);
  }
  return { ok: false, last };
}

const SCEN = {
  // K1: a read counts when the article was read — its end scrolled into view, or enough time on screen —
  // and never for a peek.
  async K1() {
    await dismissMorning();
    const p = await page();
    check('K1 KB dashboard loads', await toKB(p));
    check('K1 open the short draft', await openFromDash(p, DRAFT));
    await sleep(2000);
    await tap(p, modeBtn('board'));
    await sleep(1000);
    await tap(p, modeBtn('kb'));
    await sleep(2000);
    check('K1 a trip to Board and back is still a peek', (await articleState(DRAFT)).lastRead === null, await articleState(DRAFT));
    await sleep(1000);
    check('K1 back to the dashboard', await back(p));
    check('K1 a 3 s peek at a one-screen article is not a read', (await articleState(DRAFT)).lastRead === null, await articleState(DRAFT));
    check('K1 reopen the short draft', await openFromDash(p, DRAFT));
    await sleep(32000);
    const draft = await articleState(DRAFT);
    check('K1 32 s on screen counts as a read', typeof draft.lastRead === 'number', draft);
    check('K1 the reader says it was read today', (await text(p, '#kb-readline')) === '1 min read · Read today', await text(p, '#kb-readline'));
    check('K1 back again', await back(p));
    check('K1 open the long read', await openFromDash(p, LONG));
    await sleep(2000);
    check('K1 2 s at the top of a long article is not a read', (await articleState(LONG)).lastRead === null);
    await ev(p, () => document.querySelector('.kb-read-end').scrollIntoView({ block: 'end' }));
    let long;
    for (let i = 0; i < 30 && !(long && long.lastRead); i++) { await sleep(100); long = await articleState(LONG); }
    check('K1 reaching the end of a long article counts within 3 s', typeof long.lastRead === 'number', long);
    await p.close();
  },

  // K2: the dashboard runs off the server's history: unread count, the picks' order and labels, the reader's line.
  async K2() {
    await dismissMorning();
    const p = await page();
    check('K2 KB dashboard loads', await toKB(p));
    const dash = await ev(p, () => ({
      unread: [...document.querySelectorAll('.kb-stat')].find((s) => /unread/i.test(s.textContent))?.querySelector('b').textContent,
      picks: [...document.querySelectorAll('.kb-col-picks .kb-card')].map((c) => [c.querySelector('h3').textContent, c.querySelector('.kb-meta-right').textContent.trim()]),
    }));
    check('K2 unread counts the never-read articles', dash.unread === '2', dash.unread);
    check('K2 picks: updated since read, then unread newest first', JSON.stringify(dash.picks) === JSON.stringify([
      ['Short note', 'Updated since you read it'], ['Long read', 'Not read yet'], ['Draft idea', 'Not read yet'],
    ]), dash.picks);
    await sleep(900);   // past the dashboard's entrance fade
    await shot(p, 'K2-dashboard');
    check('K2 open the moved job', await openFromDash(p, MOVED));
    check('K2 its history survived the move', (await text(p, '#kb-readline')) === '1 min read · Read 1 month ago', await text(p, '#kb-readline'));
    await shot(p, 'K2-reader');
    await p.close();
  },

  // K3: the card shows once, on load, laid out inside the screen; Not today ends it on every device.
  async K3() {
    const p = await page();
    check('K3 the morning card shows on load', await cardShown(p));
    const c = await cardText(p);
    check('K3 eyebrow', c.eyebrow === 'Morning read · 1 min', c.eyebrow);
    check('K3 title', c.title === 'Short note', c.title);
    check('K3 reason', c.reason === 'Updated since you read it', c.reason);
    check('K3 workspace and collection', c.meta === 'Personal · apps', c.meta);
    check('K3 excerpt without its TL;DR label', c.excerpt === 'A note short enough to fit on one screen.', c.excerpt);
    check('K3 inside the viewport', await ev(p, () => {
      const r = document.getElementById('km-card').getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }));
    check('K3 focus on Read now', (await ev(p, () => document.activeElement && document.activeElement.id)) === 'km-read');
    await shot(p, 'K3-card');
    await tap(p, '#km-later');
    check('K3 Not today closes it', await cardHidden(p));
    check('K3 the server has no card for today now', (await api('GET', '/api/kb/morning?ws=personal')).body.card === null);
    await p.close();
    const q = await page();
    await sleep(3000);
    check('K3 another browser gets no card', (await ev(q, () => document.getElementById('km-card').classList.contains('hidden'))) === true);
    await q.close();
  },

  // K4: the day's pick follows you to a device open on another workspace; Read now switches and opens it.
  // K4b: if another device answered first (409), Read now still opens the article, with no toast.
  async K4() {
    await api('GET', '/api/kb/morning?ws=personal');
    const p = await page({ workspace: 'sucden' });
    check('K4 the card shows on a Sucden page', await cardShown(p));
    const c = await cardText(p);
    check('K4 it is the Personal pick', c.title === 'Short note' && c.meta === 'Personal · apps', c);
    await shot(p, 'K4-card');
    await tap(p, '#km-read');
    check('K4 Read now switches workspace and opens the article', await waitFor(p, () => STATE.workspace === 'personal' && STATE.mode === 'kb'
      && (document.querySelector('#kb-reader .kb-article h1') || {}).textContent === 'Short note', 8000));
    check('K4 the card is gone', await cardHidden(p));
    await p.close();

    reset();
    check('K4b preview back after reset', (await previewReady()).ok);
    const q = await page();
    check('K4b the card shows', await cardShown(q));
    check('K4b another device answers first', (await api('POST', '/api/kb/morning', { action: 'later' })).status === 200);
    await tap(q, '#km-read');
    check('K4b Read now still opens the article', await waitFor(q, () => STATE.mode === 'kb'
      && (document.querySelector('#kb-reader .kb-article h1') || {}).textContent === 'Short note', 8000));
    check('K4b no toast for the 409', (await ev(q, () => document.getElementById('toast').classList.contains('hidden'))) === true);
    await q.close();
  },

  // K5: Skip this one keeps the article out of the morning read for 90 days.
  async K5() {
    const p = await page();
    check('K5 the card shows', await cardShown(p));
    await tap(p, '#km-skip');
    check('K5 Skip this one closes it', await cardHidden(p));
    await sleep(300);
    const entry = readsOnDisk().articles.personal['02-short-note'];
    check('K5 skipped for 90 days', Math.abs(entry.skipUntil - (Date.now() + 90 * DAY)) < 60000, entry);
    await p.close();
  },

  // K7: the card waits behind Settings (or any overlay) and comes up at the next check; Escape is Not today.
  async K7() {
    const p = await page({ workspace: 'business' });
    await sleep(3000);
    check('K7 nothing to read on Business: no card', (await ev(p, () => document.getElementById('km-card').classList.contains('hidden'))) === true);
    await ev(p, () => openSheet());
    await ev(p, () => setWorkspace('personal'));
    await sleep(3000);
    check('K7 no card while Settings is open', (await ev(p, () => document.getElementById('km-card').classList.contains('hidden'))) === true);
    await ev(p, () => { closeSheet(); document.dispatchEvent(new Event('visibilitychange')); });
    check('K7 the card shows at the next check', await cardShown(p));
    await p.keyboard.press('Escape');
    check('K7 Escape closes it', await cardHidden(p));
    check('K7 Escape counted as Not today', (await api('GET', '/api/kb/morning?ws=personal')).body.card === null);
    await p.close();
  },

  // K6: a browser's old localStorage history goes to the server once, then the local copy is gone.
  async K6() {
    await dismissMorning();
    const when = Date.now() - 2 * DAY;
    const p = await page({
      before: (pg) => pg.evaluateOnNewDocument((k, t) => {
        if (!sessionStorage.getItem('seeded')) { localStorage.setItem('vaultboard.kbReads', JSON.stringify({ [k]: t })); sessionStorage.setItem('seeded', '1'); }
      }, LONG, when),
    });
    check('K6 the local history is removed after the import', await waitFor(p, () => localStorage.getItem('vaultboard.kbReads') === null, 8000));
    const long = await articleState(LONG);
    check('K6 the server holds the imported read', long.lastRead === when, long);
    await p.close();
  },
};

(async () => {
  if (!NAMES.length) { console.error('usage: node scripts/kb-reading-e2e.js [--phone] [--theme=dark|sepia] K1 [K2 …]'); process.exit(2); }
  for (const n of NAMES) if (!SCEN[n]) { console.error('unknown scenario: ' + n); process.exit(2); }
  try {
    for (const n of NAMES) {
      console.log(`--- ${n} (${DEFAULTS.theme === 'light' ? 'sepia' : 'dark'}, ${DEFAULTS.phone ? 'phone' : 'desktop'})`);
      const before = startedAt();
      reset();
      const after = startedAt();
      if (!after || after === before) { check(`${n} preview container restarted by reset.sh`, false, { before, after }); continue; }
      const ready = await previewReady();
      if (!ready.ok) { check(`${n} preview serves /api/kb after reset`, false, ready.last); continue; }
      await SCEN[n]();
    }
  } finally {
    if (browser) await browser.close();
  }
  if (failures) for (const f of failed) console.log(`  failed: ${f}`);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
