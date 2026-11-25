'use strict';
// The calendar on disk (spec §3): <vault>/.vaultos/calendar.json. Only VaultOS writes it: every write
// re-reads the file inside one queue, applies the change and lands atomically. A file that can't be
// parsed or fails validation is reported (CalendarDamaged) and never overwritten.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const { validateEntry, lastDate, todayIn } = require('../public/calendar-core');

const MAX_LIVE = 2000;
const ID_RE = /^c_[a-z2-7]{10}$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz234567';
const DAY_MS = 86400000;
const DELETED_KEEP_DAYS = 30;
const ACK_KEEP_DAYS = 60;
const USER_FIELDS = ['title', 'date', 'allDay', 'start', 'end', 'repeat', 'skip', 'ping', 'card', 'note', 'links', 'brief', 'agent'];
// Fields added after the first release (2026-11-19): an entry saved before then reads with these.
const LATER_DEFAULTS = { links: [], brief: '', agent: null };
const FULL = 'The calendar is full (2,000 upcoming entries)';

class CalendarDamaged extends Error {
  constructor(reason) {
    super(`calendar.json: ${reason}`);
    this.name = 'CalendarDamaged';
  }
}

const defaultRandomId = () => Array.from(crypto.randomBytes(10), (b) => ID_CHARS[b & 31]).join('');
const userFields = (e) => Object.fromEntries(USER_FIELDS.map((k) => [k, e[k]]));

