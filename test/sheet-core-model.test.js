'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { applyOps, cfCss, matchListItem, cellText, compactOps } = require('../public/sheet-core');
const server = require('../lib/sheet-xlsx');
const { makeTracker } = require('./fixtures');

// A tracker-shaped sheet: header on row 0 (frozen), a merged section band on row 1, task rows 2..14 with a
// status list in column F and a conditional format that colours a row when its status cell reads 'Open'.
function T() {
  return {
    index: 0,
    name: 'Tracker',
    rowCount: 16,
    colCount: 7,
    cells: {
      '0,0': { t: 'Task', s: 0 }, '0,5': { t: 'Status', s: 0 },
      '1,0': { t: 'Section A', s: 1 }, '1,1': { s: 1 },
      '2,0': { t: 'Write spec' }, '2,5': { t: 'Open' },
      '3,0': { t: 'Review' }, '3,5': { t: 'Closed' },
      '5,0': { t: 'Ship' },
      '15,0': { t: 'Total' },
    },
    styles: ['font-weight:600', 'background:#dddddd;font-weight:600'],
    colWidths: [160, 80, 80, 80, 80, 90, 80],
    rowHeights: { 1: 28 },
    defaultRowHeight: 20,
    hiddenRows: [],
    hiddenCols: [],
    merges: [{ r1: 1, c1: 0, r2: 1, c2: 6 }],
    frozen: { rows: 1, cols: 0 },
    lists: [{ ranges: [{ r1: 2, c1: 5, r2: 14, c2: 5 }], items: ['Open', 'Closed'], strict: true }],
    cf: [{
      ranges: [{ r1: 2, c1: 0, r2: 14, c2: 6 }],
      rules: [{ kind: 'ref', op: 'eq', values: ['Open'], ref: { r: 0, c: 5, absR: false, absC: true }, css: 'background:#c00000', stop: false }],
    }],
    cfSkipped: 0,
    readOnly: null,
    rowOps: null,
    tooBig: false,
  };
}

const ins = (at, n, like) => ({ op: 'insertRows', sheet: 0, at, n, like });
const del = (at, n) => ({ op: 'deleteRows', sheet: 0, at, n });
const set = (r, c, v) => ({ op: 'set', sheet: 0, r, c, v });

// ---- the brief's tests ------------------------------------------------------

