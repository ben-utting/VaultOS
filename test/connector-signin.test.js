'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startFake } = require('../scripts/fake-mcp-oauth');
const { createConnectorService } = require('../lib/connector-service');

const ORIGIN = 'http://localhost:7684';
const EXPIRED = 'This sign-in link has expired. Start again from VaultOS.';

function fakeRun() {
  return async (cmd) => {
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: m[1] === 'agent' ? 0 : 1, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
}
const fakeSpawn = () => () => {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {};
  return p;
};

async function setup(t, { env = {}, home: givenHome } = {}) {
  const atl = await startFake();
  const vt = await startFake({ shape: 'vantage' });
  const home = givenHome || fs.mkdtempSync(path.join(os.tmpdir(), 'conn-signin-'));
  const time = { t: Date.now() };
  const make = () => createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: atl.base, CONNECTOR_UPSTREAM_VANTAGE: vt.base, ...env },
    fetch: (...a) => globalThis.fetch(...a), run: fakeRun(), spawn: fakeSpawn(), now: () => time.t,
    installedAgents: async () => ['cursor'],
  });
  const svc = make();
  await svc.init();
  t.after(async () => { await atl.stop(); await vt.stop(); if (!givenHome) fs.rmSync(home, { recursive: true, force: true }); });
  return { atl, vt, home, svc, time, make };
}

async function follow(svc, id, { nonce = 'n1', origin = ORIGIN } = {}) {
  const { url } = await svc.signInStart(id, { origin, nonce });
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  return { code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), iss: loc.searchParams.get('iss') || undefined, nonce };
}
const signIn = async (svc, id, opts) => svc.signInCallback(id, await follow(svc, id, opts));
const row = async (svc, id) => (await svc.view()).connectors.find((c) => c.id === id);
const stored = (home) => JSON.parse(fs.readFileSync(path.join(home, '.vaultos/connectors.json'), 'utf8')).connectors;

test('vantage: start, follow the fake, callback; connected with the account', async (t) => {
  const { svc, vt, home } = await setup(t);
  await signIn(svc, 'vantage');
  const r = await row(svc, 'vantage');
  assert.equal(r.state, 'connected');
  assert.equal(r.method, 'oauth');
  assert.equal(r.account, 'alex@example.com · Main');
  assert.deepEqual(vt.state.resources[0], { at: 'authorize', resource: vt.base });
  assert.equal(vt.state.scopes[0], null);
  assert.equal(stored(home).vantage.resource, vt.base);
});

test('vantage: the callback refuses a wrong iss', async (t) => {
  const { svc, home } = await setup(t);
  const cb = await follow(svc, 'vantage');
  await assert.rejects(svc.signInCallback('vantage', { ...cb, iss: 'https://evil.example' }), { message: EXPIRED });
  assert.equal(stored(home).vantage, undefined);
});

test('two sign-ins at once only accept their own state', async (t) => {
  const { svc, home } = await setup(t);
  const a = await follow(svc, 'atlassian');
  await follow(svc, 'vantage');
  await assert.rejects(svc.signInCallback('vantage', a), { message: EXPIRED });
  assert.equal(stored(home).vantage, undefined);
  await svc.signInCallback('atlassian', a);
  assert.equal((await row(svc, 'atlassian')).state, 'connected');
});

test('vantage refresh, and a refused refresh asks to sign in again', async (t) => {
  const { svc, vt, time } = await setup(t);
  await signIn(svc, 'vantage');
  time.t += 3600 * 1000;
  assert.match(await svc.relayTarget('vantage').authorization(), /^Bearer at-/);
  assert.equal(vt.state.refreshes, 1);
  vt.setMode('refuse-refresh');
  time.t += 3600 * 1000;
  assert.equal(await svc.relayTarget('vantage').authorization(), null);
  assert.equal((await row(svc, 'vantage')).state, 'needs-sign-in');
});

test('sign-out revokes at vantage', async (t) => {
  const { svc, vt, home } = await setup(t);
  await signIn(svc, 'vantage');
  const rt = stored(home).vantage.tokens.refresh_token;
  await svc.disconnect('vantage');
  assert.deepEqual(vt.state.revoked, [rt]);
  assert.equal((await row(svc, 'vantage')).state, 'not-connected');
});

