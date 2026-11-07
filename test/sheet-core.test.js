'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  colName, colIndex, parseCell, parseRange, rangeStr, shiftRange, shiftRefList, rebaseFormula,
} = require('../public/sheet-core');

// ---- A1 references --------------------------------------------------------

test('colName/colIndex round trip', () => {
  for (const c of [0, 25, 26, 701, 702, 16383]) assert.equal(colIndex(colName(c)), c);
  assert.equal(colName(27), 'AB');
});

test('colName/colIndex reject out-of-range input', () => {
  assert.throws(() => colName(-1));
  assert.throws(() => colName(16384));
  assert.throws(() => colName(1.5));
  assert.throws(() => colIndex('XFE'));
  assert.throws(() => colIndex('A1'));
  assert.throws(() => colIndex(''));
});

test('parseCell flags', () => assert.deepEqual(parseCell('$F3'), { r: 2, c: 5, absR: false, absC: true }));

test('parseCell accepts $ on either part and the grid limits', () => {
  assert.deepEqual(parseCell('A$1'), { r: 0, c: 0, absR: true, absC: false });
  assert.deepEqual(parseCell('$XFD$1048576'), { r: 1048575, c: 16383, absR: true, absC: true });
});

test('parseCell throws on anything else', () => {
  for (const bad of ['', 'A', '1', 'A0', 'XFE1', 'A1048577', 'A$', '$$A1', 'A1:B2', ' A1', 'A-1', '$']) {
    assert.throws(() => parseCell(bad), undefined, JSON.stringify(bad));
  }
});

test('parseRange / rangeStr', () => {
  assert.deepEqual(parseRange('A1:G1'), { r1: 0, c1: 0, r2: 0, c2: 6 });
  assert.deepEqual(parseRange('B2'), { r1: 1, c1: 1, r2: 1, c2: 1 });
  assert.deepEqual(parseRange('$B$5:A1'), { r1: 0, c1: 0, r2: 4, c2: 1 });
  assert.equal(rangeStr({ r1: 0, c1: 0, r2: 0, c2: 6 }), 'A1:G1');
  assert.equal(rangeStr({ r1: 2, c1: 5, r2: 2, c2: 5 }), 'F3');
  assert.throws(() => parseRange('A1:'));
  assert.throws(() => parseRange('A1:B2:C3'));
});

// ---- range shifting -------------------------------------------------------

test('insert shifts and grows', () => {
  assert.deepEqual(shiftRange(parseRange('A3:G3'), 1, 1), parseRange('A4:G4'));
  assert.deepEqual(shiftRange(parseRange('F3:F15'), 5, 2), parseRange('F3:F17'));
  assert.deepEqual(shiftRange(parseRange('F3:F15'), 15, 1), parseRange('F3:F15'));
});

test('delete removes, shrinks, moves up', () => {
  assert.equal(shiftRange(parseRange('A5:G5'), 4, -1), null);
  assert.deepEqual(shiftRange(parseRange('F3:F15'), 4, -2), parseRange('F3:F13'));
  assert.deepEqual(shiftRange(parseRange('F20:F30'), 4, -2), parseRange('F18:F28'));
});

test('delete clips a range that overlaps either edge of the band', () => {
  assert.deepEqual(shiftRange(parseRange('A3:A6'), 4, -3), parseRange('A3:A4'));
  assert.deepEqual(shiftRange(parseRange('A6:A11'), 4, -3), parseRange('A5:A8'));
});

test('shiftRange returns a new object', () => {
  const rg = parseRange('A3:G3');
  assert.notEqual(shiftRange(rg, 10, 1), rg);
  assert.deepEqual(rg, parseRange('A3:G3'));
});

test('insert at the first row moves a range, at the last row grows it, past it does nothing', () => {
  const rg = parseRange('A3:A6');
  assert.deepEqual(shiftRange(rg, 2, 1), parseRange('A4:A7'));
  assert.deepEqual(shiftRange(rg, 5, 1), parseRange('A3:A7'));
  assert.deepEqual(shiftRange(rg, 6, 1), parseRange('A3:A6'));
});

test('delete bands next to a range leave it or move it, and a band equal to it removes it', () => {
  const rg = parseRange('A5:A8');
  assert.deepEqual(shiftRange(rg, 2, -2), parseRange('A3:A6'));   // rows 3-4, directly above
  assert.deepEqual(shiftRange(rg, 8, -2), parseRange('A5:A8'));   // rows 9-10, directly below
  assert.equal(shiftRange(rg, 4, -4), null);
});

