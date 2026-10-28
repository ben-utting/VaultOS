'use strict';
// Knowledge Base reading history and the morning read. The rules are pure
// functions (every clock and time zone comes in as an argument, so tests pass
// fixed ones); the history itself is one JSON file, .vaultos/kb-reads.json,
// next to settings.json and outside Files mode and search like the rest of .vaultos.
//
// History is kept per workspace and keyed by the article's job folder name, so
// moving a finished job into _done/ (or to another area) keeps its reads.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const { zonedDate, zonedTime } = require('./today-note');

const READS_REL = '.vaultos/kb-reads.json';
const MORNING_START = 5;    // the morning read shows from 05:00…
const MORNING_END = 12;     // …up to noon, in the Today time zone
const STALE_DAYS = 30;      // "not read in a while"
const SKIP_DAYS = 90;       // Skip this one keeps an article out of the morning read this long
const WORDS_PER_MIN = 200;
const DAY_MS = 86400000;

const emptyState = () => ({ version: 1, articles: {}, morning: null });

const articleKey = (relPath) => path.posix.basename(path.posix.dirname(relPath));

// Fenced code and HTML comments aren't read the way prose is, so they don't count.
function readingMinutes(body) {
  const prose = String(body || '').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const words = prose.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MIN));
}

// 'updated' when the article's updated: date is later than the day (in the zone) it was last read.
function readState(article, entry, tz) {
  if (!entry || !entry.read) return 'unread';
  const updated = article.updated || '';
  return updated && updated > zonedDate(new Date(entry.read), tz) ? 'updated' : 'read';
}

function inMorning(now, tz) {
  const hour = Number(zonedTime(new Date(now), tz).slice(0, 2));
  return hour >= MORNING_START && hour < MORNING_END;
}

const byTitle = (x, y) => x.article.title.localeCompare(y.article.title);
const desc = (a, b) => (b || '').localeCompare(a || '');

// Every article the morning read could offer, best first: changed since you read it,
// then never read, then not read for STALE_DAYS. Drafts and skipped articles never.
function morningCandidates(articles, entries, now, tz) {
  const updated = [];
  const unread = [];
  const stale = [];
  for (const article of articles) {
    if (article.status && article.status !== 'published') continue;
    const entry = entries[articleKey(article.path)];
    if (entry && entry.skipUntil > now) continue;
    const state = readState(article, entry, tz);
    if (state === 'updated') updated.push({ article, reason: 'updated', read: entry.read });
    else if (state === 'unread') unread.push({ article, reason: 'unread' });
    else if (now - entry.read >= STALE_DAYS * DAY_MS) stale.push({ article, reason: 'stale', read: entry.read });
  }
  updated.sort((x, y) => desc(x.article.updated, y.article.updated) || byTitle(x, y));
  unread.sort((x, y) => desc(x.article.updated || x.article.created, y.article.updated || y.article.created) || byTitle(x, y));
  stale.sort((x, y) => x.read - y.read || byTitle(x, y));
  return [...updated, ...unread, ...stale].map(({ article, reason }) => ({ article, reason }));
}

const morningPick = (articles, entries, now, tz) => morningCandidates(articles, entries, now, tz)[0] || null;

// A browser's old localStorage history ({ path: ms }) into the server state. Each path
// goes to the board whose folder it sits in; anything that isn't a real past read of an
// article on a current board is dropped. Where both sides have a read, the newer wins.
function mergeImport(state, boards, map, now) {
  const next = JSON.parse(JSON.stringify(state));
  let imported = 0;
  for (const [p, read] of Object.entries(map || {})) {
    if (typeof read !== 'number' || !Number.isFinite(read) || read <= 0 || read > now) continue;
    if (typeof p !== 'string' || !p.endsWith('/article.md') || p.split('/').includes('..')) continue;
    const board = boards.find((b) => p.startsWith(b.dir + '/'));
    if (!board) continue;
    const key = articleKey(p);
    const ws = next.articles[board.key] || (next.articles[board.key] = {});
    const entry = ws[key] || {};
    if (entry.read && entry.read >= read) continue;
    ws[key] = { ...entry, read };
    imported++;
  }
  return { state: next, imported };
}

// ---------- The store ----------
// Read from disk once, then held in memory; only this server writes the file. Writes
// run one at a time, each on a copy, and memory changes only after the file is saved.
// A file that won't parse is never replaced (the same rule as settings.json): reads
// see an empty history and every write fails with DAMAGED_MSG until someone fixes it.
const DAMAGED_MSG = `${READS_REL} is damaged. Fix or delete it.`;

const validState = (s) => !!s && s.version === 1 && !!s.articles && typeof s.articles === 'object' && !Array.isArray(s.articles);

function createReadStore(vaultDir) {
  const full = path.join(vaultDir, READS_REL);
  let state = null;
  let damaged = null;
  let queue = Promise.resolve();

  function load() {
    if (state) return;
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      state = emptyState();
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* damaged, below */ }
    if (validState(parsed)) state = { ...emptyState(), ...parsed };
    else {
      damaged = DAMAGED_MSG;
      state = emptyState();
      console.error(`kb reads: ${DAMAGED_MSG}`);
    }
  }

  function get() { load(); return state; }

  function update(fn) {
    const run = queue.then(async () => {
      load();
      if (damaged) throw Object.assign(new Error(DAMAGED_MSG), { status: 500 });
      const next = fn(JSON.parse(JSON.stringify(state)));
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await atomicWrite(full, JSON.stringify(next, null, 2) + '\n');
      state = next;
      return state;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { get, update, damaged: () => { load(); return damaged; } };
}

module.exports = {
  READS_REL, MORNING_START, MORNING_END, STALE_DAYS, SKIP_DAYS, WORDS_PER_MIN, DAMAGED_MSG,
  emptyState, articleKey, readingMinutes, readState, inMorning, morningCandidates, morningPick, mergeImport,
  createReadStore,
};
