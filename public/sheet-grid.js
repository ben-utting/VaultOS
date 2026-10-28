'use strict';

// ========================================================================
// SheetGrid — the spreadsheet grid Files mode draws a .csv / .xlsx in.
// Classic script: needs sheet-core.js (window.SheetCore) and app.js (esc).
//
//   const grid = SheetGrid.create(payload, { editable, onChange, onRequestSave, onLeave, onDownload, bigBanner, toast });
//   (bigBanner: the host shows its own "too large" banner when no sheet can be drawn, so the grid's panel
//   then gives only the size)
//   grid.attach(viewEl) · grid.suspend() · grid.load(payload, { keepView }) · grid.destroy()
//   grid.setEditable(bool) · grid.ops() · grid.changeCount() · grid.hasDraft() · grid.commitEdit() → bool
//   grid.checkpoint() → mark · grid.opsSince(mark) · grid.release(mark) · grid.replay(ops) → { applied, skipped }
//   grid.focus() · grid.selectAll()            (see "Public API" for what each one means)
//   grid.cellBox(r, c) → { r, c, top, left, width, height, stuckRow, stuckCol }: the cell's (or its
//   merge's) box in table coordinates, the only cell geometry to use (see cellBox below); null when hidden
//
// Rows are drawn from HTML strings, the first screenful at once and the rest a batch a frame; a sheet's
// table is kept while the grid lives (a sheet tab switch swaps tables, it doesn't redraw). Every listener is
// delegated to the grid's own elements, never one per cell. Keyboard focus sits in an off-screen <textarea>
// (the "sink"): it is what receives the arrow keys, and it always holds one selected space so Chrome fires
// copy/cut/paste for Ctrl+C/X/V even though nothing visible is selected. inputmode="none" keeps a phone's
// keyboard down when a tap focuses it; the cell editor is a separate textarea with a normal keyboard.
// Screen readers: each table is role="grid", named after its sheet; the sink's aria-label follows the
// selection ("F4, Open", announce()), and an open list is pointed at with aria-activedescendant.
//
// Editing: every change is a group of ops (SheetCore's Op shapes). A new group is applied to the current
// sheet model (SheetCore.applyOps), and the rows it touches are redrawn in place; a row insert/delete
// redraws the sheet. Undo rebuilds the sheet from the server's version by replaying the groups left.
// The editor, the list popup and the row menu live inside grid.el, so detaching and re-attaching the grid
// (another file, another mode) keeps an edit in progress as it was.
//
// Cell CSS comes from the server, built from a whitelist (lib/sheet-style.js), and goes into style
// attributes as it is; cell text always goes through esc().
// ========================================================================

