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

// agent: { state, since, kind, via: 'hook'|'proc', sessionId } or null. Returns the same object when nothing
// changed, so the caller can tell the page only about changes.
function nextAgent(agent, { kind, busy, quietMs, inputAt, now }) {
  if (!busy) return null;   // a bare prompt: the agent has exited
  if (agent && agent.via === 'hook' && (kind === null || kind === agent.kind)) {
    if (agent.state === 'working' && quietMs > AGENT_QUIET_MS) return { ...agent, state: 'idle', since: now };
    if (agent.state === 'blocked' && inputAt > agent.since && quietMs > AGENT_DISMISS_MS) return { ...agent, state: 'idle', since: now };
    return agent;
  }
  if (!kind) return null;
  const state = processState({ running: true, quietMs });
  if (agent && agent.kind === kind && agent.via === 'proc' && agent.state === state) return agent;
  return { state, since: now, kind, via: 'proc', sessionId: '' };
}

module.exports = { AGENT_QUIET_MS, AGENT_DISMISS_MS, parseTpgid, foreground, foregroundArgv, nextAgent };
