'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AgentConfigError, toClaude, toCursor, entryHash, claudeWriter, cursorWriter, syncAgents,
} = require('../lib/connector-agents');

const HTTP = { kind: 'http', url: 'http://127.0.0.1:7684/mcp/atlassian', headers: { 'X-VaultOS-Key': 'k' } };
const STDIO = { kind: 'stdio', command: '/h/.local/bin/azmcp', args: ['server', 'start', '--read-only'] };
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));

test('toClaude and toCursor shapes', () => {
  assert.deepEqual(toClaude(HTTP), { type: 'http', url: HTTP.url, headers: HTTP.headers });
  assert.deepEqual(toCursor(HTTP), { url: HTTP.url, headers: HTTP.headers });
  assert.deepEqual(toClaude(STDIO), { type: 'stdio', command: STDIO.command, args: STDIO.args });
  assert.deepEqual(toCursor(STDIO), { command: STDIO.command, args: STDIO.args });
});

test('entryHash ignores key order and an empty env', () => {
  const a = { type: 'http', url: 'u', headers: { a: '1', b: '2' } };
  const b = { headers: { b: '2', a: '1' }, url: 'u', type: 'http' };
  assert.equal(entryHash(a), entryHash(b));
  assert.match(entryHash(a), /^[0-9a-f]{64}$/);
  assert.equal(entryHash({ ...toClaude(STDIO), env: {} }), entryHash(toClaude(STDIO)));
  assert.notEqual(entryHash({ ...toClaude(STDIO), env: { A: '1' } }), entryHash(toClaude(STDIO)));
});

test('cursor put keeps other servers and keys', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.cursor'));
  const f = path.join(home, '.cursor/mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }));
  const w = cursorWriter({ home });
  await w.put('atlassian', toCursor(HTTP));
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), { mcpServers: { mine: { command: 'x' }, atlassian: toCursor(HTTP) }, other: 1 });
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n');
  await w.remove('atlassian');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mcpServers: { mine: { command: 'x' } }, other: 1 });
});

test('cursor creates ~/.cursor when missing', async () => {
  const home = tmpHome();
  const w = cursorWriter({ home });
  assert.deepEqual(await w.list(), { user: {}, perFolder: {} });
  await w.put('azure', toCursor(STDIO));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')), { mcpServers: { azure: toCursor(STDIO) } });
});

test('cursor invalid JSON: AgentConfigError, file untouched', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.cursor'));
  const f = path.join(home, '.cursor/mcp.json');
  fs.writeFileSync(f, '{ "mcpServers": { oops, }');
  const before = fs.readFileSync(f);
  const w = cursorWriter({ home });
  await assert.rejects(() => w.put('atlassian', toCursor(HTTP)), AgentConfigError);
  await assert.rejects(() => w.remove('atlassian'), AgentConfigError);
  await assert.rejects(() => w.list(), AgentConfigError);
  assert.ok(before.equals(fs.readFileSync(f)));
});

test('claude put runs remove then add-json with --scope user and quoted JSON', async () => {
  const cmds = [];
  const run = async (c) => { cmds.push(c); return { code: cmds.length === 1 ? 1 : 0, stdout: '', stderr: '' }; };
  const w = claudeWriter({ home: tmpHome(), run });
  await w.put('atlassian', toClaude(HTTP));
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0], "claude mcp remove --scope user 'atlassian'");
  assert.equal(cmds[1], `claude mcp add-json --scope user 'atlassian' '${JSON.stringify(toClaude(HTTP))}'`);
});

test('claude put throws when add-json fails, without leaking the entry', async () => {
  const run = async (c) => ({ code: c.includes('add-json') ? 2 : 0, stdout: '', stderr: 'k' });
  const w = claudeWriter({ home: tmpHome(), run });
  await assert.rejects(() => w.put('atlassian', toClaude(HTTP)), (e) => !e.message.includes('X-VaultOS-Key') && !e.message.includes('127.0.0.1'));
});

test('claude remove ignores a failure when the entry is already gone, throws otherwise', async () => {
  const home = tmpHome();
  const run = async () => ({ code: 1, stdout: '', stderr: '' });
  const w = claudeWriter({ home, run });
  await w.remove('atlassian'); // no ~/.claude.json: gone
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { atlassian: {} } }));
  await assert.rejects(() => w.remove('atlassian'));
});

test('claude list reports per-folder entries of the same name', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { azure: { type: 'stdio', command: 'c', args: [] } },
    projects: { '/w/a': { mcpServers: { atlassian: {} } }, '/w/b': { mcpServers: { atlassian: {} } }, '/w/c': {} },
  }));
  const l = await claudeWriter({ home, run: async () => ({ code: 0 }) }).list();
  assert.deepEqual(Object.keys(l.user), ['azure']);
  assert.deepEqual(l.perFolder, { atlassian: ['/w/a', '/w/b'] });
});

test('claude list: invalid ~/.claude.json is an AgentConfigError', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), '{nope');
  await assert.rejects(() => claudeWriter({ home, run: async () => ({ code: 0 }) }).list(), AgentConfigError);
});

function memWriter(id, initial = {}, { failList } = {}) {
  const user = { ...initial };
  const calls = [];
  return {
    id, label: id, calls, user, translate: toCursor,
    async list() { if (failList) throw new Error('boom'); return { user: { ...user }, perFolder: { atlassian: ['/w/a'] } }; },
    async put(n, e) { calls.push(['put', n]); user[n] = e; },
    async remove(n) { calls.push(['remove', n]); delete user[n]; },
  };
}

