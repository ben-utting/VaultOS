'use strict';
// Which agent gets which Microsoft connector, through connector-service.js: VaultOS's read-only ones go to every agent,
// except that Cursor gets Cursor's own (Teams, Outlook, Outlook calendar) while that one is on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const { createConnectorService } = require('../lib/connector-service');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LINK = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback&state=st4te';
const BACK = 'http://localhost:8787/callback?code=one-time&state=st4te';
const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
const settle = () => new Promise((r) => setTimeout(r, 2));

function world(t, { agents = ['cursor', 'copilot', 'opencode'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cu-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spawned = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('exit', null));
    spawned.push({ cmd, args, child });
    setImmediate(() => child.stdout.write(`Opening your browser...\n${LINK}\nListening on http://localhost:8787/callback\n`));
    return child;
  };
  const forwarded = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://localhost:8787/')) { forwarded.push(u); setImmediate(() => spawned[spawned.length - 1].child.emit('exit', 0)); return reply(200, {}); }
    if (u.includes('/devicecode')) return reply(200, { device_code: 'dc', user_code: 'C0DE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
    if (u.includes('/token')) return reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (u.includes('/me?')) return reply(200, { id: 'u1', userPrincipalName: 'alex@example.com' });
    if (u.includes('/me/chats')) return reply(200, { value: [] });
    return reply(404, {});
  };
  let toolsOut = "MCP 'cursor-teams' requires authentication.";
  const run = async (cmd) => (cmd.startsWith('agent mcp list-tools') ? { code: 0, stdout: toolsOut, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const svc = createConnectorService({
    home, port: 8080, env: {}, fetch, run, spawn, now: () => 1000000, sleep: () => new Promise((r) => setImmediate(r)),
    installedAgents: async () => agents,
  });
  const files = {
    cursor: () => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers,
    copilot: () => JSON.parse(fs.readFileSync(path.join(home, '.copilot/mcp-config.json'), 'utf8')).mcpServers,
    opencode: () => JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8')).mcp,
  };
  const row = async (id) => (await svc.view()).connectors.find((c) => c.id === id);
  return { svc, home, files, row, spawned, forwarded, signedIn: (yes) => { toolsOut = yes ? 'Tools:\n- list_chats' : "MCP 'cursor-teams' requires authentication."; } };
}

async function signInChats(svc) {
  await svc.msappStart('teamschats', { tenantId: TENANT, clientId: CLIENT });
  for (let i = 0; i < 1000 && (await svc.msappStatus('teamschats')).status === 'waiting'; i++) await settle();
}

test('Teams chats reaches every installed MCP agent, with the relay entry in each one\'s own shape', async (t) => {
  const w = world(t);
  await w.svc.init();
  await signInChats(w.svc);
  const url = 'http://127.0.0.1:8080/mcp/teamschats';
  assert.strictEqual(w.files.cursor().teamschats.url, url);
  assert.deepStrictEqual({ ...w.files.copilot().teamschats, headers: undefined }, { type: 'http', url, headers: undefined, tools: ['*'] });
  assert.strictEqual(w.files.opencode().teamschats.type, 'remote');
  assert.strictEqual(w.files.opencode().teamschats.url, url);
  const rows = (await w.row('teamschats')).agents;
  assert.deepStrictEqual(rows.map((r) => [r.id, r.chip]), [['claude', 'Not installed'], ['cursor', 'Added'], ['copilot', 'Added'], ['opencode', 'Added']]);
});

test("turning on Teams (Cursor) gives Cursor Cursor's own and takes Teams chats off Cursor only; turning it off brings it back", async (t) => {
  const w = world(t);
  await w.svc.init();
  await signInChats(w.svc);
  const r = await w.svc.cursorStart('cursor-teams');
  assert.strictEqual(r.url, LINK);
  assert.deepStrictEqual(w.spawned[0].args, ['-lc', "agent mcp login 'cursor-teams'"]);
  assert.deepStrictEqual(w.files.cursor()['cursor-teams'], { url: 'https://api.cursor.com/rest-mcp/teams/mcp' });
  assert.strictEqual(w.files.cursor().teamschats, undefined);
  assert.ok(w.files.copilot().teamschats && w.files.opencode().teamschats);
  assert.strictEqual(w.files.copilot()['cursor-teams'], undefined, "Cursor's own goes to Cursor only");

  let row = await w.row('cursor-teams');
  assert.strictEqual(row.state, 'connecting');
  assert.deepStrictEqual(row.login, { url: LINK, port: '8787' });
  assert.deepStrictEqual(row.agents.map((a) => a.id), ['cursor']);
  assert.strictEqual(row.insteadOf, 'Teams chats');
  assert.ok(row.scopes.includes('ChatMessage.Send'));
  const chats = await w.row('teamschats');
  assert.strictEqual(chats.agents.find((a) => a.id === 'cursor').chip, 'Uses Teams (Cursor)');
  assert.strictEqual(chats.cursorAltOn, true);

  w.signedIn(true);
  const tested = await w.svc.cursorFinish('cursor-teams', { url: BACK });
  assert.strictEqual(tested.ok, true);
  assert.deepStrictEqual(w.forwarded, [BACK]);
  row = await w.row('cursor-teams');
  assert.strictEqual(row.state, 'connected');
  assert.strictEqual(row.signedIn, true);
  const stored = fs.readFileSync(path.join(w.home, '.vaultos', 'connectors.json'), 'utf8');
  assert.ok(!stored.includes('one-time') && !stored.includes('st4te'), 'the pasted address is never stored');

  await w.svc.disconnect('cursor-teams');
  assert.strictEqual(w.files.cursor()['cursor-teams'], undefined);
  assert.strictEqual(w.files.cursor().teamschats.url, 'http://127.0.0.1:8080/mcp/teamschats');
  assert.strictEqual((await w.row('cursor-teams')).state, 'not-connected');
});

test('on but not signed in reads "not signed in"; Test finds out from the Cursor CLI', async (t) => {
  const w = world(t);
  await w.svc.init();
  await w.svc.enable('cursor-outlook');
  assert.deepStrictEqual(w.files.cursor()['cursor-outlook'], { url: 'https://api.cursor.com/rest-mcp/outlook/mcp' });
  assert.strictEqual((await w.row('cursor-outlook')).state, 'not-signed-in');
  const res = await w.svc.test('cursor-outlook');
  assert.strictEqual(res.ok, false);
  assert.strictEqual((await w.row('cursor-outlook')).state, 'not-signed-in');
  w.signedIn(true);
  assert.strictEqual((await w.svc.test('cursor-outlook')).ok, true);
  assert.strictEqual((await w.row('cursor-outlook')).state, 'connected');
});

test('a wrong paste is refused in plain words and the sign-in keeps waiting', async (t) => {
  const w = world(t);
  await w.svc.init();
  await w.svc.cursorStart('cursor-teams');
  await assert.rejects(() => w.svc.cursorFinish('cursor-teams', { url: 'https://evil.example/?code=x&state=st4te' }), /isn't the address your browser ended on/);
  assert.deepStrictEqual(w.forwarded, []);
  assert.strictEqual((await w.row('cursor-teams')).state, 'connecting');
  await w.svc.cursorCancel('cursor-teams');
});

test("Cursor's own needs the Cursor CLI, and only Cursor's own take the Cursor sign-in", async (t) => {
  const w = world(t, { agents: ['copilot'] });
  await w.svc.init();
  await assert.rejects(() => w.svc.cursorStart('cursor-teams'), /Install the Cursor CLI first/);
  assert.strictEqual((await w.row('cursor-teams')).needsCursor, true);
  const v = world(t);
  await v.svc.init();
  await assert.rejects(() => v.svc.cursorStart('teamschats'), /isn't one of Cursor's own connectors/);
  await assert.rejects(() => v.svc.cursorStart('constructor'), /Unknown connector/);
});
