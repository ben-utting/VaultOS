'use strict';

// ========================================================================
// SheetFiles — the glue between Files mode and the spreadsheet grid.
// Classic script, loaded after app.js (api, esc, toast, svg, showLogin) and sheet-grid.js; it reaches into
// workbench.js (FX, FX_ICONS, fxPin, fxDownload, renderView, renderTabs) only at run time.
//
// One controller per open spreadsheet path, kept while its tab is open, so a grid keeps its sheet, scroll,
// selection and unsaved edits across tab and mode switches; closing the tab drops it (drop). workbench.js's
// renderView() calls beforeViewChange(nextPath, nextKind) first thing, puts barHtml() in the file bar when the
// file is shown as a grid, routes file-bar clicks through onBar(), and calls mount() for the view; renderTabs()
// marks a tab `.unsaved` (isDirty); fxClose() asks confirmDiscard() then drop(); fxOpen() never replaces a dirty
// preview tab; setMode() calls beforeViewChange(null, null) on leaving Files; the Files Ctrl+A handler asks
// selectAll() first. Exposed as window.SheetFiles so those hooks can check it loaded.
//
// Saving (one save per file at a time; Save and Ctrl+S do nothing while one is in flight):
//   commitEdit (a list refusing the text stops here) → mark = checkpoint() → POST compactOps(ops())
//   200      the file holds what was sent: load the fresh payload, replay what was typed after the mark
//   409      the file changed on disk: the conflict banner (reload and re-apply my edits / discard them)
//   no answer (dropped connection, proxy error, 120 s timeout): ask the server whose write the file is — settle();
//            moved but not provably ours: the same banner, saying the save may have gone through
//   anything else: release(mark), say why; the edits stay
// A background refresh never reloads over unsaved edits (or a save in flight): it shows the banner instead.
// ========================================================================

