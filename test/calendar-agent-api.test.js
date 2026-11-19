'use strict';
// What an agent in a VaultOS terminal may do with the calendar (spec §7), over the real service with a fixed clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCalendarService } = require('../lib/calendar-service');
const { createCalendarAgentApi, CREATES_PER_HOUR, DELETES_PER_HOUR } = require('../lib/calendar-agent-api');
const { agentLabelFromNames, PROFILES } = require('../lib/agents');

const RATE = 'Too many calendar changes from agents in the last hour';
function setup(t, nowIso = '2026-11-18T10:05:00Z') {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-api-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const clock = { now: Date.parse(nowIso) };
  const now = () => clock.now;
  const settings = () => ({ features: { calendar: true }, today: { timezone: 'Europe/London' }, boards: [] });
  const svc = createCalendarService({
    vaultDir: vault, settings, boards: () => [], resolveWorkspace: () => ({ dir: vault }), scanAll: async () => [],
    safeVaultPath: async (rel) => path.join(vault, rel), now, profiles: PROFILES,
  });
  const api = createCalendarAgentApi({ store: svc.view.store, view: svc.view, tz: () => 'Europe/London', now });
  return { api, clock, svc };
}
const one = (more = {}) => ({ title: 'Chase X', date: '2026-11-20', start: '09:00', ...more });

test('agentLabelFromNames maps process names to the profile label', () => {
  assert.equal(agentLabelFromNames(['bash', 'claude'], PROFILES), 'Claude Code');
  assert.equal(agentLabelFromNames(['/usr/bin/node', '/home/x/.local/bin/cursor-agent'], PROFILES), 'Cursor CLI');
  assert.equal(agentLabelFromNames(['bash', 'node', 5, null], PROFILES), 'An agent');
});

test('add resolves today/tomorrow in the VaultOS zone and tags the agent', async (t) => {
  const { api } = setup(t, '2026-11-18T23:30:00Z');   // still the 18th in London
  const r = await api.add({ entry: one({ date: 'tomorrow', repeat: { every: 'daily', until: 'tomorrow' } }) }, 'Claude Code');
  assert.equal(r.status, 200);
  assert.equal(r.body.entry.date, '2026-11-19');
  assert.equal(r.body.entry.repeat.until, '2026-11-19');
  assert.deepEqual(r.body.entry.created.by, { kind: 'agent', agent: 'Claude Code' });
  assert.equal((await api.add({ entry: one({ date: 'today' }) }, 'Pi')).body.entry.date, '2026-11-18');
});

test('add with a bad date names the field', async (t) => {
  const { api } = setup(t);
  const r = await api.add({ entry: { title: 'X', date: 'Friday', start: '09:00' } }, 'Claude Code');
  assert.equal(r.status, 400);
  assert.match(r.body.errors.date, /YYYY-MM-DD/);
  assert.equal((await api.add({}, 'Claude Code')).status, 400);
});

test('the 31st create in an hour is refused with 429; an hour later it works', async (t) => {
  const { api, clock } = setup(t);
  assert.equal(CREATES_PER_HOUR, 30);
  for (let i = 0; i < 30; i++) assert.equal((await api.add({ entry: one({ title: `E${i}` }) }, 'Claude Code')).status, 200);
  const over = await api.add({ entry: one() }, 'Claude Code');
  assert.equal(over.status, 429);
  assert.equal(over.body.error, RATE);
  clock.now += 3600 * 1000 + 1;
  assert.equal((await api.add({ entry: one() }, 'Claude Code')).status, 200);
});

test('refused creates don\'t count towards the limit', async (t) => {
  const { api } = setup(t);
  for (let i = 0; i < 40; i++) assert.equal((await api.add({ entry: one({ date: 'nope' }) }, 'Claude Code')).status, 400);
  assert.equal((await api.add({ entry: one() }, 'Claude Code')).status, 200);
});

test('the 21st delete in an hour is refused', async (t) => {
  const { api } = setup(t);
  assert.equal(DELETES_PER_HOUR, 20);
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await api.add({ entry: one({ title: `E${i}` }) }, 'Claude Code')).body.entry.id);
  for (let i = 0; i < 20; i++) assert.equal((await api.delete({ id: ids[i] }, 'Claude Code')).status, 200);
  const over = await api.delete({ id: ids[20] }, 'Claude Code');
  assert.equal(over.status, 429);
  assert.equal(over.body.error, RATE);
  assert.equal((await api.show({ id: ids[20] })).status, 200);
});

