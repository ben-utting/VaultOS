'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/settings');
const { createLearnService } = require('../lib/learn-service');
const { LearnError } = require('../lib/learn-names');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const KEY = 'sk-or-v1-abcdefgh1234';
const NOW = new Date('2026-11-13T14:30:00Z');

const INSTRUCTIONS = `# Studying in this folder

Each folder here is a notebook about one topic. The person learns by writing notes by hand, so help them understand. Don't write their notes for them.

## How to answer

- Answer from the files in this notebook's \`Sources/\` folder first. Say where the answer is, like \`video 04.txt [12:30]\` or a file name.
- When you go beyond the sources, say so in a short phrase.
- Use plain words and a small example. Keep answers short unless asked to go deeper.
- Now and then, end with one question that checks understanding.

## Keep the study log

After every answer, add an entry to \`Notes/YYYY-MM-DD study.md\` in this notebook, using today's date. Create the file with a \`# YYYY-MM-DD\` title if it doesn't exist. Each entry:

    ## <the question, in the person's own words>

    <your answer, as you gave it>

    Sources: <file> [12:30], <file>

Never edit or reorder earlier entries. If the person says "log that", add your last answer.

## Leave these alone

Don't change files in \`Sources/\` or \`Studio/\`, and don't create files outside this notebook.

_AGENTS.md and CLAUDE.md in this folder say the same thing: Claude Code reads CLAUDE.md, other agents read AGENTS.md. If you change one, change the other._
`;

