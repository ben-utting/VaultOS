'use strict';
// Pure Pomodoro state machine for Today mode. No fs, no clock, no timers: callers pass nowMs.
// startedAt and endsAt are epoch milliseconds (numbers), so state survives JSON round trips
// and compares directly with Date.now().

const MINUTES = { focus: 25, short: 5, long: 15 };
const CYCLE_LEN = 4;

const initial = (today) => ({
  phase: 'focus', state: 'idle', target: 'focus', startedAt: null, endsAt: null,
  leftMs: null, cycle: 0, cycleDate: today, lastEvent: null,
});

const durationMs = (phase, spm = 60) => MINUTES[phase] * spm * 1000;

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const checkNow = (nowMs) => {
  if (!Number.isFinite(nowMs)) throw bad('nowMs must be a finite number');
};

const rollDay = (s, today) => (s.cycleDate === today ? { ...s } : { ...s, cycle: 0, cycleDate: today });

const idleIn = (s, phase) => ({
  ...s, phase, state: 'idle', startedAt: null, endsAt: null, leftMs: null,
});

// lastEvent belongs to the service (completion toasts); every transition carries it through.
function apply(s, action, { nowMs, today, target, spm = 60 } = {}) {
  checkNow(nowMs);
  const cur = rollDay(s, today);
  const need = (state) => {
    if (cur.state !== state) throw bad(`cannot ${action} while ${cur.state}`);
  };
  switch (action) {
    case 'start':
      need('idle');
      return {
        ...cur, state: 'running', startedAt: nowMs, endsAt: nowMs + durationMs(cur.phase, spm),
        leftMs: null, target: cur.phase === 'focus' && target ? target : cur.target,
      };
    case 'pause':
      need('running');
      return { ...cur, state: 'paused', leftMs: Math.max(0, cur.endsAt - nowMs), endsAt: null };
    case 'resume':
      need('paused');
      return { ...cur, state: 'running', endsAt: nowMs + cur.leftMs, leftMs: null };
    case 'skip':
      return idleIn(cur, cur.phase === 'focus' ? 'short' : 'focus');
    case 'reset':
      return idleIn(cur, cur.phase);
    default:
      throw bad(`unknown action: ${action}`);
  }
}

// Needs a running session; completing before endsAt is accepted, the service decides when to call.
function complete(s, { nowMs, today } = {}) {
  checkNow(nowMs);
  if (s.state !== 'running') throw bad(`cannot complete while ${s.state}`);
  const cur = rollDay(s, today);
  if (cur.phase !== 'focus') return { state: idleIn(cur, 'focus'), logged: null };
  const logged = { startedAt: cur.startedAt, min: MINUTES.focus, target: cur.target };
  const n = cur.cycle + 1;
  const long = n >= CYCLE_LEN;
  return { state: idleIn({ ...cur, cycle: long ? 0 : n }, long ? 'long' : 'short'), logged };
}

module.exports = { MINUTES, initial, durationMs, apply, complete };
