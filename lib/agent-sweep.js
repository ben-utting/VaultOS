'use strict';
// What runs in a terminal, and its agent's next state (spec 2026-11-12 §3.1, §3.3).
//
// The server sweeps every terminal every 5s, whatever the default agent: it reads the whole command line of the
// terminal's foreground process (foregroundArgv), names the agent (lib/agents.js detectAgent), and asks nextAgent
// what the terminal's agent is now. A state Claude's hook reported is kept, with the fallbacks for what hooks can't
// see; any other agent is working while it prints and idle after 20s of quiet.
const fs = require('node:fs');
const { processState } = require('./agents');

const AGENT_QUIET_MS = 20e3;   // hook says working, but silent this long = interrupted (Esc fires no Stop hook)
const AGENT_DISMISS_MS = 8e3;  // hook says blocked, you pressed a key, then silence = dialog dismissed (Esc fires nothing)
const AGENT_ASK_MS = 3e3;      // Cursor asked to run a command, then this long silent = waiting for your approval
const AGENT_RESUME_MS = 1500;  // …and output within this long again = it carried on (you answered)
const AGENT_ESC_MS = 3e3;      // Esc during a working turn, then this long quiet = the turn was stopped (no hook fires)
const ECHO_MS = 1500;          // output this soon after a keypress or a resize is its echo or a redraw, not work
const RUN_GAP_MS = 2e3;        // a gap longer than this between outputs ends an activity run

// An agent without hooks is judged by its activity run (spec R2.5): act.actStart..act.actLast, the last stretch of
// output with no gap over 2s, leaving out output within 1.5s of your input (t.inputAt) or a resize (t.resizeAt).
function noteOutput(act, { now, inputAt = 0, resizeAt = 0 }) {
  if (now - Math.max(inputAt || 0, resizeAt || 0) < ECHO_MS) return;
  if (now - act.actLast > RUN_GAP_MS) act.actStart = now;
  act.actLast = now;
}

// /proc/<pid>/stat → the terminal's foreground process group (tpgid, the 8th field). The name (2nd field) is in
// brackets and can hold spaces and brackets itself, so the fields are counted from after the last ')'.
function parseTpgid(stat) {
  const s = String(stat || '');
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const rest = s.slice(close + 1).trim().split(/\s+/);   // state ppid pgrp session tty_nr tpgid …
  const n = Number(rest[5]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The shell's foreground process group (pgid: the shell's own pid at a bare prompt) and the whole command line of
// its leader. pgid null and argv [fallback] (node-pty's process name) when /proc can't tell.
function foreground(pid, fallback, read = (p) => fs.readFileSync(p, 'utf8')) {
  let pgid = null;
  try {
    pgid = parseTpgid(read(`/proc/${pid}/stat`));
    if (pgid) {
      const argv = String(read(`/proc/${pgid}/cmdline`) || '').split('\0').filter((a, i, all) => a !== '' || i < all.length - 1);
      if (argv.length && argv[0]) return { pgid, argv };
    }
  } catch { /* gone, or not Linux */ }
  return { pgid, argv: [fallback] };
}
const foregroundArgv = (pid, fallback, read) => foreground(pid, fallback, read).argv;

// A hook event → { state, ask } (state null: the agent has gone), or undefined: an event that changes nothing.
// Claude's names are PascalCase; Cursor's (agent: 'cursor', spec 2026-11-12 R2.4) camelCase. ask: Cursor asked to
// run a command; with its screen then silent, nextAgent reads that as waiting for your approval.
function claudeState(b) {
  switch (b.hook_event_name) {
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit': case 'PostToolUse': return 'working';
    case 'PreToolUse': return b.tool_name === 'AskUserQuestion' ? 'blocked' : 'working';
    case 'PermissionRequest': return 'blocked';
    case 'Notification':
      return ['permission_prompt', 'elicitation_dialog'].includes(b.notification_type) ? 'blocked' : undefined;
    case 'Stop': return 'done';
    case 'SessionEnd': return null;
    default: return undefined;
  }
}
const CURSOR_WORKING = new Set(['beforeSubmitPrompt', 'afterAgentThought', 'preToolUse', 'afterShellExecution', 'postToolUse']);
function hookState(b) {
  if (b && b.agent === 'cursor') {
    const e = b.hook_event_name;
    if (e === 'sessionStart') return { state: 'idle', ask: false };
    if (CURSOR_WORKING.has(e)) return { state: 'working', ask: false };
    if (e === 'beforeShellExecution') return { state: 'working', ask: true };
    if (e === 'stop') return { state: b.status === 'aborted' || b.status === 'error' ? 'idle' : 'done', ask: false };
    if (e === 'sessionEnd') return { state: null };
    return undefined;
  }
  const state = claudeState(b || {});
  return state === undefined ? undefined : { state };
}

// agent: { state, since, kind, via: 'hook'|'proc', sessionId } or null. Returns the same object when nothing
// changed, so the caller can tell the page only about changes.
function nextAgent(agent, { kind, busy, quietMs, activeQuietMs = Infinity, runMs = 0, inputAt, escAt = 0, now }) {
  if (!busy) return null;   // a bare prompt: the agent has exited
  if (agent && agent.via === 'hook' && (kind === null || kind === agent.kind)) {
    // Cursor has no approval hook: it asked to run a command (ask) and its screen went silent, so it waits for you.
    // Real output again (activeQuietMs: not the redraw a focus or a resize causes) means it carried on. Claude's own
    // blocked comes from its hooks and is never inferred.
    if (agent.inferred) {
      if (activeQuietMs >= AGENT_RESUME_MS) return agent;
      const { inferred, ...rest } = agent;
      return { ...rest, state: 'working', ask: false, since: now };
    }
    if (agent.state === 'working' && agent.ask && quietMs > AGENT_ASK_MS) return { ...agent, state: 'blocked', inferred: true, since: now };
    // Esc stops a Claude turn and fires no hook (the Stop menu item sends it too): quiet soon after is idle.
    if (agent.state === 'working' && escAt > agent.since && quietMs > AGENT_ESC_MS) return { ...agent, state: 'idle', since: now };
    if (agent.state === 'working' && quietMs > AGENT_QUIET_MS) return { ...agent, state: 'idle', since: now };
    if (agent.state === 'blocked' && inputAt > agent.since && quietMs > AGENT_DISMISS_MS) return { ...agent, state: 'idle', since: now };
    return agent;
  }
  if (!kind) return null;
  const state = processState({ activeQuietMs, runMs });
  if (agent && agent.kind === kind && agent.via === 'proc' && agent.state === state) return agent;
  return { state, since: now, kind, via: 'proc', sessionId: '' };
}

module.exports = { AGENT_QUIET_MS, AGENT_DISMISS_MS, AGENT_ASK_MS, parseTpgid, foreground, foregroundArgv, hookState, noteOutput, nextAgent };
