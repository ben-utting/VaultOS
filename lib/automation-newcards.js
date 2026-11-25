'use strict';
// New cards an automation proposes (spec 2026-11-25 §5–§6). The agent never writes them: it sends vaultos-card
// blocks and VaultOS creates each card here, inside the one folder the automation names. This file holds where
// a card may go (checkDestination, destinationFolders), what its folder is called and what its task.md says.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setFrontmatterField, replaceSection, parseFrontmatter } = require('./task-file');
const { safeNote } = require('./automation-note');
const { wallParts, NEW_CARDS_PER_HOUR } = require('../public/automation-core');

const ERR_MISSING = "That folder doesn't exist";
const ERR_OUTSIDE = 'That folder is outside the board';
const ERR_HIDDEN = "Cards in that folder wouldn't show on the board";
const ERR_CARD = "That's a card's folder; pick the folder it sits in";

const segments = (folder) => (folder ? folder.split('/') : []);
const hidden = (name, skipDirs) => name.startsWith('.') || skipDirs.has(name);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Whether new cards can go into <boardDir>/<folder> (folder relative, '' = the board's root). Synchronous, so the
// shared validation can ask it while saving. The folder must exist, really be inside the board (no symlink out),
// sit in no folder the board skips, and not be a card's folder or inside one (that would make subtasks).
function checkDestination(boardDir, folder, { skipDirs }) {
  const segs = segments(folder);
  if (segs.some((s) => hidden(s, skipDirs))) return { ok: false, error: ERR_HIDDEN };
  const dir = path.join(boardDir, ...segs);
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: ERR_MISSING };
  } catch { return { ok: false, error: ERR_MISSING }; }
  let real;
  let root;
  try {
    real = fs.realpathSync(dir);
    root = fs.realpathSync(boardDir);
  } catch { return { ok: false, error: ERR_MISSING }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { ok: false, error: ERR_OUTSIDE };
  for (let i = segs.length; i > 0; i--) {
    if (isFile(path.join(boardDir, ...segs.slice(0, i), 'task.md'))) return { ok: false, error: ERR_CARD };
  }
  return { ok: true, dir };
}

// The folders the builder offers: '' (the root) first, then every folder up to `depth` levels down that passes
// checkDestination's rules, sorted, at most `max` in all. Symlinked folders aren't followed.
async function destinationFolders(boardDir, { skipDirs, depth = 3, max = 300 }) {
  const out = [''];
  async function walk(dir, rel, level) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || hidden(e.name, skipDirs)) continue;
      const full = path.join(dir, e.name);
      if (isFile(path.join(full, 'task.md'))) continue;   // a card: neither it nor anything under it
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (level < depth) await walk(full, r, level + 1);
    }
  }
  await walk(boardDir, '', 1);
  const rest = out.slice(1).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ['', ...rest].slice(0, max);
}

const SLUG_MAX = 50;
function slugTitle(title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX).replace(/-+$/, '');
}
// A new card's folder: its key, else a slug of its title, else card-YYYYMMDD-HHMM on the wall clock.
function folderNameFor(card, nowMs, tz) {
  if (card.key) return card.key;
  const slug = slugTitle(card.title);
  if (slug) return slug;
  const w = wallParts(nowMs, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `card-${w.y}${pad(w.mo)}${pad(w.d)}-${pad(w.h)}${pad(w.mi)}`;
}

const BUILT_IN = `---
type: task
id: ""
title: ""
status: backlog
priority: med
created: ""
updated: ""
---

## Goal

## Context / key facts

## Plan

## Progress log

## Findings / decisions
`;
const SECTIONS = ['Goal', 'Context / key facts', 'Plan', 'Progress log', 'Findings / decisions'];
const oneLine = (v) => String(v || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/ {2,}/g, ' ').trim();
const hasSection = (raw, heading) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'im').test(raw);

// aliases is a list, so it's written as one: setFrontmatterField would quote the brackets into a string. The id
// only ever uses the key or slug alphabet.
function setAliases(raw, id) {
  const line = `aliases: ["${id}"]`;
  if (/^aliases:.*$/m.test(raw.split(/\n---/)[0])) return raw.replace(/^aliases:.*$/m, line);
  return raw.replace(/^(id:.*)$/m, `$1\n${line}`);
}

