'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NC = require('../lib/automation-newcards');
const { parseFrontmatter } = require('../lib/task-file');

const SKIP = new Set(['_tasks', '_Templates', 'archive', 'correspondence', 'data', 'Scripts', '_cancelled']);

// A temp board with these relative files (a path ending in /.keep just makes the folder).
function tmpBoard(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newcards-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const SUC_LIKE_TEMPLATE = `---
type: task
id: ""                 # e.g. a short slug
title: ""
area: ""               # one | two
status: backlog        # backlog | in-progress | done
priority: med          # low | med | high
owner: Owner-from-template
created: 2026-01-01
updated: 2026-01-01
blocked_by: ""          # what you're waiting on
---

## Goal
_One or two sentences._

## Context / key facts
_Hosts, tickets, owners._

## Plan
- [ ] Phase 1 …

## Progress log
_Append-only._

- 2026-01-01 — created.

## Findings / decisions
_Things learned._
`;

test('checkDestination: exists, inside, not skipped, not a card folder', (t) => {
  const b = tmpBoard(t, { 'tickets/.keep': '', 'archive/x/.keep': '', 'job/task.md': '---\nid: job\n---\n', 'job/sub/.keep': '', '.hidden/.keep': '', 'file.md': 'x' });
  assert.deepEqual(NC.checkDestination(b, 'tickets', { skipDirs: SKIP }), { ok: true, dir: path.join(b, 'tickets') });
  assert.equal(NC.checkDestination(b, '', { skipDirs: SKIP }).ok, true);
  assert.equal(NC.checkDestination(b, 'nope', { skipDirs: SKIP }).error, "That folder doesn't exist");
  assert.equal(NC.checkDestination(b, 'file.md', { skipDirs: SKIP }).error, "That folder doesn't exist");
  assert.equal(NC.checkDestination(b, 'archive/x', { skipDirs: SKIP }).error, "Cards in that folder wouldn't show on the board");
  assert.equal(NC.checkDestination(b, '.hidden', { skipDirs: SKIP }).error, "Cards in that folder wouldn't show on the board");
  assert.equal(NC.checkDestination(b, 'job', { skipDirs: SKIP }).error, "That's a card's folder; pick the folder it sits in");
  assert.equal(NC.checkDestination(b, 'job/sub', { skipDirs: SKIP }).error, "That's a card's folder; pick the folder it sits in");
  fs.symlinkSync(os.tmpdir(), path.join(b, 'out'));
  assert.equal(NC.checkDestination(b, 'out', { skipDirs: SKIP }).error, 'That folder is outside the board');
});

test('destinationFolders: root first, depth 3, no skipped, dot or card folders', async (t) => {
  const b = tmpBoard(t, { 'a/b/c/d/.keep': '', '_tasks/x/.keep': '', '.git/x/.keep': '', 'job/task.md': '', 'job/sub/.keep': '', 'z/.keep': '' });
  assert.deepEqual(await NC.destinationFolders(b, { skipDirs: SKIP }), ['', 'a', 'a/b', 'a/b/c', 'z']);
  assert.deepEqual(await NC.destinationFolders(b, { skipDirs: SKIP, max: 2 }), ['', 'a']);
});

test('folderNameFor and slugTitle', () => {
  assert.equal(NC.folderNameFor({ key: 'SUC-1', title: 'x' }, 0, 'UTC'), 'SUC-1');
  assert.equal(NC.folderNameFor({ title: 'IAM — Reset MFA for new starter!' }, 0, 'UTC'), 'iam-reset-mfa-for-new-starter');
  assert.equal(NC.folderNameFor({ title: 'Café déjà vu' }, 0, 'UTC'), 'cafe-deja-vu');
  assert.equal(NC.folderNameFor({ title: '———' }, Date.UTC(2026, 10, 25, 8, 5), 'UTC'), 'card-20261125-0805');
  assert.equal(NC.folderNameFor({ title: '———' }, Date.UTC(2026, 6, 25, 8, 5), 'Europe/London'), 'card-20260725-0905');
  const long = NC.slugTitle(`${'a'.repeat(49)} bbbb`);
  assert.ok(long.length <= 50);
  assert.doesNotMatch(long, /-$/);
});

test('buildTaskFile: template kept, fields filled, sections written', () => {
  const raw = NC.buildTaskFile({ template: SUC_LIKE_TEMPLATE, id: 'SUC-1', today: '2026-11-25', automationName: 'Jira queue', agentLabel: 'Claude Code',
    card: { title: 'IAM — "Reset": MFA', key: 'SUC-1', goal: 'Works.', link: 'https://x.test/1', priority: 'high', plan: ['one'], context: 'ctx' } });
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.title, 'IAM — "Reset": MFA');
  assert.equal(meta.status, 'backlog');
  assert.equal(meta.priority, 'high');
  assert.equal(meta.id, 'SUC-1');
  assert.equal(meta.source_key, 'SUC-1');
  assert.equal(meta.created_by, 'Jira queue');
  assert.equal(meta.owner, 'Owner-from-template');
  assert.equal(meta.created, '2026-11-25');
  assert.equal(meta.updated, '2026-11-25');
  assert.equal(meta.area, '');
  assert.deepEqual(meta.aliases, ['SUC-1']);
  assert.match(raw, /^id: SUC-1\naliases: \["SUC-1"\]\n/m);
  assert.match(body, /## Goal\nWorks\./);
  assert.match(body, /## Context \/ key facts\nctx\n\nSource: https:\/\/x\.test\/1/);
  assert.match(body, /## Plan\n- \[ \] one/);
  assert.match(body, /## Progress log\n- 2026-11-25 — Created by automation "Jira queue" \(Claude Code\)\./);
  assert.doesNotMatch(body, /2026-01-01 — created/);
  assert.match(body, /## Findings \/ decisions\n_Things learned\._/);
  const keyless = parseFrontmatter(NC.buildTaskFile({ template: SUC_LIKE_TEMPLATE, id: 'x', today: '2026-11-25', automationName: 'A', agentLabel: 'Claude Code',
    card: { title: 't', goal: 'g', plan: [], priority: 'med' } })).meta;
  assert.equal(keyless.source_key, undefined);
});

test('buildTaskFile: awkward templates and text (Review Focus 4, 5)', () => {
  assert.equal(parseFrontmatter(NC.buildTaskFile({ template: null, card: { title: '[P1] Fix [x]', goal: 'g', plan: [], priority: 'med' }, id: 'x', today: '2026-11-25', automationName: '[Daily]', agentLabel: 'Claude Code' })).meta.title, '[P1] Fix [x]');
  assert.equal(parseFrontmatter(NC.buildTaskFile({ template: null, card: { title: "'quoted' rest", goal: 'g', plan: [], priority: 'med' }, id: 'x', today: '2026-11-25', automationName: '[Daily]', agentLabel: 'Claude Code' })).meta.created_by, '[Daily]');
  const card = { title: '- a: "b"\n---', goal: '## Heading', plan: [], priority: 'med', context: '```\n## Sneaky' };
  const templates = [null, SUC_LIKE_TEMPLATE.replace(/\n/g, '\r\n'), '---\nid: ""\ntitle: ""\nstatus: backlog\n---\n',
    SUC_LIKE_TEMPLATE.replace(/## Plan[\s\S]*?(?=## Progress log)/, ''), 'no frontmatter at all\n'];
  for (const template of templates) {
    const raw = NC.buildTaskFile({ template, card, id: 'x', today: '2026-11-25', automationName: 'A', agentLabel: 'Claude Code', fromCardId: 'job-1' });
    assert.doesNotMatch(raw, /\r/);
    const { meta, body } = parseFrontmatter(raw);
    assert.equal(meta.status, 'backlog', String(template).slice(0, 20));
    assert.equal(meta.title, '- a: "b" ---');
    const heads = body.split('\n').filter((l) => /^## /.test(l));
    assert.deepEqual(heads.filter((h) => ['## Goal', '## Context / key facts', '## Plan', '## Progress log'].includes(h)),
      ['## Goal', '## Context / key facts', '## Plan', '## Progress log']);
    assert.doesNotMatch(body, /^## Heading/m);
    assert.doesNotMatch(body, /^## Sneaky/m);
    assert.match(body, /- \[ \] Look at the source and plan this/);
    assert.match(body, /- 2026-11-25 — Created by automation "A" \(Claude Code\) from \[\[job-1\]\]\./);
  }
});

// ---------- Board index, duplicates, caps, the queue (spec §6) ----------
const task = (id, title, status = 'backlog', extra = '') => `---\nid: ${id}\ntitle: "${title}"\nstatus: ${status}\n${extra}---\n\n## Goal\ng\n`;
// A temp vault with a Work board; returns paths and a writer over it.
function vaultWith(t, files = {}, opts = {}) {
  const vault = tmpBoard(t, Object.fromEntries(Object.entries(files).map(([k, v]) => [`Work/${k}`, v])));
  fs.mkdirSync(path.join(vault, 'Work', 'tickets'), { recursive: true });
  const boardDir = path.join(vault, 'Work');
  const destDir = path.join(boardDir, 'tickets');
  const created = [];
  const writer = NC.createCardWriter({ vaultDir: vault, ...opts });
  const begin = (more = {}) => writer.begin({ boardDir, destDir, max: 5, automationName: 'Queue', agentLabel: 'Claude Code', trial: false,
    today: '2026-11-25', tz: 'UTC', onCreate: async () => { created.push(1); }, ...more });
  return { vault, boardDir, destDir, writer, begin, created };
}
const C = (title, key) => ({ title, goal: 'g', plan: [], priority: 'med', ...(key ? { key } : {}) });

test('boardIndex: keys board-wide incl. archive and Done; existing = direct children of dest', async (t) => {
  const v = vaultWith(t, { 'tickets/A-1/task.md': task('A-1', 'One'), 'archive/old/task.md': task('old', 'Old', 'done', 'source_key: B-2\n'),
    'other/C-3/task.md': task('C-3', 'Three', 'done'), '_cancelled/D-4/task.md': task('D-4', 'Four'), '_tasks/_Templates/task.md': task('""', ''),
    'tickets/deep/E-5/task.md': task('E-5', 'Five') });
  const ix = await NC.boardIndex(v.boardDir, v.destDir);
  for (const k of ['a-1', 'b-2', 'old', 'c-3', 'd-4', 'e-5']) assert.ok(ix.keys.includes(k), k);
  assert.ok(!ix.keys.includes(''));
  assert.deepEqual(ix.existing, [{ id: 'A-1', title: 'One', status: 'backlog' }]);
});

test('add: creates <dest>/<KEY>/task.md, calls onCreate, updates the index', async (t) => {
  const v = vaultWith(t);
  const run = await v.begin();
  const r = await run.add(C('Reset MFA', 'SUC-1'));
  assert.deepEqual(r, { created: { path: 'Work/tickets/SUC-1/task.md', id: 'SUC-1', title: 'Reset MFA', key: 'SUC-1' } });
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(v.destDir, 'SUC-1', 'task.md'), 'utf8'));
  assert.equal(meta.title, 'Reset MFA');
  assert.equal(meta.created_by, 'Queue');
  assert.equal(v.created.length, 1);
  assert.ok(run.index.keys.includes('suc-1'));
  assert.deepEqual(run.index.existing.map((e) => e.id), ['SUC-1']);
  assert.deepEqual(fs.readdirSync(path.join(v.destDir, 'SUC-1')), ['task.md']);
  const k = await run.add(C('Keyless one'), { fromCardId: 'job-1' });
  assert.equal(k.created.path, 'Work/tickets/keyless-one/task.md');
  assert.equal('key' in k.created, false);
  assert.match(fs.readFileSync(path.join(v.destDir, 'keyless-one', 'task.md'), 'utf8'), /from \[\[job-1\]\]/);
});

test('add: uses the board template when there is one', async (t) => {
  const v = vaultWith(t, { '_tasks/_Templates/task.md': SUC_LIKE_TEMPLATE });
  const r = await (await v.begin()).add(C('T', 'X-1'));
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(v.vault, r.created.path), 'utf8')).meta.owner, 'Owner-from-template');
});

test('duplicates (Review Focus 2, 3)', async (t) => {
  const v = vaultWith(t, { 'elsewhere/SUC-1/task.md': task('SUC-1', 'Old one', 'done'), 'tickets/reset-mfa/task.md': task('reset-mfa', 'Reset MFA'),
    'tickets/plain/.keep': '' });
  const run = await v.begin();
  assert.deepEqual(await run.add(C('Again', 'suc-1')), { notCreated: { title: 'Again', key: 'suc-1', reason: 'suc-1 already has a card' } });
  assert.ok((await run.add(C('Nine', 'SUC-9'))).created);
  assert.deepEqual(await run.add(C('Nine again', 'suc-9')), { notCreated: { title: 'Nine again', key: 'suc-9', reason: 'duplicate in this run' } });
  assert.deepEqual(await run.add(C('reset   MFA ')), { notCreated: { title: 'reset   MFA ', reason: 'a card with that title already exists' } });
  assert.deepEqual(await run.add(C('Plain')), { notCreated: { title: 'Plain', reason: 'a folder called plain already exists' } });
  assert.deepEqual(fs.readdirSync(path.join(v.destDir, 'plain')), ['.keep']);
  assert.ok((await run.add(C('Brand new'))).created);
  assert.deepEqual(await run.add(C('Brand  New')), { notCreated: { title: 'Brand  New', reason: 'duplicate in this run' } });
});

test('caps: per run counts created only; hourly across runs; trials write nothing and do not count', async (t) => {
  let clock = Date.UTC(2026, 10, 25, 8);
  const v = vaultWith(t, { 'tickets/D-0/task.md': task('D-0', 'Dup') }, { now: () => clock, perHour: 3 });
  const run = await v.begin({ max: 2 });
  const out = [];
  for (const c of [C('a', 'A-1'), C('d', 'D-0'), C('b', 'B-1'), C('c', 'C-1')]) out.push(await run.add(c));
  assert.equal(out.filter((r) => r.created).length, 2);
  assert.equal(out[1].notCreated.reason, 'D-0 already has a card');
  assert.equal(out[3].notCreated.reason, 'not created (over the limit of 2)');
  const trial = await v.begin({ trial: true });
  const tr = await trial.add(C('t', 'T-1'));
  assert.equal(tr.created.path, 'Work/tickets/T-1/task.md');
  assert.equal(fs.existsSync(path.join(v.destDir, 'T-1')), false);
  assert.equal(v.created.length, 2);
  const run2 = await v.begin();
  assert.ok((await run2.add(C('e', 'E-1'))).created);
  assert.equal((await run2.add(C('f', 'F-1'))).notCreated.reason, 'not created (3 an hour across automations)');
  clock += 3601 * 1000;
  assert.ok((await (await v.begin()).add(C('f', 'F-1'))).created);   // a new run: F-1 was already proposed in run2
  const trial2 = await v.begin({ trial: true, max: 1 });
  assert.ok((await trial2.add(C('g', 'G-1'))).created);
  assert.equal((await trial2.add(C('h', 'H-1'))).notCreated.reason, 'not created (over the limit of 1)');
  assert.equal((await trial2.add(C('a', 'A-1'))).notCreated.reason, 'A-1 already has a card');
});

test('concurrent adds from two runs are serialised: one folder, one duplicate', async (t) => {
  const v = vaultWith(t);
  const [r1, r2] = await Promise.all([v.begin(), v.begin()]);
  const res = await Promise.all([r1.add(C('Z', 'Z-1')), r2.add(C('Z too', 'Z-1'))]);
  assert.equal(res.filter((r) => r.created).length, 1);
  assert.equal(res.find((r) => r.notCreated).notCreated.reason, 'Z-1 already has a card');
  assert.deepEqual(fs.readdirSync(v.destDir), ['Z-1']);
});

test('a failing onCreate does not undo the card', async (t) => {
  const v = vaultWith(t);
  const r = await (await v.begin({ onCreate: async () => { throw new Error('board regen failed'); } })).add(C('x', 'X-9'));
  assert.ok(r.created);
  assert.ok(fs.existsSync(path.join(v.destDir, 'X-9', 'task.md')));
});
