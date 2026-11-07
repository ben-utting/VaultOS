'use strict';
// The made-up demo vault behind the README pictures, shared by readme-shots.js (stills) and readme-loops.js
// (animated loops). setup() resets the portable preview (127.0.0.1:7692) to a blank install, runs setup through its
// API and seeds a "Pocket Recipes" side project, a small Home board and a week of Today habits. Nothing personal goes
// in: every name, date and line of text below is invented, and dates are relative to today so the board never looks
// stale. Only ever point it at the portable preview; it wipes that preview's vault.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:7692';
const PREVIEW = '/opt/vault/portable-preview';
const VAULT = path.join(PREVIEW, 'vault');
const OUT = path.join(__dirname, '..', 'docs', 'images');
const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const PASSWORD = 'readme-demo-password';
const TERM_WHERE_KEY = 'vaultboard.term.where';   // public/workbench.js
const TZ = 'Europe/London';
const HIDDEN_COLUMNS = ['needs-decision', 'scheduled'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Node 18's fetch can hang without holding the event loop right after the container starts; a ref'd timer ends it.
async function call(method, url, { cookie, body } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(BASE + url, {
      method, signal: ac.signal,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, res };
  } finally { clearTimeout(t); }
}
async function must(method, url, opts) {
  const r = await call(method, url, opts);
  if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${r.text.slice(0, 200)}`);
  return r;
}

// ---------- dates ----------
const zoned = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = zoned(new Date());
const day = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- demo content ----------
function task({ id, title, area, status, priority = 'med', created, updated, extra = {}, goal, plan, log, findings = '' }) {
  const fm = {
    type: 'task', id, aliases: `["${id}"]`, title: `"${title}"`, area, status, priority, owner: '',
    created, updated, blocked_by: '', review_note: '', scheduled_for: '', decision_note: '', batch: '', host: '', ...extra,
  };
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v === '' ? '""' : v}`).join('\n');
  return `---\n${head}\n---\n\n## Goal\n${goal}\n\n## Context / key facts\n- Part of the Pocket Recipes launch.\n\n## Plan\n${plan.map(([done, s]) => `- [${done ? 'x' : ' '}] ${s}`).join('\n')}\n\n## Progress log\n${log.map(([d, s]) => `- ${d} — ${s}`).join('\n')}\n\n## Findings / decisions\n${findings || '_None yet._'}\n`;
}

function article({ title, area, stack, job, created, tldr, body }) {
  return `---\ntype: article\ntitle: "${title}"\narea: ${area}\nstack: [${stack.join(', ')}]\ntickets: ""\njob: "${job}"\nstatus: published\ncreated: ${created}\nupdated: ${created}\n---\n\n> **TL;DR** — ${tldr}\n\n${body}\n`;
}

