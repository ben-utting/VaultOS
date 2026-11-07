'use strict';
// Synthetic spreadsheet sandbox for the sheet-editor preview (:7690) and its tests.
//
//   node scripts/sheet-sandbox.js <outDir>      → writes <outDir>/Sandbox/*
//
// Every value is invented (made-up hosts, env.NNN references, lorem-style text) and the content is
// deterministic: no clock or random values, so the pristine copy regenerates identically.
// Run it with the worktree's node_modules, e.g.
//   docker run --rm -v "$PWD":/app:ro -v <dir>:/out -w /app \
//     node:22-bookworm-slim node scripts/sheet-sandbox.js /out
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/sheet-sandbox.js <outDir>');
  process.exit(1);
}
const dir = path.join(outDir, 'Sandbox');
fs.mkdirSync(dir, { recursive: true });

const FIXED = new Date(Date.UTC(2026, 0, 1));
const WHITE = { argb: 'FFFFFFFF' };
const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur.',
];
const pad = (n, w = 3) => String(n).padStart(w, '0');
const date = (i) => new Date(Date.UTC(2026, 9 + Math.floor(i / 28), 1 + (i % 28)));

function newWb() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'sandbox';
  wb.lastModifiedBy = 'sandbox';
  wb.created = FIXED;
  wb.modified = FIXED;
  return wb;
}
// ExcelJS stamps every zip entry with the current time; re-zip with a fixed date so the bytes are
// reproducible too (loadAsync does not add dated directory entries).
async function stable(buf) {
  const zip = await JSZip.loadAsync(buf);
  Object.values(zip.files).forEach((f) => { f.date = FIXED; });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function save(wb, name) {
  fs.writeFileSync(path.join(dir, name), await stable(await wb.xlsx.writeBuffer()));
}
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

// ---------------------------------------------------------------------------------------------
// Environment Build Action List.xlsx — theme header, section bands, list validation, CF, no freeze
// ---------------------------------------------------------------------------------------------
async function actionList() {
  const wb = newWb();
  const ws = wb.addWorksheet('Action List');
  ws.columns = [
    { width: 30 }, { width: 12 }, { width: 52 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 44 },
  ];
  const head = ws.addRow(['Task', 'Reference', 'Action', 'Owner', 'Due Date', 'Status', 'Updates']);
  head.height = 39.95;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: WHITE };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 5 } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  ws.autoFilter = 'A1:G1';

  const sections = { 2: 'Environments', 16: 'Networking', 30: 'Identity', 44: 'Monitoring' };
  const owners = ['Platform Team', 'Network Team', 'Identity Team', 'Ops Team', 'Security Team'];
  const verbs = ['Provision', 'Review', 'Configure', 'Validate', 'Document', 'Decommission', 'Migrate'];
  const things = ['hypervisor cluster', 'edge gateway', 'jump host', 'log forwarder', 'backup target',
    'build runner', 'service mesh', 'secrets store', 'dns zone', 'load balancer'];
  const cycle = ['Open', 'In Progress', 'Closed', null];
  const taskRows = [];
  let n = 0;
  for (let r = 2; r <= 67; r += 1) {
    if (sections[r]) {
      ws.mergeCells(`A${r}:G${r}`);
      ws.getCell(`A${r}`).value = sections[r];
      ws.getRow(r).height = 24;
      for (let c = 1; c <= 7; c += 1) {
        const cell = ws.getCell(r, c);
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
        cell.border = {
          top: { style: 'medium' }, bottom: { style: 'medium' },
          ...(c === 1 ? { left: { style: 'medium' } } : {}),
          ...(c === 7 ? { right: { style: 'medium' } } : {}),
        };
        cell.alignment = { vertical: 'middle' };
      }
      continue;
    }
    n += 1;
    taskRows.push(r);
    let status = cycle[(n - 1) % 4];
    if (r === 4) status = 'Open';
    if (r === 5) status = 'Closed';
    const row = ws.getRow(r);
    row.height = 39.95;
    row.getCell(1).value = `${verbs[n % verbs.length]} ${things[n % things.length]} ${pad(n)}`;
    row.getCell(2).value = `env.${pad(n)}`;
    row.getCell(3).value = LOREM[n % LOREM.length];
    row.getCell(4).value = owners[n % owners.length];
    row.getCell(5).value = date(n);
    row.getCell(5).numFmt = 'dd/mm/yyyy';
    row.getCell(6).value = status;
    row.getCell(7).value = n % 3 === 0 ? '' : LOREM[(n + 2) % LOREM.length];
    for (let c = 1; c <= 7; c += 1) {
      const cell = row.getCell(c);
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = box;
    }
    row.getCell(6).dataValidation = {
      type: 'list',
      allowBlank: true,
      showErrorMessage: true,
      formulae: ['"Open,In Progress,Closed"'],
    };
  }
  // contiguous task-row runs → one CF range each, anchored on the first (F3)
  const runs = [];
  taskRows.forEach((r) => {
    const last = runs[runs.length - 1];
    if (last && last[1] === r - 1) last[1] = r; else runs.push([r, r]);
  });
  const ref = runs.map(([a, b]) => `F${a}:F${b}`).join(' ');
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: 'expression', priority: 1, formulae: ['$F3="Open"'],
        style: { font: { color: WHITE }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC00000' } } },
      },
      {
        type: 'expression', priority: 2, formulae: ['$F3="In Progress"'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFED7D31' } } },
      },
    ],
  });
  await save(wb, 'Environment Build Action List.xlsx');
}

