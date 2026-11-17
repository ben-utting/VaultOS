'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFake } = require('../scripts/fake-mcp-oauth');

const b64url = (b) => Buffer.from(b).toString('base64url');
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const REDIR = 'http://localhost:7695/api/connectors/atlassian/callback';

// v2 discovery: the MCP server's resource metadata names its authorization server (RFC 9728), whose own metadata
// sits at the RFC 8414 address for its issuer.
async function discover(fake) {
  const prm = await (await fetch(fake.base + '/.well-known/oauth-protected-resource/v2/mcp')).json();
  const as = new URL(prm.authorization_servers[0]);
  const meta = await (await fetch(as.origin + '/.well-known/oauth-authorization-server' + as.pathname)).json();
  return { prm, meta };
}

async function signIn(fake, scope) {
  const { meta } = await discover(fake);
  const reg = await (await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIR], client_name: 'VaultOS' }),
  })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIR, state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', ...(scope ? { scope } : {}) }).forEach(([k, v]) => u.searchParams.set(k, v));
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

const rpc = (fake, token, body, extra = {}) => fetch(fake.base + '/v2/mcp', {
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
  const { prm, meta } = await discover(fake);
  assert.equal(prm.resource, fake.base + '/v2/mcp');
  assert.deepEqual(prm.authorization_servers, [fake.base + '/as']);
  assert.deepEqual(prm.scopes_supported, fake.scopes);
  assert.ok(fake.scopes.includes('offline_access'));
  assert.equal(meta.issuer, fake.base + '/as');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'])
    assert.ok(meta[k].startsWith(fake.base + '/as/'), k);
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
  assert.equal(last.path, '/v2/mcp');
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
  const bad = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');

  fake.setMode('slow-sse');
  const start = Date.now();
  const sl = await rpc(fake, tok.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const ev = sseEvents(await sl.text());
  assert.equal(ev.length, 2);
  assert.ok(Date.now() - start >= 250);
});

test('authorize refuses an unregistered redirect_uri or unknown client', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  const { meta, reg } = await signIn(fake);
  const go = (clientId, uri) => {
    const u = new URL(meta.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: uri, state: 's',
      code_challenge: 'c', code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
    return fetch(u, { redirect: 'manual' });
  };
  assert.equal((await go(reg.client_id, 'http://evil.example/cb')).status, 400);
  assert.equal((await go('nobody', REDIR)).status, 400);
});

test('code exchange refuses a different client_id or redirect_uri', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  const a = await signIn(fake);
  const wrongUri = await fetch(a.meta.token_endpoint, { method: 'POST', headers: FORM,
    body: form({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier,
      client_id: a.reg.client_id, redirect_uri: 'http://evil.example/cb' }) });
  assert.equal(wrongUri.status, 400);
  assert.equal((await wrongUri.json()).error, 'invalid_grant');
  const b = await signIn(fake);
  const wrongClient = await exchange(b.meta, { client_id: 'fake-other' }, b.code, b.verifier);
  assert.equal(wrongClient.status, 400);
  assert.equal((await wrongClient.json()).error, 'invalid_grant');
});

const mcpPost = (url, method, params, headers = {}) => fetch(url, { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

test('noAuth answers tools/list with no Authorization', async (t) => {
  const fake = await startFake({ noAuth: true }); t.after(() => fake.stop());
  const r = await mcpPost(fake.base + '/v1/mcp', 'tools/list');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /atlassianUserInfo/);
  const withAuth = await mcpPost(fake.base + '/v1/mcp', 'tools/list', undefined, { authorization: 'Bearer nope' });
  assert.equal(withAuth.status, 200);
  assert.ok(fake.state.seen.some((s) => s.headers.authorization === 'Bearer nope'));
  const strict = await startFake(); t.after(() => strict.stop());
  assert.equal((await mcpPost(strict.base + '/v1/mcp', 'tools/list')).status, 401);
});

test('get_me returns alex-example', async (t) => {
  const fake = await startFake({ noAuth: true }); t.after(() => fake.stop());
  const r = await mcpPost(fake.base + '/mcp/', 'tools/call', { name: 'get_me', arguments: {} });
  const j = await r.json();
  assert.deepEqual(JSON.parse(j.result.content[0].text), { login: 'alex-example' });
  const l = await (await mcpPost(fake.base + '/mcp/', 'tools/list')).text();
  assert.match(l, /get_me/);
});

test('the MCP endpoint answers at /mcp/ and /api/mcp', async (t) => {
  const fake = await startFake({ noAuth: true }); t.after(() => fake.stop());
  for (const p of ['/mcp/', '/api/mcp', '/v1/mcp', '/v2/mcp']) assert.equal((await mcpPost(fake.base + p, 'tools/list')).status, 200, p);
});

test('v2 takes only OAuth tokens and v1 only API tokens, like Atlassian', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  const { reg, verifier, code, meta } = await signIn(fake);
  const tok = await (await exchange(meta, reg, code, verifier)).json();
  const basic = 'Basic ' + Buffer.from('alex@example.com:tok').toString('base64');
  const list = (p, auth) => mcpPost(fake.base + p, 'tools/list', undefined, { authorization: auth });
  assert.equal((await list('/v2/mcp', 'Bearer ' + tok.access_token)).status, 200);
  assert.equal((await list('/v1/mcp', 'Bearer ' + tok.access_token)).status, 401);
  assert.equal((await list('/v1/mcp', basic)).status, 200);
  assert.equal((await list('/v1/mcp', 'Bearer svc-key')).status, 200);
  const refused = await list('/v2/mcp', basic);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('www-authenticate'), `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/v2/mcp"`);
  assert.equal((await list('/v2/mcp', 'Bearer svc-key')).status, 401);
});

