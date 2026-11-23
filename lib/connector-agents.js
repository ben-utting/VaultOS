'use strict';
// Writes one user-wide MCP entry per connected connector into each installed agent that takes MCP servers.
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

function toCopilot(entry) {
  if (entry.kind === 'http') return { type: 'http', url: entry.url, headers: entry.headers || {}, tools: ['*'] };
  return { type: 'local', command: entry.command, args: entry.args, tools: ['*'] };
}

function toOpenCode(entry) {
  if (entry.kind === 'http') return { type: 'remote', url: entry.url, headers: entry.headers || {}, enabled: true };
  return { type: 'local', command: [entry.command, ...entry.args], enabled: true };
}

function toAntigravity(entry) {
  if (entry.kind === 'http') return { serverUrl: entry.url, headers: entry.headers || {} };
  return { command: entry.command, args: entry.args };
}

function toCodex(entry) {
  if (entry.kind === 'http') return { url: entry.url, ...(entry.headers && Object.keys(entry.headers).length ? { http_headers: entry.headers } : {}) };
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
  for (const k of ['type', 'url', 'serverUrl', 'headers', 'http_headers', 'command', 'args']) if (e[k] !== undefined) proj[k] = e[k];
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

// One JSON file per agent, its servers under `keys` (e.g. ['mcpServers'] or ['mcp']). Only that object is changed;
// everything else in the file is kept. The file can hold the relay key, so it is written 0600 (a stricter existing
// mode is kept). A link is written through to its target, so the link itself stays where the person put it.
function jsonWriter({ id, label, file, shown, keys, translate }) {
  const dir = path.dirname(file);
  const where = keys.join('.');
  const load = () => readJson(file, shown, {});
  const servers = (j) => {
    let m = j;
    for (const k of keys) {
      m = m && typeof m === 'object' && !Array.isArray(m) ? m[k] : undefined;
      if (m === undefined) return {};
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new AgentConfigError(`Couldn't read \`${shown}\` (its ${where} isn't an object). VaultOS left it alone.`);
    }
    return m;
  };
  const setServers = (j, m) => {
    let o = j;
    for (const k of keys.slice(0, -1)) {
      if (o[k] === undefined) o[k] = {};
      if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) throw new AgentConfigError(`Couldn't read \`${shown}\` (its ${k} isn't an object). VaultOS left it alone.`);
      o = o[k];
    }
    o[keys[keys.length - 1]] = m;
  };
  async function save(j) {
    await fsp.mkdir(dir, { recursive: true });
    let target = file;
    try { target = await fsp.realpath(file); } catch (e) {
      if (e.code !== 'ENOENT') throw new AgentConfigError(`Couldn't write \`${shown}\`.`);
      const link = await fsp.lstat(file).then((x) => x.isSymbolicLink(), () => false);
      if (link) throw new AgentConfigError(`\`${shown}\` is a link to a file that isn't there. VaultOS left it alone.`);
    }
    let mode = 0o600;
    try { mode = (await fsp.stat(target)).mode & 0o600; } catch { /* new file */ }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
    await fsp.writeFile(tmp, JSON.stringify(j, null, 2) + '\n', { encoding: 'utf8', mode });
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, target);
  }
  return {
    id, label, translate,
    async list() {
      return { user: { ...servers(await load()) }, perFolder: {} };
    },
    async put(name, agentEntry) {
      const j = await load();
      setServers(j, { ...servers(j), [name]: agentEntry });
      await save(j);
    },
    async remove(name) {
      const j = await load();
      if (!Object.hasOwn(servers(j), name)) return;
      const next = { ...servers(j) };
      delete next[name];
      setServers(j, next);
      await save(j);
    },
  };
}

function cursorWriter({ home }) {
  return jsonWriter({ id: 'cursor', label: 'Cursor CLI', file: path.join(home, '.cursor', 'mcp.json'), shown: '~/.cursor/mcp.json', keys: ['mcpServers'], translate: toCursor });
}

// GitHub Copilot CLI: ~/.copilot/mcp-config.json, "http" or "local", every tool allowed.
function copilotWriter({ home }) {
  return jsonWriter({ id: 'copilot', label: 'Copilot CLI', file: path.join(home, '.copilot', 'mcp-config.json'), shown: '~/.copilot/mcp-config.json', keys: ['mcpServers'], translate: toCopilot });
}

