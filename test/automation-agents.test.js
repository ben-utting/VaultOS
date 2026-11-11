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

test('agents without an adapter are refused, cursor among them for now', () => {
  assert.match(A.agentCommand('codex', 'report', 'P').error, /not available/);
  assert.deepEqual(A.offeredLevels('codex'), []);
  assert.deepEqual(A.offeredLevels('cursor'), []);
  assert.deepEqual(A.offeredLevels('claude'), ['report', 'update', 'work']);
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
