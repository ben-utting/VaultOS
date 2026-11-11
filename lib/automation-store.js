'use strict';
// Automations on disk, inside the vault (spec §3): definitions in .vaultos/automations.json, the
// scheduler's state in .vaultos/automations-state.json, one file per run under
// .vaultos/automation-runs/<automation id>/<run id>.json. Writes to the two shared files go through
// one queue. A corrupt automations.json is reported and never overwritten.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const { validateAutomation, lastSlot, runCounts } = require('../public/automation-core');

const RUN_ID_RE = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4}$/;
const AUTO_ID_RE = /^[0-9a-f]{8}$/;
const KEEP_DAYS = 90;
const DAY_MS = 86400000;

function createAutomationStore(vaultDir, { now = Date.now, randomHex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n) } = {}) {
  const dir = path.join(vaultDir, '.vaultos');
  const defsFile = path.join(dir, 'automations.json');
  const stateFile = path.join(dir, 'automations-state.json');
  const runsDir = path.join(dir, 'automation-runs');
  const iso = () => new Date(now()).toISOString();

  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  async function readJson(file, fallback, label) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
    try { return JSON.parse(text); } catch (err) {
      if (!label) return fallback;   // the state file is only a cache of slots: start it afresh
      throw new Error(`${label}: ${err.message}`);
    }
  }
  async function writeJson(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  }

  async function readDefs() {
    const d = await readJson(defsFile, { version: 1, automations: [] }, 'automations.json');
    if (!d || d.version !== 1 || !Array.isArray(d.automations)) throw new Error('automations.json: unsupported format');
    return d;
  }
  const readState = async () => {
    const s = await readJson(stateFile, {}, null);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  };
  async function patchState(id, patch) {
    const s = await readState();
    if (patch === null) delete s[id];
    else s[id] = { ...(s[id] || {}), ...patch };
    await writeJson(stateFile, s);
  }
  const slotIso = (a, tz) => {
    const t = lastSlot(a.schedule, tz, now());
    return t === null ? null : new Date(t).toISOString();
  };

  const list = async () => (await readDefs()).automations;
  const get = async (id) => (await list()).find((a) => a.id === id) || null;

  // tags (spec §5): origin = { by:'agent', agent, at } on an automation an agent made; agentChange =
  // { agent, fields, switchedOff, at } after an agent's edit. Stored only when passed: a save from the tab
  // passes none, which clears them.
  const withoutPairCheck = ({ agentLevels, ...rest }) => rest;   // eslint-disable-line no-unused-vars
  const withTags = (a, { origin = null, agentChange = null } = {}) => ({ ...a, ...(origin ? { origin } : {}), ...(agentChange ? { agentChange } : {}) });
  // tags may also carry guard(list) -> message|null, checked inside the queue (e.g. the agents' draft cap);
  // a message comes back as { ok: false, refused }.
  function create(input, ctx, tags = {}) {
    return serial(async () => {
      const d = await readDefs();
      const refused = tags.guard ? tags.guard(d.automations) : null;
      if (refused) return { ok: false, refused };
      const r = validateAutomation(input, ctx);
      if (!r.ok) return r;
      let id;
      do id = randomHex(8); while (d.automations.some((a) => a.id === id));
      const a = withTags({ id, ...r.value, created: iso(), updated: iso() }, tags);
      d.automations.push(a);
      await writeJson(defsFile, d);
      await patchState(id, { lastSlot: slotIso(a, ctx.tz), lastRunId: null });
      return { ok: true, value: a };
    });
  }
  // Writes one automation from a validated input (or, with patch, the old one with a few fields changed and no
  // validation, so switching off always works). Runs inside the queue.
  async function write(d, i, old, { input, patch, ctx, tags }) {
    let value;
    if (patch) {
      const { id: _i, created: _c, updated: _u, origin: _o, agentChange: _a, ...rest } = old;   // eslint-disable-line no-unused-vars
      value = { ...rest, ...patch };
    } else {
      // Switching off with the same agent and level must always work, even after the default agent changed
      // and no longer covers the level (spec §5.5: the run-time check catches that), so the pair check is skipped.
      const keepsPair = input && input.enabled === false && input.agent === old.agent && input.level === old.level;
      const r = validateAutomation(input, keepsPair ? withoutPairCheck(ctx) : ctx);
      if (!r.ok) return r;
      value = r.value;
    }
    const a = withTags({ id: old.id, ...value, created: old.created, updated: iso() }, tags);
    d.automations[i] = a;
    await writeJson(defsFile, d);
    // A new schedule, or switching it on, counts from now: neither fires a catch-up for a slot before it.
    const switchedOn = !old.enabled && a.enabled;
    if (switchedOn || JSON.stringify(old.schedule) !== JSON.stringify(a.schedule)) await patchState(old.id, { lastSlot: slotIso(a, ctx.tz) });
    return { ok: true, value: a };
  }
  function update(id, input, ctx, tags) {
    return serial(async () => {
      const d = await readDefs();
      const i = d.automations.findIndex((a) => a.id === id);
      if (i === -1) return null;
      return write(d, i, d.automations[i], { input, ctx, tags });
    });
  }
  // Read, decide and write in one turn of the queue, so nothing saved meanwhile is lost (the agents' edits).
  // decide(old) returns { input, ctx, tags } | { patch, ctx, tags } | { keep: true } | { errors }.
  function mutate(id, decide) {
    return serial(async () => {
      const d = await readDefs();
      const i = d.automations.findIndex((a) => a.id === id);
      if (i === -1) return null;
      const plan = await decide(d.automations[i]);
      if (plan.errors) return { ok: false, errors: plan.errors };
      if (plan.keep) return { ok: true, value: d.automations[i] };
      return write(d, i, d.automations[i], plan);
    });
  }
  // refuse(old) -> message|null, checked inside the queue. Returns { removed: true } | { refused } | null.
  function removeIf(id, refuse) {
    return serial(async () => {
      const d = await readDefs();
      const old = d.automations.find((a) => a.id === id);
      if (!old) return null;
      const refused = refuse(old);
      if (refused) return { refused };
      await writeJson(defsFile, { ...d, automations: d.automations.filter((a) => a.id !== id) });
      await patchState(id, null);
      return { removed: true };
    });
  }
  function remove(id) {
    return removeIf(id, () => null).then((r) => !!r);
  }
  async function getState(id) {
    const s = (await readState())[id] || {};
    return { lastSlot: s.lastSlot ? Date.parse(s.lastSlot) : null, lastRunId: s.lastRunId || null };
  }
  function setState(id, patch) {
    const p = { ...patch };
    if (typeof p.lastSlot === 'number') p.lastSlot = new Date(p.lastSlot).toISOString();
    return serial(() => patchState(id, p));
  }

  // ---------- Runs ----------
  // YYYYMMDD-HHMMSS-mmmx: the 4-character tail is the milliseconds plus one random hex digit, so ids
  // still sort by time when two runs start in the same second (the newest-first listing relies on it).
  function newRunId() {
    const s = iso();
    return `${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 19).replace(/:/g, '')}-${s.slice(20, 23)}${randomHex(1)}`;
  }
  const runFile = (run) => path.join(runsDir, run.automationId, `${run.id}.json`);
  async function saveRun(run) {
    if (!RUN_ID_RE.test(run.id) || !AUTO_ID_RE.test(run.automationId)) throw new Error('bad run id');
    await writeJson(runFile(run), run);
  }
  async function automationDirs() {
    try { return (await fsp.readdir(runsDir)).filter((n) => AUTO_ID_RE.test(n)); } catch { return []; }
  }
  // Every run file as { id, file }, newest first. Names only: nothing is read.
  async function runIndex(automation) {
    const dirs = automation === undefined ? await automationDirs() : (AUTO_ID_RE.test(automation) ? [automation] : []);
    const out = [];
    for (const a of dirs) {
      let names = [];
      try { names = await fsp.readdir(path.join(runsDir, a)); } catch { /* none yet */ }
      for (const n of names) {
        const id = n.replace(/\.json$/, '');
        if (n.endsWith('.json') && RUN_ID_RE.test(id)) out.push({ id, file: path.join(runsDir, a, n) });
      }
    }
    return out.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  }
  async function getRun(id) {
    if (!RUN_ID_RE.test(String(id))) return null;
    const hit = (await runIndex()).find((r) => r.id === id);
    return hit ? readJson(hit.file, null, null) : null;
  }
  const summary = (run) => ({
    ...run,
    cards: (run.cards || []).map(({ note, outputTail, ...c }) => c),
    counts: runCounts(run),
  });
  async function listRuns({ automation, before, limit = 30 } = {}) {
    const ids = (await runIndex(automation)).filter((r) => !before || r.id < before).slice(0, limit);
    const runs = await Promise.all(ids.map((r) => readJson(r.file, null, null)));
    return runs.filter(Boolean).map(summary);
  }
  async function recoverRunning() {
    let n = 0;
    for (const r of await runIndex()) {
      const run = await readJson(r.file, null, null);
      if (!run || run.state !== 'running') continue;
      run.state = 'interrupted';
      run.endedAt = iso();
      for (const c of run.cards || []) {
        if (c.state === 'running') { c.state = 'failed'; c.reason = 'VaultOS restarted'; }
        else if (c.state === 'waiting') c.state = 'not-run';
      }
      await writeJson(r.file, run);
      n++;
    }
    return n;
  }
  async function prune() {
    let n = 0;
    for (const r of await runIndex()) {
      const [, y, m, d] = RUN_ID_RE.exec(r.id);
      if (now() - Date.UTC(+y, +m - 1, +d) > KEEP_DAYS * DAY_MS) {
        await fsp.rm(r.file, { force: true });
        n++;
      }
    }
    return n;
  }

  return { list, get, create, update, mutate, remove, removeIf, getState, setState, newRunId, saveRun, getRun, listRuns, recoverRunning, prune };
}

module.exports = { createAutomationStore, RUN_ID_RE, AUTO_ID_RE };
