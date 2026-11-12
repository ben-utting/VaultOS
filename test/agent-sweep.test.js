'use strict';
// lib/agent-sweep.js: what runs in a terminal, and its agent's next state (spec 2026-11-12 §3.1, §3.3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/agent-sweep');

const now = 1e6;

test('parseTpgid reads the 8th field even when the name has spaces and brackets', () => {
  assert.equal(S.parseTpgid('123 (my (odd) name) S 1 123 123 34816 4567 4194560 0 0'), 4567);
  assert.equal(S.parseTpgid('10 (bash) S 1 10 10 34816 22 0'), 22);
  assert.equal(S.parseTpgid('garbage'), null);
  assert.equal(S.parseTpgid('10 (bash) S 1 10 10 34816 -1 0'), null);
});

test('foregroundArgv reads the foreground group leader, else falls back to argv[0]', () => {
  const files = { '/proc/10/stat': '10 (bash) S 1 10 10 34816 22 0', '/proc/22/cmdline': 'claude\0--resume\0' };
  const read = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  assert.deepEqual(S.foregroundArgv(10, 'bash', read), ['claude', '--resume']);
  assert.deepEqual(S.foregroundArgv(11, 'claude', () => { throw new Error('EACCES'); }), ['claude']);
  const empty = { '/proc/10/stat': files['/proc/10/stat'], '/proc/22/cmdline': '' };
  assert.deepEqual(S.foregroundArgv(10, 'node', (p) => empty[p]), ['node']);
});

test('a hook state of the same kind is kept, with its fallbacks', () => {
  const a = { state: 'working', since: now - 1000, kind: 'claude', via: 'hook', sessionId: 's' };
  assert.equal(S.nextAgent(a, { kind: 'claude', busy: true, quietMs: 5e3, inputAt: 0, now }), a);
  const quiet = S.nextAgent(a, { kind: 'claude', busy: true, quietMs: 21e3, inputAt: 0, now });
  assert.deepEqual(quiet, { ...a, state: 'idle', since: now });
  const b = { ...a, state: 'blocked' };
  assert.equal(S.nextAgent(b, { kind: 'claude', busy: true, quietMs: 9e3, inputAt: now - 500, now }).state, 'idle');
  assert.equal(S.nextAgent(b, { kind: 'claude', busy: true, quietMs: 9e3, inputAt: 0, now }), b);
  const done = { ...a, state: 'done' };
  assert.equal(S.nextAgent(done, { kind: 'claude', busy: true, quietMs: 60e3, inputAt: 0, now }), done);
});

test('a hook state survives when detection cannot name the program, while something runs', () => {
  const a = { state: 'idle', since: now - 1000, kind: 'claude', via: 'hook', sessionId: '' };
  assert.equal(S.nextAgent(a, { kind: null, busy: true, quietMs: 1e3, inputAt: 0, now }), a);
  assert.equal(S.nextAgent(a, { kind: null, busy: false, quietMs: 1e3, inputAt: 0, now }), null);
});

test('a hook-less agent is working while it prints and idle after 20s quiet; since moves only on a change', () => {
  const w = S.nextAgent(null, { kind: 'cursor', busy: true, quietMs: 1e3, inputAt: 0, now });
  assert.deepEqual(w, { state: 'working', since: now, kind: 'cursor', via: 'proc', sessionId: '' });
  assert.equal(S.nextAgent(w, { kind: 'cursor', busy: true, quietMs: 2e3, inputAt: 0, now: now + 5e3 }), w);
  const idle = S.nextAgent(w, { kind: 'cursor', busy: true, quietMs: 21e3, inputAt: 0, now: now + 9e3 });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.since, now + 9e3);
});

test('another kind in front replaces the agent; nothing in front clears it', () => {
  const c = { state: 'done', since: now - 1, kind: 'claude', via: 'hook', sessionId: '' };
  const x = S.nextAgent(c, { kind: 'cursor', busy: true, quietMs: 1e3, inputAt: 0, now });
  assert.equal(x.kind, 'cursor');
  assert.equal(x.via, 'proc');
  assert.equal(x.since, now);
  assert.equal(S.nextAgent(x, { kind: null, busy: true, quietMs: 1e3, inputAt: 0, now }), null);
  assert.equal(S.nextAgent(null, { kind: null, busy: true, quietMs: 1e3, inputAt: 0, now }), null);
  assert.equal(S.nextAgent(null, { kind: 'cursor', busy: false, quietMs: 1e3, inputAt: 0, now }), null);
});

test('the quiet and dismiss times are the ones the hooks fallbacks always used', () => {
  assert.equal(S.AGENT_QUIET_MS, 20e3);
  assert.equal(S.AGENT_DISMISS_MS, 8e3);
});
