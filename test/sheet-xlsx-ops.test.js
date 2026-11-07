'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { loadWorkbook, toModel, applyOps, shiftRows, writeVerified } = require('../lib/sheet-xlsx');
const { editText } = require('../lib/sheet-values');
const { makeTracker, makePack } = require('./fixtures');

// ---- the plan's tests, verbatim (one correction, see 'set keeps style and coerces') ----------------

const set = (r, c, v) => ({ op: 'set', sheet: 0, r, c, v }), ins = (at, n, like) => ({ op: 'insertRows', sheet: 0, at, n, like }), del = (at, n) => ({ op: 'deleteRows', sheet: 0, at, n });
async function after(ops, make = makeTracker) { const src = await make(); const wb = await loadWorkbook(src); applyOps(wb, ops); return (await loadWorkbook(await writeVerified(wb, src))).worksheets[0]; }
const merges = (ws) => Object.values(ws._merges).map((m) => m.range).sort();
// The plan typed '42' into B5, which holds the text 'Ops'; Task 4's coerceInput keeps a text cell text
// (ticket ids), so the coercion is shown on E5 (a number cell) instead, and B5 has its own test below.
test('set keeps style and coerces', async () => { const orig = (await loadWorkbook(await makeTracker())).worksheets[0]; const ws = await after([set(3, 5, 'Closed'), set(4, 4, '42')]); assert.equal(ws.getCell('F4').value, 'Closed'); assert.deepEqual(ws.getCell('F4').fill, orig.getCell('F4').fill); assert.equal(ws.getCell('E5').value, 42); });
test('set on a merged non-master is refused', async () => { const wb = await loadWorkbook(await makeTracker()); assert.throws(() => applyOps(wb, [set(1, 3, 'x')]), (e) => e.status === 400); });
test('insert above the section row: everything moves, CF re-anchors, merged border survives', async () => {
  const ws = await after([ins(1, 1, 1)]);
  assert.deepEqual(merges(ws), ['A17:G17', 'A3:G3']);
  assert.equal(ws.getCell('G3').border.right.style, 'medium');
  assert.equal(ws.dataValidations.find('F4').type, 'list'); assert.equal(ws.dataValidations.find('F3'), undefined);
  assert.match(ws.conditionalFormattings[0].ref, /^F4:F16/); assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], '$F4="Open"');
  assert.equal(ws.autoFilter, 'A1:G1'); assert.equal(ws.pageSetup.printArea, 'A1:G21');
});
test('insert above the first task row copies the task row, not the section row', async () => {
  const ws = await after([ins(2, 1, 2)]);                       // new Excel row 3, like = old row 3
  assert.equal(ws.dataValidations.find('F3').type, 'list');
  assert.equal(ws.conditionalFormattings[0].ref, 'F4:F16 F3'); // shifted range first (anchor F4), new cell appended
  assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], '$F4="Open"');
  assert.deepEqual(ws.getCell('A3').fill, ws.getCell('A4').fill); assert.equal(ws.getCell('A3').value, null);
});
test('insert inside the list range: DV + CF cover the new rows once, height from like', async () => {
  const ws = await after([ins(6, 2, 5)]);                       // new Excel rows 7–8, like = Excel row 6
  for (const a of ['F7', 'F8']) assert.equal(ws.dataValidations.find(a).type, 'list');
  assert.equal(ws.conditionalFormattings[0].ref.split(' ')[0], 'F3:F17');
  assert.equal(ws.getRow(7).height, ws.getRow(6).height);
  assert.deepEqual(merges(ws), ['A18:G18', 'A2:G2']);
});
test('delete the section row: merge dropped, rest moves up, CF re-anchors, border on G15 survives', async () => {
  const ws = await after([del(1, 1)]);
  assert.deepEqual(merges(ws), ['A15:G15']); assert.equal(ws.getCell('G15').border.right.style, 'medium');
  assert.match(ws.conditionalFormattings[0].ref, /^F2:F14/); assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], '$F2="Open"');
  assert.equal(ws.dataValidations.find('F15'), undefined);
});
test('row ops refused when the workbook has formulas', async () => { const wb = await loadWorkbook(await makePack()); assert.throws(() => applyOps(wb, [ins(2, 1, 1)]), /formulas/); });
test('fullCalcOnLoad written only when formulas exist', async () => {
  const calc = async (make, ops) => { const src = await make(); const wb = await loadWorkbook(src); applyOps(wb, ops); return (await JSZip.loadAsync(await writeVerified(wb, src))).file('xl/workbook.xml').async('string'); };
  assert.doesNotMatch(await calc(makeTracker, [set(3, 5, 'Closed')]), /fullCalcOnLoad="1"/);
  assert.match(await calc(makePack, [set(1, 0, 'x')]), /<calcPr[^>]*fullCalcOnLoad="1"/);
});

// ---- helpers for the extra cases --------------------------------------------------------------------

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// a workbook built in memory, as the bytes a file would have
async function bytes(build) {
  const wb = new ExcelJS.Workbook();
  await build(wb);
  return wb.xlsx.writeBuffer();
}

// the tracker with something more done to it
const trackerWith = (edit) => async () => {
  const wb = await loadWorkbook(await makeTracker());
  await edit(wb.worksheets[0], wb);
  return wb.xlsx.writeBuffer();
};

const refused = (wb, ops, message) => assert.throws(() => applyOps(wb, ops), (e) => {
  assert.equal(e.status, 400);
  if (message instanceof RegExp) assert.match(e.message, message);
  else if (message) assert.equal(e.message, message);
  return true;
});

// a workbook with one picture on its first sheet, so the output keeps one drawing part
const withPicture = () => bytes((wb) => {
  const ws = wb.addWorksheet('Pic');
  ws.getCell('A1').value = 'x';
  ws.addImage(wb.addImage({ buffer: PNG, extension: 'png' }), { tl: { col: 2, row: 2 }, ext: { width: 20, height: 20 } });
});