function createCalendarStore(vaultDir, { tz, now = Date.now, randomId = defaultRandomId } = {}) {
  const file = path.join(vaultDir, '.vaultos', 'calendar.json');
  const iso = () => new Date(now()).toISOString();
  let lastDamage = null;

  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function readRaw() {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, entries: [], deleted: [], acks: {} };
      throw err;
    }
    let d;
    try { d = JSON.parse(text); } catch (err) { throw new CalendarDamaged(err.message); }
    if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.entries)) throw new CalendarDamaged('unsupported format (expected version 1 with an entries list)');
    if (d.deleted !== undefined && !Array.isArray(d.deleted)) throw new CalendarDamaged('"deleted" must be a list');
    if (d.acks !== undefined && (!d.acks || typeof d.acks !== 'object' || Array.isArray(d.acks))) throw new CalendarDamaged('"acks" must be an object');
    d.entries.forEach((e, i) => {
      const where = `entry ${i + 1}${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
      if (!e || typeof e !== 'object' || !ID_RE.test(e.id)) throw new CalendarDamaged(`${where}: bad id`);
      const v = validateEntry(e);
      if (!v.ok) {
        const [field, msg] = Object.entries(v.errors)[0];
        throw new CalendarDamaged(`${where}: ${field}: ${msg}`);
      }
    });
    const filled = (e) => {
      for (const [k, v] of Object.entries(LATER_DEFAULTS)) if (e[k] === undefined) e[k] = Array.isArray(v) ? [] : v;
      return e;
    };
    return { version: 1, entries: d.entries.map(filled), deleted: (d.deleted || []).map((e) => (e && typeof e === 'object' ? filled(e) : e)), acks: d.acks || {} };
  }

  async function read() {
    try {
      const d = await readRaw();
      lastDamage = null;
      return d;
    } catch (err) {
      if (err instanceof CalendarDamaged) lastDamage = err.message;
      throw err;
    }
  }

  function housekeep(d) {
    const t = now();
    d.deleted = d.deleted.filter((e) => !(t - Date.parse(e.deletedAt) > DELETED_KEEP_DAYS * DAY_MS));
    for (const [k, a] of Object.entries(d.acks)) if (!a || t - Date.parse(a.at) > ACK_KEEP_DAYS * DAY_MS) delete d.acks[k];
  }
  async function write(d) {
    housekeep(d);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify(d, null, 2) + '\n');
  }

  // Entries that still have a date today or later (past entries don't count towards the cap).
  function liveCount(entries) {
    const today = todayIn(tz(), now());
    return entries.filter((e) => { const l = lastDate(e); return l === null || l >= today; }).length;
  }
  const isLive = (e) => { const l = lastDate(e); return l === null || l >= todayIn(tz(), now()); };

  // input → { ok: true, entry } | { ok: false, errors } | { ok: false, refused }.
  // opts.guard(entries) -> message|null runs inside the queue (the agents' rate limits).
  // opts.prepare(entries, data) -> { input } | { refused } runs there too, after guard, and may change the input
  // (an automation's reminder: the duplicate check and the free slot are decided against what's on disk now).
  function create(input, who, { guard, prepare } = {}) {
    return serial(async () => {
      const d = await read();
      const refused = guard ? guard(d.entries) : null;
      if (refused) return { ok: false, refused };
      if (prepare) {
        const p = prepare(d.entries, d);
        if (p.refused) return { ok: false, refused: p.refused };
        input = p.input;
      }
      const v = validateEntry(input);
      if (!v.ok) return { ok: false, errors: v.errors };
      if (isLive(v.entry) && liveCount(d.entries) >= MAX_LIVE) return { ok: false, refused: FULL };
      let id;
      do id = `c_${randomId()}`; while (d.entries.some((e) => e.id === id) || d.deleted.some((e) => e.id === id));
      const at = iso();
      const entry = { id, ...v.entry, created: { at, by: who }, updated: { at, by: who } };
      d.entries.push(entry);
      await write(d);
      return { ok: true, entry };
    });
  }

  // changes are merged over the entry's user fields, then validated. null = no such entry.
  function update(id, changes, who) {
    return serial(async () => {
      const d = await read();
      const i = d.entries.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const old = d.entries[i];
      const v = validateEntry({ ...userFields(old), ...(changes || {}) });
      if (!v.ok) return { ok: false, errors: v.errors };
      if (isLive(v.entry) && !isLive(old) && liveCount(d.entries) >= MAX_LIVE) return { ok: false, refused: FULL };
      const entry = { id, ...v.entry, created: old.created, updated: { at: iso(), by: who } };
      d.entries[i] = entry;
      await write(d);
      return { ok: true, entry };
    });
  }

  function skip(id, date, who) {
    return serial(async () => {
      const d = await read();
      const i = d.entries.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const old = d.entries[i];
      const v = validateEntry({ ...userFields(old), skip: [...old.skip, date] });
      if (!v.ok) return { ok: false, errors: v.errors };
      const entry = { id, ...v.entry, created: old.created, updated: { at: iso(), by: who } };
      d.entries[i] = entry;
      await write(d);
      return { ok: true, entry };
    });
  }

  // → the entry as it went into Recently deleted, or null.
  function remove(id, who) {
    return serial(async () => {
      const d = await read();
      const i = d.entries.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const [old] = d.entries.splice(i, 1);
      const gone = { ...old, deletedAt: iso(), deletedBy: who };
      d.deleted.push(gone);
      await write(d);
      return gone;
    });
  }

  function restore(id, who) {
    return serial(async () => {
      const d = await read();
      const i = d.deleted.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const { deletedAt, deletedBy, ...rest } = d.deleted[i];   // eslint-disable-line no-unused-vars
      if (isLive(rest) && liveCount(d.entries) >= MAX_LIVE) return { ok: false, refused: FULL };
      const entry = { ...rest, updated: { at: iso(), by: who } };
      d.deleted.splice(i, 1);
      d.entries.push(entry);
      await write(d);
      return { ok: true, entry };
    });
  }

  // state: done | dismissed | snoozed; until (ISO) is stored for snoozed only. A done or dismissed ack is
  // final: two devices acting on one reminder at once can't bring it back by snoozing after the other's Done.
  function ack(keys, state, until, who) {
    return serial(async () => {
      const d = await read();
      const at = iso();
      for (const k of keys) {
        const old = d.acks[k];
        if (old && (old.state === 'done' || old.state === 'dismissed')) continue;
        d.acks[k] = state === 'snoozed' ? { state, until, at, by: who } : { state, at, by: who };
      }
      await write(d);
    });
  }

  return { read, create, update, skip, remove, restore, ack, damaged: () => lastDamage, file };
}

module.exports = { createCalendarStore, CalendarDamaged, MAX_LIVE, ID_RE, USER_FIELDS, userFields };
