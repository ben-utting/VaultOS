'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startFake } = require('../scripts/fake-mcp-oauth');
const o = require('../lib/connector-oauth');
const R = require('../lib/connector-relay');

const KEY = 'test-key-1234';
const REDIR = 'http://localhost:7695/api/connectors/atlassian/callback';
const basic = 'Basic ' + Buffer.from('alex@example.com:tok').toString('base64');
const msg = (method, id, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const SIGN_IN = R.messages.notConnected('Atlassian');
const RUN_OUT = R.messages.expired('Atlassian');

function stubTarget(fake, over = {}) {
  const t = {
    label: 'Atlassian', url: fake.base + '/v1/mcp', marked: 0, renews: 0, kind: 'not-connected',
    authorization: async () => 'Bearer svc-key',
    renew: async (rejected) => { t.rejected = rejected; t.renews++; return null; },
    markNeedsSignIn: () => { t.marked++; },
    missing: () => t.kind,
    ...over,
  };
  return t;
}

// A relay on a real loopback server. `peer` overrides the socket's remote address.
async function startRelay(t, { target, key = KEY, peer, fetch: fetchFn } = {}) {
  const log = [];
  const handler = R.createRelay({ getKey: () => key, target: (id) => (id === 'atlassian' ? target : null), log: (m) => log.push(m), ...(fetchFn ? { fetch: fetchFn } : {}) });
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (peer) Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
    handler(req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => { for (const s of sockets) s.destroy(); server.close(ok); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, body, headers = {}, path = '/mcp/atlassian') => fetch(base + path, {
    method, body, headers: { 'x-vaultos-key': KEY, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  });
  return { base, call, log, port: server.address().port };
}

async function setupFake(t) {
  const fake = await startFake(); t.after(() => fake.stop());
  return fake;
}

async function liveTokens(fake) {
  const meta = await o.discover(fake.base);
  const reg = await o.registerClient(meta, REDIR);
  const { verifier, challenge } = o.pkcePair();
  const r = await fetch(o.authorizeUrl(meta, { clientId: reg.client_id, redirectUri: REDIR, state: 's', challenge }), { redirect: 'manual' });
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const tokens = await o.exchangeCode(meta, { clientId: reg.client_id, redirectUri: REDIR, code, verifier });
  return { meta, clientId: reg.client_id, tokens };
}

test('refuses a non-loopback peer', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake), peer: '172.17.0.1' });
  const r = await relay.call('POST', msg('tools/list', 1));
  assert.equal(r.status, 403);
  assert.equal(fake.state.seen.length, 0);
  await relay.call('POST', msg('tools/list', 2));
  assert.equal(relay.log.length, 1, 'refused peer logged at most once a minute');
});

test('isLoopback and keyMatches', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(R.isLoopback(a), true);
  for (const a of ['172.17.0.1', '::ffff:10.0.0.1', '', undefined]) assert.equal(R.isLoopback(a), false);
  assert.equal(R.keyMatches('abc', 'abc'), true);
  assert.equal(R.keyMatches('abd', 'abc'), false);
  assert.equal(R.keyMatches('ab', 'abc'), false);
  assert.equal(R.keyMatches(undefined, 'abc'), false);
  assert.equal(R.keyMatches('abc', ''), false);
});

test('refuses a missing or wrong key, and never sends the key upstream', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake) });
  assert.equal((await relay.call('POST', msg('tools/list', 1), { 'x-vaultos-key': 'wrong' })).status, 403);
  const noKey = await fetch(relay.base + '/mcp/atlassian', { method: 'POST', body: msg('tools/list', 1) });
  assert.equal(noKey.status, 403);
  assert.equal(fake.state.seen.length, 0);
  const ok = await relay.call('POST', msg('tools/list', 1), {
    cookie: 'a=b', 'x-forwarded-for': '1.2.3.4', authorization: 'Bearer agent-secret', 'x-other': 'z', 'mcp-session-id': 'sess-1',
  });
  assert.equal(ok.status, 200);
  await ok.text();
  const h = fake.state.seen[0].headers;
  for (const k of ['x-vaultos-key', 'cookie', 'x-forwarded-for', 'x-other']) assert.equal(h[k], undefined, k);
  assert.equal(h.authorization, 'Bearer svc-key');
  assert.equal(h['mcp-session-id'], 'sess-1');
});

