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
  const { card } = cursorTree(t);
  const home = tmp(t);
  const cur = path.join(home, '.cache', 'vaultos', 'automation-cursor', '.cursor');
  for (const d of ['chats/old', 'projects/old', 'ai-tracking', 'skills-cursor/keep']) fs.mkdirSync(path.join(cur, d), { recursive: true });
  assert.deepEqual(await A.prepareAgent('cursor', 'report', card, { home }), {});
  const cfg = JSON.parse(fs.readFileSync(path.join(cur, 'cli-config.json'), 'utf8'));
  assert.equal(cfg.version, 1);
  assert.deepEqual(cfg.permissions.allow, []);
  assert.deepEqual(cfg.permissions.deny, await A.cursorRules(card));
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
