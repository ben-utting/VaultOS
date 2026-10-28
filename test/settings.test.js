'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/settings');

const board = (dir, extra) => ({ key: S.boardKey(dir), dir, label: dir, hidden: false, ...extra });
const withBoards = (...boards) => ({ ...S.defaults(), boards });

test('defaults validate', () => {
  assert.deepEqual(S.defaults(), {
    version: 1, setupDone: false, boards: [],
    features: { today: false, terminal: true, morningRead: true },
    today: { dir: 'Today', timezone: 'UTC' }, agent: { profile: 'none' },
  });
  assert.deepEqual(S.validate(S.defaults()), S.defaults());
  assert.equal(S.SETTINGS_REL, '.vaultos/settings.json');
});

test('morningRead defaults on, and must be true or false', () => {
  assert.equal(S.defaults().features.morningRead, true);
  assert.equal(S.validate({ version: 1, features: { today: true } }).features.morningRead, true);
  assert.equal(S.validate({ version: 1, features: { morningRead: false } }).features.morningRead, false);
  assert.throws(() => S.validate({ version: 1, features: { morningRead: 'yes' } }), /features\.morningRead must be true or false/);
});

test('validate fills missing sections', () => {
  assert.deepEqual(S.validate({ version: 1 }), S.defaults());
});

test('validate does not mutate its input', () => {
  const raw = { version: 1 };
  S.validate(raw);
  assert.deepEqual(raw, { version: 1 });
});

test('validate rejects bad settings', () => {
  const bad = (raw) => assert.throws(() => S.validate(raw), /^Error: settings\.json:/);
  bad(null);
  bad([]);
  bad({ version: 2 });
  bad({ version: 1, setupDone: 'yes' });
  bad({ version: 1, boards: 'x' });
  bad({ version: 1, features: { today: 1 } });
  bad({ version: 1, boards: [board('Work'), board('Work')] });
  bad({ version: 1, boards: [board('Work'), { ...board('work'), key: 'other' }] });
  bad({ version: 1, boards: [{ ...board('Work'), key: 'Bad Key' }] });
  bad({ version: 1, boards: [{ ...board('Work'), dir: 'a/b' }] });
  bad({ version: 1, boards: [{ ...board('Work'), dir: 'a\\b' }] });
  bad({ version: 1, boards: [{ ...board('Work'), dir: '.hid' }] });
  bad({ version: 1, boards: [{ ...board('Work'), dir: '_hid' }] });
  bad({ version: 1, boards: [{ ...board('Work'), label: '' }] });
  bad({ version: 1, boards: [{ ...board('Work'), label: 'x'.repeat(61) }] });
  bad({ version: 1, boards: [{ ...board('Work'), hidden: 'no' }] });
  bad({ version: 1, today: { dir: '/abs', timezone: 'UTC' } });
  bad({ version: 1, today: { dir: '../up', timezone: 'UTC' } });
  bad({ version: 1, today: { dir: 'a/../b', timezone: 'UTC' } });
  bad({ version: 1, today: { dir: 'Today', timezone: 'Not/AZone' } });
  bad({ version: 1, agent: { profile: 'emacs' } });
  bad({ version: 1, agent: { profile: 'custom' } });
  bad({ version: 1, agent: { profile: 'custom', custom: { label: 'X', detect: 'x', start: 'x go' } } });
  bad({ version: 1, agent: { profile: 'custom', custom: { detect: 'x', start: 'x {prompt}' } } });
  bad({ version: 1, agent: { profile: 'custom', custom: { label: 'X', start: 'x {prompt}' } } });
  for (const detect of ['-p', '.x', 'x; rm -rf ~', 'a b', '$(id)', '`id`', 'a|b', '', 'x'.repeat(65)]) {
    bad({ version: 1, agent: { profile: 'custom', custom: { label: 'X', detect, start: 'x {prompt}' } } });
  }
});

test('validate accepts a complete custom agent', () => {
  const custom = { label: 'X', detect: 'x', install: 'i', login: 'l', start: 'x {prompt}' };
  const s = S.validate({ version: 1, agent: { profile: 'custom', custom } });
  assert.deepEqual(s.agent.custom, custom);
});

test('boardDirName', () => {
  assert.equal(S.boardDirName('Work'), 'Work');
  assert.equal(S.boardDirName("Team's Work!"), 'Teams Work');
  assert.equal(S.boardDirName('  a   b '), 'a b');
  assert.equal(S.boardDirName('_x'), 'x');
  assert.equal(S.boardDirName('.x'), 'x');
  assert.equal(S.boardDirName('a'.repeat(70)).length, 60);
});

test('boardDirName refuses labels with nothing usable', () => {
  assert.throws(() => S.boardDirName('🚀'), /A board name needs a letter or number/);
  assert.throws(() => S.boardDirName('!!!'), /A board name needs a letter or number/);
});

test('boardKey', () => {
  assert.equal(S.boardKey('Teams Work'), 'teams-work');
  assert.equal(S.boardKey('A.B_c'), 'a.b_c');
});

