'use strict';

// ========================================================================
// The Due bell (window.CalendarDue): in every mode while Calendar is on. It
// polls /api/calendar/due every 30 s and at once when the tab comes back,
// shows the count on the bell and in the tab title, toasts what came due
// while the page is open (with one chime), and holds the Due panel: Done,
// Snooze and Dismiss, and the card each reminder links to.
// Every open tab toasts what came due since it last looked; the device chimes
// once. The chime's "already heard" list (key + when it became due, last 200)
// is kept in localStorage and shared over a BroadcastChannel, and checked and
// written under a Web Lock where the browser has one, so two tabs don't both
// chime. A reminder back from a snooze is due again, so it toasts and chimes again.
// Uses app.js's globals: $, toast, setMode, setWorkspace, openTask, STATE, calendarOn.
// ========================================================================

(function () {
  const CV = window.CalendarView;
  const POLL_MS = 30000;
  const SEEN_KEY = 'vaultboard.calendar.seen';
  const CHIME_KEY = 'vaultboard.calendar.chime';
  const SEEN_MAX = 200;
  const MAX_TOASTS = 3;
  const RECENT_MS = 60000;   // on a tab's first poll, items due longer ago than this are announced quietly, not toasted
  const COUNT = /^(\d{2,3}:\d{2} · )?(\(\d+\) )?/;   // Today's countdown, then our count, at the start of the title

  const D = {
    timer: null, retry: null, items: [], tz: 'UTC', error: '', first: true, last: 0,
    toasts: [],   // due items toasted on this page and not yet acted on, oldest first
    count: 0, panelSig: null, toastSig: null,
  };
  const tabSeen = new Set();   // tokens this tab has toasted or announced
  const phone = () => window.matchMedia('(max-width: 700px)').matches;
  const signedIn = () => !$('app').classList.contains('hidden');

  // ---------- The device's chime list (tokens = key|dueSince, CalendarView.seenToken) ----------
  function storedSeen() {
    try { const a = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  const seen = new Set(storedSeen());
  function markSeen(keys) {
    if (!keys.length) return;
    for (const k of storedSeen()) seen.add(k);   // what the other tabs heard since
    for (const k of keys) { seen.delete(k); seen.add(k); }
    const all = [...seen].slice(-SEEN_MAX);
    seen.clear();
    for (const k of all) seen.add(k);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch { /* private window: this tab only */ }
    if (bc) bc.postMessage({ seen: keys });
  }
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('vaultos-calendar') : null;
  if (bc) bc.onmessage = (e) => {
    const m = e.data || {};
    if (Array.isArray(m.seen)) for (const k of m.seen) seen.add(k);
    if (m.acked) { dropToast(m.acked); poll(); }
  };

  const chimeOn = () => { try { return localStorage.getItem(CHIME_KEY) !== 'off'; } catch { return true; } };

  // ---------- Polling ----------
  async function poll() {
    if (!calendarOn()) return;
    // Signed in but the app not shown yet (start() is still loading): try again in a moment, not in 30 s.
    if (!signedIn()) { clearTimeout(D.retry); D.retry = setTimeout(poll, 1000); return; }
    D.last = Date.now();
    let data;
    try {
      const res = await fetch('/api/calendar/due');
      if (res.status === 401 || res.status === 404) return;
      data = await res.json();
    } catch { return; }   // offline for a moment: the next poll tries again
    D.items = data.items || [];
    D.tz = data.timezone || D.tz;
    D.error = data.error || '';
    const keys = new Set(D.items.map((i) => i.key));
    D.toasts = D.toasts.filter((t) => keys.has(t.key));   // acted on elsewhere
    for (const t of D.toasts) Object.assign(t, D.items.find((i) => i.key === t.key));
    let fresh = CV.freshItems(D.items, tabSeen);
    if (D.first) {
      // A page just opened: what came due a while ago gets one quiet line (once per device), not a toast each.
      D.first = false;
      const cut = Date.now() - RECENT_MS;
      const old = fresh.filter((i) => Date.parse(i.dueSince || i.pingAt) <= cut);
      fresh = fresh.filter((i) => !old.includes(i));
      for (const i of old) tabSeen.add(CV.seenToken(i));
      const unheard = await claim(old);
      if (unheard.length) {
        toast(`${unheard.length} reminder${unheard.length === 1 ? '' : 's'} came due while VaultOS was closed`,
          { action: 'Open', onAction: openPanel, tone: 'info', ms: 10000 });
      }
    }
    if (fresh.length) {
      for (const i of fresh) tabSeen.add(CV.seenToken(i));
      D.toasts = D.toasts.filter((t) => !fresh.some((f) => f.key === t.key));
      D.toasts.push(...fresh.slice().reverse());   // the due list is newest first; toasts stack in arrival order
      const unheard = await claim(fresh);
      if (unheard.length && chimeOn() && typeof TermToast !== 'undefined') TermToast.tone('reminder');   // a top-level const, not on window
    }
    paint();
  }
  // The items this device hasn't chimed or announced yet, marked as heard: checked and written in one step
  // (under a Web Lock when the browser has them) so two tabs polling at once don't both chime.
  async function claim(items) {
    if (!items.length) return [];
    const take = () => {
      const unheard = CV.freshItems(CV.freshItems(items, seen), storedSeen());
      markSeen(unheard.map(CV.seenToken));
      return unheard;
    };
    try { if (navigator.locks) return await navigator.locks.request('vaultos-calendar-seen', take); } catch { /* no lock: best effort */ }
    return take();
  }
  function schedule() {
    clearTimeout(D.timer);
    D.timer = null;
    if (!calendarOn()) return;
    D.timer = setTimeout(async () => { await poll(); schedule(); }, POLL_MS);
  }
  const soon = () => { if (calendarOn() && Date.now() - D.last > 2000) poll(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
  window.addEventListener('focus', soon);

  // ---------- Painting ----------
  function paint() {
    D.count = D.items.length;
    const n = $('cal-bell-n');
    n.textContent = D.count > 99 ? '99+' : String(D.count);
    n.classList.toggle('hidden', !D.count);
    $('cal-bell').setAttribute('aria-label', D.count ? `Due reminders: ${D.count}` : 'Due reminders: none');
    applyTitle();
    paintToasts();
    if (panelOpen()) paintPanel();
  }
  // "(2) VaultOS", or after Today's countdown: "24:59 · (2) VaultOS" (Today strips only a leading countdown).
  function applyTitle() {
    const t = document.title;
    const m = COUNT.exec(t);
    const rest = t.slice(m[0].length);
    const want = `${m[1] || ''}${D.count && calendarOn() ? `(${D.count}) ` : ''}${rest}`;
    if (want !== t) document.title = want;
  }
  new MutationObserver(() => applyTitle()).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });

  // The Agent button's agent for an item, or null for no button (window.CalendarAgent, calendar-agent.js).
  const agentFor = (i) => (window.CalendarAgent ? CalendarAgent.forItem(i.agent || null, i.agentLabel || null) : null);
  function paintToasts() {
    const box = $('cal-toasts');
    const shown = D.toasts.slice(-MAX_TOASTS);
    const extra = D.toasts.length - shown.length;
    const now = Date.now();
    const sig = JSON.stringify([shown.map((t) => [CV.seenToken(t), CV.toastWhen(t, D.tz, now), t.title]), extra]);
    if (sig === D.toastSig) return;   // unchanged: keep the buttons (and any focus on them)
    D.toastSig = sig;
    box.innerHTML = shown.map((t) => CV.toastHtml(t, D.tz, now, agentFor(t))).join('')
      + (extra ? `<div class="cal-toast cal-toast-more"><span>+${extra} more</span><button type="button" class="su-btn su-sm" data-act="open">Open Due</button></div>` : '');
  }
  function dropToast(key) {
    const before = D.toasts.length;
    D.toasts = D.toasts.filter((t) => t.key !== key);
    if (D.toasts.length !== before) paintToasts();
  }

  // ---------- Acting on an item ----------
  async function ack(key, action, forChoice) {
    try {
      const res = await fetch(`/api/calendar/due/${encodeURIComponent(key)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forChoice ? { for: forChoice } : {}),
      });
      if (res.status === 401) { if (typeof showLogin === 'function') showLogin(); return; }
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || 'That reminder could not be changed'); }
    } catch { toast("VaultOS isn't answering"); return; }
    const wasFocused = $('cal-due').contains(document.activeElement);
    D.items = D.items.filter((i) => i.key !== key);
    dropToast(key);
    if (bc) bc.postMessage({ acked: key });
    paint();
    // The acted-on item's buttons are gone: keep the keyboard in the panel, on the next Done (or Close).
    if (wasFocused && panelOpen()) ($('cal-due').querySelector('[data-act="done"]') || $('cal-due-close')).focus({ preventScroll: true });
    await poll();
    if (window.Today && Today.refreshComing) Today.refreshComing();
  }

  // ---------- The Due panel ----------
  const panelOpen = () => !$('cal-due').classList.contains('hidden');
  // The list repaints only when what it shows changes, so focus and an open Snooze menu survive a poll.
  function paintPanel({ force = false } = {}) {
    const now = Date.now();
    $('cal-due-err').textContent = D.error;
    $('cal-due-err').classList.toggle('hidden', !D.error);
    const sig = CV.dueSignature(D.items);
    if (force || sig !== D.panelSig) {
      D.panelSig = sig;
      $('cal-due-list').innerHTML = D.items.map((i) => CV.dueItemHtml(i, D.tz, now, agentFor(i))).join('');
    }
    $('cal-due-empty').classList.toggle('hidden', D.items.length > 0 || !!D.error);
    const on = chimeOn();
    $('cal-chime').setAttribute('aria-pressed', String(on));
    $('cal-chime').title = on ? 'Chime on for this device' : 'Chime off for this device';
    $('cal-chime').setAttribute('aria-label', $('cal-chime').title);
    $('cal-chime-on').classList.toggle('hidden', !on);
    $('cal-chime-off').classList.toggle('hidden', on);
  }
  function place() {
    const p = $('cal-due');
    if (phone()) { p.style.top = ''; p.style.right = ''; return; }
    const r = $('cal-bell').getBoundingClientRect();
    p.style.top = `${Math.round(r.bottom + 6)}px`;
    p.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }
  function openPanel() {
    paintPanel({ force: true });
    $('cal-due').classList.remove('hidden');
    $('cal-due-scrim').classList.toggle('hidden', !phone());
    $('cal-bell').setAttribute('aria-expanded', 'true');
    place();
    const first = $('cal-due').querySelector('[data-act="done"]') || $('cal-due-close');
    first.focus({ preventScroll: true });
    poll();
  }
  function closePanel({ focus = true } = {}) {
    if (!panelOpen()) return;
    $('cal-due').classList.add('hidden');
    $('cal-due-scrim').classList.add('hidden');
    $('cal-bell').setAttribute('aria-expanded', 'false');
    if (focus) $('cal-bell').focus({ preventScroll: true });
  }
  function closeMenus(except) {
    for (const m of $('cal-due').querySelectorAll('.cal-snooze-menu')) if (m !== except) m.remove();
    for (const b of $('cal-due').querySelectorAll('[data-act="snooze"][aria-expanded="true"]')) if (!except || b.nextElementSibling !== except) b.setAttribute('aria-expanded', 'false');
  }
  function snoozeMenu(btn) {
    const open = btn.nextElementSibling && btn.nextElementSibling.classList.contains('cal-snooze-menu');
    closeMenus();
    if (open) return;
    const m = document.createElement('div');
    m.className = 'cal-snooze-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = [['10m', '10 min'], ['1h', '1 hour'], ['tomorrow', 'Tomorrow 9:00']]
      .map(([v, l]) => `<button type="button" role="menuitem" data-for="${v}">${l}</button>`).join('');
    btn.after(m);
    btn.setAttribute('aria-expanded', 'true');
    m.querySelector('button').focus();
  }
  function openCard(path, board) {
    closePanel({ focus: false });
    if (board && typeof STATE !== 'undefined' && board !== STATE.workspace) setWorkspace(board);
    setMode('board');
    openTask(path);
  }

  // ---------- Events ----------
  $('cal-bell').addEventListener('click', () => (panelOpen() ? closePanel() : openPanel()));
  $('cal-due-close').addEventListener('click', () => closePanel());
  $('cal-due-scrim').addEventListener('click', () => closePanel());
  $('cal-due-cal').addEventListener('click', () => { closePanel({ focus: false }); setMode('calendar'); });
  $('cal-chime').addEventListener('click', () => {
    try { localStorage.setItem(CHIME_KEY, chimeOn() ? 'off' : 'on'); } catch { /* not remembered */ }
    paintPanel();
  });
  $('cal-due-list').addEventListener('click', (e) => {
    const item = e.target.closest('.cal-due-item');
    if (!item) return;
    const key = item.dataset.key;
    const pick = e.target.closest('[data-for]');
    if (pick) { closeMenus(); ack(key, 'snooze', pick.dataset.for); return; }
    const card = e.target.closest('[data-card]');
    if (card) { openCard(card.dataset.card, card.dataset.board); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'agent') { closePanel({ focus: false }); CalendarAgent.launch(b.dataset.entry, b.dataset.date); return; }
    if (b.dataset.act === 'snooze') snoozeMenu(b);
    else ack(key, b.dataset.act === 'done' ? 'done' : 'dismiss');
  });
  $('cal-toasts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'open') { openPanel(); return; }
    const t = b.closest('.cal-toast');
    const key = t && t.dataset.key;
    if (!key) return;
    if (b.dataset.act === 'close') dropToast(key);   // it stays in the Due list
    else if (b.dataset.act === 'agent') { dropToast(key); CalendarAgent.launch(b.dataset.entry, b.dataset.date); }   // stays in the Due list too
    else if (b.dataset.act === 'done') ack(key, 'done');
    else if (b.dataset.act === 'snooze10') ack(key, 'snooze', '10m');
  });
  document.addEventListener('click', (e) => {
    if (!panelOpen() || phone()) return;
    if (e.target.closest('#cal-due, #cal-bell')) return;
    closePanel({ focus: false });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panelOpen()) return;
    e.stopPropagation();
    if ($('cal-due').querySelector('.cal-snooze-menu')) { const b = $('cal-due').querySelector('[data-act="snooze"][aria-expanded="true"]'); closeMenus(); if (b) b.focus(); return; }
    closePanel();
  }, true);
  window.addEventListener('resize', () => { if (panelOpen()) place(); });

  window.CalendarDue = {
    init() {},
    // Settings changed what is on (applyMe): start or stop.
    featureChanged() {
      const on = calendarOn();
      $('cal-bell').classList.toggle('hidden', !on);
      if (on) {
        // A changed default agent (or terminals switched on or off) changes the Agent buttons: repaint them.
        D.toastSig = '';
        paintPanel({ force: true });
        paintToasts();
        if (!D.timer) { poll(); schedule(); }
        return;
      }
      clearTimeout(D.timer);
      clearTimeout(D.retry);
      D.timer = null;
      D.items = [];
      D.toasts = [];
      D.first = true;
      closePanel({ focus: false });
      paint();
    },
    refresh: () => poll(),
  };
})();
