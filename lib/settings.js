'use strict';
// The settings model: .vaultos/settings.json inside the vault. Pure functions
// return new objects and never mutate their input; the store does the file I/O.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');

const SETTINGS_REL = '.vaultos/settings.json';
const { PROFILE_IDS: PROFILES } = require('./agents');
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

function defaults() {
  return {
    version: 1,
    setupDone: false,
    boards: [],
    features: { today: false, terminal: true, morningRead: true },
    today: { dir: 'Today', timezone: 'UTC' },
    agent: { profile: 'none' },
  };
}

// Thrown for problems the person can fix (a clash, a bad value); callers show its message.
// Anything else escaping this module is a bug or an I/O failure.
class SettingsError extends Error {}
const fail = (what) => new SettingsError(`settings.json: ${what}`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

function section(raw, name) {
  if (raw[name] === undefined) return {};
  if (!isObj(raw[name])) throw fail(`${name} must be an object`);
  return raw[name];
}

function validBoard(b) {
  if (!isObj(b)) throw fail('a board must be an object');
  const { key, dir, label, hidden } = b;
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw fail(`invalid board key ${JSON.stringify(key)}`);
  if (typeof dir !== 'string' || !dir || /[\\/]/.test(dir) || /^[._]/.test(dir)) {
    throw fail(`invalid board folder ${JSON.stringify(dir)}`);
  }
  if (typeof label !== 'string' || label.length < 1 || label.length > 60) {
    throw fail('a board label must be 1 to 60 characters');
  }
  if (typeof hidden !== 'boolean') throw fail('a board "hidden" must be true or false');
  return { key, dir, label, hidden };
}

function validate(raw) {
  if (!isObj(raw)) throw fail('must be an object');
  const d = defaults();
  if (raw.version !== 1) throw fail(`unsupported version ${JSON.stringify(raw.version)}`);
  const setupDone = raw.setupDone === undefined ? d.setupDone : raw.setupDone;
  if (typeof setupDone !== 'boolean') throw fail('setupDone must be true or false');

  const rawBoards = raw.boards === undefined ? [] : raw.boards;
  if (!Array.isArray(rawBoards)) throw fail('boards must be a list');
  const boards = rawBoards.map(validBoard);
  const keys = new Set();
  const dirs = new Set();
  for (const b of boards) {
    if (keys.has(b.key)) throw fail(`duplicate board key "${b.key}"`);
    if (dirs.has(b.dir.toLowerCase())) throw fail(`duplicate board folder "${b.dir}"`);
    keys.add(b.key);
    dirs.add(b.dir.toLowerCase());
  }

  const f = section(raw, 'features');
  const features = { ...d.features };
  for (const k of Object.keys(features)) {
    if (f[k] === undefined) continue;
    if (typeof f[k] !== 'boolean') throw fail(`features.${k} must be true or false`);
    features[k] = f[k];
  }

  const t = section(raw, 'today');
  const today = { dir: t.dir === undefined ? d.today.dir : t.dir, timezone: t.timezone === undefined ? d.today.timezone : t.timezone };
  if (!isStr(today.dir)) throw fail('today.dir must be a folder name');
  if (path.isAbsolute(today.dir) || today.dir.startsWith('/') || today.dir.startsWith('\\') ||
      today.dir.split(/[\\/]/).includes('..')) {
    throw fail('today.dir must be inside the vault');
  }
  if (!isStr(today.timezone)) throw fail('today.timezone must be a time zone name');
  try { new Intl.DateTimeFormat('en', { timeZone: today.timezone }); } catch {
    throw fail(`unknown time zone "${today.timezone}"`);
  }

  const a = section(raw, 'agent');
  const profile = a.profile === undefined ? d.agent.profile : a.profile;
  if (!PROFILES.includes(profile)) throw fail(`unknown agent profile ${JSON.stringify(profile)}`);
  const agent = { profile };
  // A saved custom agent stays when another agent is the default, so it can be the default again.
  if (profile === 'custom' && !isObj(a.custom)) throw fail('a custom agent needs agent.custom');
  if (a.custom !== undefined) {
    const c = a.custom;
    if (!isObj(c)) throw fail('agent.custom must be an object');
    if (!isStr(c.label) || !isStr(c.detect)) throw fail('a custom agent needs a label and a detect command');
    // detect is run through a shell by isInstalled, and settings.json is a synced file.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(c.detect)) {
      throw fail('agent.custom.detect must be a command name (letters, digits, . _ + -)');
    }
    if (typeof c.start !== 'string' || !c.start.includes('{prompt}')) {
      throw fail('a custom agent start command must contain {prompt}');
    }
    for (const k of ['install', 'login']) {
      if (c[k] !== undefined && typeof c[k] !== 'string') throw fail(`agent.custom.${k} must be text`);
    }
    agent.custom = { label: c.label, detect: c.detect, start: c.start };
    for (const k of ['install', 'login']) if (c[k] !== undefined) agent.custom[k] = c[k];
  }

  return { version: 1, setupDone, boards, features, today, agent };
}