test('addBoard appends a visible board', () => {
  const s0 = S.defaults();
  const { settings, board: b } = S.addBoard(s0, '  Team Notes ');
  assert.deepEqual(b, { key: 'team-notes', dir: 'Team Notes', label: 'Team Notes', hidden: false });
  assert.deepEqual(settings.boards, [b]);
  assert.deepEqual(s0.boards, []);
});

test('addBoard clash is case-insensitive', () => {
  const { settings } = S.addBoard(S.defaults(), 'Work');
  assert.throws(() => S.addBoard(settings, 'work'), /A board called "work" already exists/);
});

test("addExistingBoard refuses Today's folder and dot folders", () => {
  const s = S.defaults();
  assert.throws(() => S.addExistingBoard(s, 'Today', { todayDir: 'Today' }), /That folder is Today's/);
  assert.throws(() => S.addExistingBoard(s, 'today', { todayDir: 'Today' }), /That folder is Today's/);
  assert.throws(() => S.addExistingBoard(s, '.git', { todayDir: 'Today' }));
  assert.throws(() => S.addExistingBoard(s, '_x', { todayDir: 'Today' }));
  const r = S.addExistingBoard(s, 'Notes', { todayDir: 'Today' });
  assert.deepEqual(r.board, { key: 'notes', dir: 'Notes', label: 'Notes', hidden: false });
  assert.equal(r.settings.boards.length, 1);
  assert.throws(() => S.addExistingBoard(r.settings, 'NOTES', { todayDir: 'Today' }), /already exists/);
});

test('updateBoard renames, hides, moves', () => {
  const s = withBoards(board('Work'), board('Notes'), board('alpha'));
  const r = S.updateBoard(s, 'alpha', { label: ' Alpha One ', hidden: true, index: 0 });
  assert.deepEqual(r.boards.map((b) => b.key), ['alpha', 'work', 'notes']);
  assert.equal(r.boards[0].label, 'Alpha One');
  assert.equal(r.boards[0].hidden, true);
  assert.equal(r.boards[0].dir, 'alpha');
  assert.equal(s.boards[2].label, 'alpha');
  assert.deepEqual(S.updateBoard(s, 'work', { index: 99 }).boards.map((b) => b.key), ['notes', 'alpha', 'work']);
  assert.deepEqual(S.updateBoard(s, 'alpha', { index: -5 }).boards.map((b) => b.key), ['alpha', 'work', 'notes']);
  assert.deepEqual(S.visibleBoards(r).map((b) => b.key), ['work', 'notes']);
});

test('updateBoard refuses hiding the last visible board', () => {
  const s = withBoards(board('Work'), board('Notes', { hidden: true }));
  assert.throws(() => S.updateBoard(s, 'work', { hidden: true }), /At least one board must stay visible/);
});

test('updateBoard unknown key', () => {
  assert.throws(() => S.updateBoard(S.defaults(), 'nope', { label: 'x' }), /Unknown board/);
});

test('store round-trips and leaves no temp file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-settings-'));
  const store = S.createSettingsStore(dir);
  assert.equal(store.file, path.join(dir, '.vaultos', 'settings.json'));
  assert.equal(store.load(), null);
  assert.equal(store.current(), null);
  const next = S.addBoard(S.defaults(), 'Work').settings;
  const saved = await store.save(next);
  assert.deepEqual(saved, next);
  assert.deepEqual(store.current(), next);
  const text = fs.readFileSync(store.file, 'utf8');
  assert.equal(text, JSON.stringify(next, null, 2) + '\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.vaultos')), ['settings.json']);
  assert.deepEqual(S.createSettingsStore(dir).load(), next);
  await assert.rejects(store.save({ version: 3 }), /settings\.json/);
});

test('store load throws on bad JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-settings-'));
  fs.mkdirSync(path.join(dir, '.vaultos'));
  fs.writeFileSync(path.join(dir, '.vaultos', 'settings.json'), '{nope');
  assert.throws(() => S.createSettingsStore(dir).load(), /settings\.json/);
});

test('validate accepts plain agent command names', () => {
  for (const detect of ['aider', 'my-agent2']) {
    const custom = { label: 'X', detect, start: `${detect} {prompt}` };
    assert.equal(S.validate({ version: 1, agent: { profile: 'custom', custom } }).agent.custom.detect, detect);
  }
});

test('old agent settings load unchanged and every new id saves', () => {
  assert.deepEqual(S.validate({ version: 1, agent: { profile: 'cursor' } }).agent, { profile: 'cursor' });
  for (const id of ['pi', 'codex', 'antigravity', 'copilot', 'opencode', 'kilo']) {
    assert.equal(S.validate({ version: 1, agent: { profile: id } }).agent.profile, id);
  }
  assert.throws(() => S.validate({ version: 1, agent: { profile: 'gemini' } }), /unknown agent profile/);
});

test('a saved custom agent is kept when another agent is the default', () => {
  const custom = { label: 'Mine', detect: 'mine', start: 'mine {prompt}' };
  assert.deepEqual(S.validate({ version: 1, agent: { profile: 'claude', custom } }).agent, { profile: 'claude', custom });
  assert.throws(() => S.validate({ version: 1, agent: { profile: 'claude', custom: { label: 'Bad', detect: 'x', start: 'no prompt' } } }), /\{prompt\}/);
});
