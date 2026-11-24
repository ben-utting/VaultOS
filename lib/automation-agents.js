'use strict';
// How an automation starts an agent with no terminal (spec §5): the command per agent and level,
// spawning it in its own process group with a time limit, and the before/after file lists that
// catch a read-only run that changed something anyway. Commands were checked on 2026-11-11 (spec,
// "Decisions made during implementation"): an agent/level pair is offered only once it has been
// shown to stay read-only (Report/Update) or inside the card folder (Work).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shellQuote } = require('./agents');
const { toCursor } = require('./connector-agents');

const OUTPUT_MAX = 256 * 1024;
const KILL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 2000;
const SNAPSHOT_MAX = 5000;
const LEVEL_LABEL = { report: 'Report', update: 'Update', work: 'Work' };
const AGENT_LABEL = { claude: 'Claude Code', cursor: 'Cursor CLI', pi: 'Pi' };

// Quote only what the shell would misread, so the command stays readable in logs and tests.
const q = (a) => (/^[A-Za-z0-9_.,:/=@+-]+$/.test(a) ? a : shellQuote(a));
const join = (argv) => argv.map(q).join(' ');

const CLAUDE = ['claude', '-p', '--output-format', 'text', '--strict-mcp-config', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];

// Cursor CLI (checked 2026-11-11 with a signed-in Cursor, spec "Decisions made during implementation"). Its
// --mode ask alone still read any file and loaded the user's MCP servers, and it has no switch for hooks, so:
// - it runs with its own Cursor home (no MCP servers, user hooks or Claude settings; its chats stay out of the
//   person's history), borrowing the real sign-in through XDG_CONFIG_HOME;
// - before each card, prepareAgent writes that home's cli-config.json with deny rules that keep reads inside the
//   card folder and block writes, shell, web and MCP, and refuses a card whose own folder would load hooks or MCP.
// Report and Update only: in normal mode it could create new files outside the card (rules can name only paths
// that exist), so Work isn't offered. The prompt goes on stdin. cursor-agent comes first: a person's own wrapper
// script may be called `agent`.
const CURSOR_HOME = (home) => path.join(home, '.cache', 'vaultos', 'automation-cursor');
const cursorOpts = (o = {}) => {
  const home = o.home || process.env.HOME || os.homedir();
  return { home, xdgConfig: o.xdgConfig || process.env.XDG_CONFIG_HOME || path.join(home, '.config') };
};
// The environment and binary every Cursor command here starts with.
function cursorBin(opts) {
  const { home, xdgConfig } = cursorOpts(opts);
  const own = CURSOR_HOME(home);
  const env = [`XDG_CONFIG_HOME=${q(xdgConfig)}`, `HOME=${q(own)}`, `CURSOR_CONFIG_DIR=${q(path.join(own, '.cursor'))}`, `CURSOR_DATA_DIR=${q(path.join(own, '.cursor'))}`];
  return `${env.join(' ')} "$(command -v cursor-agent || command -v agent)"`;
}
// opts.model: the automation's model, passed as --model when set (always quoted; validateAutomation keeps it to
// one line that can't start with "-", and Cursor reads the word after --model as its value whatever it is).
function cursorCommand(level, prompt, opts = {}) {
  const flags = ['-p', '--output-format', 'text', '--trust', '--mode', 'ask'];
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  // --approve-mcps: with the run's own MCP servers in mcp.json, Cursor would otherwise ask before using them.
  return { cmd: `${cursorBin(opts)} ${join(flags)}${model ? ` --model ${shellQuote(model)}` : ''}${opts.mcp ? ' --approve-mcps' : ''}`, input: prompt };
}
// The models this Cursor sign-in can use, for the builder's suggestions (parseCursorModels reads the output).
function cursorModelsCommand(opts) {
  if (testAgent()) return { cmd: `${q(process.execPath)} ${q(testAgent())} models`, input: null };
  return { cmd: `${cursorBin(opts)} --list-models`, input: null };
}
// `--list-models` prints a heading, then one "<id> - <label>" line per model; the default is marked "(current, default)".
function parseCursorModels(text) {
  const out = [];
  const seen = new Set();
  const clean = String(text || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u200b-\u200d\ufeff]/g, '');
  for (const line of clean.split(/\r?\n/)) {
    const m = /^\s*(\S+) - (.+?)\s*$/.exec(line);
    if (!m || m[1].startsWith('-') || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], label: m[2].replace(/\s+/g, ' ') });
  }
  return out;
}

