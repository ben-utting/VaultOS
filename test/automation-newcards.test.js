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
