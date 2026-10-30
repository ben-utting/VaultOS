'use strict';

// ========================================================================
// Workbench — Files mode + the terminal dock.
// Loaded after app.js and shares its globals ($, api, esc, svg, ICONS, toast,
// copyText, holdScroll, withRefreshFeedback, hydrateDiagrams, debounce,
// setMode, STATE). Files mode is the whole vault, not a workspace, so nothing
// here goes through ws().
// ========================================================================

const FX_KEYS = {
  tabs: 'vaultboard.fx.tabs', active: 'vaultboard.fx.active', expanded: 'vaultboard.fx.expanded',
  hours: 'vaultboard.fx.hours', recentOpen: 'vaultboard.fx.recentOpen', views: 'vaultboard.fx.views',
  recentH: 'vaultboard.fx.recentH',
};
function lsGet(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

const FX = {
  loaded: false,
  tree: new Map(),                                   // dir path ('' = root) -> items
  expanded: new Set(lsGet(FX_KEYS.expanded, [])),
  tabs: lsGet(FX_KEYS.tabs, []),                     // [{ path, pinned }]
  active: lsGet(FX_KEYS.active, null),
  views: lsGet(FX_KEYS.views, {}),                   // path -> 'rendered' | 'source'
  files: new Map(),                                  // path -> payload from /api/fs/file
  changed: new Set(),                                // open tabs whose file changed while in the background
  recent: [],
  hours: lsGet(FX_KEYS.hours, 24),
  recentOpen: lsGet(FX_KEYS.recentOpen, true),
  recentH: lsGet(FX_KEYS.recentH, null),             // px the user dragged it to, or null for the default
  query: '',
  found: null,                                       // search results, or null for the tree
  sideOpen: false,                                   // narrow screens only
};

const FX_ICONS = {
  folder: svg('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
  folderOpen: svg('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
  md: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  text: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>'),
  binary: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>'),
  caret: svg('<polyline points="9 18 15 12 9 6"/>'),
  terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  locate: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  sheet: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
};

const dirOf = (p) => p.split('/').slice(0, -1).join('/');
const baseOf = (p) => p.split('/').pop();
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function saveTabs() {
  lsSet(FX_KEYS.tabs, FX.tabs);
  lsSet(FX_KEYS.active, FX.active);
}

// ---------- Data ----------
async function fxLoadDir(dir) {
  const d = await api('/api/fs/tree?path=' + encodeURIComponent(dir));
  FX.tree.set(dir, d.items);
  return d.items;
}

async function fxLoadRecent() {
  const d = await api('/api/fs/recent?hours=' + FX.hours);
  FX.recent = d.items;
  // Anything open in a tab that's newer on disk than what we rendered is stale.
  for (const r of d.items) {
    const f = FX.files.get(r.path);
    if (f && r.mtime > f.mtime + 1) {
      if (r.path === FX.active && STATE.mode === 'files' && document.visibilityState === 'visible') {
        fxShow(r.path, { keepScroll: true, refetch: true }).catch(() => {});
      } else {
        FX.changed.add(r.path);
        FX.files.delete(r.path);
      }
    }
  }
}

async function fxLoad() {
  $('fx-recent-hours').value = String(FX.hours);
  applyRecentOpen();
  try {
    await fxLoadDir('');
    // Restore expanded folders, dropping any that have since moved or gone.
    await Promise.all([...FX.expanded].map((d) => fxLoadDir(d).catch(() => FX.expanded.delete(d))));
    lsSet(FX_KEYS.expanded, [...FX.expanded]);
    await fxLoadRecent();
  } catch (err) { toast(err.message); return; }
  FX.loaded = true;
  FX.tabs = FX.tabs.filter((t) => t && t.path);
  if (FX.active && !FX.tabs.some((t) => t.path === FX.active)) FX.active = FX.tabs[0] ? FX.tabs[0].path : null;
  fxRenderAll();
  if (FX.active) fxShow(FX.active).catch(() => fxClose(FX.active));
}

async function fxRefresh() {
  await Promise.all([...FX.tree.keys()].map((d) => fxLoadDir(d).catch(() => { FX.tree.delete(d); FX.expanded.delete(d); })));
  await fxLoadRecent();
  if (FX.query) await fxRunSearch(FX.query);
  renderTree();
  renderRecent();
  if (FX.active) await fxShow(FX.active, { keepScroll: true, refetch: true });
}

function fxRenderAll() {
  renderRecent();
  renderTree();
  renderTabs();
  renderView();
}

// ---------- Changed recently ----------
function applyRecentOpen() {
  $('fx-recent').classList.toggle('hidden', !FX.recentOpen);
  $('fx-recent-toggle').setAttribute('aria-expanded', String(FX.recentOpen));
  $('fx-recent-toggle').classList.toggle('collapsed', !FX.recentOpen);
  const sec = $('fx-recent-sec');
  sec.classList.toggle('sized', FX.recentOpen && FX.recentH != null);
  if (FX.recentH != null) sec.style.setProperty('--fx-recent-h', FX.recentH + 'px');
  $('fx-recent-resize').classList.toggle('hidden', !FX.recentOpen);
}

function renderRecent() {
  const el = $('fx-recent');
  if (!FX.recent.length) {
    el.innerHTML = `<p class="fx-empty">Nothing changed in the last ${FX.hours === 1 ? 'hour' : FX.hours === 24 ? '24 hours' : '7 days'}.</p>`;
    return;
  }
  el.innerHTML = FX.recent.map((r) => {
    const fresh = Date.now() - r.mtime < 10 * 60e3;
    return `<button type="button" class="fx-recent-item${r.path === FX.active ? ' active' : ''}" data-path="${esc(r.path)}" title="${esc(r.path)}">
      <span class="fx-recent-name">${fresh ? '<span class="fx-fresh" aria-label="changed in the last 10 minutes"></span>' : ''}${esc(r.name)}</span>
      <span class="fx-recent-dir">${esc(dirOf(r.path))}</span>
      <span class="fx-recent-when">${ago(r.mtime)}</span>
    </button>`;
  }).join('');
}

$('fx-recent').addEventListener('click', (e) => {
  const b = e.target.closest('[data-path]');
  if (b) fxOpen(b.dataset.path);   // the tree stays put; the crosshair in the file bar reveals it
});
$('fx-recent').addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-path]');
  if (b) fxPin(b.dataset.path);
});
$('fx-recent-toggle').addEventListener('click', () => {
  FX.recentOpen = !FX.recentOpen;
  lsSet(FX_KEYS.recentOpen, FX.recentOpen);
  applyRecentOpen();
});
// Drag the bottom edge of "Changed recently" to give it more (or less) of the
// sidebar; double-click the edge to go back to the default size.
$('fx-recent-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const el = $('fx-recent-resize');
  const sec = $('fx-recent-sec');
  const top = sec.getBoundingClientRect().top;
  const max = () => $('fx-side').getBoundingClientRect().bottom - top - 90;   // leave the Vault header + a few rows
  el.setPointerCapture(e.pointerId);
  document.body.classList.add('fx-resizing');
  const move = (ev) => {
    FX.recentH = Math.round(Math.min(Math.max(ev.clientY - top, 80), max()));
    applyRecentOpen();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    document.body.classList.remove('fx-resizing');
    lsSet(FX_KEYS.recentH, FX.recentH);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
});
$('fx-recent-resize').addEventListener('dblclick', () => {
  FX.recentH = null;
  lsSet(FX_KEYS.recentH, null);
  $('fx-recent-sec').classList.remove('sized');
});

