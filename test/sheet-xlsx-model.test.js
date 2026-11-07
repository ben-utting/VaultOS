'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { loadWorkbook, toModel, anyDrawable } = require('../lib/sheet-xlsx');
const { makeTracker, makePack } = require('./fixtures');

// build a workbook in memory, write it, and load it the way the server does
async function roundTrip(build) {
  const wb = new ExcelJS.Workbook();
  await build(wb);
  return loadWorkbook(await wb.xlsx.writeBuffer());
}
const model = async (build) => toModel(await roundTrip(build));

const FIELDS = ['index', 'name', 'rowCount', 'colCount', 'cells', 'styles', 'colWidths', 'rowHeights', 'defaultRowHeight', 'hiddenRows',
  'hiddenCols', 'merges', 'frozen', 'lists', 'cf', 'cfSkipped', 'readOnly', 'rowOps', 'tooBig', 'locked'].sort();

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---- the plan's tests, verbatim -------------------------------------------

test('tracker model', async () => {
  const s = toModel(await loadWorkbook(await makeTracker())).sheets[0];
  assert.deepEqual(s.frozen, { rows: 1, cols: 0 });
  assert.deepEqual(s.merges.find((m) => m.r1 === 1), { r1: 1, c1: 0, r2: 1, c2: 6 });
  assert.deepEqual(s.lists[0].items, ['Open', 'In Progress', 'Closed']); assert.equal(s.lists[0].strict, true);
  assert.deepEqual(s.cf[0].rules[0], { kind: 'ref', op: 'eq', values: ['Open'], ref: { r: 0, c: 5, absR: false, absC: true }, css: s.cf[0].rules[0].css, stop: false });
  assert.match(s.cf[0].rules[0].css, /background:#c00000/);
  assert.match(s.styles[s.cells['0,0'].s], /font-weight:700/);
  assert.equal(s.rowOps, null);
});
test('pack model', async () => {
  const { sheets } = toModel(await loadWorkbook(await makePack()));
  assert.equal(sheets.length, 2); assert.equal(sheets[1].index, 2); assert.equal(sheets[1].name, 'Detail');
  assert.deepEqual(sheets[0].cells['3,1'], { ...sheets[0].cells['3,1'], f: '=SUM(B2:B3)', t: '5' });
  assert.match(sheets[0].rowOps, /formulas/);
});

// ---- the pack's hidden list sheet, and the tracker's details ----------------

test('a list whose source is on a hidden sheet resolves', async () => {
  const { sheets } = toModel(await loadWorkbook(await makePack()));
  assert.deepEqual(sheets[1].lists[0].items, ['Low', 'Medium', 'High']);
  assert.equal(sheets[1].lists.length, 1);
  assert.deepEqual(sheets[1].lists[0].ranges, [{ r1: 4, c1: 2, r2: 7, c2: 2 }]);
  assert.deepEqual(sheets[1].frozen, { rows: 4, cols: 0 });
  assert.deepEqual(sheets[0].lists, []);
});

test('tracker: sizes, rows, list and cf coverage, cells', async () => {
  const s = toModel(await loadWorkbook(await makeTracker())).sheets[0];
  assert.equal(s.name, 'Tracker');
  assert.equal(s.index, 0);
  assert.equal(s.rowCount, 16);
  assert.equal(s.colCount, 7);
  assert.equal(s.tooBig, false);
  assert.equal(s.readOnly, null);
  assert.equal(s.cfSkipped, 0);
  assert.equal(s.colWidths.length, 7);
  assert.equal(s.colWidths[0], 215);                    // round(30 * 7 + 5)
  assert.equal(s.defaultRowHeight, 20);                 // 15pt
  assert.equal(s.rowHeights[0], 40);                    // 30pt
  assert.equal(s.rowHeights[2], 53);                    // row 3: 40pt
  assert.equal(s.rowHeights[3], 30);                    // row 4: 22.5pt
  assert.deepEqual(s.lists[0].ranges, [{ r1: 2, c1: 5, r2: 14, c2: 5 }]);
  assert.deepEqual(s.cf[0].ranges, [{ r1: 2, c1: 5, r2: 14, c2: 5 }]);
  assert.deepEqual(s.merges, [{ r1: 1, c1: 0, r2: 1, c2: 6 }, { r1: 15, c1: 0, r2: 15, c2: 6 }]);
  assert.equal(s.cells['3,5'].t, 'Open');
  assert.equal(s.cells['4,5'].t, 'Closed');
  assert.equal(s.cells['3,0'].t, 'Task 02');
  assert.equal(s.cells['3,3'].t, '02/10/2026');          // dd/mm/yyyy
  assert.ok(!('f' in s.cells['3,0']));
  assert.ok(!('e' in s.cells['3,0']), 'e only when the edit text differs');
  assert.equal(s.cells['0,0'].t, 'Task');
});

test('merged cells: the master shows text, the right-edge cell keeps its border but carries no text', async () => {
  const s = toModel(await loadWorkbook(await makeTracker())).sheets[0];
  assert.equal(s.cells['1,0'].t, 'Environments');
  assert.match(s.styles[s.cells['1,0'].s], /font-weight:700/);
  const edge = s.cells['1,6'];
  assert.ok(edge, 'G2 is in the model');
  assert.ok(!('t' in edge), 'a non-master merged cell has no text');
  assert.ok(!('e' in edge) && !('f' in edge));
  assert.match(s.styles[edge.s], /border-right:2px solid #000000/);
  assert.ok(!/border-right/.test(s.styles[s.cells['1,0'].s]), 'the border is on G2 only');
  assert.match(s.styles[s.cells['15,6'].s], /border-right:2px solid/);
  assert.ok(!('t' in s.cells['15,6']));
});

test('an unstyled merge sends nothing for its non-master cells and no empty style', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('M');
    ws.getCell('A1').value = 'title';
    ws.mergeCells('A1:C1');
    ws.getCell('A2').value = 'x';
  });
  assert.deepEqual(s.merges, [{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  assert.deepEqual(s.cells, { '0,0': { t: 'title' }, '1,0': { t: 'x' } });
  assert.deepEqual(s.styles, []);
});

test('every Sheet field is present on every sheet', async () => {
  for (const buf of [await makeTracker(), await makePack()]) {
    for (const s of toModel(await loadWorkbook(buf)).sheets) {
      assert.deepEqual(Object.keys(s).sort(), FIELDS);
      for (const k of FIELDS) assert.notEqual(s[k], undefined, k);
      assert.equal(s.colWidths.length, s.colCount);
      assert.ok(Array.isArray(s.styles) && Array.isArray(s.hiddenRows) && Array.isArray(s.hiddenCols));
      assert.equal(typeof s.rowHeights, 'object');
    }
  }
});

test('pack: styles are deduped per sheet and indexes point into the sheet\'s own list', async () => {
  const { sheets } = toModel(await loadWorkbook(await makePack()));
  for (const s of sheets) {
    assert.equal(new Set(s.styles).size, s.styles.length);
    assert.ok(!s.styles.includes(''));
    for (const cell of Object.values(s.cells)) if ('s' in cell) assert.ok(s.styles[cell.s] !== undefined);
  }
  const ov = sheets[0];
  assert.match(ov.styles[ov.cells['0,0'].s], /background:#ddebf7/);
  assert.ok('0,1' in ov.cells, 'a styled empty cell is in the model');
  assert.equal(ov.cells['0,1'].t, '');
  assert.match(ov.styles[ov.cells['4,0'].s], /white-space:pre-wrap/);
  assert.match(ov.styles[ov.cells['4,0'].s], /color:#/);
  assert.equal(ov.rowHeights[4], 60);
});

test('active sheet is an index into sheets[]: the active tab if visible, else the first', async () => {
  const wb = await loadWorkbook(await makePack());      // activeTab 2 = Detail, the second visible sheet
  assert.equal(toModel(wb).active, 1);
  wb.views[0].activeTab = 1;                            // the hidden Lists sheet
  assert.equal(toModel(wb).active, 0);
  wb.views = [];
  assert.equal(toModel(wb).active, 0);
  assert.equal(toModel(await loadWorkbook(await makeTracker())).active, 0);
});

// ---- loading ---------------------------------------------------------------

test('a workbook with no visible worksheets is unreadable', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Only', { state: 'hidden' }).getCell('A1').value = 1;
  await assert.rejects(loadWorkbook(await wb.xlsx.writeBuffer()), (err) => err.unreadable === true && /no visible worksheets/.test(err.message));
  const very = new ExcelJS.Workbook();
  very.addWorksheet('A', { state: 'visible' });
  very.addWorksheet('B', { state: 'veryHidden' });
  const ok = await loadWorkbook(await very.xlsx.writeBuffer());
  assert.deepEqual(toModel(ok).sheets.map((s) => [s.index, s.name]), [[0, 'A']]);
});

test('a zip with no workbook part loads as empty, which is unreadable', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  await assert.rejects(loadWorkbook(await zip.generateAsync({ type: 'nodebuffer' })), (err) => err.unreadable === true);
});

test('bytes that are not a zip are rejected by ExcelJS itself (no unreadable flag)', async () => {
  await assert.rejects(loadWorkbook(Buffer.from('not a zip file at all')), (err) => err.unreadable === undefined);
});

// ---- sheet-level mapping ---------------------------------------------------

test('widths, heights, hidden rows and columns, default sizes', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getColumn(1).width = 20;
    ws.getColumn(3).hidden = true;
    ws.getColumn(3).width = 10;
    ws.getCell('E2').value = 'x';
    ws.getRow(2).height = 33;
    ws.getRow(4).hidden = true;
    ws.getRow(4).height = 15;
    ws.getCell('A4').value = 'hidden row';
    ws.getRow(6).height = 15;                  // the default: nothing to record
    ws.getCell('A6').value = 'default height';
  });
  assert.equal(s.colCount, 5);
  assert.equal(s.colWidths.length, 5);
  assert.equal(s.colWidths[0], 145);           // round(20 * 7 + 5)
  assert.equal(s.colWidths[2], 75);            // round(10 * 7 + 5)
  assert.equal(s.colWidths[4], 64);            // columns the file doesn't mention: 8.43 chars
  assert.deepEqual(s.hiddenCols, [2]);
  assert.deepEqual(s.hiddenRows, [3]);
  assert.equal(s.rowHeights[1], 44);           // 33pt
  assert.ok(!(5 in s.rowHeights));
  assert.equal(s.defaultRowHeight, 20);
});

