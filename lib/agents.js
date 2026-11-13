'use strict';
// Agent profiles: what VaultOS knows about each supported coding agent.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { atomicWrite } = require('./atomic-write');

// Commands verified in the image on 2026-10-15 (scripts/agent-probe.sh). `short`: the name in the terminal's
// agents list. `proc`: program names the agent runs as. `marks`: fragments of its install path, which find it
// when it runs as a `node` script or behind a wrapper that renames argv[0] (detectAgent).
const npm = (pkg) => `npm install -g --prefix ~/.local ${pkg}`;
const agent = (p) => ({ loginNote: null, hooks: null, marks: [], ...p });
const PROFILES = {
  claude: agent({
    id: 'claude', label: 'Claude Code', short: 'Claude', maker: 'Anthropic', tier: 'tested', detect: ['claude'], proc: ['claude'], marks: ['@anthropic-ai/claude-code'],
    install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'claude', start: 'claude {prompt}', hooks: 'claude',
  }),
  cursor: agent({
    id: 'cursor', label: 'Cursor CLI', short: 'Cursor', maker: 'Cursor', tier: 'tested', detect: ['agent', 'cursor-agent'], proc: ['agent', 'cursor-agent'], marks: ['/cursor-agent/'],
    install: 'curl https://cursor.com/install -fsS | bash', login: 'NO_OPEN_BROWSER=1 agent login', start: 'agent {prompt}',
  }),
  pi: agent({
    id: 'pi', label: 'Pi', short: 'Pi', maker: 'pi.dev', tier: 'tested', detect: ['pi'], proc: ['pi'], marks: ['pi-coding-agent'],
    install: npm('@mariozechner/pi-coding-agent'), login: 'pi', loginNote: 'Then type /login', start: 'pi {prompt}',
  }),
  codex: agent({
    id: 'codex', label: 'Codex CLI', short: 'Codex', maker: 'OpenAI', tier: 'more', detect: ['codex'], proc: ['codex'], marks: ['@openai/codex'],
    install: npm('@openai/codex'), login: 'codex login --device-auth', start: 'codex {prompt}',
  }),
  antigravity: agent({
    id: 'antigravity', label: 'Antigravity CLI', short: 'Antigravity', maker: 'Google', tier: 'more', detect: ['agy'], proc: ['agy'],
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', login: 'agy', loginNote: 'Sign in when it asks', start: 'agy -i {prompt}',
  }),
  copilot: agent({
    id: 'copilot', label: 'Copilot CLI', short: 'Copilot', maker: 'GitHub', tier: 'more', detect: ['copilot'], proc: ['copilot'], marks: ['@github/copilot'],
    install: npm('@github/copilot'), login: 'copilot', loginNote: 'Then type /login', start: 'copilot -i {prompt}',
  }),
  opencode: agent({
    id: 'opencode', label: 'OpenCode', short: 'OpenCode', maker: 'open source', tier: 'more', detect: ['opencode'], proc: ['opencode'], marks: ['opencode-ai'],
    install: npm('opencode-ai'), login: 'opencode auth login', start: 'opencode --prompt {prompt}',
  }),
  kilo: agent({
    id: 'kilo', label: 'Kilo CLI', short: 'Kilo', maker: 'Kilo', tier: 'more', detect: ['kilo'], proc: ['kilo', '.kilo'], marks: ['@kilocode/cli'],
    install: npm('@kilocode/cli'), login: 'kilo auth login', start: 'kilo --prompt {prompt}',
  }),
};
// Every profile settings.json takes, in the order the picker shows them.
const PROFILE_IDS = [...Object.keys(PROFILES), 'custom', 'none'];

const KICKOFF_PROMPT = 'Catch me up on this task from task.md (Plan, Progress log, Comments). Keep it to a few short lines: where it stands, the one next step, and anything blocked or waiting on me. Do not start the work or change any files until I say so.';

