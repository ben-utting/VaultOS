'use strict';

// ========================================================================
// LearnCore — Learn mode's pure logic (window.LearnCore). No DOM.
//   treeOrder(folder, items) -> items            Sources A–Z, Notes/Studio newest first (names start with a date)
//   pickFrom(activeTab, notebook) -> path|null   the file Studio reads: open text tab, newest log, newest source
//   tabsFor(store, nb) -> { tabs, active }       per-notebook tabs; 'terminal' is the fixed first tab
//   withTab / withoutTab / withActive(store, nb, path) -> store   (pure)
//   reconcile(store, nb, existing:Set) -> { store, closed }       drop tabs whose file is gone
//   startButtons(agents, termOn) -> [{ id, label, command }]
//   youtubeKind(text) -> 'video' | 'playlist' | 'both' | null      (mirrors lib/learn-youtube.js parseYoutubeUrl)
//   madeBy(model, cost) -> 'Made by <model> · $0.04'
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.LearnCore = f();
}(typeof self !== 'undefined' ? self : this, () => {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const dirsFirst = (a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0);

  function treeOrder(folder, items) {
    const newest = folder === 'Notes' || folder === 'Studio';
    return items.slice().sort((a, b) => dirsFirst(a, b) || (newest && !a.dir && !b.dir ? coll.compare(b.name, a.name) : coll.compare(a.name, b.name)));
  }

  const isText = (p) => /\.(md|txt)$/i.test(p || '');
  const within = (p, nb) => typeof p === 'string' && p.startsWith(`${nb}/`);

  function pickFrom(activeTab, notebook) {
    if (!notebook) return null;
    if (within(activeTab, notebook.path) && isText(activeTab)) return activeTab;
    const latest = notebook.latest || {};
    return latest.notes || latest.sources || null;
  }

  const EMPTY = () => ({ tabs: [], active: 'terminal' });
  function tabsFor(store, nb) {
    const t = store && store[nb];
    if (!t || !Array.isArray(t.tabs)) return EMPTY();
    const tabs = t.tabs.filter((p) => typeof p === 'string');
    const active = typeof t.active === 'string' && (t.active === 'terminal' || tabs.includes(t.active)) ? t.active : 'terminal';
    return { tabs, active };
  }
  const put = (store, nb, t) => ({ ...(store || {}), [nb]: t });
  function withTab(store, nb, p) {
    const t = tabsFor(store, nb);
    return put(store, nb, { tabs: t.tabs.includes(p) ? t.tabs : [...t.tabs, p], active: p });
  }
  function withoutTab(store, nb, p) {
    const t = tabsFor(store, nb);
    return put(store, nb, { tabs: t.tabs.filter((x) => x !== p), active: t.active === p ? 'terminal' : t.active });
  }
  function withActive(store, nb, p) {
    const t = tabsFor(store, nb);
    return put(store, nb, { tabs: t.tabs, active: p === 'terminal' || t.tabs.includes(p) ? p : t.active });
  }
  function reconcile(store, nb, existing) {
    const t = tabsFor(store, nb);
    const closed = t.tabs.filter((p) => !existing.has(p));
    if (!closed.length) return { store, closed };
    return { store: put(store, nb, { tabs: t.tabs.filter((p) => existing.has(p)), active: closed.includes(t.active) ? 'terminal' : t.active }), closed };
  }

  function startButtons(agents, termOn) {
    if (!termOn) return [];
    const list = Array.isArray(agents) ? agents.slice(0, 2) : [];
    if (!list.length) return [{ id: 'plain', label: 'Open a terminal', command: null }];
    return list.map((a) => ({ id: a.id, label: `Start ${a.short || a.label}`, command: a.command }));
  }

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
  const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
  function youtubeKind(text) {
    if (typeof text !== 'string') return null;
    let raw = text.trim();
    if (/^(www\.|m\.)?youtube\.com\/|^youtu\.be\//i.test(raw)) raw = `https://${raw}`;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    let video = null;
    if (host === 'youtu.be') video = segs[0] || null;
    else if (HOSTS.includes(host)) {
      if (segs[0] === 'watch') video = u.searchParams.get('v');
      else if ((segs[0] === 'shorts' || segs[0] === 'live') && segs.length === 2) video = segs[1];
      else if (segs[0] !== 'playlist') return null;
    } else return null;
    const list = u.searchParams.get('list');
    const hasList = !!list && !/^RD/.test(list) && LIST_ID.test(list);
    const hasVideo = !!video && VIDEO_ID.test(video);
    if (hasVideo && hasList) return 'both';
    if (hasVideo) return 'video';
    return hasList ? 'playlist' : null;
  }

  function madeBy(model, cost) {
    const who = `Made by ${model || 'OpenRouter'}`;
    return typeof cost === 'number' ? `${who} · $${cost.toFixed(2)}` : who;
  }

  return { treeOrder, pickFrom, tabsFor, withTab, withoutTab, withActive, reconcile, startButtons, youtubeKind, madeBy };
}));