test('an empty sheet is 0 rows by 1 column and has every field', async () => {
  const { sheets: [s] } = await model((wb) => { wb.addWorksheet('Empty'); });
  assert.equal(s.rowCount, 0);
  assert.equal(s.colCount, 1);
  assert.deepEqual(s.cells, {});
  assert.equal(s.colWidths.length, 1);
  assert.deepEqual(s.frozen, { rows: 0, cols: 0 });
});

test('frozen panes: columns, rows, both, and the first frozen view wins', async () => {
  const { sheets } = await model((wb) => {
    wb.addWorksheet('Cols', { views: [{ state: 'frozen', xSplit: 2 }] }).getCell('C3').value = 1;
    wb.addWorksheet('Both', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] }).getCell('C3').value = 1;
    wb.addWorksheet('Split', { views: [{ state: 'split', xSplit: 1500, ySplit: 900 }] }).getCell('C3').value = 1;
    wb.addWorksheet('None').getCell('C3').value = 1;
  });
  assert.deepEqual(sheets.map((s) => s.frozen), [{ rows: 0, cols: 2 }, { rows: 3, cols: 1 }, { rows: 0, cols: 0 }, { rows: 0, cols: 0 }]);
});

test('a protected sheet is read-only with a reason', async () => {
  const { sheets } = await model(async (wb) => {
    const ws = wb.addWorksheet('Locked');
    ws.getCell('A1').value = 1;
    await ws.protect();
    wb.addWorksheet('Open').getCell('A1').value = 1;
  });
  assert.equal(sheets[0].readOnly, 'This sheet is protected in Excel');
  assert.equal(sheets[1].readOnly, null);
});

