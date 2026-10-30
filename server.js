'use strict';

const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const { marked } = require('marked');

// ---------- Config ----------
const ROOT = __dirname;
const VAULT_DIR = process.env.VAULT_DIR || '/vault';
const PORT = parseInt(process.env.PORT || '8080', 10);
// Test hook: shrinks a "minute" so the e2e can run a timer in seconds. Integer 1-60 only.
const TODAY_SPM = (() => { const n = parseInt(process.env.TODAY_SECONDS_PER_MINUTE || '', 10); return n >= 1 && n <= 60 ? n : 60; })();
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';

// Password hash, session secret and lockout live in DATA_DIR (default ~/.vaultos),
// outside the synced vault. No config is a normal state now: first-run setup sets
// the password, and until then sessions are signed with a secret made at boot,
// which setup then writes into config.json so its own login survives.
const { dataDirFrom, readConfig, writePassword, MIN_PASSWORD, verifyPassword, readLockout, writeLockout } = require('./lib/password');
const DATA_DIR = dataDirFrom(process.env);
let config = readConfig(DATA_DIR);
const PENDING_SECRET = crypto.randomBytes(32).toString('hex');

// ---------- Settings (.vaultos/settings.json in the vault) ----------
// Boards, Today and the agent come from the vault's own settings file, read once
// at boot (see boot()) and cached by the store; every save updates the cache.
// A file that fails to load is never replaced: its message sits in SETTINGS_ERROR
// and the setup screen shows it until someone fixes the file.
const { SETTINGS_REL, createSettingsStore, visibleBoards, defaults: settingsDefaults, addBoard, addExistingBoard, updateBoard, SettingsError } = require('./lib/settings');
const { parseAllowedHosts, hostAllowed, safeHost } = require('./lib/host-check');
const { writeRootKit, writeBoardKit, updateAgentsBlock } = require('./lib/starter-kit');
const { zonedDate } = require('./lib/today-note');
const { legacySettings } = require('./lib/migrate');
const { setupStage, stepsFor, folderCheck, windowOpen } = require('./lib/setup');
const { createConnectorService, ConnectorError } = require('./lib/connector-service');
const { createRelay } = require('./lib/connector-relay');
const { runCapture } = require('./lib/connector-azure');
const { PROFILES, kickoffPrompt, profileFor, startCommand, isInstalled, installClaudeHook, processMatches, processState, terminalTask } = require('./lib/agents');
const { createReadStore, readingMinutes, readState, readAt, mergeImport, articleKey, inMorning, morningPick, SKIP_DAYS } = require('./lib/kb-reads');
const settingsStore = createSettingsStore(VAULT_DIR);
let SETTINGS_ERROR = null;
const SETTINGS = () => settingsStore.current();
// The terminal is mounted unless TERMINAL=0 (a deployment that must never offer a
// shell); whether it is offered is the features.terminal setting, read on every use.
const TERMINAL_ENV = process.env.TERMINAL !== '0';
const terminalOn = () => TERMINAL_ENV && !!(SETTINGS() && SETTINGS().features.terminal);
const stage = () => setupStage({ hasPassword: !!config, settings: SETTINGS(), settingsError: SETTINGS_ERROR });

// Independent trees under the vault root, same Board/KB conventions. Each `?ws=` request
// param picks one; everything below resolves against its dir, not a single global constant,
// so writes/scans never cross boards. All of them, hidden ones included: hiding only
// takes a board out of the switcher.
const boards = () => (SETTINGS() ? SETTINGS().boards : []);
// The first visible board (or the first of all, if a hand edit hid every one).
const defaultBoard = () => boards().find((b) => !b.hidden) || boards()[0];
function resolveWorkspace(key) {
  const b = boards().find((x) => x.key === key) || defaultBoard();
  if (!b) throw Object.assign(new Error('No boards yet. Finish setup first.'), { status: 409 });
  return { key: b.key, dir: path.join(VAULT_DIR, b.dir), label: b.label };
}

// Today's folder, or null while Today is off (no folder, no service).
function todayDir() {
  const s = SETTINGS();
  return s && s.features.today ? path.join(VAULT_DIR, s.today.dir) : null;
}
// Board and KB scans skip the Today folder whether Today is on or off: its notes
// are not jobs, and switching Today off should not put them on a board.
function todaySkipDir() {
  const s = SETTINGS();
  return s ? path.join(VAULT_DIR, s.today.dir) : null;
}

// Folders that hold reference material rather than jobs — never scanned for tasks.
// _cancelled/ holds jobs pulled before completion (status: cancelled): kept on disk, off the board.
const SKIP_DIRS = new Set(['_tasks', '_Templates', 'archive', 'correspondence', 'data', 'Scripts', '_cancelled']);

const STATUSES = ['backlog', 'in-progress', 'blocked', 'needs-decision', 'review', 'scheduled', 'done'];

// Lockout policy: after MAX_ATTEMPTS failures, lock for escalating durations.
const MAX_ATTEMPTS = 5;
const LOCK_STEPS_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3]; // 1m, 5m, 15m, 60m

// ---------- Path safety ----------
// Resolve a client-supplied relative path inside the given workspace, rejecting traversal.
function safeTaskPath(relPath, wsDir) {
  const clean = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(VAULT_DIR, clean);
  if (!full.startsWith(wsDir + path.sep)) throw new Error('Path outside workspace');
  if (path.basename(full) !== 'task.md') throw new Error('Not a task file');
  return realInWorkspace(full, wsDir);
}
// The checks above read the path as written; this one follows it. Where it really
// leads must still be inside the workspace, so a symlinked file or folder can't walk
// out of it (Files has the same rule in safeVaultPath). A missing file is left for
// the caller's own read to report, as before.
function realInWorkspace(full, wsDir) {
  let real;
  try { real = fs.realpathSync.native(full); }
  catch (err) { if (err.code === 'ENOENT') return full; throw err; }
  if (!real.startsWith(fs.realpathSync.native(wsDir) + path.sep)) throw new Error('Path outside workspace');
  return full;
}
function relOf(full) {
  return path.relative(VAULT_DIR, full).split(path.sep).join('/');
}

// A job's other .md files — guides, notes, anything dropped beside task.md —
// listed so the drawer can offer them without leaving the app. task.md and
// article.md already have their own dedicated views, so they're excluded here.
async function siblingDocs(taskFull) {
  const dir = path.dirname(taskFull);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') &&
      e.name !== 'task.md' && e.name !== 'article.md')
    .map((e) => ({ name: e.name, path: relOf(path.join(dir, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A sibling .md file's path is safe to read only if it sits in the same folder
// as a task.md — that's the whole allowlist, same discipline as diagrams/
// and screenshots/: it keeps this from becoming a way to read arbitrary
// markdown out of the vault (GPO reports, CVs, saved pages under _Templates).
async function safeJobDocPath(relPath, wsDir) {
  const clean = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(VAULT_DIR, clean);
  if (!full.startsWith(wsDir + path.sep)) throw new Error('Path outside workspace');
  if (path.extname(full).toLowerCase() !== '.md') throw new Error('Not a markdown file');
  const base = path.basename(full);
  if (base === 'task.md' || base === 'article.md') throw new Error('Use the dedicated view for this file');
  await fsp.access(path.join(path.dirname(full), 'task.md'));
  return realInWorkspace(full, wsDir);
}

// ---------- Frontmatter ----------
// Deliberately a small YAML subset: `key: value`, optionally quoted. That is all the
// task template uses, and a full YAML parser would invite formats the writer can't
// round-trip safely later.
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const rawVal = kv[2].trim();
    // A quoted scalar's content is verbatim between the matching quotes — it must never
    // go through comment-stripping, or a title/value that legitimately contains '#'
    // (a ticket number in parens, a hex colour, ...) gets silently truncated.
    // Double quotes honour the \" and \\ escapes; single quotes honour ''.
    const qm = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(rawVal);
    if (qm) {
      meta[kv[1]] = qm[1] !== undefined ? qm[1].replace(/\\(["\\])/g, '$1') : qm[2].replace(/''/g, "'");
      continue;
    }
    const v = rawVal.replace(/\s+#.*$/, '').trim();
    // Inline list: `stack: [a, b, c]` → array. Only KB articles use this; task.md never
    // has bracketed values, so existing files are unaffected.
    if (v.startsWith('[') && v.endsWith(']')) {
      meta[kv[1]] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

// Line indices of `- [ ]` / `- [x]` plan items, ignoring fenced code blocks.
// Only these two forms are indexed, because they are exactly what marked renders as
// <input type="checkbox">. Other markers (notably `[~]`, used for "proposed" decisions)
// are left alone — including them here would desync the UI's Nth-checkbox index from
// the file's Nth line.
function checklistLines(body) {
  const lines = body.split(/\r?\n/);
  const idx = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*[-*]\s*\[[ xX]\]/.test(lines[i])) idx.push(i);
  }
  return { lines, idx };
}

function countChecklist(body) {
  const { lines, idx } = checklistLines(body);
  let done = 0;
  for (const i of idx) if (/^\s*[-*]\s*\[[xX]\]/.test(lines[i])) done++;
  return { done, total: idx.length };
}

// ---------- Scanner ----------
async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || full === todaySkipDir()) continue;
      await walk(full, out);
    } else if (e.name === 'task.md') {
      out.push(full);
    }
  }
  return out;
}

async function loadTask(full) {
  const [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
  const { meta, body } = parseFrontmatter(raw);
  const rel = relOf(full);
  const folder = path.dirname(rel);                              // e.g. Work/2. website/...  
  const segs = folder.split('/');
  const project = segs[1] || '(root)';                           // top-level folder under Work
  const status = STATUSES.includes(meta.status) ? meta.status : 'backlog';
  // A sibling article.md means this job has a Knowledge Base write-up.
  let articlePath = '';
  try {
    await fsp.access(path.join(path.dirname(full), 'article.md'));
    articlePath = folder + '/article.md';
  } catch { /* no article yet */ }
  return {
    path: rel,
    folder,
    articlePath,
    project,
    name: segs[segs.length - 1],
    title: meta.title || segs[segs.length - 1],
    id: meta.id || '',
    area: meta.area || '',
    status,
    priority: meta.priority || 'med',
    owner: meta.owner || '',
    created: meta.created || '',
    updated: meta.updated || '',
    blocked_by: meta.blocked_by || '',
    review_note: meta.review_note || '',   // status: review — what's left to verify/write up/decide
    scheduled_for: meta.scheduled_for || '', // status: scheduled — target start/CAB date
    decision_note: meta.decision_note || '', // status: needs-decision — what needs deciding, and by whom
    batch: meta.batch || '',                 // free-text grouping key: this task is one of N siblings (see batchKeyOf)
    host: meta.host || '',                   // the box this work happens on — a label, never part of a copied path
    checklist: countChecklist(body),
    mtime: stat.mtimeMs,
    body,
  };
}

// ---------- Batches ----------
// A batch is one free-text `batch:` value shared by N sibling task.md files, each of
// which stays a real card. Children point at the parent; the parent declares nothing,
// so the key a parent answers to has to be derived — its `id:` (which is what the
// existing clusters already name themselves, e.g. id: "stage-3-secrets"), falling back
// to its folder name for the handful of task.md files with no id.
// A batch needs no parent file at all: several clusters (ceph, bonus-drills) are
// parentless, and those are reachable through the chip/filter instead of a parent page.
function batchKeyOf(task) {
  return task.id || task.name || '';
}

// Every task in the workspace declaring `batch: <key>`, minus the parent itself.
// Ordered by folder so the rows match the on-disk 01-/04-/05- numbering the user reads them in.
function childrenOfBatch(tasks, key, selfPath) {
  if (!key) return [];
  return tasks
    .filter((t) => t.batch === key && t.path !== selfPath)
    .sort((a, b) => a.folder.localeCompare(b.folder))
    .map(({ path: p, folder, title, status, priority, host, batch, updated, checklist }) =>
      ({ path: p, folder, title, status, priority, host, batch, updated, checklist }));
}

// A subtask's task.md opens with a callout telling whoever picks the file up in a terminal
// how to close it — don't run /done, file output in the parent's data/, no article per child.
// That contract is written for the agent, not for the user reading the board: the drawer already
// shows the parent back-link and the batch chip, so on screen the banner is pure noise above
// every subtask's Goal.
//
// This strips it from the rendered HTML only. The file on disk is untouched, which is the
// whole point — `inject-plan.sh` feeds the raw task.md to the agent, and the agent still
// gets its instructions. Matching is deliberately narrow (a *leading* callout whose title
// line says SUBTASK) so an ordinary `> [!warning]` in the middle of a task still renders.
function stripAgentBanner(body) {
  const m = /^\s*>\s*\[!\w+\][^\n]*\bSUBTASK\b[^\n]*\n(?:>[^\n]*(?:\n|$))*/i.exec(body);
  return m ? body.slice(m[0].length).replace(/^\s*\n/, '') : body;
}

// The other direction: the task a child's `batch:` points at, so a subtask can get back to
// the page it was dispatched from. Null for a parentless batch (ceph, bonus-drills), which
// is a normal state, not an error — those clusters have no parent file to return to.
function parentOfBatch(tasks, batch, selfPath) {
  if (!batch) return null;
  const p = tasks.find((t) => t.path !== selfPath && t.batch !== batch && batchKeyOf(t) === batch);
  return p ? { path: p.path, title: p.title, status: p.status } : null;
}

async function scanAll(wsDir) {
  const files = await walk(wsDir, []);
  const tasks = await Promise.all(files.map(loadTask));
  tasks.sort((a, b) => a.folder.localeCompare(b.folder));
  return tasks;
}

// ========================================================================
// Knowledge Base
// ------------------------------------------------------------------------
// Completed jobs grow a sibling `article.md` — a curated, skim-first write-up
// (see Work/_tasks/_Templates/article.md). The KB portal reads those. A job's
// task.md stays the working doc; the article is the durable knowledge.
// Collections = the top-level area folder (same grouping the board calls
// "project"). Articles link to each other with [[wikilinks]]; backlinks are
// derived, so linking one direction is enough.
// ========================================================================

// Strip the "N. " ordering prefix area folders carry, for display.
function collectionName(key) {
  return key.replace(/^\d+\.\s*/, '');
}

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

async function walkKB(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || full === todaySkipDir()) continue;   // also skips _tasks, so the template never shows
      await walkKB(full, out);
    } else if (e.name === 'article.md') {
      out.push(full);
    }
  }
  return out;
}

// First blockquote (the TL;DR) or first real paragraph, as a plain-text excerpt.
function articleExcerpt(body) {
  const lines = body.split(/\r?\n/);
  const quote = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) quote.push(l.replace(/^\s*>\s?/, ''));
    else if (quote.length) break;
  }
  let text = quote.join(' ');
  if (!text) {
    for (const l of lines) {
      const t = l.trim();
      if (!t || t.startsWith('#') || t.startsWith('---')) continue;
      text = t; break;
    }
  }
  return text.replace(/\*\*|__|`|\[\[|\]\]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^TL;DR\s*[:—–-]?\s*/i, '').trim().slice(0, 220);
}

// Targets referenced by [[...]] in a body (raw target strings, before the `|`).
function outgoingTargets(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1].split('|')[0].trim());
  return out;
}

async function loadArticleRaw(full) {
  const [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
  const { meta, body } = parseFrontmatter(raw);
  const rel = relOf(full);                                   // Work/<area>/<job>/article.md
  const segs = path.dirname(rel).split('/');
  const collection = segs[1] || '(root)';
  const stack = Array.isArray(meta.stack) ? meta.stack : (meta.stack ? [meta.stack] : []);
  return {
    path: rel,
    collection,
    collectionName: collectionName(collection),
    title: meta.title || segs[segs.length - 1],
    area: meta.area || '',
    stack,
    tickets: meta.tickets || '',
    job: meta.job || '',
    status: meta.status || 'published',
    created: meta.created || '',
    updated: meta.updated || '',
    mtime: stat.mtimeMs,
    minutes: readingMinutes(body),
    excerpt: articleExcerpt(body),
    diagrams: articleDiagrams(body, rel),
    body,
  };
}

// Build a resolver from a link target to an article's rel path. Accepts the
// full path (with or without .md), the job folder name, or the title.
function buildResolver(articles) {
  const byKey = new Map();
  const add = (k, rel) => { const key = String(k).toLowerCase(); if (k && !byKey.has(key)) byKey.set(key, rel); };
  for (const a of articles) {
    const noExt = a.path.replace(/\.md$/, '');
    add(a.path, a.path);
    add(noExt, a.path);
    add(path.basename(path.dirname(a.path)), a.path);        // job folder slug
    add(a.title, a.path);
  }
  return (target) => byKey.get(String(target).toLowerCase().replace(/\.md$/, '')) || null;
}

// [[target|label]] → markdown link the frontend routes on (#kb/<enc>); unresolved → plain label.
function renderWikilinks(body, resolve) {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_m, inner) => {
    const [t, l] = inner.split('|');
    const target = t.trim();
    const label = (l || t).trim();
    const rel = resolve(target);
    return rel ? `[${label}](#kb/${encodeURIComponent(rel)})` : label;
  });
}

// Decode the handful of HTML entities marked emits, so TOC labels read as plain text
// and heading slugs are computed from the real characters.
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Add ids to h2/h3 and return a table of contents in document order.
function headingsAndToc(html) {
  const toc = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    const id = slugify(text);
    toc.push({ level: Number(lvl), text, id });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });
  return { html: out, toc };
}

async function scanKB(wsDir) {
  const files = await walkKB(wsDir, []);
  const articles = await Promise.all(files.map(loadArticleRaw));
  articles.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.title.localeCompare(b.title));
  return articles;
}

