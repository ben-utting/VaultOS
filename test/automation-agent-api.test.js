'use strict';
// The rules an agent works under (spec §5): drafts saved off, safe vs switch-off edits, trials, delete when off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomationStore } = require('../lib/automation-store');
const { createAgentApi } = require('../lib/automation-agent-api');
const AC = require('../public/automation-core');

const TZ = 'Europe/London';
const ctx = () => ({
  boardKeys: ['work', 'home'], agentIds: ['default', 'claude', 'cursor'], tz: TZ,
  agentLevels: { default: ['report', 'update', 'work'], claude: ['report', 'update', 'work'], cursor: ['report', 'update'] },
  agentLabels: { claude: 'Claude Code', cursor: 'Cursor CLI' }, defaultAgent: 'claude',
});
const draft = (more = {}) => ({
  name: 'Check', agent: 'default', template: 'check-in', prompt: 'Look.', level: 'report',
  cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
  schedule: { repeat: 'weekdays', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more,
});

function setup(t, { start = Date.parse('2026-11-11T09:00:00Z') } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-agent-api-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const clock = { now: start };
  const store = createAutomationStore(vault, { now: () => clock.now });
  const tried = [];
  const removed = [];
  const runner = {
    tryNow: async (id) => (id === 'busy' ? { error: 'It is already queued' } : (await store.get(id)) ? (tried.push(id), { queued: true }) : { error: 'No such automation' }),
    remove: (id) => removed.push(id),
  };
  const api = createAgentApi({
    store, runner, ctx, tz: () => TZ, now: () => clock.now, options: () => ({ hello: 1 }),
    listCards: async () => [
      { path: 'Work/a/task.md', title: 'A', status: 'in-progress', batch: '' },
      { path: 'Work/b/task.md', title: 'B', status: 'backlog', batch: '' },
    ],
  });
  // A switched-on automation the person made in the tab.
  const personOn = async (more = {}) => (await store.create({ ...draft(more), enabled: true }, ctx())).value;
  return { store, api, clock, tried, removed, personOn };
}

test('create saves it off and tags it, whatever enabled says', async (t) => {
  const s = setup(t);
  const r = await s.api.create({ ...draft(), enabled: true }, 'Cursor CLI');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.automation.enabled, false);
  assert.deepEqual(r.body.automation.origin, { by: 'agent', agent: 'Cursor CLI', at: '2026-11-11T09:00:00.000Z' });
  assert.equal((await s.store.get(r.body.automation.id)).enabled, false);
});

test('create ignores id, origin, created and unknown keys', async (t) => {
  const s = setup(t);
  const r = await s.api.create({ ...draft(), id: 'mine', origin: { by: 'person' }, created: '2020-01-01', agentChange: { fields: ['x'] }, rogue: 1 }, 'Claude Code');
  const a = r.body.automation;
  assert.notEqual(a.id, 'mine');
  assert.equal(a.origin.by, 'agent');
  assert.equal(a.origin.agent, 'Claude Code');
  assert.notEqual(a.created, '2020-01-01');
  assert.equal('agentChange' in a, false);
  assert.equal('rogue' in a, false);
});

test('create reports field errors as a 400', async (t) => {
  const s = setup(t);
  const r = await s.api.create(draft({ agent: 'cursor', level: 'work' }), 'Cursor CLI');
  assert.equal(r.status, 400);
  assert.equal(r.body.errors.level, "Cursor CLI can't run at Work");
});

test('create refuses the 11th agent draft that is still off', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await s.api.create(draft({ name: `D${i}` }), 'Cursor CLI')).status, 200);
  const r = await s.api.create(draft({ name: 'D10' }), 'Cursor CLI');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'There are already 10 drafts from agents. Delete some or switch them on first.');
});

test('a safe edit keeps an automation on', async (t) => {
  const s = setup(t);
  const a = await s.personOn();
  const r = await s.api.edit(a.id, { name: 'Morning', schedule: { time: '09:00' }, timeLimitMin: 5, section: 'Check-in' }, 'Cursor CLI');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body.automation;
  assert.equal(b.enabled, true);
  assert.equal(b.name, 'Morning');
  assert.deepEqual(b.schedule, { repeat: 'weekdays', time: '09:00' });
  assert.equal('agentChange' in b, false);
});