$('fx-recent-hours').addEventListener('change', async (e) => {
  FX.hours = Number(e.target.value) || 24;
  lsSet(FX_KEYS.hours, FX.hours);
  try { await fxLoadRecent(); renderRecent(); } catch (err) { toast(err.message); }
});

// ---------- Tree ----------
function fileIcon(kind) { return FX_ICONS[kind] || FX_ICONS.binary; }

function treeRows(dir, depth, out) {
  for (const it of FX.tree.get(dir) || []) {
    const open = it.dir && FX.expanded.has(it.path);
    out.push(`<div class="fx-row${it.dir ? ' dir' : ''}${it.path === FX.active ? ' active' : ''}${open ? ' open' : ''}"`
      + ` role="treeitem" tabindex="-1" data-path="${esc(it.path)}"${it.dir ? ' data-dir="1"' : ''}`
      + (it.dir ? ` aria-expanded="${open}"` : '')
      + ` style="--depth:${depth}" title="${esc(it.path)}">`
      + `<span class="fx-caret">${it.dir ? FX_ICONS.caret : ''}</span>`
      + `<span class="fx-ico">${it.dir ? (open ? FX_ICONS.folderOpen : FX_ICONS.folder) : fileIcon(it.kind)}</span>`
      + `<span class="fx-name">${esc(it.name)}</span></div>`);
    if (open) {
      if (FX.tree.has(it.path)) treeRows(it.path, depth + 1, out);
      else out.push(`<div class="fx-row fx-loading" style="--depth:${depth + 1}">Loading…</div>`);
    }
  }
  return out;
}

function renderTree() {
  const el = $('fx-tree');
  const keep = holdScroll(el);
  if (FX.found) {
    $('fx-tree-title').textContent = FX.found.total > FX.found.items.length
      ? `${FX.found.items.length} of ${FX.found.total} matches` : `${FX.found.total} match${FX.found.total === 1 ? '' : 'es'}`;
    el.innerHTML = FX.found.items.length ? FX.found.items.map((it) =>
      `<div class="fx-row fx-hit${it.dir ? ' dir' : ''}${it.path === FX.active ? ' active' : ''}" role="treeitem" tabindex="-1"`
      + ` data-path="${esc(it.path)}"${it.dir ? ' data-dir="1"' : ''} style="--depth:0" title="${esc(it.path)}">`
      + `<span class="fx-ico">${it.dir ? FX_ICONS.folder : fileIcon(it.kind)}</span>`
      + `<span class="fx-name">${esc(it.name)}<small>${esc(dirOf(it.path))}</small></span></div>`).join('')
      : '<p class="fx-empty">No file or folder names match.</p>';
  } else {
    $('fx-tree-title').textContent = 'Vault';
    el.innerHTML = treeRows('', 0, []).join('');
  }
  keep();
}

async function fxToggleDir(p, force) {
  const open = force ?? !FX.expanded.has(p);
  if (open) FX.expanded.add(p); else FX.expanded.delete(p);
  lsSet(FX_KEYS.expanded, [...FX.expanded]);
  renderTree();
  if (open && !FX.tree.has(p)) {
    try { await fxLoadDir(p); } catch (err) { FX.expanded.delete(p); toast(err.message); }
    renderTree();
  }
}

