'use strict';
// `vaultos-calendar` (spec §7.2): argument handling, what it sends, how it prints and its exit codes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main, USAGE } = require('../lib/calendar-cli');

const ENV = { VAULTOS_HOOK_URL: 'http://127.0.0.1:7684/api/term/agent', VAULTOS_TERM_ID: 'term1234', VAULTOS_TERM_TOKEN: 'tok' };
const OFF = 'The calendar is switched off in VaultOS Settings → Features.';
const sink = () => { const s = { text: '', write: (d) => { s.text += d; return true; } }; return s; };
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
    env, stdout, stderr, fetch, procNames,
    readFile: async (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
  });
  return { code, out: stdout.text, err: stderr.text, sent: fetch.sent, last: fetch.sent[fetch.sent.length - 1] };
};
const ENTRY = {
  id: 'c_7k2m9p4x1q', title: 'Chase X', date: '2026-11-20', allDay: false, start: '09:00', end: null, repeat: null, skip: [], ping: 'start', card: null, note: '',
  created: { at: '2026-11-18T10:00:00.000Z', by: { kind: 'agent', agent: 'Claude Code' } }, updated: { at: '2026-11-18T10:00:00.000Z', by: { kind: 'agent', agent: 'Claude Code' } },
};
const OCC = (more = {}) => ({ entryId: 'c_7k2m9p4x1q', date: '2026-11-20', title: 'Chase X', allDay: false, start: '09:00', end: null, repeat: null, repeatText: '', ping: 'start', card: null, note: '', ...more });

test('add maps flags onto an entry and posts it with id, token and agentHint', async () => {
  const { code, last: sent, out } = await run(
    ['add', '--title', 'Chase X', '--date', 'tomorrow', '--time', '09:00', '--repeat', 'weekly:mon,fri', '--until', '2026-12-31', '--ping', '10m'],
    { answers: [['add', 200, { entry: { ...ENTRY, repeat: { every: 'weekly', days: [0, 4], until: '2026-12-31' }, ping: '10m' } }]] });
  assert.equal(code, 0);
  assert.equal(sent.url, 'http://127.0.0.1:7684/api/term/calendar/add');
  assert.deepEqual(sent.body.args.entry, { title: 'Chase X', date: 'tomorrow', start: '09:00', allDay: false, repeat: { every: 'weekly', days: [0, 4], until: '2026-12-31' }, ping: '10m' });
  assert.deepEqual(sent.body.agentHint, ['bash', 'claude']);
  assert.equal(sent.body.id, 'term1234');
  assert.equal(sent.body.token, 'tok');
  assert.match(out, /^Added: c_7k2m9p4x1q · Fri 20 Nov 2026 09:00 · Chase X · Mon, Fri until 31 Dec 2026 · pings 10 min before$/m);
});

