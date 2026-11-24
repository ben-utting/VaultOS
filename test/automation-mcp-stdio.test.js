'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFilter, STDIO_WRAPPER } = require('../lib/automation-mcp-stdio');

const call = (id, name) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const listReq = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const listRes = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_x' }] } });
function make() {
  const logs = [];
  return { logs, f: createFilter({ id: 'azure', log: (e) => logs.push(e) }) };
}

test('a call to a listed tool is forwarded and logged', () => {
  const { f, logs } = make();
  assert.equal(f.fromAgent(listReq).forward, listReq);
  assert.equal(f.fromServer(listRes), listRes);
  const line = call(2, 'read_x');
  assert.deepEqual(f.fromAgent(line), { forward: line });
  assert.deepEqual(logs, [{ id: 'azure', tool: 'read_x', refused: false }]);
});

test('a call before any list, or to an unlisted tool, is answered here and logged refused', () => {
  const { f, logs } = make();
  const expect = (id) => ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'VaultOS has azure read-only for automations, so write_y is off.' }] } });
  let r = f.fromAgent(call(5, 'write_y'));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), expect(5));
  f.fromAgent(listReq); f.fromServer(listRes);
  r = f.fromAgent(call(6, 'write_y'));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), expect(6));
  assert.deepEqual(logs, [{ id: 'azure', tool: 'write_y', refused: true }, { id: 'azure', tool: 'write_y', refused: true }]);
});

test("a line that isn't JSON is never forwarded", () => {
  const { f } = make();
  const r = f.fromAgent('not json');
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
});

test('a batch is never forwarded', () => {
  const { f } = make();
  const r = f.fromAgent(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'read_x' } }, { jsonrpc: '2.0', method: 'notifications/x' }]));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), [
    { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Send this request on its own.' } },
    { jsonrpc: '2.0', id: 'b', error: { code: -32600, message: 'Send this request on its own.' } },
  ]);
});

test('other messages pass both ways unchanged', () => {
  const { f, logs } = make();
  const init = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(f.fromAgent(init), { forward: init });
  assert.deepEqual(f.fromAgent(note), { forward: note });
  const rep = JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} });
  assert.equal(f.fromServer(rep), rep);
  assert.deepEqual(logs, []);
});

test('the wrapper end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-'));
  const log = path.join(dir, 'calls.log');
  const seen = path.join(dir, 'seen.txt');
  const fake = path.join(__dirname, 'fixtures', 'fake-stdio-mcp.js');
  const p = spawn(process.execPath, [STDIO_WRAPPER, '--id', 'azure', '--log', log, '--', process.execPath, fake], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FAKE_STDIO_SEEN: seen },
  });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  const closed = new Promise((res) => p.on('close', (code) => res(code)));
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const waitFor = async (n) => { for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < n; i++) await new Promise((r) => setTimeout(r, 50)); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); await waitFor(1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); await waitFor(2);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_x' } }); await waitFor(3);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_y' } }); await waitFor(4);
  const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies.length, 4);
  assert.equal(replies[2].result.content[0].text, '{"ok":true}');
  assert.equal(replies[3].result.isError, true);
  p.stdin.end();
  assert.equal(await closed, 0);
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries, [{ id: 'azure', tool: 'read_x', refused: false }, { id: 'azure', tool: 'write_y', refused: true }]);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(seen, 'utf8'), 'read_x\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a large multi-byte line passes both ways whole', async () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-stdio-mcp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-'));
  const p = spawn(process.execPath, [STDIO_WRAPPER, '--id', 'azure', '--log', path.join(dir, 'c.log'), '--', process.execPath, fake], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => { out += c; });
  const closed = new Promise((res) => p.on('close', res));
  const text = '\u20ac'.repeat(60000) + 'caf\u00e9 \u{1F600}';
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x/echo', params: { text } }) + '\n');
  for (let i = 0; i < 100 && !out.endsWith('\n'); i++) await new Promise((r) => setTimeout(r, 50));
  p.stdin.end();
  await closed;
  assert.equal(JSON.parse(out).result.text, text);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Azure's namespace-mode tools: the agent picks a sub-command through arguments.command.
const callArgs = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
function makeListed(id = 'azure') {
  const logs = [];
  const f = createFilter({ id, log: (e) => logs.push(e) });
  f.fromAgent(listReq);
  f.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'keyvault' }, { name: 'storage' }, { name: 'keyvault_secret_get' }] } }));
  return { f, logs };
}
const secretRefusal = (id, what) => ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `VaultOS doesn't let automations read secrets, so ${what} is off.` }] } });