test('an unknown connector is 404', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake) });
  assert.equal((await relay.call('POST', msg('tools/list', 1), {}, '/mcp/nope')).status, 404);
});

test('an oversize body is 413', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake) });
  const r = await relay.call('POST', 'x'.repeat(4 * 1024 * 1024 + 10));
  assert.equal(r.status, 413);
  assert.equal(fake.state.seen.length, 0);
});

test('not connected: a non-tools method gets 200 and the -32001 message with the request id', async (t) => {
  const fake = await setupFake(t);
  const target = stubTarget(fake, { authorization: async () => null });
  const relay = await startRelay(t, { target });
  const r = await relay.call('POST', msg('resources/list', 7));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 7, error: { code: -32001, message: SIGN_IN } });
  assert.equal(fake.state.seen.length, 0);
  target.kind = 'expired';
  const e = await (await relay.call('POST', msg('prompts/list', 'abc'))).json();
  assert.equal(e.id, 'abc');
  assert.equal(e.error.message, RUN_OUT);
  assert.equal((await relay.call('POST', msg('tools/call', 8, { name: 'getThing', arguments: {} }))).status, 200);
  const other = await (await relay.call('POST', msg('tools/call', 9, { name: 'getThing' }))).json();
  assert.equal(other.error.code, -32001);
});

test('a notification without a sign-in is 202 and empty', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake, { authorization: async () => null }) });
  const r = await relay.call('POST', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(r.status, 202);
  assert.equal(await r.text(), '');
});

test('initialize without a sign-in connects locally', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake, { authorization: async () => null }) });
  const r = await relay.call('POST', msg('initialize', 1, { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), null);
  assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 1, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'VaultOS', version: '1' } } });
  const d = await (await relay.call('POST', msg('initialize', 2, {}))).json();
  assert.equal(d.result.protocolVersion, '2025-06-18');
  assert.equal(fake.state.seen.length, 0);
});

test('tools/list without a sign-in lists vaultos_sign_in with the sentence', async (t) => {
  const fake = await setupFake(t);
  const target = stubTarget(fake, { authorization: async () => null });
  const relay = await startRelay(t, { target });
  const j = await (await relay.call('POST', msg('tools/list', 3))).json();
  assert.deepEqual(j.result.tools, [{ name: 'vaultos_sign_in', description: SIGN_IN, inputSchema: { type: 'object', properties: {} } }]);
  target.kind = 'expired';
  const k = await (await relay.call('POST', msg('tools/list', 4))).json();
  assert.equal(k.result.tools[0].description, RUN_OUT);
});

test('calling vaultos_sign_in returns the sentence as an error result', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake, { authorization: async () => null }) });
  const j = await (await relay.call('POST', msg('tools/call', 5, { name: 'vaultos_sign_in', arguments: {} }))).json();
  assert.deepEqual(j, { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: SIGN_IN }], isError: true } });
});

test('a body that is not JSON: parse error without a sign-in, forwarded as-is with one', async (t) => {
  const fake = await setupFake(t);
  const off = await startRelay(t, { target: stubTarget(fake, { authorization: async () => null }) });
  const r = await off.call('POST', '{nope');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const on = await startRelay(t, { target: stubTarget(fake) });
  const f = await on.call('POST', '{nope');
  assert.equal(f.status, 400); // the fake's own answer, passed through
  await f.text();
  assert.equal(fake.state.seen.length, 1);
});