test('a refused redirect gives the Vantage sentence and stores nothing', async (t) => {
  const { svc, vt, home } = await setup(t);
  vt.state.refuseRedirect = 'vault.example';
  await assert.rejects(svc.signInStart('vantage', { origin: 'https://vault.example', nonce: 'n' }),
    { message: "Vantage didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost." });
  assert.equal(stored(home).vantage, undefined);
});

test('an Atlassian v2 sign-in made before this release keeps refreshing after a restart', async (t) => {
  const { svc, atl, home, time, make } = await setup(t);
  await signIn(svc, 'atlassian');
  const rec = stored(home).atlassian;
  assert.equal(rec.resource, atl.base + '/v2/mcp');
  assert.equal(rec.client.issuer, atl.base + '/as');
  const again = make();
  await again.init();
  time.t += 3600 * 1000;
  assert.match(await again.relayTarget('atlassian').authorization(), /^Bearer at-/);
  assert.equal(atl.state.refreshes, 1);
});

test('github has no browser sign-in', async (t) => {
  const { svc } = await setup(t);
  await assert.rejects(svc.signInStart('github', { origin: ORIGIN, nonce: 'n' }), { message: "GitHub doesn't sign in with a browser." });
});

test('an unreachable Vantage gives the Vantage start sentence', async (t) => {
  const { svc } = await setup(t, { env: { CONNECTOR_UPSTREAM_VANTAGE: 'http://127.0.0.1:9' } });
  await assert.rejects(svc.signInStart('vantage', { origin: ORIGIN, nonce: 'n' }),
    { message: "Couldn't reach Vantage to start sign-in. Try again, or use an API token." });
});

test('vantage token: refused, then accepted, and never shown', async (t) => {
  const { svc, home } = await setup(t);
  await assert.rejects(svc.saveToken('vantage', { token: 'nope' }), (e) => /^Vantage didn't accept this token \(/.test(e.message));
  await svc.saveToken('vantage', { token: 'vt-key' });
  const r = await row(svc, 'vantage');
  assert.equal(r.state, 'connected');
  assert.equal(r.method, 'token');
  assert.equal(r.account, 'alex@example.com · Main');
  assert.doesNotMatch(JSON.stringify(await svc.view()), /vt-key/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'), /vt-key/);
});

// ----- Vantage's read-only default, through the service's relay target -----
async function relayVantage(svc, body) {
  const { createRelay } = require('../lib/connector-relay');
  const http = require('node:http');
  const handler = createRelay({ getKey: () => 'k', target: (id) => svc.relayTarget(id) });
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp/vantage`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'x-vaultos-key': 'k', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
    return await r.text();
  } finally { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); }
}
const toolsIn = (text) => {
  const data = text.split('\n\n').filter(Boolean).map((e) => e.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'));
  const msg = data.map((d) => JSON.parse(d)).find((m) => m.result && m.result.tools);
  return msg.result.tools.map((x) => x.name);
};

test('Allow changes applies on the next request, both ways', async (t) => {
  const { svc, vt } = await setup(t);
  await svc.saveToken('vantage', { token: 'vt-key' });
  assert.ok(!toolsIn(await relayVantage(svc, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).includes('create-budget'));
  await svc.vantageSettings({ allowChanges: true });
  assert.ok(toolsIn(await relayVantage(svc, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).includes('create-budget'));
  await relayVantage(svc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create-budget', arguments: {} } });
  assert.deepEqual(vt.state.calls.filter((n) => n === 'create-budget'), ['create-budget']);
  await svc.vantageSettings({ allowChanges: false });
  assert.ok(!toolsIn(await relayVantage(svc, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).includes('create-budget'));
});

test('Test counts only the tools agents can see', async (t) => {
  const { svc } = await setup(t);
  await svc.saveToken('vantage', { token: 'vt-key' });
  assert.equal((await row(svc, 'vantage')).lastTest.tools, 3);
  await svc.vantageSettings({ allowChanges: true });
  assert.equal((await svc.test('vantage')).tools, 6);
});
