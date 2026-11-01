'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const NC = require('../public/notes-core');

test('wikiSegments splits links, resolving known names', () => {
  assert.deepEqual(NC.wikiSegments('see [[AI]] and [[Gone#2|that]].', new Map([['ai', 'N/Main/AI.md']])), [
    { text: 'see ' },
    { label: 'AI', target: 'AI', anchor: null, path: 'N/Main/AI.md' },
    { text: ' and ' },
    { label: 'that', target: 'Gone', anchor: '2', path: null },
    { text: '.' },
  ]);
});

test('wikiSegments leaves plain and unclosed text alone', () => {
  assert.deepEqual(NC.wikiSegments('no links', new Map()), [{ text: 'no links' }]);
  assert.deepEqual(NC.wikiSegments('[[open', new Map()), [{ text: '[[open' }]);
});

test('ageLabel', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(NC.ageLabel(now - 30e3, now), 'now');
  assert.equal(NC.ageLabel(now - 5 * 60e3, now), '5m');
  assert.equal(NC.ageLabel(now - 2 * 3600e3, now), '2h');
  assert.equal(NC.ageLabel(now - 3 * 86400e3, now), '3d');
  assert.equal(NC.ageLabel(now - 35 * 86400e3, now), '5w');
});

const k = (o) => NC.captureKeyIntent({ key: 'j', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isMac: false, boxOpen: false, inEditable: false, inTerminal: false, ...o });
test('captureKeyIntent: Ctrl+J opens, ⌘J on a Mac', () => {
  assert.equal(k({ ctrlKey: true }), 'open');
  assert.equal(k({ key: 'J', ctrlKey: true }), 'open');
  assert.equal(k({ isMac: true, metaKey: true }), 'open');
});
test('captureKeyIntent: not in a terminal, a text field, with the box open, Ctrl on a Mac, or with Shift', () => {
  assert.equal(k({ ctrlKey: true, inTerminal: true }), null);
  assert.equal(k({ ctrlKey: true, inEditable: true }), null);
  assert.equal(k({ ctrlKey: true, boxOpen: true }), null);
  assert.equal(k({ isMac: true, ctrlKey: true }), null);
  assert.equal(k({ ctrlKey: true, shiftKey: true }), null);
  assert.equal(k({ key: 'k', ctrlKey: true }), null);
});

test('filterMain by status and tag', () => {
  const items = [
    { title: 'a', status: 'child', tags: ['AI'] },
    { title: 'b', status: 'baby', tags: ['AI', 'work'] },
    { title: 'c', status: null, tags: [] },
  ];
  assert.deepEqual(NC.filterMain(items, { status: 'child', tag: null }).map((i) => i.title), ['a']);
  assert.deepEqual(NC.filterMain(items, { status: null, tag: 'AI' }).map((i) => i.title), ['a', 'b']);
  assert.deepEqual(NC.filterMain(items, { status: 'baby', tag: 'work' }).map((i) => i.title), ['b']);
  assert.equal(NC.filterMain(items, { status: null, tag: null }).length, 3);
});
