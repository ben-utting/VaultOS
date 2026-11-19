'use strict';

// ========================================================================
// CalendarCore — the calendar rules the server (validation, what's due) and
// the browser (the views, the panel) must answer the same way
// (window.CalendarCore; also a Node module for lib/ and the tests).
// Every date is a 'YYYY-MM-DD' string and every time an 'HH:MM' wall-clock
// time in one IANA zone (the VaultOS time zone). Date arithmetic works on the
// date string alone (UTC calendar maths), never on local Date getters.
// No I/O and no clock of its own: callers pass `now`.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f(require('./automation-core'));
  else root.CalendarCore = f(root.AutomationCore);
})(typeof self !== 'undefined' ? self : this, function (AutomationCore) {
  const DAY_MS = 86400000;
  const MIN_MS = 60000;
  const TITLE_MAX = 120;
  const NOTE_MAX = 4000;
  const LINKS_MAX = 10;
  const LINK_MAX = 500;
  const BRIEF_MAX = 500;
  // The built-in agents an entry may name (lib/agents.js PROFILES; a test keeps the two the same).
  const AGENT_IDS = ['claude', 'cursor', 'pi', 'codex', 'antigravity', 'copilot', 'opencode', 'kilo'];
  const SKIP_MAX = 500;
  const CARD_MAX = 1024;
  const PINGS = ['start', '5m', '10m', '15m', '30m', '1h', '1d'];
  const ALL_DAY_PINGS = ['start', '1d'];
  const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
  const DUE_WINDOW_DAYS = 30;
  const ALL_DAY_TIME = '08:00';
  const SNOOZE_TOMORROW = '09:00';
  const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const KEY_RE = /^(c_[a-z2-7]{10})@(\d{4}-\d{2}-\d{2})$/;   // a due item: <entry id>@<date>
  const PING_OFFSET_MIN = { start: 0, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60, '1d': 1440 };

  const DATE_MSG = 'Use YYYY-MM-DD (for example 2026-11-20)';
  const TIME_MSG = 'Use HH:MM (24-hour), for example 09:00 or 15:30';

  const pad = (n) => String(n).padStart(2, '0');

  // ---------- Dates ----------
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const parts = (date) => date.split('-').map(Number);
  const toDate = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  function addDays(date, n) {
    const [y, m, d] = parts(date);
    return toDate(new Date(Date.UTC(y, m - 1, d + n)));
  }
  function weekday(date) {
    const [y, m, d] = parts(date);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  }
  const mondayOf = (date) => addDays(date, -weekday(date));
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isLeap = (y) => daysInMonth(y, 2) === 29;
  function todayIn(tz, nowMs) {
    const w = AutomationCore.wallParts(nowMs, tz);
    return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  }
  // Whole days from a to b (b − a).
  function daysBetween(a, b) {
    const [ay, am, ad] = parts(a);
    const [by, bm, bd] = parts(b);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
  }
  // The instant the wall clock in tz reads `date time`.
  function wallMs(date, time, tz) {
    const [y, m, d] = parts(date);
    const [h, mi] = time.split(':').map(Number);
    return AutomationCore.wallToUtc(y, m, d, h, mi, tz);
  }

  // ---------- Validation ----------
  // One line: tabs and line breaks become spaces, other control characters go.
  const oneLine = (s) => s.replace(/[\t\n\r\v\f]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const noteText = (s) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

  // A link is a web address, or a vault-relative path: no leading slash, no '..' segment, no control characters.
  function isLink(s) {
    if (typeof s !== 'string' || !s || s.length > LINK_MAX || /[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/^https?:\/\/\S+$/i.test(s)) return true;
    if (s.includes('://') || /^[\/\\]/.test(s)) return false;
    return !s.split(/[\/\\]/).includes('..');
  }

  function validateRepeat(r, date, errors) {
    if (r === null || r === undefined) return null;
    if (typeof r !== 'object' || Array.isArray(r) || !REPEATS.includes(r.every)) {
      errors.repeat = 'Repeat must be none, daily, weekdays, weekly (with days), monthly or yearly';
      return null;
    }
    const out = { every: r.every };
    if (r.every === 'weekly') {
      const days = Array.isArray(r.days) ? r.days : [];
      if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        errors.repeat = 'A weekly repeat needs at least one day (0 = Monday … 6 = Sunday)';
        return null;
      }
      out.days = [...new Set(days)].sort((a, b) => a - b);
    }
    if (r.until !== undefined && r.until !== null) {
      if (!isDate(r.until)) { errors.repeat = `Repeat until: ${DATE_MSG}`; return null; }
      if (isDate(date) && r.until < date) { errors.repeat = 'Repeat until is before the first date'; return null; }
      out.until = r.until;
    }
    return out;
  }

  // input → { ok: true, entry } with exactly the user fields, normalised, or { ok: false, errors: { field: msg } }.
  function validateEntry(input) {
    const x = input && typeof input === 'object' ? input : {};
    const errors = {};
    const e = {};

    if (typeof x.title !== 'string') errors.title = 'A title is needed';
    else {
      e.title = oneLine(x.title);
      if (!e.title) errors.title = 'A title is needed';
      else if (e.title.length > TITLE_MAX) errors.title = `Keep the title to ${TITLE_MAX} characters`;
    }

    if (!isDate(x.date)) errors.date = DATE_MSG;
    e.date = x.date;

    if (x.allDay !== undefined && typeof x.allDay !== 'boolean') errors.allDay = 'All day must be true or false';
    e.allDay = x.allDay === true;

    if (e.allDay) {
      e.start = null;
      e.end = null;
    } else {
      if (x.start === undefined || x.start === null || x.start === '') errors.start = `A start time is needed unless it's all day. ${TIME_MSG}`;
      else if (!isTime(x.start)) errors.start = TIME_MSG;
      e.start = x.start === undefined ? null : x.start;
      if (x.end === undefined || x.end === null || x.end === '') e.end = null;
      else if (!isTime(x.end)) { errors.end = TIME_MSG; e.end = x.end; }
      else if (isTime(e.start) && x.end <= e.start) { errors.end = 'The end time must be after the start, on the same day'; e.end = x.end; }
      else e.end = x.end;
    }

    e.repeat = validateRepeat(x.repeat, x.date, errors);

    if (x.skip === undefined || x.skip === null) e.skip = [];
    else if (!Array.isArray(x.skip) || !x.skip.every(isDate)) { errors.skip = `Skipped dates: ${DATE_MSG}`; e.skip = []; }
    else {
      e.skip = [...new Set(x.skip)].sort();
      if (e.skip.length > SKIP_MAX) errors.skip = `At most ${SKIP_MAX} skipped dates`;
    }

    // Left out → a ping at the start (a reminder that never pings is rarely what's meant); null → no ping.
    const ping = x.ping === undefined ? 'start' : x.ping;
    const allowed = e.allDay ? ALL_DAY_PINGS : PINGS;
    if (ping !== null && !allowed.includes(ping)) {
      errors.ping = e.allDay
        ? 'All-day entries ping with start (08:00 on the day), 1d (08:00 the day before) or none'
        : 'Use none, start, 5m, 10m, 15m, 30m, 1h or 1d';
    }
    e.ping = ping;

    if (x.card === undefined || x.card === null || x.card === '') e.card = null;
    else if (typeof x.card !== 'string' || x.card.length > CARD_MAX || /[\u0000-\u001f]/.test(x.card)) { errors.card = 'No card at that path'; e.card = null; }
    else e.card = x.card.trim();

    if (x.note === undefined || x.note === null) e.note = '';
    else if (typeof x.note !== 'string') { errors.note = 'The note must be text'; e.note = ''; }
    else {
      e.note = noteText(x.note);
      if (e.note.length > NOTE_MAX) errors.note = `Keep the note to ${NOTE_MAX.toLocaleString('en-GB')} characters`;
    }

    if (x.links === undefined || x.links === null) e.links = [];
    else if (!Array.isArray(x.links)) { errors.links = 'Links must be a list'; e.links = []; }
    else {
      e.links = x.links.map((l) => (typeof l === 'string' ? l.trim() : l)).filter((l) => l !== '');
      const bad = e.links.findIndex((l) => !isLink(l));
      if (bad >= 0) errors.links = `Link ${bad + 1} isn't a web address or a vault path`;
      else if (e.links.length > LINKS_MAX) errors.links = `At most ${LINKS_MAX} links`;
    }

    if (x.brief === undefined || x.brief === null) e.brief = '';
    else if (typeof x.brief !== 'string') { errors.brief = 'The focus must be text'; e.brief = ''; }
    else {
      e.brief = oneLine(x.brief);
      if (e.brief.length > BRIEF_MAX) errors.brief = `Keep it to ${BRIEF_MAX} characters`;
    }

    if (x.agent === undefined || x.agent === null) e.agent = null;
    else if (!AGENT_IDS.includes(x.agent)) { errors.agent = 'Pick one of the built-in agents, or leave it on the default'; e.agent = null; }
    else e.agent = x.agent;

    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      entry: {
        title: e.title, date: e.date, allDay: e.allDay, start: e.start, end: e.end, repeat: e.repeat, skip: e.skip, ping: e.ping, card: e.card, note: e.note,
        links: e.links, brief: e.brief, agent: e.agent,
      },
    };
  }

  // 'daily' | 'weekdays' | 'monthly' | 'yearly' | 'none' | 'weekly:mon,wed' → repeat | null | { error }.
  function parseRepeatFlag(s) {
    const v = String(s || '').trim().toLowerCase();
    if (v === 'none') return null;
    if (['daily', 'weekdays', 'monthly', 'yearly'].includes(v)) return { every: v };
    const m = /^weekly:(.+)$/.exec(v);
    if (m) {
      const days = m[1].split(',').map((d) => DAY_NAMES.indexOf(d.trim()));
      if (days.every((d) => d >= 0)) return { every: 'weekly', days: [...new Set(days)].sort((a, b) => a - b) };
    }
    return { error: 'Use daily, weekdays, weekly:mon,wed (mon…sun), monthly, yearly or none' };
  }

  // ---------- Occurrences ----------
  function fallsOn(entry, date) {
    const r = entry.repeat;
    if (!r) return date === entry.date;
    switch (r.every) {
      case 'daily': return true;
      case 'weekdays': return weekday(date) < 5;
      case 'weekly': return r.days.includes(weekday(date));
      case 'monthly': {
        const [y, m, d] = parts(date);
        const want = parts(entry.date)[2];
        return d === Math.min(want, daysInMonth(y, m));
      }
      case 'yearly': {
        const [y, m, d] = parts(date);
        const [, wm, wd] = parts(entry.date);
        if (m !== wm) return false;
        return d === wd || (wm === 2 && wd === 29 && d === 28 && !isLeap(y));
      }
      default: return false;
    }
  }

  // The dates the entry falls on from `from` to `to` inclusive, ascending: minus skip, never before date, never after until.
  function occurrences(entry, from, to) {
    let a = from > entry.date ? from : entry.date;
    let b = to;
    if (!entry.repeat) b = entry.date < b ? entry.date : b;
    else if (entry.repeat.until && entry.repeat.until < b) b = entry.repeat.until;
    const out = [];
    if (a > b) return out;
    const skip = new Set(entry.skip || []);
    for (let d = a; d <= b; d = addDays(d, 1)) if (fallsOn(entry, d) && !skip.has(d)) out.push(d);
    return out;
  }

  // The last date the entry falls on, or null when it repeats forever.
  function lastDate(entry) {
    if (!entry.repeat) return entry.date;
    if (!entry.repeat.until) return null;
    const until = entry.repeat.until;
    const from = addDays(until, -800) > entry.date ? addDays(until, -800) : entry.date;
    const occ = occurrences(entry, from, until);
    return occ.length ? occ[occ.length - 1] : entry.date;
  }

  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }
  const shortDate = (date) => { const [, m, d] = parts(date); return `${d} ${MONTH_SHORT[m - 1]}`; };

  // "Every Wednesday", "Mon, Wed, Fri", "Weekdays", "Monthly on the 23rd", "Yearly on 4 Jun"; '' for none.
  function describeRepeat(entry) {
    const r = entry.repeat;
    if (!r) return '';
    let s;
    switch (r.every) {
      case 'daily': s = 'Every day'; break;
      case 'weekdays': s = 'Weekdays'; break;
      case 'weekly': s = r.days.length === 1 ? `Every ${DAY_LONG[r.days[0]]}` : r.days.map((d) => DAY_SHORT[d]).join(', '); break;
      case 'monthly': s = `Monthly on the ${ordinal(parts(entry.date)[2])}`; break;
      case 'yearly': s = `Yearly on ${shortDate(entry.date)}`; break;
      default: s = '';
    }
    if (r.until) s += ` until ${shortDate(r.until)} ${parts(r.until)[0]}`;
    return s;
  }

  // ---------- Pings and what's due ----------
  // The instant the occurrence on `date` pings, or null when the entry has no ping.
  function pingAt(entry, date, tz) {
    if (!entry.ping || !(entry.ping in PING_OFFSET_MIN)) return null;
    if (entry.allDay) return wallMs(entry.ping === '1d' ? addDays(date, -1) : date, ALL_DAY_TIME, tz);
    return wallMs(date, entry.start, tz) - PING_OFFSET_MIN[entry.ping] * MIN_MS;
  }

  // What's due now: per entry the latest due occurrence, with the earlier due ones folded into it.
  // Due = pinged at or before now, not before the entry was created, within the last 30 days, and not
  // acked done/dismissed. A date snoozed until later is skipped entirely (neither shows nor counts).
  function dueItems(entries, acks, tz, nowMs) {
    const a = acks || {};
    const today = todayIn(tz, nowMs);
    const from = addDays(today, -(DUE_WINDOW_DAYS + 1));
    const to = addDays(today, 1);
    const windowStart = nowMs - DUE_WINDOW_DAYS * DAY_MS;
    const out = [];
    for (const entry of entries) {
      if (!entry.ping) continue;
      const createdAt = Date.parse(entry.created && entry.created.at) || 0;
      const kept = [];
      for (const date of occurrences(entry, from, to)) {
        const p = pingAt(entry, date, tz);
        if (p === null || p > nowMs || p < createdAt || p <= windowStart) continue;
        const key = `${entry.id}@${date}`;
        const ack = a[key];
        if (ack && (ack.state === 'done' || ack.state === 'dismissed')) continue;
        if (ack && ack.state === 'snoozed' && !(Date.parse(ack.until) <= nowMs)) continue;
        // dueSince: when it (last) became due. A snooze that has run out makes it due again from its end, so a
        // device that toasted it before toasts it again (the browser keys its seen list on key + dueSince).
        kept.push({ key, date, p, since: ack && ack.state === 'snoozed' ? Math.max(p, Date.parse(ack.until)) : p });
      }
      if (!kept.length) continue;
      const last = kept[kept.length - 1];
      const earlierKeys = kept.slice(0, -1).reverse().map((k) => k.key);
      out.push({ key: last.key, entryId: entry.id, date: last.date, pingAt: last.p, dueSince: last.since, missedEarlier: earlierKeys.length, earlierKeys });
    }
    return out.sort((x, y) => y.pingAt - x.pingAt);
  }

  // The first ping still to come (after now), looking a little over a year ahead; null when none will.
  // Used to warn when an entry is saved with a ping that has already gone ("ping the day before", said today).
  function nextPingAt(entry, tz, nowMs) {
    if (!entry.ping) return null;
    const today = todayIn(tz, nowMs);
    for (const date of occurrences(entry, addDays(today, -1), addDays(today, 400))) {
      const p = pingAt(entry, date, tz);
      if (p !== null && p > nowMs) return p;
    }
    return null;
  }

  // '10m' | '1h' | 'tomorrow' | 'Nm' (1–1440) | 'Nh' (1–24) → the instant the snooze ends, or null.
  function snoozeUntil(choice, tz, nowMs) {
    const v = String(choice || '').trim().toLowerCase();
    if (v === 'tomorrow') return wallMs(addDays(todayIn(tz, nowMs), 1), SNOOZE_TOMORROW, tz);
    let m = /^(\d{1,4})m$/.exec(v);
    if (m) { const n = Number(m[1]); return n >= 1 && n <= 1440 ? nowMs + n * MIN_MS : null; }
    m = /^(\d{1,2})h$/.exec(v);
    if (m) { const n = Number(m[1]); return n >= 1 && n <= 24 ? nowMs + n * 60 * MIN_MS : null; }
    return null;
  }

  return {
    TITLE_MAX, NOTE_MAX, SKIP_MAX, LINKS_MAX, LINK_MAX, BRIEF_MAX, AGENT_IDS, isLink, PINGS, ALL_DAY_PINGS, REPEATS, DUE_WINDOW_DAYS, ALL_DAY_TIME, SNOOZE_TOMORROW,
    DAY_NAMES, DAY_SHORT, DAY_LONG, MONTH_SHORT, KEY_RE, DATE_MSG,
    isDate, isTime, addDays, weekday, mondayOf, daysInMonth, daysBetween, todayIn, wallMs,
    validateEntry, parseRepeatFlag, occurrences, lastDate, describeRepeat, pingAt, dueItems, nextPingAt, snoozeUntil,
  };
});