const ADAPTERS = {
  claude: {
    levels: ['report', 'update', 'work'],
    connectors: true,
    command: (level, prompt, opts = {}) => ({
      cmd: join([...CLAUDE, ...(level === 'work'
        ? ['--tools', 'Read,Grep,Glob,Edit,Write', '--permission-mode', 'acceptEdits']
        : ['--tools', 'Read,Grep,Glob']),
      // The run's own config file (still --strict-mcp-config: nothing else loads) and only those servers allowed.
      ...(opts.mcp ? ['--mcp-config', opts.mcp.configFile, '--allowedTools', opts.mcp.ids.map((id) => `mcp__${id}`).join(',')] : [])]),
      input: prompt,
    }),
  },
  // Pi: read-only worked (2026-11-11), but its tools have no folder limit, for reads as much as writes, so a
  // card could have it read files outside its folder (credentials) into a note. Not offered until confined.
  pi: {
    levels: [],
    connectors: false,
    command: (level, prompt) => ({ cmd: join(['pi', '-p', '--tools', 'read,grep,find,ls', '--no-session', '--no-extensions']), input: prompt }),
  },
  cursor: {
    levels: ['report', 'update'],
    // Switched on 2026-11-24 at Ben's call, before the four live checks in spec §12 were run on a machine with
    // Cursor installed. Read-only is enforced by VaultOS (relay filters, stdio wrapper), whatever Cursor does.
    connectors: true,
    command: cursorCommand,
  },
};

const testAgent = () => process.env.AUTOMATION_TEST_AGENT || '';

// Tests only (with AUTOMATION_TEST_AGENT): AUTOMATION_TEST_LEVELS="cursor:report,update;pi:" narrows the levels.
function testLevels(agentId) {
  for (const part of (process.env.AUTOMATION_TEST_LEVELS || '').split(';')) {
    const [id, levels = ''] = part.split(':');
    if (id === agentId) return levels.split(',').filter(Boolean);
  }
  return ['report', 'update', 'work'];
}

function offeredLevels(agentId) {
  if (testAgent()) return testLevels(agentId);
  return ADAPTERS[agentId] ? [...ADAPTERS[agentId].levels] : [];
}

// Whether an agent can look things up in connectors during a run (always, with the test agent).
function agentConnectors(agentId) {
  if (testAgent()) return true;
  return !!(ADAPTERS[agentId] && ADAPTERS[agentId].connectors);
}

// A run's MCP servers count only when at least one is signed in; with none, everything stays as it is without connectors.
const runMcp = (opts) => (opts && opts.mcp && opts.mcp.ids && opts.mcp.ids.length ? opts.mcp : null);

function agentCommand(agentId, level, prompt, opts) {
  if (opts && opts.mcp && !runMcp(opts)) opts = { ...opts, mcp: undefined };
  if (testAgent()) {
    const mcp = opts && opts.mcp ? ` --mcp-config ${q(opts.mcp.configFile)}` : '';
    return { cmd: `${q(process.execPath)} ${q(testAgent())} ${level}${mcp}`, input: prompt };
  }
  if (!offeredLevels(agentId).includes(level)) {
    return { error: `${AGENT_LABEL[agentId] || agentId} is not available for automations at the ${LEVEL_LABEL[level] || level} level` };
  }
  return ADAPTERS[agentId].command(level, prompt, opts);
}

// Cursor's permission patterns: Kind(pattern), where only `*` is a wildcard (it matches anything, "/" and dot
// files included) and the rest is literal, and a deny beats any allow. "Only this folder" can't be said directly,
// so the rules deny, by exact path, every entry beside each folder on the way down to the card, and every symlink
// in the card that leads out of it (Cursor checks the path as written). Rules are built from the real path,
// which is what the agent's working directory reports. A file created beside the card mid-run isn't covered.
async function cursorRules(cardDir, { mcp } = {}) {
  const card = await fsp.realpath(cardDir);
  const deny = mcp ? ['Shell(*)', 'WebFetch(*)', 'Write(*)'] : ['Shell(*)', 'WebFetch(*)', 'Mcp(*:*)', 'Write(*)'];
  const block = (p) => deny.push(`Read(${p})`, `Read(${p}/*)`);
  let dir = '/';
  for (const next of card.split('/').filter(Boolean)) {
    for (const name of (await fsp.readdir(dir)).sort()) if (name !== next) block(path.posix.join(dir, name));
    dir = path.posix.join(dir, next);
  }
  for (const link of await linksLeaving(card)) block(link);
  return deny;
}

// Symlinks under dir (not .git) whose target is outside it, or missing; up to SNAPSHOT_MAX entries are looked at.
async function linksLeaving(dir) {
  const out = [];
  let seen = 0;
  const inside = (p) => p === dir || p.startsWith(`${dir}/`);
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > SNAPSHOT_MAX) return;
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try { target = await fsp.realpath(full); } catch { /* dangling */ }
        if (!target || !inside(target)) out.push(full);
      } else if (e.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out;
}

