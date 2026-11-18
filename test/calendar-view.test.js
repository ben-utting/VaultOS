'use strict';
// CalendarView: the strings and markup the Calendar mode, the Due panel, the toasts and Today's card show.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../public/calendar-view');

const LON = 'Europe/London';
const occ = (date, more = {}) => ({ entryId: 'c_aaaaaaaaaa', date, title: 'T', allDay: false, start: '09:00', end: null, repeatText: '', ping: 'start', card: null, note: '', created: { by: { kind: 'person' } }, ...more });

test('dayLabel', () => {
  assert.equal(CV.dayLabel('2026-11-18', '2026-11-18'), 'Today · Wed 18 Nov');
  assert.equal(CV.dayLabel('2026-11-19', '2026-11-18'), 'Tomorrow · Thu 19 Nov');
  assert.equal(CV.dayLabel('2026-11-20', '2026-11-18'), 'Fri 20 Nov');
  assert.equal(CV.dayLabel('2026-11-17', '2026-11-18'), 'Tue 17 Nov');
});

test('agendaGroups folds runs of empty days into one gap', () => {
  const g = CV.agendaGroups([occ('2026-11-18'), occ('2026-11-20'), occ('2026-11-20', { start: '08:00' }), occ('2026-11-23'), occ('2026-11-25')], '2026-11-18', 8, '2026-11-18');
  assert.deepEqual(g.map((x) => (x.kind === 'gap' ? x.label : `${x.date}:${x.items.length}`)), [
    '2026-11-18:1', 'Nothing on Thu 19', '2026-11-20:2', 'Nothing on Sat 21 – Sun 22', '2026-11-23:1', 'Nothing on Tue 24', '2026-11-25:1',
  ]);
  assert.equal(g[0].label, 'Today · Wed 18 Nov');
  assert.equal(g[0].today, true);
  assert.equal(g[2].items[0].start, '08:00');   // in time order
  const empty = CV.agendaGroups([], '2026-11-18', 3, '2026-11-18');
  assert.deepEqual(empty.map((x) => x.kind), ['day', 'gap']);   // today always shows
  assert.equal(empty[1].label, 'Nothing on Thu 19 – Fri 20');
  const past = CV.agendaGroups([occ('2026-11-16')], '2026-11-16', 1, '2026-11-18');
  assert.equal(past[0].past, true);
  assert.equal(CV.agendaGroups([], '2026-10-30', 4, '2026-01-01')[0].label, 'Nothing on Fri 30 Oct – Mon 2 Nov');
});

test('weekColumns', () => {
  const w = CV.weekColumns([occ('2026-11-18', { start: '10:00' }), occ('2026-11-18', { allDay: true, start: null }), occ('2026-11-22')], '2026-11-16', '2026-11-18');
  assert.equal(w.length, 7);
  assert.deepEqual(w.map((c) => c.label), ['Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20', 'Sat 21', 'Sun 22']);
  assert.equal(w[2].today, true);
  assert.equal(w[0].past, true);
  assert.equal(w[3].past, false);
  assert.deepEqual(w[2].items.map((o) => o.allDay), [true, false]);   // all-day first, then by time
  assert.equal(w[6].items.length, 1);
});

test('monthCells', () => {
  const many = ['08:00', '09:00', '10:00', '11:00', '12:00'].map((start) => occ('2026-11-18', { start }));
  const cells = CV.monthCells([...many, occ('2026-12-01')], 2026, 11, '2026-11-18');
  assert.equal(cells.length, 42);   // Mon 26 Oct … Sun 6 Dec
  assert.equal(cells[0].date, '2026-10-26');
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[41].date, '2026-12-06');
  const c18 = cells.find((c) => c.date === '2026-11-18');
  assert.equal(c18.day, 18);
  assert.equal(c18.today, true);
  assert.equal(c18.items.length, 3);
  assert.equal(c18.more, '+2 more');
  assert.equal(cells.find((c) => c.date === '2026-12-01').items.length, 1);
  assert.equal(cells.find((c) => c.date === '2026-11-17').past, true);
  assert.equal(CV.monthCells([], 2026, 2, '2026-01-01').length, 35);   // Mon 26 Jan … Sun 1 Mar
});

test('rangeTitle', () => {
  assert.equal(CV.rangeTitle('agenda', '2026-11-18'), 'Wed 18 Nov – Tue 1 Dec');
  assert.equal(CV.rangeTitle('week', '2026-11-16'), '16 – 22 Nov 2026');
  assert.equal(CV.rangeTitle('week', '2026-11-30'), '30 Nov – 6 Dec 2026');
  assert.equal(CV.rangeTitle('week', '2026-12-28'), '28 Dec 2026 – 3 Jan 2027');
  assert.equal(CV.rangeTitle('month', '2026-11-18'), 'November 2026');
});

test('dueWhen', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  assert.equal(CV.dueWhen(Date.parse('2026-11-18T09:00:00Z'), LON, now), 'Due 09:00 today');
  assert.equal(CV.dueWhen('2026-11-17T18:00:00.000Z', LON, now), 'Due yesterday 18:00');
  assert.equal(CV.dueWhen(Date.parse('2026-11-16T18:00:00Z'), LON, now), 'Due Mon 16 Nov 18:00');
});

