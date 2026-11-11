'use strict';
// How an automation starts an agent with no terminal (spec §5): the command per agent and level,
// spawning it in its own process group with a time limit, and the before/after file lists that
// catch a read-only run that changed something anyway. Commands were checked on 2026-11-11 (spec,
// "Decisions made during implementation"): an agent/level pair is offered only once it has been
// shown to stay read-only (Report/Update) or inside the card folder (Work).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shellQuote } = require('./agents');

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
const ADAPTERS = {
  claude: {
    levels: ['report', 'update', 'work'],
    command: (level, prompt) => ({
      cmd: join([...CLAUDE, ...(level === 'work'
        ? ['--tools', 'Read,Grep,Glob,Edit,Write', '--permission-mode', 'acceptEdits']
        : ['--tools', 'Read,Grep,Glob'])]),
      input: prompt,
    }),
  },
  // Pi: read-only worked (2026-11-11), but its tools have no folder limit, for reads as much as writes, so a
  // card could have it read files outside its folder (credentials) into a note. Not offered until confined.
  pi: {
    levels: [],
    command: (level, prompt) => ({ cmd: join(['pi', '-p', '--tools', 'read,grep,find,ls', '--no-session', '--no-extensions']), input: prompt }),
  },
  // Cursor CLI: not offered until checked on a machine where it is signed in (candidate: agent -p --mode ask --trust).
};

const testAgent = () => process.env.AUTOMATION_TEST_AGENT || '';

function offeredLevels(agentId) {
  if (testAgent()) return ['report', 'update', 'work'];
  return ADAPTERS[agentId] ? [...ADAPTERS[agentId].levels] : [];
}

function agentCommand(agentId, level, prompt) {
  if (testAgent()) return { cmd: `${q(process.execPath)} ${q(testAgent())} ${level}`, input: prompt };
  if (!offeredLevels(agentId).includes(level)) {
    return { error: `${AGENT_LABEL[agentId] || agentId} is not available for automations at the ${LEVEL_LABEL[level] || level} level` };
  }
  return ADAPTERS[agentId].command(level, prompt);
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

module.exports = { ADAPTERS, AGENT_LABEL, offeredLevels, agentCommand, automationEnv, spawnAgent, snapshotDir, diffSnapshots };
