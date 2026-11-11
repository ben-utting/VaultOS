'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/automation-note');

const automation = { name: 'Morning check-in', level: 'report', prompt: 'Look at this card.' };
const card = { title: 'T', status: 'in-progress', updated: '2026-11-01' };
const fence = '```';

test('buildPrompt carries the card, the level paragraph and the instructions', () => {
  const p = N.buildPrompt({ automation, card, taskRaw: '---\nid: x\n---\nBODY\n', today: '2026-11-11', tz: 'Europe/London' });
  assert.ok(p.startsWith('You are running unattended for the VaultOS automation "Morning check-in". Nobody is watching: don\'t ask questions, don\'t wait for input.\n'));
  assert.ok(p.includes('Today is 2026-11-11 (Europe/London). Card: "T", status in-progress, last updated 2026-11-01.\nIts folder is your working directory.\n'));
  assert.ok(p.includes("Don't try to change anything: VaultOS writes your note into the card."));
  assert.ok(p.includes("Here is the card's task.md:\n----- task.md -----\n---\nid: x\n---\nBODY\n----- end of task.md -----\n"));
  assert.ok(p.includes('\nLook at this card.\n'));
  assert.ok(p.endsWith(N.noteInstructions('report')));
});

test('buildPrompt uses the update and work paragraphs', () => {
  const up = N.buildPrompt({ automation: { ...automation, level: 'update' }, card, taskRaw: 'x', today: '2026-11-11', tz: 'UTC' });
  assert.ok(up.includes('You may propose a status change in a vaultos-update block.'));
  assert.ok(up.endsWith(N.noteInstructions('update')));
  assert.ok(N.noteInstructions('update').includes('Never propose done.'));
  const work = N.buildPrompt({ automation: { ...automation, level: 'work' }, card, taskRaw: 'x', today: '2026-11-11', tz: 'UTC' });
  assert.ok(work.includes("You may edit files in this card's folder."));
});

test('buildPrompt cuts task.md at 60 KB', () => {
  const big = 'a'.repeat(70 * 1024);
  const p = N.buildPrompt({ automation, card, taskRaw: big, today: '2026-11-11', tz: 'UTC' });
  assert.ok(p.includes('a'.repeat(60 * 1024) + '\n(cut short: read task.md for the rest)\n----- end of task.md -----'));
  assert.ok(!p.includes('a'.repeat(60 * 1024 + 1)));
});

test('parseOutput takes the last note block', () => {
  const out = `thinking\n${fence}vaultos-note\nfirst\n${fence}\nmore\n${fence}vaultos-note\n  second note \n${fence}\n`;
  assert.deepEqual(N.parseOutput(out, 'report'), { note: 'second note', cut: false, update: null, ignored: [] });
});

test('parseOutput: no block or an empty block gives no note', () => {
  assert.equal(N.parseOutput('just words', 'report').note, null);
  assert.equal(N.parseOutput(`${fence}vaultos-note\n   \n${fence}`, 'report').note, null);
  assert.equal(N.parseOutput(`${fence}vaultos-note\nnever closed`, 'report').note, null);
});

test('parseOutput cuts a long note at a line break', () => {
  const line = 'x'.repeat(39);
  const body = Array(40).fill(line).join('\n');
  const r = N.parseOutput(`${fence}vaultos-note\n${body}\n${fence}`, 'report');
  assert.equal(r.cut, true);
  assert.ok(r.note.endsWith('\n(cut short)'));
  const kept = r.note.slice(0, -'\n(cut short)'.length);
  assert.ok(kept.length <= 1500);
  assert.ok(kept.endsWith(line));
});

test('parseOutput reads vaultos-update only at update level', () => {
  const out = `${fence}vaultos-update\nstatus: blocked\nblocked_by: vendor\nfoo: x\n${fence}\n${fence}vaultos-note\nn\n${fence}`;
  assert.deepEqual(N.parseOutput(out, 'update'), { note: 'n', cut: false, update: { status: 'blocked', blocked_by: 'vendor' }, ignored: ['foo'] });
  assert.deepEqual(N.parseOutput(out, 'report'), { note: 'n', cut: false, update: null, ignored: ['vaultos-update block (not an Update automation)'] });
});

test('parseOutput ignores status done, unknown statuses and a bad scheduled_for', () => {
  const block = (body) => `${fence}vaultos-update\n${body}\n${fence}\n${fence}vaultos-note\nn\n${fence}`;
  assert.deepEqual(N.parseOutput(block('status: done'), 'update').update, {});
  assert.deepEqual(N.parseOutput(block('status: done'), 'update').ignored, ['status: done']);
  assert.deepEqual(N.parseOutput(block('status: sideways'), 'update').ignored, ['status: sideways']);
  const r = N.parseOutput(block('status: scheduled\nscheduled_for: soon'), 'update');
  assert.deepEqual(r.update, { status: 'scheduled' });
  assert.deepEqual(r.ignored, ['scheduled_for: soon']);
  assert.deepEqual(N.parseOutput(block('scheduled_for: 2026-12-01'), 'update').update, { scheduled_for: '2026-12-01' });
});

test('parseOutput accepts longer fences', () => {
  assert.equal(N.parseOutput('````vaultos-note\nhas ``` inside\n````', 'report').note, 'has ``` inside');
});

test('stampText formats in the zone', () => {
  assert.equal(N.stampText(Date.parse('2026-11-11T08:03:00Z'), 'Europe/London'), '11 Nov 2026, 08:03');
  assert.equal(N.stampText(Date.parse('2026-07-01T08:03:00Z'), 'Europe/London'), '1 Jul 2026, 09:03');
});

test('sectionLines layout', () => {
  assert.deepEqual(
    N.sectionLines({ stamp: '11 Nov 2026, 08:03', automationName: 'Morning check-in', agentLabel: 'Claude Code', note: 'a\nb' }),
    ['_11 Nov 2026, 08:03 · Morning check-in · Claude Code_', '', 'a', 'b'],
  );
});