test('the original bytes are forwarded unchanged', async (t) => {
  const fake = await setupFake(t);
  let got = '';
  const spy = async (u, init) => { got = Buffer.from(init.body).toString(); return fetch(u, init); };
  const handler = R.createRelay({ getKey: () => KEY, target: () => stubTarget(fake), fetch: spy });
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }));
  const body = '{ "jsonrpc":"2.0",  "id":1,"method":"tools/list" }';
  const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp/atlassian`, { method: 'POST', body, headers: { 'x-vaultos-key': KEY } });
  await r.text();
  assert.equal(got, body);
});

test('GET without a sign-in is 405', async (t) => {
  const fake = await setupFake(t);
  const relay = await startRelay(t, { target: stubTarget(fake, { authorization: async () => null }) });
  assert.equal((await relay.call('GET')).status, 405);
  assert.equal(fake.state.seen.length, 0);
});

test('expired token: renew, retry once, success', async (t) => {
  const fake = await setupFake(t);
  const stale = 'Bearer at-stale';
  let current = stale;
  const target = stubTarget(fake, {
    authorization: async () => current,
    renew: async (rejected) => { target.renews++; assert.equal(rejected, stale); current = 'Bearer svc-key'; return current; },
  });
  const relay = await startRelay(t, { target });
  const r = await relay.call('POST', msg('tools/list', 1));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /atlassianUserInfo/);
  assert.equal(target.renews, 1);
  assert.equal(fake.state.seen.length, 2);
  assert.equal(target.marked, 0);
});

test('renew refused: markNeedsSignIn once, the expired message, 200, never 401', async (t) => {
  const fake = await setupFake(t);
  const target = stubTarget(fake, { authorization: async () => 'Bearer at-stale' });
  const relay = await startRelay(t, { target });
  const r = await relay.call('POST', msg('resources/list', 4));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.id, 4);
  assert.deepEqual(j.error, { code: -32001, message: RUN_OUT });
  assert.equal(target.marked, 1);
});

test('upstream that answers 401 even after renew never yields 401', async (t) => {
  const fake = await setupFake(t);
  const target = stubTarget(fake, {
    authorization: async () => 'Bearer at-stale',
    renew: async (rejected) => { target.renews++; assert.equal(rejected, 'Bearer at-stale'); return 'Bearer at-still-bad'; },
  });
  const relay = await startRelay(t, { target });
  for (const [m, body] of [['POST', msg('tools/list', 1)], ['POST', msg('initialize', 2, {})],
    ['POST', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })], ['GET'], ['DELETE']]) {
    const r = await relay.call(m, body);
    assert.notEqual(r.status, 401, m);
    await r.text();
  }
  assert.equal(target.renews >= 1, true);
  assert.equal(target.marked >= 1, true);
});

test('serialised: concurrent calls share one run, the next starts afresh', async () => {
  let n = 0; let release;
  const f = R.serialised(() => new Promise((ok) => { n++; release = () => ok(n); }));
  const a = f(); const b = f();
  assert.equal(n, 1);
  release();
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  const c = f();
  assert.equal(n, 2);
  release();
  assert.equal(await c, 2);
  const g = R.serialised(async () => { throw new Error('boom'); });
  await assert.rejects(g(), /boom/);
  await assert.rejects(g(), /boom/);
});

test('two calls during expiry make one refresh', async (t) => {
  const fake = await setupFake(t);
  const live = await liveTokens(fake);
  let tokens = live.tokens;
  const refresh = R.serialised(async () => {
    tokens = await o.refreshTokens(live.meta, { clientId: live.clientId, refreshToken: tokens.refresh_token });
    fake.setMode('normal'); // the fresh token is good
    return 'Bearer ' + tokens.access_token;
  });
  const target = stubTarget(fake, { authorization: async () => 'Bearer ' + tokens.access_token, renew: refresh });
  const relay = await startRelay(t, { target });
  fake.setMode('expire'); // the current access token is now dead
  const rs = await Promise.all([relay.call('POST', msg('tools/list', 1)), relay.call('POST', msg('tools/list', 2))]);
  for (const r of rs) { assert.equal(r.status, 200); assert.match(await r.text(), /atlassianUserInfo/); }
  assert.equal(fake.state.refreshes, 1);
});

test('SSE streams as it arrives', async (t) => {
  const fake = await setupFake(t);
  fake.setMode('slow-sse');
  const relay = await startRelay(t, { target: stubTarget(fake) });
  const r = await relay.call('POST', msg('tools/list', 1));
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  const t0 = Date.now();
  const first = await reader.read();
  const firstAt = Date.now() - t0;
  assert.match(Buffer.from(first.value).toString(), /notifications\/message/);
  assert.ok(firstAt < 250, `first event took ${firstAt} ms`);
  let rest = '';
  for (;;) { const c = await reader.read(); if (c.done) break; rest += Buffer.from(c.value).toString(); }
  assert.match(rest, /atlassianUserInfo/);
});

test('an agent hang-up aborts upstream', async (t) => {
  const fake = await setupFake(t);
  fake.setMode('slow-sse');
  const signals = [];
  const spy = async (u, init) => { signals.push(init.signal); return fetch(u, init); };
  const relay = await startRelay(t, { target: stubTarget(fake), fetch: spy });
  const sock = net.connect(relay.port, '127.0.0.1');
  const body = msg('tools/list', 2);
  sock.write(`POST /mcp/atlassian HTTP/1.1\r\nHost: 127.0.0.1\r\nx-vaultos-key: ${KEY}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  await new Promise((ok) => sock.once('data', ok)); // the first event arrived
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  sock.destroy();
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(signals[0].aborted, true);
  // the relay still works for the next caller (no unhandled error)
  fake.setMode('normal');
  const again = await relay.call('POST', msg('tools/list', 3));
  assert.equal(again.status, 200);
  await again.text();
});

