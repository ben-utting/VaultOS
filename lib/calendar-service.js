'use strict';
// The calendar glued to the server (spec §6): the store over the server's settings and boards, the
// /api/calendar routes for the browser, and `view` — the shapes and actions the agent API shares
// (lib/calendar-agent-api.js). server.js hands in what it owns as deps and mounts `router` behind its
// sign-in gate. With Calendar off every route answers 404 and nothing in calendar.json is touched.
const express = require('express');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCalendarStore, CalendarDamaged } = require('./calendar-store');
const { installManagedSkill } = require('./skill-install');
const { parseFrontmatter } = require('./task-file');
const { agentLabelFromNames } = require('./agents');
const { createCalendarAgentApi } = require('./calendar-agent-api');
const CC = require('../public/calendar-core');
const { wallParts } = require('../public/automation-core');

const { KEY_RE } = CC;
const RANGE_MAX_DAYS = 62;
const COMING_DAYS = 62;
const PICKER_MAX = 20;
const OFF = 'The calendar is switched off';
const OFF_TERM = 'The calendar is switched off in VaultOS Settings → Features.';
const NO_CARD = 'No card at that path';
const PING_GONE = "That ping time has already passed, so it won't ping.";
const ME = { kind: 'person' };

const damagedMessage = (err) => `VaultOS can't read .vaultos/calendar.json: ${err.message.replace(/^calendar\.json: /, '').replace(/\.$/, '')}. Nothing will be changed until it's fixed.`;
const normRel = (rel) => String(rel).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
const byName = (who) => (who && who.kind === 'agent' ? who.agent || 'An agent' : '');

