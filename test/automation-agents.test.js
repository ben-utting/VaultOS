'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../lib/automation-agents');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const fakeCmd = (level = 'report') => `'${process.execPath}' '${FAKE}' ${level}`;
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-agents-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('claude adapter puts the prompt on stdin, limits tools per level, turns hooks off', () => {
  const r = A.agentCommand('claude', 'report', 'P');
  assert.equal(r.input, 'P');
  for (const part of ['claude -p', '--tools Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', `--settings '{"disableAllHooks":true}'`]) {
    assert.ok(r.cmd.includes(part), `${part} in ${r.cmd}`);
  }
  assert.ok(!r.cmd.includes('Edit'));
  const w = A.agentCommand('claude', 'work', 'P');
  assert.ok(w.cmd.includes('--tools Read,Grep,Glob,Edit,Write'));
  assert.ok(w.cmd.includes('--permission-mode acceptEdits'));
});

test('pi is not offered yet: its reads are not confined to the card folder', () => {
  assert.deepEqual(A.offeredLevels('pi'), []);
  assert.match(A.agentCommand('pi', 'report', 'P').error, /not available/);
});

test('agents without an adapter are refused', () => {
  assert.match(A.agentCommand('codex', 'report', 'P').error, /not available/);
  assert.deepEqual(A.offeredLevels('codex'), []);
  assert.deepEqual(A.offeredLevels('claude'), ['report', 'update', 'work']);
});

// ---------- Cursor CLI ----------

test('cursor is offered for report and update, not work (it could create files outside the card)', () => {
  assert.deepEqual(A.offeredLevels('cursor'), ['report', 'update']);
  assert.match(A.agentCommand('cursor', 'work', 'P').error, /Cursor CLI is not available for automations at the Work level/);
});

test('cursor command: prompt on stdin, its own Cursor home with the real sign-in, ask mode', () => {
  const r = A.agentCommand('cursor', 'report', 'P', { home: '/h' });
  assert.equal(r.input, 'P');
  for (const part of [
    'XDG_CONFIG_HOME=/h/.config', 'HOME=/h/.cache/vaultos/automation-cursor',
    'CURSOR_CONFIG_DIR=/h/.cache/vaultos/automation-cursor/.cursor', 'CURSOR_DATA_DIR=/h/.cache/vaultos/automation-cursor/.cursor',
    '"$(command -v cursor-agent || command -v agent)"', '-p', '--output-format text', '--trust', '--mode ask',
  ]) assert.ok(r.cmd.includes(part), `${part} in ${r.cmd}`);
  assert.ok(r.cmd.indexOf('XDG_CONFIG_HOME=') < r.cmd.indexOf('HOME=/h/.cache'), 'the sign-in path is set from the real home');
  for (const bad of ['--force', '--yolo', '--approve-mcps', '--sandbox']) assert.ok(!r.cmd.includes(bad), `${bad} in ${r.cmd}`);
  assert.equal(A.agentCommand('cursor', 'update', 'P', { home: '/h' }).cmd, r.cmd);
});

test('cursor command keeps an XDG_CONFIG_HOME the server already has', () => {
  const r = A.agentCommand('cursor', 'report', 'P', { home: '/h', xdgConfig: '/x/conf' });
  assert.ok(r.cmd.includes('XDG_CONFIG_HOME=/x/conf'), r.cmd);
});

// ---------- The automation's model ----------
const count = (s, part) => s.split(part).length - 1;

test('cursor command: no model, or a blank one, passes no --model', () => {
  for (const opts of [{ home: '/h' }, { home: '/h', model: '' }, { home: '/h', model: null }, { home: '/h', model: '   ' }]) {
    const r = A.agentCommand('cursor', 'report', 'P', opts);
    assert.ok(!r.cmd.includes('--model'), r.cmd);
  }
});