// Open every ancestor folder of a path (and the path itself, for a folder),
// then scroll its row into view.
async function fxReveal(p, { self = false } = {}) {
  if (FX.found) return;   // search results are showing; the row is already listed
  const segs = p.split('/');
  for (let i = 1; i <= segs.length - (self ? 0 : 1); i++) {
    const d = segs.slice(0, i).join('/');
    FX.expanded.add(d);
    if (!FX.tree.has(d)) { try { await fxLoadDir(d); } catch { break; } }
  }
  lsSet(FX_KEYS.expanded, [...FX.expanded]);
  renderTree();
  const row = $('fx-tree').querySelector(`[data-path="${CSS.escape(p)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

$('fx-tree').addEventListener('click', (e) => {
  const row = e.target.closest('.fx-row[data-path]');
  if (!row) return;
  if (row.dataset.dir) {
    if (FX.found) { fxClearSearch(); fxReveal(row.dataset.path, { self: true }); return; }
    fxToggleDir(row.dataset.path);
  } else {
    fxOpen(row.dataset.path);
    if (FX.sideOpen) setFxSide(false);
  }
});
$('fx-tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.fx-row[data-path]:not([data-dir])');
  if (row) fxPin(row.dataset.path);
});
// Arrow keys walk the rows, Enter opens, Left/Right fold — enough to drive the
// tree without a mouse.
$('fx-tree').addEventListener('keydown', (e) => {
  const rows = [...$('fx-tree').querySelectorAll('.fx-row[data-path]')];
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  const row = rows[i];
  const go = (j) => { if (rows[j]) { e.preventDefault(); rows[j].focus(); } };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'ArrowRight' && row.dataset.dir && !FX.expanded.has(row.dataset.path)) { e.preventDefault(); fxToggleDir(row.dataset.path, true); }
  else if (e.key === 'ArrowLeft' && row.dataset.dir && FX.expanded.has(row.dataset.path)) { e.preventDefault(); fxToggleDir(row.dataset.path, false); }
  else if (e.key === 'Enter') { e.preventDefault(); row.click(); }
});
$('fx-tree').addEventListener('focusin', (e) => {
  // Roving tabindex: only the focused row sits in the tab order.
  for (const r of $('fx-tree').querySelectorAll('[tabindex="0"]')) r.tabIndex = -1;
  const row = e.target.closest('.fx-row');
  if (row) row.tabIndex = 0;
});
// Files an agent writes while you're looking don't appear by themselves: the
// tree is fetched per folder and cached. The button rescans every open folder
// (and the open file); coming back to the tab/app does the same quietly.
$('fx-refresh').addEventListener('click', () => withRefreshFeedback($('fx-refresh'), fxRefresh));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && STATE.mode === 'files' && FX.loaded) fxRefresh().catch(() => {});
});
$('fx-collapse').addEventListener('click', () => {
  FX.expanded.clear();
  lsSet(FX_KEYS.expanded, []);
  renderTree();
});

// ---------- Search (the header box, in Files mode) ----------
async function fxRunSearch(q) {
  FX.found = await api('/api/fs/find?q=' + encodeURIComponent(q));
}
const fxSearch = debounce(async (q) => {
  FX.query = q.trim();
  if (!FX.query) { FX.found = null; renderTree(); return; }
  try { await fxRunSearch(FX.query); renderTree(); } catch (err) { toast(err.message); }
}, 200);
function fxClearSearch() {
  FX.query = '';
  FX.found = null;
  if (STATE.mode === 'files') $('search').value = '';
}

// ---------- Tabs ----------
// VS Code's model: a single click opens a *preview* tab (italic) that the next
// single click reuses, so browsing doesn't pile up tabs. Double-click — or
// opening from a path you clicked in the terminal or the drawer — pins it.
function fxOpen(p, { pin = false, reveal = false } = {}) {
  if (STATE.mode !== 'files') setMode('files');
  let tab = FX.tabs.find((t) => t.path === p);
  if (!tab) {
    let previewIdx = FX.tabs.findIndex((t) => !t.pinned);
    tab = { path: p, pinned: pin };
    // A preview tab holding unsaved spreadsheet edits is never replaced: it becomes a kept tab instead.
    if (!pin && previewIdx >= 0 && ((window.SheetFiles && SheetFiles.isDirty(FX.tabs[previewIdx].path)) || TextEdit.isDirty(FX.tabs[previewIdx].path))) {
      FX.tabs[previewIdx].pinned = true;
      previewIdx = -1;
    }
    if (!pin && previewIdx >= 0) {
      const old = FX.tabs[previewIdx].path;
      FX.files.delete(old);
      TextEdit.drop(old);
      if (window.SheetFiles) SheetFiles.drop(old);
      FX.tabs[previewIdx] = tab;
    } else {
      const at = FX.tabs.findIndex((t) => t.path === FX.active);
      FX.tabs.splice(at >= 0 ? at + 1 : FX.tabs.length, 0, tab);
    }
  } else if (pin) tab.pinned = true;
  FX.active = p;
  saveTabs();
  renderTabs();
  if (reveal) fxReveal(p);
  return fxShow(p).catch((err) => { toast(err.message); fxClose(p); });
}

function fxPin(p) {
  const tab = FX.tabs.find((t) => t.path === p);
  if (tab) { tab.pinned = true; saveTabs(); renderTabs(); } else fxOpen(p, { pin: true });
}

function fxClose(p) {
  const i = FX.tabs.findIndex((t) => t.path === p);
  if (i < 0) return;
  // A file with unsaved edits asks first; closing its tab drops its grid or its draft.
  if (!TextEdit.confirmDiscard(p)) return;
  TextEdit.drop(p);
  if (window.SheetFiles) {
    if (!SheetFiles.confirmDiscard(p)) return;
    SheetFiles.drop(p);
  }
  FX.tabs.splice(i, 1);
  FX.files.delete(p);
  FX.changed.delete(p);
  if (FX.active === p) {
    const next = FX.tabs[i] || FX.tabs[i - 1];
    FX.active = next ? next.path : null;
  }
  saveTabs();
  renderTabs();
  if (FX.active) fxShow(FX.active).catch(() => {});
  else { renderView(); renderTree(); }
}

// `.changed` (● after the name) = changed on disk while in the background; `.unsaved` (● in place of the ×) = a
// spreadsheet with edits not saved yet.
function renderTabs() {
  const el = $('fx-tabs');
  el.innerHTML = FX.tabs.map((t) => {
    const unsaved = (!!window.SheetFiles && SheetFiles.isDirty(t.path)) || TextEdit.isDirty(t.path);
    return `<div class="fx-tab${t.path === FX.active ? ' active' : ''}${t.pinned ? '' : ' preview'}${FX.changed.has(t.path) ? ' changed' : ''}${unsaved ? ' unsaved' : ''}"`
      + ` role="tab" aria-selected="${t.path === FX.active}" data-path="${esc(t.path)}" title="${esc(t.path)}${t.pinned ? '' : ' (preview — double-click to keep)'}">`
      + `<span class="fx-ico">${fileIcon(fxKindOf(t.path))}</span><span class="fx-tab-name">${esc(baseOf(t.path))}</span>`
      + `<button type="button" class="fx-tab-x" aria-label="Close ${esc(baseOf(t.path))}${unsaved ? ' (unsaved changes)' : ''}">${ICONS.close}</button></div>`;
  }).join('');
  const act = el.querySelector('.fx-tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function fxKindOf(p) {
  const f = FX.files.get(p);
  if (f) return f.kind;
  if (/\.md$/i.test(p)) return 'md';
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(p)) return 'image';
  if (/\.(csv|xlsx)$/i.test(p)) return 'sheet';
  return 'text';
}

$('fx-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.fx-tab');
  if (!tab) return;
  if (e.target.closest('.fx-tab-x')) { fxClose(tab.dataset.path); return; }
  if (tab.dataset.path !== FX.active) {
    FX.active = tab.dataset.path;
    saveTabs();
    renderTabs();
    fxShow(FX.active).catch((err) => toast(err.message));
  }
});
$('fx-tabs').addEventListener('dblclick', (e) => {
  const tab = e.target.closest('.fx-tab');
  if (tab && !e.target.closest('.fx-tab-x')) fxPin(tab.dataset.path);
});
$('fx-tabs').addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.fx-tab');
  if (tab && e.button === 1) { e.preventDefault(); fxClose(tab.dataset.path); }
});

// ---------- Viewer ----------
async function fxShow(p, { keepScroll = false, refetch = false } = {}) {
  let f = FX.files.get(p);
  if (!f || refetch || FX.changed.has(p)) {
    f = await api('/api/fs/file?path=' + encodeURIComponent(p));
    FX.files.set(p, f);
    FX.changed.delete(p);
  }
  if (p !== FX.active) return;   // the user moved on while this was loading
  renderTabs();
  renderView({ keepScroll });
  for (const r of document.querySelectorAll('#fx-tree .fx-row.active, #fx-recent .active')) r.classList.remove('active');
  for (const r of document.querySelectorAll(`#fx-tree [data-path="${CSS.escape(p)}"], #fx-recent [data-path="${CSS.escape(p)}"]`)) r.classList.add('active');
}

function crumbs(p) {
  const segs = p.split('/');
  return segs.map((s, i) => i < segs.length - 1
    ? `<button type="button" class="fx-crumb" data-dir="${esc(segs.slice(0, i + 1).join('/'))}">${esc(s)}</button><span class="fx-sep">/</span>`
    : `<span class="fx-crumb-last">${esc(s)}</span>`).join('');
}

function metaBlock(meta) {
  const keys = Object.keys(meta || {});
  if (!keys.length) return '';
  return `<details class="fx-props"${keys.length <= 8 ? ' open' : ''}><summary>Properties <span class="n">${keys.length}</span></summary><dl>`
    + keys.map((k) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(meta[k]) ? meta[k].join(', ') : meta[k])}</dd>`).join('')
    + '</dl></details>';
}

function renderView({ keepScroll = false } = {}) {
  const view = $('fx-view');
  const bar = $('fx-bar');
  const p = FX.active;
  const f = p && FX.files.get(p);
  // .md: Rendered | Source. A spreadsheet is a grid; a .csv also has its text, so Grid | Source.
  const csvText = !!f && f.kind === 'sheet' && /\.csv$/i.test(p) && f.source != null;
  const mode = !f ? null : f.kind === 'md' ? (FX.views[p] || 'source')
    : f.kind === 'sheet' ? (csvText ? FX.views[p] || 'grid' : 'grid') : null;
  const grid = !!f && f.kind === 'sheet' && mode === 'grid' && !!window.SheetFiles;
  // Tell the grid on screen what comes next: another file, or this one not as a grid (CSV Source), suspends
  // it (closes its editor); a re-render of the same grid (the 8s poll, coming back to the tab, Re-read)
  // leaves it alone. The class only changes when the kind of view does: toggling it on every re-render
  // would make the browser lay the whole grid out again.
  if (window.SheetFiles) SheetFiles.beforeViewChange(p || null, grid ? 'grid' : f ? f.kind : null);
  view.classList.toggle('fx-view-sheet', grid);
  if (!p) {
    bar.classList.add('hidden');
    view.innerHTML = fxWelcome();
    return;
  }
  if (!f) { bar.classList.add('hidden'); view.innerHTML = '<p class="fx-empty fx-pad">Loading…</p>'; return; }
  const restore = keepScroll ? holdScroll(view) : null;
  const views = f.kind === 'md' ? [['rendered', 'Rendered'], ['source', 'Source']] : csvText ? [['grid', 'Grid'], ['source', 'Source']] : null;
  bar.classList.remove('hidden');
  bar.innerHTML = `<nav class="fx-crumbs" aria-label="Path">${crumbs(p)}</nav>
    <span class="fx-when" title="${esc(new Date(f.mtime).toLocaleString())}">edited ${ago(f.mtime)}</span>
    ${views ? `<div class="seg fx-seg" role="group" aria-label="View">${views.map(([v, label]) => `<button data-v="${v}" class="${mode === v ? 'on' : ''}">${label}</button>`).join('')}</div>` : ''}
    ${grid ? SheetFiles.barHtml(p, f) : ''}
    ${TextEdit.barHtml(p, f, mode)}
    <span class="fx-tools">
    <button type="button" class="ghost fx-bar-btn" id="fx-locate" title="Show in the tree" aria-label="Show in the tree">${FX_ICONS.locate}</button>
    ${f.source != null ? `<button type="button" class="ghost fx-bar-btn fx-copyall" id="fx-copyall" title="Copy the whole file (or Ctrl+A in the file, then Ctrl+C)">${ICONS.copy}<span>Copy file</span></button>` : ''}
    <button type="button" class="ghost fx-bar-btn" id="fx-copy" title="Copy vault path" aria-label="Copy vault path">${FX_ICONS.link}</button>
    <button type="button" class="ghost fx-bar-btn" id="fx-download" title="Download this file" aria-label="Download">${FX_ICONS.download}</button>
    ${termOn() ? `<button type="button" class="ghost fx-bar-btn" id="fx-term" title="Open the terminal in this folder" aria-label="Terminal here">${FX_ICONS.terminal}</button>` : ''}
    <button type="button" class="ghost fx-bar-btn" id="fx-reload" title="Re-read from disk" aria-label="Refresh file">${FX_ICONS.refresh}</button>
    </span>`;

  if (TextEdit.isEditing(p) && TextEdit.canEdit(f, mode)) {
    TextEdit.mount(view, p, f);
  } else if (f.kind === 'md' && mode === 'rendered') {
    view.innerHTML = `<div class="fx-doc"><h1 class="fx-title">${esc(f.title)}</h1>${metaBlock(f.meta)}<article class="markdown fx-md">${f.html}</article></div>`;
    wireDocLinks(view, p);
    const diagrams = hydrateDiagrams(view);
    if (restore) diagrams.then(restore, restore);
  } else if (f.kind === 'md' || f.kind === 'text' || (f.kind === 'sheet' && mode === 'source')) {
    view.innerHTML = `<pre class="fx-source"><code>${sourceLines(f.source)}</code></pre>`;
  } else if (grid) {
    SheetFiles.mount(view, p, f);
    return;
  } else if (f.kind === 'image') {
    view.innerHTML = `<div class="fx-image"><img src="/api/fs/raw?path=${encodeURIComponent(p)}&v=${Math.round(f.mtime)}" alt="${esc(f.name)}"></div>`;
  } else {
    view.innerHTML = `<div class="fx-binary"><p><b>${esc(f.name)}</b></p><p>${f.tooLarge ? 'Too large to preview here' : 'No preview for this file type'} · ${(f.size / 1024).toFixed(1)} KB</p></div>`;
  }
  if (restore) restore(); else view.scrollTop = 0;
}

// One <span> per line so CSS counters can number them without the numbers
// ending up in a copy-paste. Split on \r?\n: Windows files (most .ps1) are
// CRLF, and a stray \r left in a span becomes a newline once parsed as HTML,
// so every line copied out double-spaced.
function sourceLines(src) {
  const lines = String(src ?? '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => `<span class="ln">${esc(l)}</span>`).join('');
}

// ---------- Select all / copy inside the open file ----------
// Ctrl+A (Cmd+A) in Files selects the open file's contents, not the whole app.
// It only steps in when focus isn't somewhere that has its own select-all: a
// text box, or the terminal (xterm's hidden textarea is a <textarea>, so the
// first check covers it).
function inOwnSelectAll(el) {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}
function fxSelectable() {
  return $('fx-view').querySelector('.fx-source code, .fx-md');
}
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'a') return;
  if (STATE.mode !== 'files' || inOwnSelectAll(document.activeElement)) return;
  // A spreadsheet grid on screen: Ctrl+A selects its cells (and gives it the keyboard), not the page.
  if (window.SheetFiles && SheetFiles.selectAll()) { e.preventDefault(); return; }
  const target = fxSelectable();
  if (!target) return;
  e.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

// Each source line is its own block <span> (that's what numbers it), and a
// browser copies block boundaries unpredictably — sometimes one newline,
// sometimes two. Rebuild the text from the selected lines instead, so a
// copy is byte-for-byte what's in the file. Line numbers are CSS counters,
// so they were never in the text to begin with.
document.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const code = $('fx-view').querySelector('.fx-source code');
  if (!code || !code.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  const frag = sel.getRangeAt(0).cloneContents();
  const lines = frag.querySelectorAll('.ln');
  if (!lines.length) return;   // inside a single line: the default copy is already right
  e.preventDefault();
  e.clipboardData.setData('text/plain', [...lines].map((l) => l.textContent).join('\n'));
});

// Relative links inside a rendered note ([guide](../notes/x.md)) open as tabs
// instead of navigating the whole app away.
function wireDocLinks(root, docPath) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^([a-z]+:|#|\/api\/|\/\/)/i.test(href)) continue;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const base = href.startsWith('/') ? [] : dirOf(docPath).split('/').filter(Boolean);
      for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') base.pop(); else base.push(seg);
      }
      fxOpen(base.join('/'), { pin: true, reveal: true });
    });
  }
}

function fxWelcome() {
  const top = FX.recent.slice(0, 6);
  return `<div class="fx-welcome">
    <h2>Files</h2>
    <p>The whole vault, read-only. Click a file for a preview tab, double-click to keep it open. Paths the agent prints in the terminal are clickable and land here.</p>
    ${top.length ? `<h3>Just changed</h3><div class="fx-welcome-list">${top.map((r) =>
      `<button type="button" data-path="${esc(r.path)}"><span class="fx-ico">${fileIcon(r.kind)}</span><span class="fx-name">${esc(r.name)}<small>${esc(dirOf(r.path))}</small></span><span class="fx-recent-when">${ago(r.mtime)}</span></button>`).join('')}</div>` : ''}
    <p class="fx-hint">${termOn() ? '<kbd>Ctrl</kbd>+<kbd>`</kbd> terminal · ' : ''}type in the search box to find a file by name</p>
  </div>`;
}

$('fx-view').addEventListener('click', (e) => {
  const b = e.target.closest('.fx-welcome-list [data-path]');
  if (b) fxOpen(b.dataset.path, { pin: true, reveal: true });
});

$('fx-bar').addEventListener('click', (e) => {
  const p = FX.active;
  if (!p) return;
  const crumb = e.target.closest('.fx-crumb');
  if (crumb) {
    fxClearSearch();
    fxReveal(crumb.dataset.dir, { self: true });
    if (window.matchMedia('(max-width: 900px)').matches) setFxSide(true);
    return;
  }
  const seg = e.target.closest('.fx-seg button');
  if (seg) {
    if (TextEdit.isEditing(p)) {   // another view of a file being edited: finish or discard the edit first
      if (!TextEdit.confirmDiscard(p)) return;
      TextEdit.drop(p);
      renderTabs();
    }
    FX.views[p] = seg.dataset.v; lsSet(FX_KEYS.views, FX.views); renderView(); return;
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  if (TextEdit.onBar(btn, p)) return;
  if (window.SheetFiles && SheetFiles.onBar(btn, p)) return;
  if (btn.id === 'fx-locate') { fxClearSearch(); fxReveal(p); if (window.matchMedia('(max-width: 900px)').matches) setFxSide(true); }
  else if (btn.id === 'fx-copy') copyText(p).then(() => toast('Copied ' + p));
  else if (btn.id === 'fx-copyall') {
    const f = FX.files.get(p);
    if (f && f.source != null) copyText(f.source).then(() => toast(`Copied ${baseOf(p)} (${f.source.split('\n').length} lines)`));
  }
  else if (btn.id === 'fx-download') fxDownload(p);
  else if (btn.id === 'fx-term') termOpen({ cwd: dirOf(p) });
  else if (btn.id === 'fx-reload') withRefreshFeedback(btn, () => fxShow(p, { keepScroll: true, refetch: true }));
});

// ---------- Download ----------
// A plain <a download> click: the server answers with Content-Disposition:
// attachment, so the browser saves it (to Downloads, or asks where) instead of
// navigating. Works for every kind, including ones Files can't preview.
function fxDownload(p) {
  const a = document.createElement('a');
  a.href = '/api/fs/download?path=' + encodeURIComponent(p);
  a.download = baseOf(p);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Right-click menu (tree, Changed recently, tabs) ----------
const fxMenu = document.createElement('div');
fxMenu.className = 'fx-menu hidden';
fxMenu.setAttribute('role', 'menu');
document.body.appendChild(fxMenu);
let FX_MENU_TARGET = null;   // { path, dir }

function fxMenuClose() {
  fxMenu.classList.add('hidden');
  FX_MENU_TARGET = null;
}
function fxMenuOpen(x, y, target) {
  FX_MENU_TARGET = target;
  const item = (act, icon, label) => `<button type="button" role="menuitem" data-act="${act}">${icon}<span>${label}</span></button>`;
  const term = termOn() ? item('term', FX_ICONS.terminal, 'Terminal here') : '';
  fxMenu.innerHTML = target.dir
    ? item('upload', FX_ICONS.upload, 'Upload files here…')
      + item('copy', FX_ICONS.link, 'Copy vault path')
      + term
    : item('open', FX_ICONS.md, 'Open')
      + item('download', FX_ICONS.download, 'Download')
      + item('copy', FX_ICONS.link, 'Copy vault path')
      + item('upload', FX_ICONS.upload, 'Upload files to this folder…')
      + term;
  fxMenu.classList.remove('hidden');
  // Keep it on screen: flip left/up when it would run off the edge.
  const r = fxMenu.getBoundingClientRect();
  fxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  fxMenu.style.top = Math.max(4, y + r.height > window.innerHeight - 4 ? y - r.height : y) + 'px';
  fxMenu.querySelector('button').focus();
}

document.addEventListener('contextmenu', (e) => {
  if (STATE.mode !== 'files') return;
  const el = e.target.closest('#fx-tree [data-path], #fx-recent [data-path], #fx-tabs [data-path], .fx-welcome-list [data-path]');
  if (!el) return;
  e.preventDefault();
  fxMenuOpen(e.clientX, e.clientY, { path: el.dataset.path, dir: !!el.dataset.dir });
});
fxMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  const t = FX_MENU_TARGET;
  if (!b || !t) return;
  fxMenuClose();
  const folder = t.dir ? t.path : dirOf(t.path);
  if (b.dataset.act === 'open') fxOpen(t.path, { pin: true });
  else if (b.dataset.act === 'download') fxDownload(t.path);
  else if (b.dataset.act === 'copy') copyText(t.path).then(() => toast('Copied ' + t.path));
  else if (b.dataset.act === 'term') termOpen({ cwd: folder });
  else if (b.dataset.act === 'upload') fxPickUpload(folder);
});
fxMenu.addEventListener('keydown', (e) => {
  const items = [...fxMenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fxMenuClose(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
document.addEventListener('pointerdown', (e) => { if (FX_MENU_TARGET && !fxMenu.contains(e.target)) fxMenuClose(); }, true);
window.addEventListener('blur', () => { if (FX_MENU_TARGET) fxMenuClose(); });
window.addEventListener('resize', () => { if (FX_MENU_TARGET) fxMenuClose(); });
$('fx-tree').addEventListener('scroll', () => { if (FX_MENU_TARGET) fxMenuClose(); });

// ---------- Upload (drag from the desktop, or the menu's file picker) ----------
// Drop on a folder row → into that folder; on a file row → beside it; on the
// open file's view → its folder; on the tree's empty space → the vault root.
// Hovering a closed folder for a moment opens it, so you can drag deep without
// letting go. A dropped folder uploads with its sub-folders.
function fxPickUpload(folder) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.addEventListener('change', () => fxUpload(folder, [...inp.files].map((f) => ({ file: f, name: f.name }))));
  inp.click();
}

// DataTransfer items must be read synchronously inside the drop event; the
// entries they hand out can be walked afterwards.
function fxDropEntries(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every(Boolean)) return fxWalkEntries(entries, '');
  return Promise.resolve([...dt.files].map((f) => ({ file: f, name: f.name })));
}
async function fxWalkEntries(entries, prefix) {
  const out = [];
  for (const en of entries) {
    if (en.isFile) {
      const file = await new Promise((res, rej) => en.file(res, rej));
      out.push({ file, name: prefix + en.name });
    } else if (en.isDirectory) {
      const reader = en.createReader();
      const kids = [];
      // readEntries returns in batches (100 in Chrome) until it returns none.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        kids.push(...batch);
      }
      out.push(...await fxWalkEntries(kids, prefix + en.name + '/'));
    }
  }
  return out;
}

function fxPut(folder, item, overwrite, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/fs/upload?dir=' + encodeURIComponent(folder) + '&name=' + encodeURIComponent(item.name) + (overwrite ? '&overwrite=1' : ''));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON (e.g. a proxy's 413 page) */ }
      if (xhr.status === 401) { showLogin(); reject(new Error('Not authenticated')); return; }
      if (xhr.status === 413 && !data.error) data.error = 'Too large for the proxy in front of VaultOS';
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(item.file);
  });
}

// Skip the OS's junk files that ride along with a dropped folder; the server
// would refuse the dot-named ones anyway.
const FX_UPLOAD_JUNK = /(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini)$/i;
let FX_UPLOADING = false;

async function fxUpload(folder, items) {
  items = items.filter((it) => !FX_UPLOAD_JUNK.test(it.name));
  if (!items.length) return;
  if (FX_UPLOADING) { toast('An upload is already running'); return; }
  FX_UPLOADING = true;
  const where = folder || 'the vault root';
  const done = [];
  const failed = [];
  let replaceAll = null;   // null = ask each time
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const label = items.length > 1 ? `Uploading ${i + 1}/${items.length}: ${it.name}` : `Uploading ${it.name}`;
      const progress = (f) => toast(`${label} — ${Math.round(f * 100)}%`);
      progress(0);
      let r = await fxPut(folder, it, false, progress).catch((err) => ({ status: 0, data: { error: err.message } }));
      if (r.status === 409 && r.data.exists) {
        let ok = replaceAll;
        if (ok == null) {
          ok = confirm(`"${r.data.path}" already exists.\n\nReplace it with the one you're uploading?`);
          if (items.length - i > 1 && confirm(`Do the same (${ok ? 'replace' : 'skip'}) for any other files that already exist?`)) replaceAll = ok;
        }
        if (!ok) { failed.push(`${it.name} (kept the existing file)`); continue; }
        r = await fxPut(folder, it, true, progress).catch((err) => ({ status: 0, data: { error: err.message } }));
      }
      if (r.status === 200) done.push(r.data.path);
      else failed.push(`${it.name}: ${r.data.error || 'failed'}`);
    }
  } finally {
    FX_UPLOADING = false;
  }
  // Show the result where it landed: open the target folder and re-read it.
  if (done.length) {
    const dirs = new Set([folder, ...done.map(dirOf)]);
    for (const d of [...FX.tree.keys()]) if (dirs.has(d) || [...dirs].some((x) => x.startsWith(d + '/'))) FX.tree.delete(d);
    if (folder) await fxReveal(folder, { self: true });
    else { await fxLoadDir('').catch(() => {}); renderTree(); }
    await Promise.all([...FX.expanded].filter((d) => !FX.tree.has(d)).map((d) => fxLoadDir(d).catch(() => FX.expanded.delete(d))));
    fxLoadRecent().then(renderRecent, () => {});
    renderTree();
    if (done.length === 1) fxOpen(done[0], { reveal: true });
  }
  const ok = done.length ? `Uploaded ${done.length} file${done.length === 1 ? '' : 's'} to ${where}` : '';
  toast(failed.length ? [ok, `Not uploaded: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ''}`].filter(Boolean).join(' · ') : ok);
}