test('there is no authorization-server metadata at the root: only v2 discovery finds it', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  assert.equal((await fetch(fake.base + '/.well-known/oauth-authorization-server')).status, 404);
});

test('authorize records the scope it was asked for', async (t) => {
  const fake = await startFake(); t.after(() => fake.stop());
  await signIn(fake, 'read:me offline_access');
  await signIn(fake);
  assert.deepEqual(fake.state.scopes, ['read:me offline_access', null]);
});

// ----- the Vantage shape -----
async function vantageSignIn(fake) {
  const asm = await (await fetch(fake.base + '/.well-known/oauth-authorization-server')).json();
  const reg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIR], client_name: 'VaultOS' }) })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(asm.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIR, state: 's1', code_challenge: challenge, code_challenge_method: 'S256' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const loc = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location'));
  const tok = await (await exchange(asm, reg, loc.searchParams.get('code'), verifier)).json();
  return { asm, loc, tok };
}

test('the vantage shape hides the path metadata behind an HTML 403 and serves the root documents', async (t) => {
  const fake = await startFake({ shape: 'vantage' }); t.after(() => fake.stop());
  const blocked = await fetch(fake.base + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(blocked.status, 403);
  assert.match(blocked.headers.get('content-type'), /text\/html/);
  assert.match(await blocked.text(), /Cloudflare/);
  assert.deepEqual(await (await fetch(fake.base + '/.well-known/oauth-protected-resource')).json(),
    { resource: fake.base, authorization_servers: [fake.base], bearer_methods_supported: ['header'] });
  const asm = await (await fetch(fake.base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(asm.issuer, fake.base);
  assert.equal(asm.registration_endpoint, fake.base + '/register');
  assert.equal(asm.scopes_supported, undefined);
  const { loc } = await vantageSignIn(fake);
  assert.equal(loc.searchParams.get('iss'), fake.base);
  const anon = await fetch(fake.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('vantage tools/list is SSE with a notification first and the result split over two data lines', async (t) => {
  const fake = await startFake({ shape: 'vantage' }); t.after(() => fake.stop());
  const { tok } = await vantageSignIn(fake);
  const r = await mcpPost(fake.base + '/mcp', 'tools/list', undefined, { authorization: 'Bearer ' + tok.access_token });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = (await r.text()).split('\n\n').filter(Boolean);
  assert.equal(events.length, 2);
  assert.match(events[0], /notifications\/progress/);
  const lines = events[1].split('\n');
  assert.ok(lines.includes('id: 1'));
  const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.equal(data.length, 2);
  const names = JSON.parse(data.join('\n')).result.tools.map((x) => x.name);
  assert.deepEqual(names, ['query-costs', 'list-budgets', 'get-myself', 'list-ingest-tokens', 'create-budget', 'delete-folder']);
});

test('vantage /mcp takes Bearer vt-key', async (t) => {
  const fake = await startFake({ shape: 'vantage' }); t.after(() => fake.stop());
  const r = await mcpPost(fake.base + '/mcp', 'tools/call', { name: 'get-myself', arguments: {} }, { authorization: 'Bearer vt-key' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse((await r.json()).result.content[0].text), { email: 'alex@example.com', workspace: 'Main' });
  assert.equal((await mcpPost(fake.base + '/mcp', 'tools/list', undefined, { authorization: 'Bearer nope' })).status, 401);
});
