'use strict';
// Pure derived values for Today mode: streaks, the seven-day window and focus sums.
// Callers pass in what they read from disk; nothing here touches fs or the clock.
const { addDays } = require('./today-note');

const MAX_STREAK = 400;

// doneOn(iso) → ticked ids, or null when that day has no note. Today unticked doesn't break a streak.
function streaks(doneOn, ids, today) {
  const out = {};
  for (const id of ids) {
    let d = (doneOn(today) || []).includes(id) ? today : addDays(today, -1);
    let n = 0;
    while (n < MAX_STREAK && (doneOn(d) || []).includes(id)) { n++; d = addDays(d, -1); }
    out[id] = n;
  }
  return out;
}

const windowEnd = (selected, today) => (selected >= addDays(today, -6) ? today : selected);

function week(doneOn, end) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(end, -i);
    out.push({ date, done: doneOn(date) || [] });
  }
  return out;
}

const TASK_PREFIX = /^task:\s*/;

function focusByHabit(day) {
  const out = {};
  for (const f of (day && day.focus) || []) {
    if (f.target === 'focus' || TASK_PREFIX.test(f.target)) continue;
    out[f.target] = (out[f.target] || 0) + f.min;
  }
  return out;
}

function focusByTask(day) {
  const out = {};
  for (const f of (day && day.focus) || []) {
    if (!TASK_PREFIX.test(f.target)) continue;
    const text = f.target.replace(TASK_PREFIX, '');
    out[text] = (out[text] || 0) + f.min;
  }
  return out;
}

const crossesGoal = (before, after, goal) => goal != null && before < goal && after >= goal;

module.exports = { streaks, windowEnd, week, focusByHabit, focusByTask, crossesGoal };