test('cursor command: a set model is passed once, shell-quoted, after the read-only flags', () => {
  const r = A.agentCommand('cursor', 'report', 'P', { home: '/h', model: 'gpt-5' });
  assert.equal(count(r.cmd, '--model'), 1, r.cmd);
  assert.ok(r.cmd.endsWith(" --trust --mode ask --model 'gpt-5'"), r.cmd);
  assert.equal(r.input, 'P', 'the prompt still goes on stdin');
  const p = A.agentCommand('cursor', 'update', 'P', { home: '/h', model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' });
  assert.equal(count(p.cmd, '--model'), 1, p.cmd);
  assert.ok(p.cmd.includes(" --mode ask --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'"), p.cmd);
});

test('cursor command: a model holding shell syntax stays one quoted word', () => {
  const r = A.agentCommand('cursor', 'report', 'P', { home: '/h', model: "x'; touch /tmp/pwned; echo '" });
  assert.ok(r.cmd.endsWith(` --model 'x'\\''; touch /tmp/pwned; echo '\\'''`), r.cmd);
  for (const bad of ['--force', '--yolo', '--approve-mcps', '--sandbox']) assert.ok(!r.cmd.includes(bad), `${bad} in ${r.cmd}`);
});

test('a model is never passed to another agent', () => {
  for (const level of ['report', 'update', 'work']) {
    const r = A.agentCommand('claude', level, 'P', { model: 'gpt-5' });
    assert.ok(!r.cmd.includes('--model'), r.cmd);
    assert.ok(!r.cmd.includes('gpt-5'), r.cmd);
    assert.equal(r.cmd, A.agentCommand('claude', level, 'P').cmd);
  }
});

test('cursor models command: --list-models from the automation Cursor home with the real sign-in', () => {
  const r = A.cursorModelsCommand({ home: '/h' });
  for (const part of [
    'XDG_CONFIG_HOME=/h/.config', 'HOME=/h/.cache/vaultos/automation-cursor', 'CURSOR_CONFIG_DIR=/h/.cache/vaultos/automation-cursor/.cursor',
    '"$(command -v cursor-agent || command -v agent)" --list-models',
  ]) assert.ok(r.cmd.includes(part), `${part} in ${r.cmd}`);
  assert.ok(!r.cmd.includes(' -p'), r.cmd);
});

test('parseCursorModels reads ids and labels from --list-models output', () => {
  const out = [
    '\u001b[1mAvailable models\u001b[0m', '',
    'auto - Auto (current, default)',
    'gpt-5.3-codex - Codex 5.3',
    'grok-4.7-low-fast - Grok 4.7  Low Fast​​',
    'claude-opus-4-8[context=1m] - Opus 4.8 1M',
    'Tip: use --model <id>', 'gpt-5.3-codex - Codex 5.3',
  ].join('\n');
  assert.deepEqual(A.parseCursorModels(out), [
    { id: 'auto', label: 'Auto (current, default)' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'grok-4.7-low-fast', label: 'Grok 4.7 Low Fast' },
    { id: 'claude-opus-4-8[context=1m]', label: 'Opus 4.8 1M' },
  ]);
  assert.deepEqual(A.parseCursorModels('Error: not signed in'), []);
  assert.deepEqual(A.parseCursorModels(''), []);
});

// Cursor's permission globs (checked 2026-11-11 in its bundle): Kind(pattern), only `*` is a wildcard and it
// matches anything, "/" and dot files included; the rest is literal; a deny wins over any allow.
const denies = (rules, kind, p) => rules.some((r) => {
  const m = r.match(/^(\w+)\((.*)\)$/);
  if (!m || m[1] !== kind) return false;
  const re = new RegExp(`^${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
  return re.test(p);
});

// root/vault/{secret.txt, .hidden/secret.txt, Work/{card-a/{task.md, sub/x.md}, card-b/notes.txt, card-a-old/notes.txt}}
function cursorTree(t) {
  const root = fs.realpathSync(tmp(t));
  const v = path.join(root, 'vault');
  const card = path.join(v, 'Work', 'card-a');
  for (const d of ['.hidden', 'Work/card-a/sub', 'Work/card-b', 'Work/card-a-old']) fs.mkdirSync(path.join(v, d), { recursive: true });
  for (const [f, s] of [['secret.txt', 'S1'], ['.hidden/secret.txt', 'S2'], ['Work/card-a/task.md', 'T'], ['Work/card-a/sub/x.md', 'X'],
    ['Work/card-b/notes.txt', 'S3'], ['Work/card-a-old/notes.txt', 'S4']]) fs.writeFileSync(path.join(v, f), s);
  return { root, v, card };
}
// cursorRules lists every sibling on the way to the card, the temp folder's own entries included, and other test
// files running alongside add and remove entries there all the time. So rules taken at two moments are compared
// without the Read rules for temp-folder entries other than this test's own root.
function steadyRules(rules, root) {
  return rules.filter((r) => {
    const m = /^Read\((.+?)(\/\*)?\)$/.exec(r);
    return !m || path.dirname(m[1]) !== path.dirname(root) || m[1] === root;
  });
}
const steadyConfig = (text, root) => {
  const c = JSON.parse(text);
  return JSON.stringify({ ...c, permissions: { ...c.permissions, deny: steadyRules(c.permissions.deny, root) } }, null, 2);
};

test('cursor rules: the card folder is readable, nothing outside it is', async (t) => {
  const { root, v, card } = cursorTree(t);
  const rules = await A.cursorRules(card);
  for (const p of [`${card}/task.md`, `${card}/sub/x.md`, card]) assert.ok(!denies(rules, 'Read', p), `${p} should be readable`);
  for (const p of [`${v}/secret.txt`, `${v}/.hidden/secret.txt`, `${v}/Work/card-b/notes.txt`, `${v}/Work/card-a-old/notes.txt`,
    `${v}/Work/card-b`, '/etc/hostname']) assert.ok(denies(rules, 'Read', p), `${p} should be denied`);
  fs.writeFileSync(path.join(root, 'beside-vault.txt'), 'S5');
  assert.ok(denies(await A.cursorRules(card), 'Read', `${root}/beside-vault.txt`), 'every level up is covered');
});

test('cursor rules: no writes anywhere, no shell, web or MCP', async (t) => {
  const { v, card } = cursorTree(t);
  const rules = await A.cursorRules(card);
  for (const p of [`${card}/notes.txt`, `${card}/.cursor/hooks.json`, `${v}/new.txt`, '/tmp/x']) assert.ok(denies(rules, 'Write', p), p);
  for (const r of ['Shell(*)', 'WebFetch(*)', 'Mcp(*:*)']) assert.ok(rules.includes(r), r);
});

test('cursor rules: a symlink in the card that leads outside it is denied, one that stays inside is not', async (t) => {
  const { v, card } = cursorTree(t);
  fs.symlinkSync(path.join(v, 'Work', 'card-b', 'notes.txt'), path.join(card, 'sib-link.txt'));
  fs.symlinkSync(path.join(v, '.hidden'), path.join(card, 'sub', 'hidden-link'));
  fs.symlinkSync(path.join(card, 'sub'), path.join(card, 'inner-link'));
  fs.symlinkSync(path.join(v, 'gone'), path.join(card, 'dangling'));
  const rules = await A.cursorRules(card);
  for (const p of [`${card}/sib-link.txt`, `${card}/sub/hidden-link/secret.txt`, `${card}/dangling`]) assert.ok(denies(rules, 'Read', p), p);
  assert.ok(!denies(rules, 'Read', `${card}/inner-link/x.md`));
});

test('cursor rules use the real path when the card is reached through a symlink', async (t) => {
  const { root, card } = cursorTree(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.join(root, 'vault'), alias);
  const rules = await A.cursorRules(path.join(alias, 'Work', 'card-a'));
  assert.ok(!denies(rules, 'Read', `${card}/task.md`), 'the agent works from the real path');
  assert.ok(denies(rules, 'Read', path.join(root, 'vault', 'Work', 'card-b', 'notes.txt')));
  assert.ok(denies(rules, 'Read', path.join(alias, 'Work', 'card-b', 'notes.txt')), 'the alias is a sibling, so denied too');
});

test('cursor guard: hooks or MCP servers in the card folder skip it, other settings do not', async (t) => {
  const { card } = cursorTree(t);
  assert.equal(await A.cursorGuard(card), null);
  const put = (rel, s) => { fs.mkdirSync(path.dirname(path.join(card, rel)), { recursive: true }); fs.writeFileSync(path.join(card, rel), s); };
  put('.claude/settings.local.json', '{"outputStyle":"Concise"}');
  assert.equal(await A.cursorGuard(card), null);
  put('.claude/settings.local.json', '{"hooks":{}}');
  assert.equal(await A.cursorGuard(card), null, 'an empty hooks block loads nothing');
  put('.claude/settings.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}');
  assert.match(await A.cursorGuard(card), /\.claude\/settings\.json/);
  fs.rmSync(path.join(card, '.claude'), { recursive: true });
  put('.claude/settings.local.json', '{ not json');
  assert.match(await A.cursorGuard(card), /\.claude\/settings\.local\.json/);
  fs.rmSync(path.join(card, '.claude'), { recursive: true });
  put('.cursor/hooks.json', '{}');
  assert.match(await A.cursorGuard(card), /\.cursor\/hooks\.json/);
  fs.rmSync(path.join(card, '.cursor'), { recursive: true });
  put('.cursor/mcp.json', '{}');
  assert.match(await A.cursorGuard(card), /\.cursor\/mcp\.json/);
});

test('prepareAgent for cursor writes the card rules into its own Cursor home and clears old chats', async (t) => {
  const { v, card } = cursorTree(t);
  const home = tmp(t);
  const cur = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor');
  for (const d of ['chats/old', 'projects/old', 'ai-tracking', 'skills-cursor/keep']) fs.mkdirSync(path.join(cur, d), { recursive: true });
  assert.deepEqual(await A.prepareAgent('cursor', 'report', card, { home }), {});
  const cfg = JSON.parse(fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8'));
  assert.equal(cfg.version, 1);
  assert.deepEqual(cfg.permissions.allow, []);
  // What the rules mean, not a second snapshot: other tests add and remove folders in /tmp meanwhile.
  for (const r of ['Shell(*)', 'WebFetch(*)', 'Mcp(*:*)', 'Write(*)']) assert.ok(cfg.permissions.deny.includes(r), r);
  assert.ok(denies(cfg.permissions.deny, 'Read', `${v}/secret.txt`));
  assert.ok(denies(cfg.permissions.deny, 'Read', `${v}/Work/card-b/notes.txt`));
  assert.ok(!denies(cfg.permissions.deny, 'Read', `${card}/task.md`));
  for (const d of ['chats', 'projects', 'ai-tracking']) assert.ok(!fs.existsSync(path.join(cur, d)), `${d} cleared`);
  assert.ok(fs.existsSync(path.join(cur, 'skills-cursor', 'keep')), 'the rest of the Cursor home is kept');
});

test('prepareAgent for cursor skips a card whose folder has its own hooks, and leaves other agents alone', async (t) => {
  const { card } = cursorTree(t);
  const home = tmp(t);
  fs.mkdirSync(path.join(card, '.cursor'));
  fs.writeFileSync(path.join(card, '.cursor', 'hooks.json'), '{}');
  assert.match((await A.prepareAgent('cursor', 'report', card, { home })).skip, /hooks/);
  assert.deepEqual(await A.prepareAgent('claude', 'report', card, { home }), {});
  assert.deepEqual(fs.readdirSync(home), [], 'claude needs no preparation');
});

test('automationEnv strips terminal ids and sets TZ', () => {
  const env = A.automationEnv({ PATH: '/bin', VAULTOS_TERM_ID: '1', VAULTOS_TERM_TOKEN: 't', VAULTOS_HOOK_URL: 'u', HOME: '/h' }, 'Europe/London');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TZ: 'Europe/London', VAULTOS_AUTOMATION: '1' });
});

test('spawnAgent returns output and exit code', async (t) => {
  const r = await A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:note MARK:one', cwd: tmp(t), env: process.env, timeoutMs: 10000 }).done;
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.output, /```vaultos-note\nFake note\. MARK:one\n```/);
});

test('spawnAgent reports a crash', async (t) => {
  const r = await A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:crash', cwd: tmp(t), env: process.env, timeoutMs: 10000 }).done;
  assert.equal(r.code, 3);
  assert.match(r.output, /boom/);
});

test('spawnAgent times out and kills the process group', async (t) => {
  const t0 = Date.now();
  const r = await A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:hang', cwd: tmp(t), env: process.env, timeoutMs: 300 }).done;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 7000);
});

test('spawnAgent kill() ends it', async (t) => {
  const h = A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:hang', cwd: tmp(t), env: process.env, timeoutMs: 60000 });
  setTimeout(() => h.kill(), 200);
  const r = await h.done;
  assert.equal(r.killed, true);
  assert.equal(r.timedOut, false);
});

test('spawnAgent caps output', async (t) => {
  const r = await A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:flood', cwd: tmp(t), env: process.env, timeoutMs: 20000 }).done;
  assert.ok(r.output.length <= 256 * 1024, `length ${r.output.length}`);
  assert.match(r.output, /After the flood\.\n```\n$/);
});

test('snapshot and diff see a touched file and ignore .git', async (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'task.md'), 'x');
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, 'data'));
  fs.writeFileSync(path.join(d, 'data', 'a.txt'), 'a');
  const before = await A.snapshotDir(d);
  assert.deepEqual([...before.keys()].sort(), ['data/a.txt', 'task.md']);
  fs.writeFileSync(path.join(d, 'touched.txt'), 'x');
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'x');
  fs.writeFileSync(path.join(d, 'data', 'a.txt'), 'changed');
  assert.deepEqual(A.diffSnapshots(before, await A.snapshotDir(d)), ['data/a.txt', 'touched.txt']);
});