// ---------------------------------------------------------------------------------------------
// svc-spp-linux - InfoSec Sign-off Pack.xlsx — 4 visible sheets + hidden "Lists" (3rd), frozen row 4
// ---------------------------------------------------------------------------------------------
async function signoffPack() {
  const wb = newWb();
  function pack(name, title, headers, rowsN, opts = {}) {
    const ws = wb.addWorksheet(name);
    ws.views = [{ state: 'frozen', ySplit: 4, topLeftCell: 'A5', activeCell: 'A5' }];
    ws.columns = headers.map((h, i) => ({ width: opts.widths ? opts.widths[i] : 20 }));
    ws.mergeCells('A1:F1');
    const t = ws.getCell('A1');
    t.value = title;
    t.font = { bold: true, size: 14, color: { theme: 1 } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    t.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 28;
    ws.getCell('A2').value = 'Service account: svc-spp-linux (synthetic sandbox)';
    ws.getCell('A2').font = { italic: true, color: { theme: 1, tint: 0.35 } };
    ws.getCell('A3').value = `Sheet: ${name}`;
    ws.getCell('A3').font = { color: { theme: 1, tint: 0.35 } };
    const hr = ws.getRow(4);
    headers.forEach((h, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { theme: 4, tint: -0.25 } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      cell.border = box;
    });
    for (let i = 1; i <= rowsN; i += 1) {
      const row = ws.getRow(4 + i);
      headers.forEach((h, c) => {
        const cell = row.getCell(c + 1);
        if (c === 0) cell.value = `${name.slice(0, 3).toUpperCase()}-${pad(i)}`;
        else if (c === 1) cell.value = opts.long ? `${LOREM[i % 6]} ${LOREM[(i + 1) % 6]} ${LOREM[(i + 3) % 6]}` : LOREM[i % 6];
        else if (c === 2) cell.value = i % 3 === 0 ? 'No' : (i % 3 === 1 ? 'Yes' : 'N/A');
        else cell.value = `Note ${pad(i)}.${c}`;
        cell.font = { color: { theme: 1, tint: 0.15 } };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = box;
      });
      if (opts.list) {
        row.getCell(3).dataValidation = {
          type: 'list', allowBlank: true, showErrorMessage: true, formulae: ['"Yes,No,N/A"'],
        };
      }
    }
    return ws;
  }
  const h6 = ['Ref', 'Description', 'Compliant', 'Owner', 'Evidence', 'Comment'];
  pack('Summary', 'Summary of controls', h6, 10, { widths: [14, 50, 12, 18, 20, 30] });
  pack('Access Controls', 'Access control review', h6, 12, { widths: [14, 50, 12, 18, 20, 30] });
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  ['Yes', 'No', 'N/A'].forEach((v, i) => { lists.getCell(i + 1, 1).value = v; });
  pack('Evidence', 'Evidence register', h6, 60, { long: true, list: true, widths: [14, 90, 12, 18, 20, 30] });
  pack('Sign-off', 'Sign-off record', h6, 8, { widths: [14, 50, 12, 18, 20, 30] });
  await save(wb, 'svc-spp-linux - InfoSec Sign-off Pack.xlsx');
}

// ---------------------------------------------------------------------------------------------
// linux.xlsx — frozen first column, 14 wide columns, 80 rows, autoFilter, header fill
// ---------------------------------------------------------------------------------------------
async function linuxInventory() {
  const wb = newWb();
  const ws = wb.addWorksheet('Linux');
  ws.views = [{ state: 'frozen', xSplit: 1, topLeftCell: 'B1', activeCell: 'B1' }];
  const headers = ['Hostname', 'IP Address', 'OS', 'Environment', 'Owner', 'Role', 'CPU', 'Memory GB', 'Disk GB',
    'Patch Group', 'Last Seen', 'Agent', 'Zone', 'Notes'];
  ws.columns = headers.map(() => ({ width: 18 }));
  const hr = ws.addRow(headers);
  hr.eachCell((cell) => {
    cell.font = { bold: true, color: WHITE };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  });
  ws.autoFilter = 'A1:N1';
  const oss = ['Debian 12', 'Ubuntu 22.04', 'RHEL 9', 'Rocky 9'];
  const envs = ['prod', 'test', 'dev'];
  const roles = ['web', 'db', 'cache', 'batch', 'proxy'];
  for (let i = 1; i <= 80; i += 1) {
    ws.addRow([
      `srv-lin-${pad(i)}`, `10.${20 + (i % 4)}.${Math.floor(i / 10)}.${10 + (i % 200)}`, oss[i % 4], envs[i % 3],
      `Team ${String.fromCharCode(65 + (i % 5))}`, roles[i % 5], 2 + (i % 4) * 2, 4 * (1 + (i % 8)), 50 * (1 + (i % 6)),
      `PG-${1 + (i % 3)}`, date(i), i % 7 === 0 ? 'stale' : 'ok', `zone-${1 + (i % 3)}`, i % 9 === 0 ? 'Needs review' : '',
    ]);
    ws.getRow(i + 1).getCell(11).numFmt = 'dd/mm/yyyy';
  }
  await save(wb, 'linux.xlsx');
}

// ---------------------------------------------------------------------------------------------
// Mimecast_User_Access_Export.xlsx — 3 sheets, frozen row 1, SUM / COUNTIF with cached results
// ---------------------------------------------------------------------------------------------
async function mimecast() {
  const wb = newWb();
  const roles = ['Admin', 'Reader', 'Auditor', 'Reader'];
  const N = 20;
  const users = wb.addWorksheet('Users');
  users.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
  users.columns = [{ width: 30 }, { width: 22 }, { width: 14 }, { width: 14 }];
  const uh = users.addRow(['Email', 'Display Name', 'Role', 'Logins']);
  uh.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }; });
  let total = 0;
  const count = { Admin: 0, Reader: 0, Auditor: 0 };
  for (let i = 1; i <= N; i += 1) {
    const logins = (i * 7) % 31;
    total += logins;
    count[roles[i % 4]] += 1;
    users.addRow([`user${pad(i)}@example.test`, `Test User ${pad(i)}`, roles[i % 4], logins]);
  }
  users.addRow(['Total logins', '', '', { formula: `SUM(D2:D${N + 1})`, result: total }]);

  const summary = wb.addWorksheet('Summary');
  summary.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
  summary.columns = [{ width: 28 }, { width: 14 }];
  const sh = summary.addRow(['Measure', 'Value']);
  sh.eachCell((c) => { c.font = { bold: true }; });
  summary.addRow(['Total logins', { formula: `SUM(Users!D2:D${N + 1})`, result: total }]);
  ['Admin', 'Reader', 'Auditor'].forEach((r) => {
    summary.addRow([`${r} users`, { formula: `COUNTIF(Users!C2:C${N + 1},"${r}")`, result: count[r] }]);
  });

  const groups = wb.addWorksheet('Groups');
  groups.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
  groups.columns = [{ width: 26 }, { width: 14 }, { width: 40 }];
  const gh = groups.addRow(['Group', 'Members', 'Description']);
  gh.eachCell((c) => { c.font = { bold: true }; });
  ['Admins', 'Readers', 'Auditors', 'Service'].forEach((g, i) => {
    groups.addRow([`grp-${g.toLowerCase()}`, 3 + i * 4, LOREM[i]]);
  });
  await save(wb, 'Mimecast_User_Access_Export.xlsx');
}