// A section the template lacks goes in before the next one it has, or at the end.
function putSection(raw, heading, lines) {
  if (hasSection(raw, heading)) return replaceSection(raw, heading, lines);
  const later = SECTIONS.slice(SECTIONS.indexOf(heading) + 1).find((h) => hasSection(raw, h));
  const block = [`## ${heading}`, ...lines, '', ''].join('\n');
  if (!later) return `${raw.replace(/\s*$/, '\n')}\n${block}`.replace(/\n+$/, '\n');
  const re = new RegExp(`^##\\s+${later.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'im');
  return raw.replace(re, (m) => `${block}${m}`);
}

// The board templates open with a `<!-- SUBTASK ONLY … -->` comment and the subtask callout under it, and say "in a
// standalone job, delete both". A new card is a standalone job, so both go: the comment line, the `>` lines right
// after it, and one blank line.
function dropSubtaskCallout(raw) {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => /^<!--\s*SUBTASK ONLY\b/.test(l.trim()));
  if (at === -1) return raw;
  let end = at + 1;
  while (end < lines.length && /^>/.test(lines[end])) end++;
  if (end < lines.length && lines[end].trim() === '') end++;
  lines.splice(at, end - at);
  return lines.join('\n');
}

// A new card's task.md from the workspace's template (or a built-in one), with the card's fields filled in.
function buildTaskFile({ template, card, id, today, automationName, agentLabel, fromCardId }) {
  let raw = typeof template === 'string' ? template.replace(/\r\n/g, '\n') : '';
  if (!/^---\n[\s\S]*?\n---/.test(raw)) raw = BUILT_IN;
  raw = dropSubtaskCallout(raw);
  const fields = [['id', id], ['title', oneLine(card.title)], ['status', 'backlog'], ['priority', card.priority || 'med'],
    ['created', today], ['updated', today], ...(card.key ? [['source_key', card.key]] : []), ['created_by', oneLine(automationName)]];
  for (const [k, v] of fields) raw = setFrontmatterField(raw, k, v);
  raw = setAliases(raw, id);
  const context = [];
  if (card.context) context.push(...safeNote(String(card.context)).split('\n'));
  if (card.link) context.push(...(context.length ? [''] : []), `Source: ${oneLine(card.link)}`);
  const plan = (card.plan && card.plan.length ? card.plan : ['Look at the source and plan this'])
    .map((l) => `- [ ] ${safeNote(oneLine(l))}`);
  const log = `- ${today} — Created by automation "${oneLine(automationName)}" (${oneLine(agentLabel)})${fromCardId ? ` from [[${oneLine(fromCardId)}]]` : ''}.`;
  raw = putSection(raw, 'Goal', [safeNote(oneLine(card.goal))]);
  raw = putSection(raw, 'Context / key facts', context);
  raw = putSection(raw, 'Plan', plan);
  raw = putSection(raw, 'Progress log', [log]);
  if (!hasSection(raw, 'Findings / decisions')) raw = putSection(raw, 'Findings / decisions', []);
  return raw;
}

// ---------- What's already there (spec §6) ----------
const INDEX_SKIP = new Set(['_tasks', '_Templates']);
async function readMeta(full) {
  try { return parseFrontmatter(await fsp.readFile(full, 'utf8')).meta; } catch { return null; }
}
const keyOf = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const titleOf = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

// keys: the lowercased id and source_key of every task.md on the board, Done, archive and _cancelled included
// (only dot folders, _tasks and _Templates are left out), so a finished or moved card still counts. existing:
// the cards directly inside the destination, for the prompt and the keyless title check.
async function boardIndex(boardDir, destDir) {
  const keys = new Set();
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!INDEX_SKIP.has(e.name)) await walk(full); continue; }
      if (e.name !== 'task.md') continue;
      const meta = await readMeta(full);
      if (!meta) continue;
      for (const k of [keyOf(meta.id), keyOf(meta.source_key)]) if (k) keys.add(k);
    }
  }
  await walk(boardDir);
  const existing = [];
  let entries = [];
  try { entries = await fsp.readdir(destDir, { withFileTypes: true }); } catch { /* checked before a run */ }
  for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const meta = await readMeta(path.join(destDir, e.name, 'task.md'));
    if (meta) existing.push({ id: meta.id || e.name, title: meta.title || e.name, status: meta.status || 'backlog' });
  }
  return { keys: [...keys], existing };
}

// ---------- Creating cards (spec §5–§6) ----------
const HOUR_MS = 3600 * 1000;
// One writer per VaultOS: every add from every run goes through its one queue, so two runs can't race for a folder,
// and the rolling-hour cap counts across automations. begin() opens a run: its index, its in-run checks, its cap.
function createCardWriter({ vaultDir, now = Date.now, perHour = NEW_CARDS_PER_HOUR }) {
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  let stamps = [];               // when each real card was created, for the rolling hour
  const madeKeys = new Set();    // keys this writer created, seen by runs whose index is older
  const rel = (full) => path.relative(vaultDir, full).split(path.sep).join('/');

  async function begin({ boardDir, destDir, max, automationName, agentLabel, trial = false, today, tz, onCreate = async () => {} }) {
    const index = await boardIndex(boardDir, destDir);
    const seenKeys = new Set();
    const seenTitles = new Set();
    let made = 0;
    const templateFile = path.join(boardDir, '_tasks', '_Templates', 'task.md');

    function add(card, { fromCardId } = {}) {
      return serial(async () => {
        const key = card.key ? keyOf(card.key) : '';
        const title = titleOf(card.title);
        const tag = { title: card.title, ...(card.key ? { key: card.key } : {}) };
        const not = (reason) => ({ notCreated: { ...tag, reason } });
        const dupInRun = key ? seenKeys.has(key) : seenTitles.has(title);
        if (key) seenKeys.add(key); else seenTitles.add(title);
        if (dupInRun) return not('duplicate in this run');
        if (key && (index.keys.includes(key) || madeKeys.has(key))) return not(`${card.key} already has a card`);
        if (!key && index.existing.some((e) => titleOf(e.title) === title)) return not('a card with that title already exists');
        if (made >= max) return not(`not created (over the limit of ${max})`);
        if (!trial) {
          stamps = stamps.filter((t) => now() - t < HOUR_MS);
          if (stamps.length >= perHour) return not(`not created (${perHour} an hour across automations)`);
        }
        const name = folderNameFor(card, now(), tz);
        const dir = path.join(destDir, name);
        const file = path.join(dir, 'task.md');
        if (trial) {
          if (fs.existsSync(dir)) return not(`a folder called ${name} already exists`);
        } else {
          try { await fsp.mkdir(dir); } catch (err) {
            return not(err && err.code === 'EEXIST' ? `a folder called ${name} already exists` : `VaultOS couldn't create it: ${err && err.message}`);
          }
          let template = null;
          try { template = await fsp.readFile(templateFile, 'utf8'); } catch { /* the built-in one */ }
          const tmp = path.join(dir, `.task.md.${crypto.randomBytes(6).toString('hex')}.tmp`);
          try {
            await fsp.writeFile(tmp, buildTaskFile({ template, card, id: name, today, automationName, agentLabel, fromCardId }));
            await fsp.rename(tmp, file);
          } catch (err) {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            return not(`VaultOS couldn't create it: ${err && err.message}`);
          }
          stamps.push(now());
          if (key) madeKeys.add(key);
        }
        made++;
        if (key) index.keys.push(key);
        index.existing.push({ id: name, title: card.title, status: 'backlog' });
        if (!trial) {
          try { await onCreate(); } catch (err) { console.error('automations: after creating a card:', err && err.message); }
        }
        return { created: { path: rel(file), id: name, title: card.title, ...(card.key ? { key: card.key } : {}) } };
      });
    }
    return { index, add };
  }
  return { begin };
}

module.exports = { checkDestination, destinationFolders, folderNameFor, slugTitle, buildTaskFile, boardIndex, createCardWriter };
