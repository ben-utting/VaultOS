'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';

async function renameServer(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-rename-'));
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
    'Personal/notes/report.txt': 'hello\n',
    'Personal/notes/other.txt': 'other\n',
    'Personal/notes/sub/inner.txt': 'inner\n',
    'Personal/1. job/01-thing/task.md': '---\ntitle: Thing\nstatus: todo\n---\n',
    ...files,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const rename = async (p, name) => {
    const res = await fetch(`${srv.base}/api/fs/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ path: p, name }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const has = (p) => fs.existsSync(path.join(d.vault, ...p.split('/')));
  return { srv, rename, has, vault: d.vault, data: d.data };
}

test('a file is renamed in place and the answer carries the new path', async (t) => {
  const { rename, has } = await renameServer(t);
  const res = await rename('Personal/notes/report.txt', 'Weekly report.txt');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { path: 'Personal/notes/Weekly report.txt', oldPath: 'Personal/notes/report.txt', name: 'Weekly report.txt', dir: false });
  assert.ok(has('Personal/notes/Weekly report.txt'));
  assert.ok(!has('Personal/notes/report.txt'));
});

test('a folder is renamed with what is inside it', async (t) => {
  const { rename, has } = await renameServer(t);
  const res = await rename('Personal/notes/sub', 'archive-2026');
  assert.equal(res.status, 200);
  assert.equal(res.body.dir, true);
  assert.ok(has('Personal/notes/archive-2026/inner.txt'));
  assert.ok(!has('Personal/notes/sub'));
});

test('a name that is taken is refused and nothing moves', async (t) => {
  const { rename, has } = await renameServer(t);
  const res = await rename('Personal/notes/report.txt', 'other.txt');
  assert.equal(res.status, 409);
  assert.ok(has('Personal/notes/report.txt'));
});

test('names VaultOS reads are protected', async (t) => {
  const { rename, has } = await renameServer(t);
  for (const [p, name] of [
    ['Personal/1. job/01-thing/task.md', 'notes.md'],
    ['Personal/_tasks/Board.md', 'Board2.md'],
    ['Personal/_tasks', 'tasks2'],
    ['Personal', 'Mine'],
  ]) {
    const res = await rename(p, name);
    assert.equal(res.status, 422, `${p} -> ${res.status}`);
    assert.ok(has(p), p);
  }
});

test('bad names are 400s', async (t) => {
  const { rename, has } = await renameServer(t);
  for (const name of ['', '   ', 'a/b.txt', 'a\\b.txt', '..', '.hidden', 'x:y.txt', 'trailing.', 'report.txt', 'x'.repeat(300)]) {
    const res = await rename('Personal/notes/report.txt', name);
    assert.equal(res.status, 400, `${JSON.stringify(name)} -> ${res.status}`);
  }
  assert.ok(has('Personal/notes/report.txt'));
  assert.equal((await rename('Personal/notes/report.txt', 42)).status, 400);
});

test('only paths inside the vault can be renamed', async (t) => {
  const { rename } = await renameServer(t);
  for (const p of ['../outside.txt', '/etc/passwd', '.vaultos/settings.json', 'Personal/nope.txt', '']) {
    const res = await rename(p, 'x.txt');
    assert.ok(res.status >= 400 && res.status < 500, `${p} -> ${res.status}`);
  }
});

test('a rename needs a login', async (t) => {
  const { srv } = await renameServer(t);
  const res = await fetch(`${srv.base}/api/fs/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Personal/notes/report.txt', name: 'x.txt' }) });
  assert.equal(res.status, 401);
});

test('the previous version moves with a renamed file', async (t) => {
  const { srv, rename, has, vault, data } = await renameServer(t);
  const cookie = await login(srv.base, PASSWORD);
  const get = async (p) => (await fetch(`${srv.base}/api/fs/file?path=${encodeURIComponent(p)}`, { headers: { cookie } })).json();
  const f = await get('Personal/notes/report.txt');
  const saved = await fetch(`${srv.base}/api/fs/text/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ path: 'Personal/notes/report.txt', text: 'v2\n', mtime: f.mtime }) });
  assert.equal(saved.status, 200);
  assert.equal((await rename('Personal/notes/report.txt', 'renamed.txt')).status, 200);
  const after = await get('Personal/notes/renamed.txt');
  assert.equal(after.source, 'v2\n');
  assert.ok(after.backup, 'the backup followed the file');
  assert.ok(has('Personal/notes/renamed.txt') && vault && data);
});
