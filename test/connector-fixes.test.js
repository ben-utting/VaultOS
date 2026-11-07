'use strict';
// The final-review fixes: refresh outcomes, ids that are prototype keys, disconnect order, resource indicators,
// agent config file modes, and the places a failure must not be remembered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startFake } = require('../scripts/fake-mcp-oauth');
const { createConnectorService, ConnectorError } = require('../lib/connector-service');
const o = require('../lib/connector-oauth');
const { cursorWriter, AgentConfigError } = require('../lib/connector-agents');
const { parseDeviceCode } = require('../lib/connector-azure');
const { CONNECTORS } = require('../lib/connectors');

const ORIGIN = 'http://localhost:7684';
const SUB = '11111111-1111-1111-1111-111111111111';

// ----- oauth -----
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body || {}) });
const refreshWith = (f) => o.refreshTokens({ token_endpoint: 'http://x/t' }, { clientId: 'c', refreshToken: 'r' }, { fetch: f, now: () => 0 });

test('refresh: 5xx, 429 and 408 are network failures, never a refused sign-in', async () => {
  for (const status of [500, 503, 429, 408]) {
    await assert.rejects(refreshWith(answer(status, {})), (e) => e instanceof o.OAuthError && e.code === 'network', String(status));
  }
});

test('refresh: 400 and 401 end the sign-in, except a 400 that names a temporary fault', async () => {
  for (const status of [400, 401]) {
    await assert.rejects(refreshWith(answer(status, { error: 'invalid_grant' })), (e) => e.code === 'refresh-refused', String(status));
  }
  await assert.rejects(refreshWith(answer(400, { error: 'temporarily_unavailable' })), (e) => e.code === 'network');
});

test('every OAuth request has a deadline, and a timeout is a network failure', async () => {
  let signal;
  const hang = async (u, init) => { signal = init.signal; const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(refreshWith(hang), (e) => e.code === 'network' && /timed out/.test(e.message));
  assert.ok(signal instanceof AbortSignal);
  let revokeSignal;
  assert.equal(await o.revoke({ token_endpoint: 'http://x/t' }, { clientId: 'c', token: 't' }, { fetch: async (u, init) => { revokeSignal = init.signal; return { ok: true }; } }), true);
  assert.ok(revokeSignal instanceof AbortSignal);
  for (const [name, call] of [
    ['discover', () => o.discover('http://x', { fetch: hang })],
    ['register', () => o.registerClient({ registration_endpoint: 'http://x/r' }, 'http://x/cb', { fetch: hang })],
    ['exchange', () => o.exchangeCode({ token_endpoint: 'http://x/t' }, { clientId: 'c', redirectUri: 'r', code: 'c', verifier: 'v' }, { fetch: hang })],
  ]) await assert.rejects(call(), (e) => e instanceof o.OAuthError, name);
});

test('discover wants https endpoints unless the base itself is http', async () => {
  const meta = (u) => ({ registration_endpoint: u + '/r', authorization_endpoint: u + '/a', token_endpoint: u + '/t', code_challenge_methods_supported: ['S256'] });
  const serve = (u) => async () => ({ ok: true, status: 200, json: async () => meta(u) });
  await assert.rejects(o.discover('https://mcp.example.com', { fetch: serve('http://mcp.example.com') }), (e) => e.code === 'discovery');
  await assert.rejects(o.discover('https://mcp.example.com', { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...meta('https://mcp.example.com'), revocation_endpoint: 'http://x/rev' }) }) }), (e) => e.code === 'discovery');
  assert.ok(await o.discover('https://mcp.example.com', { fetch: serve('https://mcp.example.com') }));
  assert.ok(await o.discover('http://127.0.0.1:5555', { fetch: serve('http://127.0.0.1:5555') }));
});

test('a token response without expires_in lasts an hour; without a refresh token there is none to send later', async () => {
  const f = answer(200, { access_token: 'a' });
  const t = await o.exchangeCode({ token_endpoint: 'http://x/t' }, { clientId: 'c', redirectUri: 'r', code: 'c', verifier: 'v' }, { fetch: f, now: () => 1000 });
  assert.equal(t.expires_at, 1000 + 3600 * 1000);
  assert.equal(t.refresh_token, undefined);
});

test('authorize, exchange and refresh carry the resource (RFC 8707)', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  const meta = await o.discover(fake.base);
  const resource = fake.base + '/v1/mcp';
  const redir = 'http://localhost:7695/api/connectors/atlassian/callback';
  const reg = await o.registerClient(meta, redir);
  const { verifier, challenge } = o.pkcePair();
  const url = o.authorizeUrl(meta, { clientId: reg.client_id, redirectUri: redir, state: 's', challenge, resource });
  assert.equal(new URL(url).searchParams.get('resource'), resource);
  const code = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
  const tok = await o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: redir, code, verifier, resource });
  await o.refreshTokens(meta, { clientId: reg.client_id, refreshToken: tok.refresh_token, resource });
  assert.deepEqual(fake.state.resources, [{ at: 'authorize', resource }, { at: 'authorization_code', resource }, { at: 'refresh_token', resource }]);
});

