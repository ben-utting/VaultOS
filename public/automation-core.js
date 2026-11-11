'use strict';

// ========================================================================
// AutomationCore — the parts of Automations that the browser (the builder,
// the list) and the server (the scheduler, validation) must answer the same
// way (window.AutomationCore; also a Node module for lib/ and the tests).
// Schedules are wall-clock times in one IANA time zone; slots are epoch ms.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.AutomationCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_MS = 86400000;
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const HOURS_EVERY = [1, 2, 3, 4, 6, 8, 12];

  // ---------- Time zones ----------
  const fmtCache = new Map();
  function partsFmt(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      fmtCache.set(tz, f);
    }
    return f;
  }
  // The wall clock in tz at instant ms: { y, mo, d, h, mi, s }.
  function wallParts(ms, tz) {
    const p = {};
    for (const x of partsFmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
    return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
  }
  // tz's offset from UTC at instant ms, in ms (positive east of Greenwich).
  function offsetAt(ms, tz) {
    const w = wallParts(ms, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  }
  // The instant the wall clock in tz reads y-mo-d h:mi. A time that happens twice (clocks going back)
  // gives the first; a time that never happens (clocks going forward) gives the instant just after the
  // gap, read with the offset from before it (01:30 on a spring-forward night runs at 02:30).
  function wallToUtc(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const before = offsetAt(guess - DAY_MS, tz);
    const after = offsetAt(guess + DAY_MS, tz);
    const hits = [...new Set([before, after])].map((o) => guess - o).filter((t) => {
      const w = wallParts(t, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    });
    return hits.length ? Math.min(...hits) : guess - before;
  }

  // ---------- Schedules ----------
  const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  // Minutes after midnight at which the schedule fires on a day it fires at all.
  function timesOf(s) {
    if (s.repeat !== 'hours') return [hm(s.time)];
    const step = s.every * 60;
    const out = new Set();
    for (let k = 0; k < 1440 / step; k++) out.add((hm(s.from) + k * step) % 1440);
    return [...out].sort((a, b) => a - b);
  }
  // Whether the schedule fires on this calendar day (weekday 0 = Sunday, as Date.getUTCDay).
  function firesOn(s, weekday) {
    if (s.repeat === 'weekdays') return weekday >= 1 && weekday <= 5;
    if (s.repeat === 'weekly') return s.days.includes(DAYS[(weekday + 6) % 7]);
    return true;
  }
  // Every slot on the local calendar days start..end (offsets from the local date of ms), ascending.
  function slotsAround(s, tz, ms, start, end) {
    const w = wallParts(ms, tz);
    const out = [];
    for (let k = start; k <= end; k++) {
      const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + k));
      if (!firesOn(s, day.getUTCDay())) continue;
      for (const min of timesOf(s)) {
        out.push(wallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(min / 60), min % 60, tz));
      }
    }
    return out.sort((a, b) => a - b);
  }
  // The latest slot at or before atMs, or null (a weekly schedule with no days never fires).
  function lastSlot(s, tz, atMs) {
    const past = slotsAround(s, tz, atMs, -8, 1).filter((t) => t <= atMs);
    return past.length ? past[past.length - 1] : null;
  }
  // The earliest slot after afterMs, or null.
  function nextSlot(s, tz, afterMs) {
    const next = slotsAround(s, tz, afterMs, -1, 8).find((t) => t > afterMs);
    return next === undefined ? null : next;
  }
  function describeSchedule(s) {
    if (s.repeat === 'daily') return `Every day ${s.time}`;
    if (s.repeat === 'weekdays') return `Weekdays ${s.time}`;
    if (s.repeat === 'weekly') return `${DAYS.filter((d) => s.days.includes(d)).map((d) => DAY_LABEL[d]).join(', ')} ${s.time}`;
    return `Every ${s.every === 1 ? 'hour' : `${s.every} hours`} from ${s.from}`;
  }

  return { DAYS, DAY_LABEL, HOURS_EVERY, wallParts, wallToUtc, lastSlot, nextSlot, describeSchedule, hhmm };
});