// --- Drag and drop ---
const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let FX_DROP_EL = null;
let FX_DROP_T = null;
let FX_DROP_HOVER = null;
function fxDropTarget(e) {
  const row = e.target.closest('#fx-tree .fx-row[data-path]');
  if (row) return { el: row.dataset.dir ? row : null, folder: row.dataset.dir ? row.dataset.path : dirOf(row.dataset.path), row };
  if (e.target.closest('#fx-tree')) return { el: $('fx-tree'), folder: '' };
  if (e.target.closest('.fx-main') && FX.active) return { el: $('fx-view'), folder: dirOf(FX.active) };
  return null;
}
function fxDropMark(el, folder) {
  if (FX_DROP_EL !== el) {
    if (FX_DROP_EL) FX_DROP_EL.classList.remove('fx-drop');
    FX_DROP_EL = el;
    if (el) el.classList.add('fx-drop');
  }
  $('files-view').dataset.dropHint = folder == null ? '' : `Drop to upload into ${folder || 'the vault root'}`;
}
function fxDropClear() {
  fxDropMark(null, null);
  clearTimeout(FX_DROP_T);
  FX_DROP_HOVER = null;
  $('files-view').classList.remove('fx-dragging');
}
$('files-view').addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  const t = fxDropTarget(e);
  if (!t) { e.dataTransfer.dropEffect = 'none'; fxDropMark(null, null); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $('files-view').classList.add('fx-dragging');
  // A file row highlights its parent folder's row when that's on screen.
  const el = t.el || $('fx-tree').querySelector(`.fx-row[data-dir][data-path="${CSS.escape(t.folder)}"]`) || $('fx-tree');
  fxDropMark(el, t.folder);
  // Spring-load: hovering a closed folder opens it after 700ms.
  const dirRow = t.row && t.row.dataset.dir && !FX.expanded.has(t.row.dataset.path) ? t.row.dataset.path : null;
  if (dirRow !== FX_DROP_HOVER) {
    clearTimeout(FX_DROP_T);
    FX_DROP_HOVER = dirRow;
    if (dirRow) FX_DROP_T = setTimeout(() => fxToggleDir(dirRow, true), 700);
  }
});
$('files-view').addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !$('files-view').contains(e.relatedTarget)) fxDropClear();
});
$('files-view').addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  const t = fxDropTarget(e);
  fxDropClear();
  if (!t) return;
  e.preventDefault();
  fxDropEntries(e.dataTransfer).then((items) => fxUpload(t.folder, items), (err) => toast(err.message));
});
// A file dropped anywhere else would make the browser navigate away to it.
for (const ev of ['dragover', 'drop']) {
  window.addEventListener(ev, (e) => { if (isFileDrag(e) && !e.defaultPrevented) e.preventDefault(); });
}

