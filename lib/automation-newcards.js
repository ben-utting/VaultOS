'use strict';
// New cards an automation proposes (spec 2026-11-25 §5–§6). The agent never writes them: it sends vaultos-card
// blocks and VaultOS creates each card here, inside the one folder the automation names. This file holds where
// a card may go (checkDestination, destinationFolders), what its folder is called and what its task.md says.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { setFrontmatterField, replaceSection } = require('./task-file');
const { safeNote } = require('./automation-note');
const { wallParts } = require('../public/automation-core');

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

// A new card's task.md from the workspace's template (or a built-in one), with the card's fields filled in.
function buildTaskFile({ template, card, id, today, automationName, agentLabel, fromCardId }) {
  let raw = typeof template === 'string' ? template.replace(/\r\n/g, '\n') : '';
  if (!/^---\n[\s\S]*?\n---/.test(raw)) raw = BUILT_IN;
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

module.exports = { checkDestination, destinationFolders, folderNameFor, slugTitle, buildTaskFile };
