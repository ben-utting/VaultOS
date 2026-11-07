'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createConnectorService } = require('../lib/connector-service');
const { createRelay } = require('../lib/connector-relay');

const AZ_LINE = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKNPLV to authenticate.';
const TOKEN = 'eyJhbGciOi.payload.sig';

async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-entra-'));
  const spawned = [];
  const spawn = () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}; spawned.push(p); return p; };
  const graph = [];
  const state = { tokenOk: true };
  const run = async (cmd) => {
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: 0, stdout: '', stderr: '' };
    if (cmd.startsWith('az account show')) return { code: 0, stdout: JSON.stringify({ user: { name: 'alex@example.com' }, tenantId: '0', id: 's1', name: 'Sub' }), stderr: '' };
    if (cmd.startsWith('az account list')) return { code: 0, stdout: '[]', stderr: '' };
    if (cmd.startsWith('az account get-access-token')) return state.tokenOk ? { code: 0, stdout: TOKEN, stderr: '' } : { code: 1, stdout: '', stderr: 'login' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetch = async (url, init) => {
    graph.push({ url: String(url), init });
    const body = JSON.stringify({ value: [{ displayName: 'Acme Ltd' }] });
    return { status: 200, body: { cancel: async () => {} }, text: async () => body };
  };
  const svc = createConnectorService({ home, port: 7684, env: {}, fetch, run, spawn, now: () => 1000000, installedAgents: async () => ['cursor'] });
  await svc.init();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const connectAzure = async () => {
    const p = svc.azureStart();
    spawned[0].stderr.write(`${AZ_LINE}\n`);
    await p;
    spawned[0].emit('close', 0);
    await new Promise((r) => setImmediate(r));
    await svc.azureStatus();
  };
  return { svc, home, graph, state, connectAzure };
}
const row = async (svc, id) => (await svc.view()).connectors.find((c) => c.id === id);
const cursor = (home) => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers;
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function post(svc, body) {
  const server = http.createServer(createRelay({ getKey: () => 'k', target: (id) => svc.relayTarget(id) }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/entra`, { method: 'POST', headers: { 'x-vaultos-key': 'k', 'content-type': 'application/json' }, body });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  } finally { server.close(); }
}

test('entra: not connected and asking for Azure first, until Azure is signed in', async (t) => {
  const { svc } = await setup(t);
  const e = await row(svc, 'entra');
  assert.strictEqual(e.state, 'not-connected');
  assert.strictEqual(e.needsAzure, true);
  await assert.rejects(svc.enable('entra'), /Connect Azure first/);
});

test('entra: enable after Azure gives connected with 2 tools, the org name, and an http entry for Cursor', async (t) => {
  const { svc, home, connectAzure, graph } = await setup(t);
  await connectAzure();
  await svc.enable('entra');
  const e = await row(svc, 'entra');
  assert.strictEqual(e.state, 'connected');
  assert.strictEqual(e.method, 'azure');
  assert.strictEqual(e.lastTest.tools, 2);
  assert.strictEqual(e.account, 'Acme Ltd');
  assert.strictEqual(cursor(home).entra.url, 'http://127.0.0.1:7684/mcp/entra');
  assert.ok(graph.every((g) => g.init.method === 'GET' && /graph\.microsoft\.com/.test(g.url)));
});

test('entra: the relay serves tools/list and a graph_get call itself, with no token in the reply', async (t) => {
  const { svc, connectAzure, graph } = await setup(t);
  await connectAzure();
  await svc.enable('entra');
  const list = await post(svc, rpc('tools/list'));
  assert.deepStrictEqual(list.json.result.tools.map((x) => x.name), ['graph_get', 'graph_help']);
  const call = await post(svc, rpc('tools/call', { name: 'graph_get', arguments: { path: '/users', query: { $top: 1 } } }));
  assert.match(call.json.result.content[0].text, /Acme Ltd/);
  assert.ok(!JSON.stringify(call.json).includes(TOKEN));
  assert.ok(graph.some((g) => /\/v1\.0\/users\?%24top=1|\/v1\.0\/users\?\$top=1/.test(g.url)));
  assert.strictEqual((await post(svc, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
});

test('entra: when Azure signs out the entry goes and the relay says it is not connected; signing back in brings it back', async (t) => {
  const { svc, home, connectAzure } = await setup(t);
  await connectAzure();
  await svc.enable('entra');
  await svc.disconnect('azure');
  const e = await row(svc, 'entra');
  assert.strictEqual(e.state, 'not-connected');
  assert.strictEqual(e.needsAzure, true);
  assert.strictEqual(cursor(home).entra, undefined);
  const r = await post(svc, rpc('tools/list'));
  assert.match(r.json.result.tools[0].description, /isn't connected/);
});

test('entra: turning it off removes only its entry and leaves Azure alone', async (t) => {
  const { svc, home, connectAzure } = await setup(t);
  await connectAzure();
  await svc.enable('entra');
  await svc.disconnect('entra');
  assert.strictEqual(cursor(home).entra, undefined);
  assert.ok(cursor(home).azure);
  assert.strictEqual((await row(svc, 'azure')).state, 'connected');
  assert.strictEqual((await row(svc, 'entra')).state, 'not-connected');
});

test('entra: a failing token shows an error on the row after Test, not a lost connection', async (t) => {
  const { svc, connectAzure, state } = await setup(t);
  await connectAzure();
  await svc.enable('entra');
  state.tokenOk = false;
  await svc.test('entra');
  const e = await row(svc, 'entra');
  assert.strictEqual(e.state, 'error');
  assert.match(e.error, /Azure again/);
});

test('entra: it takes no token and the token route refuses it', async (t) => {
  const { svc } = await setup(t);
  await assert.rejects(svc.saveToken('entra', { token: 'x' }), /doesn't use a token/);
});