// Ben has ADHD: when the i-have-adhd skill is installed, the check-in opens with its slash command so the reply
// comes back short and shaped for him (the skill stays on for the whole session). Claude Code and the Cursor CLI
// take a `/skill` as their first prompt (Cursor checked on the work laptop 2026-10-30); the others are not known
// to, and an agent without the skill would answer "unknown command", so the skill folder is looked for first.
const ADHD_SKILL = 'i-have-adhd';
const ADHD_SKILL_DIRS = { claude: ['.claude/skills'], cursor: ['.cursor/skills', '.agents/skills', '.claude/skills'] };
// Learn mode's start buttons: the agent opens in a notebook folder and briefs Ben on where his studying stands.
const LEARN_KICKOFF = 'Tell me which sources this notebook has and where the newest study log in Notes/ stopped, in a few short lines. Then wait for my question.';

function kickoffPrompt(profile, home = process.env.HOME, base = KICKOFF_PROMPT) {
  const dirs = (profile && ADHD_SKILL_DIRS[profile.id]) || [];
  if (home && dirs.some((d) => fs.existsSync(path.join(home, d, ADHD_SKILL, 'SKILL.md')))) {
    return `/${ADHD_SKILL} ${base}`;
  }
  return base;
}

const HOOK_CMD = '[ -n "$VAULTOS_TERM_ID" ] && node "$HOME/.claude/hooks/vaultos-state.js" || true';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];

// settings.agent comes from lib/settings.js.
function profileFor(settings) {
  const a = settings && settings.agent;
  if (!a || a.profile === 'none') return null;
  if (a.profile === 'custom') {
    const c = a.custom;
    return {
      id: 'custom', label: c.label, short: c.label, detect: [c.detect], proc: [c.detect], marks: [],
      install: c.install, login: c.login, start: c.start, hooks: null, loginNote: null,
    };
  }
  return PROFILES[a.profile] || null;
}

// Every agent a terminal may be running, whatever the default: the built-ins in PROFILE_IDS order, then a saved
// custom agent (it is detected last, so it never shadows a built-in).
function agentProfiles(settings) {
  const list = PROFILE_IDS.filter((id) => PROFILES[id]).map((id) => PROFILES[id]);
  const c = settings && settings.agent && settings.agent.custom;
  if (c && c.detect) list.push(profileFor({ agent: { profile: 'custom', custom: c } }));
  return list;
}

// Which agent a terminal's foreground process is, from its whole command line, or null. In profile order, the
// first agent where: argv[0]'s name is one of its programs; or argv[0] is an interpreter and its script (the first
// argument that isn't a flag) is; or any argument holds one of its install-path marks.
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'python', 'python3']);
// A package manager is an agent only while it runs one (npx, npm exec, pnpm dlx, bunx), never while it installs or
// looks one up: Settings → Install runs `npm install … @openai/codex` in a terminal.
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_SUBCOMMANDS = new Set(['exec', 'x', 'dlx']);
function detectAgent(argv, profiles) {
  if (!Array.isArray(argv) || !argv.length || !argv[0]) return null;
  // A process title (npm sets one): the whole command in argv[0], the rest NUL padding. A first word with a '/'
  // is a path that happens to hold a space, not a title.
  const first = String(argv[0]).trim();
  if (/\s/.test(first) && !first.split(/\s+/)[0].includes('/') && argv.slice(1).every((a) => a === '')) argv = first.split(/\s+/);
  const name = path.basename(String(argv[0]));
  if (RUNNERS.has(name)) {
    const sub = argv.slice(1).find((a) => a && !String(a).startsWith('-'));
    if (!RUN_SUBCOMMANDS.has(sub)) return null;
  }
  const script = INTERPRETERS.has(name) ? argv.slice(1).find((a) => a && !String(a).startsWith('-')) : null;
  const scriptName = script ? path.basename(String(script)) : null;
  for (const p of profiles || []) {
    const proc = p.proc || [];
    if (proc.includes(name) || (scriptName && proc.includes(scriptName))) return p.id;
    if ((p.marks || []).some((m) => argv.some((a) => String(a).includes(m)))) return p.id;
  }
  return null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function startCommand(profile, prompt) {
  return profile.start.split('{prompt}').join(shellQuote(prompt));
}
// The agent on its own, with no prompt: what agents + in a terminal space starts (`claude`, `agent`). A flag
// right before {prompt} only carries the prompt (`copilot -i {prompt}`, `opencode --prompt {prompt}`), so it goes too.
function plainStartCommand(profile) {
  return String((profile && profile.start) || '')
    .replace(/\s+-{1,2}[A-Za-z][\w-]*\s+(['"]?)\{prompt\}\1/g, '')
    .split('{prompt}').join('')
    .replace(/\s+/g, ' ').trim();
}

// A login shell, so PATH matches a VaultOS terminal (which runs bash -l).
function defaultRun(cmd) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', cmd], { env: process.env, timeout: 10000 }, (err) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
    });
  });
}

