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

// ---------- Validation, templates, summaries (Task 3) ----------
const ctx = { boardKeys: ['work', 'home'], agentIds: ['default', 'claude'] };
const example = () => ({
  name: 'Morning check-in',
  enabled: true,
  agent: 'default',
  template: 'check-in',
  prompt: 'Look at this card.',
  level: 'report',
  cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
  schedule: { repeat: 'weekdays', time: '08:00' },
  section: 'Latest check-in',
  timeLimitMin: 10,
});
const errorsFor = (patch) => {
  const a = example();
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('cards.')) a.cards[k.slice(6)] = v; else a[k] = v;
  }
  const r = AC.validateAutomation(a, ctx);
  assert.equal(r.ok, false, `expected ${JSON.stringify(patch)} to be refused`);
  return r.errors;
};

test('validateAutomation accepts the check-in example', () => {
  const r = AC.validateAutomation(example(), ctx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value, example());
});

test('errors are per field', () => {
  assert.ok(errorsFor({ name: '' }).name);
  assert.ok(errorsFor({ name: 'x'.repeat(61) }).name);
  assert.ok(errorsFor({ prompt: 'x'.repeat(8001) }).prompt);
  assert.ok(errorsFor({ prompt: '   ' }).prompt);
  assert.ok(errorsFor({ level: 'admin' }).level);
  assert.ok(errorsFor({ 'cards.board': 'nope' }).board);
  assert.ok(errorsFor({ 'cards.statuses': [] }).statuses);
  assert.ok(errorsFor({ 'cards.statuses': ['done'] }).statuses);
  assert.ok(errorsFor({ schedule: { repeat: 'hours', every: 5, from: '08:00' } }).schedule);
  assert.ok(errorsFor({ schedule: { repeat: 'daily', time: '8:00' } }).schedule);
  assert.ok(errorsFor({ schedule: { repeat: 'weekly', days: [], time: '08:00' } }).schedule);
  assert.equal(errorsFor({ section: 'Plan' }).section, "That's one of the card's own sections");
  assert.equal(errorsFor({ section: 'progress log' }).section, "That's one of the card's own sections");
  assert.ok(errorsFor({ section: 'a/b' }).section);
  assert.ok(errorsFor({ timeLimitMin: 31 }).timeLimitMin);
  assert.ok(errorsFor({ timeLimitMin: 1 }).timeLimitMin);
  assert.ok(errorsFor({ agent: 'codex' }).agent);
  assert.ok(errorsFor({ template: 'other' }).template);
});

test("board 'all' is accepted and statuses come back in board order", () => {
  const a = example();
  a.cards = { board: 'all', statuses: ['blocked', 'in-progress', 'blocked'], subtasks: true };
  const r = AC.validateAutomation(a, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.cards, { board: 'all', statuses: ['in-progress', 'blocked'], subtasks: true });
});

test('schedule is normalised to its own fields', () => {
  const a = example();
  a.schedule = { repeat: 'hours', every: 4, from: '08:00', time: '09:00', days: ['mon'] };
  assert.deepEqual(AC.validateAutomation(a, ctx).value.schedule, { repeat: 'hours', every: 4, from: '08:00' });
});

test('runSummary', () => {
  const start = Date.parse('2026-11-11T08:00:00Z');
  const cards = [...Array(5)].map(() => ({ state: 'noted' })).concat([{ state: 'skipped' }]);
  const run = { state: 'finished', startedAt: new Date(start).toISOString(), endedAt: new Date(start + 7 * 60000).toISOString(), cards };
  assert.equal(AC.runSummary(run), '6 cards · 7 min · 5 noted, 1 skipped');
  assert.deepEqual(AC.runCounts(run), { noted: 5, skipped: 1, failed: 0, timedOut: 0, notRun: 0, moved: 0 });
  assert.equal(AC.runSummary({ ...run, state: 'running' }), 'running');
  assert.equal(AC.runSummary({ ...run, endedAt: new Date(start + 20000).toISOString(), cards: [{ state: 'timed-out' }] }), '1 card · <1 min · 1 timed out');
});

test('templates, level text and paragraphs carry the spec copy', () => {
  assert.match(AC.TEMPLATES['check-in'].prompt, /^Look at this card and tell Ben where it stands\./);
  assert.match(AC.TEMPLATES['check-in'].prompt, /\*\*Waiting on you:\*\* what Ben needs to decide or do, or "Nothing"\./);
  assert.equal(AC.TEMPLATES.blank.prompt, '');
  assert.equal(AC.LEVEL_TEXT.update, 'Can also move the card (never to Done).');
  assert.equal(AC.LEVEL_PARAGRAPHS.report, "You can read and search files. Don't try to change anything: VaultOS writes your note into the card.");
  assert.equal(AC.LEVEL_PARAGRAPHS.update, `${AC.LEVEL_PARAGRAPHS.report} You may propose a status change in a vaultos-update block.`);
  assert.equal(AC.MAX_CARDS, 20);
  assert.equal(AC.STATUS_LABEL['in-progress'], 'In Progress');
});

// ---------- Display helpers (Task 10) ----------
test('whenText reads relative to now in the zone', () => {
  const now = T('2026-11-11T12:00:00Z');   // Wed
  assert.equal(AC.whenText(T('2026-11-11T08:00:00Z'), now, LON), 'Today 08:00');
  assert.equal(AC.whenText(T('2026-11-12T08:00:00Z'), now, LON), 'Tomorrow 08:00');
  assert.equal(AC.whenText(T('2026-11-10T08:00:00Z'), now, LON), 'Yesterday 08:00');
  assert.equal(AC.whenText(T('2026-11-14T08:00:00Z'), now, LON), 'Sat 08:00');
  assert.equal(AC.whenText(T('2026-11-07T08:00:00Z'), now, LON), 'Sat 7 Nov 08:00');
  assert.equal(AC.whenText(T('2026-12-25T08:00:00Z'), now, LON), '25 Dec 08:00');
});

test('cardsText names statuses and the board', () => {
  assert.equal(AC.cardsText({ board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false }, 'Work'), 'In Progress + Blocked · Work');
  assert.equal(AC.cardsText({ board: 'all', statuses: ['review'], subtasks: true }, null), 'Review · All boards · with subtasks');
});

test('lastRunTone and failureText', () => {
  assert.equal(AC.lastRunTone({ state: 'finished', cards: [{ state: 'noted' }] }), 'ok');
  assert.equal(AC.lastRunTone({ state: 'finished', cards: [{ state: 'noted' }, { state: 'skipped' }] }), 'warn');
  assert.equal(AC.lastRunTone({ state: 'stopped', cards: [] }), 'warn');
  assert.equal(AC.lastRunTone({ state: 'failed', cards: [] }), 'bad');
  assert.equal(AC.lastRunTone({ state: 'interrupted', cards: [] }), 'bad');
  const run = { state: 'failed', cards: [{ state: 'failed', reason: 'the agent exited with code 127\nmore' }, { state: 'not-run', reason: '' }] };
  assert.equal(AC.failureText(run), 'the agent exited with code 127');
  assert.equal(AC.failureText({ state: 'finished', cards: [] }), '');
});