test('add: all-day, ping none, card, note, end', async () => {
  const r = await run(['add', '--title', 'Holiday', '--date', '2026-12-24', '--all-day', '--ping', 'none', '--card', 'Work/1. a/01-x', '--note', 'Pack'],
    { answers: [['add', 200, { entry: { ...ENTRY, allDay: true, start: null, ping: null } }]] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.last.body.args.entry, { title: 'Holiday', date: '2026-12-24', allDay: true, ping: null, card: 'Work/1. a/01-x', note: 'Pack' });
  const e = await run(['add', '--title', 'M', '--date', 'today', '--time', '09:00', '--end', '09:30'], { answers: [['add', 200, { entry: ENTRY }]] });
  assert.equal(e.last.body.args.entry.end, '09:30');
});

test('edit sends only the flags given; --file sends the JSON unchanged', async () => {
  const r = await run(['edit', 'c_7k2m9p4x1q', '--title', 'New'], { answers: [['edit', 200, { entry: ENTRY }]] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.last.body.args, { id: 'c_7k2m9p4x1q', changes: { title: 'New' } });
  const t = await run(['edit', 'c_7k2m9p4x1q', '--time', '10:00'], { answers: [['edit', 200, { entry: ENTRY }]] });
  assert.deepEqual(t.last.body.args.changes, { start: '10:00', allDay: false });   // a time makes it timed
  const f = await run(['edit', 'c_7k2m9p4x1q', '--file', 'c.json'], { files: { 'c.json': '{"note":"x","weird":1}' }, answers: [['edit', 200, { entry: ENTRY }]] });
  assert.deepEqual(f.last.body.args.changes, { note: 'x', weird: 1 });
  const a = await run(['add', '--file', '-'], { files: { '-': '{"title":"From stdin"}' }, answers: [['add', 200, { entry: ENTRY }]] });
  assert.deepEqual(a.last.body.args.entry, { title: 'From stdin' });
});

test('edit --until alone keeps the repeat it has', async () => {
  const shown = { entry: { ...ENTRY, repeat: { every: 'weekly', days: [2] }, repeatText: 'Every Wednesday' } };
  const r = await run(['edit', 'c_7k2m9p4x1q', '--until', '2027-01-31'], { answers: [['show', 200, shown], ['edit', 200, { entry: ENTRY }]] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.last.body.args.changes, { repeat: { every: 'weekly', days: [2], until: '2027-01-31' } });
});

test('field errors print per field and exit 1', async () => {
  const r = await run(['add', '--title', '', '--date', 'Friday'], { answers: [['add', 400, { error: 'Some fields need fixing', errors: { title: 'A title is needed', date: 'Use YYYY-MM-DD (for example 2026-11-20)' } }]] });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'Some fields need fixing\n  title: A title is needed\n  date: Use YYYY-MM-DD (for example 2026-11-20)\n');
});

test('switched off prints the message and exits 1', async () => {
  const r = await run(['today'], { answers: [['today', 403, { error: OFF }]] });
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), OFF);
  const lim = await run(['add', '--title', 'x', '--date', 'today', '--time', '09:00'], { answers: [['add', 429, { error: 'Too many calendar changes from agents in the last hour' }]] });
  assert.equal(lim.code, 1);
});

test('outside a VaultOS terminal exits 2', async () => {
  const r = await run(['today'], { env: {} });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), 'Run this in a VaultOS terminal.');
  assert.equal(r.sent.length, 0);
  const ended = await run(['today'], { answers: [['today', 403, { error: 'Forbidden' }]] });
  assert.equal(ended.code, 2);
});

test('VaultOS not answering exits 3', async () => {
  const r = await run(['due'], { answers: [['due', 'down']] });
  assert.equal(r.code, 3);
  assert.equal(r.err.trim(), "VaultOS isn't answering.");
});

test('--json prints the server body', async () => {
  const body = { count: 0, items: [] };
  const r = await run(['due', '--json'], { answers: [['due', 200, body]] });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), body);
});

test('today prints the Now line first', async () => {
  const r = await run(['today'], { answers: [['today', 200, {
    now: { date: '2026-11-18', time: '10:05', timezone: 'Europe/London', weekday: 'Wednesday' },
    entries: [OCC({ date: '2026-11-18', start: '11:00', end: '11:30', card: { path: 'Work/a/task.md', title: 'Card A', exists: true, board: 'work' }, repeatText: 'Every day' })],
    due: [{ key: 'c_7k2m9p4x1q@2026-11-18', entryId: 'c_7k2m9p4x1q', date: '2026-11-18', title: 'Chase X', pingAt: '2026-11-18T09:00:00.000Z', start: '09:00', allDay: false, card: null, by: '', missedEarlier: 2 }],
  }]] });
  assert.equal(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines[0], 'Now: Wed 18 Nov 2026 10:05 Europe/London');
  assert.ok(lines.includes('  c_7k2m9p4x1q · Wed 18 Nov 2026 11:00–11:30 · Chase X · Every day · pings at start · card Card A'), r.out);
  assert.ok(lines.includes('  c_7k2m9p4x1q@2026-11-18 · Wed 18 Nov 2026 09:00 · Chase X [+2 missed earlier]'), r.out);
});

test('list prints one line per occurrence, all-day as All day; empty says so', async () => {
  const r = await run(['list', '--from', 'today', '--to', '2026-11-30', '--search', 'chase'], { answers: [['list', 200, {
    from: '2026-11-18', to: '2026-11-30', days: [{ date: '2026-11-20', occurrences: [OCC(), OCC({ entryId: 'c_bbbbbbbbbb', allDay: true, start: null, title: 'Off', ping: '1d' })] }],
  }]] });
  assert.deepEqual(r.last.body.args, { from: 'today', to: '2026-11-30', search: 'chase' });
  assert.equal(r.out, 'c_7k2m9p4x1q · Fri 20 Nov 2026 09:00 · Chase X · pings at start\nc_bbbbbbbbbb · Fri 20 Nov 2026 All day · Off · pings at 08:00 the day before\n');
  const e = await run(['list'], { answers: [['list', 200, { from: '2026-11-18', to: '2026-12-01', days: [] }]] });
  assert.equal(e.out.trim(), 'Nothing from Wed 18 Nov 2026 to Tue 1 Dec 2026.');
});

