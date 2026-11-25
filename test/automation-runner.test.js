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
const { createCardWriter, checkDestination, destinationFolders } = require('../lib/automation-newcards');

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
function setup(t, { cards = {}, busy = [], clock = null, withNewCards = false, ...more } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-runner-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  if (withNewCards) {
    // New cards go into Work/<folder>, through the real writer (what lib/automation-service.js builds).
    fs.mkdirSync(path.join(vault, 'Work', 'tickets'), { recursive: true });
    const writer = createCardWriter({ vaultDir: vault });
    more = {
      newCards: {
        begin: async (automation, { trial, agentLabel }) => {
          const boardDir = path.join(vault, 'Work');
          const skipDirs = new Set(['_tasks', '_Templates', 'archive']);
          const nc = automation.newCards;
          const chk = checkDestination(boardDir, nc.folder, { skipDirs });
          if (!chk.ok) return { error: chk.error };
          const h = await writer.begin({ boardDir, destDir: chk.dir, max: nc.max, automationName: automation.name, agentLabel, trial, today: '2026-11-11', tz: TZ, choose: !!nc.choose });
          return { ...h, dir: chk.dir, relDir: path.relative(vault, chk.dir).split(path.sep).join('/'),
            label: nc.choose ? 'Work' : `Work / ${nc.folder || 'top of the board'}`, choose: !!nc.choose,
            folders: nc.choose ? await destinationFolders(boardDir, { skipDirs }) : [] };
        },
      },
      ...more,
    };
  }
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

// The real Cursor command each card would get (the fake agent still does the run).
const cursorSpy = (cmds) => ({
  resolveAgent: () => ({ id: 'cursor', label: 'Cursor CLI' }),
  agentCommand: (id, level, prompt, opts) => {
    if (prompt) cmds.push(A.ADAPTERS[id].command(level, prompt, { ...opts, home: '/h' }).cmd);
    return A.agentCommand(id, level, prompt, opts);
  },
});

test('a run passes the automation model to every card, and a trial does too', async (t) => {
  const cmds = [];
  const s = setup(t, { cards: { '01-a': ['in-progress'], '02-b': ['blocked'] }, ...cursorSpy(cmds) });
  const a = await s.make({ agent: 'default', model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' });
  assert.equal(a.model, 'claude-opus-4-8[context=1m,effort=high,fast=false]');
  const run = await runAndWait(s, a);
  assert.deepEqual(run.cards.map((c) => c.state), ['noted', 'noted']);
  await tryAndWait(s, a);
  assert.equal(cmds.length, 4);
  for (const cmd of cmds) {
    assert.equal(cmd.split('--model').length - 1, 1, cmd);
    assert.ok(cmd.endsWith(" --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'"), cmd);
  }
});

test('an automation with no model runs Cursor without --model', async (t) => {
  const cmds = [];
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, ...cursorSpy(cmds) });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.cards[0].state, 'noted');
  assert.equal(cmds.length, 1);
  assert.ok(!cmds[0].includes('--model'), cmds[0]);
});

