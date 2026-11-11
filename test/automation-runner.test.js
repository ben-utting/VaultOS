'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomationStore } = require('../lib/automation-store');
const { createRunner } = require('../lib/automation-runner');
const A = require('../lib/automation-agents');
const { parseFrontmatter } = require('../lib/task-file');

process.env.AUTOMATION_TEST_AGENT = path.join(__dirname, 'fixtures', 'fake-agent.js');
const TZ = 'Europe/London';
const ctx = { boardKeys: ['work'], agentIds: ['default', 'claude'], tz: TZ };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const taskText = (title, status, extra = '') => `---
id: ${title}
title: "${title}"
status: ${status}
updated: 2026-11-01
${extra}---

## Goal
g

## Progress log

- 2026-11-01 — created.
`;

// A temp vault with a Work board, the real store and the real spawner (fake agent), and a runner over them.
function setup(t, { cards = {}, busy = [], clock = null, ...more } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-runner-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  for (const [name, [status, extra]] of Object.entries(cards)) {
    const dir = path.join(vault, 'Work', '1. a', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), taskText(name, status, extra));
  }
  const now = clock ? () => clock.now : Date.now;
  const store = createAutomationStore(vault, { now });
  const rel = (full) => path.relative(vault, full).split(path.sep).join('/');
  const listCards = async () => {
    const out = [];
    const base = path.join(vault, 'Work', '1. a');
    for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const full = path.join(base, name, 'task.md');
      if (!fs.existsSync(full)) continue;
      const { meta } = parseFrontmatter(fs.readFileSync(full, 'utf8'));
      out.push({ path: rel(full), board: 'work', title: meta.title, status: meta.status, updated: meta.updated, batch: meta.batch || '', full, dir: path.dirname(full) });
    }
    return out;
  };
  const runner = createRunner({
    store, now, tz: () => TZ, today: () => '2026-11-11', listCards,
    isBusy: (p) => busy.includes(p),
    resolveAgent: () => ({ id: 'claude', label: 'Claude Code' }),
    agentCommand: A.agentCommand, spawnAgent: A.spawnAgent, agentEnv: () => process.env,
    readCard: async (full) => { try { return fs.readFileSync(full, 'utf8'); } catch { return null; } },
    writeCard: async (card, raw) => fs.writeFileSync(card.full, raw),
    ...more,
  });
  t.after(() => runner.shutdown());
  const read = (name) => fs.readFileSync(path.join(vault, 'Work', '1. a', name, 'task.md'), 'utf8');
  const make = async (more2 = {}) => (await store.create({
    name: 'Check', enabled: true, agent: 'default', template: 'blank', prompt: 'FAKE:note', level: 'report',
    cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
    schedule: { repeat: 'daily', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more2,
  }, ctx)).value;
  const lastRun = async () => store.getRun((await store.listRuns({ limit: 1 }))[0].id);
  return { vault, store, runner, read, make, lastRun };
}
const runAndWait = async (s, a) => {
  assert.deepEqual(await s.runner.runNow(a.id), { queued: true });
  await s.runner.idle();
  return s.lastRun();
};
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(25); }
};

test('run now notes each matching card and writes the section', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['blocked'], '03-c': ['done'] } });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.state, 'finished');
  assert.equal(run.trigger, 'manual');
  assert.deepEqual(run.cards.map((c) => [c.path, c.state]), [['Work/1. a/01-a/task.md', 'noted'], ['Work/1. a/02-b/task.md', 'noted']]);
  assert.equal(run.cards[0].note, 'Fake note.');
  assert.match(s.read('01-a'), /## Latest check-in\n_\d+ \w+ 2026, \d\d:\d\d · Check · Claude Code_\n\nFake note\.\n\n## Goal/);
  assert.match(s.read('01-a'), /^updated: 2026-11-01$/m);
  assert.ok(!s.read('03-c').includes('Latest check-in'));
  assert.equal((await s.store.getState(run.automationId)).lastRunId, run.id);
});

