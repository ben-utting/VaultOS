'use strict';
// Today mode's file store and payload builder. The vault is edited by hand and synced by
// Syncthing, so every write re-reads the file fresh inside a per-path queue and lands atomically.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const N = require('./today-note');
const S = require('./today-stats');
const T = require('./today-timer');

const QUOTE_LOOKBACK = 30;
const STREAK_LOOKBACK = 400;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// A timer target names what the session is for: 'focus', a goal habit's id, 'task:<text>' (a line of today's
// list) or 'board: <title>' (a Board task, from Today's Next). The label is the target without its prefix.
const TASK_T = /^task:\s*/;
const BOARD_T = /^board:\s*/;
const BOARD_MAX = 200;
const boardTitle = (t) => String(t).replace(BOARD_T, '').trim();
const prefixed = (t) => TASK_T.test(t) || BOARD_T.test(t);
const unprefix = (t) => (BOARD_T.test(t) ? boardTitle(t) : String(t).replace(TASK_T, ''));

function createToday({ dir, now = () => new Date(), quotes, timers = { set: setTimeout, clear: clearTimeout }, secondsPerMinute = 60, timeZone = 'Europe/London' }) {
  const timerFile = path.join(dir, '.timer.json');
  const todayDate = () => N.zonedDate(now(), timeZone);
  const habitsFile = path.join(dir, 'habits.md');
  const noteFile = (date) => path.join(dir, 'days', date.slice(0, 7), `${date}.md`);

  async function readRaw(file) {
    try { return await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  // Per-path promise chain. fn(raw) gets the file's current text (null when missing) and returns
  // the new text, or null/the same text for no change.
  const chains = new Map();
  const cache = new Map();   // path -> { mtimeMs, parsed }
  function edit(file, fn) {
    const run = async () => {
      const raw = await readRaw(file);
      const next = await fn(raw);
      if (next == null || next === raw) return raw;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      try { await atomicWrite(file, next); } finally { cache.delete(file); }
      return next;
    };
    const prev = chains.get(file) || Promise.resolve();
    const p = prev.then(run, run);
    const tail = p.catch(() => {});
    chains.set(file, tail);
    tail.then(() => { if (chains.get(file) === tail) chains.delete(file); });
    return p;
  }

  async function readDay(date) {
    const file = noteFile(date);
    let st;
    try { st = await fsp.stat(file); } catch (e) { if (e.code === 'ENOENT') { cache.delete(file); return null; } throw e; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.parsed;
    const raw = await readRaw(file);
    if (raw == null) return null;
    const parsed = N.parseDay(raw);
    cache.set(file, { mtimeMs: st.mtimeMs, parsed });
    return parsed;
  }

  async function loadHabits(canWrite) {
    let raw = await readRaw(habitsFile);
    if (raw == null) {
      if (!canWrite) return { habits: [], warnings: [] };
      raw = await edit(habitsFile, (cur) => (cur == null ? N.DEFAULT_HABITS_MD : null));
    }
    return N.parseHabits(raw);
  }

  // Latest note dated before `date`: list days/*/ and look back at most 400 days.
  async function findPrevDate(date) {
    const floor = N.addDays(date, -STREAK_LOOKBACK);
    let best = null;
    let months = [];
    try { months = await fsp.readdir(path.join(dir, 'days')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const m of months) {
      if (!/^\d{4}-\d{2}$/.test(m) || m > date.slice(0, 7)) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(dir, 'days', m)); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
      for (const f of files) {
        const d = f.slice(0, -3);
        if (f.endsWith('.md') && N.isISODate(d) && d < date && d >= floor && (!best || d > best)) best = d;
      }
    }
    return best;
  }

  // The one place a day note is created. Open tasks of the latest earlier note come along;
  // the caller marks them [>] in the source only after this note is written.
  async function createNote(date, quote) {
    const prevDate = await findPrevDate(date);
    let carried = [];
    if (prevDate) carried = N.rollover(await readRaw(noteFile(prevDate)) || '', prevDate).carried;
    const texts = carried.map((l) => N.parseDay(`## Tasks\n${l}\n`).tasks[0].text);
    return { md: N.newDay(date, { carried, quote }), prevDate: carried.length ? prevDate : null, texts };
  }

  // The quote is fetched before the note's queue is entered, so a slow ZenQuotes never holds up another
  // write, and it goes in only if the note still has no quote by then.
  async function ensureToday(date) {
    const day = await readDay(date);
    const quote = day && day.quote ? null : await quotes.today();
    let rolled = null;
    let movedTexts = [];
    await edit(noteFile(date), async (raw) => {
      if (raw == null) { const c = await createNote(date, quote); rolled = c.prevDate; movedTexts = c.texts; return c.md; }
      return quote && !N.parseDay(raw).quote ? N.setQuote(raw, quote) : null;
    });
    // New note first, source second: a crash between the two can only duplicate a task.
    if (rolled) await edit(noteFile(rolled), (raw) => (raw == null ? null : N.markMoved(raw, movedTexts)));
  }

  function checkDate(date, today) {
    if (!N.isISODate(date)) throw httpError(400, 'Invalid date');
    if (date > today) throw httpError(400, 'Date is in the future');
  }

  async function payload(date, { canWrite = false } = {}) {
    const today = todayDate();
    date = date === undefined ? today : date;
    checkDate(date, today);
    const { habits, warnings } = await loadHabits(canWrite && date === today);
    if (canWrite && date === today) await ensureToday(date);

    const ids = habits.map((h) => h.id);
    const day = await readDay(date);

    // Prefetch notes so the pure stats functions can read synchronously.
    const done = new Map();
    const load = async (d) => { if (!done.has(d)) { const p = await readDay(d); done.set(d, p ? p.done : null); } };
    const end = S.windowEnd(date, today);
    for (let i = 0; i < 7; i++) await load(N.addDays(end, -i));
    let alive = new Set(ids);
    for (let i = 0, d = today; i <= STREAK_LOOKBACK && alive.size; i++, d = N.addDays(d, -1)) {
      await load(d);
      if (d !== today) alive = new Set([...alive].filter((id) => (done.get(d) || []).includes(id)));
    }
    const doneOn = (d) => (done.has(d) ? done.get(d) : null);

    let quote = null;
    let quoteFallback = false;
    if (day && day.quote) quote = { ...day.quote, date };
    else {
      for (let i = 1; i <= QUOTE_LOOKBACK && !quote; i++) {
        const d = N.addDays(date, -i);
        const p = await readDay(d);
        if (p && p.quote) { quote = { ...p.quote, date: d }; quoteFallback = true; }
      }
    }

    const names = Object.fromEntries(habits.map((h) => [h.id, h.name]));
    const label = (target) => {
      if (target === 'focus') return 'Just focus';
      if (prefixed(target)) return unprefix(target);
      return names[target] || target;
    };
    const byTask = S.focusByTask(day);
    const todayDay = date === today ? day : await readDay(today);

    return {
      today, date, timeZone, serverNow: now().getTime(), habits, warnings,
      day: {
        exists: !!day,
        done: day ? day.done : [],
        tasks: day ? day.tasks.map((t) => ({ ...t, min: byTask[t.text] || 0 })) : [],
        focus: day ? day.focus.map((f) => ({ ...f, label: label(f.target) })) : [],
        quote, quoteFallback,
      },
      week: S.week(doneOn, end),
      streaks: S.streaks(doneOn, ids, today),
      focusByHabit: S.focusByHabit(day),
      summary: {
        done: todayDay ? todayDay.done.filter((id) => ids.includes(id)).length : 0,
        total: ids.length,
        focusMin: todayDay ? todayDay.focus.reduce((n, f) => n + f.min, 0) : 0,
      },
      timer: await timerView(names),
    };
  }

  async function setHabit(date, id, on) {
    const today = todayDate();
    checkDate(date, today);
    const { habits } = await loadHabits(true);
    const order = habits.map((h) => h.id);
    if (!order.includes(id)) throw httpError(404, 'Unknown habit');
    if (date === today) await ensureToday(date);
    await edit(noteFile(date), (raw) => N.setHabit(raw == null ? N.newDay(date, {}) : raw, id, !!on, order));
    return payload(date, { canWrite: true });
  }

  // Add, edit or remove a habit row in habits.md; answers with the payload for `date`.
  async function editHabits(date, { op, id, name, icon, goal } = {}) {
    checkDate(date, todayDate());
    if (!['add', 'update', 'remove'].includes(op)) throw httpError(400, 'Unknown habit operation');
    if (op !== 'add' && typeof id !== 'string') throw httpError(400, 'id is required');
    await edit(habitsFile, (raw) => {
      const md = raw == null ? N.DEFAULT_HABITS_MD : raw;
      if (op === 'add') return N.addHabit(md, { name, icon, goal }).md;
      if (op === 'update') return N.updateHabit(md, id, { name, icon, goal });
      return N.removeHabit(md, id);
    });
    return payload(date, { canWrite: true });
  }

  async function task(date, { op, text, index } = {}) {
    const today = todayDate();
    checkDate(date, today);
    if (!['add', 'toggle', 'delete'].includes(op)) throw httpError(400, 'Unknown task operation');
    if (op !== 'add' && !Number.isInteger(index)) throw httpError(400, 'index is required');
    if (op !== 'add' && typeof text !== 'string') throw httpError(400, 'text is required');
    if (op === 'add') N.cleanTaskText(text);
    if (date === today) await ensureToday(date);
    await edit(noteFile(date), (raw) => {
      if (op === 'add') return N.addTask(raw == null ? N.newDay(date, {}) : raw, text);
      if (raw == null) throw httpError(409, 'This day changed since you loaded it. Refreshed.');
      return op === 'toggle' ? N.toggleTask(raw, index, text) : N.deleteTask(raw, index, text);
    });
    return payload(date, { canWrite: true });
  }

  async function shuffleQuote() {
    const today = todayDate();
    if (!(await readDay(today))) throw httpError(400, "Today's note doesn't exist yet");
    const q = await quotes.random();
    if (!q) throw httpError(502, 'No quote available');
    await edit(noteFile(today), (raw) => (raw == null ? null : N.setQuote(raw, q)));
    return payload(today, { canWrite: true });
  }

  // ---------- Pomodoro ----------
  // The server owns the clock. State is one JSON file; every transition runs through `tchain` so a
  // user action and the completion callback can't interleave.
  let ts = null;          // in-memory timer state, loaded once
  let handle = null;
  let tchain = Promise.resolve();
  const nowMs = () => now().getTime();
  const serial = (fn) => { const p = tchain.then(fn, fn); tchain = p.catch(() => {}); return p; };

  async function loadTimer() {
    if (ts) return ts;
    let loaded = null;
    try {
      const j = JSON.parse(await readRaw(timerFile));
      if (j && typeof j === 'object' && ['idle', 'running', 'paused'].includes(j.state) && T.MINUTES[j.phase]
        && (j.state !== 'running' || Number.isFinite(j.endsAt)) && (j.state !== 'paused' || Number.isFinite(j.leftMs))) {
        loaded = { ...T.initial(todayDate()), ...j };
      }
    } catch { /* missing or corrupt: start fresh */ }
    if (!ts) ts = loaded || T.initial(todayDate());   // never replace state a transition or boot set meanwhile
    return ts;
  }

  async function saveTimer(next) {
    await fsp.mkdir(dir, { recursive: true });
    await atomicWrite(timerFile, JSON.stringify(next));
    ts = next;
  }

  function arm() {
    if (handle != null) { timers.clear(handle); handle = null; }
    if (!ts || ts.state !== 'running') return;
    const mine = ts.endsAt;
    handle = timers.set(() => { handle = null; return serial(() => finish(mine)).catch((e) => console.error('Today timer completion failed:', e.message)); },
      Math.max(0, ts.endsAt - nowMs()));
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  async function finish(expectEndsAt) {
    const cur = await loadTimer();
    if (cur.state !== 'running' || (expectEndsAt != null && cur.endsAt !== expectEndsAt)) return;   // stale callback
    const at = now();
    const { habits } = await loadHabits(true);
    const habit = (id) => habits.find((h) => h.id === id);
    const r = T.complete(cur, { nowMs: at.getTime(), today: todayDate() });
    let event;
    if (!r.logged) event = { kind: 'break-done', text: 'Break over.' };
    else {
      const start = new Date(r.logged.startedAt);
      const date = N.zonedDate(start, timeZone);
      const target = r.logged.target;
      const h = habit(target);
      const label = target === 'focus' ? 'Just focus' : prefixed(target) ? unprefix(target) : (h ? h.name : target);
      let text = `Session logged: ${r.logged.min} min on ${label}.`;
      if (date === todayDate()) await ensureToday(date);
      await edit(noteFile(date), (raw) => {
        let md = raw == null ? N.newDay(date, {}) : raw;
        const before = (S.focusByHabit(N.parseDay(md))[target]) || 0;
        const entry = { time: N.zonedTime(start, timeZone), min: r.logged.min, target };
        const last = N.parseDay(md).focus.slice(-1)[0];
        if (last && N.focusLine(last) === N.focusLine(entry)) return null;   // already logged before a crash
        md = N.appendFocus(md, entry);
        if (h && S.crossesGoal(before, before + r.logged.min, h.goal)) {
          md = N.setHabit(md, h.id, true, habits.map((x) => x.id));
          text = `${h.name} ticked. ${before + r.logged.min} of ${h.goal} minutes today.`;
        }
        return md;
      });
      event = { kind: 'focus-done', text };
    }
    const lastEvent = { id: ((cur.lastEvent && cur.lastEvent.id) || 0) + 1, kind: event.kind, at: at.toISOString(), text: event.text };
    await saveTimer({ ...r.state, lastEvent });
    arm();
  }

  async function timer(action, target) {
    await serial(async () => {
      const cur = await loadTimer();
      const today = todayDate();
      if (action === 'start' && target !== undefined && target !== null) {
        if (!(await validTarget(target, today))) throw httpError(400, 'Unknown timer target');
        target = target.startsWith('task:') ? `task:${target.replace(/^task:\s*/, '')}`
          : BOARD_T.test(target) ? `board: ${boardTitle(target)}` : target;
      } else if (action === 'start' && cur.phase === 'focus' && !(await validTarget(cur.target, today))) target = 'focus';
      else target = undefined;
      const next = T.apply(cur, action, { nowMs: nowMs(), today, target, spm: secondsPerMinute });
      await saveTimer(next);
      arm();
    });
    return payload(undefined, { canWrite: true });
  }

  async function validTarget(target, today) {
    if (typeof target !== 'string') return false;
    if (target === 'focus') return true;
    // A Board task isn't in the day note: any one-line title will do, as the Board shows it.
    if (BOARD_T.test(target)) {
      const title = boardTitle(target);
      return title.length > 0 && title.length <= BOARD_MAX && !/[\r\n]/.test(title);
    }
    if (/^task:/.test(target)) {
      const d = await readDay(today);
      const text = target.replace(/^task:\s*/, '');
      return !!d && d.tasks.some((t) => !t.done && !t.moved && t.text === text);
    }
    const h = (await loadHabits(false)).habits.find((x) => x.id === target);
    return !!h && h.goal != null;
  }

  async function timerView(names) {
    const s = await loadTimer();
    const n = nowMs();
    const t = s.target;
    const targetLabel = t === 'focus' ? 'Just focus' : prefixed(t) ? unprefix(t) : (names[t] || t);
    return {
      phase: s.phase, state: s.state, target: t, targetLabel,
      startedAt: s.startedAt, endsAt: s.endsAt,
      leftMs: s.state === 'running' ? Math.max(0, s.endsAt - n) : s.state === 'paused' ? s.leftMs : null,
      totalMs: T.durationMs(s.phase, secondsPerMinute),
      cycle: s.cycleDate === todayDate() ? s.cycle : 0, lastEvent: s.lastEvent,
    };
  }

  async function boot() {
    await serial(async () => {
      ts = null;   // boot always reads the file fresh
      const cur = await loadTimer();
      if (cur.state === 'running' && cur.endsAt <= nowMs()) await finish(cur.endsAt);
      else arm();
    });
  }

  // Cancel the pending completion (Today switched off at runtime). Safe with nothing pending
  // and safe twice; the saved timer state is left alone for the next boot.
  function stop() {
    if (handle != null) { timers.clear(handle); handle = null; }
  }

  return { payload, setHabit, editHabits, task, shuffleQuote, timer, boot, stop, edit, noteFile, readDay };
}

module.exports = { createToday, httpError };