// ----- service -----
function fakeRun({ listFails = false } = {}) {
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: ['claude', 'az', 'azmcp'].includes(m[1]) ? 0 : 1, stdout: '', stderr: '' };
    if (cmd.startsWith('az account show')) return { code: 0, stdout: JSON.stringify({ user: { name: 'alex@example.com' }, tenantId: '0', id: SUB, name: 'Sub One' }), stderr: '' };
    if (cmd.startsWith('az account list')) {
      if (run.listFails) return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: JSON.stringify([{ id: SUB, name: 'Sub One', isDefault: true }]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls; run.listFails = listFails;
  return run;
}
const fakeSpawn = () => () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}; return p; };

async function setup(t, { fetchWrap, run = fakeRun() } = {}) {
  const fake = await startFake();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-fix-'));
  const time = { t: 1000000 };
  const base = (...a) => globalThis.fetch(...a);
  const svc = createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base },
    fetch: fetchWrap ? fetchWrap(base) : base, run, spawn: fakeSpawn(), now: () => time.t, installedAgents: async () => ['cursor'],
  });
  await svc.init();
  t.after(async () => { await fake.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { fake, home, svc, time, run };
}
async function signIn(svc, nonce = 'n1') {
  const { url } = await svc.atlassianStart({ origin: ORIGIN, nonce });
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await svc.atlassianCallback({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), nonce });
}
const row = async (svc, id) => (await svc.view()).connectors.find((c) => c.id === id);
const cursorFile = (home) => path.join(home, '.cursor/mcp.json');

test('a prototype key is not a connector: a person-facing error, no az logout', async (t) => {
  const { svc, run } = await setup(t);
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(svc.disconnect(id), (e) => e instanceof ConnectorError, id);
    await assert.rejects(svc.test(id), (e) => e instanceof ConnectorError, id);
  }
  assert.ok(!run.calls.some((c) => c.includes('az logout')));
  assert.equal(svc.relayTarget('constructor'), null);
  assert.ok(Object.hasOwn(CONNECTORS, 'atlassian'));
});

test('disconnect deletes the record and syncs the agents before it revokes', async (t) => {
  let atRevoke = null;
  const { svc, home } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    if (init && init.body && /token_type_hint/.test(String(init.body))) {
      atRevoke = { file: fs.readFileSync(cursorFile(home), 'utf8'), store: fs.readFileSync(path.join(home, '.vaultos/connectors.json'), 'utf8') };
    }
    return base(u, init);
  } });
  await signIn(svc);
  assert.match(fs.readFileSync(cursorFile(home), 'utf8'), /atlassian/);
  await svc.disconnect('atlassian');
  assert.ok(atRevoke, 'a revoke was sent');
  assert.doesNotMatch(atRevoke.file, /atlassian/);
  assert.doesNotMatch(atRevoke.store, /access_token/);
});

test('a revoke that fails is noted, and the connector is gone anyway', async (t) => {
  const { svc } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    if (init && init.body && /token_type_hint/.test(String(init.body))) throw new Error('down');
    return base(u, init);
  } });
  await signIn(svc);
  await svc.disconnect('atlassian');
  const a = await row(svc, 'atlassian');
  assert.equal(a.state, 'not-connected');
  assert.match(a.error, /didn't confirm the sign-out/);
});

test('sign-in sends the MCP server as the resource on authorize, exchange', async (t) => {
  const { svc, fake } = await setup(t);
  await signIn(svc);
  const resource = fake.base + '/v1/mcp';
  assert.deepEqual(fake.state.resources, [{ at: 'authorize', resource }, { at: 'authorization_code', resource }]);
});

test('the option cards stay hidden (connecting) while the code exchange runs', async (t) => {
  let during;
  let svcRef;
  const { svc } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    if (init && init.body && /grant_type=authorization_code/.test(String(init.body))) during = (await row(svcRef, 'atlassian')).state;
    return base(u, init);
  } });
  svcRef = svc;
  await signIn(svc);
  assert.equal(during, 'connecting');
  assert.equal((await row(svc, 'atlassian')).state, 'connected');
});

test('a failed early refresh still serves the access token while it is valid, and fails once it has expired', async (t) => {
  let down = false;
  const { svc, time, fake } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    if (down && /grant_type=refresh_token/.test(String((init && init.body) || ''))) return new Response('{}', { status: 503 });
    return base(u, init);
  } });
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  const first = await target.authorization();
  time.t += 3600 * 1000 - 30 * 1000; // inside the refresh window, still valid
  down = true;
  assert.equal(await target.authorization(), first);
  time.t += 60 * 1000; // expired
  await assert.rejects(target.authorization());
  assert.equal(fake.state.refreshes, 0);
  assert.equal((await row(svc, 'atlassian')).state, 'connected', 'a 503 never costs the sign-in');
});

