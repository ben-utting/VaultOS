'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TT = require('../public/termtree');
const {
  leaves, insert, insertLargest, remove, layout, setRatio, neighbour, reconcile, tooSmall,
  parseStore, rekey, spaceKey, rows, spaces, rollup, agentOrder, paneTitle, observe,
  nextNeedingYou, canOpen,
} = TT;

const T = { dir: 'row', r: 0.5, a: { id: 'a' }, b: { dir: 'col', r: 0.25, a: { id: 'b' }, b: { id: 'c' } } };
const copy = (x) => JSON.parse(JSON.stringify(x));

test('insert splits right and down', () => {
  assert.deepEqual(insert(null, 'a', {}), { id: 'a' });
  assert.deepEqual(insert({ id: 'a' }, 'b', { target: 'a', dir: 'row' }), { dir: 'row', r: 0.5, a: { id: 'a' }, b: { id: 'b' } });
  const n = insert(T, 'd', { target: 'c', dir: 'col' });
  assert.deepEqual(leaves(n), ['a', 'b', 'c', 'd']);
  assert.equal(n.b.b.dir, 'col');
  assert.deepEqual(n.b.b.a, { id: 'c' });
  assert.deepEqual(T, copy(T));
});

test('layout gives fractions and split paths', () => {
  const L = layout(T);
  assert.deepEqual(L.rects, { a: [0, 0, 0.5, 1], b: [0.5, 0, 0.5, 0.25], c: [0.5, 0.25, 0.5, 0.75] });
  assert.deepEqual(L.splits[0], { path: '', dir: 'row', x: 0, y: 0, w: 1, h: 1, r: 0.5 });
  assert.equal(L.splits[1].path, 'b');
});

test('insertLargest splits the biggest pane along its longer side', () => {
  const area = { w: 1600, h: 400 };
  let t = insertLargest(null, 'a', area);
  t = insertLargest(t, 'b', area);
  assert.equal(t.dir, 'row');
  t = insertLargest(t, 'c', { ...area, focus: 'b' });
  assert.deepEqual(leaves(t), ['a', 'b', 'c']);
  assert.equal(t.b.dir, 'row');
  assert.deepEqual(t.b.b, { id: 'c' });
  let u = insertLargest(null, 'a', { w: 400, h: 900 });
  u = insertLargest(u, 'b', { w: 400, h: 900 });
  assert.equal(u.dir, 'col');
});

test('remove promotes the sibling', () => {
  assert.deepEqual(remove(T, 'b'), { dir: 'row', r: 0.5, a: { id: 'a' }, b: { id: 'c' } });
  assert.equal(remove({ id: 'a' }, 'a'), null);
  assert.deepEqual(T, copy(T));
});

test('setRatio clamps and is pure', () => {
  assert.equal(setRatio(T, '', 0.95).r, 0.88);
  assert.equal(setRatio(T, 'b', 0.01).b.r, 0.12);
  assert.equal(T.r, 0.5);
  assert.deepEqual(T, copy(T));
});

test('neighbour picks the largest shared edge', () => {
  const R = layout(T).rects;
  assert.equal(neighbour(R, 'a', 'right'), 'c');
  assert.equal(neighbour(R, 'c', 'up'), 'b');
  assert.equal(neighbour(R, 'b', 'left'), 'a');
  assert.equal(neighbour(R, 'a', 'left'), null);
});

test('reconcile drops unheld and adds held', () => {
  const t = reconcile(T, ['a', 'c', 'd'], { w: 1600, h: 400, focus: 'a' });
  assert.deepEqual(new Set(leaves(t)), new Set(['a', 'c', 'd']));
  assert.equal(reconcile(T, [], {}), null);
  assert.deepEqual(T, copy(T));
});

test('tooSmall', () => {
  assert.equal(tooSmall({ a: [0, 0, 0.05, 1] }, 1600, 400), true);
  assert.equal(tooSmall({ a: [0, 0, 0.5, 1] }, 1600, 400), false);
});