// ---------- Narrow screens: the tree is a slide-over ----------
function setFxSide(open) {
  FX.sideOpen = open;
  $('fx-layout').classList.toggle('fx-side-open', open);
}
$('fx-side-toggle').addEventListener('click', () => setFxSide(!FX.sideOpen));
$('fx-scrim').addEventListener('click', () => setFxSide(false));

// ---------- Live: poll while Files is on screen ----------
// A 1,800-file stat walk every 8s is cheap, and it's the one request that
// both refreshes "Changed recently" and notices the open file changed under us.
setInterval(() => {
  if (!FX.loaded || STATE.mode !== 'files' || document.visibilityState !== 'visible') return;
  fxLoadRecent().then(() => { renderRecent(); renderTabs(); }).catch(() => {});
}, 8000);
window.addEventListener('focus', () => {
  if (FX.loaded && STATE.mode === 'files') fxLoadRecent().then(() => { renderRecent(); renderTabs(); }).catch(() => {});
});

// ---------- Task drawer: Show in Files / Terminal here ----------
// Two icon buttons in the drawer header. Their tooltips name the actual folder,
// so hovering tells you exactly where you're about to land.
let DRAWER_TASK = null;
function renderWorkbenchLinks(t) {
  DRAWER_TASK = t;
  const dir = dirOf(t.path);
  const short = dir.split('/').slice(-2).join('/');
  $('d-files').dataset.tip = `Show in Files\nOpens ${short}/ in the file tree, with task.md in a tab`;
  renderDrawerAgent();
}
// The drawer's agent button: "Start agent" until a terminal is working this
// task, then "Go to agent" with that terminal's state as a dot.
function renderDrawerAgent() {
  if (!DRAWER_TASK) return;
  const a = TASK_AGENTS[DRAWER_TASK.path];
  const short = dirOf(DRAWER_TASK.path).split('/').slice(-2).join('/');
  const btn = $('d-agent');
  const state = a ? twAgentText(a.state, agentLabel()) : '';
  btn.dataset.tip = a
    ? `Go to agent\n${state} — jump to its terminal`
    : `Start agent\nOpens ${agentLabel() || 'the agent'} in ${short}/ to brief you on where it stands and what's next`;
  btn.setAttribute('aria-label', a ? `Go to agent (${state})` : 'Start agent');
  // The default agent's own logo in place of the generic robot.
  const id = ME.agent && ME.agent.profile;
  if (id && btn.dataset.mark !== id && typeof AgentMarks !== 'undefined') {
    btn.querySelector('svg').outerHTML = AgentMarks.svg(id).replace('<svg ', '<svg class="icon" ');
    btn.dataset.mark = id;
  }
  const dot = btn.querySelector('.agent-dot');
  dot.classList.toggle('hidden', !a);
  dot.dataset.agent = a ? a.state : '';
}
$('d-files').addEventListener('click', () => {
  if (!DRAWER_TASK) return;
  // Remember where we were, so going back to the Board reopens this task
  // at the same scroll position instead of leaving you to find the card again.
  RETURN_TASK = { path: DRAWER_TASK.path, ws: STATE.workspace, scroll: $('drawer').scrollTop };
  closeDrawer();
  fxOpen(DRAWER_TASK.path, { pin: true, reveal: true });
});

