// Edit / Save for text files in Files mode (.txt, .md, .json … and a .csv's Source view).
//
// Click Edit and the numbered read-only view becomes a plain text box holding the whole file. Select all,
// paste a report over it, Save. The server (POST /api/fs/text/save) refuses when the file changed on disk since
// it was opened, keeps the old text as the previous version, and Restore swaps it back.
//
// A draft is kept per path (like the grid's unsaved edits) so switching tabs doesn't lose a paste. workbench.js
// calls in at the same places it does for SheetFiles: renderView (mount, barHtml), the bar click (onBar),
// renderTabs (isDirty), fxClose / fxOpen (confirmDiscard, drop).
'use strict';

const TextEdit = (() => {
  const drafts = new Map();   // path -> { base, text, mtime, saving, wasDirty }

  const ICON = {
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
    cancel: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
  };

  const nameOf = (p) => p.split('/').pop();
  const moved = (a, b) => Math.abs(a - b) > 1;   // mtimes in ms; the file system keeps sub-ms parts loosely
  function ukStamp(ms) {
    const d = new Date(ms);
    const z = (n) => String(n).padStart(2, '0');
    return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }

  // Can this file be edited as text here? A .md in either view (Edit switches it to Source); a .csv only on its
  // Source tab (the Grid has its own Edit); a file too big to have been read has no text to edit.
  function canEdit(f, mode) {
    if (!f || f.source == null || f.tooLarge) return false;
    return f.kind === 'md' || f.kind === 'text' || (f.kind === 'sheet' && mode === 'source');
  }

  const isEditing = (p) => drafts.has(p);
  const dirty = (d) => !!d && d.text !== d.base;
  const isDirty = (p) => dirty(drafts.get(p));
  function anyDirty() {
    for (const d of drafts.values()) if (dirty(d)) return true;
    return false;
  }
  window.addEventListener('beforeunload', (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Before a tab closes or Cancel throws the text away: true when it may.
  function confirmDiscard(p) {
    return !isDirty(p) || confirm(`Discard your unsaved changes to ${nameOf(p)}?`);
  }
  function drop(p) { drafts.delete(p); }

  // ---- Bar ----
  function buttons(p, f, mode) {
    const d = drafts.get(p);
    if (d) {
      return [
        { id: 'fx-text-save', icon: ICON.save, label: d.saving ? 'Saving…' : 'Save',
          title: d.saving ? 'Saving…' : dirty(d) ? 'Save your changes to the file (Ctrl+S)' : 'Nothing to save yet',
          off: d.saving || !dirty(d) },
        { id: 'fx-text-cancel', icon: ICON.cancel, label: 'Cancel',
          title: 'Stop editing (asks before throwing away unsaved changes)', off: d.saving },
      ];
    }
    const out = [];
    if (canEdit(f, mode)) {
      out.push({ id: 'fx-text-edit', icon: ICON.edit, label: 'Edit', title: 'Edit this file as text. Paste in new data, then Save.' });
      if (f.backup) {
        out.push({ id: 'fx-text-restore', icon: ICON.history, label: 'Restore previous',
          title: `Put back the version from ${ukStamp(f.backup.mtime)} (what's there now becomes the backup)` });
      }
    }
    return out;
  }
  const buttonHtml = (b) => `<button type="button" class="ghost fx-bar-btn fx-sheet-btn" id="${b.id}" title="${esc(b.title)}"`
    + `${b.off ? ' disabled' : ''}>${b.icon}<span class="fx-sheet-label">${esc(b.label)}</span></button>`;
  function barHtml(p, f, mode) {
    const bs = buttons(p, f, mode);
    return bs.length ? `<span class="fx-sheet-btns" id="fx-text-btns" data-path="${esc(p)}">${bs.map(buttonHtml).join('')}</span>` : '';
  }
  // The Save button and the tab's dot follow the text as you type, without redrawing the box.
  function syncBar(p) {
    const d = drafts.get(p);
    if (!d) return;
    const save = document.getElementById('fx-text-save');
    if (save) { save.disabled = d.saving || !dirty(d); save.title = dirty(d) ? 'Save your changes to the file (Ctrl+S)' : 'Nothing to save yet'; }
    if (dirty(d) !== d.wasDirty) { d.wasDirty = dirty(d); renderTabs(); }
  }

  // ---- The box ----
  function mount(view, p, f) {
    const d = drafts.get(p);
    view.innerHTML = `<div class="fx-edit">
      <div class="fx-edit-note hidden" id="fx-edit-note" role="alert"></div>
      <textarea class="fx-edit-box" id="fx-edit-box" spellcheck="false" autocapitalize="off" autocomplete="off"
        aria-label="Contents of ${esc(nameOf(p))}"></textarea></div>`;
    const box = view.querySelector('#fx-edit-box');
    box.value = d.text;
    box.addEventListener('input', () => { d.text = box.value; syncBar(p); });
    box.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(p); }
    });
    if (moved(f.mtime, d.mtime)) note(p, 'This file changed on disk since you started editing, so saving will be refused.', true);
    box.focus({ preventScroll: true });
  }
  function note(p, msg, reload) {
    const el = document.getElementById('fx-edit-note');
    if (!el || FX.active !== p) return;
    el.classList.toggle('hidden', !msg);
    el.innerHTML = msg
      ? `<span>${esc(msg)}</span>${reload ? '<button type="button" class="ghost" id="fx-edit-reload">Load the file as it is now</button>' : ''}`
      : '';
  }

  // ---- Actions ----
  function start(p) {
    const f = FX.files.get(p);
    if (!f || f.source == null || drafts.has(p)) return;
    if (f.kind === 'md') { FX.views[p] = 'source'; lsSet(FX_KEYS.views, FX.views); }
    drafts.set(p, { base: f.source, text: f.source, mtime: f.mtime, saving: false, wasDirty: false });
    renderView();
  }

  function cancel(p) {
    if (!confirmDiscard(p)) return;
    drop(p);
    renderTabs();
    renderView();
  }

  // Throw the draft away and show the file as it is on disk now (after "changed on disk").
  function reloadAsIs(p) {
    if (!confirmDiscard(p)) return;
    drop(p);
    fxShow(p, { refetch: true }).catch((err) => toast(err.message));
  }

  async function save(p) {
    const d = drafts.get(p);
    if (!d || d.saving || !dirty(d)) return;
    d.saving = true;
    renderView({ keepScroll: true });
    try {
      await api('/api/fs/text/save', { method: 'POST', body: JSON.stringify({ path: p, text: d.text, mtime: d.mtime }) });
    } catch (err) {
      d.saving = false;
      renderView({ keepScroll: true });
      const stale = /changed on disk/i.test(err.message);
      note(p, stale ? 'This file changed on disk since you started editing. Nothing was saved.' : err.message, stale);
      toast(err.message);
      return;
    }
    drop(p);
    toast(`Saved ${nameOf(p)}`);
    renderTabs();
    await fxShow(p, { refetch: true, keepScroll: true }).catch((err) => toast(err.message));
  }

  async function restore(p) {
    const f = FX.files.get(p);
    if (!f || !f.backup) return;
    if (!confirm(`Put back the version of ${nameOf(p)} from ${ukStamp(f.backup.mtime)}? What's there now becomes the backup.`)) return;
    try {
      await api('/api/fs/text/restore', { method: 'POST', body: JSON.stringify({ path: p, mtime: f.mtime }) });
    } catch (err) { toast(err.message); return; }
    toast(`Restored the previous ${nameOf(p)}`);
    await fxShow(p, { refetch: true, keepScroll: true }).catch((err) => toast(err.message));
  }

  // The bar's buttons; true when the click was ours.
  function onBar(btn, p) {
    switch (btn.id) {
      case 'fx-text-edit': start(p); return true;
      case 'fx-text-save': save(p); return true;
      case 'fx-text-cancel': cancel(p); return true;
      case 'fx-text-restore': restore(p); return true;
      default: return false;
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#fx-edit-reload');
    if (b && FX.active) reloadAsIs(FX.active);
  });

  return { canEdit, isEditing, isDirty, anyDirty, confirmDiscard, drop, barHtml, mount, onBar };
})();
