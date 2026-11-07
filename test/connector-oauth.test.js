'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFake } = require('../scripts/fake-mcp-oauth');
const o = require('../lib/connector-oauth');

const REDIR = 'http://localhost:7695/api/connectors/atlassian/callback';

async function setup(t) {
  const fake = await startFake(); t.after(() => fake.stop());
  const meta = await o.discover(fake.base);
  return { fake, meta };
}
async function authorize(meta, clientId, challenge) {
  const url = o.authorizeUrl(meta, { clientId, redirectUri: REDIR, state: 'st', challenge });
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return new URL(r.headers.get('location')).searchParams.get('code');
}

test('discover reads the fake\'s metadata', async (t) => {
  const { fake, meta } = await setup(t);
  assert.equal(meta.registration_endpoint, fake.base + '/v1/register');
  assert.equal(meta.token_endpoint, fake.base + '/v1/token');
});

test('discover rejects metadata without registration or S256', async () => {
  const mk = (body) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  await assert.rejects(o.discover('http://x', { fetch: mk({ code_challenge_methods_supported: ['S256'] }) }),
    (e) => e instanceof o.OAuthError && e.code === 'discovery');
  await assert.rejects(o.discover('http://x', { fetch: mk({ registration_endpoint: 'http://x/r', code_challenge_methods_supported: ['plain'] }) }),
    (e) => e.code === 'discovery');
});

test('registerClient sends the exact body', async (t) => {
  const { fake, meta } = await setup(t);
  const seen = [];
  const spy = async (u, init) => { seen.push(JSON.parse(init.body)); return fetch(u, init); };
  const reg = await o.registerClient(meta, REDIR, { fetch: spy });
  assert.match(reg.client_id, /^fake-/);
  assert.equal(reg.redirect_uri, REDIR);
  assert.deepEqual(seen[0], { client_name: 'VaultOS', redirect_uris: [REDIR],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  const post = fake.state.seen.find((s) => s.method === 'POST' && s.path === '/v1/register');
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
  assert.equal(u.origin + u.pathname, fake.base + '/v1/authorize');
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p, { response_type: 'code', client_id: 'c1', redirect_uri: REDIR, state: 'st',
    code_challenge: 'ch', code_challenge_method: 'S256' });
});

test('exchangeCode then refreshTokens, expires_at from the injected now', async (t) => {
  const { fake, meta } = await setup(t);
  const reg = await o.registerClient(meta, REDIR);
  const { verifier, challenge } = o.pkcePair();
  const code = await authorize(meta, reg.client_id, challenge);
  const tok = await o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: REDIR, code, verifier }, { now: () => 1000 });
  assert.equal(tok.expires_at, 1000 + 3600 * 1000);
  assert.ok(tok.access_token && tok.refresh_token);
  const ex = fake.state.seen.filter((s) => s.path === '/v1/token')[0];
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
