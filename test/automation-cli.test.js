'use strict';
// `vaultos-automations` (spec §4): argument handling, what it sends, how it prints and its exit codes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../lib/automation-cli');

const ENV = { VAULTOS_HOOK_URL: 'http://127.0.0.1:8080/api/term/agent', VAULTOS_TERM_ID: 'term1234', VAULTOS_TERM_TOKEN: 'tok' };
const sink = () => { const s = { text: '', write: (d) => { s.text += d; return true; } }; return s; };
// A fetch that answers from a list of [command, status, body] in order and records what it was sent.
function fakeFetch(answers) {
  const sent = [];
  const f = async (url, init) => {
    const command = url.split('/').pop();
    sent.push({ url, command, body: JSON.parse(init.body) });
    const i = answers.findIndex((a) => a[0] === command);
    if (i === -1) throw new Error(`unexpected ${command}`);
    const [, status, body] = answers[i];
    if (answers.filter((a) => a[0] === command).length > 1) answers.splice(i, 1);
    if (status === 'down') throw new TypeError('fetch failed');
    return { status, ok: status === 200, json: async () => body };
  };
  f.sent = sent;
  return f;
}
const run = async (argv, { env = ENV, answers = [], files = {}, procNames = () => ['bash', 'claude'] } = {}) => {
  const stdout = sink();
  const stderr = sink();
  const fetch = fakeFetch(answers);
  const code = await main(argv, {
    env, stdout, stderr, fetch, procNames, sleep: async () => {},
    readFile: async (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
  });
  return { code, out: stdout.text, err: stderr.text, sent: fetch.sent };
};

test('outside a VaultOS terminal it says so and exits 2', async () => {
  const r = await run(['list'], { env: {} });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), 'Run this in a VaultOS terminal.');
  assert.equal(r.sent.length, 0);
});

test('a 403 from the server says the session ended and exits 2', async () => {
  const r = await run(['list'], { answers: [['list', 403, { error: 'Forbidden' }]] });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), "This terminal's VaultOS session has ended; open a new terminal.");
});

test('automations switched off is the server refusing, exit 1', async () => {
  const r = await run(['list'], { answers: [['list', 403, { error: 'Automations are off' }]] });
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'Automations are off');
});

test('VaultOS not answering exits 3', async () => {
  const r = await run(['list'], { answers: [['list', 'down', null]] });
  assert.equal(r.code, 3);
  assert.equal(r.err.trim(), "VaultOS isn't answering.");
});