function sideProject(dir) {
  const f = {};
  const T = (rel, o) => { f[`${dir}/${rel}/task.md`] = task(o); };
  T('1. launch/01-landing-page', {
    id: 'landing-page', title: 'Launch — landing page', area: 'web', status: 'in-progress', priority: 'high',
    created: day(-9), updated: day(0),
    goal: 'A one-page site that explains Pocket Recipes in ten seconds and collects waitlist emails.',
    plan: [[1, 'Write the headline and three feature blurbs'], [1, 'Hero screenshot from the app'], [1, 'Waitlist form wired to the mailing list'], [0, 'Lighthouse score above 95'], [0, 'Publish behind the real domain']],
    log: [[day(0), 'Form posts to the list; double opt-in confirmed with a test address.'], [day(-2), 'Hero image and copy in. Mobile layout reviewed.'], [day(-9), 'Created.']],
    findings: '- The form needs a honeypot field; bots found the staging copy within a day.',
  });
  T('1. launch/02-pricing-page', {
    id: 'pricing-page', title: 'Launch — pricing page', area: 'web', status: 'in-progress', priority: 'high',
    created: day(-6), updated: day(-1),
    goal: 'A pricing page that matches how we actually want to charge.',
    plan: [[1, 'Draft both options'], [0, 'Pick one'], [0, 'Build the page']],
    log: [[day(-1), 'Both drafts written: a free tier, and a 14-day trial.'], [day(-6), 'Created.']],
  });
  T('1. launch/03-waitlist-email', {
    id: 'waitlist-email', title: 'Launch — welcome email', area: 'email', status: 'backlog',
    created: day(-5), updated: day(-3),
    goal: 'The first email every waitlist sign-up gets.',
    plan: [[0, 'Write it'], [0, 'Send a test to three friends']],
    log: [[day(-3), 'Waits for the landing page to ship.'], [day(-5), 'Created.']],
  });
  T('1. launch/04-domain-and-dns', {
    id: 'domain-dns', title: 'Launch — domain and DNS', area: 'infra', status: 'done',
    created: day(-14), updated: day(-8),
    goal: 'The domain points at the server with HTTPS and email records in place.',
    plan: [[1, 'Buy the domain'], [1, 'A and AAAA records'], [1, 'SPF, DKIM and DMARC'], [1, 'HTTPS with automatic renewal']],
    log: [[day(-8), 'Done. Mail-tester score 10/10.'], [day(-14), 'Created.']],
  });
  f[`${dir}/1. launch/04-domain-and-dns/article.md`] = article({
    title: 'Domain, DNS and email records', area: 'infra', stack: ['DNS', 'Caddy', 'SPF/DKIM'],
    job: `${dir}/1. launch/04-domain-and-dns/task.md`, created: day(-8),
    tldr: 'The domain now serves the site over HTTPS, renewing on its own, and mail from it lands in inboxes rather than spam.',
    body: `## Stack\nCaddy in front of the app handles certificates. DNS is at the registrar.\n\n## Glossary\n- **SPF** (Sender Policy Framework): which servers may send mail for the domain.\n- **DKIM** (DomainKeys Identified Mail): a signature on each message, checked against a DNS key.\n- **DMARC**: what receivers should do when SPF or DKIM fail.\n\n## Situation & goal\nWe had a domain and nothing on it. Done meant the landing page on HTTPS and sign-up emails that arrive.\n\n## What I did\n1. Pointed the A and AAAA records at the server.\n2. Let Caddy fetch the certificate:\n\n\`\`\`\npocketrecipes.example {\n  reverse_proxy app:3000\n}\n\`\`\`\n\n3. Added SPF, DKIM and a \`p=quarantine\` DMARC record from the mail provider's setup page.\n\n## Key decisions\n- **DMARC starts at quarantine**, not reject, for the first month, so a mistake costs a spam-folder email rather than a lost one.\n\n## Related\n- [[${dir}/2. app/05-postgres-backups/article|Nightly Postgres backups]]`,
  });
  T('2. app/01-fix-login-redirect', {
    id: 'login-redirect', title: 'App — login redirect loop', area: 'auth', status: 'review', priority: 'high',
    created: day(-4), updated: day(-1), extra: { review_note: '"Check on Safari and the iOS home-screen app"' },
    goal: 'Signing in on a second device no longer bounces between /login and /home.',
    plan: [[1, 'Reproduce with two browsers'], [1, 'Fix the stale session cookie'], [0, 'Test on Safari']],
    log: [[day(-1), 'Fix deployed to staging.'], [day(-4), 'Created.']],
    findings: '- The old cookie was scoped to `www.`, the new one to the bare domain; both were sent.',
  });
  T('2. app/02-offline-mode', {
    id: 'offline-mode', title: 'App — offline recipes', area: 'app', status: 'backlog',
    created: day(-10), updated: day(-10),
    goal: 'Saved recipes open with no signal, in the kitchen.',
    plan: [[0, 'Service worker caching'], [0, 'Sync when back online']], log: [[day(-10), 'Created.']],
  });
  T('2. app/03-image-uploads', {
    id: 'image-uploads', title: 'App — photo uploads', area: 'app', status: 'blocked',
    created: day(-7), updated: day(-2), extra: { blocked_by: '"Storage bucket quota increase"' },
    goal: 'Add a photo to a recipe from the phone camera.',
    plan: [[1, 'Resize on the client'], [0, 'Upload to the bucket']],
    log: [[day(-2), 'Blocked: the bucket is at its quota. Request sent.'], [day(-7), 'Created.']],
  });
  T('2. app/04-search', {
    id: 'search', title: 'App — search by ingredient', area: 'app', status: 'backlog', priority: 'low',
    created: day(-10), updated: day(-10),
    goal: 'Type "leek" and see everything with leeks in it.',
    plan: [[0, 'Postgres full-text index']], log: [[day(-10), 'Created.']],
  });
  T('2. app/05-postgres-backups', {
    id: 'pg-backups', title: 'App — nightly Postgres backups', area: 'infra', status: 'done',
    created: day(-12), updated: day(-5),
    goal: 'A nightly, tested, off-site backup of the database.',
    plan: [[1, 'pg_dump at 02:00'], [1, 'Encrypted copy off-site'], [1, 'Restore test']],
    log: [[day(-5), 'Restore test passed in 40 s.'], [day(-12), 'Created.']],
  });
  f[`${dir}/2. app/05-postgres-backups/article.md`] = article({
    title: 'Nightly Postgres backups', area: 'infra', stack: ['Postgres', 'restic', 'cron'],
    job: `${dir}/2. app/05-postgres-backups/task.md`, created: day(-5),
    tldr: 'The database is dumped every night at 02:00, encrypted and copied off-site, and a restore has been tested end to end.',
    body: `## Stack\nPostgres 16, restic for encrypted off-site copies, cron to run it.\n\n## Glossary\n- **pg_dump**: Postgres's own export tool; one consistent snapshot while the app keeps running.\n- **restic**: encrypted, de-duplicated backups to any storage.\n\n## Situation & goal\nNo backups existed. Done meant a nightly copy we had actually restored from.\n\n## What I did\n\`\`\`\n0 2 * * *  pg_dump -Fc recipes > /backups/recipes.dump && restic backup /backups\n\`\`\`\n\nThen restored last night's dump into a scratch database and ran the app against it.\n\n## Key decisions\n- **Keep 7 daily and 4 weekly copies.** Enough to undo a bad migration noticed late.\n\n## Related\n- [[${dir}/1. launch/04-domain-and-dns/article|Domain, DNS and email records]]`,
  });
  T('2. app/06-dark-mode', {
    id: 'dark-mode', title: 'App — dark mode', area: 'app', status: 'in-progress',
    created: day(-3), updated: day(0),
    goal: 'The app follows the phone\'s light or dark setting.',
    plan: [[1, 'Colour tokens'], [0, 'Swap on prefers-color-scheme'], [0, 'Check contrast']],
    log: [[day(0), 'Tokens in; half the screens converted.'], [day(-3), 'Created.']],
  });
  T('1. launch/05-pick-a-name', {
    id: 'name', title: 'Launch — pick a name', area: 'brand', status: 'done',
    created: day(-20), updated: day(-16), goal: 'A name that is short, sayable and has a free domain.',
    plan: [[1, 'Long list'], [1, 'Check domains'], [1, 'Decide']], log: [[day(-16), 'Pocket Recipes it is.']],
  });
  T('2. app/07-repo-and-ci', {
    id: 'repo-ci', title: 'App — repo and CI', area: 'infra', status: 'done',
    created: day(-18), updated: day(-11), goal: 'Every push runs the tests; main deploys itself.',
    plan: [[1, 'Repo'], [1, 'Test workflow'], [1, 'Deploy on main']], log: [[day(-11), 'Green builds on every push.']],
  });
  T('2. app/08-share-a-recipe', {
    id: 'share', title: 'App — share a recipe link', area: 'app', status: 'blocked',
    created: day(-2), updated: day(-2), extra: { blocked_by: '"Needs the public page design"' }, goal: 'Send a recipe to a friend who has no account.',
    plan: [[0, 'Public read-only page'], [0, 'Link preview image']], log: [[day(-2), 'Created.']],
  });
  T('2. app/09-shopping-list', {
    id: 'shopping-list', title: 'App — shopping list from a recipe', area: 'app', status: 'backlog',
    created: day(-1), updated: day(-1), goal: 'One tap adds a recipe\'s ingredients to a list.',
    plan: [[0, 'Merge duplicate ingredients'], [0, 'Tick off in the shop']], log: [[day(-1), 'Created.']],
  });
  return f;
}

