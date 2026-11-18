'use strict';
// CalendarCore: the calendar rules the server and the browser share (validation, repeats, pings, what's due).
const test = require('node:test');
const assert = require('node:assert/strict');
const CC = require('../public/calendar-core');

const LON = 'Europe/London';
const BASE = { title: 'T', date: '2026-11-18', allDay: false, start: '09:00', end: null, repeat: null, skip: [], ping: 'start', card: null, note: '' };
const E = (x = {}) => ({ id: 'c_aaaaaaaaaa', created: { at: '2026-11-01T00:00:00Z' }, ...BASE, ...x });

test('validateEntry accepts a timed one-off and normalises it', () => {
  const r = CC.validateEntry({ title: '  Dentist\u0007 ', date: '2026-11-19', allDay: false, start: '15:20', end: '16:00', ping: '30m' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { title: 'Dentist', date: '2026-11-19', allDay: false, start: '15:20', end: '16:00', repeat: null, skip: [], ping: '30m', card: null, note: '' });
});

test('validateEntry rejects other date and time shapes', () => {
  for (const date of ['20/11/2026', 'Friday', '2026-11-20T09:00', '2026-02-30']) assert.ok(CC.validateEntry(E({ date })).errors.date, date);
  for (const start of ['9am', '25:00', '9:00']) assert.ok(CC.validateEntry(E({ start })).errors.start, start);
  assert.match(CC.validateEntry(E({ date: 'Friday' })).errors.date, /YYYY-MM-DD/);
});

test('validateEntry field rules', () => {
  assert.ok(CC.validateEntry(E({ title: '' })).errors.title);
  assert.ok(CC.validateEntry(E({ title: 'x'.repeat(121) })).errors.title);
  assert.ok(CC.validateEntry(E({ end: '08:00' })).errors.end);               // not after start
  assert.ok(CC.validateEntry(E({ allDay: true, ping: '10m' })).errors.ping);  // minute offsets not for all-day
  assert.ok(CC.validateEntry(E({ allDay: false, start: null })).errors.start);
  assert.ok(CC.validateEntry(E({ repeat: { every: 'weekly', days: [] } })).errors.repeat);
  assert.ok(CC.validateEntry(E({ repeat: { every: 'hourly' } })).errors.repeat);
  assert.ok(CC.validateEntry(E({ note: 'x'.repeat(2001) })).errors.note);
  assert.equal(CC.validateEntry(E({ allDay: true, start: '09:00' })).entry.start, null);
});

test('validateEntry: skip, until and repeat normalisation', () => {
  const r = CC.validateEntry(E({ repeat: { every: 'weekly', days: [4, 0, 4], until: '2026-12-31' }, skip: ['2026-11-30', '2026-11-23', '2026-11-30'] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry.repeat, { every: 'weekly', days: [0, 4], until: '2026-12-31' });
  assert.deepEqual(r.entry.skip, ['2026-11-23', '2026-11-30']);
  assert.deepEqual(CC.validateEntry(E({ repeat: { every: 'daily', days: [1] } })).entry.repeat, { every: 'daily' });
  assert.ok(CC.validateEntry(E({ repeat: { every: 'daily', until: '2026-11-01' } })).errors.repeat); // until before date
  assert.ok(CC.validateEntry(E({ skip: ['tomorrow'] })).errors.skip);
  assert.ok(CC.validateEntry(E({ skip: Array.from({ length: 501 }, (_, i) => CC.addDays('2027-01-01', i)) })).errors.skip);
});

test('validateEntry: ping defaults to start when left out, null means no ping', () => {
  assert.equal(CC.validateEntry({ title: 'X', date: '2026-11-19', start: '09:00' }).entry.ping, 'start');
  assert.equal(CC.validateEntry({ title: 'X', date: '2026-11-19', start: '09:00', ping: null }).entry.ping, null);
});

test('parseRepeatFlag', () => {
  assert.deepEqual(CC.parseRepeatFlag('weekly:wed,mon'), { every: 'weekly', days: [0, 2] });
  assert.equal(CC.parseRepeatFlag('none'), null);
  assert.deepEqual(CC.parseRepeatFlag('weekdays'), { every: 'weekdays' });
  assert.ok(CC.parseRepeatFlag('weekly:funday').error);
  assert.ok(CC.parseRepeatFlag('hourly').error);
});

test('date helpers', () => {
  assert.equal(CC.todayIn(LON, Date.parse('2026-06-30T23:30:00Z')), '2026-07-01'); // BST
  assert.equal(CC.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(CC.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(CC.weekday('2026-11-16'), 0);
  assert.equal(CC.weekday('2026-11-22'), 6);
  assert.equal(CC.mondayOf('2026-11-22'), '2026-11-16');
});

test('occurrences: each repeat kind', () => {
  assert.deepEqual(CC.occurrences(E({ repeat: { every: 'weekdays' } }), '2026-11-20', '2026-11-24'), ['2026-11-20', '2026-11-23', '2026-11-24']);
  assert.deepEqual(CC.occurrences(E({ repeat: { every: 'weekly', days: [0, 2, 4] } }), '2026-11-16', '2026-11-22'), ['2026-11-18', '2026-11-20']); // not before date
  assert.deepEqual(CC.occurrences(E({ date: '2026-01-31', repeat: { every: 'monthly' } }), '2026-02-01', '2026-04-30'), ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(CC.occurrences(E({ date: '2028-02-29', repeat: { every: 'yearly' } }), '2029-01-01', '2029-12-31'), ['2029-02-28']);
  assert.deepEqual(CC.occurrences(E({ repeat: { every: 'daily', until: '2026-11-20' }, skip: ['2026-11-19', '2027-01-01'] }), '2026-11-01', '2026-11-30'), ['2026-11-18', '2026-11-20']);
  assert.deepEqual(CC.occurrences(E(), '2026-11-01', '2026-11-30'), ['2026-11-18']);
  assert.deepEqual(CC.occurrences(E(), '2026-11-19', '2026-11-30'), []);
});

test('lastDate', () => {
  assert.equal(CC.lastDate(E()), '2026-11-18');
  assert.equal(CC.lastDate(E({ repeat: { every: 'daily' } })), null);
  assert.equal(CC.lastDate(E({ repeat: { every: 'weekly', days: [0], until: '2026-12-06' } })), '2026-11-30'); // last Monday on or before until
});

test('describeRepeat', () => {
  assert.equal(CC.describeRepeat(E()), '');
  assert.equal(CC.describeRepeat(E({ repeat: { every: 'weekly', days: [2] } })), 'Every Wednesday');
  assert.equal(CC.describeRepeat(E({ repeat: { every: 'weekly', days: [0, 2, 4] } })), 'Mon, Wed, Fri');
  assert.equal(CC.describeRepeat(E({ repeat: { every: 'weekdays' } })), 'Weekdays');
  assert.equal(CC.describeRepeat(E({ date: '2026-11-23', repeat: { every: 'monthly' } })), 'Monthly on the 23rd');
  assert.equal(CC.describeRepeat(E({ date: '2026-06-04', repeat: { every: 'yearly' } })), 'Yearly on 4 Jun');
});

test('pingAt across both clock changes', () => {
  assert.equal(CC.pingAt(E({ start: '01:30' }), '2027-03-28', LON), Date.parse('2027-03-28T01:30:00Z')); // gap: runs at 02:30 BST
  assert.equal(CC.pingAt(E({ start: '01:30' }), '2026-10-25', LON), Date.parse('2026-10-25T00:30:00Z')); // twice: the first
  assert.equal(CC.pingAt(E({ start: '09:00', ping: '10m' }), '2026-07-01', LON), Date.parse('2026-07-01T07:50:00Z'));
  assert.equal(CC.pingAt(E({ allDay: true, start: null, ping: '1d' }), '2026-11-20', LON), Date.parse('2026-11-19T08:00:00Z'));
  assert.equal(CC.pingAt(E({ ping: null }), '2026-11-20', LON), null);
});

test('dueItems: created-after, window, folding, snooze', () => {
  const daily = E({ id: 'c_dddddddddd', date: '2026-11-15', start: '08:00', repeat: { every: 'daily' }, created: { at: '2026-11-15T12:00:00Z' } });
  const now = Date.parse('2026-11-18T10:00:00Z');
  const d = CC.dueItems([daily], {}, LON, now);
  assert.equal(d.length, 1);
  assert.equal(d[0].key, 'c_dddddddddd@2026-11-18');
  assert.equal(d[0].missedEarlier, 2);                 // 16th, 17th (15th's 08:00 was before created)
  assert.deepEqual(d[0].earlierKeys, ['c_dddddddddd@2026-11-17', 'c_dddddddddd@2026-11-16']);
  const acks = { 'c_dddddddddd@2026-11-18': { state: 'snoozed', until: '2026-11-18T11:00:00Z' } };
  assert.equal(CC.dueItems([daily], acks, LON, now)[0].key, 'c_dddddddddd@2026-11-17');  // snoozed one hidden, next latest shows
  assert.equal(CC.dueItems([daily], acks, LON, Date.parse('2026-11-18T11:00:01Z'))[0].key, 'c_dddddddddd@2026-11-18');
  const old = E({ date: '2026-09-01', created: { at: '2026-08-01T00:00:00Z' } });
  assert.deepEqual(CC.dueItems([old], {}, LON, now), []);   // outside 30 days
});

test('dueItems: done and dismissed drop the date; newest ping first across entries', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const a = E({ id: 'c_aaaaaaaaaa', start: '08:00' });
  const b = E({ id: 'c_bbbbbbbbbb', start: '09:30' });
  assert.deepEqual(CC.dueItems([a, b], {}, LON, now).map((x) => x.entryId), ['c_bbbbbbbbbb', 'c_aaaaaaaaaa']);
  assert.deepEqual(CC.dueItems([a, b], { 'c_bbbbbbbbbb@2026-11-18': { state: 'done' } }, LON, now).map((x) => x.entryId), ['c_aaaaaaaaaa']);
  assert.deepEqual(CC.dueItems([a], { 'c_aaaaaaaaaa@2026-11-18': { state: 'dismissed' } }, LON, now), []);
  assert.equal(CC.dueItems([a], {}, LON, now)[0].pingAt, Date.parse('2026-11-18T08:00:00Z'));
});

test('snoozeUntil', () => {
  const now = Date.parse('2026-11-18T22:30:00Z');
  assert.equal(CC.snoozeUntil('10m', LON, now), now + 600000);
  assert.equal(CC.snoozeUntil('1h', LON, now), now + 3600000);
  assert.equal(CC.snoozeUntil('tomorrow', LON, now), Date.parse('2026-11-19T09:00:00Z'));
  assert.equal(CC.snoozeUntil('24h', LON, now), now + 24 * 3600000);
  assert.equal(CC.snoozeUntil('25h', LON, now), null);
  assert.equal(CC.snoozeUntil('1441m', LON, now), null);
  assert.equal(CC.snoozeUntil('0m', LON, now), null);
  assert.equal(CC.snoozeUntil('later', LON, now), null);
});