test('mcpProbe lists the fake\'s two tools and calls one', async (t) => {
  const fake = await setupFake(t);
  const p = await R.mcpProbe(fake.base + '/v1/mcp', basic, { fetch });
  assert.equal(p.ok, true);
  assert.deepEqual(p.tools, ['atlassianUserInfo', 'getAccessibleAtlassianResources']);
  const res = await p.call('atlassianUserInfo', {});
  assert.deepEqual(JSON.parse(res.content[0].text), { email: 'alex@example.com' });
  assert.equal(fake.state.seen.filter((s) => s.headers['mcp-session-id']).length >= 3, true);
});

test('mcpProbe reports a refused credential without throwing', async (t) => {
  const fake = await setupFake(t);
  const p = await R.mcpProbe(fake.base + '/v1/mcp', 'Bearer nope', { fetch });
  assert.equal(p.ok, false);
  assert.deepEqual(p.tools, []);
  assert.match(p.error, /401/);
});

test('a 401 that arrives after another request\'s refresh does not refresh again', async (t) => {
  const fake = await setupFake(t);
  const live = await liveTokens(fake);
  const stale = 'Bearer ' + live.tokens.access_token;
  let stored = stale, rt = live.tokens.refresh_token;
  const refresh = R.serialised(async () => {
    const n = await o.refreshTokens(live.meta, { clientId: live.clientId, refreshToken: rt });
    rt = n.refresh_token; stored = 'Bearer ' + n.access_token; fake.setMode('normal');
    return stored;
  });
  // Both requests were issued with the old credential; renew(rejected) only refreshes if it is still current.
  const target = stubTarget(fake, {
    authorization: async () => stale,
    renew: async (rejected) => (stored !== rejected ? stored : refresh()),
  });
  fake.setMode('expire');
  const relay = await startRelay(t, { target });
  const a = await relay.call('POST', msg('tools/list', 1));
  assert.equal(a.status, 200); await a.text();
  const b = await relay.call('POST', msg('tools/list', 2)); // its 401 comes after A's refresh finished
  assert.equal(b.status, 200); assert.match(await b.text(), /atlassianUserInfo/);
  assert.equal(fake.state.refreshes, 1);
});

test('headers reach the agent before the first SSE event', async (t) => {
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    const timer = setTimeout(() => { res.write('data: {}\n\n'); res.end(); }, 600);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => { up.closeAllConnections(); up.close(ok); }));
  const target = { label: 'Atlassian', url: `http://127.0.0.1:${up.address().port}/`, authorization: async () => 'Bearer x',
    renew: async () => null, markNeedsSignIn() {}, missing: () => 'not-connected' };
  const relay = await startRelay(t, { target });
  const t0 = Date.now();
  const r = await relay.call('GET', undefined, { accept: 'text/event-stream' });
  const took = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.ok(took < 400, `headers took ${took} ms`);
  await r.body.cancel();
});

test('a throwing renew or authorization answers an error status and never marks needs-sign-in', async (t) => {
  const fake = await setupFake(t);
  const target = stubTarget(fake, { authorization: async () => 'Bearer at-stale', renew: async () => { throw new Error('network'); } });
  const relay = await startRelay(t, { target });
  const r = await relay.call('POST', msg('tools/list', 1));
  assert.ok(r.status >= 500);
  const t2 = stubTarget(fake, { authorization: async () => { throw new Error('network'); } });
  const relay2 = await startRelay(t, { target: t2 });
  assert.ok((await relay2.call('POST', msg('tools/list', 1))).status >= 500);
  assert.equal(target.marked + t2.marked, 0);
});