test('edit, skip, show, deleted, restore and list', async (t) => {
  const { api } = setup(t);
  const id = (await api.add({ entry: one({ date: 'today', repeat: { every: 'daily' } }) }, 'Cursor CLI')).body.entry.id;
  const ed = await api.edit({ id, changes: { start: '10:00' } }, 'Claude Code');
  assert.equal(ed.status, 200);
  assert.deepEqual(ed.body.entry.updated.by, { kind: 'agent', agent: 'Claude Code' });
  assert.deepEqual(ed.body.entry.created.by, { kind: 'agent', agent: 'Cursor CLI' });
  assert.equal((await api.skip({ id, date: 'tomorrow' }, 'Claude Code')).body.entry.skip[0], '2026-11-19');
  assert.equal((await api.show({ id })).body.entry.repeatText, 'Every day');
  assert.equal((await api.edit({ id: 'c_nonexisten', changes: {} }, 'X')).status, 404);
  const l = await api.list({ from: 'today', to: '2026-11-21' });
  assert.equal(l.status, 200);
  assert.equal(l.body.from, '2026-11-18');
  assert.deepEqual(l.body.days.map((d) => d.date), ['2026-11-18', '2026-11-20', '2026-11-21']);   // 19th skipped, empty days left out
  assert.equal(l.body.days[0].occurrences[0].start, '10:00');
  assert.equal((await api.list({ from: 'today', to: '2027-03-01' })).status, 400);   // more than 62 days
  assert.deepEqual((await api.list({ search: 'chase' })).body.days.length, 13);   // default: today + 13 days, minus the skip
  assert.deepEqual((await api.list({ search: 'nothing like it' })).body.days, []);
  await api.delete({ id }, 'Claude Code');
  assert.deepEqual((await api.deleted()).body.entries.map((e) => e.id), [id]);
  assert.equal((await api.restore({ id }, 'Claude Code')).status, 200);
});

test('done with an entry id acts on its listed due item; nothing due → 404', async (t) => {
  const { api, clock } = setup(t, '2026-11-18T08:00:00Z');
  const id = (await api.add({ entry: one({ date: 'today', start: '09:00', repeat: { every: 'daily' } }) }, 'Claude Code')).body.entry.id;
  const none = await api.done({ target: id }, 'Claude Code');
  assert.equal(none.status, 404);
  assert.equal(none.body.error, 'Nothing due for that entry');
  clock.now = Date.parse('2026-11-18T09:01:00Z');
  assert.equal((await api.due()).body.count, 1);
  assert.equal((await api.snooze({ target: id, for: '30m' }, 'Claude Code')).status, 200);
  assert.equal((await api.due()).body.count, 0);
  clock.now = Date.parse('2026-11-18T09:32:00Z');
  assert.equal((await api.due()).body.count, 1);
  assert.equal((await api.snooze({ target: id, for: '25h' }, 'Claude Code')).status, 400);
  assert.equal((await api.done({ target: `${id}@2026-11-18` }, 'Claude Code')).status, 200);
  assert.equal((await api.due()).body.count, 0);
  assert.equal((await api.dismiss({ target: 'c_nonexisten' }, 'Claude Code')).status, 404);
});

test('today answers the real date, time, zone and weekday', async (t) => {
  const { api } = setup(t, '2026-07-01T09:05:00Z');   // 10:05 BST
  await api.add({ entry: one({ date: 'today', start: '11:00' }) }, 'Claude Code');
  const r = await api.today();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.now, { date: '2026-07-01', time: '10:05', timezone: 'Europe/London', weekday: 'Wednesday' });
  assert.equal(r.body.entries.length, 1);
  assert.deepEqual(r.body.due, []);
});

test('list --search also matches the focus for the agent', async (t) => {
  const { api } = setup(t);
  await api.add({ entry: one({ title: 'Supplier', brief: 'Check the PR review' }) }, 'Claude Code');
  const days = (await api.list({ search: 'pr review' })).body.days;
  assert.equal(days.length, 1);
  assert.equal(days[0].occurrences[0].title, 'Supplier');
});
test('views carry the entry agent and its label', async (t) => {
  const { api } = setup(t);
  const { entry } = (await api.add({ entry: one({ agent: 'cursor' }) }, 'Claude Code')).body;
  const shown = (await api.show({ id: entry.id })).body.entry;
  assert.deepEqual([shown.agent, shown.agentLabel], ['cursor', 'Cursor CLI']);
  const occ = (await api.list({})).body.days[0].occurrences[0];
  assert.deepEqual([occ.agent, occ.agentLabel], ['cursor', 'Cursor CLI']);
  const plain = (await api.add({ entry: one({ title: 'Plain' }) }, 'Claude Code')).body.entry;
  assert.deepEqual([(await api.show({ id: plain.id })).body.entry.agentLabel], [null]);
});
