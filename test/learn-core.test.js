'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LC = require('../public/learn-core');

const NB = { path: 'Learning/A', latest: { notes: 'Learning/A/Notes/2026-11-13 study.md', sources: 'Learning/A/Sources/v.txt' } };

test('treeOrder: Sources in the order they came in (oldest first), Notes and Studio newest first, folders first', () => {
  const items = (names) => names.map((n) => (n.endsWith('/') ? { name: n.slice(0, -1), dir: true } : { name: n }));
  const timed = (pairs) => pairs.map(([name, mtime]) => (name.endsWith('/') ? { name: name.slice(0, -1), dir: true } : { name, mtime }));
  assert.deepEqual(LC.treeOrder('Sources', timed([['Day 1 Docker.txt', 300], ['FREE course (Day 0 40).txt', 100], ['If you are preparing.txt', 200], ['sub/']])).map((i) => i.name),
    ['sub', 'FREE course (Day 0 40).txt', 'If you are preparing.txt', 'Day 1 Docker.txt']);
  assert.deepEqual(LC.treeOrder('Sources', timed([['b.txt', 100], ['a.txt', 100]])).map((i) => i.name), ['a.txt', 'b.txt'], 'same time: A to Z');
  assert.deepEqual(LC.treeOrder('Sources', items(['video 10.txt', 'video 2.txt', 'b.md', 'sub/'])).map((i) => i.name), ['sub', 'b.md', 'video 2.txt', 'video 10.txt'], 'no times: A to Z, numbers in order');
  assert.deepEqual(LC.treeOrder('Notes', items(['2026-11-12 study.md', '2026-11-13 study.md', 'old/'])).map((i) => i.name), ['old', '2026-11-13 study.md', '2026-11-12 study.md']);
  assert.deepEqual(LC.treeOrder('Studio', items(['2026-11-01 0900 a.png', '2026-11-13 1430 b.png'])).map((i) => i.name), ['2026-11-13 1430 b.png', '2026-11-01 0900 a.png']);
  assert.deepEqual(LC.treeOrder('Other', items(['b', 'A', 'c'])).map((i) => i.name), ['A', 'b', 'c']);
});

test('pickFrom: the open text file in this notebook, else the newest study log, else the newest source', () => {
  assert.equal(LC.pickFrom('Learning/A/Sources/x.md', NB), 'Learning/A/Sources/x.md');
  assert.equal(LC.pickFrom('Learning/A/Notes/n.TXT', NB), 'Learning/A/Notes/n.TXT');
  assert.equal(LC.pickFrom('Learning/A/Studio/x.png', NB), NB.latest.notes);
  assert.equal(LC.pickFrom('Learning/B/Notes/x.md', NB), NB.latest.notes, 'a tab from another notebook is ignored');
  assert.equal(LC.pickFrom('Learning/AB/x.md', NB), NB.latest.notes, 'a sibling whose name starts the same is another notebook');
  assert.equal(LC.pickFrom('terminal', NB), NB.latest.notes);
  assert.equal(LC.pickFrom(null, { path: 'Learning/A', latest: { notes: null, sources: 'Learning/A/Sources/v.txt' } }), 'Learning/A/Sources/v.txt');
  assert.equal(LC.pickFrom(null, { path: 'Learning/A', latest: { notes: null, sources: null } }), null);
  assert.equal(LC.pickFrom(null, { path: 'Learning/A' }), null);
});