// ---------------------------------------------------------------------------------------------
// RVTools_export_all.xlsx — a valid zip ExcelJS cannot load. (A zip with no xl/workbook.xml at all is NOT
// enough: ExcelJS 4.4 quietly loads that as an empty workbook, so the workbook part is present but truncated,
// which makes `load` throw.)
// ---------------------------------------------------------------------------------------------
async function rvtools() {
  const zip = new JSZip();
  const opts = { date: FIXED, createFolders: false };
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/></Types>', opts);
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', opts);
  zip.file('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="vI', opts);
  zip.file('xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>', opts);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(dir, 'RVTools_export_all.xlsx'), buf);
}

// ---------------------------------------------------------------------------------------------
// Chart Pack.xlsx — tracker-like workbook plus an extra xl/charts/chart1.xml ExcelJS drops on re-save
// ---------------------------------------------------------------------------------------------
async function chartPack() {
  const wb = newWb();
  const ws = wb.addWorksheet('Tracker');
  ws.columns = [{ width: 24 }, { width: 14 }, { width: 14 }];
  const hr = ws.addRow(['Item', 'Planned', 'Actual']);
  hr.eachCell((c) => { c.font = { bold: true }; });
  for (let i = 1; i <= 8; i += 1) ws.addRow([`Milestone ${pad(i)}`, i * 10, i * 9]);
  const buf = await wb.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buf);
  const ct = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', ct.replace('</Types>',
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'),
  { date: FIXED });
  zip.file('xl/charts/chart1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
    + '<c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>Tracker!$B$2:$B$9</c:f></c:numRef></c:val></c:ser>'
    + '<c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea></c:chart></c:chartSpace>',
  { date: FIXED });
  fs.writeFileSync(path.join(dir, 'Chart Pack.xlsx'), await stable(await zip.generateAsync({ type: 'nodebuffer' })));
}