// the first drawing with one more anchor in it (a text box), which ExcelJS doesn't write back
async function withTextBox(buf) {
  const zip = await JSZip.loadAsync(buf);
  const name = Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
  const xml = await zip.file(name).async('string');
  const box = '<xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
    + '<xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
    + '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="9" name="TextBox 1"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>'
    + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
    + '<xdr:txBody><a:bodyPr/><a:p><a:r><a:t>note</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>';
  zip.file(name, xml.replace('</xdr:wsDr>', box + '</xdr:wsDr>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const CUSTOM_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const CUSTOM_XML = '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ContentTypeId"><vt:lpwstr xmlns:vt="x">0x0101</vt:lpwstr></property></Properties>';

// custom properties added the way Excel writes them: the part, a content-type override and a package relationship
async function withCustomProperties(buf) {
  const zip = await JSZip.loadAsync(buf);
  zip.file('docProps/custom.xml', CUSTOM_XML);
  const rels = await zip.file('_rels/.rels').async('string');
  zip.file('_rels/.rels', rels.replace('</Relationships>', `<Relationship Id="rId99" Type="${CUSTOM_REL}" Target="docProps/custom.xml"/></Relationships>`));
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_TYPE}"/></Types>`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---- validation ---------------------------------------------------------------------------------------

test('ops must be a list of known ops, at most 50,000 of them', async () => {
  const wb = await loadWorkbook(await makeTracker());
  refused(wb, 'not a list');
  refused(wb, [{ op: 'nope', sheet: 0 }]);
  refused(wb, [null]);
  refused(wb, Array.from({ length: 50001 }, () => set(40, 9, '')));
  applyOps(wb, []);
  applyOps(wb, Array.from({ length: 50000 }, () => set(40, 9, '')));   // all no-ops, but allowed
});

test('sheet must be the position of a visible worksheet', async () => {
  const wb = await loadWorkbook(await makePack());                     // Overview, Lists (hidden), Detail
  for (const sheet of [1, 3, -1, '0', 0.5, null, undefined]) refused(wb, [{ op: 'set', sheet, r: 0, c: 0, v: 'x' }]);
  applyOps(wb, [{ op: 'set', sheet: 2, r: 4, c: 3, v: 'owner-x' }]);
  assert.equal(wb.worksheets[2].getCell('D5').value, 'owner-x');
  assert.equal(wb.worksheets[1].getCell('A1').value, 'Low', 'the hidden sheet is untouched');
});

test('set: r and c inside Excel, v a string of at most 32,767 characters', async () => {
  const wb = await loadWorkbook(await makeTracker());
  for (const [r, c] of [[1048576, 0], [0, 16384], [-1, 0], [0, -1], [1.5, 0], ['1', 0], [0, null]]) refused(wb, [set(r, c, 'x')]);
  for (const v of [42, null, undefined, { text: 'x' }, 'x'.repeat(32768)]) refused(wb, [set(20, 0, v)]);
  applyOps(wb, [set(20, 0, 'x'.repeat(32767)), set(1048575, 16383, 'corner')]);
  assert.equal(wb.worksheets[0].getCell('XFD1048576').value, 'corner');
});

test('row ops: n from 1 to 1,000, at inside the sheet, like null or the row above or at', async () => {
  const wb = await loadWorkbook(await makeTracker());
  for (const n of [0, 1001, 1.5, -1, '1']) { refused(wb, [ins(3, n, null)]); refused(wb, [del(3, n)]); }
  for (const at of [-1, 1048576, 2.5]) { refused(wb, [ins(at, 1, null)]); refused(wb, [del(at, 1)]); }
  refused(wb, [del(1048575, 2)], /outside/);
  for (const like of [4, 1, 'x', 3.5, -1]) refused(wb, [ins(3, 1, like)]);
  refused(wb, [ins(0, 1, -1)]);
  applyOps(wb, [ins(3, 1, null), ins(3, 1, 2), ins(3, 1, 3), ins(0, 1, 0), { op: 'insertRows', sheet: 0, at: 3, n: 1 }]);
  applyOps(wb, [ins(3, 1000, 3), del(3, 1000)]);
});

test('a formula cell is refused with its address', async () => {
  const wb = await loadWorkbook(await makePack());
  refused(wb, [{ op: 'set', sheet: 0, r: 3, c: 1, v: '6' }], 'B4 has a formula — edit formulas in Excel');
});

test('the merged non-master refusal names the cell to edit instead', async () => {
  const wb = await loadWorkbook(await makeTracker());
  refused(wb, [set(1, 6, 'x')], /^G2 .*A2/);
  applyOps(wb, [set(1, 0, 'Build')]);                                 // the master itself is fine
  assert.equal(wb.worksheets[0].getCell('A2').value, 'Build');
});

test('a protected sheet refuses every op', async () => {
  const buf = await bytes(async (wb) => { const ws = wb.addWorksheet('P'); ws.getCell('A1').value = 'a'; await ws.protect(); });
  const wb = await loadWorkbook(buf);
  for (const op of [set(0, 0, 'b'), ins(0, 1, null), del(0, 1)]) refused(wb, [op], 'This sheet is protected in Excel');
});

test('Ruling 9: a sheet too big to draw refuses every op', async () => {
  const buf = await bytes((wb) => { const ws = wb.addWorksheet('Big'); ws.getCell('A1').value = 'a'; ws.getCell('B30001').value = 1; });
  const wb = await loadWorkbook(buf);                                  // 30001 rows x 2 columns > 60000 cells
  for (const op of [set(0, 0, 'b'), ins(0, 1, null), del(0, 1)]) refused(wb, [op], 'This sheet is too big to edit here — edit it in Excel');
});

test('row ops are refused on a sheet with pictures, with that reason', async () => {
  const wb = await loadWorkbook(await withPicture());
  refused(wb, [ins(0, 1, null)], /pictures/);
  applyOps(wb, [set(0, 0, 'y')]);
});

test('ops apply in order: a set after an insert lands in the new row', async () => {
  const ws = await after([ins(3, 1, 3), set(3, 0, 'New task')]);
  assert.equal(ws.getCell('A4').value, 'New task');
  assert.equal(ws.getCell('A5').value, 'Task 02');
  assert.equal(ws.getCell('F5').value, 'Open');
});

// ---- set ------------------------------------------------------------------------------------------------

test('set: typing a number into a text cell keeps it text (B5 holds "Ops")', async () => {
  const ws = await after([set(4, 1, '42')]);
  assert.equal(ws.getCell('B5').value, '42');
});

test('Ruling 10: a set that repeats the edit text leaves the cell alone', async () => {
  const rich = { richText: [{ text: 'Hel' }, { font: { bold: true }, text: 'lo' }] };
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = rich;
    ws.getCell('A2').value = new Date(Date.UTC(2026, 2, 12, 9, 5, 0, 250));
    ws.getCell('A2').numFmt = 'mmm yyyy';
  });
  const src = await make();
  const wb = await loadWorkbook(src);
  const date = wb.worksheets[0].getCell('A2');
  const when = date.value.getTime();
  applyOps(wb, [set(0, 0, 'Hello'), set(1, 0, editText(date.value, date.numFmt)), set(9, 9, '')]);
  assert.equal(wb.worksheets[0].findCell('J10'), undefined, 'an empty set on an absent cell creates nothing');
  const ws = (await loadWorkbook(await writeVerified(wb, src))).worksheets[0];
  assert.deepEqual(ws.getCell('A1').value, rich, 'rich text is not flattened by an unchanged commit');
  assert.equal(ws.getCell('A2').value.getTime(), when);
  assert.equal(ws.getCell('A2').numFmt, 'mmm yyyy');
});

test('set: rich text becomes plain text, blanks clear, style stays', async () => {
  const src = await bytes((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = { richText: [{ text: 'a' }, { font: { bold: true }, text: 'b' }] };
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    ws.getCell('A2').value = 'gone';
    ws.getCell('A2').font = { italic: true };
  });
  const wb = await loadWorkbook(src);
  applyOps(wb, [set(0, 0, 'plain'), set(1, 0, '')]);
  const ws = (await loadWorkbook(await writeVerified(wb, src))).worksheets[0];
  assert.equal(ws.getCell('A1').value, 'plain');
  assert.equal(ws.getCell('A1').fill.fgColor.argb, 'FFFFFF00');
  assert.equal(ws.getCell('A2').value, null);
  assert.equal(ws.getCell('A2').font.italic, true);
});

// ---- row shifting -----------------------------------------------------------------------------------------

test('insert below the last task row: the new row gets the list and an appended CF cell', async () => {
  const ws = await after([ins(15, 1, 14)]);                    // new Excel row 16, like = Excel row 15
  assert.equal(ws.conditionalFormattings[0].ref, 'F3:F15 F16');
  assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], '$F3="Open"');
  assert.equal(ws.dataValidations.find('F16').type, 'list');
  assert.deepEqual(merges(ws), ['A17:G17', 'A2:G2']);
  assert.equal(ws.getCell('A17').value, 'Wrap-up');
});

