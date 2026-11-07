'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const T = 'Personal/notes/report.txt';

async function textServer(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-textsave-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [{ key: 'personal', dir: 'Personal', label: 'Personal', hidden: false }],
      features: { today: false }, today: { dir: 'Personal/Today', timezone: 'Europe/London' },
    }),
    'Personal/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    [T]: 'old line\n',
    ...files,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const post = async (url, body) => {
    const res = await fetch(srv.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const file = async (p) => (await fetch(`${srv.base}/api/fs/file?path=${encodeURIComponent(p)}`, { headers: { cookie } })).json();
  const disk = (p) => fs.readFileSync(path.join(d.vault, ...p.split('/')), 'utf8');
  return { srv, vault: d.vault, post, file, disk };
}

test('save replaces the text, keeps the old one for restore, and answers the new mtime', async (t) => {
  const { post, file, disk } = await textServer(t);
  const before = await file(T);
  assert.equal(before.source, 'old line\n');
  assert.equal(before.backup, null);

  const res = await post('/api/fs/text/save', { path: T, text: 'report 1\nreport 2\n', mtime: before.mtime });
  assert.equal(res.status, 200);
  assert.equal(disk(T), 'report 1\nreport 2\n');
  assert.ok(res.body.mtime >= before.mtime);
  assert.ok(res.body.backup && res.body.backup.mtime);

  const after = await file(T);
  assert.equal(after.source, 'report 1\nreport 2\n');
  assert.ok(after.backup);

  const back = await post('/api/fs/text/restore', { path: T, mtime: after.mtime });
  assert.equal(back.status, 200);
  assert.equal(disk(T), 'old line\n');
});

test('a file that changed on disk since it was opened is refused with 409 and left alone', async (t) => {
  const { post, file, disk, vault } = await textServer(t);
  const before = await file(T);
  fs.writeFileSync(path.join(vault, ...T.split('/')), 'someone else was here\n');
  const future = new Date(before.mtime + 5000);
  fs.utimesSync(path.join(vault, ...T.split('/')), future, future);
  const res = await post('/api/fs/text/save', { path: T, text: 'mine\n', mtime: before.mtime });
  assert.equal(res.status, 409);
  assert.equal(disk(T), 'someone else was here\n');
});

test('an empty or blank save is refused, so a stray click never wipes a file', async (t) => {
  const { post, file, disk } = await textServer(t);
  const { mtime } = await file(T);
  for (const text of ['', '  \n\n']) {
    const res = await post('/api/fs/text/save', { path: T, text, mtime });
    assert.equal(res.status, 400);
  }
  assert.equal(disk(T), 'old line\n');
});

test('CRLF files stay CRLF after a save', async (t) => {
  const win = 'Personal/notes/win.txt';
  const { post, file, disk } = await textServer(t, { [win]: 'a\r\nb\r\n' });
  const { mtime } = await file(win);
  const res = await post('/api/fs/text/save', { path: win, text: 'x\ny\nz\n', mtime });
  assert.equal(res.status, 200);
  assert.equal(disk(win), 'x\r\ny\r\nz\r\n');
});

test('a csv saves through its Source text', async (t) => {
  const csv = 'Personal/notes/data.csv';
  const { post, file, disk } = await textServer(t, { [csv]: 'a,b\n1,2\n' });
  const { mtime } = await file(csv);
  const res = await post('/api/fs/text/save', { path: csv, text: 'a,b\n3,4\n5,6\n', mtime });
  assert.equal(res.status, 200);
  assert.equal(disk(csv), 'a,b\n3,4\n5,6\n');
});

test('only text can be saved: an xlsx, an image, a dot-folder and a path outside the vault are all refused', async (t) => {
  const { post, file } = await textServer(t, {
    'Personal/notes/book.xlsx': 'PK',
    'Personal/notes/pic.png': 'x',
    '.hidden/secret.txt': 'x',
  });
  const { mtime } = await file(T);
  for (const p of ['Personal/notes/book.xlsx', 'Personal/notes/pic.png', '.hidden/secret.txt', '../outside.txt', '/etc/passwd']) {
    const res = await post('/api/fs/text/save', { path: p, text: 'x', mtime });
    assert.ok(res.status >= 400 && res.status < 500, `${p} -> ${res.status}`);
  }
});

test('bad requests are 400s: no text, a NUL byte, no mtime, over the 1 MB limit', async (t) => {
  const { post, file, disk } = await textServer(t);
  const { mtime } = await file(T);
  assert.equal((await post('/api/fs/text/save', { path: T, mtime })).status, 400);
  assert.equal((await post('/api/fs/text/save', { path: T, text: 'a\0b', mtime })).status, 400);
  assert.equal((await post('/api/fs/text/save', { path: T, text: 'x' })).status, 400);
  assert.equal((await post('/api/fs/text/save', { path: T, text: 'x'.repeat(1024 * 1024 + 1), mtime })).status, 413);
  assert.equal(disk(T), 'old line\n');
});

test('a save needs a login', async (t) => {
  const { srv, file } = await textServer(t);
  const { mtime } = await file(T);
  const res = await fetch(`${srv.base}/api/fs/text/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: T, text: 'x', mtime }),
  });
  assert.equal(res.status, 401);
});