// Back to the Board after "Show in Files": reopen the task you left from, once.
// Skipped if the workspace changed in between (the card may not exist there).
let RETURN_TASK = null;
$('mode-board').addEventListener('click', async () => {
  const r = RETURN_TASK;
  RETURN_TASK = null;
  if (!r || r.ws !== STATE.workspace) return;
  await openTask(r.path);
  if (OPEN && OPEN.path === r.path) $('drawer').scrollTop = r.scroll;
});
// Start agent: a new terminal in the task's folder, linked to the task, with
// the chosen agent (Settings → Agent) already started on it. If a terminal is
// already on this task, go there instead of starting a second agent on the
// same files. The command is the server's (ME.agent.startCommand): the agent's
// start command with the check-in prompt quoted in. The check-in asks for a
// brief, not the work: that starts when the person says so.
$('d-agent').addEventListener('click', () => {
  if (!DRAWER_TASK) return;
  const a = TASK_AGENTS[DRAWER_TASK.path];
  if (a) goToAgent(a.id);
  else if (ME.agent) termOpen({ cwd: dirOf(DRAWER_TASK.path), task: DRAWER_TASK.path, run: ME.agent.startCommand });
});

// ========================================================================
// Terminals in the bottom dock. The workspace itself (sessions, tabs, tiling,
// dividers) is createTermWorkspace() in termui.js, shared with the pop-out
// window. This part owns the dock around it and the hand-over:
//  - Pop out moves the focused session into the one "VaultOS Terminals"
//    window (opening it if needed). That window is a full workspace too.
//  - Closing (or reloading) that window hands every session in it back to the
//    dock. Nothing is lost.
// ========================================================================
const TERM_KEYS = { open: 'vaultboard.term.open', h: 'vaultboard.term.h', returning: 'vaultboard.term.returning' };
const POPOUT_NAME = 'vaultos-terminals';
const dockVisible = () => !$('term-dock').classList.contains('hidden');