test('spawnAgent ends even when a child that left the process group holds the output open', { timeout: 20000 }, async (t) => {
  const t0 = Date.now();
  const r = await A.spawnAgent({ cmd: fakeCmd(), input: 'FAKE:orphan', cwd: tmp(t), env: process.env, timeoutMs: 20000 }).done;
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  assert.equal(r.code, 0);
  assert.match(r.output, /Left one behind\./);
});

test('agentConnectors: claude and cursor yes, pi no', () => {
  assert.equal(process.env.AUTOMATION_TEST_AGENT, undefined);
  assert.equal(A.agentConnectors('claude'), true);
  assert.equal(A.agentConnectors('cursor'), true);
  assert.equal(A.agentConnectors('pi'), false);
  assert.equal(A.agentConnectors('codex'), false);
});

// ---------- A run's MCP servers (connectors) ----------
const MCP = (file = '/tmp/x/mcp.json') => ({
  configFile: file,
  ids: ['atlassian', 'azure'],
  entries: {
    atlassian: { kind: 'http', url: 'http://127.0.0.1:1/mcp/atlassian', headers: { 'X-VaultOS-Key': 'ONEOFFKEY' } },
    azure: { kind: 'stdio', command: 'node', args: ['az.js'] },
  },
});

test('claude with connectors: its own config file and only those servers allowed', () => {
  const r = A.agentCommand('claude', 'report', 'P', { mcp: MCP() });
  assert.ok(r.cmd.endsWith('--mcp-config /tmp/x/mcp.json --allowedTools mcp__atlassian,mcp__azure'), r.cmd);
  assert.ok(r.cmd.includes('--strict-mcp-config'));
  assert.ok(!r.cmd.includes('ONEOFFKEY'));
  assert.equal(r.input, 'P');
});

