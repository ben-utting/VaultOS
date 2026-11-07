'use strict';

// ========================================================================
// CSV for the spreadsheet viewer: decode, parse, build the sheet model, apply
// edit ops, and serialise again. Byte-preserving: a record nobody touched is
// written back as the exact text it was read from (`raw` + its own line
// ending), so saving an edit changes only the records that were edited.
// ========================================================================

const NOT_UTF8 = "This CSV isn't UTF-8, so it's view-only here";

const CANDIDATES = [',', ';', '\t', '|'];  // order is the tie-break: ',' first
const SNIFF_RECORDS = 20;                  // records read per candidate when guessing the delimiter
const SHEET_CELL_CAP = 60000;              // grid renders a sheet only up to this many cells
const MAX_ROW = 1048575;                   // Excel's grid limits, as sanity caps on op coordinates
const MAX_COL = 16383;
const MAX_BAND = 1000;                     // rows per insertRows / deleteRows op
const GROW_CELL_CAP = 1000000;             // an op may not grow the file past this many cells (the grid shows 60000)

function badOp(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function isUtf8(encoding) {
  return encoding === 'utf-8' || encoding === 'utf-8-bom';
}

// ---- Decode ---------------------------------------------------------------

function decodeLatin1(buf) {
  // WHATWG "latin1" is windows-1252, which is what Excel's "ANSI" CSVs really are.
  try { return new TextDecoder('latin1').decode(buf); } catch { return buf.toString('latin1'); }
}

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { encoding: 'utf-16le', text: buf.toString('utf16le', 2) };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return { encoding: 'utf-16be', text: swapped.swap16().toString('utf16le') };
  }
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  try {
    // ignoreBOM: the decoder must not eat a BOM itself; the one we detect is stripped here
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf);
    return { encoding: bom ? 'utf-8-bom' : 'utf-8', text };
  } catch {
    return { encoding: 'latin1', text: decodeLatin1(buf) };
  }
}

// ---- Parse ----------------------------------------------------------------

// RFC 4180: a field that starts with a quote runs to the closing quote (`""` is a literal
// quote); a quote anywhere else in a field is literal. A record ends at \r\n, \n or \r.
// `raw` is the record's text without its line ending; `eol` is that ending ('' on a last
// record with none). Reads at most `limit` records.
function parseRecords(text, delim, limit) {
  const plain = new RegExp('[^' + delim + '\\r\\n]*', 'y');
  const records = [];
  const n = text.length;
  let i = 0;
  while (i < n && records.length < limit) {
    const start = i;
    const fields = [];
    let eol = '';
    for (;;) {
      let v = '';
      let q = false;
      if (text.charCodeAt(i) === 34) {
        q = true;
        i++;
        for (;;) {
          const j = text.indexOf('"', i);
          if (j === -1) { v += text.slice(i); i = n; break; }  // unterminated: runs to the end
          v += text.slice(i, j);
          if (text.charCodeAt(j + 1) === 34) { v += '"'; i = j + 2; } else { i = j + 1; break; }
        }
      }
      plain.lastIndex = i;
      const rest = plain.exec(text)[0];  // stray text after a closing quote, or the whole plain field
      v += rest;
      i += rest.length;
      fields.push({ v, q });
      if (i >= n) break;
      if (text[i] === delim) { i++; continue; }
      if (text[i] === '\r' && text[i + 1] === '\n') { eol = '\r\n'; i += 2; } else { eol = text[i]; i++; }
      break;
    }
    records.push({ fields, raw: text.slice(start, i - eol.length), eol });
  }
  return records;
}

// The candidate whose first few records most often share one field count above 1.
// Ties (and "none do") go to the earliest candidate, so ','.
function detectDelimiter(text) {
  let best = ',';
  let bestScore = 0;
  for (const cand of CANDIDATES) {
    if (!text.includes(cand)) continue;
    const seen = new Map();
    let score = 0;
    for (const rec of parseRecords(text, cand, SNIFF_RECORDS)) {
      const k = rec.fields.length;
      if (k < 2) continue;
      const count = (seen.get(k) || 0) + 1;
      seen.set(k, count);
      if (count > score) score = count;
    }
    if (score > bestScore) { best = cand; bestScore = score; }
  }
  return best;
}

function dominantEol(records) {
  const counts = { '\n': 0, '\r\n': 0, '\r': 0 };
  for (const rec of records) if (rec.eol) counts[rec.eol]++;
  let best = '\n';
  for (const e of ['\r\n', '\r']) if (counts[e] > counts[best]) best = e;
  return best;
}

function allQuoted(records) {
  if (!records.length) return false;
  for (const rec of records) for (const f of rec.fields) if (!f.q) return false;
  return true;
}

function parseCsv(buf) {
  const { encoding, text } = decode(buf);
  const delimiter = detectDelimiter(text);
  const records = parseRecords(text, delimiter, Infinity);
  return {
    encoding,
    delimiter,
    eolDominant: dominantEol(records),
    endsWithEol: records.length > 0 && records[records.length - 1].eol !== '',
    quoteAll: allQuoted(records),
    records,
  };
}

function csvEditable(parsed) {
  return isUtf8(parsed.encoding) ? null : NOT_UTF8;
}

// ---- Sheet model ----------------------------------------------------------