const TW = createTermWorkspace($('term-area'), {
  store: 'vaultboard.term',
  persist: true,
  host: 'dock',
  sideDefault: 'rail',
  // A terminal the Terminals window holds is shown there, not taken from it.
  goElsewhere: (id) => TW.where(id) === 'window' && (() => { const w = openTermWindow(); if (w) handToWindow(w, [{ id }]); return !!w; })(),
  extraButtons:
    `<button id="term-pop" class="ghost" type="button" title="Move this space to its own window — you can open more there" aria-label="Pop out"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>`
    + `<button id="term-min" class="ghost" type="button" title="Minimise (the shells keep running) — Ctrl+\`" aria-label="Minimise terminals"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`
    + `<button id="term-close" class="ghost" type="button" title="Close — ends every terminal session" aria-label="Close terminals"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`,
  onOpenPath: (rel) => fxOpen(rel, { pin: true, reveal: true }),
  onChange: (n) => { $('termbtn').dataset.n = n || ''; },
  beforeNew: () => showTerminals(),
  isActive: dockVisible,
  agentLabel,
});

function applyDockSize() {
  const h = Math.min(Math.max(lsGet(TERM_KEYS.h, 340), 160), window.innerHeight - 120);
  document.body.style.setProperty('--dock-user-h', h + 'px');
}

function dockShow(show) {
  $('term-dock').classList.toggle('hidden', !show);
  document.body.classList.toggle('dock-open', show);
  $('termbtn').setAttribute('aria-pressed', String(show));
  $('termbtn').classList.toggle('on', show);
  lsSet(TERM_KEYS.open, show);
  if (show) { TW.layout(); TW.markSeen(); const f = TW.focused(); if (f) requestAnimationFrame(() => f.handle.focus()); }
}

// Never with the terminal off (Settings → Features, or TERMINAL=0): nothing opens or reopens a shell then.
function showTerminals() {
  if (!termOn()) return;
  applyDockSize();
  dockShow(true);
}

// ---------- Window or dock ----------
// Where a terminal button opens a shell: the one "VaultOS Terminals" window
// (the default) or the dock. A phone always gets the dock — a second window
// there is just another browser tab. Closing the window still hands its
// sessions back to the dock (adoptReturned below), so "snap back" is free.
const TERM_WHERE_KEY = 'vaultboard.term.where';
const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
const termWhere = () => (isPhone() ? 'dock' : lsGet(TERM_WHERE_KEY, 'window'));
segSet('segTermWhere', lsGet(TERM_WHERE_KEY, 'window'));
for (const b of document.querySelectorAll('#segTermWhere button')) b.addEventListener('click', () => {
  lsSet(TERM_WHERE_KEY, b.dataset.v);
  segSet('segTermWhere', b.dataset.v);
});
// Agent sound: a chime when an agent needs you or finishes (read by termui).
segSet('segTermSound', lsGet('vaultboard.term.sound', false) ? 'on' : 'off');
for (const b of document.querySelectorAll('#segTermSound button')) b.addEventListener('click', () => {
  lsSet('vaultboard.term.sound', b.dataset.v === 'on');
  segSet('segTermSound', b.dataset.v);
});

// window.open('', name) returns the existing Terminals window without
// reloading it, or a blank new one. Must run synchronously inside the click,
// or the browser treats it as an unrequested pop-up.
function openTermWindow() {
  const w = window.open('', POPOUT_NAME, 'popup,width=1100,height=720');
  if (!w) toast('Pop-up blocked — allow pop-ups for this site');
  return w;
}
// Give sessions to that window: an existing one takes them straight away via
// its twAdopt(); a blank one is pointed at terminal.html with them in the URL
// (with none, terminal.html starts a fresh shell of its own).
// Jump to a terminal by id, wherever it is: the dock, the Terminals window, or
// nowhere yet (detached — reattached in the usual place). Synchronous, so it can
// open the window from inside the click that asked for it.
function goToAgent(id) {
  if (TW.session(id)) { showTerminals(); TW.focus(id); return; }
  const a = Object.values(TASK_AGENTS).find((x) => x.id === id) || {};
  const m = { id, cwd: a.cwd || '', task: a.task || '' };
  // Already in the window, or the window is where terminals open: hand it over.
  if (TW.where(id) === 'window' || termWhere() === 'window') {
    const w = openTermWindow();
    if (w) { handToWindow(w, [m]); return; }
  }
  showTerminals();
  TW.bring(m);
}

function handToWindow(w, metas) {
  let adopted = false;
  try { if (typeof w.twAdopt === 'function') { if (metas.length) w.twAdopt(metas); adopted = true; } } catch { /* not ours yet */ }
  if (!adopted) w.location.href = 'terminal.html' + (metas.length ? '?adopt=' + encodeURIComponent(JSON.stringify(metas)) : '');
  w.focus();
}

