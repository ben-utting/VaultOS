'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, login } = require('./helpers/server');
const { startFake } = require('../scripts/fake-mcp-oauth');

const PASSWORD = 'correct horse';

// fetch won't send a Host of our choosing, so a request that names one goes through http.request.
const rawCall = (base, method, url, { cookie, body, headers }) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const req = http.request({ host: u.hostname, port: u.port, path: url, method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
    res.on('end', () => {
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      const h = new Headers(); for (const [k, v] of Object.entries(res.headers)) if (k !== 'set-cookie') h.set(k, String(v));
      h.getSetCookie = () => res.headers['set-cookie'] || [];
      resolve({ status: res.statusCode, body: json, text, headers: h });
    });
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const call = async (base, method, url, { cookie, body, headers } = {}) => {
  if (headers && headers.host) return rawCall(base, method, url, { cookie, body, headers });
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

// The cookie header after a response that may have rotated the session (the sign-in start stores a nonce in it).
const mergeCookie = (cookie, res) => {
  const jar = new Map(cookie.split('; ').map((c) => c.split(/=(.*)/s).slice(0, 2)));
  for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const [k, v] = kv.split(/=(.*)/s); jar.set(k, v); }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};

async function ready(t, { env = {}, host } = {}) {
  const fake = await startFake();
  t.after(() => fake.stop());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-cx-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault); fs.mkdirSync(d.home);
  const srv = await startServer({ ...d, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base, ...env } });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  const headers = host ? { host } : {}; // when the allowlist doesn't name 127.0.0.1, the person's browser uses another name
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD }, headers })).status, 200);
  const lr = await call(base, 'POST', '/api/login', { body: { password: PASSWORD }, headers });
  assert.equal(lr.status, 200);
  const cookie = mergeCookie('', lr);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, headers, body: { labels: ['Work'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, headers, body: { today: false } })).status, 200);
  return { ...d, base, cookie, srv, fake, headers };
}

const storeKey = (s) => JSON.parse(fs.readFileSync(path.join(s.home, '.vaultos', 'connectors.json'), 'utf8')).relayKey;
const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

async function signIn(s) {
  const st = await call(s.base, 'POST', '/api/connectors/atlassian/start', { cookie: s.cookie });
  assert.equal(st.status, 200);
  s.cookie = mergeCookie(s.cookie, st); // the browser keeps the session the start route wrote the nonce into
  const hop = await fetch(st.body.url, { redirect: 'manual' });
  assert.equal(hop.status, 302);
  return hop.headers.get('location');
}

test('connectors need a session', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'GET', '/api/connectors')).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/connectors/atlassian/start')).status, 401);
});

test('GET /api/connectors lists the four connectors not connected, and five planned', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.connectors.map((c) => c.id), ['atlassian', 'azure', 'github', 'mslearn']);
  assert.equal(r.body.connectors.find((c) => c.id === 'atlassian').state, 'not-connected');
  assert.notEqual(r.body.connectors.find((c) => c.id === 'azure').state, 'connected');
  assert.equal(r.body.planned.length, 5);
  assert.equal(r.body.attention, false);
});

test('the whole Atlassian sign-in over HTTP', async (t) => {
  const s = await ready(t);
  const loc = await signIn(s);
  const u = new URL(loc);
  assert.equal(u.pathname, '/api/connectors/atlassian/callback');
  const cb = await call(s.base, 'GET', u.pathname + u.search, { cookie: s.cookie });
  assert.equal(cb.status, 200);
  assert.match(cb.text, /Atlassian is connected, you can close this tab\./);
  assert.match(cb.text, /new BroadcastChannel\('vaultos-connectors'\)/);
  assert.doesNotMatch(cb.text, /opener/);
  const r = await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie });
  assert.equal(r.body.connectors.find((c) => c.id === 'atlassian').state, 'connected');
  assert.ok(!r.text.includes(storeKey(s)));
  const dis = await call(s.base, 'POST', '/api/connectors/atlassian/disconnect', { cookie: s.cookie });
  assert.equal(dis.status, 200);
  const r2 = await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie });
  assert.equal(r2.body.connectors.find((c) => c.id === 'atlassian').state, 'not-connected');
});

test('the relay answers tools/list with the key from the store', async (t) => {
  const s = await ready(t);
  const u = new URL(await signIn(s));
  await call(s.base, 'GET', u.pathname + u.search, { cookie: s.cookie });
  const r = await call(s.base, 'POST', '/mcp/atlassian', { body: rpc, headers: { 'x-vaultos-key': storeKey(s) } });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('tools'), r.text);
  const bad = await call(s.base, 'POST', '/mcp/atlassian', { body: rpc, headers: { 'x-vaultos-key': 'nope' } });
  assert.equal(bad.status, 403);
  assert.equal((await call(s.base, 'POST', '/mcp/atlassian', { body: rpc })).status, 403);
});

test('the relay refuses a non-loopback peer', async (t) => {
  const s = await ready(t);
  const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!ext) return t.skip('no non-internal IPv4 address');
  const port = new URL(s.base).port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: ext.address, port, path: '/mcp/atlassian', method: 'POST', headers: { 'x-vaultos-key': storeKey(s), 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(rpc));
  });
  // The server may also bind only loopback; a refused connection is equally "not served".
  assert.equal(status, 403);
});

