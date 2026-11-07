'use strict';

// ========================================================================
// NotesCore — Notes mode's and the capture box's pure logic (window.NotesCore). No DOM.
//   wikiSegments(text, names) -> [{ text } | { label, target, anchor, path }]
//   ageLabel(mtime, now) -> 'now' | '5m' | '2h' | '3d' | '5w'
//   captureKeyIntent(ev) -> 'open' | null   (Ctrl+J, ⌘J on a Mac)
//   filterMain(items, { status, tag }) -> items
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.NotesCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  // [[Target]], [[Target#anchor]], [[Target|label]], [[Target#anchor|label]]. names: lower-cased name -> path.
  function wikiSegments(text, names) {
    const out = [];
    const re = /\[\[([^\[\]|#]+)(?:#([^\[\]|]*))?(?:\|([^\[\]]*))?\]\]/g;
    let last = 0;
    let m;
    const s = String(text || '');
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      const target = m[1].trim();
      const anchor = m[2] !== undefined && m[2].trim() ? m[2].trim() : null;
      const label = m[3] !== undefined && m[3].trim() ? m[3].trim() : target;
      out.push({ label, target, anchor, path: (names && names.get(target.toLowerCase())) || null });
      last = re.lastIndex;
    }
    if (last < s.length || !out.length) out.push({ text: s.slice(last) });
    return out;
  }

  function ageLabel(mtime, now) {
    const s = Math.max(0, (now - mtime) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 14 * 86400) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / (7 * 86400))}w`;
  }

  function captureKeyIntent({ key, ctrlKey, metaKey, shiftKey, altKey, isMac, boxOpen, inEditable, inTerminal } = {}) {
    if (shiftKey || altKey || boxOpen || inEditable || inTerminal) return null;
    if (!(isMac ? metaKey : ctrlKey)) return null;
    return String(key || '').toLowerCase() === 'j' ? 'open' : null;
  }

  function filterMain(items, { status = null, tag = null } = {}) {
    return items.filter((i) => (!status || i.status === status) && (!tag || (i.tags || []).includes(tag)));
  }

  return { wikiSegments, ageLabel, captureKeyIntent, filterMain };
});
