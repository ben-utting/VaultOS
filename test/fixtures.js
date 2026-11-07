'use strict';

// ========================================================================
// Workbooks for the spreadsheet tests, generated with ExcelJS (no vault
// content is committed). This is a helper, not a suite: `node --test
// 'test/*.test.js'` never picks it up.
//
//   makeTracker()  an "action list": header, merged section bands, task rows,
//                  a status dropdown and a conditional format
//   makePack()     a three-sheet pack (one hidden): frozen header rows,
//                  wrapped text, theme fonts with tint, a formula, and a
//                  dropdown whose list lives on the hidden sheet
//
// Both return a Promise<Buffer>.
// ========================================================================

const ExcelJS = require('exceljs');

const WHITE = { argb: 'FFFFFFFF' };
const solid = (color) => ({ type: 'pattern', pattern: 'solid', fgColor: color });

// ExcelJS gives every cell of a merge the master's style OBJECT (shared by reference), so assigning
// `cell.border = ...` to one of them changes the whole band. Give a cell its own style object instead.
function ownStyle(cell, style) {
  cell.style = JSON.parse(JSON.stringify(style));
}

// Rows (Excel numbering):
//   1       header: bold white on a theme-5 fill, autoFilter A1:G1, frozen below it
//   2       section band, merged A2:G2, medium right border on G2
//   3-15    tasks (F4 = Open, F5 = Closed), custom heights, status list on F3:F15,
//           conditional format $F3="Open" -> red fill on F3:F15
//   16      section band, merged A16:G16, medium right border on G16
// printArea A1:G20.
async function makeTracker() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tracker', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 30 }, { width: 22 }, { width: 18 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 40 }];

  const head = ws.addRow(['Task', 'Owner', 'Team', 'Due', 'Priority', 'Status', 'Notes']);
  head.height = 30;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: WHITE };
    cell.fill = solid({ theme: 5 });
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  ws.autoFilter = 'A1:G1';

  const band = (row, title) => {
    ws.mergeCells(`A${row}:G${row}`);
    ws.getCell(`A${row}`).value = title;
    ws.getRow(row).height = 24;
    const base = { font: { bold: true }, fill: solid({ argb: 'FFD9E1F2' }) };
    ownStyle(ws.getCell(`A${row}`), base);
    for (const col of 'BCDEF') ownStyle(ws.getCell(`${col}${row}`), base);
    ownStyle(ws.getCell(`G${row}`), { ...base, border: { right: { style: 'medium' } } });
  };
  band(2, 'Environments');

  const owners = ['Platform', 'Network', 'Identity', 'Ops'];
  const statuses = ['In Progress', 'Open', 'Closed'];
  for (let r = 3; r <= 15; r += 1) {
    const n = r - 2;
    let status = statuses[n % 3];
    if (r === 4) status = 'Open';
    if (r === 5) status = 'Closed';
    const row = ws.getRow(r);
    row.height = r % 2 ? 40 : 22.5;
    row.getCell(1).value = `Task ${String(n).padStart(2, '0')}`;
    row.getCell(2).value = owners[n % owners.length];
    row.getCell(3).value = `team-${n % 3}`;
    row.getCell(4).value = new Date(Date.UTC(2026, 9, n));
    row.getCell(4).numFmt = 'dd/mm/yyyy';
    row.getCell(5).value = (n % 3) + 1;
    row.getCell(6).value = status;
    row.getCell(7).value = n % 2 ? `Note for task ${n}` : '';
    row.getCell(6).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: true, formulae: ['"Open,In Progress,Closed"'],
    };
  }
  band(16, 'Wrap-up');

  ws.addConditionalFormatting({
    ref: 'F3:F15',
    rules: [{
      type: 'expression',
      priority: 1,
      formulae: ['$F3="Open"'],
      style: { font: { color: WHITE }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC00000' } } },
    }],
  });
  ws.pageSetup.printArea = 'A1:G20';
  return wb.xlsx.writeBuffer();
}

// Sheets: Overview (visible), Lists (hidden), Detail (visible, the active tab).
//   Overview  B2 = 2, B3 = 3, B4 = =SUM(B2:B3) (cached result 5); frozen below row 4
//   Lists     Low / Medium / High in A1:A3
//   Detail    frozen below row 4; C5:C8 is a list validation reading Lists!$A$1:$A$3
async function makePack() {
  const wb = new ExcelJS.Workbook();
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 2, visibility: 'visible' }];

  const ov = wb.addWorksheet('Overview', { views: [{ state: 'frozen', ySplit: 4 }] });
  ov.columns = [{ width: 24 }, { width: 14 }, { width: 40 }];
  ov.getCell('A1').value = 'Overview';
  ov.getCell('A1').font = { bold: true, size: 14, color: { theme: 1 } };
  ov.getCell('A1').fill = solid({ argb: 'FFDDEBF7' });
  ov.getCell('B1').fill = solid({ argb: 'FFDDEBF7' });
  ov.getCell('A2').value = 'First';
  ov.getCell('B2').value = 2;
  ov.getCell('A3').value = 'Second';
  ov.getCell('B3').value = 3;
  ov.getCell('A4').value = 'Total';
  ov.getCell('A4').font = { bold: true };
  ov.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 5 };
  ov.getCell('A5').value = 'A longer note that wraps inside its cell so the row grows taller than the others.';
  ov.getCell('A5').font = { italic: true, color: { theme: 1, tint: 0.35 } };
  ov.getCell('A5').alignment = { wrapText: true, vertical: 'top' };
  ov.getRow(5).height = 45;

  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  ['Low', 'Medium', 'High'].forEach((v, i) => { lists.getCell(i + 1, 1).value = v; });

  const detail = wb.addWorksheet('Detail', { views: [{ state: 'frozen', ySplit: 4 }] });
  detail.columns = [{ width: 12 }, { width: 50 }, { width: 14 }, { width: 24 }];
  detail.getCell('A1').value = 'Detail register';
  detail.getCell('A1').font = { bold: true, size: 14 };
  detail.getCell('A2').value = 'Synthetic data';
  detail.getCell('A2').font = { italic: true, color: { theme: 1, tint: 0.35 } };
  ['Ref', 'Description', 'Level', 'Owner'].forEach((h, i) => {
    const cell = detail.getCell(4, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { theme: 4, tint: -0.25 } };
    cell.fill = solid({ argb: 'FFF2F2F2' });
  });
  for (let r = 5; r <= 8; r += 1) {
    detail.getCell(r, 1).value = `D-${r - 4}`;
    detail.getCell(r, 2).value = `Description ${r - 4}: text that wraps when the column is narrow`;
    detail.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
    detail.getCell(r, 3).value = ['Low', 'Medium', 'High', 'Low'][r - 5];
    detail.getCell(r, 3).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: true, formulae: ['Lists!$A$1:$A$3'],
    };
    detail.getCell(r, 4).value = `owner-${r - 4}`;
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { makeTracker, makePack };
