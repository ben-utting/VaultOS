'use strict';
// Derive a settings file for a vault that was set up before settings.json
// existed. Read-only: the caller decides whether to save the result.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validate, boardKey } = require('./settings');

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

async function subdirs(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch { return []; }
}

const isFile = (p) => fsp.stat(p).then((s) => s.isFile(), () => false);

// Top-level non-dot folders that hold _tasks/Board.md.
async function findBoards(vaultDir) {
  const found = [];
  for (const name of await subdirs(vaultDir)) {
    if (await isFile(path.join(vaultDir, name, '_tasks', 'Board.md'))) found.push(name);
  }
  return found.sort(byName);
}

// A folder named Today holding habits.md, at depth 1 or 2. POSIX path or null.
async function findTodayDir(vaultDir) {
  const tops = (await subdirs(vaultDir)).sort(byName);
  if (tops.includes('Today') && await isFile(path.join(vaultDir, 'Today', 'habits.md'))) return 'Today';
  for (const top of tops) {
    if ((await subdirs(path.join(vaultDir, top))).includes('Today') &&
        await isFile(path.join(vaultDir, top, 'Today', 'habits.md'))) return `${top}/Today`;
  }
  return null;
}

async function legacySettings(vaultDir, { env = process.env, hasCommand }) {
  const dirs = await findBoards(vaultDir);
  if (!dirs.length) return null;
  const todayDir = await findTodayDir(vaultDir);
  let timezone = env.TZ || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = 'UTC'; }
  return validate({
    version: 1,
    setupDone: true,
    boards: dirs.map((dir) => ({ key: boardKey(dir), dir, label: dir, hidden: false })),
    features: { today: todayDir !== null, terminal: env.TERMINAL !== '0' },
    today: { dir: todayDir || 'Today', timezone },
    agent: { profile: (await hasCommand('claude')) ? 'claude' : 'none' },
  });
}

module.exports = { findBoards, findTodayDir, legacySettings };