async function isInstalled(profile, { run = defaultRun } = {}) {
  for (const name of profile.detect) {
    const r = await run(`command -v -- ${shellQuote(name)}`);
    if (r && r.code === 0) return true;
  }
  return false;
}

// Guarded like HOOK_CMD: ~/.claude is shared with containers that have no node and
// no /app (vault-code), and a rollback to an older image drops the script.
const recallCmd = (script) => `[ -f "${script}" ] && command -v node >/dev/null 2>&1 && node "${script}" || true`;
const KEEP_SESSIONS_DAYS = 36500; // Claude deletes sessions after 30 days unless told otherwise

// Copy the hook script and register it for every event, without touching
// anything else in settings.json. With recallScript, also register the Knowledge
// Base recall hook on UserPromptSubmit; it runs in place, so it is not copied.
// Sessions are kept unless the user already chose a cleanupPeriodDays.
// Returns whether anything changed.
async function installClaudeHook(home, hookSrc, recallScript) {
  const dir = path.join(home, '.claude');
  const hookDst = path.join(dir, 'hooks', 'vaultos-state.js');
  const src = await fsp.readFile(hookSrc, 'utf8');
  let changed = false;

  await fsp.mkdir(path.dirname(hookDst), { recursive: true });
  let cur = null;
  try { cur = await fsp.readFile(hookDst, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (cur !== src) { await atomicWrite(hookDst, src); changed = true; }

  const file = path.join(dir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let edited = false;
  for (const ev of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    const has = settings.hooks[ev].some((g) => g && Array.isArray(g.hooks) &&
      g.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes('vaultos-state.js')));
    if (!has) {
      settings.hooks[ev].push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] });
      edited = true;
    }
  }
  if (recallScript) {
    const groups = settings.hooks.UserPromptSubmit;
    const has = groups.some((g) => g && Array.isArray(g.hooks) &&
      g.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes('vault-recall.js')));
    if (!has) {
      groups.push({ hooks: [{ type: 'command', command: recallCmd(recallScript), timeout: 5 }] });
      edited = true;
    }
  }
  if (settings.cleanupPeriodDays === undefined) {
    settings.cleanupPeriodDays = KEEP_SESSIONS_DAYS;
    edited = true;
  }
  if (edited) {
    await atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
    changed = true;
  }
  return changed;
}

// Cursor's hooks (spec 2026-11-12 R2.4). Only these names are ever written: one Cursor doesn't know makes it drop
// the whole file. The guard runs the shared hook script inside a VaultOS terminal and is silent anywhere else
// (~/.cursor is shared with code-server), draining stdin so Cursor never waits on a pipe.
const CURSOR_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'afterAgentThought', 'preToolUse', 'beforeShellExecution',
  'afterShellExecution', 'postToolUse', 'stop', 'sessionEnd'];
const CURSOR_GUARD = `#!/bin/sh
# VaultOS: Cursor's events -> the terminal's agent state (installed by VaultOS; safe to delete with its hooks.json entries).
if [ -n "$VAULTOS_TERM_ID" ] && command -v node >/dev/null 2>&1; then exec node "$(dirname "$0")/vaultos-state.js" cursor; fi
cat >/dev/null
exit 0
`;

