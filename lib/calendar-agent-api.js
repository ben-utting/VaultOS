'use strict';
// What an agent in a VaultOS terminal may do with the calendar (spec §7): everything the person can, tagged
// with the agent's name, within 30 creates and 20 deletes per rolling hour across all terminals (in memory;
// a restart starts the count again). The service's `view` holds every rule; this file resolves the
// command's words (today, tomorrow, an entry id for its due item) and counts. Every function answers
// { status, body } for the terminal routes to send as is.
const CC = require('../public/calendar-core');
const { wallParts } = require('../public/automation-core');

const { KEY_RE } = CC;

const CREATES_PER_HOUR = 30;
const DELETES_PER_HOUR = 20;
const HOUR_MS = 3600 * 1000;
const LIST_DAYS = 14;
const RATE = 'Too many calendar changes from agents in the last hour';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createCalendarAgentApi({ view, tz, now = Date.now }) {
  const fail = (status, error, errors) => ({ status, body: errors ? { error, errors } : { error } });
  const who = (label) => ({ kind: 'agent', agent: label || 'An agent' });
  const today = () => CC.todayIn(tz(), now());
  // 'today' | 'tomorrow' in the VaultOS time zone; anything else is left for validation to judge.
  const day = (v) => (v === 'today' ? today() : v === 'tomorrow' ? CC.addDays(today(), 1) : v);
  function words(x) {
    const out = { ...x };
    if ('date' in out) out.date = day(out.date);
    if (isObj(out.repeat) && 'until' in out.repeat) out.repeat = { ...out.repeat, until: day(out.repeat.until) };
    return out;
  }

  // Rolling-hour limits. A call takes its slot before it awaits anything (so parallel calls can't all slip
  // under the limit) and gives it back if it wasn't accepted.
  const used = { create: [], delete: [] };
  const LIMIT = { create: CREATES_PER_HOUR, delete: DELETES_PER_HOUR };
  async function limited(kind, fn) {
    const cutoff = now() - HOUR_MS;
    used[kind] = used[kind].filter((t) => t > cutoff);
    if (used[kind].length >= LIMIT[kind]) return fail(429, RATE);
    const slot = now();
    used[kind].push(slot);
    let r;
    try { r = await fn(); } finally {
      if (!r || r.status !== 200) { const i = used[kind].indexOf(slot); if (i >= 0) used[kind].splice(i, 1); }
    }
    return r;
  }

  const idOf = (a) => (typeof a.id === 'string' ? a.id : '');

  async function show(a = {}) {
    const e = await view.getEntry(idOf(a));
    return e ? { status: 200, body: { entry: e } } : fail(404, 'No such entry');
  }
  function add(a = {}, label) {
    if (!isObj(a.entry)) return fail(400, 'Some fields need fixing', { entry: 'Send the entry as an object (title, date, time …)' });
    return limited('create', () => view.create(words(a.entry), who(label)));
  }
  function edit(a = {}, label) {
    return view.update(idOf(a), words(isObj(a.changes) ? a.changes : {}), who(label));
  }
  const skip = (a = {}, label) => view.skip(idOf(a), day(a.date), who(label));
  const remove = (a = {}, label) => limited('delete', () => view.remove(idOf(a), who(label)));
  const restore = (a = {}, label) => view.restore(idOf(a), who(label));
  // Clear one occurrence (card 84): a one-off goes to Recently deleted, so it counts towards the delete limit.
  async function clear(a = {}, label) {
    const e = (await view.store.read()).entries.find((x) => x.id === idOf(a));
    const date = a.date === undefined ? undefined : day(a.date);
    if (e && !e.repeat) return limited('delete', () => view.clear(idOf(a), date, who(label)));
    return view.clear(idOf(a), date, who(label));
  }
  // The briefing for an agent opened from this reminder; date 'today' | 'tomorrow' | YYYY-MM-DD | none (the next one).
  const brief = (a = {}) => view.brief(idOf(a), a.date === undefined ? undefined : day(a.date));
  const deleted = async () => ({ status: 200, body: { entries: await view.deleted() } });
  const due = async () => ({ status: 200, body: await view.due() });

  // from/to default to today … today + 13; at most 62 days; search = a case-insensitive title, note or focus substring.
  async function list(a = {}) {
    const from = a.from === undefined ? today() : day(a.from);
    const to = a.to === undefined ? CC.addDays(CC.isDate(from) ? from : today(), LIST_DAYS - 1) : day(a.to);
    const bad = view.checkRange(from, to);
    if (bad) return fail(400, bad);
    const d = await view.store.read();
    const needle = typeof a.search === 'string' ? a.search.trim().toLowerCase() : '';
    const entries = needle ? d.entries.filter((e) => `${e.title}\n${e.note}\n${e.brief || ''}`.toLowerCase().includes(needle)) : d.entries;
    const days = [];
    for (const o of await view.occurrencesIn(entries, from, to)) {
      const last = days[days.length - 1];
      if (last && last.date === o.date) last.occurrences.push(o);
      else days.push({ date: o.date, occurrences: [o] });
    }
    return { status: 200, body: { from, to, days } };
  }

  async function todayView() {
    const w = wallParts(now(), tz());
    const date = today();
    const d = await view.store.read();
    return {
      status: 200,
      body: {
        now: { date, time: `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`, timezone: tz(), weekday: CC.DAY_LONG[CC.weekday(date)] },
        entries: await view.occurrencesIn(d.entries, date, date),
        due: (await view.due()).items,
      },
    };
  }

  // target: a due key (c_…@YYYY-MM-DD), or an entry id meaning that entry's listed due item.
  async function keyFor(target) {
    const t = typeof target === 'string' ? target.trim() : '';
    if (KEY_RE.test(t)) return { key: t };
    const item = (await view.due()).items.find((i) => i.entryId === t);
    return item ? { key: item.key } : { error: fail(404, t ? 'Nothing due for that entry' : 'Say which reminder (an id or a key)') };
  }
  const acting = (action) => async (a = {}, label) => {
    const k = await keyFor(a.target);
    return k.error || view.ackDue(k.key, action, a.for, who(label));
  };

  return {
    today: todayView, list, show, add, edit, skip, remove, delete: remove, deleted, restore, due, brief, clear,
    done: acting('done'), dismiss: acting('dismiss'), snooze: acting('snooze'),
  };
}

module.exports = { createCalendarAgentApi, CREATES_PER_HOUR, DELETES_PER_HOUR };