test('an azure keyvault call for a secret is refused and logged', () => {
  const { f, logs } = makeListed();
  let r = f.fromAgent(callArgs(2, 'keyvault', { command: 'keyvault_secret_get', parameters: {} }));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), secretRefusal(2, 'keyvault_secret_get'));
  r = f.fromAgent(callArgs(3, 'keyvault', { command: 'KeyVault_Secret_List' }));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), secretRefusal(3, 'KeyVault_Secret_List'));
  assert.deepEqual(logs, [
    { id: 'azure', tool: 'keyvault:keyvault_secret_get', refused: true },
    { id: 'azure', tool: 'keyvault:KeyVault_Secret_List', refused: true },
  ]);
});

test('a listed tool named like a secret read is refused', () => {
  const { f, logs } = makeListed();
  const r = f.fromAgent(callArgs(2, 'keyvault_secret_get', {}));
  assert.equal(r.forward, undefined);
  assert.deepEqual(JSON.parse(r.reply), secretRefusal(2, 'keyvault_secret_get'));
  assert.deepEqual(logs, [{ id: 'azure', tool: 'keyvault_secret_get', refused: true }]);
});

test('other keyvault and namespace calls go through and log their sub-command', () => {
  const { f, logs } = makeListed();
  for (const [n, a] of [['keyvault', { command: 'keyvault_key_get' }], ['storage', { command: 'storage_blob_get' }], ['keyvault', { intent: 'x', learn: true }]]) {
    const line = callArgs(2, n, a);
    assert.deepEqual(f.fromAgent(line), { forward: line });
  }
  assert.deepEqual(logs, [
    { id: 'azure', tool: 'keyvault:keyvault_key_get', refused: false },
    { id: 'azure', tool: 'storage:storage_blob_get', refused: false },
    { id: 'azure', tool: 'keyvault', refused: false },
  ]);
});

test("the secret rule is azure's only", () => {
  const { f, logs } = makeListed('azuredevops');
  const line = callArgs(2, 'keyvault', { command: 'keyvault_secret_get' });
  assert.deepEqual(f.fromAgent(line), { forward: line });
  assert.equal(logs[0].refused, false);
});

test('a non-string command counts as no command', () => {
  const { f, logs } = makeListed();
  for (const c of [5, { a: 1 }, null]) {
    const line = callArgs(2, 'keyvault', { command: c });
    assert.deepEqual(f.fromAgent(line), { forward: line });
  }
  assert.deepEqual(logs.map((l) => l.tool), ['keyvault', 'keyvault', 'keyvault']);
});

test('azure refuses every read azmcp marks secret, in any namespace', () => {
  const logs = [];
  const f = createFilter({ id: 'azure', log: (e) => logs.push(e) });
  f.fromAgent(listReq);
  const names = ['keyvault', 'storage', 'azure', 'appservice', 'resiliency', 'insights', 'appconfig'];
  f.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: names.map((name) => ({ name })) } }));
  const bad = [['storage', 'keyvault_secret_get'], ['azure', 'keyvault_secret_get'], ['appservice', 'appservice_webapp_settings_get-appsettings'],
    ['resiliency', 'resiliency_drill_run_get-report-download-url'], ['insights', 'insights_get']];
  for (const [n, c] of bad) {
    const r = f.fromAgent(callArgs(2, n, { command: c }));
    assert.equal(r.forward, undefined, c);
    assert.deepEqual(JSON.parse(r.reply), secretRefusal(2, c));
  }
  for (const [n, c] of [['keyvault', 'keyvault_key_get'], ['storage', 'storage_blob_get'], ['appconfig', 'appconfig_kv_get']]) {
    const line = callArgs(3, n, { command: c });
    assert.deepEqual(f.fromAgent(line), { forward: line }, c);
  }
});

test('an odd command is logged as name:?', () => {
  const { f, logs } = makeListed();
  const line = callArgs(2, 'storage', { command: 'x y!' });
  assert.deepEqual(f.fromAgent(line), { forward: line });
  const long = callArgs(3, 'storage', { command: 'a'.repeat(81) });
  assert.deepEqual(f.fromAgent(long), { forward: long });
  assert.deepEqual(logs.map((l) => l.tool), ['storage:?', 'storage:?']);
});

