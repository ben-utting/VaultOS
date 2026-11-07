'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer, login } = require('./helpers/server');

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
  return { status: res.status, body: json, text };
};

// A server whose HOME holds a stub `claude` on PATH, set up through its routes
// (board Work). Everything the hook install writes lands in the temp HOME.
async function ready(t, { env = {}, bins = ['claude'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-agent-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  const bin = path.join(d.home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\necho 1.0\n', { mode: 0o755 });
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  t.after(async () => {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  return { ...d, base, cookie, srv };
}

const hookFile = (s) => path.join(s.home, '.claude', 'settings.json');

test('agent claude reports installed and a start command', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  assert.equal(r.status, 200);
  const g = await call(s.base, 'GET', '/api/agent', { cookie: s.cookie });
  assert.equal(g.status, 200);
  assert.equal(g.body.profile, 'claude');
  assert.equal(g.body.installed, true);
  assert.equal(g.body.hooks, 'claude');
  assert.ok(g.body.startCommand.startsWith("claude 'Catch me up on this task"));
  assert.deepEqual(r.body, g.body);
});

test('choosing claude installs the hook once', async (t) => {
  const s = await ready(t);
  fs.rmSync(path.join(s.home, '.claude'), { recursive: true, force: true });   // setup already put it in: Claude Code is installed
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  const first = fs.readFileSync(hookFile(s), 'utf8');
  assert.equal(Object.keys(JSON.parse(first).hooks).length, 8);
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'hooks', 'vaultos-state.js')));
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  assert.equal(fs.readFileSync(hookFile(s), 'utf8'), first);
});

test('custom profile needs {prompt}', async (t) => {
  const s = await ready(t);
  const custom = { label: 'Mine', detect: 'mine', start: 'mine go' };
  const bad = await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'custom', custom } });
  assert.equal(bad.status, 400);
  const ok = await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'custom', custom: { ...custom, start: 'mine {prompt}' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.label, 'Mine');
  assert.equal(ok.body.installed, false);
  assert.equal(ok.body.hooks, null);
});

test('profile none hides the agent', async (t) => {
  const s = await ready(t, { env: { TERMINAL: undefined } });
  const g = await call(s.base, 'GET', '/api/agent', { cookie: s.cookie });
  assert.equal(g.body.profile, 'none');
  for (const k of ['label', 'installed', 'startCommand', 'install', 'login', 'hooks']) assert.equal(g.body[k], null);
  const me = async () => (await call(s.base, 'GET', '/api/me', { cookie: s.cookie })).body.agent;
  assert.equal(await me(), null);
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  const a = await me();
  assert.equal(a.label, 'Claude Code');
  assert.ok(a.startCommand.startsWith("claude '"));
  await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { terminal: false } });
  assert.equal(await me(), null);
});

test('a broken hook file does not fail saving the agent', async (t) => {
  const s = await ready(t);
  fs.mkdirSync(path.join(s.home, '.claude'), { recursive: true });
  fs.writeFileSync(hookFile(s), '{');
  const r = await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.hookError, 'Could not install the Claude status hook');
  assert.equal((await call(s.base, 'GET', '/api/agent', { cookie: s.cookie })).body.profile, 'claude');
  assert.equal(fs.readFileSync(hookFile(s), 'utf8'), '{');
});

test('agent routes need a session', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'GET', '/api/agent')).status, 401);
  assert.equal((await call(s.base, 'GET', '/api/agents')).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/settings/agent', { body: { profile: 'claude' } })).status, 401);
});

// A raw upgrade request, so no pty is ever spawned.
function upgrade(base, cookie) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET /api/term?id=abcdefgh1 HTTP/1.1\r\nHost: ${u.host}\r\nOrigin: ${base}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
    sock.setTimeout(3000, () => { sock.destroy(); });
    sock.on('error', reject);
  });
}

test('terminal off refuses the socket', async (t) => {
  const s = await ready(t, { env: { TERMINAL: undefined } });
  // Control: terminal on, Origin matches, no cookie -> 401, so Origin and terminalOn() passed.
  assert.match(await upgrade(s.base, ''), / 401 /);
  assert.equal((await call(s.base, 'POST', '/api/settings/features', { cookie: s.cookie, body: { terminal: false } })).status, 200);
  assert.match(await upgrade(s.base, s.cookie), / 403 /);
  // Not 404: the route is mounted, the setting is what refuses.
  assert.equal((await call(s.base, 'GET', '/api/settings', { cookie: s.cookie })).body.terminalAllowed, true);
});

test('GET /api/agents lists eight agents with live installed checks and the default', async (t) => {
  const s = await ready(t, { bins: ['claude', 'pi'] });
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'cursor' } });
  const r = await call(s.base, 'GET', '/api/agents', { cookie: s.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.default, 'cursor');
  assert.deepEqual(r.body.agents.map((a) => a.id), ['claude', 'cursor', 'pi', 'codex', 'antigravity', 'copilot', 'opencode', 'kilo']);
  assert.deepEqual(r.body.agents.filter((a) => a.installed).map((a) => a.id), ['claude', 'pi']);
  const cursor = r.body.agents.find((a) => a.id === 'cursor');
  assert.equal(cursor.installed, false);   // the default, not installed: still listed as such
  assert.deepEqual(Object.keys(cursor).sort(), ['hooks', 'id', 'install', 'installed', 'label', 'login', 'loginNote', 'maker', 'tier']);
  assert.equal(r.body.agents.find((a) => a.id === 'pi').loginNote, 'Then type /login');
});

test('GET /api/agents lists a saved custom agent last, by its own label', async (t) => {
  const s = await ready(t);
  const custom = { label: 'My agent', detect: 'claude', start: 'claude {prompt}' };
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'custom', custom } });
  const r = await call(s.base, 'GET', '/api/agents', { cookie: s.cookie });
  const last = r.body.agents[r.body.agents.length - 1];
  assert.equal(r.body.default, 'custom');
  assert.deepEqual([last.id, last.label, last.tier, last.installed], ['custom', 'My agent', 'other', true]);
});

test('the Claude hook goes in when Claude Code is installed but another agent is the default', async (t) => {
  const s = await ready(t, { bins: ['claude', 'pi'] });
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'pi' } });
  fs.rmSync(path.join(s.home, '.claude'), { recursive: true, force: true });   // as if Claude Code was installed after
  await call(s.base, 'GET', '/api/agents', { cookie: s.cookie });
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'hooks', 'vaultos-state.js')));
});

test('making a built-in the default keeps the saved Other agent, and Other can be the default again', async (t) => {
  const s = await ready(t);
  const custom = { label: 'My agent', detect: 'claude', start: 'claude {prompt}' };
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'custom', custom } });
  await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } });
  let r = await call(s.base, 'GET', '/api/agents', { cookie: s.cookie });
  assert.equal(r.body.default, 'claude');
  assert.equal(r.body.agents.find((a) => a.id === 'custom').label, 'My agent');
  assert.equal((await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'custom' } })).status, 200);
  r = await call(s.base, 'GET', '/api/agents', { cookie: s.cookie });
  assert.equal(r.body.default, 'custom');
});
