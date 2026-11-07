'use strict';

// Excel tables: the header row and the totals row are locked (the table part keeps the column names and the
// totals too, and Excel repairs a file where they disagree with the cells), a table round-trips unchanged, and
// a table ExcelJS would write back differently makes the file view-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { loadWorkbook, toModel, checkEditable, applyOps, writeVerified } = require('../lib/sheet-xlsx');

const HEADER = 'That cell is part of an Excel table header — edit it in Excel';
const TOTALS = 'That cell is part of an Excel table totals row — edit it in Excel';

// Sheet 'Hosts': A1 a title, table T1 at B3:C7 (header row 3, rows 4-6, totals row 7). Saved as Excel saves a
// table: no headerRowCount attribute (it defaults to 1). `table` edits the table part's XML.
async function makeTable({ table = (x) => x } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hosts');
  ws.getCell('A1').value = 'Inventory';
  ws.addTable({
    name: 'T1', ref: 'B3', headerRow: true, totalsRow: true,
    columns: [{ name: 'Host', totalsRowLabel: 'Total' }, { name: 'Count', totalsRowFunction: 'sum' }],
    rows: [['alpha', 1], ['beta', 2], ['gamma', 3]],
  });
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const part = 'xl/tables/table1.xml';
  const xml = await zip.file(part).async('string');
  assert.match(xml, / headerRowCount="1"/);
  zip.file(part, table(xml.replace(' headerRowCount="1"', '')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const tablePart = async (buf) => {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(Object.keys(zip.files).find((n) => /^xl\/tables\/[^/]+\.xml$/.test(n))).async('string');
};
// what Excel reads from a table part: name, ref, header and totals row counts (with their defaults), column names
async function shape(buf) {
  const xml = await tablePart(buf);
  const tag = /<table\b[^>]*>/.exec(xml)[0];
  const attr = (name, dflt) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : dflt; };
  return { name: attr('name'), ref: attr('ref'), header: Number(attr('headerRowCount', 1)), totals: Number(attr('totalsRowCount', 0)),
    columns: [...xml.matchAll(/<tableColumn\b[^>]*\sname="([^"]*)"/g)].map((m) => m[1]) };
}
const set = (r, c, v) => ({ op: 'set', sheet: 0, r, c, v });
const refused = (wb, ops, message) => assert.throws(() => applyOps(wb, ops), (e) => e.status === 400 && e.message === message);

test('ExcelJS alone writes an Excel table back without its header row (why loadWorkbook reads the part itself)', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await makeTable());
  assert.match(await tablePart(await wb.xlsx.writeBuffer()), / headerRowCount="0"/);
});

test('loadWorkbook: no headerRowCount means a header row; headerRowCount="0" means none', async () => {
  const t = (wb) => Object.values(wb.worksheets[0].tables)[0].table;
  assert.equal(t(await loadWorkbook(await makeTable())).headerRow, true);
  const none = await loadWorkbook(await makeTable({ table: (x) => x.replace('<table ', '<table headerRowCount="0" ') }));
  assert.equal(t(none).headerRow, false);
});

test('toModel locks the header and totals rows, each with its reason; a CSV-like sheet has none', async () => {
  const { sheets } = toModel(await loadWorkbook(await makeTable()));
  assert.deepEqual(sheets[0].locked, [
    { r1: 2, c1: 1, r2: 2, c2: 2, msg: HEADER },
    { r1: 6, c1: 1, r2: 6, c2: 2, msg: TOTALS },
  ]);
  const plain = new ExcelJS.Workbook();
  plain.addWorksheet('S').getCell('A1').value = 'x';
  assert.deepEqual(toModel(await loadWorkbook(await plain.xlsx.writeBuffer())).sheets[0].locked, []);
});

test('a real table round-trips, so the file is editable', async () => {
  const src = await makeTable();
  assert.deepEqual((await checkEditable(src, await loadWorkbook(src))).lost, []);
});

test('set in the header row or the totals row is refused (400); in the body it saves, the table part unchanged', async () => {
  const src = await makeTable();
  refused(await loadWorkbook(src), [set(2, 1, 'Name')], HEADER);
  refused(await loadWorkbook(src), [set(2, 2, 'Count')], HEADER);              // even the text it already has
  refused(await loadWorkbook(src), [set(6, 1, 'All')], TOTALS);
  refused(await loadWorkbook(src), [set(3, 1, 'ok'), set(6, 2, '7')], TOTALS);   // a whole save, not just the bad op
  const wb = await loadWorkbook(src);
  applyOps(wb, [set(3, 1, 'delta'), set(5, 2, '9'), set(1, 1, 'outside the table')]);
  const out = await writeVerified(wb, src);
  assert.deepEqual(await shape(out), await shape(src));
  assert.deepEqual(await shape(out), { name: 'T1', ref: 'B3:C7', header: 1, totals: 1, columns: ['Host', 'Count'] });
  const back = await loadWorkbook(out);
  assert.equal(back.worksheets[0].getCell('B4').value, 'delta');
  assert.equal(back.worksheets[0].getCell('C6').value, 9);
  assert.deepEqual((await checkEditable(out, back)).lost, []);
  assert.deepEqual(toModel(back).sheets[0].locked, toModel(await loadWorkbook(src)).sheets[0].locked);
});

test('row operations stay refused on a sheet with a table, so the locked rows never move', async () => {
  const src = await makeTable();
  const reason = toModel(await loadWorkbook(src)).sheets[0].rowOps;   // the totals row's SUBTOTAL is a formula, which says it first
  assert.ok(reason);
  refused(await loadWorkbook(src), [{ op: 'insertRows', sheet: 0, at: 4, n: 1, like: null }], reason);
  const noTotals = await makeTable({ table: (x) => x.replace(' totalsRowCount="1"', '') });
  const wb = await loadWorkbook(noTotals);
  wb.worksheets[0].getRow(7).eachCell((cell) => { cell.value = null; });   // the old totals row: no SUBTOTAL left
  assert.equal(toModel(wb).sheets[0].rowOps, 'This sheet has an Excel table, so add or remove rows in Excel');
});

test('a table ExcelJS would write back differently is a loss: Excel tables', async () => {
  // ExcelJS knows one totals row or none; a part saying 2 stands in for any table it can't write back as it was
  const src = await makeTable({ table: (x) => x.replace('totalsRowCount="1"', 'totalsRowCount="2"') });
  const r = await checkEditable(src, await loadWorkbook(src));
  assert.deepEqual(r.lost, ['Excel tables']);
  assert.equal(r.reason, 'Saving here would lose Excel tables — edit it in Excel');
});
