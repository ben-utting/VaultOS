'use strict';
// The terminal-only automation routes (spec §3–§4): loopback + a live terminal's token, automations on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const PASSWORD = 'correct horse battery';
const call = async (base, method, url, { cookie, body, headers = {} } = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const draft = (more = {}) => ({
  name: 'Check', agent: 'claude', template: 'check-in', prompt: 'FAKE:note', level: 'report',
  cards: { board: 'work', statuses: ['in-progress'], subtasks: false },
  schedule: { repeat: 'weekdays', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more,
});

async function ready(t, { automations = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-auto-term-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {});
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { TERMINAL: '1', AUTOMATION_TEST_AGENT: FAKE, TZ: 'Europe/London' } });
  const terms = [];
  t.after(async () => { for (const x of terms) x.close(); await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  if (automations) assert.equal((await call(base, 'POST', '/api/settings/features', { cookie, body: { automations: true } })).status, 200);
  const card = (rel, status = 'in-progress') => {
    const f = path.join(d.vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `---\nid: x\ntitle: "${path.basename(path.dirname(f))}"\nstatus: ${status}\nupdated: 2026-11-01\n---\n\n## Goal\ng\n`);
    return f;
  };
  const term = async () => { const x = await openTerm({ base, cookie }); terms.push(x); return x; };
  const as = (tm, command, args, more = {}) => call(base, 'POST', `/api/term/automations/${command}`, { body: { id: tm.id, token: tm.token, args, ...more } });
  const person = (method, url, body) => call(base, method, url, { cookie, body });
  return { ...d, base, cookie, card, term, as, person };
}

test('a terminal can list, create a draft and see it off', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  assert.deepEqual((await s.as(tm, 'list')).body.automations, []);
  const c = await s.as(tm, 'create', { ...draft(), enabled: true }, { agentHint: ['bash', 'claude'] });
  assert.equal(c.status, 200, c.text);
  const mine = (await s.person('GET', '/api/automations')).body.automations;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].enabled, false);
  assert.equal(mine[0].origin.agent, 'Claude Code');
  const opts = (await s.as(tm, 'options')).body;
  assert.deepEqual(opts.boards.map((b) => b.key), ['work', 'home']);
  assert.equal(opts.limits.trialCards, 3);
  assert.ok(opts.agents.some((a) => a.id === 'claude' && a.levels.includes('work')));
});

test('no token, a wrong token, or another terminal\'s id is 403', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  const bare = await call(s.base, 'POST', '/api/term/automations/list', { body: {} });
  assert.equal(bare.status, 403);
  assert.equal((await s.as({ id: tm.id, token: 'x'.repeat(tm.token.length) }, 'list')).status, 403);
  assert.equal((await s.as({ id: 'someoneelse1', token: tm.token }, 'list')).status, 403);
  // A session cookie is not a terminal token either.
  assert.equal((await call(s.base, 'POST', '/api/term/automations/list', { cookie: s.cookie, body: {} })).status, 403);
});

test('a forwarded-for header doesn\'t stand in for a token', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/term/automations/list', { body: {}, headers: { 'X-Forwarded-For': '127.0.0.1' } });
  assert.equal(r.status, 403);
});

test('with automations switched off every command says Automations are off', { timeout: 30000 }, async (t) => {
  const s = await ready(t, { automations: false });
  const tm = await s.term();
  for (const cmd of ['options', 'list', 'create', 'try']) {
    const r = await s.as(tm, cmd, {});
    assert.equal(r.status, 403, cmd);
    assert.equal(r.body.error, 'Automations are off', cmd);
  }
});

test('an unknown command is a 404', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  assert.equal((await s.as(tm, 'on', {})).status, 404);
  assert.equal((await s.as(tm, 'stop', {})).status, 404);
});

test('the agent label comes from the hint', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  const a = (await s.as(tm, 'create', draft({ name: 'A' }), { agentHint: ['bash', 'cursor-agent'] })).body.automation;
  assert.equal(a.origin.agent, 'Cursor CLI');
  const b = (await s.as(tm, 'create', draft({ name: 'B' }), { agentHint: ['bash', 'node'] })).body.automation;
  assert.equal(b.origin.agent, 'An agent');
  const c = (await s.as(tm, 'create', draft({ name: 'C' }))).body.automation;
  assert.equal(c.origin.agent, 'An agent');
});

test('try queues a trial and the run shows trigger trial', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const f = s.card('Work/1. a/01-x/task.md');
  const before = fs.readFileSync(f, 'utf8');
  const tm = await s.term();
  const { automation } = (await s.as(tm, 'create', draft())).body;
  const r = await s.as(tm, 'try', { id: automation.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.queued, true);
  let run = null;
  for (let i = 0; i < 100 && !(run && run.state !== 'running'); i++) {
    await new Promise((res) => setTimeout(res, 100));
    [run] = (await s.as(tm, 'runs', { automation: automation.id })).body.runs;
  }
  assert.equal(run.trigger, 'trial');
  assert.equal(run.state, 'finished');
  const detail = (await s.as(tm, 'run', { id: run.id })).body;
  assert.equal(detail.cards[0].note, 'Fake note.');
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.equal((await s.as(tm, 'delete', { id: automation.id })).status, 200);
});
