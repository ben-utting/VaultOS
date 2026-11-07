'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/settings');
const { createNotesService } = require('../lib/notes-service');

const NOW = new Date('2026-11-01T09:12:00Z');
const DAY = 86400000;

function vault(t, files = {}, { notes } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'vault');
  const all = {
    'Notes/Inbox/a rough one.md': '2026-10-30 10:00\n\nFirst rough thought\n',
    'Notes/Main/Small steps.md': '2026-10-01 08:00\n\nStatus #child\n\nTags [[habits]] [[work]]\n\n## Small steps\nbody\n',
    'Notes/Tags/habits.md': '',
    'Notes/Tags/work.md': '',
    'Notes/Sources/Books/A Book.md': '# A Book\n',
    'Notes/_tasks/x.md': 'hidden\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) { fs.mkdirSync(path.join(dir, rel), { recursive: true }); continue; }
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const settings = S.validate({ version: 1, features: { notes: true }, today: { timezone: 'Europe/London' }, ...(notes ? { notes } : {}) });
  return { root, dir, settings, at: (rel) => path.join(dir, ...rel.split('/')) };
}
const svc = (v, opts = {}) => createNotesService({ vaultDir: v.dir, settings: () => v.settings, now: () => NOW, ...opts });
const ago = (v, rel, ms) => { const d = new Date(NOW.getTime() - ms); fs.utimesSync(v.at(rel), d, d); };

test('list: inbox newest first with first line and old mark; main with status and tags; names; nothing missing', async (t) => {
  const v = vault(t, { 'Notes/Inbox/newer.md': 'Newer one\n' });
  ago(v, 'Notes/Inbox/a rough one.md', 8 * DAY);
  ago(v, 'Notes/Inbox/newer.md', 6 * DAY);
  const l = await svc(v).list();
  assert.deepEqual(l.inbox.map((i) => [i.path, i.first, i.old]), [
    ['Notes/Inbox/newer.md', 'Newer one', false],
    ['Notes/Inbox/a rough one.md', 'First rough thought', true],
  ]);
  assert.equal(l.main.length, 1);
  assert.deepEqual({ ...l.main[0], mtime: 0 }, { path: 'Notes/Main/Small steps.md', title: 'Small steps', status: 'child', tags: ['habits', 'work'], mtime: 0 });
  assert.deepEqual(l.tags, ['habits', 'work']);
  const names = l.names.map((n) => n.name);
  assert.equal(names[0], 'Small steps');
  assert.ok(names.includes('A Book'));
  assert.ok(!names.includes('x'));
  assert.deepEqual(l.missing, []);
});

test('list: a missing tags folder is named, not an error', async (t) => {
  const v = vault(t);
  fs.rmSync(v.at('Notes/Tags'), { recursive: true });
  const l = await svc(v).list();
  assert.deepEqual(l.missing, ['tags']);
  assert.deepEqual(l.tags, []);
});

test('capture writes a stamped file named from the first words', async (t) => {
  const v = vault(t);
  const r = await svc(v).capture('Hello there');
  assert.deepEqual(r, { path: 'Notes/Inbox/2026-11-01 0912 Hello there.md', name: '2026-11-01 0912 Hello there.md' });
  assert.equal(fs.readFileSync(v.at(r.path), 'utf8'), '2026-11-01 09:12\n\nHello there\n');
});

test('two captures at once with the same words get two files', async (t) => {
  const v = vault(t);
  const s = svc(v);
  const [a, b] = await Promise.all([s.capture('Hello there'), s.capture('Hello there')]);
  assert.deepEqual([a.name, b.name].sort(), ['2026-11-01 0912 Hello there 2.md', '2026-11-01 0912 Hello there.md']);
});

test('capture refuses empty text and NUL bytes', async (t) => {
  const v = vault(t);
  await assert.rejects(svc(v).capture('   '), (e) => e.status === 400);
  await assert.rejects(svc(v).capture('a\u0000'), (e) => e.status === 400);
});

test('capture makes a missing inbox folder, but not a missing notes folder', async (t) => {
  const v = vault(t);
  fs.rmSync(v.at('Notes/Inbox'), { recursive: true });
  const r = await svc(v).capture('Fresh');
  assert.ok(fs.existsSync(v.at(r.path)));
  fs.rmSync(v.at('Notes'), { recursive: true });
  await assert.rejects(svc(v).capture('Fresh'), (e) => e.status === 409);
});