test("the relay works with a Host the allowlist doesn't name", async (t) => {
  const s = await ready(t, { env: { ALLOWED_HOSTS: 'example.test' }, host: 'example.test' });
  assert.equal((await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie })).status, 421); // Host 127.0.0.1 is refused here
  const r = await call(s.base, 'POST', '/mcp/atlassian', { body: rpc, headers: { 'x-vaultos-key': storeKey(s) } });
  assert.equal(r.status, 200); // not connected yet: a JSON-RPC error, but past the Host check
  assert.match(r.text, /isn't connected yet/);
});

test('callback without a session is 401, and with another session\'s state shows the expired sentence', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'GET', '/api/connectors/atlassian/callback?code=x&state=y')).status, 401);
  const u = new URL(await signIn(s));
  const other = await login(s.base, PASSWORD); // a second session: no nonce, so another sign-in's state is unknown
  const cb = await call(s.base, 'GET', u.pathname + u.search, { cookie: other });
  assert.equal(cb.status, 200);
  assert.match(cb.text, /This sign-in link has expired\. Start again from VaultOS\./);
  assert.ok(!/connected, you can close/.test(cb.text));
});

test('token route reports a person-facing problem as 400', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/connectors/atlassian/token', { cookie: s.cookie, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Enter your email/);
});

test('POST /api/connectors/atlassian/cancel needs a session and ends the pending sign-in', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'POST', '/api/connectors/atlassian/cancel')).status, 401);
  await signIn(s);
  const before = await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie });
  assert.equal(before.body.connectors[0].state, 'connecting');
  assert.equal((await call(s.base, 'POST', '/api/connectors/atlassian/cancel', { cookie: s.cookie })).status, 200);
  const after = await call(s.base, 'GET', '/api/connectors', { cookie: s.cookie });
  assert.equal(after.body.connectors[0].state, 'not-connected');
});

test('the callback without a session answers the browser with a page, not JSON', async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'GET', '/api/connectors/atlassian/callback?code=x&state=y');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /Sign in to VaultOS in this browser, then start again from Settings → Connectors\./);
  assert.equal(r.body, null);
});

test('a prototype key as a connector id is a 400 with a sentence, and runs nothing', async (t) => {
  const s = await ready(t);
  for (const id of ['constructor', '__proto__']) {
    for (const verb of ['disconnect', 'test']) {
      const r = await call(s.base, 'POST', `/api/connectors/${id}/${verb}`, { cookie: s.cookie });
      assert.equal(r.status, 400, `${id} ${verb}`);
      assert.match(r.body.error, /Unknown connector/);
    }
  }
});

async function readyWithFakes(t) {
  const gh = await startFake({ noAuth: true });
  const ms = await startFake({ noAuth: true });
  t.after(() => Promise.all([gh.stop(), ms.stop()]));
  const s = await ready(t, { env: { CONNECTOR_UPSTREAM_GITHUB: gh.base, CONNECTOR_UPSTREAM_MSLEARN: ms.base } });
  return s;
}

test('token route saves a github token (200) and refuses mslearn and azure (400)', async (t) => {
  const s = await readyWithFakes(t);
  const ok = await call(s.base, 'POST', '/api/connectors/github/token', { cookie: s.cookie, body: { token: ' ghp_secret123\n' } });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes('ghp_secret123'));
  for (const id of ['mslearn', 'azure', 'nope', 'constructor', '__proto__']) {
    const r = await call(s.base, 'POST', `/api/connectors/${id}/token`, { cookie: s.cookie, body: { token: 'x' } });
    assert.equal(r.status, 400, id);
    assert.equal(typeof r.body.error, 'string', id);
  }
});

test('enable route turns on mslearn (200) and refuses github (400)', async (t) => {
  const s = await readyWithFakes(t);
  assert.equal((await call(s.base, 'POST', '/api/connectors/mslearn/enable', { cookie: s.cookie })).status, 200);
  for (const id of ['github', 'atlassian', 'azure', 'nope', 'constructor', '__proto__']) {
    const r = await call(s.base, 'POST', `/api/connectors/${id}/enable`, { cookie: s.cookie });
    assert.equal(r.status, 400, id);
    assert.equal(typeof r.body.error, 'string', id);
  }
});

test('token and enable routes need a session (401)', async (t) => {
  const s = await readyWithFakes(t);
  assert.equal((await call(s.base, 'POST', '/api/connectors/github/token', { body: { token: 'x' } })).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/connectors/mslearn/enable')).status, 401);
});

test('the atlassian token flow still works through /api/connectors/atlassian/token', async (t) => {
  const s = await readyWithFakes(t);
  const r = await call(s.base, 'POST', '/api/connectors/atlassian/token', { cookie: s.cookie, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Enter your email/);
  const az = await call(s.base, 'POST', '/api/connectors/azure/cancel', { cookie: s.cookie });
  assert.equal(az.status, 200);
});
