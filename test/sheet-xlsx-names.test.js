'use strict';

// What ExcelJS can't write back on its own, in workbook.xml and the sheet parts:
//   defined names        carried over from the source by every save, moved by its row operations
//   links to a place in the workbook (<hyperlink location=…>)   lost: the file is view-only
//   Excel extensions (<ext uri=…>, e.g. sparklines)              lost: the file is view-only
// The workbooks are made with ExcelJS and the raw XML injected with JSZip.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const {
  loadWorkbook, toModel, checkEditable, applyOps, writeVerified, carryOverDefinedNames, definedNamesKept,
} = require('../lib/sheet-xlsx');
const { makeTracker } = require('./fixtures');

const NAMES = [
  '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$C$10</definedName>',
  '<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Other!$A$1:$B$5</definedName>',
  '<definedName name="Header" comment="the &quot;top&quot; row">\'Data\'!$A$1:$C$1</definedName>',
  '<definedName name="Hosts">OFFSET(Data!$A$2,0,0,COUNTA(Data!$A:$A)-1,1)</definedName>',
  '<definedName name="Local" localSheetId="1">Other!$A$2:$A$4</definedName>',
  '<definedName name="Rate">0.2</definedName>',
  '<definedName name="WholeCol">Data!$B:$B</definedName>',
];
const ELEMENT = `<definedNames>${NAMES.join('')}</definedNames>`;