test('an automation saved before models existed (no model field) loads and runs', async (t) => {
  const cmds = [];
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, ...cursorSpy(cmds) });
  const old = {
    id: '0123abcd', name: 'Old check', enabled: true, agent: 'cursor', template: 'blank', prompt: 'FAKE:note', level: 'report',
    cards: { board: 'work', statuses: ['in-progress'], subtasks: false }, schedule: { repeat: 'daily', time: '20:00' },
    section: 'Latest check-in', timeLimitMin: 10, created: '2026-11-12T10:00:00.000Z', updated: '2026-11-12T10:00:00.000Z',
  };
  fs.mkdirSync(path.join(s.vault, '.vaultos'), { recursive: true });
  fs.writeFileSync(path.join(s.vault, '.vaultos', 'automations.json'), JSON.stringify({ version: 1, automations: [old] }));
  assert.deepEqual(await s.store.get(old.id), old);
  const run = await runAndWait(s, old);
  assert.equal(run.state, 'finished');
  assert.equal(run.cards[0].state, 'noted');
  assert.match(s.read('01-a'), /## Latest check-in\n.*Old check · Cursor CLI_\n\nFake note\./);
  assert.ok(!cmds[0].includes('--model'), cmds[0]);
  assert.equal('model' in (await s.store.get(old.id)), false, 'running it adds no model');
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

// ---------- Connector access per card ----------
const cctx = { ...ctx, connectorIds: ['atlassian', 'vantage'], agentConnectors: { default: true, claude: true } };
// A stand-in for connectors.automationAccess: records every open and revoke, returns a fake Access.
function fakeAccess(over = {}) {
  const log = { opened: [], revoked: 0, order: [] };
  const fn = async (o) => {
    log.opened.push(o);
    if (over.fail) throw new Error(over.fail);
    return {
      ids: ['atlassian'], entries: { atlassian: { kind: 'http', url: 'http://x', headers: { 'X-VaultOS-Key': 'SECRETKEY' } } },
      missing: ['vantage'], labels: { atlassian: 'Atlassian', vantage: 'Vantage' }, configFile: '/tmp/fake-mcp.json',
      usage: async () => {
        log.order.push('usage');
        if (over.usageFails) throw new Error(over.usageFails);
        return { lookups: { atlassian: { getIssue: 2 } }, refusedCalls: { atlassian: { editIssue: 1 } } };
      },
      revoke: async () => { log.revoked++; log.order.push('revoke'); },
    };
  };
  return { log, fn };
}
const withConn = (s, more = {}) => s.make({ connectors: ['atlassian', 'vantage'], ...more });
const cset = (t, o = {}, extra = {}) => {
  const acc = fakeAccess(o);
  const s = setup(t, { agentConnectors: () => true, connectorAccess: acc.fn, ...extra });
  const make = (more = {}) => s.store.create({
    name: 'Check', enabled: true, agent: 'default', template: 'blank', prompt: 'FAKE:note', level: 'report',
    cards: { board: 'work', statuses: ['in-progress', 'blocked'], subtasks: false },
    schedule: { repeat: 'daily', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10, ...more,
  }, cctx).then((r) => r.value);
  return { ...s, acc, make };
};

test('an automation without connectors never opens access', async (t) => {
  const s = cset(t, {}, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make());
  assert.equal(run.state, 'finished');
  assert.equal(s.acc.log.opened.length, 0);
  assert.ok(!('lookups' in run.cards[0]) && !('refusedCalls' in run.cards[0]) && !('notSignedIn' in run.cards[0]));
});

test('a card with connectors: access is opened, handed to setup, the command and the prompt, then revoked', async (t) => {
  const preps = [], cmds = [], prompts = [];
  const s = cset(t, {}, {
    cards: { '01-a': ['in-progress'] },
    prepareAgent: async (id, level, dir, opts) => { preps.push(opts); return {}; },
    agentCommand: (id, level, prompt, opts) => { cmds.push(opts); prompts.push(prompt); return A.agentCommand(id, level, prompt, opts); },
  });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian', 'vantage'], prompt: 'FAKE:note MARK:hello' }));
  assert.equal(run.state, 'finished');
  assert.deepEqual(s.acc.log.opened, [{ runId: run.id, cardPath: 'Work/1. a/01-a/task.md', ids: ['atlassian', 'vantage'] }]);
  assert.equal(preps[0].mcp.configFile, '/tmp/fake-mcp.json');
  assert.deepEqual(preps[0].mcp.ids, ['atlassian']);
  assert.equal(cmds[cmds.length - 1].mcp.configFile, '/tmp/fake-mcp.json');
  const real = prompts[prompts.length - 1];
  assert.match(real, /Connectors: you may look things up in Atlassian/);
  assert.match(real, /Vantage is not signed in/);
  assert.equal(s.acc.log.revoked, 1);
  assert.deepEqual(s.acc.log.order, ['usage', 'revoke']);
  const c = run.cards[0];
  assert.deepEqual(c.lookups, { atlassian: { getIssue: 2 } });
  assert.deepEqual(c.refusedCalls, { atlassian: { editIssue: 1 } });
  assert.deepEqual(c.notSignedIn, ['vantage']);
  const saved = JSON.stringify(run);
  assert.ok(!saved.includes('SECRETKEY') && !saved.includes('fake-mcp.json'));
});

test('a usage() that throws still records the connectors not signed in, and revokes', async (t) => {
  const s = cset(t, { usageFails: 'log unreadable' }, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian', 'vantage'] }));
  const c = run.cards[0];
  assert.equal(c.state, 'noted');
  assert.deepEqual(c.notSignedIn, ['vantage']);
  assert.ok(!('lookups' in c) && !('refusedCalls' in c));
  assert.deepEqual(s.acc.log.order, ['usage', 'revoke']);
});

test('a timed-out card still revokes its connector access', async (t) => {
  const s = cset(t, {}, { cards: { '01-a': ['in-progress'] }, timeLimitMs: 300 });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian'], prompt: 'FAKE:hang' }));
  assert.equal(run.cards[0].state, 'timed-out');
  assert.equal(s.acc.log.revoked, 1);
});

test('a card the setup skips revokes access and starts no agent', async (t) => {
  const spawned = [];
  const s = cset(t, {}, {
    cards: { '01-a': ['in-progress'] },
    prepareAgent: async () => ({ skip: 'nope' }),
    spawnAgent: (o) => { spawned.push(o); return A.spawnAgent(o); },
  });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian'] }));
  assert.equal(run.cards[0].state, 'skipped');
  assert.equal(spawned.length, 0);
  assert.equal(s.acc.log.revoked, 1);
});

test('access that cannot be set up fails that card only', async (t) => {
  let n = 0;
  const spawned = [];
  const acc = fakeAccess();
  const s = cset(t, {}, {
    cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] },
    connectorAccess: async (o) => { if (n++ === 0) throw new Error('disk full'); return acc.fn(o); },
    spawnAgent: (o) => { spawned.push(path.basename(o.cwd)); return A.spawnAgent(o); },
  });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian'] }));
  assert.deepEqual(run.cards.map((c) => c.state), ['failed', 'noted']);
  assert.equal(run.cards[0].reason, "couldn't set up connectors: disk full");
  assert.deepEqual(spawned, ['02-b']);
});

test('a default agent that cannot use connectors fails the run before any card', async (t) => {
  const s = cset(t, {}, {
    cards: { '01-a': ['in-progress'] },
    resolveAgent: () => ({ id: 'cursor', label: 'Cursor CLI' }),
    agentConnectors: () => false,
    agentCommand: () => ({ cmd: ['x'], input: '' }),
  });
  const run = await runAndWait(s, await s.make({ connectors: ['atlassian'] }));
  assert.equal(run.state, 'failed');
  assert.equal(run.cards[0].state, 'not-run');
  assert.equal(run.cards[0].reason, "Cursor CLI can't use connectors in automations yet");
  assert.equal(s.acc.log.opened.length, 0);
});

test('a trial uses connectors too and writes nothing', async (t) => {
  const s = cset(t, {}, { cards: { '01-a': ['in-progress'] } });
  const before = s.read('01-a');
  const run = await tryAndWait(s, await s.make({ connectors: ['atlassian'] }));
  assert.equal(run.cards[0].state, 'noted');
  assert.equal(s.acc.log.opened.length, 1);
  assert.equal(s.acc.log.revoked, 1);
  assert.deepEqual(run.cards[0].lookups, { atlassian: { getIssue: 2 } });
  assert.equal(s.read('01-a'), before);
});

// ---------- Calendar reminders (vaultos-remind) ----------
const { createCalendarService } = require('../lib/calendar-service');
const { PROFILES } = require('../lib/agents');
// A runner whose addReminder/cardReminders go to the real calendar service over the same temp vault, the way
// lib/automation-service.js wires them. flags.calendar switches Settings → Features → Calendar.
function calSetup(t, { cards, clockIso = '2026-11-25T19:00:00Z', calendar = true, promptOut = null } = {}) {
  const flags = { calendar };
  const clock = { now: Date.parse(clockIso) };
  let cal = null;
  const s = setup(t, {
    cards,
    cardReminders: (p) => cal.upcomingForCard(p),
    addReminder: ({ automation, card, remind, trial, taken }) => cal.addFromAutomation(remind, { card: card.path, cardTitle: card.title, automationName: automation.name, dryRun: trial, taken }),
    ...(promptOut ? { agentEnv: () => ({ ...process.env, FAKE_PROMPT_OUT: promptOut }) } : {}),
  });
  cal = createCalendarService({
    vaultDir: s.vault, settings: () => ({ features: { calendar: flags.calendar }, today: { timezone: TZ }, boards: [] }),
    boards: () => [], resolveWorkspace: () => ({ dir: s.vault }), scanAll: async () => [], safeVaultPath: async (rel) => path.join(s.vault, rel),
    now: () => clock.now, profiles: PROFILES,
  });
  const calFile = path.join(s.vault, '.vaultos', 'calendar.json');
  const entries = () => (fs.existsSync(calFile) ? JSON.parse(fs.readFileSync(calFile, 'utf8')).entries : []);
  return { ...s, cal, flags, clock, entries, calFile };
}
const three = { '01-a': ['in-progress'], '02-b': ['in-progress'], '03-c': ['blocked'] };

test('reminders on: each card\'s reminder is added, staggered, and recorded in the run', async (t) => {
  const s = calSetup(t, { cards: three });
  const run = await runAndWait(s, await s.make({ reminders: true, prompt: 'FAKE:remind:2026-11-26' }));
  assert.deepEqual(run.cards.map((c) => [c.state, c.reminder && c.reminder.start, c.reminderSkipped]), [
    ['noted', '09:00', ''], ['noted', '09:15', ''], ['noted', '09:30', ''],
  ]);
  assert.deepEqual(run.cards[0].reminder, { id: s.entries()[0].id, date: '2026-11-26', start: '09:00', end: null, title: '01-a', ping: 'start' });
  assert.deepEqual(s.entries().map((e) => [e.card, e.start, e.note, e.created.by.agent]), [
    ['Work/1. a/01-a/task.md', '09:00', 'Fake reminder.', 'Automation: Check'],
    ['Work/1. a/02-b/task.md', '09:15', 'Fake reminder.', 'Automation: Check'],
    ['Work/1. a/03-c/task.md', '09:30', 'Fake reminder.', 'Automation: Check'],
  ]);
});

test('a re-run the same day adds no duplicates', async (t) => {
  const s = calSetup(t, { cards: three });
  const a = await s.make({ reminders: true, prompt: 'FAKE:remind:2026-11-26' });
  await runAndWait(s, a);
  const again = await runAndWait(s, a);
  assert.deepEqual(again.cards.map((c) => [c.state, c.reminder, c.reminderSkipped]), Array(3).fill(['noted', null, 'already has a reminder on that date']));
  assert.equal(s.entries().length, 3);
});

test('a trial writes nothing to the calendar but previews staggered times', async (t) => {
  const s = calSetup(t, { cards: three });
  const run = await tryAndWait(s, await s.make({ reminders: true, prompt: 'FAKE:remind:2026-11-26' }));
  assert.deepEqual(run.cards.map((c) => c.reminder && [c.reminder.id, c.reminder.start]), [[null, '09:00'], [null, '09:15'], [null, '09:30']]);
  assert.equal(fs.existsSync(s.calFile), false);
});

test('reminders off: a vaultos-remind block is ignored and nothing is added', async (t) => {
  const s = calSetup(t, { cards: { '01-a': ['in-progress'] } });
  const run = await runAndWait(s, await s.make({ prompt: 'FAKE:remind:2026-11-26' }));
  assert.equal(run.cards[0].state, 'noted');
  assert.equal(run.cards[0].reminder, null);
  assert.deepEqual(run.cards[0].ignored, ['vaultos-remind block (reminders are off for this automation)']);
  assert.equal(fs.existsSync(s.calFile), false);
});

test('Calendar off: the reminder is skipped with the reason and the card is still noted', async (t) => {
  const s = calSetup(t, { cards: { '01-a': ['in-progress'] }, calendar: false });
  const run = await runAndWait(s, await s.make({ reminders: true, prompt: 'FAKE:remind:2026-11-26' }));
  assert.deepEqual([run.cards[0].state, run.cards[0].reminder, run.cards[0].reminderSkipped], ['noted', null, 'Calendar is switched off']);
  assert.match(s.read('01-a'), /## Latest check-in/);
});

test('a bad or past date never fails the card', async (t) => {
  const s = calSetup(t, { cards: { '01-a': ['in-progress'], '02-b': ['in-progress'] } });
  const bad = await runAndWait(s, await s.make({ reminders: true, prompt: 'FAKE:remind:soon', cards: { board: 'work', statuses: ['in-progress'], subtasks: false } }));
  assert.deepEqual(bad.cards.map((c) => [c.state, c.reminder, c.reminderSkipped, c.ignored]), Array(2).fill(['noted', null, '', ['vaultos-remind date: soon']]));
  const past = await runAndWait(s, await s.make({ name: 'Past', reminders: true, prompt: 'FAKE:remind:2026-11-01' }));
  assert.deepEqual(past.cards.map((c) => [c.state, c.reminderSkipped]), Array(2).fill(['noted', 'that date has passed']));
});

test('a reminder that throws is recorded as skipped; the note is still written', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, addReminder: async () => { throw new Error('disk full'); } });
  const run = await runAndWait(s, await s.make({ reminders: true, prompt: 'FAKE:remind:2026-11-26' }));
  assert.deepEqual([run.cards[0].state, run.cards[0].reminderSkipped], ['noted', "VaultOS couldn't add it: disk full"]);
  assert.match(s.read('01-a'), /Fake note\./);
});

