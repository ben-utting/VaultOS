'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');
const { createIndex } = require('../lib/search');

const PASSWORD = 'correct horse';
// The file holds YAML escapes: \" for a quote and \\ for one backslash.
const ESCAPED_LINE = 'title: "Add a \\"ship kit\\" to C:\\\\tools #3"';
const LITERAL_TITLE = 'Add a "ship kit" to C:\\tools #3';
const TASK = `---\n${ESCAPED_LINE}\nstatus: backlog\nupdated: 2026-10-01\n---\n\n# Ship kit\n`;
const TASK_PATH = 'Personal/1. job/01-ship/task.md';
const ARTICLE_PATH = 'Personal/1. job/02-patchmon/article.md';

async function lookServer(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-look-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true,
      boards: [{ key: 'personal', dir: 'Personal', label: 'Personal', hidden: false }],
      features: { today: false }, today: { dir: 'Personal/Today', timezone: 'Europe/London' },
    }),
    'Personal/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    [TASK_PATH]: TASK,
    [ARTICLE_PATH]: '---\ntype: article\ntitle: PatchMon rollout\nupdated: 2026-10-01\n---\n\n> **TL;DR:** PatchMon watches every host for pending updates.\n\n## Body\n\ntext\n',
    'notes.md': '# notes\n',
    'core': 'crash',
    'core.123456': 'crash',
    ...files,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const cookie = await login(srv.base, PASSWORD);
  const get = async (url) => {
    const res = await fetch(`${srv.base}${url}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    return res.json();
  };
  return { srv, cookie, get, vault: d.vault };
}

test('an escaped double-quoted title reads literally', async (t) => {
  const { get } = await lookServer(t);
  const { tasks } = await get('/api/tasks?ws=personal');
  const task = tasks.find((x) => x.path === TASK_PATH);
  assert.ok(task);
  assert.equal(task.title, LITERAL_TITLE);
});

test('a status change leaves an escaped title byte-identical', async (t) => {
  const { srv, cookie, get, vault } = await lookServer(t);
  const { tasks } = await get('/api/tasks?ws=personal');
  const task = tasks.find((x) => x.path === TASK_PATH);
  const res = await fetch(`${srv.base}/api/task/status?ws=personal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: task.path, status: 'review', mtime: task.mtime }),
  });
  assert.equal(res.status, 200);
  const lines = fs.readFileSync(path.join(vault, ...TASK_PATH.split('/')), 'utf8').split('\n');
  assert.ok(lines.includes(ESCAPED_LINE), 'title line unchanged');
  assert.ok(lines.includes('status: review'), 'status line updated');
});

test('a value with a double quote is written escaped', () => {
  // No HTTP route writes free text through setFrontmatterField, so test the function itself.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-look-fn-'));
  const keep = { VAULT_DIR: process.env.VAULT_DIR, DATA_DIR: process.env.DATA_DIR, HOME: process.env.HOME };
  fs.mkdirSync(path.join(root, 'vault'));
  Object.assign(process.env, { VAULT_DIR: path.join(root, 'vault'), DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home') });
  try {
    const { setFrontmatterField, parseFrontmatter } = require('../server.js');
    const raw = '---\ntitle: T\ndecision_note: old\n---\n\nbody\n';
    const next = setFrontmatterField(raw, 'decision_note', 'say "yes"');
    assert.ok(next.split('\n').includes('decision_note: "say \\"yes\\""'), next);
    assert.equal(parseFrontmatter(next).meta.decision_note, 'say "yes"');
    const back = setFrontmatterField(raw, 'decision_note', 'C:\\x');
    assert.ok(back.split('\n').includes('decision_note: "C:\\\\x"'), back);
    assert.equal(parseFrontmatter(back).meta.decision_note, 'C:\\x');
    assert.equal(parseFrontmatter("---\nk: 'it''s'\n---\n").meta.k, "it's");
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the KB excerpt drops "TL;DR:" with its colon', async (t) => {
  const { get } = await lookServer(t);
  const { articles } = await get('/api/kb?ws=personal');
  const a = articles.find((x) => x.path === ARTICLE_PATH);
  assert.ok(a);
  assert.ok(a.excerpt.startsWith('PatchMon'), a.excerpt);
});

test('crash dumps never show in recent files', async (t) => {
  const { get } = await lookServer(t);
  const { items } = await get('/api/fs/recent');
  const names = items.map((i) => i.name);
  assert.ok(names.includes('notes.md'));
  assert.ok(!names.includes('core'));
  assert.ok(!names.includes('core.123456'));
});

test('search sees the same unescaped title', async (t) => {
  // The terminal search route needs a terminal token; the KB box and vault-search both
  // answer from this index, so ask it directly.
  const { vault } = await lookServer(t);
  const hits = await createIndex(vault, { maxAgeMs: 0 }).search('ship');
  const hit = hits.find((h) => h.path === TASK_PATH);
  assert.ok(hit, JSON.stringify(hits));
  assert.equal(hit.title, LITERAL_TITLE);
});
