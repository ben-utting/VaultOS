'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ado = require('../lib/connector-ado');
const { createFilter, parseArgs } = require('../lib/ado-mcp');
const { CONNECTORS, entryFor } = require('../lib/connectors');
const { createConnectorService } = require('../lib/connector-service');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const FAKE = path.join(__dirname, 'fixtures', 'fake-ado-server.js');

// A home with the fake installed where the real one goes (~/.local/bin/mcp-server-azuredevops).
function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-ado-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.symlinkSync(FAKE, path.join(home, '.local/bin', ado.BIN));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// ----- policy and parsing -----
test('parseOrg takes a name or a pasted address, and refuses anything else', () => {
  assert.equal(ado.parseOrg('contoso'), 'contoso');
  assert.equal(ado.parseOrg('  my-org-2 '), 'my-org-2');
  assert.equal(ado.parseOrg('https://dev.azure.com/contoso/Project/_boards'), 'contoso');
  assert.equal(ado.parseOrg('dev.azure.com/contoso'), 'contoso');
  assert.equal(ado.parseOrg('https://contoso.visualstudio.com/Project'), 'contoso');
  assert.equal(ado.parseOrg('contoso.visualstudio.com'), 'contoso');
  for (const bad of ['', ' ', '-x', 'x-', 'a b', 'a/b', '--allow-changes', 'https://example.com/contoso', 'x'.repeat(51), null, 42]) {
    assert.equal(ado.parseOrg(bad), null, String(bad));
  }
});

test('allowed: read tools pass, write tools, unknown tools and a backlog reorder do not', () => {
  for (const n of ['core_list_projects', 'wit_work_item', 'wit_query', 'repo_file', 'pipelines_build', 'wiki', 'search_code']) assert.ok(ado.allowed(n, {}), n);
  for (const n of ['wit_work_item_write', 'repo_pull_request_write', 'pipelines_write', 'wiki_upsert_page', 'repo_create_branch', 'wit_work_item_attachment_upload', 'wit_work_item_attachment_link', 'brand_new_tool', '', undefined]) {
    assert.equal(ado.allowed(n, {}), false, String(n));
  }
  assert.equal(ado.allowed('wit_backlog', { action: 'list' }), true);
  assert.equal(ado.allowed('wit_backlog', { action: 'reorder' }), false);
  assert.equal(ado.allowed('constructor', {}), false);
});

test('no READ tool is named like a write', () => {
  for (const n of ado.READ) assert.ok(!/_write$|upsert|create/.test(n), n);
});

test('the catalogue: local, rides the Azure sign-in, pinned install', () => {
  const c = CONNECTORS.azuredevops;
  assert.equal(c.kind, 'local');
  assert.deepEqual(c.signIn, ['azure']);
  assert.deepEqual(c.detect, ['mcp-server-azuredevops']);
  assert.equal(c.install, 'npm install -g --prefix ~/.local @azure-devops/mcp@2.11.0');
});

test('entryFor azuredevops runs the wrapper with the organization, read-only unless allowChanges', () => {
  const e = entryFor('azuredevops', { home: '/h', org: 'contoso' });
  assert.equal(e.kind, 'stdio');
  assert.equal(e.command, process.execPath);
  assert.deepEqual(e.args, [ado.WRAPPER, '--server', '/h/.local/bin/mcp-server-azuredevops', '--org', 'contoso']);
  assert.deepEqual(entryFor('azuredevops', { home: '/h', org: 'contoso', allowChanges: true }).args.slice(-1), ['--allow-changes']);
  assert.deepEqual(parseArgs(e.args.slice(1)), { allowChanges: false, server: '/h/.local/bin/mcp-server-azuredevops', org: 'contoso' });
});

// ----- the filter -----
function filterPair(allowChanges) {
  const toServer = [], toClient = [];
  const f = createFilter({ allowChanges, toServer: (l) => toServer.push(l), toClient: (l) => toClient.push(l) });
  return { f, toServer, toClient };
}
const line = (o) => JSON.stringify(o);