test("claude without connectors: today's command exactly", () => {
  const base = 'claude -p --output-format text --strict-mcp-config --no-session-persistence --settings \'{"disableAllHooks":true}\'';
  assert.equal(A.agentCommand('claude', 'report', 'P').cmd, `${base} --tools Read,Grep,Glob`);
  assert.equal(A.agentCommand('claude', 'work', 'P').cmd, `${base} --tools Read,Grep,Glob,Edit,Write --permission-mode acceptEdits`);
  assert.equal(A.agentCommand('claude', 'work', 'P', { model: 'x' }).cmd, A.agentCommand('claude', 'work', 'P').cmd);
});

test('cursor command with connectors adds --approve-mcps; without, nothing changes', () => {
  const plain = A.agentCommand('cursor', 'report', 'P', { home: '/h' }).cmd;
  const withMcp = A.agentCommand('cursor', 'report', 'P', { home: '/h', mcp: MCP() }).cmd;
  assert.ok(!plain.includes('--approve-mcps'));
  assert.equal(withMcp, `${plain} --approve-mcps`);
  const m = A.agentCommand('cursor', 'report', 'P', { home: '/h', model: 'gpt-5', mcp: MCP() }).cmd;
  assert.ok(m.endsWith("--model gpt-5 --approve-mcps") || m.endsWith("--model 'gpt-5' --approve-mcps"), m);
  assert.ok(!withMcp.includes('ONEOFFKEY'));
});