test('a prompt or cards edit switches it off and records what changed', async (t) => {
  const s = setup(t);
  const a = await s.personOn();
  const r = await s.api.edit(a.id, { prompt: 'Look harder.', cards: { statuses: ['blocked'] } }, 'Cursor CLI');
  const b = r.body.automation;
  assert.equal(b.enabled, false);
  assert.deepEqual(b.agentChange, { agent: 'Cursor CLI', fields: ['prompt', 'cards'], switchedOff: true, at: '2026-11-11T09:00:00.000Z' });
  assert.equal(AC.agentTagText(b, TZ), 'Cursor CLI changed the prompt and cards. Off until you switch it on.');
  // A later safe edit keeps the explanation; a later switch-off edit adds to it.
  s.clock.now += 60000;
  const c = (await s.api.edit(a.id, { name: 'Renamed' }, 'Cursor CLI')).body.automation;
  assert.deepEqual(c.agentChange.fields, ['prompt', 'cards']);
  const d = (await s.api.edit(a.id, { level: 'update' }, 'Cursor CLI')).body.automation;
  assert.deepEqual(d.agentChange.fields, ['prompt', 'cards', 'level']);
  assert.equal(d.agentChange.switchedOff, true);
});

test('a partial cards or schedule edit keeps the rest', async (t) => {
  const s = setup(t);
  const a = await s.personOn({ cards: { board: 'home', statuses: ['in-progress'], subtasks: true } });
  const b = (await s.api.edit(a.id, { cards: { statuses: ['blocked'] }, schedule: { time: '07:30' } }, 'Cursor CLI')).body.automation;
  assert.deepEqual(b.cards, { board: 'home', statuses: ['blocked'], subtasks: true });
  assert.deepEqual(b.schedule, { repeat: 'weekdays', time: '07:30' });
});

test('edit never switches one on, but may switch one off', async (t) => {
  const s = setup(t);
  const { automation } = (await s.api.create(draft(), 'Cursor CLI')).body;
  assert.equal((await s.api.edit(automation.id, { enabled: true }, 'Cursor CLI')).body.automation.enabled, false);
  const on = await s.personOn({ name: 'On' });
  assert.equal((await s.api.edit(on.id, { enabled: false }, 'Cursor CLI')).body.automation.enabled, false);
  assert.equal((await s.api.edit('nope', { name: 'x' }, 'Cursor CLI')).status, 404);
});

test('off keeps the tags and is fine when it is already off', async (t) => {
  const s = setup(t);
  const on = await s.personOn();
  const r = await s.api.off(on.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.automation.enabled, false);
  const { automation } = (await s.api.create(draft({ name: 'Draft' }), 'Cursor CLI')).body;
  assert.deepEqual((await s.api.off(automation.id)).body.automation.origin, automation.origin);
});

test('delete refuses an automation that is on', async (t) => {
  const s = setup(t);
  const on = await s.personOn();
  const r = await s.api.remove(on.id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Switch it off in the Automations tab before deleting it.');
  assert.ok(await s.store.get(on.id));
  const { automation } = (await s.api.create(draft({ name: 'Draft' }), 'Cursor CLI')).body;
  assert.equal((await s.api.remove(automation.id)).status, 200);
  assert.equal(await s.store.get(automation.id), null);
  assert.deepEqual(s.removed, [automation.id]);
});

test('the seventh trial in an hour is refused with the time it frees up', async (t) => {
  const s = setup(t);
  const { automation } = (await s.api.create(draft(), 'Cursor CLI')).body;
  for (let i = 0; i < 6; i++) {
    const r = await s.api.tryRun(automation.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.queued, true);
    s.clock.now += 5 * 60000;
  }
  const r = await s.api.tryRun(automation.id);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Too many trials this hour; try again after 10:00.');   // first at 09:00 UTC = 09:00 London
  s.clock.now = Date.parse('2026-11-11T10:00:01Z');
  assert.equal((await s.api.tryRun(automation.id)).status, 200);
});

test('a trial the runner refuses is not counted and says why', async (t) => {
  const s = setup(t);
  assert.equal((await s.api.tryRun('nope')).status, 404);
  const busy = await s.api.tryRun('busy');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'It is already queued');
});

test('list, show, match, runs and run read without changing anything', async (t) => {
  const s = setup(t);
  const { automation } = (await s.api.create(draft(), 'Cursor CLI')).body;
  const l = await s.api.list();
  assert.equal(l.status, 200);
  assert.equal(l.body.automations[0].tag, 'Draft from Cursor CLI · 11 Nov');
  assert.equal(l.body.automations[0].scheduleText, AC.describeSchedule(automation.schedule));
  assert.equal((await s.api.show(automation.id)).body.automation.id, automation.id);
  assert.equal((await s.api.show('nope')).status, 404);
  assert.deepEqual((await s.api.match({ id: automation.id })).body, { count: 1, cards: [{ title: 'A', status: 'in-progress', path: 'Work/a/task.md' }] });
  assert.equal((await s.api.match({ draft: { cards: { board: 'work', statuses: ['backlog'] } } })).body.count, 1);
  assert.deepEqual((await s.api.runs({})).body, { runs: [] });
  assert.equal((await s.api.run('20261111-090000-0001')).status, 404);
  assert.deepEqual((await s.api.options()).body, { hello: 1 });
});
