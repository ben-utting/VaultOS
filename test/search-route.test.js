'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';
const task = (title, status, body) => `---\ntype: task\ntitle: "${title}"\nstatus: ${status}\nupdated: 2026-10-01\n---\n\n${body}\n`;
const art = (title, body) => `---\ntype: article\ntitle: "${title}"\nupdated: 2026-10-01\n---\n\n${body}\n`;
const settings = (today) => JSON.stringify({
  version: 1, setupDone: true,
  boards: [
    { key: 'work', dir: 'Work', label: 'Work', hidden: false },
    { key: 'home', dir: 'Home', label: 'Home', hidden: false },
    { key: 'archive', dir: 'Archive', label: 'Archive', hidden: true },
  ],
  features: { today }, today: { dir: 'Home/Today' },
});
const FILES = {
  'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
  'Work/1. Ops/01-boiler/task.md': task('Boiler rota', 'in-progress', 'service the boiler'),
  'Work/1. Ops/02-long/task.md': task('Long job', 'review', 'boiler pipework long'),
  'Work/1. Ops/02-long/_tasks/hidden.md': 'boiler in a tasks dir\n',
  'Home/2. Admin/01-dentist/task.md': task('Dentist', 'scheduled', 'book the dentist near the boiler'),
  'Home/2. Admin/01-dentist/article.md': art('Dentist notes', 'dentist boiler checklist'),
  'Home/notes/meeting-notes.md': 'boiler meeting notes\n',
  'Home/Today/2026-10-01.md': 'boiler today note\n',
  'Archive/old/task.md': task('Old boiler', 'done', 'boiler'),
  'Loose/stuff/note.md': 'boiler loose\n',
};

async function srvWith(t, today = true, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-searchroute-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, { '.vaultos/settings.json': settings(today), ...FILES, ...extra });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { srv, cookie: await login(srv.base, PASSWORD) };
}
const get = (s, qs) => fetch(`${s.srv.base}/api/search?${qs}`, { headers: { cookie: s.cookie } });
const paths = async (s, qs) => (await (await get(s, qs)).json()).results.map((r) => r.path);

test('search requires a session', async (t) => {
  const s = await srvWith(t);
  const res = await fetch(`${s.srv.base}/api/search?q=boiler`);
  assert.equal(res.status, 401);
});

test('search requires q', async (t) => {
  const s = await srvWith(t);
  const res = await get(s, 'q=');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('search finds tasks, articles and notes across visible workspaces', async (t) => {
  const s = await srvWith(t);
  const got = await paths(s, 'q=boiler');
  assert.ok(got.includes('Work/1. Ops/01-boiler/task.md'));
  assert.ok(got.includes('Home/notes/meeting-notes.md'));
  assert.ok(got.includes('Home/2. Admin/01-dentist/article.md'));
});

test('search leaves out hidden workspaces, loose folders, Today and _tasks', async (t) => {
  const s = await srvWith(t);
  const got = await paths(s, 'q=boiler');
  assert.ok(got.length > 0);
  for (const p of got) {
    assert.ok(!/^(Archive|Loose)\//.test(p), p);
    assert.ok(!p.startsWith('Home/Today/'), p);
    assert.ok(!p.split('/').includes('_tasks'), p);
  }
});

test('kind, ws and status narrow results', async (t) => {
  const s = await srvWith(t);
  assert.deepEqual(await paths(s, 'q=boiler&kind=task&status=review'), ['Work/1. Ops/02-long/task.md']);
  assert.deepEqual(await paths(s, 'q=boiler&ws=home&kind=article'), ['Home/2. Admin/01-dentist/article.md']);
  const noKind = await paths(s, 'q=boiler&status=review');
  assert.ok(noKind.length > 1);
  assert.ok(noKind.includes('Home/notes/meeting-notes.md'));
  const work = await paths(s, 'q=boiler&ws=work');
  assert.ok(work.length > 0 && work.every((p) => p.startsWith('Work/')));
});

test('results carry ws, wsLabel and folder', async (t) => {
  const s = await srvWith(t);
  const { results } = await (await get(s, 'q=dentist&kind=task')).json();
  const r = results.find((x) => x.path === 'Home/2. Admin/01-dentist/task.md');
  assert.ok(r);
  assert.equal(r.ws, 'home');
  assert.equal(r.wsLabel, 'Home');
  assert.equal(r.folder, '2. Admin / 01-dentist');
  assert.equal(r.status, 'scheduled');
  const note = (await (await get(s, 'q=meeting')).json()).results.find((x) => x.path === 'Home/notes/meeting-notes.md');
  assert.equal(note.folder, 'notes');
  assert.equal(note.status, undefined);
});

test('limit is clamped to 1..50', async (t) => {
  const s = await srvWith(t);
  assert.ok((await paths(s, 'q=boiler&limit=500')).length <= 50);
  assert.equal((await paths(s, 'q=boiler&limit=0')).length, 1);
});

test('an unknown kind or ws gives 400', async (t) => {
  const s = await srvWith(t);
  assert.equal((await get(s, 'q=boiler&kind=bogus')).status, 400);
  assert.equal((await get(s, 'q=boiler&ws=nope')).status, 400);
  assert.equal((await get(s, 'q=boiler&ws=archive')).status, 400);
});

test('terms counts index tokens; a stopword-only query is empty, not an error', async (t) => {
  const s = await srvWith(t);
  const res = await get(s, 'q=the');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: [], terms: 0 });
  assert.equal((await (await get(s, 'q=service%20boiler')).json()).terms, 2);
});

test('/api/me carries todayDir only when Today is on', async (t) => {
  const on = await srvWith(t, true);
  const me = await (await fetch(`${on.srv.base}/api/me`, { headers: { cookie: on.cookie } })).json();
  assert.equal(me.todayDir, 'Home/Today');
  const off = await srvWith(t, false);
  const me2 = await (await fetch(`${off.srv.base}/api/me`, { headers: { cookie: off.cookie } })).json();
  assert.equal(me2.todayDir, '');
});

test('limit defaults to 30', async (t) => {
  const s = await srvWith(t, true, Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`Work/bulk/n${i}.md`, `zebrafinch sighting ${i}\n`])));
  assert.equal((await paths(s, 'q=zebrafinch')).length, 30);
});

test('q is capped at 200 characters', async (t) => {
  const s = await srvWith(t);
  assert.equal((await get(s, 'q=' + 'a'.repeat(201))).status, 400);
  assert.equal((await get(s, 'q=' + 'a'.repeat(200))).status, 200);
  assert.equal((await get(s, 'q=' + encodeURIComponent('  ' + 'a'.repeat(200) + '  '))).status, 200);
});
