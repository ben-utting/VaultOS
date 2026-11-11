'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomationStore } = require('../lib/automation-store');

const T = (iso) => Date.parse(iso);
const ctx = { boardKeys: ['work', 'home'], agentIds: ['default', 'claude'], tz: 'Europe/London' };
const input = (more = {}) => ({
  name: 'Morning check-in', enabled: true, agent: 'default', template: 'check-in', prompt: 'Look.', level: 'report',
  cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
  schedule: { repeat: 'daily', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more,
});
function setup(t, nowIso = '2026-11-11T09:40:00Z') {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-store-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const clock = { now: T(nowIso) };
  let n = 0;
  const store = createAutomationStore(vault, { now: () => clock.now, randomHex: (len) => (++n).toString(16).padStart(len, '0') });
  return { vault, store, clock, file: (rel) => path.join(vault, '.vaultos', rel) };
}
const run = (id, automationId, more = {}) => ({
  id, automationId, automationName: 'A', agent: 'claude', level: 'report', trigger: 'manual',
  startedAt: '2026-11-11T08:00:00.000Z', endedAt: '2026-11-11T08:07:00.000Z', state: 'finished',
  cards: [{ path: 'Work/1. a/01-x/task.md', board: 'work', title: 'X', state: 'noted', reason: '', note: 'secret note', statusChange: null, proposalIgnored: '', filesChanged: [], startedAt: '', durationMs: 1, outputTail: 'tail', doneReverted: false }],
  ...more,
});

test('create → list → get round-trip', async (t) => {
  const { store, file } = setup(t);
  const r = await store.create(input(), ctx);
  assert.equal(r.ok, true);
  assert.match(r.value.id, /^[0-9a-f]{8}$/);
  assert.equal(r.value.created, '2026-11-11T09:40:00.000Z');
  assert.equal(r.value.updated, '2026-11-11T09:40:00.000Z');
  assert.deepEqual(await store.list(), [r.value]);
  assert.deepEqual(await store.get(r.value.id), r.value);
  assert.equal(await store.get('nope'), null);
  const disk = JSON.parse(fs.readFileSync(file('automations.json'), 'utf8'));
  assert.deepEqual(disk, { version: 1, automations: [r.value] });
});

test('create rejects invalid input with field errors and writes nothing', async (t) => {
  const { store, file } = setup(t);
  const r = await store.create(input({ section: 'Plan', name: '' }), ctx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.section && r.errors.name);
  assert.equal(fs.existsSync(file('automations.json')), false);
});

test('create sets lastSlot to the latest slot so nothing catches up', async (t) => {
  const { store } = setup(t);
  const { value } = await store.create(input(), ctx);
  assert.deepEqual(await store.getState(value.id), { lastSlot: T('2026-11-11T08:00:00Z'), lastRunId: null });
});

test('update keeps lastSlot unless the schedule changed', async (t) => {
  const { store, clock } = setup(t);
  const { value } = await store.create(input(), ctx);
  await store.setState(value.id, { lastSlot: T('2026-11-10T08:00:00Z') });
  clock.now = T('2026-11-11T10:00:00Z');
  const renamed = await store.update(value.id, input({ name: 'Renamed' }), ctx);
  assert.equal(renamed.value.name, 'Renamed');
  assert.equal(renamed.value.id, value.id);
  assert.equal(renamed.value.created, value.created);
  assert.equal(renamed.value.updated, '2026-11-11T10:00:00.000Z');
  assert.equal((await store.getState(value.id)).lastSlot, T('2026-11-10T08:00:00Z'));
  await store.update(value.id, input({ schedule: { repeat: 'daily', time: '09:00' } }), ctx);
  assert.equal((await store.getState(value.id)).lastSlot, T('2026-11-11T09:00:00Z'));
  assert.equal(await store.update('nope', input(), ctx), null);
});

test('remove deletes the definition and its state but keeps run files', async (t) => {
  const { store, file } = setup(t);
  const { value } = await store.create(input(), ctx);
  await store.saveRun(run('20261111-080000-0001', value.id));
  assert.equal(await store.remove(value.id), true);
  assert.equal(await store.get(value.id), null);
  assert.deepEqual(await store.getState(value.id), { lastSlot: null, lastRunId: null });
  assert.ok(fs.existsSync(file(`automation-runs/${value.id}/20261111-080000-0001.json`)));
  assert.equal(await store.remove(value.id), false);
});

test('newRunId is UTC time plus 4 hex', (t) => {
  const { store } = setup(t);
  assert.match(store.newRunId(), /^20261111-094000-[0-9a-f]{4}$/);
});

test('saveRun, getRun and listRuns', async (t) => {
  const { store } = setup(t);
  await store.saveRun(run('20261109-080000-0001', 'aaaaaaaa'));
  await store.saveRun(run('20261110-080000-0002', 'bbbbbbbb'));
  await store.saveRun(run('20261111-080000-0003', 'aaaaaaaa'));
  assert.equal((await store.getRun('20261110-080000-0002')).cards[0].note, 'secret note');
  assert.equal(await store.getRun('../../etc/passwd'), null);
  assert.equal(await store.getRun('20991231-000000-ffff'), null);
  const all = await store.listRuns({});
  assert.deepEqual(all.map((r) => r.id), ['20261111-080000-0003', '20261110-080000-0002', '20261109-080000-0001']);
  assert.equal(all[0].cards[0].note, undefined);
  assert.equal(all[0].cards[0].outputTail, undefined);
  assert.equal(all[0].counts.noted, 1);
  assert.deepEqual((await store.listRuns({ automation: 'aaaaaaaa' })).map((r) => r.id), ['20261111-080000-0003', '20261109-080000-0001']);
  assert.deepEqual((await store.listRuns({ limit: 1 })).map((r) => r.id), ['20261111-080000-0003']);
  assert.deepEqual((await store.listRuns({ before: '20261111-080000-0003', limit: 1 })).map((r) => r.id), ['20261110-080000-0002']);
  assert.deepEqual(await store.listRuns({ automation: '../x' }), []);
});

test('recoverRunning marks interrupted runs', async (t) => {
  const { store } = setup(t);
  await store.saveRun(run('20261111-080000-0001', 'aaaaaaaa', {
    state: 'running', endedAt: null,
    cards: [
      { path: 'a', title: 'A', state: 'noted', reason: '' },
      { path: 'b', title: 'B', state: 'running', reason: '' },
      { path: 'c', title: 'C', state: 'waiting', reason: '' },
    ],
  }));
  await store.saveRun(run('20261111-070000-0002', 'aaaaaaaa'));
  assert.equal(await store.recoverRunning(), 1);
  const r = await store.getRun('20261111-080000-0001');
  assert.equal(r.state, 'interrupted');
  assert.equal(r.endedAt, '2026-11-11T09:40:00.000Z');
  assert.deepEqual(r.cards.map((c) => [c.state, c.reason]), [['noted', ''], ['failed', 'VaultOS restarted'], ['not-run', '']]);
  assert.equal((await store.getRun('20261111-070000-0002')).state, 'finished');
});

test('prune deletes runs older than 90 days only', async (t) => {
  const { store } = setup(t);
  await store.saveRun(run('20260801-080000-0001', 'aaaaaaaa'));
  await store.saveRun(run('20260820-080000-0002', 'aaaaaaaa'));
  await store.saveRun(run('20261001-080000-0003', 'aaaaaaaa'));
  assert.equal(await store.prune(), 1);
  assert.deepEqual((await store.listRuns({})).map((r) => r.id), ['20261001-080000-0003', '20260820-080000-0002']);
});

test('a corrupt automations.json is reported and left alone', async (t) => {
  const { store, file } = setup(t);
  fs.mkdirSync(path.dirname(file('automations.json')), { recursive: true });
  fs.writeFileSync(file('automations.json'), '{ not json');
  await assert.rejects(store.list(), /automations\.json/);
  await assert.rejects(store.create(input(), ctx), /automations\.json/);
  assert.equal(fs.readFileSync(file('automations.json'), 'utf8'), '{ not json');
});
