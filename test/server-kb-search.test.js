'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const art = (title, body) => `---\ntype: article\n${title ? `title: "${title}"\n` : ''}updated: 2026-10-01\n---\n\n${body}\n`;

async function kbServer(t, files, env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-kbsearch-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true, boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
      features: { today: false }, today: { dir: 'Work/Today' },
    }),
    'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    ...files,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { srv, cookie: await login(srv.base, PASSWORD) };
}

async function kb(srv, cookie, q) {
  const res = await fetch(`${srv.base}/api/kb?ws=work&q=${encodeURIComponent(q)}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()).articles.map((a) => a.path);
}

test('kb search ranks by relevance and matches non-adjacent words', async (t) => {
  const { srv, cookie } = await kbServer(t, {
    'Work/1. p/a/article.md': art('Safeguard AD connection test', 'Ran it.'),
    'Work/1. p/b/article.md': art('Slow day', 'the connection to safeguard was slow'),
    'Work/1. p/c/article.md': art('Printers', 'toner'),
  });
  const got = await kb(srv, cookie, 'safeguard test connection');
  assert.equal(got[0], 'Work/1. p/a/article.md');
  assert.ok(got.includes('Work/1. p/b/article.md'));
  assert.ok(!got.includes('Work/1. p/c/article.md'));
});

test('terminal search refuses a caller without a terminal token', async (t) => {
  const { srv } = await kbServer(t, { 'Work/1. p/a/article.md': art('Alpha', 'x') }, { TERMINAL: undefined });
  const res = await fetch(`${srv.base}/api/term/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'nope', token: 'nope', q: 'alpha' }),
  });
  assert.equal(res.status, 403);
});

test('kb search finds an article with no title or TL;DR, titled by its folder', async (t) => {
  const { srv, cookie } = await kbServer(t, { 'Work/1. p/03-contact-form/article.md': art('', 'the form posts to the mailer') });
  const res = await fetch(`${srv.base}/api/kb?ws=work&q=mailer`, { headers: { cookie } });
  const { articles } = await res.json();
  assert.deepEqual(articles.map((a) => [a.path, a.title]), [['Work/1. p/03-contact-form/article.md', '03-contact-form']]);
});

test('kb search still finds partial words while typing', async (t) => {
  const { srv, cookie } = await kbServer(t, {
    'Work/1. p/a/article.md': art('AdminSDHolder and SDProp', 'Postgres too.'),
    'Work/1. p/b/article.md': art('Printers', 'toner'),
  });
  assert.deepEqual(await kb(srv, cookie, 'postg'), ['Work/1. p/a/article.md']);
  assert.deepEqual(await kb(srv, cookie, 'sdholder'), ['Work/1. p/a/article.md']);
});