test('an unlisted tool keeps the read-only text even with a secret command', () => {
  const { f, logs } = make();
  f.fromAgent(listReq);
  f.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'storage' }] } }));
  const r = f.fromAgent(callArgs(2, 'keyvault', { command: 'keyvault_secret_get' }));
  assert.equal(JSON.parse(r.reply).result.content[0].text, 'VaultOS has azure read-only for automations, so keyvault is off.');
  assert.deepEqual(logs, [{ id: 'azure', tool: 'keyvault:keyvault_secret_get', refused: true }]);
});

test('what is forwarded is the message that was checked, not the raw line', () => {
  const { f, logs } = makeListed();
  // Duplicate keys: JSON.parse keeps the last one, a server may keep the first.
  const dupParams = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"keyvault","arguments":{"command":"keyvault_secret_get"}},"params":{"name":"storage","arguments":{"command":"storage_blob_get"}}}';
  let r = f.fromAgent(dupParams);
  assert.equal(r.forward, JSON.stringify(JSON.parse(dupParams)));
  assert.doesNotMatch(r.forward, /secret/);
  const dupCommand = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"keyvault","arguments":{"command":"keyvault_secret_get","command":"keyvault_key_get"}}}';
  r = f.fromAgent(dupCommand);
  assert.equal(r.forward, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"keyvault","arguments":{"command":"keyvault_key_get"}}}');
  // Other messages too, and spacing doesn't matter.
  const spaced = '{ "jsonrpc": "2.0", "id": 4, "method": "initialize", "params": {}, "method": "initialize" }';
  assert.deepEqual(f.fromAgent(spaced), { forward: '{"jsonrpc":"2.0","id":4,"method":"initialize","params":{}}' });
  assert.deepEqual(logs.map((l) => [l.tool, l.refused]), [['storage:storage_blob_get', false], ['keyvault:keyvault_key_get', false]]);
});

test('a second command key in another case is refused with the read-only text, and logged refused', () => {
  for (const id of ['azure', 'azuredevops']) {
    const logs = [];
    const f = createFilter({ id, log: (e) => logs.push(e) });
    f.fromAgent(listReq);
    f.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'storage' }] } }));
    for (const [n, args] of [[2, { command: 'storage_account_get', Command: 'keyvault_secret_get' }], [3, { COMMAND: 'storage_blob_get' }], [4, { cOmmand: 'x', intent: 'y' }]]) {
      const r = f.fromAgent(callArgs(n, 'storage', args));
      assert.equal(r.forward, undefined, JSON.stringify(args));
      assert.deepEqual(JSON.parse(r.reply), { jsonrpc: '2.0', id: n, result: { isError: true, content: [{ type: 'text', text: `VaultOS has ${id} read-only for automations, so storage is off.` }] } });
    }
    assert.deepEqual(logs.map((l) => [l.tool, l.refused]), [['storage:storage_account_get', true], ['storage', true], ['storage', true]]);
    // Only the exact key counts as the sub-command; others named differently pass.
    const ok = callArgs(5, 'storage', { command: 'storage_blob_get', commandLine: 'x', subcommand: 'y' });
    assert.deepEqual(f.fromAgent(ok), { forward: ok });
  }
});

test('insights get is refused wherever it appears, with any separator', () => {
  const logs = [];
  const f = createFilter({ id: 'azure', log: (e) => logs.push(e) });
  f.fromAgent(listReq);
  f.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'monitor' }, { name: 'insights' }, { name: 'monitor_insights_get' }] } }));
  for (const [n, c] of [['monitor', 'monitor_insights_get'], ['insights', 'Insights-Get'], ['insights', 'insightsget'], ['insights', 'insights_get_report']]) {
    const r = f.fromAgent(callArgs(2, n, { command: c }));
    assert.equal(r.forward, undefined, c);
    assert.deepEqual(JSON.parse(r.reply), secretRefusal(2, c));
  }
  const byName = f.fromAgent(callArgs(3, 'monitor_insights_get', {}));
  assert.deepEqual(JSON.parse(byName.reply), secretRefusal(3, 'monitor_insights_get'));
  const fine = callArgs(4, 'insights', { command: 'insights_list' });
  assert.deepEqual(f.fromAgent(fine), { forward: fine });
  assert.ok(logs.slice(0, 5).every((l) => l.refused));
});