test('CF coverage for several columns is one range; relative formulas follow the anchor', async () => {
  const make = trackerWith((ws) => {
    ws.addConditionalFormatting({ ref: 'B3:D15', rules: [{ type: 'expression', priority: 2, formulae: ['$E3>1'], style: { font: { bold: true } } }] });
  });
  const ws = await after([ins(2, 1, 2)], make);
  const cf = ws.conditionalFormattings.find((e) => e.ref.startsWith('B'));
  assert.equal(cf.ref, 'B4:D16 B3:D3');
  assert.equal(cf.rules[0].formulae[0], '$E4>1');
});

test('a delete band holding a whole CF range drops that entry', async () => {
  const make = trackerWith((ws) => {
    ws.addConditionalFormatting({ ref: 'B5:C6', rules: [{ type: 'expression', priority: 2, formulae: ['$B5="x"'], style: { font: { bold: true } } }] });
  });
  assert.equal((await loadWorkbook(await make())).worksheets[0].conditionalFormattings.length, 2);
  const ws = await after([del(4, 2)], make);                   // Excel rows 5–6
  assert.equal(ws.conditionalFormattings.length, 1);
  assert.equal(ws.conditionalFormattings[0].ref, 'F3:F13');
  assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], '$F3="Open"');
});

test('notes, links, rich text, dates and booleans move with their row', async () => {
  const rich = { richText: [{ text: 'Hel' }, { font: { bold: true }, text: 'lo' }] };
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'head';
    ws.getCell('A3').value = 'with note';
    ws.getCell('A3').note = 'a note';
    ws.getCell('B3').value = { text: 'site', hyperlink: 'https://example.invalid/' };
    ws.getCell('C3').value = rich;
    ws.getCell('D3').value = new Date(Date.UTC(2026, 9, 6));
    ws.getCell('D3').numFmt = 'dd/mm/yyyy';
    ws.getCell('E3').value = true;
  });
  const ws = await after([ins(1, 2, null)], make);
  assert.equal(ws.getCell('A5').value, 'with note');
  assert.equal(ws.getCell('A5').note, 'a note');
  assert.deepEqual(ws.getCell('B5').value, { text: 'site', hyperlink: 'https://example.invalid/' });
  assert.deepEqual(ws.getCell('C5').value, rich);
  assert.equal(ws.getCell('D5').value.getTime(), Date.UTC(2026, 9, 6));
  assert.equal(ws.getCell('D5').numFmt, 'dd/mm/yyyy');
  assert.equal(ws.getCell('E5').value, true);
  for (const a of ['A3', 'B3', 'C3', 'D3', 'E3']) assert.equal(ws.getCell(a).value, null, a);
  assert.equal(ws.getCell('A3').note, undefined);

  const back = await after([del(0, 2)], make);                 // the head row and the empty row 2 go
  assert.equal(back.getCell('A1').value, 'with note');
  assert.equal(back.getCell('A1').note, 'a note');
  assert.equal(back.getCell('B1').value.hyperlink, 'https://example.invalid/');
});

