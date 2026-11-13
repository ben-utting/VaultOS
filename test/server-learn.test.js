'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const KEY = 'sk-or-v1-abcdefgh1234';

async function learnServer(t, { on = true, env = {}, bins = [], agent = 'claude' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-learn-srv-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  const bin = path.join(d.home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\necho 1.0\n', { mode: 0o755 });
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
      features: { today: false, learn: on }, today: { dir: 'Work/Today', timezone: 'Europe/London' }, agent: { profile: agent },
    }),
    'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const req = async (method, url, body, { auth = true } = {}) => {
    const res = await fetch(srv.base + url, {
      method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  return { ...d, req, disk: (p) => path.join(d.vault, ...p.split('/')) };
}

test('Learn off: every route is 404', async (t) => {
  const s = await learnServer(t, { on: false });
  for (const [m, u, b] of [['GET', '/api/learn/notebooks'], ['POST', '/api/learn/notebooks', { name: 'x' }], ['POST', '/api/learn/youtube', { notebook: 'Learning/x', url: 'https://youtu.be/abcdefghijk' }],
    ['GET', '/api/learn/youtube/abc'], ['POST', '/api/learn/image', { notebook: 'Learning/x' }], ['GET', '/api/learn/key'], ['PUT', '/api/learn/key', { key: KEY }],
    ['DELETE', '/api/learn/key'], ['POST', '/api/learn/key/test'], ['GET', '/api/learn/agents']]) {
    const r = await s.req(m, u, b);
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.equal(r.body.error, 'Learn is off');
  }
});

test('writes need a real session', async (t) => {
  const s = await learnServer(t);
  for (const [m, u, b] of [['POST', '/api/learn/notebooks', { name: 'x' }], ['POST', '/api/learn/image', { notebook: 'Learning/x' }],
    ['PUT', '/api/learn/key', { key: KEY }], ['DELETE', '/api/learn/key'], ['POST', '/api/learn/key/test'], ['POST', '/api/learn/youtube', { notebook: 'Learning/x', url: 'x' }]]) {
    assert.equal((await s.req(m, u, b, { auth: false })).status, 401, `${m} ${u}`);
  }
});

test('create and list notebooks through the routes', async (t) => {
  const s = await learnServer(t);
  const c = await s.req('POST', '/api/learn/notebooks', { name: 'Sample notebook' });
  assert.equal(c.status, 200);
  assert.equal(c.body.notebook.path, 'Learning/Sample notebook');
  assert.ok(fs.existsSync(s.disk('Learning/AGENTS.md')));
  assert.equal((await s.req('POST', '/api/learn/notebooks', { name: 'sample NOTEBOOK' })).status, 409);
  assert.equal((await s.req('POST', '/api/learn/notebooks', { name: '../x' })).status, 400);
  const l = await s.req('GET', '/api/learn/notebooks');
  assert.deepEqual(l.body.notebooks.map((n) => n.name), ['Sample notebook']);
});

test('the key never comes back, only its last four', async (t) => {
  const s = await learnServer(t);
  assert.deepEqual((await s.req('GET', '/api/learn/key')).body, { set: false, source: null, last4: null });
  assert.equal((await s.req('PUT', '/api/learn/key', { key: 'nope' })).status, 400);
  assert.equal((await s.req('PUT', '/api/learn/key', { key: KEY })).status, 200);
  const g = await s.req('GET', '/api/learn/key');
  assert.deepEqual(g.body, { set: true, source: 'saved', last4: '1234' });
  assert.ok(!g.text.includes('sk-or-'));
  assert.equal(fs.statSync(path.join(s.home, '.vaultos', 'learn.json')).mode & 0o777, 0o600);
  assert.equal((await s.req('DELETE', '/api/learn/key')).status, 200);
  assert.equal((await s.req('GET', '/api/learn/key')).body.set, false);
});

test('image and import errors come back as one line, never a 401', async (t) => {
  const s = await learnServer(t);
  await s.req('POST', '/api/learn/notebooks', { name: 'A' });
  const noKey = await s.req('POST', '/api/learn/image', { notebook: 'Learning/A', from: '', focus: '' });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, 'Add an OpenRouter key in Settings → Learn.');
  assert.equal((await s.req('POST', '/api/learn/image', { notebook: '../Work', from: '' })).status, 400);
  const yt = await s.req('POST', '/api/learn/youtube', { notebook: 'Learning/A', url: 'https://example.com/v' });
  assert.equal(yt.status, 400);
  assert.equal(yt.body.error, 'That isn\'t a YouTube link.');
  assert.equal((await s.req('GET', '/api/learn/youtube/nope')).status, 404);
});

test('turning Learn on in Settings creates the folder and its instructions', async (t) => {
  const s = await learnServer(t, { on: false });
  assert.equal((await s.req('POST', '/api/settings/features', { learn: true })).status, 200);
  assert.ok(fs.existsSync(s.disk('Learning/AGENTS.md')));
  assert.ok(fs.existsSync(s.disk('Learning/CLAUDE.md')));
});

test('start buttons: the default agent, then the first other installed one, with the Learn kickoff', async (t) => {
  const s = await learnServer(t, { env: { TERMINAL: '1' }, bins: ['claude', 'agent'] });
  const r = await s.req('GET', '/api/learn/agents');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.agents.map((a) => [a.id, a.label, a.short]), [['claude', 'Claude Code', 'Claude'], ['cursor', 'Cursor CLI', 'Cursor']]);
  assert.match(r.body.agents[0].command, /^claude 'Tell me which sources this notebook has/);
  assert.match(r.body.agents[1].command, /^agent 'Tell me which sources this notebook has/);
});

test('start buttons: none when terminals are off; only installed agents otherwise', async (t) => {
  const off = await learnServer(t, { bins: ['claude', 'agent'] });
  assert.deepEqual((await off.req('GET', '/api/learn/agents')).body, { agents: [] });
  const one = await learnServer(t, { env: { TERMINAL: '1' }, bins: ['agent'], agent: 'claude' });
  assert.deepEqual((await one.req('GET', '/api/learn/agents')).body.agents.map((a) => a.id), ['cursor']);
});
