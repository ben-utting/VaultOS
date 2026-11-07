'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const art = (title, updated = '2026-10-01') => `---\ntype: article\ntitle: "${title}"\nupdated: ${updated}\n---\n\n> **TL;DR** ${title}.\n\n${'word '.repeat(400)}\n`;
const A = 'Personal/1. a/01-a/article.md';
const S = 'Work/1. b/05-s/article.md';

async function readsServer(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-kbreads-srv-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [
        { key: 'personal', dir: 'Personal', label: 'Personal', hidden: false },
        { key: 'work', dir: 'Work', label: 'Work', hidden: false },
      ],
      features: { today: false }, today: { dir: 'Personal/Today', timezone: 'Europe/London' },
    }),
    'Personal/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    [A]: art('Alpha'),
    'Personal/1. a/01-a/task.md': '---\ntitle: Alpha task\nstatus: done\n---\n',
    [S]: art('Sierra'),
    ...extra,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { srv, vault: d.vault, cookie: await login(srv.base, PASSWORD) };
}

async function call(base, method, url, { cookie, body } = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const readsFile = (vault) => path.join(vault, '.vaultos/kb-reads.json');
const kbList = async (s, ws) => (await call(s.srv.base, 'GET', `/api/kb?ws=${ws}`, { cookie: s.cookie })).body.articles;

test('articles carry reading time and an unread state', async (t) => {
  const s = await readsServer(t);
  const [a] = await kbList(s, 'personal');
  assert.equal(a.minutes, 2);
  assert.equal(a.lastRead, null);
  assert.equal(a.readState, 'unread');
  const one = await call(s.srv.base, 'GET', `/api/kb/article?ws=personal&path=${encodeURIComponent(A)}`, { cookie: s.cookie });
  assert.equal(one.status, 200);
  assert.equal(one.body.minutes, 2);
  assert.equal(one.body.lastRead, null);
  assert.equal(one.body.readState, 'unread');
});

test('POST /api/kb/read records a read for a signed-in session only', async (t) => {
  const s = await readsServer(t);
  assert.equal((await call(s.srv.base, 'POST', '/api/kb/read?ws=personal', { body: { path: A } })).status, 401);
  assert.equal(fs.existsSync(readsFile(s.vault)), false);

  const r = await call(s.srv.base, 'POST', '/api/kb/read?ws=personal', { cookie: s.cookie, body: { path: A } });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.lastRead, 'number');
  assert.equal(r.body.readState, 'read');
  const [a] = await kbList(s, 'personal');
  assert.equal(a.lastRead, r.body.lastRead);
  assert.equal(a.readState, 'read');
  const disk = JSON.parse(fs.readFileSync(readsFile(s.vault), 'utf8'));
  assert.equal(disk.articles.personal['01-a'].read, r.body.lastRead);
});

test('POST /api/kb/read refuses anything but an article in that workspace', async (t) => {
  const s = await readsServer(t);
  for (const p of ['Personal/1. a/01-a/task.md', S, 'Personal/../Work/1. b/05-s/article.md', 'Personal/1. a/nope/article.md']) {
    const r = await call(s.srv.base, 'POST', '/api/kb/read?ws=personal', { cookie: s.cookie, body: { path: p } });
    assert.equal(r.status, 400, p);
  }
  assert.equal(fs.existsSync(readsFile(s.vault)), false);
});

test('import merges a browser\'s old history, and refuses a non-object', async (t) => {
  const s = await readsServer(t);
  const now = Date.now();
  const r = await call(s.srv.base, 'POST', '/api/kb/reads/import', {
    cookie: s.cookie, body: { reads: { [A]: now - 1000, [S]: now - 2000 } },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { imported: 2 });
  assert.equal((await kbList(s, 'work'))[0].lastRead, now - 2000);
  for (const body of [{ reads: [] }, {}, { reads: 'x' }]) {
    assert.equal((await call(s.srv.base, 'POST', '/api/kb/reads/import', { cookie: s.cookie, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(s.srv.base, 'POST', '/api/kb/reads/import', { body: { reads: {} } })).status, 401);
});

test('a damaged kb-reads.json: reads still work, writes fail, the file is untouched', async (t) => {
  const s = await readsServer(t, { '.vaultos/kb-reads.json': '{bad' });
  const [a] = await kbList(s, 'personal');
  assert.equal(a.readState, 'unread');
  const r = await call(s.srv.base, 'POST', '/api/kb/read?ws=personal', { cookie: s.cookie, body: { path: A } });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /kb-reads\.json is damaged/);
  assert.equal(fs.readFileSync(readsFile(s.vault), 'utf8'), '{bad');
});

test('a hand-edited entry whose read is not a time reads as unread, and the KB still loads', async (t) => {
  const s = await readsServer(t, { '.vaultos/kb-reads.json': JSON.stringify({ version: 1, articles: { personal: { '01-a': { read: 'yesterday' } } }, morning: null }) });
  const r = await call(s.srv.base, 'GET', '/api/kb?ws=personal', { cookie: s.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.articles[0].lastRead, null);
  assert.equal(r.body.articles[0].readState, 'unread');
  assert.equal((await call(s.srv.base, 'GET', `/api/kb/article?ws=personal&path=${encodeURIComponent(A)}`, { cookie: s.cookie })).status, 200);
});

test('Morning read is a feature switch, on by default', async (t) => {
  const s = await readsServer(t);
  const me = async () => (await call(s.srv.base, 'GET', '/api/me', { cookie: s.cookie })).body.features.morningRead;
  assert.equal(await me(), true);
  assert.equal((await call(s.srv.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { morningRead: false } })).status, 200);
  assert.equal(await me(), false);
  assert.equal((await call(s.srv.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { morningRead: 'no' } })).status, 400);
});