// ========================================================================
// Diagrams
// ========================================================================
// Diagrams are authored by the `diagram-design` skill as standalone HTML files
// carrying one inline <svg>, and live in a `diagrams/` subfolder of the job:
//
//   Work/<area>/<job>/diagrams/cert-chain.html
//
// referenced from article.md (or task.md) as a plain image: `![Caption](diagrams/cert-chain.html)`.
//
// The generated SVG is fully self-contained — literal hex fills, inline
// font-family attributes, no CSS classes and no var(--…) references, and it
// paints its own background rect. So we lift the <svg> straight out of the file
// and inject it into the page rather than iframing the HTML. That buys a real
// DOM node (pan/zoom is plain viewBox arithmetic), crisp text at any zoom, and
// no style bleed in either direction.
//
// The one thing that is NOT self-contained is <defs> ids — `arrow`, `dots`,
// `architecture-title` are page-global and identical across every generated
// diagram, so two on one article would silently steal each other's markers.
// Every id is therefore namespaced per file on the way out.

const DIAGRAM_EXT = new Set(['.html', '.htm', '.svg']);

// Screenshots dropped into a job's `screenshots/` folder — same allowlist
// discipline as diagrams (parent dir name is the whole gate), but these are
// raw image bytes, not HTML to extract from.
const SCREENSHOT_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
]);

function safeScreenshotPath(relPath, wsDir) {
  const clean = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(VAULT_DIR, clean);
  if (!full.startsWith(wsDir + path.sep)) throw new Error('Path outside workspace');
  const contentType = SCREENSHOT_EXT.get(path.extname(full).toLowerCase());
  if (!contentType) throw new Error('Not an image file');
  if (path.basename(path.dirname(full)) !== 'screenshots') throw new Error('Not in a screenshots/ folder');
  return { full: realInWorkspace(full, wsDir), contentType };
}

// Same traversal rules as tasks, but the file must sit in a `diagrams/` folder.
// That constraint is the whole allowlist: it keeps this endpoint from becoming a
// way to read arbitrary HTML out of the vault (GPO reports, CVs, saved pages).
function safeDiagramPath(relPath, wsDir) {
  const clean = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(VAULT_DIR, clean);
  if (!full.startsWith(wsDir + path.sep)) throw new Error('Path outside workspace');
  if (!DIAGRAM_EXT.has(path.extname(full).toLowerCase())) throw new Error('Not a diagram file');
  if (path.basename(path.dirname(full)) !== 'diagrams') throw new Error('Not in a diagrams/ folder');
  return realInWorkspace(full, wsDir);
}

// A stable, collision-proof namespace for one diagram's ids, derived from its path.
function diagramNs(rel) {
  return 'd' + crypto.createHash('sha1').update(rel).digest('hex').slice(0, 8);
}

// Pull the inline <svg>…</svg> out of a diagram file. A .svg file is already one.
function extractSvg(raw) {
  const start = raw.search(/<svg[\s>]/i);
  if (start === -1) return null;
  const end = raw.toLowerCase().lastIndexOf('</svg>');
  if (end === -1 || end < start) return null;
  return raw.slice(start, end + '</svg>'.length);
}

// Rewrite every id and every reference to one, so several diagrams can share a page.
// Covers the three forms the generated SVGs use: id="", url(#…) in fill/stroke/marker-*,
// and href/xlink:href/aria-labelledby pointing at a local id.
function namespaceIds(svg, ns) {
  const ids = new Set();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  if (!ids.size) return svg;
  let out = svg.replace(/(\sid=")([^"]+)(")/g, (_m, a, id, b) => `${a}${ns}-${id}${b}`);
  out = out.replace(/url\(#([^)]+)\)/g, (m, id) => (ids.has(id) ? `url(#${ns}-${id})` : m));
  out = out.replace(/((?:xlink:)?href=")#([^"]+)(")/g, (m, a, id, b) => (ids.has(id) ? `${a}#${ns}-${id}${b}` : m));
  out = out.replace(/(\saria-labelledby=")([^"]+)(")/g, (m, a, list, b) => {
    const mapped = list.split(/\s+/).map((id) => (ids.has(id) ? `${ns}-${id}` : id)).join(' ');
    return `${a}${mapped}${b}`;
  });
  return out;
}

const firstTag = (svg, tag) => {
  const m = svg.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : '';
};

// Read one diagram file and return everything the viewer needs.
async function loadDiagram(full) {
  const rel = relOf(full);
  let raw, stat;
  try {
    [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
  } catch {
    throw new Error('Diagram file not found');   // never echo the server-side path back
  }
  const found = extractSvg(raw);
  if (!found) throw new Error('No <svg> found in this file');
  const ns = diagramNs(rel);
  const svg = namespaceIds(found, ns);
  const vb = svg.match(/viewBox="([\d.\-\s]+)"/i);
  const box = vb ? vb[1].trim().split(/\s+/).map(Number) : null;
  // The page <h1> is the diagram's real headline; <title> inside the SVG mirrors it.
  const h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    path: rel,
    ns,
    title: firstTag(svg, 'title') || (h1 ? decodeEntities(h1[1].replace(/<[^>]+>/g, '')).trim() : '') ||
      path.basename(rel, path.extname(rel)),
    desc: firstTag(svg, 'desc'),
    viewBox: box && box.length === 4 ? box : [0, 0, 1000, 600],
    mtime: stat.mtimeMs,
    svg,
  };
}

// marked renders `![Caption](diagrams/x.html)` as an <img>, which no browser can
// display — an HTML file is not an image. Swap those (and the equivalent link
// form) for a placeholder the frontend hydrates with the real SVG. Anything not
// pointing into a diagrams/ folder is left completely alone, so ordinary images
// and links keep working.
function linkDiagrams(html, docRel) {
  const baseDir = path.dirname(docRel);
  const isDiagram = (src) =>
    !/^[a-z]+:/i.test(src) && !src.startsWith('#') &&
    DIAGRAM_EXT.has(path.extname(src).toLowerCase()) &&
    path.basename(path.dirname(src)) === 'diagrams';
  const figure = (src, caption) => {
    const rel = path.normalize(path.join(baseDir, src));
    const cap = caption ? `<figcaption>${caption}</figcaption>` : '';
    return `<figure class="diagram" data-diagram="${escapeHtml(rel)}">` +
      `<div class="diagram-slot"><span class="diagram-loading">Loading diagram…</span></div>${cap}</figure>`;
  };
  return html
    .replace(/<img\s+([^>]*?)>/gi, (m, attrs) => {
      const src = (attrs.match(/src="([^"]*)"/i) || [])[1] || '';
      if (!isDiagram(decodeURIComponent(src))) return m;
      return figure(decodeURIComponent(src), (attrs.match(/alt="([^"]*)"/i) || [])[1] || '');
    })
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      if (!isDiagram(decodeURIComponent(href))) return m;
      return figure(decodeURIComponent(href), label.replace(/<[^>]+>/g, '').trim());
    });
}

// Same diagram references as linkDiagrams, but read straight off the raw
// markdown (no render pass) — used to build the KB welcome page's "random
// diagram" spotlight without rendering every article in the workspace.
function articleDiagrams(body, docRel) {
  const baseDir = path.dirname(docRel);
  const isDiagram = (src) =>
    !/^[a-z]+:/i.test(src) && !src.startsWith('#') &&
    DIAGRAM_EXT.has(path.extname(src).toLowerCase()) &&
    path.basename(path.dirname(src)) === 'diagrams';
  const out = [];
  const seen = new Set();
  const re = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(body))) {
    const src = decodeURIComponent(m[2]);
    if (!isDiagram(src)) continue;
    const rel = path.normalize(path.join(baseDir, src));
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ path: rel, caption: m[1] || '' });
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// marked renders `![Caption](screenshots/x.png)` as a plain <img src="screenshots/x.png">,
// which 404s — there's no static file server for job folders. Point it at
// /api/screenshot instead. Unlike diagrams this doesn't need client-side
// hydration (it's just bytes), so the server builds the final URL directly,
// using the workspace this request already resolved.
function linkScreenshots(html, docRel, wsKey) {
  const baseDir = path.dirname(docRel);
  const isScreenshot = (src) =>
    !/^[a-z]+:/i.test(src) && !src.startsWith('#') &&
    SCREENSHOT_EXT.has(path.extname(src).toLowerCase()) &&
    path.basename(path.dirname(src)) === 'screenshots';
  return html.replace(/<img\s+([^>]*?)>/gi, (m, attrs) => {
    const src = (attrs.match(/src="([^"]*)"/i) || [])[1] || '';
    const decoded = decodeURIComponent(src);
    if (!isScreenshot(decoded)) return m;
    const rel = path.normalize(path.join(baseDir, decoded));
    const url = `/api/screenshot?path=${encodeURIComponent(rel)}&ws=${encodeURIComponent(wsKey)}`;
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    const cap = alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : '';
    return `<figure class="screenshot"><a href="${url}" target="_blank" rel="noopener">` +
      `<img src="${url}" alt="${escapeHtml(alt)}" loading="lazy"></a>${cap}</figure>`;
  });
}

// Every markdown body in the app renders through here, so a diagram or
// screenshot reference works the same in a KB article and in a live task's drawer.
function renderBody(md, docRel, wsKey) {
  return linkScreenshots(linkDiagrams(marked.parse(stripAgentNotes(md)), docRel), docRel, wsKey);
}

// `> [!agent] …` callouts are notes for the next Claude session (where to pick
// up, what not to do) — agents read the raw task.md, so they still get them;
// people reading in VaultOS don't need to. The whole quote block goes, up to
// the first line that isn't `>`. Fenced code is left alone, so an example of
// the syntax inside ``` still shows.
function stripAgentNotes(md) {
  const out = [];
  let fence = false, skipping = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^\s*>\s*\[!agent\]/i.test(line)) { skipping = true; continue; }
    if (skipping && /^\s*>/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join('\n');
}

// ---------- Writer ----------
// Rules, all deliberate:
//  - Surgical line edits only. Never regenerate a file from parsed state — Obsidian and
//    Claude Code also write these files, and anything we don't model would be destroyed.
//  - Atomic write (tmp in the same dir, then rename) — a torn write here shows up as the
//    zero-byte file in sync tools like Syncthing.
//  - mtime guard: refuse if the file changed since the client loaded it.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const { atomicWrite } = require('./lib/atomic-write');
const { createToday } = require('./lib/today-service');
const { createQuotes } = require('./lib/today-quote');
const { createIndex } = require('./lib/search');

// One warm search index for the KB box and the agents' `vault-search`. The vault
// may sit on a network share where a full walk takes seconds, so searches answer
// from memory and a background rescan runs at most once a minute.
const searchIndex = createIndex(VAULT_DIR, { maxAgeMs: 60e3 });

// Built on first use from the settings, and only while Today is on, so a vault
// without Today never starts the timer service or fetches a quote.
// TODAY_QUOTES=0 (tests) swaps ZenQuotes for a stub that never has one.
const NO_QUOTES = { today: async () => null, random: async () => null };
let TODAY_SVC = null;
function todayService() {
  const dir = todayDir();
  if (!dir) return null;
  if (!TODAY_SVC) {
    TODAY_SVC = createToday({
      dir,
      quotes: process.env.TODAY_QUOTES === '0' ? NO_QUOTES : createQuotes({ fetch }),
      secondsPerMinute: TODAY_SPM,
      timeZone: SETTINGS().today.timezone,
    });
  }
  return TODAY_SVC;
}

async function readGuarded(full, expectedMtime) {
  const [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
  if (expectedMtime && Math.abs(stat.mtimeMs - Number(expectedMtime)) > 1) {
    const err = new Error('This task changed on disk since you loaded it. Refresh and retry.');
    err.status = 409;
    throw err;
  }
  return raw;
}

// Insert lines into a `## <heading>` section of the body, touching nothing else.
// Creates the section at the end of the file when missing. 'top' inserts just under
// the heading (Progress log is newest-first); 'bottom' inserts at the section's end
// (Comments read as a thread, oldest first).
function insertInSection(raw, heading, entry, position) {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(raw);
  const head = m ? m[1] : '';
  const lines = (m ? m[2] : raw).split('\n');
  const isHeading = (l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l.trim());
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && isHeading(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${heading}`, '', ...entry, '');
    return head + lines.join('\n');
  }
  let end = lines.length;                      // first line after the section
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^##\s/.test(lines[i])) { end = i; break; }
  }
  let at;
  if (position === 'top') {
    at = start + 1;
    if (at < end && lines[at].trim() === '') at++; // keep the blank line under the heading
  } else {
    at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at--; // land after the last real line
  }
  lines.splice(at, 0, ...entry);
  return head + lines.join('\n');
}

// A board comment as markdown list-item lines: `- **<date> <time>:** text`,
// continuation lines indented so multi-line comments stay one list item.
// No name: a VaultOS has one user.
function formatComment(text) {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const parts = String(text).replace(/\r/g, '').trim().split('\n');
  return [`- **${todayISO()} ${hhmm}:** ${parts[0]}`, ...parts.slice(1).map((l) => `  ${l}`)];
}

// Replace a single frontmatter field in place, leaving the rest of the file byte-identical.
function setFrontmatterField(raw, key, value) {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!m) throw new Error('No frontmatter block');
  const re = new RegExp(`^(${key}:[ \\t]*).*$`, 'm');
  let fm = m[2];
  const quoted = /[:#"\\]/.test(value) || value !== value.trim()
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
  fm = re.test(fm) ? fm.replace(re, (_, p1) => p1 + quoted) : `${fm}\n${key}: ${quoted}`;
  return raw.slice(0, m[1].length) + fm + raw.slice(m[1].length + m[2].length);
}

// ---------- Board.md regeneration ----------
// Board.md is generated output, not a second source of truth. Frontmatter `status:` wins.
const COLUMN_TITLES = {
  'backlog': 'Backlog', 'scheduled': 'Scheduled', 'in-progress': 'In Progress',
  'blocked': 'Blocked', 'needs-decision': 'Needs Decision', 'review': 'Review', 'done': 'Done',
};

async function regenerateBoard(tasks, wsDir) {
  const boardPath = path.join(wsDir, '_tasks', 'Board.md');
  try { await fsp.access(boardPath); } catch { return; } // don't create it if it was removed
  if (!tasks) tasks = await scanAll(wsDir);
  const out = ['---', '', 'kanban-plugin: board', '', '---', ''];
  for (const s of STATUSES) {
    out.push(`## ${COLUMN_TITLES[s]}`, '');
    const column = tasks
      .filter((t) => t.status === s)
      .sort((a, b) => (a.updated || '').localeCompare(b.updated || '') || a.title.localeCompare(b.title));
    for (const t of column) {
      const link = t.path.replace(/\.md$/, '');
      out.push(`- [ ] [[${link}|${t.title}]]`);
    }
    if (s === 'done') out.push('**Complete**');
    out.push('');
  }
  out.push(
    '',
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board","list-collapse":[false,false,false,false,false,false,false],"show-checkboxes":false}',
    '```',
    '%%',
    '',
  );
  const text = out.join('\n');
  // Skip identical rewrites — every write churns an mtime that Syncthing then ships.
  const current = await fsp.readFile(boardPath, 'utf8').catch(() => null);
  if (current !== text) await atomicWrite(boardPath, text);
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// ---------- Same-box read path (added 2026-09-20) ----------
// Lets tooling on the same host (a headless-Chrome screenshot pipeline) read the
// board without a login. Off unless LOCAL_READ=1: on Docker Desktop the client's
// real address is not kept, so the gateway rule below could let any machine on
// the network read the board. Only a host that has checked who its peers are
// should turn it on.
//
// THE DECISION IS MADE FROM THE SOCKET, NEVER FROM A HEADER. `req.ip` is off
// limits: with TRUST_PROXY on it returns whatever X-Forwarded-For says, and the
// client writes that header. Only req.socket.remoteAddress is used, the kernel's
// view of the peer.
//
// Behind a published Docker port a connection from the host's loopback is
// re-originated by docker-proxy and arrives from the bridge GATEWAY (measured on
// Linux: host 127.0.0.1 -> ::ffff:172.18.0.1), so a literal 127.0.0.1 test would
// never fire. 127.0.0.1/::1 stay in the set for runs outside Docker. The gateway
// is trusted, not the whole bridge range, so a sibling container does not get
// this path; only docker-proxy originates from the gateway.
//
// FOOTGUN: the rule means "arrived via this host's loopback". A reverse proxy or
// tunnel run ON this machine pointing at 127.0.0.1 inherits the trust and would
// publish the read path. Keep any tunnel off-box, or leave LOCAL_READ off.
function defaultGateway() {
  // /proc/net/route: the default route is the row with Destination 00000000;
  // Gateway is little-endian hex. Read once at startup, so recreating the
  // Docker network (and moving off 172.18.x) needs a restart, not an edit.
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 2 && f[1] === '00000000' && f[2] !== '00000000') {
        const h = f[2];
        return [6, 4, 2, 0].map((i) => parseInt(h.substr(i, 2), 16)).join('.');
      }
    }
  } catch (err) { /* not Linux, or no default route: fall through to loopback only */ }
  return null;
}
const LOCAL_READ = process.env.LOCAL_READ === '1';
const LOCAL_PEERS = new Set(['127.0.0.1', '::1']);
const GW = defaultGateway();
if (GW) LOCAL_PEERS.add(GW);
if (LOCAL_READ) console.log(`same-box read path trusts: ${[...LOCAL_PEERS].join(', ')}`);

function isLocalPeer(req) {
  if (!LOCAL_READ) return false;
  // req.socket.remoteAddress -- the real peer of the TCP connection.
  // NOT req.ip, NOT req.headers['x-forwarded-for'].
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  return LOCAL_PEERS.has(addr.replace(/^::ffff:/, ''));
}

// Reads only. A write still needs the login even from this box, so a bug in the
// screenshot tooling can never rewrite a task.md.
function isLocalRead(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && isLocalPeer(req);
}

