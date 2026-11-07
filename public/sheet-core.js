'use strict';

// ========================================================================
// SheetCore — spreadsheet maths shared by the browser grid (window.SheetCore)
// and the server's lib/sheet-* modules (require). No DOM, no dependencies.
// Row and column numbers are 0-based; A1 text is 1-based, as in Excel.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.SheetCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_COL = 16383;      // XFD
  const MAX_ROW = 1048575;    // row 1048576

  // ---- A1 references ------------------------------------------------------

  function colName(c) {
    if (!Number.isInteger(c) || c < 0 || c > MAX_COL) throw new RangeError('Column out of range: ' + c);
    let name = '';
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }

  // -1 when `letters` is not a column on the grid
  function colNumber(letters) {
    if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1 > MAX_COL ? -1 : n - 1;
  }

  function colIndex(letters) {
    const c = colNumber(letters);
    if (c < 0) throw new Error('Bad column: ' + letters);
    return c;
  }

  const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

  // null unless `text` is a cell on the Excel grid, so names like `Rate_2024` are never mistaken for refs
  function matchCell(text) {
    const m = CELL_RE.exec(text);
    if (!m) return null;
    const c = colNumber(m[2]);
    const r = parseInt(m[4], 10) - 1;
    if (c < 0 || r < 0 || r > MAX_ROW) return null;
    return { r, c, absR: m[3] === '$', absC: m[1] === '$', colText: m[2] };
  }

  function parseCell(text) {
    const cell = matchCell(String(text));
    if (!cell) throw new Error('Bad cell reference: ' + text);
    return { r: cell.r, c: cell.c, absR: cell.absR, absC: cell.absC };
  }

  // 'A1:G1' or a single 'B2'; corners are normalised so r1 <= r2 and c1 <= c2
  function parseRange(text) {
    const parts = String(text).split(':');
    if (parts.length > 2) throw new Error('Bad range: ' + text);
    const a = parseCell(parts[0]);
    const b = parts.length === 2 ? parseCell(parts[1]) : a;
    return {
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c),
    };
  }

  function rangeStr(rg) {
    const from = colName(rg.c1) + (rg.r1 + 1);
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2) return from;
    return from + ':' + colName(rg.c2) + (rg.r2 + 1);
  }

  // ---- Row insert / delete on ranges --------------------------------------

  // Where row `r` lands. delta > 0 inserts delta rows at `at`; delta < 0 deletes the band at..at-delta-1
  // (a row inside the band lands on `at`, the first row that moved up into the gap).
  function shiftRow(r, at, delta) {
    if (delta > 0) return r >= at ? r + delta : r;
    const n = -delta;
    if (r >= at + n) return r - n;
    return r >= at ? at : r;
  }

  // Same, for the last row of a range: inside a deleted band it stops at the row above the band.
  function shiftEnd(r, at, delta) {
    return delta < 0 && r >= at && r < at - delta ? at - 1 : shiftRow(r, at, delta);
  }

  // [first, last] rows of a span after the shift; null when a delete removes all of it or an insert
  // pushes all of it past the last row of the sheet (an insert that only pushes the end off is clipped).
  function shiftSpan(r1, r2, at, delta) {
    const first = shiftRow(r1, at, delta);
    const last = Math.min(shiftEnd(r2, at, delta), MAX_ROW);
    return first > last ? null : [first, last];
  }

  // null when the range is gone; the input is never modified
  function shiftRange(rg, at, delta) {
    const span = shiftSpan(rg.r1, rg.r2, at, delta);
    return span && { r1: span[0], c1: rg.c1, r2: span[1], c2: rg.c2 };
  }

  const WHOLE_COL = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
  const WHOLE_ROW = /^(\$?)(\d+):(\$?)(\d+)$/;

  // 'F3:F15 F17' (a sqref, as in data validations) -> same list after the shift, '' when nothing is left.
  // Whole-column tokens ('F:F') never move; whole-row tokens ('3:5') shift like any other rows.
  function shiftRefList(list, at, delta) {
    return String(list).split(/\s+/).filter(Boolean)
      .map((text) => shiftRef(text, at, delta)).filter(Boolean).join(' ');
  }

  function shiftRef(text, at, delta) {
    const cols = WHOLE_COL.exec(text);
    if (cols && colNumber(cols[1]) >= 0 && colNumber(cols[2]) >= 0) return text;
    const rows = WHOLE_ROW.exec(text);
    if (rows) {
      let a = { dollar: rows[1], r: parseInt(rows[2], 10) - 1 };
      let b = { dollar: rows[3], r: parseInt(rows[4], 10) - 1 };
      if (a.r > b.r) [a, b] = [b, a];
      if (a.r >= 0 && b.r <= MAX_ROW) {
        const span = shiftSpan(a.r, b.r, at, delta);
        return span ? a.dollar + (span[0] + 1) + ':' + b.dollar + (span[1] + 1) : '';
      }
    }
    const rg = shiftRange(parseRange(text), at, delta);
    return rg ? rangeStr(rg) : '';
  }

  // ---- Formula re-anchoring -----------------------------------------------

  const WORD = '[$\\w.\\u00a1-\\uffff]';
  // string literal | error literal (ends in `!` but is no sheet qualifier) |
  // [qualifier!] word [:word]  -> groups: qualifier, first word, second word. A word that is a function
  // name or a 3-D sheet range is left to the next match (the second word may not be followed by `(` or `!`).
  const FORMULA_TOKEN = new RegExp(
    '"(?:[^"]|"")*"'
    + '|#(?:NULL!|DIV/0!|VALUE!|REF!|NAME\\?|NUM!|N/A|GETTING_DATA|SPILL!|CALC!)'
    + `|('(?:[^']|'')+'!|${WORD}+!)?(${WORD}+)(?::(${WORD}+)(?![\\w$.\\u00a1-\\uffff(!]))?`,
    'g');

  // One cell (or A:B range of two) rewritten, or null when a delete leaves nothing of it.
  // Relative rows follow the anchor cell; `$` rows follow their target, as Excel does: in a range the first
  // row stops at the gap, the last row stops above it, and a range wholly inside the gap is gone. With
  // `follow`, relative rows follow their target too (a defined name has no anchor cell that moves). A row is
  // never written past the sheet's last one (K1:$K$1048576 after an insert keeps its end at 1048576).
  function rebaseRefs(a, b, { at, delta, anchorShift, follow }) {
    const text = (cell, r) => (cell.absC ? '$' : '') + cell.colText + (cell.absR ? '$' : '') + (Math.min(Math.max(r, 0), MAX_ROW) + 1);
    const pinned = (cell) => cell.absR || follow;
    if (!b) {
      if (!pinned(a)) return text(a, a.r + anchorShift);
      const span = shiftSpan(a.r, a.r, at, delta);
      return span && text(a, span[0]);
    }
    if (a.r > b.r) [a, b] = [b, a];       // a reversed range is written back low-to-high
    if (pinned(a) && pinned(b)) {
      const span = shiftSpan(a.r, b.r, at, delta);
      return span && text(a, span[0]) + ':' + text(b, span[1]);
    }
    const first = pinned(a) ? shiftRow(a.r, at, delta) : a.r + anchorShift;
    const last = pinned(b) ? shiftEnd(b.r, at, delta) : b.r + anchorShift;
    return text(a, first) + ':' + text(b, last);
  }

  // A whole-row range (3:5, $3:$5) rewritten like a cell range of those rows, or null when a delete takes
  // all of it; undefined when the two words aren't rows on the grid.
  const ROW_WORD = /^(\$?)(\d+)$/;
  function rebaseRows(a, b, opts) {
    const ends = [ROW_WORD.exec(a), ROW_WORD.exec(b)];
    if (!ends[0] || !ends[1]) return undefined;
    const [x, y] = ends.map((m) => ({ r: parseInt(m[2], 10) - 1, absR: m[1] === '$', absC: false, colText: '' }));
    if (x.r < 0 || y.r < 0 || x.r > MAX_ROW || y.r > MAX_ROW) return undefined;
    return rebaseRefs(x, y, opts);
  }

  // Rewrites the cell refs in a CF / data-validation formula, or a defined name, after rows are inserted or
  // deleted. Only refs to `sheet` change (columns never do); the rest of the text is returned character for
  // character. A `$` ref (or range) that a delete removes becomes `#REF!`, qualifier included. `#REF!A1` is a
  // ref to a sheet that was deleted, so it is left alone like any other sheet's.
  // `definedName`: the formula of a defined name (print area, print titles, a named range). It has no anchor
  // cell, so every row follows its target, `$` or not, and whole rows (`$1:$2`) move like the rows they
  // cover. Without it whole rows are never touched (a cell formula's SUM($3:$5) isn't rewritten here).
  function rebaseFormula(formula, { sheet, at, delta = 0, anchorShift = 0, definedName = false }) {
    const mine = sheet.toLowerCase();
    const text = String(formula);
    const opts = { at, delta, anchorShift, follow: definedName };
    return text.replace(FORMULA_TOKEN, (tok, qual, a, b, offset) => {
      if (a === undefined) return tok;                                 // string or error literal
      if (text[offset + tok.length] === '(') return tok;               // function name
      if (!qual && text.slice(Math.max(0, offset - 5), offset).toUpperCase() === '#REF!') return tok;   // a deleted sheet's
      if (qual) {
        const name = qual[0] === "'" ? qual.slice(1, -2).replace(/''/g, "'") : qual.slice(0, -1);
        if (name.toLowerCase() !== mine) return tok;
      }
      const first = matchCell(a);
      const second = b === undefined ? null : matchCell(b);
      let refs;
      if (first && (b === undefined || second)) refs = rebaseRefs(first, second, opts);
      else if (definedName && b !== undefined) refs = rebaseRows(a, b, opts);
      if (refs === undefined) return tok;                              // names, numbers, whole columns
      return refs === null ? '#REF!' : (qual || '') + refs;
    });
  }

  // ========================================================================
  // Client model: the grid's pending edits applied to the server's JSON sheet,
  // conditional-format evaluation and list matching.
  //
  // `applyOps` mirrors what lib/sheet-xlsx.js (shiftRows) and lib/sheet-csv.js do with the same ops, so the
  // grid shows what a save will produce; the fresh payload from the server then replaces the result.
  // Known differences, all things the client cannot know: a `set` stores the typed text, not the display
  // text (it cannot format values); blank rows added past the end of an xlsx are counted here but only kept
  // by the server when they carry formatting; and a CSV sheet gets the xlsx rules (a CSV has no formatting,
  // and its header is always row 0 and always frozen, so a row op at the top shows a different freeze line
  // and header look until the save replaces it).
  // ========================================================================

  const cellKey = (r, c) => r + ',' + c;

  function splitKey(key) {
    const comma = key.indexOf(',');
    return { r: Number(key.slice(0, comma)), c: Number(key.slice(comma + 1)) };
  }

  // Where row `r` goes when rows are inserted (delta > 0) or the band at..at-delta-1 is deleted; null when
  // a delete takes the row. (shiftRow above lands a deleted row on `at`, which is right for range starts.)
  function moveRow(r, at, delta) {
    if (delta > 0) return r >= at ? r + delta : r;
    if (r < at) return r;
    return r < at - delta ? null : r + delta;
  }

  // How many of the rows at..at+n-1 lie below row `limit` (a row count): the part of a band that is there.
  function bandOverlap(at, n, limit) {
    return Math.max(0, Math.min(at + n, limit) - at);
  }

  const covers = (rg, r, c) => rg.r1 <= r && r <= rg.r2 && rg.c1 <= c && c <= rg.c2;
  const coversCell = (ranges, r, c) => ranges.some((rg) => covers(rg, r, c));

  // ---- Checking ops ---------------------------------------------------------

  const likeOf = (op) => (op.like === undefined ? null : op.like);   // JSON has no undefined: a missing like is none

  function requireInt(value, min, what) {
    if (!Number.isInteger(value) || value < min) throw new Error('Bad ' + what + ': ' + JSON.stringify(value));
  }

  // The server validates every op; this only makes sure the grid hands over the right ones.
  function checkOp(sheet, op) {
    if (!op || typeof op !== 'object') throw new Error('Bad op');
    if (op.sheet !== sheet.index) throw new Error('Op for sheet ' + op.sheet + ' applied to sheet ' + sheet.index);
    if (op.op === 'set') {
      requireInt(op.r, 0, 'row');
      requireInt(op.c, 0, 'column');
      if (typeof op.v !== 'string') throw new Error('A cell can only be set to text');
      return;
    }
    if (op.op !== 'insertRows' && op.op !== 'deleteRows') throw new Error('Unknown op: ' + op.op);
    requireInt(op.at, 0, 'row');
    requireInt(op.n, 1, 'row count');
    const like = likeOf(op);
    if (op.op === 'insertRows' && like !== null && like !== op.at && like !== op.at - 1) {
      throw new Error('New rows can only copy the row above or below them');
    }
  }

  // ---- set ------------------------------------------------------------------

  // The typed text is stored as the display text (the client cannot format it; the server's payload will).
  // Empty text clears the cell but keeps its style; a cell with nothing left is removed.
  function applySet(sheet, op) {
    const key = cellKey(op.r, op.c);
    const old = sheet.cells[key] || {};
    const cell = { ...old };
    delete cell.t;
    delete cell.e;
    delete cell.f;
    if (op.v !== '') cell.t = op.v;
    if (Object.keys(cell).length > 0) sheet.cells[key] = cell;
    else delete sheet.cells[key];

    sheet.rowCount = Math.max(sheet.rowCount, op.r + 1);
    sheet.colCount = Math.max(sheet.colCount, op.c + 1);
    sheet.changed.add(key);
  }

  // ---- Row insert / delete --------------------------------------------------

  // The new key of a 'r,c' key after the row op, or null when its row is deleted.
  function movedKey(key, s) {
    const { r, c } = splitKey(key);
    const to = moveRow(r, s.at, s.delta);
    return to === null ? null : cellKey(to, c);
  }

  function shiftCells(cells, s) {
    const out = {};
    for (const [key, cell] of Object.entries(cells)) {
      const to = movedKey(key, s);
      if (to !== null) out[to] = cell;
    }
    return out;
  }

  function shiftRowKeys(byRow, s) {
    const out = {};
    for (const [row, value] of Object.entries(byRow)) {
      const to = moveRow(Number(row), s.at, s.delta);
      if (to !== null) out[to] = value;
    }
    return out;
  }

  function shiftRowList(rows, s) {
    return rows.map((r) => moveRow(r, s.at, s.delta)).filter((r) => r !== null);
  }

  function shiftMerges(merges, s) {
    const out = [];
    for (const m of merges) {
      const rg = shiftRange(m, s.at, s.delta);
      if (rg && (rg.r1 !== rg.r2 || rg.c1 !== rg.c2)) out.push(rg);
    }
    return out;
  }

  // The columns of `ranges` that include row `r`.
  function columnsAt(ranges, r) {
    const cols = new Set();
    for (const rg of ranges) {
      if (rg.r1 > r || r > rg.r2) continue;
      for (let c = rg.c1; c <= rg.c2; c++) cols.add(c);
    }
    return cols;
  }

  // Ranges over the new rows for the `wanted` columns the shifted ranges don't already reach. A shifted
  // range holds all the new rows or none (it grew across the insertion point or it didn't), so looking at
  // row `at` is enough.
  function coverNewRows(shifted, wanted, s) {
    const have = columnsAt(shifted, s.at);
    const cols = [...wanted].filter((c) => !have.has(c)).sort((a, b) => a - b);
    const added = [];
    for (const c of cols) {
      const last = added[added.length - 1];
      if (last && last.c2 === c - 1) last.c2 = c;
      else added.push({ r1: s.at, c1: c, r2: s.at + s.n - 1, c2: c });
    }
    return added;
  }

  // Ruling 19: an insert grows a list when the rows just above and below the insertion point are both in it
  // (the range crossing the point grows by itself; this also covers a list held as separate ranges), and
  // the rows copy `like`'s list too.
  function shiftLists(lists, s) {
    const out = [];
    for (const list of lists) {
      const shifted = list.ranges.map((rg) => shiftRange(rg, s.at, s.delta)).filter(Boolean);
      let ranges = shifted;
      if (s.delta > 0) {
        const wanted = new Set();
        const above = columnsAt(list.ranges, s.at - 1);
        for (const c of columnsAt(list.ranges, s.at)) if (above.has(c)) wanted.add(c);
        if (s.like !== null) for (const c of columnsAt(list.ranges, s.like)) wanted.add(c);
        ranges = shifted.concat(coverNewRows(shifted, wanted, s));
      }
      if (ranges.length > 0) out.push({ ...list, ranges });
    }
    return out;
  }

  // Relative refs are offsets from the cell being drawn, so they stay; an absolute row follows its row, and
  // the rule goes when a delete takes that row.
  function shiftRule(rule, s) {
    if (rule.kind !== 'ref' || !rule.ref.absR) return rule;
    const r = moveRow(rule.ref.r, s.at, s.delta);
    return r === null ? null : { ...rule, ref: { ...rule.ref, r } };
  }

  // Conditional formats follow their rows; the new rows get `like`'s formats. An entry with no rows left, or
  // none of whose rules survive, is dropped. A rule dropped from a surviving entry is counted in `skipped`,
  // as the server will count it (its formula turns into #REF!, which the grid can't draw).
  function shiftFormats(entries, s) {
    const cf = [];
    let skipped = 0;
    for (const entry of entries) {
      const shifted = entry.ranges.map((rg) => shiftRange(rg, s.at, s.delta)).filter(Boolean);
      if (shifted.length === 0) continue;
      const rules = entry.rules.map((rule) => shiftRule(rule, s)).filter(Boolean);
      skipped += entry.rules.length - rules.length;
      if (rules.length === 0) continue;
      let ranges = shifted;
      if (s.delta > 0 && s.like !== null) ranges = shifted.concat(coverNewRows(shifted, columnsAt(entry.ranges, s.like), s));
      cf.push({ ...entry, ranges, rules });
    }
    return { cf, skipped };
  }

  // Ruling 24: the freeze line follows the rows. Rows inserted above it join the frozen part, deleted
  // frozen rows leave it. Frozen columns are not touched.
  function shiftFrozen(frozen, s) {
    if (!frozen) return frozen;
    if (s.delta > 0) return s.at < frozen.rows ? { ...frozen, rows: frozen.rows + s.n } : frozen;
    return { ...frozen, rows: frozen.rows - bandOverlap(s.at, s.n, frozen.rows) };
  }

  // What new rows copy from row `like`, read before anything moves: its styled cells (style only, never
  // text) and its height.
  function likeFormat(sheet, like) {
    if (like === null) return null;
    const styles = [];
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const { r, c } = splitKey(key);
      if (r === like && cell.s !== undefined) styles.push({ c, s: cell.s });
    }
    return { styles, height: sheet.rowHeights[like] };
  }

  function addLikeFormat(sheet, format, s) {
    for (let r = s.at; r < s.at + s.n; r++) {
      for (const { c, s: style } of format.styles) sheet.cells[cellKey(r, c)] = { s: style };
      if (format.height !== undefined) sheet.rowHeights[r] = format.height;
    }
  }

  function shiftRows(sheet, at, delta, like) {
    const s = { at, delta, n: Math.abs(delta), like };
    const format = likeFormat(sheet, like);

    if (delta > 0) sheet.rowCount = Math.max(sheet.rowCount, at) + s.n;
    else sheet.rowCount -= bandOverlap(at, s.n, sheet.rowCount);

    sheet.cells = shiftCells(sheet.cells, s);
    sheet.rowHeights = shiftRowKeys(sheet.rowHeights, s);
    sheet.hiddenRows = shiftRowList(sheet.hiddenRows, s);
    sheet.merges = shiftMerges(sheet.merges, s);
    sheet.lists = shiftLists(sheet.lists, s);
    const formats = shiftFormats(sheet.cf, s);
    sheet.cf = formats.cf;
    sheet.cfSkipped += formats.skipped;
    sheet.frozen = shiftFrozen(sheet.frozen, s);

    sheet.changed = new Set([...sheet.changed].map((key) => movedKey(key, s)).filter((key) => key !== null));
    sheet.newRows = new Set(shiftRowList([...sheet.newRows], s));

    if (delta < 0) return;
    if (format) addLikeFormat(sheet, format, s);
    for (let r = at; r < at + s.n; r++) sheet.newRows.add(r);
  }

  // A new sheet; `sheet` is not touched. `changed` (the 'r,c' cells set since the server's version) and
  // `newRows` (rows inserted since) carry on from the input if it has them.
  function applyOps(sheet, ops) {
    const out = structuredClone(sheet);
    out.changed = new Set(out.changed || []);
    out.newRows = new Set(out.newRows || []);
    for (const op of ops) {
      checkOp(out, op);
      if (op.op === 'set') applySet(out, op);
      else if (op.op === 'insertRows') shiftRows(out, op.at, op.n, likeOf(op));
      else shiftRows(out, op.at, -op.n, null);
    }
    return out;
  }

  // The ops with every `set` dropped that a later `set` of the same cell replaces, unless a row op on that
  // sheet came between them (it moves cells, so the two may no longer be the same cell). The input is not
  // changed.
  function compactOps(ops) {
    const kept = [];
    const lastSet = new Map();                 // sheet -> Map('r,c' -> index in kept) since that sheet's last row op
    for (const op of ops) {
      if (op.op !== 'set') {
        lastSet.delete(op.sheet);
        kept.push(op);
        continue;
      }
      if (!lastSet.has(op.sheet)) lastSet.set(op.sheet, new Map());
      const cells = lastSet.get(op.sheet);
      const key = cellKey(op.r, op.c);
      if (cells.has(key)) kept[cells.get(key)] = null;
      cells.set(key, kept.length);
      kept.push(op);
    }
    return kept.filter((op) => op !== null);
  }

  // ---- Reading cells --------------------------------------------------------

  function cellText(sheet, r, c) {
    const cell = sheet.cells[cellKey(r, c)];
    return cell && cell.t ? cell.t : '';
  }

  // What a rule compares: the edit text when there is one (the number behind a formatted £1,250.00), else
  // the display text.
  function cellValue(sheet, r, c) {
    const cell = sheet.cells[cellKey(r, c)];
    if (!cell) return '';
    return cell.e !== undefined ? cell.e : cell.t || '';
  }

  // ---- Conditional formats --------------------------------------------------

  const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const sign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // -1, 0 or 1: how the cell's text sorts against a rule's literal. Two numbers compare as numbers (and a
  // blank cell reads as 0 beside a number, as in Excel); anything else compares as text, ignoring case.
  function compareToLiteral(text, literal) {
    if (typeof literal === 'number' && Number.isFinite(literal)) {
      if (text === '') return sign(0, literal);
      if (NUMBER_TEXT.test(text) && Number.isFinite(Number(text))) return sign(Number(text), literal);
    }
    return sign(text.toLowerCase(), String(literal).toLowerCase());
  }

  function holds(op, values, text) {
    const cmp = (i) => compareToLiteral(text, values[i]);
    switch (op) {
      case 'eq': return cmp(0) === 0;
      case 'ne': return cmp(0) !== 0;
      case 'gt': return cmp(0) > 0;
      case 'lt': return cmp(0) < 0;
      case 'ge': return cmp(0) >= 0;
      case 'le': return cmp(0) <= 0;
      case 'between': return cmp(0) >= 0 && cmp(1) <= 0;
      case 'notBetween': return !(cmp(0) >= 0 && cmp(1) <= 0);
      default: return false;
    }
  }

  // The cell a rule looks at when drawing (r, c): that cell, or for a `ref` rule the cell it points to
  // (relative parts are offsets from (r, c), absolute ones are indices); null when that is off the grid.
  function ruleSubject(rule, r, c) {
    if (rule.kind !== 'ref') return { r, c };
    const at = { r: rule.ref.absR ? rule.ref.r : r + rule.ref.r, c: rule.ref.absC ? rule.ref.c : c + rule.ref.c };
    return at.r < 0 || at.c < 0 ? null : at;
  }

  function ruleMatches(sheet, rule, r, c) {
    const subject = ruleSubject(rule, r, c);
    return subject !== null && holds(rule.op, rule.values, cellValue(sheet, subject.r, subject.c));
  }

  // The rules that apply to (r, c), in order, up to and including the first with `stop`.
  function matchingRules(sheet, r, c) {
    const hits = [];
    for (const entry of sheet.cf) {
      if (!coversCell(entry.ranges, r, c)) continue;
      for (const rule of entry.rules) {
        if (!ruleMatches(sheet, rule, r, c)) continue;
        hits.push(rule);
        if (rule.stop) return hits;
      }
    }
    return hits;
  }

  // The CSS for (r, c) from its conditional formats; where several rules set one property the first wins.
  function cfCss(sheet, r, c) {
    const declarations = new Map();            // property -> declaration
    for (const rule of matchingRules(sheet, r, c)) {
      for (const declaration of rule.css.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 1) continue;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        if (!declarations.has(property)) declarations.set(property, declaration.trim());
      }
    }
    return [...declarations.values()].join(';');
  }

  // ---- Lists ----------------------------------------------------------------

  const listKey = (text) => String(text).trim().toLowerCase();

  // The list's own spelling of what was typed (ends trimmed, case ignored), or null when it is no item.
  function matchListItem(items, text) {
    const key = listKey(text);
    if (key === '') return null;
    const item = items.find((candidate) => listKey(candidate) === key);
    return item === undefined ? null : item;
  }

  return {
    colName, colIndex, parseCell, parseRange, rangeStr,
    shiftRange, shiftRefList,
    rebaseFormula,
    applyOps, compactOps, cellText, cfCss, matchListItem,
  };
});
