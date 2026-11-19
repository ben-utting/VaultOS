'use strict';
// The calendar's browser routes (spec §6): signed-in session, 404 while Calendar is off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const CC = require('../public/calendar-core');

const PASSWORD = 'correct horse battery';
const LON = 'Europe/London';
const call = async (base, method, url, { cookie, body, headers = {} } = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const today = () => CC.todayIn(LON, Date.now());
const ME = { kind: 'person' };
const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString();
const stored = (id, more = {}) => ({
  id, title: 'E', date: today(), allDay: false, start: '09:00', end: null, repeat: null, skip: [], ping: 'start', card: null, note: '',
  created: { at: daysAgoIso(10), by: ME }, updated: { at: daysAgoIso(10), by: ME }, ...more,
});

async function ready(t, { calendar = true, env = {}, bins = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-cal-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  // Stub agents on the login shell's PATH (the image's profile adds ~/.local/bin), so isInstalled finds them.
  const bin = path.join(d.home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\necho 1.0\n', { mode: 0o755 });
  if (bins.length) env = { PATH: `${bin}:${process.env.PATH}`, ...env };
  seedVault(d.vault, {});
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { TZ: LON, ...env } });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: LON } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  if (calendar) assert.equal((await call(base, 'POST', '/api/settings/features', { cookie, body: { calendar: true } })).status, 200);
  const file = path.join(d.vault, '.vaultos', 'calendar.json');
  const card = (rel, title) => {
    const f = path.join(d.vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `---\nid: x\ntitle: "${title || path.basename(path.dirname(f))}"\nstatus: in-progress\nupdated: 2026-11-01\n---\n\n## Goal\ng\n`);
    return f;
  };
  const seed = (entries, acks = {}) => fs.writeFileSync(file, JSON.stringify({ version: 1, entries, deleted: [], acks }));
  const person = (method, url, body) => call(base, method, url, { cookie, body });
  return { ...d, base, cookie, file, card, seed, person };
}

test('off: every calendar route answers 404', async (t) => {
  const s = await ready(t, { calendar: false });
  for (const [m, u, b] of [
    ['GET', '/api/calendar'], ['GET', '/api/calendar/entry/c_aaaaaaaaaa'], ['POST', '/api/calendar/entry', { title: 'x', date: today(), start: '09:00' }],
    ['PUT', '/api/calendar/entry/c_aaaaaaaaaa', { title: 'y' }], ['DELETE', '/api/calendar/entry/c_aaaaaaaaaa'],
    ['POST', '/api/calendar/entry/c_aaaaaaaaaa/skip', { date: today() }], ['GET', '/api/calendar/deleted'],
    ['POST', '/api/calendar/deleted/c_aaaaaaaaaa/restore'], ['GET', '/api/calendar/due'],
    ['POST', `/api/calendar/due/${encodeURIComponent(`c_aaaaaaaaaa@${today()}`)}/done`], ['GET', '/api/calendar/cards?q=a'], ['GET', '/api/calendar/coming'],
  ]) {
    const r = await s.person(m, u, b);
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.equal(r.body.error, 'The calendar is switched off');
  }
  assert.equal(fs.existsSync(s.file), false);
});