test('toastWhen', () => {
  const now = Date.parse('2026-11-18T10:20:00Z');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: '10:30', allDay: false }, LON, now), '10:30 · in 10 minutes');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: '10:21', allDay: false }, LON, now), '10:21 · in 1 minute');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: '10:20', allDay: false }, LON, now), '10:20 · now');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: '09:00', allDay: false }, LON, now), '09:00 · now');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: '11:20', allDay: false }, LON, now), '11:20 · in 1 hour');
  assert.equal(CV.toastWhen({ date: '2026-11-19', start: '10:20', allDay: false }, LON, now), 'Tomorrow 10:20');
  assert.equal(CV.toastWhen({ date: '2026-11-18', start: null, allDay: true }, LON, now), 'All day');
  assert.equal(CV.toastWhen({ date: '2026-11-19', start: null, allDay: true }, LON, now), 'Tomorrow · All day');
});

test('byText', () => {
  assert.equal(CV.byText({ kind: 'agent', agent: 'Claude Code' }), 'Added by Claude Code');
  assert.equal(CV.byText({ kind: 'person' }), '');
  assert.equal(CV.byText(undefined), '');
});

test('rows carry the time, title, repeat, ping, card and who added it', () => {
  const html = CV.entryRowHtml(occ('2026-11-18', { start: '09:00', end: '09:30', repeatText: 'Weekdays', ping: '10m', card: { path: 'W/a/task.md', title: 'Card A', exists: true }, created: { by: { kind: 'agent', agent: 'Cursor CLI' } } }));
  for (const s of ['09:00', '09:30', 'Weekdays', '10 min before', 'Card A', 'Added by Cursor CLI', 'data-entry="c_aaaaaaaaaa"', 'data-date="2026-11-18"']) assert.ok(html.includes(s), s);
  assert.ok(CV.entryRowHtml(occ('2026-11-18', { allDay: true, start: null })).includes('All day'));
  assert.ok(CV.entryRowHtml(occ('2026-11-18', { card: { path: 'x/task.md', title: 'Gone', exists: false } })).includes('card not found'));
});

test('row, due and toast html escape markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const o = { entryId: 'c_a', date: '2026-11-18', title: evil, note: evil, allDay: false, start: '09:00', end: null, repeatText: '', ping: 'start', card: { path: 'a/task.md', title: evil, exists: true }, created: { by: { kind: 'agent', agent: evil } } };
  for (const html of [CV.entryRowHtml(o), CV.dueItemHtml({ ...o, key: 'c_a@2026-11-18', pingAt: '2026-11-18T09:00:00Z', by: evil, missedEarlier: 1 }), CV.toastHtml({ ...o, pingAt: '2026-11-18T09:00:00Z' }, 'Europe/London', Date.parse('2026-11-18T08:55:00Z'))]) {
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img'), html);
  }
});

test('due items show when, missed count, card and actions', () => {
  const html = CV.dueItemHtml({ key: 'c_a@2026-11-18', entryId: 'c_a', date: '2026-11-18', title: 'Chase', pingAt: '2026-11-18T09:00:00Z', start: '09:00', allDay: false,
    card: { path: 'Work/a/task.md', title: 'Card A', exists: true, board: 'work' }, by: 'Claude Code', missedEarlier: 3 }, LON, Date.parse('2026-11-18T10:00:00Z'));
  for (const s of ['Due 09:00 today', '+3 missed earlier', 'Added by Claude Code', 'Card A', 'data-card="Work/a/task.md"', 'data-board="work"', 'data-act="done"', 'data-act="snooze"', 'data-act="dismiss"', 'data-key="c_a@2026-11-18"']) assert.ok(html.includes(s), s);
});

test('seenToken and freshItems: a snooze that ran out is new again', () => {
  const a = { key: 'c_a@2026-11-18', dueSince: '2026-11-18T09:00:00.000Z', pingAt: '2026-11-18T09:00:00.000Z' };
  const seen = new Set([CV.seenToken(a)]);
  assert.equal(CV.seenToken(a), 'c_a@2026-11-18|2026-11-18T09:00:00.000Z');
  assert.deepEqual(CV.freshItems([a], seen), []);
  const again = { ...a, dueSince: '2026-11-18T09:10:00.000Z' };   // snoozed 10 minutes, now due again
  assert.deepEqual(CV.freshItems([again], seen), [again]);
  assert.deepEqual(CV.freshItems([again], [CV.seenToken(again)]), []);   // an array works too (localStorage)
});

test('dueSignature changes only when what the panel shows changes', () => {
  const it = { key: 'c_a@2026-11-18', dueSince: '2026-11-18T09:00:00.000Z', missedEarlier: 0, title: 'T', card: null, by: '' };
  assert.equal(CV.dueSignature([it]), CV.dueSignature([{ ...it }]));
  assert.notEqual(CV.dueSignature([it]), CV.dueSignature([{ ...it, missedEarlier: 1 }]));
  assert.notEqual(CV.dueSignature([it]), CV.dueSignature([{ ...it, title: 'U' }]));
  assert.notEqual(CV.dueSignature([it]), CV.dueSignature([]));
});

test('toastWhen words a date before today', () => {
  const now = Date.parse('2026-11-18T10:20:00Z');
  assert.equal(CV.toastWhen({ date: '2026-11-17', start: '18:00', allDay: false }, LON, now), 'Yesterday 18:00');
  assert.equal(CV.toastWhen({ date: '2026-11-16', start: '18:00', allDay: false }, LON, now), 'Mon 16 Nov 18:00');
  assert.equal(CV.toastWhen({ date: '2026-11-17', start: null, allDay: true }, LON, now), 'Yesterday · All day');
});