test('insert clips a range at the last row of the sheet', () => {
  assert.deepEqual(shiftRange(parseRange('F1:F1048576'), 4, 1), parseRange('F1:F1048576'));
  assert.deepEqual(shiftRange(parseRange('F1048570:F1048576'), 1048572, 3), parseRange('F1048570:F1048576'));
  assert.equal(shiftRange(parseRange('F1048576'), 0, 1), null);
});

test('parseRange stays strict about whole-column and whole-row text', () => {
  assert.throws(() => parseRange('F:F'));
  assert.throws(() => parseRange('3:5'));
});

test('ref list', () => assert.equal(shiftRefList('F3:F15 F17 F19:F47', 16, -1), 'F3:F15 F18:F46'));

test('ref list is empty when every range is removed', () => {
  assert.equal(shiftRefList('F17', 16, -1), '');
  assert.equal(shiftRefList('F17 F18:F19', 16, -3), '');
});

test('ref list: whole-column tokens pass through, whole-row tokens shift', () => {
  assert.equal(shiftRefList('F:F 3:5', 3, 1), 'F:F 3:6');          // insert inside the rows grows them
  assert.equal(shiftRefList('F:F 3:5', 2, 1), 'F:F 4:6');          // insert at the first row moves them
  assert.equal(shiftRefList('$F:$H $3:$5', 0, 2), '$F:$H $5:$7');
  assert.equal(shiftRefList('F:F 3:5', 2, -3), 'F:F');            // deleted entirely
  assert.equal(shiftRefList('3:5 8:9', 3, -2), '3:3 6:7');
});

test('ref list: a range to the last row survives an insert', () => {
  assert.equal(shiftRefList('F1:F1048576', 4, 1), 'F1:F1048576');
  assert.equal(shiftRefList('1:1048576', 4, 1), '1:1048576');
});

test('ref list still throws on junk', () => {
  assert.throws(() => shiftRefList('F3 nope', 0, 1));
  assert.throws(() => shiftRefList('0:3', 0, 1));
  assert.throws(() => shiftRefList('ZZZ:ZZZ', 0, 1));
});

// ---- formula re-anchoring -------------------------------------------------

test('rebase', () => {
  assert.equal(rebaseFormula('$F3="Open"', { sheet: 'S', at: 0, delta: 1, anchorShift: 1 }), '$F4="Open"');
  assert.equal(rebaseFormula('$F3="Open"', { sheet: 'S', at: 9, delta: 1, anchorShift: 0 }), '$F3="Open"');
  assert.equal(rebaseFormula('COUNTIF($K$2:$K$9,A1)', { sheet: 'S', at: 4, delta: 2, anchorShift: 0 }), 'COUNTIF($K$2:$K$11,A1)');
  assert.equal(rebaseFormula('Other!$A$5="x"', { sheet: 'S', at: 0, delta: 1, anchorShift: 1 }), 'Other!$A$5="x"');
  assert.equal(rebaseFormula('A1="B2"', { sheet: 'S', at: 0, delta: 1, anchorShift: 1 }), 'A2="B2"');
  assert.equal(rebaseFormula("'S'!$A$5", { sheet: 'S', at: 2, delta: -1, anchorShift: 0 }), "'S'!$A$4");
});

test('rebase: absolute rows follow the delete, relative rows follow the anchor', () => {
  const o = { sheet: 'S', at: 2, delta: -3, anchorShift: 0 };         // band is rows 3-5
  assert.equal(rebaseFormula('$K$9', o), '$K$6');
  assert.equal(rebaseFormula('$K$4', o), '#REF!');                    // inside the band -> gone
  assert.equal(rebaseFormula('$K$2', o), '$K$2');
  assert.equal(rebaseFormula('K9', o), 'K9');                         // relative: anchorShift only
  assert.equal(rebaseFormula('K9', { ...o, anchorShift: -3 }), 'K6');
});

test('rebase: each ref in a range moves independently and $ flags survive', () => {
  assert.equal(rebaseFormula('A1:B5', { sheet: 'S', at: 50, delta: 1, anchorShift: 2 }), 'A3:B7');
  assert.equal(rebaseFormula('$A1+A$1', { sheet: 'S', at: 5, delta: 1, anchorShift: 2 }), '$A3+A$1');
});

test('rebase clamps to row 1', () => {
  assert.equal(rebaseFormula('A2', { sheet: 'S', at: 0, delta: -1, anchorShift: -5 }), 'A1');
});

