'use strict';
// A terminal's space (spaces +, spec 2026-11-11-terminal-spaces-plus §4): sent on every connect, kept and listed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');

const PASSWORD = 'correct horse battery';
const call = async (base, method, url, { cookie, body } = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
};

async function ready(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-term-space-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {});
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { TERMINAL: '1' } });
  const open = [];
  t.after(async () => { for (const x of open) x.close(); await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  const term = async (o) => { const x = await openTerm({ base, cookie }, o); open.push(x); return x; };
  const listed = async (id) => (await call(base, 'GET', '/api/term/list', { cookie })).body.sessions.find((x) => x.id === id);
  return { base, cookie, term, listed };
}

test('a terminal opened with a space lists it', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term({ query: { space: 'ab12', spaceName: 'Space 2' } });
  const row = await s.listed(tm.id);
  assert.equal(row.space, 'ab12');
  assert.equal(row.spaceName, 'Space 2');
  const plain = await s.term();
  const r2 = await s.listed(plain.id);
  assert.equal(r2.space, '');
  assert.equal(r2.spaceName, '');
});

test('a reattach with another space replaces it, an empty one clears it, none keeps it', { timeout: 40000 }, async (t) => {
  const s = await ready(t);
  const first = await s.term({ query: { space: 'ab12', spaceName: 'Space 2' } });
  await first.detach();
  const again = await s.term({ id: first.id, query: { space: 'cd34', spaceName: 'Space 3' } });
  assert.equal((await s.listed(first.id)).space, 'cd34');
  await again.detach();
  const old = await s.term({ id: first.id });   // an old page: no space parameter at all
  assert.equal((await s.listed(first.id)).space, 'cd34');
  assert.equal((await s.listed(first.id)).spaceName, 'Space 3');
  await old.detach();
  await s.term({ id: first.id, query: { space: '', spaceName: '' } });
  assert.equal((await s.listed(first.id)).space, '');
});

test('bad space values are dropped', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const a = await s.term({ query: { space: 'a b', spaceName: 'Sp\u0007ace\u001b 2' } });
  const ra = await s.listed(a.id);
  assert.equal(ra.space, '');
  assert.equal(ra.spaceName, 'Space 2');
  const b = await s.term({ query: { space: 'x'.repeat(41), spaceName: 'n'.repeat(50) } });
  const rb = await s.listed(b.id);
  assert.equal(rb.space, '');
  assert.equal(rb.spaceName, 'n'.repeat(40));
});

test('/api/me has the plain agent command', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'POST', '/api/settings/agent', { cookie: s.cookie, body: { profile: 'claude' } })).status, 200);
  const me = (await call(s.base, 'GET', '/api/me', { cookie: s.cookie })).body;
  assert.equal(me.agent.plainCommand, 'claude');
  assert.ok(me.agent.startCommand.startsWith("claude 'Catch me up"));
});
