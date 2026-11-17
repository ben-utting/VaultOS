'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFake } = require('../scripts/fake-mcp-oauth');
const o = require('../lib/connector-oauth');

const REDIR = 'http://localhost:7695/api/connectors/atlassian/callback';

async function setup(t) {
  const fake = await startFake(); t.after(() => fake.stop());
  const meta = await o.discover(fake.base + '/v2/mcp');
  return { fake, meta };
}
async function authorize(meta, clientId, challenge) {
  const url = o.authorizeUrl(meta, { clientId, redirectUri: REDIR, state: 'st', challenge });
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return new URL(r.headers.get('location')).searchParams.get('code');
}

test('discover follows the MCP server\'s resource metadata to its authorization server', async (t) => {
  const { fake, meta } = await setup(t);
  assert.equal(meta.issuer, fake.base + '/as');
  assert.equal(meta.registration_endpoint, fake.base + '/as/register');
  assert.equal(meta.token_endpoint, fake.base + '/as/token');
  assert.deepEqual(meta.scopes, fake.scopes);
});

// A made-up v2 layout like Atlassian's: resource on one host, authorization server on another, under a path.
const RES = 'https://mcp.example/v2/mcp';
const PRM_URL = 'https://mcp.example/.well-known/oauth-protected-resource/v2/mcp';
const AS = 'https://auth.example/t1';
const ASM_URL = 'https://auth.example/.well-known/oauth-authorization-server/t1';
const goodPrm = () => ({ resource: RES, authorization_servers: [AS], scopes_supported: ['read:me', 'offline_access'] });
const goodAsm = () => ({ issuer: AS, authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/oauth/token',
  registration_endpoint: 'https://auth.example/t1/dcr/register', revocation_endpoint: 'https://auth.example/oauth/revoke', code_challenge_methods_supported: ['S256'] });
