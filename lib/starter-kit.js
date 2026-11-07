'use strict';
// The starter kit: generic files setup writes into a vault so any coding agent
// knows how tasks work there. starter-kit/root/ goes to the vault root,
// starter-kit/board/ into each board folder, starter-kit/welcome/ into the first
// board only. Each starter-kit/skills/<name>/ goes to .agents/skills/ (read by Pi, the
// Cursor CLI and most other agents) and .claude/skills/ (Claude Code reads only that). The kit only fills gaps: a file that already exists is never
// overwritten, and an existing AGENTS.md only ever changes between the markers.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');

const KIT_DIR = path.join(__dirname, '..', 'starter-kit');
const START = '<!-- vaultos:boards -->';
const END = '<!-- /vaultos:boards -->';

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Files under dir as sorted POSIX paths relative to it, dot-folders included.
async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

// lstat, so a symlink (even a dangling one) counts as there and is never written through.
async function exists(full) {
  try { await fsp.lstat(full); return true; } catch { return false; }
}

// Copies each kit file in `files` from srcDir to destRel/<file> in the vault, skipping
// any that exist. Check-then-write instead of O_EXCL so the file appears whole
// (atomicWrite renames into place); setup is the only writer at that moment.
async function copyMissing(srcDir, vaultDir, destRel, files, transform) {
  const written = [];
  for (const f of files) {
    const rel = destRel ? `${destRel}/${f}` : f;
    const full = path.join(vaultDir, ...rel.split('/'));
    if (await exists(full)) continue;
    const text = await fsp.readFile(path.join(srcDir, ...f.split('/')), 'utf8');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await atomicWrite(full, transform ? transform(text, f) : text);
    written.push(rel);
  }
  return written;
}

// One line per board. Labels are free text, so whitespace runs (newlines included)
// fold to one space and marker look-alikes go: the block must survive the next update.
function boardsBlock(boards) {
  const oneLine = (s) => String(s).replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();
  return boards.map((b) => `- **${oneLine(b.label)}** → \`${b.dir}/\``).join('\n');
}

// text with the boards list put between the markers, or null without both markers.
function withBoards(text, boards) {
  const s = text.indexOf(START);
  if (s < 0) return null;
  const e = text.indexOf(END, s + START.length);
  if (e < 0) return null;
  const lines = boardsBlock(boards);
  return `${text.slice(0, s + START.length)}\n${lines ? `${lines}\n` : ''}${text.slice(e)}`;
}

// The cursor flag adds .cursor/commands/, for agents that read them.
async function writeRootKit(vaultDir, boards, { cursor = false } = {}) {
  const src = path.join(KIT_DIR, 'root');
  const files = (await listFiles(src)).filter((f) => cursor || !f.startsWith('.cursor/'));
  const written = await copyMissing(src, vaultDir, '', files,
    (text, f) => (f === 'AGENTS.md' ? withBoards(text, boards) ?? text : text));
  const skills = path.join(KIT_DIR, 'skills');
  const skillFiles = await listFiles(skills);
  for (const dest of ['.agents/skills', '.claude/skills']) written.push(...await copyMissing(skills, vaultDir, dest, skillFiles));
  return written;
}

async function writeBoardKit(vaultDir, board, { welcome = false, today = todayISO() } = {}) {
  const dir = board && board.dir;
  // Settings already validates this; the check here keeps a bad caller inside the vault.
  if (typeof dir !== 'string' || !dir || /[\\/]/.test(dir) || dir === '.' || dir === '..') {
    throw new Error(`Invalid board folder ${JSON.stringify(dir)}`);
  }
  await fsp.mkdir(path.join(vaultDir, dir), { recursive: true });
  const fill = (text) => text.replaceAll('{{today}}', () => today); // a function: no `$&` patterns
  const written = [];
  for (const part of welcome ? ['board', 'welcome'] : ['board']) {
    const src = path.join(KIT_DIR, part);
    written.push(...await copyMissing(src, vaultDir, dir, await listFiles(src), fill));
  }
  return written.sort();
}

// Rewrites the boards list in AGENTS.md and nothing else. False when there is no
// file, a marker is missing (the user's own AGENTS.md), or the list is unchanged.
async function updateAgentsBlock(vaultDir, boards) {
  const full = path.join(vaultDir, 'AGENTS.md');
  let text;
  try { text = await fsp.readFile(full, 'utf8'); } catch { return false; }
  const next = withBoards(text, boards);
  if (next === null || next === text) return false;
  await atomicWrite(full, next);
  return true;
}

module.exports = { KIT_DIR, boardsBlock, writeRootKit, writeBoardKit, updateAgentsBlock };
