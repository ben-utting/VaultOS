'use strict';

// ========================================================================
// SidebarCore — the sidebar's pure decisions (spec 2026-11-19 §5): which
// state it starts in, reading the saved choice, the phone breakpoint, when
// Ctrl+B may toggle it, and tooltip text (window.SidebarCore; also a Node
// module for the tests). No DOM writes, no storage writes, no clock.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.SidebarCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const STORE_KEY = 'vaultboard.sidebar';
  const OPEN_MIN = 1280;   // expanded by default from this window width
  const PHONE_MAX = 700;   // the phone layout (tab bar, no sidebar) at and below this width
  const STATES = ['open', 'rail'];

  // The saved choice, or null when there is none, it's not one of ours, or the storage refuses to be read.
  function readStored(storage) {
    try {
      const v = storage ? storage.getItem(STORE_KEY) : null;
      return STATES.includes(v) ? v : null;
    } catch {
      return null;
    }
  }

  function initialState(width, stored) {
    if (STATES.includes(stored)) return stored;
    return width >= OPEN_MIN ? 'open' : 'rail';
  }

  const isPhone = (width) => width <= PHONE_MAX;

  // Ctrl+B toggles the sidebar unless the person is typing or working in a terminal (where it's a shell key).
  const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  function shortcutAllowed(target) {
    if (!target) return true;
    if (TYPING.has(String(target.tagName || '').toUpperCase())) return false;
    if (target.isContentEditable) return false;
    if (typeof target.closest === 'function' && target.closest('.xterm, #term-area')) return false;
    return true;
  }

  const tipText = (name, status) => (status ? `${name} · ${status}` : String(name));

  // What a count slot shows (spec §3): text in the expanded row, a dot in the rail, the tooltip's status, and whether
  // it is the gold number badge (Calendar only). Only Calendar, Board and Terminals have counts.
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function countView(name, value, alert) {
    const n = Math.max(0, Number(value) || 0);
    const none = { text: '', dot: false, status: '', badge: false };
    if (name === 'calendar') return n ? { text: n > 99 ? '99+' : String(n), dot: true, status: `${n} due`, badge: true } : none;
    if (name === 'board') return n ? { text: String(n), dot: false, status: `${n} open`, badge: false } : none;
    if (name === 'terminals') {
      if (alert === 'blocked') return { text: 'needs you', dot: true, status: `${Math.max(n, 1)} needs you`, badge: false };
      return n ? { text: plural(n, 'agent'), dot: false, status: plural(n, 'agent'), badge: false } : none;
    }
    return none;
  }

  return { STORE_KEY, OPEN_MIN, PHONE_MAX, readStored, initialState, isPhone, shortcutAllowed, tipText, countView };
});
