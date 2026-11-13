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
    video: svg('<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.76-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
    upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
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
      letGo();
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
    const off = L.open ? '' : ' disabled';
    $('ln-foot').innerHTML = `<button type="button" id="ln-new" class="su-btn su-sm">${ICON.plus}New notebook</button>`
      + `<button type="button" id="ln-yt" class="su-btn su-sm"${off}>${ICON.video}Add YouTube video</button>`
      + `<button type="button" id="ln-up" class="su-btn su-sm"${off}>${ICON.upload}Upload</button>`;
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

  // ---------- The notebook's terminal ----------
  // One terminal per notebook, found in the server's list by the notebook's space id, so any device reattaches to it.
  // Learn holds at most one handle, the open notebook's; switching notebook lets go of it (it runs on, detached).
  // The start screen sits over the pane while no agent runs there: the default agent, then one other installed one.
  const T = { id: null, nb: null, handle: null, state: null, agent: null, dismissed: false, sawAgent: false, agents: null, list: [], attaching: false };
  const hasTW = () => typeof TW !== 'undefined';
  const rowById = (id) => T.list.find((x) => x.id === id) || null;
  const rowFor = (nb) => (nb ? T.list.find((x) => x.space === nb.space) || null : null);
  const held = () => !!T.handle && T.state !== 'moved' && T.state !== 'closed';
  const told = () => { if (hasTW()) TW.localChanged(); };

  function termSkeleton() {
    const el = $('ln-term');
    if ($('ln-term-host')) return;
    el.innerHTML = '<div id="ln-term-host" class="ln-term-host"></div>'
      + '<div id="ln-start" class="ln-start hidden"></div>'
      + '<div id="ln-moved" class="ln-moved hidden"><p>This notebook\'s terminal is open in another window.</p>'
      + '<button type="button" id="ln-bring" class="su-btn su-sm">Bring it here</button></div>'
      + '<p id="ln-term-off" class="fx-empty fx-pad hidden">Terminals are off on this machine.</p>';
  }

  function letGo() {
    if (!T.handle) return;
    try { T.handle.dispose(); } catch { /* already gone */ }
    const host = $('ln-term-host');
    if (host) host.innerHTML = '';
    Object.assign(T, { id: null, nb: null, handle: null, state: null, agent: null, dismissed: false, sawAgent: false });
    told();
  }

  function attach(id, nb, opts = {}) {
    termSkeleton();
    letGo();
    T.id = id;
    T.nb = nb.path;
    T.state = 'connecting';
    // createTerminal reports its first state before it returns; told() then runs the dock's list callbacks, which
    // come back to syncTerm while T.handle is still unset. The flag stops that attaching a second time.
    T.attaching = true;
    try {
      T.handle = createTerminal($('ln-term-host'), {
        id, space: nb.space, spaceName: `Learn · ${nb.name}`.slice(0, 40), ...opts,
        onState: (st) => { T.state = st; told(); overlay(); },
        onAgent: (ag) => { T.agent = ag; overlay(); },
        onOpenPath: (rel) => { if (L.open && rel.startsWith(`${L.open}/`)) openFile(rel); else { setMode('files'); fxOpen(rel, { pin: true }); } },
        onExit: () => overlay(),
      });
    } finally { T.attaching = false; }
    T.handle.onNextInput((d) => { T.dismissed = true; overlay(); return d; });
    told();
  }

  // Attach to the open notebook's terminal if the server has one and Learn isn't holding it; let go of another's.
  function syncTerm() {
    if (T.attaching) return;
    const nb = current();
    if (T.handle && (!nb || T.nb !== nb.path)) letGo();
    if (!nb || !termOn() || T.handle) return;
    const row = rowFor(nb);
    if (row) attach(row.id, nb);
  }

  function agentRunning() {
    if (T.agent && T.agent.state && T.agent.state !== 'gone') return true;
    const row = T.id ? rowById(T.id) : null;
    return !!(row && (row.agent || row.cmd));
  }

  function overlay() {
    if (!$('ln-term-host')) return;
    const off = !termOn();
    $('ln-term-off').classList.toggle('hidden', !off);
    $('ln-moved').classList.toggle('hidden', off || T.state !== 'moved');
    const running = agentRunning();
    if (running) T.sawAgent = true;
    else if (T.sawAgent) { T.sawAgent = false; T.dismissed = false; }   // the agent ended: offer the buttons again
    const show = !off && T.state !== 'moved' && (!T.handle || (T.state === 'open' && !running && !T.dismissed));
    const start = $('ln-start');
    if (show && !start.dataset.ready) paintStart();
    start.classList.toggle('hidden', !show);
  }

  function paintStart() {
    const start = $('ln-start');
    if (!T.agents) { start.innerHTML = '<p class="fx-empty">Loading…</p>'; return; }
    const btns = LearnCore.startButtons(T.agents, termOn());
    start.dataset.ready = '1';
    start.innerHTML = '<div class="ln-start-card"><h3>Study with an agent</h3>'
      + '<p class="su-hint">It opens in this notebook\'s folder, answers from your sources, and writes each answer into today\'s study log.</p>'
      + `<div class="ln-start-btns">${btns.map((b, i) => `<button type="button" class="su-btn${i === 0 ? ' primary' : ''}" data-start="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div></div>`;
  }

  async function loadAgents() {
    try { T.agents = (await api('/api/learn/agents')).agents; } catch { T.agents = []; }
    const start = $('ln-start');
    if (start) { delete start.dataset.ready; overlay(); }
  }

  function startAgent(id) {
    const nb = current();
    if (!nb) return;
    const btn = LearnCore.startButtons(T.agents, termOn()).find((b) => b.id === id);
    if (!btn) return;
    T.dismissed = true;
    if (T.handle && T.state === 'open') {
      if (btn.command) T.handle.type(`${btn.command}\r`);
    } else {
      const fresh = `learn-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      attach(fresh, nb, { cwd: nb.path, ...(btn.command ? { run: btn.command } : {}) });
      T.dismissed = true;
    }
    overlay();
    setTimeout(() => { if (T.handle) { T.handle.fit(); T.handle.focus(); } }, 50);
  }

  function renderTerminal() {
    termSkeleton();
    syncTerm();
    overlay();
    if (T.handle) requestAnimationFrame(() => { if (T.handle) T.handle.fit(); });
  }

  // A terminal of a Learn notebook (held here or not): the dock sends it to Learn instead of taking it.
  function holds(id) {
    if (T.id === id) return true;
    const row = rowById(id);
    return !!row && typeof row.space === 'string' && row.space.startsWith('learn-') && L.notebooks.some((n) => n.space === row.space);
  }
  async function goTo(id) {
    const row = rowById(id);
    const nb = row ? L.notebooks.find((n) => n.space === row.space) : (T.id === id ? current() : null);
    if (!nb) return;
    setMode('learn');
    if (L.open !== nb.path) await open(nb.path);
    activate('terminal');
    if (phone()) setView('study');
    if (T.handle && T.id === id && T.state !== 'open') { T.handle.reconnect(); told(); }
    else if (!T.handle) attach(id, nb);
    setTimeout(() => { if (T.handle) { T.handle.fit(); T.handle.focus(); } }, 50);
  }

  // ---------- Studio ----------
  // Make an image from the open text tab, else the newest study log, else the newest source (LearnCore.pickFrom).
  const ST = { key: null, making: false, made: '', err: '' };
  function renderStudio() {
    const el = $('ln-studio-body');
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = '<div class="ln-make"><button type="button" id="ln-make" class="su-btn primary">Make an image</button>'
        + '<p id="ln-from" class="ln-from"></p>'
        + '<label class="su-label" for="ln-focus">What should it show?</label>'
        + '<input id="ln-focus" class="su-input" maxlength="300" autocomplete="off" placeholder="Leave blank for the main idea">'
        + '<p id="ln-studio-note" class="su-hint"></p><button type="button" id="ln-key-link" class="su-btn su-sm hidden">Open Settings → Learn</button>'
        + '<p id="ln-made" class="su-hint" aria-live="polite"></p><p id="ln-studio-err" class="su-err" aria-live="polite"></p></div>'
        + '<div class="ln-later"><h3>Coming later</h3><ul><li>Podcast (two voices)</li><li>Flashcards</li><li>Study guide</li><li>Slides</li></ul></div>';
    }
    const nb = current();
    const from = LearnCore.pickFrom(tabs().active, nb);
    const keyed = !!(ST.key && ST.key.set);
    const why = !nb ? 'Open a notebook first.' : !keyed ? 'Add an OpenRouter key in Settings → Learn.' : !from ? 'Add a source first.' : '';
    $('ln-make').disabled = !!why || ST.making;
    $('ln-make').textContent = ST.making ? 'Making…' : 'Make an image';
    $('ln-from').innerHTML = from ? `From: <b>${esc(base(from))}</b>` : '';
    $('ln-studio-note').textContent = ST.key === null && nb ? '' : why;
    $('ln-key-link').classList.toggle('hidden', !nb || keyed || ST.key === null);
    $('ln-made').textContent = ST.made;
    $('ln-studio-err').textContent = ST.err;
  }
  async function loadKey() {
    try { ST.key = await api('/api/learn/key'); } catch { ST.key = { set: false }; }
    renderStudio();
  }
  async function makeImage() {
    const nb = current();
    const from = LearnCore.pickFrom(tabs().active, nb);
    if (!nb || ST.making) return;
    ST.making = true;
    ST.err = '';
    ST.made = '';
    renderStudio();
    try {
      const r = await api('/api/learn/image', { method: 'POST', body: JSON.stringify({ notebook: nb.path, from: from || '', focus: $('ln-focus').value }) });
      ST.made = LearnCore.madeBy(r.model, r.cost);
      await loadTree();
      if (L.open === nb.path) openFile(r.path);
    } catch (err) {
      ST.err = err.message;
    } finally {
      ST.making = false;
      renderStudio();
    }
  }

  // ---------- Add YouTube video ----------
  // One import per notebook (the server's rule too). It carries on when the dialog closes or another notebook opens;
  // reopening the dialog for that notebook shows how it is going.
  const Y = { nb: null, jobs: new Map(), last: new Map(), timer: null, pending: null };
  const ytShown = () => !$('ln-yt-dlg').classList.contains('hidden');
  function ytOpen() {
    if (!L.open) return;
    Y.nb = L.open;
    Y.pending = null;
    $('ln-yt-msg').textContent = '';
    $('ln-yt-ask').classList.add('hidden');
    $('ln-yt-url').value = '';
    $('ln-yt-dlg').classList.remove('hidden');
    paintJob(Y.last.get(Y.nb) || null);
    $('ln-yt-url').focus();
  }
  function ytClose() { $('ln-yt-dlg').classList.add('hidden'); }
  function paintJob(job) {
    const el = $('ln-yt-status');
    if (!job) { el.textContent = ''; return; }
    const capped = job.listed > job.total && job.total ? `First ${job.total} of ${job.listed}. ` : '';
    if (job.state === 'running') {
      el.textContent = !job.total ? 'Starting…' : job.total > 1 ? `${capped}Importing ${job.done} of ${job.total}…` : 'Fetching the transcript…';
      return;
    }
    if (job.state === 'failed') { el.textContent = ''; $('ln-yt-msg').textContent = job.error || 'Something went wrong.'; return; }
    const n = job.failed.length;
    const allCaptions = n && job.failed.every((f) => f.reason === 'This video has no captions.');
    const why = !n ? '' : allCaptions ? `, ${n} had no captions` : `, ${n} couldn't be saved`;
    el.textContent = `${capped}Saved ${job.saved.length}${why}.${n ? ` ${job.failed.map((f) => (allCaptions ? f.title : `${f.title} (${f.reason})`)).join('; ')}` : ''}`;
  }
  async function ytStart(url, playlist) {
    const kind = LearnCore.youtubeKind(url);
    if (playlist === undefined && kind === 'both') { Y.pending = url; $('ln-yt-ask').classList.remove('hidden'); return; }
    $('ln-yt-ask').classList.add('hidden');
    $('ln-yt-msg').textContent = '';
    const nb = Y.nb;
    try {
      const r = await api('/api/learn/youtube', { method: 'POST', body: JSON.stringify({ notebook: nb, url, playlist: playlist === true }) });
      Y.jobs.set(nb, r.jobId);
      Y.last.set(nb, { state: 'running', done: 0, total: 0, listed: 0, saved: [], failed: [] });
      if (Y.nb === nb && ytShown()) paintJob(Y.last.get(nb));
      ytPoll();
    } catch (err) {
      $('ln-yt-msg').textContent = err.message;
    }
  }
  function ytPoll() {
    if (Y.timer) return;
    Y.timer = setInterval(async () => {
      if (!Y.jobs.size) { clearInterval(Y.timer); Y.timer = null; return; }
      for (const [nb, id] of [...Y.jobs]) {
        let job;
        try { job = await api(`/api/learn/youtube/${encodeURIComponent(id)}`); } catch { Y.jobs.delete(nb); continue; }
        const before = Y.last.get(nb);
        Y.last.set(nb, job);
        if (Y.nb === nb && ytShown()) paintJob(job);
        if (job.state === 'running') { if (L.open === nb && (!before || before.saved.length !== job.saved.length)) { await loadTree(); renderSide(); } continue; }
        Y.jobs.delete(nb);
        const one = job.state === 'done' && job.total === 1 && job.saved.length === 1;
        // One video in: close the dialog so its new tab shows. A playlist keeps it open with the summary.
        if (one && Y.nb === nb && ytShown()) { ytClose(); Y.last.delete(nb); }
        if (L.open === nb) {
          await loadList();
          await loadTree();
          if (one) openFile(job.saved[0]);
          else render();
        }
      }
    }, 1000);
  }

  // ---------- Upload ----------
  async function upload(files) {
    if (!L.open || !files.length) return;
    const nb = L.open;
    await fxUpload(`${nb}/Sources`, files.map((f) => ({ file: f, name: f.name })));
    if (L.open === nb) { await loadTree(); renderSide(); }
  }
  function pickUpload() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.addEventListener('change', () => upload([...inp.files]));
    inp.click();
  }

  // ---------- Settings → Learn ----------
  const keyLine = (k) => (!k || !k.set ? 'No key' : k.source === 'env' ? 'Using OPENROUTER_API_KEY from the server' : `Key saved, ends …${k.last4}`);
  async function openSettings() {
    $('lr-dir').value = (ME.learn && ME.learn.dir) || 'Learning';
    $('lr-dir-msg').textContent = '';
    $('lr-key-msg').textContent = '';
    $('lr-key').value = '';
    await loadKey();
    $('lr-key-status').textContent = keyLine(ST.key);
  }
  async function keyAction(fn) {
    $('lr-key-msg').textContent = '';
    try { await fn(); } catch (err) { $('lr-key-msg').textContent = err.message; }
    $('lr-key-status').textContent = keyLine(ST.key);
    renderStudio();
  }
  $('lr-key-save').addEventListener('click', () => keyAction(async () => {
    ST.key = await api('/api/learn/key', { method: 'PUT', body: JSON.stringify({ key: $('lr-key').value }) });
    $('lr-key').value = '';
  }));
  $('lr-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('lr-key-save').click(); } });
  $('lr-key-remove').addEventListener('click', () => keyAction(async () => { ST.key = await api('/api/learn/key', { method: 'DELETE' }); }));
  $('lr-key-test').addEventListener('click', () => keyAction(async () => {
    $('lr-key-msg').textContent = 'Testing…';
    const r = await api('/api/learn/key/test', { method: 'POST' });
    $('lr-key-msg').textContent = `Key works${typeof r.credit === 'number' ? ` · $${r.credit.toFixed(2)} credit left` : ''}`;
  }));
  $('lr-dir-save').addEventListener('click', async () => {
    $('lr-dir-msg').textContent = '';
    try {
      await api('/api/settings/learn', { method: 'POST', body: JSON.stringify({ dir: $('lr-dir').value }) });
      location.reload();
    } catch (err) { $('lr-dir-msg').textContent = err.message; }
  });

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
    letGo();
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
    if (p === 'terminal' && T.handle) setTimeout(() => { if (T.handle) { T.handle.fit(); T.handle.focus(); } }, 30);
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
    if (e.target.closest('#ln-settings')) { openSheet('learn'); return; }
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
    } else if (e.target.closest('#ln-yt')) ytOpen();
    else if (e.target.closest('#ln-up')) pickUpload();
  });
  $('ln-yt-form').addEventListener('submit', (e) => { e.preventDefault(); ytStart($('ln-yt-url').value.trim()); });
  $('ln-yt-video').addEventListener('click', () => { if (Y.pending) ytStart(Y.pending, false); });
  $('ln-yt-list').addEventListener('click', () => { if (Y.pending) ytStart(Y.pending, true); });
  $('ln-yt-close').addEventListener('click', ytClose);
  $('ln-yt-dlg').addEventListener('click', (e) => { if (e.target.id === 'ln-yt-dlg') ytClose(); });
  $('ln-yt-dlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); ytClose(); } });
  $('ln-studio-body').addEventListener('click', (e) => {
    if (e.target.closest('#ln-make')) makeImage();
    else if (e.target.closest('#ln-key-link')) openSheet('learn');
  });
  $('ln-side').addEventListener('dragover', (e) => { if (L.open && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('ln-side').classList.add('ln-drop'); } });
  $('ln-side').addEventListener('dragleave', (e) => { if (!$('ln-side').contains(e.relatedTarget)) $('ln-side').classList.remove('ln-drop'); });
  $('ln-side').addEventListener('drop', (e) => {
    $('ln-side').classList.remove('ln-drop');
    if (!L.open || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    upload([...e.dataTransfer.files]);
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
    if (!T.agents) loadAgents();
    if (!ST.key) loadKey();
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

  $('ln-term').addEventListener('click', (e) => {
    const b = e.target.closest('[data-start]');
    if (b) { startAgent(b.dataset.start); return; }
    if (e.target.closest('#ln-bring') && T.handle) { T.handle.reconnect(); told(); }
  });
  if (hasTW()) TW.onList((list) => { T.list = list || []; if (L.on) { syncTerm(); overlay(); } });

  return {
    show, hide, open, openFile, openSettings,
    holds,
    heldMap: () => (held() ? new Map([[T.id, 'learn']]) : new Map()),
    goTo,
    terminal: () => (T.handle ? { id: T.id, handle: T.handle, state: T.state } : null),
  };
})();
window.Learn = Learn;
