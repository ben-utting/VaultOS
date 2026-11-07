'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { streaks, windowEnd, week, focusByHabit, focusByTask, crossesGoal } = require('../lib/today-stats');

const days = { '2026-10-11': [], '2026-10-10': ['read'], '2026-10-09': ['read'], '2026-10-08': ['gym'], '2026-10-06': ['read'] };
const doneOn = (d) => days[d] || null;
test('streak: unticked today does not break it; a gap ends it', () => {
  assert.deepEqual(streaks(doneOn, ['read', 'gym'], '2026-10-11'), { read: 2, gym: 0 });
  days['2026-10-11'] = ['read'];
  assert.equal(streaks(doneOn, ['read'], '2026-10-11').read, 3);
});
test('streak stops at 400 days', () => {
  assert.equal(streaks(() => ['x'], ['x'], '2026-10-11').x, 400);
});
test('week and windowEnd', () => {
  assert.equal(windowEnd('2026-10-05', '2026-10-11'), '2026-10-11');
  assert.equal(windowEnd('2026-10-04', '2026-10-11'), '2026-10-04');
  const w = week(doneOn, '2026-10-11');
  assert.deepEqual(w.map((d) => d.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(w[2].done, []);
});
test('focus sums and crossesGoal', () => {
  const day = { focus: [{ min: 25, target: 'read' }, { min: 25, target: 'read' }, { min: 25, target: 'task: Dentist' }, { min: 25, target: 'focus' }] };
  assert.deepEqual(focusByHabit(day), { read: 50 });
  assert.deepEqual(focusByTask(day), { Dentist: 25 });
  assert.equal(crossesGoal(25, 50, 30), true);
  assert.equal(crossesGoal(50, 75, 30), false);
  assert.equal(crossesGoal(0, 25, null), false);
});
