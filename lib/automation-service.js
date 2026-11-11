'use strict';
// Automations glued to the server (spec §3.4, §7): the store and runner over the server's boards,
// terminals and settings, and the /api/automations routes. server.js hands in what it owns as deps
// and mounts `router` behind its sign-in gate. Automations are live only when TERMINAL is allowed on
// the machine and Settings → Features → Automations is on; GETs work either way, writes need live.
const express = require('express');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const { createAutomationStore } = require('./automation-store');
const { createRunner, selectCards } = require('./automation-runner');
const { AGENT_LABEL, offeredLevels, agentCommand, prepareAgent, automationEnv, spawnAgent } = require('./automation-agents');
const { createAgentApi, TRIALS_PER_HOUR, MAX_AGENT_DRAFTS } = require('./automation-agent-api');
const {
  describeSchedule, nextSlot, CARD_STATUSES, STATUS_LABEL, LEVELS, LEVEL_LABEL, LEVEL_TEXT, TEMPLATES,
  MAX_CARDS, TRIAL_CARDS, PROMPT_MAX, NAME_MAX, HOURS_EVERY,
} = require('../public/automation-core');

const PICKER_AGENTS = ['claude', 'cursor', 'pi'];
const INSTALLED_TTL_MS = 60000;
const PRUNE_EVERY_MS = 24 * 3600 * 1000;