test('skip, delete, restore, done, dismiss, snooze send the right args', async () => {
  let r = await run(['skip', 'c_7k2m9p4x1q', '--date', 'tomorrow'], { answers: [['skip', 200, { entry: ENTRY }]] });
  assert.deepEqual(r.last.body.args, { id: 'c_7k2m9p4x1q', date: 'tomorrow' });
  r = await run(['delete', 'c_7k2m9p4x1q'], { answers: [['delete', 200, { entry: ENTRY }]] });
  assert.match(r.out, /Recently deleted/);
  r = await run(['restore', 'c_7k2m9p4x1q'], { answers: [['restore', 200, { entry: ENTRY }]] });
  assert.equal(r.code, 0);
  r = await run(['done', 'c_7k2m9p4x1q'], { answers: [['done', 200, { ok: true }]] });
  assert.deepEqual(r.last.body.args, { target: 'c_7k2m9p4x1q' });
  r = await run(['snooze', 'c_7k2m9p4x1q@2026-11-18', '--for', '2h'], { answers: [['snooze', 200, { ok: true, until: '2026-11-18T12:00:00.000Z' }]] });
  assert.deepEqual(r.last.body.args, { target: 'c_7k2m9p4x1q@2026-11-18', for: '2h' });
  r = await run(['dismiss', 'c_7k2m9p4x1q'], { answers: [['dismiss', 200, { ok: true }]] });
  assert.equal(r.code, 0);
});

test('bad usage (unknown command, missing id, bad --repeat) exits 2 with USAGE', async () => {
  for (const argv of [['nonsense'], [], ['show'], ['edit'], ['skip', 'c_7k2m9p4x1q'], ['snooze', 'c_7k2m9p4x1q'], ['delete'],
    ['add', '--title', 'x', '--date', 'today', '--repeat', 'hourly'], ['add', '--title'], ['add', '--title', 'x', '--until', '2026-12-01']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(r.err.includes(USAGE), JSON.stringify(argv));
    assert.equal(r.sent.length, 0);
  }
  assert.match(USAGE, /^vaultos-calendar <command> \[--json\]/);
  assert.match(USAGE, /done <id\|key> {2}dismiss <id\|key> {2}snooze <id\|key> --for 10m\|1h\|tomorrow\|Nm\|Nh/);
});

test('--help prints the usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(USAGE));
});

test('a warning from VaultOS prints after the confirmation (the agent relays it)', async () => {
  const r = await run(['add', '--title', 'Bins', '--date', 'tomorrow', '--all-day', '--ping', '1d'],
    { answers: [['add', 200, { entry: { ...ENTRY, allDay: true, start: null, ping: '1d' }, warning: "That ping time has already passed, so it won't ping." }]] });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Added: .*\nNote: That ping time has already passed, so it won't ping\.\n$/);
  const e = await run(['edit', 'c_7k2m9p4x1q', '--date', '2026-11-01'], { answers: [['edit', 200, { entry: ENTRY, warning: 'W' }]] });
  assert.match(e.out, /\nNote: W\n$/);
});

