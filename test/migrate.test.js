'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBoards, findTodayDir, legacySettings } = require('../lib/migrate');

let root;
const put = (rel, body = 'x') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
const listing = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      out.push(`${path.relative(dir, p)}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};
const yes = async () => true;
const no = async () => false;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  put('Beta/_tasks/Board.md');
  put('alpha/_tasks/Board.md');
  put('Gamma/notes.md');
  put('.obsidian/x');
  put('Beta/Today/habits.md');
  put('a/b/Today/habits.md');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('findBoards sorts case-insensitively', async () => {
  assert.deepEqual(await findBoards(root), ['alpha', 'Beta']);
});

test('findTodayDir finds depth 1-2 only', async () => {
  assert.equal(await findTodayDir(root), 'Beta/Today');
  fs.rmSync(path.join(root, 'Beta', 'Today'), { recursive: true });
  assert.equal(await findTodayDir(root), null);
});

test('legacySettings maps the vault', async () => {
  const s = await legacySettings(root, { env: { TZ: 'Europe/London' }, hasCommand: yes });
  assert.deepEqual(s, {
    version: 1, setupDone: true,
    boards: [
      { key: 'alpha', dir: 'alpha', label: 'alpha', hidden: false },
      { key: 'beta', dir: 'Beta', label: 'Beta', hidden: false },
    ],
    features: { today: true, terminal: true, morningRead: true },
    today: { dir: 'Beta/Today', timezone: 'Europe/London' },
    agent: { profile: 'claude' },
  });
});

test('legacySettings falls back without TERMINAL, claude, TZ or Today', async () => {
  fs.rmSync(path.join(root, 'Beta', 'Today'), { recursive: true });
  const s = await legacySettings(root, { env: { TERMINAL: '0' }, hasCommand: no });
  assert.equal(s.features.terminal, false);
  assert.equal(s.features.today, false);
  assert.equal(s.agent.profile, 'none');
  assert.equal(s.today.timezone, 'UTC');
  assert.equal(s.today.dir, 'Today');
});

test('legacySettings is null with no boards', async () => {
  fs.rmSync(path.join(root, 'Beta'), { recursive: true });
  fs.rmSync(path.join(root, 'alpha'), { recursive: true });
  assert.equal(await legacySettings(root, { env: {}, hasCommand: yes }), null);
});

test('legacySettings writes nothing', async () => {
  const before = listing(root);
  await legacySettings(root, { env: {}, hasCommand: yes });
  assert.deepEqual(listing(root), before);
});

test('legacySettings ignores workspace-visibility.json', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-data-'));
  fs.writeFileSync(path.join(data, 'workspace-visibility.json'), '{"beta":true}');
  const s = await legacySettings(root, { env: {}, hasCommand: yes });
  assert.ok(s.boards.every((b) => b.hidden === false));
  fs.rmSync(data, { recursive: true, force: true });
});
