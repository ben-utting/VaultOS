'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LearnError, checkNotebookName, safeTitle, uniqueName, stamp } = require('../lib/learn-names');

const is400 = (e) => e instanceof LearnError && e.status === 400;

test('notebook names are trimmed and kept', () => {
  assert.equal(checkNotebookName('  Cloud basics '), 'Cloud basics');
  assert.equal(checkNotebookName('trail '), 'trail');
  assert.equal(checkNotebookName('a'.repeat(60)).length, 60);
  assert.equal(checkNotebookName('Café & co (2)'), 'Café & co (2)');
});

test('notebook names that Windows or the vault would refuse are 400', () => {
  for (const bad of ['', ' ', 'a/b', 'a\\b', 'x:y', 'what?', 'a*b', 'a"b', 'a<b', 'a>b', 'a|b', '.hidden', '_tasks',
    'trail.', 'a'.repeat(61), 'tab\there', 'nul', 'COM1', 'lpt9.notes', 42, null]) {
    assert.throws(() => checkNotebookName(bad), is400, JSON.stringify(bad));
  }
});

test('LearnError carries a status', () => {
  const e = new LearnError(409, 'taken');
  assert.equal(e.status, 409);
  assert.equal(e.message, 'taken');
  assert.ok(e instanceof Error);
});

test('safeTitle swaps illegal characters for spaces and collapses them', () => {
  assert.equal(safeTitle('Part 3: Modules / Outputs?', { max: 100, fallback: 'x' }), 'Part 3 Modules Outputs');
  assert.equal(safeTitle('  tabs\tand\nnewlines  ', { max: 100, fallback: 'x' }), 'tabs and newlines');
});

test('safeTitle never returns an illegal or empty name (Review Focus 2)', () => {
  assert.equal(safeTitle('???', { max: 100, fallback: 'dQw4w9WgXcQ' }), 'dQw4w9WgXcQ');
  assert.equal(safeTitle('', { max: 100, fallback: 'vid' }), 'vid');
  assert.equal(safeTitle('🎉🎉', { max: 100, fallback: 'vid' }), '🎉🎉');
  assert.equal(safeTitle('CON', { max: 100, fallback: 'vid' }), 'CON video');
  assert.equal(safeTitle('aux.part', { max: 100, fallback: 'vid' }), 'aux.part video');
  assert.equal(safeTitle('...', { max: 100, fallback: 'vid' }), 'vid');
  assert.equal(safeTitle('.hidden title', { max: 100, fallback: 'vid' }), 'hidden title');
  assert.ok(!/[. ]$/.test(safeTitle('ends with dot.', { max: 100, fallback: 'v' })));
  const long = safeTitle('w '.repeat(200), { max: 100, fallback: 'v' });
  assert.ok(long.length <= 100 && long.length > 0 && !/[. ]$/.test(long));
});

test('safeTitle never splits an emoji when it cuts', () => {
  const t = safeTitle('a' + '🎉'.repeat(10), { max: 6, fallback: 'v' });
  assert.ok(t.length <= 6);
  assert.ok(!/[\uD800-\uDBFF]$/.test(t), 'no lone high surrogate at the end');
});

test('uniqueName adds (2), (3) case-insensitively', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await uniqueName(dir, 'a', '.txt'), 'a.txt');
  fs.writeFileSync(path.join(dir, 'A.txt'), '');
  fs.writeFileSync(path.join(dir, 'a (2).txt'), '');
  assert.equal(await uniqueName(dir, 'a', '.txt'), 'a (3).txt');
  assert.equal(await uniqueName(path.join(dir, 'missing'), 'b', '.png'), 'b.png');
});

test('stamp uses the time zone', () => {
  assert.deepEqual(stamp(new Date('2026-11-13T23:30:00Z'), 'Asia/Tokyo'), { day: '2026-11-14', time: '0830' });
  assert.deepEqual(stamp(new Date('2026-11-13T00:05:00Z'), 'UTC'), { day: '2026-11-13', time: '0005' });
});