test('insert above section row', () => { const s = applyOps(T(), [ins(1, 1, 1)]); assert.deepEqual(s.merges, [{ r1: 2, c1: 0, r2: 2, c2: 6 }]); assert.deepEqual(s.lists[0].ranges[0], { r1: 3, c1: 5, r2: 15, c2: 5 }); assert.equal(s.rowCount, 17); });
test('insert inside range grows coverage once', () => assert.deepEqual(applyOps(T(), [ins(6, 2, 5)]).lists[0].ranges, [{ r1: 2, c1: 5, r2: 16, c2: 5 }]));
test('insert above first task row copies the list', () => assert.deepEqual(applyOps(T(), [ins(2, 1, 2)]).lists[0].ranges, [{ r1: 3, c1: 5, r2: 15, c2: 5 }, { r1: 2, c1: 5, r2: 2, c2: 5 }]));
test('delete band drops merge', () => assert.deepEqual(applyOps(T(), [{ op: 'deleteRows', sheet: 0, at: 1, n: 1 }]).merges, []));
test('set grows and tracks changes through row shifts', () => { const s = applyOps(T(), [set(40, 9, 'x'), set(5, 1, 'y'), ins(0, 1, null)]); assert.equal(s.rowCount, 42); assert.equal(s.colCount, 10); assert.ok(s.changed.has('6,1')); assert.ok(s.changed.has('41,9')); });
test('cfCss', () => { const s = applyOps(T(), [set(3, 5, 'open'), set(4, 5, 'Open ')]); assert.match(cfCss(s, 3, 5), /#c00000/); assert.equal(cfCss(s, 4, 5), ''); });
test('matchListItem', () => { assert.equal(matchListItem(['Open', 'Closed'], ' closed '), 'Closed'); assert.equal(matchListItem(['Open'], 'Nope'), null); });
test('compactOps', () => assert.deepEqual(compactOps([set(1, 1, 'a'), set(1, 1, 'b'), ins(0, 1, null), set(2, 1, 'c')]), [set(1, 1, 'b'), ins(0, 1, null), set(2, 1, 'c')]));

// ---- set --------------------------------------------------------------------

test('set stores the text, drops the edit text and marks the cell changed', () => {
  const base = T();
  base.cells['2,5'] = { t: '£15.00', e: '15', s: 1 };
  const s = applyOps(base, [set(2, 5, '20')]);
  assert.deepEqual(s.cells['2,5'], { t: '20', s: 1 });
  assert.deepEqual([...s.changed], ['2,5']);
});

test("set '' keeps the style and drops text, edit text and formula", () => {
  const base = T();
  base.cells['2,5'] = { t: '£15.00', e: '15', s: 1, f: '=A1*2' };
  const s = applyOps(base, [set(2, 5, '')]);
  assert.deepEqual(s.cells['2,5'], { s: 1 });
  assert.ok(s.changed.has('2,5'));
});

test("set '' on a cell with nothing else removes the entry", () => {
  const s = applyOps(T(), [set(2, 0, ''), set(9, 9, '')]);
  assert.equal('2,0' in s.cells, false);
  assert.equal('9,9' in s.cells, false);
});

test('set inside bounds leaves rowCount and colCount alone', () => {
  const s = applyOps(T(), [set(15, 6, 'x')]);
  assert.equal(s.rowCount, 16);
  assert.equal(s.colCount, 7);
});

// ---- insert / delete --------------------------------------------------------

test('insert re-keys cells at and below the row and leaves the rows above', () => {
  const s = applyOps(T(), [ins(3, 2, null)]);
  assert.equal(cellText(s, 2, 0), 'Write spec');
  assert.equal(cellText(s, 3, 0), '');
  assert.equal(cellText(s, 4, 0), '');
  assert.equal(cellText(s, 5, 0), 'Review');
  assert.equal(cellText(s, 5, 5), 'Closed');
  assert.equal(cellText(s, 7, 0), 'Ship');
  assert.equal(cellText(s, 17, 0), 'Total');
  assert.equal(s.rowCount, 18);
});

test('delete drops the band, moves the rows below up and shrinks rowCount', () => {
  const s = applyOps(T(), [del(2, 2)]);
  assert.equal(cellText(s, 2, 0), '');
  assert.equal(cellText(s, 3, 0), 'Ship');
  assert.equal(cellText(s, 13, 0), 'Total');
  assert.equal(s.rowCount, 14);
  assert.deepEqual(s.lists[0].ranges, [{ r1: 2, c1: 5, r2: 12, c2: 5 }]);
  assert.deepEqual(s.cf[0].ranges, [{ r1: 2, c1: 0, r2: 12, c2: 6 }]);
});

test('delete past the last row changes nothing', () => {
  const s = applyOps(T(), [del(20, 3)]);
  assert.equal(s.rowCount, 16);
  assert.equal(cellText(s, 15, 0), 'Total');
});

test('insert at the end extends the sheet', () => {
  const s = applyOps(T(), [ins(16, 2, 15)]);
  assert.equal(s.rowCount, 18);
  assert.equal(cellText(s, 15, 0), 'Total');
});

test('a merge crossing the insertion point grows, a merge partly deleted shrinks, one cell wide goes', () => {
  const base = T();
  base.merges = [{ r1: 4, c1: 0, r2: 8, c2: 1 }, { r1: 10, c1: 2, r2: 11, c2: 2 }];
  assert.deepEqual(applyOps(base, [ins(6, 2, 5)]).merges, [{ r1: 4, c1: 0, r2: 10, c2: 1 }, { r1: 12, c1: 2, r2: 13, c2: 2 }]);
  assert.deepEqual(applyOps(base, [del(7, 2)]).merges, [{ r1: 4, c1: 0, r2: 6, c2: 1 }, { r1: 8, c1: 2, r2: 9, c2: 2 }]);
  assert.deepEqual(applyOps(base, [del(11, 1)]).merges, [{ r1: 4, c1: 0, r2: 8, c2: 1 }]);
});

test('rowHeights and hiddenRows shift with their rows and vanish with deleted ones', () => {
  const base = T();
  base.rowHeights = { 1: 28, 5: 40, 9: 50 };
  base.hiddenRows = [3, 9];
  const inserted = applyOps(base, [ins(4, 2, null)]);
  assert.deepEqual(inserted.rowHeights, { 1: 28, 7: 40, 11: 50 });
  assert.deepEqual(inserted.hiddenRows, [3, 11]);
  const deleted = applyOps(base, [del(5, 2)]);
  assert.deepEqual(deleted.rowHeights, { 1: 28, 7: 50 });
  assert.deepEqual(deleted.hiddenRows, [3, 7]);
});

test('inserted rows take like’s height and cell styles, never its text, hidden state or merge', () => {
  const base = T();
  base.hiddenRows = [1];
  const s = applyOps(base, [ins(1, 2, 1)]);
  assert.deepEqual(s.cells['1,0'], { s: 1 });
  assert.deepEqual(s.cells['1,1'], { s: 1 });
  assert.deepEqual(s.cells['2,0'], { s: 1 });
  assert.deepEqual(s.cells['3,0'], { t: 'Section A', s: 1 });     // the old row, moved
  assert.equal(s.cells['1,2'], undefined);                         // like had no cell there
  assert.equal(s.rowHeights[1], 28);
  assert.equal(s.rowHeights[2], 28);
  assert.equal(s.rowHeights[3], 28);
  assert.deepEqual(s.hiddenRows, [3]);
  assert.deepEqual(s.merges, [{ r1: 3, c1: 0, r2: 3, c2: 6 }]);
});

test('like is read from its row before the shift, whether it is at the insertion point or just above it', () => {
  const s = applyOps(T(), [ins(1, 1, 1)]);
  assert.deepEqual(s.cells['1,0'], { s: 1 });
  assert.deepEqual(s.cells['2,0'], { t: 'Section A', s: 1 });
  const above = applyOps(T(), [ins(2, 1, 1)]);                    // like = at - 1
  assert.deepEqual(above.cells['2,0'], { s: 1 });
  assert.deepEqual(above.cells['1,0'], { t: 'Section A', s: 1 });
});

test('a list covering the rows on both sides of the insertion point stays whole, even across separate ranges', () => {
  const s = applyOps(T(), [ins(2, 1, 2), ins(3, 1, 3)]);
  const rows = new Set();
  for (const rg of s.lists[0].ranges) for (let r = rg.r1; r <= rg.r2; r++) rows.add(r);
  assert.deepEqual([...rows].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('insert just below a list does not extend it, just above it only with like inside it', () => {
  assert.deepEqual(applyOps(T(), [ins(15, 1, 14)]).lists[0].ranges, [{ r1: 2, c1: 5, r2: 14, c2: 5 }, { r1: 15, c1: 5, r2: 15, c2: 5 }]);
  assert.deepEqual(applyOps(T(), [ins(15, 1, 15)]).lists[0].ranges, [{ r1: 2, c1: 5, r2: 14, c2: 5 }]);
  assert.deepEqual(applyOps(T(), [ins(2, 1, null)]).lists[0].ranges, [{ r1: 3, c1: 5, r2: 15, c2: 5 }]);
});

test('a list or conditional format with no rows left is dropped', () => {
  const s = applyOps(T(), [del(2, 13)]);
  assert.deepEqual(s.lists, []);
  assert.deepEqual(s.cf, []);
  assert.equal(s.rowCount, 3);
});

test('cf coverage follows like for new rows not already covered', () => {
  const edge = applyOps(T(), [ins(2, 1, 2)]);
  assert.deepEqual(edge.cf[0].ranges, [{ r1: 3, c1: 0, r2: 15, c2: 6 }, { r1: 2, c1: 0, r2: 2, c2: 6 }]);
  const inside = applyOps(T(), [ins(6, 2, 5)]);
  assert.deepEqual(inside.cf[0].ranges, [{ r1: 2, c1: 0, r2: 16, c2: 6 }]);
  const plain = applyOps(T(), [ins(2, 1, null)]);
  assert.deepEqual(plain.cf[0].ranges, [{ r1: 3, c1: 0, r2: 15, c2: 6 }]);
});

test('cf coverage is added per column run where like was covered', () => {
  const base = T();
  base.cf[0].ranges = [{ r1: 2, c1: 0, r2: 4, c2: 1 }, { r1: 2, c1: 3, r2: 4, c2: 3 }, { r1: 6, c1: 2, r2: 8, c2: 2 }];
  const s = applyOps(base, [ins(2, 2, 2)]);
  assert.deepEqual(s.cf[0].ranges.slice(3), [{ r1: 2, c1: 0, r2: 3, c2: 1 }, { r1: 2, c1: 3, r2: 3, c2: 3 }]);
});

// ---- the freeze line (Ruling 24) --------------------------------------------

function frozenAfter(frozen, ...ops) {
  const base = T();
  base.frozen = frozen;
  return applyOps(base, ops).frozen;
}

test('insert above or inside the frozen rows grows them, at or below the line does not', () => {
  const f = { rows: 3, cols: 2 };
  assert.deepEqual(frozenAfter(f, ins(0, 2, null)), { rows: 5, cols: 2 });
  assert.deepEqual(frozenAfter(f, ins(1, 2, 1)), { rows: 5, cols: 2 });
  assert.deepEqual(frozenAfter(f, ins(2, 1, 2)), { rows: 4, cols: 2 });
  assert.deepEqual(frozenAfter(f, ins(3, 4, 3)), { rows: 3, cols: 2 });
  assert.deepEqual(frozenAfter(f, ins(9, 4, 9)), { rows: 3, cols: 2 });
});

test('delete takes away only the frozen rows it covers', () => {
  const f = { rows: 3, cols: 2 };
  assert.deepEqual(frozenAfter(f, del(1, 1)), { rows: 2, cols: 2 });
  assert.deepEqual(frozenAfter(f, del(2, 3)), { rows: 2, cols: 2 });      // rows 2..4: only row 2 is frozen
  assert.deepEqual(frozenAfter(f, del(0, 10)), { rows: 0, cols: 2 });
  assert.deepEqual(frozenAfter(f, del(3, 2)), { rows: 3, cols: 2 });
  assert.deepEqual(frozenAfter(f, del(8, 2)), { rows: 3, cols: 2 });
});

test('the freeze line follows a series of row ops', () => {
  assert.deepEqual(frozenAfter({ rows: 2, cols: 0 }, ins(0, 1, null), del(0, 2), ins(5, 1, 5)), { rows: 1, cols: 0 });
});

// ---- changed / newRows ------------------------------------------------------

test('changed continues from the input sheet and shifts with it', () => {
  const base = T();
  base.changed = new Set(['5,1', '9,9']);
  const s = applyOps(base, [ins(5, 2, null), set(1, 1, 'z')]);
  assert.deepEqual([...s.changed].sort(), ['1,1', '11,9', '7,1']);
  assert.deepEqual([...base.changed].sort(), ['5,1', '9,9']);
});

test('deleting a row drops its changed cells', () => {
  const s = applyOps(T(), [set(5, 1, 'y'), set(8, 2, 'w'), del(5, 1)]);
  assert.deepEqual([...s.changed], ['7,2']);
});

test('newRows marks inserted rows and follows later row ops', () => {
  const s = applyOps(T(), [ins(3, 2, null)]);
  assert.deepEqual([...s.newRows].sort(), [3, 4]);
  const later = applyOps(s, [ins(0, 1, null), del(4, 1)]);          // rows 3, 4 -> 4, 5; then 4 goes and 5 -> 4; row 0 is new too
  assert.deepEqual([...later.newRows].sort((a, b) => a - b), [0, 4]);
  assert.deepEqual([...s.newRows].sort(), [3, 4]);
});

test('a sheet from the server starts with nothing changed or new', () => {
  const s = applyOps(T(), []);
  assert.equal(s.changed.size, 0);
  assert.equal(s.newRows.size, 0);
});

// ---- purity and contract checks ---------------------------------------------

test('applyOps leaves its input alone', () => {
  const base = T();
  base.changed = new Set(['1,1']);
  base.newRows = new Set([4]);
  const before = JSON.stringify({ ...base, changed: [...base.changed], newRows: [...base.newRows] });
  const out = applyOps(base, [set(40, 9, 'x'), ins(1, 2, 1), del(3, 4)]);
  assert.notEqual(out, base);
  assert.equal(JSON.stringify({ ...base, changed: [...base.changed], newRows: [...base.newRows] }), before);
  out.cells['1,0'].t = 'mutated';
  out.lists[0].items.push('x');
  out.cf[0].rules[0].css = 'x';
  assert.equal(JSON.stringify({ ...base, changed: [...base.changed], newRows: [...base.newRows] }), before);
});

test('an op for another sheet throws', () => {
  assert.throws(() => applyOps(T(), [{ op: 'set', sheet: 1, r: 0, c: 0, v: 'x' }]), /sheet/i);
  assert.throws(() => applyOps(T(), [{ op: 'deleteRows', sheet: 2, at: 0, n: 1 }]), /sheet/i);
});

test('unknown ops, bad numbers and a like that is not adjacent throw', () => {
  assert.throws(() => applyOps(T(), [{ op: 'nope', sheet: 0 }]));
  assert.throws(() => applyOps(T(), [set(-1, 0, 'x')]));
  assert.throws(() => applyOps(T(), [{ op: 'set', sheet: 0, r: 0, c: 0, v: 5 }]));
  assert.throws(() => applyOps(T(), [del(1, 0)]));
  assert.throws(() => applyOps(T(), [ins(5, 1, 2)]));
});

// ---- cellText ---------------------------------------------------------------

test('cellText gives the display text or an empty string', () => {
  const s = T();
  assert.equal(cellText(s, 2, 5), 'Open');
  assert.equal(cellText(s, 1, 1), '');          // styled only
  assert.equal(cellText(s, 30, 30), '');
});

// ---- cfCss ------------------------------------------------------------------

function withRules(...rules) {
  const s = T();
  s.cf = [{ ranges: [{ r1: 2, c1: 0, r2: 14, c2: 6 }], rules }];
  return s;
}
const cellRule = (op, values, css, stop = false) => ({ kind: 'cell', op, values, css, stop });

test('cfCss ignores cells outside the ranges', () => {
  const s = T();
  s.cells['1,5'] = { t: 'Open' };
  assert.equal(cfCss(s, 1, 5), '');
  assert.match(cfCss(s, 2, 5), /#c00000/);
});

test('cfCss ref rule: relative parts are offsets from the evaluated cell, absolute ones are indices', () => {
  const rel = withRules({ kind: 'ref', op: 'eq', values: ['Review'], ref: { r: 1, c: -5, absR: false, absC: false }, css: 'color:#111111', stop: false });
  assert.equal(cfCss(rel, 2, 5), 'color:#111111');                  // reads (2 + 1, 5 - 5) = (3, 0) = 'Review'
  assert.equal(cfCss(rel, 3, 5), '');                               // reads (4, 0), which is empty
});

test('cfCss ref rule with an absolute row reads that row for every cell', () => {
  const s = withRules({ kind: 'ref', op: 'eq', values: ['Status'], ref: { r: 0, c: 5, absR: true, absC: true }, css: 'color:#222222', stop: false });
  assert.equal(cfCss(s, 7, 2), 'color:#222222');
  s.cells['0,5'].t = 'other';
  assert.equal(cfCss(s, 7, 2), '');
});

test('an absolute row ref follows its row through inserts and its rule is dropped when the row is deleted', () => {
  const base = withRules(
    { kind: 'ref', op: 'eq', values: ['Status'], ref: { r: 0, c: 5, absR: true, absC: true }, css: 'color:#222222', stop: false },
    { kind: 'ref', op: 'eq', values: ['Open'], ref: { r: 0, c: 5, absR: false, absC: true }, css: 'background:#c00000', stop: false });
  const inserted = applyOps(base, [ins(0, 1, null)]);
  assert.equal(inserted.cf[0].rules[0].ref.r, 1);
  assert.equal(inserted.cf[0].rules[1].ref.r, 0);                    // relative: an offset, so unchanged
  assert.equal(cfCss(inserted, 8, 2), 'color:#222222');

  const deleted = applyOps(base, [del(0, 1)]);
  assert.equal(deleted.cf[0].rules.length, 1);
  assert.equal(deleted.cf[0].rules[0].ref.absR, false);
  assert.equal(deleted.cfSkipped, 1);

  const alone = withRules(base.cf[0].rules[0]);
  assert.deepEqual(applyOps(alone, [del(0, 1)]).cf, []);
});

test('cfCss cell rule: between is inclusive and compares numbers as numbers', () => {
  const s = withRules(cellRule('between', [10, 20], 'color:#00aa00'));
  for (const [text, hit] of [['15', true], ['10', true], ['20', true], ['9', false], ['21', false], ['2', false], ['abc', false], ['15.5', true]]) {
    s.cells['4,1'] = { t: text };
    assert.equal(cfCss(s, 4, 1) !== '', hit, text);
  }
});

test('cfCss cell rule reads the edit text when the display text is formatted', () => {
  const s = withRules(cellRule('gt', [100], 'color:#aa0000'));
  s.cells['4,1'] = { t: '£1,250.00', e: '1250' };
  assert.equal(cfCss(s, 4, 1), 'color:#aa0000');
  s.cells['4,1'] = { t: '£50.00', e: '50' };
  assert.equal(cfCss(s, 4, 1), '');
});

test('cfCss notBetween, ne and the ordering operators', () => {
  const s = withRules(cellRule('notBetween', [10, 20], 'color:#111111'));
  s.cells['4,1'] = { t: '25' };
  assert.equal(cfCss(s, 4, 1), 'color:#111111');
  s.cells['4,1'] = { t: '12' };
  assert.equal(cfCss(s, 4, 1), '');
  const ne = withRules(cellRule('ne', ['done'], 'color:#222222'));
  ne.cells['4,1'] = { t: 'DONE' };
  assert.equal(cfCss(ne, 4, 1), '');
  ne.cells['4,1'] = { t: 'open' };
  assert.equal(cfCss(ne, 4, 1), 'color:#222222');
  const ge = withRules(cellRule('ge', [5], 'color:#333333'), cellRule('lt', [5], 'color:#444444'));
  ge.cells['4,1'] = { t: '5' };
  assert.equal(cfCss(ge, 4, 1), 'color:#333333');
  ge.cells['4,1'] = { t: '4.9' };
  assert.equal(cfCss(ge, 4, 1), 'color:#444444');
});

test('cfCss reads a blank cell as 0 beside a number and as empty text beside text', () => {
  const lt = withRules(cellRule('lt', [5], 'color:#111111'));
  assert.equal(cfCss(lt, 4, 1), 'color:#111111');
  const gt = withRules(cellRule('gt', [5], 'color:#111111'));
  assert.equal(cfCss(gt, 4, 1), '');
  const eq = withRules(cellRule('eq', [''], 'color:#111111'));
  assert.equal(cfCss(eq, 4, 1), 'color:#111111');
  assert.equal(cfCss(eq, 3, 0), '');
});

test('cfCss: the first rule to set a property wins, later rules fill in the rest', () => {
  const s = withRules(
    cellRule('eq', ['x'], 'background:#aa0000;color:#ffffff'),
    cellRule('eq', ['x'], 'background:#0000aa;font-weight:600'));
  s.cells['4,1'] = { t: 'x' };
  assert.equal(cfCss(s, 4, 1), 'background:#aa0000;color:#ffffff;font-weight:600');
});

test('cfCss: stop ends the walk, across entries too', () => {
  const s = withRules(
    cellRule('eq', ['x'], 'background:#aa0000', true),
    cellRule('eq', ['x'], 'color:#ffffff'));
  s.cf.push({ ranges: [{ r1: 0, c1: 0, r2: 20, c2: 20 }], rules: [cellRule('eq', ['x'], 'font-weight:600')] });
  s.cells['4,1'] = { t: 'x' };
  assert.equal(cfCss(s, 4, 1), 'background:#aa0000');
});

test('cfCss: a ref outside the grid does not match', () => {
  const s = withRules({ kind: 'ref', op: 'eq', values: [''], ref: { r: -5, c: 0, absR: false, absC: true }, css: 'color:#111111', stop: false });
  assert.equal(cfCss(s, 2, 0), '');
});

test('cfCss on a sheet with no conditional formats', () => {
  const s = T();
  s.cf = [];
  assert.equal(cfCss(s, 3, 5), '');
});

// ---- matchListItem ----------------------------------------------------------

test('matchListItem returns the list’s spelling and trims only the ends', () => {
  assert.equal(matchListItem(['Open Now', 'Closed'], ' open now '), 'Open Now');
  assert.equal(matchListItem(['Open Now'], 'Open  Now'), null);
  assert.equal(matchListItem(['Open'], ''), null);
  assert.equal(matchListItem(['Open'], '   '), null);
  assert.equal(matchListItem([], 'Open'), null);
});

// ---- compactOps -------------------------------------------------------------

test('compactOps keeps sets on different cells and sheets, and a set after a row op on its sheet', () => {
  const a = { op: 'set', sheet: 1, r: 1, c: 1, v: 'a' };
  const ops = [set(1, 1, 'a'), a, set(1, 2, 'b'), del(0, 1), set(1, 1, 'c')];
  assert.deepEqual(compactOps(ops), ops);
});

test('compactOps: a row op on another sheet does not separate two sets', () => {
  const other = { op: 'insertRows', sheet: 1, at: 0, n: 1, like: null };
  assert.deepEqual(compactOps([set(1, 1, 'a'), other, set(1, 1, 'b')]), [other, set(1, 1, 'b')]);
});

test('compactOps collapses a run of sets and leaves its input alone', () => {
  const ops = [set(1, 1, 'a'), set(1, 1, 'b'), set(1, 1, 'c')];
  assert.deepEqual(compactOps(ops), [set(1, 1, 'c')]);
  assert.equal(ops.length, 3);
  assert.deepEqual(compactOps([]), []);
});

// ---- parity with the server --------------------------------------------------
//
// The grid shows applyOps(base, pending) until a save replaces it with what the server wrote and re-read.
// Random row ops and sets run through both on the tracker fixture (plus hidden rows and absolute-row CF
// rules) and the two sheets must agree on everything but the text of cells the client set (the server
// formats it) and rowCount (rows added past the end with no formatting are not kept in an xlsx).

async function parityWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await makeTracker());
  const ws = wb.worksheets[0];
  ws.getRow(6).hidden = true;
  ws.getRow(10).hidden = true;
  const blue = { font: { color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF0000AA' } } };
  ws.addConditionalFormatting({
    ref: 'A3:A15',
    rules: [
      { type: 'expression', priority: 2, formulae: ['$F$3="Open"'], style: blue },
      { type: 'expression', priority: 3, formulae: ['F$5="Closed"'], style: { font: { color: { argb: 'FF00AA00' } } } },
      { type: 'cellIs', priority: 4, operator: 'greaterThan', formulae: ['5'], style: blue },
    ],
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function randomOps(next, rowCount) {
  const ops = [];
  let rows = rowCount;
  for (let i = 1 + next(4); i > 0; i--) {
    const kind = next(20);
    if (kind < 9) {
      const at = next(rows + 1);
      const n = 1 + next(3);
      const near = [at - 1, at].filter((r) => r >= 0 && r < rows);      // the rows an insert may copy
      const like = near.length && next(10) > 2 ? near[next(near.length)] : null;
      ops.push(ins(at, n, like));
      rows += n;
    } else if (kind < 17) {
      const at = next(rows);
      const n = 1 + next(3);
      ops.push(del(at, n));
      rows -= Math.max(0, Math.min(at + n, rows) - at);
    } else if (rows > 0) {
      ops.push(set(next(rows), 0, 'v' + i));
    }
  }
  return ops;
}

const cellsOf = (ranges, into) => {
  for (const g of ranges) for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) into.add(r + ',' + c);
  return into;
};
const sortedEntries = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// A style that only changes the text (colour, size) draws nothing on an empty cell, so the server's model
// leaves such cells out; the client keeps them because a value typed into one takes that style.
const drawsSomething = (cell, css) => cell.t || (css !== '' && css.split(';').some((d) => !/^(?:color|font-size):/.test(d)));

function comparable(sheet, changed) {
  const lists = {};
  for (const l of sheet.lists) cellsOf(l.ranges, lists[JSON.stringify([l.items, l.strict])] ||= new Set());
  const cf = {};
  for (const e of sheet.cf) for (const rule of e.rules) cellsOf(e.ranges, cf[JSON.stringify(rule)] ||= new Set());
  const cells = {};
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const css = cell.s === undefined ? '' : sheet.styles[cell.s];
    if (drawsSomething(cell, css)) cells[key] = { css, t: changed.has(key) ? null : cell.t || '' };
  }
  return {
    merges: sheet.merges.map((m) => JSON.stringify(m)).sort(),
    frozen: sheet.frozen,
    hiddenRows: [...sheet.hiddenRows].sort((a, b) => a - b),
    rowHeights: sortedEntries(sheet.rowHeights),
    lists: sortedEntries(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v].sort()]))),
    cf: sortedEntries(Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, [...v].sort()]))),
    cfSkipped: sheet.cfSkipped,
    cells: sortedEntries(cells),
  };
}

test('applyOps agrees with the server on random row ops and sets', async () => {
  const src = await parityWorkbook();
  const base = server.toModel(await server.loadWorkbook(src)).sheets[0];
  let seed = 20261006;
  const next = (n) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return Math.floor((seed / 4294967296) * n); };
  for (let i = 0; i < 120; i++) {
    const ops = randomOps(next, base.rowCount);
    const client = applyOps(base, ops);
    const wb = await server.loadWorkbook(src);
    server.applyOps(wb, ops);
    const fresh = server.toModel(await server.loadWorkbook(await server.writeVerified(wb, src))).sheets[0];
    const expected = comparable(fresh, client.changed);
    const actual = comparable(client, client.changed);
    assert.deepEqual(actual, expected, JSON.stringify(ops));
  }
});
