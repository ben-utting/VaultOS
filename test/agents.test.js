'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../lib/agents');

const HOOK_SRC = path.join(__dirname, '..', 'hooks', 'vaultos-state.js');
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
const readSettings = (h) => fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8');

test('shellQuote escapes single quotes', () => {
  assert.equal(A.shellQuote("it's"), "'it'\\''s'");
});

test('startCommand fills the prompt', () => {
  assert.equal(A.startCommand(A.PROFILES.claude, 'Catch me up'), "claude 'Catch me up'");
});

test('custom start template', () => {
  const p = A.profileFor({ agent: { profile: 'custom', custom: { label: 'Aider', detect: 'aider', start: 'aider --message {prompt}' } } });
  assert.equal(A.startCommand(p, 'x'), "aider --message 'x'");
  assert.deepEqual(p.detect, ['aider']);
  assert.deepEqual(p.proc, ['aider']);
  assert.equal(p.hooks, null);
});

test('profileFor none is null; builtins resolve', () => {
  assert.equal(A.profileFor({ agent: { profile: 'none' } }), null);
  assert.equal(A.profileFor({ agent: { profile: 'cursor' } }).id, 'cursor');
  assert.equal(A.profileFor({ agent: { profile: 'claude' } }).hooks, 'claude');
});

test('isInstalled tries each detect name', async () => {
  const seen = [];
  const run = async (c) => { seen.push(c); return { code: c === "command -v -- 'cursor-agent'" ? 0 : 1 }; };
  assert.equal(await A.isInstalled(A.PROFILES.cursor, { run }), true);
  assert.deepEqual(seen, ["command -v -- 'agent'", "command -v -- 'cursor-agent'"]);
  assert.equal(await A.isInstalled(A.PROFILES.claude, { run: async () => ({ code: 1 }) }), false);
});

test('installClaudeHook writes the hook and 8 events', async () => {
  const h = tmpHome();
  assert.equal(await A.installClaudeHook(h, HOOK_SRC), true);
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'hooks', 'vaultos-state.js'), 'utf8'), fs.readFileSync(HOOK_SRC, 'utf8'));
  const s = JSON.parse(readSettings(h));
  assert.equal(Object.keys(s.hooks).length, 8);
  for (const ev of A.HOOK_EVENTS) {
    assert.deepEqual(s.hooks[ev], [{ hooks: [{ type: 'command', command: A.HOOK_CMD, timeout: 5 }] }]);
  }
});

test('installClaudeHook is idempotent', async () => {
  const h = tmpHome();
  await A.installClaudeHook(h, HOOK_SRC);
  const before = readSettings(h);
  assert.equal(await A.installClaudeHook(h, HOOK_SRC), false);
  assert.equal(readSettings(h), before);
});

test('installClaudeHook keeps other settings and hooks', async () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, '.claude'));
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'),
    JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  await A.installClaudeHook(h, HOOK_SRC);
  const s = JSON.parse(readSettings(h));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo hi');
  assert.equal(s.hooks.Stop[1].hooks[0].command, A.HOOK_CMD);
});

test('processMatches and processState', () => {
  assert.equal(A.processMatches(A.PROFILES.cursor, '/home/u/.local/bin/agent'), true);
  assert.equal(A.processMatches(A.PROFILES.cursor, 'node'), false);
  assert.equal(A.processState({ running: true, quietMs: 5000 }), 'working');
  assert.equal(A.processState({ running: true, quietMs: 25000 }), 'idle');
  assert.equal(A.processState({ running: false, quietMs: 0 }), null);
});

test('isInstalled quotes the name it checks', async () => {
  const seen = [];
  await A.isInstalled({ detect: ['x; touch pwned'] }, { run: async (c) => { seen.push(c); return { code: 1 }; } });
  assert.deepEqual(seen, [`command -v -- 'x; touch pwned'`]);
});

test('eight built-in profiles with the spec labels, makers and tiers', () => {
  assert.deepEqual(A.PROFILE_IDS, ['claude', 'cursor', 'pi', 'codex', 'antigravity', 'copilot', 'opencode', 'kilo', 'custom', 'none']);
  assert.deepEqual(Object.values(A.PROFILES).filter((p) => p.tier === 'tested').map((p) => p.id), ['claude', 'cursor', 'pi']);
  assert.deepEqual(Object.values(A.PROFILES).filter((p) => p.tier === 'more').map((p) => p.id), ['codex', 'antigravity', 'copilot', 'opencode', 'kilo']);
  assert.equal(A.PROFILES.antigravity.label, 'Antigravity CLI');
  assert.equal(A.PROFILES.antigravity.maker, 'Google');
  assert.equal(A.PROFILES.pi.loginNote, 'Then type /login');
  for (const p of Object.values(A.PROFILES)) {
    assert.ok(p.detect.length && p.proc.length && p.start.includes('{prompt}'), p.id);
    assert.ok(p.install === null || /--prefix ~\/\.local|curl/.test(p.install), p.id);
    assert.equal(typeof p.nodeTitle, 'boolean', p.id);
  }
});

test('node agents match only in the terminal Start agent opened', () => {
  assert.equal(A.PROFILES.codex.nodeTitle, true);
  assert.equal(A.processMatches(A.PROFILES.codex, 'node', { agentTerm: true }), true);
  assert.equal(A.processMatches(A.PROFILES.codex, 'node', { agentTerm: false }), false);
  assert.equal(A.processMatches(A.PROFILES.codex, 'node'), false);
  assert.equal(A.processMatches(A.PROFILES.claude, 'node', { agentTerm: true }), false);
  assert.equal(A.processMatches(A.PROFILES.pi, 'pi'), true);
});

