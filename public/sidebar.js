'use strict';

// ========================================================================
// Sidebar — the left sidebar (spec 2026-11-19 §5): expanded (232px) or the
// icon rail (64px), toggled by #sb-toggle or Ctrl+B / ⌘B, remembered per
// device. In the rail every button gets a tooltip naming it and its status.
// Counts and alerts come from the code that already knows them
// (setCount / setAlert); the sidebar works nothing out for itself.
// The decisions are SidebarCore's (sidebar-core.js).
// ========================================================================

(function () {
  const SC = window.SidebarCore;
  const S = { state: 'open', counts: {}, alerts: {}, inited: false };
  const el = (id) => document.getElementById(id);

  // Each sidebar button and the name its tooltip starts with.
  function buttons() {
    const list = [];
    const side = el('sidebar');
    if (!side) return list;
    for (const b of side.querySelectorAll('.mode')) list.push([b, (b.querySelector('.nv-lbl') || b).textContent.trim(), b.dataset.mode]);
    const named = [['ws-chip', null, 'workspace'], ['search-btn', 'Search', 'search'], ['capture-btn', 'New thought', 'capture'], ['termbtn', 'Terminals', 'terminals'], ['setbtn', 'Settings', 'settings']];
    for (const [id, name, key] of named) {
      const b = el(id);
      if (!b) continue;
      const label = key === 'workspace' ? (b.querySelector('.ws-chip-label') || b).textContent.trim() : name;
      list.push([b, label, key]);
    }
    return list;
  }

  // The status half of a rail tooltip ("2 due"), from what setCount / setAlert were told.
  function statusOf(key) {
    if (key === 'search') return el('search-kbd') ? el('search-kbd').textContent : '';
    if (key === 'capture') return el('capture-kbd') ? el('capture-kbd').textContent : '';
    const v = S.counts[key];
    return v && v.status ? v.status : '';
  }

  function paintTips() {
    const rail = S.state === 'rail';
    for (const [b, name, key] of buttons()) {
      if (rail && name) b.dataset.tip = SC.tipText(name, statusOf(key));
      else delete b.dataset.tip;
    }
    const t = el('sb-toggle');
    if (t) {
      t.setAttribute('aria-expanded', String(!rail));
      t.setAttribute('aria-label', rail ? 'Show sidebar' : 'Hide sidebar');
      t.dataset.tip = rail ? 'Show sidebar · Ctrl+B' : 'Hide sidebar · Ctrl+B';
    }
  }

  function apply(state) {
    S.state = state === 'rail' ? 'rail' : 'open';
    document.body.classList.toggle('sb-open', S.state === 'open');
    document.body.classList.toggle('sb-rail', S.state === 'rail');
    paintTips();
  }

  function toggle() {
    apply(S.state === 'open' ? 'rail' : 'open');
    try { localStorage.setItem(SC.STORE_KEY, S.state); } catch { /* private window: not remembered */ }
  }

  function init() {
    if (S.inited) { paintTips(); return; }
    S.inited = true;
    let storage = null;
    try { storage = window.localStorage; } catch { storage = null; }
    apply(SC.initialState(window.innerWidth, SC.readStored(storage)));
    const t = el('sb-toggle');
    if (t) t.addEventListener('click', toggle);
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'b') return;
      if (SC.isPhone(window.innerWidth) || !SC.shortcutAllowed(e.target)) return;
      e.preventDefault();
      toggle();
    });
    // The workspace's name changes after /api/workspaces answers: keep the rail's tooltip in step.
    const label = el('ws-chip') && el('ws-chip').querySelector('.ws-chip-label');
    if (label) new MutationObserver(paintTips).observe(label, { childList: true, characterData: true, subtree: true });
  }

  // Counts come from the code that already works them out; each repaints its slot and the rail tooltips.
  const SLOT = { calendar: 'mode-calendar', board: 'mode-board', terminals: 'termbtn' };
  function paintCount(name) {
    const b = el(SLOT[name]);
    const c = S.counts[name] || { value: 0 };
    const v = SC.countView(name, c.value, S.alerts[name] || '');
    S.counts[name] = { value: c.value, status: v.status };
    if (!b) return;
    const slot = b.querySelector('.nv-n');
    if (slot) {
      slot.textContent = v.text;
      slot.classList.toggle('nv-badge', v.badge);
      slot.classList.toggle('nv-alert', name === 'terminals' && v.dot);
    }
    b.classList.toggle('nv-dot-on', v.dot);
  }
  function setCount(name, value) {
    if (!SLOT[name]) return;
    S.counts[name] = { value, status: (S.counts[name] || {}).status || '' };
    paintCount(name);
    paintTips();
  }
  function setAlert(name, state) {
    if (!SLOT[name]) return;
    S.alerts[name] = state || '';
    paintCount(name);
    paintTips();
  }

  window.Sidebar = { init, toggle, state: () => S.state, setCount, setAlert };
})();