// DNS-rebinding guard: with VaultOS on localhost a hostile page can point its own
// name at 127.0.0.1, and the browser then sends that name in Host. Anything not in
// ALLOWED_HOSTS is refused, first of all, before the session or any route. The raw
// header is used, never req.hostname (which follows X-Forwarded-Host under TRUST_PROXY).
// /health is exempt so a container healthcheck (Host: whatever the probe uses) works.
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS || undefined);
const hostLogged = new Set();
function logRejectedHost(host) {
  // Once per distinct host, capped so a flood of made-up names cannot grow memory.
  if (hostLogged.size >= 100 || hostLogged.has(host)) return;
  hostLogged.add(host);
  console.log(`host rejected: ${host}`);
}
app.use((req, res, next) => {
  // /api/term/agent is already limited to loopback callers holding a per-terminal token.
  if (req.path === '/health' || req.path.startsWith('/mcp/') || (req.method === 'POST' && (req.path === '/api/term/agent' || req.path === '/api/term/search')) || hostAllowed(req.headers.host, ALLOWED_HOSTS)) return next();
  const host = safeHost(req.headers.host);
  logRejectedHost(host);
  res.status(421).type('text/plain').send(
    `This address isn't in ALLOWED_HOSTS. Open VaultOS at http://localhost:<port you published>, or add "${host}" to ALLOWED_HOSTS.`);
});

// Liveness for Docker/monitoring. Registered before cookieSession and the /api
// gate so it needs no session. Once set up, 200 only if the vault has at least one
// non-dot entry: a failed bind mount can leave /vault as an empty dir, and Syncthing
// recreates .stfolder in an empty folder, so dotfiles alone don't count. While setup
// is due an empty folder is expected, so a readable one is enough; a settings file
// that failed to load is reported in `error` without failing the check. That error
// is a fixed string: this route is public, and SETTINGS_ERROR can quote the file's
// text, folder names or an absolute path. The detail is in the server log.
function vaultHasEntries(dir) {
  try {
    return fs.readdirSync(dir).filter(n => !n.startsWith('.')).length > 0;
  } catch (e) {
    return false;
  }
}
function vaultReadable(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return fs.statSync(dir).isDirectory();
  } catch (e) {
    return false;
  }
}
app.get('/health', (req, res) => {
  if (stage() === 'done') {
    const ok = vaultHasEntries(VAULT_DIR);
    return res.status(ok ? 200 : 503).json({ ok, setup: false });
  }
  const ok = vaultReadable(VAULT_DIR);
  const body = { ok, setup: true };
  if (SETTINGS_ERROR) body.error = `${SETTINGS_REL} could not be loaded`;
  res.status(ok ? 200 : 503).json(body);
});
// The connector relay: agents in this container call it with the relay key. It needs a loopback peer and the
// key (not the Host allowlist or a session), and it reads the raw body itself, so it sits before the JSON parser.
const CONNECTOR_AGENTS = ['claude', 'cursor', 'pi'];
const connectors = createConnectorService({
  home: process.env.HOME || os.homedir(),
  port: PORT,
  run: runCapture,
  spawn,
  installedAgents: async () => {
    const ok = await Promise.all(CONNECTOR_AGENTS.map((id) => isInstalled(PROFILES[id]).catch(() => false)));
    return CONNECTOR_AGENTS.filter((id, i) => ok[i]);
  },
});
const relayHandler = createRelay({
  getKey: () => connectors.relayKey(),
  target: (id) => connectors.relayTarget(id),
  fetch: (...a) => fetch(...a),
  log: (m) => console.log(m),
});
app.all('/mcp/:id', relayHandler);
app.use(express.json({ limit: '2mb' }));
// body-parser's own errors (too big, not JSON, an unsupported charset or Content-Encoding, an aborted upload)
// would otherwise reach Express's default handler: an HTML page with a stack trace and /app/node_modules paths,
// shown to anyone, since this runs ahead of the login gate. Every one of them (they carry `type`, or `expose`
// with a 4xx status) is answered as JSON with its own status; nothing else ever reaches this handler, because
// it sits right after the body parser. Only a sheet save can be too large in a way the person can fix.
app.use((err, req, res, next) => {
  if (!err || !(err.type || (err.expose && err.status >= 400 && err.status < 500))) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 400;
  if (status !== 413) return res.status(status).json({ error: 'Bad request' });
  const sheet = req.path.startsWith('/api/fs/sheet/');
  res.status(413).json({ error: sheet ? 'Too many changes for one save — save in smaller steps' : 'That request is too large' });
});
// Kept as a named middleware so the terminal's websocket upgrade (which never
// passes through Express) can read the same session. Configured once: before
// setup there is no config yet, and setup saves PENDING_SECRET as the secret.
// cookie-session reads SESSION_KEYS on every request, so a password change swaps
// its one key in place and every cookie signed with the old key stops working.
const SESSION_KEYS = [config ? config.sessionSecret : PENDING_SECRET];
const sessionMw = cookieSession({
  name: 'board_sess',
  keys: SESSION_KEYS,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  sameSite: 'lax',
  secure: SECURE_COOKIE,
});
app.use(sessionMw);

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  // No password yet: nothing to check, and DATA_DIR may not exist to hold a lockout.
  if (!config) return res.status(409).json({ error: 'Set a password first', setup: true });
  const lock = readLockout(DATA_DIR);
  const now = Date.now();
  if (lock.lockedUntil > now) {
    const secs = Math.ceil((lock.lockedUntil - now) / 1000);
    return res.status(429).json({ error: `Locked. Try again in ${secs}s.`, lockedFor: secs });
  }
  const { password } = req.body || {};
  if (typeof password === 'string' && verifyPassword(config, password)) {
    writeLockout(DATA_DIR, { attempts: 0, lockedUntil: 0, lockLevel: 0 });
    req.session.authed = true;
    return res.json({ ok: true });
  }
  lock.attempts = (lock.attempts || 0) + 1;
  let msg;
  if (lock.attempts >= MAX_ATTEMPTS) {
    const step = Math.min(lock.lockLevel, LOCK_STEPS_MS.length - 1);
    const dur = LOCK_STEPS_MS[step];
    lock.lockedUntil = now + dur;
    lock.lockLevel = (lock.lockLevel || 0) + 1;
    lock.attempts = 0;
    msg = `Too many attempts. Locked for ${Math.round(dur / 1000)}s.`;
  } else {
    msg = `Wrong password. ${MAX_ATTEMPTS - lock.attempts} attempt(s) left.`;
  }
  writeLockout(DATA_DIR, lock);
  return res.status(401).json({ error: msg });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
// Reports a same-box reader as authed so the SPA renders the board instead of
// the login overlay (app.js gates on this). `localRead` marks why: the session
// is absent, the peer address is what let it through, and writes will still 401.
// Signed in, it also carries what the UI shows: the features that are on and the
// agent's Start command. Signed out, `setup` tells the page to go to setup instead.
app.get('/api/me', (req, res) => {
  const authed = !!(req.session && req.session.authed);
  const localRead = !authed && isLocalPeer(req);
  if (!authed && !localRead) return res.json({ authed: false, setup: stage() !== 'done' });
  const s = SETTINGS();
  const profile = profileFor(s);
  res.json({
    authed: true,
    ...(localRead ? { localRead: true } : {}),
    features: { today: !!(s && s.features.today), terminal: terminalOn(), morningRead: !!(s && s.features.morningRead) },
    agent: terminalOn() && profile ? { profile: profile.id, label: profile.label, startCommand: startCommand(profile, kickoffPrompt(profile)) } : null,
  });
});

// ---------- Setup ----------
// First-run setup: step 2 (password) and step 3 (boards) have routes here; step 4
// (agent) lives with the agent routes and step 5 is /finish. While setup is due the
// gate below holds the rest of the API at 409 and `/` serves the setup page. The
// unauthenticated part (the password) only works for SETUP_WINDOW_MIN minutes after
// boot; everything after it needs the session the password step signs in.
const STARTED_AT = Date.now();
const SETUP_WINDOW_MIN = (() => {
  const raw = process.env.SETUP_WINDOW_MIN;
  return /^\d+$/.test(raw || '') ? parseInt(raw, 10) : 15;
})();
const setupWindowOpen = () => windowOpen(STARTED_AT, Date.now(), SETUP_WINDOW_MIN);
const sessionAuthed = (req) => !!(req.session && req.session.authed);
const validTimeZone = (tz) => {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};
const SETUP_OPEN = new Set(['/login', '/logout', '/me', '/agent', '/agents', '/settings/agent']);
app.use('/api', (req, res, next) => {
  if (stage() === 'done' || req.path.startsWith('/setup/') || SETUP_OPEN.has(req.path)) return next();
  res.status(409).json({ error: 'Finish setup first', setup: true });
});
const setupPage = (req, res, next) => {
  if (stage() === 'done') return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT, 'public', 'setup.html'));
};
app.get(['/', '/index.html'], setupPage);
app.get('/setup', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT, 'public', 'setup.html'));
});

app.get('/api/setup/state', async (req, res) => {
  const st = stage();
  if (st === 'done') return res.json({ stage: 'done' });
  const authed = sessionAuthed(req);
  const open = setupWindowOpen();
  const body = {
    stage: st, steps: stepsFor(st, SETTINGS()), authed, windowOpen: open, terminalAllowed: TERMINAL_ENV,
  };
  // The folder check and the settings error can quote file content and folder names:
  // only someone inside the window or signed in sees them.
  if (open || authed) {
    body.settingsError = SETTINGS_ERROR;
    body.folder = await folderCheck(VAULT_DIR);
  }
  res.json(body);
});

app.post('/api/setup/password', (req, res) => {
  if (!setupWindowOpen()) {
    return res.status(403).json({ error: 'Setup window closed. Restart the container to finish setup.' });
  }
  // The check and the write run with no await between them (writePassword is
  // synchronous), so of two simultaneous posts exactly one gets through.
  // A config on disk counts too: set-password.js may have run since boot.
  if (config || readConfig(DATA_DIR)) return res.status(409).json({ error: 'A password is already set' });
  try {
    config = writePassword(DATA_DIR, (req.body || {}).password, { sessionSecret: PENDING_SECRET });
  } catch (err) {
    if (/at least \d+ characters/.test(err.message)) return res.status(400).json({ error: err.message });
    // Anything else (EACCES, ENOSPC…) can carry an absolute path, and the caller is unauthenticated.
    console.error('setup password failed:', err.message);
    return res.status(500).json({ error: 'Could not save the password' });
  }
  req.session.authed = true;
  res.json({ ok: true });
});

// Whether the vault root already has a folder or file of this name, ignoring case.
// Shared by setup and Settings so both refuse to write into something already there.
function folderExists(dir) {
  let taken = [];
  try { taken = fs.readdirSync(VAULT_DIR).map((n) => n.toLowerCase()); } catch { /* unreadable: the writes will say so */ }
  return taken.includes(String(dir).toLowerCase());
}

