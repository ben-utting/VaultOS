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
      out.push({ path: rel(full), board: 'work', title: meta.title || name, status: meta.status || 'backlog', updated: meta.updated, batch: meta.batch || '', full, dir: path.dirname(full) });
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

test('a card the agent setup refuses is skipped with its reason, gets no agent, and the run goes on', async (t) => {
  const seen = [];
  const spawned = [];
  const s = setup(t, {
    cards: { '01-a': ['in-progress'], '02-b': ['in-progress'], '03-c': ['in-progress'] },
    prepareAgent: async (agentId, level, dir) => {
      seen.push([agentId, level, path.basename(dir)]);
      return path.basename(dir) === '01-a' ? { skip: 'its folder has its own agent hooks (.cursor/hooks.json)' } : {};
    },
    spawnAgent: (opts) => { spawned.push(path.basename(opts.cwd)); return A.spawnAgent(opts); },
  });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.state, 'finished');
  assert.deepEqual(run.cards.map((c) => [c.state, c.reason]), [
    ['skipped', 'its folder has its own agent hooks (.cursor/hooks.json)'], ['noted', ''], ['noted', '']]);
  assert.deepEqual(seen, [['claude', 'report', '01-a'], ['claude', 'report', '02-b'], ['claude', 'report', '03-c']]);
  assert.deepEqual(spawned, ['02-b', '03-c']);
  assert.ok(!s.read('01-a').includes('Latest check-in'));
});

test('a setup that throws fails that card only, without starting an agent', async (t) => {
  const spawned = [];
  const s = setup(t, {
    cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] },
    prepareAgent: async (agentId, level, dir) => { if (path.basename(dir) === '01-a') throw new Error('disk full'); return {}; },
    spawnAgent: (opts) => { spawned.push(path.basename(opts.cwd)); return A.spawnAgent(opts); },
  });
  const run = await runAndWait(s, await s.make());
  assert.deepEqual(run.cards.map((c) => c.state), ['failed', 'noted']);
  assert.match(run.cards[0].reason, /disk full/);
  assert.deepEqual(spawned, ['02-b']);
});

// ---------- Trials ----------
const tryAndWait = async (s, a) => {
  assert.deepEqual(await s.runner.tryNow(a.id), { queued: true });
  await s.runner.idle();
  return s.lastRun();
};
const AC = require('../public/automation-core');

test('a trial takes at most 3 cards and writes nothing', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'], '03-c': ['in-progress'], '04-d': ['in-progress'], '05-e': ['blocked'] } });
  const names = ['01-a', '02-b', '03-c', '04-d', '05-e'];
  const before = names.map((n) => s.read(n));
  const run = await tryAndWait(s, await s.make());
  assert.equal(run.trigger, 'trial');
  assert.equal(run.state, 'finished');
  assert.deepEqual(run.cards.map((c) => [c.title, c.state]), [['01-a', 'noted'], ['02-b', 'noted'], ['03-c', 'noted']]);
  assert.equal(run.cards[0].note, 'Fake note.');
  assert.deepEqual(names.map((n) => s.read(n)), before);
});

test('a trial runs the agent at report level with the report prompt for a work automation', async (t) => {
  const levels = [];
  const preps = [];
  const prompts = [];
  const s = setup(t, {
    cards: { '01-a': ['in-progress'] },
    agentCommand: (id, level, prompt, opts) => { levels.push(level); if (prompt) prompts.push(prompt); return A.agentCommand(id, level, prompt, opts); },
    prepareAgent: async (id, level) => { preps.push(level); return {}; },
  });
  const run = await tryAndWait(s, await s.make({ level: 'work' }));
  assert.equal(run.cards[0].state, 'noted');
  assert.ok(levels.length && levels.every((l) => l === 'report'), levels.join());
  assert.deepEqual(preps, ['report']);
  assert.ok(prompts[0].includes(AC.LEVEL_PARAGRAPHS.report));
  assert.ok(!prompts[0].includes(AC.LEVEL_PARAGRAPHS.work));
});

test('an update trial records the move it would make without making it', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const before = s.read('01-a');
  const run = await tryAndWait(s, await s.make({ level: 'update', prompt: 'FAKE:update:blocked' }));
  assert.deepEqual(run.cards[0].statusChange, { from: 'in-progress', to: 'blocked' });
  assert.equal(s.read('01-a'), before);
  assert.match(s.read('01-a'), /^status: in-progress$/m);
});