function csvToSheet(parsed, name) {
  const { records } = parsed;
  const rowCount = records.length;
  let colCount = 1;
  for (const rec of records) if (rec.fields.length > colCount) colCount = rec.fields.length;
  const tooBig = rowCount * colCount > SHEET_CELL_CAP;

  const maxLen = new Array(colCount).fill(0);
  const cells = {};
  for (let r = 0; r < rowCount; r++) {
    const fields = records[r].fields;
    for (let c = 0; c < fields.length; c++) {
      const v = fields[c].v;
      if (v === '') continue;
      if (v.length > maxLen[c]) maxLen[c] = v.length;
      if (tooBig) continue;
      cells[r + ',' + c] = r === 0 ? { t: v, s: 0 } : { t: v };
    }
  }

  return {
    index: 0,
    name,
    rowCount,
    colCount,
    cells,
    styles: ['font-weight:600'],
    colWidths: maxLen.map((len) => Math.min(320, Math.max(48, len * 7 + 16))),
    rowHeights: {},
    defaultRowHeight: 20,
    hiddenRows: [],
    hiddenCols: [],
    merges: [],
    frozen: { rows: 1, cols: 0 },
    lists: [],
    cf: [],
    cfSkipped: 0,
    readOnly: null,
    rowOps: null,
    tooBig,
    locked: [],
  };
}

// ---- Ops ------------------------------------------------------------------

function intArg(x, max, what) {
  if (!Number.isInteger(x) || x < 0 || x > max) throw badOp('Bad ' + what + ': ' + JSON.stringify(x));
  return x;
}

function blankRecord(width) {
  const fields = [];
  for (let i = 0; i < width; i++) fields.push({ v: '', q: false });
  return { fields, raw: null, eol: '' };
}

// Returns a new Parsed; `parsed` and its records are left alone (untouched records are shared).
function applyCsvOps(parsed, ops) {
  if (!isUtf8(parsed.encoding)) throw badOp(NOT_UTF8);
  if (!Array.isArray(ops)) throw badOp('Ops must be a list');

  const recs = parsed.records.slice();
  const owned = new Set();  // records created or copied here, so safe to change in place

  const width = () => (recs.length ? recs[0].fields.length : 1);  // new records match record 0
  const checkGrowth = (extra) => {
    if ((recs.length + extra) * width() > GROW_CELL_CAP) throw badOp('That would make the CSV too large');
  };
  const appendBlanks = (upTo) => {  // records 0..upTo-1 exist afterwards
    const w = width();
    checkGrowth(upTo - recs.length);
    while (recs.length < upTo) {
      const rec = blankRecord(w);
      owned.add(rec);
      recs.push(rec);
    }
  };
  const own = (r) => {
    const rec = recs[r];
    if (owned.has(rec)) return rec;
    const copy = { fields: rec.fields.slice(), raw: null, eol: rec.eol };
    owned.add(copy);
    recs[r] = copy;
    return copy;
  };

  for (const op of ops) {
    if (!op || typeof op !== 'object') throw badOp('Bad op');
    if (op.sheet !== 0) throw badOp('A CSV has one sheet');
    switch (op.op) {
      case 'set': {
        const r = intArg(op.r, MAX_ROW, 'row');
        const c = intArg(op.c, MAX_COL, 'column');
        if (typeof op.v !== 'string') throw badOp('Cell value must be text');
        if (r >= recs.length) appendBlanks(r + 1);
        else if (c < recs[r].fields.length && recs[r].fields[c].v === op.v) break;  // same text: leave the bytes alone
        const rec = own(r);
        while (rec.fields.length <= c) rec.fields.push({ v: '', q: false });
        rec.fields[c] = { v: op.v, q: rec.fields[c].q };
        break;
      }
      case 'insertRows': {  // `like` is formatting; a CSV has none
        const at = intArg(op.at, MAX_ROW, 'row');
        const n = intArg(op.n, MAX_BAND, 'row count');
        if (n < 1) throw badOp('Bad row count: ' + n);
        const w = width();
        if (at > recs.length) appendBlanks(at);
        checkGrowth(n);
        const fresh = [];
        for (let i = 0; i < n; i++) {
          const rec = blankRecord(w);
          owned.add(rec);
          fresh.push(rec);
        }
        recs.splice(at, 0, ...fresh);
        break;
      }
      case 'deleteRows': {
        const at = intArg(op.at, MAX_ROW, 'row');
        const n = intArg(op.n, MAX_BAND, 'row count');
        if (n < 1) throw badOp('Bad row count: ' + n);
        recs.splice(at, n);
        break;
      }
      default:
        throw badOp('Unknown op: ' + JSON.stringify(op.op));
    }
  }
  return { ...parsed, records: recs };
}

// ---- Serialise ------------------------------------------------------------

// The file ends with a line ending iff it did when parsed; every record before the
// last always gets one (its own, else the file's dominant one).
function serializeCsv(parsed) {
  if (!isUtf8(parsed.encoding)) throw badOp(NOT_UTF8);
  const { records, delimiter, eolDominant, endsWithEol, quoteAll } = parsed;
  const needsQuote = new RegExp('["\\r\\n' + delimiter + ']');
  const field = (f) => (f.q || quoteAll || needsQuote.test(f.v) ? '"' + f.v.replace(/"/g, '""') + '"' : f.v);
  const last = records.length - 1;
  const out = [];
  for (let i = 0; i <= last; i++) {
    const rec = records[i];
    out.push(typeof rec.raw === 'string' ? rec.raw : rec.fields.map(field).join(delimiter));
    if (i < last || endsWithEol) out.push(rec.eol || eolDominant);
  }
  const body = Buffer.from(out.join(''), 'utf8');
  return parsed.encoding === 'utf-8-bom' ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
}

module.exports = { parseCsv, csvToSheet, csvEditable, applyCsvOps, serializeCsv, SHEET_CELL_CAP };
