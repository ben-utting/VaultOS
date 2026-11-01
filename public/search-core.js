'use strict';

// ========================================================================
// SearchCore — the search panel's pure logic (window.SearchCore). No DOM.
//   keyIntent(ev) -> 'open' | 'close-to-browser' | null
//   intentForQuery(q) -> 'recent' | 'search'
//   filterLabel(mode, q) -> string | null
//   visibleFileHits(items, workspaces, todayDir) -> items
//   groupResults(results, files, { type }) -> [{ key, label, items, total }]
//   highlight(text, q) -> HTML string
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.SearchCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const CAP = 5;
  const GROUPS = [['task', 'Tasks'], ['article', 'Articles'], ['note', 'Notes'], ['file', 'Files']];

  // Ctrl+F / Ctrl+K (Cmd on a Mac) open; a second Ctrl+F inside the open panel gives the key back to the browser.
  function keyIntent({ key, ctrlKey, metaKey, shiftKey, altKey, isMac, panelOpen, inPanel, inEditable, inTerminal } = {}) {
    if (shiftKey || altKey) return null;
    if (!(isMac ? metaKey : ctrlKey)) return null;
    const kk = String(key || '').toLowerCase();
    if (kk !== 'f' && kk !== 'k') return null;
    if (panelOpen) return kk === 'f' && inPanel ? 'close-to-browser' : null;
    if (inTerminal || inEditable) return null;
    return 'open';
  }

  function intentForQuery(q) {
    return /[\p{L}\p{N}]/u.test(String(q || '')) ? 'search' : 'recent';
  }

  function filterLabel(mode, q) {
    if (mode === 'board') return `Filter Board to '${q}'`;
    if (mode === 'kb') return `Filter Knowledge Base to '${q}'`;
    if (mode === 'files') return `Filter the Files tree to '${q}'`;
    return null;
  }

  function visibleFileHits(items, workspaces, todayDir) {
    const dirs = (workspaces || []).map((w) => w && w.dir).filter(Boolean);
    const today = String(todayDir || '').replace(/\/+$/, '');
    return (items || []).filter((it) => {
      if (!it || it.dir || typeof it.path !== 'string') return false;
      if (/\.md$/i.test(it.path)) return false;
      if (!dirs.includes(it.path.split('/')[0])) return false;
      if (today && (it.path === today || it.path.startsWith(today + '/'))) return false;
      return true;
    });
  }

  function groupResults(results, files, { type } = {}) {
    const all = type === 'all' || type === undefined;
    const out = [];
    for (const [key, label] of GROUPS) {
      if (!all && type !== key) continue;
      const list = key === 'file' ? (files || []) : (results || []).filter((r) => r && r.kind === key);
      if (!list.length) continue;
      out.push({ key, label, items: all ? list.slice(0, CAP) : list, total: list.length });
    }
    return out;
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function highlight(text, q) {
    const safe = esc(text == null ? '' : text);
    const words = [...new Set(String(q || '').split(/\s+/).filter((w) => w.length >= 2))]
      .map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    if (!words.length) return safe;
    return safe.replace(new RegExp(words.join('|'), 'gi'), (m) => `<mark>${m}</mark>`);
  }

  return { keyIntent, intentForQuery, filterLabel, visibleFileHits, groupResults, highlight };
});