// Open a terminal from elsewhere in the app. With a cwd it's a *new* session
// in that folder, so a running agent is never interrupted by a `cd`. In
// window mode a blocked pop-up falls back to the dock rather than doing nothing.
function termOpen({ cwd, run, task } = {}) {
  if (!termOn()) return;
  if (termWhere() === 'window') {
    // The window adds its terminals without the cap check, so ask here first, and only when a new shell
    // would start: no popup, no pane (the dock's own create() does this itself). That is a minted id, or a
    // window not open yet, which starts a fresh shell of its own. With no args and the window open (presence
    // says it holds a terminal) this only raises it, so the cap doesn't apply.
    const fresh = cwd != null || !!run;
    const winOpen = TW.rows().some((r) => r.where === 'window');
    if ((fresh || !winOpen) && !TW.canOpen()) return;
    const w = openTermWindow();
    if (w) { handToWindow(w, fresh ? [{ id: twNewId(), cwd: cwd || '', run, task }] : []); return; }
  }
  showTerminals();
  if (cwd != null || run || !TW.sessions().length) TW.create({ cwd, run, task });
}

// ---------- Agent states, app-wide ----------
// Every terminal the server holds — the dock's, the Terminals window's and
// detached ones — so the Board cards, the drawer and the header button agree
// whichever window the agent lives in. In-memory on the server, so cheap.
let AGENT_SIG = '';
// The workspace polls /api/term/list (every 3s while visible); this just reads it.
TW.onList((list) => {
  if (!list || !termOn()) return;   // signed out, the same-box read view (no shells there), or the terminal is off
  const byTask = {};
  let alert = '';
  for (const x of list) {
    if (!x.agent) continue;
    if (x.task) byTask[x.task] = { id: x.id, cwd: x.cwd, task: x.task, state: x.agent.state };
    if (x.agent.state === 'blocked') alert = 'blocked';
    else if (x.agent.state === 'done' && !alert) alert = 'done';
  }
  $('termbtn').dataset.alert = alert;
  const sig = JSON.stringify(byTask);
  if (sig === AGENT_SIG) return;
  AGENT_SIG = sig;
  TASK_AGENTS = byTask;
  paintCardAgents();
  renderDrawerAgent();
});

// The header button: hide a visible dock; show one that already holds
// sessions (ones sent back from the window live here until moved again);
// otherwise open a terminal wherever the setting says.
$('termbtn').addEventListener('click', () => {
  if (dockVisible()) dockShow(false);
  else if (TW.sessions().length) showTerminals();
  else termOpen();
});
$('term-min').addEventListener('click', () => dockShow(false));
// Close ends the shells too — minimise is the one that keeps them. Same
// confirm as a tab's ✕ when something is still live in them.
$('term-close').addEventListener('click', () => {
  const live = TW.sessions().filter((x) => x.state === 'open').length;
  if (live && !confirm(`End ${live === 1 ? 'the running terminal' : `all ${live} running terminals`}? Anything running in them is stopped.`)) return;
  for (const x of [...TW.sessions()]) TW.remove(x.id);
  dockShow(false);
});

// ---------- Pop out ----------
// Moves the active space (all its panes) into the Terminals window (see handToWindow).
$('term-pop').addEventListener('click', () => {
  if (!TW.focused()) return;
  const w = openTermWindow();
  if (!w) return;
  handToWindow(w, TW.popSpace(TW.activeSpace()));
  if (!TW.sessions().length) dockShow(false);
});

// Sessions handed back by the Terminals window as it closes. Ones this dock
// still has a pane for (opened in both places) just reconnect.
function adoptReturned(metas) {
  if (!metas || !metas.length) return;
  try { localStorage.removeItem(TERM_KEYS.returning); } catch { /* ignore */ }
  TW.adopt(metas);   // ones already held here are just focused, never reconnected
  showTerminals();
}

// Drag the top edge of the dock to resize.
$('term-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const el = $('term-resize');
  el.setPointerCapture(e.pointerId);
  document.body.classList.add('dock-resizing');
  const move = (ev) => {
    const h = Math.min(Math.max(window.innerHeight - ev.clientY, 160), window.innerHeight - 120);
    document.body.style.setProperty('--dock-user-h', h + 'px');
  };
  const up = (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    document.body.classList.remove('dock-resizing');
    lsSet(TERM_KEYS.h, Math.round(window.innerHeight - ev.clientY));
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
});

// Ctrl+` shows/hides the dock. Ctrl+Shift+` (new terminal) and Alt+1…9 are
// handled by the workspace while the dock is open; with it hidden, Ctrl+Shift+`
// opens the dock with a new terminal.
document.addEventListener('keydown', (e) => {
  if (!termOn() || !(e.ctrlKey && (e.key === '`' || e.key === '~' || e.code === 'Backquote'))) return;
  if (e.shiftKey) { if (!dockVisible()) { e.preventDefault(); TW.create(); } return; }
  e.preventDefault();
  $('termbtn').click();
});

// Messages from the Terminals window: a clicked vault path to open here, or
// its sessions coming back as it closes.
try {
  new BroadcastChannel('vaultos-workbench').onmessage = (e) => {
    if (!e.data) return;
    if (e.data.open) fxOpen(e.data.open, { pin: true, reveal: true });
    if (e.data.returned) adoptReturned(e.data.returned);   // (presence messages are termui's)
  };
} catch { /* no BroadcastChannel: returned sessions are picked up on next load instead */ }

// After a reload: reattach every saved session (same ids, so the server hands
// back the running shells with their scrollback), plus any the Terminals
// window returned while this page wasn't open. Waits for a real signed-in
// session; a same-box read can't have one.
(function restoreTerminals() {
  const saved = TW.savedSessions();
  const legacy = lsGet('vaultboard.term.id', null);
  if (legacy && !saved.length) saved.push({ id: legacy, n: 1 });
  try { localStorage.removeItem('vaultboard.term.id'); localStorage.removeItem('vaultboard.term.max'); } catch { /* ignore */ }
  const returning = lsGet(TERM_KEYS.returning, []);
  if (!saved.length && !returning.length) return;
  fetch('/api/me').then((r) => r.json()).then((me) => {
    if (!me.authed || me.localRead || !(me.features && me.features.terminal)) return;
    return TW.restore(saved, returning).then(() => {
      // Forget the returned sessions that are back; on a signed-out page none
      // are, so they stay for the next load.
      const left = returning.filter((r) => !TW.session(r.id));
      try { if (left.length) lsSet(TERM_KEYS.returning, left); else localStorage.removeItem(TERM_KEYS.returning); } catch { /* ignore */ }
      if (TW.sessions().length && (lsGet(TERM_KEYS.open, false) || returning.length)) showTerminals();
    });
  }).catch(() => {});
})();

// ---------- Phone: fit the terminal above the on-screen keyboard ----------
// iOS never shrinks the layout viewport for the keyboard (Android does, via
// interactive-widget=resizes-content in the viewport meta), so a dock sized off
// 100dvh would type into a prompt hidden behind it. The visual viewport is the
// part actually on screen: styles.css sizes the phone dock off --vvh/--vvtop,
// and body.vkb-open drops the bottom tab bar while the keyboard is up. The
// dock's ResizeObserver in term.js refits the terminal from there.
if (window.visualViewport) {
  const vv = window.visualViewport;
  let full = { w: 0, h: 0 };   // tallest visual viewport at this width = no keyboard
  const onVV = () => {
    if (vv.width !== full.w) full = { w: vv.width, h: 0 };
    full.h = Math.max(full.h, vv.height);
    const root = document.documentElement.style;
    root.setProperty('--vvh', vv.height + 'px');
    root.setProperty('--vvtop', vv.offsetTop + 'px');
    document.body.classList.toggle('vkb-open', full.h - vv.height > 120);
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
  onVV();
}