test('filter, read-only: a write call is answered here and never reaches the server', () => {
  const { f, toServer, toClient } = filterPair(false);
  f.fromClient(line({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wit_work_item_write', arguments: {} } }));
  assert.equal(toServer.length, 0);
  const r = JSON.parse(toClient[0]);
  assert.equal(r.id, 7);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /read-only/);
  f.fromClient(line({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'wit_backlog', arguments: { action: 'reorder' } } }));
  assert.equal(toServer.length, 0);
  f.fromClient(line({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wit_backlog', arguments: { action: 'list' } } }));
  assert.equal(toServer.length, 1);
});

test('filter, read-only: tools/list answers lose the write tools; other messages pass byte for byte', () => {
  const { f, toServer, toClient } = filterPair(false);
  f.fromClient(line({ jsonrpc: '2.0', id: 'a', method: 'tools/list', params: {} }));
  // A server-to-client request with the same id is not the answer.
  const ask = line({ jsonrpc: '2.0', id: 'a', method: 'elicitation/create', params: { message: 'Pick a project' } });
  f.fromServer(ask);
  f.fromServer(line({ jsonrpc: '2.0', id: 'a', result: { tools: [{ name: 'core_list_projects' }, { name: 'wiki_upsert_page' }, { name: 'brand_new_tool' }] } }));
  assert.equal(toServer.length, 1);
  assert.equal(toClient[0], ask);
  assert.deepEqual(JSON.parse(toClient[1]).result.tools.map((t) => t.name), ['core_list_projects']);
  const other = '{"jsonrpc":"2.0","id":3,"result":{"x":1}}';
  f.fromServer(other);
  f.fromServer('not json');
  assert.deepEqual(toClient.slice(2), [other, 'not json']);
});

test('filter, allow changes: everything passes untouched', () => {
  const { f, toServer, toClient } = filterPair(true);
  const call = line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wit_work_item_write', arguments: {} } });
  const list = line({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  f.fromClient(call); f.fromClient(list);
  const ans = line({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'wiki_upsert_page' }] } });
  f.fromServer(ans);
  assert.deepEqual(toServer, [call, list]);
  assert.deepEqual(toClient, [ans]);
});

// ----- the wrapper as a process, against the fake -----
test('the wrapper starts the server with azcli and the org, and hides writes from an agent', async (t) => {
  const home = fakeHome(t);
  const log = path.join(home, 'log');
  const e = ado.entry({ home, org: 'contoso' });
  const p = await ado.stdioProbe(e.command, e.args, { env: { ...process.env, FAKE_ADO_LOG: log }, timeoutMs: 10000 });
  t.after(() => p.close());
  assert.equal(p.ok, true, p.error);
  assert.deepEqual(p.tools, ['core_list_projects', 'wit_work_item', 'wit_backlog']);
  const refused = await p.call('repo_create_branch', {});
  assert.equal(refused.isError, true);
  const ran = await p.call('wit_work_item', { action: 'get' });
  assert.equal(ran.content[0].text, 'RAN wit_work_item');
  const seen = fs.readFileSync(log, 'utf8');
  assert.match(seen, /ARGS \["contoso","--authentication","azcli"\]/);
  assert.doesNotMatch(seen, /repo_create_branch/);
});

test('with --allow-changes the agent sees and can call every tool', async (t) => {
  const home = fakeHome(t);
  const e = ado.entry({ home, org: 'contoso', allowChanges: true });
  const p = await ado.stdioProbe(e.command, e.args, { timeoutMs: 10000 });
  t.after(() => p.close());
  assert.equal(p.tools.length, 7);
  assert.equal((await p.call('repo_create_branch', {})).content[0].text, 'RAN repo_create_branch');
});

test('test(): projects counted; a token failure and a missing install are failures with a reason', async (t) => {
  const home = fakeHome(t);
  assert.deepEqual(await ado.test({ home, org: 'contoso', timeoutMs: 10000 }), { ok: true, tools: 3, projects: 2 });
  const noauth = await ado.test({ home, org: 'contoso', env: { ...process.env, FAKE_ADO_MODE: 'noauth' }, timeoutMs: 10000 });
  assert.equal(noauth.ok, false);
  assert.match(noauth.error, /^Error fetching projects: ChainedTokenCredential/);
  const crash = await ado.test({ home, org: 'contoso', env: { ...process.env, FAKE_ADO_MODE: 'crash' }, timeoutMs: 10000 });
  assert.equal(crash.ok, false);
  assert.match(crash.error, /ENOTFOUND/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-ado-none-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const missing = await ado.test({ home: empty, org: 'contoso', timeoutMs: 10000 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /isn't installed/);
});

test('the wrapper without --server or --org exits 2', async () => {
  const code = await new Promise((r) => spawn(process.execPath, [ado.WRAPPER, '--org', 'x'], { stdio: 'ignore' }).on('close', r));
  assert.equal(code, 2);
});

// ----- the service -----
const AZ_LINE = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKNPLV to authenticate.';

async function service(t, { installed = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-ado-svc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spawned = [];
  const fakeSpawn = () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}; spawned.push(p); return p; };
  const st = { installed, test: { ok: true, tools: 29, projects: 4 }, tests: [] };
  const run = async (cmd) => {
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: m[1] === 'mcp-server-azuredevops' && !st.installed ? 1 : 0, stdout: '', stderr: '' };
    if (cmd.startsWith('az account show')) return { code: 0, stdout: JSON.stringify({ user: { name: 'alex@example.com' }, tenantId: '0', id: 's1', name: 'Sub' }), stderr: '' };
    if (cmd.startsWith('az account list')) return { code: 0, stdout: '[]', stderr: '' };
    if (cmd.startsWith('az account get-access-token')) return { code: 0, stdout: 'x', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const adoTest = async (o) => { st.tests.push(o); return st.test; };
  const svc = createConnectorService({ home, port: 7684, env: {}, run, spawn: fakeSpawn, now: () => 1000000, installedAgents: async () => ['cursor'], adoTest });
  await svc.init();
  const connectAzure = async () => {
    const n = spawned.length;
    const p = svc.azureStart();
    spawned[n].stderr.write(`${AZ_LINE}\n`);
    await p;
    spawned[n].emit('close', 0);
    await new Promise((r) => setImmediate(r));
    await svc.azureStatus();
  };
  const row = async () => (await svc.view()).connectors.find((c) => c.id === 'azuredevops');
  const cursor = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers; } catch { return {}; } };
  return { svc, home, st, connectAzure, row, cursor };
}

test('service: needs Azure first, then an organization; a refused check saves nothing', async (t) => {
  const { svc, st, connectAzure, row, cursor } = await service(t);
  assert.equal((await row()).state, 'not-connected');
  assert.equal((await row()).needsAzure, true);
  await assert.rejects(svc.enable('azuredevops', { org: 'contoso' }), /Connect Azure first/);
  await connectAzure();
  assert.equal((await row()).needsAzure, undefined);
  await assert.rejects(svc.enable('azuredevops', { org: 'not an org' }), /Enter your Azure DevOps organization/);
  st.test = { ok: false, tools: 0, error: 'Failed to obtain Azure DevOps token. Ensure you have Azure CLI logged' };
  await assert.rejects(svc.enable('azuredevops', { org: 'contoso' }), /can't open contoso/);
  assert.equal((await row()).state, 'not-connected');
  assert.equal(cursor().azuredevops, undefined);
});

test('service: turning it on writes the agent entry; the switch rewrites it; Azure signing out takes it off', async (t) => {
  const { svc, st, home, connectAzure, row, cursor } = await service(t);
  await connectAzure();
  await svc.enable('azuredevops', { org: 'https://dev.azure.com/contoso/' });
  assert.deepEqual(st.tests[0], { home, org: 'contoso', allowChanges: false, env: {} });
  let r = await row();
  assert.equal(r.state, 'connected');
  assert.equal(r.org, 'contoso');
  assert.equal(r.allowChanges, false);
  assert.deepEqual([r.lastTest.tools, r.lastTest.projects], [29, 4]);
  assert.deepEqual(cursor().azuredevops.args, [ado.WRAPPER, '--server', path.join(home, '.local/bin/mcp-server-azuredevops'), '--org', 'contoso']);
  // Azure's own switch does not touch Azure DevOps, and the reverse.
  await svc.azureSettings({ allowChanges: true });
  assert.equal(cursor().azuredevops.args.includes('--allow-changes'), false);
  await svc.azureSettings({ allowChanges: false });
  await svc.adoSettings({ allowChanges: true });
  assert.equal(cursor().azuredevops.args.at(-1), '--allow-changes');
  assert.equal(cursor().azure.args.includes('--read-only'), true);
  // A failing Test leaves it on with the error.
  st.test = { ok: false, tools: 0, error: 'getaddrinfo ENOTFOUND dev.azure.com' };
  await svc.test('azuredevops');
  r = await row();
  assert.equal(r.state, 'error');
  assert.match(r.error, /didn't answer for contoso/);
  // Azure signs out: Azure DevOps goes from the agents, the organization is kept for next time.
  await svc.disconnect('azure');
  r = await row();
  assert.equal(r.state, 'not-connected');
  assert.equal(r.org, 'contoso');
  assert.equal(cursor().azuredevops, undefined);
  // Changing the organization keeps the switch.
  await connectAzure();
  st.test = { ok: true, tools: 40 };
  await svc.enable('azuredevops', { org: 'fabrikam' });
  r = await row();
  assert.equal(r.org, 'fabrikam');
  assert.equal(r.allowChanges, true);
  await svc.disconnect('azuredevops');
  assert.equal((await row()).org, undefined);
  assert.equal(cursor().azuredevops, undefined);
});

test('service: not installed shows the install, and refuses to turn on', async (t) => {
  const { svc, connectAzure, row } = await service(t, { installed: false });
  await connectAzure();
  const r = await row();
  assert.equal(r.state, 'not-installed');
  assert.equal(r.install, CONNECTORS.azuredevops.install);
  await assert.rejects(svc.enable('azuredevops', { org: 'contoso' }), /Install Azure DevOps first/);
});
