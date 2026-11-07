'use strict';

// The grid's edit history (undo/redo steps, folding past the limit, a save's checkpoint). sheet-grid.js is a
// browser script; it is loaded in a bare context with only what it reads when it loads (window.SheetCore),
// and its pure history model taken from window.SheetGrid.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const window = { SheetCore: require('../public/sheet-core') };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sheet-grid.js'), 'utf8'), { window });
const { createHistory } = window.SheetGrid;
const plain = (x) => JSON.parse(JSON.stringify(x));   // arrays from the other realm, as plain values

const set = (r, v) => ({ op: 'set', sheet: 0, r, c: 0, v });
const step = (si, ...ops) => ({ si, ops });

test('ops() lists every applied step in order; undo/redo move steps between the stacks', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'a')));
  h.add(step(0, set(1, 'b'), set(2, 'c')));
  assert.deepEqual(plain(h.ops()), [set(0, 'a'), set(1, 'b'), set(2, 'c')]);
  assert.deepEqual(plain(h.undo().group.ops), [set(1, 'b'), set(2, 'c')]);
  assert.deepEqual(plain(h.ops()), [set(0, 'a')]);
  assert.deepEqual(plain(h.redo().group.ops), [set(1, 'b'), set(2, 'c')]);
  assert.equal(h.ops().length, 3);
  assert.equal(h.redo(), null);
});

test('a new step clears redo', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'a')));
  h.undo();
  h.add(step(0, set(1, 'b')));
  assert.equal(h.redo(), null);
  assert.deepEqual(plain(h.ops()), [set(1, 'b')]);
});

test('applied(si) is the undoable steps of one sheet, for replaying on its base', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'a')));
  h.add(step(1, { op: 'set', sheet: 3, r: 0, c: 0, v: 'x' }));
  h.add(step(0, set(1, 'b')));
  assert.deepEqual(plain(h.applied(0)), [set(0, 'a'), set(1, 'b')]);
  assert.equal(h.applied(1).length, 1);
});

test('past the limit the oldest steps fold: still in ops(), no longer undoable', () => {
  const h = createHistory(2);
  assert.equal(h.add(step(0, set(0, 'a'))).length, 0);
  h.add(step(0, set(1, 'b')));
  const folded = h.add(step(0, set(2, 'c')));
  assert.deepEqual(plain(folded.map((g) => g.ops)), [[set(0, 'a')]]);
  assert.equal(h.ops().length, 3);
  assert.deepEqual(plain(h.applied(0)), [set(1, 'b'), set(2, 'c')]);
  assert.ok(h.undo().group);
  assert.ok(h.undo().group);
  assert.equal(h.undo(), null);                        // the folded step stays
  assert.deepEqual(plain(h.ops()), [set(0, 'a')]);
});

test('checkpoint: undo stops at the mark; opsSince(mark) is only what came after', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'sent')));
  const mark = h.checkpoint();
  h.add(step(0, set(1, 'later')));
  assert.deepEqual(plain(h.opsSince(mark)), [set(1, 'later')]);
  assert.ok(h.undo().group, 'a step after the mark can be undone');
  assert.deepEqual(plain(h.opsSince(mark)), []);
  assert.deepEqual(plain(h.undo()), { paused: true }, 'the sent step cannot');
  assert.deepEqual(plain(h.ops()), [set(0, 'sent')]);
  h.redo();
  assert.deepEqual(plain(h.opsSince(mark)), [set(1, 'later')]);
});

test('release(mark) lets undo through again', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'sent')));
  const mark = h.checkpoint();
  assert.deepEqual(plain(h.undo()), { paused: true });
  h.release(mark);
  assert.ok(h.undo().group);
  assert.equal(h.ops().length, 0);
});

test('a step undone before the save and redone during it counts as after the mark', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'kept')));
  h.add(step(0, set(1, 'undone')));
  h.undo();                                            // not in what the save sends
  const mark = h.checkpoint();
  h.redo();
  assert.deepEqual(plain(h.opsSince(mark)), [set(1, 'undone')]);
  assert.ok(h.undo().group, 'and it can be undone again');
});

test('steps after the mark that fold away still come back from opsSince', () => {
  const h = createHistory(2);
  h.add(step(0, set(0, 'sent')));
  const mark = h.checkpoint();
  h.add(step(0, set(1, 'a')));
  h.add(step(0, set(2, 'b')));
  h.add(step(0, set(3, 'c')));                         // folds 'sent' and then 'a'
  assert.deepEqual(plain(h.opsSince(mark)), [set(1, 'a'), set(2, 'b'), set(3, 'c')]);
  assert.equal(h.ops().length, 4);
});

test('reset() empties everything, pins included', () => {
  const h = createHistory(500);
  h.add(step(0, set(0, 'a')));
  h.checkpoint();
  h.reset();
  assert.deepEqual(plain(h.sizes()), { undo: 0, redo: 0, folded: 0, pins: 0 });
  assert.equal(h.ops().length, 0);
  h.add(step(0, set(0, 'b')));
  assert.ok(h.undo().group);
});
