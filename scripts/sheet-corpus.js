#!/usr/bin/env node
'use strict';

// Read-only sweep of a folder of spreadsheets: what would the viewer/editor make of each one?
//
//   node scripts/sheet-corpus.js <dir> [--ops-smoke]
//
// Every .xlsx / .csv under <dir> (dot-folders and node_modules skipped, symlinks not followed) gets one line:
//
//   EDITABLE                 <path>
//   VIEW-ONLY (<reason>)     <path>
//   UNREADABLE (<error>)     <path>
//
// then a summary line. An editable file must also survive a save that changes nothing:
//   csv    applyCsvOps(parsed, []) then serializeCsv gives back the very same bytes
//   xlsx   writing the workbook (validations regrouped, custom properties and defined names carried over,
//          as a save does) loses no zip part or drawing anchor, writes no overlapping validation ranges,
//          and re-loading what was written gives the same cellSignature as the workbook had
// A file that doesn't prints `EQUIV-FAIL <path>: <what differs>` and the exit code is 1; so does a round
// trip that throws (`EQUIV-FAIL <path>: round trip threw: <message>`), never reported as UNREADABLE.
//
// With --ops-smoke, every editable xlsx whose first visible sheet allows row operations also gets an edit
// that should cancel out: insert one row at row 3 formatted like row 3, type 'x' into the first cell of
// the new row that no merge covers (if any), delete the row again; save it with writeVerified (as the route does)
// and re-load it. Its cellSignature must equal the original's, and no sheet of what was written may have
// overlapping validation ranges:
//
//   OPS-OK                   <path>
//   OPS-SKIP (<reason>)      <path>      the sheet can't take row operations (formulas, a table, ...)
//   EQUIV-FAIL <path>: ops smoke: <what differs>
//
// Nothing is written anywhere. The output carries paths, verdicts, counts and short structural
// descriptions only (sheet numbers, field names, cell addresses), never cell contents, so it is safe to
// run over private files.
//
//   docker run --rm -v /opt/vault/board-sheets:/app -v <dir>:/data:ro -w /app \
//     node:22-bookworm-slim node scripts/sheet-corpus.js /data

const fs = require('fs');
const path = require('path');
const { parseCsv, csvEditable, applyCsvOps, serializeCsv } = require('../lib/sheet-csv');
const JSZip = require('jszip');
const { parseRange } = require('../public/sheet-core');
const {
  loadWorkbook, toModel, packageLosses, carryOverPackageParts, carryOverDefinedNames, checkEditable, cellSignature, applyOps,
  writeVerified, prepareForWrite,
} = require('../lib/sheet-xlsx');

const SKIP_DIRS = new Set(['node_modules']);
const TYPES = ['xlsx', 'csv'];
const VERDICTS = ['EDITABLE', 'VIEW-ONLY', 'UNREADABLE'];

// ---- Walk ---------------------------------------------------------------------------

function walk(dir, found = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile() && /\.(xlsx|csv)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

// first line only, bounded, so an odd parser message can't flood (or leak) the output
const oneLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);

// ---- Equivalence ----------------------------------------------------------------------

// the cell addresses where two signature entries differ, as 'A1 B7 ...' (at most 3, then a count)
function cellDiffs(a, b) {
  const addrs = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bad = [...addrs].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return bad.length <= 3 ? bad.join(' ') : `${bad.slice(0, 3).join(' ')} +${bad.length - 3} more`;
}

// '' when the two signatures agree, else a short structural description of the first few differences
function signatureDiff(before, after) {
  if (before.length !== after.length) return `sheet count ${before.length} -> ${after.length}`;
  const out = [];
  before.forEach((a, i) => {
    const b = after[i];
    for (const key of Object.keys(a)) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      out.push(key === 'cells' ? `cells differ on sheet ${i + 1} (${cellDiffs(a.cells, b.cells)})` : `${key} differs on sheet ${i + 1}`);
    }
  });
  return out.slice(0, 4).join('; ') + (out.length > 4 ? `; +${out.length - 4} more` : '');
}

// ---- Overlapping validation ranges (ExcelJS's own grouping wrote them; see prepareForWrite) ----------

