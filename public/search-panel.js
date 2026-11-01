'use strict';

// ========================================================================
// SearchPanel — the Ctrl+F / Ctrl+K overlay (window.SearchPanel). One box that finds tasks, articles and notes
// (GET /api/search) and other files by name (GET /api/fs/find) across the visible workspaces.
//   SearchPanel.open({ q })               opens it (the header button, the shortcuts, the filter chip's text)
//   SearchPanel.close({ restoreFocus })   Escape, the backdrop, the ×, a pick
//   SearchPanel.isOpen()
// The pure parts (which key does what, grouping, which files are visible, <mark>) are SearchCore's
// (search-core.js). Picks go through app.js and workbench.js: setWorkspace / setMode / openTask / openArticle
// / fxOpen, and the Filter row through applyFilter. Type, Workspace and Status last for the session (memory only).
// Escape: window capture, like the Settings sheet's, so one press closes the panel and not the drawer behind it.
// ========================================================================

const SearchPanel = (() => {
  const TYPES = [['all', 'All'], ['task', 'Tasks'], ['article', 'Articles'], ['note', 'Notes'], ['file', 'Files']];
  const STATUSES = ['backlog', 'scheduled', 'in-progress', 'blocked', 'needs-decision', 'review', 'done'];
  const RECENT_MAX = 8;
  const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    chev: svg('<path d="m6 9 6 6 6-6"/>'),
    filter: svg('<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>'),
    task: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>'),
    article: svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
    note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    more: svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  };
  // In memory for the session: the filters, and what the panel is doing now.
  const S = { open: false, type: 'all', ws: '', status: '', seq: 0, ctl: null, timer: 0, pending: false, rows: [], sel: -1, back: null };
  let root = null, input, list, wsBtn, stBtn, wsMenu, stMenu, WS_MENU, ST_MENU;

  const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || '')
    || /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || '');
  const phone = () => matchMedia('(max-width: 700px)').matches;
  const narrowing = () => S.type !== 'all' || !!S.ws || (S.type === 'task' && !!S.status);
  const wsShown = () => (S.ws ? WORKSPACE_LIST.filter((w) => w.key === S.ws) : WORKSPACE_LIST);

  // Where a vault path sits: its workspace (by the first folder) and the folders between that and the file.
  function placeOf(p) {
    const segs = String(p).split('/');
    const w = WORKSPACE_LIST.find((x) => x.dir === segs[0]);
    return w ? { ws: w.key, wsLabel: w.label, folder: segs.slice(1, -1).join(' / ') } : null;
  }
  // The rules /api/search applies on the server, for the rows the client builds itself (Recent).
  function visiblePath(p) {
    if (!placeOf(p) || /(^|\/)Board\.md$/.test(p)) return false;
    if (wsShown().every((w) => !p.startsWith(w.dir + '/'))) return false;
    if (p.split('/').some((g) => /^_(tasks|templates)$/i.test(g))) return false;
    const today = String(ME.todayDir || '').replace(/\/+$/, '');
    return !(today && (p === today || p.startsWith(today + '/')));
  }
  const extOf = (name) => { const m = /\.([^./]+)$/.exec(name || ''); return m ? m[1].toUpperCase() : 'File'; };
  const fileRow = (it) => ({ ...placeOf(it.path), path: it.path, kind: 'file', title: it.name, ext: extOf(it.name), mtime: it.mtime });

  // ---- Build (once, on first open) ----
  function build() {
    root = document.createElement('div');
    root.id = 'search-panel';
    root.className = 'sp hidden';
    root.innerHTML = `<div class="sp-box" role="dialog" aria-modal="true" aria-label="Search">
      <div class="sp-head">${ICON.search}
        <input id="sp-q" type="text" placeholder="Search tasks, articles, notes and files" autocomplete="off" spellcheck="false"
          autocapitalize="off" enterkeyhint="search" role="combobox" aria-expanded="true" aria-controls="sp-list" aria-autocomplete="list" aria-label="Search">
        <button type="button" class="ghost sp-close" aria-label="Close search">${ICON.close}</button>
      </div>
      <div class="sp-filters">
        <div class="sp-seg" role="group" aria-label="Type">${TYPES.map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="false">${l}</button>`).join('')}</div>
        <button type="button" id="sp-ws" class="ghost sp-pick" aria-controls="sp-ws-menu"></button>
        <button type="button" id="sp-status" class="ghost sp-pick hidden" aria-controls="sp-status-menu"></button>
      </div>
      <div id="sp-list" class="sp-list" role="listbox" aria-label="Results"></div>
    </div>
    <div id="sp-ws-menu" class="fx-menu more-menu hidden" role="menu" aria-label="Workspace"></div>
    <div id="sp-status-menu" class="fx-menu more-menu hidden" role="menu" aria-label="Status"></div>`;
    document.body.appendChild(root);
    input = root.querySelector('#sp-q');
    list = root.querySelector('#sp-list');
    wsBtn = root.querySelector('#sp-ws');
    stBtn = root.querySelector('#sp-status');
    wsMenu = root.querySelector('#sp-ws-menu');
    stMenu = root.querySelector('#sp-status-menu');
    // MoreMenu moves each menu to <body> (z-index 70, above the panel) and gives it its keys.
    WS_MENU = MoreMenu.attach(wsBtn, wsMenu, { onOpen: paintWsMenu });
    ST_MENU = MoreMenu.attach(stBtn, stMenu, { onOpen: paintStatusMenu });

    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelector('.sp-close').addEventListener('click', () => close());
    input.addEventListener('input', () => { clearTimeout(S.timer); S.pending = true; S.timer = setTimeout(run, 150); });
    input.addEventListener('keydown', onInputKey);
    root.querySelector('.sp-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) setType(b.dataset.type); });
    wsMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-ws]'); if (b) { S.ws = b.dataset.ws; paintFilters(); run(); } });
    stMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (b) { S.status = b.dataset.status; paintFilters(); run(); } });
    list.addEventListener('click', (e) => {
      if (e.target.closest('.sp-clear')) { S.type = 'all'; S.ws = ''; S.status = ''; paintFilters(); run(); input.focus(); return; }
      const r = e.target.closest('.sp-row');
      if (r) pick(Number(r.dataset.i));
    });
    list.addEventListener('mousemove', (e) => { const r = e.target.closest('.sp-row'); if (r && Number(r.dataset.i) !== S.sel) select(Number(r.dataset.i), false); });
    // Tab stays inside the panel: input → close → filters → (Clear filters) → back to the input.
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...root.querySelector('.sp-box').querySelectorAll('input, button:not([disabled])')].filter((x) => x.getClientRects().length);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
  }

  function paintFilters() {
    for (const b of root.querySelectorAll('.sp-seg button')) b.setAttribute('aria-pressed', String(b.dataset.type === S.type));
    const w = WORKSPACE_LIST.find((x) => x.key === S.ws);
    if (S.ws && !w) S.ws = '';   // hidden since it was picked
    wsBtn.innerHTML = `<span>${esc(w ? w.label : 'All workspaces')}</span>${ICON.chev}`;
    wsBtn.classList.toggle('hidden', WORKSPACE_LIST.length < 2);
    stBtn.classList.toggle('hidden', S.type !== 'task');
    stBtn.innerHTML = (S.status ? `<span class="dot" style="background: var(--${esc(S.status)})"></span><span>${esc(STATUS_LABELS[S.status])}</span>` : '<span>Any status</span>') + ICON.chev;
  }
  const radio = (attr, val, on, label) => `<button type="button" role="menuitemradio" ${attr}="${esc(val)}" aria-checked="${on}">${label}</button>`;
  function paintWsMenu() {
    wsMenu.innerHTML = radio('data-ws', '', !S.ws, 'All workspaces')
      + WORKSPACE_LIST.map((w) => radio('data-ws', w.key, S.ws === w.key, `<span>${esc(w.label)}</span>`)).join('');
  }
  function paintStatusMenu() {
    stMenu.innerHTML = radio('data-status', '', !S.status, 'Any status')
      + STATUSES.map((s) => radio('data-status', s, S.status === s, `<span class="dot" style="background: var(--${s})"></span>${esc(STATUS_LABELS[s])}`)).join('');
  }
  function setType(t) {
    S.type = t;
    paintFilters();
    run();
  }

  // ---- Open / close ----
  function open({ q = '' } = {}) {
    if (!root) build();
    if (S.open) { if (q) { input.value = q; run(); } input.focus(); return; }
    const a = document.activeElement;
    S.back = a && a !== document.body && !root.contains(a) ? a : null;
    S.open = true;
    root.classList.remove('hidden');
    $('search-btn').setAttribute('aria-expanded', 'true');
    input.value = q;
    list.innerHTML = '';
    paintFilters();
    run();
    input.focus();
    input.select();
  }
  function close({ restoreFocus = true } = {}) {
    if (!S.open) return;
    S.open = false;
    clearTimeout(S.timer);
    S.seq++;
    if (S.ctl) S.ctl.abort();
    WS_MENU.close({ focus: false });
    ST_MENU.close({ focus: false });
    root.classList.add('hidden');
    $('search-btn').setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const b = S.back && S.back.isConnected && S.back.getClientRects().length ? S.back : $('search-btn');
      b.focus();
    }
    S.back = null;
  }

  // ---- Searching ----
  // One AbortController per query and a sequence number: an answer that isn't for the latest query is dropped.
  async function run() {
    clearTimeout(S.timer);
    S.pending = false;
    const seq = ++S.seq;
    if (S.ctl) S.ctl.abort();
    const ctl = S.ctl = new AbortController();
    const opts = { signal: ctl.signal };
    const q = input.value.trim().slice(0, 200);
    try {
      if (SearchCore.intentForQuery(q) === 'recent') {
        const rec = await recent(opts);
        if (seq === S.seq) paint(q, rec);
        return;
      }
      const kind = S.type === 'all' || S.type === 'file' ? '' : S.type;
      const p = new URLSearchParams({ q });
      if (kind) p.set('kind', kind);
      if (S.ws) p.set('ws', S.ws);
      if (kind === 'task' && S.status) p.set('status', S.status);
      const [s, f] = await Promise.all([
        S.type === 'file' ? { results: [], terms: 1 } : api('/api/search?' + p, opts),
        S.type === 'all' || S.type === 'file' ? api('/api/fs/find?q=' + encodeURIComponent(q), opts) : { items: [] },
      ]);
      if (seq !== S.seq) return;
      if (s.terms === 0) {   // only stopwords: show what changed lately instead of nothing
        const rec = await recent(opts);
        if (seq === S.seq) paint(q, rec);
        return;
      }
      const files = SearchCore.visibleFileHits(f.items, wsShown(), ME.todayDir).map(fileRow);
      paint(q, SearchCore.groupResults(s.results, files, { type: S.type }));
    } catch {
      if (seq === S.seq) paint(q, null);
    }
  }

  // The 8 most recently changed tasks and files: /api/fs/recent plus the board's tasks, by mtime.
  async function recent(opts) {
    let items = [];
    try { items = (await api('/api/fs/recent?hours=720', opts)).items || []; }
    catch (err) { if (err && err.name === 'AbortError') throw err; }
    const byPath = new Map();
    const titles = new Map((STATE.tasks || []).map((t) => [t.path, t]));
    for (const it of items) {
      if (!it || typeof it.path !== 'string') continue;
      const name = it.name || it.path.split('/').pop();
      const pl = placeOf(it.path) || {};
      const dir = it.path.split('/').slice(-2, -1)[0] || name;
      if (name === 'task.md') {
        const t = titles.get(it.path);
        byPath.set(it.path, { ...pl, path: it.path, kind: 'task', title: t ? t.title : dir, status: t && t.status, mtime: it.mtime });
      } else if (name === 'article.md') byPath.set(it.path, { ...pl, path: it.path, kind: 'article', title: dir, mtime: it.mtime });
      else if (/\.md$/i.test(name)) byPath.set(it.path, { ...pl, path: it.path, kind: 'note', title: name.replace(/\.md$/i, ''), mtime: it.mtime });
      else byPath.set(it.path, fileRow({ ...it, name }));
    }
    for (const t of STATE.tasks || []) {
      const had = byPath.get(t.path);
      byPath.set(t.path, { ...placeOf(t.path), path: t.path, kind: 'task', title: t.title, status: t.status, mtime: Math.max(t.mtime || 0, (had && had.mtime) || 0) });
    }
    const out = [...byPath.values()]
      .filter((r) => visiblePath(r.path) && (S.type === 'all' || r.kind === S.type) && !(S.type === 'task' && S.status && r.status !== S.status))
      .sort((x, y) => (y.mtime || 0) - (x.mtime || 0))
      .slice(0, RECENT_MAX);
    return out.length ? [{ key: 'recent', label: 'Recent', items: out, total: out.length }] : [];
  }

  // ---- Rendering ----
  // S.rows lines up with the .sp-row elements: { type: 'filter' } | { type: 'hit', r } | { type: 'more', key }.
  function paint(q, groups) {
    const rows = [];
    let h = '';
    const row = (cls, icon, inner, entry, path) => {
      rows.push(entry);
      const i = rows.length - 1;
      return `<div class="sp-row${cls}" role="option" id="sp-o-${i}" data-i="${i}"${path ? ` data-path="${esc(path)}"` : ''} aria-selected="false">${icon}<span class="sp-main">${inner}</span></div>`;
    };
    const label = q && SearchCore.filterLabel(STATE.mode, q);
    if (label) h += row(' sp-filter', ICON.filter, `<span class="sp-title">${esc(label)}</span>`, { type: 'filter' });
    if (groups === null) h += '<div class="sp-empty">Search is unavailable</div>';
    else if (!groups.length) {
      h += SearchCore.intentForQuery(q) === 'search'
        ? `<div class="sp-empty">Nothing matches '${esc(q)}'${narrowing() ? ' <button type="button" class="linklike sp-clear">Clear filters</button>' : ''}</div>`
        : '<div class="sp-empty">Nothing has changed lately</div>';
    } else {
      for (const g of groups) {
        h += `<div class="sp-group" data-group="${g.key}" role="presentation">${esc(g.label)}</div>`;
        for (const r of g.items) h += row('', ICON[r.kind] || ICON.file, hitHtml(r, q), { type: 'hit', r }, r.path);
        if (g.total > g.items.length) h += row(' sp-more', ICON.more, `<span class="sp-title">Show all ${g.total}</span>`, { type: 'more', key: g.key });
      }
    }
    list.innerHTML = h;
    list.scrollTop = 0;
    S.rows = rows;
    select(rows.length ? 0 : -1);
  }
  function hitHtml(r, q) {
    const bits = [];
    if (r.kind === 'task' && r.status) bits.push(`<span class="dot" style="background: var(--${esc(r.status)})"></span><span>${esc(STATUS_LABELS[r.status] || r.status)}</span><span class="sp-sep">·</span>`);
    const where = [r.wsLabel, r.folder].filter(Boolean).join(' · ');
    bits.push(`<span class="sp-where">${esc(where)}${r.kind === 'file' ? ` · ${esc(r.ext)}` : ''}</span>`);
    const snip = r.kind !== 'file' && r.snippet ? `<span class="sp-snip">${SearchCore.highlight(r.snippet, q)}</span>` : '';
    return `<span class="sp-title">${SearchCore.highlight(r.title || r.path, q)}</span><span class="sp-meta">${bits.join('')}</span>${snip}`;
  }
  function select(i, scroll = true) {
    const old = list.querySelector('.sp-row.sel');
    if (old) { old.classList.remove('sel'); old.setAttribute('aria-selected', 'false'); }
    S.sel = i;
    const el = i >= 0 ? list.querySelector(`#sp-o-${i}`) : null;
    if (el) {
      el.classList.add('sel');
      el.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function onInputKey(e) {
    const n = S.rows.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      select(e.key === 'ArrowDown' ? (S.sel + 1) % n : (S.sel - 1 + n) % n);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      // Typed faster than the debounce: search for what is in the box first, then pick from that.
      if (S.pending) run().then(() => { if (S.sel >= 0) pick(S.sel); });
      else if (S.sel >= 0) pick(S.sel);
    }
  }

  // ---- Picks ----
  async function pick(i) {
    const entry = S.rows[i];
    if (!entry) return;
    if (entry.type === 'more') { setType(entry.key); input.focus(); return; }
    const q = input.value.trim();
    if (entry.type === 'filter') { close(); applyFilter(q); return; }
    const r = entry.r;
    close({ restoreFocus: false });
    // The phone's full-screen terminal would sit over where the pick lands (the tab bar does the same).
    if (phone() && $('termbtn').getAttribute('aria-pressed') === 'true') $('termbtn').click();
    if (r.kind === 'task' || r.kind === 'article') {
      if (r.ws && r.ws !== STATE.workspace) setWorkspace(r.ws);
      setMode(r.kind === 'task' ? 'board' : 'kb');
      if (r.kind === 'task') await openTask(r.path);
      else { closeDrawer(); await openArticle(r.path); }
    } else {
      closeDrawer();
      fxOpen(r.path, { reveal: true });
    }
  }

  // ---- The shortcuts ----
  // Capture phase on document, so the key is seen before anything inside the page acts on it. Inside a terminal,
  // the text editor, a sheet cell editor or any other text field the key is theirs (SearchCore.keyIntent).
  document.addEventListener('keydown', (e) => {
    if (DGV || DOCV || sheetOpen() || $('app').classList.contains('hidden')) return;   // an overlay above owns the key
    const t = e.target instanceof Element ? e.target : null;
    const inPanel = !!(root && t && root.contains(t));
    const intent = SearchCore.keyIntent({
      key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, isMac: isMac(),
      panelOpen: S.open, inPanel,
      inEditable: !inPanel && !!(t && (t.isContentEditable || t.closest('input, textarea, select'))),
      inTerminal: !!(t && t.closest('.xterm')),
    });
    if (intent === 'open') { e.preventDefault(); open(); }
    else if (intent === 'close-to-browser') close();   // no preventDefault: the browser's own find opens
    else if (S.open && inPanel && (isMac() ? e.metaKey : e.ctrlKey) && String(e.key).toLowerCase() === 'k') e.preventDefault();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !S.open) return;
    if (WS_MENU.isOpen() || ST_MENU.isOpen()) return;   // the menu's own window listener closes just the menu
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  return { open, close, isOpen: () => S.open };
})();
window.SearchPanel = SearchPanel;