test('hidden rows and outline levels move with their rows', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 8; r++) ws.getCell(r, 1).value = `row ${r}`;
    ws.getRow(5).hidden = true;
    ws.getRow(6).outlineLevel = 1;
  });
  const ws = await after([ins(2, 2, null)], make);
  assert.equal(ws.getRow(7).hidden, true);
  assert.equal(ws.getCell('A7').value, 'row 5');
  assert.equal(ws.getRow(8).outlineLevel, 1);
  assert.equal(ws.getRow(5).hidden, false);
  assert.equal(ws.getRow(6).outlineLevel, 0);
  const back = await after([ins(2, 2, null), del(2, 2)], make);
  assert.equal(back.getRow(5).hidden, true);
  assert.equal(back.getRow(6).outlineLevel, 1);
  assert.equal(back.getRow(7).hidden, false);
});

test('inserted rows take like\'s height and styles but never its values, merges or hidden state', async () => {
  const ws = await after([ins(1, 1, 1)]);                      // like = the merged section row
  assert.equal(ws.getRow(2).height, 24);
  assert.equal(ws.getCell('A2').value, null);
  assert.equal(ws.getCell('A2').font.bold, true);
  assert.equal(ws.getCell('G2').border.right.style, 'medium');
  assert.equal(ws.getCell('G2').type, ExcelJS.ValueType.Null, 'no merge on the new row');
  assert.deepEqual(merges(ws), ['A17:G17', 'A3:G3']);
});

test('styles are cloned for new rows, and no shared style object is changed', async () => {
  const wb = await loadWorkbook(await makeTracker());
  const ws = wb.worksheets[0];
  const band = ws.getCell('A2').style;                         // shared with B2:F2
  assert.equal(ws.getCell('B2').style, band);
  const task = ws.getCell('D4').style;
  const snap = JSON.stringify([band, task, ws.getCell('G2').style]);
  applyOps(wb, [ins(1, 2, 1), ins(4, 1, 4), set(5, 3, '13/10/2026'), del(8, 1)]);
  assert.equal(JSON.stringify([band, task, ws.getCell('G4').style]), snap, 'the old objects are as they were');
  assert.equal(ws.getCell('A4').style, band, 'a moved cell keeps its style object');
  assert.notEqual(ws.getCell('A2').style, band, 'a new cell has its own copy');
  assert.notEqual(ws.getCell('A3').style, ws.getCell('A2').style, 'each new cell has its own copy');
  assert.deepEqual(ws.getCell('A2').style, band);
});

test('shiftRows works on the workbook in memory', async () => {
  const wb = await loadWorkbook(await makeTracker());
  const ws = wb.worksheets[0];
  shiftRows(ws, wb, 0, 2);
  assert.equal(ws.getCell('A3').value, 'Task');
  assert.equal(ws.getCell('A4').value, 'Environments');
  assert.equal(ws.getCell('B4').type, ExcelJS.ValueType.Merge);
  assert.equal(ws.autoFilter, 'A3:G3');
  assert.deepEqual(merges(ws), ['A18:G18', 'A4:G4']);
  shiftRows(ws, wb, 0, -2);
  assert.equal(ws.getCell('A1').value, 'Task');
  assert.equal(ws.autoFilter, 'A1:G1');
  assert.deepEqual(merges(ws), ['A16:G16', 'A2:G2']);
});

