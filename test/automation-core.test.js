'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AC = require('../public/automation-core');

const T = (iso) => Date.parse(iso);
const LON = 'Europe/London';
const slotsBetween = (s, tz, from, to) => {
  const out = [];
  for (let t = AC.nextSlot(s, tz, from); t !== null && t < to; t = AC.nextSlot(s, tz, t)) out.push(t);
  return out;
};

test('daily: lastSlot just after 08:00 London is today 08:00', () => {
  assert.equal(AC.lastSlot({ repeat: 'daily', time: '08:00' }, LON, T('2026-11-11T08:00:30Z')), T('2026-11-11T08:00:00Z'));
});

test('daily in BST', () => {
  assert.equal(AC.lastSlot({ repeat: 'daily', time: '08:00' }, LON, T('2026-07-01T07:30:00Z')), T('2026-07-01T07:00:00Z'));
});

test('weekdays skips the weekend', () => {
  const s = { repeat: 'weekdays', time: '08:00' };
  assert.equal(AC.lastSlot(s, LON, T('2026-11-14T12:00:00Z')), T('2026-11-13T08:00:00Z'));
  assert.equal(AC.nextSlot(s, LON, T('2026-11-14T12:00:00Z')), T('2026-11-16T08:00:00Z'));
});

test('weekly picks the named days', () => {
  const s = { repeat: 'weekly', days: ['mon', 'wed'], time: '17:00' };
  assert.equal(AC.nextSlot(s, LON, T('2026-11-16T17:00:00Z')), T('2026-11-18T17:00:00Z'));
});

test('hours grid', () => {
  const s = { repeat: 'hours', every: 4, from: '08:00' };
  assert.equal(AC.lastSlot(s, LON, T('2026-11-11T13:00:00Z')), T('2026-11-11T12:00:00Z'));
  assert.equal(AC.nextSlot(s, LON, T('2026-11-11T13:00:00Z')), T('2026-11-11T16:00:00Z'));
  assert.equal(AC.nextSlot(s, LON, T('2026-11-11T22:00:00Z')), T('2026-11-12T00:00:00Z'));
  assert.equal(AC.nextSlot(s, LON, T('2026-11-12T00:00:00Z')), T('2026-11-12T04:00:00Z'));
});

test('spring forward: a 01:30 London slot on 2027-03-28 happens once, at 02:30 BST', () => {
  const s = { repeat: 'daily', time: '01:30' };
  assert.equal(AC.lastSlot(s, LON, T('2027-03-28T12:00:00Z')), T('2027-03-28T01:30:00Z'));
  assert.deepEqual(slotsBetween(s, LON, T('2027-03-27T12:00:00Z'), T('2027-03-28T12:00:00Z')), [T('2027-03-28T01:30:00Z')]);
});

test('fall back: a 01:30 London slot on 2026-10-25 happens once, the first time', () => {
  const s = { repeat: 'daily', time: '01:30' };
  assert.equal(AC.lastSlot(s, LON, T('2026-10-25T12:00:00Z')), T('2026-10-25T00:30:00Z'));
  assert.deepEqual(slotsBetween(s, LON, T('2026-10-24T12:00:00Z'), T('2026-10-25T12:00:00Z')), [T('2026-10-25T00:30:00Z')]);
});

test('Lord Howe 30-minute shift does not double or drop', () => {
  const s = { repeat: 'daily', time: '02:15' };
  assert.equal(slotsBetween(s, 'Australia/Lord_Howe', T('2026-10-01T00:00:00Z'), T('2026-10-08T00:00:00Z')).length, 7);
});

test('describeSchedule', () => {
  assert.equal(AC.describeSchedule({ repeat: 'daily', time: '08:00' }), 'Every day 08:00');
  assert.equal(AC.describeSchedule({ repeat: 'weekdays', time: '08:00' }), 'Weekdays 08:00');
  assert.equal(AC.describeSchedule({ repeat: 'weekly', days: ['mon', 'wed'], time: '17:00' }), 'Mon, Wed 17:00');
  assert.equal(AC.describeSchedule({ repeat: 'hours', every: 4, from: '08:00' }), 'Every 4 hours from 08:00');
  assert.equal(AC.describeSchedule({ repeat: 'hours', every: 1, from: '08:00' }), 'Every hour from 08:00');
});
