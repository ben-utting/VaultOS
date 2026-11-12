'use strict';
// Every agent in every terminal, whatever the default (spec 2026-11-12 §3). The bug this pins: with Cursor as the
// default, the 5s sweep wiped the state Claude's hook had just reported, so Claude rows dropped out at once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');

const PASSWORD = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-term-agents-'));
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
  const list = async () => (await call(base, 'GET', '/api/term/list', { cookie })).body;
  const agentOf = async (id) => ((await list()).sessions.find((x) => x.id === id) || {}).agent;
  // Polls until pred(agent) holds (every 300ms, up to ms); the last agent seen either way.
  const until = async (id, pred, ms = 12000) => {
    const end = Date.now() + ms;
    let a;
    while (Date.now() < end) { a = await agentOf(id); if (pred(a)) return a; await sleep(300); }
    return a;
  };
  const setDefault = async (profile) => assert.equal((await call(base, 'POST', '/api/settings/agent', { cookie, body: { profile } })).status, 200);
  const hook = (tm, ev) => call(base, 'POST', '/api/term/agent', { body: { id: tm.id, token: tm.token, hook_event_name: ev, session_id: 's1' } });
  const hookAs = (tm, body) => call(base, 'POST', '/api/term/agent', { body: { id: tm.id, token: tm.token, session_id: 's1', ...body } });
  return { term, list, agentOf, until, setDefault, hook, hookAs };
}

test('Claude and Cursor both stay in the list with Cursor as the default, then with Claude', { timeout: 90000 }, async (t) => {
  const s = await ready(t);
  await s.setDefault('cursor');
  const a = await s.term();
  const b = await s.term();
  a.send({ t: 'in', d: '(exec -a claude sleep 120)\r' });
  b.send({ t: 'in', d: '(exec -a agent sleep 120)\r' });
  await sleep(800);
  assert.equal((await s.hook(a, 'SessionStart')).status, 200);

  const ca = await s.until(a.id, (x) => x && x.state === 'idle');
  assert.deepEqual(ca && { state: ca.state, kind: ca.kind, label: ca.label }, { state: 'idle', kind: 'claude', label: 'Claude' });
  const cb = await s.until(b.id, (x) => x && x.kind === 'cursor');
  assert.equal(cb && cb.label, 'Cursor');
  assert.ok(['working', 'idle'].includes(cb.state), cb.state);
  assert.equal(typeof (await s.list()).now, 'number');

  await sleep(6000);   // at least one full sweep (every 5s): before the fix, Claude's state was gone by now
  const after = await s.agentOf(a.id);
  assert.equal(after && after.kind, 'claude', 'the Claude agent is still listed after a sweep');
  assert.equal(after.state, 'idle');
  assert.equal(after.since, ca.since, 'since does not move without a change');

  assert.equal((await s.hook(a, 'UserPromptSubmit')).status, 200);
  assert.equal((await s.agentOf(a.id)).state, 'working');

  await s.setDefault('claude');
  await sleep(6000);
  const cb2 = await s.agentOf(b.id);
  assert.equal(cb2 && cb2.kind, 'cursor', 'Cursor is still detected with Claude as the default');

  b.send({ t: 'in', d: '\x03' });
  const gone = await s.until(b.id, (x) => x === null);
  assert.equal(gone, null, 'the Cursor row goes once it exits');
});

// Final review: a wrapper script that doesn't exec leaves bash as the foreground process (argv[0] 'bash', the same
// name as the shell), which read as "nothing running": the agent never showed and Claude's hook state was wiped.
test('an agent run by a wrapper script that does not exec is found, and Claude keeps its hook state', { timeout: 60000 }, async (t) => {
  const s = await ready(t);
  await s.setDefault('cursor');
  const a = await s.term();
  const b = await s.term();
  const wrap = (name) => `mkdir -p "$HOME/w" && printf '#!/bin/bash\\nsleep 120\\n' > "$HOME/w/${name}" && chmod +x "$HOME/w/${name}" && "$HOME/w/${name}"\r`;
  a.send({ t: 'in', d: wrap('claude') });
  b.send({ t: 'in', d: wrap('agent') });
  await sleep(1000);
  assert.equal((await s.hook(a, 'SessionStart')).status, 200);
  const ca = await s.until(a.id, (x) => x && x.kind === 'claude');
  assert.equal(ca && ca.state, 'idle');
  const cb = await s.until(b.id, (x) => x && x.kind === 'cursor');
  assert.equal(cb && cb.label, 'Cursor');
  await sleep(6000);
  const after = await s.agentOf(a.id);
  assert.equal(after && after.kind, 'claude', 'still listed after a sweep');
  assert.equal(after.state, 'idle');
});

// Round 2: Cursor's own hook events (agent: cursor) drive its row; it stays Cursor through a sweep.
test('Cursor\'s hook events give it idle, working and done, labelled Cursor', { timeout: 60000 }, async (t) => {
  const s = await ready(t);
  await s.setDefault('claude');
  const c = await s.term();
  c.send({ t: 'in', d: '(exec -a agent sleep 120)\r' });
  await sleep(800);
  const post = (ev, x = {}) => s.hookAs(c, { agent: 'cursor', hook_event_name: ev, ...x });
  assert.equal((await post('sessionStart')).status, 200);
  let a = await s.until(c.id, (x) => x && x.state === 'idle' && x.kind === 'cursor');
  assert.equal(a && a.label, 'Cursor');
  await post('beforeSubmitPrompt');
  a = await s.agentOf(c.id);
  assert.deepEqual([a.state, a.kind], ['working', 'cursor']);
  await post('stop', { status: 'completed' });
  a = await s.agentOf(c.id);
  assert.deepEqual([a.state, a.kind], ['done', 'cursor']);
  await sleep(6000);   // a sweep: the hook's done stands, still Cursor
  a = await s.agentOf(c.id);
  assert.deepEqual([a.state, a.kind], ['done', 'cursor']);
  await post('sessionEnd');
  assert.equal(await s.agentOf(c.id), null);
});