test('capture refuses an inbox that is a symlink out of the vault', async (t) => {
  const v = vault(t);
  const outside = path.join(v.root, 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(v.at('Notes/Inbox'), { recursive: true });
  fs.symlinkSync(outside, v.at('Notes/Inbox'));
  await assert.rejects(svc(v).capture('Escape'), (e) => e.status === 400);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('remove moves a rough note to the trash, undo puts it back', async (t) => {
  const v = vault(t);
  const s = svc(v);
  const rel = 'Notes/Inbox/a rough one.md';
  const { token } = await s.remove(rel);
  assert.ok(!fs.existsSync(v.at(rel)));
  assert.equal(fs.readdirSync(v.at('.vaultos/notes-trash')).length, 1);
  assert.deepEqual(await s.undo(token), { path: rel });
  assert.equal(fs.readFileSync(v.at(rel), 'utf8'), '2026-10-30 10:00\n\nFirst rough thought\n');
});

test('remove refuses a main note and answers 404 for a gone one', async (t) => {
  const v = vault(t);
  await assert.rejects(svc(v).remove('Notes/Main/Small steps.md'), (e) => e.status === 400);
  await assert.rejects(svc(v).remove('Notes/Inbox/never there.md'), (e) => e.status === 404);
});

test('after the undo window the trash file is gone and undo is 410', async (t) => {
  const v = vault(t);
  const s = svc(v, { undoMs: 20 });
  const { token } = await s.remove('Notes/Inbox/a rough one.md');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(fs.readdirSync(v.at('.vaultos/notes-trash')), []);
  await assert.rejects(s.undo(token), (e) => e.status === 410);
});

test('undo is 409 when a note has taken the name again', async (t) => {
  const v = vault(t);
  const s = svc(v);
  const rel = 'Notes/Inbox/a rough one.md';
  const { token } = await s.remove(rel);
  fs.writeFileSync(v.at(rel), 'new\n');
  await assert.rejects(s.undo(token), (e) => e.status === 409);
});

test('sweep removes trash removed over a day ago and keeps newer', async (t) => {
  const oldName = `${NOW.getTime() - 2 * DAY}-aaaa.md`;
  const newName = `${NOW.getTime() - 3600000}-bbbb.md`;
  const v = vault(t, { [`.vaultos/notes-trash/${oldName}`]: 'o', [`.vaultos/notes-trash/${newName}`]: 'n' });
  await svc(v).sweep();
  assert.deepEqual(fs.readdirSync(v.at('.vaultos/notes-trash')), [newName]);
});

test('remove leaves the note\'s own times alone, so it never needs to own the file', async (t) => {
  const v = vault(t);
  const rel = 'Notes/Inbox/a rough one.md';
  ago(v, rel, 5 * DAY);
  const before = fs.statSync(v.at(rel)).mtimeMs;
  await svc(v).remove(rel);
  const [f] = fs.readdirSync(v.at('.vaultos/notes-trash'));
  assert.equal(fs.statSync(path.join(v.at('.vaultos/notes-trash'), f)).mtimeMs, before);
});

test('sweep goes by when a note was removed, not by its own age', async (t) => {
  const v = vault(t);
  const rel = 'Notes/Inbox/a rough one.md';
  ago(v, rel, 30 * DAY);
  await svc(v, { now: () => new Date() }).remove(rel);
  await svc(v, { now: () => new Date() }).sweep();
  assert.equal(fs.readdirSync(v.at('.vaultos/notes-trash')).length, 1, 'a just-removed old note is kept');
});

test('two removes of the same note at once: one Undo, the other "Already gone."', async (t) => {
  const v = vault(t);
  const s = svc(v);
  const rel = 'Notes/Inbox/a rough one.md';
  const [a, b] = await Promise.allSettled([s.remove(rel), s.remove(rel)]);
  const ok = [a, b].filter((r) => r.status === 'fulfilled');
  const bad = [a, b].filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.status, 404);
  assert.equal(bad[0].reason.message, 'Already gone.');
});

test('one unreadable note does not take down the list', async (t) => {
  const v = vault(t, { 'Notes/Inbox/locked.md': 'secret\n' });
  fs.chmodSync(v.at('Notes/Inbox/locked.md'), 0o000);
  t.after(() => { try { fs.chmodSync(v.at('Notes/Inbox/locked.md'), 0o644); } catch {} });
  const l = await svc(v).list();
  assert.ok(l.inbox.some((i) => i.path === 'Notes/Inbox/a rough one.md'));
});