test('parseStore rejects junk', () => {
  const empty = { v: 1, active: null, spaces: {} };
  assert.deepEqual(parseStore('nope'), empty);
  assert.deepEqual(parseStore(null), empty);
  const bad = JSON.stringify({ v: 1, active: null, spaces: { x: { root: { dir: 'row', r: 0.5, a: { id: 'a' } }, focus: 'a', zoom: null } } });
  assert.deepEqual(parseStore(bad).spaces, {});
  const wide = JSON.stringify({ v: 1, active: 'x', spaces: { x: { root: { dir: 'row', r: 2, a: { id: 'a' }, b: { id: 'b' } }, focus: 'a', zoom: null } } });
  const p = parseStore(wide);
  assert.equal(p.spaces.x.root.r, 0.88);
  assert.equal(p.active, 'x');
  const lost = JSON.stringify({ v: 1, active: 'gone', spaces: { x: { root: { id: 'a' }, focus: 'a', zoom: null } } });
  assert.equal(parseStore(lost).active, null);
});

test('rekey moves a leaf or renames the whole space', () => {
  const s = { v: 1, active: 'd:P/x', spaces: { 'd:P/x': { root: { id: '1' }, focus: '1', zoom: null } } };
  const r = rekey(s, '1', 'd:P/x', 't:P/x/task.md', { w: 800, h: 400 });
  assert.deepEqual(Object.keys(r.store.spaces), ['t:P/x/task.md']);
  assert.equal(r.store.active, 't:P/x/task.md');
  assert.equal(r.renamed, true);
  assert.deepEqual(s, copy(s));
  const s2 = { v: 1, active: 'd:P/x', spaces: { 'd:P/x': { root: { dir: 'row', r: 0.5, a: { id: '1' }, b: { id: '2' } }, focus: '1', zoom: null } } };
  const r2 = rekey(s2, '1', 'd:P/x', 't:P/x/task.md', { w: 800, h: 400 });
  assert.deepEqual(Object.keys(r2.store.spaces).sort(), ['d:P/x', 't:P/x/task.md']);
  assert.equal(r2.renamed, false);
  assert.deepEqual(leaves(r2.store.spaces['d:P/x'].root), ['2']);
  assert.deepEqual(leaves(r2.store.spaces['t:P/x/task.md'].root), ['1']);
  assert.deepEqual(s2, copy(s2));
});

test('spaceKey: task first, then cwd, with the join rule', () => {
  assert.equal(spaceKey({ task: 'P/1/x/task.md', cwd: 'P/1/x' }, new Set()), 't:P/1/x/task.md');
  assert.equal(spaceKey({ task: '', cwd: 'P/1/x' }, new Set(['P/1/x/task.md'])), 't:P/1/x/task.md');
  assert.equal(spaceKey({ task: '', cwd: 'P/1/x/data' }, new Set(['P/1/x/task.md'])), 'd:P/1/x/data');
  assert.equal(spaceKey({ cwd: '' }, new Set()), 'd:');
});

const held = (...ids) => new Map(ids.map((id) => [id, { meta: { id, n: +id, title: '', cwd: '', task: '' }, osc: '', agent: null }]));

test('rows: where each session is', () => {
  const list = [{ id: '1', attached: true }, { id: '2', attached: true }, { id: '3', attached: false }, { id: '4', attached: true }];
  const presence = new Map([['2', 'window'], ['3', 'dock']]);
  const rs = rows(list, held('1', '9'), presence);
  assert.deepEqual(rs.map((r) => r.id), ['1', '2', '3', '4', '9']);
  const where = Object.fromEntries(rs.map((r) => [r.id, r.where]));
  assert.deepEqual(where, { 1: 'here', 2: 'window', 3: 'detached', 4: 'elsewhere', 9: 'here' });
  assert.deepEqual(rows(null, held('1', '9'), presence).map((r) => r.id), ['1', '9']);
});

const TASK = 'Personal/1. apps/01-api-refactor';
const mk = (o) => ({ id: 'x', where: 'here', agent: null, cwd: '', task: '', ...o });