test('rebase leaves string literals alone, including "" escapes', () => {
  assert.equal(
    rebaseFormula('A1="say ""B2"" now"&B3', { sheet: 'S', at: 50, delta: 1, anchorShift: 1 }),
    'A2="say ""B2"" now"&B4',
  );
});

test('rebase matches this sheet by name, quoted or not, case-insensitively', () => {
  const o = { sheet: 'My Sheet', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula("'My Sheet'!A1", o), "'My Sheet'!A2");
  assert.equal(rebaseFormula("'my sheet'!A1", o), "'my sheet'!A2");
  assert.equal(rebaseFormula("'Other Sheet'!A1", o), "'Other Sheet'!A1");
  assert.equal(rebaseFormula('Plan!A1:B5', { sheet: 'plan', at: 0, delta: 1, anchorShift: 1 }), 'Plan!A2:B6');
  assert.equal(rebaseFormula("'Bob''s'!A1", { sheet: "Bob's", at: 0, delta: 1, anchorShift: 1 }), "'Bob''s'!A2");
});

test('rebase: a qualifier covers both ends of its range, and only that range', () => {
  const o = { sheet: 'S', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula('SUM(Other!A1:B5)+A1', o), 'SUM(Other!A1:B5)+A2');
});

test('rebase skips function names, whole-column refs and defined names', () => {
  const o = { sheet: 'S', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula('LOG10(A1)', o), 'LOG10(A2)');
  assert.equal(rebaseFormula('COUNTIF($F:$F,"x")+COUNTIF(F:F,B1)', o), 'COUNTIF($F:$F,"x")+COUNTIF(F:F,B2)');
  assert.equal(rebaseFormula('SUM(MyRange)+Rate_2024', o), 'SUM(MyRange)+Rate_2024');
});

test('rebase leaves the text around refs exactly as it was', () => {
  assert.equal(
    rebaseFormula('  AND( $F3 = "Open" ,\tA1<>1.5E3 )', { sheet: 'S', at: 0, delta: 1, anchorShift: 1 }),
    '  AND( $F4 = "Open" ,\tA2<>1.5E3 )',
  );
});

test('rebase: absolute ranges follow Excel when a delete clips them', () => {
  assert.equal(rebaseFormula('$K$2:$K$9', { sheet: 'S', at: 7, delta: -3, anchorShift: 0 }), '$K$2:$K$7');
  assert.equal(
    rebaseFormula('COUNTIF($K$2:$K$9,A1)', { sheet: 'S', at: 8, delta: -1, anchorShift: 0 }),
    'COUNTIF($K$2:$K$8,A1)',
  );
  assert.equal(rebaseFormula('$K$4:$K$9', { sheet: 'S', at: 2, delta: -2, anchorShift: 0 }), '$K$3:$K$7');
  assert.equal(rebaseFormula('$K$2:$K$9', { sheet: 'S', at: 1, delta: -1, anchorShift: 0 }), '$K$2:$K$8');
});

test('rebase: a deleted absolute ref or range becomes #REF!, qualifier included', () => {
  const o = { sheet: 'S', at: 3, delta: -2, anchorShift: 0 };      // band is rows 4-5
  assert.equal(rebaseFormula('$K$4:$K$5', o), '#REF!');
  assert.equal(rebaseFormula('$K$5', o), '#REF!');
  assert.equal(rebaseFormula('SUM($K$4:$K$5)+K9', o), 'SUM(#REF!)+K9');
  assert.equal(rebaseFormula("'S'!$K$4:$K$5", o), '#REF!');
  assert.equal(rebaseFormula('S!$K$5', o), '#REF!');
  assert.equal(rebaseFormula('Other!$K$5', o), 'Other!$K$5');
});

test('rebase: a range with one relative end moves it by the anchor and the other by the delete', () => {
  assert.equal(rebaseFormula('B3:$B$9', { sheet: 'S', at: 4, delta: -1, anchorShift: -1 }), 'B2:$B$8');
  assert.equal(rebaseFormula('B3:$B$6', { sheet: 'S', at: 5, delta: -2, anchorShift: 0 }), 'B3:$B$5');
});

test('rebase: inserts grow, move and clip absolute ranges', () => {
  const o = { sheet: 'S', at: 4, delta: 1, anchorShift: 0 };
  assert.equal(rebaseFormula('$A$1:$A$1048576', o), '$A$1:$A$1048576');
  assert.equal(rebaseFormula('$A$5:$A$9', o), '$A$6:$A$10');
  assert.equal(rebaseFormula('$A$3:$A$9', o), '$A$3:$A$10');
  assert.equal(rebaseFormula('$A$9:$A$3', o), '$A$3:$A$10');      // reversed ranges are written back low-to-high
});