// Data (A1:C10) and Other (A1:B5), both autofiltered. workbook.xml gets `element` (none: no names at all)
// after </sheets>, then `workbookXml`; each sheet part in `sheetXml` goes through its function.
async function build({ element = ELEMENT, workbookXml = (x) => x, sheetXml = {}, extra = () => {} } = {}) {
  const wb = new ExcelJS.Workbook();
  const d = wb.addWorksheet('Data');
  const o = wb.addWorksheet('Other');
  for (let r = 1; r <= 10; r++) { d.getCell(r, 1).value = `h${r}`; d.getCell(r, 2).value = r; d.getCell(r, 3).value = 'x'; }
  for (let r = 1; r <= 5; r++) { o.getCell(r, 1).value = `o${r}`; o.getCell(r, 2).value = r; }
  d.autoFilter = 'A1:C10';
  o.autoFilter = 'A1:B5';
  extra(wb);
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  let xml = (await zip.file('xl/workbook.xml').async('string')).replace(/<definedNames>[\s\S]*?<\/definedNames>/, '');
  if (element) xml = xml.replace('</sheets>', `</sheets>${element}`);
  zip.file('xl/workbook.xml', workbookXml(xml));
  for (const [part, fn] of Object.entries(sheetXml)) zip.file(part, fn(await zip.file(part).async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const workbookXmlOf = async (buf) => (await JSZip.loadAsync(buf)).file('xl/workbook.xml').async('string');
const namesOf = async (buf) => {
  const m = /<definedNames\b[^>]*?(?:\/>|>[\s\S]*?<\/definedNames>)/.exec(await workbookXmlOf(buf));
  return m ? m[0] : null;
};
async function save(src, ops) {
  const wb = await loadWorkbook(src);
  applyOps(wb, ops);
  return writeVerified(wb, src);
}
const set = (sheet, r, c, v) => ({ op: 'set', sheet, r, c, v });
const ins = (sheet, at, n) => ({ op: 'insertRows', sheet, at, n, like: null });
const del = (sheet, at, n) => ({ op: 'deleteRows', sheet, at, n });
const check = async (buf) => checkEditable(buf, await loadWorkbook(buf));
// NAMES with entry i's formula replaced
const withName = (changes) => `<definedNames>${NAMES.map((n, i) => (i in changes ? n.replace(/>[^<]*</, `>${changes[i]}<`) : n)).join('')}</definedNames>`;

// ---- defined names ------------------------------------------------------------------------------------

test('ExcelJS alone breaks these names, which is why a save carries them over', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await build());
  const names = await namesOf(await wb.xlsx.writeBuffer());
  assert.match(names, /&apos;OFFSET\(Data&apos;!\$A\$2/);          // the dynamic name, as a broken reference
  assert.doesNotMatch(names, /name="Rate"|name="WholeCol"|localSheetId|hidden=/);
});

test('a workbook with dynamic, constant, whole-column and sheet-scoped names is editable', async () => {
  const r = await check(await build());
  assert.deepEqual(r.lost, []);
  assert.equal(r.editable, true);
});

test('a set-only save gives every name back byte for byte', async () => {
  const src = await build();
  const out = await save(src, [set(0, 1, 1, '42'), set(1, 2, 0, 'new')]);
  assert.equal(await namesOf(out), ELEMENT);
  const back = await loadWorkbook(out);
  assert.equal(back.worksheets[0].getCell('B2').value, 42);
  assert.equal((await check(out)).editable, true);
});

test('rows inserted on Data move the names that point at Data; the rest keep their bytes', async () => {
  const out = await save(await build(), [ins(0, 0, 2)]);
  assert.equal(await namesOf(out), withName({
    0: 'Data!$A$3:$C$12',
    2: "'Data'!$A$3:$C$3",
    3: 'OFFSET(Data!$A$4,0,0,COUNTA(Data!$A:$A)-1,1)',
  }));
  assert.match(await namesOf(out), /comment="the &quot;top&quot; row">'Data'!\$A\$3:\$C\$3</);   // attributes as they were
});

test('rows deleted on Data shrink its names; an insert below every name changes none of them', async () => {
  assert.equal(await namesOf(await save(await build(), [del(0, 4, 2)])), withName({ 0: 'Data!$A$1:$C$8' }));
  assert.equal(await namesOf(await save(await build(), [ins(0, 12, 3)])), ELEMENT);
});

test('a delete that takes a named range away leaves #REF!, as Excel does', async () => {
  const out = await save(await build(), [del(0, 0, 2)]);              // Excel rows 1-2: Header's row, Hosts' anchor
  assert.equal(await namesOf(out), withName({ 0: 'Data!$A$1:$C$8', 2: '#REF!', 3: 'OFFSET(#REF!,0,0,COUNTA(Data!$A:$A)-1,1)' }));
});

test('ops on Other move only the names on Other, in the order the ops were applied', async () => {
  const out = await save(await build(), [ins(1, 0, 1), del(1, 4, 1), ins(0, 0, 1)]);
  assert.equal(await namesOf(out), withName({
    0: 'Data!$A$2:$C$11',
    1: 'Other!$A$2:$B$5',                                              // +1 at the top, then row 5 (was 4) deleted
    2: "'Data'!$A$2:$C$2",
    3: 'OFFSET(Data!$A$3,0,0,COUNTA(Data!$A:$A)-1,1)',
    4: 'Other!$A$3:$A$4',
  }));
});

test('print areas and titles follow their rows; an area deleted goes, and so does a name with none left', async () => {
  const element = '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$10,Data!$E$4:$F$5</definedName>'
    + '<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$2</definedName></definedNames>';
  const src = await build({ element });
  const moved = await save(src, [ins(0, 0, 1)]);
  assert.equal(await namesOf(moved), '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$2:$C$11,Data!$E$5:$F$6</definedName>'
    + '<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$2:$3</definedName></definedNames>');
  const setup = (await loadWorkbook(moved)).worksheets[0].pageSetup;      // ExcelJS reads them as the page setup
  assert.equal(setup.printArea, 'A2:C11');                                 // (it reads a name's first area only)
  assert.equal(setup.printTitlesRow, '2:3');
  assert.equal(await namesOf(await save(src, [del(0, 3, 2)])), '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'
    + 'Data!$A$1:$C$8</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$2</definedName></definedNames>');
  assert.equal(await namesOf(await save(src, [del(0, 0, 2)])), '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'
    + 'Data!$A$1:$C$8,Data!$E$2:$F$3</definedName></definedNames>');
});

test('ExcelJS-written print areas ($A1:$C10, relative rows) move too', async () => {
  const src = await makeTracker();                                        // printArea A1:G20, as ExcelJS writes it
  assert.match(await namesOf(src), /&apos;Tracker&apos;!\$A1:\$G20/);
  const wb = await loadWorkbook(src);
  applyOps(wb, [{ op: 'insertRows', sheet: 0, at: 1, n: 1, like: 1 }]);
  const out = await writeVerified(wb, src);
  assert.match(await namesOf(out), />'Tracker'!\$A1:\$G21</);
  assert.equal((await loadWorkbook(out)).worksheets[0].pageSetup.printArea, 'A1:G21');
});

test('a prefixed <x:definedNames> comes back in the main namespace, its names intact', async () => {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const src = await build({ element: `<x:definedNames xmlns:x="${main}"><x:definedName name="Rate">0.2</x:definedName></x:definedNames>` });
  assert.equal((await check(src)).editable, true);
  const out = await save(src, [set(0, 0, 0, 'top')]);
  assert.equal(await namesOf(out), `<definedNames xmlns:x="${main}"><definedName name="Rate">0.2</definedName></definedNames>`);
  await loadWorkbook(out);
});

test('with no names in the source, what ExcelJS wrote stays', async () => {
  const none = await build({ element: null });
  const tracker = await makeTracker();                                    // ExcelJS wrote a Print_Area name
  const r = await carryOverDefinedNames(none, tracker);
  assert.equal(r.out, tracker);
  assert.equal(r.expected, null);
  const empty = await carryOverDefinedNames(await build({ element: '<definedNames/>' }), tracker);
  assert.equal(empty.out, tracker);
  assert.equal(await definedNamesKept(tracker, null), true);
});

test('definedNamesKept fails an output without the names it should hold', async () => {
  const src = await build();
  const bare = await build({ element: null });
  const carried = await carryOverDefinedNames(src, bare);
  assert.equal(carried.expected.length, NAMES.length);
  assert.equal(await definedNamesKept(bare, carried.expected), false);
  assert.equal(await definedNamesKept(carried.out, carried.expected), true);
  const noSheets = await JSZip.loadAsync(bare);                           // nowhere to put them: output unchanged, check fails
  noSheets.file('xl/workbook.xml', (await noSheets.file('xl/workbook.xml').async('string')).replace(/<sheets>[\s\S]*<\/sheets>/, ''));
  const broken = await noSheets.generateAsync({ type: 'nodebuffer' });
  const r = await carryOverDefinedNames(src, broken);
  assert.equal(r.out, broken);
  assert.equal(await definedNamesKept(r.out, r.expected), false);
});

// ---- links to other places in the workbook ---------------------------------------------------------------

const LINKS = '<hyperlinks><hyperlink ref="A3" location="Other!A1" display="Other"/><hyperlink ref="A4" location="Hosts"/></hyperlinks>';
const beforeMargins = (xml, add) => { assert.match(xml, /<pageMargins/); return xml.replace('<pageMargins', `${add}<pageMargins`); };

test('a link to a place in the workbook makes the file view-only', async () => {
  const r = await check(await build({ sheetXml: { 'xl/worksheets/sheet1.xml': (x) => beforeMargins(x, LINKS) } }));
  assert.deepEqual(r.lost, ['links to other places in the workbook']);
  assert.equal(r.reason, 'Saving here would lose links to other places in the workbook — edit it in Excel');
});

test('a web link is kept by a save, so it is no loss', async () => {
  const src = await build({ extra: (wb) => { wb.worksheets[0].getCell('A3').value = { text: 'site', hyperlink: 'https://example.com/' }; } });
  assert.deepEqual((await check(src)).lost, []);
});

// ---- Excel extensions -------------------------------------------------------------------------------------

const SPARKLINES = '<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
  + '<x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup><x14:colorSeries rgb="FF376092"/>'
  + '<x14:sparklines><x14:sparkline><xm:f>Data!B1:B10</xm:f><xm:sqref>D1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>'
  + '</x14:sparklineGroups></ext></extLst>';

test('sparklines (an Excel extension ExcelJS drops) make the file view-only', async () => {
  const r = await check(await build({ sheetXml: { 'xl/worksheets/sheet1.xml': (x) => x.replace('</worksheet>', `${SPARKLINES}</worksheet>`) } }));
  assert.deepEqual(r.lost, ['Excel extensions such as sparklines']);
  assert.equal(r.editable, false);
});

test('extensions ExcelJS writes back, and the two workbook settings that carry nothing, are no loss', async () => {
  const settings = '<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">'
    + '<x15:workbookPr chartTrackingRefBase="1"/></ext><ext uri="{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}" '
    + 'xmlns:xcalcf="http://schemas.microsoft.com/office/spreadsheetml/2018/calcfeatures"><xcalcf:calcFeatures>'
    + '<xcalcf:feature name="microsoft.com:RD"/></xcalcf:calcFeatures></ext></extLst>';
  const src = await build({ workbookXml: (x) => x.replace('</workbook>', `${settings}</workbook>`) });
  const styles = await (await JSZip.loadAsync(src)).file('xl/styles.xml').async('string');
  assert.match(styles, /<ext [^>]*uri="\{EB79DEF2/);                       // slicer styles: ExcelJS writes them again
  assert.deepEqual((await check(src)).lost, []);
});

test('data bars: ExcelJS drops their x14 half on a save, so the file is view-only', async () => {
  const src = await build({
    extra: (wb) => wb.worksheets[0].addConditionalFormatting({ ref: 'B1:B10', rules: [{ type: 'dataBar', priority: 1,
      cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF638EC6' } }] }),
  });
  assert.match(await (await JSZip.loadAsync(src)).file('xl/worksheets/sheet1.xml').async('string'), /<ext [^>]*uri="\{78C0D931/);
  assert.deepEqual((await check(src)).lost, ['Excel extensions such as sparklines']);
});

test('toModel of a workbook with names still reads its sheets (names are not cells)', async () => {
  const { sheets } = toModel(await loadWorkbook(await build()));
  assert.deepEqual(sheets.map((s) => s.name), ['Data', 'Other']);
});
