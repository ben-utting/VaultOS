'use strict';
// Per-card connector access for an automation run: a one-off key, an MCP config naming only the connectors the card
// ticked (and that are connected), and the counts of what the run looked up. All of it is deleted when the run's agent
// stops. Read-only always: nothing here passes "Allow changes", and the relay filters the tools (see relayTarget).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CONNECTORS, entryFor } = require('./connectors');
const { STDIO_WRAPPER } = require('./automation-mcp-stdio');
const { toClaude } = require('./connector-agents');

const AUTOMATION_IDS = Object.keys(CONNECTORS).filter((id) => CONNECTORS[id].kind !== 'cursor');
const WRAPPED = new Set(['azure', 'azuredevops']); // the connectors an agent starts itself
const MAX_TOOLS = 50;

function createAutomationAccess({ dir, port, home, connected, record, label }) {
  const keys = new Map(); // key -> { ids: Set, calls: {id: Map}, refused: {id: Map} }
  const live = new Set(); // file names of the accesses open now: clearLeftovers() keeps them

  const bump = (table, id, tool, cap = MAX_TOOLS) => {
    const m = table[id] || (table[id] = new Map());
    if (!m.has(tool) && m.size >= cap) return;
    m.set(tool, (m.get(tool) || 0) + 1);
  };
  const plain = (table) => Object.fromEntries(Object.entries(table).map(([id, m]) => [id, Object.fromEntries(m)]));

  async function ensureDir() {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(dir, 0o700);
  }

  // Never throws: a connector whose state can't be read (the store not loaded yet, or unreadable) is not connected.
  function choices() {
    return AUTOMATION_IDS.map((id) => {
      let on = false;
      try { on = !!connected(id); } catch { /* not connected */ }
      return { id, label: label(id), connected: on };
    });
  }

  async function open({ runId, cardPath, ids }) {
    const wanted = [...new Set(Array.isArray(ids) ? ids : [])];
    for (const id of wanted) {
      if (typeof id !== 'string' || !AUTOMATION_IDS.includes(id)) throw new Error(`${typeof id === 'string' ? id : 'That'} isn't a connector an automation can use.`);
    }
    await ensureDir();
    const rand = crypto.randomBytes(12).toString('hex');
    const configFile = path.join(dir, `${rand}.json`);
    const logFile = path.join(dir, `${rand}.log`);
    const key = crypto.randomBytes(32).toString('base64url');
    const got = [], missing = [], entries = {}, labels = {};
    for (const id of wanted) {
      labels[id] = label(id);
      if (!connected(id)) { missing.push(id); continue; }
      const r = record(id) || {};
      let e = entryFor(id, { port, key, home, allowChanges: false, org: r.org });
      if (WRAPPED.has(id)) e = { kind: 'stdio', command: process.execPath, args: [STDIO_WRAPPER, '--id', id, '--log', logFile, '--', e.command, ...e.args] };
      entries[id] = e;
      got.push(id);
    }
    const config = { mcpServers: Object.fromEntries(got.map((id) => [id, toClaude(entries[id])])) };
    // Named live before they exist, so a clearLeftovers() meanwhile never takes them.
    const mine = [path.basename(configFile), path.basename(logFile)];
    for (const f of mine) live.add(f);
    try {
      await fs.promises.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      await fs.promises.chmod(configFile, 0o600);
    } catch (err) {
      for (const f of mine) live.delete(f);
      await fs.promises.rm(configFile, { force: true }).catch(() => {});
      throw err;
    }
    const state = { ids: new Set(got), calls: {}, refused: {} };
    keys.set(key, state);

    async function usage() {
      const calls = { ...state.calls }, refused = { ...state.refused };
      // Copy the relay's maps so the wrapper's counts can be merged without changing them.
      for (const t of [calls, refused]) for (const id of Object.keys(t)) t[id] = new Map(t[id]);
      let text = '';
      try { text = await fs.promises.readFile(logFile, 'utf8'); } catch { /* no log: nothing was called */ }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!m || typeof m.id !== 'string' || typeof m.tool !== 'string' || !state.ids.has(m.id)) continue;
        bump(m.refused ? refused : calls, m.id, m.tool.slice(0, 120));
      }
      return { lookups: plain(calls), refusedCalls: plain(refused) };
    }

    async function revoke() {
      keys.delete(key);
      for (const f of mine) live.delete(f);
      await fs.promises.rm(configFile, { force: true });
      await fs.promises.rm(logFile, { force: true });
    }

    return { ids: got, entries, missing, labels, configFile, usage, revoke };
  }

  // Never throws: anything that is not a live key is null.
  function grant(key) {
    try {
      if (typeof key !== 'string') return null;
      const s = keys.get(key);
      if (!s) return null;
      return {
        ids: s.ids,
        count(id, tool, refused) {
          if (typeof id !== 'string' || typeof tool !== 'string' || !s.ids.has(id)) return;
          bump(refused ? s.refused : s.calls, id, tool.slice(0, 120));
        },
      };
    } catch { return null; }
  }

  async function clearLeftovers() {
    await ensureDir();
    for (const f of await fs.promises.readdir(dir)) if (!live.has(f)) await fs.promises.rm(path.join(dir, f), { recursive: true, force: true });
  }

  return { choices, open, grant, clearLeftovers };
}

module.exports = { AUTOMATION_IDS, createAutomationAccess };
