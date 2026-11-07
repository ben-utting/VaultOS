'use strict';

// ========================================================================
// TermTree — the terminal workspace's pure logic (window.TermTree): the split
// tree, the space/row model, toast dedupe and the terminal cap. No DOM, and no
// function mutates its inputs (only `observe` writes to the memo you hand it).
//   Node = {id} | {dir:'row'|'col', r, a, b}   row = side by side, col = stacked
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.TermTree = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const R_MIN = 0.12;
  const R_MAX = 0.88;
  const EPS = 1e-6;
  const STATUS_WORD = {
    backlog: 'backlog', 'in-progress': 'in progress', blocked: 'blocked',
    'needs-decision': 'needs decision', review: 'review', scheduled: 'scheduled', done: 'done',
  };

  const isLeaf = (n) => !!n && typeof n.id === 'string';
  const clampR = (r) => Math.min(R_MAX, Math.max(R_MIN, r));
  const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop();

  // ---- split tree ---------------------------------------------------------

  function leaves(node) {
    if (!node) return [];
    return isLeaf(node) ? [node.id] : leaves(node.a).concat(leaves(node.b));
  }

  function mapLeaf(node, id, fn) {
    if (isLeaf(node)) return node.id === id ? fn(node) : node;
    return { dir: node.dir, r: node.r, a: mapLeaf(node.a, id, fn), b: mapLeaf(node.b, id, fn) };
  }

  function insert(rootNode, newId, opts) {
    if (!rootNode) return { id: newId };
    const o = opts || {};
    const all = leaves(rootNode);
    const target = all.includes(o.target) ? o.target : all[all.length - 1];
    const dir = o.dir === 'col' ? 'col' : 'row';
    return mapLeaf(rootNode, target, (leaf) => ({ dir, r: 0.5, a: { id: leaf.id }, b: { id: newId } }));
  }

  function layout(rootNode) {
    const rects = {};
    const splits = [];
    (function walk(n, x, y, w, h, path) {
      if (isLeaf(n)) { rects[n.id] = [x, y, w, h]; return; }
      splits.push({ path, dir: n.dir, x, y, w, h, r: n.r });
      if (n.dir === 'row') {
        const aw = w * n.r;
        walk(n.a, x, y, aw, h, path + 'a');
        walk(n.b, x + aw, y, w - aw, h, path + 'b');
      } else {
        const ah = h * n.r;
        walk(n.a, x, y, w, ah, path + 'a');
        walk(n.b, x, y + ah, w, h - ah, path + 'b');
      }
    })(rootNode, 0, 0, 1, 1, '');
    return { rects, splits };
  }

  function insertLargest(rootNode, newId, opts) {
    if (!rootNode) return { id: newId };
    const o = opts || {};
    const W = o.w || 1;
    const H = o.h || 1;
    const { rects } = layout(rootNode);
    let best = null;
    let bestArea = -1;
    for (const id of leaves(rootNode)) {
      const area = rects[id][2] * W * rects[id][3] * H;
      if (area > bestArea + EPS || (Math.abs(area - bestArea) <= EPS && id === o.focus)) { best = id; bestArea = area; }
    }
    const r = rects[best];
    return insert(rootNode, newId, { target: best, dir: r[2] * W >= r[3] * H ? 'row' : 'col' });
  }

  function remove(node, id) {
    if (!node) return null;
    if (isLeaf(node)) return node.id === id ? null : node;
    const a = remove(node.a, id);
    const b = remove(node.b, id);
    if (!a) return b;
    if (!b) return a;
    return a === node.a && b === node.b ? node : { dir: node.dir, r: node.r, a, b };
  }

  function setRatio(node, path, r) {
    if (isLeaf(node)) return node;
    if (!path) return { dir: node.dir, r: clampR(r), a: node.a, b: node.b };
    const rest = path.slice(1);
    return path[0] === 'a'
      ? { dir: node.dir, r: node.r, a: setRatio(node.a, rest, r), b: node.b }
      : { dir: node.dir, r: node.r, a: node.a, b: setRatio(node.b, rest, r) };
  }

  function neighbour(rects, id, dir) {
    const me = rects[id];
    if (!me) return null;
    const [x, y, w, h] = me;
    let best = null;
    let bestOverlap = 0;
    for (const k of Object.keys(rects)) {
      if (k === id) continue;
      const [cx, cy, cw, ch] = rects[k];
      let touches;
      let overlap;
      if (dir === 'right' || dir === 'left') {
        touches = Math.abs(dir === 'right' ? cx - (x + w) : (cx + cw) - x) < EPS;
        overlap = Math.min(y + h, cy + ch) - Math.max(y, cy);
      } else {
        touches = Math.abs(dir === 'down' ? cy - (y + h) : (cy + ch) - y) < EPS;
        overlap = Math.min(x + w, cx + cw) - Math.max(x, cx);
      }
      if (touches && overlap > EPS && overlap > bestOverlap + EPS) { best = k; bestOverlap = overlap; }
    }
    return best;
  }

  function reconcile(rootNode, heldIds, opts) {
    const held = [...new Set(heldIds || [])];
    if (!held.length) return null;
    let t = rootNode || null;
    for (const id of leaves(t)) if (!held.includes(id)) t = remove(t, id);
    const have = new Set(leaves(t));
    for (const id of held) {
      if (have.has(id)) continue;
      t = insertLargest(t, id, opts || {});
      have.add(id);
    }
    return t;
  }

  function tooSmall(rects, wPx, hPx, minW = 140, minH = 70) {
    return Object.values(rects).some((r) => r[2] * wPx < minW || r[3] * hPx < minH);
  }

  // ---- persisted store ----------------------------------------------------

  const emptyStore = () => ({ v: 1, active: null, spaces: {} });

  // Returns a cleaned copy of a stored node, or null when it is malformed.
  function cleanNode(n, seen, depth) {
    if (!n || typeof n !== 'object' || depth > 32) return null;
    if (typeof n.id === 'string') {
      if (!n.id || seen.has(n.id)) return null;
      seen.add(n.id);
      return { id: n.id };
    }
    if ((n.dir !== 'row' && n.dir !== 'col') || typeof n.r !== 'number' || !Number.isFinite(n.r)) return null;
    const a = cleanNode(n.a, seen, depth + 1);
    const b = a && cleanNode(n.b, seen, depth + 1);
    return a && b ? { dir: n.dir, r: clampR(n.r), a, b } : null;
  }

  function parseStore(raw) {
    let o;
    try { o = JSON.parse(raw); } catch { return emptyStore(); }
    if (!o || o.v !== 1 || !o.spaces || typeof o.spaces !== 'object') return emptyStore();
    const out = emptyStore();
    for (const key of Object.keys(o.spaces)) {
      const sp = o.spaces[key];
      const rootNode = sp && cleanNode(sp.root, new Set(), 0);
      if (!rootNode) continue;
      const ids = leaves(rootNode);
      out.spaces[key] = {
        root: rootNode,
        focus: ids.includes(sp.focus) ? sp.focus : ids[0],
        zoom: ids.includes(sp.zoom) ? sp.zoom : null,
      };
    }
    out.active = typeof o.active === 'string' && out.spaces[o.active] ? o.active : null;
    return out;
  }

  function rekey(store, id, fromKey, toKey, opts) {
    const from = store.spaces[fromKey];
    if (!from || fromKey === toKey || !leaves(from.root).includes(id)) return { store, renamed: false };
    const o = opts || {};
    if (leaves(from.root).length === 1 && !store.spaces[toKey]) {
      const spaces = {};
      for (const k of Object.keys(store.spaces)) spaces[k === fromKey ? toKey : k] = store.spaces[k];
      return { store: { v: store.v, active: store.active === fromKey ? toKey : store.active, spaces }, renamed: true };
    }
    const left = remove(from.root, id);
    const spaces = {};
    for (const k of Object.keys(store.spaces)) {
      if (k === fromKey) {
        if (!left) continue;
        const ids = leaves(left);
        spaces[k] = { root: left, focus: ids.includes(from.focus) ? from.focus : ids[0], zoom: ids.includes(from.zoom) ? from.zoom : null };
      } else spaces[k] = store.spaces[k];
    }
    const dest = store.spaces[toKey];
    const droot = insertLargest(dest ? dest.root : null, id, o);
    spaces[toKey] = { root: droot, focus: dest && dest.focus ? dest.focus : id, zoom: dest ? dest.zoom : null };
    let active = store.active;
    if (active === fromKey && !left) active = toKey;
    return { store: { v: store.v, active, spaces }, renamed: false };
  }

  // ---- space / row model --------------------------------------------------

  function spaceKey(s, knownTasks) {
    if (s.task) return 't:' + s.task;
    const cwd = s.cwd || '';
    if (cwd && knownTasks && knownTasks.has(cwd + '/task.md')) return 't:' + cwd + '/task.md';
    return 'd:' + cwd;
  }

  function rows(list, held, presence) {
    const out = [];
    const known = new Set();
    for (const x of list || []) if (x.task) known.add(x.task);
    if (held) for (const h of held.values()) if (h.meta && h.meta.task) known.add(h.meta.task);
    const mkRow = (x, h) => {
      const meta = (h && h.meta) || {};
      const pick = (k) => (x && x[k] != null && x[k] !== '' ? x[k] : meta[k] != null ? meta[k] : (h && h[k] != null ? h[k] : ''));
      const task = pick('task');
      const cwd = pick('cwd');
      const agent = (h && h.agent) || (x && x.agent) || null;
      const id = (x || meta).id;
      let where;
      if (h) where = 'here';
      else if (!x.attached) where = 'detached';
      else where = (presence && presence.get(id)) || 'elsewhere';
      return {
        id, n: meta.n != null ? meta.n : (x && x.n != null ? x.n : null),
        key: spaceKey({ task, cwd }, known),
        title: pick('title'), osc: (h && h.osc) || '', cmd: (x && x.cmd) || '', cwd, task, agent, where,
        idleSince: x && x.idleSince != null ? x.idleSince : null,
        taskTitle: pick('taskTitle'), taskStatus: pick('taskStatus'), taskMissing: !!pick('taskMissing'), branch: pick('branch'),
      };
    };
    const seen = new Set();
    for (const x of list || []) {
      seen.add(x.id);
      out.push(mkRow(x, held && held.get(x.id)));
    }
    if (held) for (const [id, h] of held) if (!seen.has(id)) out.push(mkRow(null, h));
    return out;
  }

  const STATE_RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

  function rollup(states) {
    let best = '';
    for (const s of states || []) {
      if (!(s in STATE_RANK)) continue;
      if (best === '' || STATE_RANK[s] < STATE_RANK[best]) best = s;
    }
    return best;
  }

  // Spaces in list order. Only a space with a pane held here gets a number (num, what Alt+N goes to); one
  // without is dimmed, and a click on it goes to goId: its most urgent row, else its first (goWhere says where).
  function spaces(rowList, names) {
    const groups = new Map();
    for (const r of rowList) {
      if (!groups.has(r.key)) groups.set(r.key, []);
      groups.get(r.key).push(r);
    }
    const out = [];
    let num = 0;
    for (const [key, rs] of groups) {
      const isTask = key.startsWith('t:');
      const first = rs[0];
      let name;
      let detail;
      if (isTask) {
        const folder = basename(key.slice(2).replace(/\/[^/]*$/, ''));
        name = first.taskTitle || folder;
        detail = rs.some((r) => r.taskMissing) ? 'task moved' : STATUS_WORD[first.taskStatus] || '';
      } else {
        const cwd = key.slice(2);
        name = cwd ? basename(cwd) : 'vault';
        const branch = (rs.find((r) => r.branch) || {}).branch;
        detail = branch || (cwd.includes('/') ? cwd.replace(/\/[^/]*$/, '') : `${rs.length} terminal${rs.length === 1 ? '' : 's'}`);
      }
      const detached = rs.filter((r) => r.where === 'detached').length;
      const elsewhere = rs.filter((r) => r.where !== 'here' && r.where !== 'detached').length;
      const extra = [detached && `${detached} detached`, elsewhere && `${elsewhere} elsewhere`].filter(Boolean).join(' · ');
      if (extra) detail = detail ? `${detail} · ${extra}` : extra;
      const heldIds = rs.filter((r) => r.where === 'here').map((r) => r.id);
      const go = heldIds.length ? null : agentOrder(rs)[0] || rs[0];
      out.push({
        key, num: heldIds.length ? ++num : null, name: (names && names[key]) || name, detail,
        rollup: rollup(rs.map((r) => r.agent && r.agent.state)),
        ids: rs.map((r) => r.id),
        heldIds,
        dim: !heldIds.length,
        goId: go ? go.id : null,
        goWhere: go ? go.where : null,
      });
    }
    return out;
  }

  function agentOrder(rowList) {
    return rowList
      .filter((r) => r.agent)
      .map((r, i) => [r, i])
      .sort((p, q) => {
        const ra = STATE_RANK[p[0].agent.state] ?? 9;
        const rb = STATE_RANK[q[0].agent.state] ?? 9;
        return ra - rb || (q[0].agent.since || 0) - (p[0].agent.since || 0) || p[1] - q[1];
      })
      .map((p) => p[0]);
  }

  function paneTitle(t) {
    if (t.title) return t.title;
    const osc = String(t.osc || '').replace(/^[^\p{L}\p{N}]+\s*/u, '').trim();
    const m = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(osc);
    if (m) return `${t.cmd || 'shell'} · ${basename(m[1]) || m[1]}`;
    return osc || t.cmd || 'shell';
  }

  // ---- toasts and cap -----------------------------------------------------

  // Fires once per new blocked/done episode. `memo` is the caller's Map.
  function observe(memo, id, agent) {
    if (!agent) return null;
    const prev = memo.get(id);
    if (!prev) { memo.set(id, { state: agent.state, since: agent.since }); return null; }
    if (agent.since < prev.since) return null;
    const fresh = agent.since > prev.since || agent.state !== prev.state;
    memo.set(id, { state: agent.state, since: agent.since });
    return fresh && (agent.state === 'blocked' || agent.state === 'done')
      ? { id, state: agent.state, since: agent.since } : null;
  }

  function nextNeedingYou(rowList, currentId) {
    const pick = (state) => rowList
      .filter((r) => r.agent && r.agent.state === state)
      .sort((a, b) => a.agent.since - b.agent.since);
    const queue = pick('blocked').concat(pick('done')).map((r) => r.id);
    if (!queue.length) return null;
    const i = queue.indexOf(currentId);
    return queue[(i + 1) % queue.length];
  }

  // The server reaps one idle detached shell to make room, so a full list still
  // has space when one of them is idle (no command running).
  function canOpen(list, max = 12) {
    const l = list || [];
    return l.length < max || l.some((x) => !x.attached && !x.cmd);
  }

  return {
    STATUS_WORD, leaves, insert, insertLargest, remove, layout, setRatio, neighbour, reconcile, tooSmall,
    parseStore, rekey, spaceKey, rows, spaces, rollup, agentOrder, paneTitle, observe, nextNeedingYou, canOpen,
  };
});