test('spaces: grouping, order, naming, detail, rollup, dim', () => {
  const taskRow = mk({ id: '1', cwd: TASK, task: TASK + '/task.md', key: 't:' + TASK + '/task.md', taskTitle: 'API refactor', taskStatus: 'in-progress' });
  let s = spaces([taskRow], {});
  assert.equal(s[0].num, 1);
  assert.equal(s[0].name, 'API refactor');
  assert.equal(s[0].detail, 'in progress');
  assert.equal(spaces([{ ...taskRow, taskTitle: '' }], {})[0].name, '01-api-refactor');
  assert.equal(spaces([{ ...taskRow, taskMissing: true }], {})[0].detail, 'task moved');
  assert.equal(spaces([taskRow], { [taskRow.key]: 'Auth' })[0].name, 'Auth');

  const repo = mk({ id: '2', cwd: 'Code/DevOps/demo-repo', key: 'd:Code/DevOps/demo-repo', branch: 'feature-x' });
  s = spaces([repo], {});
  assert.equal(s[0].name, 'demo-repo');
  assert.equal(s[0].detail, 'feature-x');
  s = spaces([{ ...repo, cwd: 'Code/DevOps/x', key: 'd:Code/DevOps/x', branch: '' }], {});
  assert.equal(s[0].detail, 'Code/DevOps');
  s = spaces([mk({ id: '3', key: 'd:' }), mk({ id: '4', key: 'd:' })], {});
  assert.equal(s.length, 1);
  assert.equal(s[0].name, 'vault');
  assert.equal(s[0].detail, '2 terminals');

  s = spaces([{ ...repo, where: 'detached' }], {});
  assert.equal(s[0].dim, true);
  assert.ok(s[0].detail.endsWith(' · 1 detached'));
  assert.deepEqual(s[0].heldIds, []);

  const agents = [
    mk({ id: '5', key: 'd:q', cwd: 'q', agent: { state: 'working', since: 1 } }),
    mk({ id: '6', key: 'd:q', cwd: 'q', agent: { state: 'blocked', since: 2 } }),
  ];
  s = spaces([repo, ...agents], {});
  assert.deepEqual(s.map((x) => x.num), [1, 2]);
  assert.equal(s[1].rollup, 'blocked');
  assert.equal(s[1].dim, false);
});

test('spaces: only spaces with a pane here are numbered (Alt+N), in list order; the rest are dimmed', () => {
  const rs = [
    mk({ id: 'd1', key: 'd:a', cwd: 'a', where: 'detached' }),
    mk({ id: 'h1', key: 'd:b', cwd: 'b' }),
    mk({ id: 'w1', key: 'd:c', cwd: 'c', where: 'window' }),
    mk({ id: 'm1', key: 'd:d', cwd: 'd', where: 'detached' }),
    mk({ id: 'm2', key: 'd:d', cwd: 'd' }),
    mk({ id: 'e1', key: 'd:e', cwd: 'e', where: 'elsewhere' }),
    mk({ id: 'h2', key: 'd:f', cwd: 'f' }),
  ];
  const s = spaces(rs, {});
  assert.deepEqual(s.map((x) => x.key), ['d:a', 'd:b', 'd:c', 'd:d', 'd:e', 'd:f']);
  assert.deepEqual(s.map((x) => x.num), [null, 1, null, 2, null, 3]);
  assert.deepEqual(s.map((x) => x.dim), [true, false, true, false, true, false]);
  // A space held elsewhere (not detached) is dimmed too, and says so in its detail.
  assert.ok(s[2].detail.endsWith('1 elsewhere'));
});

test('spaces: a space with no pane here goes to its most urgent row, else its first (goId, goWhere)', () => {
  let s = spaces([
    mk({ id: 'i', key: 'd:x', cwd: 'x', where: 'detached', agent: { state: 'idle', since: 1 } }),
    mk({ id: 'n', key: 'd:x', cwd: 'x', where: 'window' }),
    mk({ id: 'b', key: 'd:x', cwd: 'x', where: 'window', agent: { state: 'blocked', since: 5 } }),
  ], {});
  assert.equal(s[0].goId, 'b');
  assert.equal(s[0].goWhere, 'window');
  s = spaces([mk({ id: 'p', key: 'd:y', cwd: 'y', where: 'detached' }), mk({ id: 'q', key: 'd:y', cwd: 'y', where: 'tab' })], {});
  assert.equal(s[0].goId, 'p');
  assert.equal(s[0].goWhere, 'detached');
  // Held here: shown, never brought, so there is no target.
  s = spaces([mk({ id: 'r', key: 'd:z', cwd: 'z', where: 'detached', agent: { state: 'blocked', since: 1 } }), mk({ id: 't', key: 'd:z', cwd: 'z' })], {});
  assert.equal(s[0].goId, null);
  assert.equal(s[0].goWhere, null);
});

