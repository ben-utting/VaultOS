'use strict';
// Calendar reminders proposed by automations: the calendar service's upcomingForCard and addFromAutomation
// (dedupe, the 15-minute slot picker, trials that write nothing, Calendar off, the hourly cap).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCalendarService, pickSlot, AUTOMATION_REMINDERS_PER_HOUR } = require('../lib/calendar-service');
const { PROFILES } = require('../lib/agents');

const CARD = 'Work/1. a/01-a/task.md';
const OTHER = 'Work/1. a/02-b/task.md';
function setup(t, nowIso = '2026-11-25T19:00:00Z', { calendar = true } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-auto-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  for (const rel of [CARD, OTHER]) {
    fs.mkdirSync(path.join(vault, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\ntitle: x\nstatus: in-progress\n---\n');
  }
  const clock = { now: Date.parse(nowIso) };
  const flags = { calendar };
  const settings = () => ({ features: { calendar: flags.calendar }, today: { timezone: 'Europe/London' }, boards: [] });
  const svc = createCalendarService({
    vaultDir: vault, settings, boards: () => [], resolveWorkspace: () => ({ dir: vault }), scanAll: async () => [],
    safeVaultPath: async (rel) => path.join(vault, rel), now: () => clock.now, profiles: PROFILES,
  });
  const file = path.join(vault, '.vaultos', 'calendar.json');
  const disk = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const ME = { kind: 'person' };
  const add = (e) => svc.view.store.create({ ping: null, ...e }, ME);
  return { svc, clock, flags, disk, add, file };
}
const proposal = (more = {}) => ({ date: '2026-11-26', time: null, end: null, title: '', ping: 'start', note: '', brief: '', ...more });
const opts = (more = {}) => ({ card: CARD, cardTitle: 'Card A', automationName: 'Evening check', dryRun: false, ...more });

// ---------- pickSlot ----------
test('pickSlot: the first free 15-minute slot from 09:00', () => {
  assert.equal(pickSlot({ busy: [] }), '09:00');
  assert.equal(pickSlot({ busy: [['09:00', null]] }), '09:15');
  assert.equal(pickSlot({ busy: [['09:00', null], ['09:15', null]] }), '09:30');
});

test('pickSlot: an entry with an end blocks every slot it covers', () => {
  assert.equal(pickSlot({ busy: [['09:00', '10:00']] }), '10:00');
  assert.equal(pickSlot({ busy: [['09:10', null]] }), '09:30');   // 09:10–09:25 overlaps both 09:00 and 09:15
});

test('pickSlot: none free before 16:00 gives null', () => {
  assert.equal(pickSlot({ busy: [['09:00', '16:00']] }), null);
  assert.equal(pickSlot({ busy: [['09:00', '15:45']] }), '15:45');
});

test('pickSlot: on today, only slots after now', () => {
  assert.equal(pickSlot({ busy: [], after: '10:07' }), '10:15');
  assert.equal(pickSlot({ busy: [], after: '10:15' }), '10:30');
  assert.equal(pickSlot({ busy: [], after: '15:50' }), null);
});

// ---------- addFromAutomation ----------
test('a reminder with no time takes 09:00 and is saved tagged as the automation, linked to the card', async (t) => {
  const { svc, disk } = setup(t);
  const r = await svc.addFromAutomation(proposal({ note: 'Chase it', brief: 'Draft the email' }), opts());
  assert.equal(r.ok, true);
  assert.equal(r.entry.start, '09:00');
  assert.equal(r.entry.title, 'Card A');
  assert.equal(r.entry.card, CARD);
  assert.equal(r.entry.allDay, false);
  assert.equal(r.entry.repeat, null);
  assert.equal(r.entry.ping, 'start');
  assert.equal(r.entry.note, 'Chase it');
  assert.equal(r.entry.brief, 'Draft the email');
  assert.deepEqual(r.entry.created.by, { kind: 'agent', agent: 'Automation: Evening check' });
  assert.equal(disk().entries.length, 1);
});

test('reminders for different cards on one date stagger past what is taken', async (t) => {
  const { svc, add } = setup(t);
  await add({ title: 'Stand-up', date: '2026-11-26', start: '09:00', end: '09:15' });
  const a = await svc.addFromAutomation(proposal(), opts());
  const b = await svc.addFromAutomation(proposal(), opts({ card: OTHER, cardTitle: 'Card B' }));
  assert.deepEqual([a.entry.start, b.entry.start], ['09:15', '09:30']);
});

test('an explicit time and end are kept, even over another entry', async (t) => {
  const { svc, add } = setup(t);
  await add({ title: 'Busy', date: '2026-11-26', start: '10:00', end: '11:00' });
  const r = await svc.addFromAutomation(proposal({ time: '10:30', end: '10:45', title: 'Call', ping: null }), opts());
  assert.equal(r.ok, true);
  assert.deepEqual([r.entry.start, r.entry.end, r.entry.title, r.entry.ping], ['10:30', '10:45', 'Call', null]);
});

test('a card that already has a reminder on that date is skipped (a re-run adds no duplicate)', async (t) => {
  const { svc, disk } = setup(t);
  assert.equal((await svc.addFromAutomation(proposal(), opts())).ok, true);
  const again = await svc.addFromAutomation(proposal({ time: '14:00' }), opts());
  assert.deepEqual(again, { skipped: 'already has a reminder on that date' });
  assert.equal(disk().entries.length, 1);
});

test('the card match ignores a trailing /task.md, and a repeat that falls on the date counts', async (t) => {
  const { svc, add } = setup(t);
  await add({ title: 'Weekly', date: '2026-11-19', start: '08:00', card: CARD, repeat: { every: 'weekly', days: [3] } });   // Thursdays
  const r = await svc.addFromAutomation(proposal(), opts({ card: 'Work/1. a/01-a' }));
  assert.deepEqual(r, { skipped: 'already has a reminder on that date' });
});

test('a reminder the person deleted for that card and date is not added again', async (t) => {
  const { svc } = setup(t);
  const r = await svc.addFromAutomation(proposal(), opts());
  await svc.view.remove(r.entry.id, { kind: 'person' });
  assert.deepEqual(await svc.addFromAutomation(proposal(), opts()), { skipped: 'a reminder for that date was deleted, so it is not added again' });
});

test('a past date, or a time already gone today, is skipped', async (t) => {
  const { svc } = setup(t);   // 19:00 on 25 Nov in London
  assert.deepEqual(await svc.addFromAutomation(proposal({ date: '2026-11-24' }), opts()), { skipped: 'that date has passed' });
  assert.deepEqual(await svc.addFromAutomation(proposal({ date: '2026-11-25', time: '18:00' }), opts()), { skipped: 'that time has already passed today' });
  assert.deepEqual(await svc.addFromAutomation(proposal({ date: '2026-11-25' }), opts()), { skipped: 'no free 15-minute slot before 16:00' });
});

test('today before 16:00 picks the next slot after now', async (t) => {
  const { svc } = setup(t, '2026-11-25T10:07:00Z');
  const r = await svc.addFromAutomation(proposal({ date: '2026-11-25' }), opts());
  assert.equal(r.entry.start, '10:15');
});

test('a full day is skipped', async (t) => {
  const { svc, add } = setup(t);
  await add({ title: 'Offsite', date: '2026-11-26', start: '08:00', end: '17:00' });
  assert.deepEqual(await svc.addFromAutomation(proposal(), opts()), { skipped: 'no free 15-minute slot before 16:00' });
});

test('a trial writes nothing but says what it would add, staggered past the run\'s own picks', async (t) => {
  const { svc, disk, file } = setup(t);
  const a = await svc.addFromAutomation(proposal(), opts({ dryRun: true }));
  assert.equal(a.ok, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.entry.start, '09:00');
  assert.equal(a.entry.id, undefined);
  const b = await svc.addFromAutomation(proposal(), opts({ dryRun: true, card: OTHER, taken: [{ date: '2026-11-26', start: '09:00', end: null }] }));
  assert.equal(b.entry.start, '09:15');
  assert.equal(fs.existsSync(file), false);
  assert.equal(disk(), null);
});

test('a trial still reports a duplicate or a bad field', async (t) => {
  const { svc } = setup(t);
  await svc.addFromAutomation(proposal(), opts());
  assert.deepEqual(await svc.addFromAutomation(proposal(), opts({ dryRun: true })), { skipped: 'already has a reminder on that date' });
  const bad = await svc.addFromAutomation(proposal({ date: '2026-11-27', ping: '1d', time: '09:00', title: 'x'.repeat(300) }), opts({ dryRun: true }));
  assert.match(bad.skipped, /^the calendar refused it: title: /);
});

test('Calendar switched off: skipped with the reason, nothing written', async (t) => {
  const { svc, file } = setup(t, undefined, { calendar: false });
  assert.deepEqual(await svc.addFromAutomation(proposal(), opts()), { skipped: 'Calendar is switched off' });
  assert.deepEqual(await svc.addFromAutomation(proposal(), opts({ dryRun: true })), { skipped: 'Calendar is switched off' });
  assert.equal(fs.existsSync(file), false);
});

test('a damaged calendar.json is skipped, never overwritten', async (t) => {
  const { svc, file } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ nope');
  const r = await svc.addFromAutomation(proposal(), opts());
  assert.match(r.skipped, /can't read \.vaultos\/calendar\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
});

test('automations add at most so many reminders an hour; trials do not count', async (t) => {
  const { svc, clock } = setup(t);
  assert.equal(AUTOMATION_REMINDERS_PER_HOUR, 30);
  for (let i = 0; i < 40; i++) await svc.addFromAutomation(proposal({ date: '2026-11-27' }), opts({ dryRun: true, card: `Work/x/${i}/task.md` }));
  let day = 0;
  for (let i = 0; i < 30; i++) {
    const r = await svc.addFromAutomation(proposal({ date: `2026-12-${String(1 + (day++ % 28)).padStart(2, '0')}`, time: `${String(9 + Math.floor(i / 28)).padStart(2, '0')}:00` }), opts({ card: `Work/x/${i}/task.md` }));
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const over = await svc.addFromAutomation(proposal({ date: '2026-12-30' }), opts({ card: 'Work/x/99/task.md' }));
  assert.deepEqual(over, { skipped: 'too many reminders from automations in the last hour' });
  clock.now += 3600 * 1000 + 1;
  assert.equal((await svc.addFromAutomation(proposal({ date: '2026-12-30' }), opts({ card: 'Work/x/99/task.md' }))).ok, true);
});

// ---------- upcomingForCard ----------
test('upcomingForCard lists the card\'s entries from today on, each at its next date', async (t) => {
  const { svc, add } = setup(t);
  await add({ title: 'Past', date: '2026-11-20', start: '09:00', card: CARD });
  await add({ title: 'Later', date: '2026-12-02', allDay: true, card: CARD });
  await add({ title: 'Weekly', date: '2026-11-02', start: '08:00', card: CARD, repeat: { every: 'weekly', days: [0] } });   // Mondays
  await add({ title: 'Other card', date: '2026-11-26', start: '09:00', card: OTHER });
  await add({ title: 'Today', date: '2026-11-25', start: '08:00', card: CARD });
  const list = await svc.upcomingForCard('Work/1. a/01-a/');
  assert.deepEqual(list.map((r) => [r.date, r.start, r.allDay, r.title, !!r.repeat]), [
    ['2026-11-25', '08:00', false, 'Today', false],
    ['2026-11-30', '08:00', false, 'Weekly', true],
    ['2026-12-02', null, true, 'Later', false],
  ]);
});

test('upcomingForCard is empty with Calendar off or a damaged file', async (t) => {
  const { svc, flags, add, file } = setup(t);
  await add({ title: 'X', date: '2026-11-26', start: '09:00', card: CARD });
  flags.calendar = false;
  assert.deepEqual(await svc.upcomingForCard(CARD), []);
  flags.calendar = true;
  fs.writeFileSync(file, '{ nope');
  assert.deepEqual(await svc.upcomingForCard(CARD), []);
});