test('cursor without connectors: cli-config.json byte-for-byte as before, and no mcp.json', async (t) => {
  const { root, card } = cursorTree(t);
  const home = tmp(t);
  const cur = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor');
  fs.mkdirSync(cur, { recursive: true });
  fs.writeFileSync(path.join(cur, 'mcp.json'), '{"stale":1}');
  await A.prepareAgent('cursor', 'report', card, { home });
  const text = fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8');
  const was = { version: 1, permissions: { allow: [], deny: await A.cursorRules(card) } };
  // Byte for byte, apart from the temp-folder entries other tests make and remove meanwhile.
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  assert.equal(steadyConfig(text, root), steadyConfig(JSON.stringify(was), root));
  assert.deepEqual((await A.cursorRules(card)).slice(0, 4), ['Shell(*)', 'WebFetch(*)', 'Mcp(*:*)', 'Write(*)']);
  assert.ok(!fs.existsSync(path.join(cur, 'mcp.json')), 'a stale mcp.json is removed');
});

test('cursor with connectors: mcp.json 0600 in its own home, and only Mcp(*:*) dropped from the deny list', async (t) => {
  const { root, card } = cursorTree(t);
  const home = tmp(t);
  const cur = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor');
  assert.deepEqual(await A.prepareAgent('cursor', 'report', card, { home, mcp: MCP() }), {});
  const file = path.join(cur, 'mcp.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {
    atlassian: { url: 'http://127.0.0.1:1/mcp/atlassian', headers: { 'X-VaultOS-Key': 'ONEOFFKEY' } },
    azure: { command: 'node', args: ['az.js'] },
  } });
  const withRules = JSON.parse(fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8')).permissions.deny;
  const without = await A.cursorRules(card);
  assert.deepEqual(steadyRules(withRules, root), steadyRules(without.filter((r) => r !== 'Mcp(*:*)'), root));
  assert.deepEqual(steadyRules(await A.cursorRules(card, { mcp: true }), root), steadyRules(withRules, root));
});

