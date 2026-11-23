'use strict';
// The config writers for the agents beyond Claude Code and Cursor: Copilot, OpenCode, Kilo, Antigravity (JSON files)
// and Codex (TOML, read and checked through its own CLI, faked here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../lib/connector-agents');

const HTTP = { kind: 'http', url: 'http://127.0.0.1:8080/mcp/teamschats', headers: { 'X-VaultOS-Key': 'k"ey' } };
const STDIO = { kind: 'stdio', command: '/h/.local/bin/azmcp', args: ['server', 'start', '--read-only'] };
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('translators: each agent gets its own shape', () => {
  assert.deepEqual(A.toCopilot(HTTP), { type: 'http', url: HTTP.url, headers: HTTP.headers, tools: ['*'] });
  assert.deepEqual(A.toCopilot(STDIO), { type: 'local', command: STDIO.command, args: STDIO.args, tools: ['*'] });
  assert.deepEqual(A.toOpenCode(HTTP), { type: 'remote', url: HTTP.url, headers: HTTP.headers, enabled: true });
  assert.deepEqual(A.toOpenCode(STDIO), { type: 'local', command: [STDIO.command, ...STDIO.args], enabled: true });
  assert.deepEqual(A.toAntigravity(HTTP), { serverUrl: HTTP.url, headers: HTTP.headers });
  assert.deepEqual(A.toCodex(HTTP), { url: HTTP.url, http_headers: HTTP.headers });
  assert.deepEqual(A.toCodex({ kind: 'http', url: 'https://x.example/mcp' }), { url: 'https://x.example/mcp' });
  assert.deepEqual(A.toCodex(STDIO), { command: STDIO.command, args: STDIO.args });
  // the hash tells two Antigravity or Codex entries apart by their address
  assert.notEqual(A.entryHash(A.toAntigravity(HTTP)), A.entryHash(A.toAntigravity({ ...HTTP, url: 'http://127.0.0.1:8080/mcp/other' })));
  assert.notEqual(A.entryHash(A.toCodex(HTTP)), A.entryHash(A.toCodex({ ...HTTP, headers: { 'X-VaultOS-Key': 'other' } })));
});

test('copilot writes ~/.copilot/mcp-config.json, 0600, keeping everything else', async () => {
  const home = tmpHome();
  const file = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { type: 'local', command: 'x' } }, other: 1 }));
  const w = A.copilotWriter({ home });
  assert.equal(w.id, 'copilot');
  await w.put('teamschats', A.toCopilot(HTTP));
  assert.deepEqual(readJson(file), { mcpServers: { mine: { type: 'local', command: 'x' }, teamschats: A.toCopilot(HTTP) }, other: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys((await w.list()).user), ['mine', 'teamschats']);
  await w.remove('teamschats');
  assert.deepEqual(readJson(file), { mcpServers: { mine: { type: 'local', command: 'x' } }, other: 1 });
});

test('opencode: a new file uses mcp.<name>; a file already on mcp.servers keeps that layout', async () => {
  const home = tmpHome();
  const dir = path.join(home, '.config', 'opencode');
  let w = await A.opencodeWriter({ home });
  await w.put('teamschats', A.toOpenCode(HTTP));
  assert.deepEqual(readJson(path.join(dir, 'opencode.json')), { mcp: { teamschats: A.toOpenCode(HTTP) } });

  const home2 = tmpHome();
  const dir2 = path.join(home2, '.config', 'opencode');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { mine: { type: 'local', command: ['x'] } } } }));
  w = await A.opencodeWriter({ home: home2 });
  await w.put('azure', A.toOpenCode(STDIO));
  assert.deepEqual(readJson(path.join(dir2, 'opencode.json')).mcp.servers, { mine: { type: 'local', command: ['x'] }, azure: A.toOpenCode(STDIO) });
  assert.equal(readJson(path.join(dir2, 'opencode.json')).$schema, 'https://opencode.ai/config.json');
  assert.ok(dir);
});