test('rebase: error literals are plain tokens, not sheet qualifiers', () => {
  const o = { sheet: 'S', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula('#REF!+A1', o), '#REF!+A2');
  assert.equal(rebaseFormula('#VALUE!+A1', o), '#VALUE!+A2');
  assert.equal(rebaseFormula('IFERROR(B1,#DIV/0!)+A1', o), 'IFERROR(B2,#DIV/0!)+A2');
  assert.equal(rebaseFormula('IF(A1=#N/A,B1,#NAME?)', o), 'IF(A2=#N/A,B2,#NAME?)');
});

test('rebase: a range end that is a function result does not hide the start', () => {
  assert.equal(rebaseFormula('SUM(A1:INDEX(B:B,3))', { sheet: 'S', at: 0, delta: 1, anchorShift: 1 }), 'SUM(A2:INDEX(B:B,3))');
});

test('rebase: #REF! right before a ref is a deleted sheet, so the ref is left alone (never #REF!#REF!)', () => {
  const del = { sheet: 'S', at: 0, delta: -1, anchorShift: 0 };      // deletes row 1
  assert.equal(rebaseFormula('#REF!A1', del), '#REF!A1');
  assert.equal(rebaseFormula('#REF!$A$1', del), '#REF!$A$1');
  assert.equal(rebaseFormula('#REF!$A$1:$B$2', del), '#REF!$A$1:$B$2');
  assert.equal(rebaseFormula('#ref!$A$1+$A$2', del), '#ref!$A$1+$A$1');
  const ins = { sheet: 'S', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula('#REF!A1+A1', ins), '#REF!A1+A2');
  assert.equal(rebaseFormula('#REF!+A1', ins), '#REF!+A2');          // an error literal on its own is still one
  assert.equal(rebaseFormula('SUM(#REF!$K$3,$K$3)', { sheet: 'S', at: 0, delta: 2, anchorShift: 0 }), 'SUM(#REF!$K$3,$K$5)');
});

test('rebase: a mixed range end never goes past the last row', () => {
  const o = { sheet: 'S', at: 0, delta: 1, anchorShift: 1 };
  assert.equal(rebaseFormula('K1:$K$1048576', o), 'K2:$K$1048576');
  assert.equal(rebaseFormula('$K$1:K1048576', o), '$K$2:K1048576');
  assert.equal(rebaseFormula('K1:$K$1048575', { ...o, delta: 5 }), 'K2:$K$1048576');
  assert.equal(rebaseFormula('K1048576', o), 'K1048576');               // a relative ref is clamped too
});

test('rebase: a defined name has no anchor, so every row follows its target and whole rows move', () => {
  const ins = { sheet: 'S', at: 0, delta: 2, anchorShift: 0 };
  const name = { ...ins, definedName: true };
  assert.equal(rebaseFormula('S!$1:$2', ins), 'S!$1:$2');                // CF / validation formulas: whole rows untouched
  assert.equal(rebaseFormula('S!A1', ins), 'S!A1');                      // ...and relative rows follow the anchor only
  assert.equal(rebaseFormula('S!$1:$2', name), 'S!$3:$4');
  assert.equal(rebaseFormula('S!2:3', name), 'S!4:5');
  assert.equal(rebaseFormula("'S'!$A1:$C10", name), "'S'!$A3:$C12");    // how ExcelJS writes a print area
  assert.equal(rebaseFormula("'S'!$3:$5,'S'!$A:$B", { ...name, at: 3 }), "'S'!$3:$7,'S'!$A:$B");
  assert.equal(rebaseFormula('Other!$1:$2', name), 'Other!$1:$2');
  const del = { sheet: 'S', at: 1, delta: -2, anchorShift: 0, definedName: true };   // rows 2-3
  assert.equal(rebaseFormula('S!$2:$3', del), '#REF!');
  assert.equal(rebaseFormula('S!$2:$5', del), 'S!$2:$3');
  assert.equal(rebaseFormula('S!A2', del), '#REF!');
  assert.equal(rebaseFormula('S!A1:A9', del), 'S!A1:A7');
  assert.equal(rebaseFormula('OFFSET(S!$A$5,0,0,COUNTA(S!$A:$A),1)', del), 'OFFSET(S!$A$3,0,0,COUNTA(S!$A:$A),1)');
});
