'use strict';

// ========================================================================
// xlsx for the spreadsheet viewer/editor, on ExcelJS 4.4.0.
//
//   loadWorkbook(buf)         parse the bytes; a workbook with no visible sheet is unreadable
//   toModel(wb)               { sheets, active }: the Sheet model the grid draws (see globals.md)
//   anyDrawable(wb)           does any visible sheet fit the grid? (a workbook where none does is view-only)
//   partCounts(buf)           the zip's parts, digits in their names normalised, with counts
//   checkEditable(buf, wb)    would saving this workbook with ExcelJS lose anything? { editable, lost, reason }
//   carryOverDefinedNames(srcBuf, outBuf, shifts)   the source's defined names put back into ExcelJS's output
//   cellSignature(wb)         everything a save must preserve, as plain data, one entry per worksheet
//   applyOps(wb, ops)         the grid's edits (set, insertRows, deleteRows), applied in order; 400 on a bad op
//   shiftRows(ws, wb, at, delta, like)   rows inserted (delta > 0) or deleted (delta < 0) at the model level
//   writeVerified(wb, srcBuf) the bytes to save, checked to have lost nothing; 422 if they would
//
// Up to cellSignature nothing modifies the workbook: reads use findRow / findCell, which never
// create rows or cells. applyOps and shiftRows are the only writers. Coordinates in the model
// and in ops are 0-based; ExcelJS's are 1-based.
//
// Sections: constants, load, small mappings (sizes, panes, merges), lists (data
// validation), conditional formats, row operations, tables, cells, toModel, eligibility
// (partCounts, checkEditable), defined names, cellSignature, ops (applyOps, shiftRows), verified write.
// ========================================================================

const { posix } = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { colName, colIndex, parseCell, parseRange, rangeStr, shiftRange, shiftRefList, rebaseFormula } = require('../public/sheet-core');
const { themePalette, cellCss, dxfCss } = require('./sheet-style');
const { displayText, editText, coerceInput } = require('./sheet-values');

// ---- Constants ------------------------------------------------------------

const SHEET_CELL_CAP = 60000;               // the grid draws a sheet only up to this many cells
const DEFAULT_COL_CHARS = 8.43;             // Excel's default column width, in characters
const DEFAULT_ROW_PT = 15;                  // and row height, in points

const PROTECTED = 'This sheet is protected in Excel';
const ROWOPS_FORMULAS = 'This workbook has formulas, so inserting or deleting rows could break them — do that in Excel';
const ROWOPS_TABLE = 'This sheet has an Excel table, so add or remove rows in Excel';
const ROWOPS_IMAGES = 'This sheet has pictures, so add or remove rows in Excel';
const ROWOPS_REFERENCED = "Other sheets' dropdowns or colour rules point at this sheet, so add or remove rows in Excel";
const TABLE_HEADER = 'That cell is part of an Excel table header — edit it in Excel';
const TABLE_TOTALS = 'That cell is part of an Excel table totals row — edit it in Excel';

const ValueType = ExcelJS.ValueType;

const isVisible = (ws) => ws.state === undefined || ws.state === 'visible';
const isObj = (v) => v !== null && typeof v === 'object';
const colPx = (chars) => Math.round(chars * 7 + 5);          // Excel's column width -> pixels
const rowPx = (pt) => Math.round(pt * 4 / 3);                // points -> pixels

// ---- Load -------------------------------------------------------------------

// ExcelJS's own errors (not a zip, truncated parts, ...) propagate as they are. A zip with no
// xl/workbook.xml loads as an empty workbook, and a workbook whose sheets are all hidden has nothing
// to show: both are "unreadable", flagged so the route can treat them like a load failure.
async function loadWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  if (!wb.worksheets.some(isVisible)) {
    throw Object.assign(new Error('no visible worksheets'), { unreadable: true });
  }
  await fixTableHeaders(wb, buf);
  return wb;
}

// ExcelJS reads a table as having a header row only when the file says headerRowCount="1". Excel leaves
// the attribute out when it is 1 (the default), so every table Excel made would load headerless and be
// written back with headerRowCount="0": its header row turned into data, and Excel repairing the file.
// The table parts decide instead: no attribute means a header row.
const TABLE_PART = /^xl\/tables\/[^/]+\.xml$/;
const TABLE_TAG = /<(?:[A-Za-z_][\w.-]*:)?table(?=[\s/>])[^>]*>/;
const tablesOf = (ws) => Object.values(ws.tables || {}).map((t) => t && t.table).filter(isObj);

async function fixTableHeaders(wb, buf) {
  const tables = wb.worksheets.flatMap(tablesOf);
  if (!tables.length) return;
  const zip = await JSZip.loadAsync(buf);
  const headerless = new Set();                 // names of the tables whose part says headerRowCount="0"
  const named = new Set();
  for (const entry of zip.file(TABLE_PART)) {
    const tag = TABLE_TAG.exec(await entry.async('string'));
    const name = tag ? attrOf(tag[0], 'name') : null;
    if (name === null) continue;
    named.add(name);
    const count = attrOf(tag[0], 'headerRowCount');
    if (count !== null && Number(count) === 0) headerless.add(name);
  }
  for (const t of tables) if (named.has(t.name)) t.headerRow = !headerless.has(t.name);
}

// ---- Small mappings: sizes, panes, merges -----------------------------------

const finitePositive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

// px per column, exactly `colCount` of them; columns the file doesn't mention get the sheet's default
function columnSizes(ws, colCount) {
  const columns = Array.isArray(ws.columns) ? ws.columns : [];
  const dflt = finitePositive(ws.properties && ws.properties.defaultColWidth) || DEFAULT_COL_CHARS;
  const widths = [];
  const hidden = [];
  for (let c = 0; c < colCount; c++) {
    const col = columns[c];
    const chars = col && typeof col.width === 'number' && Number.isFinite(col.width) && col.width >= 0 ? col.width : dflt;
    widths.push(colPx(chars));
    if (col && col.hidden) hidden.push(c);
  }
  return { widths, hidden };
}

function frozenPane(ws) {
  const views = Array.isArray(ws.views) ? ws.views : [];
  const view = views.find((v) => isObj(v) && v.state === 'frozen');
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  return view ? { rows: n(view.ySplit), cols: n(view.xSplit) } : { rows: 0, cols: 0 };
}

function mergeList(ws) {
  const out = [];
  for (const m of Object.values(ws._merges || {})) {
    const g = isObj(m) && m.model;
    if (!g || ![g.top, g.left, g.bottom, g.right].every(Number.isInteger)) continue;
    const merge = { r1: g.top - 1, c1: g.left - 1, r2: g.bottom - 1, c2: g.right - 1 };
    if (merge.r1 !== merge.r2 || merge.c1 !== merge.c2) out.push(merge);
  }
  return out.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
}

// ---- Lists (data validation) --------------------------------------------------

const QUOTED = /^"(?:[^"]|"")*"$/;
// [Sheet!]A1[:B2], with the sheet name optionally in 'quotes' ('' is a quote inside). External refs ([1]Sheet!A1) don't match.
const RANGE_REF = /^(?:('(?:[^']|'')+'|[^'![\]]+)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/;
const NAME_REF = /^[A-Za-z_\\][A-Za-z0-9_.\\]*$/;

// non-blank texts, first occurrence wins
function cleanItems(texts) {
  const seen = new Set();
  const items = [];
  for (const t of texts) {
    if (t.trim() === '' || seen.has(t)) continue;
    seen.add(t);
    items.push(t);
  }
  return items;
}

// A formula that names a range -> { ws, rg }, or null. A reference with no sheet means `home`.
function resolveRange(ctx, text, home) {
  const m = RANGE_REF.exec(text);
  if (!m) return null;
  let ws = home;
  if (m[1]) {
    const name = m[1][0] === "'" ? m[1].slice(1, -1).replace(/''/g, "'") : m[1];
    ws = ctx.sheets.get(name.toLowerCase());
    if (!ws) return null;
  }
  try { return { ws, rg: parseRange(m[2]) }; } catch { return null; }
}

// the display texts down a column or along a row; Excel doesn't allow a block as a list source
function rangeTexts({ ws, rg }) {
  if (rg.r1 !== rg.r2 && rg.c1 !== rg.c2) return null;
  const out = [];
  const last = Math.min(rg.r2, ws.rowCount - 1);      // nothing below the sheet's last row can hold text
  for (let r = rg.r1; r <= last; r++) {
    const row = ws.findRow(r + 1);
    if (!row) continue;
    for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = row.findCell(c + 1);
      if (cell) out.push(displayText(cell.value, cell.numFmt));
    }
  }
  return out;
}

// defined name (lower-cased) -> its ranges, built the first time a list points at a name
function definedRanges(ctx) {
  if (!ctx.names) {
    ctx.names = new Map();
    for (const { name, ranges } of ctx.wb.definedNames.model) ctx.names.set(String(name).toLowerCase(), ranges);
  }
  return ctx.names;
}

// The items a list validation's source stands for, or null when it can't be resolved.
function listItems(ctx, ws, formula) {
  if (typeof formula !== 'string') return null;
  let f = formula.trim();
  if (f[0] === '=') f = f.slice(1).trim();
  let texts = null;
  if (QUOTED.test(f)) {
    texts = f.slice(1, -1).replace(/""/g, '"').split(',').map((t) => t.trim());
  } else {
    let target = resolveRange(ctx, f, ws);
    if (!target && NAME_REF.test(f)) {
      const ranges = definedRanges(ctx).get(f.toLowerCase());
      if (ranges && ranges.length === 1) target = resolveRange(ctx, ranges[0], ws);
    }
    texts = target && rangeTexts(target);
  }
  const items = texts ? cleanItems(texts) : [];
  return items.length ? items : null;
}

// cells -> a short list of rectangles: vertical runs per column, then runs of identical span in neighbouring columns
function coalesce(cells) {
  const byCol = new Map();
  for (const { r, c } of cells) {
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(r);
  }
  const runs = [];
  for (const [c, rows] of byCol) {
    rows.sort((a, b) => a - b);
    let r1 = rows[0];
    let r2 = r1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] === r2 + 1) { r2 = rows[i]; continue; }
      runs.push({ r1, r2, c });
      r1 = r2 = rows[i];
    }
    runs.push({ r1, r2, c });
  }
  runs.sort((a, b) => a.r1 - b.r1 || a.r2 - b.r2 || a.c - b.c);
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.r1 === run.r1 && last.r2 === run.r2 && last.c2 + 1 === run.c) last.c2 = run.c;
    else out.push({ r1: run.r1, c1: run.c, r2: run.r2, c2: run.c });
  }
  return out.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
}