// ---------------------------------------------------------------------------------------------
// CSVs — byte-level variety: LF, BOM + CRLF + quoting + embedded CRLF, no final newline, semicolons
// ---------------------------------------------------------------------------------------------
function csvs() {
  const w = (name, data) => fs.writeFileSync(path.join(dir, name), data);
  // servers.csv — LF, header + 60 rows, 10 columns
  const sh = ['hostname', 'ip', 'os', 'env', 'owner', 'role', 'cpu', 'memory_gb', 'disk_gb', 'status'];
  const sr = [sh.join(',')];
  for (let i = 1; i <= 60; i += 1) {
    sr.push([`srv-${pad(i)}`, `10.30.${Math.floor(i / 10)}.${10 + i}`, ['debian', 'ubuntu', 'rhel'][i % 3],
      ['prod', 'test', 'dev'][i % 3], `team-${String.fromCharCode(97 + (i % 5))}`, ['web', 'db', 'cache'][i % 3],
      2 + (i % 4) * 2, 4 * (1 + (i % 8)), 50 * (1 + (i % 6)), i % 7 === 0 ? 'decommissioned' : 'active'].join(','));
  }
  w('servers.csv', `${sr.join('\n')}\n`);
  // bom-crlf.csv — UTF-8 BOM, CRLF, quoted fields with commas, one field with an embedded CRLF
  const b = [
    'id,name,notes,owner',
    '1,"Alpha, Inc.","Quoted, with comma",team-a',
    '2,Beta,"Line one\r\nLine two",team-b',
    '3,"Gamma ""quoted"" name",Plain text,team-c',
    '4,Delta,"Another, quoted field",team-a',
    '5,Epsilon,,team-d',
  ];
  w('bom-crlf.csv', `﻿${b.join('\r\n')}\r\n`);
  // no-trailing-newline.csv — LF, no final newline
  const n = ['code,label,value'];
  for (let i = 1; i <= 12; i += 1) n.push(`c${pad(i)},Label ${i},${i * 11}`);
  w('no-trailing-newline.csv', n.join('\n'));
  // semicolon.csv — ';' delimiter
  const s = ['name;department;score;comment'];
  for (let i = 1; i <= 15; i += 1) s.push(`person-${pad(i)};dept-${1 + (i % 4)};${(i * 13) % 100};${i % 3 === 0 ? 'needs follow-up' : 'ok'}`);
  w('semicolon.csv', `${s.join('\n')}\n`);
}

// ---------------------------------------------------------------------------------------------
// Not spreadsheets: the Files regression sweep (E9) opens these to check the rest of Files still works.
// notes.md — front matter + headings (Rendered | Source); script.ps1 — CRLF text (Ctrl+A, Copy file);
// pixel.png — a 16×16 checker (the image view).
// ---------------------------------------------------------------------------------------------
function others() {
  const w = (name, data) => fs.writeFileSync(path.join(dir, name), data);
  w('notes.md', [
    '---', 'title: Sandbox notes', 'status: draft', '---', '',
    '# Sandbox notes', '',
    'Made-up notes for the Files regression sweep.', '',
    '## Checklist', '',
    '- [x] Grid opens', '- [ ] Source shows the text', '',
  ].join('\n'));
  w('script.ps1', ['Write-Host "a"', 'Write-Host "b"', '$x = 1', ''].join('\r\n'));
  w('pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mO4viULjsSkleEIlzjDINRAjCJk8cGoYTQeBoUGADFQJJD5HJbUAAAAAElFTkSuQmCC', 'base64'));
}

(async () => {
  await actionList();
  await signoffPack();
  await linuxInventory();
  await mimecast();
  await rvtools();
  await chartPack();
  csvs();
  others();
  console.log(`Sandbox written to ${dir} (${fs.readdirSync(dir).length} files)`);
})().catch((e) => { console.error(e); process.exit(1); });
