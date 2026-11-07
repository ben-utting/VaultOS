'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tokenize, createIndex } = require('../lib/search');

// A temp vault seeded with { 'rel/path.md': text }, removed after the test.
function vault(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}
function write(dir, rel, text) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const fm = (meta, body = '') => `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;
const paths = (rs) => rs.map((r) => r.path);

test('tokenize lowercases, drops stopwords, folds plurals, keeps numbers', () => {
  assert.deepEqual(tokenize('The SDProp runs, every 60 minutes!'), ['sdprop', 'run', 'every', '60', 'minute']);
  assert.deepEqual(tokenize('class access'), ['class', 'access']);
});

test('a query of only stopwords and punctuation finds nothing', async (t) => {
  assert.deepEqual(tokenize('the a ?'), []);
  const dir = vault(t, { 'A/n.md': 'the a thing' });
  assert.deepEqual(await createIndex(dir).search('the a ?'), []);
});

test('a title match beats a body match', async (t) => {
  const dir = vault(t, {
    'W/1. p/a/article.md': fm({ title: 'Safeguard connection' }, 'Notes about the setup.'),
    'W/1. p/b/article.md': fm({ title: 'Other work' }, 'We checked the safeguard connection once.'),
  });
  assert.deepEqual(paths(await createIndex(dir).search('safeguard connection')), ['W/1. p/a/article.md', 'W/1. p/b/article.md']);
});

test('search: entries beat body text', async (t) => {
  const dir = vault(t, {
    'W/a/article.md': fm({ title: 'Alpha', search: '[why sdprop resets acl]' }, 'Unrelated words here.'),
    'W/b/article.md': fm({ title: 'Beta' }, 'Here sdprop came up and the acl was reset.'),
  });
  assert.equal((await createIndex(dir).search('sdprop acl'))[0].path, 'W/a/article.md');
});

test('more matched terms beat fewer', async (t) => {
  const dir = vault(t, {
    'W/a.md': 'firewall rule for port 135 on the jump host',
    'W/b.md': 'firewall upgrade notes and other firewall things',
  });
  assert.equal((await createIndex(dir).search('firewall port 135'))[0].path, 'W/a.md');
});

test('recency breaks a near tie but not a large gap', async (t) => {
  const dir = vault(t, {
    'W/old/article.md': fm({ title: 'Pricing', updated: '2024-01-01' }, 'price list'),
    'W/new/article.md': fm({ title: 'Pricing', updated: '2026-10-01' }, 'price list'),
    'W/oldtitle/task.md': fm({ title: 'Kerberos delegation', updated: '2023-01-01' }, 'notes'),
    'W/newbody/task.md': fm({ title: 'Misc', updated: '2026-10-15' }, 'a long note that mentions kerberos once among many other words here'),
  });
  const idx = createIndex(dir);
  assert.equal((await idx.search('pricing'))[0].path, 'W/new/article.md');
  assert.equal((await idx.search('kerberos'))[0].path, 'W/oldtitle/task.md');
});

test('kind filter, and Board.md and templates are never indexed', async (t) => {
  const dir = vault(t, {
    'W/_tasks/Board.md': 'widget widget',
    'W/_tasks/_Templates/article.md': 'widget',
    'W/j/task.md': 'widget task',
    'W/j/article.md': 'widget article',
    'W/j/notes.md': 'widget note',
  });
  const idx = createIndex(dir);
  assert.deepEqual(paths(await idx.search('widget', { kind: 'article' })), ['W/j/article.md']);
  assert.deepEqual(paths(await idx.search('widget')).sort(), ['W/j/article.md', 'W/j/notes.md', 'W/j/task.md']);
  const kinds = Object.fromEntries((await idx.search('widget')).map((r) => [r.path, r.kind]));
  assert.deepEqual(kinds, { 'W/j/article.md': 'article', 'W/j/notes.md': 'note', 'W/j/task.md': 'task' });
});

test('the current board gets a boost, and under restricts to a folder', async (t) => {
  const dir = vault(t, { 'Personal/x.md': 'gateway', 'Archive/x.md': 'gateway' });
  const idx = createIndex(dir);
  assert.equal((await idx.search('gateway', { board: 'Archive' }))[0].path, 'Archive/x.md');
  assert.equal((await idx.search('gateway', { board: 'Personal' }))[0].path, 'Personal/x.md');
  assert.deepEqual(paths(await idx.search('gateway', { under: 'Archive/' })), ['Archive/x.md']);
});

test('minCoverage drops documents matching too few query terms', async (t) => {
  const dir = vault(t, { 'W/a.md': 'alpha beta gamma', 'W/b.md': 'alpha only' });
  const rs = await createIndex(dir).search('alpha beta gamma', { minCoverage: 0.5 });
  assert.deepEqual(paths(rs), ['W/a.md']);
  assert.equal(rs[0].coverage, 1);
});

test('stack and search given as plain strings are still indexed', async (t) => {
  const dir = vault(t, {
    'W/a/article.md': fm({ title: 'A', stack: 'OpManager' }, 'x'),
    'W/b/article.md': fm({ title: 'B', search: '"single phrase lookup"' }, 'y'),
  });
  const idx = createIndex(dir);
  assert.equal((await idx.search('opmanager'))[0].path, 'W/a/article.md');
  assert.equal((await idx.search('phrase lookup'))[0].path, 'W/b/article.md');
});

test('snippets: TL;DR for articles, first matching line otherwise', async (t) => {
  const long = 'zebra '.repeat(80);
  const dir = vault(t, {
    'W/a/article.md': fm({ title: 'Zebra article' }, '> **TL;DR** — Zebras were counted.\n\n## More\nzebra body'),
    'W/n.md': `first line\n${long}\nlast`,
  });
  const rs = await createIndex(dir).search('zebra');
  const by = Object.fromEntries(rs.map((r) => [r.path, r]));
  assert.equal(by['W/a/article.md'].snippet, 'Zebras were counted.');
  assert.ok(by['W/n.md'].snippet.startsWith('zebra zebra'));
  assert.ok(by['W/n.md'].snippet.length <= 240);
});

test('a TL;DR marker with the colon inside the bold is still recognised', async (t) => {
  const dir = vault(t, { 'W/a/article.md': fm({ title: 'Quokka' }, '> **TL;DR:** Quokkas were found.\n\nbody') });
  assert.equal((await createIndex(dir).search('quokka'))[0].snippet, 'Quokkas were found.');
});

test('with maxAgeMs the cached index is served and refreshed in the background', async (t) => {
  const dir = vault(t, { 'W/a.md': 'apple' });
  const idx = createIndex(dir, { maxAgeMs: 60000 });
  assert.equal((await idx.search('apple')).length, 1);
  write(dir, 'W/c.md', 'apple');
  assert.equal((await idx.search('apple')).length, 1, 'fresh enough: no re-walk');
  await idx.refresh();
  assert.equal((await idx.search('apple')).length, 2);

  const stale = createIndex(dir, { maxAgeMs: 1 });
  await stale.search('apple');
  write(dir, 'W/d.md', 'apple');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await stale.search('apple')).length, 2, 'stale: answers from the cache at once');
  await stale.refresh();
  assert.equal((await stale.search('apple')).length, 3);
});

test('a missing title falls back to the folder name', async (t) => {
  const dir = vault(t, { 'W/1. p/03-contact-form/article.md': 'the form posts to the mailer' });
  assert.equal((await createIndex(dir).search('mailer'))[0].title, '03-contact-form');
});

test('the cache picks up edits and deletions', async (t) => {
  const dir = vault(t, { 'W/a.md': 'apple', 'W/b.md': 'banana' });
  const idx = createIndex(dir);
  assert.equal((await idx.search('apple')).length, 1);
  write(dir, 'W/a.md', 'cherry and more cherry');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'W', 'a.md'), later, later);
  assert.deepEqual(await idx.search('apple'), []);
  assert.equal((await idx.search('cherry')).length, 1);
  fs.rmSync(path.join(dir, 'W', 'b.md'));
  assert.deepEqual(await idx.search('banana'), []);
});

test('prefix:true lets the last query word match as a prefix', async (t) => {
  const dir = vault(t, { 'W/a/article.md': fm({ title: 'Postgres upgrade' }, 'kubernetes notes'), 'W/b.md': 'unrelated' });
  const idx = createIndex(dir);
  assert.deepEqual(await idx.search('postg'), []);
  assert.deepEqual(paths(await idx.search('postg', { prefix: true })), ['W/a/article.md']);
  assert.deepEqual(paths(await idx.search('upgrade kube', { prefix: true, minCoverage: 1 })), ['W/a/article.md']);
});

test('a task result carries its status; a note does not', async (t) => {
  const dir = vault(t, {
    'W/1. p/a/task.md': fm({ title: 'Boiler', status: 'review' }),
    'W/n.md': 'boiler',
  });
  const rs = await createIndex(dir).search('boiler');
  const task = rs.find((r) => r.kind === 'task');
  const note = rs.find((r) => r.kind === 'note');
  assert.equal(task.status, 'review');
  assert.ok(!('status' in note));
});