test('validation formulas on the sheet follow their target rows', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    ['Low', 'Mid', 'High'].forEach((v, i) => { ws.getCell(`H${i + 2}`).value = v; });
    for (let r = 2; r <= 5; r++) ws.getCell(`B${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['$H$2:$H$4'] };
    ws.getCell('C2').dataValidation = { type: 'list', allowBlank: true, formulae: ['Other!$A$1:$A$3'] };
    wb.addWorksheet('Other');
  });
  const ws = await after([ins(1, 1, null)], make);
  assert.equal(ws.dataValidations.find('B2'), undefined);
  for (const a of ['B3', 'B4', 'B5', 'B6']) assert.deepEqual(ws.dataValidations.find(a).formulae, ['$H$3:$H$5'], a);
  assert.deepEqual(ws.dataValidations.find('C3').formulae, ['Other!$A$1:$A$3']);
  const grown = await after([ins(3, 1, 2)], make);             // inside the list source and the list
  assert.deepEqual(grown.dataValidations.find('B4').formulae, ['$H$2:$H$5']);
  assert.deepEqual(grown.dataValidations.find('B3').formulae, ['$H$2:$H$5']);
});

test('defined names on the sheet move, grow inside and shrink like ranges do', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('My Sheet');
    for (let r = 1; r <= 6; r++) ws.getCell(r, 1).value = `v${r}`;
    wb.definedNames.add("'My Sheet'!$A$2:$A$4", 'Things');
  });
  const names = async (ops) => {
    const src = await make();
    const wb = await loadWorkbook(src);
    applyOps(wb, ops);
    return (await loadWorkbook(await writeVerified(wb, src))).definedNames.model;
  };
  assert.deepEqual(await names([ins(0, 1, null)]), [{ name: 'Things', ranges: ["'My Sheet'!$A$3:$A$5"] }]);
  assert.deepEqual(await names([ins(2, 2, 1)]), [{ name: 'Things', ranges: ["'My Sheet'!$A$2:$A$6"] }]);
  assert.deepEqual(await names([ins(1, 1, 1)]), [{ name: 'Things', ranges: ["'My Sheet'!$A$3:$A$5"] }]);
  assert.deepEqual(await names([ins(4, 1, 3)]), [{ name: 'Things', ranges: ["'My Sheet'!$A$2:$A$4"] }]);
  assert.deepEqual(await names([del(2, 1)]), [{ name: 'Things', ranges: ["'My Sheet'!$A$2:$A$3"] }]);
});

test('print titles move with their rows; a print area wholly deleted goes', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 10; r++) ws.getCell(r, 1).value = r;
    ws.pageSetup.printTitlesRow = '2:3';
    ws.pageSetup.printArea = 'A1:C10&&E4:F5';
  });
  const ws = await after([ins(0, 1, null)], make);
  assert.equal(ws.pageSetup.printTitlesRow, '3:4');
  assert.equal(ws.pageSetup.printArea, 'A2:C11&&E5:F6');
  const gone = await after([del(3, 2)], make);                 // Excel rows 4–5
  assert.equal(gone.pageSetup.printArea, 'A1:C8');
});

test('rows are never pushed off the end of the sheet; validations and formats there are clipped', async () => {
  // (applyOps can't get here: a sheet with a row that far down is too big to edit, Ruling 9)
  const full = await loadWorkbook(await bytes((w) => { const ws = w.addWorksheet('S'); ws.getCell('A1048576').value = 'last'; }));
  assert.throws(() => shiftRows(full.worksheets[0], full, 5, 1), (e) => e.status === 400 && /end of the sheet/.test(e.message));

  const src = await bytes((w) => {
    const ws = w.addWorksheet('S');
    ws.getCell('A1').value = 'first';
    ws.dataValidations.add('F1048575', { type: 'list', allowBlank: true, formulae: ['"a,b"'] });   // no cells there
    ws.dataValidations.add('F1048576', { type: 'list', allowBlank: true, formulae: ['"c,d"'] });
    ws.addConditionalFormatting({ ref: 'G5:G1048576', rules: [{ type: 'expression', priority: 1, formulae: ['G5>1'], style: { font: { bold: true } } }] });
  });
  const ws = await after([ins(0, 1, null)], async () => src);
  assert.deepEqual(ws.dataValidations.find('F1048576').formulae, ['"a,b"']);
  assert.equal(ws.conditionalFormattings[0].ref, 'G6:G1048576');
  assert.equal(ws.conditionalFormattings[0].rules[0].formulae[0], 'G6>1');
});

// ---- writeVerified --------------------------------------------------------------------------------------

test('writeVerified carries custom properties over', async () => {
  const src = await withCustomProperties(await makeTracker());
  const wb = await loadWorkbook(src);
  applyOps(wb, [set(3, 5, 'Closed'), ins(3, 1, 3)]);
  const out = await writeVerified(wb, src);
  const zip = await JSZip.loadAsync(out);
  assert.deepEqual(await zip.file('docProps/custom.xml').async('nodebuffer'), Buffer.from(CUSTOM_XML));
  assert.match(await zip.file('_rels/.rels').async('string'), /<Relationship\b[^>]*Target="docProps\/custom\.xml"/);
  assert.match(await zip.file('[Content_Types].xml').async('string'), /PartName="\/docProps\/custom\.xml"/);
  assert.equal((await loadWorkbook(out)).worksheets[0].getCell('F5').value, 'Closed');
});

const saveRefused = async (promise, what) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, 422);
    assert.equal(e.message, `Saving would have lost ${what} — nothing was changed`);
    return true;
  });
};

test('writeVerified refuses a save that drops a shape from a drawing', async () => {
  const src = await withTextBox(await withPicture());
  const wb = await loadWorkbook(src);
  applyOps(wb, [set(0, 0, 'y')]);
  await saveRefused(writeVerified(wb, src), 'shapes or pictures');
});

test('writeVerified refuses a save that drops a merge', async () => {
  const zip = await JSZip.loadAsync(await makeTracker());
  const xml = (await zip.file('xl/worksheets/sheet1.xml').async('string')).replace(/<mergeCells count="(\d+)">/, (_m, n) => `<mergeCells count="${Number(n) + 1}"><mergeCell ref="B5"/>`);
  zip.file('xl/worksheets/sheet1.xml', xml);
  const src = await zip.generateAsync({ type: 'nodebuffer' });
  const wb = await loadWorkbook(src);                          // ExcelJS keeps the one-cell merge in memory, drops it on write
  applyOps(wb, [set(3, 5, 'Closed')]);
  await saveRefused(writeVerified(wb, src), 'merged cells');
});

test('writeVerified compares sheets and column widths with what was written', async () => {
  const src = await makeTracker();
  const other = await loadWorkbook(src);
  other.worksheets[0].name = 'Renamed';
  other.worksheets[0].getColumn(2).width = 5;
  const otherBuf = await other.xlsx.writeBuffer();
  const wb = await loadWorkbook(src);
  wb.xlsx.writeBuffer = async () => otherBuf;                  // stands in for a writer that got it wrong
  await saveRefused(writeVerified(wb, src), 'sheets and column widths');
});

test('writeVerified on an unchanged workbook gives a file that reads back the same', async () => {
  for (const make of [makeTracker, makePack]) {
    const src = await make();
    const wb = await loadWorkbook(src);
    const out = await writeVerified(wb, src);
    const back = await loadWorkbook(out);
    assert.deepEqual(back.worksheets.map((ws) => ws.name), wb.worksheets.map((ws) => ws.name));
  }
});

// ---- Fix round 1 ------------------------------------------------------------------------------------------

test('Ruling 19: a list run grows when rows go inside it, like or not', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 30; r++) ws.getCell(`H${r}`).value = r;
    for (let r = 1; r <= 30; r++) ws.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"a,b"'] };
  });
  const ws = await after([ins(5, 1, null)], make);
  for (let r = 1; r <= 31; r++) assert.equal(ws.dataValidations.find(`I${r}`)?.type, 'list', `I${r}`);
  assert.equal(ws.dataValidations.find('I32'), undefined);
  const edge = await after([ins(30, 2, null)], make);         // below the run: nothing to grow
  assert.equal(edge.dataValidations.find('I31'), undefined);
  assert.equal(edge.dataValidations.find('I30').type, 'list');
});

test('Ruling 19: any kind of validation grows inside its run; like copies only lists at the edge', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 12; r++) ws.getCell(`A${r}`).value = r;
    for (let r = 5; r <= 9; r++) ws.getCell(`O${r}`).dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 5] };
  });
  const inside = await after([ins(6, 1, 5)], make);
  for (let r = 5; r <= 10; r++) assert.equal(inside.dataValidations.find(`O${r}`)?.type, 'whole', `O${r}`);
  const below = await after([ins(9, 1, 8)], make);             // new Excel row 10, like = the run's last row
  assert.equal(below.dataValidations.find('O10'), undefined, 'like copies lists only');
  assert.equal(below.dataValidations.find('O9').type, 'whole');
});

test('Ruling 19: equal validations held in separate objects still count as one run', async () => {
  const wb = await loadWorkbook(await bytes((w) => { const ws = w.addWorksheet('S'); ws.getCell('A1').value = 1; }));
  const ws = wb.worksheets[0];
  for (const a of ['B2', 'B3', 'B4']) ws.dataValidations.add(a, { type: 'list', allowBlank: true, formulae: ['"x,y"'] });
  assert.notEqual(ws.dataValidations.find('B2'), ws.dataValidations.find('B3'));
  shiftRows(ws, wb, 2, 2);                                     // between B2 and B3
  for (const a of ['B2', 'B3', 'B4', 'B5', 'B6']) assert.equal(ws.dataValidations.find(a)?.type, 'list', a);
});

test('Ruling 20: at most 200 row ops and 5,000 inserted rows per save', async () => {
  const wb = await loadWorkbook(await makeTracker());
  const message = 'Too many rows added or removed in one save — save more often';
  refused(wb, Array.from({ length: 201 }, () => ins(20, 1, null)), message);
  refused(wb, Array.from({ length: 6 }, () => ins(20, 1000, null)), message);
  refused(wb, [...Array.from({ length: 100 }, () => ins(20, 1, null)), ...Array.from({ length: 101 }, () => del(20, 1))], message);
  assert.equal(wb.worksheets[0].rowCount, 16, 'refused before anything was applied');
  applyOps(wb, [...Array.from({ length: 100 }, () => ins(20, 1, null)), ...Array.from({ length: 100 }, () => del(20, 1))]);
  applyOps(wb, Array.from({ length: 5 }, () => ins(20, 1000, null)));
});

test('Ruling 20: a row op that makes the sheet too big to draw is refused', async () => {
  const wb = await loadWorkbook(await bytes((w) => { const ws = w.addWorksheet('S'); ws.getCell('A1').value = 1; ws.getCell('G8000').value = 2; }));
  assert.equal(toModel(wb).sheets[0].tooBig, false);           // 8000 x 7 = 56,000 cells
  refused(wb, [ins(0, 1000, null)], 'This sheet is too big to edit here — edit it in Excel');
  applyOps(await loadWorkbook(await bytes((w) => { const ws = w.addWorksheet('S'); ws.getCell('A1').value = 1; ws.getCell('G8000').value = 2; })), [ins(0, 500, null)]);
});

// Main has a list whose source is on the visible Lists sheet
const crossSheet = (source, name = 'Lists') => () => bytes((wb) => {
  const main = wb.addWorksheet('Main');
  const lists = wb.addWorksheet(name);
  ['Low', 'Medium', 'High'].forEach((v, i) => { lists.getCell(i + 1, 1).value = v; });
  for (let r = 2; r <= 5; r++) main.getCell(`B${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [source] };
  wb.addWorksheet('MyLists').getCell('A1').value = 'x';
});
const REFERENCED = "Other sheets' dropdowns or colour rules point at this sheet, so add or remove rows in Excel";