test('subtasks are left out unless asked for', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-sub': ['in-progress', 'batch: 01-a\n'] } });
  assert.deepEqual((await runAndWait(s, await s.make())).cards.map((c) => c.title), ['01-a']);
  const both = await s.make({ name: 'With subtasks', cards: { board: 'work', statuses: ['in-progress'], subtasks: true } });
  assert.deepEqual((await runAndWait(s, both)).cards.map((c) => c.title), ['01-a', '02-sub']);
});

test('cards come in status order, then path', async (t) => {
  const s = setup(t, { cards: { '01-a': ['blocked'], '02-b': ['in-progress'], '03-c': ['in-progress'] } });
  assert.deepEqual((await runAndWait(s, await s.make())).cards.map((c) => c.title), ['02-b', '03-c', '01-a']);
});

test('a busy card is skipped with the reason', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] }, busy: ['Work/1. a/01-a/task.md'] });
  const run = await runAndWait(s, await s.make());
  assert.deepEqual(run.cards.map((c) => [c.state, c.reason]), [['skipped', 'an agent is working on it in a terminal'], ['noted', '']]);
  assert.ok(!s.read('01-a').includes('Latest check-in'));
});

test('over 20 cards: 20 processed, the rest not run', async (t) => {
  const cards = {};
  for (let i = 1; i <= 22; i++) cards[`${String(i).padStart(2, '0')}-x`] = ['in-progress'];
  const s = setup(t, { cards });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.cards.length, 22);
  assert.equal(run.cards.filter((c) => c.state === 'noted').length, 20);
  assert.deepEqual(run.cards.slice(20).map((c) => [c.state, c.reason]), [['not-run', 'over the 20-card limit'], ['not-run', 'over the 20-card limit']]);
});

test('no note: the card fails with the output tail and nothing is written', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const before = s.read('01-a');
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:none' }));
  assert.equal(run.cards[0].state, 'failed');
  assert.equal(run.cards[0].reason, 'no note in the output');
  assert.match(run.cards[0].outputTail, /wrote no note/);
  assert.equal(s.read('01-a'), before);
});

test('a crash on the first card fails the run fast', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'], '03-c': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:crash' }));
  assert.equal(run.state, 'failed');
  assert.deepEqual(run.cards.map((c) => c.state), ['failed', 'not-run', 'not-run']);
  assert.equal(run.cards[0].reason, 'the agent exited with code 3');
  assert.match(run.cards[0].outputTail, /boom/);
});

test('two timeouts in a row stop the run', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'], '03-c': ['in-progress'] }, timeLimitMs: 300 });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:hang' }));
  assert.equal(run.state, 'failed');
  assert.deepEqual(run.cards.map((c) => c.state), ['timed-out', 'timed-out', 'not-run']);
});

test('files changed on a report run are flagged', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:touch' }));
  assert.equal(run.cards[0].state, 'noted');
  assert.deepEqual(run.cards[0].filesChanged, ['touched.txt']);
});

test('an update proposal is applied', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:update:blocked', level: 'update' }));
  assert.deepEqual(run.cards[0].statusChange, { from: 'in-progress', to: 'blocked' });
  assert.match(s.read('01-a'), /^status: blocked$/m);
  assert.match(s.read('01-a'), /^blocked_by: fake blocker$/m);
});

test('a work run that sets done is put back', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:done', level: 'work' }));
  assert.equal(run.cards[0].doneReverted, true);
  assert.match(s.read('01-a'), /^status: in-progress$/m);
  assert.equal(run.cards[0].statusBefore, 'in-progress');
});

test('a card finished before its turn is recorded as moved', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  fs.writeFileSync(path.join(s.vault, 'Work/1. a/02-b/task.md'), taskText('02-b', 'done'));
  await s.runner.idle();
  assert.deepEqual((await s.lastRun()).cards.map((c) => c.state), ['noted', 'moved']);
});