test('a sheet over 60000 cells is too big: no cells, every other field present', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('Big', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.getCell('A1').value = 'head';
    ws.getCell('A60001').value = 'tail';
    ws.getCell('B2').value = 'x';
    ws.getRow(3).height = 30;
    ws.getRow(5).hidden = true;
    ws.getCell('A5').value = 'h';
  });
  assert.equal(s.rowCount, 60001);
  assert.equal(s.colCount, 2);
  assert.equal(s.tooBig, true);
  assert.deepEqual(s.cells, {});
  assert.deepEqual(Object.keys(s).sort(), FIELDS);
  assert.equal(s.colWidths.length, 2);
  assert.deepEqual(s.frozen, { rows: 1, cols: 0 });
  assert.deepEqual(s.hiddenRows, [4]);
  assert.equal(s.rowHeights[2], 40);
});

test('exactly 60000 cells is not too big', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('Edge');
    ws.getCell('A60000').value = 'last';
  });
  assert.equal(s.rowCount * s.colCount, 60000);
  assert.equal(s.tooBig, false);
  assert.equal(s.cells['59999,0'].t, 'last');
});

test('anyDrawable: false only when every visible sheet is too big for the grid', async () => {
  const big = (wb, name, state) => { const ws = wb.addWorksheet(name, state ? { state } : {}); ws.getCell('B60001').value = 'tail'; };
  const small = (wb, name, state) => { (state ? wb.addWorksheet(name, { state }) : wb.addWorksheet(name)).getCell('A1').value = 'x'; };
  assert.equal(anyDrawable(await roundTrip((wb) => big(wb, 'Big'))), false);
  assert.equal(anyDrawable(await roundTrip((wb) => { big(wb, 'Big'); small(wb, 'Small'); })), true);
  assert.equal(anyDrawable(await roundTrip((wb) => { big(wb, 'Big'); small(wb, 'Lists', 'hidden'); })), false);   // hidden sheets aren't drawn
  assert.equal(anyDrawable(await roundTrip((wb) => small(wb, 'Small'))), true);
});

