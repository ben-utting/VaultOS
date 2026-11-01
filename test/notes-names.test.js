'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/notes-names');

const zone = 'Europe/London';
const at = new Date('2026-11-01T09:12:00Z');

test('captureBase: London date and time, then the first line\'s words', () => {
  assert.equal(N.captureBase('Clubhouse should announce delays\nmore', at, zone), '2026-11-01 0912 Clubhouse should announce delays');
});

test('captureBase: summer time moves the date and hour', () => {
  assert.equal(N.captureBase('x', new Date('2026-07-01T23:30:00Z'), zone), '2026-07-02 0030 x');
});

test('captureBase: nothing usable on the first line leaves the bare timestamp', () => {
  assert.equal(N.captureBase('???', at, zone), '2026-11-01 0912');
  assert.equal(N.captureBase('  \nsecond', at, zone), '2026-11-01 0912');
  assert.equal(N.captureBase('[[ ]] #tag', at, zone), '2026-11-01 0912 tag');
});

test('captureBase: at most 60 characters, cut at a word', () => {
  const b = N.captureBase('a'.repeat(30) + ' ' + 'b'.repeat(30), at, zone);
  assert.ok(b.length <= 60, b);
  assert.ok(b.endsWith('a'.repeat(30)), b);
});

test('cleanName drops characters Obsidian or Windows refuse', () => {
  assert.equal(N.cleanName('Why: a/b? "c" <d> | e*. '), 'Why ab c d e');
});

test('cleanName hard-cuts one long word', () => {
  assert.equal(N.cleanName('x'.repeat(80), 10), 'x'.repeat(10));
});

test('uniqueName counts up past taken names', () => {
  assert.equal(N.uniqueName('n', () => false), 'n.md');
  assert.equal(N.uniqueName('n', (x) => x === 'n.md' || x === 'n 2.md'), 'n 3.md');
});

test('captureBody: stamp, blank line, the text, one newline', () => {
  assert.equal(N.captureBody('line one\nline two\n\n\n', at, zone), '2026-11-01 09:12\n\nline one\nline two\n');
});