test('Ruling 21: a sheet another sheet\'s dropdown points at takes no row ops, and says why', async () => {
  for (const [source, name] of [['Lists!$A$1:$A$3'], ["'My Lists'!$A$1:$A$3", 'My Lists'], ["'MY LISTS'!$A$1:$A$3", 'My Lists'], ['lists!$A$1:$A$3']]) {
    const wb = await loadWorkbook(await crossSheet(source, name)());
    const { sheets } = toModel(wb);
    assert.equal(sheets[1].rowOps, REFERENCED, source);
    assert.equal(sheets[0].rowOps, null, 'the sheet holding the dropdown is fine');
    assert.equal(sheets[2].rowOps, null, 'MyLists is another sheet');
    refused(wb, [{ op: 'insertRows', sheet: 1, at: 1, n: 1, like: null }], REFERENCED);
    applyOps(wb, [ins(1, 1, null), { op: 'set', sheet: 1, r: 0, c: 1, v: 'set is fine' }]);
  }
  const other = toModel(await loadWorkbook(await crossSheet('MyLists!$A$1:$A$3')()));
  assert.equal(other.sheets[1].rowOps, null, 'MyLists! does not name Lists');
  assert.equal(other.sheets[2].rowOps, REFERENCED);
});

test('Ruling 21: a colour rule on another sheet counts too', async () => {
  const buf = await bytes((wb) => {
    const main = wb.addWorksheet('Main');
    wb.addWorksheet('Data').getCell('A1').value = 5;
    main.getCell('A1').value = 1;
    main.addConditionalFormatting({ ref: 'A1:A5', rules: [{ type: 'expression', priority: 1, formulae: ['A1>Data!$A$1'], style: { font: { bold: true } } }] });
  });
  assert.equal(toModel(await loadWorkbook(buf)).sheets[1].rowOps, REFERENCED);
});