const SQREF = /<(?:[A-Za-z_][\w.-]*:)?dataValidation(?=[\s/>])[^>]*?\ssqref\s*=\s*["']([^"']*)["']/g;

// 'xl/worksheets/sheet1.xml: F10:F15 / F3:F15' for the first overlapping pair on each sheet part ('' if none)
async function overlappingValidations(buf) {
  const zip = await JSZip.loadAsync(buf);
  const found = [];
  for (const entry of zip.file(/^xl\/worksheets\/[^/]+\.xml$/)) {
    const rects = [];
    for (const m of (await entry.async('string')).matchAll(SQREF)) {
      for (const token of m[1].split(/\s+/).filter(Boolean)) {
        try { rects.push({ token, ...parseRange(token) }); } catch { /* whole rows / columns: not written by ExcelJS */ }
      }
    }
    rects.sort((a, b) => a.r1 - b.r1);
    let pair = null;
    for (let i = 0; i < rects.length && !pair; i++) {
      for (let j = i + 1; j < rects.length && rects[j].r1 <= rects[i].r2 && !pair; j++) {
        if (rects[i].c1 <= rects[j].c2 && rects[j].c1 <= rects[i].c2) pair = `${rects[i].token} / ${rects[j].token}`;
      }
    }
    if (pair) found.push(`${entry.name}: ${pair}`);
  }
  return found.join(', ');
}

// ---- Ops smoke ---------------------------------------------------------------------------

const SMOKE_ROW = 2;          // 0-based: Excel row 3, below a typical header and first band

const LAST_COL = 16383;      // XFD

// the first column whose cell in row r (0-based) no merge covers, or null when merges cover the whole row
function freeColumn(ws, r) {
  const merges = Object.values(ws._merges || {}).map((m) => m.model).filter(Boolean);
  for (let c = 0; c <= LAST_COL; c++) {
    if (!merges.some((g) => g.top <= r + 1 && r + 1 <= g.bottom && g.left <= c + 1 && c + 1 <= g.right)) return c;
  }
  return null;
}

// { skip: reason } or { diff: '' | what differs }. Works on its own fresh copy of the workbook.
async function opsSmoke(buf, before) {
  const wb = await loadWorkbook(buf);
  const first = toModel(wb).sheets[0];
  const reason = first.readOnly || first.rowOps || (first.tooBig ? 'too big to edit here' : null);
  if (reason) return { skip: reason };
  const sheet = first.index;
  applyOps(wb, [{ op: 'insertRows', sheet, at: SMOKE_ROW, n: 1, like: SMOKE_ROW }]);
  const c = freeColumn(wb.worksheets[sheet], SMOKE_ROW);
  const set = c === null ? [] : [{ op: 'set', sheet, r: SMOKE_ROW, c, v: 'x' }];
  applyOps(wb, [...set, { op: 'deleteRows', sheet, at: SMOKE_ROW, n: 1 }]);
  const out = await writeVerified(wb, buf);
  const back = await loadWorkbook(out);
  const overlaps = await overlappingValidations(out);
  const diffs = [signatureDiff(before, cellSignature(back)), overlaps && `overlapping validation ranges (${overlaps})`];
  return { diff: diffs.filter(Boolean).join('; ') };
}

async function xlsxEquivalence(buf, wb, before) {
  const restore = prepareForWrite(wb);                                          // as a save does
  let written;
  try { written = await wb.xlsx.writeBuffer(); } finally { restore(); }
  const { out } = await carryOverDefinedNames(buf, await carryOverPackageParts(buf, written));
  const lost = await packageLosses(buf, out);
  const back = await loadWorkbook(out);
  const diffs = [];
  if (lost.length) diffs.push(`package lost: ${lost.join(', ')}`);
  const overlaps = await overlappingValidations(out);
  if (overlaps) diffs.push(`overlapping validation ranges (${overlaps})`);
  const sig = signatureDiff(before, cellSignature(back));
  if (sig) diffs.push(sig);
  return diffs.join('; ');
}

// ---- One file ---------------------------------------------------------------------------