window.SheetFiles = (() => {
  // path -> { path, payload, grid, mtime, loading, error, editing, saving, busy, conflict, check, notes, ... }
  // conflict: false, true (the file changed on disk under unsaved edits), or 'unknown' (our save's answer was lost
  // and the file moved, so it may be our own write: same banner and buttons, a different warning)
  const reg = new Map();
  let shown = null;        // { view, path }: what the Files view is showing now, or null

  const SAVE_MAX = 1.9e6;  // characters: the server takes 2 MB of JSON
  // A save or restore with no answer by then is given up on and checked (settle). Above Cloudflare's 100 s
  // request limit on purpose: through the tunnel the proxy gives up first, with a 524 that settle() handles too.
  const WRITE_TIMEOUT = 120e3;
  const RESTORE = 'Restore previous version';
  const MSG = {
    tooMany: 'Too many changes for one save — save in smaller steps',
    conflict: 'This file changed on disk since you opened it.',
    mayHaveLanded: "Your save may have gone through — the file changed and VaultOS can't tell whose change it is. Check the sheet before re-applying.",
    cf: "Some colour rules from Excel aren't shown here",
    big: 'Too large for the grid',
    skipped: (n) => `${n} of your edits couldn't be re-applied — check the sheet before saving`,
    unknown: "VaultOS didn't answer the save, so it may not have been saved.",
    stale: "Saved — but the sheet couldn't be reloaded.",
    offline: "Still can't reach VaultOS — try again in a moment",
  };
  const ICON = {
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
    done: svg('<polyline points="20 6 9 17 4 12"/>'),
  };

  const kb = (n) => ((n || 0) / 1024).toFixed(1) + ' KB';
  const nameOf = (p) => p.split('/').pop();
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const moved = (a, b) => Math.abs(a - b) > 1;   // mtimes in ms; the file system keeps sub-ms parts loosely
  // Each save or restore is named, so the server can say afterwards whether the file is that write (lastWrite.id).
  function newWriteId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function ukStamp(ms) {
    const d = new Date(ms);
    const z = (n) => String(n).padStart(2, '0');
    return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  // The controller is still the one for its path, with the same grid (a closed tab, or a payload that left nothing
  // to draw, ends whatever was in flight for it).
  const alive = (ent, grid) => reg.get(ent.path) === ent && ent.grid === grid;

  // ---- Dirty state ----

  // Unsaved: committed edits, or an edit still open in the cell editor (a draft counts — Ruling 34).
  const dirty = (ent) => !!(ent && ent.grid && (ent.grid.changeCount() > 0 || ent.grid.hasDraft()));
  const pending = (ent) => ent.grid.changeCount() + (ent.grid.hasDraft() ? 1 : 0);
  // Something is on its way for this file: a save or restore, a reload of ours, or a save whose outcome isn't known.
  const occupied = (ent) => !!(ent && (ent.saving || ent.busy || ent.check));
  const isDirty = (p) => dirty(reg.get(p));
  function anyDirty() {
    for (const ent of reg.values()) if (dirty(ent)) return true;
    return false;
  }
  // Before a tab closes (or Done throws edits away): true when it may. Asks when there are unsaved edits; while a
  // save is in flight it says to wait rather than lose track of it.
  function confirmDiscard(p) {
    const ent = reg.get(p);
    if (!ent || !ent.grid) return true;
    if (ent.saving) { toast(`Still saving ${nameOf(p)} — try again in a moment`); return false; }
    if (!dirty(ent)) return true;
    return confirm(`Discard ${plural(pending(ent), 'unsaved change')} to ${nameOf(p)}?`);
  }
  window.addEventListener('beforeunload', (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- Showing it ----

  // Not drawable (unreadable, too large, or the fetch failed): the same panel Files uses for "no preview", with
  // Download (and Show source for a CSV whose text Files has).
  function panel(view, ent, why, size) {
    const name = nameOf(ent.path);
    const big = !!(ent.payload && ent.payload.tooLarge);
    const acts = [];
    if (big && hasSource(ent.path)) acts.push(['source', 'Show source']);
    if (ent.payload) acts.push(['download', 'Download']);
    view.innerHTML = `<div class="fx-binary"><p><b>${esc(name)}</b></p>${big ? `<p>${esc(MSG.big)}</p>` : ''}`
      + `<p>${esc(why)}${size != null ? ' · ' + kb(size) : ''}</p>`
      + (acts.length ? `<p class="sg-panel-acts">${acts.map(([a, t]) => `<button type="button" class="ghost" data-act="${a}">${t}</button>`).join('')}</p>` : '')
      + '</div>';
    for (const b of view.querySelectorAll('.sg-panel-acts [data-act]')) b.addEventListener('click', () => act(ent, b.dataset.act));
  }

  function show(ent) {
    if (!shown || shown.path !== ent.path) return;   // the user moved on while it loaded
    const view = shown.view;
    syncBar(ent);
    if (ent.error && !ent.grid) { panel(view, ent, ent.error, null); return; }
    const p = ent.payload;
    if (!ent.grid) {
      panel(view, ent, p.reason || (p.tooLarge ? 'Too large to open here' : 'Nothing to show in this file'), p.size);
      return;
    }
    // The banners sit above the grid, in the view; the grid is appended after them by attach().
    if (ent.grid.el.parentNode !== view) view.replaceChildren(ent.notes);
    else if (ent.notes.parentNode !== view) view.insertBefore(ent.notes, view.firstChild);
    renderNotes(ent);
    ent.grid.attach(view);
  }

  // Esc from a grid with one cell selected hands the keyboard to the file bar, so Tab can leave from there.
  function leaveGrid() {
    const b = document.querySelector('#fx-bar button:not([disabled])');
    if (b) b.focus();
  }

  async function fetchPayload(path) {
    return api('/api/fs/sheet?path=' + encodeURIComponent(path));
  }
  // After a write the payload must be had: a few tries before giving up (null).
  async function fetchPayloadSoon(path) {
    for (const wait of [0, 400, 1200]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try { return await fetchPayload(path); } catch { /* try again */ }
    }
    return null;
  }

  // Take `p` as what the file is now: draw it (keeping the place, and an edit in progress), or create the grid,
  // or drop it when there's nothing to draw. Clears the conflict: the grid and the disk agree again.
  function adopt(ent, p) {
    const had = ent.grid;
    ent.payload = p;
    ent.mtime = p.mtime;
    ent.error = null;
    ent.conflict = false;
    if (!p.editable) ent.editing = false;
    if (!p.sheets || !p.sheets.length) {
      if (ent.grid) { ent.grid.destroy(); ent.grid = null; }
    } else if (ent.grid) {
      ent.grid.setEditable(ent.editing);
      ent.grid.load(p, { keepView: true });
    } else {
      ent.grid = SheetGrid.create(p, {
        editable: ent.editing, toast,
        onChange: () => changed(ent),
        onRequestSave: () => save(ent),
        onLeave: leaveGrid,
        onDownload: () => fxDownload(ent.path),
        bigBanner: true,   // notesOf() puts "Too large for the grid" above it when no sheet can be drawn
      });
    }
    if (ent.grid !== had) show(ent);   // a grid appeared or went: the view swaps between it and the panel
  }

  // (Re)load from disk. Never draws over unsaved edits or a write in flight: if those appeared while it loaded,
  // the answer is dropped, and a file that moved on gets the conflict banner instead.
  function load(ent) {
    if (ent.loading) return ent.loading;
    ent.loading = (async () => {
      try {
        if (!window.SheetGrid) throw new Error("The spreadsheet viewer didn't load — reload the page");
        const p = await fetchPayload(ent.path);
        if (reg.get(ent.path) !== ent) return;
        if (ent.grid && (dirty(ent) || occupied(ent))) {
          if (!occupied(ent) && moved(p.mtime, ent.mtime) && !ent.conflict) ent.conflict = true;
        } else adopt(ent, p);
      } catch (err) {
        ent.error = err.message;
        if (ent.grid) toast(err.message);   // keep showing the grid we have
      } finally {
        ent.loading = null;
      }
      if (reg.get(ent.path) === ent) { show(ent); sync(ent); }
    })();
    return ent.loading;
  }

  function controller(path) {
    let ent = reg.get(path);
    if (ent) return ent;
    ent = { path, payload: null, grid: null, mtime: null, loading: null, error: null, editing: false,
      saving: false, busy: false, conflict: false, check: null, notes: null, notesHtml: '', notesSig: null, queued: false };
    ent.notes = document.createElement('div');
    ent.notes.className = 'sg-notes';
    ent.notes.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) act(ent, b.dataset.act);
    });
    reg.set(path, ent);
    return ent;
  }

  // `meta` is Files' /api/fs/file answer for the file (its mtime is what's on disk now).
  function mount(view, path, meta) {
    shown = { view, path };
    const ent = controller(path);
    if (!ent.payload || (ent.error && !ent.grid)) {   // never loaded, or the last load failed with nothing to show
      if (ent.grid) show(ent);
      else view.innerHTML = '<p class="fx-empty fx-pad">Loading…</p>';
      load(ent);
      return;
    }
    show(ent);
    if (ent.error) { load(ent); return; }   // the last reload failed: try again, showing the grid we have meanwhile
    if (meta && Number.isFinite(meta.mtime) && moved(meta.mtime, ent.mtime)) diskMoved(ent);
  }

  // The file changed on disk (an agent, Syncthing, Excel). A clean grid simply reloads; one with unsaved edits
  // keeps them and says so; while our own write (or reload) is on its way the change is most likely ours.
  function diskMoved(ent) {
    if (occupied(ent) || ent.loading) return;
    if (dirty(ent)) {
      if (!ent.conflict) { ent.conflict = true; sync(ent); }
      return;
    }
    load(ent);
  }

  // Called before Files repaints its view (next = the path and view kind about to be shown: 'grid', or
  // another kind, or null) and when the app leaves Files mode (null, null). Only a real change away from the
  // grid on screen (another file, the same file not as a grid, or no file) suspends it, which closes its list
  // and row menu; an edit in progress stays open inside the grid until it comes back. A re-render of the same
  // grid (the 8s poll, coming back to the tab, Re-read) leaves it alone.
  function beforeViewChange(nextPath, nextKind) {
    if (!shown) return;
    if (shown.path === nextPath && nextKind === 'grid') return;
    const ent = reg.get(shown.path);
    if (ent && ent.grid) ent.grid.suspend();
    shown = null;
  }

  // Closing its tab: the grid goes, edits and all (the caller asked confirmDiscard first).
  function drop(p) {
    const ent = reg.get(p);
    if (!ent) return;
    reg.delete(p);
    if (shown && shown.path === p) shown = null;
    if (ent.grid) { ent.grid.destroy(); ent.grid = null; }
    ent.notes.remove();
  }

  // ---- Keeping the bar, the tab and the banners in step ----

  // grid.onChange: it can fire in the middle of grid.load(), so only note it; the UI catches up straight after.
  function changed(ent) {
    if (ent.queued) return;
    ent.queued = true;
    queueMicrotask(() => {
      ent.queued = false;
      if (reg.get(ent.path) !== ent) return;
      sync(ent);
      // Every edit undone while the banner was up: nothing left to protect, so show the file as it is now.
      if (ent.conflict && !dirty(ent) && !occupied(ent) && !ent.loading) { ent.conflict = false; load(ent); }
    });
  }
  function sync(ent) {
    syncBar(ent);
    syncTab(ent);
    if (ent.grid && ent.notes.parentNode) renderNotes(ent);
  }
  function syncTab(ent) {
    const tab = document.querySelector(`#fx-tabs .fx-tab[data-path="${CSS.escape(ent.path)}"]`);
    if (!tab) return;
    const d = dirty(ent);
    tab.classList.toggle('unsaved', d);
    const x = tab.querySelector('.fx-tab-x');
    if (x) x.setAttribute('aria-label', `Close ${nameOf(ent.path)}${d ? ' (unsaved changes)' : ''}`);
  }

  // ---- The file bar: Edit and Restore previous version; while editing, Save (N) and Done ----

  function buttons(p) {
    const ent = reg.get(p);
    const pl = ent && ent.payload;
    const out = [];
    if (ent && ent.editing && ent.grid) {
      const n = ent.grid.changeCount();
      const d = dirty(ent);
      out.push({ id: 'fx-sheet-save', cls: 'fx-sheet-save', icon: ICON.save,
        label: ent.saving ? 'Saving…' : n ? `Save (${n})` : 'Save',
        title: ent.saving ? 'Saving…' : ent.check ? 'Waiting to hear whether the last save landed'
          : d ? 'Save your changes to the file (Ctrl+S)' : 'Nothing to save yet',
        off: !d || occupied(ent) });
      out.push({ id: 'fx-sheet-done', cls: 'fx-sheet-done', icon: ICON.done, label: 'Done',
        title: 'Stop editing (asks before throwing away unsaved changes)', off: occupied(ent) });
      return out;
    }
    if (!pl || ent.grid) {
      const why = !pl ? 'Loading…' : !pl.editable ? pl.reason || 'This file can’t be edited here' : 'Edit the cells';
      out.push({ id: 'fx-sheet-edit', cls: 'fx-sheet-edit', icon: ICON.edit, label: 'Edit', title: why,
        off: !pl || !pl.editable || occupied(ent) });
    }
    if (pl && pl.backup) {
      // On a phone the label is just "Restore" (the rest is hidden, styles.css); the name stays the full one.
      out.push({ id: 'fx-sheet-restore', cls: 'fx-sheet-restore', icon: FX_ICONS.history, label: RESTORE, short: 'Restore',
        title: `Put back the version from ${ukStamp(pl.backup.mtime)} (what's there now becomes the backup)`, off: occupied(ent) });
    }
    return out;
  }
  // The visible label; a button with a `short` form hides the rest of it on a phone (.fx-sheet-long) and keeps
  // the whole label as its accessible name.
  const labelHtml = (b) => (b.short ? `${esc(b.short)}<span class="fx-sheet-long">${esc(b.label.slice(b.short.length))}</span>` : esc(b.label));
  const buttonHtml = (b) => `<button type="button" class="ghost fx-bar-btn fx-sheet-btn ${b.cls}" id="${b.id}" title="${esc(b.title)}"`
    + `${b.short ? ` aria-label="${esc(b.label)}"` : ''}${b.off ? ' disabled' : ''}>${b.icon}<span class="fx-sheet-label">${labelHtml(b)}</span></button>`;
  function barHtml(p) {
    const bs = buttons(p);
    return `<span class="fx-sheet-btns" id="fx-sheet-btns" data-path="${esc(p)}" data-ids="${bs.map((b) => b.id).join(' ')}">`
      + `${bs.map(buttonHtml).join('')}</span>`;
  }
  // Redraw our buttons: in place when the same ones are there (so the one with focus keeps it), else anew.
  function syncBar(ent) {
    const wrap = document.getElementById('fx-sheet-btns');
    if (!wrap || wrap.dataset.path !== ent.path) return;
    const bs = buttons(ent.path);
    if (wrap.dataset.ids !== bs.map((b) => b.id).join(' ')) {
      const focused = wrap.contains(document.activeElement) ? document.activeElement.id : null;
      wrap.outerHTML = barHtml(ent.path);
      const again = focused && document.getElementById(focused);
      if (again && !again.disabled) again.focus();
      return;
    }
    for (const b of bs) {
      const el = document.getElementById(b.id);
      if (!el) continue;
      el.disabled = b.off;
      if (el.title !== b.title) el.title = b.title;
      const span = el.querySelector('.fx-sheet-label');
      const html = labelHtml(b);
      if (span.innerHTML !== html) span.innerHTML = html;
    }
  }

  // A file-bar click: true when it was one of ours.
  function onBar(btn, p) {
    if (!btn.id.startsWith('fx-sheet-')) return false;
    const ent = reg.get(p);
    if (!ent || btn.disabled) return true;
    if (btn.id === 'fx-sheet-edit') startEditing(ent);
    else if (btn.id === 'fx-sheet-save') { if (ent.grid) ent.grid.focus(); save(ent); }   // typing carries on in the grid
    else if (btn.id === 'fx-sheet-done') done(ent);
    else if (btn.id === 'fx-sheet-restore') restore(ent);
    return true;
  }

  function startEditing(ent) {
    if (!ent.grid || !ent.payload || !ent.payload.editable || ent.editing || occupied(ent)) return;
    if (typeof fxPin === 'function') fxPin(ent.path);   // an edited file keeps its tab: never a preview tab
    ent.editing = true;
    ent.grid.setEditable(true);
    sync(ent);
    ent.grid.focus();
  }

  // Done: leave edit mode, throwing unsaved edits away (after asking).
  function done(ent) {
    const grid = ent.grid;
    if (!grid || !ent.editing || occupied(ent) || !confirmDiscard(ent.path)) return;
    const had = grid.changeCount() > 0;
    ent.editing = false;
    grid.setEditable(false);                            // closes an edit in progress
    if (had) grid.load(ent.payload, { keepView: true }); // back to the file as it was last loaded
    if (ent.conflict) { ent.conflict = false; load(ent); }   // which is out of date: show it as it is now
    sync(ent);
    const edit = document.getElementById('fx-sheet-edit');
    if (edit) edit.focus();
  }

  // ---- Saving ----

  async function save(ent) {
    const grid = ent.grid;
    if (!grid || !ent.editing || occupied(ent)) return;
    if (!grid.commitEdit()) return;                     // a list refused the text: the editor stays open
    if (!grid.changeCount()) { sync(ent); return; }    // the edit changed nothing
    const mark = grid.checkpoint();                     // undo can't reach what's being sent until this settles
    const id = newWriteId();
    const body = JSON.stringify({ path: ent.path, mtime: ent.mtime, saveId: id, ops: SheetCore.compactOps(grid.ops()) });
    if (body.length > SAVE_MAX) { grid.release(mark); toast(MSG.tooMany); return; }
    ent.saving = true;
    sync(ent);
    try {
      await write(ent, '/api/fs/sheet/save', body, id, mark, 'Saved');
    } finally {
      ent.saving = false;
      if (reg.get(ent.path) === ent) sync(ent);
    }
  }

  async function restore(ent) {
    const pl = ent.payload;
    if (!pl || !pl.backup || ent.editing || occupied(ent)) return;
    if (dirty(ent) && !confirmDiscard(ent.path)) return;   // edits left over (a save that came back view-only)
    const when = ukStamp(pl.backup.mtime);
    if (!confirm(`${RESTORE}?\n\nThis puts back the version from ${when}. What's there now becomes the backup, so you can switch back.`)) return;
    const id = newWriteId();
    ent.saving = true;
    sync(ent);
    try {
      await write(ent, '/api/fs/sheet/restore', JSON.stringify({ path: ent.path, mtime: ent.mtime, saveId: id }), id, null, `Restored the version from ${when}`);
    } finally {
      ent.saving = false;
      if (reg.get(ent.path) === ent) sync(ent);
    }
  }

  // POST a save (with its checkpoint `mark`) or a restore (mark null), named `id`, and deal with the answer.
  // fetch, not api(): the status decides what happens.
  async function write(ent, url, body, id, mark, msg) {
    const grid = ent.grid;
    const from = ent.mtime;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WRITE_TIMEOUT);
    let res = null, data = null;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctl.signal });
      data = await res.json().catch(() => null);
    } catch { res = null; } finally { clearTimeout(timer); }
    if (!alive(ent, grid)) return;
    if (res && res.status === 401) { if (mark !== null) grid.release(mark); showLogin(); return; }
    if (res && res.ok && data && Number.isFinite(data.mtime)) { await landed(ent, grid, data, id, mark, msg); return; }
    if (!res || !data || res.ok || res.status >= 502) {
      // No answer we can read (the connection dropped, a proxy gave up, the timeout): it may or may not have been
      // written.
      ent.check = { id, mark, from, landed: false, msg };
      await settle(ent);
      return;
    }
    if (mark !== null) grid.release(mark);
    if (res.status === 409 && dirty(ent)) { ent.conflict = true; return; }
    toast(data.error || 'Something went wrong, and the file wasn\'t changed');
    if (res.status === 409 || res.status === 404) await refreshNow(ent, grid);   // a restore: show the file as it is
  }

  // The write is on disk. Whatever happens next, what was sent must never be sent again: load the file as it now
  // is and put back only what was typed after the save was sent.
  async function landed(ent, grid, data, id, mark, msg) {
    patchMeta(ent.path, data);
    let fresh = data;
    if (data.reload || !Array.isArray(data.sheets)) {   // written, but the server couldn't build the payload
      fresh = await fetchPayloadSoon(ent.path);
      if (!alive(ent, grid)) return;
      if (!fresh) { ent.check = { id, mark, from: ent.mtime, landed: true, msg }; return; }
    }
    finish(ent, fresh, mark, msg);
  }
  function finish(ent, fresh, mark, msg) {
    const later = mark === null || !ent.grid ? [] : ent.grid.opsSince(mark);
    ent.check = null;
    adopt(ent, fresh);                                    // a save clears undo history: the file is the new baseline
    if (!later.length) toast(msg);
    else if (!ent.grid) toast(`${msg}, but the sheet can't be shown now — ${plural(later.length, 'later edit')} couldn't be kept`);
    else {
      const r = ent.grid.replay(later);
      toast(r.skipped ? MSG.skipped(r.skipped) : msg);
    }
    patchMeta(ent.path, fresh);
    refreshMeta(ent.path);
  }

  // A write whose answer never came (or whose file couldn't be read back afterwards): ask the server. The sheet GET
  // reads under the file's lock, so a write still under way finishes first.
  //   lastWrite.id is ours          → it landed: as for a 200
  //   the file hasn't moved         → it wasn't written: say so, the edits stay for another Save
  //   moved, and not by us (someone else's save, an outside change, a server restart that forgot the id)
  //                                 → a save keeps every edit and shows the conflict banner; a restore shows the file
  // Nothing short of our own id counts as "ours": another client's save from the same base looks the same otherwise.
  async function settle(ent) {
    const c = ent.check;
    const grid = ent.grid;
    if (!c || ent.busy) return;
    ent.busy = true;
    sync(ent);
    let fresh = null;
    try { fresh = await fetchPayloadSoon(ent.path); } finally { ent.busy = false; }
    if (!alive(ent, grid) || ent.check !== c) return;
    if (!fresh) { toast(MSG.offline); sync(ent); return; }
    const ours = c.landed || (!!fresh.lastWrite && fresh.lastWrite.id === c.id);
    if (ours) { finish(ent, fresh, c.mark, c.msg); sync(ent); return; }
    ent.check = null;
    if (c.mark !== null && grid) grid.release(c.mark);
    if (!moved(fresh.mtime, c.from)) toast(c.mark !== null ? 'It wasn\'t saved — press Save to try again' : 'Nothing was changed');
    else if (c.mark !== null) ent.conflict = 'unknown';     // may be ours: the banner says so
    else { adopt(ent, fresh); toast('Couldn\'t tell whether that worked — this is the file as it is now'); }
    sync(ent);
  }

  // A clean grid: show the file as it is on disk now (after a refused restore).
  async function refreshNow(ent, grid) {
    try {
      const fresh = await fetchPayload(ent.path);
      if (alive(ent, grid) && !dirty(ent)) { adopt(ent, fresh); patchMeta(ent.path, fresh); }
    } catch { /* the toast already said what went wrong */ }
  }

  // Files' own idea of the file (FX.files: mtime, size, a CSV's text) follows our writes, so the 8 s poll doesn't
  // take them for someone else's and Source shows the new text. The mtime and size straight away; the rest refetched.
  function patchMeta(path, d) {
    if (typeof FX === 'undefined') return;
    const f = FX.files.get(path);
    if (f && Number.isFinite(d.mtime)) { f.mtime = d.mtime; f.size = d.size; }
  }
  async function refreshMeta(path) {
    try {
      const meta = await api('/api/fs/file?path=' + encodeURIComponent(path));
      if (typeof FX === 'undefined' || !FX.tabs.some((t) => t.path === path)) return;
      const ent = reg.get(path);
      if (ent && ent.mtime != null && meta.mtime < ent.mtime - 1) return;   // late: from before our latest write
      FX.files.set(path, meta);
      FX.changed.delete(path);
      if (FX.active !== path || STATE.mode !== 'files') { renderTabs(); return; }
      // Repaint (the bar's "edited just now"), keeping the keyboard on the bar button that had it.
      const a = document.activeElement;
      const keep = a && a.id && $('fx-bar').contains(a) ? a.id : null;
      renderView({ keepScroll: true });
      const again = keep && document.getElementById(keep);
      if (again && !again.disabled) again.focus();
    } catch { /* the next poll or visit refetches it */ }
  }

  // ---- The conflict banner's buttons ----

  // Reload and re-apply my N edits: the file as it is now, with every unsaved edit put back on top (still unsaved).
  async function reapply(ent) {
    const grid = ent.grid;
    if (!grid || occupied(ent)) return;
    ent.busy = true;
    sync(ent);
    let fresh = null;
    try { fresh = await fetchPayload(ent.path); } catch (err) { toast(err.message); } finally { ent.busy = false; }
    if (!alive(ent, grid)) return;
    if (fresh && !fresh.editable) {
      // It came back view-only: the edits can't go on top of it. Keep them, and the banner, and say why.
      toast(fresh.reason || 'This file can’t be edited here any more');
    } else if (fresh) {
      const mine = SheetCore.compactOps(grid.ops());     // read now: edits made while it loaded count too
      adopt(ent, fresh);                                 // keeps an edit in progress
      if (ent.grid && mine.length) {
        const r = ent.grid.replay(mine);
        toast(r.skipped ? MSG.skipped(r.skipped) : `Reloaded with your ${plural(r.applied, 'edit')} on top — check, then Save`);
      }
      patchMeta(ent.path, fresh);
      refreshMeta(ent.path);
      backToGrid(ent);
    }
    sync(ent);
  }

  // Reload and discard my edits (after asking).
  async function discard(ent) {
    const grid = ent.grid;
    if (!grid || occupied(ent)) return;
    const n = pending(ent);
    if (n && !confirm(`Discard your ${plural(n, 'unsaved change')} to ${nameOf(ent.path)} and load the file as it is now?`)) return;
    ent.busy = true;
    sync(ent);
    let fresh = null;
    try { fresh = await fetchPayload(ent.path); } catch (err) { toast(err.message); } finally { ent.busy = false; }
    if (!alive(ent, grid)) return;
    if (fresh) {
      if (grid.hasDraft()) grid.setEditable(false);      // closes the edit in progress; adopt switches editing back on
      adopt(ent, fresh);                                  // a load without the edits
      patchMeta(ent.path, fresh);
      refreshMeta(ent.path);
      backToGrid(ent);
    }
    sync(ent);
  }
  // The banner's button that had the keyboard is gone: hand it back to the grid (and an edit still open in it).
  function backToGrid(ent) {
    const a = document.activeElement;
    if (ent.grid && ent.grid.el.isConnected && (!a || a === document.body || ent.notes.contains(a))) ent.grid.focus();
  }

  // Show source: the Source view of a CSV too big for the grid.
  function showSource(p) {
    if (typeof FX === 'undefined') return;
    FX.views[p] = 'source';
    lsSet(FX_KEYS.views, FX.views);
    renderView();
  }
  function hasSource(p) {
    const f = typeof FX !== 'undefined' && FX.files.get(p);
    return !!(f && f.source != null && /\.csv$/i.test(p));
  }

  function act(ent, a) {
    if (a === 'reapply') reapply(ent);
    else if (a === 'discard') discard(ent);
    else if (a === 'check') settle(ent);
    else if (a === 'download') fxDownload(ent.path);
    else if (a === 'source') showSource(ent.path);
  }

  // ---- Banners above the grid ----

  function notesOf(ent) {
    const pl = ent.payload;
    const out = [];
    if (!pl || !ent.grid) return out;
    if (ent.check) {
      out.push({ kind: 'check', warn: true, text: ent.check.landed ? MSG.stale : MSG.unknown,
        acts: [['check', ent.check.landed ? 'Reload' : 'Check again']] });
    } else if (ent.conflict) {
      const n = ent.grid.changeCount();
      out.push({ kind: 'conflict', warn: true, text: ent.conflict === 'unknown' ? MSG.mayHaveLanded : MSG.conflict, acts: [
        ['reapply', n ? `Reload and re-apply my ${plural(n, 'edit')}` : 'Reload and keep what I’m typing'],
        ['discard', 'Reload and discard my edits']] });
    }
    const sheets = pl.sheets || [];
    if (sheets.length && sheets.every((s) => s.tooBig || !s.cells)) {
      out.push({ kind: 'big', text: MSG.big, acts: [...(hasSource(ent.path) ? [['source', 'Show source']] : []), ['download', 'Download']] });
    } else if (!pl.editable && pl.reason) {
      out.push({ kind: 'readonly', text: pl.reason, acts: [['download', 'Download']] });
    }
    if (sheets.some((s) => s.cfSkipped > 0)) out.push({ kind: 'cf', muted: true, text: MSG.cf, acts: [] });
    return out;
  }
  // A banner that is already there is patched in place (its button labels and states), not drawn again: a warn
  // banner is role="alert", and a new one is read out — so "re-apply my 2 edits" becoming 3 mustn't re-announce.
  function renderNotes(ent) {
    const off = ent.saving || ent.busy;
    const list = notesOf(ent);
    const isOff = (a) => off && a !== 'download' && a !== 'source';
    const html = list.map((n) => `<div class="sg-note${n.warn ? ' sg-note-warn' : ''}${n.muted ? ' sg-note-muted' : ''}" data-kind="${n.kind}"`
      + `${n.warn ? ' role="alert"' : ''}><span class="sg-note-text">${esc(n.text)}</span>`
      + (n.acts.length ? `<span class="sg-note-acts">${n.acts.map(([a, t]) => `<button type="button" class="ghost" data-act="${a}"`
        + `${isOff(a) ? ' disabled' : ''}>${esc(t)}</button>`).join('')}</span>` : '')
      + '</div>').join('');
    if (html === ent.notesHtml) return;
    ent.notesHtml = html;
    const sig = list.map((n) => `${n.kind}|${n.text}|${n.acts.map(([a]) => a).join(',')}`).join('\n');
    const els = ent.notes.children;
    if (sig === ent.notesSig && els.length === list.length) {
      list.forEach((n, i) => {
        const btns = els[i].querySelectorAll('button[data-act]');
        n.acts.forEach(([a, t], j) => {
          if (btns[j].textContent !== t) btns[j].textContent = t;
          btns[j].disabled = isOff(a);
        });
      });
      return;
    }
    ent.notesSig = sig;
    ent.notes.innerHTML = html;
  }

  // ---- Keys ----

  // Ctrl+S anywhere in Files while the file on screen is being edited (in the grid, the grid saves it itself).
  // Not from a box with its own typing (the search box, a terminal).
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
    if (typeof STATE === 'undefined' || STATE.mode !== 'files' || typeof FX === 'undefined') return;
    const ent = reg.get(FX.active);
    if (!ent || !ent.editing || !ent.grid) return;
    const a = document.activeElement;
    if (a && !ent.grid.el.contains(a) && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
    e.preventDefault();
    save(ent);
  });

  // Ctrl+A in Files with the grid on screen but the keyboard elsewhere: select its cells, not the page.
  function selectAll() {
    if (!shown) return false;
    const ent = reg.get(shown.path);
    return !!(ent && ent.grid && ent.grid.el.isConnected && ent.grid.selectAll());
  }

  return { mount, beforeViewChange, barHtml, onBar, selectAll, isDirty, anyDirty, confirmDiscard, drop };
})();
