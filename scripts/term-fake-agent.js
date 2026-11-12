'use strict';
// Stand-in for Claude Code inside a preview terminal: posts the same hook events to the server so the
// terminal's agent-state badge changes. Run from a preview terminal (it needs VAULTOS_TERM_* in the env):
//
//   node /app/scripts/term-fake-agent.js [--cursor] <working|blocked|done|idle>
//
// Stays in the foreground (so the server sees a busy terminal) and prints "." every 2s.
// Keys: w working, b blocked, d done, i idle, q quit. Esc does what it does to a real Claude mid-turn: it stops
// printing and fires no hook (the server reads Esc then quiet as idle).
// --cursor: posts Cursor's events (agent: cursor, spec 2026-11-12 R2.4) instead. Cursor has no approval event:
// blocked posts beforeShellExecution and stops the dots, so the server sees "a command asked for, then silence";
// w posts beforeSubmitPrompt and starts them again.
const EVENTS = {
  working: ['SessionStart', 'UserPromptSubmit'],
  blocked: ['SessionStart', 'PermissionRequest'],
  done: ['SessionStart', 'UserPromptSubmit', 'Stop'],
  idle: ['SessionStart'],
};
const CURSOR_EVENTS = {
  working: [['sessionStart'], ['beforeSubmitPrompt']],
  blocked: [['sessionStart'], ['beforeSubmitPrompt'], ['beforeShellExecution']],
  done: [['sessionStart'], ['beforeSubmitPrompt'], ['stop', 'completed']],
  idle: [['sessionStart']],
};
const KEYS = { w: 'working', b: 'blocked', d: 'done', i: 'idle' };
const { VAULTOS_TERM_ID: id, VAULTOS_TERM_TOKEN: token, VAULTOS_HOOK_URL: url } = process.env;
const cursor = process.argv[2] === '--cursor';
const first = process.argv[cursor ? 3 : 2];
let quiet = false;   // --cursor blocked: no dots, so the screen is silent
if (!EVENTS[first] || !id || !token || !url) {
  console.error('Usage: node term-fake-agent.js <working|blocked|done|idle>  (inside a VaultOS terminal)');
  process.exit(1);
}

async function post(body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, token, session_id: 'fake', ...body }) });
  if (!r.ok) console.error(`\nhook ${body.hook_event_name} -> ${r.status}`);
}
async function report(state) {
  if (!cursor) { for (const hook_event_name of EVENTS[state]) await post({ hook_event_name }); return; }
  quiet = state === 'blocked';
  // A key sends just the step that changes the state; the first report sends the whole sequence.
  const steps = CURSOR_EVENTS[state];
  for (const [hook_event_name, status] of report.started ? steps.slice(-1) : steps) await post({ agent: 'cursor', hook_event_name, status });
  report.started = true;
}

(async () => {
  await report(first);
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    for (const k of d.toString()) {
      if (k === 'q' || k === '\x03') process.exit(0);
      if (k === '\x1b' && !cursor) { quiet = true; continue; }
      if (KEYS[k]) { if (!cursor) quiet = false; report(KEYS[k]).catch(() => {}); }
    }
  });
  setInterval(() => { if (!quiet) process.stdout.write('.'); }, 2000);
})();