function route(map) {
  const asked = [];
  const f = async (u) => {
    asked.push(String(u));
    const body = map[String(u)];
    if (body === undefined) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  f.asked = asked;
  return f;
}
const refusedDiscovery = (e) => e instanceof o.OAuthError && e.code === 'discovery';

test('discover reads both documents at their well-known addresses and keeps the offered scopes', async () => {
  const f = route({ [PRM_URL]: goodPrm(), [ASM_URL]: goodAsm() });
  const meta = await o.discover(RES, { fetch: f });
  assert.deepEqual(f.asked, [PRM_URL, ASM_URL]);
  assert.equal(meta.token_endpoint, 'https://auth.example/oauth/token');
  assert.deepEqual(meta.scopes, ['read:me', 'offline_access']);
});

test('discover refuses resource metadata that is missing or for another resource', async () => {
  await assert.rejects(o.discover(RES, { fetch: route({ [ASM_URL]: goodAsm() }) }), refusedDiscovery);
  const other = { ...goodPrm(), resource: 'https://mcp.example/v1/mcp' };
  await assert.rejects(o.discover(RES, { fetch: route({ [PRM_URL]: other, [ASM_URL]: goodAsm() }) }), refusedDiscovery);
});

test('discover refuses resource metadata that names no authorization server', async () => {
  for (const authorization_servers of [undefined, [], ['']]) {
    await assert.rejects(o.discover(RES, { fetch: route({ [PRM_URL]: { ...goodPrm(), authorization_servers }, [ASM_URL]: goodAsm() }) }), refusedDiscovery);
  }
});

test('discover will not fetch an http authorization server for an https resource', async () => {
  const f = route({ [PRM_URL]: { ...goodPrm(), authorization_servers: ['http://auth.example/t1'] } });
  await assert.rejects(o.discover(RES, { fetch: f }), refusedDiscovery);
  assert.deepEqual(f.asked, [PRM_URL]);
});

test('discover refuses authorization-server metadata for another issuer', async () => {
  const asm = { ...goodAsm(), issuer: 'https://auth.example/someone-else' };
  await assert.rejects(o.discover(RES, { fetch: route({ [PRM_URL]: goodPrm(), [ASM_URL]: asm }) }), refusedDiscovery);
});

// Vantage's layout: the path-specific resource metadata is unusable (a challenge page), the root one names the origin.
const V_PATH = 'https://mcp.example/.well-known/oauth-protected-resource/mcp';
const V_ROOT = 'https://mcp.example/.well-known/oauth-protected-resource';
const V_ASM = 'https://mcp.example/.well-known/oauth-authorization-server';
const vAsm = () => ({ issuer: 'https://mcp.example', authorization_endpoint: 'https://mcp.example/authorize', token_endpoint: 'https://mcp.example/token',
  registration_endpoint: 'https://mcp.example/register', revocation_endpoint: 'https://mcp.example/token', code_challenge_methods_supported: ['S256'] });

test('discover falls back to the root metadata when the path one is unusable', async () => {
  const f = route({ [V_ROOT]: { resource: 'https://mcp.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  const meta = await o.discover('https://mcp.example/mcp', { fetch: f, rootFallback: true });
  assert.equal(meta.resource, 'https://mcp.example');
  assert.deepEqual(meta.scopes, []);
  assert.deepEqual(f.asked, [V_PATH, V_ROOT, V_ASM]);
  const page = async (u) => (String(u) === V_PATH
    ? { ok: true, status: 200, json: async () => { throw new Error('not json'); }, text: async () => '<html>Attention Required</html>' } : f(u));
  assert.equal((await o.discover('https://mcp.example/mcp', { fetch: page, rootFallback: true })).resource, 'https://mcp.example');
});

test('the root metadata must name the origin', async () => {
  const f = route({ [V_ROOT]: { resource: 'https://other.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  await assert.rejects(o.discover('https://mcp.example/mcp', { fetch: f, rootFallback: true }), refusedDiscovery);
});

test('a path metadata for another resource is refused, not skipped', async () => {
  const f = route({ [V_PATH]: { resource: 'https://mcp.example/other', authorization_servers: ['https://mcp.example'] },
    [V_ROOT]: { resource: 'https://mcp.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  await assert.rejects(o.discover('https://mcp.example/mcp', { fetch: f, rootFallback: true }), refusedDiscovery);
  assert.deepEqual(f.asked, [V_PATH]);
});

test('the root fallback is off unless the connector asks for it', async () => {
  const f = route({ [V_ROOT]: { resource: 'https://mcp.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  await assert.rejects(o.discover('https://mcp.example/mcp', { fetch: f }), refusedDiscovery);
  assert.deepEqual(f.asked, [V_PATH]);
});

test('a network failure or a 5xx at the path metadata never falls back, even when asked', async () => {
  const f = route({ [V_ROOT]: { resource: 'https://mcp.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  const down = async (u) => { if (String(u) === V_PATH) throw new Error('ECONNRESET'); return f(u); };
  await assert.rejects(o.discover('https://mcp.example/mcp', { fetch: down, rootFallback: true }), refusedDiscovery);
  const busy = async (u) => (String(u) === V_PATH ? { ok: false, status: 503, json: async () => null, text: async () => '' } : f(u));
  await assert.rejects(o.discover('https://mcp.example/mcp', { fetch: busy, rootFallback: true }), refusedDiscovery);
});

test('issOk accepts no iss or the issuer, and refuses another', () => {
  const meta = { issuer: 'https://a.example' };
  for (const iss of [undefined, null, '', 'https://a.example', 'https://a.example/']) assert.equal(o.issOk(meta, iss), true, String(iss));
  assert.equal(o.issOk(meta, 'https://b.example'), false);
});

test('authorizeUrl sends no scope when none is offered', async () => {
  const f = route({ [V_ROOT]: { resource: 'https://mcp.example', authorization_servers: ['https://mcp.example'] }, [V_ASM]: vAsm() });
  const meta = await o.discover('https://mcp.example/mcp', { fetch: f, rootFallback: true });
  const u = new URL(o.authorizeUrl(meta, { clientId: 'c', redirectUri: REDIR, state: 's', challenge: 'ch', resource: meta.resource }));
  assert.equal(u.searchParams.has('scope'), false);
  assert.equal(u.searchParams.get('resource'), 'https://mcp.example');
});

test('discover rejects metadata without registration or S256', async () => {
  const noReg = { ...goodAsm() }; delete noReg.registration_endpoint;
  await assert.rejects(o.discover(RES, { fetch: route({ [PRM_URL]: goodPrm(), [ASM_URL]: noReg }) }), refusedDiscovery);
  const plain = { ...goodAsm(), code_challenge_methods_supported: ['plain'] };
  await assert.rejects(o.discover(RES, { fetch: route({ [PRM_URL]: goodPrm(), [ASM_URL]: plain }) }), refusedDiscovery);
});

test('registerClient sends the exact body', async (t) => {
  const { fake, meta } = await setup(t);
  const seen = [];
  const spy = async (u, init) => { seen.push(JSON.parse(init.body)); return fetch(u, init); };
  const reg = await o.registerClient(meta, REDIR, { fetch: spy });
  assert.match(reg.client_id, /^fake-/);
  assert.equal(reg.redirect_uri, REDIR);
  assert.equal(reg.issuer, fake.base + '/as', 'a client belongs to the server that registered it');
  assert.deepEqual(seen[0], { client_name: 'VaultOS', redirect_uris: [REDIR],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  const post = fake.state.seen.find((s) => s.method === 'POST' && s.path === '/as/register');
  assert.match(post.headers['content-type'], /application\/json/);
});

test('a refused redirect is OAuthError redirect-refused', async (t) => {
  const { fake, meta } = await setup(t);
  fake.state.refuseRedirect = 'localhost';
  await assert.rejects(o.registerClient(meta, REDIR), (e) => e instanceof o.OAuthError && e.code === 'redirect-refused');
});

test('pkcePair challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = o.pkcePair();
  assert.equal(Buffer.from(verifier, 'base64url').length, 32);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(o.pkcePair().verifier, verifier);
});

test('authorizeUrl carries every parameter', async (t) => {
  const { fake, meta } = await setup(t);
  const u = new URL(o.authorizeUrl(meta, { clientId: 'c1', redirectUri: REDIR, state: 'st', challenge: 'ch' }));
  assert.equal(u.origin + u.pathname, fake.base + '/as/authorize');
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p, { response_type: 'code', client_id: 'c1', redirect_uri: REDIR, state: 'st',
    code_challenge: 'ch', code_challenge_method: 'S256', scope: fake.scopes.join(' ') });
});

test('exchangeCode then refreshTokens, expires_at from the injected now', async (t) => {
  const { fake, meta } = await setup(t);
  const reg = await o.registerClient(meta, REDIR);
  const { verifier, challenge } = o.pkcePair();
  const code = await authorize(meta, reg.client_id, challenge);
  const tok = await o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: REDIR, code, verifier }, { now: () => 1000 });
  assert.equal(tok.expires_at, 1000 + 3600 * 1000);
  assert.ok(tok.access_token && tok.refresh_token);
  const ex = fake.state.seen.filter((s) => s.path === '/as/token')[0];
  assert.match(ex.headers['content-type'], /x-www-form-urlencoded/);
  assert.equal(ex.headers.authorization, undefined);
  const next = await o.refreshTokens(meta, { clientId: reg.client_id, refreshToken: tok.refresh_token }, { now: () => 5000 });
  assert.equal(next.expires_at, 5000 + 3600 * 1000);
  assert.notEqual(next.access_token, tok.access_token);
  assert.equal(fake.state.refreshes, 1);
  await assert.rejects(o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: REDIR, code, verifier }),
    (e) => e.code === 'exchange');
});

test('refreshTokens keeps the old refresh token when none comes back', async () => {
  const meta = { token_endpoint: 'http://x/t' };
  const f = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a2', expires_in: 10 }) });
  const t = await o.refreshTokens(meta, { clientId: 'c', refreshToken: 'old' }, { fetch: f, now: () => 0 });
  assert.deepEqual(t, { access_token: 'a2', refresh_token: 'old', expires_at: 10000 });
});

test('refreshTokens refused is refresh-refused', async (t) => {
  const { fake, meta } = await setup(t);
  const reg = await o.registerClient(meta, REDIR);
  const { verifier, challenge } = o.pkcePair();
  const code = await authorize(meta, reg.client_id, challenge);
  const tok = await o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: REDIR, code, verifier });
  fake.setMode('refuse-refresh');
  await assert.rejects(o.refreshTokens(meta, { clientId: reg.client_id, refreshToken: tok.refresh_token }),
    (e) => e instanceof o.OAuthError && e.code === 'refresh-refused');
});

test('revoke reaches the fake', async (t) => {
  const { fake, meta } = await setup(t);
  assert.equal(await o.revoke(meta, { clientId: 'c', token: 'tok-1' }), true);
  assert.deepEqual(fake.state.revoked, ['tok-1']);
  const down = async () => { throw new Error('down'); };
  assert.equal(await o.revoke(meta, { clientId: 'c', token: 't' }, { fetch: down }), false);
});

test('pending: single use, wrong nonce null, expired null', () => {
  let t = 0;
  const p = o.createPending({ ttlMs: 1000, now: () => t });
  const s = p.add('n1', { a: 1 });
  assert.equal(Buffer.from(s, 'base64url').length, 16);
  assert.equal(p.take('other', s), null);
  assert.deepEqual(p.take('n1', s), { a: 1 });
  assert.equal(p.take('n1', s), null);
  const s2 = p.add('n1', { b: 2 });
  t = 1001;
  assert.equal(p.take('n1', s2), null);
  assert.equal(p.take('n1', 'nope'), null);
});

test('a network failure during refresh is not refresh-refused', async () => {
  const down = async () => { throw new Error('down'); };
  await assert.rejects(o.refreshTokens({ token_endpoint: 'http://x/t' }, { clientId: 'c', refreshToken: 'r' }, { fetch: down }),
    (e) => e instanceof o.OAuthError && e.code === 'network');
});