function createAutomationService(deps) {
  const {
    vaultDir, settings, terminalEnv, boards, resolveWorkspace, scanAll, regenerateBoard, terms,
    profileFor, profiles, isInstalled, renderMarkdown, todayISO, termCmd = () => '',
  } = deps;
  const live = () => !!(terminalEnv && settings() && settings().features.automations);
  const tz = () => (settings() ? settings().today.timezone : 'UTC');
  const store = createAutomationStore(vaultDir);

  async function listCards(automation) {
    const chosen = boards().filter((b) => automation.cards.board === 'all' || b.key === automation.cards.board);
    const out = [];
    for (const b of chosen) {
      const ws = resolveWorkspace(b.key);
      for (const t of await scanAll(ws.dir)) {
        const full = path.join(vaultDir, t.path);
        out.push({ path: t.path, board: b.key, title: t.title, status: t.status, updated: t.updated, batch: t.batch, full, dir: path.dirname(full) });
      }
    }
    return out;
  }
  function isBusy(taskPath) {
    for (const t of terms().values()) if (t.task === taskPath && t.agent) return true;
    return false;
  }
  function resolveAgent(setting) {
    const id = setting === 'default' ? (profileFor(settings()) || {}).id : setting;
    if (!id || !offeredLevels(id).length) return null;
    return { id, label: AGENT_LABEL[id] || id };
  }
  const runner = createRunner({
    store, tz, today: todayISO, listCards, isBusy, resolveAgent, agentCommand, spawnAgent, prepareAgent,
    agentEnv: () => automationEnv(process.env, tz()),
    readCard: async (full) => { try { return await fsp.readFile(full, 'utf8'); } catch { return null; } },
    writeCard: async (card, raw) => {
      await atomicWrite(card.full, raw);
      await regenerateBoard(null, resolveWorkspace(card.board).dir);
    },
  });

  let pruneTimer = null;
  async function sync() {
    if (live()) {
      runner.start();
      if (!pruneTimer) {
        pruneTimer = setInterval(() => { store.prune().catch((err) => console.error('automations prune failed:', err.message)); }, PRUNE_EVERY_MS);
        pruneTimer.unref();
      }
    } else {
      runner.shutdown();
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }
  // Once at startup, whether or not automations are on: close runs a restart cut off, drop old ones.
  async function boot() {
    try {
      const n = await store.recoverRunning();
      if (n) console.log(`automations: ${n} interrupted run${n === 1 ? '' : 's'} recorded`);
      await store.prune();
    } catch (err) {
      console.error('automations boot failed:', err.message);
    }
    await sync();
  }

  // What validateAutomation checks a save against, agent and level together included (spec §5.5).
  const ctx = () => {
    const defaultAgent = (profileFor(settings()) || {}).id || null;
    const agentLevels = { default: defaultAgent ? offeredLevels(defaultAgent) : [] };
    const agentLabels = {};
    for (const id of new Set([...PICKER_AGENTS, ...(defaultAgent ? [defaultAgent] : [])])) {
      agentLevels[id] = offeredLevels(id);
      agentLabels[id] = AGENT_LABEL[id] || (profiles[id] && profiles[id].label) || id;
    }
    return {
      boardKeys: boards().map((b) => b.key),
      agentIds: ['default', ...PICKER_AGENTS.filter((id) => offeredLevels(id).length)],
      tz: tz(), agentLevels, agentLabels, defaultAgent,
    };
  };
  let installed = { at: 0, map: {} };
  async function agentsInfo() {
    if (Date.now() - installed.at > INSTALLED_TTL_MS) {
      const map = {};
      for (const id of PICKER_AGENTS) map[id] = profiles[id] ? await isInstalled(profiles[id]).catch(() => false) : false;
      installed = { at: Date.now(), map };
    }
    return PICKER_AGENTS.map((id) => ({ id, label: AGENT_LABEL[id], installed: installed.map[id], levels: offeredLevels(id) }));
  }

  // ---------- Routes ----------
  const router = express.Router();
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      console.error('automations route failed:', err && err.message);
      // Only our own file errors ("automations.json: …") are worth showing; they name no paths.
      const mine = err && /^automations\.json:/.test(err.message);
      res.status(500).json({ error: mine ? err.message : 'Something went wrong with automations' });
    }
  };
  const needLive = (req, res, next) => (live() ? next() : res.status(403).json({ error: 'Automations are off' }));

  router.get('/automations', route(async (req, res) => {
    const st = runner.status();
    const automations = await Promise.all((await store.list()).map(async (a) => {
      const next = a.enabled ? nextSlot(a.schedule, tz(), Date.now()) : null;
      const [lastRun] = await store.listRuns({ automation: a.id, limit: 1 });
      return {
        ...a, scheduleText: describeSchedule(a.schedule), nextRun: next === null ? null : new Date(next).toISOString(),
        lastRun: lastRun || null, queued: st.queue.includes(a.id), running: !!(st.current && st.current.automationId === a.id),
      };
    }));
    res.json({
      live: live(), timezone: tz(), automations, current: st.current, queue: st.queue,
      defaultAgent: (profileFor(settings()) || {}).id || null, agents: await agentsInfo(),
    });
  }));
  router.post('/automations', needLive, route(async (req, res) => {
    const r = await store.create(req.body || {}, ctx());
    if (!r.ok) return res.status(400).json({ error: 'Check the highlighted fields', errors: r.errors });
    res.json({ automation: r.value });
  }));
  router.post('/automations/stop', needLive, route(async (req, res) => res.json({ stopped: runner.stop() })));
  router.put('/automations/:id', needLive, route(async (req, res) => {
    const r = await store.update(req.params.id, req.body || {}, ctx());
    if (!r) return res.status(404).json({ error: 'No such automation' });
    if (!r.ok) return res.status(400).json({ error: 'Check the highlighted fields', errors: r.errors });
    res.json({ automation: r.value });
  }));
  router.delete('/automations/:id', needLive, route(async (req, res) => {
    runner.remove(req.params.id);
    if (!(await store.remove(req.params.id))) return res.status(404).json({ error: 'No such automation' });
    res.json({ ok: true });
  }));
  router.post('/automations/:id/run', needLive, route(async (req, res) => {
    const r = await runner.runNow(req.params.id);
    if (r.error) return res.status(409).json({ error: r.error });
    res.json(r);
  }));
  router.get('/automations/runs', route(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const automation = typeof req.query.automation === 'string' && req.query.automation ? req.query.automation : undefined;
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    res.json({ runs: await store.listRuns({ automation, before, limit }) });
  }));
  router.get('/automations/runs/:id', route(async (req, res) => {
    const run = await store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'No such run' });
    for (const c of run.cards || []) if (c.note) c.noteHtml = renderMarkdown(c.note);
    res.json(run);
  }));
  router.get('/automations/match', route(async (req, res) => {
    const statuses = String(req.query.statuses || '').split(',').filter((s) => CARD_STATUSES.includes(s));
    const board = String(req.query.board || 'all');
    const auto = { cards: { board, statuses, subtasks: req.query.subtasks === '1' } };
    const picked = selectCards(auto, await listCards(auto));
    res.json({ count: picked.length, titles: picked.slice(0, 25).map((c) => c.title) });
  }));

  // ---------- Terminal routes for agents (`vaultos-automations`, spec §3–§4) ----------
  // server.js mounts termRouter at /api/term/automations behind its terminal-token check and sets req.term.
  // What `options` tells an agent about this install.
  async function agentOptions() {
    return {
      timezone: tz(),
      boards: boards().map((b) => ({ key: b.key, label: b.label })),
      statuses: CARD_STATUSES.map((id) => ({ id, label: STATUS_LABEL[id] })),
      levels: LEVELS.map((id) => ({ id, label: LEVEL_LABEL[id], text: LEVEL_TEXT[id] })),
      agents: await agentsInfo(),
      defaultAgent: (profileFor(settings()) || {}).id || null,
      templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, prompt: t.prompt })),
      schedules: [
        { repeat: 'daily', time: '08:00' }, { repeat: 'weekdays', time: '08:00' },
        { repeat: 'weekly', days: ['mon', 'fri'], time: '17:00' }, { repeat: 'hours', every: HOURS_EVERY[0], from: '08:00' },
      ],
      limits: {
        maxCards: MAX_CARDS, trialCards: TRIAL_CARDS, trialsPerHour: TRIALS_PER_HOUR, agentDrafts: MAX_AGENT_DRAFTS,
        promptMax: PROMPT_MAX, nameMax: NAME_MAX, timeLimitMin: [2, 30], hoursEvery: HOURS_EVERY,
      },
    };
  }
  const agentApi = createAgentApi({ store, runner, ctx, listCards, tz, options: agentOptions });
  // Which agent is asking, for the tags: the command sends its process ancestors' names; the terminal's
  // foreground process is the fallback. Display only, never a permission.
  function agentLabel(hint, term) {
    const names = [...(Array.isArray(hint) ? hint.slice(0, 24) : []), ...(term ? [termCmd(term)] : [])];
    for (const n of names) {
      if (typeof n !== 'string' || !n) continue;
      const base = path.basename(n);
      const p = Object.values(profiles).find((x) => Array.isArray(x.proc) && x.proc.includes(base));
      if (p) return p.label;
    }
    return 'An agent';
  }
  const idOf = (a) => (typeof a.id === 'string' ? a.id : '');
  const COMMANDS = {
    options: () => agentApi.options(),
    list: () => agentApi.list(),
    show: (a) => agentApi.show(idOf(a)),
    match: (a) => agentApi.match(a),
    runs: (a) => agentApi.runs(a),
    run: (a) => agentApi.run(idOf(a)),
    create: (a, label) => agentApi.create(a, label),
    edit: (a, label) => agentApi.edit(idOf(a), a.changes, label),
    off: (a) => agentApi.off(idOf(a)),
    try: (a) => agentApi.tryRun(idOf(a)),
    delete: (a) => agentApi.remove(idOf(a)),
  };
  const termRouter = express.Router();
  termRouter.post('/:command', async (req, res) => {
    const fn = Object.prototype.hasOwnProperty.call(COMMANDS, req.params.command) ? COMMANDS[req.params.command] : null;
    if (!fn) return res.status(404).json({ error: 'No such command' });
    if (!live()) return res.status(403).json({ error: 'Automations are off' });
    const b = req.body || {};
    const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
    try {
      const r = await fn(args, agentLabel(b.agentHint, req.term));
      res.status(r.status).json(r.body);
    } catch (err) {
      console.error('automations terminal route failed:', err && err.message);
      const mine = err && /^automations\.json:/.test(err.message);
      res.status(500).json({ error: mine ? err.message : 'Something went wrong with automations' });
    }
  });

  return { router, termRouter, boot, sync, live, status: () => runner.status() };
}

module.exports = { createAutomationService };