// ---------- brief and the Agent button's fields (spec 2026-11-19 §4) ----------
const BRIEF = { text: 'Calendar item c_7k2m9p4x1q\nChase X\n\nBefore you do anything:\n  - Read first.', entry: ENTRY, when: { date: '2026-11-20', text: 'Due Fri 20 Nov 2026 09:00' }, card: null, rules: ['Read first.'] };
test('brief sends the id and date and prints the server text exactly', async () => {
  const r = await run(['brief', 'c_7k2m9p4x1q', '--date', 'today'], { answers: [['brief', 200, BRIEF]] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.last.body.args, { id: 'c_7k2m9p4x1q', date: 'today' });
  assert.equal(r.out, `${BRIEF.text}\n`);
  const plain = await run(['brief', 'c_7k2m9p4x1q'], { answers: [['brief', 200, BRIEF]] });
  assert.deepEqual(plain.last.body.args, { id: 'c_7k2m9p4x1q' });
  const json = await run(['brief', 'c_7k2m9p4x1q', '--json'], { answers: [['brief', 200, BRIEF]] });
  assert.deepEqual(JSON.parse(json.out), BRIEF);
});
test('brief without an id is a usage error; a refusal exits 1 with the message', async () => {
  const bare = await run(['brief']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /brief <id> \[--date D\]/);
  const r = await run(['brief', 'c_zzzzzzzzzz'], { answers: [['brief', 404, { error: 'No calendar entry c_zzzzzzzzzz' }]] });
  assert.equal(r.code, 1);
  assert.match(r.err, /^No calendar entry c_zzzzzzzzzz/);
});
test('add takes repeated --link, --brief and --agent', async () => {
  const r = await run(['add', '--title', 'X', '--date', 'today', '--time', '09:00', '--link', 'Work/a.md', '--link', 'https://b.test', '--brief', 'Look at B', '--agent', 'cursor'],
    { answers: [['add', 200, { entry: ENTRY }]] });
  assert.equal(r.code, 0);
  const e = r.last.body.args.entry;
  assert.deepEqual([e.links, e.brief, e.agent], [['Work/a.md', 'https://b.test'], 'Look at B', 'cursor']);
  const def = await run(['add', '--title', 'X', '--date', 'today', '--time', '09:00', '--agent', 'default'], { answers: [['add', 200, { entry: ENTRY }]] });
  assert.equal(def.last.body.args.entry.agent, null);
});
test('edit sends only the new fields it was given', async () => {
  const ok = [['edit', 200, { entry: ENTRY }]];
  assert.deepEqual((await run(['edit', 'c_7k2m9p4x1q', '--link', 'z'], { answers: ok })).last.body.args.changes, { links: ['z'] });
  assert.deepEqual((await run(['edit', 'c_7k2m9p4x1q', '--no-links'], { answers: ok })).last.body.args.changes, { links: [] });
  assert.deepEqual((await run(['edit', 'c_7k2m9p4x1q', '--brief', ''], { answers: ok })).last.body.args.changes, { brief: '' });
  assert.deepEqual((await run(['edit', 'c_7k2m9p4x1q', '--agent', 'default'], { answers: ok })).last.body.args.changes, { agent: null });
});
test('show prints links, the focus and the agent', async () => {
  const e = { ...ENTRY, links: ['https://x.test', 'Work/a.md'], brief: 'Did they reply?', agent: 'cursor', agentLabel: 'Cursor CLI' };
  const r = await run(['show', 'c_7k2m9p4x1q'], { answers: [['show', 200, { entry: e }]] });
  assert.match(r.out, /\nLinks:\n {2}https:\/\/x\.test\n {2}Work\/a\.md\n/);
  assert.match(r.out, /\nFor the agent: Did they reply\?\n/);
  assert.match(r.out, /\nAgent: Cursor CLI\n/);
  const plain = await run(['show', 'c_7k2m9p4x1q'], { answers: [['show', 200, { entry: { ...ENTRY, links: [], brief: '', agent: null, agentLabel: null } }]] });
  assert.doesNotMatch(plain.out, /Links:|For the agent:/);
  assert.match(plain.out, /\nAgent: default\n/);
});

test('clear sends the id and date and says what went', async () => {
  const one = await run(['clear', 'c_7k2m9p4x1q'], { answers: [['clear', 200, { cleared: 'entry', date: '2026-11-20', entry: ENTRY }]] });
  assert.equal(one.code, 0);
  assert.deepEqual(one.last.body.args, { id: 'c_7k2m9p4x1q' });
  assert.equal(one.out, 'Cleared Chase X. It stays in Recently deleted for 30 days; vaultos-calendar restore c_7k2m9p4x1q brings it back.\n');
  const rep = await run(['clear', 'c_7k2m9p4x1q', '--date', 'today'], { answers: [['clear', 200, { cleared: 'date', date: '2026-11-20', entry: { ...ENTRY, repeat: { every: 'daily' } } }]] });
  assert.deepEqual(rep.last.body.args, { id: 'c_7k2m9p4x1q', date: 'today' });
  assert.equal(rep.out, 'Cleared Fri 20 Nov 2026 from Chase X. The rest of the repeat stays.\n');
  assert.equal((await run(['clear'])).code, 2);
});