// Copy the hook script and its guard into ~/.cursor/hooks/ and add the guard to ~/.cursor/hooks.json for each
// event, keeping every other key and entry. A hooks.json it can't safely extend (not valid JSON, hooks not an
// object, one of our events not a list, a version other than 1) is left untouched, nothing else is written, and
// `log` says why. Returns whether anything changed.
async function installCursorHook(home, hookSrc, { log = () => {} } = {}) {
  const dir = path.join(home, '.cursor');
  const file = path.join(dir, 'hooks.json');
  const leave = (why) => { log(`cursor hook: ~/.cursor/hooks.json left as it is (${why}); Cursor won't report its state`); return false; };
  let cfg = {};
  try {
    cfg = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return leave(e instanceof SyntaxError ? 'not valid JSON' : `unreadable: ${e.code || e.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return leave('not a JSON object');
  if (cfg.version !== undefined && cfg.version !== 1) return leave(`version ${JSON.stringify(cfg.version)}`);
  if (cfg.hooks !== undefined && (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks))) return leave('"hooks" is not an object');
  const odd = CURSOR_HOOK_EVENTS.find((ev) => cfg.hooks && cfg.hooks[ev] !== undefined && !Array.isArray(cfg.hooks[ev]));
  if (odd) return leave(`"${odd}" is not a list`);

  const hooksDir = path.join(dir, 'hooks');
  const jsDst = path.join(hooksDir, 'vaultos-state.js');
  const shDst = path.join(hooksDir, 'vaultos-state.sh');
  let changed = false;
  await fsp.mkdir(hooksDir, { recursive: true });
  const src = await fsp.readFile(hookSrc, 'utf8');
  const read = async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  if ((await read(jsDst)) !== src) { await atomicWrite(jsDst, src); changed = true; }
  if ((await read(shDst)) !== CURSOR_GUARD) { await atomicWrite(shDst, CURSOR_GUARD); changed = true; }
  const mode = (await fsp.stat(shDst)).mode;
  if ((mode & 0o755) !== 0o755) { await fsp.chmod(shDst, 0o755); changed = true; }

  const next = { ...cfg, version: cfg.version === undefined ? 1 : cfg.version, hooks: { ...(cfg.hooks || {}) } };
  let edited = cfg.version === undefined;
  for (const ev of CURSOR_HOOK_EVENTS) {
    const list = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : [];
    if (list.some((h) => h && typeof h.command === 'string' && h.command.includes('vaultos-state'))) continue;
    next.hooks[ev] = [...list, { command: shDst }];
    edited = true;
  }
  if (edited) { await atomicWrite(file, JSON.stringify(next, null, 2) + '\n'); changed = true; }
  return changed;
}

// A terminal's card and whether it is the agent's own. Start agent names its task (explicit); a terminal merely
// opened inside a job folder is linked to that card (found) but is not the agent's.
function terminalTask({ explicit, found }) {
  if (explicit) return { task: explicit, agentTerm: true };
  return { task: found || '', agentTerm: false };
}

// An agent without hooks: working while it prints steadily (a run of at least 2s, some of it in the last 8s),
// otherwise idle. The run (lib/agent-sweep.js noteOutput) leaves out your own echo and redraws after a resize.
function processState({ activeQuietMs, runMs }) {
  return activeQuietMs < 8e3 && runMs >= 2e3 ? 'working' : 'idle';
}

module.exports = {
  PROFILES, PROFILE_IDS, KICKOFF_PROMPT, LEARN_KICKOFF, kickoffPrompt, HOOK_CMD, HOOK_EVENTS,
  recallCmd, profileFor, agentProfiles, detectAgent, CURSOR_HOOK_EVENTS, installCursorHook, shellQuote, startCommand, plainStartCommand, isInstalled, installClaudeHook, processState, terminalTask,
};