test('sync adds, rewrites when changed, removes when unwanted', async () => {
  const w = memWriter('cursor');
  let r = await syncAgents({ wanted: { atlassian: HTTP, azure: STDIO }, writers: [w], written: {} });
  assert.deepEqual(w.calls, [['put', 'atlassian'], ['put', 'azure']]);
  assert.equal(r.written.cursor.atlassian, entryHash(toCursor(HTTP)));
  assert.equal(r.agents.cursor.ok, true);
  assert.deepEqual(r.agents.cursor.perFolder, { atlassian: ['/w/a'] });

  w.calls.length = 0;
  r = await syncAgents({ wanted: { atlassian: HTTP, azure: STDIO }, writers: [w], written: r.written });
  assert.deepEqual(w.calls, []);

  const moved = { ...HTTP, url: 'http://127.0.0.1:9/mcp/atlassian' };
  r = await syncAgents({ wanted: { atlassian: moved, azure: STDIO }, writers: [w], written: r.written });
  assert.deepEqual(w.calls, [['put', 'atlassian']]);
  assert.equal(r.written.cursor.atlassian, entryHash(toCursor(moved)));

  w.calls.length = 0;
  r = await syncAgents({ wanted: { azure: STDIO }, writers: [w], written: r.written });
  assert.deepEqual(w.calls, [['remove', 'atlassian']]);
  assert.deepEqual(Object.keys(r.written.cursor), ['azure']);
  assert.deepEqual(Object.keys(w.user), ['azure']);
});

test('sync leaves a foreign same-named entry alone and reports it', async () => {
  const own = { url: 'https://x.example/mcp' };
  const w = memWriter('cursor', { atlassian: own });
  const r = await syncAgents({ wanted: { atlassian: HTTP }, writers: [w], written: {} });
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.user.atlassian, own);
  assert.deepEqual(r.agents.cursor.foreign, ['atlassian']);
  assert.equal(r.agents.cursor.ok, true);
  assert.equal(r.written.cursor.atlassian, undefined);
});

test('sync: a hand-edited entry we wrote is foreign now, and unwanting it does not remove it', async () => {
  const w = memWriter('cursor', { atlassian: { url: 'edited' } });
  const written = { cursor: { atlassian: entryHash(toCursor(HTTP)) } };
  let r = await syncAgents({ wanted: { atlassian: HTTP }, writers: [w], written });
  assert.deepEqual(r.agents.cursor.foreign, ['atlassian']);
  r = await syncAgents({ wanted: {}, writers: [w], written });
  assert.deepEqual(w.calls, []);
  assert.deepEqual(r.written.cursor, {});
});

test('sync: invalid cursor JSON gives ok:false, nothing written, file intact', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.cursor'));
  const f = path.join(home, '.cursor/mcp.json');
  fs.writeFileSync(f, '{ bad');
  const before = fs.readFileSync(f);
  const r = await syncAgents({ wanted: { atlassian: HTTP }, writers: [cursorWriter({ home })], written: { cursor: { old: 'h' } } });
  assert.equal(r.agents.cursor.ok, false);
  assert.match(r.agents.cursor.error, /mcp\.json/);
  assert.deepEqual(r.written.cursor, { old: 'h' });
  assert.ok(before.equals(fs.readFileSync(f)));
});

test("sync: one writer throwing doesn't stop the other", async () => {
  const bad = memWriter('claude', {}, { failList: true });
  const good = memWriter('cursor');
  const r = await syncAgents({ wanted: { atlassian: HTTP }, writers: [bad, good], written: { claude: { x: 'h' } } });
  assert.deepEqual(r.agents.claude, { ok: false, error: 'boom', foreign: [], perFolder: {} });
  assert.deepEqual(r.written.claude, { x: 'h' });
  assert.equal(r.agents.cursor.ok, true);
  assert.ok(r.written.cursor.atlassian);
});

test('sync: partial failure keeps completed puts in written; next sync treats them as ours', async () => {
  const w = memWriter('cursor');
  const realPut = w.put;
  w.put = async (n, e) => { if (n === 'azure') throw new Error('boom'); return realPut(n, e); };
  let r = await syncAgents({ wanted: { atlassian: HTTP, azure: STDIO }, writers: [w], written: {} });
  assert.equal(r.agents.cursor.ok, false);
  assert.equal(r.written.cursor.atlassian, entryHash(toCursor(HTTP)));
  assert.equal(r.written.cursor.azure, undefined);
  const good = memWriter('cursor', { atlassian: toCursor(HTTP) });
  r = await syncAgents({ wanted: { atlassian: HTTP, azure: STDIO }, writers: [good], written: r.written });
  assert.deepEqual(r.agents.cursor.foreign, []);
  assert.deepEqual(good.calls, [['put', 'azure']]);
});

test('sync adopts a present entry identical to what it would write', async () => {
  const w = memWriter('cursor', { atlassian: toCursor(HTTP) });
  const r = await syncAgents({ wanted: { atlassian: HTTP }, writers: [w], written: {} });
  assert.deepEqual(w.calls, []);
  assert.deepEqual(r.agents.cursor.foreign, []);
  assert.equal(r.written.cursor.atlassian, entryHash(toCursor(HTTP)));
});

test('cursor: damaged mcpServers or top level is an AgentConfigError, file untouched', async () => {
  for (const body of ['{"mcpServers":"x"}', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":5}', '[]', 'null', '7']) {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'));
    const f = path.join(home, '.cursor/mcp.json');
    fs.writeFileSync(f, body);
    const w = cursorWriter({ home });
    await assert.rejects(() => w.put('atlassian', toCursor(HTTP)), (e) => e instanceof AgentConfigError && /Couldn't read `~\/\.cursor\/mcp\.json`/.test(e.message), body);
    await assert.rejects(() => w.remove('atlassian'), AgentConfigError, body);
    await assert.rejects(() => w.list(), AgentConfigError, body);
    assert.equal(fs.readFileSync(f, 'utf8'), body);
  }
});
