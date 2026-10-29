'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFake } = require('../scripts/fake-mcp-oauth');

const b64url = (b) => Buffer.from(b).toString('base64url');
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const REDIR = 'http://localhost:7695/api/connectors/atlassian/callback';

async function signIn(fake) {
  const meta = await (await fetch(fake.base + '/.well-known/oauth-authorization-server')).json();
  const reg = await (await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIR], client_name: 'VaultOS' }),
  })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIR, state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIR);
  assert.equal(loc.searchParams.get('state'), 's1');
  return { meta, reg, verifier, code: loc.searchParams.get('code') };
}

const exchange = (meta, reg, code, verifier) => fetch(meta.token_endpoint, {
  method: 'POST', headers: FORM,
  body: form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIR }),
});

const rpc = (fake, token, body, extra = {}) => fetch(fake.base + '/v1/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra },
  body: JSON.stringify(body),
});

const sseEvents = (t) => t.split('\n\n').map((e) => e.split('\n').filter((l) => l.startsWith('data:'))
  .map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));

test('the full code flow yields a token that tools/list accepts', async (t) => {
  const fake = await startFake();
  t.after(() => fake.stop());
  const meta = await (await fetch(fake.base + '/.well-known/oauth-authorization-server')).json();
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'])
    assert.ok(meta[k].startsWith(fake.base), k);
  const { reg, verifier, code, meta: m } = await signIn(fake);
  assert.match(reg.client_id, /^fake-\d+$/);
  const tr = await exchange(m, reg, code, verifier);
  assert.equal(tr.status, 200);
  const tok = await tr.json();
  assert.ok(tok.access_token && tok.refresh_token && tok.expires_in > 0);

  const r = await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { 'mcp-session-id': 'abc', 'x-vaultos-key': 'k' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.equal(r.headers.get('mcp-session-id'), 'abc');
  const ev = sseEvents(await r.text());
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, 7);
  assert.deepEqual(ev[0].result.tools.map((x) => x.name), ['atlassianUserInfo', 'getAccessibleAtlassianResources']);
  const last = fake.state.seen[fake.state.seen.length - 1];
  assert.equal(last.method, 'POST');
  assert.equal(last.path, '/v1/mcp');
  assert.equal(last.headers['x-vaultos-key'], 'k');

  const call = await (await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'atlassianUserInfo' } })).json();
  assert.equal(call.id, 8);
  assert.match(JSON.stringify(call.result), /alex@example.com/);
  const res = await (await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'getAccessibleAtlassianResources' } })).json();
  assert.match(JSON.stringify(res.result), /example\.atlassian\.net/);
  const init = await (await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
  assert.equal(init.id, 1);
  assert.equal((await rpc(fake, tok.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

test('a wrong verifier is refused', async (t) => {
  const fake = await startFake();
  t.after(() => fake.stop());
  const { reg, code, meta } = await signIn(fake);
  const r = await exchange(meta, reg, code, 'not-the-verifier');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid_grant');
});

test('expire then refresh gives a working token and counts one refresh', async (t) => {
  const fake = await startFake();
  t.after(() => fake.stop());
  const { reg, verifier, code, meta } = await signIn(fake);
  const tok = await (await exchange(meta, reg, code, verifier)).json();
  fake.setMode('expire');
  assert.equal((await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  fake.setMode('normal');
  const rr = await fetch(meta.token_endpoint, { method: 'POST', headers: FORM,
    body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
  assert.equal(rr.status, 200);
  const t2 = await rr.json();
  assert.equal(fake.state.refreshes, 1);
  assert.equal((await rpc(fake, t2.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
  assert.equal((await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);
});

test('refuse-refresh, revoke, basic and service keys, refused redirects, slow-sse', async (t) => {
  const fake = await startFake();
  t.after(() => fake.stop());
  const { reg, verifier, code, meta } = await signIn(fake);
  const tok = await (await exchange(meta, reg, code, verifier)).json();
  fake.setMode('refuse-refresh');
  const rr = await fetch(meta.token_endpoint, { method: 'POST', headers: FORM,
    body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }) });
  assert.equal(rr.status, 400);
  fake.setMode('normal');

  const basic = 'Basic ' + Buffer.from('<b>x</b>@example.com:tok').toString('base64');
  const call = (auth, name) => fetch(fake.base + '/v1/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }) });
  const b = await call(basic, 'atlassianUserInfo');
  assert.equal(b.status, 200);
  assert.match(JSON.stringify(await b.json()), /<b>x<\/b>@example\.com/);
  const s = await call('Bearer svc-key', 'atlassianUserInfo');
  assert.equal(s.status, 200);
  assert.match(JSON.stringify(await s.json()), /alex@example\.com/);
  assert.equal((await call('Basic ' + Buffer.from('a@example.com:nope').toString('base64'), 'x')).status, 401);
  assert.equal((await rpc(fake, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);

  const rv = await fetch(meta.token_endpoint, { method: 'POST', headers: FORM,
    body: form({ token: tok.refresh_token, token_type_hint: 'refresh_token' }) });
  assert.equal(rv.status, 200);
  assert.deepEqual(fake.state.revoked, [tok.refresh_token]);

  fake.state.refuseRedirect = 'evil.example';
  const bad = await fetch(fake.base + '/v1/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');

  fake.setMode('slow-sse');
  const start = Date.now();
  const sl = await rpc(fake, 'svc-key', { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const ev = sseEvents(await sl.text());
  assert.equal(ev.length, 2);
  assert.ok(Date.now() - start >= 250);
});