// ---- cells -----------------------------------------------------------------

test('cells: display text, edit text, formulas and styles', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('C');
    ws.getCell('A1').value = 'plain';
    ws.getCell('A2').value = 0.5; ws.getCell('A2').numFmt = '0%';
    ws.getCell('A3').value = new Date(Date.UTC(2026, 2, 12)); ws.getCell('A3').numFmt = 'dd/mm/yyyy';
    ws.getCell('A4').value = 1234.5; ws.getCell('A4').numFmt = '#,##0.00';
    ws.getCell('A5').value = { formula: 'A2*2', result: 1 };
    ws.getCell('A6').value = { formula: 'IF(A1="","","x")', result: '' };      // formula cell with no display text
    ws.getCell('A7').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };   // styled, empty
    ws.getCell('A8').numFmt = '0.00';                                           // format only: nothing to draw
    ws.getCell('A11').font = { size: 14, color: { argb: 'FFFF0000' } };         // empty, colour and size only: nothing to draw
    ws.getCell('A12').font = { bold: true };                                    // empty, but bold: kept
    ws.getCell('C1').value = '';                                                // an empty string and no style: nothing to send
    ws.getCell('A9').value = true;
    ws.getCell('A10').value = { text: 'link', hyperlink: 'https://example.test' };
    ws.getCell('B1').font = { bold: true }; ws.getCell('B1').value = 'bold';
    ws.getCell('B2').font = { bold: true }; ws.getCell('B2').value = 'bold again';
    ws.getCell('B3').value = 'tail';
  });
  assert.deepEqual(s.cells['0,0'], { t: 'plain' });
  assert.equal(s.cells['1,0'].t, '50%');
  assert.equal(s.cells['1,0'].e, '0.5');
  assert.equal(s.cells['2,0'].t, '12/03/2026');
  assert.equal(s.cells['3,0'].t, '1,234.50');
  assert.equal(s.cells['3,0'].e, '1234.5');
  assert.equal(s.cells['4,0'].f, '=A2*2');
  assert.equal(s.cells['4,0'].t, '1');
  assert.ok('5,0' in s.cells, 'a formula cell is in the model even when its text is empty');
  assert.equal(s.cells['5,0'].f, '=IF(A1="","","x")');
  assert.equal(s.cells['5,0'].t, '');
  assert.ok(!('s' in s.cells['5,0']), 'no style -> no s');
  assert.equal(s.cells['6,0'].t, '');
  assert.match(s.styles[s.cells['6,0'].s], /background:#ffff00/);
  assert.ok(!('7,0' in s.cells), 'an empty cell with only a number format is left out');
  assert.ok(!('10,0' in s.cells), 'an empty cell with only a font colour and size is left out');
  assert.ok(!('0,2' in s.cells), 'an empty-string cell with no style is left out');
  for (const [key, cell] of Object.entries(s.cells)) assert.ok(cell.t !== '' || 's' in cell || 'f' in cell, key + ' is empty and unstyled');
  assert.equal(s.cells['11,0'].t, '');
  assert.match(s.styles[s.cells['11,0'].s], /font-weight:700/);
  assert.equal(s.cells['8,0'].t, 'TRUE');
  assert.equal(s.cells['9,0'].t, 'link');
  assert.equal(s.cells['0,1'].s, s.cells['1,1'].s, 'same look, same style index');
  assert.ok(!('s' in s.cells['2,1']));
});

