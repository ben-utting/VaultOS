'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';

async function moveServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-move-'));
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
    'Personal/notes/report.md': '# Report\n',
    'Personal/notes/sub/inner.txt': 'inner\n',
    'Personal/archive/report.md': '# Older report\n',
    'Personal/archive/keep.txt': 'keep\n',
    'Personal/1. job/01-thing/task.md': '---\ntitle: Thing\nstatus: todo\n---\n',
    'Other/x.txt': 'x\n',
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const move = async (p, to, ck = cookie) => {
    const res = await fetch(`${srv.base}/api/fs/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify({ path: p, to }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const has = (p) => fs.existsSync(path.join(d.vault, ...p.split('/')));
  return { srv, move, has, cookie };
}

test('a file moves into another folder and keeps its name', async (t) => {
  const { move, has } = await moveServer(t);
  const res = await move('Personal/archive/keep.txt', 'Personal/notes/sub');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { path: 'Personal/notes/sub/keep.txt', oldPath: 'Personal/archive/keep.txt', name: 'keep.txt', dir: false });
  assert.ok(has('Personal/notes/sub/keep.txt') && !has('Personal/archive/keep.txt'));
});

test('a folder moves with what is inside it, also across workspaces and to the vault root', async (t) => {
  const { move, has } = await moveServer(t);
  assert.equal((await move('Personal/notes/sub', 'Other')).status, 200);
  assert.ok(has('Other/sub/inner.txt') && !has('Personal/notes/sub'));
  assert.equal((await move('Other/x.txt', '')).status, 200);
  assert.ok(has('x.txt'));
});

test('a name taken in the target folder is refused and nothing moves', async (t) => {
  const { move, has } = await moveServer(t);
  const res = await move('Personal/notes/report.md', 'Personal/archive');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already a file or folder named report\.md in Personal\/archive/);
  assert.ok(has('Personal/notes/report.md'));
});

test('a folder cannot go into itself, and nothing goes to the folder it is already in', async (t) => {
  const { move, has } = await moveServer(t);
  assert.equal((await move('Personal/notes', 'Personal/notes')).status, 400);
  assert.equal((await move('Personal/notes', 'Personal/notes/sub')).status, 400);
  assert.equal((await move('Personal/notes/report.md', 'Personal/notes')).status, 400);
  assert.ok(has('Personal/notes/sub/inner.txt'));
});

test('names VaultOS reads cannot be moved, and nothing goes into _tasks', async (t) => {
  const { move, has } = await moveServer(t);
  for (const [p, to] of [
    ['Personal/1. job/01-thing/task.md', 'Personal/notes'],
    ['Personal/_tasks/Board.md', 'Personal/notes'],
    ['Personal/_tasks', 'Personal/notes'],
    ['Personal', 'Other'],
    ['Personal/notes/report.md', 'Personal/_tasks'],
  ]) {
    const res = await move(p, to);
    assert.equal(res.status, 422, `${p} -> ${to}: ${res.status}`);
    assert.doesNotMatch(res.body.error, /renamed/);
  }
  assert.ok(has('Personal/notes/report.md') && has('Personal/_tasks/Board.md'));
});

test('only paths and folders inside the vault, and a folder as the target', async (t) => {
  const { move, has } = await moveServer(t);
  for (const [p, to] of [
    ['../outside.txt', 'Personal'], ['', 'Personal'], ['Personal/nope.md', 'Personal/archive'],
    ['Personal/notes/report.md', '../'], ['Personal/notes/report.md', '.vaultos'], ['Personal/notes/report.md', 'Personal/nope'],
    ['Personal/notes/report.md', 'Personal/archive/keep.txt'], ['Personal/notes/report.md', 42],
  ]) {
    const res = await move(p, to);
    assert.ok(res.status >= 400 && res.status < 500, `${p} -> ${to}: ${res.status}`);
  }
  assert.ok(has('Personal/notes/report.md'));
});

test('a move needs a login', async (t) => {
  const { move } = await moveServer(t);
  assert.equal((await move('Personal/notes/report.md', 'Personal/archive', null)).status, 401);
});

test('the previous version moves with a moved file', async (t) => {
  const { srv, move, cookie } = await moveServer(t);
  const get = async (p) => (await fetch(`${srv.base}/api/fs/file?path=${encodeURIComponent(p)}`, { headers: { cookie } })).json();
  const f = await get('Personal/archive/keep.txt');
  const saved = await fetch(`${srv.base}/api/fs/text/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ path: 'Personal/archive/keep.txt', text: 'v2\n', mtime: f.mtime }) });
  assert.equal(saved.status, 200);
  assert.equal((await move('Personal/archive/keep.txt', 'Personal/notes/sub')).status, 200);
  const after = await get('Personal/notes/sub/keep.txt');
  assert.equal(after.source, 'v2\n');
  assert.ok(after.backup, 'the backup followed the file');
});