test('kilo: uses the config file that exists, else makes kilo.jsonc; a file with comments is left alone', async () => {
  const home = tmpHome();
  const dir = path.join(home, '.config', 'kilo');
  let w = await A.kiloWriter({ home });
  await w.put('teamschats', A.toOpenCode(HTTP));
  assert.deepEqual(readJson(path.join(dir, 'kilo.jsonc')), { mcp: { teamschats: A.toOpenCode(HTTP) } });

  const home2 = tmpHome();
  const dir2 = path.join(home2, '.config', 'kilo');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'opencode.json'), JSON.stringify({ mcp: {} }));
  w = await A.kiloWriter({ home: home2 });
  await w.put('teamschats', A.toOpenCode(HTTP));
  assert.ok(readJson(path.join(dir2, 'opencode.json')).mcp.teamschats);
  assert.ok(!fs.existsSync(path.join(dir2, 'kilo.jsonc')));

  const home3 = tmpHome();
  const dir3 = path.join(home3, '.config', 'kilo');
  fs.mkdirSync(dir3, { recursive: true });
  const commented = '{\n  // my servers\n  "mcp": {}\n}\n';
  fs.writeFileSync(path.join(dir3, 'kilo.jsonc'), commented);
  w = await A.kiloWriter({ home: home3 });
  await assert.rejects(() => w.put('teamschats', A.toOpenCode(HTTP)), A.AgentConfigError);
  assert.equal(fs.readFileSync(path.join(dir3, 'kilo.jsonc'), 'utf8'), commented);
});

test('antigravity writes ~/.gemini/config/mcp_config.json with serverUrl', async () => {
  const home = tmpHome();
  const w = A.antigravityWriter({ home });
  await w.put('teamschats', A.toAntigravity(HTTP));
  await w.put('azure', A.toAntigravity(STDIO));
  assert.deepEqual(readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')), {
    mcpServers: { teamschats: { serverUrl: HTTP.url, headers: HTTP.headers }, azure: { command: STDIO.command, args: STDIO.args } },
  });
});

test('a damaged servers object is an AgentConfigError and the file is untouched', async () => {
  const home = tmpHome();
  const file = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{"mcpServers": [1]}');
  await assert.rejects(() => A.copilotWriter({ home }).put('x', A.toCopilot(HTTP)), /mcpServers isn't an object/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mcpServers": [1]}');
});

