'use strict';
// Writes one user-wide MCP entry per connected connector into each installed agent.
// Only ever changes or removes entries it wrote itself (tracked by hash in `written`).
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { shellQuote } = require('./agents');

class AgentConfigError extends Error {
  constructor(message) { super(message); this.name = 'AgentConfigError'; }
}

function toClaude(entry) {
  if (entry.kind === 'http') return { type: 'http', url: entry.url, headers: entry.headers };
  return { type: 'stdio', command: entry.command, args: entry.args };
}

function toCursor(entry) {
  if (entry.kind === 'http') return { url: entry.url, headers: entry.headers };
  return { command: entry.command, args: entry.args };
}

function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
    return o;
  }
  return v;
}

function entryHash(e) {
  const proj = {};
  for (const k of ['type', 'url', 'headers', 'command', 'args']) if (e[k] !== undefined) proj[k] = e[k];
  // An empty env is the same as none (Claude may store stdio entries with env: {}).
  if (e.env && typeof e.env === 'object' && Object.keys(e.env).length) proj.env = e.env;
  return crypto.createHash('sha256').update(JSON.stringify(sorted(proj))).digest('hex');
}

async function readJson(file, shown, missing) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return missing;
    throw new AgentConfigError(`Couldn't read \`${shown}\``);
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new AgentConfigError(`Couldn't read \`${shown}\` (it isn't valid JSON). VaultOS left it alone.`);
  }
}

function claudeWriter({ home, run }) {
  const file = path.join(home, '.claude.json');
  async function list() {
    const j = await readJson(file, '~/.claude.json', {});
    const user = j.mcpServers && typeof j.mcpServers === 'object' ? { ...j.mcpServers } : {};
    const perFolder = {};
    for (const [folder, p] of Object.entries(j.projects || {})) {
      for (const name of Object.keys((p && p.mcpServers) || {})) (perFolder[name] ||= []).push(folder);
    }
    return { user, perFolder };
  }
  const removeCmd = (name) => `claude mcp remove --scope user ${shellQuote(name)}`;
  return {
    id: 'claude', label: 'Claude Code', list, translate: toClaude,
    async put(name, agentEntry) {
      await run(removeCmd(name)); // failure (not present) is ignored
      const r = await run(`claude mcp add-json --scope user ${shellQuote(name)} ${shellQuote(JSON.stringify(agentEntry))}`);
      if (r.code !== 0) throw new Error(`Claude Code didn't accept the ${name} entry (exit ${r.code})`);
    },
    async remove(name) {
      const r = await run(removeCmd(name));
      if (r.code !== 0) {
        const { user } = await list();
        if (Object.hasOwn(user, name)) throw new Error(`Claude Code didn't remove the ${name} entry (exit ${r.code})`);
      }
    },
  };
}

function cursorWriter({ home }) {
  const dir = path.join(home, '.cursor');
  const file = path.join(dir, 'mcp.json');
  const load = () => readJson(file, '~/.cursor/mcp.json', { mcpServers: {} });
  const servers = (j) => {
    const m = j.mcpServers;
    if (m === undefined) return {};
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new AgentConfigError("Couldn't read `~/.cursor/mcp.json` (its mcpServers isn't an object). VaultOS left it alone.");
    }
    return m;
  };
  // The file holds the relay key, so it is written 0600 (a stricter existing mode is kept). A link is written
  // through to its target, so the link itself stays where the person put it.
  async function save(j) {
    await fsp.mkdir(dir, { recursive: true });
    let target = file;
    try { target = await fsp.realpath(file); } catch (e) {
      if (e.code !== 'ENOENT') throw new AgentConfigError("Couldn't write `~/.cursor/mcp.json`.");
      const link = await fsp.lstat(file).then((x) => x.isSymbolicLink(), () => false);
      if (link) throw new AgentConfigError("`~/.cursor/mcp.json` is a link to a file that isn't there. VaultOS left it alone.");
    }
    let mode = 0o600;
    try { mode = (await fsp.stat(target)).mode & 0o600; } catch { /* new file */ }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
    await fsp.writeFile(tmp, JSON.stringify(j, null, 2) + '\n', { encoding: 'utf8', mode });
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, target);
  }
  return {
    id: 'cursor', label: 'Cursor CLI', translate: toCursor,
    async list() {
      return { user: { ...servers(await load()) }, perFolder: {} };
    },
    async put(name, agentEntry) {
      const j = await load();
      j.mcpServers = { ...servers(j), [name]: agentEntry };
      await save(j);
    },
    async remove(name) {
      const j = await load();
      if (!Object.hasOwn(servers(j), name)) return;
      const next = { ...servers(j) };
      delete next[name];
      j.mcpServers = next;
      await save(j);
    },
  };
}

async function syncAgents({ wanted, writers, written }) {
  const out = { written: {}, agents: {} };
  for (const w of writers) {
    const prev = (written && written[w.id]) || {};
    const next = { ...prev };
    try {
      const { user, perFolder } = await w.list();
      const foreign = [];
      const has = (name) => Object.hasOwn(user, name);
      const ours = (name) => has(name) && prev[name] === entryHash(user[name]);
      for (const [name, entry] of Object.entries(wanted || {})) {
        const desired = w.translate(entry);
        const dh = entryHash(desired);
        if (!has(name)) {
          await w.put(name, desired);
          next[name] = dh;
        } else if (ours(name) || entryHash(user[name]) === dh) {
          if (entryHash(user[name]) !== dh) await w.put(name, desired);
          next[name] = dh;
        } else {
          foreign.push(name);
          delete next[name];
        }
      }
      for (const name of Object.keys(prev)) {
        if (Object.hasOwn(wanted || {}, name)) continue;
        if (ours(name)) await w.remove(name);
        delete next[name];
      }
      out.written[w.id] = next;
      out.agents[w.id] = { ok: true, foreign, perFolder };
    } catch (e) {
      out.written[w.id] = next; // keeps every put/remove that completed before the failure
      out.agents[w.id] = { ok: false, error: e.message, foreign: [], perFolder: {} };
    }
  }
  return out;
}

module.exports = { AgentConfigError, toClaude, toCursor, entryHash, claudeWriter, cursorWriter, syncAgents };