// Cursor loads hooks and MCP servers from the card folder itself and has no switch to turn them off, so a card
// whose folder carries them isn't run. Returns the reason, or null. A settings file that can't be read counts.
async function cursorGuard(cardDir) {
  const exists = async (rel) => { try { await fsp.access(path.join(cardDir, rel)); return true; } catch { return false; } };
  if (await exists('.cursor/hooks.json')) return 'its folder has its own agent hooks (.cursor/hooks.json), which Cursor can\'t switch off';
  if (await exists('.cursor/mcp.json')) return 'its folder has its own MCP servers (.cursor/mcp.json), which automations run without';
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    let raw;
    try { raw = await fsp.readFile(path.join(cardDir, rel), 'utf8'); } catch { continue; }
    let hooks;
    try { hooks = JSON.parse(raw).hooks; } catch { return `its folder has a ${rel} that can't be read, which may hold agent hooks`; }
    if (hooks && typeof hooks === 'object' && Object.keys(hooks).length) return `its folder has its own agent hooks (${rel}), which Cursor can't switch off`;
  }
  return null;
}

// Anything an agent needs set up for one card before it starts. Returns {} to go ahead, or { skip: reason }.
async function prepareAgent(agentId, level, cardDir, opts) {
  if (testAgent() || agentId !== 'cursor') return {};
  const why = await cursorGuard(cardDir);
  if (why) return { skip: why };
  const dir = path.join(CURSOR_HOME(cursorOpts(opts).home), '.cursor');
  for (const old of ['chats', 'projects', 'ai-tracking']) await fsp.rm(path.join(dir, old), { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const mcp = runMcp(opts);
  const config = { version: 1, permissions: { allow: [], deny: await cursorRules(cardDir, { mcp: !!mcp }) } };
  await fsp.writeFile(path.join(dir, 'cli-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  // The run's servers, with their one-off key, live only in this file and only for this run.
  const file = path.join(dir, 'mcp.json');
  await fsp.rm(file, { force: true });
  if (mcp) {
    const mcpServers = {};
    for (const id of mcp.ids) mcpServers[id] = toCursor(mcp.entries[id]);
    await fsp.writeFile(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
  }
  return {};
}

// After a run: Cursor's mcp.json holds the one-off key, so it goes. Nothing to undo for other agents.
async function finishAgent(agentId, opts) {
  if (testAgent() || agentId !== 'cursor') return;
  await fsp.rm(path.join(CURSOR_HOME(cursorOpts(opts).home), '.cursor', 'mcp.json'), { force: true });
}

// The environment an automation's agent runs with: the server's own, minus anything that would
// make it look like a VaultOS terminal, with the board's time zone.
function automationEnv(base, tz) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('VAULTOS_TERM') || k === 'VAULTOS_HOOK_URL') continue;
    env[k] = v;
  }
  env.TZ = tz;
  env.VAULTOS_AUTOMATION = '1';
  return env;
}

// Runs cmd through a login shell (PATH as in a VaultOS terminal) in its own process group, writes
// input to stdin, and keeps the last OUTPUT_MAX characters of stdout+stderr. A time limit or kill()
// sends SIGTERM to the whole group, then SIGKILL after KILL_GRACE_MS.
function spawnAgent({ cmd, input, cwd, env, timeoutMs }) {
  const child = spawn('bash', ['-lc', cmd], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let timedOut = false;
  let killed = false;
  let hardKill = null;
  const take = (d) => {
    output += d;
    if (output.length > OUTPUT_MAX * 2) output = output.slice(-OUTPUT_MAX);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.stdin.on('error', () => { /* the agent closed stdin early */ });
  const signalGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  const end = () => {
    if (hardKill) return;
    signalGroup('SIGTERM');
    hardKill = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    hardKill.unref();
  };
  const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
  timer.unref();
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolve({ code, signal, timedOut, killed, output: output.slice(-OUTPUT_MAX) });
    };
    child.on('error', (err) => { take(`\n${err.message}\n`); });
    child.on('close', finish);
    // 'close' waits for every holder of the pipes. A child that left the process group (so the group kill
    // missed it) can keep them open for ever: give the output CLOSE_GRACE_MS after the agent exits, then stop reading.
    child.on('exit', (code, signal) => {
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, CLOSE_GRACE_MS).unref();
    });
  });
  if (input !== null && input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  return { done, kill: () => { if (!timedOut) killed = true; end(); } };
}

// relative path → "size:mtimeMs" for every file under dir (not .git), up to max entries.
async function snapshotDir(dir, { max = SNAPSHOT_MAX } = {}) {
  const out = new Map();
  async function walk(d, rel) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= max) return;
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, r);
      else if (e.isFile()) {
        try { const s = await fsp.stat(full); out.set(r, `${s.size}:${s.mtimeMs}`); } catch { /* vanished */ }
      }
    }
  }
  await walk(dir, '');
  return out;
}

function diffSnapshots(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

module.exports = {
  ADAPTERS, AGENT_LABEL, offeredLevels, agentConnectors, agentCommand, prepareAgent, finishAgent, cursorRules, cursorGuard, cursorModelsCommand, parseCursorModels,
  automationEnv, spawnAgent, snapshotDir, diffSnapshots,
};