// List validations grouped by identical source and strictness. ExcelJS reports a validation per cell.
// `strict` follows showErrorMessage the way Excel does: the attribute's default is false (any text is
// accepted), and ExcelJS loads an absent attribute as undefined, so only an explicit true is strict.
function buildLists(ctx, ws) {
  const dvs = ws.dataValidations && ws.dataValidations.model;
  if (!isObj(dvs)) return [];
  const cells = [];
  for (const [address, dv] of Object.entries(dvs)) {
    if (!isObj(dv) || dv.type !== 'list' || !Array.isArray(dv.formulae) || dv.formulae.length === 0) continue;
    let at;
    try { at = parseCell(address); } catch { continue; }
    cells.push({ r: at.r, c: at.c, dv });
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  const groups = new Map();
  for (const { r, c, dv } of cells) {
    const strict = dv.showErrorMessage === true;
    const key = JSON.stringify([dv.formulae, strict]);
    if (!groups.has(key)) groups.set(key, { formula: dv.formulae[0], strict, cells: [] });
    groups.get(key).cells.push({ r, c });
  }
  const lists = [];
  for (const g of groups.values()) {
    const items = listItems(ctx, ws, g.formula);
    if (items) lists.push({ ranges: coalesce(g.cells), items, strict: g.strict });
  }
  return lists;
}

// ---- Conditional formats ------------------------------------------------------

const CELL_OPS = new Map([
  ['equal', 'eq'], ['notEqual', 'ne'], ['greaterThan', 'gt'], ['lessThan', 'lt'],
  ['greaterThanOrEqual', 'ge'], ['lessThanOrEqual', 'le'], ['between', 'between'], ['notBetween', 'notBetween'],
]);
const EXPR_OPS = new Map([['=', 'eq'], ['<>', 'ne'], ['>', 'gt'], ['<', 'lt'], ['>=', 'ge'], ['<=', 'le']]);

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER_RE = new RegExp('^' + NUMBER + '$');
// REF op LITERAL, REF a single cell on this sheet, LITERAL a number or a "string"
const EXPR_RE = new RegExp('^\\s*(\\$?[A-Za-z]{1,3}\\$?\\d+)\\s*(<>|>=|<=|=|>|<)\\s*(' + NUMBER + '|"(?:[^"]|"")*")\\s*$');
const WHOLE_COL = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
const WHOLE_ROW = /^\$?(\d+):\$?(\d+)$/;

// a number or a "string" -> its value; undefined for anything else
function parseLiteral(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x !== 'string') return undefined;
  const t = x.trim();
  if (QUOTED.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  return NUMBER_RE.test(t) ? Number(t) : undefined;
}

// 'F3:F15 F17' -> rectangles. A whole column or row is clamped to the sheet's used area.
// Any token that isn't a reference makes the whole list unusable (null), so the anchor can't drift.
function parseSqref(ref, rowCount, colCount) {
  if (typeof ref !== 'string') return null;
  const tokens = ref.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const out = [];
  for (const token of tokens) {
    let m;
    try {
      if ((m = WHOLE_COL.exec(token))) {
        const a = parseCell(m[1] + '1');
        const b = parseCell(m[2] + '1');
        out.push({ r1: 0, c1: Math.min(a.c, b.c), r2: Math.max(rowCount - 1, 0), c2: Math.max(a.c, b.c) });
      } else if ((m = WHOLE_ROW.exec(token))) {
        const a = parseCell('A' + m[1]);
        const b = parseCell('A' + m[2]);
        out.push({ r1: Math.min(a.r, b.r), c1: 0, r2: Math.max(a.r, b.r), c2: Math.max(colCount - 1, 0) });
      } else {
        out.push(parseRange(token));
      }
    } catch { return null; }
  }
  return out;
}

// One ExcelJS rule -> a CfRule, or null when the grid can't draw it (the caller counts it).
function cfRule(rule, anchor, palette) {
  if (!isObj(rule)) return null;
  const css = dxfCss(rule.style, palette);
  const stop = !!rule.stopIfTrue;
  const formulae = Array.isArray(rule.formulae) ? rule.formulae : [];

  if (rule.type === 'cellIs') {
    const op = CELL_OPS.get(rule.operator);
    if (!op || formulae.length !== (op === 'between' || op === 'notBetween' ? 2 : 1)) return null;
    const values = formulae.map(parseLiteral);
    if (values.some((v) => v === undefined)) return null;
    return { kind: 'cell', op, values, css, stop };
  }

  if (rule.type === 'expression' && formulae.length === 1 && typeof formulae[0] === 'string') {
    const m = EXPR_RE.exec(formulae[0]);
    if (!m) return null;
    let at;
    try { at = parseCell(m[1]); } catch { return null; }
    const value = parseLiteral(m[3]);
    if (value === undefined) return null;
    const ref = { r: at.absR ? at.r : at.r - anchor.r, c: at.absC ? at.c : at.c - anchor.c, absR: at.absR, absC: at.absC };
    return { kind: 'ref', op: EXPR_OPS.get(m[2]), values: [value], ref, css, stop };
  }
  return null;
}

// Entries sorted by their best priority, rules by priority (lower number wins). `skipped` counts every
// rule that isn't drawable, including all rules of an entry whose ranges can't be read.
function buildCf(ws, palette, rowCount, colCount) {
  const entries = [];
  let skipped = 0;
  const priorityOf = (rule) => (isObj(rule) && typeof rule.priority === 'number' ? rule.priority : Infinity);
  for (const entry of Array.isArray(ws.conditionalFormattings) ? ws.conditionalFormattings : []) {
    const rules = isObj(entry) && Array.isArray(entry.rules) ? entry.rules : [];
    const ranges = isObj(entry) ? parseSqref(entry.ref, rowCount, colCount) : null;
    if (!ranges) { skipped += rules.length; continue; }
    const anchor = { r: ranges[0].r1, c: ranges[0].c1 };
    const kept = [];
    for (const rule of rules) {
      const mapped = cfRule(rule, anchor, palette);
      if (mapped) kept.push({ priority: priorityOf(rule), rule: mapped });
      else skipped++;
    }
    if (kept.length === 0) continue;
    kept.sort((a, b) => a.priority - b.priority);
    entries.push({ priority: kept[0].priority, ranges, rules: kept.map((k) => k.rule) });
  }
  entries.sort((a, b) => a.priority - b.priority);
  return { cf: entries.map(({ ranges, rules }) => ({ ranges, rules })), skipped };
}

// ---- Row operations ------------------------------------------------------------

function hasFormulas(wb) {
  for (const ws of wb.worksheets) {
    let found = false;
    ws.eachRow((row) => {
      if (found) return;
      row.eachCell((cell) => { if (cell.type === ValueType.Formula) found = true; });
    });
    if (found) return true;
  }
  return false;
}

// Why the grid can't edit this sheet at all, or null. The grid gets the same answers through toModel
// (readOnly, tooBig), and applyOps refuses ops on such a sheet whatever the client sends.
const readOnlyReason = (ws) => (ws.sheetProtection && ws.sheetProtection.sheet ? PROTECTED : null);
const tooBigToDraw = (ws) => ws.rowCount * Math.max(ws.columnCount, 1) > SHEET_CELL_CAP;

// The formula texts of a sheet's data validations and conditional-format rules, each once.
function ruleFormulas(ws) {
  const out = new Set();
  const dvs = ws.dataValidations && ws.dataValidations.model;
  const seen = new Set();
  for (const dv of isObj(dvs) ? Object.values(dvs) : []) {
    if (!isObj(dv) || seen.has(dv)) continue;
    seen.add(dv);
    for (const f of Array.isArray(dv.formulae) ? dv.formulae : []) if (typeof f === 'string') out.add(f);
  }
  for (const entry of Array.isArray(ws.conditionalFormattings) ? ws.conditionalFormattings : []) {
    for (const rule of (isObj(entry) && Array.isArray(entry.rules)) ? entry.rules : []) {
      if (!isObj(rule)) continue;
      for (const f of Array.isArray(rule.formulae) ? rule.formulae : []) if (typeof f === 'string') out.add(f);
      for (const v of Array.isArray(rule.cfvo) ? rule.cfvo : []) if (isObj(v) && typeof v.value === 'string') out.add(v.value);
    }
  }
  return out;
}

// Does a formula name this sheet: 'My Sheet'!A1 or Lists!A1, in any case? A name that only ends with
// it (MyLists!), a quoted name it is part of, or another workbook's sheet ([1]Lists!) doesn't count.
// Text inside "strings" does (INDIRECT("Lists!A"&ROW()) depends on that sheet's rows too).
function namesSheet(text, name) {
  const t = text.toLowerCase();
  const n = name.toLowerCase();
  if (t.includes(`'${n.replace(/'/g, "''")}'!`)) return true;
  for (let i = t.indexOf(n + '!'); i >= 0; i = t.indexOf(n + '!', i + 1)) {
    if (i === 0 || !/[\w.'\]\u00a1-\uffff]/.test(t[i - 1])) return true;
  }
  return false;
}

// Lower-cased names of the sheets that some OTHER sheet's validation or conditional-format formula
// points at. Row operations don't rewrite other sheets' formulas, so those sheets can't take them.
function referencedSheets(wb) {
  const sheets = wb.worksheets;
  const texts = sheets.map((ws) => [...ruleFormulas(ws)]);
  const out = new Set();
  sheets.forEach((ws, i) => {
    if (texts.some((list, j) => j !== i && list.some((t) => namesSheet(t, ws.name)))) out.add(ws.name.toLowerCase());
  });
  return out;
}

// What rowOpsReason needs to know about the whole workbook, worked out once.
const rowOpsContext = (wb) => ({ formulas: hasFormulas(wb), referenced: referencedSheets(wb) });

// why rows can't be inserted or deleted on this sheet, or null
function rowOpsReason(ws, rc) {
  if (rc.formulas) return ROWOPS_FORMULAS;
  if (Object.keys(ws.tables || {}).length > 0) return ROWOPS_TABLE;
  if (ws.getImages().length > 0) return ROWOPS_IMAGES;
  if (rc.referenced.has(ws.name.toLowerCase())) return ROWOPS_REFERENCED;
  return null;
}

// ---- Tables ----------------------------------------------------------------------

// An Excel table keeps its column names in its own part as well as in the header row's cells, and Excel
// repairs a file where the two disagree; a totals row's labels and formulas belong to the table too. So the
// header and totals rows are locked, as [{ r1, c1, r2, c2, msg }] rectangles: the grid explains them and
// applyOps refuses a `set` into them. (Row operations are refused on a sheet with a table, so these
// rectangles never move within a save.)
function tableLocks(ws) {
  const out = [];
  for (const t of tablesOf(ws)) {
    let rg;
    try { rg = parseRange(t.tableRef); } catch { continue; }
    if (t.headerRow) out.push({ r1: rg.r1, c1: rg.c1, r2: rg.r1, c2: rg.c2, msg: TABLE_HEADER });
    if (t.totalsRow) out.push({ r1: rg.r2, c1: rg.c1, r2: rg.r2, c2: rg.c2, msg: TABLE_TOTALS });
  }
  return out.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
}

const lockAt = (locks, r, c) => locks.find((l) => l.r1 <= r && r <= l.r2 && l.c1 <= c && c <= l.c2) || null;

// Can the grid draw any of the workbook's visible sheets? When it can't, nothing can be edited here, and the
// dry-run write of checkEditable (slow on sheets that size) is skipped.
const anyDrawable = (wb) => wb.worksheets.some((ws) => isVisible(ws) && !tooBigToDraw(ws));

// ---- Cells ---------------------------------------------------------------------

// Styles are shared between cells in a loaded workbook, so the CSS is worked out once per style object.
function makeStyler(palette) {
  const cssOf = new WeakMap();
  const styles = [];
  const index = new Map();
  return {
    styles,
    css(style) {
      if (!isObj(style)) return '';
      if (!cssOf.has(style)) cssOf.set(style, cellCss(style, palette));
      return cssOf.get(style);
    },
    // style index for non-empty CSS, in this sheet's own (deduped) list
    indexOf(css) {
      if (!index.has(css)) { index.set(css, styles.length); styles.push(css); }
      return index.get(css);
    },
  };
}

// Colour and size say nothing about a cell with no text in it. ExcelJS gives the workbook's default font
// (black, 11pt) to every cell that has any style at all (a number format, say), so those two on their own
// don't make an empty cell worth sending.
const TEXT_ONLY = /^(?:color|font-size):/;
const hasLook = (css) => css !== '' && css.split(';').some((d) => !TEXT_ONLY.test(d));

// One model cell, or null when the grid has nothing to draw for it.
//   - a cell inside a merge (not its top-left) shows nothing but keeps its own style: the
//     right and bottom borders of a merged block live on those cells
//   - otherwise a cell is kept when it has text, a formula, or a look that shows without text
//     (fill, border, bold, alignment, wrapping...)
function modelCell(cell, styler) {
  const css = styler.css(cell.style);
  if (cell.type === ValueType.Merge) return hasLook(css) ? { s: styler.indexOf(css) } : null;
  const value = cell.value;
  const numFmt = cell.numFmt;
  const t = displayText(value, numFmt);
  const formula = cell.type === ValueType.Formula;
  if (t === '' && !formula && !hasLook(css)) return null;
  const out = { t };
  const e = editText(value, numFmt);
  if (e !== t) out.e = e;
  if (css) out.s = styler.indexOf(css);
  if (formula && typeof cell.formula === 'string' && cell.formula) out.f = '=' + cell.formula;
  return out;
}

// ---- toModel -------------------------------------------------------------------

function sheetModel(ctx, ws, index) {
  const rowCount = ws.rowCount;
  const colCount = Math.max(ws.columnCount, 1);
  const tooBig = tooBigToDraw(ws);
  const cols = columnSizes(ws, colCount);
  const defaultRowPt = finitePositive(ws.properties && ws.properties.defaultRowHeight) || DEFAULT_ROW_PT;
  const defaultRowHeight = rowPx(defaultRowPt);
  const styler = makeStyler(ctx.palette);

  const cells = {};
  const rowHeights = {};
  const hiddenRows = [];
  for (let r = 0; r < rowCount; r++) {
    const row = ws.findRow(r + 1);
    if (!row) continue;
    if (row.hidden) hiddenRows.push(r);
    const px = typeof row.height === 'number' && row.height > 0 ? rowPx(row.height) : 0;
    if (px > 0 && px !== defaultRowHeight) rowHeights[r] = px;
    if (tooBig) continue;
    for (let c = 0; c < colCount; c++) {
      const cell = row.findCell(c + 1);
      const mc = cell && modelCell(cell, styler);
      if (mc) cells[r + ',' + c] = mc;
    }
  }

  const { cf, skipped } = buildCf(ws, ctx.palette, rowCount, colCount);
  return {
    index,
    name: ws.name,
    rowCount,
    colCount,
    cells,
    styles: styler.styles,
    colWidths: cols.widths,
    rowHeights,
    defaultRowHeight,
    hiddenRows,
    hiddenCols: cols.hidden,
    merges: mergeList(ws),
    frozen: frozenPane(ws),
    lists: buildLists(ctx, ws),
    cf,
    cfSkipped: skipped,
    readOnly: readOnlyReason(ws),
    rowOps: rowOpsReason(ws, ctx.rowOps),
    tooBig,
    locked: tableLocks(ws),
  };
}

// `index` is the sheet's position among ALL worksheets (hidden ones included), which is what ops
// address; `sheets` holds only the visible ones, and `active` indexes into `sheets`.
function toModel(wb) {
  const all = wb.worksheets;
  const ctx = {
    wb,
    palette: themePalette(wb._themes && wb._themes.theme1),
    rowOps: rowOpsContext(wb),
    sheets: new Map(all.map((ws) => [ws.name.toLowerCase(), ws])),
    names: null,
  };
  const sheets = [];
  all.forEach((ws, i) => { if (isVisible(ws)) sheets.push(sheetModel(ctx, ws, i)); });

  const views = Array.isArray(wb.views) ? wb.views : [];
  const tab = isObj(views[0]) ? views[0].activeTab : undefined;
  const active = Math.max(0, Number.isInteger(tab) ? sheets.findIndex((s) => s.index === tab) : 0);
  return { sheets, active };
}

// ---- Eligibility: would a save lose anything? ------------------------------------

// ExcelJS rewrites the whole package and keeps only what it understands. checkEditable writes the
// untouched workbook and compares: zip parts by count (a second drawing lost while another is kept
// is still a loss), the anchors inside the drawings (a text box beside a picture goes without the
// part count moving), then the sheet details ExcelJS is known to mangle.

// Parts that say nothing about content: relationships, content types, the standard document
// properties and thumbnail (ExcelJS writes its own app.xml and core.xml), and the two parts ExcelJS
// rebuilds from the sheets themselves. Anything else under docProps/ is counted (docProps/custom.xml
// carries custom properties, including sensitivity labels); a save carries that one over, see
// carryOverPackageParts, and anything else still missing afterwards is a loss.
const BOOKKEEPING = /(?:^|\/)_rels\/|\.rels$|^\[Content_Types\]\.xml$|^docProps\/(?:app\.xml|core\.xml|thumbnail\.[^/]*)$|calcChain|sharedStrings/;
// Parts that may go without anyone minding: print driver blobs and custom XML data stores.
const HARMLESS_PREFIXES = ['xl/printerSettings/', 'customXml/'];

// Map of normalised part name ('xl/worksheets/sheet3.xml' -> 'xl/worksheets/sheetN.xml') to how many
// parts have it, bookkeeping parts left out.
async function partCounts(buf) {
  const zip = await JSZip.loadAsync(buf);
  const counts = new Map();
  zip.forEach((path, entry) => {
    if (entry.dir || BOOKKEEPING.test(path)) return;
    const name = path.replace(/\d+/g, 'N');
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return counts;
}

// Notes (xl/commentsN.xml, with their shapes in xl/drawings/vmlDrawingN.vml) are counted note by note
// instead (noteCount): a part that goes because its last note was deleted is no loss.
const NOTE_PARTS = /^xl\/comments[^/]*$|^xl\/drawings\/vmlDrawing[^/]*$/;

// Normalised names (sorted) of the parts the output has fewer of than the source, harmless ones and
// notes aside.
function partLosses(before, after) {
  const lost = [];
  for (const [name, n] of before) {
    if (HARMLESS_PREFIXES.some((p) => name.startsWith(p)) || NOTE_PARTS.test(name)) continue;
    if ((after.get(name) || 0) < n) lost.push(name);
  }
  return lost.sort();
}

// Anchors (one per picture, shape, text box or chart) in all the workbook's drawing parts. A shape and a
// picture share one drawing part, so the part count alone can't tell that ExcelJS kept the picture and
// dropped the shape.
const DRAWING_PART = /^xl\/drawings\/drawing\d+\.xml$/;
const ANCHOR = /<(?:[A-Za-z_][\w.-]*:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)(?=[\s/>])/g;

// how many times `element` occurs across the parts whose names match `parts`
async function countElements(buf, parts, element) {
  const zip = await JSZip.loadAsync(buf);
  let total = 0;
  for (const entry of zip.file(parts)) total += ((await entry.async('string')).match(element) || []).length;
  return total;
}

const drawingAnchors = (buf) => countElements(buf, DRAWING_PART, ANCHOR);

// Notes: one <comment> each in xl/commentsN.xml. ExcelJS drops a note on a cell the file has no <c> for
// (Excel writes a note on a blank, unstyled cell that way), so notes are compared by count.
const NOTE_PART = /^xl\/comments[^/]*\.xml$/;
const NOTE = /<(?:[A-Za-z_][\w.-]*:)?comment(?=[\s/>])/g;
const noteCount = (buf) => countElements(buf, NOTE_PART, NOTE);

// Manual page breaks: <brk> in a worksheet's rowBreaks / colBreaks. ExcelJS never reads them.
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;
const PAGE_BREAK = /<(?:[A-Za-z_][\w.-]*:)?brk(?=[\s/>])/g;
const pageBreaks = (buf) => countElements(buf, WORKSHEET_PART, PAGE_BREAK);

// Hidden and grouped rows, as { hidden, grouped } counts. ExcelJS writes no <row> for a row with no cells
// and no height, so a hidden or grouped empty row would lose that state without a word (Ruling 25).
const ROW_TAG = /<(?:[A-Za-z_][\w.-]*:)?row(?=[\s/>])[^>]*>/g;
const HIDDEN_ATTR = /\shidden\s*=\s*["'](?:1|true)["']/i;
const OUTLINE_ATTR = /\soutlineLevel\s*=\s*["'](\d+)["']/;
async function rowStates(buf) {
  const zip = await JSZip.loadAsync(buf);
  const counts = { hidden: 0, grouped: 0 };
  for (const entry of zip.file(WORKSHEET_PART)) {
    for (const tag of (await entry.async('string')).match(ROW_TAG) || []) {
      if (HIDDEN_ATTR.test(tag)) counts.hidden++;
      const level = OUTLINE_ATTR.exec(tag);
      if (level && Number(level[1]) > 0) counts.grouped++;
    }
  }
  return counts;
}

// the same counts for a workbook in memory: what the writer should produce
function rowStatesInMemory(wb) {
  const counts = { hidden: 0, grouped: 0 };
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.findRow(r);
      if (!row) continue;
      if (row.hidden) counts.hidden++;
      if (row.outlineLevel > 0) counts.grouped++;
    }
  }
  return counts;
}

// What people call the thing a part belongs to, matched on the part's folder (or, for a part sitting
// directly in xl/, its file name). Anything else is called by its folder.
const SHAPES = 'shapes or pictures';
const PAGE_BREAKS = 'page breaks';
const NOTES = 'notes';
const DEPENDENT_LISTS = 'dropdowns that depend on other cells';
const CELL_BOUNDS = 'validation rules that refer to other cells';
const VALIDATIONS = 'validation rules';
const ROW_STATES = 'hidden or grouped rows';
const DOC_PROPS = 'document properties (such as sensitivity labels)';
const NAMED_RANGES = 'named ranges';
const LINKS = 'links to other places in the workbook';
const EXTENSIONS = 'Excel extensions such as sparklines';
const TABLES = 'Excel tables';
const PART_LABELS = [
  ['docProps', DOC_PROPS], ['docMetadata', DOC_PROPS],
  ['chart', 'charts'], ['drawing', SHAPES], ['pivot', 'pivot tables'],
  ['person', 'threaded comments'], ['threadedComment', 'threaded comments'],
  ['externalLink', 'links to other workbooks'], ['vbaProject', 'macros'],
  ['slicer', 'slicers'], ['timeline', 'timelines'], ['ctrlProp', 'form controls'],
];

function partLabel(name) {
  const segs = name.split('/');
  const inXl = segs[0] === 'xl';
  const own = segs.length === (inXl ? 2 : 1);          // a part directly in xl/ (or the root), not in a folder
  const key = own ? segs[segs.length - 1].replace(/\.[^.]*$/, '').replace(/N+$/, '') : segs[inXl ? 1 : 0];
  const hit = PART_LABELS.find(([prefix]) => key.startsWith(prefix));
  return hit ? hit[1] : key;
}

// What the output package lacks that the source had, as the labels people see, each once: parts whose
// count dropped (in part-name order), then shapes or pictures if the drawings hold fewer anchors, then
// page breaks if the worksheets hold fewer. Notes are not compared here (see noteCount).
async function packageLosses(srcBuf, outBuf) {
  const labels = [];
  const add = (label) => { if (!labels.includes(label)) labels.push(label); };
  for (const name of partLosses(await partCounts(srcBuf), await partCounts(outBuf))) add(partLabel(name));
  if ((await drawingAnchors(outBuf)) < (await drawingAnchors(srcBuf))) add(SHAPES);
  if ((await pageBreaks(outBuf)) < (await pageBreaks(srcBuf))) add(PAGE_BREAKS);
  return labels;
}

// 'a', 'a and b', 'a, b and c'
const sayList = (items) => (items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

// Merged ranges as sorted 'A1:B2' strings. Unlike the model's merge list this keeps one-cell merges
// (<mergeCell ref="D12"/>): they mean nothing in Excel, but ExcelJS drops them on save, and a save
// that drops anything is not one to make silently.
function mergeRanges(ws) {
  const out = [];
  for (const m of Object.values(ws._merges || {})) {
    const g = isObj(m) && m.model;
    if (!g || ![g.top, g.left, g.bottom, g.right].every(Number.isInteger)) continue;
    out.push(rangeStr({ r1: g.top - 1, c1: g.left - 1, r2: g.bottom - 1, c2: g.right - 1 }));
  }
  return out.sort();
}

// [{ width, hidden }] per column, trailing columns that say nothing dropped
function columnList(ws) {
  const cols = (Array.isArray(ws.columns) ? ws.columns : []).map((col) => ({
    width: col && typeof col.width === 'number' ? col.width : null,
    hidden: !!(col && col.hidden),
  }));
  while (cols.length && cols[cols.length - 1].width === null && !cols[cols.length - 1].hidden) cols.pop();
  return cols;
}

const widthMap = (ws) => columnList(ws).map((col, i) => [i, col.width]).filter(([, w]) => w !== null);
const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Parts a save carries over ------------------------------------------------------

// ExcelJS doesn't write these two kinds of part, though they matter to the people who set them: custom
// document properties (docProps/custom.xml: sensitivity labels, SharePoint column data) and the
// sensitivity-label metadata under docMetadata/. Nothing in the sheet depends on them, so a save puts
// the source's own bytes back into ExcelJS's output and registers them, instead of refusing the file.
const isCarried = (name) => name === 'docProps/custom.xml' || name.startsWith('docMetadata/');
// only for a source that names no content type of its own for the part
const FALLBACK_TYPES = new Map([
  ['docProps/custom.xml', 'application/vnd.openxmlformats-officedocument.custom-properties+xml'],
  ['docMetadata/LabelInfo.xml', 'application/vnd.ms-office.classificationlabels+xml'],
]);

const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, n) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[n]);
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the attributes of each <element ...> in some XML, as plain objects (entities decoded)
function elementsOf(xml, element) {
  const out = [];
  for (const tag of xml.matchAll(new RegExp('<' + element + '\\b[^>]*>', 'g'))) {
    const attrs = {};
    for (const m of tag[0].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
    out.push(attrs);
  }
  return out;
}

const zipText = async (zip, name) => (zip.file(name) ? zip.file(name).async('string') : '');
const rootTarget = (target) => String(target || '').replace(/^\//, '');

// The content type the source gives a part: its own override, else the default for the extension.
function sourceContentType(types, name) {
  const override = elementsOf(types, 'Override').find((a) => a.PartName === '/' + name);
  if (override && override.ContentType) return override.ContentType;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const dflt = elementsOf(types, 'Default').find((a) => String(a.Extension || '').toLowerCase() === ext);
  if (dflt && dflt.ContentType) return dflt.ContentType;
  return FALLBACK_TYPES.get(name) || 'application/xml';
}

// `outBuf` (ExcelJS's output for the workbook in `srcBuf`) with the source's custom properties and
// docMetadata/ parts put back: bytes verbatim, a content-type override with the source's type, and,
// where the source's package relationships point at the part, a relationship of the same type with a
// fresh id (rIdVaultOS1, 2, ...). Every other part is untouched. Parts the output already has are left
// alone, so doing it twice changes nothing; with nothing to carry the same buffer is returned.
async function carryOverPackageParts(srcBuf, outBuf) {
  const src = await JSZip.loadAsync(srcBuf);
  const missing = Object.keys(src.files).filter((n) => !src.files[n].dir && isCarried(n));
  if (!missing.length) return outBuf;
  const out = await JSZip.loadAsync(outBuf);
  const toCarry = missing.filter((n) => !out.file(n));
  if (!toCarry.length) return outBuf;

  let types = await zipText(out, '[Content_Types].xml');
  let rels = await zipText(out, '_rels/.rels');
  const closeTypes = types.lastIndexOf('</Types>');
  const closeRels = rels.lastIndexOf('</Relationships>');
  if (closeTypes < 0 || closeRels < 0) return outBuf;            // can't register them: they stay lost

  const srcTypes = await zipText(src, '[Content_Types].xml');
  const srcRels = elementsOf(await zipText(src, '_rels/.rels'), 'Relationship');
  const haveTypes = elementsOf(types, 'Override').map((a) => a.PartName);
  const haveIds = new Set(elementsOf(rels, 'Relationship').map((a) => a.Id));
  const haveTargets = new Set(elementsOf(rels, 'Relationship').map((a) => rootTarget(a.Target)));
  let nextId = 0;
  const freshId = () => { let id; do { id = 'rIdVaultOS' + (++nextId); } while (haveIds.has(id)); haveIds.add(id); return id; };

  let addTypes = '';
  let addRels = '';
  for (const name of toCarry) {
    out.file(name, await src.file(name).async('nodebuffer'));
    if (!name.endsWith('.rels') && !haveTypes.includes('/' + name)) {
      addTypes += `<Override PartName="/${escapeXml(name)}" ContentType="${escapeXml(sourceContentType(srcTypes, name))}"/>`;
    }
    const rel = srcRels.find((a) => rootTarget(a.Target) === name && a.TargetMode !== 'External');
    if (rel && !haveTargets.has(name)) {
      addRels += `<Relationship Id="${freshId()}" Type="${escapeXml(rel.Type || '')}" Target="${escapeXml(rel.Target)}"/>`;
    }
  }
  types = types.slice(0, closeTypes) + addTypes + types.slice(closeTypes);
  rels = rels.slice(0, closeRels) + addRels + rels.slice(closeRels);
  out.file('[Content_Types].xml', types);
  out.file('_rels/.rels', rels);
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const LOST_UNKNOWN = 'parts of this workbook';

// Rulings 18 and 26. ExcelJS keeps a validation per cell and, on every save, regroups the cells into
// ranges by their addresses sorted as text (F3:F15 comes back as F10:F15 and F3:F15, B3:C6 can come back
// split by column). A formula is written for the top-left cell of its range, so any relative reference,
// row or column (INDIRECT($B3), COUNTIF(A3:A9,...), B$3:B$5), would silently point elsewhere. Only
// literal lists ("a,b") and fully absolute references ($A$1:$A$3, Lists!$A$1:$A$9) survive that.
//
// A reference is relative when it lacks a $ on its row or its column (whole columns A:A and whole rows
// 3:3 count). The scan skips "strings", error literals, function names and sheet qualifiers; it is
// backed by rebaseFormula (re-anchoring by a row changes a formula with a relative row reference), so
// the two would have to miss the same reference for one to slip through.
const WORD_RE = /[$\w.\u00a1-\uffff]+/g;
const CELL_WORD = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
const COLS_WORD = /^(\$?)[A-Za-z]{1,3}$/;
const ROWS_WORD = /^(\$?)\d+$/;
const ERROR_LITERAL = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/gi;

function hasRelativeReference(formula, sheetNames) {
  if (sheetNames.some((sheet) => rebaseFormula(formula, { sheet, at: 0, delta: 0, anchorShift: 1 }) !== formula)) return true;
  const text = formula.replace(/"(?:[^"]|"")*"/g, ' ').replace(/'(?:[^']|'')+'!/g, ' ').replace(ERROR_LITERAL, ' ');
  const words = [...text.matchAll(WORD_RE)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
  return words.some(({ word, start, end }, i) => {
    const next = text[end];
    if (next === '(' || next === '!') return false;                     // a function or a sheet name
    const cell = CELL_WORD.exec(word);
    if (cell) {
      try { parseCell(word); } catch { return false; }                    // past XFD or row 1048576: a name
      return !cell[1] || !cell[3];
    }
    // whole columns (A:C) and whole rows (3:5): both ends of the same shape, joined by ':'
    const pair = next === ':' && words[i + 1] && words[i + 1].start === end + 1 ? words[i + 1].word : null;
    for (const shape of [COLS_WORD, ROWS_WORD]) {
      if (shape.test(word) && pair !== null && shape.test(pair)) return !word.startsWith('$') || !pair.startsWith('$');
    }
    return false;
  });
}

// The validations as the file writes them, per sheet name: { type, f1, f2 } with the raw formula texts
// (entities decoded; null where there is none). Read from the XML, because ExcelJS parses the bounds of
// whole-number and text-length rules with parseInt and decimal / date ones with parseFloat, so
// `10+$B$1` already looks like 10 once loaded (Finding 9). Both forms count: <dataValidation> with
// <formula1>, and the x14 extension's <x14:dataValidation> with <x14:formula1><xm:f>, which ExcelJS
// doesn't read at all.
const DV_TAG = /<((?:[A-Za-z_][\w.-]*:)?dataValidation)(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const formulaTag = (n) => new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?formula${n})(?=[\\s/>])[^>]*?(?:/>|>([\\s\\S]*?)</\\1\\s*>)`);
const FORMULA_TAGS = [formulaTag(1), formulaTag(2)];
const decodeXml = (s) => unescapeXml(s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))));
const xmlText = (inner) => decodeXml(inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')).replace(/<[^>]*>/g, ''));
const attrOf = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] !== undefined ? m[1] : m[2]) : null;
};

// sheet name -> its worksheet part, from xl/workbook.xml and its relationships
async function sheetParts(zip) {
  const targets = new Map();
  for (const tag of (await zipText(zip, 'xl/_rels/workbook.xml.rels')).match(/<(?:[A-Za-z_][\w.-]*:)?Relationship(?=[\s/>])[^>]*>/g) || []) {
    const id = attrOf(tag, 'Id');
    const target = attrOf(tag, 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : posix.normalize(`xl/${target}`));
  }
  const parts = new Map();
  for (const tag of (await zipText(zip, 'xl/workbook.xml')).match(/<(?:[A-Za-z_][\w.-]*:)?sheet(?=[\s/>])[^>]*>/g) || []) {
    const id = attrOf(tag, '[A-Za-z_][\\w.-]*:id');
    const name = attrOf(tag, 'name');
    if (name !== null && id && targets.has(id)) parts.set(name, targets.get(id));
  }
  return parts;
}

async function rawValidations(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map();
  for (const [name, part] of await sheetParts(zip)) {
    const list = [];
    for (const m of (await zipText(zip, part)).matchAll(DV_TAG)) {
      const body = m[3] || '';
      const [f1, f2] = FORMULA_TAGS.map((re) => { const f = re.exec(body); return f ? xmlText(f[2] || '') : null; });
      list.push({ type: attrOf(m[2], 'type') || 'none', f1, f2 });
    }
    out.set(name, list);
  }
  return out;
}

// A plain number, optionally signed, with decimals or an exponent: what Excel writes for a numeric,
// date (serial) or time (fraction) bound. Anything else refers to a cell or is a formula.
const PLAIN_NUMBER = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const NO_BOUNDS = new Set(['list', 'none', 'any']);

// Rulings 18, 26 on the raw texts, as loss labels: each validation is judged once, first for relative
// references (any type), then, if it isn't a list, for bounds that aren't plain numbers.
function validationLosses(raw, sheetNames) {
  const labels = new Set();
  for (const list of raw.values()) {
    for (const { type, f1, f2 } of list) {
      const formulas = [f1, f2].filter((f) => f !== null && f !== '');
      if (formulas.some((f) => hasRelativeReference(f, sheetNames))) labels.add(DEPENDENT_LISTS);
      else if (!NO_BOUNDS.has(type) && !formulas.every((f) => PLAIN_NUMBER.test(f))) labels.add(CELL_BOUNDS);
    }
  }
  return [DEPENDENT_LISTS, CELL_BOUNDS].filter((label) => labels.has(label));
}

// Does every sheet keep the same validation rules, text for text? Compared as sets of distinct
// (type, formula1, formula2), not counts: ExcelJS legitimately writes one Excel range as several
// elements (F3:F67 as F10:F67 + F3:F67), and which cells a rule covers is kept cell by cell in its
// model. Catches any rule ExcelJS drops (the x14 ones) or rewrites (10+$B$1 -> 10, 1E3 -> 1).
function sameValidations(before, after) {
  const keys = (list) => [...new Set((list || []).map((v) => JSON.stringify([v.type, v.f1, v.f2])))].sort();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!sameData(keys(before.get(name)), keys(after.get(name)))) return false;
  }
  return true;
}

// texts -> how many times each occurs
const tally = (items) => items.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
// Does `after` hold every item of `before`, as often (multisets)?
function keepsAll(before, after) {
  const have = tally(after);
  for (const [x, n] of tally(before)) if ((have.get(x) || 0) < n) return false;
  return true;
}

// Each table part as text, sorted: its name, ref, header and totals row counts (as Excel reads them: no
// headerRowCount means 1, no totalsRowCount means 0) and its column names. ExcelJS rewrites table parts
// from its own model, so a difference here is a table Excel would repair or read differently.
const TABLE_COLUMN = /<(?:[A-Za-z_][\w.-]*:)?tableColumn(?=[\s/>])[^>]*>/g;
async function tableShapes(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  for (const entry of zip.file(TABLE_PART)) {
    const xml = await entry.async('string');
    const tag = TABLE_TAG.exec(xml);
    if (!tag) { out.push('unreadable table part'); continue; }
    const count = (name, dflt) => { const v = attrOf(tag[0], name); return v === null ? dflt : Number(v); };
    out.push(JSON.stringify([attrOf(tag[0], 'name'), attrOf(tag[0], 'ref'), count('headerRowCount', 1), count('totalsRowCount', 0),
      (xml.match(TABLE_COLUMN) || []).map((col) => attrOf(col, 'name'))]));
  }
  return out.sort();
}

// Hyperlinks to a place inside the workbook (<hyperlink location="Sheet2!A1">, a cell or a name) per sheet, as
// [sheet, ref, location] texts. ExcelJS reads only the links that have a relationship (web and file links),
// so these go on a save.
const HYPERLINK = /<(?:[A-Za-z_][\w.-]*:)?hyperlink(?=[\s/>])[^>]*>/g;
async function locationLinks(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  for (const [name, part] of await sheetParts(zip)) {
    for (const tag of (await zipText(zip, part)).match(HYPERLINK) || []) {
      const location = attrOf(tag, 'location');
      if (location !== null) out.push(JSON.stringify([name, attrOf(tag, 'ref'), location]));
    }
  }
  return out;
}

// Excel's extensions (<ext uri="{…}"> in an <extLst>: sparklines, x14 colour rules, slicer lists, table alt
// text...) as 'part uri' texts, a worksheet named by its sheet name (ExcelJS renumbers the parts) and any other
// part by its name with the digits normalised. A save keeps only those ExcelJS writes itself.
const EXT_TAG = /<(?:[A-Za-z_][\w.-]*:)?ext(?=[\s/>])[^>]*?\suri\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// Left out on purpose:
//   {CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}  x14 data validations: judged rule by rule above ("validation rules")
//   {140A7094-0E35-4892-8432-C4D2E57EDEB5}  x15:workbookPr chartTrackingRefBase, a chart-formatting default
//   {B58B0392-4F1F-4190-BB64-5DF3571DCE5F}  xcalcf:calcFeatures, the calc features Excel last saved with
// The last two sit in xl/workbook.xml of most files Excel saves, carry no content, and Excel writes them again
// on its next save; refusing them would make nearly every workbook view-only.
const EXT_IGNORED = new Set([
  '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}', '{140A7094-0E35-4892-8432-C4D2E57EDEB5}', '{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}',
]);
async function extensionUris(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sheetOf = new Map([...await sheetParts(zip)].map(([name, part]) => [part, name]));
  const out = [];
  for (const entry of zip.file(/\.xml$/)) {
    const key = sheetOf.has(entry.name) ? `sheet ${JSON.stringify(sheetOf.get(entry.name))}` : entry.name.replace(/\d+/g, 'N');
    for (const m of (await entry.async('string')).matchAll(EXT_TAG)) {
      const uri = (m[1] !== undefined ? m[1] : m[2]).trim().toUpperCase();
      if (!EXT_IGNORED.has(uri)) out.push(`${key} ${uri}`);
    }
  }
  return out;
}

// ---- Defined names a save carries over ------------------------------------------------------

// ExcelJS keeps a defined name only as a list of plain ranges: a dynamic name (OFFSET(...)) comes back as a
// broken reference, a constant (=0.2) or a whole-column name is dropped, and every name loses its scope and
// flags (localSheetId, hidden, comment), so two sheets' hidden _xlnm._FilterDatabase names merge into one.
// A save therefore puts the source's own <definedNames> into ExcelJS's workbook.xml: each <definedName> with
// its attributes as they were, and its formula moved through the save's row operations on the sheet it
// names (rebaseFormula's definedName mode: every row follows its target, `$` or not, whole rows included;
// a print area drops an area a delete removes). A name that names no shifted sheet keeps its bytes. With no
// <definedNames> in the source, ExcelJS's own (print areas, print titles) stay.
const DEFINED_NAMES = /<((?:[A-Za-z_][\w.-]*:)?)definedNames(?=[\s/>])[^>]*?(?:\/>|>[\s\S]*?<\/\1definedNames\s*>)/;
const DEFINED_NAME = /<((?:[A-Za-z_][\w.-]*:)?)definedName(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1definedName\s*>)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// one <definedName> as plain data: its attributes (decoded, sorted) and its formula text (null for <definedName/>)
const attrsOf = (attrs) => Object.fromEntries([...attrs.matchAll(ATTR)].map((m) => [m[1], decodeXml(m[2] !== undefined ? m[2] : m[3])]).sort(byKey));
const namesIn = (element) => [...element.matchAll(DEFINED_NAME)].map((m) => [attrsOf(m[2]), m[3] === undefined ? null : xmlText(m[3])]);

// A print area or print titles name is a list of areas ('S'!$A$1:$C$9,'S'!$E$4:$F$5). An area a delete takes
// away is left out, as the sheet's own page setup does; one with no area left goes altogether ('').
const PRINT_NAMES = new Set(['_xlnm.print_area', '_xlnm.print_titles']);
function withoutDeletedAreas(text) {
  const areas = text.match(/(?:'(?:[^']|'')*'|[^,'])+/g) || [];
  return areas.filter((area) => area.trim() !== '#REF!').join(',');
}

function rebasedName(name, text, shifts) {
  let out = text;
  for (const s of shifts) {
    if (namesSheet(out, s.sheet)) out = rebaseFormula(out, { sheet: s.sheet, at: s.at, delta: s.delta, anchorShift: 0, definedName: true });
  }
  return out !== text && PRINT_NAMES.has(String(name).toLowerCase()) ? withoutDeletedAreas(out) : out;
}

// The <definedNames> element to write (a prefixed one loses its prefix: ExcelJS writes the main namespace
// as the default) and the names it must come back with, or null when the source has none.
function carriedNames(srcXml, shifts) {
  const found = DEFINED_NAMES.exec(srcXml);
  if (!found || !namesIn(found[0]).length) return null;
  const expected = [];
  let element = found[0].replace(DEFINED_NAME, (raw, prefix, attrs, inner) => {
    const text = inner === undefined ? null : xmlText(inner);
    const now = text === null ? null : rebasedName(attrsOf(attrs).name, text, shifts);
    if (now === '') return '';                                 // a print area whose every area was deleted
    expected.push([attrsOf(attrs), now]);
    return now === text ? raw : `<${prefix}definedName${attrs}>${escapeXml(now)}</${prefix}definedName>`;
  });
  const prefix = found[1];
  if (prefix) element = element.split(`<${prefix}definedName`).join('<definedName').split(`</${prefix}definedName`).join('</definedName');
  return { element, expected };
}

// `outXml` with `element` in place of its <definedNames>, or right after </sheets> (where the schema wants
// it: ExcelJS writes nothing between the two); null if neither is there.
function withDefinedNames(outXml, element) {
  const at = DEFINED_NAMES.exec(outXml);
  if (at) return outXml.slice(0, at.index) + element + outXml.slice(at.index + at[0].length);
  const sheets = /<\/(?:[A-Za-z_][\w.-]*:)?sheets\s*>/.exec(outXml);
  if (!sheets) return null;
  const end = sheets.index + sheets[0].length;
  return outXml.slice(0, end) + element + outXml.slice(end);
}

// { out, expected }: ExcelJS's output `outBuf` with the source's defined names carried over, moved through
// `shifts` ([{ sheet: name, at, delta }], in the order they were applied; none for a dry run), and the names
// the output must hold (null: the source has none, nothing to check). See definedNamesKept.
async function carryOverDefinedNames(srcBuf, outBuf, shifts = []) {
  const names = carriedNames(await zipText(await JSZip.loadAsync(srcBuf), 'xl/workbook.xml'), shifts);
  if (!names) return { out: outBuf, expected: null };
  const zip = await JSZip.loadAsync(outBuf);
  const xml = withDefinedNames(await zipText(zip, 'xl/workbook.xml'), names.element);
  if (xml === null) return { out: outBuf, expected: names.expected };       // definedNamesKept says so
  zip.file('xl/workbook.xml', xml);
  return { out: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), expected: names.expected };
}

// Does the output hold exactly the names carryOverDefinedNames meant it to (same attributes, same formulas,
// same order)?
async function definedNamesKept(outBuf, expected) {
  if (expected === null) return true;
  const found = DEFINED_NAMES.exec(await zipText(await JSZip.loadAsync(outBuf), 'xl/workbook.xml'));
  return sameData(found ? namesIn(found[0]) : [], expected);
}

// { editable, lost, reason }. `lost` names what a save would lose, each once: parts (in part-name
// order), shapes or pictures, page breaks, notes, hidden or grouped rows, merged cells, column widths,
// dropdowns that depend on other cells, validation rules that refer to other cells, validation rules,
// named ranges, links to other places in the workbook, Excel extensions such as sparklines, Excel tables.
// A workbook that can't even be written and read back counts as lossy.
//
// The dry run writes a fresh copy loaded from `srcBuf`, never `wb`: ExcelJS's writer edits the workbook
// it writes (it stamps dxfId and a ref on every conditional-format rule, and numbers rules that have no
// priority). `wb` is only read, as "what the person sees", and compared with what the save would give.
async function checkEditable(srcBuf, wb) {
  const lost = [];
  const add = (label) => { if (!lost.includes(label)) lost.push(label); };
  try {
    const copy = await loadWorkbook(srcBuf);
    // what a save writes: validations regrouped (prepareForWrite), ExcelJS's output with the parts and the
    // defined names it doesn't write put back; what is still missing is lost
    prepareForWrite(copy);
    const names = await carryOverDefinedNames(srcBuf, await carryOverPackageParts(srcBuf, await copy.xlsx.writeBuffer()));
    const out = names.out;
    for (const label of await packageLosses(srcBuf, out)) add(label);
    if ((await noteCount(out)) < (await noteCount(srcBuf))) add(NOTES);
    const [rowsWere, rowsNow] = [await rowStates(srcBuf), await rowStates(out)];
    if (rowsNow.hidden < rowsWere.hidden || rowsNow.grouped < rowsWere.grouped) add(ROW_STATES);

    const back = new ExcelJS.Workbook();
    await back.xlsx.load(out);
    const sheets = Math.min(wb.worksheets.length, back.worksheets.length);
    let merges = false;
    let widths = false;
    for (let i = 0; i < sheets; i++) {
      const was = wb.worksheets[i];
      const now = back.worksheets[i];
      if (!sameData(mergeRanges(was), mergeRanges(now))) merges = true;
      if (!sameData(widthMap(was), widthMap(now))) widths = true;
    }
    if (merges) add('merged cells');
    if (widths) add('column widths');
    const rules = await rawValidations(srcBuf);
    for (const label of validationLosses(rules, wb.worksheets.map((ws) => ws.name))) add(label);
    if (!sameValidations(rules, await rawValidations(out))) add(VALIDATIONS);
    if (!(await definedNamesKept(out, names.expected))) add(NAMED_RANGES);
    if (!keepsAll(await locationLinks(srcBuf), await locationLinks(out))) add(LINKS);
    if (!keepsAll(await extensionUris(srcBuf), await extensionUris(out))) add(EXTENSIONS);
    if (!sameData(await tableShapes(srcBuf), await tableShapes(out))) add(TABLES);
  } catch {
    add(LOST_UNKNOWN);
  }
  const editable = lost.length === 0;
  return { editable, lost, reason: editable ? null : `Saving here would lose ${sayList(lost)} — edit it in Excel` };
}

// ---- cellSignature -------------------------------------------------------------

// What a save must not change, as plain JSON-safe data (an array with one entry per worksheet, hidden
// ones included). Two signatures are deepEqual, and stringify alike, exactly when nothing we track
// differs. It only reads:
// loaded cells that share a style share the style object, so nothing here may touch one.

// Object keys come out sorted, so equal data is equal as JSON text too (a loaded font can have its
// keys in another order than the file it was saved from).
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (_key, v) => (isObj(v) && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(byKey)) : v);
const jsonSafe = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v, sortKeys)));

// objects without their undefined / null / empty parts; an empty result is null (so `{}` and "no border" agree)
function prune(v) {
  if (Array.isArray(v)) return v.map((x) => { const p = prune(x); return p === undefined ? null : p; });
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined && p !== null) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}
const styleField = (v) => { const p = prune(jsonSafe(v)); return p === undefined ? null : p; };

// A cell whose style is the workbook default is written without one, and loads back with no font: the
// default font and "no font" are the same cell. `<u/>` and `<u val="single"/>` are one underline too.
const DEFAULT_FONT = JSON.stringify({ color: { theme: 1 }, family: 2, name: 'Calibri', scheme: 'minor', size: 11 });
function fontField(font) {
  const f = styleField(font);
  if (f && f.underline === 'single') f.underline = true;
  return f && JSON.stringify(f) === DEFAULT_FONT ? null : f;
}

// Validation flags that are false are the same as absent (ExcelJS writes only the true ones).
const DV_FLAGS = ['showErrorMessage', 'showInputMessage', 'allowBlank'];
function validationField(model) {
  const dv = styleField(model);
  for (const rule of Object.values(dv || {})) {
    for (const flag of DV_FLAGS) if (rule[flag] === false) delete rule[flag];
  }
  return dv;
}
const fillField = (fill) => { const f = styleField(fill); return f && f.type === 'pattern' && (!f.pattern || f.pattern === 'none') ? null : f; };

function plainValue(cell) {
  const v = cell.value;
  switch (cell.type) {
    case ValueType.Null: return null;
    case ValueType.Merge: return { mergedInto: cell.master ? cell.master.address : null };
    case ValueType.RichText: return v.richText.map((part) => part.text).join('');
    case ValueType.Hyperlink: return { text: jsonSafe(v.text), hyperlink: v.hyperlink };
    case ValueType.Formula: return { formula: cell.formula === undefined ? null : cell.formula, result: jsonSafe(cell.result) };
    default: return jsonSafe(v);
  }
}

// [value, numFmt, font, fill, border, alignment, protection], or null for a cell with nothing in it at all
function cellEntry(cell) {
  const numFmt = cell.numFmt === undefined || cell.numFmt === 'General' ? null : cell.numFmt;
  const entry = [plainValue(cell), numFmt, fontField(cell.font), fillField(cell.fill), styleField(cell.border),
    styleField(cell.alignment), styleField(cell.protection)];
  return cell.type !== ValueType.Merge && entry.every((x) => x === null) ? null : entry;
}

// ExcelJS's writer stamps `dxfId` (an index into the file's style table) and a copy of the entry's `ref`
// on each rule it writes; neither is content, and the style itself is on the rule.
function conditionalFormats(ws) {
  const entries = jsonSafe(ws.conditionalFormattings) || [];
  for (const entry of entries) {
    for (const rule of (entry && entry.rules) || []) { delete rule.dxfId; delete rule.ref; }
  }
  return entries;
}

function sheetSignature(ws) {
  const rows = {};
  const cells = {};
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.findRow(r);
    if (!row) continue;
    const height = typeof row.height === 'number' ? row.height : null;
    const hidden = !!row.hidden;
    const outlineLevel = row.outlineLevel || 0;
    if (height !== null || hidden || outlineLevel) rows[r] = { height, hidden, outlineLevel };
    for (let c = 1; c <= row.cellCount; c++) {
      const cell = row.findCell(c);
      const entry = cell && cellEntry(cell);
      if (entry) cells[cell.address] = entry;
    }
  }
  return {
    name: ws.name,
    state: ws.state || 'visible',
    merges: mergeRanges(ws),
    cols: columnList(ws),
    views: styleField(ws.views),
    autoFilter: styleField(ws.autoFilter),
    printArea: (ws.pageSetup && ws.pageSetup.printArea) || null,
    dv: validationField(ws.dataValidations && ws.dataValidations.model),
    cf: conditionalFormats(ws),
    rows,
    cells,
  };
}

const cellSignature = (wb) => wb.worksheets.map((ws) => jsonSafe(sheetSignature(ws)));

// ---- Ops: set, insert and delete rows --------------------------------------------------

// applyOps applies the grid's edits (Op in globals.md) to a freshly loaded workbook, in order, each in
// the coordinates the ops before it left behind. A bad op is a 400 whose message is for the person; the
// route throws the workbook away then, so a half-applied list never reaches a file.

const MAX_ROW = 1048575;                    // row 1048576, 0-based
const MAX_COL = 16383;                      // XFD
const MAX_OPS = 50000;
const MAX_ROWS_PER_OP = 1000;
const MAX_TEXT = 32767;                     // the most text a cell holds in Excel
const MAX_ROW_OPS = 200;                    // Ruling 20: each row op re-serialises the sheet model,
const MAX_ROWS_INSERTED = 5000;             // so one save may only do so much of it
const TOO_MANY_ROWS = 'Too many rows added or removed in one save — save more often';
const TOO_BIG = 'This sheet is too big to edit here — edit it in Excel';
const OP_NAMES = new Set(['set', 'insertRows', 'deleteRows']);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const inRange = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
const likeOf = (op) => (op.like === undefined ? null : op.like);       // JSON has no undefined: a missing like is none

// The checks that need nothing but the op: all of them run before anything is applied.
function checkOp(op, sheets) {
  if (!isObj(op) || !OP_NAMES.has(op.op)) throw badRequest("That isn't an edit VaultOS can save");
  const ws = Number.isInteger(op.sheet) ? sheets[op.sheet] : undefined;
  if (!ws || !isVisible(ws)) throw badRequest("That sheet isn't in this workbook");
  if (op.op === 'set') {
    if (!inRange(op.r, MAX_ROW) || !inRange(op.c, MAX_COL)) throw badRequest('That cell is outside the sheet');
    if (typeof op.v !== 'string') throw badRequest('A cell can only be set to text');
    if (op.v.length > MAX_TEXT) throw badRequest('A cell can hold at most 32,767 characters');
    return;
  }
  if (!Number.isInteger(op.n) || op.n < 1 || op.n > MAX_ROWS_PER_OP) throw badRequest('Rows can be inserted or deleted up to 1,000 at a time');
  if (!inRange(op.at, MAX_ROW) || op.at + op.n - 1 > MAX_ROW) throw badRequest('Those rows are outside the sheet');
  const like = likeOf(op);
  if (op.op === 'insertRows' && like !== null && !(inRange(like, MAX_ROW) && (like === op.at - 1 || like === op.at))) {
    throw badRequest('New rows can only copy the formatting of the row above them or below them');
  }
}

// Ruling 10: text equal to what the editor offered is no edit at all, so the cell isn't touched (an
// [h]:mm duration, a month-only date or rich text would otherwise be rewritten by an unchanged commit).
function setCell(ws, { r, c, v }) {
  const row = ws.findRow(r + 1);
  const found = row ? row.findCell(c + 1) : undefined;
  if (found && found.type === ValueType.Merge) {
    throw badRequest(`${found.address} is part of merged cells — edit ${found.master.address} instead`);
  }
  if (found && found.type === ValueType.Formula) throw badRequest(`${found.address} has a formula — edit formulas in Excel`);
  if (v === editText(found ? found.value : null, found ? found.numFmt : undefined)) return;
  const cell = found || ws.getCell(r + 1, c + 1);
  // the style object is left alone: loaded cells share them
  cell.value = coerceInput(v, { value: cell.value, numFmt: cell.numFmt });
}

function applyOps(wb, ops) {
  if (!Array.isArray(ops)) throw badRequest('The edits must come as a list');
  if (ops.length > MAX_OPS) throw badRequest('Too many edits to save at once (at most 50,000)');
  const sheets = wb.worksheets;
  for (const op of ops) checkOp(op, sheets);
  const rowOps = ops.filter((op) => op.op !== 'set');
  const inserted = rowOps.reduce((sum, op) => sum + (op.op === 'insertRows' ? op.n : 0), 0);
  if (rowOps.length > MAX_ROW_OPS || inserted > MAX_ROWS_INSERTED) throw badRequest(TOO_MANY_ROWS);

  // What toModel told the grid, from the workbook as loaded (no op adds a formula, a table, a picture or
  // a validation / conditional format on another sheet).
  const rc = rowOps.length ? rowOpsContext(wb) : { formulas: false, referenced: new Set() };
  const gates = new Map();
  for (const op of ops) {
    const ws = sheets[op.sheet];
    if (!gates.has(ws)) gates.set(ws, { readOnly: readOnlyReason(ws), tooBig: tooBigToDraw(ws), rowOps: rowOpsReason(ws, rc), locks: tableLocks(ws) });
  }

  for (const op of ops) {
    const ws = sheets[op.sheet];
    const gate = gates.get(ws);
    if (gate.readOnly) throw badRequest(gate.readOnly);
    if (gate.tooBig) throw badRequest(TOO_BIG);                     // Ruling 9
    if (op.op === 'set') {
      const lock = lockAt(gate.locks, op.r, op.c);                  // a table's header or totals row
      if (lock) throw badRequest(lock.msg);
      setCell(ws, op);
      continue;
    }
    if (gate.rowOps) throw badRequest(gate.rowOps);
    if (op.op === 'insertRows') shiftRows(ws, wb, op.at, op.n, likeOf(op));
    else shiftRows(ws, wb, op.at, -op.n);
    if (tooBigToDraw(ws)) throw badRequest(TOO_BIG);                // Ruling 20: inserts can grow it past the cap
  }
}

// ---- Row shifting, on the worksheet model -------------------------------------------------

// ExcelJS's spliceRows / insertRow leave merges, validations, conditional formats and print areas where
// they were. shiftRows instead rewrites ws.model, everything that is pinned to a row, and assigns it
// back. Three traps of that setter, all handled here: it reads `mergeCells` where the getter gives
// `merges`; it doesn't reset `_merges` (re-merging then throws); and it drops every merged non-master
// cell model, and with it that cell's own style (the right border of a merged band lives on its last
// cell), so those go in as plain empty cells with their style and are merged again by the setter.
//
// What moves: rows (height, hidden, outline level, row style) with their cells (values, styles, notes,
// links), merges (shrunk or grown, gone when nothing or one cell is left), data validations (keyed per
// cell; their formulas follow their targets; rows inserted inside a validated run of a column get it
// too), conditional formats (ranges shift; formulas re-anchor to the new top-left of the first range),
// the autoFilter, print areas and print-title rows, defined names, and the frozen line (Ruling 24). Not
// moved: the selection. A file with manual page breaks never gets here (ExcelJS doesn't read them, so
// checkEditable refuses it), and no row op runs on a sheet with formulas, tables or pictures, or one
// that another sheet's validation or conditional format points at, so none of those needs moving.
//
// `like` (insert only, the pre-shift row index) gives the new rows that row's height, row style, outline
// level, a deep copy of each styled cell's style, its list validations and its conditional-format
// coverage. Never its values, merges or hidden state.

const ADDRESS = /^([A-Z]{1,3})(\d+)$/;
const hasStyle = (style) => isObj(style) && Object.keys(style).length > 0;
const atRow = (address, number) => address.replace(/\d+$/, '') + number;

function movedRow(row, number) {
  const cells = row.cells.map((cell) => {
    const address = atRow(cell.address, number);
    if (cell.type !== ValueType.Merge) return { ...cell, address };
    const plain = { address, type: ValueType.Null, style: cell.style };
    if (cell.comment) plain.comment = cell.comment;
    return plain;
  });
  return { ...row, number, cells };
}

// A new row that has an outline level but no cells gets an explicit height (like's, else the sheet's
// default): ExcelJS writes no <row> for a row with neither, and the level would go (writeVerified would
// refuse the save).
function newRowLike(source, number, defaultHeight) {
  const cells = source.cells.filter((cell) => hasStyle(cell.style))
    .map((cell) => ({ address: atRow(cell.address, number), type: ValueType.Null, style: structuredClone(cell.style) }));
  const row = {
    number, cells, style: hasStyle(source.style) ? structuredClone(source.style) : {}, hidden: false, outlineLevel: source.outlineLevel || 0,
  };
  if (source.height) row.height = source.height;
  else if (row.outlineLevel > 0 && cells.length === 0) row.height = defaultHeight;
  return row;
}

function shiftedMerges(ranges, at, delta) {
  const out = [];
  for (const text of Array.isArray(ranges) ? ranges : []) {
    const rg = shiftRange(parseRange(text), at, delta);
    if (rg && (rg.r1 !== rg.r2 || rg.c1 !== rg.c2)) out.push(rangeStr(rg));
  }
  return out;
}

// ExcelJS keeps a validation per cell (one object shared by all the cells of an Excel range). Each object
// is rebased once and stays shared. anchorShift is 0: checkEditable refuses any workbook whose
// validation formulas have a relative row reference (Ruling 18), so what is left is literal lists and
// absolute ($row) references, which follow their target rows and never their anchor.
//
// An insert inside a validated run grows it, as Excel does (Ruling 19): a new cell gets its column's
// validation when the rows just above and just below the insertion point hold the same one. "The same"
// means the same object or an equal one, on purpose: ExcelJS writes one Excel range as overlapping
// sqrefs (F3:F15 as F10:F15 + F3:F15), so after a load and save a single run can be held by two
// distinct but equal objects, and requiring identity would leave a hole at the seam; equal neighbours
// are one rule to Excel and to ExcelJS's own writer (it groups by deep equality). `like` adds its list
// validations on top, which matters at the edges of a run.
function shiftedValidations(dvs, s) {
  const out = {};
  if (!isObj(dvs)) return out;
  const rebased = new Map();
  const moved = (dv) => {
    if (!rebased.has(dv)) rebased.set(dv, { ...dv, ...(Array.isArray(dv.formulae) ? { formulae: dv.formulae.map((f) => s.rebase(f, 0)) } : {}) });
    return rebased.get(dv);
  };
  for (const [key, dv] of Object.entries(dvs)) {
    if (!isObj(dv)) continue;
    const a = ADDRESS.exec(key);
    if (!a) {                                                 // a range as the key: only code makes those
      const ref = shiftRefList(key, s.at, s.delta);
      if (ref) out[ref] = moved(dv);
      continue;
    }
    const r = Number(a[2]) - 1;
    const to = s.moveRow(r);
    if (to !== null) out[a[1] + (to + 1)] = moved(dv);
    if (s.delta > 0 && r === s.at - 1) {
      const below = dvs[a[1] + (s.at + 1)];
      if (isObj(below) && (below === dv || sameData(below, dv))) for (let i = 0; i < s.n; i++) out[a[1] + (s.at + i + 1)] = moved(dv);
    }
  }
  if (s.like !== null) {
    for (const [key, dv] of Object.entries(dvs)) {
      const a = ADDRESS.exec(key);
      if (a && Number(a[2]) - 1 === s.like && isObj(dv) && dv.type === 'list') for (let i = 0; i < s.n; i++) out[a[1] + (s.at + i + 1)] = moved(dv);
    }
  }
  return out;
}

// 'F3:F15 H2' -> rectangles, whole columns and whole rows as what they cover (unlike the model's
// parseSqref, nothing is clamped to the used area: these rewrite the file).
function sqrefRects(ref) {
  return String(ref).trim().split(/\s+/).filter(Boolean).map((token) => {
    let m;
    if ((m = WHOLE_COL.exec(token))) {
      const a = colIndex(m[1]);
      const b = colIndex(m[2]);
      return { r1: 0, c1: Math.min(a, b), r2: MAX_ROW, c2: Math.max(a, b) };
    }
    if ((m = WHOLE_ROW.exec(token))) {
      const a = Number(m[1]) - 1;
      const b = Number(m[2]) - 1;
      return { r1: Math.min(a, b), c1: 0, r2: Math.max(a, b), c2: MAX_COL };
    }
    return parseRange(token);
  });
}

// The shifted list `ref`, plus ranges for the new rows' cells in the columns where the old list covered
// row `like`, leaving out what `ref` already covers. A shifted range holds all of the new rows or none
// of them (it grew across the insertion point or it didn't), so checking row `at` is enough.
function withLikeCoverage(ref, oldRef, s) {
  const mark = new Uint8Array(MAX_COL + 1);
  for (const g of sqrefRects(oldRef)) if (g.r1 <= s.like && s.like <= g.r2) mark.fill(1, g.c1, g.c2 + 1);
  for (const g of sqrefRects(ref)) if (g.r1 <= s.at && s.at <= g.r2) mark.fill(0, g.c1, g.c2 + 1);
  const add = [];
  for (let c = 0; c <= MAX_COL; c++) {
    if (!mark[c]) continue;
    let end = c;
    while (end < MAX_COL && mark[end + 1]) end++;
    add.push(rangeStr({ r1: s.at, c1: c, r2: s.at + s.n - 1, c2: end }));
    c = end;
  }
  return add.length ? `${ref} ${add.join(' ')}` : ref;
}

function rebasedRule(rule, anchorShift, s) {
  if (!isObj(rule)) return rule;
  const out = { ...rule };
  if (Array.isArray(rule.formulae)) out.formulae = rule.formulae.map((f) => s.rebase(f, anchorShift));
  if (Array.isArray(rule.cfvo)) {
    out.cfvo = rule.cfvo.map((v) => (isObj(v) && v.type === 'formula' ? { ...v, value: s.rebase(v.value, anchorShift) } : v));
  }
  return out;
}

// A rule's formula is written for the top-left cell of the entry's first range, so when that cell moves
// (or a delete takes the first range away) relative references move by as much (anchorShift).
function shiftedFormats(entries, s) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObj(entry) || typeof entry.ref !== 'string') { out.push(entry); continue; }
    let ref = shiftRefList(entry.ref, s.at, s.delta);
    if (!ref) continue;
    if (s.like !== null) ref = withLikeCoverage(ref, entry.ref, s);
    const anchorShift = sqrefRects(ref)[0].r1 - sqrefRects(entry.ref)[0].r1;
    const rules = Array.isArray(entry.rules) ? entry.rules.map((rule) => rebasedRule(rule, anchorShift, s)) : entry.rules;
    out.push({ ...entry, ref, rules });
  }
  return out;
}

// A loaded autoFilter is 'A1:G1'; one made in code may be { from, to } with 'A1' or { row, column } ends.
function shiftedAutoFilter(af, s) {
  let ref = null;
  if (typeof af === 'string') ref = af;
  else if (isObj(af)) {
    const end = (x) => (typeof x === 'string' ? x
      : isObj(x) && Number.isInteger(x.row) && Number.isInteger(x.column) ? colName(x.column - 1) + x.row : null);
    const from = end(af.from);
    const to = end(af.to);
    if (from && to) ref = `${from}:${to}`;
  }
  if (ref === null) return af;
  return shiftRefList(ref, s.at, s.delta) || undefined;
}

// printArea is 'A1:G20', several joined with '&&'; printTitlesRow is '1:2'.
function shiftedPageSetup(ps, s) {
  if (!isObj(ps)) return ps;
  const out = { ...ps };
  if (typeof ps.printArea === 'string' && ps.printArea) {
    const areas = ps.printArea.split('&&').map((a) => shiftRefList(a, s.at, s.delta)).filter(Boolean);
    if (areas.length) out.printArea = areas.join('&&');
    else delete out.printArea;
  }
  if (typeof ps.printTitlesRow === 'string' && ps.printTitlesRow) {
    const rows = shiftRefList(ps.printTitlesRow, s.at, s.delta);
    if (rows) out.printTitlesRow = rows;
    else delete out.printTitlesRow;
  }
  return out;
}

// Ruling 24: the frozen line follows the rows. With F frozen rows (ySplit), an insert above it adds the
// new rows to the frozen part, and a delete takes away the frozen rows it covers (none left and no frozen
// columns: no frozen pane). The pane's first scrolling row (topLeftCell) moves with the line.
function shiftedViews(views, s) {
  if (!Array.isArray(views)) return views;
  return views.map((view) => {
    if (!isObj(view) || view.state !== 'frozen' || !(view.ySplit > 0)) return view;
    const frozen = view.ySplit;
    const covered = s.delta > 0 ? (s.at < frozen ? s.n : 0) : Math.max(0, Math.min(s.at + s.n, frozen) - s.at);
    if (covered === 0) return view;
    const ySplit = s.delta > 0 ? frozen + s.n : frozen - covered;
    if (ySplit === 0 && !(view.xSplit > 0)) {
      const normal = { ...view, state: 'normal' };
      for (const key of ['xSplit', 'ySplit', 'topLeftCell']) delete normal[key];
      return normal;
    }
    const out = { ...view, ySplit };
    const top = typeof view.topLeftCell === 'string' ? ADDRESS.exec(view.topLeftCell.replace(/\$/g, '').toUpperCase()) : null;
    if (top) {
      const r = Number(top[2]) - 1;
      const moved = s.delta > 0 ? (r >= s.at ? r + s.n : r) : r >= s.at + s.n ? r - s.n : r >= s.at ? s.at : r;
      out.topLeftCell = top[1] + (Math.max(moved, ySplit) + 1);
    }
    return out;
  });
}

// Defined names live in one cell matrix per name, keyed by sheet name. ExcelJS's spliceRows moves and
// deletes their cells but leaves a gap where rows go into the middle of a named range; Excel grows the
// range instead (as shiftRange does), so the gap is filled where the rows above and below are both named.
function shiftNames(wb, name, s) {
  const names = wb.definedNames;
  if (!names || !isObj(names.matrixMap)) return;
  const mine = name.toLowerCase();
  const keys = new Set();
  for (const matrix of Object.values(names.matrixMap)) {
    for (const key of Object.keys((matrix && matrix.sheets) || {})) if (key.toLowerCase() === mine) keys.add(key);
  }
  for (const key of keys) {
    names.spliceRows(key, s.at + 1, s.delta < 0 ? s.n : 0, s.delta > 0 ? s.n : 0);
    if (s.delta < 0) continue;
    for (const matrix of Object.values(names.matrixMap)) {
      const rows = matrix && matrix.sheets && matrix.sheets[key];
      const above = rows && rows[s.at];                       // 1-based: the row just above the new ones
      const below = rows && rows[s.at + s.n + 1];             // and the one just below them
      if (!above || !below) continue;
      above.forEach((cell, col) => {
        if (cell && below[col]) for (let r = s.at + 1; r <= s.at + s.n; r++) matrix.getCellAt(key, r, col);
      });
    }
  }
}

function shiftRows(ws, wb, at, delta, like = null) {
  if (!inRange(at, MAX_ROW) || !Number.isInteger(delta) || delta === 0) throw new Error('shiftRows: bad arguments');
  const n = Math.abs(delta);
  const inserting = delta > 0;
  const s = {
    at, delta, n,
    like: inserting && Number.isInteger(like) ? like : null,
    // where 0-based row r goes: null when a delete takes it, or an insert pushes it past the last row
    moveRow: (r) => {
      if (inserting) return r < at ? r : r + n > MAX_ROW ? null : r + n;
      return r < at ? r : r < at + n ? null : r - n;
    },
    rebase: (formula, anchorShift) => (typeof formula === 'string' ? rebaseFormula(formula, { sheet: ws.name, at, delta, anchorShift }) : formula),
  };

  const m = ws.model;
  // The getter leaves out a row with no cells and no height, even a hidden or grouped one; keep those so a
  // shift doesn't lose their state (ExcelJS's writer still skips them if they are empty when it writes).
  const listed = new Set(m.rows.map((row) => row.number));
  for (let i = 1; i <= ws.rowCount; i++) {
    const row = listed.has(i) ? null : ws.findRow(i);
    if (row && (row.hidden || row.outlineLevel)) {
      m.rows.push({ number: i, cells: [], hidden: row.hidden, outlineLevel: row.outlineLevel, style: row.style });
    }
  }
  if (inserting && m.rows.some((row) => row.number - 1 >= at && row.number - 1 + n > MAX_ROW)) {
    throw badRequest("There's no room for new rows: they would push rows off the end of the sheet");
  }
  const rows = [];
  for (const row of m.rows) {
    const to = s.moveRow(row.number - 1);
    if (to !== null) rows.push(movedRow(row, to + 1));
  }
  const source = s.like === null ? null : m.rows.find((row) => row.number === s.like + 1);
  const defaultHeight = finitePositive(ws.properties && ws.properties.defaultRowHeight) || DEFAULT_ROW_PT;
  if (source) for (let i = 0; i < n; i++) rows.push(newRowLike(source, at + i + 1, defaultHeight));
  m.rows = rows.sort((a, b) => a.number - b.number);

  m.mergeCells = shiftedMerges(m.merges, at, delta);
  m.dataValidations = shiftedValidations(m.dataValidations, s);
  m.conditionalFormattings = shiftedFormats(m.conditionalFormattings, s);
  m.autoFilter = shiftedAutoFilter(m.autoFilter, s);
  m.pageSetup = shiftedPageSetup(m.pageSetup, s);
  m.views = shiftedViews(m.views, s);

  ws._merges = {};
  ws.model = m;
  shiftNames(wb, ws.name, s);
  if (!ROW_SHIFTS.has(wb)) ROW_SHIFTS.set(wb, []);
  ROW_SHIFTS.get(wb).push({ sheet: ws.name, at, delta });
}

// Every shift applied to a workbook since it was loaded, in order: writeVerified moves the source's defined
// names through them (ExcelJS's own copy of the names is not what gets written; see carryOverDefinedNames).
const ROW_SHIFTS = new WeakMap();

// ---- Validation ranges for the writer (Ruling 27) ------------------------------------------

// ExcelJS keeps a validation per cell, and its writer groups the cells into ranges again. But it walks
// them with their addresses sorted as text (F10 before F3) and grows each group without checking which
// cells are already taken, so one Excel range comes out as overlapping ranges (F10:F15 and F3:F15). Excel
// may treat overlapping validations as damage and offer to repair the file. The writer does copy a key
// that is already a range ('F3:F15') straight into the file, so prepareForWrite does the grouping itself:
// cells in number order (row, then column); each rectangle grows down, then right, over cells not yet
// taken that hold an equal validation (deep equality, as in shiftedValidations: the same rule whichever
// object holds it). A one-cell rectangle keeps its plain address as the key; it has no equal free
// neighbour, so the writer's own grouping leaves it alone too (except that ExcelJS's isEqual calls any
// two Dates equal: two touching date rules with different bounds would still be merged, which
// checkEditable's raw comparison of the rules refuses).
//
// From this call until the returned restore() runs, the model is keyed by ranges: find(address) doesn't
// answer for a cell inside one, so nothing but the writer should read it then.
const MAX_REGROUP_CELLS = 2000000;   // a range key larger than this (only code makes those) is left as it is

function rangeKeyed(model) {
  const out = {};
  const cells = new Map();                                    // 'r,c' -> validation
  for (const [address, dv] of Object.entries(model)) {
    if (!isObj(dv)) continue;
    let rg = null;
    try { rg = parseRange(address); } catch { /* not a cell or a range: passed through below */ }
    if (!rg || (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) > MAX_REGROUP_CELLS) { out[address] = dv; continue; }
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) cells.set(r + ',' + c, dv);
  }
  const canon = new Map();
  const ruleKey = (dv) => {
    if (!canon.has(dv)) canon.set(dv, JSON.stringify(dv, sortKeys));
    return canon.get(dv);
  };
  const taken = new Set();
  const free = (r, c, key) => {
    const id = r + ',' + c;
    const dv = cells.get(id);
    return dv !== undefined && !taken.has(id) && ruleKey(dv) === key;
  };
  const order = [...cells.keys()].map((id) => id.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [r, c] of order) {
    if (taken.has(r + ',' + c)) continue;
    const dv = cells.get(r + ',' + c);
    const key = ruleKey(dv);
    let h = 1;
    while (r + h <= MAX_ROW && free(r + h, c, key)) h++;
    let w = 1;
    for (; c + w <= MAX_COL; w++) {
      let whole = true;
      for (let i = 0; i < h && whole; i++) whole = free(r + i, c + w, key);
      if (!whole) break;
    }
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) taken.add((r + i) + ',' + (c + j));
    out[rangeStr({ r1: r, c1: c, r2: r + h - 1, c2: c + w - 1 })] = dv;
  }
  return out;
}

function prepareForWrite(wb) {
  const saved = [];
  for (const ws of wb.worksheets) {
    const dvs = ws.dataValidations;
    if (!dvs || !isObj(dvs.model)) continue;
    saved.push([dvs, dvs.model]);
    dvs.model = rangeKeyed(dvs.model);
  }
  return () => { for (const [dvs, model] of saved) dvs.model = model; };
}

// ---- Verified write -----------------------------------------------------------------------

// Cells carrying a note, across the workbook: what the writer will put in xl/commentsN.xml (it writes one
// <comment> per cell model with a note).
function notesInMemory(wb) {
  let total = 0;
  for (const ws of wb.worksheets) {
    for (const row of ws.model.rows) for (const cell of row.cells) if (cell.comment) total++;
  }
  return total;
}

// What ExcelJS has been seen to drop and the person would miss: the sheets themselves (names, count,
// order), each sheet's merged ranges and its column widths.
const layoutOf = (wb) => ({
  sheets: wb.worksheets.map((ws) => ws.name),
  merges: wb.worksheets.map(mergeRanges),
  widths: wb.worksheets.map(widthMap),
});

// The bytes to save for `wb` (loaded from `srcBuf`, ops applied): ExcelJS's output with the parts it
// doesn't write carried over (custom properties, sensitivity labels), and the source's defined names moved
// through the row operations applied to `wb` (carryOverDefinedNames), then checked: no zip part, drawing
// anchor or page break the source had is missing; the output holds exactly as many notes, and hidden and
// grouped rows, as the edited workbook (those can go with a deleted row, so the source's counts are not the
// measure; a row ExcelJS doesn't write is refused, never lost); the defined names and the tables are the
// ones meant; and it reads back with the sheets, merges and widths the edited workbook has. Anything else
// is a 422 and nothing is saved.
// The workbook is measured first because writing edits it (dxfId and a ref on every conditional-format
// rule). Validations are written as non-overlapping ranges (prepareForWrite); the per-cell model is put
// back afterwards, so `wb` can still be read (toModel) once this returns.
async function writeVerified(wb, srcBuf) {
  const before = layoutOf(wb);
  const notes = notesInMemory(wb);
  const rows = rowStatesInMemory(wb);
  if (hasFormulas(wb)) wb.calcProperties = Object.assign(wb.calcProperties || {}, { fullCalcOnLoad: true });
  const restore = prepareForWrite(wb);                         // validations as non-overlapping ranges
  let written;
  try {
    written = await wb.xlsx.writeBuffer();
  } finally {
    restore();                                                 // the workbook means what it meant
  }
  const names = await carryOverDefinedNames(srcBuf, await carryOverPackageParts(srcBuf, written), ROW_SHIFTS.get(wb) || []);
  const out = names.out;

  const lost = [];
  const add = (label) => { if (!lost.includes(label)) lost.push(label); };
  try {
    for (const label of await packageLosses(srcBuf, out)) add(label);
    if ((await noteCount(out)) !== notes) add(NOTES);
    if (!sameData(await rowStates(out), rows)) add(ROW_STATES);
    if (!(await definedNamesKept(out, names.expected))) add(NAMED_RANGES);
    if (!sameData(await tableShapes(srcBuf), await tableShapes(out))) add(TABLES);   // no op may change a table
    const after = layoutOf(await loadWorkbook(out));
    if (!sameData(before.sheets, after.sheets)) add('sheets');
    const shared = Math.min(before.sheets.length, after.sheets.length);
    for (let i = 0; i < shared; i++) {
      if (!sameData(before.merges[i], after.merges[i])) add('merged cells');
      if (!sameData(before.widths[i], after.widths[i])) add('column widths');
    }
  } catch {
    add(LOST_UNKNOWN);
  }
  if (lost.length) throw Object.assign(new Error(`Saving would have lost ${sayList(lost)} — nothing was changed`), { status: 422 });
  return out;
}

module.exports = {
  loadWorkbook, toModel, anyDrawable, partCounts, drawingAnchors, partLosses, packageLosses, carryOverPackageParts, carryOverDefinedNames,
  definedNamesKept, checkEditable, cellSignature, applyOps, shiftRows, writeVerified, prepareForWrite,
};
