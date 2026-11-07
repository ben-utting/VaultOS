'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { zoneAtHour } = require('./helpers/zone');
const { writePassword } = require('../lib/password');
const { zonedDate } = require('../lib/today-note');

const PASSWORD = 'correct horse';
const DAY = 86400000;
const art = (title, updated) => `---\ntype: article\ntitle: "${title}"\nupdated: ${updated}\n---\n\n> **TL;DR** About ${title}.\n\nBody of ${title}.\n`;
const NEW = 'Personal/1. a/01-new/article.md';
const board = '---\n\nkanban-plugin: board\n\n---\n';

// The server's clock is real; the zone puts "now" inside (08:00) or outside (15:00) the window.
async function morningServer(t, { hour = 8, morningRead = true, reads, env, cookie = true } = {}) {
  const tz = zoneAtHour(hour);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-kbmorning-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [
        { key: 'personal', dir: 'Personal', label: 'Personal', hidden: false },
        { key: 'work', dir: 'Work', label: 'Work', hidden: false },
        { key: 'business', dir: 'Business', label: 'Business', hidden: false },
      ],
      features: { today: false, morningRead }, today: { dir: 'Personal/Today', timezone: tz },
    }),
    'Personal/_tasks/Board.md': board,
    'Work/_tasks/Board.md': board,
    'Business/_tasks/Board.md': board,
    [NEW]: art('New one', '2026-10-27'),
    'Personal/1. a/02-old/article.md': art('Old one', '2026-01-01'),
    'Work/1. b/05-s/article.md': art('Sierra', '2026-10-20'),
    ...(reads ? { '.vaultos/kb-reads.json': JSON.stringify(reads) } : {}),
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(d.vault, '.vaultos/kb-reads.json');
  return {
    srv, tz, vault: d.vault, file,
    cookie: cookie ? await login(srv.base, PASSWORD) : null,
    disk: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}
const oldRead = () => ({ version: 1, articles: { personal: { '02-old': { read: Date.now() - 40 * DAY } } }, morning: null });

async function call(s, method, url, body, { cookie = s.cookie } = {}) {
  const res = await fetch(s.srv.base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const card = async (s, ws = 'personal') => (await call(s, 'GET', `/api/kb/morning?ws=${ws}`)).body.card;
const act = (s, action, opts) => call(s, 'POST', '/api/kb/morning', { action }, opts);

test('outside the window there is no card, and nothing is stored', async (t) => {
  const s = await morningServer(t, { hour: 15 });
  assert.equal(await card(s), null);
  assert.equal(fs.existsSync(s.file), false);
});

test('with Morning read off there is no card', async (t) => {
  const s = await morningServer(t, { morningRead: false });
  assert.equal(await card(s), null);
});

test('in the window: the pick for the open workspace, kept for the day and shown everywhere', async (t) => {
  const s = await morningServer(t, { reads: oldRead() });
  const c = await card(s);
  assert.equal(c.ws, 'personal');
  assert.equal(c.wsLabel, 'Personal');
  assert.equal(c.path, NEW);
  assert.equal(c.title, 'New one');
  assert.equal(c.collectionName, 'a');
  assert.match(c.excerpt, /About New one/);
  assert.equal(c.reason, 'unread');
  assert.equal(c.lastRead, null);
  assert.ok(c.minutes >= 1);
  const m = s.disk().morning;
  assert.equal(m.date, zonedDate(new Date(), s.tz));
  assert.equal(m.ws, 'personal');
  assert.equal(m.key, '01-new');
  assert.equal(m.done, false);
  assert.deepEqual(await card(s, 'work'), c);   // the phone open on another workspace sees the same card
});

test('a workspace with nothing to read stores nothing, so a later one can still pick', async (t) => {
  const s = await morningServer(t);
  assert.equal(await card(s, 'business'), null);
  assert.equal(fs.existsSync(s.file) ? s.disk().morning : null, null);
  assert.equal((await card(s, 'personal')).path, NEW);
});

test('Not today ends the day; a second press is a 409', async (t) => {
  const s = await morningServer(t);
  await card(s);
  assert.equal((await act(s, 'later')).status, 200);
  assert.equal(await card(s), null);
  assert.equal((await act(s, 'later')).status, 409);
});

test('Skip this one keeps the article out for 90 days', async (t) => {
  const s = await morningServer(t);
  await card(s);
  assert.equal((await act(s, 'skip')).status, 200);
  const skipUntil = s.disk().articles.personal['01-new'].skipUntil;
  assert.ok(Math.abs(skipUntil - (Date.now() + 90 * DAY)) < 60000, String(skipUntil));
  assert.equal(await card(s), null);
});

test('Read now ends the day without counting as a read', async (t) => {
  const s = await morningServer(t);
  await card(s);
  assert.equal((await act(s, 'open')).status, 200);
  assert.equal(s.disk().morning.done, true);
  assert.equal((s.disk().articles.personal || {})['01-new'], undefined);
});

test('a bad action is a 400, and no session is a 401', async (t) => {
  const s = await morningServer(t);
  await card(s);
  assert.equal((await act(s, 'nope')).status, 400);
  assert.equal((await act(s, 'later', { cookie: null })).status, 401);
});

test('read in the KB after the pick: no card, the day is done', async (t) => {
  const s = await morningServer(t);
  await card(s);
  assert.equal((await call(s, 'POST', '/api/kb/read?ws=personal', { path: NEW })).status, 200);
  assert.equal(await card(s), null);
  assert.equal(s.disk().morning.done, true);
});

test('moved after the pick: the same card at its new path', async (t) => {
  const s = await morningServer(t);
  const before = await card(s);
  fs.mkdirSync(path.join(s.vault, 'Personal/1. a/_done'));
  fs.renameSync(path.join(s.vault, 'Personal/1. a/01-new'), path.join(s.vault, 'Personal/1. a/_done/01-new'));
  const after = await card(s);
  assert.equal(after.title, before.title);
  assert.equal(after.path, 'Personal/1. a/_done/01-new/article.md');
});

test('deleted after the pick: no card, the day is done', async (t) => {
  const s = await morningServer(t);
  await card(s);
  fs.rmSync(path.join(s.vault, 'Personal/1. a/01-new'), { recursive: true });
  assert.equal(await card(s), null);
  assert.equal(s.disk().morning.done, true);
});

test('a card shown before noon can still be answered after it', async (t) => {
  const tz = zoneAtHour(15);
  const s = await morningServer(t, {
    hour: 15,
    reads: { version: 1, articles: {}, morning: { date: zonedDate(new Date(), tz), ws: 'personal', key: '01-new', at: Date.now() - 3600000, reason: 'unread', done: false } },
  });
  assert.equal((await act(s, 'later')).status, 200);
  assert.equal(s.disk().morning.done, true);
});

test('the same-box read path sees the card and writes nothing', async (t) => {
  const s = await morningServer(t, { env: { LOCAL_READ: '1' }, cookie: false });
  const r = await call(s, 'GET', '/api/kb/morning?ws=personal', undefined, { cookie: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.card.path, NEW);
  assert.equal(fs.existsSync(s.file), false);
});