test('rollup', () => {
  assert.equal(rollup(['idle', 'working', 'done']), 'done');
  assert.equal(rollup(['working', 'blocked']), 'blocked');
  assert.equal(rollup([]), '');
});

test('agentOrder', () => {
  const rs = [
    mk({ id: 'i', agent: { state: 'idle', since: 1 } }),
    mk({ id: 'n' }),
    mk({ id: 'w', agent: { state: 'working', since: 1 } }),
    mk({ id: 'd', agent: { state: 'done', since: 1 } }),
    mk({ id: 'b1', agent: { state: 'blocked', since: 1 } }),
    mk({ id: 'b2', agent: { state: 'blocked', since: 9 } }),
  ];
  assert.deepEqual(agentOrder(rs).map((r) => r.id), ['b2', 'b1', 'd', 'w', 'i']);
});

test('paneTitle', () => {
  assert.equal(paneTitle({ title: 'logs' }), 'logs');
  const osc = 'coder@vault-workbench: /vault/Personal/1. apps/01-api-refactor';
  assert.equal(paneTitle({ osc, cmd: '' }), 'shell · 01-api-refactor');
  assert.equal(paneTitle({ osc, cmd: 'npm' }), 'npm · 01-api-refactor');
  assert.equal(paneTitle({ osc: '✳ Fix the login bug' }), 'Fix the login bug');
  assert.equal(paneTitle({ osc: '⠂ Claude Code' }), 'Claude Code');
  assert.equal(paneTitle({ cmd: 'claude' }), 'claude');
  assert.equal(paneTitle({}), 'shell');
});

test('observe fires once per new blocked or done', () => {
  const m = new Map();
  assert.equal(observe(m, '1', { state: 'blocked', since: 10 }), null);
  assert.equal(observe(m, '1', { state: 'working', since: 20 }), null);
  assert.deepEqual(observe(m, '1', { state: 'blocked', since: 30 }), { id: '1', state: 'blocked', since: 30 });
  assert.equal(observe(m, '1', { state: 'blocked', since: 30 }), null);
  assert.equal(observe(m, '1', { state: 'done', since: 25 }), null);
  assert.equal(observe(m, '2', null), null);
});

test('nextNeedingYou cycles blocked oldest first, then done', () => {
  const rs = [
    mk({ id: 'a', agent: { state: 'blocked', since: 5 } }),
    mk({ id: 'b', agent: { state: 'blocked', since: 3 } }),
    mk({ id: 'c', agent: { state: 'done', since: 1 } }),
    mk({ id: 'd', agent: { state: 'working', since: 1 } }),
  ];
  assert.equal(nextNeedingYou(rs, null), 'b');
  assert.equal(nextNeedingYou(rs, 'b'), 'a');
  assert.equal(nextNeedingYou(rs, 'a'), 'c');
  assert.equal(nextNeedingYou(rs, 'c'), 'b');
  assert.equal(nextNeedingYou([rs[3]], null), null);
});

test('canOpen', () => {
  const n = (k, f) => Array.from({ length: k }, (_, i) => ({ id: String(i), attached: true, cmd: 'bash', ...(f ? f(i) : {}) }));
  assert.equal(canOpen(n(11)), true);
  assert.equal(canOpen(n(12)), false);
  assert.equal(canOpen(n(12, (i) => (i === 0 ? { attached: false, cmd: '' } : {}))), true);
  assert.equal(canOpen(n(12, (i) => (i === 0 ? { attached: false, cmd: 'claude' } : {}))), false);
});

test('rows applies the task-folder join rule', () => {
  const list = [
    { id: '1', task: 'P/1/x/task.md', cwd: 'P/1/x', attached: true },
    { id: '2', task: '', cwd: 'P/1/x', attached: true },
  ];
  const rs = rows(list, new Map(), new Map());
  assert.deepEqual(rs.map((r) => r.key), ['t:P/1/x/task.md', 't:P/1/x/task.md']);
  const sp = spaces(rs, {});
  assert.equal(sp.length, 1);
  assert.deepEqual(sp[0].ids, ['1', '2']);
});
