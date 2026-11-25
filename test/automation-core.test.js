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

// ---------- The model (passed to Cursor as --model) ----------

test('model: left out or null means none, and the value carries no model key', () => {
  assert.equal('model' in AC.validateAutomation(example(), ctx).value, false);
  const r = AC.validateAutomation({ ...example(), model: null }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal('model' in r.value, false);
});

test('model: a set id is kept, trimmed; a parameterized id is fine', () => {
  assert.equal(AC.validateAutomation({ ...example(), model: '  gpt-5  ' }, ctx).value.model, 'gpt-5');
  const id = 'claude-opus-4-8[context=1m,effort=high,fast=false]';
  assert.equal(AC.validateAutomation({ ...example(), model: id }, ctx).value.model, id);
  assert.equal(AC.validateAutomation({ ...example(), model: 'm'.repeat(200) }, ctx).value.model, 'm'.repeat(200));
});

test('model: empty, multi-line, over 200 characters, control characters, a leading dash or a non-string are refused', () => {
  for (const model of ['', '   ', 'gpt-5\nrm -rf', 'gpt-5\r', 'a\tb', 'gpt\u0000', 'gpt x', 'm'.repeat(201), '--force', 42, ['gpt-5'], {}]) {
    assert.ok(errorsFor({ model }).model, `expected ${JSON.stringify(model)} to be refused`);
  }
});

test('model: it is not checked against any list of models', () => {
  assert.equal(AC.validateAutomation({ ...example(), model: 'some-model-from-next-year' }, ctx).ok, true);
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
  assert.match(AC.TEMPLATES['check-in'].prompt, /^Look at this card and tell me where it stands\./);
  assert.match(AC.TEMPLATES['check-in'].prompt, /\*\*Waiting on you:\*\* what I need to decide or do, or "Nothing"\./);
  // A list, so the three parts stay apart wherever the note is rendered (markdown joins plain lines).
  assert.match(AC.TEMPLATES['check-in'].prompt, /^- \*\*Where it stands:\*\*/m);
  assert.match(AC.TEMPLATES['check-in'].prompt, /^- \*\*Next step:\*\*/m);
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

// ---------- Agent and level, checked together ----------
const levelCtx = (more = {}) => ({
  boardKeys: ['work'], agentIds: ['default', 'claude', 'cursor'],
  agentLevels: { default: ['report', 'update'], claude: ['report', 'update', 'work'], cursor: ['report', 'update'] },
  agentLabels: { claude: 'Claude Code', cursor: 'Cursor CLI' }, defaultAgent: 'cursor', ...more,
});

test('agent and level: an agent not offered at the level gets a level error', () => {
  const r = AC.validateAutomation({ ...example(), agent: 'cursor', level: 'work' }, levelCtx());
  assert.equal(r.ok, false);
  assert.equal(r.errors.level, "Cursor CLI can't run at Work");
  assert.equal(r.errors.agent, undefined);
  assert.equal(AC.validateAutomation({ ...example(), agent: 'cursor', level: 'update' }, levelCtx()).ok, true);
});

test('agent and level: default names the default agent and the alternatives', () => {
  const r = AC.validateAutomation({ ...example(), agent: 'default', level: 'work' }, levelCtx());
  assert.equal(r.errors.level, "Your default agent (Cursor CLI) can't run at Work; pick Claude Code or another level");
});

test('agent and level: no default agent is an agent error', () => {
  const ctx2 = levelCtx({ agentIds: ['default', 'claude'], agentLevels: { default: [], claude: ['report', 'update', 'work'] }, defaultAgent: null });
  const r = AC.validateAutomation({ ...example(), agent: 'default', level: 'report' }, ctx2);
  assert.equal(r.ok, false);
  assert.equal(r.errors.agent, 'Pick an agent that can run automations');
  assert.equal(r.errors.level, undefined);
});

test('agent and level: without agentLevels nothing extra is checked', () => {
  const r = AC.validateAutomation({ ...example(), agent: 'cursor', level: 'work' }, { boardKeys: ['work'], agentIds: ['default', 'claude', 'cursor'] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ---------- Connectors ----------
const connCtx = (more = {}) => levelCtx({
  connectorIds: ['atlassian', 'azuredevops'], agentConnectors: { default: false, claude: true, cursor: false }, ...more,
});
const CONN_ERR = 'Pick connectors automations can use';

test('connectors: absent, null and [] are all off and not stored', () => {
  for (const c of [undefined, null, []]) {
    const r = AC.validateAutomation({ ...example(), agent: 'claude', connectors: c }, connCtx());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal('connectors' in r.value, false);
  }
});

test('connectors must be known, usable and unique', () => {
  for (const c of [['nope'], ['cursor-teams'], ['atlassian', 'atlassian'], 'atlassian']) {
    const r = AC.validateAutomation({ ...example(), agent: 'claude', connectors: c }, connCtx());
    assert.equal(r.ok, false);
    assert.equal(r.errors.connectors, CONN_ERR);
  }
  // A missing ctx.connectorIds counts as none.
  assert.equal(AC.validateAutomation({ ...example(), agent: 'claude', connectors: ['atlassian'] }, levelCtx()).errors.connectors, CONN_ERR);
});

test("connectors: an agent that can't use them is refused", () => {
  const r = AC.validateAutomation({ ...example(), agent: 'cursor', connectors: ['atlassian'] }, connCtx());
  assert.equal(r.errors.connectors, "Cursor CLI can't use connectors in automations yet");
  const d = AC.validateAutomation({ ...example(), agent: 'default', connectors: ['atlassian'] }, connCtx({ agentConnectors: { default: false, claude: true, cursor: false } }));
  assert.equal(d.errors.connectors, "Cursor CLI can't use connectors in automations yet");
  const ok = AC.validateAutomation({ ...example(), agent: 'default', connectors: ['atlassian'] }, connCtx({ agentConnectors: { default: true } }));
  assert.equal(ok.ok, true);
});

test("connectors: the can't-use message never says null", () => {
  const ask = (more) => AC.validateAutomation({ ...example(), agent: 'default', connectors: ['atlassian'] }, connCtx(more)).errors.connectors;
  // No default agent at all (and no level check to catch it first).
  const none = ask({ defaultAgent: null, agentLevels: undefined, agentConnectors: { default: false } });
  assert.equal(none, "Your default agent can't use connectors in automations yet");
  // A default agent with no label falls back to its id.
  assert.equal(ask({ defaultAgent: 'pi', agentLevels: undefined, agentConnectors: { default: false } }), "pi can't use connectors in automations yet");
  for (const m of [none]) assert.doesNotMatch(m, /null|undefined/);
});

test('connectors: a valid list is kept in order given', () => {
  const r = AC.validateAutomation({ ...example(), agent: 'claude', connectors: ['azuredevops', 'atlassian'] }, connCtx());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.connectors, ['azuredevops', 'atlassian']);
});

test("the builder's hint when the agent can't use connectors says saving removes saved ones", () => {
  assert.equal(AC.connectorsAgentHint('Cursor CLI', { saved: ['atlassian'] }), "Cursor CLI can't use connectors in automations yet; saving removes them.");
  for (const a of [{}, { saved: [] }, { saved: undefined }, null, undefined]) {
    assert.equal(AC.connectorsAgentHint('Cursor CLI', a), "Cursor CLI can't use connectors in automations yet");
  }
});

test('listText is exported', () => {
  assert.equal(AC.listText(['a', 'b', 'c']), 'a, b and c');
});

// ---------- Agent tags ----------
test('agentTagText: a draft from an agent, only while it is off', () => {
  const origin = { by: 'agent', agent: 'Cursor CLI', at: '2026-11-11T09:00:00.000Z' };
  assert.equal(AC.agentTagText({ enabled: false, origin }, 'Europe/London'), 'Draft from Cursor CLI · 11 Nov');
  assert.equal(AC.agentTagText({ enabled: true, origin }, 'Europe/London'), '');
  assert.equal(AC.agentTagText({ enabled: false }, 'Europe/London'), '');
});

test('agentTagText: what the agent changed wins over the draft tag', () => {
  const origin = { by: 'agent', agent: 'Cursor CLI', at: '2026-11-11T09:00:00.000Z' };
  const off = { agent: 'Cursor CLI', fields: ['prompt', 'cards'], switchedOff: true, at: '2026-11-11T10:00:00.000Z' };
  assert.equal(AC.agentTagText({ enabled: false, origin, agentChange: off }, 'Europe/London'), 'Cursor CLI changed the prompt and cards. Off until you switch it on.');
  const three = { agent: 'Cursor CLI', fields: ['agent', 'level', 'prompt'], switchedOff: false, at: '2026-11-11T10:00:00.000Z' };
  assert.equal(AC.agentTagText({ enabled: false, agentChange: three }, 'Europe/London'), 'Cursor CLI changed the agent, level and prompt.');
});

test('agentTagText: the date is in the board time zone', () => {
  const origin = { by: 'agent', agent: 'Claude Code', at: '2026-11-11T23:30:00.000Z' };
  assert.equal(AC.agentTagText({ enabled: false, origin }, 'Asia/Tokyo'), 'Draft from Claude Code · 12 Nov');
});

test('agentTagText: an agent draft the agent then edited still reads as a draft', () => {
  const origin = { by: 'agent', agent: 'Claude Code', at: '2026-11-11T09:00:00.000Z' };
  const edit = { agent: 'Claude Code', fields: ['prompt'], switchedOff: false, at: '2026-11-11T09:30:00.000Z' };
  assert.equal(AC.agentTagText({ enabled: false, origin, agentChange: edit }, 'Europe/London'), 'Draft from Claude Code · 11 Nov');
  // Once an agent edit switched it off, that explanation wins.
  assert.equal(AC.agentTagText({ enabled: false, origin, agentChange: { ...edit, switchedOff: true } }, 'Europe/London'),
    'Claude Code changed the prompt. Off until you switch it on.');
});

test('triggerText says how a run started, and that a Work trial ran as Report', () => {
  assert.equal(AC.triggerText({ trigger: 'schedule', level: 'report' }), 'scheduled');
  assert.equal(AC.triggerText({ trigger: 'manual', level: 'work' }), 'run now');
  assert.equal(AC.triggerText({ trigger: 'trial', level: 'update' }), 'trial · not written to cards');
  assert.equal(AC.triggerText({ trigger: 'trial', level: 'work' }), 'trial · tried as Report · not written to cards');
});

// ---------- Calendar reminders ----------
test('reminders: absent, null and false are all off and not stored', () => {
  for (const r of [undefined, null, false]) {
    const v = AC.validateAutomation({ ...example(), reminders: r }, levelCtx());
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal('reminders' in v.value, false);
  }
});

test('reminders: true is kept, anything else is refused', () => {
  const on = AC.validateAutomation({ ...example(), reminders: true }, levelCtx());
  assert.equal(on.ok, true, JSON.stringify(on.errors));
  assert.equal(on.value.reminders, true);
  for (const r of ['yes', 1, {}, []]) {
    const v = AC.validateAutomation({ ...example(), reminders: r }, levelCtx());
    assert.equal(v.ok, false);
    assert.equal(v.errors.reminders, 'Must be on or off');
  }
});

test('reminders can be saved while Calendar is off (runs skip them)', () => {
  const v = AC.validateAutomation({ ...example(), reminders: true }, levelCtx({ calendarLive: false }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.value.reminders, true);
});

test('reminderText: added, would remind, skipped, nothing', () => {
  const c = { reminder: { id: 'c_x', date: '2026-11-26', start: '09:15', end: null, title: 'Chase the vendor', ping: 'start' } };
  assert.equal(AC.reminderText(c, false), 'Reminder added: Thu 26 Nov 09:15 · Chase the vendor');
  assert.equal(AC.reminderText(c, true), 'Would remind: Thu 26 Nov 09:15 · Chase the vendor');
  assert.equal(AC.reminderText({ reminder: { ...c.reminder, end: '09:45' } }, false), 'Reminder added: Thu 26 Nov 09:15–09:45 · Chase the vendor');
  assert.equal(AC.reminderText({ reminder: null, reminderSkipped: 'Calendar is switched off' }, false), 'Reminder skipped: Calendar is switched off');
  assert.equal(AC.reminderText({ reminder: null, reminderSkipped: '' }, true), '');
  assert.equal(AC.reminderText({}, true), '');
});

// ---------- New cards (spec 2026-11-25: Work can create new cards) ----------
const ncBase = { name: 'Q', agent: 'claude', template: 'blank', prompt: 'p', level: 'work',
  schedule: { repeat: 'daily', time: '08:00' }, timeLimitMin: 10 };
const ctxNC = { boardKeys: ['work'], agentIds: ['default', 'claude', 'cursor'], tz: 'UTC',
  agentLevels: { default: ['report', 'update', 'work'], claude: ['report', 'update', 'work'], cursor: ['report', 'update'] },
  agentOnceLevels: { default: ['work'], claude: ['work'], cursor: ['work'] }, agentLabels: { claude: 'Claude Code', cursor: 'Cursor CLI' } };

test('once: valid with work + newCards; drops cards and section; max defaults to 5', () => {
  const r = AC.validateAutomation({ ...ncBase, runsOn: 'once', newCards: { board: 'work', folder: 'tickets' },
    cards: { board: 'work', statuses: ['backlog'] }, section: 'X' }, ctxNC);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.newCards, { board: 'work', folder: 'tickets', max: 5 });
  assert.equal(r.value.runsOn, 'once');
  assert.equal('cards' in r.value, false);
  assert.equal('section' in r.value, false);
});

test('once needs Work, a destination, and no reminders', () => {
  const e = AC.validateAutomation({ ...ncBase, runsOn: 'once', level: 'report', reminders: true }, ctxNC).errors;
  assert.equal(e.level, 'Once runs create cards, so they need Work');
  assert.equal(e.newCards, 'Pick where new cards go');
  assert.equal(e.reminders, "Once runs can't add calendar reminders");
});

test('cursor: Work allowed once, refused on each card', () => {
  assert.equal(AC.validateAutomation({ ...ncBase, agent: 'cursor', runsOn: 'once', newCards: { board: 'work', folder: '' } }, ctxNC).ok, true);
  const e = AC.validateAutomation({ ...ncBase, agent: 'cursor', cards: { board: 'work', statuses: ['backlog'] }, section: 'Latest check-in' }, ctxNC).errors;
  assert.equal(e.level, "Cursor CLI can't run at Work on each card; pick Once or another level");
  const pi = AC.validateAutomation({ ...ncBase, agent: 'cursor', runsOn: 'once', newCards: { board: 'work', folder: '' } },
    { ...ctxNC, agentOnceLevels: { ...ctxNC.agentOnceLevels, cursor: [] } }).errors;
  assert.equal(pi.level, "Cursor CLI can't run Once automations");
});

test('newCards shape: folder without .. or leading slash, max 1-10, known board, folder check from ctx', () => {
  const v = (nc, more = {}) => AC.validateAutomation({ ...ncBase, runsOn: 'once', newCards: nc }, { ...ctxNC, ...more });
  assert.equal(v({ board: 'nope', folder: 'a' }).errors.newCards, 'Pick a board for new cards');
  for (const folder of ['../x', 'a/../b', 'a\\b', 'a//b', '\u0001', './a', 'x'.repeat(201)]) {
    assert.equal(v({ board: 'work', folder }).errors.newCards, 'Pick a folder inside the board', folder);
  }
  assert.equal(v({ board: 'work', folder: '/a/b/' }).value.newCards.folder, 'a/b');
  assert.equal(v({ board: 'work', folder: ' 2. iam/tickets ' }).value.newCards.folder, '2. iam/tickets');
  assert.equal(v({ board: 'work', folder: 'a', max: 11 }).errors.newCards, 'New cards per run: 1 to 10');
  assert.equal(v({ board: 'work', folder: 'a', max: 0 }).errors.newCards, 'New cards per run: 1 to 10');
  assert.equal(v({ board: 'work', folder: 'a', max: 2.5 }).errors.newCards, 'New cards per run: 1 to 10');
  assert.equal(v({ board: 'work', folder: 'a' }, { newCardsFolderError: () => "That folder doesn't exist" }).errors.newCards, "That folder doesn't exist");
  let asked = null;
  v({ board: 'work', folder: '/t/' }, { newCardsFolderError: (b, f) => { asked = [b, f]; return null; } });
  assert.deepEqual(asked, ['work', 't']);
  assert.equal(v('tickets').errors.newCards, 'Pick where new cards go');
});

test('per-card Work may have newCards; runsOn junk refused', () => {
  const r = AC.validateAutomation({ ...ncBase, cards: { board: 'work', statuses: ['backlog'] }, section: 'Latest check-in', newCards: { board: 'work', folder: 'f', max: 3 } }, ctxNC);
  assert.deepEqual(r.value.newCards, { board: 'work', folder: 'f', max: 3 });
  assert.equal('runsOn' in r.value, false);
  const cards = AC.validateAutomation({ ...ncBase, runsOn: 'cards', cards: { board: 'work', statuses: ['backlog'] }, section: 'Latest check-in' }, ctxNC);
  assert.equal(cards.ok, true);
  assert.equal('runsOn' in cards.value, false);
  assert.equal('newCards' in cards.value, false);
  assert.equal(AC.validateAutomation({ ...ncBase, runsOn: 'twice' }, ctxNC).errors.runsOn, 'Pick each matching card or once');
});

test('Work level text mentions new cards', () => {
  assert.equal(AC.LEVEL_TEXT.work, "Can edit files in the card's folder and create new cards.");
  assert.deepEqual(AC.RUNS_ON, ['cards', 'once']);
  assert.equal(AC.RUNS_ON_LABEL.once, 'Once');
  assert.equal(AC.NEW_CARDS_DEFAULT, 5);
  assert.equal(AC.NEW_CARDS_LIMIT, 10);
  assert.equal(AC.NEW_CARDS_PER_HOUR, 30);
  assert.ok(AC.CARD_KEY_RE.test('TCK-1234') && !AC.CARD_KEY_RE.test('../x') && !AC.CARD_KEY_RE.test('-x'));
  assert.match(AC.ONCE_PARAGRAPH, /^There is no card in this run\./);
});

test('summaries: once runs and created counts', () => {
  const t = '2026-11-25T08:00:00Z';
  assert.equal(AC.runSummary({ state: 'finished', runsOn: 'once', startedAt: t, endedAt: t, createdCount: 3, cards: [{ state: 'noted' }] }), '<1 min · 3 cards created');
  assert.equal(AC.runSummary({ state: 'finished', runsOn: 'once', trigger: 'trial', startedAt: t, endedAt: t, createdCount: 1, cards: [{ state: 'noted' }] }), '<1 min · would create 1 card');
  assert.equal(AC.runSummary({ state: 'finished', runsOn: 'once', startedAt: t, endedAt: t, createdCount: 0, cards: [{ state: 'noted' }] }), '<1 min · nothing created');
  assert.equal(AC.runSummary({ state: 'failed', runsOn: 'once', startedAt: t, endedAt: t, cards: [{ state: 'failed' }] }), '<1 min · 1 failed · nothing created');
  assert.equal(AC.runSummary({ state: 'finished', startedAt: t, endedAt: t, createdCount: 2, cards: [{ state: 'noted' }, { state: 'noted' }] }), '2 cards · <1 min · 2 noted · 2 cards created');
  assert.equal(AC.triggerText({ trigger: 'trial', level: 'work', runsOn: 'once' }), 'trial · nothing created');
  assert.equal(AC.newCardsText({ board: 'work', folder: '' }, 'Work'), 'New cards → Work / top of the board');
  assert.equal(AC.newCardsText({ board: 'work', folder: 'tickets' }), 'New cards → work / tickets');
});

test('createdText: created, would create, not created', () => {
  const c = { created: [{ title: 'Reset MFA', key: 'TCK-1', path: 'Work/tickets/TCK-1/task.md' }, { title: 'No key', path: 'Work/tickets/no-key/task.md' }],
    notCreated: [{ title: 'Dup', key: 'TCK-2', reason: 'TCK-2 already has a card' }, { title: 'Keyless', reason: 'duplicate in this run' }] };
  assert.deepEqual(AC.createdText(c, false), ['Created: Reset MFA (TCK-1)', 'Created: No key',
    'Not created: TCK-2 — TCK-2 already has a card', 'Not created: Keyless — duplicate in this run']);
  assert.deepEqual(AC.createdText(c, true).slice(0, 1), ['Would create: Reset MFA (TCK-1)']);
  assert.deepEqual(AC.createdText({}, false), []);
});

test('review 5: newCards only counts at Work; at Report or Update it is dropped and its folder never checked', () => {
  for (const level of ['report', 'update']) {
    const r = AC.validateAutomation({ ...ncBase, level, cards: { board: 'work', statuses: ['backlog'] }, section: 'Latest check-in', newCards: { board: 'work', folder: 'gone' } },
      { ...ctxNC, newCardsFolderError: () => "That folder doesn't exist" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal('newCards' in r.value, false);
  }
});

// ---------- Let the agent choose the folder (2026-11-25, follow-up) ----------
test('choose: newCards with choose keeps only the board (top as base) and the cap', () => {
  const r = AC.validateAutomation({ ...ncBase, runsOn: 'once', newCards: { board: 'work', folder: 'ignored/here', max: 10, choose: true } },
    { ...ctxNC, newCardsFolderError: (b, f) => (f === '' ? null : 'checked the wrong folder') });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.newCards, { board: 'work', folder: '', max: 10, choose: true });
  assert.equal(AC.validateAutomation({ ...ncBase, runsOn: 'once', newCards: { board: 'work', folder: '', choose: 'yes' } }, ctxNC).errors.newCards, 'Must be on or off');
  const plain = AC.validateAutomation({ ...ncBase, runsOn: 'once', newCards: { board: 'work', folder: 't', choose: false } }, ctxNC).value.newCards;
  assert.deepEqual(plain, { board: 'work', folder: 't', max: 5 });
  assert.equal(AC.NEW_FOLDERS_PER_RUN, 3);
  assert.ok(AC.FOLDER_NAME_RE.test('10. security') && AC.FOLDER_NAME_RE.test('entra_b-2') && !AC.FOLDER_NAME_RE.test('.git') && !AC.FOLDER_NAME_RE.test('a/b') && !AC.FOLDER_NAME_RE.test('x'.repeat(61)));
});

test('choose: list text and created lines say where each card went', () => {
  assert.equal(AC.newCardsText({ board: 'work', folder: '', choose: true }, 'Work'), 'New cards → Work / the agent picks the folder');
  const c = { created: [{ title: 'Reset MFA', key: 'TCK-1', folder: '3. iam' }, { title: 'Firewall', folder: '10. security', newFolder: true }, { title: 'Top', folder: '' }] };
  assert.deepEqual(AC.createdText(c, false), ['Created: Reset MFA (TCK-1) in 3. iam', 'Created: Firewall in 10. security (new folder)', 'Created: Top in the top of the board']);
  assert.deepEqual(AC.createdText({ created: [{ title: 'A', key: 'K' }] }, false), ['Created: A (K)']);
});

test('choose: a new folder name ends in a letter or digit (SMB drops trailing dots and spaces)', () => {
  for (const ok of ['10. security', 'entra', 'a', 'x_1-b']) assert.ok(AC.FOLDER_NAME_RE.test(ok), ok);
  for (const bad of ['security ', '10.', 'x-', 'x_', ' x', '.x', '']) assert.ok(!AC.FOLDER_NAME_RE.test(bad), JSON.stringify(bad));
});
