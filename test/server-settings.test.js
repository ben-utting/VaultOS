'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');

const PASSWORD = 'correct horse';

const call = async (base, method, url, { cookie, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const setCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: json, text, setCookie };
};

// Starts a server and runs setup through its routes (boards Work and Home, Today off).
async function ready(t, { files = {}, boards = ['Work', 'Home'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-settings-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, files);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = srv.base;
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: boards, timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  return { ...d, base, cookie };
}

const keys = async (s) => (await call(s.base, 'GET', '/api/workspaces', { cookie: s.cookie })).body.map((w) => w.key);

test('settings need a session', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'GET', '/api/settings')).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/settings/boards', { body: { label: 'X' } })).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/settings/password', { body: { current: PASSWORD, next: 'another one' } })).status, 401);
});

test('GET lists candidate folders', async (t) => {
  const s = await ready(t, { files: { 'Archive/old.md': 'x', '.git/HEAD': 'x', '_misc/a.md': 'x' } });
  const r = await call(s.base, 'GET', '/api/settings', { cookie: s.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.folders, ['Archive']);
  assert.equal(r.body.settings.boards.length, 2);
  assert.equal(r.body.terminalAllowed, false);
});

test('add a board', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/settings/boards', { cookie: s.cookie, body: { label: 'Notes' } });
  assert.equal(r.status, 200);
  assert.ok((await keys(s)).includes('notes'));
  assert.ok(fs.existsSync(path.join(s.vault, 'Notes/_tasks/Board.md')));
  assert.ok(!fs.existsSync(path.join(s.vault, 'Notes/1. getting-started')));
  assert.match(fs.readFileSync(path.join(s.vault, 'AGENTS.md'), 'utf8'), /\*\*Notes\*\*/);
});

test('add clashing board is 400', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/settings/boards', { cookie: s.cookie, body: { label: 'work' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already exists/);
});

test('add board over an existing folder is 400 and leaves it alone', async (t) => {
  const s = await ready(t, { files: { 'Archive/old.md': 'x' } });
  const r = await call(s.base, 'POST', '/api/settings/boards', { cookie: s.cookie, body: { label: 'archive' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Add an existing folder/);
  assert.ok(!r.body.error.includes('Settings'));
  assert.ok(!fs.existsSync(path.join(s.vault, 'Archive/_tasks')));
});

test('add an existing folder', async (t) => {
  const s = await ready(t, { files: { 'Archive/old.md': 'keep me\n' } });
  const r = await call(s.base, 'POST', '/api/settings/boards/existing', { cookie: s.cookie, body: { dir: 'Archive' } });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(s.vault, 'Archive/_tasks/Board.md')));
  assert.equal(fs.readFileSync(path.join(s.vault, 'Archive/old.md'), 'utf8'), 'keep me\n');
  assert.ok((await keys(s)).includes('archive'));
});

test('existing folder must be a candidate', async (t) => {
  const s = await ready(t, { files: { '.git/HEAD': 'x', 'Archive/a.md': 'x' } });
  for (const dir of ['.git', 'Work', 'Missing', 5]) {
    const r = await call(s.base, 'POST', '/api/settings/boards/existing', { cookie: s.cookie, body: { dir } });
    assert.equal(r.status, 400, String(dir));
  }
});

test('hide the last visible board is 400', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'PATCH', '/api/settings/boards/work', { cookie: s.cookie, body: { hidden: true } })).status, 200);
  const r = await call(s.base, 'PATCH', '/api/settings/boards/home', { cookie: s.cookie, body: { hidden: true } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /visible/);
  assert.equal((await call(s.base, 'PATCH', '/api/settings/boards/nope', { cookie: s.cookie, body: { label: 'x' } })).status, 400);
});

test('rename and move to index 0', async (t) => {
  const s = await ready(t);
  assert.deepEqual(await keys(s), ['work', 'home']);
  const r = await call(s.base, 'PATCH', '/api/settings/boards/home', { cookie: s.cookie, body: { index: 0, label: 'House' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await keys(s), ['home', 'work']);
  assert.equal(r.body.settings.boards[0].label, 'House');
});

test('Today off, on, off', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'GET', '/api/today', { cookie: s.cookie })).status, 404);
  const on = await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { today: true } });
  assert.equal(on.status, 200);
  const r = await call(s.base, 'GET', '/api/today', { cookie: s.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.timeZone, 'Europe/London');
  // A new timezone while on rebuilds the service.
  assert.equal((await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { timezone: 'Asia/Tokyo' } })).status, 200);
  assert.equal((await call(s.base, 'GET', '/api/today', { cookie: s.cookie })).body.timeZone, 'Asia/Tokyo');
  assert.equal((await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { today: false } })).status, 200);
  assert.equal((await call(s.base, 'GET', '/api/today', { cookie: s.cookie })).status, 404);
});

