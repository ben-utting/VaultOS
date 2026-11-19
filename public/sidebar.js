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
    const a = S.alerts[name] || { state: '', n: 0 };
    const v = SC.countView(name, c.value, a.state, a.n);
    S.counts[name] = { value: c.value, status: v.status };
    if (!b) return;
    const slot = b.querySelector('.nv-n');
    if (slot) {
      slot.textContent = v.text;
      slot.classList.toggle('nv-badge', v.badge);
      slot.classList.toggle('nv-alert', name === 'terminals' && a.state === 'blocked');
    }
    b.classList.toggle('nv-dot-on', v.dot);
  }
  function setCount(name, value) {
    if (!SLOT[name]) return;
    S.counts[name] = { value, status: (S.counts[name] || {}).status || '' };
    paintCount(name);
    paintTips();
  }
  function setAlert(name, state, count) {
    if (!SLOT[name]) return;
    S.alerts[name] = { state: state || '', n: count || 0 };
    paintCount(name);
    paintTips();
  }

  // ---------- Phone: the More sheet (spec §6) ----------
  // Rows click their twins in the (hidden) sidebar, so every handler and feature switch is the sidebar's own.
  const sheetOpen = () => el('more-sheet') && !el('more-sheet').classList.contains('hidden');
  function openMore() {
    const sheet = el('more-sheet');
    if (!sheet) return;
    const chip = el('ws-chip');
    const wsRow = sheet.querySelector('[data-for="ws-chip"]');
    if (wsRow && chip) {
      wsRow.classList.toggle('hidden', chip.classList.contains('hidden'));
      wsRow.querySelector('.more-ws-name').textContent = (chip.querySelector('.ws-chip-label') || chip).textContent;
      wsRow.querySelector('.nv-ws-init').textContent = (chip.querySelector('.nv-ws-init') || {}).textContent || '';
    }
    sheet.classList.remove('hidden');
    el('more-scrim').classList.remove('hidden');
    el('mnav-more').setAttribute('aria-expanded', 'true');
    const first = [...sheet.querySelectorAll('button')].find((b) => !b.classList.contains('hidden'));
    if (first) first.focus();
  }
  function closeMore({ focus = true } = {}) {
    if (!sheetOpen()) return;
    el('more-sheet').classList.add('hidden');
    el('more-scrim').classList.add('hidden');
    el('mnav-more').setAttribute('aria-expanded', 'false');
    if (focus) el('mnav-more').focus();
  }
  function wireMore() {
    const more = el('mnav-more');
    const sheet = el('more-sheet');
    if (!more || !sheet) return;
    more.addEventListener('click', () => (sheetOpen() ? closeMore() : openMore()));
    el('more-scrim').addEventListener('click', () => closeMore());
    sheet.addEventListener('click', (e) => {
      const row = e.target.closest('[data-for]');
      if (!row) return;
      closeMore({ focus: false });
      const twin = el(row.dataset.for);
      if (!twin) return;
      // A mode row goes the tab bar's way (app.js goTwin): the full-screen terminal and a task sheet step aside first.
      if (/^mode-/.test(row.dataset.for) && typeof window.goTwin === 'function') window.goTwin(row.dataset.for);
      else twin.click();
      // The workspace menu opens under its chip, which is hidden on a phone: show it above the tab bar instead.
      const menu = el('ws-menu');
      if (row.dataset.for === 'ws-chip' && menu && !menu.classList.contains('hidden')) {
        Object.assign(menu.style, { left: '8px', right: '8px', top: 'auto', bottom: 'calc(var(--mnav-h, 58px) + 8px)' });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheetOpen()) { e.stopPropagation(); closeMore(); }
    }, true);
    const search = el('search-btn-m');
    if (search) search.addEventListener('click', () => { if (window.SearchPanel) SearchPanel.open({ via: 'button' }); });
  }

  const initOnce = init;
  function initAll() { const first = !S.inited; initOnce(); if (first) wireMore(); }

  window.Sidebar = { init: initAll, toggle, state: () => S.state, setCount, setAlert, openMore, closeMore };
})();
