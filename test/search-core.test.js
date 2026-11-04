'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../public/search-core');

const k = (o) => SC.keyIntent({ key: 'f', ctrlKey: true, isMac: false, panelOpen: false, inPanel: false, inEditable: false, inTerminal: false, ...o });

test('keyIntent: Ctrl+F opens, except in a terminal', () => {
  assert.equal(k({}), 'open');
  assert.equal(k({ inTerminal: true }), null);
});
test('keyIntent: second Ctrl+F in the panel hands back to the browser; Ctrl+K stays null', () => {
  assert.equal(k({ panelOpen: true, inPanel: true }), 'close-to-browser');
  assert.equal(k({ key: 'k', panelOpen: true, inPanel: true }), null);
  assert.equal(k({ key: 'k' }), 'open');
});
test('keyIntent: with a document on screen Ctrl+F is the browser\'s find, Ctrl+K still opens', () => {
  assert.equal(k({ inDoc: true }), null);
  assert.equal(k({ key: 'k', inDoc: true }), 'open');
  assert.equal(k({ isMac: true, ctrlKey: false, metaKey: true, inDoc: true }), null);
});
test('keyIntent: Mac uses the meta key', () => {
  assert.equal(k({ isMac: true, ctrlKey: false, metaKey: true }), 'open');
  assert.equal(k({ isMac: true }), null);
});
test('keyIntent: editable fields and extra modifiers leave the key alone', () => {
  assert.equal(k({ inEditable: true }), null);
  assert.equal(k({ shiftKey: true }), null);
  assert.equal(k({ altKey: true }), null);
});

test('intentForQuery needs a word character', () => {
  assert.equal(SC.intentForQuery('  '), 'recent');
  assert.equal(SC.intentForQuery('?!'), 'recent');
  assert.equal(SC.intentForQuery('the ?'), 'search');
});

test('filterLabel', () => {
  assert.equal(SC.filterLabel('board', 'x'), "Filter Board to 'x'");
  assert.equal(SC.filterLabel('kb', 'x'), "Filter Knowledge Base to 'x'");
  assert.equal(SC.filterLabel('files', 'x'), "Filter the Files tree to 'x'");
  assert.equal(SC.filterLabel('today', 'x'), null);
});

test('visibleFileHits', () => {
  const ws = [{ key: 'home', label: 'Home', dir: 'Home' }];
  const items = [
    { path: 'Archive/a.pdf', name: 'a.pdf' }, { path: 'Loose/b.pdf', name: 'b.pdf' },
    { path: 'Home/Today/c.pdf', name: 'c.pdf' }, { path: 'Home/n.md', name: 'n.md' },
    { path: 'Home/dir', name: 'dir', dir: true },
    { path: 'Home/notes/invoice-boiler.pdf', name: 'invoice-boiler.pdf' },
  ];
  assert.deepEqual(SC.visibleFileHits(items, ws, 'Home/Today').map((i) => i.path), ['Home/notes/invoice-boiler.pdf']);
  assert.equal(SC.visibleFileHits(items, ws, '').length, 2);
  const hidden = [{ path: 'Home/_tasks/x.pdf' }, { path: 'Home/1. p/_Templates/y.pdf' }, { path: 'Home/ok/z.pdf' }];
  assert.deepEqual(SC.visibleFileHits(hidden, ws, '').map((i) => i.path), ['Home/ok/z.pdf']);
});

test('groupResults: order, cap, omitted empties', () => {
  const r = (kind, n) => Array.from({ length: n }, (_, i) => ({ path: kind + i, kind }));
  const results = [...r('note', 2), ...r('task', 7), ...r('article', 1)];
  const files = [{ path: 'Home/f.pdf', name: 'f.pdf' }];
  const g = SC.groupResults(results, files, { type: 'all' });
  assert.deepEqual(g.map((x) => [x.key, x.label, x.items.length, x.total]),
    [['task', 'Tasks', 5, 7], ['article', 'Articles', 1, 1], ['note', 'Notes', 2, 2], ['file', 'Files', 1, 1]]);
  const t = SC.groupResults(results, [], { type: 'task' });
  assert.deepEqual(t.map((x) => [x.key, x.items.length]), [['task', 7]]);
  assert.deepEqual(SC.groupResults([], [], { type: 'all' }), []);
});

test('highlight escapes then marks', () => {
  assert.equal(SC.highlight('<b>&amp; ship</b>', 'ship'), '&lt;b&gt;&amp;amp; <mark>ship</mark>&lt;/b&gt;');
  assert.equal(SC.highlight('a Ship b', 'x ship'), 'a <mark>Ship</mark> b');
  assert.equal(SC.highlight('a.b', '.. a.'), '<mark>a.</mark>b');
  assert.equal(SC.highlight('a & b', 'amp'), 'a &amp; b');
  assert.equal(SC.highlight('x < y > "z"', 'lt gt quot'), 'x &lt; y &gt; &quot;z&quot;');
});