test('shared formulas get their own text', async () => {
  const buf = await (async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('F');
    ws.getCell('A1').value = 1; ws.getCell('A2').value = 2; ws.getCell('A3').value = 3;
    ws.getCell('B1').value = { formula: 'A1*2', result: 2 };
    ws.getCell('B2').value = { sharedFormula: 'B1', result: 4 };
    ws.getCell('B3').value = { sharedFormula: 'B1', result: 6 };
    return wb.xlsx.writeBuffer();
  })();
  const s = toModel(await loadWorkbook(buf)).sheets[0];
  assert.equal(s.cells['0,1'].f, '=A1*2');
  assert.equal(s.cells['1,1'].f, '=A2*2');
  assert.equal(s.cells['2,1'].f, '=A3*2');
  assert.equal(s.cells['2,1'].t, '6');
});

// ---- rowOps ----------------------------------------------------------------

test('rowOps: the first reason wins; formulas anywhere in the workbook count', async () => {
  const withTable = (ws) => ws.addTable({ name: 'T1', ref: 'A1', headerRow: true, columns: [{ name: 'a' }], rows: [[1]] });
  const withImage = (wb, ws) => ws.addImage(wb.addImage({ buffer: PNG, extension: 'png' }), 'C3:D4');

  const plain = await model((wb) => { wb.addWorksheet('A').getCell('A1').value = 1; });
  assert.equal(plain.sheets[0].rowOps, null);

  const tbl = await model((wb) => { withTable(wb.addWorksheet('A')); wb.addWorksheet('B').getCell('A1').value = 1; });
  assert.equal(tbl.sheets[0].rowOps, 'This sheet has an Excel table, so add or remove rows in Excel');
  assert.equal(tbl.sheets[1].rowOps, null, 'a table on another sheet does not matter');

  const img = await model((wb) => { withImage(wb, wb.addWorksheet('A')); wb.addWorksheet('B').getCell('A1').value = 1; });
  assert.equal(img.sheets[0].rowOps, 'This sheet has pictures, so add or remove rows in Excel');
  assert.equal(img.sheets[1].rowOps, null);

  const both = await model((wb) => { const ws = wb.addWorksheet('A'); withImage(wb, ws); withTable(ws); });
  assert.match(both.sheets[0].rowOps, /table/);

  const formulaElsewhere = await model((wb) => {
    const a = wb.addWorksheet('A'); withTable(a); withImage(wb, a);
    wb.addWorksheet('B', { state: 'hidden' }).getCell('A1').value = { formula: '1+1', result: 2 };
  });
  assert.equal(formulaElsewhere.sheets.length, 1);
  assert.equal(formulaElsewhere.sheets[0].rowOps, 'This workbook has formulas, so inserting or deleting rows could break them — do that in Excel');
});

// ---- lists -----------------------------------------------------------------

