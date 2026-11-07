'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/today-timer');

const TODAY = '2026-10-11';
const ctx = (nowMs, extra = {}) => ({ nowMs, today: TODAY, spm: 60, ...extra });

test('start, pause, resume keeps leftMs', () => {
  let s = T.apply(T.initial(TODAY), 'start', ctx(0));
  assert.equal(s.state, 'running');
  assert.equal(s.endsAt, 1500000);
  s = T.apply(s, 'pause', ctx(60000));
  assert.equal(s.state, 'paused');
  assert.equal(s.leftMs, 1440000);
  s = T.apply(s, 'resume', ctx(100000));
  assert.equal(s.state, 'running');
  assert.equal(s.endsAt, 100000 + 1440000);
});

test('start takes target only in the focus phase', () => {
  let s = T.apply(T.initial(TODAY), 'start', ctx(0, { target: 'task:write' }));
  assert.equal(s.target, 'task:write');
  s = T.complete(s, ctx(1500000)).state;
  s = T.apply(s, 'start', ctx(1600000, { target: 'habit-x' }));
  assert.equal(s.phase, 'short');
  assert.equal(s.target, 'task:write');
});

test('fourth completion goes to the long break', () => {
  let s = T.initial(TODAY);
  const phases = [];
  let t = 0;
  for (let i = 0; i < 4; i++) {
    s = T.apply(s, 'start', ctx(t));
    const r = T.complete(s, ctx(t += 1500000));
    assert.deepEqual(Object.keys(r.logged).sort(), ['min', 'startedAt', 'target']);
    assert.equal(r.logged.min, 25);
    s = r.state;
    assert.equal(s.state, 'idle');
    phases.push(s.phase);
    s = T.apply(s, 'start', ctx(t));
    const b = T.complete(s, ctx(t += 60000));
    assert.equal(b.logged, null);
    s = b.state;
    assert.equal(s.phase, 'focus');
    assert.equal(s.state, 'idle');
  }
  assert.deepEqual(phases, ['short', 'short', 'short', 'long']);
  assert.equal(s.cycle, 0);
});

test('skip does not count a session', () => {
  let s = T.apply(T.initial(TODAY), 'start', ctx(0));
  s = T.apply(s, 'skip', ctx(1000));
  assert.equal(s.cycle, 0);
  assert.equal(s.phase, 'short');
  assert.equal(s.state, 'idle');
  s = T.apply(s, 'skip', ctx(2000));
  assert.equal(s.phase, 'focus');
});

test('reset returns to idle in the same phase', () => {
  let s = T.apply(T.initial(TODAY), 'start', ctx(0));
  s = T.apply(s, 'reset', ctx(1000));
  assert.equal(s.state, 'idle');
  assert.equal(s.phase, 'focus');
  assert.equal(s.endsAt, null);
});

test('cycle resets on a new day', () => {
  const s0 = { ...T.initial('2026-10-10'), cycle: 3 };
  const s = T.apply(s0, 'start', ctx(0));
  assert.equal(s.cycle, 0);
  assert.equal(s.cycleDate, TODAY);
});

test('invalid actions throw 400', () => {
  const idle = T.initial(TODAY);
  assert.throws(() => T.apply(idle, 'pause', ctx(0)), { status: 400 });
  const running = T.apply(idle, 'start', ctx(0));
  assert.throws(() => T.apply(running, 'resume', ctx(1)), { status: 400 });
  assert.throws(() => T.apply(running, 'start', ctx(1)), { status: 400 });
  assert.throws(() => T.apply(idle, 'bogus', ctx(1)), { status: 400 });
  assert.throws(() => T.complete(idle, ctx(1)), { status: 400 });
});

test('spm shrinks durations', () => {
  assert.equal(T.durationMs('focus', 1), 25000);
  assert.equal(T.durationMs('long'), 900000);
});

test('state survives a JSON round trip', () => {
  const s = T.apply(T.initial(TODAY), 'start', ctx(5000));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('transitions never touch lastEvent', () => {
  const ev = { id: 7, kind: 'focus-done', at: 1, text: 'x' };
  let s = { ...T.initial(TODAY), lastEvent: ev };
  const seen = [];
  s = T.apply(s, 'start', ctx(0)); seen.push(s);
  s = T.apply(s, 'pause', ctx(1000)); seen.push(s);
  s = T.apply(s, 'resume', ctx(2000)); seen.push(s);
  seen.push(T.apply(s, 'skip', ctx(3000)));
  seen.push(T.apply(s, 'reset', ctx(3000)));
  seen.push(T.complete(s, ctx(4000)).state);
  for (const x of seen) assert.equal(x.lastEvent, ev);
});

test('non-finite nowMs throws 400', () => {
  const idle = T.initial(TODAY);
  assert.throws(() => T.apply(idle, 'start', { today: TODAY }), { status: 400 });
  assert.throws(() => T.apply(idle, 'start', ctx(NaN)), { status: 400 });
  const running = T.apply(idle, 'start', ctx(0));
  assert.throws(() => T.complete(running, { today: TODAY }), { status: 400 });
});