test('stop() mid-card', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:hang' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  await sleep(200);
  const t0 = Date.now();
  assert.equal(s.runner.stop(), true);
  await s.runner.idle();
  assert.ok(Date.now() - t0 < 7000);
  const run = await s.lastRun();
  assert.equal(run.state, 'stopped');
  assert.deepEqual(run.cards.map((c) => [c.state, c.reason]), [['failed', 'stopped'], ['not-run', '']]);
  assert.equal(s.runner.stop(), false);
});

test('tick runs a due automation once and collapses missed slots', async (t) => {
  const clock = { now: Date.parse('2026-11-09T09:00:00Z') };
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, clock });
  const a = await s.make();
  clock.now = Date.parse('2026-11-11T10:00:00Z');
  await s.runner.tick();
  await s.runner.idle();
  await s.runner.tick();
  await s.runner.idle();
  const runs = await s.store.listRuns({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'catch-up');
  assert.equal((await s.store.getState(a.id)).lastSlot, Date.parse('2026-11-11T08:00:00Z'));
});

test('tick on time is a scheduled run, and a disabled automation never runs', async (t) => {
  const clock = { now: Date.parse('2026-11-10T09:00:00Z') };
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, clock });
  await s.make();
  await s.make({ name: 'Off', enabled: false });
  clock.now = Date.parse('2026-11-11T08:00:20Z');
  await s.runner.tick();
  await s.runner.idle();
  const runs = await s.store.listRuns({});
  assert.deepEqual(runs.map((r) => [r.automationName, r.trigger]), [['Check', 'schedule']]);
});

test('the queue runs one at a time and refuses duplicates', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow' });
  const b = await s.make({ name: 'B', prompt: 'FAKE:note' });
  assert.deepEqual(await s.runner.runNow(a.id), { queued: true });
  assert.deepEqual(await s.runner.runNow(b.id), { queued: true });
  await waitFor(() => s.runner.status().current);
  assert.equal(s.runner.status().current.automationId, a.id);
  assert.deepEqual(s.runner.status().queue, [b.id]);
  assert.ok((await s.runner.runNow(b.id)).error);
  assert.ok((await s.runner.runNow(a.id)).error);
  assert.ok((await s.runner.runNow('nope')).error);
  await s.runner.idle();
  const runs = await s.store.listRuns({});
  assert.deepEqual(runs.map((r) => r.automationName).sort(), ['B', 'Check']);
  const [first, second] = [...runs].sort((x, y) => (x.startedAt < y.startedAt ? -1 : 1));
  assert.ok(second.startedAt >= first.endedAt);
});

test('delete while running stops it', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:hang' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  s.runner.remove(a.id);
  await s.runner.idle();
  assert.equal((await s.lastRun()).state, 'stopped');
});

test('edit during run keeps snapshot', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow MARK:old' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  const { id, created, updated, ...def } = a;
  await s.store.update(a.id, { ...def, prompt: 'FAKE:slow MARK:new' }, ctx);
  await s.runner.idle();
  assert.deepEqual((await s.lastRun()).cards.map((c) => c.note), ['Slow note. MARK:old', 'Slow note. MARK:old']);
});

test('no usable agent fails the run without starting anything', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, resolveAgent: () => null });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.state, 'failed');
  assert.equal(run.cards[0].state, 'not-run');
  assert.match(run.cards[0].reason, /agent/i);
});

test('start() twice leaves one interval', async (t) => {
  let made = 0;
  let cleared = 0;
  const s = setup(t, {
    setInterval: () => { made++; return { unref() {} }; },
    clearInterval: () => { cleared++; },
  });
  s.runner.start();
  s.runner.start();
  assert.equal(made, 1);
  s.runner.shutdown();
  assert.equal(cleared, 1);
  s.runner.start();
  assert.equal(made, 2);
});

test('a run is visible as current or queued from the moment it is queued', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make();
  await s.runner.runNow(a.id);
  const st = s.runner.status();
  assert.ok((st.current && st.current.automationId === a.id) || st.queue.includes(a.id), JSON.stringify(st));
  await s.runner.idle();
  assert.deepEqual(s.runner.status(), { current: null, queue: [] });
});