test('list sources: literal, same-sheet range, other sheet (plain and quoted), defined name', async () => {
  const wb = await roundTrip((wb) => {
    const ws = wb.addWorksheet('Main');
    const other = wb.addWorksheet('Other');
    const quoted = wb.addWorksheet("It's Mine", { state: 'hidden' });
    ['x', 'y', 'x', '', 'z'].forEach((v, i) => { if (v) other.getCell(i + 1, 1).value = v; });
    ['p', 'q'].forEach((v, i) => { quoted.getCell(i + 1, 1).value = v; });
    [1, 2, 3].forEach((v, i) => { ws.getCell(i + 2, 11).value = v; });                 // K2:K4
    wb.definedNames.add("'It''s Mine'!$A$1:$A$2", 'Pq');
    const dv = (cell, formulae, extra = {}) => { ws.getCell(cell).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: true, formulae, ...extra }; };
    dv('A1', ['"a, b ,,a,c"']);                       // literal: trimmed, blanks dropped, de-duplicated
    dv('A2', ['"say ""hi"",ok"']);                    // "" is a quote inside a literal
    dv('A3', ['$K$2:$K$4']);                          // same sheet
    dv('A4', ['Other!$A$1:$A$5']);                    // blanks dropped, duplicates removed
    dv('A5', ["'It''s Mine'!$A$1:$A$2"]);             // quoted sheet name, hidden source
    dv('A6', ['Pq']);                                 // defined name
    dv('A7', ['=Other!$A$1:$A$2']);                   // a leading '=' is tolerated
    dv('A8', ['INDIRECT("Other!A1:A3")']);            // can't be resolved: no list
    dv('A9', ['Nope!$A$1:$A$3']);                     // no such sheet: no list
    dv('A10', ['Missing']);                           // no such name: no list
    dv('A11', ['Other!$A$1:$B$3']);                   // two-dimensional: Excel doesn't allow it either
    dv('A12', ['"free,text"']);
  });
  wb.worksheets[0].dataValidations.model.A12.showErrorMessage = false;   // ExcelJS can't write an explicit 0, only read one
  const s = toModel(wb).sheets[0];
  const byCell = (cell) => s.lists.find((l) => l.ranges.some((r) => `${r.r1},${r.c1}` === cell));
  assert.deepEqual(byCell('0,0').items, ['a', 'b', 'c']);
  assert.deepEqual(byCell('1,0').items, ['say "hi"', 'ok']);
  assert.deepEqual(byCell('2,0').items, ['1', '2', '3']);
  assert.deepEqual(byCell('3,0').items, ['x', 'y', 'z']);
  assert.deepEqual(byCell('4,0').items, ['p', 'q']);
  assert.deepEqual(byCell('5,0').items, ['p', 'q']);
  assert.deepEqual(byCell('6,0').items, ['x', 'y']);
  for (const key of ['7,0', '8,0', '9,0', '10,0']) assert.equal(byCell(key), undefined, key);
  assert.equal(byCell('11,0').strict, false);
  assert.equal(byCell('0,0').strict, true);                                   // explicit showErrorMessage: true
  assert.equal(s.lists.length, 8);
});

test('lists: strict only when the file says showErrorMessage is on (absent means any text is accepted)', async () => {
  const wb = await roundTrip((b) => {
    const ws = b.addWorksheet('S');
    ws.getCell('A1').dataValidation = { type: 'list', allowBlank: true, formulae: ['"a,b"'] };                          // attribute omitted
    ws.getCell('A2').dataValidation = { type: 'list', allowBlank: true, showErrorMessage: true, formulae: ['"a,b"'] };  // explicit on
    ws.getCell('A3').dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: ['"c,d"'] }; // ExcelJS omits false too
  });
  assert.equal(wb.worksheets[0].dataValidations.model.A1.showErrorMessage, undefined, 'ExcelJS loads an omitted attribute as undefined');
  const lists = toModel(wb).sheets[0].lists;
  const at = (r) => lists.find((l) => l.ranges.some((g) => g.r1 <= r && r <= g.r2));
  assert.equal(at(0).strict, false);
  assert.equal(at(1).strict, true);
  assert.equal(at(2).strict, false);
  assert.equal(lists.length, 3, 'omitted and explicit-on are different groups now');
  const { sheets: [tracker] } = toModel(await loadWorkbook(await makeTracker()));
  assert.equal(tracker.lists[0].strict, true);
});

