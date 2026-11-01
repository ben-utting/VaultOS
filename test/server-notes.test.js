'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const MAIN = 'Notes/Main/Small steps.md';

async function notesServer(t, { on = true, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-notes-srv-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
      features: { today: false, notes: on }, today: { dir: 'Work/Today', timezone: 'Europe/London' },
    }),
    'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    'Notes/Inbox/first.md': '2026-10-30 10:00\n\nFirst thought\n',
    [MAIN]: '2026-10-01 08:00\n\nStatus #baby\n\nTags\n\n## Small steps\nbody\n',
    'Notes/Tags/habits.md': '',
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const req = async (method, url, body, { auth = true } = {}) => {
    const res = await fetch(srv.base + url, {
      method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { vault: d.vault, req, disk: (p) => path.join(d.vault, ...p.split('/')) };
}

test('notes off: the routes are 404', async (t) => {
  const s = await notesServer(t, { on: false });
  const r = await s.req('GET', '/api/notes');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Notes is off');
  assert.equal((await s.req('POST', '/api/notes/capture', { text: 'x' })).status, 404);
});

test('capture, list, delete, undo, and a second undo is 410', async (t) => {
  const s = await notesServer(t);
  const c = await s.req('POST', '/api/notes/capture', { text: 'A new thought' });
  assert.equal(c.status, 200);
  assert.ok(fs.existsSync(s.disk(c.body.path)));
  const l = await s.req('GET', '/api/notes');
  assert.equal(l.status, 200);
  assert.ok(l.body.inbox.some((i) => i.path === c.body.path));
  assert.equal(l.body.main[0].path, MAIN);
  const del = await s.req('POST', '/api/notes/delete', { path: c.body.path });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(s.disk(c.body.path)));
  const u = await s.req('POST', '/api/notes/undo', { token: del.body.token });
  assert.equal(u.status, 200);
  assert.ok(fs.existsSync(s.disk(c.body.path)));
  assert.equal((await s.req('POST', '/api/notes/undo', { token: del.body.token })).status, 410);
});

test('empty capture is 400 with a message', async (t) => {
  const s = await notesServer(t);
  const r = await s.req('POST', '/api/notes/capture', { text: '  ' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Type something first.');
});

test('the same-box read path can list but not capture', async (t) => {
  const s = await notesServer(t, { env: { LOCAL_READ: '1' } });
  assert.equal((await s.req('GET', '/api/notes', null, { auth: false })).status, 200);
  assert.equal((await s.req('POST', '/api/notes/capture', { text: 'sneaky' }, { auth: false })).status, 401);
  assert.deepEqual(fs.readdirSync(s.disk('Notes/Inbox')), ['first.md']);
});

test('a note saves through the Files text route, and a stale mtime is 409', async (t) => {
  const s = await notesServer(t);
  const f = await s.req('GET', `/api/fs/file?path=${encodeURIComponent(MAIN)}`);
  const ok = await s.req('POST', '/api/fs/text/save', { path: MAIN, text: 'edited\n', mtime: f.body.mtime });
  assert.equal(ok.status, 200);
  assert.equal(fs.readFileSync(s.disk(MAIN), 'utf8'), 'edited\n');
  assert.equal((await s.req('POST', '/api/fs/text/save', { path: MAIN, text: 'again\n', mtime: f.body.mtime })).status, 409);
});

test('search finds a note in the notes folder when Notes is on, and not when it is off', async (t) => {
  const on = await notesServer(t);
  const r = await on.req('GET', '/api/search?q=Small%20steps');
  assert.equal(r.status, 200);
  const hit = r.body.results.find((x) => x.path === MAIN);
  assert.ok(hit, JSON.stringify(r.body));
  assert.equal(hit.ws, null);
  assert.equal(hit.wsLabel, 'Notes');
  const off = await notesServer(t, { on: false });
  const r2 = await off.req('GET', '/api/search?q=Small%20steps');
  assert.ok(!r2.body.results.some((x) => x.path === MAIN));
});
