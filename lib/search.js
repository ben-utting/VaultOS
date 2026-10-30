'use strict';
// Ranked search over every markdown file in the vault: BM25 with weighted
// fields, nudged toward recently updated and curated (article) documents.
// One engine for the KB search box, the `vault-search` CLI and the recall hook.
// The index lives in memory and re-reads a file only when its mtime or size
// changes, so repeated searches cost a directory walk plus the scoring.
const fsp = require('node:fs/promises');
const path = require('node:path');

const K1 = 1.2;
const B = 0.75;
const WEIGHTS = { title: 3, search: 3, meta: 2, tldr: 2, body: 1 };
const RECENCY_BOOST = 0.3;          // up to +30% for a document updated today
const RECENCY_HALF_LIFE_DAYS = 180; // ...halving every six months
const ARTICLE_BOOST = 1.15;         // curated write-ups over working notes
const BOARD_BOOST = 1.2;            // the board the agent is working in
const SNIPPET_MAX = 240;
const PREFIX_MAX = 30;               // words a typed prefix may stand for
const SKIP_DIRS = new Set(['node_modules', '_Templates']);

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does doing for from had has have
he her here hers him his how i if in into is it its just me my no nor not of on or our ours out over she so
some such than that the their them then there these they this those to too up us very was we were what when
where which while who whom why will with would you your yours about after again all also am any because
before being between both during each few further more most off once only other own same should through
under until`.split(/\s+/));

function tokenize(text) {
  const out = [];
  for (let w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (!STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

// --- parsing ----------------------------------------------------------------

// One frontmatter value: an inline [a, "b, c"] list, a quoted string, or a bare
// string with any trailing `# comment` (the templates annotate their keys) cut off.
function parseValue(v) {
  v = v.trim();
  if (v.startsWith('[')) {
    const inner = v.slice(1, v.lastIndexOf(']') > 0 ? v.lastIndexOf(']') : undefined);
    return [...inner.matchAll(/"([^"]*)"|'([^']*)'|([^,]+)/g)]
      .map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter(Boolean);
  }
  const q = v.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/);
  if (q) return q[1] !== undefined ? q[1].replace(/\\(["\\])/g, '$1') : q[2].replace(/''/g, "'");
  return v.replace(/\s+#.*$/, '').trim();
}

// Minimal YAML frontmatter: `key: value` lines plus `- item` block lists.
function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { meta[listKey].push(String(parseValue(item[1]))); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const val = parseValue(kv[2]);
    listKey = val === '' ? kv[1] : null;
    meta[kv[1]] = val === '' ? [] : val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

const list = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(String);
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');

// The `> **TL;DR** ...` blockquote, marker stripped, and the body without it.
function splitTldr(body) {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex((l) => /^>\s*\*\*TL;DR:?\*\*/i.test(l));
  if (i < 0) return { tldr: '', rest: body };
  let j = i + 1;
  while (j < lines.length && lines[j].startsWith('>')) j++;
  const tldr = lines.slice(i, j).map((l) => l.replace(/^>\s?/, '')).join(' ')
    .replace(/^\*\*TL;DR:?\*\*\s*[—:-]?\s*/i, '').trim();
  return { tldr, rest: [...lines.slice(0, i), ...lines.slice(j)].join('\n') };
}

function kindOf(name) {
  if (name === 'article.md') return 'article';
  if (name === 'task.md' || name === 'info.md') return 'task';
  return 'note';
}

function parseDoc(rel, raw, mtimeMs) {
  const { meta, body } = frontmatter(raw);
  const { tldr, rest } = splitTldr(body);
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  const kind = kindOf(name);
  const heading = (rest.match(/^#\s+(.+)$/m) || [])[1];
  const fallback = kind === 'note' ? name.replace(/\.md$/i, '') : (segs[segs.length - 2] || name);
  const title = String((typeof meta.title === 'string' && meta.title) || heading || fallback);
  const fields = {
    title: tokenize(title),
    search: tokenize(list(meta.search).join(' ')),
    meta: tokenize([...list(meta.stack), ...list(meta.tickets)].join(' ')),
    tldr: tokenize(tldr),
    body: tokenize(rest),
  };
  const tf = new Map();
  let len = 0;
  for (const [f, toks] of Object.entries(fields)) {
    len += WEIGHTS[f] * toks.length;
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + WEIGHTS[f]);
  }
  const date = isoDate(meta.updated) || isoDate(meta.created) || new Date(mtimeMs).toISOString().slice(0, 10);
  return { path: rel, kind, board: segs.length > 1 ? segs[0] : '', title, date, tldr, text: rest, tf, len };
}

// First body line sharing a term with the query, cut to SNIPPET_MAX.
function lineSnippet(text, terms) {
  const line = text.split(/\r?\n/).find((l) => tokenize(l).some((t) => terms.has(t))) || '';
  const clean = line.replace(/^[#>*\-\s]+/, '').trim();
  return clean.length > SNIPPET_MAX ? clean.slice(0, SNIPPET_MAX - 1) + '…' : clean;
}

// --- index --------------------------------------------------------------------

// maxAgeMs 0 re-walks on every search (fresh, slow on a network share). A long-lived
// caller (the server) passes a positive age: within it searches use the cached
// documents as they are; past it they still answer from the cache at once and a
// single background refresh catches up.
function createIndex(vaultDir, { maxAgeMs = 0 } = {}) {
  const cache = new Map(); // rel -> { mtimeMs, size, doc }
  let lastRefresh = 0;
  let inflight = null;

  async function walk(rel, out) {
    let entries;
    try { entries = await fsp.readdir(path.join(vaultDir, rel), { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (e) => {
      if (e.name.startsWith('.')) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(r, out); return; }
      if (!e.isFile() || !/\.md$/i.test(e.name) || e.name === 'Board.md') return;
      try {
        const st = await fsp.stat(path.join(vaultDir, r));
        out.push({ rel: r, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-walk */ }
    }));
  }

  function refresh() {
    if (!inflight) {
      inflight = rescan().finally(() => { lastRefresh = Date.now(); inflight = null; });
    }
    return inflight;
  }

  async function documents() {
    if (!lastRefresh || !maxAgeMs) await refresh();
    else if (Date.now() - lastRefresh >= maxAgeMs) refresh().catch(() => {});
    return [...cache.values()].map((c) => c.doc);
  }

  async function rescan() {
    const found = [];
    await walk('', found);
    const seen = new Set();
    await Promise.all(found.map(async (f) => {
      seen.add(f.rel);
      const hit = cache.get(f.rel);
      if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return;
      try {
        const raw = await fsp.readFile(path.join(vaultDir, f.rel), 'utf8');
        cache.set(f.rel, { mtimeMs: f.mtimeMs, size: f.size, doc: parseDoc(f.rel, raw, f.mtimeMs) });
      } catch { cache.delete(f.rel); seen.delete(f.rel); }
    }));
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  }

  async function search(query, opts = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const docs = await documents();
    if (!docs.length) return [];
    const N = docs.length;
    const avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
    // Each query word is a group of index terms; with prefix (search-as-you-type)
    // the last word also stands for every indexed word it begins.
    const groups = terms.map((t) => [t]);
    if (opts.prefix) {
      const last = terms[terms.length - 1];
      const more = new Set();
      for (const d of docs) for (const k of d.tf.keys()) if (k !== last && k.startsWith(last)) more.add(k);
      groups[groups.length - 1].push(...[...more].slice(0, PREFIX_MAX));
    }
    const idf = new Map(groups.flat().map((t) => {
      const df = docs.reduce((n, d) => n + (d.tf.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
    }));
    const kinds = opts.kind ? new Set(list(opts.kind)) : null;
    const now = Date.now();
    const termSet = new Set(terms);
    const out = [];
    for (const d of docs) {
      if (kinds && !kinds.has(d.kind)) continue;
      if (opts.under && !d.path.startsWith(opts.under)) continue;
      let bm25 = 0;
      let matched = 0;
      for (const group of groups) {
        let hit = false;
        for (const t of group) {
          const f = d.tf.get(t);
          if (!f) continue;
          hit = true;
          bm25 += idf.get(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
        }
        if (hit) matched++;
      }
      const coverage = matched / terms.length;
      if (!bm25 || coverage < (opts.minCoverage || 0)) continue;
      const ageDays = Math.max(0, (now - Date.parse(d.date)) / 864e5) || 0;
      let score = bm25 * (1 + RECENCY_BOOST * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS));
      if (d.kind === 'article') score *= ARTICLE_BOOST;
      if (opts.board && d.board === opts.board) score *= BOARD_BOOST;
      out.push({ d, score, coverage });
    }
    out.sort((x, y) => y.score - x.score || x.d.path.localeCompare(y.d.path));
    return out.slice(0, opts.limit || 10).map(({ d, score, coverage }) => ({
      path: d.path, kind: d.kind, board: d.board, title: d.title, date: d.date,
      score: Math.round(score * 1000) / 1000, coverage,
      snippet: (d.kind === 'article' && d.tldr) || lineSnippet(d.text, termSet),
    }));
  }

  return { search, refresh };
}

module.exports = { tokenize, createIndex };