test('Ruling 22: deleting the row that holds the only note saves, and the file has no notes', async () => {
  const src = await bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 6; r++) ws.getCell(r, 1).value = `r${r}`;
    ws.getCell('A4').note = 'only note';
  });
  const wb = await loadWorkbook(src);
  applyOps(wb, [del(3, 1)]);
  const out = await writeVerified(wb, src);
  const zip = await JSZip.loadAsync(out);
  assert.equal(Object.keys(zip.files).filter((n) => /comments/.test(n)).length, 0);
  const ws = (await loadWorkbook(out)).worksheets[0];
  assert.equal(ws.getCell('A4').value, 'r5');
  assert.equal(ws.getCell('A4').note, undefined);
});

test('Ruling 22: writeVerified refuses output that holds a different number of notes', async () => {
  const src = await bytes((wb) => { const ws = wb.addWorksheet('S'); ws.getCell('A1').value = 'x'; ws.getCell('A1').note = 'n'; });
  const plain = await bytes((wb) => { wb.addWorksheet('S').getCell('A1').value = 'x'; });
  const wb = await loadWorkbook(src);
  wb.xlsx.writeBuffer = async () => plain;                     // a writer that dropped the note
  await saveRefused(writeVerified(wb, src), 'notes');
  const kept = await loadWorkbook(src);
  applyOps(kept, [ins(0, 2, null)]);
  assert.equal((await loadWorkbook(await writeVerified(kept, src))).worksheets[0].getCell('A3').note, 'n');
});

// rows 1–4 frozen, the scrolling pane starting at row 5
const frozen4 = () => bytes((wb) => {
  const ws = wb.addWorksheet('S', { views: [{ state: 'frozen', ySplit: 4, topLeftCell: 'A5' }] });
  for (let r = 1; r <= 12; r++) ws.getCell(r, 1).value = r;
});
const pane = (ws) => ({ state: ws.views[0].state, ySplit: ws.views[0].ySplit, topLeftCell: ws.views[0].topLeftCell });

test('Ruling 24: the freeze line follows the rows above it', async () => {
  assert.deepEqual(pane(await after([ins(1, 2, 1)], frozen4)), { state: 'frozen', ySplit: 6, topLeftCell: 'A7' });
  assert.deepEqual(pane(await after([ins(4, 2, 3)], frozen4)), { state: 'frozen', ySplit: 4, topLeftCell: 'A5' }, 'at the line: below it');
  assert.deepEqual(pane(await after([ins(8, 1, 7)], frozen4)), { state: 'frozen', ySplit: 4, topLeftCell: 'A5' });
  assert.deepEqual(pane(await after([del(0, 2)], frozen4)), { state: 'frozen', ySplit: 2, topLeftCell: 'A3' });
  assert.deepEqual(pane(await after([del(3, 3)], frozen4)), { state: 'frozen', ySplit: 3, topLeftCell: 'A4' }, 'a band across the line');
  assert.deepEqual(pane(await after([del(6, 3)], frozen4)), { state: 'frozen', ySplit: 4, topLeftCell: 'A5' });
  const gone = await after([del(0, 5)], frozen4);
  assert.equal(gone.views[0].state, 'normal');
  assert.equal(toModel(await loadWorkbook(await makeTracker())).sheets[0].frozen.rows, 1);
  const header = await after([del(0, 1)]);                     // the tracker's only frozen row
  assert.equal(header.views[0].state, 'normal');
  assert.equal(pane(await after([ins(0, 1, null)])).ySplit, 2);
});

test('Ruling 24: frozen columns stay frozen when the frozen rows go', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1, topLeftCell: 'B2' }] });
    for (let r = 1; r <= 5; r++) ws.getCell(r, 1).value = r;
  });
  const ws = await after([del(0, 1)], make);
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.views[0].xSplit, 1);
  assert.equal(ws.views[0].ySplit || 0, 0);
});

test('Ruling 24: inserted rows take like\'s outline level', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 8; r++) ws.getCell(r, 1).value = r;
    for (const r of [3, 4, 5]) ws.getRow(r).outlineLevel = 1;
  });
  // each new row gets text, as an edit would: ExcelJS writes no row that has nothing in it
  const ws = await after([ins(4, 1, 4), ins(1, 1, null), ins(8, 1, 7), set(5, 0, 'g'), set(1, 0, 'n'), set(8, 0, 'u')], make);
  assert.equal(ws.getCell('A6').value, 'g');
  assert.equal(ws.getRow(6).outlineLevel, 1, 'inside the group, like a grouped row (kept while the later inserts moved it)');
  assert.equal(ws.getRow(2).outlineLevel, 0, 'no like');
  assert.equal(ws.getRow(9).outlineLevel, 0, 'like an ungrouped row');
  for (const r of [4, 5, 7]) assert.equal(ws.getRow(r).outlineLevel, 1, `row ${r}`);
});

// ---- Fix round 1b ---------------------------------------------------------------------------------------

test('Ruling 25: writeVerified refuses a save that would drop a hidden or grouped row', async () => {
  const src = await makeTracker();
  for (const mark of [(row) => { row.hidden = true; }, (row) => { row.outlineLevel = 1; }]) {
    const wb = await loadWorkbook(src);
    mark(wb.worksheets[0].getRow(30));                         // an empty row: ExcelJS writes no <row> for it
    await saveRefused(writeVerified(wb, src), 'hidden or grouped rows');
  }
  const wb = await loadWorkbook(src);
  wb.worksheets[0].getRow(14).hidden = true;                   // a row with cells is written, hidden
  const ws = (await loadWorkbook(await writeVerified(wb, src))).worksheets[0];
  assert.equal(ws.getRow(14).hidden, true);
});