function createCalendarService(deps) {
  const {
    vaultDir, settings, terminalEnv, boards, resolveWorkspace, scanAll, safeVaultPath,
    canWrite = () => false, profiles = {}, termCmd = () => '', now = Date.now,
  } = deps;
  const live = () => !!(settings() && settings().features.calendar);
  const tz = () => (settings() ? settings().today.timezone : 'UTC');
  const store = createCalendarStore(vaultDir, { tz, now });

  // ---------- Cards ----------
  // A folder means its task.md ("--card Work/1. a/01-x").
  function resolveCardArg(rel) {
    if (typeof rel !== 'string' || !rel.trim()) return rel;
    const r = normRel(rel.trim());
    return path.posix.basename(r) === 'task.md' ? r : `${r}/task.md`;
  }
  // null when rel is a task.md inside the vault, else the field error.
  async function cardError(rel) {
    if (typeof rel !== 'string' || path.posix.basename(rel) !== 'task.md') return NO_CARD;
    try {
      const full = await safeVaultPath(rel);
      const st = await fsp.stat(full);
      return st.isFile() ? null : NO_CARD;
    } catch {
      return NO_CARD;
    }
  }
  const boardOf = (rel) => { const top = rel.split('/')[0]; const b = boards().find((x) => x.dir === top); return b ? b.key : null; };
  async function cardInfo(rel) {
    const info = { path: rel, title: path.posix.basename(path.posix.dirname(rel)) || rel, exists: false, board: boardOf(rel) };
    try {
      const raw = await fsp.readFile(await safeVaultPath(rel), 'utf8');
      const t = parseFrontmatter(raw).meta.title;
      return { ...info, title: typeof t === 'string' && t.trim() ? t.trim() : info.title, exists: true };
    } catch {
      return info;
    }
  }
  // Card titles, read once per request.
  async function cardsFor(entries) {
    const map = new Map();
    for (const e of entries) if (e.card && !map.has(e.card)) map.set(e.card, await cardInfo(e.card));
    return map;
  }

  // ---------- Shapes ----------
  function occurrenceView(entry, date, cards) {
    return {
      entryId: entry.id, date, title: entry.title, allDay: entry.allDay, start: entry.start, end: entry.end,
      repeat: entry.repeat, repeatText: CC.describeRepeat(entry), ping: entry.ping,
      card: entry.card ? cards.get(entry.card) || null : null, note: entry.note, created: entry.created, updated: entry.updated,
    };
  }
  function entryView(entry, cards) {
    return { ...entry, repeatText: CC.describeRepeat(entry), card: entry.card ? cards.get(entry.card) || null : null };
  }
  function dueView(item, entry, cards) {
    return {
      key: item.key, entryId: item.entryId, date: item.date, title: entry.title, pingAt: new Date(item.pingAt).toISOString(),
      dueSince: new Date(item.dueSince).toISOString(),
      start: entry.start, allDay: entry.allDay, card: entry.card ? cards.get(entry.card) || null : null,
      by: byName(entry.created && entry.created.by), missedEarlier: item.missedEarlier,
    };
  }
  const order = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1)
    || String(a.start || '').localeCompare(String(b.start || ''))
    || a.title.localeCompare(b.title);
  async function occurrencesIn(entries, from, to) {
    const hits = [];
    for (const e of entries) for (const date of CC.occurrences(e, from, to)) hits.push([e, date]);
    const cards = await cardsFor(hits.map(([e]) => e));
    return hits.map(([e, date]) => occurrenceView(e, date, cards)).sort(order);
  }
  const nowWall = () => {
    const w = wallParts(now(), tz());
    return `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
  };

  // ---------- Reads ----------
  // from/to: YYYY-MM-DD, at most 62 days; defaults today … today+13.
  function checkRange(from, to) {
    if (!CC.isDate(from) || !CC.isDate(to)) return 'from and to must be dates (YYYY-MM-DD)';
    const span = CC.daysBetween(from, to);
    if (span < 0) return 'to must not be before from';
    if (span >= RANGE_MAX_DAYS) return `At most ${RANGE_MAX_DAYS} days at a time`;
    return null;
  }
  async function range(from, to) {
    const d = await store.read();
    const today = CC.todayIn(tz(), now());
    const monday = CC.mondayOf(today);
    let week = 0;
    let todayCount = 0;
    for (const e of d.entries) {
      todayCount += CC.occurrences(e, today, today).length;
      week += CC.occurrences(e, monday, CC.addDays(monday, 6)).length;
    }
    return { timezone: tz(), now: new Date(now()).toISOString(), counts: { today: todayCount, week }, occurrences: await occurrencesIn(d.entries, from, to) };
  }
  async function due() {
    let d;
    try { d = await store.read(); } catch (err) {
      if (err instanceof CalendarDamaged) return { timezone: tz(), count: 0, items: [], error: damagedMessage(err) };
      throw err;
    }
    const items = CC.dueItems(d.entries, d.acks, tz(), now());
    const byId = new Map(d.entries.map((e) => [e.id, e]));
    const cards = await cardsFor(items.map((i) => byId.get(i.entryId)));
    return { timezone: tz(), count: items.length, items: items.map((i) => dueView(i, byId.get(i.entryId), cards)) };
  }
  async function getEntry(id) {
    const d = await store.read();
    const e = d.entries.find((x) => x.id === id);
    return e ? entryView(e, await cardsFor([e])) : null;
  }
  async function deleted() {
    const d = await store.read();
    const list = [...d.deleted].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    const cards = await cardsFor(list);
    return list.map((e) => entryView(e, cards));
  }
  // The rest of today (not yet over) in time order, and the next occurrence after today within 62 days.
  async function coming() {
    const d = await store.read();
    const today = CC.todayIn(tz(), now());
    const hm = nowWall();
    const todays = (await occurrencesIn(d.entries, today, today)).filter((o) => o.allDay || (o.end || o.start) >= hm);
    const later = await occurrencesIn(d.entries, CC.addDays(today, 1), CC.addDays(today, COMING_DAYS));
    return { timezone: tz(), now: new Date(now()).toISOString(), today: todays, next: later[0] || null };
  }
  async function searchCards(q) {
    const needle = String(q || '').trim().toLowerCase();
    const out = [];
    for (const b of boards()) {
      let tasks;
      try { tasks = await scanAll(resolveWorkspace(b.key).dir); } catch { continue; }
      for (const t of tasks) if (!needle || String(t.title).toLowerCase().includes(needle)) out.push({ path: t.path, title: t.title, board: b.key, updated: t.updated || '' });
    }
    out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.title.localeCompare(b.title));
    return out.slice(0, PICKER_MAX).map(({ updated, ...c }) => c);   // eslint-disable-line no-unused-vars
  }

  // ---------- Writes ({ status, body }, shared with the agent API) ----------
  const answer = (r, notFound = 'No such entry') => {
    if (r === null) return { status: 404, body: { error: notFound } };
    if (r.ok) {
      // A ping that has already gone never fires (pings before an entry was saved don't count, spec §4.2): say so,
      // so neither the person nor the agent is left waiting for it.
      const gone = r.entry.ping && CC.nextPingAt(r.entry, tz(), now()) === null;
      return { status: 200, body: gone ? { entry: r.entry, warning: PING_GONE } : { entry: r.entry } };
    }
    if (r.refused) return { status: 400, body: { error: r.refused } };
    return { status: 400, body: { error: 'Some fields need fixing', errors: r.errors } };
  };
  // A card that's set or changed must be a task.md in the vault; an unchanged (perhaps stale) one is left alone.
  async function withCard(input, oldCard) {
    if (!input || typeof input !== 'object' || !('card' in input) || input.card === null || input.card === '') return { input };
    const card = resolveCardArg(input.card);
    if (card === oldCard) return { input: { ...input, card } };
    const err = await cardError(card);
    return err ? { error: { status: 400, body: { error: 'Some fields need fixing', errors: { card: err } } } } : { input: { ...input, card } };
  }
  async function create(input, who, opts) {
    const c = await withCard(input, undefined);
    if (c.error) return c.error;
    return answer(await store.create(c.input, who, opts));
  }
  async function update(id, changes, who) {
    const d = await store.read();
    const old = d.entries.find((e) => e.id === id);
    if (!old) return answer(null);
    const c = await withCard(changes, old.card);
    if (c.error) return c.error;
    return answer(await store.update(id, c.input, who));
  }
  const skip = async (id, date, who) => answer(await store.skip(id, date, who));
  async function remove(id, who) {
    const gone = await store.remove(id, who);
    return gone ? { status: 200, body: { entry: gone } } : answer(null);
  }
  const restore = async (id, who) => answer(await store.restore(id, who), 'Nothing in Recently deleted with that id');

  // Done, Dismiss or Snooze on a due item; acts on the missed occurrences folded into it too (spec §4.2).
  async function ackDue(key, action, forChoice, who) {
    const m = KEY_RE.exec(String(key || ''));
    if (!m || !['done', 'dismiss', 'snooze'].includes(action)) return { status: 404, body: { error: 'No such reminder' } };
    let until = null;
    if (action === 'snooze') {
      const t = CC.snoozeUntil(forChoice, tz(), now());
      if (t === null) return { status: 400, body: { error: 'Snooze for 10m, 1h or tomorrow', errors: { for: 'Use 10m, 1h, tomorrow, or Nm / Nh up to 24 hours' } } };
      until = new Date(t).toISOString();
    }
    const d = await store.read();
    const entry = d.entries.find((e) => e.id === m[1]);
    const ack = d.acks[key];
    if (!entry || (!ack && !CC.occurrences(entry, m[2], m[2]).length)) return { status: 404, body: { error: 'No such reminder' } };
    if (ack && (ack.state === 'done' || ack.state === 'dismissed')) return { status: 200, body: { ok: true } };
    const item = CC.dueItems(d.entries, d.acks, tz(), now()).find((i) => i.key === key);
    const earlier = item ? item.earlierKeys : [];
    if (action === 'snooze') {
      await store.ack([key], 'snoozed', until, who);
      if (earlier.length) await store.ack(earlier, 'dismissed', null, who);
      return { status: 200, body: { ok: true, until } };
    }
    await store.ack([key, ...earlier], action === 'done' ? 'done' : 'dismissed', null, who);
    return { status: 200, body: { ok: true } };
  }

  // ---------- Browser routes ----------
  const router = express.Router();
  router.use('/calendar', (req, res, next) => (live() ? next() : res.status(404).json({ error: OFF })));
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof CalendarDamaged) return res.status(503).json({ error: damagedMessage(err) });
      console.error('calendar route failed:', err && err.message);
      res.status(500).json({ error: 'Something went wrong with the calendar' });
    }
  };
  const write = (fn) => route(async (req, res) => {
    if (!canWrite(req)) return res.status(401).json({ error: 'Sign in to change the calendar' });
    const r = await fn(req, res);
    res.status(r.status).json(r.body);
  });

  router.get('/calendar', route(async (req, res) => {
    const today = CC.todayIn(tz(), now());
    const from = req.query.from === undefined ? today : String(req.query.from);
    const to = req.query.to === undefined ? CC.addDays(from, 13) : String(req.query.to);
    const bad = checkRange(from, to);
    if (bad) return res.status(400).json({ error: bad });
    res.json(await range(from, to));
  }));
  router.get('/calendar/entry/:id', route(async (req, res) => {
    const e = await getEntry(req.params.id);
    return e ? res.json({ entry: e }) : res.status(404).json({ error: 'No such entry' });
  }));
  router.post('/calendar/entry', write((req) => create(req.body || {}, ME)));
  router.put('/calendar/entry/:id', write((req) => update(req.params.id, req.body || {}, ME)));
  router.delete('/calendar/entry/:id', write((req) => remove(req.params.id, ME)));
  router.post('/calendar/entry/:id/skip', write((req) => skip(req.params.id, (req.body || {}).date, ME)));
  router.get('/calendar/deleted', route(async (req, res) => res.json({ entries: await deleted() })));
  router.post('/calendar/deleted/:id/restore', write((req) => restore(req.params.id, ME)));
  router.get('/calendar/due', route(async (req, res) => res.json(await due())));
  router.post('/calendar/due/:key/:action', write((req) => ackDue(req.params.key, req.params.action, (req.body || {}).for, ME)));
  router.get('/calendar/cards', route(async (req, res) => res.json({ cards: await searchCards(req.query.q) })));
  router.get('/calendar/coming', route(async (req, res) => res.json(await coming())));
  router.all(/^\/calendar(\/.*)?$/, (req, res) => res.status(404).json({ error: 'Not found' }));

  // The vaultos-calendar skill for the agents in the terminals (spec §8): written while Calendar is on and the
  // machine allows terminals. Switching Calendar off leaves the copies; the command then says it's off.
  const SKILL_DIR = path.join(__dirname, '..', 'skills', 'vaultos-calendar');
  async function sync() {
    if (!live() || !terminalEnv) return;
    try {
      const r = await installManagedSkill({ srcDir: SKILL_DIR, name: 'vaultos-calendar', home: process.env.HOME || os.homedir() });
      if (r.written.length) console.log(`calendar: skill written (${r.written.length} files)`);
    } catch (err) {
      console.error('calendar: installing the skill failed:', err && err.message);
    }
  }
  async function boot() { await sync(); }

  const view = {
    tz, store, occurrencesIn, dueView, range, due, coming, getEntry, deleted, checkRange, cardError, resolveCardArg,
    create, update, skip, remove, restore, ackDue,
  };

  // ---------- Terminal routes for agents (`vaultos-calendar`, spec §7) ----------
  // server.js mounts termRouter at /api/term/calendar behind its terminal-token check and sets req.term.
  const agentApi = createCalendarAgentApi({ view, tz, now });
  const COMMANDS = ['today', 'list', 'show', 'add', 'edit', 'skip', 'delete', 'deleted', 'restore', 'due', 'done', 'dismiss', 'snooze'];
  const termRouter = express.Router();
  termRouter.post('/:command', async (req, res) => {
    const name = req.params.command;
    if (!COMMANDS.includes(name)) return res.status(404).json({ error: 'No such command' });
    if (!live()) return res.status(403).json({ error: OFF_TERM });
    const b = req.body || {};
    const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
    // Which agent is asking, for the tags: the command's process ancestors, then the terminal's foreground process.
    const label = agentLabelFromNames([...(Array.isArray(b.agentHint) ? b.agentHint.slice(0, 24) : []), ...(req.term ? [termCmd(req.term)] : [])], profiles);
    try {
      const r = await agentApi[name](args, label);
      res.status(r.status).json(r.body);
    } catch (err) {
      if (err instanceof CalendarDamaged) return res.status(503).json({ error: damagedMessage(err) });
      console.error('calendar terminal route failed:', err && err.message);
      res.status(500).json({ error: 'Something went wrong with the calendar' });
    }
  });

  return { router, termRouter, live, sync, boot, view };
}

module.exports = { createCalendarService, damagedMessage, OFF_TERM };