test('a trial is refused while that automation is running or queued', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow' });
  assert.deepEqual(await s.runner.runNow(a.id), { queued: true });
  const r = await s.runner.tryNow(a.id);
  assert.ok(r.error === 'It is running now' || r.error === 'It is already queued', JSON.stringify(r));
  await s.runner.idle();
  const runs = await s.store.listRuns({ limit: 5 });
  assert.deepEqual(runs.map((x) => x.trigger), ['manual']);
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

// ---------- Final review fixes ----------
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('stop before the agent starts: no agent is spawned', { timeout: 20000 }, async (t) => {
  const g = gate();
  let spawned = 0;
  let reads = 0;
  const s = setup(t, {
    cards: { '01-a': ['in-progress'] },
    spawnAgent: (o) => { spawned++; return A.spawnAgent(o); },
    readCard: async (full) => { if (++reads === 1) await g.p; try { return fs.readFileSync(full, 'utf8'); } catch { return null; } },
  });
  const a = await s.make({ prompt: 'FAKE:hang' });
  await s.runner.runNow(a.id);
  await waitFor(() => reads === 1);
  s.runner.stop();
  g.open();
  await s.runner.idle();
  assert.equal(spawned, 0);
  const run = await s.lastRun();
  assert.equal(run.state, 'stopped');
  assert.deepEqual(run.cards.map((c) => [c.state, c.reason]), [['failed', 'stopped']]);
});

test('a tick still in flight when automations are switched off starts nothing', { timeout: 20000 }, async (t) => {
  const clock = { now: Date.parse('2026-11-10T09:00:00Z') };
  const g = gate();
  let gated = false;
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, clock });
  await s.make();
  const realList = s.store.list;
  s.store.list = async () => { if (gated) await g.p; return realList(); };
  clock.now = Date.parse('2026-11-11T08:00:20Z');
  gated = true;
  const ticking = s.runner.tick();
  s.runner.shutdown();
  g.open();
  await ticking;
  await s.runner.idle();
  assert.deepEqual(await s.store.listRuns({}), []);
  assert.deepEqual((await s.runner.runNow((await realList())[0].id)), { error: 'Automations are off' });
  s.runner.start();
  assert.deepEqual((await s.runner.runNow((await realList())[0].id)), { queued: true });
  await s.runner.idle();
});

test('a write error fails the card, not the server', { timeout: 20000 }, async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, writeCard: async () => { throw new Error('ENOSPC: no space left on device'); } });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.state, 'failed');
  assert.equal(run.cards[0].state, 'failed');
  assert.match(run.cards[0].reason, /no space left/);
  assert.deepEqual(s.runner.status(), { current: null, queue: [] });
});

test('an update run over a card without frontmatter fails that card cleanly', { timeout: 20000 }, async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:update:blocked', level: 'update', cards: { board: 'work', statuses: ['backlog', 'in-progress'], subtasks: false } });
  fs.mkdirSync(path.join(s.vault, 'Work/1. a/00-bare'), { recursive: true });
  fs.writeFileSync(path.join(s.vault, 'Work/1. a/00-bare/task.md'), 'no frontmatter here\n');
  const run = await runAndWait(s, a);
  const bare = run.cards.find((c) => c.path.includes('00-bare'));
  assert.equal(bare.state, 'failed');
  assert.match(bare.reason, /frontmatter/);
  assert.equal(fs.readFileSync(path.join(s.vault, 'Work/1. a/00-bare/task.md'), 'utf8'), 'no frontmatter here\n');
});

test('a run whose definition cannot be read clears itself and the queue goes on', { timeout: 20000 }, async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make();
  const b = await s.make({ name: 'B' });
  const realGet = s.store.get;
  let calls = 0;
  s.store.get = async (id) => { if (id === a.id && ++calls === 2) throw new Error('automations.json: Unexpected end of JSON input'); return realGet(id); };
  await s.runner.runNow(a.id);
  await s.runner.runNow(b.id);
  await s.runner.idle();
  assert.deepEqual(s.runner.status(), { current: null, queue: [] });
  assert.deepEqual((await s.store.listRuns({})).map((r) => [r.automationName, r.state]), [['B', 'finished']]);
});

test('a card the person finished mid-run gets no note (report)', { timeout: 20000 }, async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  await sleep(200);
  const f = path.join(s.vault, 'Work/1. a/01-a/task.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: in-progress', 'status: done'));
  const done = fs.readFileSync(f, 'utf8');
  await s.runner.idle();
  const run = await s.lastRun();
  assert.equal(run.cards[0].state, 'moved');
  assert.equal(run.cards[0].reason, 'the card was finished while the agent ran');
  assert.equal(fs.readFileSync(f, 'utf8'), done);
});

test('a card moved to Done on the board during a work run stays done', { timeout: 20000 }, async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] } });
  const a = await s.make({ prompt: 'FAKE:slow', level: 'work' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  await sleep(200);
  const f = path.join(s.vault, 'Work/1. a/01-a/task.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: in-progress', 'status: done')
    .replace('## Progress log\n\n', '## Progress log\n\n- 2026-11-11 — status in-progress → done (moved on the board).\n'));
  await s.runner.idle();
  assert.equal((await s.lastRun()).cards[0].state, 'moved');
  assert.match(fs.readFileSync(f, 'utf8'), /^status: done$/m);
});
