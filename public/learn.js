'use strict';

// ========================================================================
// Learn — Learn mode (window.Learn): notebooks on the left, the notebook's terminal and its file tabs in the middle,
// Studio on the right; one pane at a time on a phone. A notebook is a folder in the Learn folder (settings learn.dir)
// with Sources/, Notes/ and Studio/. Loaded after workbench.js and shares its globals and app.js's ($, api, esc,
// svg, ICONS, toast, holdScroll, safeHtml, hydrateDiagrams, setMode, fxOpen, fxReveal, fxDownload, fileIcon,
// fxKindOf, sourceLines, metaBlock, ago). Its pure logic is LearnCore (learn-core.js). Files are listed and read
// through the Files routes; tabs and documents reuse the Files classes so they look the same.
// ========================================================================

const Learn = (() => {
  const K = { notebook: 'vaultboard.learn.notebook', tabs: 'vaultboard.learn.tabs', panes: 'vaultboard.learn.panes', view: 'vaultboard.learn.view' };
  const get = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  const POLL_MS = 5000;
  const SUBS = ['Sources', 'Notes', 'Studio'];
  const HIDDEN = new Set(['AGENTS.md', 'CLAUDE.md']);   // the instruction files, should a copy sit in a notebook
  const ICON = {
    left: svg('<polyline points="15 18 9 12 15 6"/>'),
    right: svg('<polyline points="9 18 15 12 9 6"/>'),
    terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  };

  const L = {
    on: false, loaded: false, dir: '', notebooks: [], error: null,
    open: get(K.notebook, null),              // the open notebook's path; null = none picked
    picked: false,                            // the open notebook was chosen (or remembered), not defaulted
    tree: new Map(),                          // folder path -> items from /api/fs/tree
    expanded: new Set(),                      // folders open in the tree (a notebook's three are opened when it opens)
    files: new Map(),                         // path -> /api/fs/file payload
    store: get(K.tabs, {}),                   // LearnCore tab store, per notebook
    panes: { side: true, studio: true, ...get(K.panes, {}) },
    view: ['notebook', 'study', 'studio'].includes(get(K.view, 'notebook')) ? get(K.view, 'notebook') : 'notebook',
    creating: false,                          // the New notebook field is showing
    timer: null, polling: false, docSeq: 0,
  };
  if (L.open) L.picked = true;

  const base = (p) => String(p).split('/').pop();
  const parent = (p) => String(p).split('/').slice(0, -1).join('/');
  const current = () => L.notebooks.find((n) => n.path === L.open) || null;
  const tabs = () => (L.open ? LearnCore.tabsFor(L.store, L.open) : { tabs: [], active: 'terminal' });
  const saveTabs = () => put(K.tabs, L.store);
  const phone = () => window.matchMedia('(max-width: 700px)').matches;

  // ---------- Loading ----------
  async function loadList() {
    try {
      const d = await api('/api/learn/notebooks');
      L.dir = d.dir;
      L.notebooks = d.notebooks;
      L.error = null;
    } catch (err) {
      L.error = err.message;
      return;
    }
    L.loaded = true;
    if (L.open && !current()) {
      // The open notebook went away (renamed or deleted outside VaultOS): back to the list.
      if (L.picked) toast(`"${base(L.open)}" is gone`);
      L.open = null;
      L.picked = false;
      put(K.notebook, null);
    }
    if (!L.open && L.notebooks.length && !L.picked) {
      L.open = L.notebooks[0].path;   // first visit: the most recently used notebook
      openFolders(L.open);
    }
  }
  function openFolders(nb) {
    for (const sub of SUBS) L.expanded.add(`${nb}/${sub}`);
    L.expanded.add(nb);
  }
  async function loadDir(dir) {
    try { L.tree.set(dir, (await api(`/api/fs/tree?path=${encodeURIComponent(dir)}`)).items); } catch { L.tree.delete(dir); }
  }
  // The open notebook's tree: its own folder and every expanded folder inside it.
  async function loadTree() {
    if (!L.open) return;
    const dirs = [L.open, ...[...L.expanded].filter((d) => d.startsWith(`${L.open}/`))];
    await Promise.all(dirs.map(loadDir));
  }
  // Every path the tree has seen. A tab whose folder hasn't been listed counts as present (we can't tell).
  function present() {
    const seen = new Set();
    for (const items of L.tree.values()) for (const it of items) seen.add(it.path);
    const known = (p) => seen.has(p) || !L.tree.has(parent(p));
    return new Set(tabs().tabs.filter(known));
  }
  function reconcileTabs() {
    if (!L.open) return;
    const r = LearnCore.reconcile(L.store, L.open, present());
    if (!r.closed.length) return;
    L.store = r.store;
    saveTabs();
    for (const p of r.closed) L.files.delete(p);
    toast(r.closed.length === 1 ? `"${base(r.closed[0])}" is gone` : `${r.closed.length} open files are gone`);
  }

  async function refresh() {
    if (L.polling) return;
    L.polling = true;
    try {
      const had = L.open;
      await loadList();
      if (L.open) await loadTree();
      if (had && L.open === had) reconcileTabs();
      const t = tabs();
      if (L.open && t.active !== 'terminal') {
        const old = L.files.get(t.active);
        let f = null;
        try { f = await api(`/api/fs/file?path=${encodeURIComponent(t.active)}`); } catch { /* gone: the next poll closes it */ }
        if (f && (!old || old.mtime !== f.mtime)) { L.files.set(t.active, f); renderSide(); renderTabs(); paintDoc(t.active, { keepScroll: true }); return; }
      }
      render();
    } finally { L.polling = false; }
  }

  // ---------- Rendering ----------
  function rowHtml(it, depth) {
    const open = it.dir && L.expanded.has(it.path);
    const active = !it.dir && it.path === tabs().active;
    return `<div class="fx-row${it.dir ? ' dir' : ''}${active ? ' active' : ''}${open ? ' open' : ''}" role="treeitem" tabindex="-1"`
      + ` data-path="${esc(it.path)}"${it.dir ? ` data-dir="1" aria-expanded="${open}"` : ''} style="--depth:${depth}" title="${esc(it.name)}">`
      + `<span class="fx-caret">${it.dir ? FX_ICONS.caret : ''}</span>`
      + `<span class="fx-ico">${it.dir ? (open ? FX_ICONS.folderOpen : FX_ICONS.folder) : fileIcon(it.kind)}</span>`
      + `<span class="fx-name">${esc(it.name)}</span></div>`;
  }
  function folderRows(dir, depth, out) {
    const items = L.tree.get(dir);
    if (!items) { out.push(`<div class="fx-row fx-loading" style="--depth:${depth}">Loading…</div>`); return out; }
    const name = base(dir);
    let list = items.filter((it) => it.dir || !HIDDEN.has(it.name));
    if (dir === L.open) {
      // The three folders first, in their order; anything else Ben put there after them.
      const subs = SUBS.map((s) => list.find((it) => it.dir && it.name === s)).filter(Boolean);
      list = [...subs, ...LearnCore.treeOrder('', list.filter((it) => !subs.includes(it)))];
    } else list = LearnCore.treeOrder(name, list);
    if (!list.length && dir === `${L.open}/Sources`) out.push(`<div class="ln-hint" style="--depth:${depth}">Add a YouTube video or upload a file</div>`);
    for (const it of list) {
      out.push(rowHtml(it, depth));
      if (it.dir && L.expanded.has(it.path)) folderRows(it.path, depth + 1, out);
    }
    return out;
  }
  function renderSide() {
    const el = $('ln-list');
    const keep = holdScroll(el);
    const out = [];
    if (L.creating) {
      out.push(`<form id="ln-new-form" class="ln-new"><input id="ln-new-name" class="su-input" maxlength="60" placeholder="Notebook name" aria-label="Notebook name" autocomplete="off">`
        + '<button type="submit" class="su-btn su-sm">Create</button><button type="button" id="ln-new-cancel" class="su-btn su-sm">Cancel</button></form>');
    }
    if (L.error) out.push(`<p class="ln-empty">Can't open ${esc(L.dir || 'the Learn folder')}: ${esc(L.error)}</p><button type="button" id="ln-settings" class="su-btn su-sm">Open Settings</button>`);
    for (const n of L.notebooks) {
      const open = n.path === L.open;
      out.push(`<div class="fx-row dir ln-nb${open ? ' open' : ''}" role="treeitem" tabindex="-1" data-nb="${esc(n.path)}" data-path="${esc(n.path)}" aria-expanded="${open}" style="--depth:0" title="${esc(n.name)}">`
        + `<span class="fx-caret">${FX_ICONS.caret}</span><span class="fx-ico">${open ? FX_ICONS.folderOpen : FX_ICONS.folder}</span>`
        + `<span class="fx-name">${esc(n.name)}</span><span class="ln-count">${n.sources} source${n.sources === 1 ? '' : 's'}</span></div>`);
      if (open) folderRows(n.path, 1, out);
    }
    el.innerHTML = out.join('');
    keep();
    $('ln-foot').innerHTML = `<button type="button" id="ln-new" class="su-btn su-sm">${ICON.plus}New notebook</button>`;
  }

  function renderTabs() {
    const el = $('ln-tabs');
    if (!L.open) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const t = tabs();
    el.innerHTML = `<div class="fx-tab ln-tab-term${t.active === 'terminal' ? ' active' : ''}" role="tab" aria-selected="${t.active === 'terminal'}" data-path="terminal" title="This notebook's terminal">`
      + `<span class="fx-ico">${ICON.terminal}</span><span class="fx-tab-name">Terminal</span></div>`
      + t.tabs.map((p) => `<div class="fx-tab${p === t.active ? ' active' : ''}" role="tab" aria-selected="${p === t.active}" data-path="${esc(p)}" title="${esc(p)}">`
        + `<span class="fx-ico">${fileIcon(fxKindOf(p))}</span><span class="fx-tab-name">${esc(base(p))}</span>`
        + `<button type="button" class="fx-tab-x" aria-label="Close ${esc(base(p))}">${ICONS.close}</button></div>`).join('');
    const act = el.querySelector('.fx-tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function firstBox() {
    return `<div id="ln-first" class="ln-first"><h2>Name your first notebook</h2>
      <p class="su-hint">One notebook per topic. It holds what you study from, your study logs and what Studio makes.</p>
      <form id="ln-first-form" class="ln-first-row"><input id="ln-first-name" class="su-input" maxlength="60" placeholder="Notebook name" aria-label="Notebook name" autocomplete="off">
      <button type="submit" id="ln-first-go" class="su-btn primary">Create</button></form><p id="ln-first-err" class="su-err" aria-live="polite"></p></div>`;
  }

  function renderMain() {
    const doc = $('ln-doc');
    const term = $('ln-term');
    if (!L.loaded && !L.error) { term.classList.add('hidden'); doc.classList.remove('hidden'); doc.dataset.path = ''; doc.innerHTML = '<p class="fx-empty fx-pad">Loading…</p>'; return; }
    if (!L.open) {
      term.classList.add('hidden');
      doc.classList.remove('hidden');
      doc.dataset.path = '';
      doc.innerHTML = L.notebooks.length ? '<p class="fx-empty fx-pad">Pick a notebook on the left.</p>' : firstBox();
      // A phone shows one pane: with nothing to list yet, show the one holding the box (not remembered).
      if (!L.notebooks.length && phone() && L.view !== 'study') { L.view = 'study'; applyView(); }
      return;
    }
    const t = tabs();
    if (t.active === 'terminal') {
      doc.classList.add('hidden');
      doc.dataset.path = '';
      term.classList.remove('hidden');
      renderTerminal();
      return;
    }
    term.classList.add('hidden');
    doc.classList.remove('hidden');
    if (doc.dataset.path !== t.active || !L.files.has(t.active)) showDoc(t.active);
  }

  async function showDoc(p) {
    const doc = $('ln-doc');
    doc.dataset.path = p;
    if (L.files.has(p)) { paintDoc(p); return; }
    const seq = ++L.docSeq;
    doc.innerHTML = '<p class="fx-empty fx-pad ln-loading">Loading…</p>';
    let f;
    try { f = await api(`/api/fs/file?path=${encodeURIComponent(p)}`); } catch (err) {
      if (seq === L.docSeq) doc.innerHTML = `<p class="fx-empty fx-pad">Couldn't open ${esc(base(p))}: ${esc(err.message)}</p>`;
      return;
    }
    if (seq !== L.docSeq || doc.dataset.path !== p) return;   // moved on while it loaded
    L.files.set(p, f);
    paintDoc(p);
  }

  function paintDoc(p, { keepScroll = false } = {}) {
    const doc = $('ln-doc');
    const f = L.files.get(p);
    if (!f || doc.dataset.path !== p) return;
    const restore = keepScroll ? holdScroll(doc) : null;
    const text = f.kind === 'md' || f.kind === 'text';
    const bar = `<div class="ln-docbar"><span class="ln-docname" title="${esc(p)}">${esc(f.name || base(p))}</span>`
      + `<span class="fx-when" title="${esc(new Date(f.mtime).toLocaleString())}">edited ${ago(f.mtime)}</span>`
      + (text && f.source != null ? '<button type="button" id="ln-edit" class="su-btn su-sm">Edit in Files</button>' : '') + '</div>';
    let body;
    if (f.kind === 'md' && f.html != null) {
      body = `<div class="fx-doc"><h1 class="fx-title">${esc(f.title)}</h1>${metaBlock(f.meta)}<article class="markdown fx-md">${safeHtml(f.html)}</article></div>`;
    } else if (text && f.source != null) {
      body = `<pre class="fx-source"><code>${sourceLines(f.source)}</code></pre>`;
    } else if (f.kind === 'image') {
      body = `<div class="fx-image"><img src="/api/fs/raw?path=${encodeURIComponent(p)}&v=${Math.round(f.mtime)}" alt="${esc(f.name || base(p))}"></div>`;
    } else {
      body = `<div class="fx-binary"><p><b>${esc(f.name || base(p))}</b></p><p>${f.tooLarge ? 'Too large to show here.' : 'Learn shows notes, text and images.'}</p>`
        + '<button type="button" id="ln-open-files" class="su-btn su-sm">Open in Files</button></div>';
    }
    doc.innerHTML = bar + body;
    if (f.kind === 'md') {
      const d = hydrateDiagrams(doc);
      if (restore) d.then(restore, restore);
    } else if (restore) restore();
    if (!keepScroll) doc.scrollTop = 0;
  }

  // The terminal pane. Filled in with the notebook's terminal and its start screen.
  function renderTerminal() {
    const el = $('ln-term');
    if (!el.querySelector('.ln-term-note')) el.innerHTML = '<p class="fx-empty fx-pad ln-term-note">This notebook\'s terminal opens here.</p>';
  }

  function renderStudio() {
    const el = $('ln-studio-body');
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = '<div class="ln-later"><h3>Coming later</h3><ul><li>Podcast (two voices)</li><li>Flashcards</li><li>Study guide</li><li>Slides</li></ul></div>';
  }

  function applyPanes() {
    const lay = $('ln-layout');
    lay.classList.toggle('ln-side-off', !L.panes.side);
    lay.classList.toggle('ln-studio-off', !L.panes.studio);
    $('ln-side-rail').classList.toggle('hidden', L.panes.side);
    $('ln-studio-rail').classList.toggle('hidden', L.panes.studio);
    $('ln-side-fold').innerHTML = ICON.left;
    $('ln-studio-fold').innerHTML = ICON.right;
    $('ln-side-rail').innerHTML = ICON.right;
    $('ln-studio-rail').innerHTML = ICON.left;
  }
  function applyView() {
    const lay = $('ln-layout');
    for (const v of ['notebook', 'study', 'studio']) lay.classList.toggle(`ln-v-${v}`, L.view === v);
    for (const b of $('ln-switch').querySelectorAll('button')) {
      const on = b.dataset.v === L.view;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('on', on);
    }
  }
  function setView(v) {
    L.view = v;
    put(K.view, v);
    applyView();
  }

  function render() {
    renderSide();
    renderTabs();
    renderMain();
    renderStudio();
    applyPanes();
    applyView();
  }

  // ---------- Actions ----------
  async function open(nb) {
    if (L.open === nb) return;
    L.open = nb;
    L.picked = true;
    put(K.notebook, nb);
    openFolders(nb);
    render();
    await loadTree();
    render();
  }

  async function openFile(p) {
    if (!L.open || !p.startsWith(`${L.open}/`)) return;
    L.store = LearnCore.withTab(L.store, L.open, p);
    saveTabs();
    renderSide();
    renderTabs();
    renderMain();
    if (phone()) setView('study');
  }

  function activate(p) {
    L.store = LearnCore.withActive(L.store, L.open, p);
    saveTabs();
    renderSide();
    renderTabs();
    renderMain();
  }

  function closeTab(p) {
    L.store = LearnCore.withoutTab(L.store, L.open, p);
    L.files.delete(p);
    saveTabs();
    renderSide();
    renderTabs();
    renderMain();
  }

  async function toggleDir(p) {
    if (L.expanded.has(p)) L.expanded.delete(p);
    else {
      L.expanded.add(p);
      if (!L.tree.has(p)) { renderSide(); await loadDir(p); }
    }
    renderSide();
  }

  async function create(name, errEl) {
    try {
      const d = await api('/api/learn/notebooks', { method: 'POST', body: JSON.stringify({ name }) });
      L.creating = false;
      L.open = d.notebook.path;
      L.picked = true;
      put(K.notebook, L.open);
      openFolders(L.open);
      await loadList();
      await loadTree();
      if (phone()) L.view = 'notebook';
      render();
      return true;
    } catch (err) {
      if (errEl) errEl.textContent = err.message; else toast(err.message);
      return false;
    }
  }

  function toFiles(p, how) {
    setMode('files');
    if (how === 'reveal') fxReveal(p);
    else fxOpen(p, { pin: true });
  }

  // A small menu for a file row: Open, Show in Files, Download.
  function menu(x, y, p) {
    closeMenu();
    const m = document.createElement('div');
    m.id = 'ln-menu';
    m.className = 'fx-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = '<button type="button" role="menuitem" data-act="open">Open</button>'
      + '<button type="button" role="menuitem" data-act="reveal">Show in Files</button>'
      + '<button type="button" role="menuitem" data-act="download">Download</button>';
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      closeMenu();
      if (b.dataset.act === 'open') openFile(p);
      else if (b.dataset.act === 'reveal') toFiles(p, 'reveal');
      else fxDownload(p);
    });
    m.querySelector('button').focus();
  }
  function closeMenu() { const m = $('ln-menu'); if (m) m.remove(); }

  // ---------- Events ----------
  $('ln-list').addEventListener('click', (e) => {
    if (e.target.closest('#ln-settings')) { openSheet('features'); return; }
    if (e.target.closest('#ln-new-cancel')) { L.creating = false; renderSide(); return; }
    const r = e.target.closest('.fx-row');
    if (!r || r.classList.contains('fx-loading')) return;
    if (r.dataset.nb) { if (r.dataset.nb === L.open) toggleDir(r.dataset.nb); else open(r.dataset.nb); return; }
    if (r.dataset.dir) toggleDir(r.dataset.path);
    else openFile(r.dataset.path);
  });
  $('ln-list').addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.fx-row');
    if (!r || r.dataset.dir || r.dataset.nb || !r.dataset.path) return;
    e.preventDefault();
    menu(e.clientX, e.clientY, r.dataset.path);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#ln-menu')) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  $('ln-list').addEventListener('submit', async (e) => {
    if (e.target.id !== 'ln-new-form') return;
    e.preventDefault();
    const v = $('ln-new-name').value;
    await create(v, null);
  });
  $('ln-foot').addEventListener('click', (e) => {
    if (e.target.closest('#ln-new')) {
      L.creating = true;
      renderSide();
      $('ln-new-name').focus();
    }
  });
  $('ln-tabs').addEventListener('click', (e) => {
    const x = e.target.closest('.fx-tab-x');
    const t = e.target.closest('.fx-tab');
    if (!t) return;
    if (x) closeTab(t.dataset.path);
    else activate(t.dataset.path);
  });
  $('ln-tabs').addEventListener('auxclick', (e) => {
    const t = e.target.closest('.fx-tab');
    if (t && e.button === 1 && t.dataset.path !== 'terminal') { e.preventDefault(); closeTab(t.dataset.path); }
  });
  $('ln-doc').addEventListener('click', (e) => {
    if (e.target.closest('#ln-edit') || e.target.closest('#ln-open-files')) toFiles($('ln-doc').dataset.path);
  });
  $('ln-doc').addEventListener('submit', async (e) => {
    if (e.target.id !== 'ln-first-form') return;
    e.preventDefault();
    $('ln-first-err').textContent = '';
    await create($('ln-first-name').value, $('ln-first-err'));
  });
  $('ln-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) setView(b.dataset.v); });
  const fold = (which, on) => { L.panes[which] = on; put(K.panes, L.panes); applyPanes(); window.dispatchEvent(new Event('resize')); };
  $('ln-side-fold').addEventListener('click', () => fold('side', false));
  $('ln-side-rail').addEventListener('click', () => fold('side', true));
  $('ln-studio-fold').addEventListener('click', () => fold('studio', false));
  $('ln-studio-rail').addEventListener('click', () => fold('studio', true));

  // ---------- Showing and hiding ----------
  async function show() {
    L.on = true;
    $('count').textContent = '';
    render();
    await refresh();
    clearInterval(L.timer);
    L.timer = setInterval(() => { if (L.on && document.visibilityState === 'visible') refresh(); }, POLL_MS);
  }
  function hide() {
    L.on = false;
    clearInterval(L.timer);
    L.timer = null;
    closeMenu();
  }

  return {
    show, hide, open, openFile,
    // Terminals held by Learn (the notebook terminal): filled in with the terminal.
    holds: () => false,
    heldMap: () => new Map(),
    goTo: () => {},
  };
})();
window.Learn = Learn;