// Folder name for a board label: only safe characters, at most 60 long.
function boardDirName(label) {
  let s = String(label).replace(/[^A-Za-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[._]+/, '').slice(0, 60).trim();
  if (!/[A-Za-z0-9]/.test(s)) throw new SettingsError('A board name needs a letter or number');
  return s;
}

const boardKey = (dir) => String(dir).toLowerCase().replace(/ +/g, '-');

function clashes(s, key, dir) {
  return s.boards.some((b) => b.key === key || b.dir.toLowerCase() === dir.toLowerCase());
}

function append(s, board) {
  const settings = validate({ ...s, boards: [...s.boards, board] });
  return { settings, board: settings.boards[settings.boards.length - 1] };
}

function addBoard(s, label) {
  label = String(label).trim();
  const dir = boardDirName(label);
  const key = boardKey(dir);
  if (clashes(s, key, dir)) throw new SettingsError(`A board called "${label}" already exists`);
  return append(s, { key, dir, label, hidden: false });
}

function addExistingBoard(s, dir, { todayDir }) {
  if (/^[._]/.test(dir)) throw new SettingsError('That folder cannot be a board');
  if (todayDir && dir.toLowerCase() === String(todayDir).toLowerCase()) throw new SettingsError("That folder is Today's");
  const key = boardKey(dir);
  if (clashes(s, key, dir)) throw new SettingsError(`A board called "${dir}" already exists`);
  return append(s, { key, dir, label: dir, hidden: false });
}

function updateBoard(s, key, { label, hidden, index } = {}) {
  const at = s.boards.findIndex((b) => b.key === key);
  if (at < 0) throw new SettingsError('Unknown board');
  const board = { ...s.boards[at] };
  if (label !== undefined) board.label = String(label).trim();
  if (hidden !== undefined) board.hidden = hidden;
  const boards = s.boards.filter((_, i) => i !== at);
  let to = at;
  if (index !== undefined) to = Math.max(0, Math.min(boards.length, Math.trunc(index)));
  boards.splice(to, 0, board);
  if (!boards.some((b) => !b.hidden)) throw new SettingsError('At least one board must stay visible');
  return validate({ ...s, boards });
}

const visibleBoards = (s) => s.boards.filter((b) => !b.hidden);

function createSettingsStore(vaultDir) {
  const file = path.join(vaultDir, ...SETTINGS_REL.split('/'));
  let cached = null;
  return {
    file,
    // Null when the file does not exist; throws on a file that is unreadable or invalid.
    load() {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return (cached = null);
        throw fail(`cannot read ${SETTINGS_REL} (${e.message})`);
      }
      let raw;
      try { raw = JSON.parse(text); } catch (e) { throw fail(`${SETTINGS_REL} is not valid JSON (${e.message})`); }
      return (cached = validate(raw));
    },
    current: () => cached,
    async save(next) {
      const s = validate(next);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(file, JSON.stringify(s, null, 2) + '\n');
      cached = s;
      return s;
    },
  };
}

module.exports = {
  SettingsError, SETTINGS_REL, defaults, validate, boardDirName, boardKey,
  addBoard, addExistingBoard, updateBoard, visibleBoards, createSettingsStore,
};
