'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/connector-entra');

const TOKEN = 'eyJhbGciOi.payload.sig';
const ok = (stdout = TOKEN) => async () => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function make(over = {}) {
  const calls = [];
  const fetch = over.fetch || (async (url, init) => { calls.push({ url: String(url), init }); return reply(200, { value: [{ displayName: 'Acme' }] }); });
  const entra = E.createEntra({ run: over.run || ok(), fetch, now: over.now });
  return { entra, calls };
}
const call = (entra, name, args) => entra.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r) => r.result.content[0].text;

test('resolveTarget accepts allowed areas, with or without /v1.0', () => {
  assert.deepEqual(E.resolveTarget('/users'), { path: '/users', search: '' });
  assert.equal(E.resolveTarget('users/abc/memberOf').path, '/users/abc/memberOf');
  assert.equal(E.resolveTarget('/v1.0/groups').path, '/groups');
  assert.equal(E.resolveTarget('https://graph.microsoft.com/v1.0/users?$top=5&$skiptoken=x').search, '?$top=5&$skiptoken=x');
});

test('an encoded dot-dot is resolved by the URL parser, so it can only land on an allowed area', () => {
  assert.equal(E.resolveTarget('/%2e%2e/users').path, '/users');
  assert.throws(() => E.resolveTarget('/%2e%2e/sendMail'), E.EntraError);
});

test('policies, identity, consent grants and reports are readable; the write-ish and mail areas still are not', () => {
  for (const ok of ['/policies/conditionalAccessPolicies', '/identity/conditionalAccess/policies', '/oauth2PermissionGrants', '/reports/authenticationMethods/userRegistrationDetails']) {
    assert.doesNotThrow(() => E.resolveTarget(ok), ok);
  }
  for (const bad of ['/me/messages/../../sendMail', '/security/alerts', '/identityGovernance/x', '/policiesX']) assert.throws(() => E.resolveTarget(bad), E.EntraError, bad);
});

test('resolveTarget refuses other areas, hosts, versions, traversal and batching', () => {
  for (const bad of ['/me/../sendMail', '/sendMail', '/$batch', '/beta/users', '/v2/users',
    'https://evil.example/v1.0/users', 'http://graph.microsoft.com.evil.example/v1.0/users', '', '  ', 5, null]) {
    assert.throws(() => E.resolveTarget(bad), E.EntraError, String(bad));
  }
});

test('buildUrl adds only $ options and rejects the rest', () => {
  const u = E.buildUrl({ path: '/users', query: { $select: 'displayName', $top: 5 } });
  assert.equal(u.searchParams.get('$select'), 'displayName');
  assert.equal(u.searchParams.get('$top'), '5');
  for (const q of [{ foo: 'x' }, { $a: { b: 1 } }, ['$top'], 'x']) assert.throws(() => E.buildUrl({ path: '/users', query: q }), E.EntraError);
});

test('tools/list offers graph_get and graph_help; initialize and ping answer; notifications return nothing', async () => {
  const { entra } = make();
  const list = await entra.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['graph_get', 'graph_help']);
  const init = await entra.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual((await entra.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  assert.equal(await entra.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await entra.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601);
  assert.equal((await entra.handle([])).error.code, -32600);
});

test('graph_get sends one GET with the token and eventual consistency for filters', async () => {
  const { entra, calls } = make();
  const r = await call(entra, 'graph_get', { path: '/users', query: { $filter: "startswith(displayName,'A')" } });
  assert.ok(!r.result.isError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers.consistencylevel, 'eventual');
  assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\?/);
});

test('graph_get never makes a request for a refused path, and says why', async () => {
  const { entra, calls } = make();
  const r = await call(entra, 'graph_get', { path: '/me/../sendMail' });
  assert.equal(r.result.isError, true);
  assert.equal(calls.length, 0);
  const m = await call(entra, 'graph_get', { path: '/sendMail' });
  assert.match(textOf(m), /not available/);
});

test('no tool can write: only GET is ever sent, whatever the arguments', async () => {
  const { entra, calls } = make();
  await call(entra, 'graph_get', { path: '/users', method: 'DELETE', body: '{}' });
  await call(entra, 'graph_get', { path: '/groups', query: { $top: 1 } });
  assert.ok(calls.length === 2 && calls.every((c) => c.init.method === 'GET' && c.init.body === undefined));
});

test('a Graph error comes back as a tool error with its message; 403 adds a hint', async () => {
  const { entra } = make({ fetch: async () => reply(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }) });
  const r = await call(entra, 'graph_get', { path: '/auditLogs/signIns' });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /answered 403\. Authorization_RequestDenied: Insufficient privileges.*does not carry the permission/);
});

test('a 401 gets one retry with a fresh token', async () => {
  let n = 0, tokens = 0;
  const run = async () => ({ code: 0, stdout: `eyJtok${++tokens}.a.b\n`, stderr: '' });
  const { entra } = make({ run, fetch: async (url, init) => (++n === 1 ? reply(401, {}) : reply(200, { id: init.headers.authorization })) });
  const r = await call(entra, 'graph_get', { path: '/me' });
  assert.ok(!r.result.isError);
  assert.match(textOf(r), /eyJtok2/);
});

test('the token is reused for ten minutes, then fetched again', async () => {
  let t = 1000, runs = 0;
  const run = async () => { runs++; return { code: 0, stdout: TOKEN, stderr: '' }; };
  const { entra } = make({ run, now: () => t });
  await call(entra, 'graph_get', { path: '/me' });
  await call(entra, 'graph_get', { path: '/me' });
  assert.equal(runs, 1);
  t += 11 * 60 * 1000;
  await call(entra, 'graph_get', { path: '/me' });
  assert.equal(runs, 2);
});

test('when az has no usable sign-in the tool says to sign in to Azure again', async () => {
  const { entra, calls } = make({ run: async () => ({ code: 1, stdout: '', stderr: 'Please run az login' }) });
  const r = await call(entra, 'graph_get', { path: '/me' });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /sign in to Azure again/);
  assert.equal(calls.length, 0);
});

test('a token never appears in a reply, even if az prints a warning around it', async () => {
  const { entra } = make({ run: async () => ({ code: 0, stdout: 'WARNING: x\n' + TOKEN, stderr: '' }) });
  const r = await call(entra, 'graph_get', { path: '/me' });
  assert.equal(r.result.isError, true); // not a bare token: refused rather than sent
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('long answers are cut and say how to narrow them', async () => {
  const { entra } = make({ fetch: async () => reply(200, 'x'.repeat(200 * 1024)) });
  const r = await call(entra, 'graph_get', { path: '/users' });
  assert.ok(textOf(r).length < 101 * 1024 + 200);
  assert.match(textOf(r), /\$select/);
});

test('probe reports the organisation, and the tool count; a failure carries the reason', async () => {
  const good = await make().entra.probe();
  assert.deepEqual(good, { ok: true, tools: 2, error: null, org: 'Acme' });
  const bad = await make({ run: async () => ({ code: 1, stdout: '', stderr: '' }) }).entra.probe();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Azure again/);
});