function home(dir) {
  const f = {};
  const T = (rel, o) => { f[`${dir}/${rel}/task.md`] = task(o); };
  T('1. house/01-plan-the-garden', {
    id: 'garden', title: 'Plan the spring garden', area: 'garden', status: 'in-progress',
    created: day(-6), updated: day(-1), goal: 'Know what goes where before the bulbs arrive.',
    plan: [[1, 'Measure the beds'], [0, 'Order bulbs']], log: [[day(-1), 'Beds measured.']],
  });
  T('1. house/02-renew-passport', {
    id: 'passport', title: 'Renew passport', area: 'admin', status: 'scheduled',
    created: day(-4), updated: day(-4), extra: { scheduled_for: day(10) }, goal: 'New passport before the trip.',
    plan: [[0, 'Photo'], [0, 'Apply online']], log: [[day(-4), 'Created.']],
  });
  T('1. house/03-fix-the-bike', {
    id: 'bike', title: 'Fix the bike brakes', area: 'bike', status: 'backlog', priority: 'low',
    created: day(-8), updated: day(-8), goal: 'Brakes that stop the bike.', plan: [[0, 'New pads']], log: [[day(-8), 'Created.']],
  });
  return f;
}

function todayDays(dir) {
  const f = {};
  const pattern = [['move', 'read', 'water', 'plan'], ['move', 'water'], ['read', 'learn', 'water', 'plan'], ['move', 'read', 'learn', 'water', 'plan'], ['water'], ['move', 'read', 'water', 'plan']];
  for (let i = 6; i >= 1; i--) {
    const d = day(-i);
    f[`${dir}/days/${d.slice(0, 7)}/${d}.md`] = `---\ndate: ${d}\nhabits: [${pattern[6 - i].join(', ')}]\n---\n\n## Tasks\n\n## Focus\n- 09:00 25m read\n- 14:30 25m Just focus\n\n`;
  }
  f[`${dir}/days/${TODAY.slice(0, 7)}/${TODAY}.md`] = `---\ndate: ${TODAY}\nhabits: [move, water]\n---\n\n## Quote\n> Well begun is half done.\n> — Aristotle\n\n## Tasks\n- [x] Reply to the beta testers\n- [x] Book the dentist\n- [ ] Finish the landing page form\n- [ ] Water the tomatoes\n\n## Focus\n- 08:40 25m read\n- 09:20 25m Just focus\n\n`;
  return f;
}

