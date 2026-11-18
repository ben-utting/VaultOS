'use strict';
// The calendar store: .vaultos/calendar.json, one write at a time, never overwriting a file it can't read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCalendarStore, CalendarDamaged, MAX_LIVE } = require('../lib/calendar-store');

const ME = { kind: 'person' };
const AGENT = { kind: 'agent', agent: 'Claude Code' };
const valid = { title: 'Dentist', date: '2026-11-19', allDay: false, start: '15:20', ping: 'start' };

function setup(t, nowIso = '2026-11-18T10:00:00Z') {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-store-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const clock = { now: Date.parse(nowIso) };
  const s = createCalendarStore(vault, { tz: () => 'Europe/London', now: () => clock.now });
  const file = path.join(vault, '.vaultos', 'calendar.json');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const put = (data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  return { vault, s, clock, file, disk, put };
}
const stored = (i, date, more = {}) => ({
  id: `c_${String(i).padStart(10, 'a').replace(/[0-9]/g, (d) => 'abcdefghij'[d])}`,
  title: `E${i}`, date, allDay: true, start: null, end: null, repeat: null, skip: [], ping: null, card: null, note: '',
  created: { at: '2026-01-01T00:00:00.000Z', by: ME }, updated: { at: '2026-01-01T00:00:00.000Z', by: ME }, ...more,
});

test('create writes calendar.json with id, created and updated', async (t) => {
  const { s, disk } = setup(t);
  const r = await s.create(valid, AGENT);
  assert.equal(r.ok, true);
  assert.match(r.entry.id, /^c_[a-z2-7]{10}$/);
  assert.deepEqual(r.entry.created, { at: '2026-11-18T10:00:00.000Z', by: AGENT });
  assert.deepEqual(r.entry.updated, { at: '2026-11-18T10:00:00.000Z', by: AGENT });
  const d = disk();
  assert.equal(d.version, 1);
  assert.equal(d.entries[0].title, 'Dentist');
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(d.acks, {});
});

test('a missing file reads as empty', async (t) => {
  const { s } = setup(t);
  assert.deepEqual(await s.read(), { version: 1, entries: [], deleted: [], acks: {} });
});

test('bad input answers field errors and writes nothing', async (t) => {
  const { s, file } = setup(t);
  const r = await s.create({ ...valid, title: '' }, ME);
  assert.equal(r.ok, false);
  assert.ok(r.errors.title);
  assert.equal(fs.existsSync(file), false);
});

test('update merges, re-validates, and stamps updated only', async (t) => {
  const { s, clock } = setup(t);
  const { entry } = await s.create(valid, AGENT);
  clock.now += 60000;
  const r = await s.update(entry.id, { title: 'Dentist (moved)', start: '16:00' }, ME);
  assert.equal(r.ok, true);
  assert.equal(r.entry.title, 'Dentist (moved)');
  assert.equal(r.entry.start, '16:00');
  assert.equal(r.entry.ping, 'start');
  assert.deepEqual(r.entry.created, entry.created);
  assert.deepEqual(r.entry.updated, { at: '2026-11-18T10:01:00.000Z', by: ME });
  assert.ok((await s.update(entry.id, { end: '15:00' }, ME)).errors.end);
  assert.equal((await s.read()).entries[0].start, '16:00');
  assert.equal(await s.update('c_nonexisten', { title: 'x' }, ME), null);
});

test('skip adds one date to the repeat', async (t) => {
  const { s } = setup(t);
  const { entry } = await s.create({ ...valid, repeat: { every: 'daily' } }, ME);
  const r = await s.skip(entry.id, '2026-11-21', AGENT);
  assert.deepEqual(r.entry.skip, ['2026-11-21']);
  assert.deepEqual(r.entry.updated.by, AGENT);
  assert.ok((await s.skip(entry.id, 'Friday', ME)).errors.skip);
  assert.equal(await s.skip('c_nonexisten', '2026-11-21', ME), null);
});

test('remove moves to deleted with deletedAt/deletedBy; restore brings it back', async (t) => {
  const { s, disk } = setup(t);
  const { entry } = await s.create(valid, ME);
  const gone = await s.remove(entry.id, AGENT);
  assert.equal(gone.id, entry.id);
  let d = disk();
  assert.deepEqual(d.entries, []);
  assert.equal(d.deleted[0].deletedAt, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(d.deleted[0].deletedBy, AGENT);
  assert.equal(await s.remove(entry.id, ME), null);
  const back = await s.restore(entry.id, ME);
  assert.equal(back.ok, true);
  assert.equal(back.entry.deletedAt, undefined);
  d = disk();
  assert.deepEqual(d.deleted, []);
  assert.equal(d.entries[0].id, entry.id);
  assert.equal(await s.restore(entry.id, ME), null);
});

test('housekeeping drops deleted > 30 days and acks > 60 days on the next write', async (t) => {
  const { s, put, disk } = setup(t);
  put({
    version: 1,
    entries: [],
    deleted: [{ ...stored(1, '2026-10-01'), deletedAt: '2026-10-18T09:59:00.000Z', deletedBy: ME }, { ...stored(2, '2026-10-01'), deletedAt: '2026-10-20T00:00:00.000Z', deletedBy: ME }],
    acks: { 'c_old@2026-09-01': { state: 'done', at: '2026-09-18T09:00:00.000Z', by: ME }, 'c_new@2026-11-01': { state: 'done', at: '2026-11-01T09:00:00.000Z', by: ME } },
  });
  await s.create(valid, ME);
  const d = disk();
  assert.deepEqual(d.deleted.map((e) => e.title), ['E2']);
  assert.deepEqual(Object.keys(d.acks), ['c_new@2026-11-01']);
});

test('a corrupt file is refused and never overwritten', async (t) => {
  const { s, file } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ nope');
  await assert.rejects(s.create(valid, ME), (e) => e instanceof CalendarDamaged);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
  assert.match(s.damaged(), /^calendar\.json: /);
  await assert.rejects(s.read(), (e) => e instanceof CalendarDamaged);
});

test('a wrong version or an invalid entry is damage too; a good read clears it', async (t) => {
  const { s, put } = setup(t);
  put({ version: 2, entries: [] });
  await assert.rejects(s.read(), /calendar\.json: /);
  put({ version: 1, entries: [{ ...stored(1, '2026-11-20'), date: 'Friday' }] });
  await assert.rejects(s.read(), (e) => e instanceof CalendarDamaged && /date/.test(e.message));
  put({ version: 1, entries: [{ ...stored(1, '2026-11-20'), id: 'nope' }] });
  await assert.rejects(s.read(), CalendarDamaged);
  put({ version: 1, entries: [stored(1, '2026-11-20')] });
  assert.equal((await s.read()).entries.length, 1);
  assert.equal(s.damaged(), null);
});

test('the 2,000 cap counts only entries with a date today or later', async (t) => {
  const { s, put } = setup(t);
  assert.equal(MAX_LIVE, 2000);
  put({ version: 1, entries: Array.from({ length: MAX_LIVE }, (_, i) => stored(i, '2026-11-17')), deleted: [], acks: {} });
  assert.equal((await s.create(valid, ME)).ok, true);
  put({ version: 1, entries: Array.from({ length: MAX_LIVE }, (_, i) => stored(i, '2026-11-18')), deleted: [], acks: {} });
  const r = await s.create(valid, ME);
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'The calendar is full (2,000 upcoming entries)');
});

test('guard runs inside the queue and can refuse', async (t) => {
  const { s, file } = setup(t);
  const r = await s.create(valid, AGENT, { guard: (entries) => (entries.length >= 0 ? 'No more' : null) });
  assert.deepEqual(r, { ok: false, refused: 'No more' });
  assert.equal(fs.existsSync(file), false);
});

test('writes are serialised: 20 parallel creates all land', async (t) => {
  const { s, disk } = setup(t);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.create({ ...valid, title: `T${i}` }, ME)));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(disk().entries.length, 20);
  assert.equal(new Set(disk().entries.map((e) => e.id)).size, 20);
});

test('ack stores state, until, at and by per key', async (t) => {
  const { s, disk } = setup(t);
  await s.ack(['c_aaaaaaaaaa@2026-11-18', 'c_aaaaaaaaaa@2026-11-17'], 'dismissed', null, ME);
  await s.ack(['c_bbbbbbbbbb@2026-11-18'], 'snoozed', '2026-11-18T11:00:00.000Z', AGENT);
  const a = disk().acks;
  assert.deepEqual(a['c_aaaaaaaaaa@2026-11-18'], { state: 'dismissed', at: '2026-11-18T10:00:00.000Z', by: ME });
  assert.deepEqual(a['c_aaaaaaaaaa@2026-11-17'], { state: 'dismissed', at: '2026-11-18T10:00:00.000Z', by: ME });
  assert.deepEqual(a['c_bbbbbbbbbb@2026-11-18'], { state: 'snoozed', until: '2026-11-18T11:00:00.000Z', at: '2026-11-18T10:00:00.000Z', by: AGENT });
});
