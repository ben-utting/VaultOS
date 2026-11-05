'use strict';
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
const REFRESH = 'rt-secret-one';
const ACCESS = 'at-secret-one';

const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 2)); // the sign-in writes a file, so real time must pass
const untilDone = async (svc) => { for (let i = 0; i < 1000 && (await svc.msappStatus('transcripts')).status === 'waiting'; i++) await settle(); };

// One fake answering the login host and Graph. `s` is shared between services built on the same home.
function fakeNet(s = {}) {
  s.log = s.log || [];
  s.refreshMode = s.refreshMode || 'ok';
  const fetch = async (url, init) => {
    const u = String(url);
    s.log.push({ url: u, init });
    if (u.includes('/devicecode')) return reply(200, { device_code: 'dc', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
    if (u.includes('/token')) {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'refresh_token') {
        if (s.refreshMode === 'invalid_grant') return reply(400, { error: 'invalid_grant', error_description: 'AADSTS70008: gone' });
        return reply(200, { access_token: ACCESS, refresh_token: 'rt-secret-two', expires_in: 3600 });
      }
      return reply(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    }
    if (u.includes('/me?')) return reply(200, { id: 'user1', userPrincipalName: 'alex@example.com' });
    if (u.includes('getAllTranscripts')) return reply(200, { value: [{ id: 'tr1', meetingId: 'mt1', createdDateTime: '2026-11-04T10:00:00Z' }] });
    if (u.includes('/onlineMeetings/mt1')) return reply(200, { subject: 'Standup' });
    return reply(404, {});
  };
  s.fetch = fetch;
  return s;
}

function build(home, net, extra = {}) {
  return createConnectorService({
    home, port: 7684, env: {}, fetch: net.fetch, run: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => 1000000, sleep: async () => {}, installedAgents: async () => ['cursor'], ...extra,
  });
}
async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tr-'));
  const net = fakeNet();
  const svc = build(home, net);
  await svc.init();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { svc, home, net };
}
const storeFile = (home) => path.join(home, '.vaultos', 'connectors.json');
const saved = (home) => JSON.parse(fs.readFileSync(storeFile(home), 'utf8')).connectors.transcripts;
const row = async (svc) => (await svc.view()).connectors.find((c) => c.id === 'transcripts');
const cursor = (home) => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers;
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function signIn(svc, ids = { tenantId: TENANT, clientId: CLIENT }) {
  const info = await svc.msappStart('transcripts', ids);
  await untilDone(svc);
  return info;
}

async function post(svc, body) {
  const server = http.createServer(createRelay({ getKey: () => 'k', target: (id) => svc.relayTarget(id) }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/transcripts`, { method: 'POST', headers: { 'x-vaultos-key': 'k', 'content-type': 'application/json' }, body });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  } finally { server.close(); }
}
const listCall = (svc) => post(svc, rpc('tools/call', { name: 'transcripts_list', arguments: {} }));

test('start refuses ids that are not GUIDs, in plain words', async (t) => {
  const { svc } = await setup(t);
  await assert.rejects(svc.msappStart('transcripts', { tenantId: 'x', clientId: CLIENT }), { message: "That doesn't look like a Directory (tenant) ID." });
  await assert.rejects(svc.msappStart('transcripts', { tenantId: TENANT, clientId: 'x' }), { message: "That doesn't look like an Application (client) ID." });
  await assert.rejects(svc.msappStart('github', { tenantId: TENANT, clientId: CLIENT }), /doesn't sign in with an app/);
  assert.strictEqual((await row(svc)).state, 'not-connected');
});

test('enable says to sign in first', async (t) => {
  const { svc } = await setup(t);
  await assert.rejects(svc.enable('transcripts'), /Sign in first\./);
});

test('sign-in: device code, then the store record, mode 0600, and an agent entry with no token in it', async (t) => {
  const { svc, home } = await setup(t);
  assert.strictEqual((await row(svc)).needsAzure, undefined);
  const info = await svc.msappStart('transcripts', { tenantId: TENANT, clientId: CLIENT });
  assert.deepStrictEqual({ url: info.url, code: info.code }, { url: 'https://microsoft.com/devicelogin', code: 'ABCD1234' });
  assert.strictEqual((await row(svc)).state, 'connecting');
  await untilDone(svc);
  assert.deepStrictEqual(await svc.msappStatus('transcripts'), { status: 'done' });
  const r = saved(home);
  assert.strictEqual(r.method, 'msapp');
  assert.strictEqual(r.tenantId, TENANT);
  assert.strictEqual(r.clientId, CLIENT);
  assert.strictEqual(r.refreshToken, REFRESH);
  assert.strictEqual(r.account, 'alex@example.com');
  assert.strictEqual(fs.statSync(storeFile(home)).mode & 0o777, 0o600);
  const v = await row(svc);
  assert.strictEqual(v.state, 'connected');
  assert.strictEqual(v.tenantId, TENANT);
  assert.strictEqual(v.account, 'alex@example.com');
  assert.ok(!JSON.stringify(v).includes(REFRESH));
  const file = fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8');
  assert.strictEqual(cursor(home).transcripts.url, 'http://127.0.0.1:7684/mcp/transcripts');
  assert.ok(!file.includes(REFRESH) && !file.includes(ACCESS));
});

test('a failed start leaves the row signed out with the reason', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tr-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const net = fakeNet();
  const base = net.fetch;
  net.fetch = async (url, init) => (String(url).includes('/devicecode') ? reply(400, { error: 'invalid_client', error_description: 'AADSTS700016: no such app' }) : base(url, init));
  const svc = build(home, net);
  await svc.init();
  await assert.rejects(svc.msappStart('transcripts', { tenantId: TENANT, clientId: CLIENT }), /not found in this directory/);
  const v = await row(svc);
  assert.strictEqual(v.state, 'not-connected');
  assert.match(v.error, /not found in this directory/);
});

test('Entra is unaffected: Azure signed out, transcripts stays connected and Entra stays off', async (t) => {
  const { svc } = await setup(t);
  await signIn(svc);
  const entra = (await svc.view()).connectors.find((c) => c.id === 'entra');
  assert.strictEqual(entra.state, 'not-connected');
  assert.strictEqual(entra.needsAzure, true);
  assert.strictEqual((await row(svc)).state, 'connected');
});

test('the relay serves transcripts_list through the service', async (t) => {
  const { svc } = await setup(t);
  await signIn(svc);
  const list = await post(svc, rpc('tools/list'));
  assert.ok(list.json.result.tools.some((x) => x.name === 'transcripts_list'));
  const res = await listCall(svc);
  assert.match(res.json.result.content[0].text, /Standup · meetingId=mt1 transcriptId=tr1/);
  assert.ok(!JSON.stringify(res.json).includes(ACCESS));
});

test('after a restart the saved sign-in works with no new sign-in (one refresh, the saved token)', async (t) => {
  const { svc, home, net } = await setup(t);
  await signIn(svc);
  net.log.length = 0;
  const second = build(home, net);
  await second.init();
  assert.strictEqual((await row(second)).state, 'connected');
  const res = await listCall(second);
  assert.match(res.json.result.content[0].text, /Standup/);
  const tokenCalls = net.log.filter((l) => l.url.includes('/token'));
  assert.strictEqual(tokenCalls.length, 1);
  const form = new URLSearchParams(String(tokenCalls[0].init.body));
  assert.strictEqual(form.get('grant_type'), 'refresh_token');
  assert.strictEqual(form.get('refresh_token'), REFRESH);
  assert.ok(!net.log.some((l) => l.url.includes('/devicecode')));
  assert.strictEqual(saved(home).refreshToken, 'rt-secret-two', 'the rotated token is stored');
});

test('invalid_grant during a tool call marks the record needs-sign-in', async (t) => {
  const { svc, home, net } = await setup(t);
  await signIn(svc);
  const second = build(home, net);
  await second.init();
  net.refreshMode = 'invalid_grant';
  const res = await listCall(second);
  assert.strictEqual(res.json.result.isError, true);
  assert.strictEqual(saved(home).needsSignIn, true);
  assert.strictEqual((await row(second)).state, 'needs-sign-in');
  assert.strictEqual(second.needsAttention(), true);
});

test('sign-out keeps only the IDs, removes the agent entry, and the row is not-connected with the IDs', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  await svc.disconnect('transcripts');
  assert.deepStrictEqual(saved(home), { method: 'msapp', tenantId: TENANT, clientId: CLIENT });
  assert.strictEqual(cursor(home).transcripts, undefined);
  const v = await row(svc);
  assert.strictEqual(v.state, 'not-connected');
  assert.strictEqual(v.tenantId, TENANT);
  assert.strictEqual(v.clientId, CLIENT);
  const res = await post(svc, rpc('tools/list'));
  assert.match(res.json.result.tools[0].description, /isn't connected/);
  assert.strictEqual((await svc.msappStatus('transcripts')).status, 'idle');
});

test('test() reads /me and records the account', async (t) => {
  const { svc } = await setup(t);
  await assert.rejects(svc.test('transcripts'), /isn't connected yet/);
  await signIn(svc);
  const r = await svc.test('transcripts');
  assert.strictEqual(r.ok, true);
  assert.strictEqual((await row(svc)).account, 'alex@example.com');
});

test('a new sign-in while signed in changes nothing until it completes; cancel keeps the old one', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  await svc.msappStart('transcripts', { tenantId: TENANT, clientId: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.strictEqual(saved(home).clientId, CLIENT);
  assert.strictEqual((await row(svc)).state, 'connected');
  svc.msappCancel('transcripts');
  assert.strictEqual(saved(home).clientId, CLIENT);
  assert.deepStrictEqual(await svc.msappStatus('transcripts'), { status: 'done' });
  assert.match((await listCall(svc)).json.result.content[0].text, /Standup/);
});

test('signing in again with other IDs replaces the saved sign-in on completion', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  const other = '99999999-bbbb-cccc-dddd-eeeeeeeeeeee';
  await signIn(svc, { tenantId: TENANT, clientId: other });
  assert.strictEqual(saved(home).clientId, other);
  assert.strictEqual(saved(home).refreshToken, REFRESH);
  assert.strictEqual(saved(home).account, 'alex@example.com');
});

// Wait until the saved record has a refresh token (the sign-in finished) without calling msappStatus.
const untilSaved = async (home) => { for (let i = 0; i < 1000; i++) { try { if (saved(home) && saved(home).refreshToken) return; } catch { /* not written yet */ } await settle(); } };

test('a finished sign-in nobody polled for shows up in view() with the account and the agent entry', async (t) => {
  const { svc, home } = await setup(t);
  await svc.msappStart('transcripts', { tenantId: TENANT, clientId: CLIENT });
  await untilSaved(home);
  const v = await row(svc);
  assert.strictEqual(v.state, 'connected');
  assert.strictEqual(v.account, 'alex@example.com');
  assert.ok(cursor(home).transcripts);
});

test('a finished sign-in nobody polled for works through a tool call', async (t) => {
  const { svc, home } = await setup(t);
  await svc.msappStart('transcripts', { tenantId: TENANT, clientId: CLIENT });
  await untilSaved(home);
  assert.match((await listCall(svc)).json.result.content[0].text, /Standup/);
});

test('a refresh held open on the replaced app cannot overwrite a same-ID re-sign-in', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tr-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const net = fakeNet();
  const base = net.fetch;
  let release;
  const held = new Promise((r) => { release = r; });
  let hold = false;
  net.fetch = async (url, init) => {
    const form = String(url).includes('/token') ? new URLSearchParams(String(init.body)) : null;
    if (hold && form && form.get('grant_type') === 'refresh_token') {
      hold = false;
      await held;
      return reply(400, { error: 'invalid_grant', error_description: 'AADSTS70008: gone' });
    }
    return base(url, init);
  };
  const svc = build(home, net);
  await svc.init();
  await signIn(svc);
  // a restarted service holds a refreshable app whose access token must be refreshed
  const old = build(home, net);
  await old.init();
  hold = true;
  const pending = listCall(old);
  await settle();
  // re-sign-in on the same service as `old`, same IDs, as a different user
  await old.msappStart('transcripts', { tenantId: TENANT, clientId: CLIENT });
  await untilDone(old);
  release();
  await pending;
  await settle();
  assert.strictEqual(saved(home).needsSignIn, undefined);
  assert.strictEqual(saved(home).refreshToken, REFRESH);
});
