'use strict';
// The automations runner (spec §4): a 30-second tick that queues due automations, a queue that runs
// one agent at a time, and the per-card loop that starts the agent, reads its note and has VaultOS
// write the card. Everything it touches outside its own state comes in through deps, so tests drive
// it with a temp vault and a stand-in agent.
const { parseFrontmatter } = require('./task-file');
const { buildPrompt, parseOutput, stampText } = require('./automation-note');
const { applyResult, doneOnBoard } = require('./automation-card');
const { snapshotDir, diffSnapshots } = require('./automation-agents');
const { lastSlot, MAX_CARDS, CARD_STATUSES, STATUS_LABEL } = require('../public/automation-core');

const TAIL_MAX = 4096;
const CATCH_UP_MS = 60000;   // a slot this far in the past when queued counts as a catch-up

// The cards a run takes, in the order it takes them: matching statuses (never done), subtasks only when
// asked, in board column order and then by path. The builder's live count uses the same rule.
function selectCards(automation, cards) {
  const { statuses, subtasks } = automation.cards;
  return cards
    .filter((c) => statuses.includes(c.status) && c.status !== 'done' && (subtasks || !c.batch))
    .sort((x, y) => (CARD_STATUSES.indexOf(x.status) - CARD_STATUSES.indexOf(y.status)) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function createRunner(deps) {
  const {
    store, now = Date.now, tz, today, listCards, isBusy, resolveAgent, agentCommand, spawnAgent, agentEnv,
    prepareAgent = async () => ({}),
    readCard, writeCard, onChange = () => {}, timeLimitMs = null, tickMs = 30000,
    setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
  } = deps;
  const queue = [];        // [{ id, trigger }]
  let current = null;      // { run, automation, agent, handle, index, total, stopped }
  let timer = null;
  let draining = null;     // the drain loop's promise while it runs
  let off = false;         // shutdown() was called and start() hasn't been since: nothing new may start
  const iso = (ms = now()) => new Date(ms).toISOString();
  const changed = () => { try { onChange(); } catch { /* a listener must not stop a run */ } };
  const busyWith = (id) => (current && current.run.automationId === id) || queue.some((j) => j.id === id);

  // ---------- Schedule ----------
  async function tick() {
    if (off) return;
    let list;
    try { list = await store.list(); } catch (err) { console.error('automations:', err.message); return; }
    for (const a of list) {
      if (off) return;   // switched off while this tick was reading
      if (!a.enabled || busyWith(a.id)) continue;
      const slot = lastSlot(a.schedule, tz(), now());
      if (slot === null) continue;
      const st = await store.getState(a.id);
      if (off) return;
      if (st.lastSlot !== null && slot <= st.lastSlot) continue;
      await store.setState(a.id, { lastSlot: slot });
      if (st.lastSlot === null) continue;   // no record of an earlier slot (a hand-made definition): start counting from now
      enqueue(a.id, now() - slot > CATCH_UP_MS ? 'catch-up' : 'schedule');
    }
  }
  function start() {
    off = false;
    if (timer) return;
    timer = setIv(() => { tick().catch((err) => console.error('automations tick failed:', err.message)); }, tickMs);
    if (timer && timer.unref) timer.unref();
    tick().catch((err) => console.error('automations tick failed:', err.message));
  }
  function shutdown() {
    off = true;
    if (timer) clearIv(timer);
    timer = null;
    queue.length = 0;
    stop();
  }

  // ---------- Queue ----------
  function enqueue(id, trigger) {
    if (off) return;
    queue.push({ id, trigger });
    changed();
    if (!draining) {
      draining = (async () => {
        try {
          while (queue.length) {
            const job = queue.shift();
            try { await runJob(job); } catch (err) { console.error('automations: a run failed:', err && err.message); }
          }
        } finally {
          draining = null;
          changed();
        }
      })();
    }
  }
  async function runNow(id) {
    if (off) return { error: 'Automations are off' };
    const a = await store.get(id);
    if (!a) return { error: 'No such automation' };
    if (current && current.run.automationId === id) return { error: 'It is running now' };
    if (queue.some((j) => j.id === id)) return { error: 'It is already queued' };
    enqueue(id, 'manual');
    return { queued: true };
  }
  function stop() {
    if (!current) return false;
    current.stopped = true;
    if (current.handle) current.handle.kill();
    changed();
    return true;
  }
  function remove(id) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
    if (current && current.run.automationId === id) stop();
    changed();
  }
  async function idle() {
    while (draining) await draining;
  }
  function status() {
    const cur = current && current.index >= 0 && current.run.cards[current.index];
    return {
      current: current ? {
        runId: current.run.id, automationId: current.run.automationId, automationName: current.run.automationName,
        index: current.index, total: current.total, card: cur ? { path: cur.path, title: cur.title } : null,
      } : null,
      queue: queue.map((j) => j.id),
    };
  }

  // ---------- A run ----------
  const blankResult = (c, state, reason = '') => ({
    path: c.path, board: c.board, title: c.title, state, reason, note: '', statusChange: null, proposalIgnored: '',
    filesChanged: [], ignored: [], startedAt: '', durationMs: 0, outputTail: '', doneReverted: false, statusBefore: c.status,
  });

  async function runJob({ id, trigger }) {
    // Visible as the current run from here on, before the first await, so a run is never neither
    // queued nor current while it gets going.
    current = { run: { id: null, automationId: id, automationName: '', cards: [] }, automation: null, agent: null, handle: null, index: -1, total: 0, stopped: false };
    try {
      await runJobBody(id, trigger);
    } finally {
      current = null;   // whatever happened, the next run can start
      changed();
    }
  }
  async function runJobBody(id, trigger) {
    const automation = await store.get(id);
    if (!automation || current.stopped) { current = null; return; }
    const agent = resolveAgent(automation.agent);
    const run = {
      id: store.newRunId(), automationId: id, automationName: automation.name, agent: agent ? agent.id : automation.agent,
      level: automation.level, trigger, startedAt: iso(), endedAt: null, state: 'running', cards: [],
    };
    let selected = [];
    try { selected = selectCards(automation, await listCards(automation)); } catch (err) {
      console.error('automations: listing cards failed:', err.message);
    }
    run.cards = selected.map((c, i) => (i < MAX_CARDS ? blankResult(c, 'waiting') : blankResult(c, 'not-run', `over the ${MAX_CARDS}-card limit`)));
    Object.assign(current, { run, automation, agent, total: Math.min(selected.length, MAX_CARDS) });
    const save = () => store.saveRun(run).catch((err) => console.error('automations: saving the run failed:', err.message));

    const problem = !agent ? 'No agent is set up for automations (Settings → Agent)' : agentCommand(agent.id, automation.level, '').error;
    let failed = false;
    if (problem) {
      failed = true;
      const first = run.cards.find((c) => c.state === 'waiting');
      if (first) first.reason = problem;
    } else {
      await save();
      changed();
      let agentRuns = 0;
      let failsInRow = 0;
      let anyNoted = false;
      for (let i = 0; i < current.total; i++) {
        if (current.stopped) break;
        current.index = i;
        const c = run.cards[i];
        c.state = 'running';
        c.startedAt = iso();
        await save();
        changed();
        let ranAgent = false;
        try {
          ranAgent = await runCard(selected[i], c);
        } catch (err) {   // a read, write or board update that failed: this card only
          console.error('automations: a card failed:', err && err.message);
          c.state = 'failed';
          c.reason = `VaultOS couldn't finish this card: ${err && err.message}`;
          ranAgent = c.durationMs > 0;   // set once the agent has exited: it ran, then the write failed
        }
        await save();
        changed();
        if (ranAgent) agentRuns++;
        if (current.stopped) break;
        if (c.state === 'noted') { anyNoted = true; failsInRow = 0; continue; }
        if (c.state !== 'failed' && c.state !== 'timed-out') continue;
        failsInRow++;
        if ((agentRuns === 1 && c.state === 'failed' && !anyNoted) || failsInRow >= 2) { failed = true; break; }
      }
    }
    for (const c of run.cards) if (c.state === 'waiting' || c.state === 'running') c.state = 'not-run';
    run.state = current.stopped ? 'stopped' : failed ? 'failed' : 'finished';
    run.endedAt = iso();
    await save();
    await store.setState(id, { lastRunId: run.id }).catch(() => {});
  }

  // One card. Returns whether an agent was started.
  async function runCard(card, c) {
    const { automation, agent } = current;
    const raw = await readCard(card.full);
    if (raw === null) { c.state = 'moved'; c.reason = 'the card was moved'; return false; }
    const meta = parseFrontmatter(raw).meta;
    const status = meta.status || 'backlog';
    if (status === 'done') { c.state = 'moved'; c.reason = 'the card was finished'; return false; }
    if (!automation.cards.statuses.includes(status)) { c.state = 'skipped'; c.reason = `its status is now ${STATUS_LABEL[status] || status}`; return false; }
    if (isBusy(card.path)) { c.state = 'skipped'; c.reason = 'an agent is working on it in a terminal'; return false; }
    const prep = await prepareAgent(agent.id, automation.level, card.dir);   // e.g. Cursor's per-card rules
    if (prep && prep.skip) { c.state = 'skipped'; c.reason = prep.skip; return false; }
    c.statusBefore = status;

    if (current.stopped) { c.state = 'failed'; c.reason = 'stopped'; return false; }
    const before = await snapshotDir(card.dir);
    if (current.stopped) { c.state = 'failed'; c.reason = 'stopped'; return false; }   // no agent once Stop is pressed
    const prompt = buildPrompt({ automation, card: { title: meta.title || card.title, status, updated: meta.updated }, taskRaw: raw, today: today(), tz: tz() });
    const { cmd, input } = agentCommand(agent.id, automation.level, prompt);
    const t0 = Date.now();
    current.handle = spawnAgent({ cmd, input, cwd: card.dir, env: agentEnv(), timeoutMs: timeLimitMs || automation.timeLimitMin * 60000 });
    const res = await current.handle.done;
    current.handle = null;
    c.durationMs = Date.now() - t0;
    c.filesChanged = diffSnapshots(before, await snapshotDir(card.dir));
    const tail = res.output.slice(-TAIL_MAX);

    if (res.killed || current.stopped) { c.state = 'failed'; c.reason = 'stopped'; c.outputTail = tail; return true; }
    if (res.timedOut) { c.state = 'timed-out'; c.reason = `over the ${automation.timeLimitMin}-minute limit`; c.outputTail = tail; return true; }
    const parsed = parseOutput(res.output, automation.level);
    c.ignored = parsed.ignored;
    if (!parsed.note) {
      c.state = 'failed';
      c.reason = res.code ? `the agent exited with code ${res.code}` : 'no note in the output';
      c.outputTail = tail;
      return true;
    }
    c.note = parsed.note;
    const fresh = await readCard(card.full);   // anything changed meanwhile (in the app, Obsidian or a terminal) stays
    if (fresh === null) { c.state = 'moved'; c.reason = 'the card was moved while the agent ran'; return true; }
    // Finished while the agent ran: by the person (any Report/Update run, or a board move on a Work run)
    // means nothing is written. Only a Work agent's own Done gets put back, by applyResult.
    const freshStatus = parseFrontmatter(fresh).meta.status || 'backlog';
    if (freshStatus === 'done' && status !== 'done' && (automation.level !== 'work' || doneOnBoard(fresh, today()))) {
      c.state = 'moved';
      c.reason = 'the card was finished while the agent ran';
      return true;
    }
    const r = applyResult(fresh, {
      automation, agentLabel: agent.label, stamp: stampText(now(), tz()), note: parsed.note,
      update: parsed.update, statusAtStart: status, today: today(),
    });
    await writeCard(card, r.raw);
    c.state = 'noted';
    c.statusChange = r.statusChange;
    c.proposalIgnored = r.proposalIgnored;
    c.doneReverted = r.doneReverted;
    return true;
  }

  return { start, shutdown, tick, runNow, stop, remove, status, idle };
}

module.exports = { createRunner, selectCards };