test('Ruling 25: a hidden row that a delete takes away is no loss', async () => {
  const src = await bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 6; r++) ws.getCell(r, 1).value = r;
    ws.getRow(4).hidden = true;
  });
  const wb = await loadWorkbook(src);
  applyOps(wb, [del(3, 1)]);
  const ws = (await loadWorkbook(await writeVerified(wb, src))).worksheets[0];
  assert.equal(ws.getCell('A4').value, 5);
  assert.equal([1, 2, 3, 4, 5].some((r) => ws.getRow(r).hidden), false);
});

// ---- Fix round 2 ----------------------------------------------------------------------------------------

test('a blank row inserted inside a group keeps its row and its outline level', async () => {
  const make = () => bytes((wb) => {
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 8; r++) ws.getCell(r, 1).value = r;
    for (const r of [3, 4, 5]) ws.getRow(r).outlineLevel = 1;
  });
  for (const op of [ins(4, 1, 3), ins(3, 1, 3)]) {
    const ws = await after([op], make);                       // writeVerified would refuse if the row were not written
    const r = op.at + 1;
    assert.equal(ws.getRow(r).outlineLevel, 1, `new row ${r}`);
    assert.equal(ws.getRow(r).height, 15, 'the sheet default height');
    assert.equal(ws.getCell(`A${r}`).value, null);
  }
  const plain = await after([ins(1, 1, 0)], make);            // like an ungrouped row: no height forced
  assert.equal(plain.getRow(2).height, undefined);
});

// ---- Fix round 3: validation ranges written without overlaps (Ruling 27) ---------------------------------

const { parseRange } = require('../public/sheet-core');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// every <dataValidation sqref> token, per worksheet part
async function sqrefs(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = {};
  for (const entry of zip.file(/^xl\/worksheets\/[^/]+\.xml$/)) {
    out[entry.name] = [...(await entry.async('string')).matchAll(/<dataValidation\b[^>]*\ssqref="([^"]*)"/g)].map((m) => m[1]);
  }
  return out;
}
// the first two tokens (across all elements of one sheet) whose rectangles intersect, or null
function overlap(list) {
  const rects = list.flatMap((sq) => sq.split(/\s+/).filter(Boolean).map((t) => ({ t, ...parseRange(t) })));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2) return `${a.t} / ${b.t}`;
    }
  }
  return null;
}
const noOverlaps = async (buf) => { for (const [part, list] of Object.entries(await sqrefs(buf))) assert.equal(overlap(list), null, part); };

test('Ruling 27: the tracker plus an inserted row is written with validation ranges that do not overlap', async () => {
  const src = await makeTracker();
  assert.equal(overlap((await sqrefs(src))['xl/worksheets/sheet1.xml']), 'F10:F15 / F3:F15', 'ExcelJS on its own overlaps them');
  const wb = await loadWorkbook(src);
  applyOps(wb, [ins(2, 1, 2)]);
  const out = await writeVerified(wb, src);
  await noOverlaps(out);
  assert.deepEqual((await sqrefs(out))['xl/worksheets/sheet1.xml'], ['F3:F16']);
  const ws = (await loadWorkbook(out)).worksheets[0];
  for (let r = 3; r <= 16; r++) assert.equal(ws.dataValidations.find(`F${r}`)?.type, 'list', `F${r}`);
});

test('Ruling 27: one range per block, whatever the text order of the addresses', async () => {
  const src = await bytes((wb) => {
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 1;
    const rule = () => ({ type: 'list', allowBlank: true, formulae: ['"a,b"'] });   // a new, equal object per cell
    for (const r of [...Array.from({ length: 13 }, (_, i) => 3 + i), ...Array.from({ length: 13 }, (_, i) => 17 + i)]) ws.getCell(`F${r}`).dataValidation = rule();
    for (const a of ['C3', 'C4', 'C5', 'C6', 'D3', 'D4', 'D5', 'D6']) ws.getCell(a).dataValidation = rule();
    ws.getCell('H8').dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 9] };
  });
  const wb = await loadWorkbook(src);
  const out = await writeVerified(wb, src);
  assert.deepEqual([...(await sqrefs(out))['xl/worksheets/sheet1.xml']].sort(), ['C3:D6', 'F17:F29', 'F3:F15', 'H8']);
  await noOverlaps(out);
  assert.equal(wb.worksheets[0].dataValidations.find('F20').type, 'list', 'the workbook in memory is per cell again');
  assert.deepEqual(toModel(wb).sheets[0].lists.map((l) => l.ranges.length), [3]);
});

test('Ruling 27: a no-op save of the sandbox action list has no more validation elements and no overlaps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-sandbox-'));
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sheet-sandbox.js'), dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const src = fs.readFileSync(path.join(dir, 'Sandbox', 'Environment Build Action List.xlsx'));
    const before = await sqrefs(src);
    const wb = await loadWorkbook(src);
    const cellsBefore = Object.keys(wb.worksheets[0].dataValidations.model).sort();
    const out = await writeVerified(wb, src);
    const after = await sqrefs(out);
    const count = (s) => Object.values(s).reduce((n, list) => n + list.length, 0);
    assert.ok(count(after) <= count(before), `${count(after)} <= ${count(before)}`);
    assert.ok(count(before) > 0);
    await noOverlaps(out);
    assert.deepEqual(Object.keys((await loadWorkbook(out)).worksheets[0].dataValidations.model).sort(), cellsBefore, 'the same cells validated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