// { verdict, detail, equiv, ops } where equiv is '' (fine) or what differs, and ops is null (not run) or
// { skip } / { fail } / { ok: true }
async function examine(full, type, smoke) {
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch (e) {
    return { verdict: 'UNREADABLE', detail: oneLine(e), equiv: '' };
  }
  if (type === 'csv') {
    let parsed;
    try {
      parsed = parseCsv(buf);
      const reason = csvEditable(parsed);
      if (reason) return { verdict: 'VIEW-ONLY', detail: reason, equiv: '' };
      const same = serializeCsv(applyCsvOps(parsed, [])).equals(buf);
      return { verdict: 'EDITABLE', detail: '', equiv: same ? '' : 'serialised bytes differ from the file' };
    } catch (e) {
      return { verdict: 'UNREADABLE', detail: oneLine(e), equiv: '' };
    }
  }
  let wb;
  try {
    wb = await loadWorkbook(buf);
  } catch (e) {
    return { verdict: 'UNREADABLE', detail: oneLine(e), equiv: '' };
  }
  let before;
  let check;
  try {
    before = cellSignature(wb);
    check = await checkEditable(buf, wb);
  } catch (e) {
    return { verdict: 'UNREADABLE', detail: oneLine(e), equiv: '' };
  }
  if (!check.editable) return { verdict: 'VIEW-ONLY', detail: check.reason, equiv: '' };

  // the file reads, so from here a throw is a failed round trip, not an unreadable file
  let equiv;
  try {
    equiv = await xlsxEquivalence(buf, wb, before);
  } catch (e) {
    equiv = `round trip threw: ${oneLine(e)}`;
  }
  let ops = null;
  if (smoke) {
    try {
      const r = await opsSmoke(buf, before);
      ops = r.skip ? { skip: r.skip } : r.diff ? { fail: `ops smoke: ${r.diff}` } : { ok: true };
    } catch (e) {
      ops = { fail: `round trip threw: ${oneLine(e)}` };
    }
  }
  return { verdict: 'EDITABLE', detail: '', equiv, ops };
}

// ---- Main ---------------------------------------------------------------------------------

async function main(argv) {
  const args = argv.slice(2);
  const opsSmoke = args.includes('--ops-smoke');
  const dirs = args.filter((a) => a !== '--ops-smoke');
  if (dirs.length !== 1) {
    console.error('Usage: node scripts/sheet-corpus.js <dir> [--ops-smoke]');
    return 2;
  }
  const root = path.resolve(dirs[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${dirs[0]}`);
    return 2;
  }

  const counts = {};
  for (const t of TYPES) counts[t] = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const failures = new Set();
  const smoke = { ok: 0, skip: 0, fail: 0 };

  for (const full of walk(root)) {
    const rel = path.relative(root, full);
    const type = path.extname(full).slice(1).toLowerCase();
    const { verdict, detail, equiv, ops } = await examine(full, type, opsSmoke);
    counts[type][verdict]++;
    console.log(`${verdict}${detail ? ` (${detail})` : ''}  ${rel}`);
    if (equiv) {
      failures.add(rel);
      console.log(`EQUIV-FAIL ${rel}: ${equiv}`);
    }
    if (!ops) continue;
    if (ops.ok) {
      smoke.ok++;
      console.log(`OPS-OK  ${rel}`);
    } else if (ops.skip) {
      smoke.skip++;
      console.log(`OPS-SKIP (${ops.skip})  ${rel}`);
    } else {
      smoke.fail++;
      failures.add(rel);
      console.log(`EQUIV-FAIL ${rel}: ${ops.fail}`);
    }
  }

  const part = (t) => `${t}: ` + VERDICTS.map((v) => `${counts[t][v]} ${v}`).join(', ');
  const smokePart = opsSmoke ? ` | ops smoke: ${smoke.ok} ok, ${smoke.skip} skipped, ${smoke.fail} failed` : '';
  console.log(`SUMMARY ${TYPES.map(part).join(' | ')}${smokePart} | ${failures.size} equivalence failures`);
  return failures.size ? 1 : 0;
}

main(process.argv).then((code) => { process.exitCode = code; }, (e) => {
  console.error(oneLine(e));
  process.exitCode = 3;
});
