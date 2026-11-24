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