function write(files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(VAULT, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  execFileSync('chown', ['-R', '1000:1000', VAULT]);
}

// ---------- setup ----------
async function setup() {
  console.log('--- reset the preview');
  execFileSync('bash', [path.join(PREVIEW, 'reset.sh')], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    const r = await call('GET', '/api/setup/state').catch(() => null);
    if (r && r.status === 200 && r.body && r.body.stage === 'full' && r.body.windowOpen) break;
    if (i > 60) throw new Error('preview never came up as a blank install');
    await sleep(500);
  }
  await must('POST', '/api/setup/password', { body: { password: PASSWORD } });
  const login = await must('POST', '/api/login', { body: { password: PASSWORD } });
  const cookie = login.res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  await must('POST', '/api/setup/boards', { cookie, body: { labels: ['Side Project', 'Home'], timezone: TZ } });
  await must('POST', '/api/setup/finish', { cookie, body: { today: true } });
  // A default agent, so the card shows Start agent (with Claude Code's mark) as it does on a real install.
  await must('POST', '/api/settings/agent', { cookie, body: { profile: 'claude' } });
  const settings = JSON.parse(fs.readFileSync(path.join(VAULT, '.vaultos', 'settings.json'), 'utf8'));
  const [sp, hm] = settings.boards;
  // The welcome card is for real first runs; the demo board starts with the side project.
  fs.rmSync(path.join(VAULT, sp.dir, '1. getting-started'), { recursive: true, force: true });
  write({ ...sideProject(sp.dir), ...home(hm.dir), ...todayDays(settings.today.dir) });
  await must('GET', '/api/today', { cookie });   // creates habits.md and settles today's note
  // Files' "Changed recently" should lead with board work, not the Today notes just written.
  await sleep(1100);
  const now = Date.now() / 1000;
  Object.keys(sideProject(sp.dir)).forEach((rel, i) => {
    const t = now - i * 600;
    fs.utimesSync(path.join(VAULT, ...rel.split('/')), t, t);
  });
  return { cookie, sp, hm };
}

// ---------- pages ----------
// A page signed in to the demo vault, in one theme, on the side project's board, with the fonts a reader's desktop
// would show. Each caller gives its own browser context so nothing carries from one picture into the next.
async function openPage(ctx, view, { theme, cookie, sp }) {
  const page = await ctx.newPage();
  await page.setViewport(view);
  await page.emulateTimezone(TZ);
  for (const kv of cookie.split('; ')) {
    const i = kv.indexOf('=');
    await page.setCookie({ name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE });
  }
  await page.evaluateOnNewDocument((t, ws, whereKey, hidden) => {
    localStorage.setItem('vaultboard.theme', t);
    localStorage.setItem('vaultboard.font', 'system');
    localStorage.setItem('vaultboard.workspace', ws);
    localStorage.setItem(`vaultboard.hiddenColumns.${ws}`, JSON.stringify(hidden));   // Done shows; the two least-used columns don't
    localStorage.setItem(whereKey, JSON.stringify('dock'));        // terminals in the docked panel, not a pop-out
    localStorage.setItem('vaultboard.term.h', JSON.stringify(330));
  }, theme, sp.key, TERM_WHERE_KEY, HIDDEN_COLUMNS);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#board .card');
  // This box only has DejaVu Sans, which no reader's desktop shows. Roboto is in VaultOS's own font list and is
  // close to Segoe UI and SF, so the pictures look like the app does on a real machine.
  await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=block' });
  await page.addStyleTag({ content: ':root { --ui-font: Roboto, sans-serif !important; }' });
  await page.evaluate(async () => {
    await Promise.all(['400 14px Roboto', '600 14px Roboto', '700 14px Roboto'].map((f) => document.fonts.load(f)));
  });
  return page;
}

// The logo and headings use Space Grotesk; wait until it has loaded, or the picture shows the fallback face.
async function fontsReady(page) {
  await page.evaluate(async () => { await document.fonts.load('600 15px "Space Grotesk"'); await document.fonts.ready; });
}

const mode = async (page, m) => { await page.click(`#mode-${m}`); await sleep(900); };

module.exports = { BASE, VAULT, OUT, PUPPETEER, CHROME, TZ, sleep, call, must, task, write, setup, openPage, fontsReady, mode };
