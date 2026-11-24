'use strict';
// Automations and connectors, end to end through a real server: a trial with Atlassian ticked reads through the
// relay with a one-off key, a write is refused before it reaches the (fake) upstream, the card is untouched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');
const { startFake } = require('../scripts/fake-mcp-oauth');

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

async function ready(t, { fakeOpts = {}, fakeMode, upstreamEnv = 'CONNECTOR_UPSTREAM_ATLASSIAN' } = {}) {
  const fake = await startFake(fakeOpts);
  if (fakeMode) fake.setMode(fakeMode);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-auto-cx-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {});
  const keyOut = path.join(root, 'key-out.txt');
  const promptOut = path.join(root, 'prompt-out.txt');
  const srv = await startServer({ ...d, env: { TERMINAL: '1', AUTOMATION_TEST_AGENT: FAKE, TZ: 'Europe/London', FAKE_KEY_OUT: keyOut, FAKE_PROMPT_OUT: promptOut, [upstreamEnv]: fake.base } });
  const terms = [];
  t.after(async () => { for (const x of terms) x.close(); await srv.stop(); await fake.stop(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/settings/features', { cookie, body: { automations: true } })).status, 200);
  const f = path.join(d.vault, 'Work', '1. a', '01-x', 'task.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\nid: x\ntitle: "01-x"\nstatus: in-progress\nupdated: 2026-11-01\n---\n\n## Goal\ng\n');
  const term = async () => { const x = await openTerm({ base, cookie }); terms.push(x); return x; };
  const as = (tm, command, args) => call(base, 'POST', `/api/term/automations/${command}`, { body: { id: tm.id, token: tm.token, args } });
  const person = (method, url, body) => call(base, method, url, { cookie, body });
  // Starts a trial of a new automation and waits for its one card's record.
  const trial = async (more) => {
    const tm = await term();
    const { automation } = (await as(tm, 'create', draft(more))).body;
    const r = await as(tm, 'try', { id: automation.id });
    assert.equal(r.status, 200, r.text);
    let run = null;
    for (let i = 0; i < 150 && !(run && run.state !== 'running'); i++) {
      await new Promise((res) => setTimeout(res, 100));
      [run] = (await as(tm, 'runs', { automation: automation.id })).body.runs;
    }
    assert.equal(run.state, 'finished');
    return (await as(tm, 'run', { id: run.id })).body.cards[0];
  };
  return { ...d, base, fake, f, keyOut, promptOut, person, trial, mcpDir: path.join(d.home, '.cache', 'vaultos', 'automation-mcp') };
}

const leftovers = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

test('a trial with Atlassian ticked reads, is refused a write, and changes nothing', { timeout: 60000 }, async (t) => {
  const s = await ready(t, { fakeMode: 'jira' });
  const con = await s.person('POST', '/api/connectors/atlassian/token', { email: 'alex@example.com', token: 'tok' }); assert.equal(con.status, 200, con.text);
  const before = fs.readFileSync(s.f, 'utf8');
  const card = await s.trial({ connectors: ['atlassian'], prompt: 'FAKE:mcp:atlassian:getJiraIssue FAKE:mcp:atlassian:editJiraIssue' });
  assert.match(fs.readFileSync(s.promptOut, 'utf8'), /Connectors: you may look things up in Atlassian through their MCP tools\./);
  assert.match(card.note, /MCP:getJiraIssue:ok/);
  assert.match(card.note, /MCP:editJiraIssue:refused/);
  assert.equal(card.lookups.atlassian.getJiraIssue, 1);
  assert.equal(card.refusedCalls.atlassian.editJiraIssue, 1);
  assert.ok(s.fake.state.calls.includes('getJiraIssue'));
  assert.ok(!s.fake.state.calls.includes('editJiraIssue'));
  assert.equal(fs.readFileSync(s.f, 'utf8'), before);
  assert.deepEqual(leftovers(s.mcpDir), []);
  // The one-off key is dead once the run is over.
  const key = fs.readFileSync(s.keyOut, 'utf8');
  assert.ok(key.length > 8);
  const after = await fetch(`${s.base}/mcp/atlassian`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-VaultOS-Key': key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(after.status, 403);
});

test('an automation with no ticks makes no config and the prompt has no Connectors paragraph', { timeout: 60000 }, async (t) => {
  const s = await ready(t, { fakeMode: 'jira' });
  const con = await s.person('POST', '/api/connectors/atlassian/token', { email: 'alex@example.com', token: 'tok' }); assert.equal(con.status, 200, con.text);
  s.fake.state.calls.length = 0; // connecting listed tools itself
  const card = await s.trial({ prompt: 'FAKE:mcp:atlassian:getJiraIssue' });
  assert.doesNotMatch(fs.readFileSync(s.promptOut, 'utf8'), /Connectors:/);
  assert.match(card.note, /MCP:getJiraIssue:unsupported/);
  assert.equal(card.lookups, undefined);
  assert.equal(card.notSignedIn, undefined);
  assert.equal(fs.existsSync(s.keyOut), false);
  assert.deepEqual(s.fake.state.calls, []);
  assert.deepEqual(leftovers(s.mcpDir), []);
});

test('a run key reaching Vantage with Allow changes on still only sees read tools', { timeout: 60000 }, async (t) => {
  const s = await ready(t, { fakeOpts: { shape: 'vantage' }, upstreamEnv: 'CONNECTOR_UPSTREAM_VANTAGE' });
  assert.equal((await s.person('POST', '/api/connectors/vantage/token', { token: 'vt-key' })).status, 200);
  assert.equal((await s.person('POST', '/api/connectors/vantage/settings', { allowChanges: true })).status, 200);
  const card = await s.trial({ connectors: ['vantage'], prompt: 'FAKE:mcp:vantage:create-budget FAKE:mcp:vantage:query-costs' });
  assert.match(card.note, /MCP:create-budget:refused/);
  assert.match(card.note, /MCP:query-costs:ok/);
  assert.ok(s.fake.state.calls.includes('query-costs'));
  assert.ok(!s.fake.state.calls.includes('create-budget'));
  assert.deepEqual(leftovers(s.mcpDir), []);
});