(function () {
  const Core = window.SheetCore;
  const ROWNUM_MIN = 32;                 // px: the row-number column for up to 3 digits
  const DEFAULT_COL = 64;                // px: Excel's default column (8.43 characters)
  const SPILL_MAX = 30;                  // columns a long text may run across
  const FIRST_CELLS = 5000;              // drawn at once: more than a screenful at any size
  const FIRST_ROWS = 60;                 // ...and never fewer rows than this
  const BATCH_CELLS = 2500;              // then this many a frame (Chrome re-lays the whole table each time)
  const SPARE_ROWS = 20;                 // edit mode: blank rows past the last one, to type into
  const SPARE_COLS = 2;                  // ...and blank columns past the last one
  const UNDO_MAX = 500;                  // undo steps kept; older ones stay changes but can't be undone
  const PASTE_MAX = 20000;               // cells one paste may write
  const CELL_MAX = 32767;                // characters in one cell (Excel's limit, and the server's)
  const ROWOP_MAX = 1000;                // rows one insert / delete may add or remove (the server's limit)
  const DOUBLE_TAP_MS = 400;
  // After a press in the grid the formula bar keeps its height until presses have stopped this long (past a
  // double-click's second press: Windows allows 500ms), so the cells don't move between the two presses.
  const BAR_HOLD_MS = 550;
  const TOUCH_MIN = 32;                  // px: the smallest target a finger gets (the ▾, a row number in edit mode)
  const SAY_MS = 250;                    // a screen reader hears where the selection stopped, not every step
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MSG = {
    view: 'Press Edit to change cells',
    formula: "Formula cells can't be changed here — edit them in Excel",
    merge: 'Only the first cell of a merged block can be changed',
    table: 'That cell is part of an Excel table header — edit it in Excel',
    tooMuch: "That's too much to paste at once (max 20,000 cells)",
    tooLong: 'A cell can hold at most 32,767 characters',
    paused: 'Saving… undo is paused',
  };
  // On a Mac, Option+key types a character (Option+2 is ™); elsewhere Alt+key is a shortcut (the browser's
  // Alt+D, VaultOS's Alt+1…9 for terminals). Ctrl+Alt is AltGr, which types, everywhere.
  const MAC = (() => {
    try {
      const nav = typeof navigator === 'undefined' ? {} : navigator;
      return /mac|iphone|ipad|ipod/i.test((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
    } catch { return false; }
  })();
  let SEQ = 0;

  // ---- Cell styles -----------------------------------------------------------

  // One server style string, split so borders can be dropped or swapped per cell: a border both neighbours
  // carry (Excel stores "all borders" on both cells) would otherwise draw twice as thick with separate borders.
  function parseStyle(css) {
    const out = { rest: '', b: { top: '', right: '', bottom: '', left: '' }, align: '', wrap: false, fill: false, bold: false };
    const keep = [];
    for (const raw of String(css || '').split(';')) {
      const d = raw.trim();
      const i = d.indexOf(':');
      if (i < 1) continue;
      const prop = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).trim();
      const side = prop.startsWith('border-') ? prop.slice(7) : '';
      if (SIDES.includes(side)) { out.b[side] = d; continue; }
      if (prop === 'text-align') out.align = value;
      else if (prop === 'white-space') out.wrap = value !== 'nowrap';
      else if (prop === 'background' || prop === 'background-color') out.fill = true;
      else if (prop === 'font-weight') out.bold = Number(value) >= 600 || value === 'bold';
      keep.push(d);
    }
    out.rest = keep.join(';');
    return out;
  }
  const NO_STYLE = parseStyle('');

  // Excel's "General" alignment: numbers and dates to the right, TRUE/FALSE and errors centred, text left.
  const NUMBERISH = /^[-+(]?[£$€¥]?[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?\)?$/;
  const DATEISH = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$|^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?$/i;
  const CENTRED = /^(?:TRUE|FALSE|#(?:N\/A|DIV\/0!|REF!|NAME\?|VALUE!|NUM!|NULL!|SPILL!|CALC!))$/;
  function generalAlign(t) {
    if (CENTRED.test(t)) return 'center';
    if (/\d/.test(t) && (NUMBERISH.test(t) || DATEISH.test(t))) return 'right';
    return '';
  }

  // TSV for the clipboard: a field with a tab, newline or quote is quoted, quotes doubled (what Excel reads).
  const tsvField = (t) => (/[\t\n\r"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);

  // What Excel puts on the clipboard, back into rows of cells: tab-separated, CRLF (or LF) between rows, a
  // field holding a tab, newline or quote wrapped in quotes with its quotes doubled. One trailing line break
  // (Excel always adds it) is not an extra row. A field that opens a quote and never closes it is plain text.
  // With `max`, parsing stops (null) as soon as there are more than `max` cells.
  function parseClip(text, max = Infinity) {
    const s = String(text).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let i = 0;
    let cells = 0;
    while (i <= s.length) {
      let field = '';
      if (s[i] === '"') {
        let j = i + 1, val = '', closed = false;
        while (j < s.length) {
          if (s[j] === '"') {
            if (s[j + 1] === '"') { val += '"'; j += 2; continue; }
            closed = true;
            j++;
            break;
          }
          val += s[j++];
        }
        if (closed) {
          while (j < s.length && s[j] !== '\t' && s[j] !== '\n') val += s[j++];
          field = val;
          i = j;
        } else {
          let k = i;
          while (k < s.length && s[k] !== '\t' && s[k] !== '\n') k++;
          field = s.slice(i, k);
          i = k;
        }
      } else {
        let k = i;
        while (k < s.length && s[k] !== '\t' && s[k] !== '\n') k++;
        field = s.slice(i, k);
        i = k;
      }
      row.push(field);
      if (++cells > max) return null;
      if (i >= s.length) { rows.push(row); break; }
      if (s[i] === '\n') {
        rows.push(row);
        row = [];
        if (i + 1 === s.length) break;   // the trailing line break
      }
      i++;
    }
    return rows;
  }

  // ---- The edit history ------------------------------------------------------

  // Undo steps ("groups": { si, ops, … }) in the order they were applied, each with a sequence number. Past
  // `max` steps the oldest is folded: still applied and still in ops(), but no longer undoable (the grid folds
  // its ops into the sheet's base). A save in flight pins what it sent:
  //   mark = checkpoint()   pins every step applied so far: undo won't go below it until release(mark)
  //   opsSince(mark)        the ops of the steps applied after the mark that are still applied — what that
  //                         save didn't send, to replay on the file it returns
  //   release(mark)         unpins (the save failed; a successful one reloads the grid, which resets this)
  // A redone step gets a new number: it is applied again now, after any mark.
  function createHistory(max) {
    let seq = 0;
    let undo = [], redo = [], folded = [], pins = [];
    const top = () => (pins.length ? Math.max(...pins) : -Infinity);
    const opsOf = (groups) => {
      const out = [];
      for (const g of groups) for (const op of g.ops) out.push(op);
      return out;
    };
    // Keep at most `max` undoable steps; the ones folded away, oldest first.
    function trim() {
      const out = [];
      while (undo.length > max) {
        const g = undo.shift();
        folded.push(g);
        out.push(g);
      }
      return out;
    }
    return {
      // A new step: numbered, on top, redo gone. Returns the steps folded away.
      add(g) { g.seq = ++seq; undo.push(g); redo = []; return trim(); },
      // The step to undo: { group }, { paused: true } while a save in flight has it, or null when there's none.
      undo() {
        const g = undo[undo.length - 1];
        if (!g) return null;
        if (g.seq <= top()) return { paused: true };
        undo.pop();
        redo.push(g);
        return { group: g };
      },
      // The step to redo, renumbered: { group, folded }, or null.
      redo() {
        const g = redo.pop();
        if (!g) return null;
        g.seq = ++seq;
        undo.push(g);
        return { group: g, folded: trim() };
      },
      // The undoable steps' ops on sheet si, in order: what the base needs replayed after an undo.
      applied(si) { return opsOf(undo.filter((g) => g.si === si)); },
      ops() { return opsOf(folded).concat(opsOf(undo)); },
      opsSince(mark) { return opsOf(folded.filter((g) => g.seq > mark)).concat(opsOf(undo.filter((g) => g.seq > mark))); },
      checkpoint() { pins.push(seq); return seq; },
      release(mark) { const i = pins.indexOf(mark); if (i >= 0) pins.splice(i, 1); },
      reset() { undo = []; redo = []; folded = []; pins = []; },
      sizes() { return { undo: undo.length, redo: redo.length, folded: folded.length, pins: pins.length }; },
    };
  }

  // ---- One sheet → HTML ------------------------------------------------------

  // A .csv has no column widths of its own; the server guesses from character counts, which runs short in a
  // font wider than Calibri. Measure the text in the grid's own font instead (the first FIT_ROWS rows), never
  // narrower than the server's guess and never wider than FIT_MAX.
  const FIT_ROWS = 2000, FIT_MAX = 420;
  let fitCtx = null;
  function fitWidths(sheet, nC) {
    if (!fitCtx) fitCtx = document.createElement('canvas').getContext('2d');
    const out = (sheet.colWidths || []).slice(0, nC);
    const infos = (sheet.styles || []).map(parseStyle);
    const family = 'Calibri, Carlito, "Segoe UI", Arial, sans-serif';
    const px = 13;   // --sg-fs in styles.css
    const rows = Math.min(sheet.rowCount || 0, FIT_ROWS);
    for (const font of ['normal', 'bold']) {
      fitCtx.font = `${font === 'bold' ? '700 ' : ''}${px}px ${family}`;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < nC; c++) {
          const cell = sheet.cells[r + ',' + c];
          if (!cell || !cell.t) continue;
          const st = cell.s != null && infos[cell.s];
          if ((font === 'bold') !== !!(st && st.bold)) continue;
          const w = Math.ceil(fitCtx.measureText(cell.t.length > 200 ? cell.t.slice(0, 200) : cell.t).width) + 12;
          if (!(out[c] >= w)) out[c] = Math.min(Math.max(w, out[c] || 0), FIT_MAX);
        }
      }
    }
    return out;
  }

  // Everything about a sheet's layout the grid needs after drawing it: which rows/columns are on screen, the
  // merges, the frozen panes. Positions are model indexes (0-based); hidden rows and columns are left out.
  // `spare` adds blank rows/columns past the data (edit mode), drawn with dimmed headers.
  function layoutOf(sheet, widths, spare) {
    const nR = Math.max((sheet.rowCount || 0) + spare.r, 1);
    const nC = Math.max((sheet.colCount || 0) + spare.c, 1);
    const hiddenR = new Set(sheet.hiddenRows || []);
    const hiddenC = new Set(sheet.hiddenCols || []);
    const vrows = [], vcols = [];
    const rIdx = new Int32Array(nR).fill(-1), cIdx = new Int32Array(nC).fill(-1);
    for (let r = 0; r < nR; r++) if (!hiddenR.has(r)) { rIdx[r] = vrows.length; vrows.push(r); }
    for (let c = 0; c < nC; c++) if (!hiddenC.has(c)) { cIdx[c] = vcols.length; vcols.push(c); }
    const colW = (c) => (widths[c] > 0 ? widths[c] : DEFAULT_COL);
    const rnW = Math.max(ROWNUM_MIN, 10 + 7 * String(nR).length);

    // Merges: drawn from their first visible row and column, spanning only visible ones.
    const merges = [];
    const masters = new Map();           // 'r,c' of the drawn cell -> { rs, cs, m }
    const covered = new Set();           // 'r,c' of every other cell in a merge
    for (const g of sheet.merges || []) {
      const m = { r1: Math.max(0, g.r1), c1: Math.max(0, g.c1), r2: Math.min(nR - 1, g.r2), c2: Math.min(nC - 1, g.c2) };
      if (m.r1 > m.r2 || m.c1 > m.c2 || (m.r1 === m.r2 && m.c1 === m.c2)) continue;
      merges.push(m);
      let fr = -1, rs = 0, fc = -1, cs = 0;
      for (let r = m.r1; r <= m.r2; r++) if (rIdx[r] >= 0) { if (fr < 0) fr = r; rs++; }
      for (let c = m.c1; c <= m.c2; c++) if (cIdx[c] >= 0) { if (fc < 0) fc = c; cs++; }
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) covered.add(r + ',' + c);
      if (rs && cs) {
        covered.delete(fr + ',' + fc);
        masters.set(fr + ',' + fc, { rs, cs, m, lr: lastVisible(rIdx, m.r1, m.r2), lc: lastVisible(cIdx, m.c1, m.c2) });
      }
    }

    const FR = Math.min(Math.max(0, (sheet.frozen && sheet.frozen.rows) || 0), nR);
    const FC = Math.min(Math.max(0, (sheet.frozen && sheet.frozen.cols) || 0), nC);
    // Each visible column's left edge in table coordinates (also a frozen column's sticky left).
    const colLeft = new Float64Array(nC);
    let x = rnW, frozenRight = rnW;
    for (const c of vcols) {
      colLeft[c] = x;
      x += colW(c);
      if (c < FC) frozenRight = x;
    }
    // Per visible row (by position in vrows): where the merges drawn from it end (exclusive), so a batch of
    // rows never stops inside a rowspan.
    const spanEnd = new Int32Array(vrows.length);
    for (const [key, info] of masters) {
      const i = rIdx[Number(key.slice(0, key.indexOf(',')))];
      spanEnd[i] = Math.max(spanEnd[i], rIdx[info.lr] + 1);
    }
    return { nR, nC, vrows, vcols, rIdx, cIdx, colW, colLeft, rnW, merges, masters, covered, FR, FC, frozenRight, spanEnd,
      spare: spare.r + spare.c > 0 };
  }

  // Where a batch of rows that starts at vrows[from] and should end at vrows[end] may end: past the last row
  // of every merge that starts inside it (a rowspan must never run into the rows still to come).
  function batchEnd(L, from, end) {
    let e = Math.min(end, L.vrows.length);
    for (let i = from; i < e; i++) if (L.spanEnd[i] > e) e = L.spanEnd[i];
    return e;
  }

  function lastVisible(idx, a, b) {
    for (let i = b; i >= a; i--) if (idx[i] >= 0) return i;
    return a;
  }

  // A sheet's HTML, in pieces: `open` (table, column widths and letters), `rows(i, j)` (the visible rows
  // vrows[i..j-1] — the grid draws the first screenful at once and appends the rest in batches, since laying
  // out a 60,000-cell table in one go takes the best part of a second), `close`. Rows are drawn from the
  // sheet model as it is when they're drawn (getSheet()), so rows still to come show edits made meanwhile,
  // and one row can be drawn again on its own after an edit.
  function sheetRenderer(getSheet, L) {
    const first = getSheet();
    const infos = (first.styles || []).map(parseStyle);
    const info = (cell) => (cell && cell.s != null && infos[cell.s]) || NO_STYLE;
    const { vrows, vcols, rIdx, cIdx, colW, colLeft, rnW, masters, covered, FR, FC } = L;
    const prevVisible = (idx, list, i) => (idx[i] > 0 ? list[idx[i] - 1] : -1);
    const defH = first.defaultRowHeight > 0 ? first.defaultRowHeight : 20;

    let total = rnW;
    let cols = `<col style="width:${rnW}px">`;
    let head = '<th class="sg-corner" title="Select all"></th>';
    for (const c of vcols) {
      const w = colW(c);
      total += w;
      cols += `<col style="width:${w}px">`;
      const fc = c < FC;
      const spare = L.spare && c >= (first.colCount || 0);
      head += `<th class="sg-ch${fc ? ' sg-fc' : ''}${spare ? ' sg-spare' : ''}" data-c="${c}"${fc ? ` style="--sgl:${colLeft[c]}px"` : ''}>${Core.colName(c)}</th>`;
    }

    function rows(from, to) {
      const sheet = getSheet();
      const cells = sheet.cells || {};
      const hasCf = Array.isArray(sheet.cf) && sheet.cf.length > 0;
      const heights = sheet.rowHeights || {};
      const changed = sheet.changed, added = sheet.newRows;
      const dataRows = sheet.rowCount || 0;
      const parts = [];
      for (let ri = from; ri < to; ri++) {
        const r = vrows[ri];
        const h = heights[r];
        const fixed = h > 0;
        const frozenRow = r < FR;
        const trCls = frozenRow ? (fixed ? 'sg-fr sg-hx' : 'sg-fr') : fixed ? 'sg-hx' : '';
        const rhCls = (added && added.has(r) ? ' sg-newrow' : '') + (L.spare && r >= dataRows ? ' sg-spare' : '');
        let row = `<tr data-r="${r}"${trCls ? ` class="${trCls}"` : ''}`
          + (fixed ? ` style="height:${h}px;--rh:${Math.max(h - 1, 1)}px"` : '') + `><th class="sg-rh${rhCls}">${r + 1}</th>`;
        for (let i = 0; i < vcols.length; i++) {
          const c = vcols[i];
          const key = r + ',' + c;
          if (covered.has(key)) continue;
          const cell = cells[key];
          const st = info(cell);
          const mst = masters.get(key);
          const text = cell && cell.t ? cell.t : '';
          let cls = '';
          let attrs = '';
          let css = st.rest;

          // Borders: drop the left/top one the neighbour already draws; a merge takes its right and bottom
          // borders from the cells on its far edges (that's where Excel keeps them).
          const pc = prevVisible(cIdx, vcols, c);
          const pr = prevVisible(rIdx, vrows, r);
          let bRight = st.b.right, bBottom = st.b.bottom;
          if (mst) {
            bRight = info(cells[r + ',' + mst.lc]).b.right || bRight;
            bBottom = info(cells[mst.lr + ',' + c]).b.bottom || bBottom;
          }
          const borders = [];
          if (st.b.top && !(pr >= 0 && info(cells[pr + ',' + c]).b.bottom)) borders.push(st.b.top);
          if (bRight) borders.push(bRight);
          if (bBottom) borders.push(bBottom);
          if (st.b.left && !(pc >= 0 && info(cells[r + ',' + pc]).b.right)) borders.push(st.b.left);
          if (borders.length) css += (css ? ';' : '') + borders.join(';');

          const general = !st.align && text ? generalAlign(text) : '';
          if (general) css += (css ? ';' : '') + 'text-align:' + general;
          let filled = st.fill;
          if (hasCf) {
            const cf = Core.cfCss(sheet, r, c);
            if (cf) {
              css += (css ? ';' : '') + cf;
              if (/(?:^|;)\s*background/.test(cf)) filled = true;
            }
          }
          if (filled) cls += ' sg-fill';
          if (changed && changed.has(key)) cls += ' sg-changed';

          let frozenCol = c < FC;
          if (mst) {
            attrs += (mst.cs > 1 ? ` colspan="${mst.cs}"` : '') + (mst.rs > 1 ? ` rowspan="${mst.rs}"` : '');
            if (frozenCol && mst.m.c2 >= FC) frozenCol = false;          // crosses the freeze line: not sticky
            if (frozenRow && mst.m.r2 >= FR) cls += ' sg-xr';
            if (mst.rs > 1 && fixed) {
              let sum = 0;
              for (let k = mst.m.r1; k <= mst.m.r2; k++) if (rIdx[k] >= 0) sum += heights[k] > 0 ? heights[k] : defH;
              css += (css ? ';' : '') + `--rh:${sum - 1}px`;
            }
          }
          if (frozenCol) {
            cls += ' sg-fc';
            css += (css ? ';' : '') + `--sgl:${colLeft[c]}px`;
          }

          // A long unwrapped text runs on over empty cells to its right, as in Excel.
          let spill = '';
          if (text && !mst && !st.wrap && !general && (!st.align || st.align === 'left') && text.length * 7.5 > colW(c) - 8) {
            let width = colW(c);
            for (let j = i + 1, n = 0; j < vcols.length && n < SPILL_MAX; j++, n++) {
              const cj = vcols[j];
              const kj = r + ',' + cj;
              if ((c < FC) !== (cj < FC) || covered.has(kj) || masters.has(kj)) break;
              const nb = cells[kj];
              if (nb && nb.t) break;
              width += colW(cj);
            }
            if (width > colW(c)) {
              cls += ' sg-ov';
              spill = ` style="width:${width - 9}px"`;
            }
          }

          row += `<td data-c="${c}"${attrs}${cls ? ` class="${cls.slice(1)}"` : ''}${css ? ` style="${css}"` : ''}`
            + `${cell && cell.f ? ` title="${esc(cell.f)}"` : ''}>${text ? `<div class="sg-c"${spill}>${esc(text)}</div>` : ''}</td>`;
        }
        parts.push(row + '</tr>');
      }
      return parts.join('');
    }
    // The height the rows from vrows[from] on will take (a guess for wrapped ones): the stand-in that keeps
    // the scrollbar the size of the whole sheet while they're still to come.
    function restHeight(from) {
      const heights = getSheet().rowHeights || {};
      let h = 0;
      for (let ri = from; ri < vrows.length; ri++) h += heights[vrows[ri]] > 0 ? heights[vrows[ri]] : defH;
      return h;
    }
    return {
      // A grid named after its sheet, for screen readers (the keyboard itself lives in the sink: see announce).
      open: `<table class="sg-table" role="grid" aria-label="${esc(first.name || 'Sheet')}" aria-readonly="${!L.spare}"`
        + ` style="width:${total}px;--sg-rowh:${defH}px"><colgroup>${cols}</colgroup>`
        + `<thead><tr>${head}</tr></thead><tbody>`,
      rows,
      spacer: (from) => (from < vrows.length
        ? `<tr class="sg-spacer" aria-hidden="true"><td colspan="${vcols.length + 1}" style="height:${restHeight(from)}px"></td></tr>` : ''),
      restHeight,
      close: '</tbody></table>',
    };
  }

  // ---- Reading the model -----------------------------------------------------

  const splitKey = (key) => { const i = key.indexOf(','); return { r: Number(key.slice(0, i)), c: Number(key.slice(i + 1)) }; };
  const covers = (rg, r, c) => rg.r1 <= r && r <= rg.r2 && rg.c1 <= c && c <= rg.c2;
  // What the editor starts from, and what a commit is compared with: the edit text, else the display text.
  function editTextOf(s, r, c) {
    const cell = s.cells && s.cells[r + ',' + c];
    if (!cell) return '';
    return cell.e !== undefined ? cell.e : cell.t || '';
  }
  function listAt(s, r, c) {
    for (const list of s.lists || []) if (list.ranges.some((rg) => covers(rg, r, c))) return list;
    return null;
  }
  function modelMergeAt(s, r, c) {
    for (const m of s.merges || []) if (covers(m, r, c)) return m;
    return null;
  }
  // The rows whose conditional formats may read differently after the cells `keys` changed: a rule on a
  // cell's own value reads that cell; a rule on another cell (REF op LITERAL) reads the cell its offset or
  // absolute index points at, so it is every cell in the rule's ranges that points at a changed one.
  function cfRows(s, keys, maxRow) {
    const out = new Set();
    if (!Array.isArray(s.cf) || !s.cf.length) return out;
    const pts = [...keys].map(splitKey);
    for (const entry of s.cf) {
      for (const rule of entry.rules) {
        for (const { r: R, c: C } of pts) {
          for (const rg of entry.ranges) {
            if (rule.kind !== 'ref') { if (covers(rg, R, C)) out.add(R); continue; }
            const ref = rule.ref;
            if (ref.absC ? ref.c !== C : C - ref.c < rg.c1 || C - ref.c > rg.c2) continue;
            if (!ref.absR) {
              const r = R - ref.r;
              if (r >= rg.r1 && r <= rg.r2) out.add(r);
            } else if (ref.r === R) {
              for (let r = rg.r1, end = Math.min(rg.r2, maxRow - 1); r <= end; r++) out.add(r);
            }
          }
        }
      }
    }
    return out;
  }

  // ---- The grid --------------------------------------------------------------

  function create(payload, opts = {}) {
    const gid = ++SEQ;
    const el = document.createElement('div');
    el.className = 'sg';
    el.dataset.grid = String(gid);
    el.innerHTML = '<div class="sg-fbar"><div class="sg-name" aria-label="Selected cell"></div>'
      + '<div class="sg-fx" aria-hidden="true">fx</div>'
      + '<textarea class="sg-fval" rows="1" wrap="soft" readonly aria-label="Cell contents" autocomplete="off"'
      + ' autocorrect="off" autocapitalize="off" spellcheck="false"></textarea></div>'
      + '<div class="sg-scroll"></div>'
      + '<div class="sg-tabs" role="tablist" aria-label="Sheets"></div>'
      + '<textarea class="sg-sink" inputmode="none" aria-label="Spreadsheet cells" autocomplete="off"'
      + ' autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>'
      + '<textarea class="sg-editor" hidden rows="1" enterkeyhint="done" aria-label="Edit cell" autocomplete="off"'
      + ' autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>'
      + `<button type="button" class="sg-ddbtn" hidden tabindex="-1" aria-label="Show the list" aria-haspopup="listbox"`
      + ` aria-controls="sg-${gid}-list" aria-expanded="false">${CHEVRON}</button>`
      + `<div class="sg-list" id="sg-${gid}-list" hidden role="listbox" aria-label="Choices"></div>`
      + '<div class="sg-menu" hidden role="menu" aria-label="Rows and cells"></div>';
    const nameEl = el.querySelector('.sg-name');
    const fval = el.querySelector('.sg-fval');
    const scroll = el.querySelector('.sg-scroll');
    const tabsEl = el.querySelector('.sg-tabs');
    const sink = el.querySelector('.sg-sink');
    const ed = el.querySelector('.sg-editor');
    const ddBtn = el.querySelector('.sg-ddbtn');
    const listEl = el.querySelector('.sg-list');
    const menuEl = el.querySelector('.sg-menu');

    // base: each sheet as the server sent it (plus any undo steps folded in past UNDO_MAX); sheets: base with
    // every edit applied. H: the undo steps, groups { si, ops, rows (has a row op), before, after (view snapshots) }.
    const G = { payload: null, base: [], sheets: [], cur: 0, views: [], editable: !!opts.editable, wantFocus: false, lastFocus: sink,
      told: new Set(), hinted: false };
    const H = createHistory(UNDO_MAX);
    let E = null;      // the edit in progress: { si, r, c, mode: 'enter' | 'edit', list }
    let LP = null;     // the list popup: { list, r, c, shown: [{ t, i }], hi }
    let MENU = null;   // the row menu: { returnFocus }

    const say = (msg) => (opts.toast || window.toast)(msg);
    const coarse = () => window.matchMedia('(pointer: coarse)').matches;
    function freshView(i) {
      return { i, table: null, L: null, R: null, rows: null, done: 0, gen: 0, spacer: null, cellMaps: new Map(), heads: null, frs: [], marked: [],
        top: 0, left: 0, frozenH: 0, frozenW: 0, widths: null,
        act: { r: 0, c: 0 }, anc: { r: 0, c: 0 }, foc: { r: 0, c: 0 } };
    }
    // Forget a view's drawing (the next showSheet draws it again from the model); keep where it was.
    function resetView(v) {
      v.gen++;
      if (v.table) ro.unobserve(v.table);
      Object.assign(v, { table: null, L: null, R: null, rows: null, done: 0, spacer: null, cellMaps: new Map(), heads: null, frs: [], marked: [] });
    }
    const sheet = () => G.sheets[G.cur];
    const view = () => G.views[G.cur];
    const spareOf = () => (G.editable ? { r: SPARE_ROWS, c: SPARE_COLS } : { r: 0, c: 0 });

    // ---- Drawing ----

    function renderTabs() {
      el.classList.toggle('sg-csv', G.payload.kind === 'csv');
      el.classList.toggle('sg-xlsx', G.payload.kind !== 'csv');
      tabsEl.innerHTML = G.payload.kind === 'csv' ? '' : G.sheets.map((s, i) =>
        `<button type="button" role="tab" class="sg-tab${i === G.cur ? ' on' : ''}" data-i="${i}" aria-selected="${i === G.cur}">${esc(s.name)}</button>`).join('');
    }

    function build(v, s) {
      if (s.tooBig || !s.cells) {
        const box = document.createElement('div');
        box.className = 'sg-big';
        const size = `${esc(s.name)}: ${(s.rowCount || 0).toLocaleString()} rows × ${(s.colCount || 0).toLocaleString()} columns`;
        // When no sheet can be drawn, the host's banner above the grid already says so and offers Download
        // (opts.bigBanner): only the size is left to say here.
        box.innerHTML = opts.bigBanner && G.sheets.every((x) => x.tooBig || !x.cells) ? `<p>${size}</p>`
          : '<p><b>Too large for the grid</b></p>'
          + `<p>${size} · download the file to open it in Excel</p>`
          + (opts.onDownload ? '<p><button type="button" class="ghost sg-big-dl">Download</button></p>' : '');
        const dl = box.querySelector('.sg-big-dl');
        if (dl) dl.addEventListener('click', () => opts.onDownload());
        v.table = box;
        v.L = null;
        return;
      }
      const spare = spareOf();
      if (!v.widths) v.widths = G.payload.kind === 'csv' ? fitWidths(s, Math.max((s.colCount || 0) + spare.c, 1)) : (s.colWidths || []);
      v.L = layoutOf(s, v.widths, spare);
      v.R = sheetRenderer(() => G.sheets[v.i], v.L);
      const first = batchEnd(v.L, 0, Math.max(v.L.FR + 1, FIRST_ROWS, Math.ceil(FIRST_CELLS / Math.max(1, v.L.vcols.length))));
      const holder = document.createElement('div');
      holder.innerHTML = v.R.open + v.R.rows(0, first) + v.R.spacer(first) + v.R.close;
      v.table = holder.firstChild;
      v.done = first;
      v.spacer = v.table.querySelector('tbody > tr.sg-spacer');
      v.rows = new Map();
      for (const tr of v.table.tBodies[0].rows) if (tr.dataset.r) v.rows.set(Number(tr.dataset.r), tr);
      if (v.spacer) schedule(v);
      v.cellMaps = new Map();
      v.heads = new Map();
      for (const th of v.table.tHead.rows[0].cells) if (th.dataset.c) v.heads.set(Number(th.dataset.c), th);
      v.frs = [...v.table.querySelectorAll('tbody tr.sg-fr')];
      v.marked = [];
      if (v.frs.length) ro.observe(v.table);   // wrapped frozen rows change height as fonts load
      const a1 = { r: v.L.vrows[0] || 0, c: v.L.vcols[0] || 0 };
      if (!v.placed) { v.act = { ...a1 }; v.anc = { ...a1 }; v.foc = { ...a1 }; v.placed = true; }
      clampView(v);
    }

    // The rows after the first screenful go in a batch at a time, between other work, so a big sheet shows at
    // once and the page stays responsive while the rest arrives. Anything that needs a row not drawn yet
    // (moving to it, scrolling back to where you were) draws the rest straight away: flush().
    function appendRows(v, upto) {
      const end = batchEnd(v.L, v.done, upto);
      if (!v.spacer || end <= v.done) return;
      const from = v.done;
      const body = v.table.tBodies[0];
      const before = body.rows.length - 1;   // the spacer is last
      v.spacer.insertAdjacentHTML('beforebegin', v.R.rows(from, end));
      for (let i = before; i < body.rows.length - 1; i++) v.rows.set(Number(body.rows[i].dataset.r), body.rows[i]);
      v.done = end;
      if (end < v.L.vrows.length) v.spacer.cells[0].style.height = v.R.restHeight(end) + 'px';
      else { v.spacer.remove(); v.spacer = null; }
      if (v === view() && v.marked.length && rangeOf(v).r2 >= v.L.vrows[from]) paint();   // the selection reaches into them
    }
    // One batch a frame, the first after the first screenful has been painted.
    function schedule(v) {
      const gen = v.gen;
      requestAnimationFrame(() => setTimeout(() => {
        if (v.gen !== gen || !G.views.includes(v) || !v.spacer) return;   // flushed, reloaded or destroyed meanwhile
        appendRows(v, v.done + Math.max(20, Math.floor(BATCH_CELLS / Math.max(1, v.L.vcols.length))));
        if (v.spacer) schedule(v);
      }, 0));
    }
    function flush(v) {
      if (!v.spacer) return;
      v.gen++;
      appendRows(v, Infinity);
    }
    // Back to where this sheet was scrolled: a position past the drawn rows needs the rest of them first.
    function restoreScroll(v) {
      if (v.spacer && scroll.clientHeight && v.top + scroll.clientHeight > v.spacer.offsetTop) flush(v);
      scroll.scrollTop = v.top;
      scroll.scrollLeft = v.left;
    }

    function showSheet(i) {
      G.cur = Math.max(0, Math.min(i, G.sheets.length - 1));
      const v = view();
      if (!v.table) build(v, sheet());
      if (scroll.firstChild !== v.table) scroll.replaceChildren(v.table);
      for (const b of tabsEl.querySelectorAll('.sg-tab')) {
        const on = Number(b.dataset.i) === G.cur;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      }
      measure();
      restoreScroll(v);
      paint();
    }
    // Draw sheet si again from its model (after a row insert/delete, an undo of one, or edit mode changing
    // the spare rows), keeping its scroll position and selection.
    function rebuild(si) {
      resetView(G.views[si]);
      if (si === G.cur) showSheet(si);
    }

    // Frozen panes: rows stick at the offset they were drawn at (measured, since wrapped rows grow), columns
    // at their drawn left (known from the widths). A pane bigger than 60% of the box would leave nothing to
    // scroll — on a phone, mostly — so it scrolls like any other row/column instead.
    function measure() {
      const v = view();
      if (!v || !v.L || !el.isConnected || !scroll.clientHeight) return;
      const headH = v.table.tHead.rows[0].offsetHeight;
      let bottom = headH;
      for (const tr of v.frs) {
        tr.style.setProperty('--sgt', tr.offsetTop + 'px');
        bottom = tr.offsetTop + tr.offsetHeight;
      }
      const tallFreeze = v.frs.length > 0 && bottom > scroll.clientHeight * 0.6;
      for (const tr of v.frs) tr.classList.toggle('sg-fr', !tallFreeze);
      v.headH = headH;
      v.frozenH = tallFreeze ? headH : bottom;
      const wideFreeze = v.L.FC > 0 && v.L.frozenRight > scroll.clientWidth * 0.6;
      v.table.classList.toggle('sg-nofc', wideFreeze);
      v.frozenW = wideFreeze ? v.L.rnW : v.L.frozenRight;
    }
    let measureQueued = false;
    const ro = new ResizeObserver(() => {
      if (measureQueued) return;
      measureQueued = true;
      requestAnimationFrame(() => {
        measureQueued = false;
        measure();
        if (E && E.si === G.cur && document.activeElement === ed) reveal();   // a phone keyboard came up over it
        fitBar();   // a new width rewraps the bar's text
        placeOverlays();
      });
    });
    ro.observe(scroll);

    // ---- Cells and the selection ----

    function cellEl(v, r, c) {
      let map = v.cellMaps.get(r);
      if (!map) {
        const tr = v.rows.get(r);
        if (!tr) return null;
        map = new Map();
        for (const td of tr.cells) if (td.tagName === 'TD') map.set(Number(td.dataset.c), td);
        v.cellMaps.set(r, map);
      }
      return map.get(c) || null;
    }

    function mergeAt(L, r, c) {
      for (const m of L.merges) if (m.r1 <= r && r <= m.r2 && m.c1 <= c && c <= m.c2) return m;
      return null;
    }
    // The cell a position is drawn in: itself, or its merge's drawn (first visible) cell.
    function master(L, p) {
      const m = mergeAt(L, p.r, p.c);
      if (!m) return { r: p.r, c: p.c };
      for (const [key, info] of L.masters) if (info.m === m) { const [r, c] = key.split(',').map(Number); return { r, c }; }
      return { r: p.r, c: p.c };
    }
    // The anchor..focus rectangle, grown until no merge sticks out of it.
    function rangeOf(v) {
      const rg = { r1: Math.min(v.anc.r, v.foc.r), r2: Math.max(v.anc.r, v.foc.r), c1: Math.min(v.anc.c, v.foc.c), c2: Math.max(v.anc.c, v.foc.c) };
      for (let grown = true; grown;) {
        grown = false;
        for (const m of v.L.merges) {
          if (m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2) continue;
          if (m.r1 < rg.r1) { rg.r1 = m.r1; grown = true; }
          if (m.r2 > rg.r2) { rg.r2 = m.r2; grown = true; }
          if (m.c1 < rg.c1) { rg.c1 = m.c1; grown = true; }
          if (m.c2 > rg.c2) { rg.c2 = m.c2; grown = true; }
        }
      }
      return rg;
    }
    // Just the active cell (or its merge) selected?
    function single(v) {
      const rg = rangeOf(v);
      const am = mergeAt(v.L, v.act.r, v.act.c);
      return am ? rg.r1 === am.r1 && rg.r2 === am.r2 && rg.c1 === am.c1 && rg.c2 === am.c2
        : rg.r1 === rg.r2 && rg.c1 === rg.c2;
    }
    function clampView(v) {
      const L = v.L;
      if (!L) return;
      const fix = (p) => {
        let r = Math.min(Math.max(p.r, 0), L.nR - 1), c = Math.min(Math.max(p.c, 0), L.nC - 1);
        if (L.rIdx[r] < 0) r = nearest(L.rIdx, L.vrows, r);
        if (L.cIdx[c] < 0) c = nearest(L.cIdx, L.vcols, c);
        return { r, c };
      };
      v.act = master(L, fix(v.act));
      v.anc = fix(v.anc);
      v.foc = fix(v.foc);
    }
    function nearest(idx, list, i) {
      for (let k = i; k < idx.length; k++) if (idx[k] >= 0) return k;
      for (let k = i; k >= 0; k--) if (idx[k] >= 0) return k;
      return list[0] || 0;
    }

    function paint() {
      const v = view();
      for (const e of v.marked) e.classList.remove('sg-sel', 'sg-act', 'sg-hsel');
      v.marked = [];
      el.classList.toggle('sg-nogrid', !v.L);   // a sheet too big to draw: no formula bar (styles.css)
      if (!v.L) { nameEl.textContent = ''; fval.value = ''; fval.readOnly = true; fitBar(); placeOverlays(); return; }
      const L = v.L;
      const rg = rangeOf(v);
      const one = single(v);
      const mark = (e, cls) => { if (e) { e.classList.add(cls); v.marked.push(e); } };
      const rows = L.vrows.filter((r) => r >= rg.r1 && r <= rg.r2);
      const cols = L.vcols.filter((c) => c >= rg.c1 && c <= rg.c2);
      if (!one) {
        for (const r of rows) for (const c of cols) if (r !== v.act.r || c !== v.act.c) mark(cellEl(v, r, c), 'sg-sel');
      }
      mark(cellEl(v, v.act.r, v.act.c), 'sg-act');
      for (const c of cols) mark(v.heads.get(c), 'sg-hsel');
      for (const r of rows) { const tr = v.rows.get(r); mark(tr && tr.cells[0], 'sg-hsel'); }
      nameEl.textContent = Core.colName(v.act.c) + (v.act.r + 1);
      if (LP && (LP.r !== v.act.r || LP.c !== v.act.c || !one)) closeList();
      paintBar();
      placeOverlays();
      announce();
    }
    // The sink has the keyboard, so its name is what a screen reader reads out: the active cell and its text
    // ("F4, Open"), plus the range when more is selected. Set once the selection stops moving (SAY_MS), so
    // holding an arrow key doesn't read out every cell on the way.
    let sayTimer = 0;
    function announce() {
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => {
        const v = view();
        if (!v || !v.L) return;
        const at = (p) => Core.colName(p.c) + (p.r + 1);
        let t = String(text(v.act.r, v.act.c) || '').replace(/\s+/g, ' ').trim();
        if (t.length > 120) t = t.slice(0, 120) + '…';
        const rg = rangeOf(v);
        const label = `${at(v.act)}, ${t || 'blank'}`
          + (single(v) ? '' : `, ${at({ r: rg.r1, c: rg.c1 })} to ${at({ r: rg.r2, c: rg.c2 })} selected`);
        if (sink.getAttribute('aria-label') !== label) sink.setAttribute('aria-label', label);
      }, SAY_MS);
    }
    // The formula bar: the active cell's full text (its formula, if it has one); typing in it edits the cell.
    function paintBar() {
      const v = view();
      if (!v || !v.L) return;
      if (E) { fval.readOnly = false; fitBar(); return; }
      const cell = (sheet().cells || {})[v.act.r + ',' + v.act.c];
      const full = !cell ? '' : cell.f || (cell.e !== undefined ? cell.e : cell.t || '');
      if (fval.value !== full) fval.value = full;
      fval.title = full;
      fval.readOnly = !G.editable || !!lockOf(G.cur, v.act.r, v.act.c);
      fitBar();
    }
    // The bar is as tall as its text, up to its CSS max-height (then it scrolls inside), so a long or
    // multi-line cell can be read in full. The grid below gives up that height: keep the active cell in
    // view and the editor and list button over their cell.
    // Growing it moves the grid down, so right after a press it waits (holdBar): otherwise the second press of a
    // double-click on a long cell lands on whatever cell is now under the pointer, and edits that one.
    let barHold = 0;
    function holdBar() {
      clearTimeout(barHold);
      barHold = setTimeout(() => { barHold = 0; fitBar(); }, BAR_HOLD_MS);
    }
    function fitBar() {
      if (barHold) return;
      const was = fval.style.height;
      fval.style.height = '';   // the one-line height from the stylesheet, to measure against
      const one = fval.offsetHeight;
      const max = parseFloat(getComputedStyle(fval).maxHeight) || one;
      fval.style.height = fval.scrollHeight > one + 1 ? Math.min(fval.scrollHeight, max) + 'px' : '';
      if (fval.style.height === was) return;
      const v = view();
      if (v && v.L) reveal();
      placeOverlays();
    }

    // A cell's box in table coordinates (px from the table's top-left corner, as laid out, i.e. where it sits
    // with nothing scrolled): the one place the grid gets cell geometry. Never a cell's own offsetTop/Left: a
    // frozen cell is position:sticky, which makes its offsetParent some box outside the grid. Rows come from
    // their <tr> (never sticky), columns from the known widths. A merge gives its whole block. stuckRow /
    // stuckCol: it is in a frozen pane that is holding still, so scrolling that way never moves it. null for
    // a cell that isn't drawn (a hidden row or column, outside a merge that shows).
    function cellBox(r, c) {
      const v = view();
      const L = v && v.L;
      if (!L || !(r >= 0 && r < L.nR && c >= 0 && c < L.nC)) return null;
      const at = master(L, { r, c });
      if (L.rIdx[at.r] < 0 || L.cIdx[at.c] < 0) return null;
      const m = mergeAt(L, at.r, at.c);
      if (!v.rows.has(at.r)) flush(v);
      const tr = v.rows.get(at.r);
      if (!tr) return null;
      const lastR = m ? lastVisible(L.rIdx, m.r1, m.r2) : at.r;
      const lastC = m ? lastVisible(L.cIdx, m.c1, m.c2) : at.c;
      const end = v.rows.get(lastR) || tr;
      const top = tr.offsetTop;
      const left = L.colLeft[at.c];
      return {
        r: at.r, c: at.c, top, left,
        width: L.colLeft[lastC] + L.colW(lastC) - left,
        height: end.offsetTop + end.offsetHeight - top,
        stuckRow: at.r < L.FR && !(m && m.r2 >= L.FR) && tr.classList.contains('sg-fr'),
        stuckCol: at.c < L.FC && !(m && m.c2 >= L.FC) && !v.table.classList.contains('sg-nofc'),
      };
    }
    // The same box on screen (viewport px, for position:fixed), with the part of the scroll box it may show
    // in: below the column letters (and the frozen rows, unless it is one), right of the row numbers (and
    // the frozen columns, unless it is one), inside the scrollbars.
    function screenBox(r, c) {
      const v = view();
      const b = cellBox(r, c);
      if (!b || !scroll.clientHeight) return null;
      const sr = scroll.getBoundingClientRect();
      const ox = sr.left + scroll.clientLeft, oy = sr.top + scroll.clientTop;
      const headH = v.headH || v.table.tHead.rows[0].offsetHeight;
      return {
        x: ox + b.left - (b.stuckCol ? 0 : scroll.scrollLeft),
        y: oy + b.top - (b.stuckRow ? 0 : scroll.scrollTop),
        w: b.width, h: b.height,
        area: { left: ox + (b.stuckCol ? v.L.rnW : v.frozenW), top: oy + (b.stuckRow ? headH : v.frozenH),
          right: ox + scroll.clientWidth, bottom: oy + scroll.clientHeight },
      };
    }

    // Scroll so the active cell is in the part of the box the frozen panes don't cover — only along an axis
    // it isn't stuck on.
    function reveal() {
      const v = view();
      const b = cellBox(v.act.r, v.act.c);
      if (!b) return;
      if (!b.stuckRow) {
        if (b.top - v.frozenH < scroll.scrollTop) scroll.scrollTop = Math.max(0, b.top - v.frozenH);
        else if (b.top + b.height > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = b.top + b.height - scroll.clientHeight;
      }
      if (!b.stuckCol) {
        if (b.left - v.frozenW < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, b.left - v.frozenW);
        else if (b.left + b.width > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = b.left + b.width - scroll.clientWidth;
      }
    }

    // ---- Moving ----

    const text = (r, c) => Core.cellText(sheet(), r, c);
    // One visible step from row/column `i` in direction d (±1), stopping at the edges.
    function step(idx, list, i, d) {
      const at = idx[i] >= 0 ? idx[i] : idx[nearest(idx, list, i)];
      return list[Math.max(0, Math.min(list.length - 1, at + d))];
    }
    // Ctrl+arrow: to the end of this run of filled cells, or to the next filled cell, or to the edge.
    function edge(L, p, dr, dc) {
      const list = dr ? L.vrows : L.vcols;
      const idx = dr ? L.rIdx : L.cIdx;
      const d = dr || dc;
      const filled = (j) => (dr ? !!text(list[j], p.c) : !!text(p.r, list[j]));
      let i = idx[dr ? p.r : p.c];
      if (i < 0 || i + d < 0 || i + d >= list.length) return p;
      if (filled(i) && filled(i + d)) {
        while (i + d >= 0 && i + d < list.length && filled(i + d)) i += d;
      } else {
        i += d;
        while (i >= 0 && i < list.length && !filled(i)) i += d;
        i = Math.max(0, Math.min(list.length - 1, i));
      }
      return dr ? { r: list[i], c: p.c } : { r: p.r, c: list[i] };
    }
    // From p, leaving its merge on the side it moves out of.
    function stepFrom(L, p, dr, dc, ctrl) {
      if (ctrl) return edge(L, p, dr, dc);
      const m = mergeAt(L, p.r, p.c);
      let { r, c } = p;
      if (m) { if (dr > 0) r = m.r2; if (dr < 0) r = m.r1; if (dc > 0) c = m.c2; if (dc < 0) c = m.c1; }
      if (dr) r = step(L.rIdx, L.vrows, r, dr);
      if (dc) c = step(L.cIdx, L.vcols, c, dc);
      return { r, c };
    }

    function collapseTo(p) {
      const v = view();
      const at = master(v.L, p);
      v.act = at;
      v.anc = { ...at };
      v.foc = { ...at };
      paint();
      reveal();
    }
    function extendTo(p) {
      const v = view();
      v.foc = { r: p.r, c: p.c };
      paint();
    }

    function nav(dr, dc, e) {
      const v = view();
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.shiftKey) {
        v.foc = stepFrom(v.L, v.foc, dr, dc, ctrl);
        paint();
        revealPoint(v.foc);
      } else {
        collapseTo(stepFrom(v.L, v.act, dr, dc, ctrl));
      }
    }
    function revealPoint(p) {
      const v = view();
      const keep = v.act;
      v.act = master(v.L, p);
      reveal();
      v.act = keep;
    }
    function page(d, shift) {
      const v = view();
      const L = v.L;
      const rowH = sheet().defaultRowHeight > 0 ? sheet().defaultRowHeight : 20;
      const n = Math.max(1, Math.floor((scroll.clientHeight - v.frozenH) / rowH));
      const from = shift ? v.foc : v.act;
      const to = { r: step(L.rIdx, L.vrows, from.r, d * n), c: from.c };
      scroll.scrollTop += d * n * rowH;
      if (shift) { v.foc = to; paint(); revealPoint(to); } else collapseTo(to);
    }
    function selectAll() {
      const v = view();
      const L = v.L;
      if (!L) return;
      v.anc = { r: L.vrows[0], c: L.vcols[0] };
      v.foc = { r: L.vrows[L.vrows.length - 1], c: L.vcols[L.vcols.length - 1] };
      paint();
    }
    function goTo(p, shift) {
      if (shift) { view().foc = p; paint(); revealPoint(p); } else collapseTo(p);
    }

    // ---- Locks and hints ----

    // Why (si, r, c) can't be changed, or null: a view-only file or sheet, an Excel table's header or totals row
    // (the server's `locked` rectangles, each with its reason), a formula, a merged cell's other cells.
    function lockOf(si, r, c) {
      const s = G.sheets[si];
      if (!G.payload.editable) return { kind: 'file', msg: G.payload.reason || MSG.view };
      if (s.readOnly) return { kind: 'sheet', msg: s.readOnly };
      const table = (s.locked || []).find((l) => l.r1 <= r && r <= l.r2 && l.c1 <= c && c <= l.c2);
      if (table) return { kind: 'table:' + (table.msg || MSG.table), msg: table.msg || MSG.table };
      const cell = s.cells && s.cells[r + ',' + c];
      if (cell && cell.f) return { kind: 'formula', msg: MSG.formula };
      const m = modelMergeAt(s, r, c);
      if (m && (m.r1 !== r || m.c1 !== c)) return { kind: 'merge', msg: MSG.merge };
      return null;
    }
    // Said once per kind of lock per grid: a key held down on a formula cell doesn't stack up toasts.
    function refuse(lock) {
      if (G.told.has(lock.kind)) return;
      G.told.add(lock.kind);
      say(lock.msg);
    }
    // A change tried in view mode: say how to edit, once per grid.
    function viewHint() {
      if (G.hinted) return;
      G.hinted = true;
      say(G.payload.editable ? MSG.view : G.payload.reason || MSG.view);
    }

    // ---- Changes: groups of ops, undo and redo ----

    function snap() {
      const v = view();
      const live = v.L && scroll.clientHeight;
      return { cur: G.cur, act: { ...v.act }, anc: { ...v.anc }, foc: { ...v.foc },
        top: live ? scroll.scrollTop : v.top, left: live ? scroll.scrollLeft : v.left };
    }
    function restoreSnap(sn) {
      if (sn.cur !== G.cur) showSheet(sn.cur);
      const v = view();
      Object.assign(v, { act: { ...sn.act }, anc: { ...sn.anc }, foc: { ...sn.foc }, top: sn.top, left: sn.left });
      clampView(v);
      if (v.L) restoreScroll(v);
      paint();
    }
    const changed = () => { if (opts.onChange) opts.onChange(api); };
    const keysOf = (ops) => new Set(ops.filter((o) => o.op === 'set').map((o) => o.r + ',' + o.c));

    // One undo step: apply `ops` to sheet si's current model and redraw what changed. `adjust(v)` moves the
    // selection afterwards (before the view snapshot redo goes back to).
    function applyGroup(si, ops, adjust) {
      if (!ops.length) return false;
      const before = snap();
      const old = G.sheets[si];
      let next;
      try { next = Core.applyOps(old, ops); } catch (err) { say(err.message); return false; }
      G.sheets[si] = next;
      const g = { si, ops, rows: ops.some((o) => o.op !== 'set'), before, after: null };
      fold(H.add(g));
      if (adjust) adjust(G.views[si]);
      if (g.rows) rebuild(si); else redrawCells(si, old, next, keysOf(ops));
      if (si === G.cur) paint();
      g.after = snap();
      changed();
      return true;
    }
    // Past UNDO_MAX the oldest steps can't be undone any more: they become part of the base the others replay on.
    function fold(groups) {
      for (const g of groups) G.base[g.si] = Core.applyOps(G.base[g.si], g.ops);
    }
    function undo() {
      const step = H.undo();
      if (!step) return;
      if (step.paused) { say(MSG.paused); return; }
      const g = step.group;
      closeList();
      const old = G.sheets[g.si];
      const ops = H.applied(g.si);
      G.sheets[g.si] = ops.length ? Core.applyOps(G.base[g.si], ops) : G.base[g.si];
      if (g.rows) rebuild(g.si); else redrawCells(g.si, old, G.sheets[g.si], keysOf(g.ops));
      restoreSnap(g.before);
      changed();
    }
    function redo() {
      const step = H.redo();
      if (!step) return;
      const g = step.group;
      fold(step.folded);
      closeList();
      const old = G.sheets[g.si];
      G.sheets[g.si] = Core.applyOps(old, g.ops);
      if (g.rows) rebuild(g.si); else redrawCells(g.si, old, G.sheets[g.si], keysOf(g.ops));
      restoreSnap(g.after);
      changed();
    }

    // After cells `keys` of sheet si changed (old → next model): redraw the rows they are in, and the rows
    // whose conditional formats read them, in place. A sheet that grew past what's drawn gets its new rows
    // appended; one that grew a column is drawn again.
    function redrawCells(si, old, next, keys) {
      const v = G.views[si];
      if (!v.table || !v.L) return;                            // drawn from the model when it is shown
      const L = v.L;
      const wantC = Math.max((next.colCount || 0) + (L.spare ? SPARE_COLS : 0), 1);
      if (wantC > L.nC) { rebuild(si); return; }
      if (growRows(v, next) === 'rebuilt') return;
      const rows = new Set();
      for (const key of keys) rows.add(splitKey(key).r);
      for (const r of cfRows(next, keys, v.L.nR)) rows.add(r);
      let frozen = false;
      for (const r of rows) if (redrawRow(v, r) === 'frozen') frozen = true;
      if (v.L.spare) {
        for (const [c, th] of v.heads) th.classList.toggle('sg-spare', c >= (next.colCount || 0));
        const lo = Math.min(old.rowCount || 0, next.rowCount || 0), hi = Math.max(old.rowCount || 0, next.rowCount || 0);
        for (let r = lo; r < hi; r++) { const tr = v.rows.get(r); if (tr) tr.cells[0].classList.toggle('sg-spare', r >= (next.rowCount || 0)); }
      }
      if (frozen && si === G.cur) measure();
    }
    function redrawRow(v, r) {
      const ri = v.L.rIdx[r];
      const old = v.rows.get(r);
      if (ri < 0 || !old) return false;                        // not drawn yet: drawn from the model later
      const holder = document.createElement('tbody');
      holder.innerHTML = v.R.rows(ri, ri + 1);
      const tr = holder.firstElementChild;
      old.replaceWith(tr);
      v.rows.set(r, tr);
      v.cellMaps.delete(r);
      const k = v.frs.indexOf(old);
      if (k < 0) return true;
      v.frs[k] = tr;
      return 'frozen';
    }
    // Edit mode keeps SPARE_ROWS blank rows past the data: a sheet that grew into them gets more, appended
    // to what's drawn (or left to the batches still to come). Drawn again when the row numbers get wider.
    function growRows(v, next) {
      const want = Math.max((next.rowCount || 0) + (v.L.spare ? SPARE_ROWS : 0), 1);
      if (want <= v.L.nR) return false;
      const L2 = layoutOf(next, v.widths, spareOf());
      if (L2.rnW !== v.L.rnW || L2.vcols.length !== v.L.vcols.length) { rebuild(v.i); return 'rebuilt'; }
      const from = v.L.vrows.length;
      v.L = L2;
      v.R = sheetRenderer(() => G.sheets[v.i], L2);
      if (v.spacer) {
        v.spacer.cells[0].style.height = v.R.restHeight(v.done) + 'px';
      } else {
        const holder = document.createElement('tbody');
        holder.innerHTML = v.R.rows(from, L2.vrows.length);
        const body = v.table.tBodies[0];
        for (const tr of [...holder.rows]) { body.appendChild(tr); v.rows.set(Number(tr.dataset.r), tr); }
        v.done = L2.vrows.length;
      }
      return true;
    }

    // ---- The editor ----

    // Start editing the active cell: 'enter' (a typed key replaced the text; arrows commit and move) or
    // 'edit' (F2, double-click: the text is kept and arrows move the caret).
    function openEditor(mode, initial, { focus = true } = {}) {
      const v = view();
      if (!v.L || !G.editable) return false;
      const lock = lockOf(G.cur, v.act.r, v.act.c);
      if (lock) { refuse(lock); return false; }
      closeMenu();
      const s = sheet();
      E = { si: G.cur, r: v.act.r, c: v.act.c, mode, list: listAt(s, v.act.r, v.act.c), orig: editTextOf(s, v.act.r, v.act.c) };
      reveal();
      styleEditor();
      ed.value = initial === undefined ? E.orig : initial;
      fval.value = ed.value;
      fval.readOnly = false;
      ed.hidden = false;
      el.classList.add('sg-editing');
      placeEditor();
      if (focus) {
        ed.focus({ preventScroll: true });
        const n = ed.value.length;
        ed.setSelectionRange(n, n);
      }
      if (LP) renderList();
      changed();                                               // a draft now exists (hasDraft)
      return true;
    }
    // The editor takes the cell's look: font, the colours the file (or a conditional format) gives it,
    // alignment, wrapping. Colours the cell only has from the theme stay with the stylesheet, so they follow
    // a theme switch. On a touch screen the text is at least 16px, or iOS zooms the page in on focus.
    function styleEditor() {
      const v = view();
      if (!cellBox(E.r, E.c)) return;
      const at = master(v.L, E);
      const td = cellEl(v, at.r, at.c);
      if (!td) return;
      const cs = getComputedStyle(td);
      const size = parseFloat(cs.fontSize) || 13;
      Object.assign(ed.style, {
        fontFamily: cs.fontFamily, fontSize: (coarse() ? Math.max(16, size) : size) + 'px', fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle, color: td.style.color || '', backgroundColor: td.style.backgroundColor || '',
        textAlign: /^(center|right|end)$/.test(cs.textAlign) ? cs.textAlign : 'left',
      });
      E.wrap = cs.whiteSpace !== 'nowrap';
      ed.wrap = E.wrap ? 'soft' : 'off';
      ed.classList.toggle('sg-ed-wrap', E.wrap);
    }
    // Over the cell, growing with its text (to the right for a cell that doesn't wrap, then down), clipped to
    // the part of the grid the cell can show in, so it never floats over the headers or frozen panes.
    function placeEditor() {
      if (!E) return;
      const g = E.si === G.cur ? screenBox(E.r, E.c) : null;
      if (!g) { ed.style.visibility = 'hidden'; return; }
      ed.style.visibility = '';
      ed.style.left = g.x + 'px';
      ed.style.top = g.y + 'px';
      ed.style.width = g.w + 'px';
      ed.style.height = g.h + 'px';
      let w = g.w, h = g.h;
      if (!E.wrap && ed.scrollWidth > ed.clientWidth + 1) {
        w = Math.max(g.w, Math.min(ed.scrollWidth + 4, g.area.right - g.x));
        ed.style.width = w + 'px';
      }
      if (ed.scrollHeight > ed.clientHeight + 1) {
        h = Math.max(g.h, ed.scrollHeight + 2);
        ed.style.height = h + 'px';
      }
      const clip = [Math.max(0, g.area.top - g.y), Math.max(0, g.x + w - g.area.right), Math.max(0, g.y + h - g.area.bottom), Math.max(0, g.area.left - g.x)];
      ed.style.clipPath = clip.some((n) => n > 0) ? `inset(${clip.map((n) => n + 'px').join(' ')})` : '';
    }
    function placeOverlays() {
      placeEditor();
      placeDd();
      placeList();
    }

    // Commit the edit in progress: false (and the editor stays open) when a strict list refuses the text.
    function commitEdit() {
      if (!E) return true;
      let val = ed.value;
      if (E.list) {
        if (val.trim() === '') val = '';
        else {
          const item = Core.matchListItem(E.list.items, val);
          if (item !== null) val = item;
          else if (E.list.strict) {
            say(`“${val}” isn't in the list: ${E.list.items.join(', ')}`);
            if (document.activeElement !== fval) ed.focus({ preventScroll: true });
            return false;
          }
        }
      }
      if (val.length > CELL_MAX) {
        say(MSG.tooLong);
        if (document.activeElement !== fval) ed.focus({ preventScroll: true });
        return false;
      }
      const { si, r, c } = E;
      const hadFocus = document.activeElement === ed || document.activeElement === fval;
      const s = G.sheets[si];
      const change = val !== editTextOf(s, r, c);
      closeEditor({ quiet: change });                          // a change says so itself (applyGroup)
      if (hadFocus) focusSink();
      if (!change) { if (si === G.cur) paint(); return true; }
      if (!applyGroup(si, [{ op: 'set', sheet: s.index, r, c, v: val }])) changed();
      return true;
    }
    function cancelEdit() {
      const hadFocus = document.activeElement === ed || document.activeElement === fval;
      closeEditor();
      if (hadFocus) focusSink();
      paint();
    }
    // Close the editor without committing. The draft is gone, so onChange is told (unless `quiet`: the
    // caller is about to apply a change, which tells it anyway).
    function closeEditor({ quiet = false } = {}) {
      const had = !!E;
      E = null;
      ed.hidden = true;
      ed.value = '';
      ed.style.clipPath = '';
      el.classList.remove('sg-editing');
      closeList();
      paintBar();
      if (had && !quiet) changed();
    }
    // Commit, then move like Excel: Enter ↓, Shift+Enter ↑, Tab →, Shift+Tab ←.
    function commitAndMove(dr, dc) {
      if (!commitEdit()) return;
      const v = view();
      if (v.L) collapseTo(stepFrom(v.L, v.act, dr, dc, false));
    }
    function insertNewline(src) {
      src.setRangeText('\n', src.selectionStart, src.selectionEnd, 'end');
      edInput(src);
    }
    function edInput(src) {
      if (src === fval) {
        if (!E && !openEditor('edit', fval.value, { focus: false })) { paintBar(); return; }
        ed.value = fval.value;
      } else fval.value = ed.value;
      fitBar();
      placeEditor();
      if (LP) renderList();
    }
    ed.addEventListener('input', () => edInput(ed));
    fval.addEventListener('input', () => edInput(fval));

    function edKey(e, src) {
      if (e.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (commitEdit()) requestSave(); return; }
      if (!E) {
        // The formula bar with nothing typed into it yet: Enter/Tab move on as in the grid, Esc goes back to it.
        if (src !== fval || !/^(Enter|Tab|Escape)$/.test(e.key) || (e.key === 'Enter' && e.altKey)) return;
        e.preventDefault();
        focusSink();
        const v = view();
        if (e.key !== 'Escape' && v.L) collapseTo(stepFrom(v.L, v.act, e.key === 'Enter' ? (e.shiftKey ? -1 : 1) : 0, e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : 0, false));
        return;
      }
      if (LP && listKey(e)) return;
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          if (e.altKey) insertNewline(src);
          else commitAndMove(e.shiftKey ? -1 : 1, 0);
          return;
        case 'Tab':
          e.preventDefault();
          commitAndMove(0, e.shiftKey ? -1 : 1);
          return;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          cancelEdit();
          return;
        case 'F2':
          if (src === ed) { e.preventDefault(); E.mode = E.mode === 'enter' ? 'edit' : 'enter'; }
          return;
        case 'ArrowDown': case 'ArrowUp': case 'ArrowLeft': case 'ArrowRight': {
          if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openList(); return; }
          if (src !== ed || E.mode !== 'enter' || e.altKey || ctrl) return;     // the caret moves
          e.preventDefault();
          if (!commitEdit()) return;
          const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
          nav(d[0], d[1], e);
          return;
        }
        default:
      }
    }
    ed.addEventListener('keydown', (e) => edKey(e, ed));
    fval.addEventListener('keydown', (e) => edKey(e, fval));
    function requestSave() { if (opts.onRequestSave) opts.onRequestSave(api); }

    // ---- The list (a dropdown from the file's data validation) ----

    function placeDd() {
      const v = view();
      const show = G.editable && v && v.L && single(v) && !!listAt(sheet(), v.act.r, v.act.c) && !lockOf(G.cur, v.act.r, v.act.c);
      const g = show ? screenBox(v.act.r, v.act.c) : null;
      // A finger gets at least TOUCH_MIN square, even beside a short row (it then stands a little above the
      // cell's bottom edge, or below the headers when the cell is in the first row on screen).
      const w = coarse() ? TOUCH_MIN : 18;
      const h = g ? (coarse() ? Math.min(Math.max(g.h, TOUCH_MIN), 40) : Math.min(g.h, 22)) : 0;
      // Just right of the cell, as in Excel; inside its right edge when there's no room.
      const x = g ? (g.x + g.w + w <= g.area.right ? g.x + g.w : g.x + g.w - w) : 0;
      const y = g ? Math.max(g.y + g.h - h, g.area.top) : 0;
      if (!g || x < g.area.left || g.y + g.h <= g.area.top || x + w > g.area.right || y + h > g.area.bottom) { ddBtn.hidden = true; return; }
      ddBtn.hidden = false;
      Object.assign(ddBtn.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      ddBtn.setAttribute('aria-expanded', String(!!LP));
    }
    function openList() {
      const v = view();
      if (!G.editable || !v.L) return;
      const at = E ? { r: E.r, c: E.c } : v.act;
      const list = listAt(sheet(), at.r, at.c);
      if (!list) return;
      const lock = lockOf(G.cur, at.r, at.c);
      if (lock) { refuse(lock); return; }
      closeMenu();
      const now = Core.matchListItem(list.items, E ? ed.value : editTextOf(sheet(), at.r, at.c));
      LP = { list, r: at.r, c: at.c, cur: now === null ? -1 : list.items.indexOf(now), shown: [], hi: -1 };
      renderList();
      listEl.hidden = false;
      placeList();
      placeDd();
      document.addEventListener('pointerdown', outsideList, true);
    }
    // The items, filtered by what has been typed into the editor (not by the text it started with).
    function renderList() {
      if (!LP) return;
      const q = E && ed.value !== E.orig ? ed.value.trim().toLowerCase() : '';
      LP.shown = LP.list.items.map((t, i) => ({ t, i })).filter((x) => !q || x.t.toLowerCase().includes(q));
      if (LP.hi < 0 || LP.hi >= LP.shown.length || q) {
        LP.hi = q ? (LP.shown.length ? 0 : -1) : LP.shown.findIndex((x) => x.i === LP.cur);
      }
      listEl.innerHTML = LP.shown.length
        ? LP.shown.map((x, k) => `<div class="sg-li${k === LP.hi ? ' hi' : ''}${x.i === LP.cur ? ' cur' : ''}" role="option" id="sg-${gid}-opt-${k}"`
          + ` data-item="${x.i}" aria-selected="${k === LP.hi}">${esc(x.t)}</div>`).join('')
        : '<div class="sg-li-none" role="option" aria-disabled="true">No match</div>';
      pointAt();
      placeList();
    }
    // The keyboard stays in the cell (the sink, the editor or the formula bar) while the list is open, so that
    // box says which choice is highlighted (aria-activedescendant), as a combobox's input does.
    function pointAt() {
      const id = LP && LP.hi >= 0 ? `sg-${gid}-opt-${LP.hi}` : null;
      for (const box of [sink, ed, fval]) {
        if (LP) box.setAttribute('aria-controls', listEl.id); else box.removeAttribute('aria-controls');
        if (id) box.setAttribute('aria-activedescendant', id); else box.removeAttribute('aria-activedescendant');
      }
    }
    function placeList() {
      if (!LP) return;
      const g = screenBox(LP.r, LP.c);
      if (!g) { listEl.style.visibility = 'hidden'; return; }
      listEl.style.visibility = '';
      listEl.style.minWidth = Math.max(g.w, 140) + 'px';
      const box = el.getBoundingClientRect();
      const lh = listEl.offsetHeight, lw = listEl.offsetWidth;
      const below = g.y + g.h + 2;
      const y = below + lh <= box.bottom - 4 || g.y - lh - 2 < box.top ? below : g.y - lh - 2;
      listEl.style.left = Math.max(box.left + 4, Math.min(g.x, box.right - lw - 4)) + 'px';
      listEl.style.top = y + 'px';
    }
    function closeList() {
      if (!LP) return;
      LP = null;
      listEl.hidden = true;
      listEl.innerHTML = '';
      pointAt();
      document.removeEventListener('pointerdown', outsideList, true);
      placeDd();
    }
    function outsideList(e) { if (!listEl.contains(e.target) && !ddBtn.contains(e.target)) closeList(); }
    function moveHi(d) {
      if (!LP.shown.length) return;
      LP.hi = LP.hi < 0 ? (d > 0 ? 0 : LP.shown.length - 1) : Math.max(0, Math.min(LP.shown.length - 1, LP.hi + d));
      for (const [k, item] of [...listEl.querySelectorAll('.sg-li')].entries()) {
        item.classList.toggle('hi', k === LP.hi);
        item.setAttribute('aria-selected', String(k === LP.hi));
        if (k === LP.hi) item.scrollIntoView({ block: 'nearest' });
      }
      pointAt();
    }
    // ↑/↓ move through the list, Enter picks, Esc closes it, Alt+↓ toggles it; true when the key was the list's.
    function listKey(e) {
      if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); closeList(); return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveHi(e.key === 'ArrowDown' ? 1 : -1); return true; }
      if (e.key === 'Enter' && !e.altKey && LP.hi >= 0) { e.preventDefault(); pickItem(LP.shown[LP.hi].i); return true; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); return true; }
      if (e.key === 'Tab') closeList();
      return false;
    }
    // A picked item goes in as the list spells it; the active cell stays where it is.
    function pickItem(i) {
      if (!LP) return;
      const item = LP.list.items[i];
      const { r, c } = LP;
      closeList();
      if (E) { ed.value = item; commitEdit(); return; }
      const s = sheet();
      if (item !== editTextOf(s, r, c)) applyGroup(G.cur, [{ op: 'set', sheet: s.index, r, c, v: item }]);
    }
    for (const node of [listEl, ddBtn]) {
      // Clicks here never take the keyboard away from the cell (or its editor).
      node.addEventListener('pointerdown', (e) => e.preventDefault());
      node.addEventListener('mousedown', (e) => e.preventDefault());
    }
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-item]');
      if (item) pickItem(Number(item.dataset.item));
    });
    ddBtn.addEventListener('click', () => {
      if (LP) closeList(); else openList();
    });

    // ---- The row menu ----

    function openMenu(x, y) {
      closeList();
      const v = view();
      if (!v.L) return;
      const s = sheet();
      const rg = rangeOf(v);
      // Roving focus: ↑/↓/Home/End move it between the items (the menu's keydown), so none is a Tab stop.
      const item = (act, label, disabled, title) =>
        `<button type="button" role="menuitem" tabindex="-1" data-act="${act}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
      let html = '';
      if (G.editable) {
        const n = Math.min(rg.r2 - rg.r1 + 1, ROWOP_MAX);
        const nDel = Math.min(Math.min(rg.r2, (s.rowCount || 0) - 1) - rg.r1 + 1, ROWOP_MAX);
        const blocked = s.readOnly || s.rowOps;
        const past = 'There are no rows here yet';
        html += item('above', n === 1 ? 'Insert row above' : `Insert ${n} rows above`, !!blocked || rg.r1 > (s.rowCount || 0), blocked || (rg.r1 > (s.rowCount || 0) ? past : ''))
          + item('below', n === 1 ? 'Insert row below' : `Insert ${n} rows below`, !!blocked || rg.r2 >= (s.rowCount || 0), blocked || (rg.r2 >= (s.rowCount || 0) ? past : ''))
          + item('delete', nDel <= 1 ? 'Delete row' : `Delete rows ${rg.r1 + 1}–${rg.r1 + nDel}`, !!blocked || nDel < 1, blocked || (nDel < 1 ? past : ''))
          + '<div class="sg-menu-sep" role="separator"></div>';
      }
      html += item('copy', 'Copy', false, '');
      if (G.editable) html += item('clear', 'Clear contents', !!s.readOnly, s.readOnly || '');
      menuEl.innerHTML = html;
      menuEl.hidden = false;
      MENU = { };
      const box = el.getBoundingClientRect();
      const r = menuEl.getBoundingClientRect();
      menuEl.style.left = Math.max(box.left + 4, Math.min(x, box.right - r.width - 4)) + 'px';
      menuEl.style.top = Math.max(box.top + 4, y + r.height > box.bottom - 4 ? y - r.height : y) + 'px';
      const first = menuEl.querySelector('button:not([disabled])');
      if (first) first.focus({ preventScroll: true });
      document.addEventListener('pointerdown', outsideMenu, true);
    }
    function closeMenu() {
      if (!MENU) return;
      MENU = null;
      menuEl.hidden = true;
      document.removeEventListener('pointerdown', outsideMenu, true);
      if (el.contains(document.activeElement) && menuEl.contains(document.activeElement)) focusSink();
    }
    function outsideMenu(e) { if (!menuEl.contains(e.target)) closeMenu(); }
    // At the active cell, for the keyboard (Shift+F10, the context-menu key).
    function openMenuAtCell() {
      const v = view();
      const g = screenBox(v.act.r, v.act.c);
      if (g) openMenu(Math.min(g.x + 10, g.area.right), Math.min(g.y + g.h, g.area.bottom));
    }
    menuEl.addEventListener('keydown', (e) => {
      const items = [...menuEl.querySelectorAll('button:not([disabled])')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(); focusSink(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home' && items.length) { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End' && items.length) { e.preventDefault(); items[items.length - 1].focus(); }
    });
    menuEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      closeMenu();
      focusSink();
      const act = b.dataset.act;
      if (act === 'copy') copySelection();
      else if (act === 'clear') clearSelection();
      else rowOp(act);
    });

    // Insert above/below or delete the selected rows (capped at ROWOP_MAX); the new rows copy the look of the
    // row they were inserted next to (`like`). The selection lands on the new rows.
    function rowOp(kind) {
      const v = view();
      const s = sheet();
      if (!G.editable || !v.L || s.readOnly || s.rowOps) return;
      const rg = rangeOf(v);
      const n = Math.min(rg.r2 - rg.r1 + 1, ROWOP_MAX);
      const sheetIdx = s.index;
      if (kind === 'delete') {
        const nDel = Math.min(Math.min(rg.r2, (s.rowCount || 0) - 1) - rg.r1 + 1, ROWOP_MAX);
        if (nDel < 1) return;
        applyGroup(G.cur, [{ op: 'deleteRows', sheet: sheetIdx, at: rg.r1, n: nDel }]);
        return;
      }
      const at = kind === 'above' ? rg.r1 : rg.r2 + 1;
      const like = kind === 'above' ? rg.r1 : rg.r2;
      applyGroup(G.cur, [{ op: 'insertRows', sheet: sheetIdx, at, n, like }], (w) => {
        const shift = (p) => ({ r: p.r - rg.r1 + at, c: p.c });
        if (kind === 'below') { w.act = shift(w.act); w.anc = shift(w.anc); w.foc = shift(w.foc); }
        if (n !== rg.r2 - rg.r1 + 1) {                        // capped: select just the rows added
          w.anc = { r: at, c: Math.min(w.anc.c, w.foc.c) };
          w.foc = { r: at + n - 1, c: Math.max(w.anc.c, w.foc.c) };
        }
      });
    }

    // ---- Clearing, copying, pasting ----

    // The selection as TSV; in edit mode, not the blank spare rows/columns past the data.
    function selectionTsv() {
      const v = view();
      if (!v.L) return '';
      const s = sheet();
      const rg = rangeOf(v);
      const r2 = rg.r1 < (s.rowCount || 0) ? Math.min(rg.r2, s.rowCount - 1) : rg.r2;
      const c2 = rg.c1 < (s.colCount || 0) ? Math.min(rg.c2, s.colCount - 1) : rg.c2;
      const out = [];
      for (let r = rg.r1; r <= r2; r++) {
        const row = [];
        for (let c = rg.c1; c <= c2; c++) row.push(tsvField(text(r, c)));
        out.push(row.join('\t'));
      }
      return out.join('\n');
    }
    function copySelection() {
      focusSink();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* the copy listener didn't run */ }
      if (!ok && window.copyText) window.copyText(selectionTsv());
    }
    // Delete / Backspace / Clear contents / Ctrl+X: empty the selected cells that hold something and aren't
    // locked, in one undo step.
    function clearSelection() {
      const v = view();
      const s = sheet();
      if (!v.L) return;
      const rg = rangeOf(v);
      const ops = [];
      let locked = null;
      for (const key of Object.keys(s.cells || {})) {
        const { r, c } = splitKey(key);
        if (!covers(rg, r, c) || editTextOf(s, r, c) === '') continue;
        const lock = lockOf(G.cur, r, c);
        if (lock) { locked = locked || lock; continue; }
        ops.push({ op: 'set', sheet: s.index, r, c, v: '' });
      }
      if (!ops.length) { if (locked) refuse(locked); return; }
      ops.sort((a, b) => a.r - b.r || a.c - b.c);
      applyGroup(G.cur, ops);
    }
    // Paste: one value fills the selection; a block goes in from the selection's top-left, growing the sheet.
    // Locked cells are skipped (and counted), list cells take the list's spelling, unchanged cells are left.
    function paste(clip) {
      const v = view();
      const s = sheet();
      if (!v.L) return;
      if (s.readOnly) { refuse({ kind: 'sheet', msg: s.readOnly }); return; }
      const rows = parseClip(clip, PASTE_MAX);                 // stops counting past the limit
      if (!rows) { say(MSG.tooMuch); return; }
      let w = 0;
      for (const row of rows) {
        if (row.length > w) w = row.length;
        for (const t of row) if (t.length > CELL_MAX) { say(MSG.tooLong); return; }
      }
      const h = rows.length;
      if (!h || !w) return;
      const rg = rangeOf(v);
      const fill = h === 1 && w === 1;
      // One value fills the selection, but not the blank spare rows/columns past the data (a Ctrl+A).
      const r2 = rg.r1 < (s.rowCount || 0) ? Math.min(rg.r2, s.rowCount - 1) : rg.r2;
      const c2 = rg.c1 < (s.colCount || 0) ? Math.min(rg.c2, s.colCount - 1) : rg.c2;
      const R = fill ? r2 - rg.r1 + 1 : h, C = fill ? c2 - rg.c1 + 1 : w;
      if (R * C > PASTE_MAX) { say(MSG.tooMuch); return; }
      const ops = [];
      let skipped = 0;
      for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
          const r = rg.r1 + i, c = rg.c1 + j;
          let val = fill ? rows[0][0] : rows[i][j] || '';
          const lock = lockOf(G.cur, r, c);
          if (lock) { if (!(fill && lock.kind === 'merge')) skipped++; continue; }
          const list = listAt(s, r, c);
          if (list) { const item = Core.matchListItem(list.items, val); if (item !== null) val = item; }
          if (val !== editTextOf(s, r, c)) ops.push({ op: 'set', sheet: s.index, r, c, v: val });
        }
      }
      if (skipped) say(`${skipped} locked cell${skipped === 1 ? ' was' : 's were'} skipped`);
      applyGroup(G.cur, ops, fill ? null : (u) => { u.anc = { r: rg.r1, c: rg.c1 }; u.foc = { r: rg.r1 + R - 1, c: rg.c1 + C - 1 }; });
    }

    // ---- Pointer ----

    // What a pointer event landed on: a cell, a row number, a column letter or the corner.
    function hitOf(target) {
      const v = view();
      if (!v.L || !target || !target.closest) return null;
      const cellOrHead = target.closest('td, th');
      if (!cellOrHead || !v.table.contains(cellOrHead)) return null;
      if (cellOrHead.tagName === 'TD') {
        if (cellOrHead.dataset.c === undefined) return null;   // the stand-in for rows still to come
        return { kind: 'cell', r: Number(cellOrHead.parentNode.dataset.r), c: Number(cellOrHead.dataset.c) };
      }
      if (cellOrHead.classList.contains('sg-corner')) return { kind: 'all' };
      if (cellOrHead.classList.contains('sg-ch')) return { kind: 'col', c: Number(cellOrHead.dataset.c) };
      if (cellOrHead.classList.contains('sg-rh')) return { kind: 'row', r: Number(cellOrHead.parentNode.dataset.r) };
      return null;
    }
    function pick(hit, extend) {
      const v = view();
      const L = v.L;
      const firstC = L.vcols[0], lastC = L.vcols[L.vcols.length - 1];
      const firstR = L.vrows[0], lastR = L.vrows[L.vrows.length - 1];
      if (hit.kind === 'all') { selectAll(); return; }
      if (hit.kind === 'cell') {
        if (extend) extendTo(hit);
        else collapseTo(hit);
        return;
      }
      if (hit.kind === 'row') {
        if (extend) { v.anc = { r: v.anc.r, c: firstC }; v.foc = { r: hit.r, c: lastC }; }
        else { v.act = master(L, { r: hit.r, c: firstC }); v.anc = { r: hit.r, c: firstC }; v.foc = { r: hit.r, c: lastC }; }
      } else {
        if (extend) { v.anc = { r: firstR, c: v.anc.c }; v.foc = { r: lastR, c: hit.c }; }
        else { v.act = master(L, { r: firstR, c: hit.c }); v.anc = { r: firstR, c: hit.c }; v.foc = { r: lastR, c: hit.c }; }
      }
      paint();
    }
    // Is the hit already inside the selection (a right-click there keeps it)?
    function inSelection(hit) {
      const v = view();
      const rg = rangeOf(v);
      const L = v.L;
      if (hit.kind === 'cell') return covers(rg, hit.r, hit.c);
      if (hit.kind === 'row') return hit.r >= rg.r1 && hit.r <= rg.r2 && rg.c1 <= L.vcols[0] && rg.c2 >= L.vcols[L.vcols.length - 1];
      if (hit.kind === 'col') return hit.c >= rg.c1 && hit.c <= rg.c2 && rg.r1 <= L.vrows[0] && rg.r2 >= L.vrows[L.vrows.length - 1];
      return false;
    }

    let drag = null;          // { kind } while a mouse button is held over the grid
    let lastPointer = 'mouse';
    let tap = null;           // the last tapped cell { r, c, t }: a second tap on it soon after edits it
    scroll.addEventListener('pointerdown', holdBar, true);   // before the press selects anything (see fitBar)
    scroll.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType || 'mouse';
      if (lastPointer !== 'mouse' || e.button !== 0) return;   // a finger selects on tap (click), and drags scroll
      const hit = hitOf(e.target);
      if (!hit) return;
      if (E && !commitEdit()) return;                          // a strict list said no: stay in the editor
      focusSink();
      pick(hit, e.shiftKey && hit.kind !== 'all');
      drag = { kind: hit.kind };
      try { scroll.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    });
    // No text selection and no focus change on a mouse press: the sink keeps the keyboard.
    scroll.addEventListener('mousedown', (e) => { if ((e.button === 0 || e.button === 2) && hitOf(e.target)) e.preventDefault(); });
    scroll.addEventListener('pointermove', (e) => {
      if (!drag || !(e.buttons & 1)) return;
      const box = scroll.getBoundingClientRect();
      const edgeGap = 24;
      if (e.clientY > box.bottom - edgeGap) scroll.scrollTop += 16;
      else if (e.clientY < box.top + view().frozenH + edgeGap) scroll.scrollTop -= 16;
      if (e.clientX > box.right - edgeGap) scroll.scrollLeft += 16;
      else if (e.clientX < box.left + view().frozenW + edgeGap) scroll.scrollLeft -= 16;
      const hit = hitOf(document.elementFromPoint(e.clientX, e.clientY));
      if (!hit) return;
      const v = view();
      if (drag.kind === 'cell' && hit.kind === 'cell') extendTo(hit);
      else if (drag.kind === 'row' && (hit.kind === 'row' || hit.kind === 'cell')) { v.foc = { r: hit.r, c: v.L.vcols[v.L.vcols.length - 1] }; paint(); }
      else if (drag.kind === 'col' && (hit.kind === 'col' || hit.kind === 'cell')) { v.foc = { r: v.L.vrows[v.L.vrows.length - 1], c: hit.c }; paint(); }
    });
    const endDrag = () => { drag = null; };
    scroll.addEventListener('pointerup', endDrag);
    scroll.addEventListener('pointercancel', endDrag);
    // A finger: a tap selects (never raising the keyboard); a second tap on the same cell edits it (the
    // editor takes focus inside the tap, which is what lets a phone show its keyboard); a tap on a row
    // number in edit mode opens the row menu.
    scroll.addEventListener('click', (e) => {
      if ((e.pointerType || lastPointer) === 'mouse') return;
      let hit = hitOf(e.target);
      if (!hit) return;
      if (E && !commitEdit()) return;
      const now = performance.now();
      if (hit.kind === 'cell' && G.editable && tap && now - tap.t < DOUBLE_TAP_MS) {
        const at = master(view().L, hit);
        if (at.r === tap.r && at.c === tap.c) { tap = null; collapseTo(at); openEditor('edit'); return; }
      }
      focusSink();
      if (hit.kind === 'row' && G.editable) {
        hit = rowTarget(hit, e.clientY);
        if (!inSelection(hit)) pick(hit, false);   // a row (or rows) already selected keeps its selection
        tap = null;
        openMenu(e.clientX, e.clientY);
        return;
      }
      pick(hit, false);
      tap = hit.kind === 'cell' ? { ...master(view().L, hit), t: now } : null;
    });
    // A finger on the row numbers in edit mode. Rows are often 20px, less than a fingertip, and they keep their
    // height; instead the selected rows' numbers answer to a band at least TOUCH_MIN tall (grown evenly above
    // and below), so a tap that lands a few px into the next row still gets the row you are working on.
    function rowTarget(hit, y) {
      const v = view();
      const rg = rangeOf(v);
      if (hit.r >= rg.r1 && hit.r <= rg.r2) return hit;
      const first = v.rows.get(rg.r1), last = v.rows.get(rg.r2);
      if (!first || !last) return hit;
      const a = first.cells[0].getBoundingClientRect(), b = last.cells[0].getBoundingClientRect();
      // Only while the selected row's number is really on screen (not scrolled under the headers or a frozen row).
      const shown = (th, box) => {
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!at && th.contains(at);
      };
      const pad = Math.max(0, (TOUCH_MIN - (b.bottom - a.top)) / 2);
      if (y < a.top && y >= a.top - pad && shown(first.cells[0], a)) return { kind: 'row', r: rg.r1 };
      if (y > b.bottom && y <= b.bottom + pad && shown(last.cells[0], b)) return { kind: 'row', r: rg.r2 };
      return hit;
    }
    scroll.addEventListener('dblclick', (e) => {
      // The press captured the pointer, so the event's target is the scroll box: find the cell under it.
      const hit = hitOf(document.elementFromPoint(e.clientX, e.clientY));
      if (!hit || hit.kind !== 'cell') return;
      if (!G.editable) { viewHint(); return; }
      if (E) return;
      collapseTo(hit);
      openEditor('edit');
    });
    scroll.addEventListener('contextmenu', (e) => {
      const hit = hitOf(e.target);
      if (!hit) return;
      e.preventDefault();
      if (E && !commitEdit()) return;
      if (!inSelection(hit)) {
        if (hit.kind === 'cell') collapseTo(hit); else pick(hit, false);
      }
      focusSink();
      openMenu(e.clientX, e.clientY);
    });

    scroll.addEventListener('scroll', () => {
      if (!scroll.clientHeight) return;   // hidden (another mode): the box has no layout, so no real position
      const v = view();
      if (!v) return;
      if (v.spacer && scroll.scrollTop + scroll.clientHeight > v.spacer.offsetTop) flush(v);   // scrolled past the drawn rows
      v.top = scroll.scrollTop;
      v.left = scroll.scrollLeft;
      closeMenu();
      placeOverlays();
    }, { passive: true });
    const onResize = () => { closeMenu(); placeOverlays(); };
    const onBlur = () => closeMenu();
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);

    tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.sg-tab');
      if (!b || Number(b.dataset.i) === G.cur) return;
      if (E && !commitEdit()) return;
      closeList();
      closeMenu();
      showSheet(Number(b.dataset.i));
      if (G.wantFocus) focusSink();
    });

    // ---- Keyboard + clipboard (the sink) ----

    function resetSink() {
      if (sink.value !== ' ') sink.value = ' ';
      sink.setSelectionRange(0, 1);
    }
    function focusSink() {
      if (document.activeElement !== sink) sink.focus({ preventScroll: true });
      resetSink();
    }
    // Back to where the keyboard was in the grid: the editor when one is open, else the cells.
    function refocus() {
      if (E && E.si === G.cur && G.lastFocus === fval) fval.focus({ preventScroll: true });
      else if (E && E.si === G.cur) ed.focus({ preventScroll: true });
      else focusSink();
    }
    // Esc with one cell selected: give the keyboard back to the page (Tab and Shift+Tab move between cells).
    function leave() {
      if (opts.onLeave) opts.onLeave(api);
      if (el.contains(document.activeElement)) document.activeElement.blur();
    }
    const MODE_BUTTONS = '#mode-board, #mode-kb, #mode-files, #mobile-nav button';
    for (const node of [sink, ed, fval]) {
      node.addEventListener('focus', () => { G.wantFocus = true; G.lastFocus = node; el.classList.add('sg-focus'); if (node === sink) resetSink(); });
      node.addEventListener('blur', (e) => {
        el.classList.remove('sg-focus');
        const to = e.relatedTarget;
        if (to && !el.contains(to) && !(to.matches && to.matches(MODE_BUTTONS))) G.wantFocus = false;
      });
    }

    sink.addEventListener('keydown', (e) => {
      if (e.isComposing || !view().L) return;
      if (E) { refocus(); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      const v = view();
      const L = v.L;
      if (LP && listKey(e)) return;
      switch (e.key) {
        case 'ArrowUp': nav(-1, 0, e); break;
        case 'ArrowDown':
          if (e.altKey) { if (G.editable) openList(); break; }
          nav(1, 0, e);
          break;
        case 'ArrowLeft': nav(0, -1, e); break;
        case 'ArrowRight': nav(0, 1, e); break;
        case 'Home':
          goTo(ctrl ? { r: L.vrows[0], c: L.vcols[0] } : { r: (e.shiftKey ? v.foc : v.act).r, c: L.vcols[0] }, e.shiftKey);
          break;
        case 'End':
          if (!ctrl) return;
          goTo({ r: L.vrows[L.vrows.length - 1], c: L.vcols[L.vcols.length - 1] }, e.shiftKey);
          break;
        case 'PageDown': page(1, e.shiftKey); break;
        case 'PageUp': page(-1, e.shiftKey); break;
        case 'Tab': collapseTo(stepFrom(L, v.act, 0, e.shiftKey ? -1 : 1, false)); break;
        case 'Enter': collapseTo(stepFrom(L, v.act, e.shiftKey ? -1 : 1, 0, false)); break;
        case 'Escape':
          e.stopPropagation();
          if (!single(v)) collapseTo(v.act); else leave();
          break;
        case 'Delete': case 'Backspace':
          if (G.editable) clearSelection(); else viewHint();
          break;
        case 'F2':
          if (G.editable) openEditor('edit'); else viewHint();
          break;
        case 'ContextMenu': openMenuAtCell(); break;
        case 'F10':
          if (!e.shiftKey) return;
          openMenuAtCell();
          break;
        default: {
          const k = e.key.toLowerCase();
          if (ctrl && !e.altKey) {
            if (k === 'a') { selectAll(); break; }
            if (k === 'z' && !e.shiftKey) { if (G.editable) undo(); break; }
            if ((k === 'z' && e.shiftKey) || k === 'y') { if (G.editable) redo(); break; }
            if (k === 's') { requestSave(); break; }
            return;
          }
          const printable = e.key.length === 1 && !e.metaKey && (e.ctrlKey ? e.altKey : !e.altKey || MAC);
          if (!printable && e.key !== 'Dead' && e.key !== 'Process') return;
          if (!G.editable) { viewHint(); break; }
          // A typed key replaces the cell's text. The character is put in by hand; a dead key or an input
          // method opens the editor empty and carries on composing there.
          if (printable) openEditor('enter', e.key);
          else { openEditor('enter', ''); return; }
        }
      }
      e.preventDefault();
    });

    // beforecopy/beforecut: cancelling them is what tells some browsers the commands are available.
    sink.addEventListener('beforecopy', (e) => e.preventDefault());
    sink.addEventListener('beforecut', (e) => e.preventDefault());
    const copy = (e) => {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectionTsv());
      resetSink();
    };
    sink.addEventListener('copy', copy);
    sink.addEventListener('cut', (e) => {   // edit mode: copy, then clear; view mode: just copy
      copy(e);
      if (G.editable) clearSelection();
    });
    sink.addEventListener('paste', (e) => {
      e.preventDefault();
      if (!G.editable) { viewHint(); return; }
      const clip = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (clip) paste(clip);
      resetSink();
    });
    sink.addEventListener('beforeinput', (e) => e.preventDefault());   // nothing is ever typed into the sink itself
    sink.addEventListener('input', resetSink);

    // ---- Public API ----

    function load(p, { keepView = false } = {}) {
      const before = keepView ? new Map(G.sheets.map((s, i) => [s.index, G.views[i]])) : null;
      const curIndex = keepView && sheet() ? sheet().index : null;
      const editIndex = E && G.sheets[E.si] ? G.sheets[E.si].index : null;
      const hold = keepView && el.isConnected ? holdScroll(scroll) : null;
      for (const v of G.views) v.gen++;   // stop drawing the old payload's rows
      closeList();
      closeMenu();
      G.payload = p;
      G.sheets = (p.sheets || []).slice();
      G.base = G.sheets.slice();
      H.reset();
      G.views = G.sheets.map((s, i) => {
        const old = before && before.get(s.index);
        const v = freshView(i);
        if (old) Object.assign(v, { top: old.top, left: old.left, act: old.act, anc: old.anc, foc: old.foc, placed: old.placed });
        return v;
      });
      let cur = Number.isInteger(p.active) ? p.active : 0;
      if (curIndex !== null) { const at = G.sheets.findIndex((s) => s.index === curIndex); if (at >= 0) cur = at; }
      G.cur = Math.max(0, Math.min(cur, G.sheets.length - 1));
      // An edit in progress survives a reload of the same file (keepView) when its sheet is still there.
      if (E) {
        const si = keepView ? G.sheets.findIndex((s) => s.index === editIndex) : -1;
        if (si >= 0 && G.editable && p.editable) E.si = si; else closeEditor();
      }
      renderTabs();
      if (G.sheets.length) showSheet(G.cur); else scroll.replaceChildren();
      if (hold) hold();
      placeOverlays();
    }

    const api = {
      el,
      attach(container) {
        const already = el.parentNode === container;
        if (!already) container.appendChild(el);
        if (!G.sheets.length) return;
        const v = view();
        if (scroll.firstChild !== v.table) scroll.replaceChildren(v.table);
        measure();
        restoreScroll(v);
        placeOverlays();
        const a = document.activeElement;
        const typingElsewhere = a && a !== sink && !el.contains(a) && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
        // Back on the grid it had the keyboard in: the same view coming back, or this file again with an edit
        // still open (so the typing carries on where it was).
        if ((already || E) && G.wantFocus && !typingElsewhere) refocus();
      },
      // The view is about to show something else (another file, another mode): close the list and the menu.
      // An edit in progress stays as it is, inside the grid, and is there again when the grid comes back.
      suspend() {
        closeList();
        closeMenu();
      },
      setEditable(on) {
        on = !!on;
        if (on === G.editable) return;
        if (!on && E) closeEditor();
        closeList();
        closeMenu();
        G.editable = on;
        el.classList.toggle('sg-editable', on);
        for (const v of G.views) resetView(v);
        if (G.sheets.length) showSheet(G.cur);
      },
      load,
      cellBox,
      focus() { if (G.sheets.length && view().L) refocus(); },
      // Ctrl+A from outside the grid: the cells (or, with an edit open, the editor's text).
      selectAll() {
        if (!G.sheets.length || !view().L) return false;
        if (E) { refocus(); (G.lastFocus === fval ? fval : ed).select(); return true; }
        focusSink();
        selectAll();
        return true;
      },
      // Edits, for saving. ops(): every applied edit, in order (Op shapes as in SheetCore).
      // changeCount(): how many changes that is (a cell set twice counts once). hasDraft(): an edit is open in
      // the editor or formula bar, not yet committed (commitEdit() commits it; false = a list refused it).
      // A save in flight: mark = checkpoint() before sending ops(); undo can't reach below the mark (toast)
      // until release(mark) (the save failed) or load() (it worked); opsSince(mark) = the edits applied after
      // the mark and still applied, to replay() on the payload the save returns.
      ops() { return H.ops(); },
      changeCount() { return Core.compactOps(H.ops()).length; },
      hasDraft() { return !!E; },
      commitEdit,
      checkpoint() { return H.checkpoint(); },
      release(mark) { H.release(mark); },
      opsSince(mark) { return H.opsSince(mark); },
      // Apply ops made on another copy of this file (after a reload): one undo step per sheet, redrawn.
      // → { applied, skipped }: ops whose sheet is gone, or that no longer apply, are skipped and counted.
      replay(list) {
        let applied = 0, skipped = 0;
        if (!list || !list.length) return { applied, skipped };
        const bySheet = new Map();
        for (const op of list) {
          const si = G.sheets.findIndex((s) => s.index === op.sheet);
          if (si < 0) { skipped++; continue; }
          if (!bySheet.has(si)) bySheet.set(si, []);
          bySheet.get(si).push(op);
        }
        for (const [si, ops] of bySheet) {
          const before = snap();
          let next, kept = ops;
          try {
            next = Core.applyOps(G.sheets[si], ops);
          } catch {
            // One op that doesn't apply shouldn't cost the rest: go one at a time, keeping the ones that do.
            kept = [];
            next = G.sheets[si];
            for (const op of ops) {
              try { next = Core.applyOps(next, [op]); kept.push(op); } catch { /* counted as skipped */ }
            }
          }
          skipped += ops.length - kept.length;
          if (!kept.length) continue;
          applied += kept.length;
          G.sheets[si] = next;
          const g = { si, ops: kept, rows: kept.some((o) => o.op !== 'set'), before, after: null };
          fold(H.add(g));
          rebuild(si);
          g.after = snap();
        }
        if (applied) { paint(); changed(); }
        return { applied, skipped };
      },
      destroy() {
        clearTimeout(sayTimer);
        for (const v of G.views) v.gen++;
        closeList();
        closeMenu();
        ro.disconnect();
        window.removeEventListener('resize', onResize);
        window.removeEventListener('blur', onBlur);
        el.remove();
        G.views = [];
      },
    };
    el.classList.toggle('sg-editable', G.editable);
    load(payload);
    return api;
  }

  window.SheetGrid = { create, parseClip, createHistory };
})();