test('create, read a range, edit, skip, delete, restore', async (t) => {
  const s = await ready(t);
  const d0 = today();
  const wd = CC.weekday(d0);
  const a = await s.person('POST', '/api/calendar/entry', { title: 'Standup', date: d0, start: '09:00', end: '09:15', repeat: { every: 'weekly', days: [wd] }, ping: '5m' });
  assert.equal(a.status, 200, a.text);
  const id = a.body.entry.id;
  assert.deepEqual(a.body.entry.created.by, ME);
  assert.equal((await s.person('POST', '/api/calendar/entry', { title: 'Holiday', date: d0, allDay: true })).status, 200);
  const bad = await s.person('POST', '/api/calendar/entry', { title: '', date: 'Friday', start: '09:00' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.title && bad.body.errors.date);

  let r = await s.person('GET', `/api/calendar?from=${d0}&to=${CC.addDays(d0, 13)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.timezone, LON);
  const standups = r.body.occurrences.filter((o) => o.entryId === id);
  assert.deepEqual(standups.map((o) => o.date), [d0, CC.addDays(d0, 7)]);
  assert.equal(standups[0].repeatText, `Every ${CC.DAY_LONG[wd]}`);
  assert.equal(standups[0].title, 'Standup');
  assert.equal(standups[0].card, null);
  assert.equal(r.body.occurrences[0].title, 'Holiday');   // all-day first on its day
  assert.deepEqual(r.body.counts, { today: 2, week: 2 });

  const one = await s.person('GET', `/api/calendar/entry/${id}`);
  assert.equal(one.body.entry.title, 'Standup');
  assert.equal((await s.person('GET', '/api/calendar/entry/c_nonexisten')).status, 404);

  const ed = await s.person('PUT', `/api/calendar/entry/${id}`, { title: 'Daily standup' });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.entry.title, 'Daily standup');
  assert.equal(ed.body.entry.end, '09:15');
  assert.equal((await s.person('PUT', `/api/calendar/entry/${id}`, { end: '08:00' })).body.errors.end !== undefined, true);

  assert.equal((await s.person('POST', `/api/calendar/entry/${id}/skip`, { date: CC.addDays(d0, 7) })).status, 200);
  r = await s.person('GET', `/api/calendar?from=${d0}&to=${CC.addDays(d0, 13)}`);
  assert.deepEqual(r.body.occurrences.filter((o) => o.entryId === id).map((o) => o.date), [d0]);

  assert.equal((await s.person('DELETE', `/api/calendar/entry/${id}`)).status, 200);
  const del = await s.person('GET', '/api/calendar/deleted');
  assert.deepEqual(del.body.entries.map((e) => e.id), [id]);
  assert.ok(del.body.entries[0].deletedAt);
  assert.equal((await s.person('DELETE', `/api/calendar/entry/${id}`)).status, 404);
  assert.equal((await s.person('POST', `/api/calendar/deleted/${id}/restore`)).status, 200);
  assert.deepEqual((await s.person('GET', '/api/calendar/deleted')).body.entries, []);
  assert.equal((await s.person('GET', `/api/calendar/entry/${id}`)).status, 200);
});

test('a range must be real dates, at most 62 days', async (t) => {
  const s = await ready(t);
  const d0 = today();
  assert.equal((await s.person('GET', `/api/calendar?from=${d0}&to=${CC.addDays(d0, 61)}`)).status, 200);
  assert.equal((await s.person('GET', `/api/calendar?from=${d0}&to=${CC.addDays(d0, 62)}`)).status, 400);
  assert.equal((await s.person('GET', `/api/calendar?from=Friday&to=${d0}`)).status, 400);
  assert.equal((await s.person('GET', `/api/calendar?from=${d0}&to=${CC.addDays(d0, -1)}`)).status, 400);
  const def = await s.person('GET', '/api/calendar');   // default: today and the next 13 days
  assert.equal(def.status, 200);
});

test('local read may GET but not write', async (t) => {
  const s = await ready(t, { env: { LOCAL_READ: '1' } });
  assert.equal((await call(s.base, 'GET', '/api/calendar')).status, 200);
  assert.equal((await call(s.base, 'GET', '/api/calendar/due')).status, 200);
  assert.equal((await call(s.base, 'POST', '/api/calendar/entry', { body: { title: 'x', date: today(), start: '09:00' } })).status, 401);
  assert.equal(fs.existsSync(s.file), false);
});

test('due lists, folds and acks', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md', 'The X card');
  s.seed([stored('c_dddddddddd', { title: 'Morning', date: CC.addDays(today(), -5), start: '00:00', repeat: { every: 'daily' }, card: 'Work/1. a/01-x/task.md',
    created: { at: daysAgoIso(3), by: { kind: 'agent', agent: 'Claude Code' } } })]);
  const d = await s.person('GET', '/api/calendar/due');
  assert.equal(d.status, 200);
  assert.equal(d.body.count, 1);
  assert.equal(d.body.timezone, LON);   // the Due panel and toasts word times in it
  const it = d.body.items[0];
  assert.equal(it.key, `c_dddddddddd@${today()}`);
  assert.equal(it.missedEarlier, 2);
  assert.equal(it.title, 'Morning');
  assert.equal(it.by, 'Claude Code');
  assert.equal(it.start, '00:00');
  assert.equal(it.allDay, false);
  assert.deepEqual(it.card, { path: 'Work/1. a/01-x/task.md', title: 'The X card', exists: true, board: 'work' });
  assert.match(it.pingAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(it.dueSince, it.pingAt);   // not snoozed: due since its ping
  const done = await s.person('POST', `/api/calendar/due/${encodeURIComponent(it.key)}/done`);
  assert.equal(done.status, 200);
  assert.deepEqual((await s.person('GET', '/api/calendar/due')).body, { timezone: LON, count: 0, items: [] });
  const acks = JSON.parse(fs.readFileSync(s.file, 'utf8')).acks;
  assert.equal(Object.values(acks).filter((a) => a.state === 'done').length, 3);   // the item and its two missed ones
});

test('snooze hides the item and dismisses the missed ones', async (t) => {
  const s = await ready(t);
  s.seed([stored('c_dddddddddd', { date: CC.addDays(today(), -5), start: '00:00', repeat: { every: 'daily' }, created: { at: daysAgoIso(3), by: ME } })]);
  const key = `c_dddddddddd@${today()}`;
  assert.equal((await s.person('POST', `/api/calendar/due/${encodeURIComponent(key)}/snooze`, { for: 'later' })).status, 400);
  assert.equal((await s.person('POST', `/api/calendar/due/${encodeURIComponent(key)}/snooze`, { for: '1h' })).status, 200);
  assert.equal((await s.person('GET', '/api/calendar/due')).body.count, 0);
  const acks = JSON.parse(fs.readFileSync(s.file, 'utf8')).acks;
  assert.equal(acks[key].state, 'snoozed');
  assert.equal(Object.values(acks).filter((a) => a.state === 'dismissed').length, 2);
});

test('acking a due item twice is harmless', async (t) => {
  const s = await ready(t);
  s.seed([stored('c_dddddddddd', { date: CC.addDays(today(), -5), start: '00:00', repeat: { every: 'daily' }, created: { at: daysAgoIso(3), by: ME } })]);
  const url = (a) => `/api/calendar/due/${encodeURIComponent(`c_dddddddddd@${today()}`)}/${a}`;
  assert.equal((await s.person('POST', url('done'))).status, 200);
  assert.equal((await s.person('POST', url('done'))).status, 200);
  assert.equal((await s.person('POST', url('snooze'), { for: '10m' })).status, 200);
  assert.equal((await s.person('POST', url('dismiss'))).status, 200);
  assert.deepEqual((await s.person('GET', '/api/calendar/due')).body, { timezone: LON, count: 0, items: [] });
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).acks[`c_dddddddddd@${today()}`].state, 'done');
  assert.equal((await s.person('POST', `/api/calendar/due/${encodeURIComponent(`c_zzzzzzzzzz@${today()}`)}/done`)).status, 404);
  assert.equal((await s.person('POST', `/api/calendar/due/${encodeURIComponent(`c_dddddddddd@${CC.addDays(today(), -9)}`)}/done`)).status, 404); // before the first date
  assert.equal((await s.person('POST', '/api/calendar/due/nonsense/done')).status, 404);
});

test('changing the time zone moves pings, keeps acks', async (t) => {
  const s = await ready(t);
  const tokyoYesterday = CC.addDays(CC.todayIn('Asia/Tokyo', Date.now()), -1);
  const londonYesterday = CC.addDays(today(), -1);
  s.seed([
    stored('c_tttttttttt', { title: 'Nine', date: tokyoYesterday, start: '09:00' }),
    stored('c_aaaaaaaaaa', { title: 'Noon', date: londonYesterday, start: '12:00' }),
  ]);
  let due = (await s.person('GET', '/api/calendar/due')).body;
  const nine = () => due.items.find((x) => x.entryId === 'c_tttttttttt');
  if (Date.parse(`${tokyoYesterday}T09:00:00Z`) <= Date.now()) assert.equal(nine().pingAt, `${tokyoYesterday}T09:00:00.000Z`);   // 09:00 London (GMT)
  assert.equal((await s.person('POST', `/api/calendar/due/${encodeURIComponent(`c_aaaaaaaaaa@${londonYesterday}`)}/done`)).status, 200);
  assert.equal((await s.person('POST', '/api/settings/features', { timezone: 'Asia/Tokyo' })).status, 200);
  due = (await s.person('GET', '/api/calendar/due')).body;
  assert.equal(nine().pingAt, `${tokyoYesterday}T00:00:00.000Z`);   // 09:00 Tokyo
  assert.equal(due.items.some((x) => x.entryId === 'c_aaaaaaaaaa'), false);   // acked by date, still acked
  const r = await s.person('GET', `/api/calendar?from=${londonYesterday}&to=${londonYesterday}`);
  assert.equal(r.body.timezone, 'Asia/Tokyo');
  assert.equal(r.body.occurrences.find((o) => o.entryId === 'c_aaaaaaaaaa').start, '12:00');
});

test('a stale card path does not block other edits', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md', 'Card X');
  const c = await s.person('POST', '/api/calendar/entry', { title: 'Chase', date: today(), start: '09:00', card: 'Work/1. a/01-x' });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.entry.card, 'Work/1. a/01-x/task.md');
  const id = c.body.entry.id;
  let occ = (await s.person('GET', '/api/calendar')).body.occurrences[0];
  assert.deepEqual(occ.card, { path: 'Work/1. a/01-x/task.md', title: 'Card X', exists: true, board: 'work' });
  fs.renameSync(path.join(s.vault, 'Work', '1. a', '01-x'), path.join(s.vault, 'Work', '1. a', '02-x'));
  occ = (await s.person('GET', '/api/calendar')).body.occurrences[0];
  assert.equal(occ.card.exists, false);
  assert.equal(occ.card.title, '01-x');
  assert.equal((await s.person('GET', `/api/calendar/entry/${id}`)).status, 200);
  assert.equal((await s.person('PUT', `/api/calendar/entry/${id}`, { title: 'New' })).status, 200);
  const gone = await s.person('PUT', `/api/calendar/entry/${id}`, { card: 'gone/task.md' });
  assert.equal(gone.status, 400);
  assert.ok(gone.body.errors.card);
  for (const card of ['../x/task.md', '.vaultos/calendar.json', 'Work/1. a/02-x/notes.md']) {
    assert.equal((await s.person('POST', '/api/calendar/entry', { title: 'x', date: today(), start: '09:00', card })).status, 400, card);
  }
  assert.equal((await s.person('PUT', `/api/calendar/entry/${id}`, { card: 'Work/1. a/02-x' })).status, 200);
  assert.equal((await s.person('PUT', `/api/calendar/entry/${id}`, { card: null })).body.entry.card, null);
});

test('card picker searches titles across boards', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-v/task.md', 'Vantage connector');
  s.card('Home/1. b/02-v/task.md', 'Avantgarde shelf');
  s.card('Home/1. b/03-w/task.md', 'Washing machine');
  const r = await s.person('GET', '/api/calendar/cards?q=vant');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cards.map((c) => [c.title, c.board, c.path]).sort(), [
    ['Avantgarde shelf', 'home', 'Home/1. b/02-v/task.md'],
    ['Vantage connector', 'work', 'Work/1. a/01-v/task.md'],
  ]);
  assert.ok((await s.person('GET', '/api/calendar/cards?q=')).body.cards.length <= 20);
});

test('a corrupt calendar.json: writes 503, due empty with error, file untouched', async (t) => {
  const s = await ready(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ nope');
  const w = await s.person('POST', '/api/calendar/entry', { title: 'x', date: today(), start: '09:00' });
  assert.equal(w.status, 503);
  assert.match(w.body.error, /^VaultOS can't read \.vaultos\/calendar\.json: .+\. Nothing will be changed until it's fixed\.$/);
  const g = await s.person('GET', '/api/calendar');
  assert.equal(g.status, 503);
  const d = await s.person('GET', '/api/calendar/due');
  assert.equal(d.status, 200);
  assert.equal(d.body.count, 0);
  assert.deepEqual(d.body.items, []);
  assert.match(d.body.error, /calendar\.json/);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ nope');
});

test('coming: the rest of today and the next one after', async (t) => {
  const w = (() => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: LON, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); return p; })();
  if (w < '00:05' || w > '23:50') return t.skip('too close to midnight in London');
  const s = await ready(t);
  const d0 = today();
  s.seed([
    stored('c_aaaaaaaaaa', { title: 'Late', start: '23:58' }),
    stored('c_bbbbbbbbbb', { title: 'Over', start: '00:00', end: '00:01' }),
    stored('c_cccccccccc', { title: 'Holiday', allDay: true, start: null, ping: null }),
    stored('c_dddddddddd', { title: 'Tomorrow thing', date: CC.addDays(d0, 1), start: '09:00' }),
    stored('c_eeeeeeeeee', { title: 'Later thing', date: CC.addDays(d0, 3), start: '09:00' }),
  ]);
  const r = await s.person('GET', '/api/calendar/coming');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.today.map((o) => o.title), ['Holiday', 'Late']);
  assert.equal(r.body.next.title, 'Tomorrow thing');
  assert.equal(r.body.next.date, CC.addDays(d0, 1));
  s.seed([]);
  assert.deepEqual((await s.person('GET', '/api/calendar/coming')).body.today, []);
  assert.equal((await s.person('GET', '/api/calendar/coming')).body.next, null);
});

test('saving a ping that has already gone answers with a warning', async (t) => {
  const s = await ready(t);
  const past = await s.person('POST', '/api/calendar/entry', { title: 'Too late', date: CC.addDays(today(), -1), start: '09:00' });
  assert.equal(past.status, 200);
  assert.equal(past.body.warning, "That ping time has already passed, so it won't ping.");
  const fine = await s.person('POST', '/api/calendar/entry', { title: 'Later', date: CC.addDays(today(), 2), start: '09:00' });
  assert.equal(fine.body.warning, undefined);
  const silent = await s.person('POST', '/api/calendar/entry', { title: 'No ping', date: CC.addDays(today(), -1), start: '09:00', ping: null });
  assert.equal(silent.body.warning, undefined);   // nothing was promised
  const ed = await s.person('PUT', `/api/calendar/entry/${fine.body.entry.id}`, { date: CC.addDays(today(), -2) });
  assert.equal(ed.body.warning, "That ping time has already passed, so it won't ping.");
});

test('links, brief and agent round-trip, and views carry agentLabel', async (t) => {
  const s = await ready(t);
  const r = await s.person('POST', '/api/calendar/entry', { title: 'Chase', date: today(), allDay: true, ping: 'start', links: ['https://x.test/t/1', 'Work/a.md'], brief: 'Check the reply', agent: 'cursor' });
  assert.equal(r.status, 200);
  const id = r.body.entry.id;
  const got = (await s.person('GET', `/api/calendar/entry/${id}`)).body.entry;
  assert.deepEqual([got.links, got.brief, got.agent, got.agentLabel], [['https://x.test/t/1', 'Work/a.md'], 'Check the reply', 'cursor', 'Cursor CLI']);
  const occ = (await s.person('GET', '/api/calendar')).body.occurrences.find((o) => o.entryId === id);
  assert.deepEqual([occ.agent, occ.agentLabel], ['cursor', 'Cursor CLI']);
  s.seed([stored('c_bbbbbbbbbb', { start: '00:00', created: { at: daysAgoIso(2), by: ME } }), { ...(await s.person('GET', `/api/calendar/entry/${id}`)).body.entry, card: null, allDay: false, start: '00:00', created: { at: daysAgoIso(2), by: ME }, repeatText: undefined, agentLabel: undefined }]);
  const due = (await s.person('GET', '/api/calendar/due')).body.items;
  const mine = due.find((i) => i.entryId === id);
  const old = due.find((i) => i.entryId === 'c_bbbbbbbbbb');
  assert.deepEqual([mine.agent, mine.agentLabel], ['cursor', 'Cursor CLI']);
  assert.deepEqual([old.agent, old.agentLabel], [null, null]);
  assert.equal((await s.person('POST', '/api/calendar/entry', { title: 'X', date: today(), allDay: true, agent: 'custom' })).body.errors.agent, 'Pick one of the built-in agents, or leave it on the default');
});

// ---------- The Agent button's launch (spec 2026-11-19 §5.3) ----------
const { PROFILES, startCommand } = require('../lib/agents');
const { calendarKickoff } = require('../lib/calendar-brief');
async function launchReady(t, { env = {}, agent = 'claude' } = {}) {
  const s = await ready(t, { env: { TERMINAL: '1', ...env }, bins: ['agent'] });
  if (agent) assert.equal((await s.person('POST', '/api/settings/agent', { profile: agent })).status, 200);
  const launch = (id, date) => s.person('GET', `/api/calendar/entry/${id}/agent${date ? `?date=${encodeURIComponent(date)}` : ''}`);
  return { ...s, launch };
}

test('agent launch: a card entry opens in the card folder with the fixed check-in', { timeout: 30000 }, async (t) => {
  const s = await launchReady(t);
  s.card('Work/1. a/01-x/task.md', 'Chase');
  s.seed([stored('c_aaaaaaaaaa', { card: 'Work/1. a/01-x/task.md', note: "'; rm -rf ~ #", title: '$(id)' })]);
  const r = await s.launch('c_aaaaaaaaaa', today());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...r.body, command: undefined }, {
    command: undefined, cwd: 'Work/1. a/01-x', task: 'Work/1. a/01-x/task.md', spaceName: null,
    agent: { id: 'claude', label: 'Claude Code' }, fellBack: null,
  });
  assert.equal(r.body.command, startCommand(PROFILES.claude, calendarKickoff('c_aaaaaaaaaa', today())));
  assert.doesNotMatch(r.body.command, /rm -rf|\$\(id\)/);
  const next = await s.launch('c_aaaaaaaaaa');
  assert.equal(next.body.command, startCommand(PROFILES.claude, calendarKickoff('c_aaaaaaaaaa')));
});

test('agent launch: the i-have-adhd prefix when that skill is installed', { timeout: 30000 }, async (t) => {
  const s = await launchReady(t);
  fs.mkdirSync(path.join(s.home, '.claude', 'skills', 'i-have-adhd'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.claude', 'skills', 'i-have-adhd', 'SKILL.md'), '# skill\n');
  s.seed([stored('c_aaaaaaaaaa')]);
  assert.match((await s.launch('c_aaaaaaaaaa', today())).body.command, /^claude '\/i-have-adhd A calendar reminder brought you here\./);
});

test("agent launch: the entry's own agent, or the default when it is not installed", { timeout: 30000 }, async (t) => {
  const s = await launchReady(t);
  s.seed([stored('c_aaaaaaaaaa', { agent: 'cursor' }), stored('c_bbbbbbbbbb', { agent: 'codex' })]);
  const cur = (await s.launch('c_aaaaaaaaaa', today())).body;
  assert.deepEqual([cur.agent.id, cur.fellBack], ['cursor', null]);
  assert.match(cur.command, /^agent '/);
  const codex = (await s.launch('c_bbbbbbbbbb', today())).body;
  assert.deepEqual([codex.agent.id, codex.fellBack], ['claude', "Codex CLI isn't installed"]);
});

test('agent launch: no card (or a moved one) opens a new space named after the title', { timeout: 30000 }, async (t) => {
  const s = await launchReady(t);
  s.seed([stored('c_aaaaaaaaaa', { title: '🗓️x'.repeat(30).slice(0, 120) }), stored('c_bbbbbbbbbb', { title: 'Short', card: 'Work/gone/task.md' })]);
  const r = (await s.launch('c_aaaaaaaaaa', today())).body;
  assert.deepEqual([r.cwd, r.task], ['', null]);
  assert.ok(Array.from(r.spaceName).length <= 24);
  assert.ok(r.spaceName.endsWith('…'));
  assert.doesNotMatch(r.spaceName, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  const moved = (await s.launch('c_bbbbbbbbbb', today())).body;
  assert.deepEqual([moved.cwd, moved.task, moved.spaceName], ['', null, 'Short']);
});

test('agent launch: refusals', { timeout: 30000 }, async (t) => {
  const s = await launchReady(t, { env: { LOCAL_READ: '1' } });
  s.seed([stored('c_aaaaaaaaaa', { repeat: { every: 'daily' }, skip: [today()] })], {});
  const local = await call(s.base, 'GET', `/api/calendar/entry/c_aaaaaaaaaa/agent`);
  assert.deepEqual([local.status, local.body.error], [403, 'Sign in to start an agent']);
  const unknown = await s.launch('c_zzzzzzzzzz');
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'No such entry']);
  const skipped = await s.launch('c_aaaaaaaaaa', today());
  assert.deepEqual([skipped.status, skipped.body.error], [400, `c_aaaaaaaaaa isn't on ${today()}`]);
  const junk = await s.launch('c_aaaaaaaaaa', 'junk');
  assert.deepEqual([junk.status, junk.body.error], [400, 'Use YYYY-MM-DD (for example 2026-11-20)']);
  assert.equal((await s.person('POST', '/api/settings/agent', { profile: 'none' })).status, 200);
  const none = await s.launch('c_aaaaaaaaaa', CC.addDays(today(), 1));
  assert.deepEqual([none.status, none.body.error], [409, 'Set a default agent in Settings → Agent']);
});

test('agent launch: terminals off answers 404', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  s.seed([stored('c_aaaaaaaaaa')]);
  const r = await s.person('GET', `/api/calendar/entry/c_aaaaaaaaaa/agent?date=${today()}`);
  assert.deepEqual([r.status, r.body.error], [404, 'Terminals are switched off']);
});

test('the agents list for the entry panel', { timeout: 30000 }, async (t) => {
  const s = await launchReady(t);
  const r = await s.person('GET', '/api/calendar/agents');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.default, { id: 'claude', label: 'Claude Code' });
  assert.deepEqual(r.body.agents.map((a) => a.id), CC.AGENT_IDS);
  assert.equal(r.body.agents[1].label, 'Cursor CLI');
});