test('lists: identical validations group into rectangles; different ones stay apart', async () => {
  const wb = await roundTrip((wb) => {
    const ws = wb.addWorksheet('G');
    const list = (formula) => ({ type: 'list', formulae: [formula], showErrorMessage: true });
    for (let r = 2; r <= 5; r += 1) for (const c of [2, 3]) ws.getCell(r, c).dataValidation = list('"a,b"');       // B2:C5
    ws.getCell('B8').dataValidation = list('"a,b"');
    ws.getCell('B9').dataValidation = list('"a,b"');
    ws.getCell('E2').dataValidation = list('"a,b"');
    ws.getCell('F2').dataValidation = list('"c,d"');
    ws.getCell('H2').dataValidation = { type: 'whole', operator: 'between', formulae: [1, 5] };    // not a list
    ws.getCell('Z30').value = 1;
  });
  wb.worksheets[0].dataValidations.model.E2.showErrorMessage = false;   // the same list, but not strict: a separate group
  const s = toModel(wb).sheets[0];
  assert.equal(s.lists.length, 3);
  assert.deepEqual(s.lists[0].ranges, [{ r1: 1, c1: 1, r2: 4, c2: 2 }, { r1: 7, c1: 1, r2: 8, c2: 1 }]);
  assert.deepEqual(s.lists[0].items, ['a', 'b']);
  assert.equal(s.lists[0].strict, true);
  assert.equal(s.lists[1].strict, false);
  assert.deepEqual(s.lists[1].ranges, [{ r1: 1, c1: 4, r2: 1, c2: 4 }]);
  assert.deepEqual(s.lists[2].items, ['c', 'd']);
});

// ---- conditional formats ---------------------------------------------------

const red = { font: { color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC00000' } } };

test('cf: cellIs with literal operands, ref rules, relative and absolute refs', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('CF');
    ws.getCell('J20').value = 1;
    ws.addConditionalFormatting({
      ref: 'C4:C9 E4:E9',
      rules: [
        { type: 'cellIs', operator: 'greaterThan', priority: 3, formulae: ['10'], style: red },
        { type: 'cellIs', operator: 'between', priority: 2, formulae: ['1', '5.5'], style: red },
        { type: 'cellIs', operator: 'notBetween', priority: 4, formulae: ['-2', '0'], style: red },
        { type: 'cellIs', operator: 'equal', priority: 5, formulae: ['"a""b"'], style: red },
        { type: 'expression', priority: 1, formulae: ['A4>5'], style: red },
        { type: 'expression', priority: 6, formulae: ['$B$2<>"x"'], style: red },
        { type: 'expression', priority: 7, formulae: ['  B$4 <= 3  '], style: red },
      ],
    });
  });
  assert.equal(s.cfSkipped, 0);
  assert.equal(s.cf.length, 1);
  assert.deepEqual(s.cf[0].ranges, [{ r1: 3, c1: 2, r2: 8, c2: 2 }, { r1: 3, c1: 4, r2: 8, c2: 4 }]);
  const rules = s.cf[0].rules;
  assert.deepEqual(rules.map((r) => r.kind + ':' + r.op), ['ref:gt', 'cell:between', 'cell:gt', 'cell:notBetween', 'cell:eq', 'ref:ne', 'ref:le'], 'sorted by priority');
  const css = 'background:#c00000';
  assert.ok(rules.every((r) => r.css.includes(css) && r.css.includes('color:#ffffff') && r.stop === false));
  assert.deepEqual(rules[0].ref, { r: 0, c: -2, absR: false, absC: false });          // A4 from anchor C4
  assert.deepEqual(rules[0].values, [5]);
  assert.deepEqual(rules[1].values, [1, 5.5]);
  assert.ok(!('ref' in rules[1]));
  assert.deepEqual(rules[2].values, [10]);
  assert.deepEqual(rules[3].values, [-2, 0]);
  assert.deepEqual(rules[4].values, ['a"b']);
  assert.deepEqual(rules[5].ref, { r: 1, c: 1, absR: true, absC: true });             // $B$2: absolute indices
  assert.deepEqual(rules[5].values, ['x']);
  assert.deepEqual(rules[6].ref, { r: 3, c: -1, absR: true, absC: false });           // B$4: absolute row index 3, column B is anchor C - 1
});

