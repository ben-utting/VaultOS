'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword, readConfig, verifyPassword } = require('../lib/password');

const PASSWORD = 'correct horse';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-setup-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home'), srv: null };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  t.after(async () => {
    if (d.srv) await d.srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return d;
}

async function start(d, env) {
  d.srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env });
  return d.srv;
}

const call = async (base, method, url, { cookie, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

test('full setup flow', async (t) => {
  const d = setup(t);
  const { base } = await start(d);

  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 200);
  const cookie = cookieOf(pw);
  assert.ok(cookie);

  const boards = await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: 'Europe/London' } });
  assert.equal(boards.status, 200);
  assert.equal(boards.body.settings.setupDone, false);
  assert.ok(fs.existsSync(path.join(d.vault, 'Work/_tasks/Board.md')));
  assert.ok(fs.existsSync(path.join(d.vault, 'Home/_tasks/Board.md')));
  const agents = fs.readFileSync(path.join(d.vault, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\*\*Work\*\*/);
  assert.match(agents, /\*\*Home\*\*/);
  assert.ok(fs.existsSync(path.join(d.vault, 'Work/1. getting-started/01-welcome-to-vaultos/task.md')));
  assert.ok(!fs.existsSync(path.join(d.vault, 'Home/1. getting-started')));

  assert.equal((await call(base, 'GET', '/api/tasks?ws=work', { cookie })).status, 409);

  const fin = await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false, timezone: 'Europe/London' } });
  assert.equal(fin.status, 200);

  const tasks = await call(base, 'GET', '/api/tasks?ws=work', { cookie });
  assert.equal(tasks.status, 200);
  assert.equal(tasks.body.tasks.length, 1);
  assert.equal(tasks.body.tasks[0].title, 'Welcome to VaultOS');
  assert.equal(tasks.body.tasks[0].status, 'backlog');

  const again = await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: true } });
  assert.equal(again.status, 409);

  const home = await call(base, 'GET', '/', { cookie });
  assert.match(home.text, /id="board"/);
});

test('GET / is the setup page while setup is due', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  assert.match((await call(base, 'GET', '/')).text, /id="setup"/);
  assert.match((await call(base, 'GET', '/index.html')).text, /id="setup"/);
  assert.match((await call(base, 'GET', '/setup')).text, /id="setup"/);
});

test('window closed refuses the password', async (t) => {
  const d = setup(t);
  const { base } = await start(d, { SETUP_WINDOW_MIN: '0' });
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 403);
  assert.equal(readConfig(d.data), null);
  const state = await call(base, 'GET', '/api/setup/state');
  assert.equal(state.body.windowOpen, false);
  assert.equal(state.body.folder, undefined);
  assert.equal(state.body.settingsError, undefined);
});

test('concurrent password posts: one wins', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const post = (password) => call(base, 'POST', '/api/setup/password', { body: { password } });
  const rs = await Promise.all([post('first password'), post('second password')]);
  const winner = rs.find((r) => r.status === 200) === rs[0] ? 'first password' : 'second password';
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.ok(verifyPassword(readConfig(d.data), winner));
});

test('short password is 400', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: 'short' } });
  assert.equal(pw.status, 400);
  assert.equal(readConfig(d.data), null);
});

test('boards with no usable label create nothing', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const cookie = cookieOf(await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } }));
  const r = await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', '🚀'], timezone: 'UTC' } });
  assert.equal(r.status, 400);
  assert.deepEqual(fs.readdirSync(d.vault), []);
});

test('boards without a session is 401', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const r = await call(base, 'POST', '/api/setup/boards', { body: { labels: ['Work'] } });
  assert.equal(r.status, 401);
});

test('existing folder on a new machine', async (t) => {
  const d = setup(t);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true, boards: [{ key: 'alpha', dir: 'alpha', label: 'alpha', hidden: false }],
    }),
    'alpha/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
  });
  const { base } = await start(d);
  const state = await call(base, 'GET', '/api/setup/state');
  assert.equal(state.body.stage, 'existing-folder');
  assert.deepEqual(state.body.steps, [1, 2, 4]);
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 200);
  const tasks = await call(base, 'GET', '/api/tasks?ws=alpha', { cookie: cookieOf(pw) });
  assert.equal(tasks.status, 200);
});

test('password: a config written on disk since boot gives 409', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  writePassword(d.data, 'written by cli');
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 409);
  assert.ok(verifyPassword(readConfig(d.data), 'written by cli'));
});

test('password: a non-validation failure is a 500 without detail', async (t) => {
  const d = setup(t);
  fs.mkdirSync(path.join(d.data, 'lockout.json'), { recursive: true }); // the lockout reset fails inside writePassword
  const { base } = await start(d);
  const pw = await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } });
  assert.equal(pw.status, 500);
  assert.deepEqual(pw.body, { error: 'Could not save the password' });
});

test('concurrent boards posts: one wins', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const cookie = cookieOf(await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } }));
  const post = () => call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'] } });
  const rs = await Promise.all([post(), post()]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(fs.readdirSync(d.vault).filter((n) => !n.startsWith('.')).sort(), ['AGENTS.md', 'CLAUDE.md', 'Home', 'Work']);
});

test('boards refuse a folder that already exists', async (t) => {
  const d = setup(t);
  seedVault(d.vault, { 'Work/notes.md': 'mine' });
  const { base } = await start(d);
  const cookie = cookieOf(await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } }));
  const r = await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['work'] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already exists/);
  assert.ok(!fs.existsSync(path.join(d.vault, 'Work/_tasks')));
});

test('boards save refreshes an existing AGENTS.md block', async (t) => {
  const d = setup(t);
  seedVault(d.vault, { 'AGENTS.md': 'mine\n<!-- vaultos:boards -->\n<!-- /vaultos:boards -->\n' });
  const { base } = await start(d);
  const cookie = cookieOf(await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } }));
  const r = await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Alpha'] } });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(d.vault, 'AGENTS.md'), 'utf8'), /\*\*Alpha\*\*/);
});

test('gate allowlist: me and login pass, agent reaches the auth gate', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  assert.equal((await call(base, 'GET', '/api/me')).status, 200);
  const l = await call(base, 'POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(l.status, 409);
  assert.equal(l.body.setup, true);
  assert.equal((await call(base, 'GET', '/api/agent')).status, 401);
  assert.equal((await call(base, 'GET', '/api/agents')).status, 401);   // step 4 reads it: past the setup gate, to the auth gate
});

test('setup step 4 can list the agents before setup finishes', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  const cookie = cookieOf(await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } }));
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work'] } })).status, 200);
  const r = await call(base, 'GET', '/api/agents', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.default, 'none');
  assert.equal(r.body.agents.length, 8);
});

test('state: folder shown inside the window, and to a signed-in session after it closes', async (t) => {
  const d = setup(t);
  const { base } = await start(d);
  assert.ok((await call(base, 'GET', '/api/setup/state')).body.folder);

  const d2 = setup(t);
  writePassword(d2.data, PASSWORD);
  const s2 = await start(d2, { SETUP_WINDOW_MIN: '0' });
  const anon = await call(s2.base, 'GET', '/api/setup/state');
  assert.equal(anon.body.folder, undefined);
  const cookie = await login(s2.base, PASSWORD);
  const authed = await call(s2.base, 'GET', '/api/setup/state', { cookie });
  assert.equal(authed.body.stage, 'boards');
  assert.ok(authed.body.folder);
});