// Set before the first await and cleared in finally, so a double-click cannot race the writes.
let SETUP_BOARDS_BUSY = false;
app.post('/api/setup/boards', async (req, res) => {
  if (!sessionAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  const st = stage();
  if ((st !== 'boards' && st !== 'resume') || boards().length) {
    return res.status(409).json({ error: 'Boards are already set up' });
  }
  if (SETUP_BOARDS_BUSY) return res.status(409).json({ error: 'Setup is already saving your boards' });
  SETUP_BOARDS_BUSY = true;
  try {
    await setupBoards(req, res);
  } finally {
    SETUP_BOARDS_BUSY = false;
  }
});
async function setupBoards(req, res) {
  const { labels, timezone } = req.body || {};
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > 10) {
    return res.status(400).json({ error: 'Give 1 to 10 board names' });
  }
  // Every board is worked out before anything is written, so one bad name creates nothing.
  let settings = SETTINGS() || settingsDefaults();
  const added = [];
  try {
    for (const label of labels) {
      if (typeof label !== 'string') throw new Error('A board name must be text');
      const r = addBoard(settings, label);
      settings = r.settings;
      added.push(r.board);
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (validTimeZone(timezone)) settings = { ...settings, today: { ...settings.today, timezone } };
  // Setup never writes into a folder the person already has.
  const clash = added.find((b) => folderExists(b.dir));
  if (clash) {
    return res.status(400).json({
      error: `A folder called "${clash.dir}" already exists. Pick another name, or add it later from Settings → Boards → Add an existing folder.`,
    });
  }
  try {
    // The agent is not chosen until step 4, so the Cursor commands go in too; they are harmless otherwise.
    await writeRootKit(VAULT_DIR, added, { cursor: true });
    const today = zonedDate(new Date(), validTimeZone(timezone) ? timezone : 'UTC');
    for (let i = 0; i < added.length; i++) await writeBoardKit(VAULT_DIR, added[i], { welcome: i === 0, today });
    const saved = await settingsStore.save({ ...settings, setupDone: false });
    // An AGENTS.md that was already there (with markers) gets the current list.
    await updateAgentsBlock(VAULT_DIR, saved.boards);
    res.json({ settings: saved });
  } catch (err) {
    console.error('setup boards failed:', err.message);
    res.status(500).json({ error: 'Could not write the starter files' });
  }
}

app.post('/api/setup/finish', async (req, res) => {
  if (!sessionAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  const s = SETTINGS();
  // After setup, Today and the timezone are changed from Settings, which manages the Today service.
  if (stage() !== 'resume') return res.status(409).json({ error: 'Setup is already finished' });
  if (!s || !s.boards.length) return res.status(409).json({ error: 'Add a board first' });
  const { today, timezone } = req.body || {};
  const next = {
    ...s,
    setupDone: true,
    features: { ...s.features, today: !!today },
    today: { ...s.today, timezone: validTimeZone(timezone) ? timezone : s.today.timezone },
  };
  try {
    await settingsStore.save(next);
  } catch (err) {
    console.error('setup finish failed:', err.message);
    return res.status(500).json({ error: 'Could not save the settings' });
  }
  const svc = todayService();
  if (svc) svc.boot().catch((err) => console.error('Today boot failed:', err.message));
  res.json({ ok: true });
});

// Claude Code hooks inside a Workbench terminal report the agent's state here
// (see termAgentHook). Ahead of the gate on purpose: the hook has no cookie,
// its auth is the per-terminal token plus a loopback peer.
if (TERMINAL_ENV) app.post('/api/term/agent', termAgentHook);
// `vault-search` and the recall hook, run by agents in a VaultOS terminal, use the
// server's warm index instead of walking the vault themselves. Same token as above.
if (TERMINAL_ENV) app.post('/api/term/search', async (req, res) => {
  if (!termCaller(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body;
  try {
    const results = await searchIndex.search(String(b.q || ''), {
      kind: b.kind || undefined, board: typeof b.board === 'string' ? b.board : undefined,
      limit: Math.min(50, Math.max(1, Number(b.limit) || 10)), minCoverage: Number(b.minCoverage) || 0,
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// The connector callback is a browser navigation (Atlassian sends the person back to it): with no session it gets a page.
const cxEsc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cxPage = (text, script = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VaultOS</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${cxEsc(text)}</p>${script}</body></html>`;
const cxSignInPage = (res) => res.status(401).set('Cache-Control', 'no-store').type('html')
  .send(cxPage('Sign in to VaultOS in this browser, then start again from Settings → Connectors.'));
// Gate everything below.
app.use('/api', (req, res, next) => {
  if (req.session && req.session.authed) return next();
  if (isLocalRead(req)) return next();
  if (req.method === 'GET' && req.path === '/connectors/atlassian/callback') return cxSignInPage(res);
  res.status(401).json({ error: 'Not authenticated' });
});

// ---------- Today ----------
// Thin wrappers: the logic lives in lib/today-service.js. Only a logged-in session
// may write; the same-host read path (isLocalRead) gets a read-only payload.
// With Today off there is no service, and every route answers 404.
const todayCanWrite = (req) => !!(req.session && req.session.authed);
const todayFail = (res, err) => res.status(err.status || 400).json({ error: String(err.message || err) });
function today() {
  const svc = todayService();
  if (!svc) throw Object.assign(new Error('Today is off'), { status: 404 });
  return svc;
}

app.get('/api/today', async (req, res) => {
  try {
    const date = req.query.date;
    if (date !== undefined && typeof date !== 'string') return res.status(400).json({ error: 'Invalid date' });
    res.json(await today().payload(date, { canWrite: todayCanWrite(req) }));
  } catch (err) {
    todayFail(res, err);
  }
});

app.post('/api/today/habit', async (req, res) => {
  try {
    const { date, id, done } = req.body || {};
    if (typeof date !== 'string' || typeof id !== 'string' || typeof done !== 'boolean') {
      return res.status(400).json({ error: 'date, id and done are required' });
    }
    res.json(await today().setHabit(date, id, done));
  } catch (err) {
    todayFail(res, err);
  }
});

// Add, edit or remove a habit (a row of habits.md). Answers with the payload for `date`, the day on screen.
app.post('/api/today/habits', async (req, res) => {
  try {
    const { date, op, id, name, icon, goal } = req.body || {};
    if (typeof date !== 'string' || typeof op !== 'string') return res.status(400).json({ error: 'date and op are required' });
    res.json(await today().editHabits(date, { op, id, name, icon, goal }));
  } catch (err) {
    todayFail(res, err);
  }
});

app.post('/api/today/task', async (req, res) => {
  try {
    const { date, op, index, text } = req.body || {};
    if (typeof date !== 'string' || !['add', 'toggle', 'delete'].includes(op)
      || (index !== undefined && !Number.isInteger(index)) || (text !== undefined && typeof text !== 'string')) {
      return res.status(400).json({ error: 'date, op and valid index/text are required' });
    }
    res.json(await today().task(date, { op, index, text }));
  } catch (err) {
    todayFail(res, err);
  }
});

app.post('/api/today/timer', async (req, res) => {
  try {
    const { action, target } = req.body || {};
    if (!['start', 'pause', 'resume', 'skip', 'reset'].includes(action)) return todayFail(res, Object.assign(new Error('Unknown timer action'), { status: 400 }));
    if (target !== undefined && target !== null && typeof target !== 'string') return todayFail(res, Object.assign(new Error('target must be a string'), { status: 400 }));
    res.json(await today().timer(action, target));
  } catch (err) {
    todayFail(res, err);
  }
});

app.post('/api/today/quote', async (req, res) => {
  try {
    res.json(await today().shuffleQuote());
  } catch (err) {
    todayFail(res, err);
  }
});

// ---------- Settings ----------
// Changes after setup: boards, features and the password. Every route needs a real
// session (the same-host read path is not enough: the folder list names the vault's
// contents). Errors from lib/settings.js are written for the person and go back as
// 400; anything else is logged and answered generically.
const settingsGuard = (req, res, next) => {
  if (sessionAuthed(req)) return next();
  res.status(401).json({ error: 'Not authenticated' });
};
// Only SettingsError carries a message meant for the person; anything else is logged.
const settingsFail = (res, err, what) => {
  if (err instanceof SettingsError) return res.status(400).json({ error: err.message });
  console.error(`${what} failed:`, err && err.message);
  res.status(500).json({ error: `Could not ${what}` });
};
// Every settings write runs through this one queue, in arrival order, and re-reads
// SETTINGS() inside `fn`, so two quick changes cannot save over each other.
let SETTINGS_QUEUE = Promise.resolve();
function withSettingsLock(fn) {
  const run = SETTINGS_QUEUE.then(fn);
  SETTINGS_QUEUE = run.catch(() => {});
  return run;
}

// Top-level folders that could become a board: not hidden, not `_`-prefixed, not
// already a board, not Today's.
async function candidateFolders() {
  const s = SETTINGS();
  const used = new Set(s.boards.map((b) => b.dir.toLowerCase()));
  used.add(s.today.dir.toLowerCase());
  const entries = await fsp.readdir(VAULT_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && !used.has(e.name.toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

app.get('/api/settings', settingsGuard, async (req, res) => {
  try {
    res.json({ settings: SETTINGS(), terminalAllowed: TERMINAL_ENV, folders: await candidateFolders() });
  } catch (err) {
    settingsFail(res, err, 'read the settings');
  }
});

// Saves the new settings and refreshes the board list in AGENTS.md.
async function saveBoards(settings) {
  const saved = await settingsStore.save(settings);
  await updateAgentsBlock(VAULT_DIR, saved.boards);
  return { settings: saved };
}

app.post('/api/settings/boards', settingsGuard, async (req, res) => {
  try {
    const { label } = req.body || {};
    if (typeof label !== 'string') return res.status(400).json({ error: 'A board name must be text' });
    res.json(await withSettingsLock(async () => {
      const { settings, board } = addBoard(SETTINGS(), label);
      if (folderExists(board.dir)) {
        throw new SettingsError(`A folder called "${board.dir}" already exists. Use "Add an existing folder" instead.`);
      }
      await writeBoardKit(VAULT_DIR, board);
      return saveBoards(settings);
    }));
  } catch (err) {
    settingsFail(res, err, 'add the board');
  }
});

app.post('/api/settings/boards/existing', settingsGuard, async (req, res) => {
  try {
    const { dir } = req.body || {};
    if (typeof dir !== 'string') return res.status(400).json({ error: 'Pick a folder from the list' });
    res.json(await withSettingsLock(async () => {
      if (!(await candidateFolders()).includes(dir)) throw new SettingsError('Pick a folder from the list');
      const { settings, board } = addExistingBoard(SETTINGS(), dir, { todayDir: SETTINGS().today.dir });
      // Only adds what is missing; the folder's own files are left alone.
      await writeBoardKit(VAULT_DIR, board);
      return saveBoards(settings);
    }));
  } catch (err) {
    settingsFail(res, err, 'add the folder');
  }
});

app.patch('/api/settings/boards/:key', settingsGuard, async (req, res) => {
  try {
    const { label, hidden, index } = req.body || {};
    if ((label !== undefined && typeof label !== 'string') || (hidden !== undefined && typeof hidden !== 'boolean')
      || (index !== undefined && !Number.isFinite(index))) {
      return res.status(400).json({ error: 'label must be text, hidden true or false, index a number' });
    }
    res.json(await withSettingsLock(() => saveBoards(updateBoard(SETTINGS(), req.params.key, { label, hidden, index }))));
  } catch (err) {
    settingsFail(res, err, 'update the board');
  }
});

// Today on builds and boots the service, off stops and drops it, and a new timezone
// while it is on rebuilds it (the timer service reads the zone once, when built).
// The terminal flag is only stored here; the terminal itself reads it.
app.post('/api/settings/features', settingsGuard, (req, res) => withSettingsLock(() => setFeatures(req, res)));
async function setFeatures(req, res) {
  try {
    const { today: wantToday, terminal, morningRead, timezone } = req.body || {};
    if ([wantToday, terminal, morningRead].some((v) => v !== undefined && typeof v !== 'boolean')) {
      return res.status(400).json({ error: 'today, terminal and morningRead must be true or false' });
    }
    if (timezone !== undefined && !validTimeZone(timezone)) return res.status(400).json({ error: 'Unknown time zone' });
    // Read inside the queue slot, after any earlier change has saved.
    const s = SETTINGS();
    const next = {
      ...s,
      features: {
        ...s.features,
        ...(wantToday !== undefined ? { today: wantToday } : {}),
        ...(terminal !== undefined ? { terminal } : {}),
        ...(morningRead !== undefined ? { morningRead } : {}),
      },
      today: { ...s.today, ...(timezone !== undefined ? { timezone } : {}) },
    };
    const saved = await settingsStore.save(next);
    const rebuild = s.features.today !== saved.features.today || s.today.timezone !== saved.today.timezone;
    if (rebuild) {
      if (TODAY_SVC) {
        TODAY_SVC.stop();
        TODAY_SVC = null;
      }
      const svc = todayService();
      if (svc) await svc.boot();
    }
    res.json({ settings: saved });
  } catch (err) {
    settingsFail(res, err, 'save the settings');
  }
}

// ---------- Agent ----------
// What the settings sheet and the terminal's Start button need to know about the
// chosen agent. `installed` runs the profile's detect command on the box.
async function agentStatus() {
  const profile = profileFor(SETTINGS());
  if (!profile) return { profile: 'none', label: null, installed: null, startCommand: null, install: null, login: null, hooks: null };
  return {
    profile: profile.id, label: profile.label, installed: await isInstalled(profile),
    startCommand: startCommand(profile, kickoffPrompt(profile)),
    install: profile.install || null, login: profile.login || null, hooks: profile.hooks,
  };
}
// Claude Code reports its state through a hook in the container user's real
// ~/.claude; other agents use the process badge instead. Returns whether it changed anything.
// Whenever Claude Code is installed, whichever agent is the default, so a later switch needs no resave.
async function ensureClaudeHook() {
  if (!(await isInstalled(PROFILES.claude))) return false;
  return installClaudeHook(os.homedir(), path.join(ROOT, 'hooks', 'vaultos-state.js'), path.join(ROOT, 'hooks', 'vault-recall.js'));
}
// Every agent for the picker: the eight built-ins, then a saved custom agent, each with a live installed
// check (run side by side), and which one is the default.
async function agentsList() {
  const s = SETTINGS();
  const view = (p, tier) => ({
    id: p.id, label: p.label, maker: p.maker || null, tier, install: p.install || null, login: p.login || null,
    loginNote: p.loginNote || null, hooks: p.hooks || null,
  });
  const list = Object.values(PROFILES).map((p) => view(p, p.tier));
  const custom = s && s.agent && s.agent.custom ? profileFor({ agent: { profile: 'custom', custom: s.agent.custom } }) : null;
  if (custom) list.push(view(custom, 'other'));
  const all = [...Object.values(PROFILES), ...(custom ? [custom] : [])];
  const installed = await Promise.all(all.map((p) => isInstalled(p)));
  return { default: (s && s.agent && s.agent.profile) || 'none', agents: list.map((a, i) => ({ ...a, installed: installed[i] })) };
}
app.get('/api/agents', settingsGuard, async (req, res) => {
  try {
    try { await ensureClaudeHook(); } catch (err) { console.error('claude hook install failed:', err && err.message); }
    // A newly installed agent gets the connectors' entries; the answer does not wait for it.
    connectors.sync().catch((err) => console.error('connectors sync failed:', err && err.message));
    res.json(await agentsList());
  } catch (err) {
    settingsFail(res, err, 'read the agents');
  }
});
// ---------- Connectors ----------
// Thin routes over lib/connector-service.js, which holds every rule. Only a ConnectorError carries text
// written for the person (400); anything else is logged and answered generically. Nothing here puts a token,
// the relay key or a client id into a response or a log line.
const connectorFail = (res, err, what) => {
  if (err instanceof ConnectorError) return res.status(400).json({ error: err.message });
  console.error(`${what} failed:`, err && err.message);
  res.status(500).json({ error: `Could not ${what}` });
};
const connectorRoute = (what, fn) => async (req, res) => {
  try { res.json((await fn(req, res)) || {}); } catch (err) { connectorFail(res, err, what); }
};
const cxNonce = (req) => {
  if (!req.session.cxNonce) req.session.cxNonce = crypto.randomBytes(16).toString('hex');
  return req.session.cxNonce;
};
app.get('/api/connectors', settingsGuard, connectorRoute('read the connectors', async () => ({
  ...(await connectors.view()), attention: connectors.needsAttention(),
})));
app.post('/api/connectors/:id/test', settingsGuard, connectorRoute('test the connector', (req) => connectors.test(req.params.id)));
app.post('/api/connectors/:id/disconnect', settingsGuard, connectorRoute('disconnect the connector', (req) => connectors.disconnect(req.params.id)));
app.post('/api/connectors/atlassian/start', settingsGuard, connectorRoute('start the Atlassian sign-in', (req) =>
  connectors.atlassianStart({ origin: `${req.protocol}://${req.get('host')}`, nonce: cxNonce(req) })));
app.post('/api/connectors/atlassian/cancel', settingsGuard, connectorRoute('cancel the Atlassian sign-in', (req) =>
  connectors.atlassianCancel({ nonce: cxNonce(req) })));
// The page Atlassian sends the person back to. The server sets no Content-Security-Policy on HTML, so the one
// inline line (tell the Settings tab over a same-origin BroadcastChannel; it also polls) needs no nonce. Nothing on the page names a token.
app.get('/api/connectors/atlassian/callback', (req, res, next) => (sessionAuthed(req) ? next() : cxSignInPage(res)), async (req, res) => {
  let text = 'Atlassian is connected, you can close this tab.';
  let ok = true;
  try {
    await connectors.atlassianCallback({
      code: String(req.query.code || ''), state: String(req.query.state || ''), nonce: req.session.cxNonce || '',
    });
  } catch (err) {
    ok = false;
    if (err instanceof ConnectorError) text = err.message;
    else { console.error('Atlassian callback failed:', err && err.message); text = 'Something went wrong. Start again from VaultOS.'; }
  }
  res.set('Cache-Control', 'no-store').type('html').send(cxPage(text,
    ok ? `<script>try{var c=new BroadcastChannel('vaultos-connectors');c.postMessage('done');c.close()}catch(e){}</script>` : ''));
});
app.post('/api/connectors/:id/token', settingsGuard, connectorRoute('save the sign-in', (req) =>
  connectors.saveToken(req.params.id, req.body || {})));
app.post('/api/connectors/:id/enable', settingsGuard, connectorRoute('turn the connector on', (req) =>
  connectors.enable(req.params.id)));
app.post('/api/connectors/azure/start', settingsGuard, async (req, res) => {
  try { res.json(await connectors.azureStart()); } catch (err) {
    // az's own message (why the sign-in could not start) is for the person to read.
    console.error('azure sign-in failed to start:', err && err.message);
    res.status(400).json({ error: String((err && err.message) || 'The Azure sign-in could not start.') });
  }
});
app.get('/api/connectors/azure/status', settingsGuard, connectorRoute('read the Azure sign-in', () => connectors.azureStatus()));
app.post('/api/connectors/azure/cancel', settingsGuard, connectorRoute('cancel the Azure sign-in', () => connectors.azureCancel()));
app.post('/api/connectors/azure/settings', settingsGuard, connectorRoute('save the Azure settings', (req) => {
  const { allowChanges, subscription } = req.body || {};
  return connectors.azureSettings({ allowChanges, subscription });
}));

app.get('/api/agent', settingsGuard, async (req, res) => {
  try {
    res.json(await agentStatus());
  } catch (err) {
    settingsFail(res, err, 'read the agent');
  }
});
app.post('/api/settings/agent', settingsGuard, async (req, res) => {
  try {
    const { profile, custom } = req.body || {};
    res.json(await withSettingsLock(async () => {
      const s = SETTINGS();
      if (!s) throw new SettingsError('Finish setup first');
      if (typeof profile !== 'string') throw new SettingsError('profile is required');
      // validate() is the one rule set; it throws a SettingsError for a bad profile or custom agent.
      // A body without `custom` keeps the saved one: switching the default doesn't forget an Other agent.
      const keep = custom !== undefined ? custom : s.agent && s.agent.custom;
      await settingsStore.save({ ...s, agent: { profile, ...(keep !== undefined ? { custom: keep } : {}) } });
      // The agent is saved by now; a hook failure is reported, not fatal.
      let hookError;
      try { await ensureClaudeHook(); } catch (err) {
        console.error('claude hook install failed:', err && err.message);
        hookError = 'Could not install the Claude status hook';
      }
      return { ...(await agentStatus()), ...(hookError ? { hookError } : {}) };
    }));
  } catch (err) {
    settingsFail(res, err, 'save the agent');
  }
});

// A wrong current password is a 401 that does not count toward the login lockout:
// the person is already signed in.
// A new password signs out every other browser: the session secret is replaced, and
// every open terminal socket (let in by an old cookie) is closed. This browser gets a
// cookie under the new secret, so it stays in and its terminals reconnect at once; the
// shells keep running either way.
app.post('/api/settings/password', settingsGuard, (req, res) => {
  const { current, next } = req.body || {};
  if (typeof current !== 'string' || !config || !verifyPassword(config, current)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  try {
    config = writePassword(DATA_DIR, next);
  } catch (err) {
    console.error('change password failed:', err.message);
    return res.status(500).json({ error: 'Could not save the password' });
  }
  SESSION_KEYS[0] = config.sessionSecret;
  req.session = { authed: true };
  res.json({ ok: true, signedOut: true });
  for (const t of TERMS.values()) if (t.ws) try { t.ws.close(); } catch { /* already gone */ }
});

// ---------- Workspaces ----------
// The switcher's boards: the visible ones, in settings order (the first is the
// default). Hiding and reordering happen in Settings → Boards.
app.get('/api/workspaces', (req, res) => {
  const s = SETTINGS();
  res.json(s ? visibleBoards(s).map(({ key, label }) => ({ key, label })) : []);
});

// ---------- Read API ----------
app.get('/api/tasks', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const tasks = await scanAll(ws.dir);
    const projects = [];
    const seen = new Map();
    for (const t of tasks) {
      if (!seen.has(t.project)) { seen.set(t.project, { name: t.project, count: 0 }); }
      seen.get(t.project).count++;
    }
    for (const p of seen.values()) projects.push(p);
    projects.sort((a, b) => a.name.localeCompare(b.name));
    // Every scan already has the fresh task list, so catch Board.md up with any
    // task.md created outside the app (agent mid-session, /new-task, Obsidian).
    // The Refresh button therefore doubles as the Board.md rebuild.
    regenerateBoard(tasks, ws.dir).catch(() => {});
    // Strip bodies from the list payload — the detail endpoint serves those.
    res.json({ statuses: STATUSES, projects, tasks: tasks.map(({ body, ...rest }) => rest) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Everything the drawer needs beyond the raw task: rendered body (minus the agent banner),
// and the batch's two directions. Both endpoints that paint the drawer go through here —
// /api/task on open/refresh, and the comment POST which repaints in place. They drifted
// once already: the comment response left out subtasks/parent, so posting a comment on a
// subtask blanked its back-link until the next refresh.
//
// The batch lookups come off a fresh scan rather than the client's board list: the drawer
// is also reachable from a Knowledge Base job link where the board may never have loaded,
// and a batch gains members by a file appearing on disk with no board refresh in between.
// A workspace is ~95 task.md files, so the scan is cheap.
async function decorateForDrawer(task, ws) {
  task.html = renderBody(stripAgentBanner(task.body), task.path, ws.key);
  const all = await scanAll(ws.dir);
  task.batchKey = batchKeyOf(task);
  task.subtasks = childrenOfBatch(all, task.batchKey, task.path);
  task.parent = parentOfBatch(all, task.batch, task.path);
  return task;
}

app.get('/api/task', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const full = safeTaskPath(req.query.path, ws.dir);
    const task = await loadTask(full);
    await decorateForDrawer(task, ws);
    task.docs = await siblingDocs(full);
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ---------- Knowledge Base API ----------
// Reading history (lib/kb-reads.js): .vaultos/kb-reads.json, one file for every browser.
// Dates in it are judged in the Today time zone, the one zone VaultOS has.
const READS = createReadStore(VAULT_DIR);
const kbZone = () => SETTINGS().today.timezone;
function withReads(articles, wsKey) {
  const entries = READS.get().articles[wsKey] || {};
  const tz = kbZone();
  return articles.map((a) => {
    const entry = entries[articleKey(a.path)];
    return { ...a, lastRead: readAt(entry), readState: readState(a, entry, tz) };
  });
}

// The checks every route that takes an article path makes: inside this workspace,
// named article.md, where it really leads still inside, and a live article.
async function articleFrom(wsKey, relPath) {
  const ws = resolveWorkspace(wsKey);
  const clean = path.normalize(String(relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(VAULT_DIR, clean);
  if (!full.startsWith(ws.dir + path.sep) || path.basename(full) !== 'article.md') {
    throw new Error('Not an article file');
  }
  realInWorkspace(full, ws.dir);
  const articles = await scanKB(ws.dir);
  const article = articles.find((a) => a.path === relOf(full));
  if (!article) throw new Error('Article not found');
  return { ws, article, articles };
}

// List: collections + article metas (bodies stripped). Optional ?q= full-text filter.
// Articles matching q, best first. The box searches as you type, so the last word
// matches as a prefix; when ranking finds nothing (a fragment from mid-word like
// "sdholder", or only stopwords) or the index fails, the old substring filter answers.
async function rankArticles(articles, q, wsDir) {
  const substring = () => articles.filter((a) =>
    [a.title, a.stack.join(' '), a.tickets, a.collectionName, a.body].join('\n').toLowerCase().includes(q));
  try {
    const hits = await searchIndex.search(q, { kind: 'article', under: relOf(wsDir) + '/', limit: articles.length || 1, prefix: true });
    const byPath = new Map(articles.map((a) => [a.path, a]));
    const ranked = hits.map((h) => byPath.get(h.path)).filter(Boolean);
    return ranked.length ? ranked : substring();
  } catch (err) {
    console.error('kb search failed, using substring match:', err);
    return substring();
  }
}

app.get('/api/kb', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const q = String(req.query.q || '').trim().toLowerCase();
    let articles = await scanKB(ws.dir);
    if (q) articles = await rankArticles(articles, q, ws.dir);
    const seen = new Map();
    for (const a of articles) {
      if (!seen.has(a.collection)) seen.set(a.collection, { key: a.collection, name: a.collectionName, count: 0 });
      seen.get(a.collection).count++;
    }
    const collections = [...seen.values()].sort((x, y) => x.key.localeCompare(y.key));
    res.json({ collections, articles: withReads(articles.map(({ body, ...rest }) => rest), ws.key) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// One article: rendered HTML, table of contents, and related (outgoing + backlinks).
app.get('/api/kb/article', async (req, res) => {
  try {
    const { ws, article, articles } = await articleFrom(req.query.ws, req.query.path);
    const rel = article.path;

    const resolve = buildResolver(articles);
    const md = renderWikilinks(article.body, resolve);
    const { html, toc } = headingsAndToc(renderBody(md, article.path, ws.key));

    // Related = articles this one links to + articles that link back to it.
    const outSet = new Set(outgoingTargets(article.body).map(resolve).filter(Boolean));
    const relatedMap = new Map();
    for (const other of articles) {
      if (other.path === rel) continue;
      const linksHere = outgoingTargets(other.body).map(resolve).includes(rel);
      if (outSet.has(other.path) || linksHere) {
        relatedMap.set(other.path, { path: other.path, title: other.title, collectionName: other.collectionName });
      }
    }
    const { body, ...meta } = article;
    const [withRead] = withReads([meta], ws.key);
    res.json({ ...withRead, html, toc, related: [...relatedMap.values()] });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// A read, sent by the reader once an article has really been read (see app.js's read
// tracker). Signed-in only: the same-box read path never writes.
app.post('/api/kb/read', async (req, res) => {
  if (!sessionAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  let found;
  try { found = await articleFrom(req.query.ws, (req.body || {}).path); }
  catch (err) { return res.status(400).json({ error: String(err.message || err) }); }
  try {
    const { ws, article } = found;
    const key = articleKey(article.path);
    const now = Date.now();
    await READS.update((s) => {
      const mine = s.articles[ws.key] || (s.articles[ws.key] = {});
      mine[key] = { ...mine[key], read: now };
      return s;
    });
    const [a] = withReads([article], ws.key);
    res.json({ lastRead: a.lastRead, readState: a.readState });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// One browser's history from before reads lived here ({ path: ms } from localStorage).
// Each browser sends it once, then drops its copy.
app.post('/api/kb/reads/import', async (req, res) => {
  if (!sessionAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  const { reads } = req.body || {};
  if (!reads || typeof reads !== 'object' || Array.isArray(reads)) return res.status(400).json({ error: 'reads must be an object of path → time' });
  try {
    let imported = 0;
    await READS.update((s) => {
      const out = mergeImport(s, boards(), reads, Date.now());
      imported = out.imported;
      return out.state;
    });
    res.json({ imported });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// ---------- The morning read ----------
// Once a day, between 05:00 and noon in the Today zone, one article to pick back up.
// The first ask of the day picks from the workspace it names (lib/kb-reads.js has the
// order) and stores the pick, so every device shows the same card until one of them
// answers it. The pick is stored by folder key, so a job moved after it still resolves.
// The same-box read path sees the card but stores nothing.
function morningCard(article, ws, reason) {
  const [a] = withReads([article], ws.key);
  return {
    ws: ws.key, wsLabel: ws.label, path: a.path, title: a.title, excerpt: a.excerpt,
    collectionName: a.collectionName, minutes: a.minutes, lastRead: a.lastRead, reason,
  };
}
const endMorning = (today) => READS.update((s) => {
  if (s.morning && s.morning.date === today) s.morning.done = true;
  return s;
});
// Today's stored pick as a card, or null once it's answered, gone, or read since.
async function storedMorning(m, today, canWrite) {
  if (m.done) return null;
  const ws = boards().some((b) => b.key === m.ws) ? resolveWorkspace(m.ws) : null;
  const article = ws && (await scanKB(ws.dir)).find((a) => articleKey(a.path) === m.key);
  const entry = ws && (READS.get().articles[ws.key] || {})[m.key];
  if (!article || (entry && entry.read > m.at)) {
    if (canWrite) await endMorning(today);
    return null;
  }
  return morningCard(article, ws, m.reason);
}

app.get('/api/kb/morning', async (req, res) => {
  try {
    const now = Date.now();
    const tz = kbZone();
    // A damaged history can't remember the day's answer, so no card until it's fixed.
    if (!SETTINGS().features.morningRead || !inMorning(now, tz) || READS.damaged()) return res.json({ card: null });
    const today = zonedDate(new Date(now), tz);
    const canWrite = sessionAuthed(req);
    const m = READS.get().morning;
    if (m && m.date === today) return res.json({ card: await storedMorning(m, today, canWrite) });

    const ws = resolveWorkspace(req.query.ws);
    const pick = morningPick(await scanKB(ws.dir), READS.get().articles[ws.key] || {}, now, tz);
    if (!pick) return res.json({ card: null });
    if (!canWrite) return res.json({ card: morningCard(pick.article, ws, pick.reason) });
    const mine = { date: today, ws: ws.key, key: articleKey(pick.article.path), at: now, reason: pick.reason, done: false };
    const saved = await READS.update((s) => {
      if (!(s.morning && s.morning.date === today)) s.morning = mine;   // another device may have picked first
      return s;
    });
    const won = saved.morning.ws === mine.ws && saved.morning.key === mine.key;
    res.json({ card: won ? morningCard(pick.article, ws, pick.reason) : await storedMorning(saved.morning, today, canWrite) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// open (Read now), later (Not today) or skip (Skip this one): each ends the day's card on
// every device. It answers today's pick whatever the hour, so a card shown at 11:59 still
// takes a click at 12:01. Read now doesn't count as a read; the reader decides that.
app.post('/api/kb/morning', async (req, res) => {
  if (!sessionAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  const { action } = req.body || {};
  if (!['open', 'later', 'skip'].includes(action)) return res.status(400).json({ error: 'action must be open, later or skip' });
  try {
    const now = Date.now();
    const today = zonedDate(new Date(now), kbZone());
    const m = READS.get().morning;
    if (!m || m.date !== today || m.done) return res.status(409).json({ error: 'Already answered' });
    await READS.update((s) => {
      s.morning.done = true;
      if (action === 'skip') {
        const mine = s.articles[m.ws] || (s.articles[m.ws] = {});
        mine[m.key] = { ...mine[m.key], skipUntil: now + SKIP_DAYS * 86400000 };
      }
      return s;
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// One sibling .md file from a job folder — guides, notes, anything dropped
// beside task.md — rendered the same way as a task or KB article body.
app.get('/api/task/doc', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const full = await safeJobDocPath(req.query.path, ws.dir);
    const [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
    const { meta, body } = parseFrontmatter(raw);
    const rel = relOf(full);
    res.json({
      path: rel,
      title: meta.title || path.basename(full, '.md'),
      html: renderBody(body, rel, ws.key),
      mtime: stat.mtimeMs,
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// One diagram: the namespaced inline SVG plus the metadata the viewer chrome needs.
app.get('/api/diagram', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const full = safeDiagramPath(req.query.path, ws.dir);
    res.json(await loadDiagram(full));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// One screenshot: raw image bytes, gated by the same screenshots/-folder
// allowlist as the diagram endpoint's diagrams/ check.
app.get('/api/screenshot', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const { full, contentType } = safeScreenshotPath(req.query.path, ws.dir);
    await fsp.access(full);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=300');
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ========================================================================
// PDF export
// ========================================================================
// "Export PDF" in the KB reader used to be window.print() over a print
// stylesheet, which can't do a cover, running headers or "Page X of Y", and
// came out looking like a printed web page. It's now rendered here: the
// article is laid out as a standalone document (cover page, one H2 section
// per page) and printed by the headless Chromium baked into the image, whose
// CSS paged-media support draws the running header/footer and page numbers.
//
// The PDF is for handing to people outside the vault, so anything that only
// makes sense inside it is left out: the Related panel, "References &
// related" sections, and wikilinks (which become their plain label).
//
// The stylesheet is public/pdf.css, read on every export, so the look can be
// tuned without a restart. Chromium, Inter and JetBrains Mono come from the
// Dockerfile; this is the one feature that needs the image, not just the
// bind mounts.

const CHROMIUM = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const PDF_CSS = path.join(ROOT, 'public', 'pdf.css');
const PDF_DROP_SECTION = /^(references?|related|see also)\b/i;
const PDF_TIMEOUT_MS = 60000;

// One render at a time — each is a full Chromium, and nobody exports two
// articles in the same second on purpose.
let pdfQueue = Promise.resolve();

// A CSS string literal, for values injected into @page margin boxes.
const cssString = (s) => `"${String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;

function longDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

// Diagram placeholders (from linkDiagrams) → the real inline SVG. The reader
// hydrates these client-side; a PDF has no client, so it happens here.
async function inlineDiagrams(html, wsDir) {
  const re = /<figure class="diagram" data-diagram="([^"]+)">[\s\S]*?<\/figure>/g;
  const jobs = [];
  html.replace(re, (m, rel) => { jobs.push({ m, rel }); return m; });
  let n = 0;
  for (const { m, rel } of jobs) {
    const cap = (m.match(/<figcaption>([\s\S]*?)<\/figcaption>/) || [])[1] || '';
    let inner;
    try {
      const d = await loadDiagram(safeDiagramPath(decodeEntities(rel), wsDir));
      inner = d.svg;
    } catch {
      inner = '<div class="diagram-missing">Diagram unavailable</div>';
    }
    n += 1;
    const label = `<span class="fig-num">Figure ${n}</span>${cap ? ` ${cap}` : ''}`;
    html = html.replace(m, `<figure class="diagram"><div class="diagram-art">${inner}</div><figcaption>${label}</figcaption></figure>`);
  }
  return { html, figures: n };
}

// Screenshot <img>s → data: URIs, so the PDF needs nothing from the server.
async function inlineScreenshots(html, docRel, wsDir, figStart) {
  const baseDir = path.dirname(docRel);
  const imgs = [];
  html.replace(/<img\s+([^>]*?)>/gi, (m, attrs) => { imgs.push({ m, attrs }); return m; });
  let n = figStart;
  for (const { m, attrs } of imgs) {
    const src = decodeURIComponent((attrs.match(/src="([^"]*)"/i) || [])[1] || '');
    if (/^[a-z]+:/i.test(src) || path.basename(path.dirname(src)) !== 'screenshots') continue;
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    let out;
    try {
      const { full, contentType } = safeScreenshotPath(path.normalize(path.join(baseDir, src)), wsDir);
      const data = await fsp.readFile(full);
      n += 1;
      const cap = `<figcaption><span class="fig-num">Figure ${n}</span>${alt ? ` ${alt}` : ''}</figcaption>`;
      out = `<figure class="screenshot"><img src="data:${contentType};base64,${data.toString('base64')}" alt="${alt}">${cap}</figure>`;
    } catch {
      out = '';
    }
    html = html.replace(m, out);
  }
  return html;
}

// Split rendered HTML at each <h2> into { title, html } sections; whatever
// precedes the first H2 is the intro.
function splitSections(html) {
  const parts = html.split(/(?=<h2[\s>])/);
  const intro = /^<h2[\s>]/.test(parts[0]) ? '' : parts.shift();
  const sections = parts.map((p) => {
    const m = p.match(/^<h2[^>]*>([\s\S]*?)<\/h2>/);
    return { title: m ? m[1] : '', text: m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : '', body: m ? p.slice(m[0].length) : p };
  });
  return { intro, sections };
}

async function buildArticlePdfHtml(article, ws) {
  const md = renderWikilinks(article.body, () => null);             // every [[link]] → its label
  let html = linkDiagrams(marked.parse(md), article.path);
  const dg = await inlineDiagrams(html, ws.dir);
  html = await inlineScreenshots(dg.html, article.path, ws.dir, dg.figures);
  // Any leftover in-app link (#kb/…, #…) means nothing on paper.
  html = html.replace(/<a\s+href="#[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  // Bullets that open with a bold term are glossary/stack entries.
  html = html.replace(/<li>(\s*(?:<p>)?\s*<strong>)/g, '<li class="term">$1');

  let { intro, sections } = splitSections(html);
  sections = sections.filter((s) => !PDF_DROP_SECTION.test(s.text) && s.body.replace(/<[^>]+>/g, '').trim());

  // The template opens every article with a "> **TL;DR** — …" blockquote;
  // lift it onto the cover as the summary panel.
  let tldr = '';
  intro = intro.replace(/<blockquote>([\s\S]*?)<\/blockquote>/, (m, inner) => {
    if (tldr || !/TL;?DR/i.test(inner)) return m;
    tldr = inner.replace(/<strong>\s*TL;?DR\s*<\/strong>\s*(?:[—–:-]\s*)?/i, '');
    return '';
  });

  const pad = (i) => String(i + 1).padStart(2, '0');
  const esc = escapeHtml;
  const meta = [
    article.updated && ['Updated', longDate(article.updated)],
    article.created && article.created !== article.updated && ['Created', longDate(article.created)],
    article.tickets && ['Reference', article.tickets],
  ].filter(Boolean);
  const shortTitle = article.title.length > 80 ? article.title.slice(0, 77).trimEnd() + '…' : article.title;

  const css = await fsp.readFile(PDF_CSS, 'utf8');
  const pageCss = `
    @page {
      @top-left { content: ${cssString(shortTitle)}; }
      @top-right { content: ${cssString(article.collectionName)}; }
      @bottom-left { content: ${cssString(article.updated ? `Updated ${longDate(article.updated)}` : '')}; }
    }`;

  // The CSP holds Chromium (which runs with --no-sandbox) to what this page is made of:
  // inline styles and data: images. Article markdown can carry raw HTML, and without
  // it a <script> would run and an <iframe src="file:///app/config.json"> would print
  // the server's own files into a PDF meant for people outside the vault.
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(article.title)}</title>
<style>${css}${pageCss}</style>
</head><body>
<section class="cover">
  <div class="band">
    <div class="eyebrow"><span>${esc(article.collectionName)}</span><span class="dot">·</span><span>Knowledge Base</span>${article.status !== 'published' ? `<span class="draft">${esc(article.status)}</span>` : ''}</div>
    <h1>${esc(article.title)}</h1>
    ${meta.length ? `<dl class="meta">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
  </div>
  <div class="cover-body">
    ${article.stack.length ? `<div class="chips">${article.stack.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    ${tldr ? `<div class="tldr"><div class="tldr-label">TL;DR</div>${tldr}</div>` : ''}
    ${intro.trim() ? `<div class="intro prose">${intro}</div>` : ''}
    ${sections.length ? `<nav class="contents"><div class="contents-head">Contents</div><ol>${sections.map((s, i) =>
      `<li><span class="n">${pad(i)}</span><span class="t">${s.title}</span></li>`).join('')}</ol></nav>` : ''}
  </div>
</section>
${sections.map((s, i) => `
<section class="sec">
  <header class="sec-head"><span class="sec-num">${pad(i)}</span><h2>${s.title}</h2></header>
  <div class="prose">${s.body}</div>
</section>`).join('')}
</body></html>`;
}

function runChromium(args, tmp) {
  return new Promise((resolve, reject) => {
    // TMPDIR keeps Chromium's scratch files inside the per-render dir that gets removed.
    const child = spawn(CHROMIUM, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: tmp } });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), PDF_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`chromium exited ${code}: ${err.trim().split('\n').pop()}`));
    });
  });
}

async function renderPdf(html) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultpdf-'));
  try {
    const src = path.join(dir, 'article.html');
    const out = path.join(dir, 'article.pdf');
    await fsp.writeFile(src, html);
    await runChromium([
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-extensions', '--disable-background-networking',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--no-pdf-header-footer', '--generate-pdf-document-outline',
      '--virtual-time-budget=5000', `--print-to-pdf=${out}`,
      'file://' + src,
    ], dir);
    return await fsp.readFile(out);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get('/api/kb/article.pdf', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const clean = path.normalize(req.query.path || '').replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.resolve(VAULT_DIR, clean);
    if (!full.startsWith(ws.dir + path.sep) || path.basename(full) !== 'article.md') {
      throw new Error('Not an article file');
    }
    realInWorkspace(full, ws.dir);
    const article = await loadArticleRaw(full);
    const html = await buildArticlePdfHtml(article, ws);
    if (req.query.format === 'html') return res.type('html').send(html);   // for tuning pdf.css
    const job = pdfQueue.then(() => renderPdf(html));
    pdfQueue = job.catch(() => {});
    const pdf = await job;
    const name = slugify(article.title).slice(0, 80) + '.pdf';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (err) {
    console.error('PDF export failed:', err.message);
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ---------- Write API ----------
app.post('/api/task/status', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const { path: p, status, mtime } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    const full = safeTaskPath(p, ws.dir);
    let raw = await readGuarded(full, mtime);
    const prev = parseFrontmatter(raw).meta.status || 'backlog';
    raw = setFrontmatterField(raw, 'status', status);
    raw = setFrontmatterField(raw, 'updated', todayISO());
    // Leave a record of *what* changed, per the "append dated progress" rule —
    // a bare status flip in frontmatter is invisible in the file's history.
    raw = insertInSection(raw, 'Progress log',
      [`- ${todayISO()} — status ${prev} → ${status} (moved on the board).`], 'top');
    await atomicWrite(full, raw);
    await regenerateBoard(null, ws.dir);
    const { body, ...rest } = await loadTask(full);
    res.json(rest);
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

// Comments live in a `## Comments` section inside task.md (Q1 decision) so the
// inject-plan.sh hook feeds them to every future Claude Code session automatically.
app.post('/api/task/comment', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const { path: p, text, mtime } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Empty comment' });
    if (text.length > 5000) return res.status(400).json({ error: 'Comment too long (5000 chars max)' });
    const full = safeTaskPath(p, ws.dir);
    let raw = await readGuarded(full, mtime);
    raw = insertInSection(raw, 'Comments', formatComment(text), 'bottom');
    raw = setFrontmatterField(raw, 'updated', todayISO());
    await atomicWrite(full, raw);
    // Return the full rendered task so the drawer can repaint in place — same decoration as
    // /api/task, or the repaint drops the subtask list and the parent back-link.
    const task = await loadTask(full);
    await decorateForDrawer(task, ws);
    res.json(task);
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

app.post('/api/task/check', async (req, res) => {
  try {
    const ws = resolveWorkspace(req.query.ws);
    const { path: p, index, checked, mtime } = req.body || {};
    const full = safeTaskPath(p, ws.dir);
    const raw = await readGuarded(full, mtime);
    const { body } = parseFrontmatter(raw);
    const { lines, idx } = checklistLines(body);
    if (!Number.isInteger(index) || index < 0 || index >= idx.length) {
      return res.status(400).json({ error: 'Checklist item out of range' });
    }
    const ln = idx[index];
    lines[ln] = lines[ln].replace(/^(\s*[-*]\s*)\[[ xX]\]/, `$1[${checked ? 'x' : ' '}]`);
    // Rebuild by replacing only the body portion, so the frontmatter block is untouched.
    const head = raw.slice(0, raw.length - body.length);
    const next = setFrontmatterField(head + lines.join('\n'), 'updated', todayISO());
    await atomicWrite(full, next);
    const { body: _b, ...rest } = await loadTask(full);
    res.json(rest);
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

// ========================================================================
// Workbench: Files mode (the whole vault; reads, plus upload)
// ========================================================================
// Unlike the job-scoped readers above (siblingDocs, diagrams/, screenshots/),
// Files mode can open anything in the vault — that is its point. The guard is
// therefore structural rather than an allowlist: the path must resolve inside
// VAULT_DIR, every segment must be non-dot (no .git, .stfolder, .obsidian,
// .trash, .claude), and realpath must still land inside the vault, so a
// symlink can't walk out of it. Everything sits behind the /api gate; the one
// write (upload) needs a real login, since isLocalRead only lets GETs through.
const FS_SKIP = new Set(['node_modules']);
const FS_TEXT_MAX = 1024 * 1024;
const FS_IMAGE_EXT = new Map([...SCREENSHOT_EXT, ['.ico', 'image/x-icon'], ['.bmp', 'image/bmp']]);
const FS_TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.env.example',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.svg',
  '.sh', '.bash', '.ps1', '.psm1', '.psd1', '.py', '.rb', '.go', '.rs', '.java', '.cs',
  '.sql', '.csv', '.tsv', '.log', '.tf', '.tfvars', '.hcl', '.bicep', '.dockerfile',
  '.gitignore', '.canvas', '.base',
]);
// Spreadsheets (see "Spreadsheets in Files mode" below): the size past which a file isn't opened in the grid.
// An xlsx is parsed and, before any edit, written once as a dry run; ExcelJS does both on the event loop (a
// 10 MB workbook held every other request, terminals included, for seconds), so its cap is the lower one.
const SHEET_FILE_MAX = new Map([['.csv', 5 * 1024 * 1024], ['.xlsx', 3 * 1024 * 1024]]);

// ENOENT from realpath would echo the resolved container path back to the client.
function fsError(res, err) {
  const msg = err && err.code === 'ENOENT' ? 'Not found' : String((err && err.message) || err);
  res.status(err && err.code === 'ENOENT' ? 404 : 400).json({ error: msg });
}

async function safeVaultPath(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^vault\//, '');
  const segs = raw.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s.startsWith('.') || FS_SKIP.has(s))) throw new Error('Path not allowed');
  const full = path.resolve(VAULT_DIR, ...segs);
  if (full !== VAULT_DIR && !full.startsWith(VAULT_DIR + path.sep)) throw new Error('Path outside vault');
  const real = await fsp.realpath(full);
  const realRoot = await fsp.realpath(VAULT_DIR);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Path outside vault');
  return full;
}

// A markdown file under a workspace folder renders with that workspace's key,
// so its diagrams/ and screenshots/ references resolve exactly as in the Board.
function wsKeyForRel(rel) {
  const top = rel.split('/')[0];
  const hit = boards().find((b) => b.dir === top);
  return hit ? hit.key : null;
}

function fsKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.md') return 'md';
  if (FS_IMAGE_EXT.has(ext)) return 'image';
  if (SHEET_FILE_MAX.has(ext)) return 'sheet'; // before the text set: .csv is in it, .tsv stays text
  if (FS_TEXT_EXT.has(ext) || !ext || name === 'Dockerfile' || name === 'Makefile') return 'text';
  return 'binary';
}

app.get('/api/fs/tree', async (req, res) => {
  try {
    const full = await safeVaultPath(req.query.path);
    const entries = await fsp.readdir(full, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || FS_SKIP.has(e.name)) continue;
      const rel = relOf(path.join(full, e.name));
      if (e.isDirectory()) items.push({ name: e.name, path: rel, dir: true });
      else if (e.isFile()) items.push({ name: e.name, path: rel, kind: fsKind(e.name) });
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    items.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || coll.compare(a.name, b.name));
    res.json({ path: relOf(full), items });
  } catch (err) {
    fsError(res, err);
  }
});

app.get('/api/fs/file', async (req, res) => {
  try {
    const full = await safeVaultPath(req.query.path);
    const stat = await fsp.stat(full);
    if (!stat.isFile()) throw new Error('Not a file');
    const rel = relOf(full);
    const kind = fsKind(full);
    // A .csv is a 'sheet' that still carries its text (the grid's Source view); an .xlsx has none.
    const csv = kind === 'sheet' && path.extname(full).toLowerCase() === '.csv';
    const out = { path: rel, name: path.basename(full), kind, size: stat.size, mtime: stat.mtimeMs };
    if ((kind === 'md' || kind === 'text' || csv) && stat.size > FS_TEXT_MAX) {
      if (!csv) out.kind = 'binary'; // a big csv still opens in the grid (up to SHEET_FILE_MAX), just without Source
      out.tooLarge = true;
    } else if (kind === 'md') {
      const source = await fsp.readFile(full, 'utf8');
      const { meta, body } = parseFrontmatter(source);
      out.source = source;
      out.title = meta.title || path.basename(full, '.md');
      out.meta = meta;
      out.html = renderBody(body, rel, wsKeyForRel(rel) || defaultBoard()?.key || '');
    } else if (kind === 'text' || csv) {
      const buf = await fsp.readFile(full);
      // A NUL in the first 8KB means it's binary whatever the extension says. (A UTF-16 csv is that too, as
      // text, but the grid reads it, so it stays a 'sheet' and just has no Source.)
      if (buf.subarray(0, 8192).includes(0)) { if (!csv) out.kind = 'binary'; }
      else out.source = buf.toString('utf8');
    }
    // Text the Files editor can replace: when it was last backed up (null: no earlier version to restore)
    if (out.source != null) out.backup = await sheetLib().store.backupInfo(rel);
    res.json(out);
  } catch (err) {
    fsError(res, err);
  }
});

// Raw bytes for images only. `sandbox` CSP because an .svg opened directly
// would otherwise run its scripts on this origin.
app.get('/api/fs/raw', async (req, res) => {
  try {
    const full = await safeVaultPath(req.query.path);
    const type = FS_IMAGE_EXT.get(path.extname(full).toLowerCase());
    if (!type) throw new Error('Not an image file');
    await fsp.access(full);
    res.set('Content-Type', type);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set('Cache-Control', 'private, no-cache');
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    fsError(res, err);
  }
});

// "What did the agent just touch?" — newest files across the whole vault.
// ~1,800 files, so a full stat walk is a few ms; no watcher to keep alive.
// Board.md files are skipped: every /api/tasks scan may rewrite them, so they
// would sit at the top of the list forever and bury the real edits.
async function walkRecent(dir, since, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (e) => {
    if (e.name.startsWith('.') || FS_SKIP.has(e.name)) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walkRecent(full, since, out);
    if (!e.isFile() || e.name === 'Board.md' || e.name.includes('.tmp-') || /^core(\.\d+)?$/.test(e.name)) return;
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs >= since) out.push({ path: relOf(full), name: e.name, kind: fsKind(e.name), mtime: st.mtimeMs });
    } catch { /* vanished mid-walk */ }
  }));
}
app.get('/api/fs/recent', async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
  const out = [];
  await walkRecent(VAULT_DIR, Date.now() - hours * 3600e3, out);
  out.sort((a, b) => b.mtime - a.mtime);
  res.json({ hours, items: out.slice(0, 50), now: Date.now() });
});

// Filename search for Files mode's search box: case-insensitive substring on
// the vault-relative path, every word must match ("vault board task" finds
// Work/2. website/…/task.md). Same skips as the tree.
async function walkAll(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (e) => {
    if (e.name.startsWith('.') || FS_SKIP.has(e.name)) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push({ path: relOf(full), name: e.name, dir: true }); return walkAll(full, out); }
    if (e.isFile()) out.push({ path: relOf(full), name: e.name, kind: fsKind(e.name) });
  }));
}
app.get('/api/fs/find', async (req, res) => {
  const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return res.json({ items: [] });
  const all = [];
  await walkAll(VAULT_DIR, all);
  const hits = all.filter((f) => { const p = f.path.toLowerCase(); return words.every((w) => p.includes(w)); });
  // Name matches before path-only matches, then shorter paths first.
  const score = (f) => (words.some((w) => f.name.toLowerCase().includes(w)) ? 0 : 1);
  hits.sort((a, b) => score(a) - score(b) || a.path.length - b.path.length);
  res.json({ items: hits.slice(0, 100), total: hits.length });
});

// Download any file as an attachment ("Save as" in the browser). The
// attachment disposition plus the sandbox CSP mean an .html/.svg is never
// rendered on this origin, whatever its type.
app.get('/api/fs/download', async (req, res) => {
  try {
    const full = await safeVaultPath(req.query.path);
    const stat = await fsp.stat(full);
    if (!stat.isFile()) throw new Error('Not a file');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.attachment(path.basename(full));
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    fsError(res, err);
  }
});

// Upload: the one write in Files mode. One file per request, raw bytes as the
// body (no multipart library). `dir` is an existing vault folder (checked by
// safeVaultPath); `name` may carry sub-folders when a whole folder is dropped
// ("Photos/2026/a.jpg") and those are created. Every new segment gets the same
// rules as safeVaultPath — no dot-names, no `..`, no node_modules — so an
// upload can never create a .git/.obsidian/.claude path. An existing file is a
// 409 unless overwrite=1, so the client can ask first. Bytes stream to a
// dot-named temp file (hidden from the tree) and are renamed into place, so a
// half-finished upload never appears as the file. The container runs as
// uid 1000, so files land owned by coder like any other vault file.
const FS_UPLOAD_MAX = 500 * 1024 * 1024;
app.post('/api/fs/upload', async (req, res) => {
  let tmp = null;
  try {
    const dir = await safeVaultPath(req.query.dir);
    if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Not a folder');
    const segs = String(req.query.name || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!segs.length) throw new Error('Missing file name');
    if (segs.some((s) => s === '..' || s.startsWith('.') || FS_SKIP.has(s) || /[\x00-\x1f]/.test(s) || s.length > 255)) {
      throw new Error('File name not allowed');
    }
    const size = Number(req.get('content-length'));
    if (!Number.isFinite(size)) throw new Error('Missing Content-Length');
    if (size > FS_UPLOAD_MAX) { const e = new Error(`Too large (max ${FS_UPLOAD_MAX / 1024 / 1024} MB)`); e.status = 413; throw e; }
    const target = path.resolve(dir, ...segs);
    if (!target.startsWith(dir + path.sep)) throw new Error('Path outside folder');
    const parent = path.dirname(target);
    await fsp.mkdir(parent, { recursive: true });
    // Re-check after mkdir: a pre-existing symlinked sub-folder must not lead out.
    await safeVaultPath(relOf(parent));
    const exists = await fsp.lstat(target).then((s) => s, () => null);
    if (exists && !exists.isFile()) throw new Error('A folder with that name already exists');
    if (exists && req.query.overwrite !== '1') {
      req.resume();
      return res.status(409).json({ error: 'File already exists', exists: true, path: relOf(target) });
    }
    tmp = path.join(parent, `.${path.basename(target)}.upload-${process.pid}-${Date.now()}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let got = 0;
      req.on('data', (c) => { got += c.length; if (got > FS_UPLOAD_MAX) req.destroy(new Error('Too large')); });
      req.on('aborted', () => reject(new Error('Upload aborted')));
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => (got === size ? resolve() : reject(new Error('Upload incomplete'))));
      req.pipe(out);
    });
    await fsp.rename(tmp, target);
    tmp = null;
    res.json({ ok: true, path: relOf(target), size, replaced: !!exists });
  } catch (err) {
    if (tmp) fsp.unlink(tmp).catch(() => {});
    if (!res.headersSent) {
      if (err.status) res.status(err.status).json({ error: err.message });
      else fsError(res, err);
    }
  }
});

// ========================================================================
// Spreadsheets in Files mode: .csv and .xlsx as a grid (view, edit, restore)
// ========================================================================
// GET /api/fs/sheet returns the SheetPayload the grid draws; POST /api/fs/sheet/save applies the grid's ops and
// answers with the fresh payload; POST /api/fs/sheet/restore swaps the file with its one previous version. The
// work is in lib/ (sheet-csv, sheet-xlsx, sheet-store); this section is the HTTP edge. Saves need a real login
// (the /api gate lets a same-box peer through for GETs only), the path goes through safeVaultPath like every
// other Files route, and a save is guarded twice: the client's mtime must still match the file on disk, and the
// store re-checks it right before the rename. Nothing is written for a failed save.
const SHEET_OPS_MAX = 50000;
const SHEET_UNREADABLE = "VaultOS can't read this workbook — download it to open in Excel";
const SHEET_TOO_BIG_TO_EDIT = 'This file is too big to edit here — download it to edit in Excel';
const SHEET_TOO_LARGE = 'This file is too big to open here — download it to open in Excel';
const SHEET_FAILED = "Something went wrong, and the file wasn't changed";

// lib/ is required on first use, never at boot: a missing mount or dependency then breaks only these routes.
let TERM_META = null;
function termMeta() {
  if (!TERM_META) {
    const m = require('./lib/term-meta');
    TERM_META = {
      findJobTask: m.findJobTask,
      taskInfo: m.createTaskInfo({ vaultDir: VAULT_DIR, parseFrontmatter, statuses: STATUSES }),
      gitBranch: m.createGitBranch({ vaultDir: VAULT_DIR }),
      // A getter, not a snapshot: boards can be added in Settings while the server runs.
      get wsDirs() { return boards().map((b) => path.join(VAULT_DIR, b.dir)); },
    };
  }
  return TERM_META;
}

let SHEET_LIB = null;
function sheetLib() {
  if (!SHEET_LIB) {
    const csv = require('./lib/sheet-csv');
    const xlsx = require('./lib/sheet-xlsx');
    const { createStore } = require('./lib/sheet-store');
    const store = createStore({
      vaultDir: VAULT_DIR,
      backupDir: process.env.SHEET_BACKUP_DIR || path.join(DATA_DIR, 'sheet-backups'),
    });
    SHEET_LIB = { csv, xlsx, store };
  }
  return SHEET_LIB;
}

function sheetFail(status, message) {
  return Object.assign(new Error(message), { status });
}

// Only errors that carry a 4xx status (the lib's own, with messages written for people) reach the client as
// they are. Anything else — a raw fs or ExcelJS error, a bug — can carry an absolute path, so it is logged and
// answered generically.
function sheetError(res, err) {
  if (err && err.code === 'ENOENT') return fsError(res, err);
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: String(err.message) });
  }
  console.error('[sheet]', err);
  res.status(500).json({ error: SHEET_FAILED });
}

// The checks every sheet route starts with: a vault path (safeVaultPath), that is a .csv/.xlsx, that is a file.
async function sheetTarget(relPath) {
  if (typeof relPath !== 'string' || !relPath) throw sheetFail(400, 'Missing path');
  let full;
  try {
    full = await safeVaultPath(relPath);
  } catch (err) {
    // safeVaultPath's own errors are plain; a system error (ENOENT, ENOTDIR, EACCES, ELOOP) says where the file is
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) throw sheetFail(404, 'Not found');
    throw sheetFail(400, err && !err.code ? err.message : 'Path not allowed');
  }
  const ext = path.extname(full).toLowerCase();
  if (!SHEET_FILE_MAX.has(ext)) throw sheetFail(400, 'Not a spreadsheet (.csv or .xlsx)');
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw sheetFail(400, 'Not a file');
  return { full, rel: relOf(full), ext, stat };
}

const sheetMtime = (body) => {
  if (typeof body.mtime !== 'number' || !Number.isFinite(body.mtime)) throw sheetFail(400, 'The request needs the mtime of the file you last saw');
  return body.mtime;
};

// Save identity. A client names each save or restore with a random `saveId`; the last write VaultOS made to each
// file is remembered (in memory, oldest dropped past 200, gone on restart), and a payload read while the file is
// still exactly that write carries `lastWrite: { id }`. A client whose answer got lost looks for its own id there:
// it is the only proof a write was its own (another client's save from the same base looks identical otherwise).
const SHEET_LAST_WRITES_MAX = 200;
const sheetLastWrites = new Map(); // rel -> { id, mtime }
const sheetSaveId = (body) => {
  const id = body.saveId;
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' || !/^[0-9a-f]{1,64}$/.test(id)) throw sheetFail(400, 'saveId must be up to 64 lowercase hex characters');
  return id;
};
function sheetRecordWrite(rel, id, stat) {
  sheetLastWrites.delete(rel);
  if (!id) return; // an unnamed write: whatever was remembered for this file no longer describes it
  sheetLastWrites.set(rel, { id, mtime: stat.mtimeMs });
  while (sheetLastWrites.size > SHEET_LAST_WRITES_MAX) sheetLastWrites.delete(sheetLastWrites.keys().next().value);
}
function sheetLastWrite(rel, stat) {
  const w = sheetLastWrites.get(rel);
  return w && Math.abs(w.mtime - stat.mtimeMs) <= 1 ? { id: w.id } : null;
}

// The grid draws a sheet only up to this many cells (the lib's cap): a csv past it is view-only.
function csvTooBig(parsed) {
  let cols = 1;
  for (const rec of parsed.records) if (rec.fields.length > cols) cols = rec.fields.length;
  return parsed.records.length * cols > sheetLib().csv.SHEET_CELL_CAP;
}

// Can this file be edited here, and if not, why not? The one place that rule is written: the payload (GET, and
// what a save answers with) and the save itself both ask it, so they can never disagree. `doc` is what the caller
// has already parsed: the csv's Parsed, or the xlsx's workbook. The xlsx verdict is cached on the stat of `buf`,
// so a cached verdict only ever applies to the bytes it was worked out from.
async function sheetVerdict(ext, rel, stat, buf, doc) {
  const { csv, xlsx, store } = sheetLib();
  if (ext === '.csv') {
    const reason = csv.csvEditable(doc) || (csvTooBig(doc) ? SHEET_TOO_BIG_TO_EDIT : null); // a sheet the grid can't draw
    return { editable: reason === null, reason };
  }
  // No visible sheet the grid can draw: nothing could be edited, so the dry-run write (slow at that size) is skipped.
  if (!xlsx.anyDrawable(doc)) return { editable: false, reason: SHEET_TOO_BIG_TO_EDIT };
  let verdict = store.eligibility.get(rel, stat);
  if (!verdict) {
    verdict = await xlsx.checkEditable(buf, doc);
    store.eligibility.set(rel, stat, verdict);
  }
  return { editable: verdict.editable, reason: verdict.reason };
}

// The one builder behind GET, save and restore. `buf` is the file's bytes and `stat` is the stat those bytes
// were read under (a null `buf` means the file is over SHEET_FILE_MAX and was not read).
async function buildSheetPayload(rel, buf, stat) {
  const { csv, xlsx, store } = sheetLib();
  const ext = path.extname(rel).toLowerCase();
  const out = {
    path: rel, name: path.basename(rel), kind: ext === '.csv' ? 'csv' : 'xlsx',
    mtime: stat.mtimeMs, size: stat.size,
    editable: false, reason: null,
    backup: await store.backupInfo(rel),
    tooLarge: false, csv: null,
    sheets: [], active: 0,
  };
  const lastWrite = sheetLastWrite(rel, stat);
  if (lastWrite) out.lastWrite = lastWrite;
  if (!buf) {
    out.tooLarge = true;
    out.reason = SHEET_TOO_LARGE;
    return out;
  }

  if (ext === '.csv') {
    const parsed = csv.parseCsv(buf);
    out.sheets = [csv.csvToSheet(parsed, path.basename(rel, path.extname(rel)))];
    out.csv = { delimiter: parsed.delimiter, bom: parsed.encoding === 'utf-8-bom', eol: parsed.eolDominant };
    Object.assign(out, await sheetVerdict(ext, rel, stat, buf, parsed));
    return out;
  }

  // xlsx: a file ExcelJS can't load is shown as unreadable (a 200, not an error), never as a half-drawn grid
  let wb;
  try { wb = await xlsx.loadWorkbook(buf); } catch { out.reason = SHEET_UNREADABLE; return out; }
  let model;
  try {
    model = xlsx.toModel(wb);
  } catch (err) {
    console.error('[sheet] could not model', rel, err);
    out.reason = SHEET_UNREADABLE;
    return out;
  }
  out.sheets = model.sheets;
  out.active = model.active;
  Object.assign(out, await sheetVerdict(ext, rel, stat, buf, wb));
  return out;
}

// The write has landed: answer with the fresh payload. If building it fails, the file is changed all the same, so
// the client must not be told otherwise: log it and send the minimum it needs to know — saved, and refetch.
// `load` gives { buf, stat } for the file as it now is.
async function sheetWrittenResponse(rel, written, load) {
  try {
    const now = await load();
    return await buildSheetPayload(rel, now.buf, now.stat);
  } catch (err) {
    console.error('[sheet] written, but the response could not be built', rel, err);
    return {
      path: rel, name: path.basename(rel), kind: path.extname(rel).toLowerCase() === '.csv' ? 'csv' : 'xlsx',
      mtime: written.mtimeMs, size: written.size, saved: true, reload: true,
    };
  }
}

// The new file's bytes for `ops`, or a 4xx saying why not. `guard` is { buf, stat } from the store's guarded read.
async function sheetApply(ext, rel, guard, ops) {
  const { csv, xlsx } = sheetLib();
  let doc;
  if (ext === '.csv') doc = csv.parseCsv(guard.buf);
  else try { doc = await xlsx.loadWorkbook(guard.buf); } catch { throw sheetFail(422, SHEET_UNREADABLE); }
  const verdict = await sheetVerdict(ext, rel, guard.stat, guard.buf, doc);
  if (!verdict.editable) throw sheetFail(422, verdict.reason);
  if (ext === '.csv') return csv.serializeCsv(csv.applyCsvOps(doc, ops));
  xlsx.applyOps(doc, ops);
  return xlsx.writeVerified(doc, guard.buf);
}

app.get('/api/fs/sheet', async (req, res) => {
  try {
    const { full, rel, ext } = await sheetTarget(req.query.path);
    const { store } = sheetLib();
    // Read under the file's lock, after any save or restore already under way: never a file half way through one
    // (a client checking whether its save landed must see the outcome, not the file from before it).
    // Over the cap the file isn't even read: the payload just says so.
    const read = await store.withLock(full, async () => {
      const stat = await fsp.stat(full);
      return stat.size > SHEET_FILE_MAX.get(ext) ? { buf: null, stat } : store.readGuarded(full, null);
    });
    res.json(await buildSheetPayload(rel, read.buf, read.stat));
  } catch (err) {
    sheetError(res, err);
  }
});

app.post('/api/fs/sheet/save', async (req, res) => {
  try {
    const body = req.body || {};
    const mtime = sheetMtime(body);
    const saveId = sheetSaveId(body);
    const { ops } = body;
    if (!Array.isArray(ops) || !ops.length) throw sheetFail(400, 'There are no edits to save');
    if (ops.length > SHEET_OPS_MAX) throw sheetFail(400, 'Too many edits to save at once (at most 50,000)');
    const { full, rel, ext } = await sheetTarget(body.path);
    const { store } = sheetLib();
    const saved = await store.withLock(full, async () => {
      if ((await fsp.stat(full)).size > SHEET_FILE_MAX.get(ext)) throw sheetFail(413, SHEET_TOO_LARGE);
      const guard = await store.readGuarded(full, mtime); // always the client's mtime: 409 if the file moved on
      const out = await sheetApply(ext, rel, guard, ops);
      if (!out || !out.length) throw new Error('save produced an empty file for ' + rel); // never write nothing over a file
      const stat = await store.replace(full, rel, out, guard);
      sheetRecordWrite(rel, saveId, stat);
      return { out, stat };
    });
    // from here the file has changed: nothing below may answer "the file wasn't changed"
    res.json(await sheetWrittenResponse(rel, saved.stat, async () => ({ buf: saved.out, stat: saved.stat })));
  } catch (err) {
    sheetError(res, err);
  }
});

app.post('/api/fs/sheet/restore', async (req, res) => {
  try {
    const body = req.body || {};
    const mtime = sheetMtime(body);
    const saveId = sheetSaveId(body);
    const { full, rel, ext } = await sheetTarget(body.path);
    const { store } = sheetLib();
    const restored = await store.withLock(full, async () => {
      const stat = await store.restore(full, rel, await store.readGuarded(full, mtime));
      sheetRecordWrite(rel, saveId, stat);
      return stat;
    });
    // from here the file has changed. The store doesn't hand back the restored bytes, so they are read again.
    res.json(await sheetWrittenResponse(rel, restored, async () => {
      const stat = await fsp.stat(full);
      return stat.size > SHEET_FILE_MAX.get(ext) ? { buf: null, stat } : store.readGuarded(full, null);
    }));
  } catch (err) {
    sheetError(res, err);
  }
});

// ---- Text files: Edit / Save in Files ----
// The same safety as the sheet save (vault path, per-file lock, 409 when the file moved on, the previous version
// kept for Restore), for the text Files can show: .md, .txt, .json, and a .csv's Source. The client sends the whole
// new text and the mtime it opened the file at.
const TEXT_EMPTY = 'Will not save an empty file. Paste the new text first.';
const TEXT_TOO_LARGE = 'That is too large to edit here (over 1 MB).';
const TEXT_NOT_TEXT = 'That file is not plain text, so it cannot be edited here.';

async function textTarget(relPath) {
  if (typeof relPath !== 'string' || !relPath) throw sheetFail(400, 'Missing path');
  let full;
  try {
    full = await safeVaultPath(relPath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) throw sheetFail(404, 'Not found');
    throw sheetFail(400, err && !err.code ? err.message : 'Path not allowed');
  }
  const kind = fsKind(full);
  const csv = kind === 'sheet' && path.extname(full).toLowerCase() === '.csv';
  if (kind !== 'md' && kind !== 'text' && !csv) throw sheetFail(400, TEXT_NOT_TEXT);
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw sheetFail(400, 'Not a file');
  if (stat.size > FS_TEXT_MAX) throw sheetFail(413, TEXT_TOO_LARGE);
  return { full, rel: relOf(full), stat };
}

// What the client needs after a write; it re-reads the file itself (GET /api/fs/file) for the rest.
async function textWritten(rel, stat) {
  return { path: rel, mtime: stat.mtimeMs, size: stat.size, backup: await sheetLib().store.backupInfo(rel) };
}

// Line endings stay as the file had them: a textarea only knows \n, so a CRLF file gets its \r back.
function textKeepEol(oldBuf, text) {
  const s = oldBuf.toString('utf8');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  return crlf > lf ? text.replace(/\r?\n/g, '\r\n') : text;
}

app.post('/api/fs/text/save', async (req, res) => {
  try {
    const body = req.body || {};
    const mtime = sheetMtime(body);
    if (typeof body.text !== 'string') throw sheetFail(400, 'Missing text');
    if (!body.text.trim()) throw sheetFail(400, TEXT_EMPTY);
    if (body.text.includes('\0')) throw sheetFail(400, TEXT_NOT_TEXT);
    if (Buffer.byteLength(body.text) > FS_TEXT_MAX) throw sheetFail(413, TEXT_TOO_LARGE);
    const { full, rel } = await textTarget(body.path);
    const { store } = sheetLib();
    const stat = await store.withLock(full, async () => {
      const guard = await store.readGuarded(full, mtime); // 409 if the file moved on since the client opened it
      if (guard.buf.subarray(0, 8192).includes(0)) throw sheetFail(422, TEXT_NOT_TEXT);
      return store.replace(full, rel, Buffer.from(textKeepEol(guard.buf, body.text), 'utf8'), guard);
    });
    res.json(await textWritten(rel, stat));
  } catch (err) {
    sheetError(res, err);
  }
});

app.post('/api/fs/text/restore', async (req, res) => {
  try {
    const body = req.body || {};
    const mtime = sheetMtime(body);
    const { full, rel } = await textTarget(body.path);
    const { store } = sheetLib();
    const stat = await store.withLock(full, async () => store.restore(full, rel, await store.readGuarded(full, mtime)));
    res.json(await textWritten(rel, stat));
  } catch (err) {
    sheetError(res, err);
  }
});

// ---- Rename in Files ----
// A rename stays in the same folder (no moves). VaultOS finds jobs and the Board by name, so the names it reads
// are protected: task.md, article.md and Board.md, a `_tasks` folder and anything inside one, and each board's own
// top-level folder. Links to the old name in other notes are not rewritten.
const RENAME_PROTECTED_FILES = new Set(['task.md', 'article.md', 'board.md']);
const RENAME_NAME_MAX = 255;

function renameRefusal(rel, isDir) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1].toLowerCase();
  if (!isDir && RENAME_PROTECTED_FILES.has(base)) return `${segs[segs.length - 1]} is read by name, so it cannot be renamed.`;
  if (segs.some((x) => x.toLowerCase() === '_tasks')) return 'The _tasks folder and what is inside it are read by name, so they cannot be renamed.';
  if (isDir && segs.length === 1 && boards().some((b) => b.dir === rel)) return 'A board\'s top-level folder cannot be renamed.';
  return null;
}

function renameName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw sheetFail(400, 'Type a name first.');
  if (name.length > RENAME_NAME_MAX || Buffer.byteLength(name) > RENAME_NAME_MAX) throw sheetFail(400, 'That name is too long.');
  if (/[\/\\\0]/.test(name)) throw sheetFail(400, 'A name cannot contain / or \\.');
  if (name === '.' || name === '..' || name.startsWith('.')) throw sheetFail(400, 'A name cannot start with a dot.');
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) throw sheetFail(400, 'A name cannot contain < > : " | ? * or control characters.');
  if (/[. ]$/.test(name)) throw sheetFail(400, 'A name cannot end with a dot or a space.');
  return name;
}

app.post('/api/fs/rename', async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.path !== 'string' || !body.path) throw sheetFail(400, 'Missing path');
    const name = renameName(body.name);
    let full;
    try {
      full = await safeVaultPath(body.path);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) throw sheetFail(404, 'Not found');
      throw sheetFail(400, err && !err.code ? err.message : 'Path not allowed');
    }
    if (full === VAULT_DIR) throw sheetFail(400, 'The vault itself cannot be renamed.');
    const rel = relOf(full);
    const info = await fsp.lstat(full);
    const refusal = renameRefusal(rel, info.isDirectory());
    if (refusal) throw sheetFail(422, refusal);
    if (name === path.basename(full)) throw sheetFail(400, 'That is already its name.');
    const dest = path.join(path.dirname(full), name);
    const newRel = relOf(dest);
    const { store } = sheetLib();
    await store.withLock(full, async () => {
      // A name that is already taken is refused. A case-only change on a case-insensitive disk (the vault can be
      // on one) finds the same file under the new spelling, which is fine.
      const taken = await fsp.lstat(dest).catch(() => null);
      if (taken && !(taken.ino === info.ino && taken.dev === info.dev && name.toLowerCase() === path.basename(full).toLowerCase())) {
        throw sheetFail(409, `There is already a file or folder named ${name} here.`);
      }
      await fsp.rename(full, dest);
    });
    // The previous-version backups are filed under the old path: move them with the file (best effort).
    try {
      const bakRoot = process.env.SHEET_BACKUP_DIR || path.join(DATA_DIR, 'sheet-backups');
      const from = path.join(bakRoot, ...rel.split('/'));
      const to = path.join(bakRoot, ...newRel.split('/'));
      await fsp.stat(from);
      await fsp.rename(from, to);
    } catch { /* no backup, or it could not move: the file itself has been renamed */ }
    res.json({ path: newRel, oldPath: rel, name, dir: info.isDirectory() });
  } catch (err) {
    sheetError(res, err);
  }
});

// xterm.js straight out of node_modules — no CDN, no bundler, same as the rest
// of the frontend.
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
};
app.get('/vendor/:file', (req, res) => {
  const rel = VENDOR[req.params.file];
  if (!rel) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(ROOT, 'node_modules', rel));
});

// ---------- Static ----------
// no-cache (not no-store): browser still keeps a copy but must revalidate with
// the server (via ETag/Last-Modified) on every load instead of trusting a
// heuristic freshness window — otherwise an edit here can sit invisible in a
// client's cache for up to a day, worse in an installed PWA window where a
// hard-refresh isn't easy to reach.
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ========================================================================
// Skills (Settings → Skills): what Claude in a VaultOS terminal can use
// ========================================================================
// Read live from disk, so a newly installed skill shows up without a code
// change. Sources, in the order the sheet shows them:
//  - vault   /vault/.claude/commands/*.md and /vault/.claude/skills/*/SKILL.md
//            (the VaultOS workflow: /new-task, /new-subtask, /done)
//  - mine    ~/.claude/skills/*/SKILL.md — installed by hand
//  - synced  ~/.claude/skills/synced/<org>/*/SKILL.md — pushed from claude.ai
//  - plugin  skills/commands inside each installed plugin
// ~ is HOME, the code-server home volume the terminal's `claude` uses.
// Built-in Claude Code commands aren't on disk; the frontend lists those.
function skillMeta(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // Block scalar (`>-`, `|`) or a bare key followed by indented lines.
    if (/^[>|][+-]?$/.test(v) || v === '') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    }
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    out[kv[1]] = v;
  }
  return out;
}
async function readSkillDir(dir, kind) {
  const found = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    let file, fallback;
    if (kind === 'skills' && e.isDirectory()) { file = path.join(dir, e.name, 'SKILL.md'); fallback = e.name; }
    else if (kind === 'commands' && e.isFile() && e.name.endsWith('.md')) { file = path.join(dir, e.name); fallback = e.name.slice(0, -3); }
    else continue;
    try {
      const meta = skillMeta(await fsp.readFile(file, 'utf8'));
      found.push({ name: meta.name || fallback, description: meta.description || '', hint: meta['argument-hint'] || '' });
    } catch { /* no SKILL.md: not a skill */ }
  }
  return found;
}
app.get('/api/skills', async (req, res) => {
  const home = path.join(process.env.HOME || os.homedir(), '.claude');
  const tag = (source, list) => list.map((s) => ({ ...s, source }));
  const out = [
    ...tag('vault', [...await readSkillDir(path.join(VAULT_DIR, '.claude', 'commands'), 'commands'),
      ...await readSkillDir(path.join(VAULT_DIR, '.claude', 'skills'), 'skills')]),
    ...tag('mine', (await readSkillDir(path.join(home, 'skills'), 'skills'))),
  ];
  try {
    for (const org of await fsp.readdir(path.join(home, 'skills', 'synced'))) {
      out.push(...tag('synced', await readSkillDir(path.join(home, 'skills', 'synced', org), 'skills')));
    }
  } catch { /* nothing synced */ }
  try {
    const inst = JSON.parse(await fsp.readFile(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, val] of Object.entries(inst.plugins || inst)) {
      for (const p of [].concat(val)) {
        if (!p || !p.installPath) continue;
        const plugin = key.split('@')[0];
        for (const s of [...await readSkillDir(path.join(p.installPath, 'skills'), 'skills'),
          ...await readSkillDir(path.join(p.installPath, 'commands'), 'commands')]) out.push({ ...s, source: 'plugin', plugin });
      }
    }
  } catch { /* no plugins installed */ }
  res.json({ skills: out });
});

// ========================================================================
// Workbench: Terminal (websocket + pty) — unless TERMINAL=0
// ========================================================================
// A real shell as the container user (uid 1000, same as code-server), in the
// vault. Deliberately stricter than every other route:
//  - a logged-in session is required; the same-box localRead exemption does NOT
//    apply, so the screenshot tooling path can never become a shell;
//  - the Origin must match the Host, so another site can't open a socket with
//    the user's cookie;
//  - not mounted at all when the container sets TERMINAL=0, and refused (403)
//    while the features.terminal setting is off.
// A pty survives its socket, so a reload, a sleeping laptop, a closed browser
// or a flaky connection reattaches to the same shell (with recent scrollback)
// instead of killing a running agent. Like VS Code's terminals, a detached
// shell lives on while anything runs in it; only an idle one (just the prompt)
// is reaped, after TERM_IDLE_MS. × in a tab kills it. (It was a flat 5
// minutes until 2026-10-01, which ended overnight Claude sessions.)
const TERM_IDLE_MS = 24 * 3600e3;
const TERM_MAX = 12;   // across all tabs and windows; each is a real shell (and maybe an agent)
const TERM_SCROLLBACK = 200 * 1024;
const TERMS = new Map(); // id -> { pty, buf, ws, shell, cwd, idleSince, token, task, agent, lastOut }

// ---------- Agent state (herdr-style badges) ----------
// Each shell gets VAULTOS_TERM_ID/TOKEN/HOOK_URL in its env. Claude Code hooks
// (~/.claude/hooks/vaultos-state.js, installed from board/hooks/) POST every
// lifecycle event here, and the terminal's tab and the Board card show:
//   working · blocked (an approval or question is waiting) · done (finished,
//   not looked at yet) · idle (finished and seen, or interrupted).
// Claude anywhere else (code-server, the host) has no VAULTOS_TERM_ID and the
// hook does nothing.
const AGENT_QUIET_MS = 20e3;   // working but silent this long = interrupted (Esc fires no Stop hook)
const AGENT_DISMISS_MS = 8e3;  // blocked, you pressed a key, then silence = dialog dismissed (Esc fires nothing)
function agentStateFor(b) {
  switch (b.hook_event_name) {
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit': case 'PostToolUse': return 'working';
    case 'PreToolUse': return b.tool_name === 'AskUserQuestion' ? 'blocked' : 'working';
    case 'PermissionRequest': return 'blocked';
    case 'Notification':
      return ['permission_prompt', 'elicitation_dialog'].includes(b.notification_type) ? 'blocked' : undefined;
    case 'Stop': return 'done';
    case 'SessionEnd': return null;
    default: return undefined;   // an event we don't map: leave the state alone
  }
}
const agentInfo = (t) => (t.agent ? { state: t.agent.state, since: t.agent.since } : null);
function setAgent(t, state, sessionId) {
  const prev = t.agent ? t.agent.state : null;
  if (state === prev) { if (t.agent && sessionId) t.agent.sessionId = sessionId; return; }
  t.agent = state ? { state, since: Date.now(), sessionId: sessionId || (t.agent && t.agent.sessionId) || '' } : null;
  if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'agent', a: agentInfo(t) }));
}
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// The terminal a loopback request comes from, proven by its per-terminal token
// (VAULTOS_TERM_ID / VAULTOS_TERM_TOKEN in the shell's env), or null.
function termCaller(req) {
  const b = req.body || {};
  const t = typeof b.id === 'string' && TERMS.get(b.id);
  const ok = t && isLoopback(req) && typeof b.token === 'string' && b.token.length === t.token.length
    && crypto.timingSafeEqual(Buffer.from(b.token), Buffer.from(t.token));
  return ok ? t : null;
}

function termAgentHook(req, res) {
  const b = req.body || {};
  const t = termCaller(req);
  if (!t) return res.status(403).json({ error: 'Forbidden' });
  const state = agentStateFor(b);
  if (state !== undefined) setAgent(t, state, typeof b.session_id === 'string' ? b.session_id : '');
  res.json({ ok: true });
}
// Fallbacks for what hooks can't see:
//  - Esc mid-turn: no Stop hook, but the spinner stops redrawing.
//  - Esc on a question/approval: no hook at all. Answering one makes Claude
//    carry on (spinner output, then a tool hook), so "you typed, then it went
//    quiet" means the dialog was dismissed. (herdr reads the rendered screen for
//    this; the server only has the raw pty stream, so it uses timing instead.)
//  - Claude exiting without SessionEnd: the shell is back in the foreground.
//  - An agent without hooks (hooks !== 'claude'): the state comes from the
//    foreground process alone, running and recently noisy = working, running
//    and quiet = idle, gone = no badge.
function sweepAgents() {
  const now = Date.now();
  const profile = profileFor(SETTINGS());
  if (profile && profile.hooks !== 'claude') {
    for (const t of TERMS.values()) {
      const cmd = termCmd(t);
      const next = processState({ running: !!cmd && termBusy(t) && processMatches(profile, cmd, { agentTerm: t.agentTerm }), quietMs: now - t.lastOut });
      if (next !== (t.agent ? t.agent.state : null)) setAgent(t, next);
    }
    return;
  }
  for (const t of TERMS.values()) {
    if (!t.agent) continue;
    const quiet = now - t.lastOut;
    if (!termBusy(t)) setAgent(t, null);
    else if (t.agent.state === 'working' && quiet > AGENT_QUIET_MS) setAgent(t, 'idle');
    else if (t.agent.state === 'blocked' && t.inputAt > t.agent.since && quiet > AGENT_DISMISS_MS) setAgent(t, 'idle');
  }
}

// node-pty reports the foreground process: the shell itself at a bare prompt,
// otherwise whatever is running (claude, node, sleep…).
function termCmd(t) {
  try { return path.basename(t.pty.process || ''); } catch { return ''; }
}
const termBusy = (t) => { const c = termCmd(t); return !!c && c !== path.basename(t.shell); };

// Reap detached shells that have sat at a bare prompt for TERM_IDLE_MS.
// Attached or busy resets the clock, so a finished agent gets a full day too.
function sweepTerms() {
  const now = Date.now();
  for (const t of TERMS.values()) {
    if (t.ws || termBusy(t)) t.idleSince = now;
    else if (now - t.idleSince > TERM_IDLE_MS) try { t.pty.kill(); } catch { /* gone */ }
  }
}

function termOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// The server's own settings (PORT, VAULT_DIR, SECURE_COOKIE…) are noise in an
// interactive shell, and PORT in particular would leak into anything the agent
// starts there.
function termEnv(id, token) {
  const env = {
    ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
    VAULTOS_TERM_ID: id, VAULTOS_TERM_TOKEN: token,
    VAULTOS_HOOK_URL: `http://127.0.0.1:${PORT}/api/term/agent`,
  };
  for (const k of ['PORT', 'TERMINAL', 'TRUST_PROXY', 'SECURE_COOKIE', 'CHROMIUM_PATH', 'LOCAL_READ', 'ALLOWED_HOSTS', 'DATA_DIR', 'SETUP_WINDOW_MIN', 'TODAY_QUOTES']) delete env[k];
  // Without TZ the container runs on UTC, so `date` (and the task-board Stop hook's
  // "is updated: today?") would disagree with the user near midnight. The timezone
  // chosen in setup fills in; a TZ given to the container wins.
  if (!env.TZ) {
    try { const tz = SETTINGS().today.timezone; if (validTimeZone(tz)) env.TZ = tz; } catch { /* no settings yet */ }
  }
  return env;
}

// task: vault-relative task.md this shell was opened for ("Start agent"), so
// the Board card can show its agent. Only set when the shell is created.
function attachTerm(ws, id, cwd, cols, rows, task, agentTerm) {
  const pty = require('node-pty');
  let t = TERMS.get(id);
  if (!t) {
    // Full: make room by ending the detached shell that has been idle longest.
    // Never one that's attached or running something.
    if (TERMS.size >= TERM_MAX) {
      let oldest = null;
      for (const [k, x] of TERMS) if (!x.ws && !termBusy(x) && (!oldest || x.idleSince < oldest[1].idleSince)) oldest = [k, x];
      if (oldest) { TERMS.delete(oldest[0]); try { oldest[1].pty.kill(); } catch { /* gone */ } }
    }
    if (TERMS.size >= TERM_MAX) {
      ws.send(JSON.stringify({ t: 'o', d: '\r\n\x1b[31mToo many open terminals. Close one first (or reopen a detached one from the terminal sidebar).\x1b[0m\r\n' }));
      return ws.close();
    }
    const shell = process.env.SHELL || '/bin/bash';
    const token = crypto.randomBytes(16).toString('hex');
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 100, rows: rows || 30,
      cwd,
      env: termEnv(id, token),
    });
    t = { pty: proc, buf: '', ws: null, shell, cwd, idleSince: Date.now(), token, task: task || '', agentTerm: !!agentTerm, agent: null, lastOut: Date.now(), inputAt: 0 };
    TERMS.set(id, t);
    proc.onData((d) => {
      t.lastOut = Date.now();
      t.buf = (t.buf + d).slice(-TERM_SCROLLBACK);
      if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'o', d }));
    });
    proc.onExit(({ exitCode }) => {
      if (t.ws && t.ws.readyState === 1) {
        t.ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
        t.ws.close();
      }
      if (TERMS.get(id) === t) TERMS.delete(id);
    });
  } else {
    if (t.ws && t.ws !== ws) try { t.ws.close(4000, 'Opened elsewhere'); } catch { /* already gone */ }
    if (t.buf) ws.send(JSON.stringify({ t: 'o', d: t.buf }));
    if (cols && rows) try { t.pty.resize(cols, rows); } catch { /* exited */ }
  }
  t.ws = ws;
  if (t.agent) ws.send(JSON.stringify({ t: 'agent', a: agentInfo(t) }));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'in' && typeof m.d === 'string') { t.pty.write(m.d); t.inputAt = Date.now(); }
    else if (m.t === 'seen') { if (t.agent && t.agent.state === 'done') setAgent(t, 'idle'); }
    else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) try { t.pty.resize(Math.min(m.cols, 500), Math.min(m.rows, 200)); } catch { /* exited */ }
    else if (m.t === 'kill') t.pty.kill();
  });
  ws.on('close', () => {
    if (t.ws !== ws) return;
    t.ws = null;
    t.idleSince = Date.now();
  });
}

function mountTerminal(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const deny = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) return deny(421, 'Misdirected Request');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return deny(400, 'Bad Request'); }
    if (url.pathname !== '/api/term') return deny(404, 'Not Found');
    if (!termOriginOk(req)) return deny(403, 'Forbidden');
    if (!terminalOn()) return deny(403, 'Forbidden');
    sessionMw(req, new http.ServerResponse(req), async () => {
      if (!(req.session && req.session.authed)) return deny(401, 'Unauthorized');
      const id = /^[\w-]{8,64}$/.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : crypto.randomUUID();
      let cwd = VAULT_DIR;
      try {
        const want = await safeVaultPath(url.searchParams.get('cwd') || '');
        if ((await fsp.stat(want)).isDirectory()) cwd = want;
      } catch { /* bad cwd: fall back to the vault root */ }
      let explicit = '';
      try {
        const want = url.searchParams.get('task') || '';
        if (want.endsWith('/task.md')) {
          const full = await safeVaultPath(want);
          if ((await fsp.stat(full)).isFile()) explicit = path.relative(VAULT_DIR, full).split(path.sep).join('/');
        }
      } catch { /* not a task: an ordinary shell */ }
      let found = '';
      if (!explicit && !TERMS.has(id)) {
        try { const tm = termMeta(); found = await tm.findJobTask(cwd, { vaultDir: VAULT_DIR, wsDirs: tm.wsDirs, skipDirs: SKIP_DIRS }); } catch { /* no job folder */ }
      }
      const { task, agentTerm } = terminalTask({ explicit, found });
      const cols = Number(url.searchParams.get('cols')) || 0;
      const rows = Number(url.searchParams.get('rows')) || 0;
      wss.handleUpgrade(req, socket, head, (ws) => attachTerm(ws, id, cwd, cols, rows, task, agentTerm));
    });
  });
  setInterval(sweepTerms, 60e3).unref();
  setInterval(sweepAgents, 5e3).unref();

  // Every shell the server is holding, so the terminal bar can offer to reopen
  // ones no open window knows about (a browser that crashed, another device,
  // cleared storage). Signed-in sessions only, same as the socket.
  app.get('/api/term/list', async (req, res) => {
    if (!(req.session && req.session.authed)) return res.status(401).json({ error: 'Unauthorized' });
    const sessions = [];
    for (const [id, t] of TERMS) {
      let info = null;
      try {
        if (t.task) {
          info = await termMeta().taskInfo(t.task);
          if (info.task !== t.task) t.task = info.task;   // /done moved the folder: follow it
        }
      } catch { info = null; }
      let branch = '';
      try { branch = await termMeta().gitBranch(t.cwd); } catch { branch = ''; }
      sessions.push({
        id,
        cwd: path.relative(VAULT_DIR, t.cwd).split(path.sep).join('/'),
        attached: !!t.ws,
        cmd: termBusy(t) ? termCmd(t) : '',
        idleSince: t.idleSince,
        task: t.task,
        agent: agentInfo(t),
        taskTitle: info?.title || '',
        taskStatus: info?.status || '',
        taskMissing: !!info?.missing,
        branch,
      });
    }
    res.json({ sessions });
  });
  console.log('terminal enabled on /api/term');
}

// ---------- Boot ----------
// Runs before the server listens, so the first request already sees settings.
async function boot() {
  try {
    settingsStore.load();
  } catch (err) {
    SETTINGS_ERROR = err.message;
    console.error(err.message);
  }
  // A vault set up before settings.json existed (it has a password and boards
  // with _tasks/Board.md): derive its settings once. The new file is the only
  // change on disk. A folder name the settings rules refuse lands in
  // SETTINGS_ERROR for the setup screen rather than crashing the server.
  if (config && !SETTINGS() && !SETTINGS_ERROR) {
    try {
      const legacy = await legacySettings(VAULT_DIR, {
        env: process.env, hasCommand: (name) => isInstalled({ detect: [name] }),
      });
      if (legacy) {
        const saved = await settingsStore.save(legacy);
        console.log(`migrated: wrote ${SETTINGS_REL} (${saved.boards.length} boards)`);
      }
    } catch (err) {
      SETTINGS_ERROR = err.message;
      console.error('migration failed:', err.message);
    }
  }
  // Catch up each board's Board.md with any task.md created outside the app
  // (by /new-task, an agent, or Obsidian) since the last status change.
  for (const b of boards()) {
    const ws = resolveWorkspace(b.key);
    console.log(`scanning ${ws.dir}`);
    try {
      await regenerateBoard(null, ws.dir);
      console.log(`Board.md regenerated (${ws.label})`);
    } catch (err) {
      console.error(`Board.md regeneration failed (${ws.label}):`, err.message);
    }
  }
  // A box that already chose Claude Code gets its hook (re)installed, quietly when nothing changed.
  try {
    if (await ensureClaudeHook()) console.log('claude hook installed');
  } catch (err) {
    console.error('claude hook install failed:', err.message);
  }
  const svc = todayService();
  if (svc) svc.boot().catch((err) => console.error('Today boot failed:', err.message));
}

// Required (by a test) rather than run: expose the pure frontmatter helpers and don't boot.
if (require.main !== module) module.exports = { parseFrontmatter, setFrontmatterField };

if (require.main === module) boot().then(() => {
  const server = app.listen(PORT, () => console.log(`vault-board listening on :${PORT}`));
  if (TERMINAL_ENV) mountTerminal(server);
  connectors.init().catch((err) => console.error('connectors init failed:', err && err.message));
}, (err) => {
  console.error('boot failed:', err);
  process.exit(1);
});

