'use strict';

// ========================================================================
// Terminal workspace — live shells grouped into spaces, herdr-style. Every
// terminal belongs to a space: its Board task, otherwise its folder
// (TermTree.spaceKey). Each space has its own split tree (split right or down,
// drag a divider, zoom one pane); only the active space is on screen. Used
// twice: the dock in index.html (workbench.js) and the pop-out window
// (terminal.html). Needs term.js (createTerminal) and termtree.js (TermTree),
// nothing from app.js, so the pop-out can load it on its own.
//
// Panes are absolutely placed from TermTree.layout fractions. Panes of other
// spaces, and the siblings of a zoomed pane, are .tw-off: visibility:hidden at
// their real size, never display:none, so xterm never fits to a zero box.
//
// The page also knows every terminal the server holds: a 3s /api/term/list
// poll is merged with the held sessions (TermTree.rows / spaces) and with
// BroadcastChannel presence (which other VaultOS page holds which session).
// A session another page or device opens (code 4000) leaves this page.
// ========================================================================

const TW_STATE_TEXT = {
  connecting: 'connecting…', open: 'connected', closed: 'ended', moved: 'open in another window',
  denied: 'sign in to use the terminal',
};
// An agent's state in a terminal (server.js "Agent state"), as tab, card and toast text: with the agent's name
// (Settings → Agent) when the page knows it, else neutral words. '' for a state it doesn't know.
const TW_AGENT_VERB = { working: 'is working', blocked: 'needs you', done: 'finished', idle: 'is idle' };
const twAgentText = (state, label) => (TW_AGENT_VERB[state] ? `${label || 'The agent'} ${TW_AGENT_VERB[state]}` : '');
const TW_SEQ_KEY = 'vaultboard.term.seq';   // shared by dock and pop-out, so "3" means one terminal everywhere

function twGet(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } }
function twSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
const twEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const twIcon = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const TW_ICONS = {
  splitRight: twIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  splitDown: twIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>'),
  zoom: twIcon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
  rename: twIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  close: twIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  keyboard: twIcon('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>'),
  zoomOut: twIcon('<path d="M5 12h14"/>'),
  zoomIn: twIcon('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  mic: twIcon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/>'),
};
const twNewId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