function setup(t, { files = {}, key = true, maker } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-svc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(vault);
  fs.mkdirSync(home);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(vault, ...rel.split('/'));
    if (text === null) { fs.mkdirSync(f, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const settings = S.validate({ version: 1, features: { learn: true }, today: { dir: 'Today', timezone: 'UTC' } });
  const made = [];
  const fakeMaker = maker || {
    make: async (args) => { made.push(args); return { bytes: PNG, ext: 'png', title: 'Light: how it bends?', model: 'some/model', cost: 0.04 }; },
    testKey: async () => ({ ok: true, credit: 3 }),
  };
  const svc = createLearnService({ vaultDir: vault, settings: () => settings, home, env: {}, tmpRoot: root, now: () => NOW, maker: fakeMaker, run: async () => ({ code: 1, stdout: '', stderr: '' }) });
  const disk = (rel) => path.join(vault, ...rel.split('/'));
  return { root, vault, home, svc, made, disk, ready: key ? svc.key.save(KEY) : Promise.resolve() };
}
const err = (status, re) => (e) => e instanceof LearnError && e.status === status && (!re || re.test(e.message));
const touch = (file, iso) => { const d = new Date(iso); fs.utimesSync(file, d, d); };

test('ensureFolder writes the folder and the same instructions to AGENTS.md and CLAUDE.md', async (t) => {
  const s = setup(t);
  await s.svc.ensureFolder();
  assert.equal(fs.readFileSync(s.disk('Learning/AGENTS.md'), 'utf8'), INSTRUCTIONS);
  assert.equal(fs.readFileSync(s.disk('Learning/CLAUDE.md'), 'utf8'), INSTRUCTIONS);
});

test('ensureFolder never overwrites an instruction file Ben edited', async (t) => {
  const s = setup(t, { files: { 'Learning/AGENTS.md': 'my own rules\n' } });
  await s.svc.ensureFolder();
  assert.equal(fs.readFileSync(s.disk('Learning/AGENTS.md'), 'utf8'), 'my own rules\n');
  assert.equal(fs.readFileSync(s.disk('Learning/CLAUDE.md'), 'utf8'), INSTRUCTIONS);
});

test('create makes the three folders and heals a deleted instruction file', async (t) => {
  const s = setup(t);
  await s.svc.ensureFolder();
  fs.rmSync(s.disk('Learning/AGENTS.md'));
  const r = await s.svc.create('  Cloud basics ');
  assert.equal(r.notebook.name, 'Cloud basics');
  assert.equal(r.notebook.path, 'Learning/Cloud basics');
  for (const sub of ['Sources', 'Notes', 'Studio']) assert.ok(fs.statSync(s.disk(`Learning/Cloud basics/${sub}`)).isDirectory());
  assert.equal(fs.readFileSync(s.disk('Learning/AGENTS.md'), 'utf8'), INSTRUCTIONS);
  assert.ok(!fs.existsSync(s.disk('Learning/Cloud basics/AGENTS.md')), 'no per-notebook copy (spike: Cursor reads the parent)');
});

test('create refuses a name that is taken, ignoring case', async (t) => {
  const s = setup(t);
  await s.svc.create('Cloud basics');
  await assert.rejects(s.svc.create('cloud BASICS'), err(409, /^There's already a notebook called "Cloud basics"\.$/));
  await assert.rejects(s.svc.create('a/b'), err(400));
});

test('list: notebooks only, with counts, a stable space id, newest first', async (t) => {
  const s = setup(t, {
    files: {
      'Learning/AGENTS.md': 'x', 'Learning/CLAUDE.md': 'x', 'Learning/loose.txt': 'x', 'Learning/.hidden': null, 'Learning/_old': null,
      'Learning/Old/Sources/a.txt': 'a', 'Learning/New/Sources/a.txt': 'a', 'Learning/New/Sources/b.txt': 'b',
      'Learning/New/Notes/2026-11-13 study.md': '# x', 'Learning/New/Sources/.part': 'hidden', 'Learning/New/Sources/sub': null,
    },
  });
  touch(s.disk('Learning/Old/Sources/a.txt'), '2026-11-01T00:00:00Z');
  touch(s.disk('Learning/Old'), '2026-11-01T00:00:00Z');
  touch(s.disk('Learning/Old/Sources'), '2026-11-01T00:00:00Z');
  const r = await s.svc.list();
  assert.equal(r.dir, 'Learning');
  assert.deepEqual(r.notebooks.map((n) => n.name), ['New', 'Old']);
  const nb = r.notebooks[0];
  assert.deepEqual([nb.path, nb.sources, nb.notes, nb.studio], ['Learning/New', 2, 1, 0]);
  assert.match(nb.space, /^learn-[0-9a-f]{12}$/);
  assert.equal((await s.svc.list()).notebooks[0].space, nb.space);
  assert.notEqual(r.notebooks[1].space, nb.space);
  assert.equal(typeof nb.updated, 'number');
  assert.deepEqual(nb.latest, { notes: 'Learning/New/Notes/2026-11-13 study.md', sources: nb.latest.sources });
  assert.match(nb.latest.sources, /^Learning\/New\/Sources\/[ab]\.txt$/);
  assert.deepEqual(r.notebooks[1].latest, { notes: null, sources: 'Learning/Old/Sources/a.txt' });
});

test('list with no Learn folder yet says it is missing', async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.svc.list(), { dir: 'Learning', notebooks: [], missing: true });
});

test('a notebook must be a real folder directly inside the Learn folder', async (t) => {
  const s = setup(t, { files: { 'Learning/A/Notes/x.md': 'x', 'Learning/A/Deep/x': 'x', 'Work/secret.md': 'x' } });
  fs.symlinkSync(s.disk('Work'), s.disk('Learning/Link'));
  for (const bad of ['../Work', 'Learning/../Work', 'Learning/A/Deep', 'Learning/.x', 'Learning/Link', 'Work', '', 'Learning', 5]) {
    assert.throws(() => s.svc.notebookAbs(bad), err(400), String(bad));
  }
  assert.throws(() => s.svc.notebookAbs('Learning/Gone'), err(404));
  assert.equal(s.svc.notebookAbs('Learning/A'), fs.realpathSync(s.disk('Learning/A')));
  assert.ok(!(await s.svc.list()).notebooks.some((n) => n.name === 'Link'), 'a symlinked notebook is not listed');
});

test('image reads the end of the newest study log, saves Studio/<day> <time> <title>.png', async (t) => {
  const log = `# 2026-11-13\n${'x'.repeat(30000)}THE END`;
  const s = setup(t, { files: { 'Learning/A/Notes/2026-11-12 study.md': 'older', 'Learning/A/Notes/2026-11-13 study.md': log, 'Learning/A/Sources/v.txt': 'src', 'Learning/A/Studio': null } });
  touch(s.disk('Learning/A/Notes/2026-11-12 study.md'), '2026-11-12T10:00:00Z');
  await s.ready;
  const r = await s.svc.image('Learning/A', '', '  how it bends ');
  assert.deepEqual(r, { path: 'Learning/A/Studio/2026-11-13 1430 Light how it bends.png', model: 'some/model', cost: 0.04 });
  assert.deepEqual(fs.readFileSync(s.disk(r.path)), PNG);
  assert.equal(s.made[0].key, KEY);
  assert.equal(s.made[0].focus, 'how it bends');
  assert.equal(s.made[0].text.length, 24000);
  assert.ok(s.made[0].text.endsWith('THE END'));
  assert.deepEqual(fs.readdirSync(s.disk('Learning/A/Studio')), ['2026-11-13 1430 Light how it bends.png']);
});

test('image: no study log uses the start of the newest source; a named file is used as asked', async (t) => {
  const s = setup(t, { files: { 'Learning/A/Sources/old.txt': 'OLD', 'Learning/A/Sources/new.md': `START${'y'.repeat(30000)}`, 'Learning/A/Sources/pic.png': 'png' } });
  touch(s.disk('Learning/A/Sources/old.txt'), '2026-11-01T00:00:00Z');
  touch(s.disk('Learning/A/Sources/pic.png'), '2026-11-13T15:00:00Z');
  await s.ready;
  await s.svc.image('Learning/A', '', '');
  assert.ok(s.made[0].text.startsWith('START'));
  assert.equal(s.made[0].text.length, 24000);
  await s.svc.image('Learning/A', 'Learning/A/Sources/old.txt', '');
  assert.equal(s.made[1].text, 'OLD');
});

test('image refuses a file outside the notebook, a missing source, no key, and a second run at once', async (t) => {
  let release;
  const slow = { make: () => new Promise((r) => { release = () => r({ bytes: PNG, ext: 'png', title: 't', model: 'm', cost: null }); }), testKey: async () => ({}) };
  const s = setup(t, { maker: slow, files: { 'Learning/A/Notes/n.md': 'n', 'Learning/B/Notes/x.md': 'x', 'Learning/Empty': null } });
  await s.ready;
  await assert.rejects(s.svc.image('Learning/A', 'Learning/B/Notes/x.md', ''), err(400));
  await assert.rejects(s.svc.image('Learning/A', 'Learning/A/../B/Notes/x.md', ''), err(400));
  await assert.rejects(s.svc.image('Learning/Empty', '', ''), err(400, /^Add a source first\.$/));
  const first = s.svc.image('Learning/A', '', '');   // a double click: the second comes before the first has awaited anything
  await assert.rejects(s.svc.image('Learning/A', '', ''), err(409, /^An image is already being made in this notebook\.$/));
  while (!release) await new Promise((r) => setImmediate(r));
  release();
  assert.match((await first).path, /^Learning\/A\/Studio\/2026-11-13 1430 t\.png$/);
  const nokey = setup(t, { key: false, files: { 'Learning/A/Notes/n.md': 'n' } });
  await assert.rejects(nokey.svc.image('Learning/A', '', ''), err(400, /^Add an OpenRouter key in Settings → Learn\.$/));
});

test('key: status, save, remove and test pass through; test without a key is 400', async (t) => {
  const s = setup(t, { key: false });
  assert.deepEqual(await s.svc.key.status(), { set: false, source: null, last4: null });
  await assert.rejects(s.svc.key.test(), err(400));
  await s.svc.key.save(KEY);
  assert.equal((await s.svc.key.status()).last4, '1234');
  assert.deepEqual(await s.svc.key.test(), { ok: true, credit: 3 });
  await s.svc.key.remove();
  assert.equal((await s.svc.key.status()).set, false);
});