test('tabs per notebook: Terminal is implicit, adding focuses, closing the active one goes back to Terminal', () => {
  let st = {};
  assert.deepEqual(LC.tabsFor(st, 'Learning/A'), { tabs: [], active: 'terminal' });
  st = LC.withTab(st, 'Learning/A', 'Learning/A/Notes/n.md');
  st = LC.withTab(st, 'Learning/A', 'Learning/A/Sources/v.txt');
  st = LC.withTab(st, 'Learning/A', 'Learning/A/Notes/n.md');
  assert.deepEqual(LC.tabsFor(st, 'Learning/A'), { tabs: ['Learning/A/Notes/n.md', 'Learning/A/Sources/v.txt'], active: 'Learning/A/Notes/n.md' });
  assert.deepEqual(LC.tabsFor(st, 'Learning/B'), { tabs: [], active: 'terminal' });
  const before = JSON.stringify(st);
  const st2 = LC.withoutTab(st, 'Learning/A', 'Learning/A/Notes/n.md');
  assert.equal(JSON.stringify(st), before, 'pure: the old store is untouched');
  assert.deepEqual(LC.tabsFor(st2, 'Learning/A'), { tabs: ['Learning/A/Sources/v.txt'], active: 'terminal' });
  assert.deepEqual(LC.tabsFor(LC.withoutTab(st, 'Learning/A', 'Learning/A/Sources/v.txt'), 'Learning/A').active, 'Learning/A/Notes/n.md');
  assert.deepEqual(LC.tabsFor(LC.withActive(st, 'Learning/A', 'terminal'), 'Learning/A').active, 'terminal');
  assert.deepEqual(LC.tabsFor({ 'Learning/A': 'junk' }, 'Learning/A'), { tabs: [], active: 'terminal' }, 'a damaged store reads as empty');
});

test('reconcile drops tabs whose file is gone (Review Focus 1)', () => {
  let st = LC.withTab({}, 'Learning/A', 'Learning/A/Notes/gone.md');
  st = LC.withTab(st, 'Learning/A', 'Learning/A/Sources/v.txt');
  st = LC.withActive(st, 'Learning/A', 'Learning/A/Notes/gone.md');
  const r = LC.reconcile(st, 'Learning/A', new Set(['Learning/A/Sources/v.txt']));
  assert.deepEqual(r.closed, ['Learning/A/Notes/gone.md']);
  assert.deepEqual(LC.tabsFor(r.store, 'Learning/A'), { tabs: ['Learning/A/Sources/v.txt'], active: 'terminal' });
  assert.deepEqual(LC.reconcile(r.store, 'Learning/A', new Set(['Learning/A/Sources/v.txt'])).closed, []);
});

test('startButtons: at most two agents, a plain terminal when there is none, nothing when terminals are off', () => {
  const agents = [
    { id: 'claude', label: 'Claude Code', short: 'Claude', command: "claude 'x'" },
    { id: 'cursor', label: 'Cursor CLI', short: 'Cursor', command: "agent 'x'" },
    { id: 'pi', label: 'Pi', short: 'Pi', command: "pi 'x'" },
  ];
  assert.deepEqual(LC.startButtons(agents, true), [
    { id: 'claude', label: 'Start Claude', command: "claude 'x'" },
    { id: 'cursor', label: 'Start Cursor', command: "agent 'x'" },
  ]);
  assert.deepEqual(LC.startButtons([], true), [{ id: 'plain', label: 'Open a terminal', command: null }]);
  assert.deepEqual(LC.startButtons(agents, false), []);
  assert.deepEqual(LC.startButtons(undefined, true), [{ id: 'plain', label: 'Open a terminal', command: null }]);
});

test('youtubeKind mirrors the server\'s link rules', () => {
  assert.equal(LC.youtubeKind('https://youtu.be/abcdefghijk'), 'video');
  assert.equal(LC.youtubeKind('youtube.com/watch?v=abcdefghijk'), 'video');
  assert.equal(LC.youtubeKind('https://www.youtube.com/watch?v=abcdefghijk&list=PL0123456789'), 'both');
  assert.equal(LC.youtubeKind('https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk'), 'video');
  assert.equal(LC.youtubeKind('https://www.youtube.com/playlist?list=PLe3qqz7JaEDM'), 'playlist');
  assert.equal(LC.youtubeKind('https://example.com/watch?v=abcdefghijk'), null);
  assert.equal(LC.youtubeKind('hello'), null);
  assert.equal(LC.youtubeKind(''), null);
});

test('money: the cost line shows two decimals, or nothing', () => {
  assert.equal(LC.madeBy('some/model', 0.0412), 'Made by some/model · $0.04');
  assert.equal(LC.madeBy('some/model', null), 'Made by some/model');
  assert.equal(LC.madeBy(null, 0.5), 'Made by OpenRouter · $0.50');
});