test('cf: rules that can\'t be drawn are counted, not guessed', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('CF');
    ws.getCell('J20').value = 1;
    ws.addConditionalFormatting({
      ref: 'A1:A10',
      rules: [
        { type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFF0000' }, { argb: 'FF00FF00' }] },
        { type: 'expression', priority: 2, formulae: ['AND($A1="Open",$B1>1)'], style: red },      // compound
        { type: 'expression', priority: 3, formulae: ['$A1=$B1'], style: red },                    // cell vs cell
        { type: 'expression', priority: 4, formulae: ['Other!A1="x"'], style: red },               // other sheet
        { type: 'expression', priority: 5, formulae: ['$A1=TRUE'], style: red },                   // not a literal
        { type: 'expression', priority: 6, formulae: ['$A1=5%'], style: red },
        { type: 'cellIs', operator: 'equal', priority: 7, formulae: ['$K$1'], style: red },        // operand is a reference
        { type: 'containsText', operator: 'containsText', text: 'x', priority: 8, formulae: ['NOT(ISERROR(SEARCH("x",A1)))'], style: red },
        { type: 'top10', priority: 9, rank: 5, style: red },
        { type: 'expression', priority: 10, formulae: ['$A1="ok"'], style: red },               // the one that works
      ],
    });
    ws.addConditionalFormatting({
      ref: 'C1:C3',
      rules: [{ type: 'colorScale', priority: 11, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFF0000' }, { argb: 'FF00FF00' }] }],
    });
  });
  assert.equal(s.cfSkipped, 10);
  assert.equal(s.cf.length, 1, 'an entry with nothing drawable is dropped');
  assert.equal(s.cf[0].rules.length, 1);
  assert.deepEqual(s.cf[0].rules[0].values, ['ok']);
});

test('cf: whole-column and whole-row refs are clamped to the sheet; entries sort by priority', async () => {
  const { sheets: [s] } = await model((wb) => {
    const ws = wb.addWorksheet('CF');
    ws.getCell('E12').value = 1;
    ws.addConditionalFormatting({ ref: 'C:C', rules: [{ type: 'cellIs', operator: 'lessThan', priority: 5, formulae: ['0'], style: red }] });
    ws.addConditionalFormatting({ ref: '3:3', rules: [{ type: 'cellIs', operator: 'equal', priority: 2, formulae: ['0'], style: red }] });
  });
  assert.equal(s.cf.length, 2);
  assert.deepEqual(s.cf[0].ranges, [{ r1: 2, c1: 0, r2: 2, c2: 4 }], 'priority 2 first; row 3 across the 5 columns');
  assert.deepEqual(s.cf[1].ranges, [{ r1: 0, c1: 2, r2: 11, c2: 2 }]);
});

test('cf: stop follows stopIfTrue when ExcelJS exposes it', async () => {
  const wb = await roundTrip((b) => {
    const ws = b.addWorksheet('CF');
    ws.getCell('A1').value = 1;
    ws.addConditionalFormatting({ ref: 'A1:A5', rules: [{ type: 'cellIs', operator: 'equal', priority: 1, formulae: ['1'], style: red }] });
  });
  assert.equal(toModel(wb).sheets[0].cf[0].rules[0].stop, false);
  wb.worksheets[0].conditionalFormattings[0].rules[0].stopIfTrue = true;
  assert.equal(toModel(wb).sheets[0].cf[0].rules[0].stop, true);
});

// ---- the workbook is left alone ---------------------------------------------

test('toModel does not modify the workbook (no rows or cells created, no styles touched)', async () => {
  for (const buf of [await makeTracker(), await makePack()]) {
    const wb = await loadWorkbook(buf);
    const snapshot = () => JSON.stringify([wb.worksheets.map((ws) => [ws.model, ws.rowCount, ws.columnCount, ws.conditionalFormattings, ws.dataValidations.model]), wb.definedNames.model]);
    const before = snapshot();
    toModel(wb);
    toModel(wb);
    assert.equal(snapshot(), before);
  }
});