// OpenCode and Kilo CLI (a fork of OpenCode): "remote" or "local" (the command is one array). Both read servers under
// mcp.<name>; OpenCode's newer files keep them under mcp.servers.<name>, which is followed when the file already does.
// Kilo reads kilo.jsonc, kilo.json or a legacy opencode.json(c) in ~/.config/kilo; the first that exists is used, and a
// new one is kilo.jsonc, as `kilo mcp add` makes. A .jsonc file with comments in it is left alone (it isn't valid JSON).
async function firstExisting(dir, names, fallback) {
  for (const n of names) {
    try { await fsp.access(path.join(dir, n)); return n; } catch { /* next */ }
  }
  return fallback;
}
async function opencodeWriter({ home }) {
  const dir = path.join(home, '.config', 'opencode');
  const name = await firstExisting(dir, ['opencode.jsonc', 'opencode.json'], 'opencode.json');
  let keys = ['mcp'];
  try {
    const j = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    if (j && j.mcp && j.mcp.servers && typeof j.mcp.servers === 'object' && !Array.isArray(j.mcp.servers) && !j.mcp.servers.type) keys = ['mcp', 'servers'];
  } catch { /* missing or unreadable: the writer reports it */ }
  return jsonWriter({ id: 'opencode', label: 'OpenCode', file: path.join(dir, name), shown: `~/.config/opencode/${name}`, keys, translate: toOpenCode });
}
async function kiloWriter({ home }) {
  const dir = path.join(home, '.config', 'kilo');
  const name = await firstExisting(dir, ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json'], 'kilo.jsonc');
  return jsonWriter({ id: 'kilo', label: 'Kilo CLI', file: path.join(dir, name), shown: `~/.config/kilo/${name}`, keys: ['mcp'], translate: toOpenCode });
}

// Google Antigravity CLI: ~/.gemini/config/mcp_config.json, a remote server's address is serverUrl.
function antigravityWriter({ home }) {
  return jsonWriter({ id: 'antigravity', label: 'Antigravity CLI', file: path.join(home, '.gemini', 'config', 'mcp_config.json'), shown: '~/.gemini/config/mcp_config.json', keys: ['mcpServers'], translate: toAntigravity });
}

// OpenAI Codex CLI keeps its servers in TOML (~/.codex/config.toml, or $CODEX_HOME). Reading goes through
// `codex mcp list --json`, so any way the person wrote an entry is understood. Removing is `codex mcp remove`.
// Adding appends one table VaultOS writes itself (`codex mcp add` can't set a header), then reads it back with
// `codex mcp get`; if Codex doesn't see exactly that entry, the file is put back as it was.
const tomlStr = (s) => JSON.stringify(String(s)); // a TOML basic string: JSON's escapes are valid TOML ones
function codexTable(name, e) {
  const lines = [`[mcp_servers.${tomlStr(name)}]`];
  if (e.url !== undefined) {
    lines.push(`url = ${tomlStr(e.url)}`);
    const h = Object.entries(e.http_headers || {});
    if (h.length) lines.push(`http_headers = { ${h.map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }`);
  } else {
    lines.push(`command = ${tomlStr(e.command)}`);
    lines.push(`args = [${(e.args || []).map(tomlStr).join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}
function fromCodex(x) {
  const t = (x && x.transport) || {};
  if (t.type === 'streamable_http') {
    const out = { url: t.url };
    if (t.http_headers && Object.keys(t.http_headers).length) out.http_headers = t.http_headers;
    return out;
  }
  const out = { command: t.command, args: Array.isArray(t.args) ? t.args : [] };
  if (t.env && typeof t.env === 'object' && Object.keys(t.env).length) out.env = t.env;
  return out;
}
function codexWriter({ home, run, env = process.env }) {
  const dir = env.CODEX_HOME || path.join(home, '.codex');
  const file = path.join(dir, 'config.toml');
  const shown = env.CODEX_HOME ? '$CODEX_HOME/config.toml' : '~/.codex/config.toml';
  const json = (r, what) => {
    if (!r || r.code !== 0) throw new AgentConfigError(`Codex couldn't ${what} (exit ${r && r.code}).`);
    try { return JSON.parse(r.stdout); } catch { throw new AgentConfigError(`Codex couldn't ${what}.`); }
  };
  async function list() {
    const arr = json(await run('codex mcp list --json'), 'list its MCP servers');
    const user = {};
    for (const x of Array.isArray(arr) ? arr : []) if (x && typeof x.name === 'string') user[x.name] = fromCodex(x);
    return { user, perFolder: {} };
  }
  async function remove(name) {
    await run(`codex mcp remove ${shellQuote(name)}`);
    const { user } = await list();
    if (Object.hasOwn(user, name)) throw new AgentConfigError(`Codex didn't remove the ${name} entry.`);
  }
  return {
    id: 'codex', label: 'Codex CLI', translate: toCodex, list, remove,
    async put(name, agentEntry) {
      const { user } = await list();
      if (Object.hasOwn(user, name)) await remove(name);
      let before = null;
      try { before = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new AgentConfigError(`Couldn't read \`${shown}\`.`); }
      if (before !== null && /^\s*mcp_servers\s*=/m.test(before)) throw new AgentConfigError(`\`${shown}\` sets mcp_servers in one line. VaultOS left it alone.`);
      const text = (before === null ? '' : before.replace(/\s*$/, '\n\n')) + codexTable(name, agentEntry);
      await fsp.mkdir(dir, { recursive: true });
      let mode = 0o600;
      try { mode = (await fsp.stat(file)).mode & 0o600; } catch { /* new file */ }
      const tmp = path.join(dir, `.config.toml.tmp-${process.pid}`);
      await fsp.writeFile(tmp, text, { encoding: 'utf8', mode });
      await fsp.rename(tmp, file);
      let back = null;
      try { back = fromCodex(json(await run(`codex mcp get ${shellQuote(name)} --json`), `read the ${name} entry back`)); } catch { /* checked below */ }
      if (!back || entryHash(back) !== entryHash(agentEntry)) {
        if (before === null) await fsp.rm(file, { force: true });
        else await fsp.writeFile(file, before, { encoding: 'utf8', mode });
        throw new AgentConfigError(`Codex didn't read the ${name} entry back as written. \`${shown}\` was put back as it was.`);
      }
    },
  };
}

// wanted: the entries every agent should have, or a function of the agent id (some connectors are for one agent only).
async function syncAgents({ wanted: want, writers, written }) {
  const out = { written: {}, agents: {} };
  for (const w of writers) {
    const wanted = typeof want === 'function' ? want(w.id) : want;
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

module.exports = {
  AgentConfigError, toClaude, toCursor, toCopilot, toOpenCode, toAntigravity, toCodex, entryHash, codexTable,
  claudeWriter, cursorWriter, copilotWriter, opencodeWriter, kiloWriter, antigravityWriter, codexWriter, jsonWriter, syncAgents,
};
