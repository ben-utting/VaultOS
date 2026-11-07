'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const BOARD_MD = '---\n\nkanban-plugin: board\n\n---\n';

// Temp vault, data and home folders; the server is stopped before they are removed.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-boot-'));
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

// Every path under dir, relative and with forward slashes.
function paths(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(r);
    }
  };
  walk('');
  return out.sort();
}

const get = async (base, url, cookie) => {
  const res = await fetch(base + url, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
};

function legacyVault(d) {
  seedVault(d.vault, {
    'alpha/_tasks/Board.md': BOARD_MD,
    'Beta/_tasks/Board.md': BOARD_MD,
    'Beta/Today/habits.md': '# Habits\n\n- Read\n',
  });
  writePassword(d.data, PASSWORD);
}

test('fresh folder: health 200 setup:true, me setup:true, api 409', async (t) => {
  const d = setup(t);
  const srv = await start(d);

  const health = await get(srv.base, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.setup, true);

  const me = await get(srv.base, '/api/me');
  assert.equal(me.body.authed, false);
  assert.equal(me.body.setup, true);

  const tasks = await get(srv.base, '/api/tasks');
  assert.equal(tasks.status, 409);
});

test('migrates an existing vault', async (t) => {
  const d = setup(t);
  legacyVault(d);
  const before = paths(d.vault);
  const srv = await start(d);

  assert.match(srv.output(), /migrated: wrote \.vaultos\/settings\.json \(2 boards\)/);
  const cookie = await login(srv.base, PASSWORD);
  const ws = await get(srv.base, '/api/workspaces', cookie);
  assert.deepEqual(ws.body, [{ key: 'alpha', label: 'alpha', dir: 'alpha' }, { key: 'beta', label: 'Beta', dir: 'Beta' }]);
  const me = await get(srv.base, '/api/me', cookie);
  assert.equal(me.body.authed, true);
  assert.equal(me.body.features.today, true);

  const added = paths(d.vault).filter((p) => !before.includes(p));
  assert.deepEqual(added, ['.vaultos', '.vaultos/settings.json']);
});

test('invalid settings.json is reported, not replaced', async (t) => {
  const d = setup(t);
  legacyVault(d);   // a vault migration would pick up, were the broken file ignored
  // V8's JSON error quotes the text around the fault, so the token shows up in the message.
  const broken = '{"label": zzsecret}';
  seedVault(d.vault, { '.vaultos/settings.json': broken });
  const srv = await start(d);

  const health = await get(srv.base, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.setup, true);
  assert.match(health.body.error, /settings\.json/);
  // /health is public: the detail goes to the server log, never into the response.
  assert.ok(!JSON.stringify(health.body).includes('zzsecret'), JSON.stringify(health.body));
  assert.match(srv.output(), /zzsecret/);
  assert.equal(fs.readFileSync(path.join(d.vault, '.vaultos', 'settings.json'), 'utf8'), broken);
  assert.doesNotMatch(srv.output(), /migrated:/);
});

test('a failed migration is reported, and the server stays up', async (t) => {
  const d = setup(t);
  // "Notes (old)" makes the board key notes-(old), which the settings rules refuse.
  seedVault(d.vault, { 'Notes (old)/_tasks/Board.md': BOARD_MD });
  writePassword(d.data, PASSWORD);
  const srv = await start(d);

  const health = await get(srv.base, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.setup, true);
  assert.match(health.body.error, /settings\.json/);
  assert.doesNotMatch(JSON.stringify(health.body), /notes/i);   // no folder names on a public route
  assert.match(srv.output(), /migration failed:/);
  assert.equal(fs.existsSync(path.join(d.vault, '.vaultos')), false);
  const me = await get(srv.base, '/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { authed: false, setup: true });
});

test('configured but empty vault is 503', async (t) => {
  const d = setup(t);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true, boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
    }),
  });
  writePassword(d.data, PASSWORD);
  const srv = await start(d);

  const health = await get(srv.base, '/health');
  assert.equal(health.status, 503);
  assert.equal(health.body.ok, false);
  assert.equal(health.body.setup, false);
});

test('board scans skip the Today folder even while Today is off', async (t) => {
  const d = setup(t);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true, boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
      features: { today: false }, today: { dir: 'Work/Today' },
    }),
    'Work/_tasks/Board.md': BOARD_MD,
    'Work/p/j/task.md': '---\ntitle: "J"\nstatus: backlog\n---\n',
    'Work/Today/x/task.md': '---\ntitle: "X"\nstatus: backlog\n---\n',
  });
  writePassword(d.data, PASSWORD);
  const srv = await start(d);
  const cookie = await login(srv.base, PASSWORD);

  const res = await get(srv.base, '/api/tasks?ws=work', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks.map((x) => x.path), ['Work/p/j/task.md']);
});

test('comment entries carry no name', async (t) => {
  const d = setup(t);
  legacyVault(d);
  seedVault(d.vault, {
    'alpha/1. x/01-y/task.md': '---\ntitle: "Y"\nstatus: backlog\nupdated: 2026-01-01\n---\n\n## Goal\n\nSomething.\n',
  });
  const srv = await start(d);
  const cookie = await login(srv.base, PASSWORD);

  const res = await fetch(`${srv.base}/api/task/comment?ws=alpha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: 'alpha/1. x/01-y/task.md', text: 'hi' }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const raw = fs.readFileSync(path.join(d.vault, 'alpha', '1. x', '01-y', 'task.md'), 'utf8');
  assert.match(raw, /^- \*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\*\* hi$/m);
});