test('only a terminal Start agent opened counts as the agent\'s; a job-folder terminal just links to its card', () => {
  assert.deepEqual(A.terminalTask({ explicit: 'Work/p/j/task.md', found: '' }), { task: 'Work/p/j/task.md', agentTerm: true });
  assert.deepEqual(A.terminalTask({ explicit: '', found: 'Work/p/j/task.md' }), { task: 'Work/p/j/task.md', agentTerm: false });
  assert.deepEqual(A.terminalTask({ explicit: '', found: '' }), { task: '', agentTerm: false });
  // So a dev server (`node`) in a job-folder terminal never wears a node agent's badge:
  const { agentTerm } = A.terminalTask({ explicit: '', found: 'Work/p/j/task.md' });
  assert.equal(A.processMatches(A.PROFILES.codex, 'node', { agentTerm }), false);
});

const RECALL = path.join(__dirname, '..', 'hooks', 'vault-recall.js');

test('installClaudeHook registers the recall hook once', async () => {
  const h = tmpHome();
  assert.equal(await A.installClaudeHook(h, HOOK_SRC, RECALL), true);
  const s = JSON.parse(readSettings(h));
  const groups = s.hooks.UserPromptSubmit;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1], { hooks: [{ type: 'command', command: A.recallCmd(RECALL), timeout: 5 }] });
  const before = readSettings(h);
  assert.equal(await A.installClaudeHook(h, HOOK_SRC, RECALL), false);
  assert.equal(readSettings(h), before);
});

test('installClaudeHook sets cleanupPeriodDays only when absent', async () => {
  const h = tmpHome();
  await A.installClaudeHook(h, HOOK_SRC);
  assert.equal(JSON.parse(readSettings(h)).cleanupPeriodDays, 36500);
  const h2 = tmpHome();
  fs.mkdirSync(path.join(h2, '.claude'));
  fs.writeFileSync(path.join(h2, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  await A.installClaudeHook(h2, HOOK_SRC);
  assert.equal(JSON.parse(readSettings(h2)).cleanupPeriodDays, 90);
});

test('the recall hook command is a no-op where node or the script is missing', () => {
  const { spawnSync } = require('node:child_process');
  const run = (cmd, env) => spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8', env });
  const missing = run(A.recallCmd('/nonexistent/vault-recall.js'), { PATH: process.env.PATH });
  assert.equal(missing.status, 0);
  assert.equal(missing.stderr, '');
  const noNode = run(A.recallCmd(RECALL), { PATH: '/nonexistent' });
  assert.equal(noNode.status, 0);
  assert.equal(noNode.stderr, '');
});

test('kickoffPrompt opens with /i-have-adhd for Claude Code when that skill is installed', () => {
  const home = tmpHome();
  assert.equal(A.kickoffPrompt(A.PROFILES.claude, home), A.KICKOFF_PROMPT, 'no skill installed: the plain prompt');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'i-have-adhd'), { recursive: true });
  assert.equal(A.kickoffPrompt(A.PROFILES.claude, home), A.KICKOFF_PROMPT, 'an empty skill folder is not the skill');
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'i-have-adhd', 'SKILL.md'), '---\nname: i-have-adhd\n---\n');
  assert.equal(A.kickoffPrompt(A.PROFILES.claude, home), `/i-have-adhd ${A.KICKOFF_PROMPT}`);
  assert.equal(A.startCommand(A.PROFILES.claude, A.kickoffPrompt(A.PROFILES.claude, home)), `claude '/i-have-adhd ${A.KICKOFF_PROMPT}'`);
});

test('kickoffPrompt leaves other agents, and a missing home, on the plain prompt', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'i-have-adhd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'i-have-adhd', 'SKILL.md'), 'x');
  assert.equal(A.kickoffPrompt(A.PROFILES.pi, home), A.KICKOFF_PROMPT);
  assert.equal(A.kickoffPrompt(A.PROFILES.claude, undefined), A.KICKOFF_PROMPT);
  assert.equal(A.kickoffPrompt(null, home), A.KICKOFF_PROMPT);
});

test('the check-in asks for a few short lines', () => {
  assert.match(A.KICKOFF_PROMPT, /few short lines/);
  assert.match(A.KICKOFF_PROMPT, /until I say so/);
});

test('kickoffPrompt for the Cursor CLI finds the skill in any folder Cursor reads', () => {
  for (const dir of ['.cursor/skills', '.agents/skills', '.claude/skills']) {
    const home = tmpHome();
    assert.equal(A.kickoffPrompt(A.PROFILES.cursor, home), A.KICKOFF_PROMPT, `${dir}: nothing installed yet`);
    fs.mkdirSync(path.join(home, dir, 'i-have-adhd'), { recursive: true });
    fs.writeFileSync(path.join(home, dir, 'i-have-adhd', 'SKILL.md'), 'x');
    assert.equal(A.kickoffPrompt(A.PROFILES.cursor, home), `/i-have-adhd ${A.KICKOFF_PROMPT}`, dir);
  }
});

test('kickoffPrompt for Claude Code only looks in its own skills folder', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.cursor', 'skills', 'i-have-adhd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'skills', 'i-have-adhd', 'SKILL.md'), 'x');
  assert.equal(A.kickoffPrompt(A.PROFILES.claude, home), A.KICKOFF_PROMPT);
});