test('create reads the file and sends the hint', async () => {
  const auto = { name: 'Check', level: 'report' };
  const r = await run(['create', '--file', 'a.json'], {
    files: { 'a.json': JSON.stringify(auto) },
    answers: [['create', 200, { automation: { id: 'abcd1234', name: 'Check', enabled: false } }]],
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.sent[0].url, 'http://127.0.0.1:8080/api/term/automations/create');
  assert.deepEqual(r.sent[0].body, { id: 'term1234', token: 'tok', args: auto, agentHint: ['bash', 'claude'] });
  assert.match(r.out, /Created abcd1234 \(off\)/);
  assert.match(r.out, /Automations tab/);
});

test('edit sends the id and the changes', async () => {
  const r = await run(['edit', 'abcd1234', '--file', 'c.json'], {
    files: { 'c.json': '{"schedule":{"time":"09:00"}}' },
    answers: [['edit', 200, { automation: { id: 'abcd1234', name: 'Check', enabled: true } }]],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.sent[0].body.args, { id: 'abcd1234', changes: { schedule: { time: '09:00' } } });
});

test('a model edit is sent as is and says it switched the automation off', async () => {
  const r = await run(['edit', 'abcd1234', '--file', 'c.json'], {
    files: { 'c.json': '{"model":"gpt-5"}' },
    answers: [['edit', 200, { automation: { id: 'abcd1234', name: 'Check', enabled: false, model: 'gpt-5', agentChange: { fields: ['model'], switchedOff: true } } }]],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.sent[0].body.args, { id: 'abcd1234', changes: { model: 'gpt-5' } });
  assert.match(r.out, /off until the person switches it on in the Automations tab \(changed: model\)/);
});

test('the help names the model among the edits that switch an automation off', async () => {
  const r = await run(['--help']);
  assert.match(r.out, /edit <id> --file <changes\.json> +agent, model, level, prompt, cards, runsOn, newCards, connectors or reminders changes switch it off/);
});

test('a file that is not JSON is a usage error', async () => {
  const r = await run(['create', '--file', 'a.json'], { files: { 'a.json': '{ nope' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /^Couldn't read a\.json as JSON/);
  assert.equal(r.sent.length, 0);
});

test('field errors print one per line and exit 1', async () => {
  const r = await run(['create', '--file', 'a.json'], {
    files: { 'a.json': '{}' },
    answers: [['create', 400, { error: 'Check these fields', errors: { name: 'Give it a name', level: "Cursor CLI can't run at Work" } }]],
  });
  assert.equal(r.code, 1);
  assert.equal(r.err, "Check these fields\n  name: Give it a name\n  level: Cursor CLI can't run at Work\n");
});

test('list prints one line per automation, --json prints the body', async () => {
  const body = {
    timezone: 'Europe/London',
    automations: [
      { id: 'a1', name: 'Morning', enabled: true, level: 'report', scheduleText: 'Weekdays 08:00', tag: '', lastRun: { summary: '3 cards · 1 min · 3 noted', state: 'finished' } },
      { id: 'b2', name: 'Draft one', enabled: false, level: 'update', scheduleText: 'Daily 07:00', tag: 'Draft from Claude Code · 11 Nov', lastRun: null },
    ],
  };
  const r = await run(['list'], { answers: [['list', 200, body]] });
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^a1 +on +Morning · Weekdays 08:00 · Report · last: 3 cards · 1 min · 3 noted$/);
  assert.match(lines[1], /^b2 +off +Draft one · Daily 07:00 · Update · never run · Draft from Claude Code · 11 Nov$/);
  const j = await run(['list', '--json'], { answers: [['list', 200, body]] });
  assert.deepEqual(JSON.parse(j.out), body);
});

test('try waits for the trial run and prints its notes', async () => {
  const since = '2026-11-11T09:00:00.000Z';
  const r = await run(['try', 'a1'], {
    answers: [
      ['show', 200, { automation: { id: 'a1', name: 'Morning', timeLimitMin: 10 } }],
      ['try', 200, { queued: true, since }],
      ['runs', 200, { runs: [] }],
      ['runs', 200, { runs: [{ id: 'r1', trigger: 'trial', state: 'running', startedAt: since }] }],
      ['runs', 200, { runs: [{ id: 'r1', trigger: 'trial', state: 'finished', startedAt: since }] }],
      ['run', 200, { id: 'r1', automationName: 'Morning', trigger: 'trial', state: 'finished', cards: [{ title: 'Shed', state: 'noted', note: 'Fake note.', statusChange: { from: 'in-progress', to: 'blocked' } }] }],
    ],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.sent.map((x) => x.command), ['show', 'try', 'runs', 'runs', 'runs', 'run']);
  assert.match(r.out, /trial · not written to cards/);
  assert.match(r.out, /Shed — noted/);
  assert.match(r.out, /Fake note\./);
  assert.match(r.out, /Would move: In Progress → Blocked/);
});

test('try --no-wait returns once queued', async () => {
  const r = await run(['try', 'a1', '--no-wait'], { answers: [['show', 200, { automation: { id: 'a1', timeLimitMin: 10 } }], ['try', 200, { queued: true, since: 'x' }]] });
  assert.equal(r.code, 0);
  assert.match(r.out, /Trial queued/);
});

test('unknown commands and missing ids are usage errors', async () => {
  for (const argv of [[], ['on', 'a1'], ['show'], ['edit', 'a1'], ['create']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /usage: vaultos-automations/);
  }
});

test('the installed command runs as a program and refuses outside a terminal', async () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const bin = path.join(__dirname, '..', 'bin', 'vaultos-automations.js');
  const env = { PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [bin, 'list'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'Run this in a VaultOS terminal.');
  const h = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^usage: vaultos-automations/);
});

test('an empty list says so', async () => {
  const r = await run(['list'], { answers: [['list', 200, { timezone: 'UTC', automations: [] }]] });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'No automations yet.\n');
});

test('a Work trial says it ran as Report', async () => {
  const r = await run(['run', 'r1'], { answers: [['run', 200, { id: 'r1', automationName: 'Tidy', trigger: 'trial', level: 'work', state: 'finished', cards: [] }]] });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Tidy · trial · tried as Report · not written to cards · finished$/m);
});

const optionsBody = (connectors) => ({
  timezone: 'UTC', boards: [{ key: 'work', label: 'Work' }], statuses: [{ id: 'blocked' }], levels: [], agents: [], defaultAgent: null,
  templates: [], limits: { maxCards: 25, trialCards: 3, trialsPerHour: 6, agentDrafts: 10, promptMax: 8000, timeLimitMin: [2, 30] }, connectors,
});

test('options lists the connectors automations can use now', async () => {
  const some = await run(['options'], { answers: [['options', 200, optionsBody([
    { id: 'atlassian', label: 'Atlassian', connected: true }, { id: 'azuredevops', label: 'Azure DevOps', connected: true },
    { id: 'github', label: 'GitHub', connected: false }])]] });
  assert.match(some.out, /^Connectors \(read-only\): Atlassian \(atlassian\), Azure DevOps \(azuredevops\)$/m);
  assert.doesNotMatch(some.out, /GitHub/);
  const none = await run(['options'], { answers: [['options', 200, optionsBody([{ id: 'github', label: 'GitHub', connected: false }])]] });
  assert.match(none.out, /^Connectors \(read-only\): none connected$/m);
});

test('show includes connectors and stays valid JSON', async () => {
  const withC = await run(['show', 'a1'], { answers: [['show', 200, { automation: { id: 'a1', connectors: ['atlassian', 'azuredevops'] } }]] });
  assert.deepEqual(JSON.parse(withC.out).connectors, ['atlassian', 'azuredevops']);
  const without = await run(['show', 'a1'], { answers: [['show', 200, { automation: { id: 'a1' } }]] });
  assert.equal('connectors' in JSON.parse(without.out), false);
});

test('a run prints each card\'s reminder: added, would remind, skipped', async () => {
  const rem = { id: 'c_x', date: '2026-11-26', start: '09:15', end: null, title: 'Chase', ping: 'start' };
  const live = await run(['run', 'r1'], { answers: [['run', 200, { id: 'r1', automationName: 'Evening', trigger: 'manual', state: 'finished', cards: [
    { title: 'Shed', state: 'noted', note: 'n', reminder: rem }, { title: 'Roof', state: 'noted', note: 'n', reminder: null, reminderSkipped: 'already has a reminder on that date' }] }]] });
  assert.match(live.out, /^ {2}Reminder added: Thu 26 Nov 09:15 · Chase$/m);
  assert.match(live.out, /^ {2}Reminder skipped: already has a reminder on that date$/m);
  const trial = await run(['run', 'r2'], { answers: [['run', 200, { id: 'r2', automationName: 'Evening', trigger: 'trial', state: 'finished', cards: [{ title: 'Shed', state: 'noted', note: 'n', reminder: { ...rem, id: null } }] }]] });
  assert.match(trial.out, /^ {2}Would remind: Thu 26 Nov 09:15 · Chase$/m);
});

test('options says whether calendar reminders can be added', async () => {
  const on = await run(['options'], { answers: [['options', 200, { ...optionsBody([]), calendar: true }]] });
  assert.match(on.out, /^Calendar reminders: available \(set "reminders": true\)$/m);
  const off = await run(['options'], { answers: [['options', 200, { ...optionsBody([]), calendar: false }]] });
  assert.match(off.out, /^Calendar reminders: Calendar is off in Settings → Features, so runs skip them$/m);
});

test('the help names reminders among the edits that switch an automation off', async () => {
  const r = await run(['--help']);
  assert.match(r.out, /edit <id> --file <changes\.json> .*reminders/);
});

// ---------- New cards (spec 2026-11-25 §11) ----------
test('a Once run prints what it created, would create and did not', async () => {
  const card = { kind: 'once', title: 'Work / tickets', state: 'noted', note: 'Found 3.',
    created: [{ title: 'Reset MFA', key: 'TCK-1', path: 'x' }, { title: 'Other', path: 'y' }],
    notCreated: [{ title: 'Dup', key: 'TCK-2', reason: 'TCK-2 already has a card' }] };
  const body = (trigger) => ({ id: 'r1', automationName: 'Queue', trigger, state: 'finished', runsOn: 'once', level: 'work', createdCount: 2, cards: [card] });
  const live = await run(['run', 'r1'], { answers: [['run', 200, body('manual')]] });
  assert.match(live.out, /^ {2}Created: Reset MFA \(TCK-1\)$/m);
  assert.match(live.out, /^ {2}Created: Other$/m);
  assert.match(live.out, /^ {2}Not created: TCK-2 — TCK-2 already has a card$/m);
  const trial = await run(['run', 'r1'], { answers: [['run', 200, body('trial')]] });
  assert.match(trial.out, /^Queue · trial · nothing created · finished$/m);
  assert.match(trial.out, /^ {2}Would create: Reset MFA \(TCK-1\)$/m);
});

test('list shows Once automations and where their new cards go', async () => {
  const r = await run(['list'], { answers: [['list', 200, { automations: [
    { id: 'a1', enabled: false, name: 'Queue', scheduleText: 'Weekdays 08:00', level: 'work', runsOn: 'once', newCards: { board: 'work', folder: 'tickets', max: 5 }, lastRun: null, tag: '' },
    { id: 'a2', enabled: true, name: 'Check', scheduleText: 'Daily 08:00', level: 'report', lastRun: null, tag: '' }] }]] });
  assert.match(r.out, /^a1 {2}off {2}Queue · Weekdays 08:00 · Once · Work · New cards → work \/ tickets · never run$/m);
  assert.match(r.out, /^a2 {2}on {3}Check · Daily 08:00 · Report · never run$/m);
});

test('options lists Once levels, Runs on and the folders for new cards', async () => {
  const folders = ['', ...Array.from({ length: 24 }, (_, i) => `f${String(i).padStart(2, '0')}`)];
  const r = await run(['options'], { answers: [['options', 200, { ...optionsBody([]),
    runsOn: [{ id: 'cards', label: 'Each matching card' }, { id: 'once', label: 'Once' }], folders: { work: folders },
    agents: [{ id: 'cursor', label: 'Cursor CLI', levels: ['report', 'update'], onceLevels: ['work'], installed: true }],
    limits: { ...optionsBody([]).limits, newCardsPerRun: [1, 10], newCardsDefault: 5, newCardsPerHour: 30 } }]] });
  assert.match(r.out, /^Runs on: Each matching card \(cards\), Once \(once\)$/m);
  assert.match(r.out, /^ {2}cursor \(Cursor CLI\): report, update; once: work$/m);
  assert.match(r.out, /^Folders for new cards \(work\): \(top of the board\), f00, .*f18, and 5 more$/m);
  assert.match(r.out, /new cards 1–10 a run \(default 5\), 30 an hour/);
});

test('the help names runsOn and newCards among the edits that switch an automation off', async () => {
  const r = await run(['--help']);
  assert.match(r.out, /edit <id> --file <changes\.json> .*runsOn.*newCards/);
});

test('options explains newCards, including letting the agent choose the folder', async () => {
  const r = await run(['options'], { answers: [['options', 200, { ...optionsBody([]),
    runsOn: [{ id: 'cards', label: 'Each matching card' }, { id: 'once', label: 'Once' }], folders: { work: ['', 'tickets'] },
    limits: { ...optionsBody([]).limits, newCardsPerRun: [1, 10], newCardsDefault: 5, newCardsPerHour: 30 } }]] });
  assert.match(r.out, /^New cards \(Work only\): "newCards": \{ "board": "<key>", "folder": "<a folder below>", "max": 1–10 \}$/m);
  assert.match(r.out, /^ {2}or \{ "board": "<key>", "choose": true, "max": 1–10 \}: the agent picks a folder for each card and may add up to 3 new ones a run$/m);
  const old = await run(['options'], { answers: [['options', 200, optionsBody([])]] });
  assert.doesNotMatch(old.out, /New cards \(Work only\)/);
});
