'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TN = require('../public/today-next');

const none = () => undefined;
const base = { todayTasks: [], boardTasks: [], agentState: none, viewingToday: true, wsLabel: 'Personal' };
const pick = (o) => TN.pickNext({ ...base, ...o });

test('the first open today task wins', () => {
  const n = pick({
    todayTasks: [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: false }],
    boardTasks: [{ title: 'P', path: 'p.md', status: 'in-progress', mtime: 5 }],
  });
  assert.equal(n.kind, 'today');
  assert.equal(n.text, 'b');
  assert.equal(n.target, 'task:b');
});

test('moved today tasks are skipped', () => {
  const n = pick({ todayTasks: [{ text: 'x', done: false, moved: true }, { text: 'y', done: false }] });
  assert.equal(n.kind, 'today');
  assert.equal(n.text, 'y');
  assert.equal(pick({ todayTasks: [{ text: 'x', done: false, moved: true }] }).kind, 'clear');
});

test('board fallback takes in-progress only', () => {
  const n = pick({
    boardTasks: [
      { title: 'B', path: 'b.md', status: 'backlog', mtime: 9 },
      { title: 'R', path: 'r.md', status: 'review', mtime: 8 },
      { title: 'P', path: 'p.md', status: 'in-progress', mtime: 1 },
    ],
    wsLabel: 'Sucden',
  });
  assert.equal(n.kind, 'board');
  assert.equal(n.title, 'P');
  assert.equal(n.path, 'p.md');
  assert.equal(n.target, 'task: P');
  assert.equal(n.wsLabel, 'Sucden');
});

test('needs-you beats a newer task', () => {
  const n = pick({
    boardTasks: [
      { title: 'Old', path: 'old.md', status: 'in-progress', mtime: 1 },
      { title: 'New', path: 'new.md', status: 'in-progress', mtime: 9 },
    ],
    agentState: (p) => (p === 'old.md' ? 'blocked' : undefined),
  });
  assert.equal(n.title, 'Old');
  assert.equal(n.needsYou, true);
});

test('otherwise the newest mtime wins', () => {
  const n = pick({
    boardTasks: [
      { title: 'Old', path: 'old.md', status: 'in-progress', mtime: 1 },
      { title: 'New', path: 'new.md', status: 'in-progress', mtime: 9 },
      { title: 'Mid', path: 'mid.md', status: 'in-progress', mtime: 5 },
    ],
  });
  assert.equal(n.title, 'New');
  assert.equal(n.needsYou, false);
});

test('no board data means clear', () => {
  assert.deepEqual(pick({ boardTasks: null }), { kind: 'clear' });
});

test('nothing left means clear', () => {
  assert.deepEqual(pick({ todayTasks: [{ text: 'a', done: true }], boardTasks: [] }), { kind: 'clear' });
});

test('another day never falls back to the board', () => {
  const boardTasks = [{ title: 'P', path: 'p.md', status: 'in-progress', mtime: 1 }];
  assert.equal(pick({ viewingToday: false, boardTasks }).kind, 'clear');
  const n = pick({ viewingToday: false, boardTasks, todayTasks: [{ text: 'a', done: false }] });
  assert.equal(n.kind, 'today');
});