// ---- Codex: TOML, through a fake `codex mcp` that reads the same file ----
function fakeCodex(file, { misread = false } = {}) {
  const parse = () => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    const re = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
    for (const m of text.matchAll(re)) {
      const name = m[1] || m[2];
      const body = m[3];
      const val = (k) => { const x = new RegExp(`^${k} = (.*)$`, 'm').exec(body); return x ? x[1] : undefined; };
      if (val('url')) {
        const headers = {};
        const h = val('http_headers');
        if (h) for (const [, k, v] of h.matchAll(/"((?:[^"\\]|\\.)*)" = "((?:[^"\\]|\\.)*)"/g)) headers[JSON.parse(`"${k}"`)] = JSON.parse(`"${v}"`);
        out.push({ name, transport: { type: 'streamable_http', url: misread ? 'http://wrong/' : JSON.parse(val('url')), http_headers: Object.keys(headers).length ? headers : null } });
      } else out.push({ name, transport: { type: 'stdio', command: JSON.parse(val('command')), args: JSON.parse(val('args') || '[]'), env: null } });
    }
    return out;
  };
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'codex mcp list --json') return { code: 0, stdout: JSON.stringify(parse()), stderr: 'WARNING: noise' };
    let m = /^codex mcp get '([^']+)' --json$/.exec(cmd);
    if (m) { const x = parse().find((e) => e.name === m[1]); return x ? { code: 0, stdout: JSON.stringify(x), stderr: '' } : { code: 1, stdout: '', stderr: 'not found' }; }
    m = /^codex mcp remove '([^']+)'$/.exec(cmd);
    if (m) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.replace(new RegExp(`\\[mcp_servers\\.(?:"${m[1]}"|${m[1]})\\]\\n[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, 'm'), ''));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 127, stdout: '', stderr: 'unknown' };
  };
  return { run, calls };
}

test('codex appends its own table, keeps the rest of config.toml, and reads it back through codex', async () => {
  const dir = tmpHome();
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "x"\nargs = []\n');
  const { run, calls } = fakeCodex(file);
  const w = A.codexWriter({ home: '/nowhere', run, env: { CODEX_HOME: dir } });
  await w.put('teamschats', A.toCodex(HTTP));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "x"\nargs = []\n\n'));
  assert.ok(text.endsWith('[mcp_servers."teamschats"]\nurl = "http://127.0.0.1:8080/mcp/teamschats"\nhttp_headers = { "X-VaultOS-Key" = "k\\"ey" }\n'));
  assert.ok(calls.includes("codex mcp get 'teamschats' --json"));
  const { user } = await w.list();
  assert.deepEqual(user.teamschats, A.toCodex(HTTP));
  assert.deepEqual(user.mine, { command: 'x', args: [] });
  // a rewrite replaces the table rather than adding a second one
  await w.put('teamschats', A.toCodex({ ...HTTP, headers: { 'X-VaultOS-Key': 'new' } }));
  assert.equal(fs.readFileSync(file, 'utf8').split('[mcp_servers."teamschats"]').length, 2);
  await w.put('azure', A.toCodex(STDIO));
  assert.deepEqual((await w.list()).user.azure, A.toCodex(STDIO));
  await w.remove('teamschats');
  assert.ok(!('teamschats' in (await w.list()).user));
  assert.match(fs.readFileSync(file, 'utf8'), /^model = "gpt-5"/);
});

test('codex: when codex reads the entry back differently, config.toml is put back as it was', async () => {
  const dir = tmpHome();
  const file = path.join(dir, 'config.toml');
  const before = 'model = "gpt-5"\n';
  fs.writeFileSync(file, before);
  const { run } = fakeCodex(file, { misread: true });
  const w = A.codexWriter({ home: '/nowhere', run, env: { CODEX_HOME: dir } });
  await assert.rejects(() => w.put('teamschats', A.toCodex(HTTP)), /put back as it was/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('codex: mcp_servers set in one line is left alone', async () => {
  const dir = tmpHome();
  const file = path.join(dir, 'config.toml');
  const before = 'mcp_servers = { mine = { command = "x" } }\n';
  fs.writeFileSync(file, before);
  const { run } = fakeCodex(file);
  const w = A.codexWriter({ home: '/nowhere', run, env: { CODEX_HOME: dir } });
  await assert.rejects(() => w.put('teamschats', A.toCodex(HTTP)), A.AgentConfigError);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('codex: a missing config.toml is created; a failing codex list is an AgentConfigError', async () => {
  const dir = tmpHome();
  const file = path.join(dir, 'config.toml');
  const { run } = fakeCodex(file);
  const w = A.codexWriter({ home: '/nowhere', run, env: { CODEX_HOME: dir } });
  await w.put('teamschats', A.toCodex(HTTP));
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('[mcp_servers."teamschats"]\n'));
  const broken = A.codexWriter({ home: '/nowhere', run: async () => ({ code: 1, stdout: '', stderr: 'bad config' }), env: { CODEX_HOME: dir } });
  await assert.rejects(() => broken.list(), A.AgentConfigError);
});

test('codexTable writes TOML strings safely', () => {
  assert.equal(A.codexTable('x', { command: 'a b"c', args: ['--k=v', 'q\\r'] }), '[mcp_servers."x"]\ncommand = "a b\\"c"\nargs = ["--k=v", "q\\\\r"]\n');
});

// ---- per-agent entries ----
test('sync: wanted can differ per agent', async () => {
  const mem = (id) => {
    const user = {};
    return { id, translate: A.toCursor, user, async list() { return { user: { ...user }, perFolder: {} }; }, async put(n, e) { user[n] = e; }, async remove(n) { delete user[n]; } };
  };
  const claude = mem('claude'); const cursor = mem('cursor');
  const wanted = (a) => (a === 'cursor' ? { 'cursor-teams': { kind: 'http', url: 'https://api.cursor.com/rest-mcp/teams/mcp' } } : { teamschats: HTTP });
  const r = await A.syncAgents({ wanted, writers: [claude, cursor], written: {} });
  assert.deepEqual(Object.keys(claude.user), ['teamschats']);
  assert.deepEqual(Object.keys(cursor.user), ['cursor-teams']);
  assert.deepEqual(Object.keys(r.written.cursor), ['cursor-teams']);
});
