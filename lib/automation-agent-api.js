'use strict';
// What an agent in a VaultOS terminal may do with automations (spec §5), over the store and runner.
// Agents make drafts that are saved off; only the person switches one on. Edits to name, schedule, time
// limit, note heading or template keep an automation as it was; edits to agent, level, prompt or cards
// switch it off and say so. Trials look at a few cards and write nothing. Delete only works when it's off.
// Every function answers { status, body } for the terminal routes to send as is.
const { selectCards } = require('./automation-runner');
const AC = require('../public/automation-core');

const DEFINITION = ['name', 'enabled', 'agent', 'template', 'prompt', 'level', 'cards', 'schedule', 'section', 'timeLimitMin'];
const SWITCH_OFF = ['agent', 'level', 'prompt', 'cards'];
const MAX_AGENT_DRAFTS = 10;
const TRIALS_PER_HOUR = 6;
const HOUR_MS = 3600 * 1000;
const FIELD_ERROR = 'Check these fields';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Only the definition's own fields, so an agent can't set id, origin, agentChange, created or updated.
const definition = (x) => {
  const out = {};
  if (isObj(x)) for (const k of DEFINITION) if (k in x) out[k] = x[k];
  return out;
};

function createAgentApi({ store, runner, ctx, listCards, tz, now = Date.now, options }) {
  const iso = () => new Date(now()).toISOString();
  const ok = (body) => ({ status: 200, body });
  const fail = (status, error, errors) => ({ status, body: errors ? { error, errors } : { error } });
  const noSuch = () => fail(404, 'No such automation');
  let trials = [];   // when each accepted trial was asked for; in memory, so a restart starts the count again

  const view = async (a) => {
    const next = a.enabled ? AC.nextSlot(a.schedule, tz(), now()) : null;
    const [lastRun] = await store.listRuns({ automation: a.id, limit: 1 });
    return {
      ...a, scheduleText: AC.describeSchedule(a.schedule), nextRun: next === null ? null : new Date(next).toISOString(),
      lastRun: lastRun ? { id: lastRun.id, trigger: lastRun.trigger, state: lastRun.state, startedAt: lastRun.startedAt, summary: AC.runSummary(lastRun) } : null,
      tag: AC.agentTagText(a, tz()),
    };
  };

  async function list() {
    return ok({ timezone: tz(), automations: await Promise.all((await store.list()).map(view)) });
  }
  async function show(id) {
    const a = await store.get(id);
    return a ? ok({ automation: await view(a) }) : noSuch();
  }
  async function match(arg) {
    let auto;
    if (arg && typeof arg.id === 'string') {
      auto = await store.get(arg.id);
      if (!auto) return noSuch();
    } else {
      const c = isObj(arg && arg.draft) && isObj(arg.draft.cards) ? arg.draft.cards : {};
      const statuses = Array.isArray(c.statuses) ? c.statuses.filter((s) => AC.CARD_STATUSES.includes(s)) : [];
      auto = { cards: { board: typeof c.board === 'string' ? c.board : 'all', statuses, subtasks: c.subtasks === true } };
    }
    const picked = selectCards(auto, await listCards(auto));
    return ok({ count: picked.length, cards: picked.slice(0, 25).map((c) => ({ title: c.title, status: c.status, path: c.path })) });
  }
  async function runs({ automation, limit } = {}) {
    const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    return ok({ runs: await store.listRuns({ automation: typeof automation === 'string' && automation ? automation : undefined, limit: n }) });
  }
  async function run(runId) {
    const r = await store.getRun(runId);
    return r ? ok(r) : fail(404, 'No such run');
  }

  async function create(input, label) {
    const drafts = (await store.list()).filter((a) => a.origin && !a.enabled).length;
    if (drafts >= MAX_AGENT_DRAFTS) return fail(409, `There are already ${MAX_AGENT_DRAFTS} drafts from agents. Delete some or switch them on first.`);
    const r = await store.create({ ...definition(input), enabled: false }, ctx(), { origin: { by: 'agent', agent: label, at: iso() } });
    return r.ok ? ok({ automation: r.value }) : fail(400, FIELD_ERROR, r.errors);
  }

  async function edit(id, changes, label) {
    const old = await store.get(id);
    if (!old) return noSuch();
    const c = definition(changes);
    const merged = {
      ...definition(old), ...c,
      cards: isObj(c.cards) ? { ...old.cards, ...c.cards } : old.cards,
      schedule: isObj(c.schedule) ? { ...old.schedule, ...c.schedule } : old.schedule,
      enabled: c.enabled === false ? false : old.enabled,   // never on from here
    };
    const checked = AC.validateAutomation(merged, ctx());
    if (!checked.ok) return fail(400, FIELD_ERROR, checked.errors);
    const value = checked.value;
    const changed = SWITCH_OFF.filter((k) => JSON.stringify(value[k]) !== JSON.stringify(old[k]));
    let agentChange = old.agentChange || null;
    if (changed.length) {
      const before = (old.agentChange && old.agentChange.fields) || [];
      agentChange = {
        agent: label, fields: [...before, ...changed.filter((f) => !before.includes(f))],
        switchedOff: old.enabled || !!(old.agentChange && old.agentChange.switchedOff), at: iso(),
      };
      value.enabled = false;
    }
    const r = await store.update(id, value, ctx(), { origin: old.origin || null, agentChange });
    if (!r) return noSuch();
    return r.ok ? ok({ automation: r.value }) : fail(400, FIELD_ERROR, r.errors);
  }

  async function off(id) {
    const old = await store.get(id);
    if (!old) return noSuch();
    if (!old.enabled) return ok({ automation: old });
    // Switching off must always work, so the agent-and-level check (which a later default change can trip) is left out.
    const { agentLevels, ...loose } = ctx();   // eslint-disable-line no-unused-vars
    const r = await store.update(id, { ...definition(old), enabled: false }, loose, { origin: old.origin || null, agentChange: old.agentChange || null });
    if (!r) return noSuch();
    return r.ok ? ok({ automation: r.value }) : fail(400, FIELD_ERROR, r.errors);
  }

  async function tryRun(id) {
    const t = now();
    trials = trials.filter((x) => t - x < HOUR_MS);
    if (trials.length >= TRIALS_PER_HOUR) {
      const p = AC.wallParts(trials[0] + HOUR_MS, tz());
      const at = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
      return fail(429, `Too many trials this hour; try again after ${at}.`);
    }
    const r = await runner.tryNow(id);
    if (r.error) return fail(r.error === 'No such automation' ? 404 : 409, r.error);
    trials.push(t);
    return ok({ queued: true, since: new Date(t).toISOString() });
  }

  async function remove(id) {
    const old = await store.get(id);
    if (!old) return noSuch();
    if (old.enabled) return fail(409, 'Switch it off in the Automations tab before deleting it.');
    runner.remove(id);
    if (!(await store.remove(id))) return noSuch();
    return ok({ ok: true });
  }

  return { options: async () => ok(await options()), list, show, match, runs, run, create, edit, off, tryRun, remove };
}

module.exports = { createAgentApi, SWITCH_OFF, MAX_AGENT_DRAFTS, TRIALS_PER_HOUR };