test('the prompt lists the card\'s upcoming reminders only when reminders are on', async (t) => {
  const promptOut = path.join(os.tmpdir(), `auto-remind-prompt-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(promptOut, { force: true }));
  const s = calSetup(t, { cards: { '01-a': ['in-progress'] }, promptOut });
  await s.cal.view.store.create({ title: 'Chase supplier', date: '2026-11-27', start: '10:00', card: 'Work/1. a/01-a/task.md', ping: null }, { kind: 'person' });
  await runAndWait(s, await s.make({ reminders: true }));
  await runAndWait(s, await s.make({ name: 'No reminders' }));
  const [on, off] = fs.readFileSync(promptOut, 'utf8').split('\n=====\n');
  assert.ok(on.includes('Existing upcoming calendar reminders for this card:\n- 2026-11-27 10:00 — Chase supplier\n'), on);
  assert.ok(on.includes('```vaultos-remind'));
  assert.ok(!off.includes('calendar reminders'));
  assert.ok(!off.includes('vaultos-remind'));
});

test('a card whose reminders cannot be read still runs, with none listed', async (t) => {
  const s = setup(t, { cards: { '01-a': ['in-progress'] }, cardReminders: async () => { throw new Error('nope'); } });
  const run = await runAndWait(s, await s.make({ reminders: true }));
  assert.equal(run.cards[0].state, 'noted');
});

// ---------- New cards (spec 2026-11-25 §7–§8) ----------
const ONCE = { runsOn: 'once', level: 'work', newCards: { board: 'work', folder: 'tickets', max: 5 } };
const ticket = (s, name) => fs.readFileSync(path.join(s.vault, 'Work', 'tickets', name, 'task.md'), 'utf8');

test('once: one agent in the destination, cards created, note in the run', async (t) => {
  const s = setup(t, { cards: { 'job-1': ['in-progress'] }, withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:card:TCK-1:Reset_MFA FAKE:card:-:Second_one' });
  assert.equal(a.runsOn, 'once');
  const run = await runAndWait(s, a);
  assert.equal(run.state, 'finished');
  assert.equal(run.runsOn, 'once');
  assert.equal(run.cards.length, 1);
  const c = run.cards[0];
  assert.equal(c.kind, 'once');
  assert.equal(c.state, 'noted');
  assert.equal(c.path, 'Work/tickets');
  assert.equal(c.title, 'Work / tickets');
  assert.match(c.note, /Fake note\./);
  assert.equal(run.createdCount, 2);
  assert.deepEqual(c.created.map((x) => x.path), ['Work/tickets/TCK-1/task.md', 'Work/tickets/second-one/task.md']);
  assert.deepEqual(c.created.map((x) => x.board), ['work', 'work']);   // the run detail opens each on its own board
  assert.equal(parseFrontmatter(ticket(s, 'TCK-1')).meta.title, 'Reset MFA');
  assert.match(ticket(s, 'TCK-1'), /Created by automation "Check" \(Claude Code\)\./);
  assert.match(s.read('job-1'), /status: in-progress/);
  assert.doesNotMatch(s.read('job-1'), /Latest check-in/);
});

test('once: the agent runs in the destination folder, read-only', async (t) => {
  const cmds = [];
  const s = setup(t, { withNewCards: true, agentCommand: (id, level, prompt, opts) => { cmds.push({ level, opts }); return A.agentCommand(id, level, prompt, opts); } });
  const run = await runAndWait(s, await s.make({ ...ONCE, prompt: 'FAKE:touch' }));
  assert.deepEqual(run.cards[0].filesChanged, ['touched.txt']);
  assert.ok(fs.existsSync(path.join(s.vault, 'Work', 'tickets', 'touched.txt')));
  assert.ok(cmds.length >= 2 && cmds.every((x) => x.level === 'work' && x.opts && x.opts.once === true));
});

test('once: second run creates nothing (duplicates)', async (t) => {
  const s = setup(t, { withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:card:TCK-1:Reset_MFA FAKE:card:-:Second_one' });
  await runAndWait(s, a);
  const run = await runAndWait(s, a);
  assert.equal(run.createdCount, 0);
  assert.equal(run.state, 'finished');
  assert.deepEqual(run.cards[0].notCreated.map((x) => x.reason), ['TCK-1 already has a card', 'a card with that title already exists']);
});

test('once: cards without a note still count; nothing back fails', async (t) => {
  const s = setup(t, { withNewCards: true });
  const r1 = await runAndWait(s, await s.make({ ...ONCE, prompt: 'FAKE:cardsonly FAKE:card:X-1:Only' }));
  assert.equal(r1.cards[0].state, 'noted');
  assert.equal(r1.cards[0].note, '');
  assert.equal(r1.createdCount, 1);
  const r2 = await runAndWait(s, await s.make({ ...ONCE, name: 'Other', prompt: 'FAKE:none' }));
  assert.equal(r2.state, 'failed');
  assert.equal(r2.cards[0].state, 'failed');
  assert.equal(r2.cards[0].reason, 'nothing back from the agent');
  assert.equal(r2.createdCount, 0);
});

test('once: destination gone → run fails with the folder reason (Review Focus 1)', async (t) => {
  const s = setup(t, { withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:card:TCK-1:Reset_MFA' });
  fs.rmSync(path.join(s.vault, 'Work', 'tickets'), { recursive: true });
  const run = await runAndWait(s, a);
  assert.equal(run.state, 'failed');
  assert.equal(run.cards[0].state, 'failed');
  assert.equal(run.cards[0].reason, "New cards folder: That folder doesn't exist");
});

test('once trial: would create, nothing on disk', async (t) => {
  const s = setup(t, { withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:card:TCK-1:Reset_MFA' });
  assert.deepEqual(await s.runner.tryNow(a.id), { queued: true });
  await s.runner.idle();
  const run = await s.lastRun();
  assert.equal(run.trigger, 'trial');
  assert.equal(run.createdCount, 1);
  assert.equal(run.cards[0].created[0].path, 'Work/tickets/TCK-1/task.md');
  assert.equal(fs.existsSync(path.join(s.vault, 'Work', 'tickets', 'TCK-1')), false);
});

test('once: prompt lists existing cards and keys', async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-')), 'p.txt');
  process.env.FAKE_PROMPT_OUT = out;
  t.after(() => { delete process.env.FAKE_PROMPT_OUT; });
  const s = setup(t, { withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:card:TCK-1:Reset_MFA' });
  await runAndWait(s, a);
  await runAndWait(s, a);
  const second = fs.readFileSync(out, 'utf8').split('\n=====\n')[1];
  assert.match(second, /There is no card in this run\./);
  assert.match(second, /^- TCK-1 · Reset MFA · backlog$/m);
  assert.match(second, /Keys already on the board \(case doesn't matter\): tck-1\./);
});

test('once: connectors are opened for the destination and revoked', async (t) => {
  const acc = fakeAccess();
  const s = setup(t, { withNewCards: true, agentConnectors: () => true, connectorAccess: acc.fn });
  const a = (await s.store.create({ name: 'Q', enabled: true, agent: 'default', template: 'blank', prompt: 'FAKE:card:A-1:One', ...ONCE,
    connectors: ['atlassian'], schedule: { repeat: 'daily', time: '08:00' }, timeLimitMin: 10 }, cctx)).value;
  const run = await runAndWait(s, a);
  assert.equal(run.cards[0].state, 'noted');
  assert.deepEqual(acc.log.opened, [{ runId: run.id, cardPath: 'Work/tickets', ids: ['atlassian'] }]);
  assert.equal(acc.log.revoked, 1);
  assert.deepEqual(run.cards[0].lookups, { atlassian: { getIssue: 2 } });
});

test('per-card Work with newCards: follow-ups created after the note, from-line, cap across cards', async (t) => {
  const s = setup(t, { withNewCards: true, cards: {
    'job-1': ['in-progress', 'x: FAKE:card:A-1:One FAKE:card:A-2:Two\n'],
    'job-2': ['in-progress', 'x: FAKE:card:B-1:Three FAKE:card:B-2:Four\n'],
  } });
  const run = await runAndWait(s, await s.make({ level: 'work', newCards: { board: 'work', folder: 'tickets', max: 3 } }));
  assert.equal(run.state, 'finished');
  assert.deepEqual(run.cards.map((c) => c.state), ['noted', 'noted']);
  assert.equal(run.createdCount, 3);
  assert.deepEqual(run.cards[0].created.map((c) => c.key), ['A-1', 'A-2']);
  assert.deepEqual(run.cards[1].created.map((c) => c.key), ['B-1']);
  assert.deepEqual(run.cards[1].notCreated, [{ title: 'Four', key: 'B-2', reason: 'not created (over the limit of 3)' }]);
  assert.match(ticket(s, 'A-1'), /from \[\[job-1\]\]/);
  assert.match(s.read('job-1'), /## Latest check-in/);
});

test('per-card: Work without newCards and Report list the block under Ignored', async (t) => {
  const s = setup(t, { withNewCards: true, cards: { 'job-1': ['in-progress', 'x: FAKE:card:A-1:One\n'] } });
  const w = await runAndWait(s, await s.make({ level: 'work' }));
  assert.ok(w.cards[0].ignored.includes('vaultos-card block (no folder set for new cards)'));
  assert.equal(w.createdCount, undefined);
  const r = await runAndWait(s, await s.make({ name: 'R', level: 'report' }));
  assert.ok(r.cards[0].ignored.includes('vaultos-card block (not a Work automation)'));
  assert.equal(fs.readdirSync(path.join(s.vault, 'Work', 'tickets')).length, 0);
});

test('per-card Work: destination gone → cards Ignored with the folder reason, card still noted (Review Focus 1)', async (t) => {
  const s = setup(t, { withNewCards: true, cards: { 'job-1': ['in-progress', 'x: FAKE:card:A-1:One\n'] } });
  const a = await s.make({ level: 'work', newCards: { board: 'work', folder: 'tickets', max: 3 } });
  fs.rmSync(path.join(s.vault, 'Work', 'tickets'), { recursive: true });
  const run = await runAndWait(s, a);
  assert.equal(run.cards[0].state, 'noted');
  assert.ok(run.cards[0].ignored.includes("vaultos-card block (new cards folder: That folder doesn't exist)"));
});

test('per-card Work trial: would create, nothing written', async (t) => {
  const s = setup(t, { withNewCards: true, cards: { 'job-1': ['in-progress', 'x: FAKE:card:A-1:One\n'] } });
  const a = await s.make({ level: 'work', newCards: { board: 'work', folder: 'tickets', max: 3 } });
  await s.runner.tryNow(a.id);
  await s.runner.idle();
  const run = await s.lastRun();
  assert.equal(run.createdCount, 1);
  assert.equal(run.cards[0].created[0].key, 'A-1');
  assert.equal(fs.readdirSync(path.join(s.vault, 'Work', 'tickets')).length, 0);
});

test('review 12: a Once run that times out fails the run and creates nothing', async (t) => {
  const s = setup(t, { withNewCards: true, timeLimitMs: 300 });
  const run = await runAndWait(s, await s.make({ ...ONCE, prompt: 'FAKE:hang FAKE:card:A-1:One' }));
  assert.equal(run.state, 'failed');
  assert.equal(run.cards[0].state, 'timed-out');
  assert.equal(run.createdCount, 0);
  assert.deepEqual(fs.readdirSync(path.join(s.vault, 'Work', 'tickets')), []);
});

test('review 12: stopping a Once run ends it stopped and creates nothing', async (t) => {
  const s = setup(t, { withNewCards: true });
  const a = await s.make({ ...ONCE, prompt: 'FAKE:hang FAKE:card:A-1:One' });
  await s.runner.runNow(a.id);
  await waitFor(() => s.runner.status().current && s.runner.status().current.index === 0);
  await sleep(200);
  assert.equal(s.runner.stop(), true);
  await s.runner.idle();
  const run = await s.lastRun();
  assert.equal(run.state, 'stopped');
  assert.deepEqual([run.cards[0].state, run.cards[0].reason], ['failed', 'stopped']);
  assert.deepEqual(fs.readdirSync(path.join(s.vault, 'Work', 'tickets')), []);
});

// ---------- Let the agent choose the folder ----------
test('choose: a Once run files each card into the folder the agent names, and may add a folder', async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-')), 'p.txt');
  process.env.FAKE_PROMPT_OUT = out;
  t.after(() => { delete process.env.FAKE_PROMPT_OUT; });
  const s = setup(t, { withNewCards: true });
  fs.mkdirSync(path.join(s.vault, 'Work', '3. iam'));
  const run = await runAndWait(s, await s.make({ ...ONCE, newCards: { board: 'work', folder: '', max: 10, choose: true },
    prompt: 'FAKE:card:TCK-1:Reset_MFA:3._iam FAKE:card:TCK-2:Firewall:10._security FAKE:card:TCK-3:Loose' }));
  assert.equal(run.state, 'finished');
  assert.equal(run.cards[0].title, 'Work');
  assert.deepEqual(run.cards[0].created.map((c) => [c.path, c.folder, !!c.newFolder]), [
    ['Work/3. iam/TCK-1/task.md', '3. iam', false], ['Work/10. security/TCK-2/task.md', '10. security', true], ['Work/TCK-3/task.md', '', false]]);
  const prompt = fs.readFileSync(out, 'utf8');
  assert.match(prompt, /New cards go into the Work board\. Pick a folder/);
  assert.match(prompt, /^- 3\. iam$/m);
  assert.match(prompt, /^folder: /m);
});
