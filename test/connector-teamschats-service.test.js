'use strict';
// Teams chats through connector-service.js: its own app sign-in (the shared msapp glue), its own record, and the relay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createConnectorService } = require('../lib/connector-service');
const { createRelay } = require('../lib/connector-relay');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REFRESH = 'rt-chats-one';
const ACCESS = 'at-chats-one';
const CHAT = '19:aaaa@thread.v2';

const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 2));
const untilDone = async (svc, id = 'teamschats') => { for (let i = 0; i < 1000 && (await svc.msappStatus(id)).status === 'waiting'; i++) await settle(); };

// One fake for the login host and Graph. s.deviceMode: 'ok' | 'consent' (the tenant blocks user consent).
function fakeNet(s = {}) {
  s.log = s.log || [];
  s.fetch = async (url, init) => {
    const u = String(url);
    s.log.push({ url: u, init });
    if (u.includes('/devicecode')) return reply(200, { device_code: 'dc', user_code: 'CHAT1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
    if (u.includes('/token')) {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'refresh_token') return reply(200, { access_token: ACCESS, refresh_token: 'rt-chats-two', expires_in: 3600 });
      if (s.deviceMode === 'consent') return reply(400, { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.\r\nTrace ID: t' });
      return reply(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    }
    const g = new URL(u);
    const p = decodeURIComponent(g.pathname);
    if (p === '/v1.0/me') return reply(200, { id: 'user1', userPrincipalName: 'alex@example.com' });
    if (p === '/v1.0/me/chats') return reply(200, { value: [{ id: CHAT, topic: 'Release plan', chatType: 'group', lastUpdatedDateTime: '2026-11-21T15:30:00Z' }] });
    if (p === `/v1.0/me/chats/${CHAT}/messages`) return reply(200, { value: [{ id: '1', messageType: 'message', createdDateTime: '2026-11-21T15:30:00Z', from: { user: { displayName: 'Sam Sample' } }, body: { contentType: 'html', content: '<p>Shipping <b>Thursday</b></p>' }, attachments: [] }] });
    if (p === `/v1.0/me/chats/${CHAT}`) return reply(200, { id: CHAT, topic: 'Release plan', chatType: 'group' });
    if (p.startsWith('/v1.0/me/chats/')) return reply(403, { error: { code: 'Forbidden', message: 'Forbidden' } });
    return reply(404, {});
  };
  return s;
}

function build(home, net) {
  return createConnectorService({
    home, port: 8080, env: {}, fetch: net.fetch, run: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => 1000000, sleep: () => new Promise((r) => setImmediate(r)), installedAgents: async () => ['cursor'],
  });
}
async function setup(t, net = fakeNet()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tc-'));
  const svc = build(home, net);
  await svc.init();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { svc, home, net };
}
const storeFile = (home) => path.join(home, '.vaultos', 'connectors.json');
const record = (home, id = 'teamschats') => JSON.parse(fs.readFileSync(storeFile(home), 'utf8')).connectors[id];
const row = async (svc, id = 'teamschats') => (await svc.view()).connectors.find((c) => c.id === id);
const cursor = (home) => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers;
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function signIn(svc, id = 'teamschats') {
  await svc.msappStart(id, { tenantId: TENANT, clientId: CLIENT });
  await untilDone(svc, id);
}
async function post(svc, body, id = 'teamschats') {
  const server = http.createServer(createRelay({ getKey: () => 'k', target: (x) => svc.relayTarget(x) }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/${id}`, { method: 'POST', headers: { 'x-vaultos-key': 'k', 'content-type': 'application/json' }, body });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  } finally { server.close(); }
}
const textOf = (r) => r.json.result.content[0].text;

test('sign-in asks for exactly User.Read Chat.Read offline_access, as a public client with no secret', async (t) => {
  const { svc, net } = await setup(t);
  await signIn(svc);
  const forms = net.log.filter((l) => /\/(devicecode|token)$/.test(new URL(l.url).pathname)).map((l) => new URLSearchParams(String(l.init.body)));
  assert.ok(forms.length >= 2);
  for (const f of forms) {
    assert.strictEqual(f.get('client_id'), CLIENT);
    assert.strictEqual(f.get('client_secret'), null);
    assert.strictEqual(f.get('client_assertion'), null);
  }
  assert.strictEqual(forms[0].get('scope'), 'User.Read Chat.Read offline_access');
  assert.ok(net.log.some((l) => l.url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`));
});

test('a signed-in record of its own, mode 0600; the agent entry is /mcp/teamschats with no token', async (t) => {
  const { svc, home } = await setup(t);
  assert.strictEqual((await row(svc)).state, 'not-connected');
  await signIn(svc);
  const r = record(home);
  assert.deepStrictEqual({ method: r.method, tenantId: r.tenantId, clientId: r.clientId, refreshToken: r.refreshToken, account: r.account },
    { method: 'msapp', tenantId: TENANT, clientId: CLIENT, refreshToken: REFRESH, account: 'alex@example.com' });
  assert.strictEqual(record(home, 'transcripts'), undefined, 'Teams transcripts is not signed in by it');
  assert.strictEqual(fs.statSync(storeFile(home)).mode & 0o777, 0o600);
  const v = await row(svc);
  assert.strictEqual(v.state, 'connected');
  assert.strictEqual(v.lastTest.ok, true);
  assert.strictEqual(v.lastTest.tools, 3);
  assert.ok(!JSON.stringify(v).includes(REFRESH) && !JSON.stringify(v).includes(ACCESS));
  assert.strictEqual(cursor(home).teamschats.url, 'http://127.0.0.1:8080/mcp/teamschats');
  const file = fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8');
  assert.ok(!file.includes(REFRESH) && !file.includes(ACCESS));
  assert.strictEqual(cursor(home).transcripts, undefined);
});

test('through the relay an agent lists chats and reads one thread; a chat it is not in fails cleanly', async (t) => {
  const { svc } = await setup(t);
  await signIn(svc);
  const tools = await post(svc, rpc('tools/list'));
  assert.deepStrictEqual(tools.json.result.tools.map((x) => x.name), ['chats_list', 'chat_get', 'chats_help']);
  const list = await post(svc, rpc('tools/call', { name: 'chats_list', arguments: {} }));
  assert.match(textOf(list), new RegExp(`Release plan · group · id=${CHAT.replace(/\./g, '\\.')}`));
  const thread = await post(svc, rpc('tools/call', { name: 'chat_get', arguments: { chatId: CHAT } }));
  assert.match(textOf(thread), /\] Sam Sample: Shipping Thursday$/m);
  assert.ok(!JSON.stringify(thread.json).includes(ACCESS));
  const other = await post(svc, rpc('tools/call', { name: 'chat_get', arguments: { chatId: '19:notmine@thread.v2' } }));
  assert.strictEqual(other.json.result.isError, true);
  assert.match(textOf(other), /aren't in it/);
});

test('a tenant that blocks consent: the sign-in fails with the ask-an-admin sentence, nothing is saved', async (t) => {
  const { svc, home } = await setup(t, fakeNet({ deviceMode: 'consent' }));
  await svc.msappStart('teamschats', { tenantId: TENANT, clientId: CLIENT });
  await untilDone(svc);
  const s = await svc.msappStatus('teamschats');
  assert.strictEqual(s.status, 'failed');
  assert.match(s.error, /ask an admin to grant consent for Chat\.Read on your app registration/i);
  const v = await row(svc);
  assert.strictEqual(v.state, 'not-connected');
  assert.match(v.error, /Chat\.Read/);
  assert.ok(!fs.existsSync(storeFile(home)) || !(record(home) || {}).refreshToken);
});

test('Teams chats and Teams transcripts keep separate sign-ins, even on one app registration', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc, 'teamschats');
  await signIn(svc, 'transcripts');
  assert.ok(record(home).refreshToken && record(home, 'transcripts').refreshToken);
  await svc.disconnect('transcripts');
  assert.strictEqual((await row(svc)).state, 'connected');
  assert.strictEqual(record(home).refreshToken, REFRESH);
  assert.strictEqual(cursor(home).teamschats.url, 'http://127.0.0.1:8080/mcp/teamschats');
});

test('sign-out keeps only the IDs and takes it off the agents; the relay then says to connect it', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  await svc.disconnect('teamschats');
  assert.deepStrictEqual(record(home), { method: 'msapp', tenantId: TENANT, clientId: CLIENT });
  assert.strictEqual(cursor(home).teamschats, undefined);
  const v = await row(svc);
  assert.strictEqual(v.state, 'not-connected');
  assert.strictEqual(v.clientId, CLIENT);
  const res = await post(svc, rpc('tools/list'));
  assert.match(res.json.result.tools[0].description, /Teams chats isn't connected/);
});

test('after a restart the saved sign-in is used with one refresh, no new sign-in', async (t) => {
  const { svc, home, net } = await setup(t);
  await signIn(svc);
  net.log.length = 0;
  const second = build(home, net);
  await second.init();
  const list = await post(second, rpc('tools/call', { name: 'chats_list', arguments: {} }));
  assert.match(textOf(list), /Release plan/);
  const tokenCalls = net.log.filter((l) => l.url.endsWith('/token'));
  assert.strictEqual(tokenCalls.length, 1);
  const form = new URLSearchParams(String(tokenCalls[0].init.body));
  assert.strictEqual(form.get('grant_type'), 'refresh_token');
  assert.strictEqual(form.get('scope'), 'User.Read Chat.Read offline_access');
  assert.strictEqual(record(home).refreshToken, 'rt-chats-two');
});