test("finishAgent removes cursor's mcp.json and does nothing for other agents", async (t) => {
  const { card } = cursorTree(t);
  const home = tmp(t);
  const file = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor', 'mcp.json');
  await A.prepareAgent('cursor', 'report', card, { home, mcp: MCP() });
  assert.ok(fs.existsSync(file));
  await A.finishAgent('cursor', { home });
  assert.ok(!fs.existsSync(file));
  await A.finishAgent('cursor', { home });
  assert.equal(await A.finishAgent('claude', { home, mcp: MCP() }), undefined);
});

test('the cursor guard still skips a card with its own .cursor/mcp.json when connectors are on', async (t) => {
  const { card } = cursorTree(t);
  const home = tmp(t);
  fs.mkdirSync(path.join(card, '.cursor'));
  fs.writeFileSync(path.join(card, '.cursor', 'mcp.json'), '{}');
  assert.match((await A.prepareAgent('cursor', 'report', card, { home, mcp: MCP() })).skip, /mcp\.json/);
  assert.ok(!fs.existsSync(path.join(home, '.cache')), 'nothing written for a skipped card');
});

test('test agent with connectors appends --mcp-config; without, its command is unchanged', () => {
  process.env.AUTOMATION_TEST_AGENT = FAKE;
  try {
    const plain = A.agentCommand('claude', 'report', 'P').cmd;
    assert.equal(plain, `${process.execPath} ${FAKE} report`);
    assert.equal(A.agentCommand('claude', 'report', 'P', { mcp: MCP('/tmp/c.json') }).cmd, `${plain} --mcp-config /tmp/c.json`);
  } finally { delete process.env.AUTOMATION_TEST_AGENT; }
});

