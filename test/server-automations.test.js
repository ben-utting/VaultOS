'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');

const PASSWORD = 'correct horse';
const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (base, method, url, { cookie, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

// A server with boards Work and Home, set up through its routes. terminal: whether TERMINAL is allowed.
async function ready(t, { terminal = true, files = {}, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-auto-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, files);
  const srv = await startServer({
    vault: d.vault, data: d.data, home: d.home,
    env: { TERMINAL: terminal ? '1' : '0', AUTOMATION_TEST_AGENT: FAKE, TZ: 'Europe/London', ...env },
  });
  t.after(async () => {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  const s = { ...d, base, cookie, srv };
  s.api = (method, url, body) => call(base, method, url, { cookie, body });
  s.card = (rel, status = 'in-progress', extra = '') => {
    const f = path.join(d.vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `---\nid: x\ntitle: "${path.basename(path.dirname(f))}"\nstatus: ${status}\nupdated: 2026-11-01\n${extra}---\n\n## Goal\ng\n`);
    return f;
  };
  s.turnOn = async (on = true) => assert.equal((await s.api('POST', '/api/settings/features', { automations: on })).status, 200);
  return s;
}
const automation = (more = {}) => ({
  name: 'Morning check-in', enabled: true, agent: 'claude', template: 'blank', prompt: 'FAKE:note', level: 'report',
  cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
  schedule: { repeat: 'weekdays', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more,
});
async function waitIdle(s, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await s.api('GET', '/api/automations');
    if (!r.body.current && !r.body.queue.length) return r.body;
    if (Date.now() > end) throw new Error('run did not finish');
    await sleep(100);
  }
}

test('routes need a session', async (t) => {
  const s = await ready(t);
  assert.equal((await call(s.base, 'POST', '/api/automations', { body: automation() })).status, 401);
  assert.equal((await call(s.base, 'POST', '/api/automations/stop')).status, 401);
});

test('off by default: GET says live false, writes are 403', async (t) => {
  const s = await ready(t);
  const r = await s.api('GET', '/api/automations');
  assert.equal(r.status, 200);
  assert.equal(r.body.live, false);
  assert.deepEqual(r.body.automations, []);
  assert.equal((await s.api('POST', '/api/automations', automation())).status, 403);
  assert.equal((await s.api('GET', '/api/me')).body.features.automations, false);
});

test('TERMINAL=0: the switch saves but automations stay off', async (t) => {
  const s = await ready(t, { terminal: false });
  await s.turnOn();
  assert.equal((await s.api('GET', '/api/settings')).body.settings.features.automations, true);
  assert.equal((await s.api('GET', '/api/automations')).body.live, false);
  assert.equal((await s.api('POST', '/api/automations', automation())).status, 403);
  assert.equal((await s.api('GET', '/api/me')).body.features.automations, false);
});

test('turn on, create, run now, see the note', async (t) => {
  const s = await ready(t);
  const f = s.card('Work/1. a/01-x/task.md');
  s.card('Work/1. a/02-y/task.md', 'done');
  await s.turnOn();
  assert.equal((await s.api('GET', '/api/me')).body.features.automations, true);
  const c = await s.api('POST', '/api/automations', automation());
  assert.equal(c.status, 200, c.text);
  const id = c.body.automation.id;
  const list = await s.api('GET', '/api/automations');
  assert.equal(list.body.live, true);
  assert.equal(list.body.timezone, 'Europe/London');
  assert.equal(list.body.automations[0].scheduleText, 'Weekdays 08:00');
  assert.match(list.body.automations[0].nextRun, /^\d{4}-\d\d-\d\dT0[78]:00:00\.000Z$/);
  assert.deepEqual(list.body.agents.map((a) => a.id), ['claude', 'cursor', 'pi']);
  assert.ok(list.body.agents.every((a) => typeof a.connectors === 'boolean'));
  assert.equal((await s.api('POST', `/api/automations/${id}/run`)).status, 200);
  const idle = await waitIdle(s);
  assert.equal(idle.automations[0].lastRun.state, 'finished');
  assert.match(fs.readFileSync(f, 'utf8'), /## Latest check-in\n_.* · Morning check-in · Claude Code_\n\nFake note\./);
  const runs = await s.api('GET', '/api/automations/runs');
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].counts.noted, 1);
  const detail = await s.api('GET', `/api/automations/runs/${runs.body.runs[0].id}`);
  assert.equal(detail.body.cards[0].note, 'Fake note.');
  assert.equal(detail.body.cards[0].noteHtml.trim(), '<p>Fake note.</p>');
  assert.equal((await s.api('GET', '/api/automations/runs/nope')).status, 404);
  assert.match(fs.readFileSync(path.join(s.vault, 'Work/_tasks/Board.md'), 'utf8'), /01-x/);
});

test('saving an agent at a level it can\'t run is a 400 on level', async (t) => {
  const s = await ready(t, { env: { AUTOMATION_TEST_LEVELS: 'cursor:report,update' } });
  await s.turnOn();
  const r = await s.api('POST', '/api/automations', automation({ agent: 'cursor', level: 'work' }));
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.errors.level, /^Cursor CLI can't run at Work on each card; pick Once or another level$/);
  assert.equal((await s.api('POST', '/api/automations', automation({ agent: 'cursor', level: 'update' }))).status, 200);
});

test('switching automations on installs the skill for the agents, and not before', async (t) => {
  const s = await ready(t);
  const skill = path.join(s.home, '.claude', 'skills', 'vaultos-automations', 'SKILL.md');
  assert.equal(fs.existsSync(skill), false);
  await s.turnOn();
  assert.match(fs.readFileSync(skill, 'utf8'), /^---\nname: vaultos-automations/);
  assert.ok(fs.existsSync(path.join(s.home, '.agents', 'skills', 'vaultos-automations', 'reference.md')));
});

test('create with a reserved section is 400 with field errors', async (t) => {
  const s = await ready(t);
  await s.turnOn();
  const r = await s.api('POST', '/api/automations', automation({ section: 'Plan' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.errors.section, "That's one of the card's own sections");
});

test('update, delete and unknown ids', async (t) => {
  const s = await ready(t);
  await s.turnOn();
  const { id } = (await s.api('POST', '/api/automations', automation())).body.automation;
  const u = await s.api('PUT', `/api/automations/${id}`, automation({ name: 'Renamed', enabled: false }));
  assert.equal(u.status, 200);
  assert.equal(u.body.automation.name, 'Renamed');
  assert.equal((await s.api('GET', '/api/automations')).body.automations[0].nextRun, null);
  assert.equal((await s.api('PUT', '/api/automations/ffffffff', automation())).status, 404);
  assert.equal((await s.api('DELETE', `/api/automations/${id}`)).status, 200);
  assert.equal((await s.api('DELETE', `/api/automations/${id}`)).status, 404);
  assert.equal((await s.api('POST', `/api/automations/${id}/run`)).status, 409);
});

test('match counts cards like a run picks them', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md', 'in-progress');
  s.card('Work/1. a/02-y/task.md', 'blocked');
  s.card('Work/1. a/03-z/task.md', 'done');
  s.card('Work/1. a/04-s/task.md', 'in-progress', 'batch: 01-x\n');
  s.card('Home/1. b/05-h/task.md', 'in-progress');
  const m = await s.api('GET', '/api/automations/match?board=work&statuses=in-progress,blocked,done');
  assert.deepEqual(m.body, { count: 2, titles: ['01-x', '02-y'] });
  const all = await s.api('GET', '/api/automations/match?board=all&statuses=in-progress&subtasks=1');
  assert.equal(all.body.count, 3);
});

test('an interrupted run is recovered at boot', async (t) => {
  const run = {
    id: '20261111-080000-0001', automationId: 'aaaaaaaa', automationName: 'A', agent: 'claude', level: 'report',
    trigger: 'schedule', startedAt: '2026-11-11T08:00:00.000Z', endedAt: null, state: 'running',
    cards: [{ path: 'Work/x/task.md', title: 'X', state: 'running', reason: '' }],
  };
  const s = await ready(t, { files: { '.vaultos/automation-runs/aaaaaaaa/20261111-080000-0001.json': JSON.stringify(run) } });
  const r = await s.api('GET', '/api/automations/runs/20261111-080000-0001');
  assert.equal(r.body.state, 'interrupted');
  assert.equal(r.body.cards[0].reason, 'VaultOS restarted');
});

test('toggling twice leaves one runner', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md');
  await s.turnOn(true);
  await s.turnOn(false);
  await s.turnOn(true);
  const { id } = (await s.api('POST', '/api/automations', automation())).body.automation;
  assert.equal((await s.api('POST', `/api/automations/${id}/run`)).status, 200);
  await waitIdle(s);
  const dir = path.join(s.vault, '.vaultos', 'automation-runs', id);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal((await s.api('POST', '/api/automations/stop')).body.stopped, false);
});

test('a note keeps its line breaks in the run detail', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md');
  await s.turnOn();
  const { id } = (await s.api('POST', '/api/automations', automation({ prompt: 'FAKE:lines' }))).body.automation;
  await s.api('POST', `/api/automations/${id}/run`);
  await waitIdle(s);
  const [run] = (await s.api('GET', '/api/automations/runs')).body.runs;
  const detail = await s.api('GET', `/api/automations/runs/${run.id}`);
  assert.match(detail.body.cards[0].noteHtml, /line one<br>\s*line two/);
});

// ---------- The model ----------

test('a model is saved through the routes and comes back in the list; a bad one is a 400 on model', async (t) => {
  const s = await ready(t, { env: { AUTOMATION_TEST_LEVELS: 'cursor:report,update' } });
  await s.turnOn();
  const c = await s.api('POST', '/api/automations', automation({ agent: 'cursor', model: 'gpt-5' }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.automation.model, 'gpt-5');
  const { id } = c.body.automation;
  assert.equal((await s.api('GET', '/api/automations')).body.automations[0].model, 'gpt-5');
  for (const model of ['', 'gpt-5\nsecond', 'm'.repeat(201)]) {
    const bad = await s.api('PUT', `/api/automations/${id}`, automation({ agent: 'cursor', model }));
    assert.equal(bad.status, 400, JSON.stringify(model));
    assert.ok(bad.body.errors.model, bad.text);
  }
  const cleared = await s.api('PUT', `/api/automations/${id}`, automation({ agent: 'cursor' }));
  assert.equal('model' in cleared.body.automation, false);
});

test('the models route lists what Cursor offers, only while automations are live', async (t) => {
  const s = await ready(t);
  assert.equal((await s.api('GET', '/api/automations/models')).status, 403);
  await s.turnOn();
  const r = await s.api('GET', '/api/automations/models');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.models, [
    { id: 'auto', label: 'Auto (current, default)' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'claude-opus-4-8[context=1m,effort=high,fast=false]', label: 'Opus 4.8 1M High' },
  ]);
  assert.equal(r.body.error, undefined);
});

test('the models route says why when the list cannot be loaded, and saving still works', async (t) => {
  const s = await ready(t, { env: { AUTOMATION_TEST_MODELS: 'fail', AUTOMATION_TEST_LEVELS: 'cursor:report,update' } });
  await s.turnOn();
  const r = await s.api('GET', '/api/automations/models');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.models, []);
  assert.match(r.body.error, /couldn't list/i);
  const c = await s.api('POST', '/api/automations', automation({ agent: 'cursor', model: 'typed-by-hand' }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.automation.model, 'typed-by-hand');
});

// ---------- Calendar reminders from automations ----------
const CC = require('../public/calendar-core');
test('a run with reminders on puts the agent\'s reminder on the calendar, linked to the card', async (t) => {
  const s = await ready(t);
  s.card('Work/1. a/01-x/task.md');
  await s.turnOn();
  assert.equal((await s.api('POST', '/api/settings/features', { calendar: true })).status, 200);
  assert.equal((await s.api('GET', '/api/automations')).body.calendar, true);
  const tomorrow = CC.addDays(CC.todayIn('Europe/London', Date.now()), 1);
  const c = await s.api('POST', '/api/automations', automation({ reminders: true, prompt: `FAKE:remind:${tomorrow}` }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.automation.reminders, true);
  assert.equal((await s.api('POST', `/api/automations/${c.body.automation.id}/run`)).status, 200);
  await waitIdle(s);
  const runs = await s.api('GET', '/api/automations/runs');
  const card = (await s.api('GET', `/api/automations/runs/${runs.body.runs[0].id}`)).body.cards[0];
  assert.equal(card.state, 'noted');
  assert.equal(card.reminder.date, tomorrow);
  assert.equal(card.reminder.start, '09:00');
  const cal = await s.api('GET', `/api/calendar?from=${tomorrow}&to=${tomorrow}`);
  assert.equal(cal.body.occurrences.length, 1);
  const o = cal.body.occurrences[0];
  assert.deepEqual([o.title, o.start, o.card && o.card.path, o.note], ['01-x', '09:00', 'Work/1. a/01-x/task.md', 'Fake reminder.']);
  assert.equal(o.created.by.agent, 'Automation: Morning check-in');
});

test('with Calendar off the reminder is skipped and the run still notes the card', async (t) => {
  const s = await ready(t);
  const f = s.card('Work/1. a/01-x/task.md');
  await s.turnOn();
  assert.equal((await s.api('GET', '/api/automations')).body.calendar, false);
  const c = await s.api('POST', '/api/automations', automation({ reminders: true, prompt: 'FAKE:remind:2099-01-01' }));
  assert.equal(c.status, 200, c.text);
  await s.api('POST', `/api/automations/${c.body.automation.id}/run`);
  await waitIdle(s);
  const runs = await s.api('GET', '/api/automations/runs');
  const card = (await s.api('GET', `/api/automations/runs/${runs.body.runs[0].id}`)).body.cards[0];
  assert.deepEqual([card.state, card.reminder, card.reminderSkipped], ['noted', null, 'Calendar is switched off']);
  assert.match(fs.readFileSync(f, 'utf8'), /Fake note\./);
  assert.equal(fs.existsSync(path.join(s.vault, '.vaultos', 'calendar.json')), false);
});

// ---------- New cards (spec 2026-11-25) ----------
const onceDef = (more = {}) => automation({ runsOn: 'once', level: 'work', newCards: { board: 'work', folder: 'tickets' }, prompt: 'FAKE:card:TCK-1:Reset_MFA', ...more });

test('new cards: a Once automation saves into an existing folder; missing, skipped and card folders are refused', async (t) => {
  const s = await ready(t);
  seedVault(s.vault, { 'Work/tickets/.keep': '', 'Work/archive/x/.keep': '', 'Work/job/task.md': '---\nid: job\n---\n' });   // after setup, which makes the board folders
  await s.turnOn();
  const ok = await s.api('POST', '/api/automations', onceDef());
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.automation.runsOn, 'once');
  assert.equal('cards' in ok.body.automation, false);
  const refused = async (folder) => {
    const r = await s.api('POST', '/api/automations', onceDef({ newCards: { board: 'work', folder } }));
    assert.equal(r.status, 400, folder);
    return r.body.errors.newCards;
  };
  assert.equal(await refused('nope'), "That folder doesn't exist");
  assert.equal(await refused('archive/x'), "Cards in that folder wouldn't show on the board");
  assert.equal(await refused('job'), "That's a card's folder; pick the folder it sits in");
  assert.equal(await refused('../Home'), 'Pick a folder inside the board');
  const pc = await s.api('POST', '/api/automations', automation({ level: 'work', newCards: { board: 'work', folder: 'tickets', max: 2 } }));
  assert.equal(pc.status, 200, pc.text);
  assert.deepEqual(pc.body.automation.newCards, { board: 'work', folder: 'tickets', max: 2 });
});

test('new cards: the folders route lists usable folders per board', async (t) => {
  const s = await ready(t);
  seedVault(s.vault, { 'Work/tickets/.keep': '', 'Work/archive/x/.keep': '', 'Work/2. iam/queue/.keep': '' });   // after setup, which makes the board folders
  const r = await s.api('GET', '/api/automations/folders?board=work');
  assert.equal(r.status, 200);
  assert.ok(r.body.folders.includes('') && r.body.folders.includes('tickets') && r.body.folders.includes('2. iam/queue'));
  assert.ok(!r.body.folders.some((f) => f.startsWith('archive')));
  const bad = await s.api('GET', '/api/automations/folders?board=nope');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Pick a board');
  const agents = (await s.api('GET', '/api/automations')).body.agents;
  assert.ok(agents.every((a) => Array.isArray(a.onceLevels)));
});

test('new cards: a Once run creates the card and the board shows it', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  seedVault(s.vault, { 'Work/tickets/.keep': '' });   // after setup, which makes the board folders
  await s.turnOn();
  const a = (await s.api('POST', '/api/automations', onceDef())).body.automation;
  assert.equal((await s.api('POST', `/api/automations/${a.id}/run`)).status, 200);
  await waitIdle(s);
  const [run] = (await s.api('GET', '/api/automations/runs')).body.runs;
  assert.equal(run.state, 'finished');
  assert.equal(run.runsOn, 'once');
  assert.equal(run.createdCount, 1);
  assert.ok(fs.existsSync(path.join(s.vault, 'Work', 'tickets', 'TCK-1', 'task.md')));
  const tasks = (await s.api('GET', '/api/tasks?ws=work')).body.tasks;
  const made = tasks.find((x) => x.path === 'Work/tickets/TCK-1/task.md');
  assert.ok(made, JSON.stringify(tasks.map((x) => x.path)));
  assert.equal(made.status, 'backlog');
  // The destination disappears: the next run fails and says why; switching off still works.
  fs.rmSync(path.join(s.vault, 'Work', 'tickets'), { recursive: true });
  await s.api('POST', `/api/automations/${a.id}/run`);
  await waitIdle(s);
  const [again] = (await s.api('GET', '/api/automations/runs')).body.runs;
  assert.equal(again.state, 'failed');
  assert.equal(again.cards[0].reason, "New cards folder: That folder doesn't exist");
  const off = await s.api('PUT', `/api/automations/${a.id}`, { ...onceDef(), enabled: false });
  assert.equal(off.status, 200, off.text);
});