test('a new install has no habits; the app adds them, and only when signed in', async (t) => {
  const s = await ready(t);
  await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { today: true } });
  const p = await call(s.base, 'GET', '/api/today', { cookie: s.cookie });
  assert.deepEqual(p.body.habits, []);
  const body = { date: p.body.today, op: 'add', name: 'Walk', icon: 'walk' };
  assert.equal((await call(s.base, 'POST', '/api/today/habits', { body })).status, 401);
  const r = await call(s.base, 'POST', '/api/today/habits', { cookie: s.cookie, body });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.habits, [{ id: 'walk', name: 'Walk', icon: 'walk', goal: null }]);
  assert.equal((await call(s.base, 'POST', '/api/today/habits', { cookie: s.cookie, body: { date: p.body.today, op: 'add', name: '' } })).status, 400);
});

test('features validate their input', async (t) => {
  const s = await ready(t);
  for (const body of [{ today: 'yes' }, { terminal: 1 }, { timezone: 'Mars/Base' }, { timezone: 5 }]) {
    assert.equal((await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body })).status, 400, JSON.stringify(body));
  }
  const r = await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { terminal: false } });
  assert.equal(r.body.settings.features.terminal, false);
});

test('password change', async (t) => {
  const s = await ready(t);
  const post = (body) => call(s.base, 'POST', '/api/settings/password', { cookie: s.cookie, body });
  assert.equal((await post({ current: 'wrong wrong', next: 'a brand new one' })).status, 401);
  assert.equal((await post({ current: PASSWORD, next: 'short' })).status, 400);
  const changed = await post({ current: PASSWORD, next: 'a brand new one' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.signedOut, true);
  assert.equal((await call(s.base, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/login', { body: { password: 'a brand new one' } })).status, 200);
  // Every cookie from before the change is signed out; the browser that changed it gets a new one.
  assert.equal((await call(s.base, 'GET', '/api/settings', { cookie: s.cookie })).status, 401);
  assert.equal((await call(s.base, 'GET', '/api/settings', { cookie: changed.setCookie })).status, 200);
});

test('wrong current password does not count toward the lockout', async (t) => {
  const s = await ready(t);
  for (let i = 0; i < 8; i++) {
    assert.equal((await call(s.base, 'POST', '/api/settings/password', { cookie: s.cookie, body: { current: 'wrong wrong', next: 'a brand new one' } })).status, 401);
  }
  assert.equal((await call(s.base, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
});

test('concurrent adds both land', async (t) => {
  const s = await ready(t);
  const add = (label) => call(s.base, 'POST', '/api/settings/boards', { cookie: s.cookie, body: { label } });
  const [a, b] = await Promise.all([add('Alpha'), add('Beta')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const ks = await keys(s);
  assert.ok(ks.includes('alpha') && ks.includes('beta'));
  const agents = fs.readFileSync(path.join(s.vault, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\*\*Alpha\*\*/);
  assert.match(agents, /\*\*Beta\*\*/);
});

test('an add and a rename at the same time both land', async (t) => {
  const s = await ready(t);
  const [a, b] = await Promise.all([
    call(s.base, 'POST', '/api/settings/boards', { cookie: s.cookie, body: { label: 'Alpha' } }),
    call(s.base, 'PATCH', '/api/settings/boards/home', { cookie: s.cookie, body: { label: 'House' } }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const r = await call(s.base, 'GET', '/api/settings', { cookie: s.cookie });
  const byKey = Object.fromEntries(r.body.settings.boards.map((x) => [x.key, x.label]));
  assert.equal(byKey.alpha, 'Alpha');
  assert.equal(byKey.home, 'House');
});

test('an unexpected failure is a generic 500 without the raw message', async (t) => {
  const s = await ready(t);
  // A file where the settings folder was: saving cannot create it.
  fs.rmSync(path.join(s.vault, '.vaultos'), { recursive: true });
  fs.writeFileSync(path.join(s.vault, '.vaultos'), 'x');
  const r = await call(s.base, 'PATCH', '/api/settings/boards/home', { cookie: s.cookie, body: { label: 'House' } });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'Could not update the board');
  assert.ok(!r.text.includes(s.vault));
});