// createTermWorkspace(root, opts) → workspace
//   opts.store        storage prefix for this workspace: `.tree` (split trees), `.focused`, and `.sessions`
//                     if persist; each sessionStorage first (per tab) with a localStorage mirror (a new tab)
//   opts.persist      remember the open sessions across reloads (the dock does; the pop-out returns them instead)
//   opts.host         'dock' (default) or 'window': what other pages are told (presence)
//   opts.sideDefault  'rail' or 'side': the sidebar's starting mode (the saved choice wins)
//   opts.goElsewhere(id) → boolean   goTo() of a terminal this page doesn't hold: true if it was
//                     shown somewhere else (the dock opens the Terminals window); false brings it here
//   opts.extraButtons HTML appended to the right end of the bar
//   opts.onOpenPath(rel)   a vault path was clicked in a terminal
//   opts.onChange(count)   sessions were added or removed
//   opts.beforeNew()       called before a new session is created (the dock uses it to show itself)
//   opts.isActive()        whether Alt+1…9 / Ctrl+Shift+` should act on this workspace right now
//                          (also: whether the focused terminal counts as looked at)
//   opts.onAgents(sum)     an agent's state changed; sum = { working, blocked, done, idle } counts
//   opts.agentLabel()      the chosen agent's name, for "<name> needs you"; null (or absent) for neutral words
function createTermWorkspace(root, opts = {}) {
  const agentText = (state) => twAgentText(state, opts.agentLabel ? opts.agentLabel() : null);
  const K = {
    sessions: `${opts.store}.sessions`, focused: `${opts.store}.focused`, tree: `${opts.store}.tree`,
    side: `${opts.store}.side`, layout: `${opts.store}.layout`, ratios: `${opts.store}.ratios`,   // the old Tabs/Tile keys (migrated below)
  };
  const NAMES_KEY = 'vaultboard.term.spaceNames';   // { spaceKey: custom name }, shared by both hosts
  const HOST = opts.host === 'window' ? 'window' : 'dock';
  const PAGE_ID = twNewId();   // this page, in presence messages
  const GAP = 4;               // px between panes
  const POLL_MS = 3000;        // /api/term/list while the page is visible
  const RESTORE_WAIT_MS = 2000;   // a saved session still attached after this is held by another page

  // Per-tab storage: sessionStorage first, so two VaultOS tabs (or a reload)
  // each get their own back, with a localStorage mirror for a new tab.
  function tabGet(k, fb) {
    try { const v = sessionStorage.getItem(k); if (v != null) return JSON.parse(v); } catch { /* blocked or bad JSON */ }
    return twGet(k, fb);
  }
  function tabSet(k, v) {
    try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ }
    twSet(k, v);
  }

  // Migration from the Tabs/Tile layout: its keys go (trees build themselves),
  // and a Tabs user gets each space zoomed to its focused pane the first time
  // it is built after load (place → migrateZoom), so five shells don't
  // suddenly tile into a 340px dock.
  let wasTabs = false;
  try {
    const old = localStorage.getItem(K.layout);
    if (old != null) {
      wasTabs = old === '"tabs"' || old === 'tabs';
      localStorage.removeItem(K.layout);
      localStorage.removeItem(K.ratios);
    }
  } catch { /* storage blocked */ }

  const savedAtLoad = (() => {
    const v = opts.persist ? tabGet(K.sessions, []) : [];
    return Array.isArray(v) ? v.filter((m) => m && typeof m.id === 'string' && m.id) : [];
  })();
  const W = {
    sessions: [],          // held: { id, n, title, cwd, task, key, osc, handle, pane, state, agent, topts }
    focused: null,         // the active space's focused session
    store: loadStore(),    // { v:1, active, spaces: { key: { root, focus, zoom } } }
    // Saved leaves that may wait for their session: the ones this page re-adds
    // on load (the dock's saved list; the pop-out hands its sessions back and
    // keeps none). Any other leaf without a session is dropped at once. Until
    // restore decides, they stay in the saved set too (savedList).
    saved: savedAtLoad,
    expected: new Set(savedAtLoad.map((m) => m.id)),
    // The active space and focus to come back to once the restore batch has
    // landed: each re-added session would otherwise take them over as it
    // arrives. null once settled, or once the user picks something.
    pend: null,
    picks: 0,              // explicit choices (picked()): restore() never takes the focus back after one
    restoring: false,      // restore() is running: it settles the focus itself, once, at the end
    wasTabs,
    migrated: new Set(),   // spaces already zoomed by the Tabs migration
    list: null,            // the last /api/term/list sessions; null: signed out, or not fetched yet
    listState: 'none',     // 'ok' | 'denied' (401) | 'error' (unreachable) | 'none'
    listSeq: 0,            // fetches started / the newest one applied: an older answer never wins
    listApplied: 0,
    listCbs: [],           // onList(cb)
    eventCbs: [],          // onEvent(cb)
    memo: new Map(),       // TermTree.observe: the last agent state seen per session
    peers: new Map(),      // presence of other pages: pageId → { host, ids }
    lastSplitDown: null,   // { key, path, t }: the hand-timed double-click on a divider
    menuFor: null,         // the session whose ⋯ menu is open
    footAnchor: null,      // the sidebar button the footer menu opened from
    menuShut: null,        // { id, t }: the menu that a press on its own ⋯ just closed
  };
  W.pend = { active: W.store.active, focus: tabGet(K.focused, null) };

  root.classList.add('term-area', 'tw-root');
  root.dataset.host = opts.host === 'window' ? 'window' : 'dock';
  root.innerHTML = `
    <div class="tw-side"></div>
    <div class="tw-main">
      <div class="tw-bar">
        <button type="button" class="tw-summary" title="Go to a terminal" aria-label="Go to a terminal"><span class="tw-mark" data-agent=""></span><span class="tw-summary-text"></span></button>
        <span class="tw-space-name"></span>
        <span class="tw-space-detail"></span>
        <div class="spacer"></div>
        <button type="button" class="tw-switch" title="Switch terminal" aria-label="Switch terminal"><span class="tw-switch-n"></span> <span class="tw-mark" data-agent=""></span></button>
        <button class="ghost tw-act" data-act="split-right" type="button" title="Split right" aria-label="Split right">${TW_ICONS.splitRight}</button>
        <button class="ghost tw-act" data-act="split-down" type="button" title="Split down" aria-label="Split down">${TW_ICONS.splitDown}</button>
        <button class="ghost tw-act" data-act="zoom" type="button" aria-pressed="false" title="Zoom the focused pane" aria-label="Zoom the focused pane">${TW_ICONS.zoom}</button>
        <button class="ghost tw-act tw-act-more" data-act="more" type="button" title="Pane menu — rename, combine spaces, close" aria-label="Pane menu" aria-haspopup="menu">⋯</button>
        <div class="seg tw-zoom" role="group" aria-label="Terminal text size">
          <button data-z="-1" type="button" title="Smaller text (Ctrl -)" aria-label="Smaller terminal text">${TW_ICONS.zoomOut}</button>
          <button data-z="0" type="button" class="tw-zoom-val" title="Reset text size (Ctrl 0)" aria-label="Reset terminal text size">${termFontSize()}</button>
          <button data-z="1" type="button" title="Bigger text (Ctrl +)" aria-label="Bigger terminal text">${TW_ICONS.zoomIn}</button>
        </div>
        ${opts.extraButtons || ''}
      </div>
      <div class="tw-panes"><div class="tw-modebar" hidden></div></div>
      <form class="tw-compose" hidden>
        <textarea rows="2" placeholder="Type or dictate, then Send" aria-label="Text to send to the terminal"></textarea>
        <div class="tw-compose-btns">
          <button type="button" data-c="insert" title="Put the text in without pressing Enter">Insert</button>
          <button type="submit" data-c="send" class="tw-compose-send">Send ⏎</button>
        </div>
      </form>
      <div class="tw-keys" role="toolbar" aria-label="Terminal keys">
        <button type="button" data-k="kbd" class="tw-key-kbd" aria-label="Show or hide the keyboard">${TW_ICONS.keyboard}</button>
        <button type="button" data-k="compose" class="tw-key-compose" aria-pressed="false" aria-label="Text box for typing or dictation">${TW_ICONS.mic}</button>
        <button type="button" data-k="claude" class="tw-key-claude" title="Start Claude Code">claude</button>
        <button type="button" data-k="esc">Esc</button>
        <button type="button" data-k="tab">Tab</button>
        <button type="button" data-k="ctrl" aria-pressed="false">Ctrl</button>
        <button type="button" data-k="up" aria-label="Up">↑</button>
        <button type="button" data-k="down" aria-label="Down">↓</button>
        <button type="button" data-k="left" aria-label="Left">←</button>
        <button type="button" data-k="right" aria-label="Right">→</button>
        <button type="button" data-k="nl" aria-label="New line without sending">⇧⏎</button>
        <button type="button" data-k="/">/</button>
        <button type="button" data-k="|">|</button>
        <button type="button" data-k="~">~</button>
        <button type="button" data-k="-">-</button>
      </div>
    </div>
    <div class="tw-menu" role="menu" hidden></div>`;
  const q = (sel) => root.querySelector(sel);
  const panesEl = q('.tw-panes');
  const nameEl = q('.tw-space-name');
  const detailEl = q('.tw-space-detail');
  const zoomBtn = q('[data-act="zoom"]');
  const summaryEl = q('.tw-summary');
  const switchEl = q('.tw-switch');
  const menuEl = q('.tw-menu');
  const FOOT = '\u0000foot';   // menuFor while the sidebar's footer menu is open
  let sideMode = (() => { const v = twGet(K.side, null); return v === 'side' || v === 'rail' ? v : opts.sideDefault === 'side' ? 'side' : 'rail'; })();
  const side = createTermSide(q('.tw-side'), {
    onSpace: (key) => openSpace(key),
    onAgent: (id) => goTo(id),
    onNew: () => create(),
    onMenu: (anchor) => openFootMenu(anchor),
    onRenameSpace: (key) => renameSpacePrompt(key),
    onToggle: () => toggleSide(),
  });
  function toggleSide() { sideMode = sideMode === 'side' ? 'rail' : 'side'; twSet(K.side, sideMode); side.setMode(sideMode); }
  // Phone: the same tree, but only the focused pane shows; the sidebar and the
  // splits are hidden by CSS and a summary + switch pair opens the sheet.
  const picker = createTermPicker({
    spaces: () => spaces(), rows: () => rows(),
    goTo: (id) => goTo(id), onNew: () => create(),
    refocus: () => { const f = focused(); if (f) f.handle.focus(); },
  });
  const phoneMQ = window.matchMedia('(max-width: 700px)');
  const isPhone = () => phoneMQ.matches;
  function applyPhone() {
    if (isPhone()) root.dataset.phone = '1'; else delete root.dataset.phone;
    if (toasts) toasts.el.dataset.phone = isPhone() ? '1' : '';
  }
  let toasts = null;   // set below, once goTo exists
  applyPhone();
  phoneMQ.addEventListener('change', applyPhone);
  const openPicker = () => picker.open({ present: isPhone() ? 'sheet' : 'modal' });
  summaryEl.addEventListener('click', openPicker);
  switchEl.addEventListener('click', openPicker);
  // The phone bar's summary and switch, and the open sheet: drawn with the sidebar, from the same model.
  function renderPhone() {
    const key = W.store.active;
    const sp = W.sessions.some((s) => s.key === key) ? spaces().find((x) => x.key === key) : null;
    const name = sp ? sp.name : 'No terminals';
    const f0 = sp ? focused() : null;
    const sum = f0 ? `${name} · ${paneName(f0)}` : name;
    const sumText = summaryEl.querySelector('.tw-summary-text');
    if (sumText.textContent !== sum) sumText.textContent = sum;
    summaryEl.title = sum;
    summaryEl.querySelector('.tw-mark').dataset.agent = (f0 && f0.agent && f0.agent.state) || '';
    const allRows = rows();
    const nTxt = `≡ ${spaces(allRows).length}`;
    const nEl = switchEl.querySelector('.tw-switch-n');
    if (nEl.textContent !== nTxt) nEl.textContent = nTxt;
    switchEl.querySelector('.tw-mark').dataset.agent = TermTree.rollup(allRows.map((r) => r.agent && r.agent.state));
    if (picker.isOpen()) picker.refresh();
  }
  function renderSide() {
    renderPhone();
    const rs = rows();
    const f = focused();
    side.render({
      mode: sideMode, brand: HOST === 'window', spaces: spaces(rs), agents: TermTree.agentOrder(rs),
      activeKey: W.sessions.some((s) => s.key === W.store.active) ? W.store.active : null, focusedId: f ? f.id : null,
    });
  }

  const session = (id) => W.sessions.find((s) => s.id === id);
  const focused = () => session(W.focused) || W.sessions[0] || null;
  const label = (s) => s.title || `${s.n} · ${s.cwd ? s.cwd.split('/').pop() : 'vault'}`;
  const meta = (s) => ({ id: s.id, n: s.n, title: s.title, cwd: s.cwd, task: s.task });
  // The pane's own name: a rename, else the shell's OSC title, else "shell".
  const paneName = (s) => TermTree.paneTitle({ title: s.title, osc: s.osc, cmd: '' });

  // ---------- Agent badges ----------
  // "done" means finished and not looked at yet: the focused terminal, on a
  // visible page, in a workspace that's on screen, counts as looked at.
  // hasFocus too: a window behind another app still reports 'visible'.
  const looking = (s) => s.id === W.focused && document.visibilityState === 'visible' && document.hasFocus()
    && (!opts.isActive || opts.isActive());
  function markSeen(s) { if (s && s.agent && s.agent.state === 'done' && looking(s)) s.handle.seen(); }
  function onAgent(s, a) {
    s.agent = a;
    observeAgent(s.id, a);
    markSeen(s);
    renderStrip(s);
    renderSide();
    if (opts.onAgents) {
      const sum = { working: 0, blocked: 0, done: 0, idle: 0 };
      for (const x of W.sessions) if (x.agent) sum[x.agent.state]++;
      opts.onAgents(sum);
    }
  }
  document.addEventListener('visibilitychange', () => markSeen(focused()));
  window.addEventListener('focus', () => markSeen(focused()));

  // A blocked / done episode, from a held session's socket or from the list:
  // both go through one memo, so each fires once (onEvent kind 'agent').
  function observeAgent(id, agent) {
    const e = TermTree.observe(W.memo, id, agent);
    if (e) emit({ kind: 'agent', id: e.id, state: e.state, since: e.since });
  }
  function emit(e) {
    for (const cb of W.eventCbs) try { cb(e); } catch (err) { console.error(err); }
  }

  // ---------- Tree store ----------
  // One split tree per space, saved per tab (sessionStorage, so two VaultOS
  // tabs keep their own arrangement) with a localStorage mirror for a new tab.
  function loadStore() {
    let raw = null;
    try { raw = sessionStorage.getItem(K.tree); } catch { /* storage blocked */ }
    if (raw == null) try { raw = localStorage.getItem(K.tree); } catch { /* storage blocked */ }
    return TermTree.parseStore(raw);
  }
  // While a restore is landing, the saved active space and focus are kept as
  // they were (a reload mid-restore comes back to the same place).
  function save() {
    if (opts.persist) tabSet(K.sessions, savedList());
    const p = W.pend;
    tabSet(K.focused, p ? p.focus : W.focused);
    const store = p ? { ...W.store, active: p.active } : W.store;
    try { sessionStorage.setItem(K.tree, JSON.stringify(store)); } catch { /* storage blocked */ }
    twSet(K.tree, store);
  }
  // The saved set: what's held, then the saved sessions a restore may still bring back.
  function savedList() {
    const held = W.sessions.map(meta);
    return held.concat(W.saved.filter((m) => W.expected.has(m.id) && !session(m.id)));
  }

  // Held sessions of a space, in tree order.
  function heldIn(key) {
    const sp = key && W.store.spaces[key];
    return sp ? TermTree.leaves(sp.root).filter((id) => { const s = session(id); return s && s.key === key; }) : [];
  }
  // A space's zoomed and focused panes. A reload re-adds sessions one by one,
  // so the saved ones may not be here yet: they're left in the store (the
  // pane comes back to them) and the space shows what it has meanwhile.
  function zoomOf(key) {
    const sp = key && W.store.spaces[key];
    return sp && sp.zoom && heldIn(key).includes(sp.zoom) ? sp.zoom : null;
  }
  function focusOf(key) {
    const held = heldIn(key);
    const sp = key && W.store.spaces[key];
    return zoomOf(key) || (sp && held.includes(sp.focus) ? sp.focus : held[0] || null);
  }
  // Spaces with a held session, first-seen order. (Alt+1…9 counts the sidebar's numbers, TermTree.spaces' num.)
  function spaceKeys() {
    const out = [];
    for (const s of W.sessions) if (!out.includes(s.key)) out.push(s.key);
    return out;
  }

  // Tasks a plain shell in a job folder may join: the held ones and the server's.
  function knownTasks() {
    const known = new Set();
    for (const x of W.sessions) if (x.task) known.add(x.task);
    for (const x of W.list || []) if (x.task) known.add(x.task);
    return known;
  }

  // The space a session belongs to. The task-folder join rule depends on which
  // tasks are known, so a restore that brings a plain shell back before the task
  // one would split the space in two: the saved tree remembers where it sat.
  function keyFor(s) {
    const key = TermTree.spaceKey(s, knownTasks());
    if (key.startsWith('t:')) return key;
    for (const k of Object.keys(W.store.spaces)) {
      if (k.startsWith('t:') && TermTree.leaves(W.store.spaces[k].root).includes(s.id)
        && TermTree.spaceKey(s, new Set([k.slice(2)])) === k) return k;
    }
    // A pane combined into another space stays there across a reload.
    for (const k of Object.keys(W.store.spaces)) if (TermTree.leaves(W.store.spaces[k].root).includes(s.id)) return k;
    return key;
  }

  // The leaf that takes over a closed pane's place: the first held one in its sibling.
  function sibling(node, id) {
    if (!node || typeof node.id === 'string') return null;
    if (node.a.id === id) return node.b;
    if (node.b.id === id) return node.a;
    return sibling(node.a, id) || sibling(node.b, id);
  }
  // Takes a leaf out of a space's tree, moving focus (and zoom) to its sibling.
  function dropLeaf(key, id) {
    const sp = W.store.spaces[key];
    if (!sp) return;
    const next = TermTree.remove(sp.root, id);
    if (!next) { delete W.store.spaces[key]; return; }
    const ids = TermTree.leaves(next);
    if (!ids.includes(sp.focus)) {
      const held = (n) => TermTree.leaves(n).filter((x) => session(x));
      sp.focus = held(sibling(sp.root, id))[0] || held(next)[0] || ids[0];
    }
    if (sp.zoom && !ids.includes(sp.zoom)) sp.zoom = ids.length > 1 ? sp.focus : null;
    sp.root = next;
  }

  // Drops every leaf whose session isn't here (or sits in another space) and
  // isn't expected back. Synchronous, and run before anything is placed: a
  // new pane laid out beside a ghost would open at the ghost-shared size and
  // tell the pty so, then jump. An expected one keeps its slot, so the panes
  // a reload brings back open at their final size.
  function dropGhosts() {
    for (const k of Object.keys(W.store.spaces)) {
      for (const id of TermTree.leaves(W.store.spaces[k].root)) {
        const s = session(id);
        if (s ? s.key === k : W.expected.has(id)) continue;
        dropLeaf(k, id);
      }
    }
    if (W.store.active && !W.store.spaces[W.store.active]) W.store.active = null;
  }

  // The panes area in px. A hidden dock measures 0, so placement guesses a
  // wide strip and the too-small check is skipped.
  function paneBox() {
    const w = panesEl.clientWidth;
    const h = panesEl.clientHeight;
    return w && h ? { w, h, real: true } : { w: window.innerWidth || 1600, h: 300, real: false };
  }

  // Puts a new session's leaf into its space's tree.
  //   split 'right'|'down' + target: beside / under that pane (R6: right = 'row', down = 'col')
  //   otherwise: into the largest pane
  // A leaf the saved tree already has for this id stays where it is (a reload
  // re-adds every saved session; placing them again would scramble the layout).
  function place(s, { split, target, focus }) {
    dropGhosts();   // also a leaf of this id in a space it no longer belongs to
    const sp = W.store.spaces[s.key];
    if (sp && TermTree.leaves(sp.root).includes(s.id)) { migrateZoom(s.key); return; }
    const box = paneBox();
    const splitting = !!(split && sp && TermTree.leaves(sp.root).includes(target));
    const next = splitting
      ? TermTree.insert(sp.root, s.id, { target, dir: split === 'down' ? 'col' : 'row' })
      : TermTree.insertLargest(sp ? sp.root : null, s.id, { w: box.w, h: box.h, focus: sp && sp.focus });
    // A split is asked to be seen, so it unzooms. Any other new pane in a
    // zoomed space takes the zoom over (focus moves the zoom with it).
    const out = { root: next, focus: focus || !sp ? s.id : sp.focus, zoom: sp && !splitting ? sp.zoom : null };
    // A pane that leaves one under ~140×70px still goes in, then zooms (and
    // so is focused there: a zoomed space shows only its focused pane).
    if (box.real && TermTree.tooSmall(TermTree.layout(next).rects, box.w, box.h)) { out.zoom = s.id; out.focus = s.id; }
    W.store.spaces[s.key] = out;
    migrateZoom(s.key);
  }

  // The Tabs migration, once per space: zoom it to its focused pane.
  function migrateZoom(key) {
    const sp = W.store.spaces[key];
    if (!W.wasTabs || !sp || W.migrated.has(key)) return;
    W.migrated.add(key);
    sp.zoom = sp.focus;
  }

  // ---------- Sessions ----------
  function note(s, html) {
    const el = s.pane.querySelector('.term-note');
    el.innerHTML = html || '';
    el.classList.toggle('hidden', !html);
  }

  function onState(s, state) {
    s.state = state;
    if (state === 'moved') { stolen(s); return; }
    if (state === 'denied') {
      note(s, 'The terminal needs a signed-in session (a same-box read-only view can\'t open a shell). Sign out and back in, then try again.');
    } else if (state === 'closed') {
      note(s, `Session ended. <button type="button" class="linklike" data-act="close">Close it</button>`);
    } else if (state === 'open') note(s, '');
    renderStrip(s);
  }

  // Another page or device opened this session (code 4000). The pane goes
  // (the shell keeps running there) and so does its place in the saved set;
  // its row stays, as "elsewhere". No bringing it back from here: that would
  // steal it straight back.
  function stolen(s) {
    if (!session(s.id)) return;
    const sp = spaces().find((x) => x.key === s.key);
    const name = sp ? `${sp.name} · ${paneName(s)}` : paneName(s);
    W.expected.delete(s.id);
    remove(s.id, { kill: false });
    emit({ kind: 'moved', id: s.id, name });
  }

  function onTitle(s, t) {
    s.osc = t;
    if (paneName(s) !== s.pane.querySelector('.tw-pane-name').textContent) { renderStrip(s); renderPhone(); }
  }

  // The title strip: agent mark, name, ⋯.
  function renderStrip(s) {
    const name = paneName(s);
    const nameEl = s.pane.querySelector('.tw-pane-name');
    if (nameEl.textContent !== name) nameEl.textContent = name;
    const status = s.agent ? agentText(s.agent.state) : TW_STATE_TEXT[s.state] || '';
    nameEl.title = status ? `${name} — ${status}` : name;
    const mark = s.pane.querySelector('.tw-mark');
    mark.dataset.agent = s.agent ? s.agent.state : '';
    mark.title = status;
    s.pane.dataset.state = s.state;
  }

  function buildPane(s) {
    const pane = document.createElement('div');
    pane.className = 'tw-pane';
    pane.dataset.id = s.id;
    pane.innerHTML = '<div class="tw-pane-strip"><span class="tw-mark" data-agent=""></span><span class="tw-pane-name"></span>'
      + '<button type="button" class="tw-pane-more" title="Pane menu" aria-label="Pane menu" aria-haspopup="menu">⋯</button></div>'
      + '<div class="term-host"></div><div class="term-note hidden"></div>';
    return pane;
  }

  function wirePane(s) {
    s.pane.addEventListener('pointerdown', () => { picked(); focusSession(s.id, { keepKeyboard: true }); }, true);
    // A tap (not a scroll) on a touch screen focuses the terminal right here,
    // inside the gesture: that's the only kind of focus iOS and Android will
    // raise the on-screen keyboard for, and xterm's own mouse handling doesn't
    // reliably get there from a touch.
    let tap = null;
    s.pane.addEventListener('pointerdown', (e) => { tap = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null; });
    s.pane.addEventListener('pointerup', (e) => {
      // Not on the title strip or its ⋯: that would flash the keyboard and close the menu.
      if (tap && !e.target.closest('.tw-pane-strip') && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) s.handle.focus();
      tap = null;
    });
    s.pane.addEventListener('focusin', () => { if (W.focused !== s.id) focusSession(s.id, { keepKeyboard: true }); });
    s.pane.querySelector('.term-note').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'close') remove(s.id);
    });
    const strip = s.pane.querySelector('.tw-pane-strip');
    const more = strip.querySelector('.tw-pane-more');
    strip.addEventListener('click', (e) => {
      if (!e.target.closest('.tw-pane-more')) { s.handle.focus(); return; }
      const shut = W.menuShut;
      if (shut && shut.id === s.id && Date.now() - shut.t < 400) return;   // this press just closed it
      const r = more.getBoundingClientRect();
      openMenu(s.id, { x: r.right, y: r.bottom + 2, alignRight: true });
    });
    // Right-click on the strip opens the same menu. Inside .term-host it's
    // left to term.js, where right-click pastes.
    strip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(s.id, { x: e.clientX, y: e.clientY });
    });
  }

  // Create (or, with a known id, reattach to) a session. The server keeps a
  // detached shell (for as long as something runs in it, a day if idle), so a
  // reload, a sleep or a hand-over between windows reattaches with its scrollback.
  function add({ id, n, title, cwd, task, run, focus = false, split, target } = {}) {
    if (id && session(id)) return session(id);
    const seq = n || (twGet(TW_SEQ_KEY, 0) + 1);
    if (!n) twSet(TW_SEQ_KEY, seq);
    // The server's task wins when it knows this session (it links job folders and follows /done).
    const listed = id && W.list ? W.list.find((x) => x.id === id) : null;
    const s = {
      id: id || twNewId(), n: seq, title: title || '', cwd: cwd || '', task: (listed && listed.task) || task || '',
      key: '', osc: '', handle: null, pane: null, state: 'connecting', agent: null, topts: null,
    };
    // A split goes into its target's space, whatever its own folder would
    // key to now (a plain shell that joined a task space stays there).
    const into = split ? session(target) : null;
    s.key = into ? into.key : keyFor(s);
    s.joined = s.key !== TermTree.spaceKey(s, knownTasks());   // combined by hand: the server's task link doesn't pull it back out
    W.expected.delete(s.id);
    s.pane = buildPane(s);
    panesEl.appendChild(s.pane);
    renderStrip(s);
    // An active space with nothing held here (first load, or it just emptied) gives way to this one.
    const activeHeld = W.sessions.some((x) => x.key === W.store.active);
    W.sessions.push(s);
    place(s, { split, target, focus });
    if (focus) {
      const sp = W.store.spaces[s.key];
      sp.focus = s.id;
      if (sp.zoom) sp.zoom = s.id;
    }
    if (focus || !activeHeld) W.store.active = s.key;
    // Place the pane in its final rect *before* the terminal opens, so its first
    // size is its real size. Otherwise it opens full-width and then shrinks, and
    // a TUI that's already drawn (Claude's status line) is left wrapped.
    layout();
    // term.js reads cwd/task from this object on every (re)connect, so the
    // task the list links later is what a restarted server is asked for.
    s.topts = {
      id: s.id,
      cwd: s.cwd,
      task: s.task,
      run,
      onOpenPath: (rel) => opts.onOpenPath && opts.onOpenPath(rel),
      onState: (state) => onState(s, state),
      onAgent: (a) => onAgent(s, a),
      onTitle: (t) => onTitle(s, t),
    };
    s.handle = createTerminal(s.pane.querySelector('.term-host'), s.topts);
    wirePane(s);
    save();
    heldChanged();
    if (!W.restoring) settleRestore();   // the old one-by-one restore (workbench's): the last add settles it
    return s;
  }

  // o.split 'right'|'down' (+ o.target, default the focused pane) opens the new
  // shell beside / under that pane, in the same folder and task.
  // At the server's cap (12) it opens nothing: onEvent gets { kind: 'cap' }.
  // canOpen() is the same check for a host that is about to mint an id itself
  // (the dock handing a new terminal to the window): false emits { kind: 'cap' }.
  function canOpen() {
    if (TermTree.canOpen(capList())) return true;
    emit({ kind: 'cap' });
    return false;
  }
  function create(o = {}) {
    if (!canOpen()) return null;
    picked();   // a new terminal is a choice: the restore doesn't take the focus back from it
    if (opts.beforeNew) opts.beforeNew();
    let o2 = o;
    if (o.split) {
      const t = session(o.target) || focused();
      if (t) o2 = { ...o, cwd: o.cwd != null ? o.cwd : t.cwd, task: o.task != null ? o.task : t.task, target: t.id };
    }
    const s = add({ ...o2, focus: true });
    focusSession(s.id);
    return s;
  }

  // kill: end the shell. Without it the pane goes but the shell keeps running
  // server-side — that's how a session is handed to another window.
  function remove(id, { kill = true } = {}) {
    const i = W.sessions.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const s = W.sessions[i];
    if (W.menuFor === id) closeMenu(false);
    if (kill && s.state !== 'closed') s.handle.kill();
    if (kill) setTimeout(() => s.handle.dispose(), 250); else s.handle.dispose();
    s.pane.remove();
    W.sessions.splice(i, 1);
    dropLeaf(s.key, id);
    if (!heldIn(s.key).length) delete W.store.spaces[s.key];
    if (W.store.active === s.key && !W.store.spaces[s.key]) W.store.active = spaceKeys()[0] || null;
    layout();
    save();
    const f = focused();
    if (f) f.handle.focus();
    heldChanged();
    return meta(s);
  }

  // The held set changed: tell other pages, refresh the list soon, re-render.
  function heldChanged() {
    postPresence();
    pollSoon();
    notify();
    if (opts.onChange) opts.onChange(W.sessions.length);
  }

  // Focus a session, showing its space. A zoomed space stays zoomed, on this pane.
  function focusSession(id, { keepKeyboard = false } = {}) {
    const s = session(id);
    if (!s) return;
    const sp = W.store.spaces[s.key];
    if (sp) {
      sp.focus = id;
      if (sp.zoom) sp.zoom = id;
    }
    W.store.active = s.key;
    W.focused = id;
    layout();
    save();
    markSeen(s);
    // This id, not focused(): a focus queued before this one (the dock showing
    // itself for a new terminal focuses the old one) would otherwise win.
    if (!keepKeyboard) requestAnimationFrame(() => { if (session(id)) s.handle.focus(); });
  }

  function showSpace(key) {
    const id = focusOf(key);
    if (!id) return false;
    picked();
    focusSession(id);
    return true;
  }
  // A space row was clicked. One with a pane here is shown; one without goes to its most urgent row
  // (TermTree.spaces' goId), which goTo brings here or shows where it is (the cross-host table).
  function openSpace(key) {
    if (showSpace(key)) return;
    const sp = spaces().find((x) => x.key === key);
    if (sp && sp.goId) goTo(sp.goId);
  }

  // Fold every pane of one space into another, as splits beside what is already there.
  function combineSpace(fromKey, toKey) {
    const ids = heldIn(fromKey);
    if (fromKey === toKey || !ids.length || !W.store.spaces[toKey]) return;
    const box = paneBox();
    for (const id of ids) {
      const s = session(id);
      W.store = TermTree.rekey(W.store, id, s.key, toKey, { w: box.w, h: box.h }).store;
      s.key = toKey;
      s.joined = true;
    }
    W.store.spaces[toKey].zoom = null;   // show them all, not just the zoomed pane
    picked();
    focusSession(ids[0]);
    heldChanged();
  }

  function split(dir) {
    return create({ split: dir === 'down' ? 'down' : 'right' });
  }

  function toggleZoom() {
    const sp = W.store.spaces[W.store.active];
    if (!sp) return;
    if (zoomOf(W.store.active)) sp.zoom = null;
    else if (heldIn(W.store.active).length > 1) sp.zoom = focusOf(W.store.active);
    layout();
    save();
    const f = focused();
    if (f) f.handle.focus();
  }

  // Focus the pane to the left / right / up / down of the focused one.
  function focusDir(dir) {
    const sp = W.store.spaces[W.store.active];
    if (!sp) return;
    const next = TermTree.neighbour(TermTree.layout(sp.root).rects, focusOf(W.store.active), dir);
    if (next && session(next)) { picked(); focusSession(next); }
  }

  // ---------- Layout ----------
  // Every space is laid out, not just the active one: a hidden pane keeps its
  // real size, so switching spaces never resizes a terminal.
  function layout() {
    const keys = spaceKeys();
    if (keys.length && !keys.includes(W.store.active)) W.store.active = keys[0];
    const act = W.store.active;
    W.focused = focusOf(act);
    if (W.sessions.length) delete panesEl.dataset.empty; else panesEl.dataset.empty = '1';
    let splits = [];
    let activeSingle = false;
    for (const key of Object.keys(W.store.spaces)) {
      const held = heldIn(key);
      if (!held.length) continue;
      const sp = W.store.spaces[key];
      const L = TermTree.layout(sp.root);
      const zoom = zoomOf(key);
      const single = !!zoom || TermTree.leaves(sp.root).length === 1;
      if (key === act) { activeSingle = single; if (!zoom) splits = L.splits; }
      for (const id of held) {
        const s = session(id);
        const shown = !zoom || id === zoom;
        const [x, y, w, h] = zoom && shown ? [0, 0, 1, 1] : L.rects[id];
        const g = single && shown ? 0 : GAP / 2;
        Object.assign(s.pane.style, {
          left: `calc(${x * 100}% + ${g}px)`, top: `calc(${y * 100}% + ${g}px)`,
          width: `calc(${w * 100}% - ${2 * g}px)`, height: `calc(${h * 100}% - ${2 * g}px)`,
        });
        s.pane.classList.toggle('tw-off', key !== act || !shown);
        s.pane.classList.toggle('focused', id === W.focused);
        if (single && shown) s.pane.dataset.single = '1'; else delete s.pane.dataset.single;
      }
    }
    if (activeSingle) panesEl.dataset.single = '1'; else delete panesEl.dataset.single;
    renderSplits(act, splits);
    renderBar();
  }

  // The bar names the active space, from the merged model (task title and
  // status, branch, custom name).
  function renderBar() {
    const key = W.store.active;
    const sp = W.sessions.some((s) => s.key === key) ? spaces().find((x) => x.key === key) : null;
    const name = sp ? sp.name : 'No terminals';
    const detail = sp ? sp.detail : '';
    if (nameEl.textContent !== name) nameEl.textContent = name;
    if (detailEl.textContent !== detail) detailEl.textContent = detail;
    nameEl.title = sp ? sp.name : '';
    detailEl.title = detail;
    const zoomed = !!zoomOf(key) && heldIn(key).length > 1;
    zoomBtn.setAttribute('aria-pressed', String(zoomed));
    zoomBtn.title = zoomed ? 'Show every pane in this space' : 'Zoom the focused pane';
    renderSide();
  }

  // One handle per split of the active space, rebuilt on every layout. Inner
  // splits first, so where a divider meets the one it starts from (a T), the
  // outer, longer one is on top.
  function renderSplits(key, splits) {
    for (const el of panesEl.querySelectorAll('.tw-split')) el.remove();
    for (const sp of [...splits].reverse()) {
      const el = document.createElement('div');
      el.className = 'tw-split';
      el.dataset.dir = sp.dir;
      el.dataset.path = sp.path;
      el.title = 'Drag to resize · double-click to even out';
      if (sp.dir === 'row') Object.assign(el.style, { left: `${(sp.x + sp.w * sp.r) * 100}%`, top: `${sp.y * 100}%`, height: `${sp.h * 100}%` });
      else Object.assign(el.style, { top: `${(sp.y + sp.h * sp.r) * 100}%`, left: `${sp.x * 100}%`, width: `${sp.w * 100}%` });
      // Double-click is timed by hand: the first press's drag re-lays-out and
      // replaces this element, so a real dblclick never lands on the same node
      // twice (and pointerdown's e.detail is always 0).
      el.addEventListener('pointerdown', (e) => {
        const now = Date.now();
        const last = W.lastSplitDown;
        W.lastSplitDown = { key, path: sp.path, t: now };
        if (last && last.key === key && last.path === sp.path && now - last.t < 400) {
          e.preventDefault();
          W.lastSplitDown = null;
          setRatio(key, sp.path, 0.5);
          save();
          return;
        }
        startSplitDrag(e, key, sp);
      });
      panesEl.appendChild(el);
    }
  }

  function setRatio(key, path, r) {
    const sp = W.store.spaces[key];
    if (!sp || !Number.isFinite(r)) return;
    sp.root = TermTree.setRatio(sp.root, path, r);
    layout();
  }

  // Window-level listeners rather than pointer capture: every move re-lays-out,
  // which rebuilds the handle being dragged. Each move re-checks the split is
  // still there (a pane can close, or the space change, mid-drag).
  function startSplitDrag(e, key, sp) {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = panesEl.getBoundingClientRect();
    const cls = sp.dir === 'row' ? 'tw-drag-row' : 'tw-drag-col';
    document.body.classList.add('tw-splitting', cls);
    const current = () => {
      const s = W.store.spaces[key];
      return s && W.store.active === key && !zoomOf(key)
        ? TermTree.layout(s.root).splits.find((x) => x.path === sp.path && x.dir === sp.dir) : null;
    };
    const move = (ev) => {
      const cur = current();
      if (!cur) { up(); return; }
      const f = sp.dir === 'row'
        ? ((ev.clientX - box.left) / box.width - cur.x) / cur.w
        : ((ev.clientY - box.top) / box.height - cur.y) / cur.h;
      setRatio(key, sp.path, f);
      const h = panesEl.querySelector(`.tw-split[data-path="${sp.path}"]`);
      if (h) h.classList.add('dragging');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('tw-splitting', cls);
      save();
      layout();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- Pane menu (⋯ and right-click on the strip) ----------
  function openMenu(id, { x, y, alignRight = false }) {
    const s = session(id);
    if (!s) return;
    const zoomed = !!zoomOf(s.key);
    const item = (m, icon, text) => `<button type="button" role="menuitem" data-m="${m}">${icon}<span>${text}</span></button>`;
    menuEl.innerHTML = item('rename', TW_ICONS.rename, 'Rename…')
      + item('split-right', TW_ICONS.splitRight, 'Split right')
      + item('split-down', TW_ICONS.splitDown, 'Split down')
      + item('zoom', TW_ICONS.zoom, zoomed ? 'Unzoom' : 'Zoom')
      + spaces().filter((sp) => sp.key !== s.key && heldIn(sp.key).length).slice(0, 8)
        .map((sp) => `<button type="button" role="menuitem" data-m="combine" data-to="${twEsc(sp.key)}">${TW_ICONS.splitRight}<span>Combine into ${twEsc(sp.name)}</span></button>`).join('')
      + item('close', TW_ICONS.close, 'Close');
    W.menuFor = id;
    menuEl.hidden = false;
    // Keep it on screen: flip left/up when it would run off the edge.
    const r = menuEl.getBoundingClientRect();
    const left = alignRight ? x - r.width : x;
    menuEl.style.left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4)) + 'px';
    menuEl.style.top = Math.max(4, y + r.height > window.innerHeight - 4 ? y - r.height : y) + 'px';
    menuEl.querySelector('button:not(:disabled)').focus();
  }
  // The sidebar's footer menu: the same .tw-menu, opened above its button.
  const SOUND_KEY = 'vaultboard.term.sound';
  function openFootMenu(anchor) {
    const item = (m, text, hint, off) => `<button type="button" role="menuitem" data-m="${m}"${off ? ' disabled' : ''}><span>${text}</span>${hint ? `<small>${hint}</small>` : ''}</button>`;
    menuEl.innerHTML = item('goto', 'Go to…', 'Ctrl+Space g', false) + item('keys', 'Shortcuts', 'Ctrl+Space ?', false)
      + item('sound', `Sound: ${twGet(SOUND_KEY, false) === true ? 'On' : 'Off'}`, '', false);
    W.menuFor = FOOT;
    W.footAnchor = anchor;
    menuEl.hidden = false;
    const a = anchor.getBoundingClientRect();
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4)) + 'px';
    menuEl.style.top = Math.max(4, a.top - r.height - 2) + 'px';
    menuEl.querySelector('button:not(:disabled)').focus();
  }
  function closeMenu(refocus) {
    if (menuEl.hidden) return;
    const foot = W.menuFor === FOOT;
    const s = session(W.menuFor);
    menuEl.hidden = true;
    W.menuFor = null;
    if (refocus && foot && W.footAnchor && W.footAnchor.isConnected) W.footAnchor.focus();
    else if (refocus && s) s.handle.focus();
  }

  function renamePane(id) {
    const s = session(id);
    if (!s) return;
    const shown = paneName(s);
    const name = prompt('Name this pane', s.title || shown);
    if (name != null && !(s.title === '' && name.trim() === shown)) {
      s.title = name.trim();
      save();
      renderStrip(s);
    }
    s.handle.focus();
  }

  function closePane(id) {
    const s = session(id);
    if (!s) return;
    if (s.state === 'open' && !confirm(`End "${paneName(s)}"? Anything running in it is stopped.`)) return;
    remove(id);
  }

  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    const id = W.menuFor;
    if (!b || !id) return;
    closeMenu(false);
    const m = b.dataset.m;
    if (id === FOOT) { if (m === 'goto') openPicker(); else if (m === 'keys') termKeys.openSheet(); else if (m === 'sound') twSet(SOUND_KEY, twGet(SOUND_KEY, false) !== true); return; }
    if (m === 'rename') renamePane(id);
    else if (m === 'split-right' || m === 'split-down') create({ split: m.slice(6), target: id });
    else if (m === 'zoom') { focusSession(id, { keepKeyboard: true }); toggleZoom(); }
    else if (m === 'combine') combineSpace(session(id).key, b.dataset.to);
    else if (m === 'close') closePane(id);
  });
  // Escape stays on the menu: app.js closes the drawer on any document Escape.
  menuEl.addEventListener('keydown', (e) => {
    const items = [...menuEl.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!W.menuFor || menuEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.tw-pane-more, .tw-act-more')) W.menuShut = { id: W.menuFor, t: Date.now() };
    closeMenu(false);
  }, true);
  window.addEventListener('blur', () => closeMenu(false));
  window.addEventListener('resize', () => closeMenu(false));

  // ---------- Bar ----------
  q('[data-act="split-right"]').addEventListener('click', () => split('right'));
  q('[data-act="split-down"]').addEventListener('click', () => split('down'));
  zoomBtn.addEventListener('click', () => toggleZoom());
  // The strip's ⋯ is hidden on a lone or zoomed pane; this one is always there.
  q('[data-act="more"]').addEventListener('click', (e) => {
    const f = focused();
    if (!f) return;
    if (W.menuShut && W.menuShut.id === f.id && Date.now() - W.menuShut.t < 300) return;   // the click that just closed it
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(f.id, { x: r.right, y: r.bottom + 2, alignRight: true });
  });
  const zoomEl = q('.tw-zoom');
  zoomEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-z]');
    if (!b) return;
    setTermZoom(Number(b.dataset.z));
    const f = focused();
    if (f) f.handle.focus();
  });
  window.addEventListener('vaultos-termzoom', (e) => { q('.tw-zoom-val').textContent = e.detail; });

  // ---------- Touch key row ----------
  // The keys a phone keyboard doesn't have and a shell / Claude Code needs.
  // Shown on touch screens only (styles.css). pointerdown + preventDefault so
  // a tap never moves focus off the terminal — that would drop the keyboard.
  const KEY_SEQ = {
    esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
    nl: '\x1b\r',   // what Shift+Enter sends (term.js): new line, don't submit
    claude: 'claude\r',
  };
  const keysEl = q('.tw-keys');
  const ctrlBtn = keysEl.querySelector('[data-k="ctrl"]');
  const setCtrl = (on) => ctrlBtn.setAttribute('aria-pressed', String(on));
  // Ctrl+letter → the control character (a→\x01 … z→\x1a); anything else as typed.
  const toCtrl = (d) => (d.length === 1 && /[a-z@[\\\]^_ ]/i.test(d) ? String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31) : d);
  keysEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  keysEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    const f = focused();
    if (!b || !f) return;
    const k = b.dataset.k;
    if (k === 'kbd') {
      if (f.pane.contains(document.activeElement)) f.handle.blur(); else f.handle.focus();
      return;
    }
    if (k === 'compose') { setCompose(composeEl.hidden); return; }
    if (k === 'ctrl') {
      const on = ctrlBtn.getAttribute('aria-pressed') !== 'true';
      setCtrl(on);
      f.handle.onNextInput(on ? (d) => { setCtrl(false); return toCtrl(d); } : null);
      return;
    }
    let seq = KEY_SEQ[k] ?? k;
    if (ctrlBtn.getAttribute('aria-pressed') === 'true') { f.handle.onNextInput(null); setCtrl(false); seq = toCtrl(seq); }
    f.handle.type(seq);
  });
  // Compose box. Phone dictation straight into xterm comes out garbled: the
  // voice keyboard keeps rewriting its guess via composition events, and xterm
  // forwards each rewrite as more keystrokes. A real textarea lets the keyboard
  // finish its edits; only the final text reaches the terminal.
  const composeEl = q('.tw-compose');
  const composeTa = composeEl.querySelector('textarea');
  const composeBtn = keysEl.querySelector('[data-k="compose"]');
  function setCompose(open) {
    composeEl.hidden = !open;
    composeBtn.setAttribute('aria-pressed', String(open));
    if (open) composeTa.focus();
    else { const f = focused(); if (f) f.handle.focus(); }
  }
  function sendCompose(enter) {
    const f = focused();
    const text = composeTa.value.replace(/\r?\n/g, ' ').trim();
    if (!f || (!text && !enter)) return;
    if (text) f.handle.type(text);
    // Enter as its own write: in the same chunk Claude Code reads text+CR as a
    // paste and puts a newline in the prompt instead of submitting.
    if (enter) setTimeout(() => f.handle.type('\r'), text ? 60 : 0);
    composeTa.value = '';
    composeTa.focus();
  }
  composeEl.addEventListener('submit', (e) => { e.preventDefault(); sendCompose(true); });
  composeEl.querySelector('[data-c="insert"]').addEventListener('click', () => sendCompose(false));
  composeEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  composeTa.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCompose(true); }
  });

  // Ctrl+Space prefix keys, Alt+1…9 (space N) and Ctrl+Shift+` (new terminal): termkeys.js.
  const termKeys = installTermKeys(root, {
    host: HOST,
    isActive: () => !opts.isActive || opts.isActive(),
    isPhone,
    sendNul: () => { const f = focused(); if (f) f.handle.type('\x00'); },
    split, toggleZoom, focusDir, openPicker, toggleSide,
    closeFocused: () => { if (W.focused) closePane(W.focused); },
    nextNeedingYou: () => { const id = TermTree.nextNeedingYou(rows(), W.focused); if (id) goTo(id); },
    // The space numbered n on screen: only spaces with a pane here have one, so a key never brings a session.
    showSpaceN: (n) => { const sp = spaces().find((x) => x.num === n); if (sp) showSpace(sp.key); },
    overlayOpen: () => picker.isOpen(),
    newPane: () => create(),
    refocus: () => { const f = focused(); if (f) f.handle.focus(); },
  });

  // Follow Dark/Sepia.
  new MutationObserver(() => { for (const s of W.sessions) s.handle.retheme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- Server list: rows and spaces ----------
  // Every terminal the server holds, merged with the held sessions and with
  // presence. Held rows keep the key their tree is filed under (a split stays
  // in its target's space even when its own folder would say otherwise).
  function heldMap() {
    return new Map(W.sessions.map((s) => [s.id, { meta: meta(s), osc: s.osc, agent: s.agent }]));
  }
  function rawRows() { return TermTree.rows(W.list, heldMap(), presenceMap()); }
  function rows() {
    return rawRows().map((r) => {
      const s = r.where === 'here' ? session(r.id) : null;
      return s && s.key !== r.key ? { ...r, key: s.key } : r;
    });
  }
  function spaceNames() {
    const n = twGet(NAMES_KEY, {});
    return n && typeof n === 'object' && !Array.isArray(n) ? n : {};
  }
  function spaces(rs) { return TermTree.spaces(rs || rows(), spaceNames()); }
  function where(id) {
    const r = rows().find((x) => x.id === id);
    return r ? r.where : null;
  }
  // The cap counts held sessions the list hasn't caught up with yet.
  function capList() {
    const l = (W.list || []).slice();
    for (const s of W.sessions) if (!l.some((x) => x.id === s.id)) l.push({ id: s.id, attached: true, cmd: '' });
    return l;
  }

  // The model changed (a poll, presence, the held set, a rename): re-render
  // the bar and tell onList.
  function notify() {
    renderBar();
    if (!W.listCbs.length) return;
    const rs = rows();
    for (const cb of W.listCbs) try { cb(W.list, rs); } catch (err) { console.error(err); }
  }

  // 401 → list null (held rows only). Unreachable (a server restart) keeps
  // the last list. Answers apply in order: an older, slower one never wins.
  function refreshList() {
    const seq = ++W.listSeq;
    return fetch('/api/term/list', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => {
        if (r.status === 401) return { state: 'denied', list: null };
        if (!r.ok) return { state: 'error' };
        return r.json().then((d) => ({ state: 'ok', list: Array.isArray(d && d.sessions) ? d.sessions : [] }));
      })
      .catch(() => ({ state: 'error' }))
      .then((res) => {
        if (seq < W.listApplied) return W.list;
        W.listApplied = seq;
        W.listState = res.state;
        if (res.state === 'error') return W.list;
        W.list = res.list;
        afterList();
        return W.list;
      });
  }
  function afterList() {
    if (rekeyFromList()) { layout(); save(); }
    const rs = rawRows();
    for (const r of rs) if (r.agent) observeAgent(r.id, r.agent);
    const ids = new Set(rs.map((r) => r.id));
    for (const id of W.memo.keys()) if (!ids.has(id)) W.memo.delete(id);   // gone: forget its last state
    notify();
  }
  let soonTimer = null;
  function pollSoon() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => refreshList(), 300);
  }
  const poll = () => { if (document.visibilityState === 'visible') refreshList(); };
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);

  // ---------- Rekey ----------
  // The server is the authority on a held session's task: it links a shell
  // opened in a job folder, and follows a task folder /done moved into _done/.
  // A session whose key changes moves its leaf to the new space. When every
  // pane of a space moves to the same new key, the space is renamed instead:
  // tree, focus, zoom and custom name all kept.
  function rekeyFromList() {
    if (!W.list) return false;
    const listed = new Map(W.list.map((x) => [x.id, x]));
    let changed = false;
    for (const s of W.sessions) {
      const x = listed.get(s.id);
      if (x && x.task && x.task !== s.task) { s.task = x.task; s.topts.task = x.task; changed = true; }
    }
    const want = new Map();   // id → new key
    for (const r of rawRows()) {
      const s = r.where === 'here' && listed.has(r.id) ? session(r.id) : null;
      if (s && !s.joined && s.key !== r.key) want.set(s.id, r.key);
    }
    if (!want.size) return changed;
    const names = spaceNames();
    let namesChanged = false;
    const moveName = (from, to) => {
      if (names[from] == null) return;
      names[to] = names[from];
      delete names[from];
      namesChanged = true;
    };
    const byFrom = new Map();
    for (const [id, to] of want) {
      const from = session(id).key;
      if (!byFrom.has(from)) byFrom.set(from, []);
      byFrom.get(from).push([id, to]);
    }
    const box = paneBox();
    for (const [from, moves] of byFrom) {
      const sp = W.store.spaces[from];
      const leaves = sp ? TermTree.leaves(sp.root) : [];
      const to = moves[0][1];
      const whole = sp && !W.store.spaces[to] && moves.every((m) => m[1] === to)
        && leaves.length === moves.length && leaves.every((id) => want.has(id));
      if (whole) {
        W.store.spaces[to] = sp;
        delete W.store.spaces[from];
        if (W.store.active === from) W.store.active = to;
        if (W.pend && W.pend.active === from) W.pend.active = to;
        if (W.migrated.has(from)) W.migrated.add(to);
        moveName(from, to);
        for (const [id] of moves) session(id).key = to;
        continue;
      }
      for (const [id, toKey] of moves) {
        const s = session(id);
        const r = TermTree.rekey(W.store, id, s.key, toKey, { w: box.w, h: box.h });
        W.store = r.store;
        if (r.renamed) moveName(s.key, toKey);
        s.key = toKey;
        if (!W.store.spaces[toKey] || !TermTree.leaves(W.store.spaces[toKey].root).includes(id)) place(s, {});
      }
    }
    if (namesChanged) twSet(NAMES_KEY, names);
    return true;
  }

  // ---------- Presence ----------
  // Which other VaultOS page holds which session, over the channel the dock
  // and the Terminals window already share. A page posts its held ids when
  // they change and when asked ({who}), and an empty list as it goes. Rows
  // use it only while the list also says attached, so a crashed page's
  // leftovers don't count.
  const chan = (() => { try { return new BroadcastChannel('vaultos-workbench'); } catch { return null; } })();
  function postPresence(ids) {
    if (!chan) return;
    try { chan.postMessage({ presence: { from: PAGE_ID, host: HOST, ids: ids || W.sessions.map((s) => s.id) } }); } catch { /* closing */ }
  }
  function presenceMap() {
    const out = new Map();
    for (const p of W.peers.values()) {
      const at = p.host === 'window' ? 'window' : HOST === 'dock' ? 'tab' : 'dock';
      for (const id of p.ids) out.set(id, at);
    }
    return out;
  }
  if (chan) {
    chan.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.who) postPresence();
      const p = d.presence;
      if (!p || typeof p.from !== 'string' || p.from === PAGE_ID || !Array.isArray(p.ids)) return;
      const ids = p.ids.filter((x) => typeof x === 'string');
      if (ids.length) W.peers.set(p.from, { host: p.host === 'window' ? 'window' : 'dock', ids });
      else W.peers.delete(p.from);
      notify();
      pollSoon();   // its terminals just changed hands: the list has too
    });
    window.addEventListener('pagehide', () => postPresence([]));
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;   // back from the bfcache: say hello again
      postPresence();
      try { chan.postMessage({ who: true }); } catch { /* closing */ }
    });
  }
  window.addEventListener('storage', (e) => { if (e.key === NAMES_KEY) notify(); });

  function renameSpace(key, name) {
    if (!key) return;
    const names = spaceNames();
    const v = String(name == null ? '' : name).trim();
    if (v) names[key] = v; else delete names[key];
    twSet(NAMES_KEY, names);
    notify();
  }

  function renameSpacePrompt(key) {
    const sp = spaces().find((x) => x.key === key);
    if (!sp) return;
    const name = prompt('Name this space (empty to reset)', sp.name);
    if (name != null) renameSpace(key, name);
  }

  // ---------- Restore and hand-over ----------
  // The user (or another page handing sessions over) chose a terminal: the
  // pending restore focus is dropped, and restore() won't take it back.
  function picked() {
    W.pend = null;
    W.picks++;
  }

  // The restore batch has landed (nothing more expected): come back to the
  // saved focus, or at least the saved active space.
  function settleRestore() {
    const p = W.pend;
    if (!p || W.expected.size) return;
    W.pend = null;
    if (p.focus && session(p.focus)) focusSession(p.focus, { keepKeyboard: true });
    else if (p.active && heldIn(p.active).length) { W.store.active = p.active; layout(); save(); }
    else if (W.sessions.length) save();
  }

  // Every space's tree holds exactly its held sessions.
  function reconcileAll() {
    const box = paneBox();
    const keys = new Set([...Object.keys(W.store.spaces), ...spaceKeys()]);
    for (const key of keys) {
      const held = W.sessions.filter((s) => s.key === key).map((s) => s.id);
      const sp = W.store.spaces[key];
      const next = TermTree.reconcile(sp ? sp.root : null, held, { w: box.w, h: box.h, focus: sp && sp.focus });
      if (!next) { delete W.store.spaces[key]; continue; }
      const ids = TermTree.leaves(next);
      const focus = sp && ids.includes(sp.focus) ? sp.focus : ids[0];
      W.store.spaces[key] = { root: next, focus, zoom: sp && ids.includes(sp.zoom) ? sp.zoom : null };
      migrateZoom(key);
    }
  }

  // After a reload, without stealing: the sessions handed back by the window
  // (`returning`) come back at once; a saved one comes back when the server
  // has no page on it (detached, or gone: a fresh shell under the same id).
  // One still attached is given 2s (this page's own old socket may not have
  // closed yet); still attached then, another page has it and it stays there.
  // The focus is settled once, at the end, by one rule (whether or not the 2s
  // wait ran): see settleFocus.
  async function restore(saved, returning) {
    const want = (Array.isArray(saved) ? saved : []).filter((m) => m && typeof m.id === 'string' && m.id);
    const back = (Array.isArray(returning) ? returning : []).filter((m) => m && typeof m.id === 'string' && m.id);
    for (const m of want) if (!W.saved.some((x) => x.id === m.id)) W.saved.push(m);
    W.expected = new Set(want.map((m) => m.id).filter((id) => !session(id)));
    const picks = W.picks;
    W.restoring = true;
    try {
      await refreshList();
      if (W.listState === 'denied') return W.sessions.map(meta);   // signed out: nothing can attach
      // Unreachable: no way to tell who holds what, so take them as before.
      const attached = (id) => W.listState === 'ok' && (W.list || []).some((x) => x.id === id && x.attached);
      for (const m of back) if (!session(m.id)) add({ ...m });
      const later = [];
      for (const m of want) {
        if (session(m.id)) continue;
        if (attached(m.id)) later.push(m); else add({ ...m });
      }
      if (later.length) {
        await new Promise((r) => setTimeout(r, RESTORE_WAIT_MS));
        await refreshList();
        for (const m of later) {
          if (!W.expected.has(m.id) || session(m.id)) continue;
          if (attached(m.id)) W.expected.delete(m.id); else add({ ...m });
        }
      }
    } finally {
      W.restoring = false;
    }
    // Whatever didn't come back leaves the saved set and the trees.
    W.expected.clear();
    dropGhosts();
    settleFocus(W.picks !== picks, back);
    reconcileAll();
    layout();
    save();
    notify();
    return W.sessions.map(meta);
  }

  // restore()'s focus, the same whatever the timing:
  //  1. the user chose a terminal during the restore (create, focus, a click,
  //     a bring…): that choice stands;
  //  2. else the saved focus, if it is held: it and its space come back;
  //  3. else (nothing saved, or the saved focus didn't come back) the last
  //     returning session that's held;
  //  4. else the saved active space, if it holds anything.
  function settleFocus(chose, back) {
    const p = W.pend;
    W.pend = null;
    if (chose) return;
    if (p && p.focus && session(p.focus)) { focusSession(p.focus, { keepKeyboard: true }); return; }
    const ret = back.map((m) => m.id).filter((id) => session(id)).pop();
    if (ret) { focusSession(ret, { keepKeyboard: true }); return; }
    if (p && p.active && heldIn(p.active).length) W.store.active = p.active;
  }

  // Sessions handed over by another page (the window's twAdopt, the dock's
  // returned ones): add the ones not here, focus the last.
  function adopt(metas) {
    const ms = (Array.isArray(metas) ? metas : []).filter((m) => m && typeof m.id === 'string' && m.id);
    for (const m of ms) if (!session(m.id)) add({ ...m });
    if (ms.length) { picked(); focusSession(ms[ms.length - 1].id); }
    return ms.length;
  }

  // Every held session of a space, in tree order, removed without ending
  // them (a hand-over): returns their metas.
  function popSpace(key) {
    const ids = heldIn(key);
    for (const s of W.sessions) if (s.key === key && !ids.includes(s.id)) ids.push(s.id);
    return ids.map((id) => remove(id, { kill: false })).filter(Boolean);
  }

  // Open a session here under its own id: the server hands it over, and
  // whoever had it gets code 4000.
  function bring(m) {
    if (!m || typeof m.id !== 'string' || !m.id) return null;
    picked();
    if (!session(m.id) && opts.beforeNew) opts.beforeNew();
    const s = add({ id: m.id, n: m.n, title: m.title, cwd: m.cwd, task: m.task, focus: true });
    focusSession(s.id);
    return s;
  }

  // A row was picked: held → focus it; held by another page → let the host
  // show it there if it can (goElsewhere); otherwise bring it here.
  function goTo(id) {
    if (session(id)) { picked(); focusSession(id); return; }
    if (opts.goElsewhere && opts.goElsewhere(id)) return;
    const r = rows().find((x) => x.id === id) || {};
    bring({ id, cwd: r.cwd || '', task: r.task || '', title: r.title || '' });
  }

  // Toasts: a background agent that needs you / finished, a terminal that
  // opened elsewhere, the cap. Phone state rides on the toast box's data-phone.
  toasts = TermToast.create({ onClick: (id) => goTo(id) });
  applyPhone();
  W.eventCbs.push((e) => {
    if (e.kind === 'agent') {
      if ((e.state !== 'blocked' && e.state !== 'done') || !document.hasFocus()) return;
      const s = session(e.id);
      const key = s ? s.key : (rows().find((r) => r.id === e.id) || {}).key;
      // On screen means actually visible: the workspace shown, the pane in the active
      // space, not hidden by zoom, and (phone: one pane at a time) the focused one.
      const shown = !opts.isActive || opts.isActive();
      if (s && shown && key === W.store.active && (isPhone() ? focusOf(key) === e.id : (!zoomOf(key) || zoomOf(key) === e.id))) return;
      const sp = key ? spaces().find((x) => x.key === key) : null;
      const n = s ? heldIn(key).indexOf(e.id) + 1 : 0;
      toasts.push({ id: e.id, kind: e.state, title: agentText(e.state), sub: sp ? (n ? `${sp.name} · pane ${n}` : sp.name) : '' });
      if (twGet(SOUND_KEY, false) === true) TermToast.tone(e.state);
    } else if (e.kind === 'moved') toasts.push({ id: e.id, kind: 'info', title: `${e.name} opened elsewhere`, sub: '' });
    else if (e.kind === 'cap') toasts.push({ id: null, kind: 'info', title: '12 terminals open', sub: 'Close one to open another' });
  });

  dropGhosts();
  layout();
  settleRestore();   // nothing saved to wait for: no restore to come back from
  if (chan) try { chan.postMessage({ who: true }); } catch { /* closing */ }
  refreshList();

  return {
    add, create, canOpen, remove, layout,
    focus: (id, o) => { picked(); focusSession(id, o); },
    markSeen: () => markSeen(focused()),
    focused,
    session,
    sessions: () => W.sessions,
    metas: () => W.sessions.map(meta),
    savedSessions: () => tabGet(K.sessions, []),
    savedFocus: () => (W.pend ? W.pend.focus : tabGet(K.focused, null)),
    label,
    activeSpace: () => W.store.active,
    openPicker,
    spaceKeys,
    showSpace,
    split,
    combineSpace,
    toggleZoom,
    focusDir,
    // The server list, merged
    list: () => W.list,
    refreshList,
    onList: (cb) => { W.listCbs.push(cb); return () => { W.listCbs = W.listCbs.filter((x) => x !== cb); }; },
    rows,
    spaces: () => spaces(),
    where,
    renameSpace,
    onEvent: (cb) => { W.eventCbs.push(cb); return () => { W.eventCbs = W.eventCbs.filter((x) => x !== cb); }; },
    // Across pages
    goTo,
    bring,
    adopt,
    popSpace,
    restore,
  };
}