test('fake agent FAKE:mcp calls the server in the config file: ok, refused, unsupported', async (t) => {
  const http = require('node:http');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const msg = JSON.parse(b);
      seen.push({ key: req.headers['x-vaultos-key'], method: msg.method, name: msg.params && msg.params.name, ct: req.headers['content-type'] });
      if (msg.params.name === 'denied') { res.writeHead(403); res.end('no'); return; }
      const bad = msg.params.name === 'write_it';
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x' }], isError: bad } });
      if (bad) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: message\ndata: ${body}\n\n`); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const dir = tmp(t);
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {
    atlassian: { type: 'http', url: `http://127.0.0.1:${srv.address().port}/m`, headers: { 'X-VaultOS-Key': 'K1' } },
    azure: { type: 'stdio', command: 'node', args: [] },
  } }));
  const run = (directive) => A.spawnAgent({ cmd: `${fakeCmd()} --mcp-config ${cfg}`, input: directive, cwd: dir, env: process.env, timeoutMs: 20000 }).done;
  assert.match((await run('FAKE:mcp:atlassian:read_it')).output, /MCP:read_it:ok/);
  assert.match((await run('FAKE:mcp:atlassian:write_it')).output, /MCP:write_it:refused/);
  assert.match((await run('FAKE:mcp:azure:list')).output, /MCP:list:unsupported/);
  const both = (await run('FAKE:mcp:atlassian:read_it FAKE:mcp:atlassian:write_it')).output;
  assert.match(both, /MCP:read_it:ok MCP:write_it:refused/);
  assert.match((await run('FAKE:mcp:atlassian:denied')).output, /MCP:denied:error:403/);
  assert.doesNotMatch((await run('FAKE:mcp:atlassian:denied')).output, /refused/);
  assert.deepEqual(seen.slice(0, 2).map((s) => [s.key, s.method, s.name]), [['K1', 'tools/call', 'read_it'], ['K1', 'tools/call', 'write_it']]);
  assert.equal(seen[0].ct, 'application/json');
});

test('connectors with no signed-in servers (ids: []) start both agents exactly as without', async (t) => {
  const none = { configFile: '/tmp/x/mcp.json', ids: [], entries: {} };
  assert.equal(A.agentCommand('claude', 'report', 'P', { mcp: none }).cmd, A.agentCommand('claude', 'report', 'P').cmd);
  assert.equal(A.agentCommand('cursor', 'report', 'P', { home: '/h', mcp: none }).cmd, A.agentCommand('cursor', 'report', 'P', { home: '/h' }).cmd);
  const { root, card } = cursorTree(t);
  const home = tmp(t);
  const cur = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor');
  await A.prepareAgent('cursor', 'report', card, { home });
  const plain = fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8');
  await A.prepareAgent('cursor', 'report', card, { home, mcp: none });
  const again = fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8');
  assert.equal(again, `${JSON.stringify(JSON.parse(again), null, 2)}\n`);
  assert.equal(steadyConfig(again, root), steadyConfig(plain, root));
  assert.ok(plain.includes('Mcp(*:*)'));
  assert.ok(!fs.existsSync(path.join(cur, 'mcp.json')));
});
