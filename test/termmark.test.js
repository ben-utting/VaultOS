'use strict';
// public/termmark.js: one animated mark per agent and state (spec 2026-11-12 §5). sync() is DOM-bound: e2e S13.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TM = require('../public/termmark');
const AgentMarks = require('../public/agent-marks');

test('word: the state as text, "needs you" for blocked', () => {
  assert.equal(TM.word('working'), 'working');
  assert.equal(TM.word('blocked'), 'needs you');
  assert.equal(TM.word('done'), 'done');
  assert.equal(TM.word('idle'), 'idle');
  assert.equal(TM.word('nope'), '');
  assert.equal(TM.word(undefined), '');
});

test('html: family, state, motion, the ✓ only when done, escaped', () => {
  const h = TM.html({ kind: 'claude', state: 'working', motion: 'full', id: 't"1' });
  assert.match(h, /^<span class="tm"/);
  assert.match(h, /data-family="claude"/);
  assert.match(h, /data-agent="working"/);
  assert.match(h, /data-motion="full"/);
  assert.match(h, /data-tid="t&quot;1"/);
  assert.match(h, /aria-hidden="true"/);
  assert.doesNotMatch(h, /tm-ok/);
  assert.match(TM.html({ kind: 'cursor', state: 'done' }), /data-family="cursor"[\s\S]*tm-ok/);
  assert.match(TM.html({ kind: 'codex', state: 'idle', motion: 'quiet' }), /data-family="other"[\s\S]*data-motion="quiet"/);
  assert.match(TM.html({ kind: 'cursor', state: 'working' }), /data-motion="full"/, 'full motion by default');
  assert.equal(TM.html({ kind: '', state: 'idle' }).includes('<svg'), true);
  assert.match(TM.html({ kind: 'x', state: '<b>' }), /data-agent="&lt;b&gt;"/);
});

test('html: each agent wears its own mark; an unknown one the custom-agent mark', () => {
  assert.ok(TM.html({ kind: 'claude', state: 'idle' }).includes(AgentMarks.svg('claude')));
  assert.ok(TM.html({ kind: 'cursor', state: 'idle' }).includes(AgentMarks.svg('cursor')));
  assert.ok(TM.html({ kind: 'pi', state: 'idle' }).includes(AgentMarks.svg('pi')));
  assert.ok(TM.html({ kind: 'nope', state: 'idle' }).includes(AgentMarks.svg('custom')));
  assert.ok(TM.html({ kind: '', state: 'idle' }).includes(AgentMarks.svg('custom')));
});

test('periods: one per motion family, and the breath', () => {
  assert.deepEqual(TM.PERIOD, { claude: 3000, cursor: 1200, other: 2400, blocked: 1600 });
});