test('a 429 on refresh keeps the sign-in', async (t) => {
  let code = 429;
  const { svc, time } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    if (code && /grant_type=refresh_token/.test(String((init && init.body) || ''))) return new Response('{}', { status: code });
    return base(u, init);
  } });
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  time.t += 3600 * 1000 + 1;
  await assert.rejects(target.authorization());
  assert.equal(svc.needsAttention(), false);
  code = 0;
  assert.match(await target.authorization(), /^Bearer /);
});

test('a token response without a refresh token: no refresh is attempted, the sign-in runs out as needs-sign-in', async (t) => {
  const { svc, time, fake } = await setup(t, { fetchWrap: (base) => async (u, init) => {
    const res = await base(u, init);
    if (init && /grant_type=authorization_code/.test(String(init.body || ''))) {
      const j = await res.json(); delete j.refresh_token;
      return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return res;
  } });
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  time.t += 3600 * 1000 - 30 * 1000;
  assert.match(await target.authorization(), /^Bearer /, 'still valid');
  time.t += 60 * 1000;
  assert.equal(await target.authorization(), null);
  assert.equal(target.missing(), 'expired');
  assert.equal(svc.needsAttention(), true);
  assert.equal(fake.state.refreshes, 0);
  assert.equal((await row(svc, 'atlassian')).state, 'needs-sign-in');
});

test('a 401 after a successful renewal does not lock the sign-in', async (t) => {
  const { svc, fake } = await setup(t);
  await signIn(svc);
  fake.setMode('expire'); // whichever access token is current is refused, even a fresh one
  const r = await svc.test('atlassian');
  assert.equal(r.ok, false);
  assert.equal(fake.state.refreshes, 1);
  assert.equal(svc.needsAttention(), false);
  fake.setMode('normal');
  assert.equal((await svc.test('atlassian')).ok, true);
});

test('a failed subscription listing is not remembered', async (t) => {
  const run = fakeRun({ listFails: true });
  const spawned = [];
  const spawn = () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}; spawned.push(p); return p; };
  const fake = await startFake(); t.after(() => fake.stop());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-fix-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const svc = createConnectorService({ home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base }, run, spawn, installedAgents: async () => [] });
  await svc.init();
  const started = svc.azureStart();
  spawned[0].stdout.write('To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKNPLV to authenticate.');
  await started;
  spawned[0].emit('close', 0);
  await svc.azureStatus();
  assert.deepEqual((await row(svc, 'azure')).subscriptions, []);
  run.listFails = false;
  assert.deepEqual((await row(svc, 'azure')).subscriptions, [{ id: SUB, name: 'Sub One' }]);
});

// ----- agents and azure -----
test('cursor config is written 0600, keeps a stricter mode, and writes through a link', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cur-'));
  try {
    const w = cursorWriter({ home });
    await w.put('azure', { command: '/x', args: [] });
    assert.equal(fs.statSync(cursorFile(home)).mode & 0o777, 0o600);
    fs.chmodSync(cursorFile(home), 0o400);
    await w.put('other', { command: '/y', args: [] });
    assert.equal(fs.statSync(cursorFile(home)).mode & 0o777, 0o400);
    fs.chmodSync(cursorFile(home), 0o644);
    await w.put('third', { command: '/z', args: [] });
    assert.equal(fs.statSync(cursorFile(home)).mode & 0o777, 0o600, 'a looser mode is tightened');

    const real = path.join(home, 'dotfiles-mcp.json');
    fs.writeFileSync(real, '{"mcpServers":{"keep":{"command":"k"}}}', { mode: 0o600 });
    fs.rmSync(cursorFile(home));
    fs.symlinkSync(real, cursorFile(home));
    await w.put('azure', { command: '/x', args: [] });
    assert.ok(fs.lstatSync(cursorFile(home)).isSymbolicLink(), 'the link stays');
    const j = JSON.parse(fs.readFileSync(real, 'utf8'));
    assert.deepEqual(Object.keys(j.mcpServers).sort(), ['azure', 'keep']);
    assert.equal(fs.statSync(real).mode & 0o777, 0o600);

    fs.rmSync(cursorFile(home)); fs.symlinkSync(path.join(home, 'missing.json'), cursorFile(home));
    await assert.rejects(w.put('azure', { command: '/x', args: [] }), AgentConfigError);
    assert.ok(fs.lstatSync(cursorFile(home)).isSymbolicLink());
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a device-code chunk cut inside the code is not a match', () => {
  const head = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKN';
  assert.equal(parseDeviceCode(head), null);
  assert.deepEqual(parseDeviceCode(head + 'PLV to authenticate.'), { url: 'https://login.microsoft.com/device', code: 'DDVRKNPLV' });
});
