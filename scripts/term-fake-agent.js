'use strict';
// Stand-in for Claude Code inside a preview terminal: posts the same hook events to the server so the
// terminal's agent-state badge changes. Run from a preview terminal (it needs VAULTOS_TERM_* in the env):
//
//   node /app/scripts/term-fake-agent.js <working|blocked|done|idle>
//
// Stays in the foreground (so the server sees a busy terminal) and prints "." every 2s.
// Keys: w working, b blocked, d done, i idle, q quit.
const EVENTS = {
  working: ['SessionStart', 'UserPromptSubmit'],
  blocked: ['SessionStart', 'PermissionRequest'],
  done: ['SessionStart', 'UserPromptSubmit', 'Stop'],
  idle: ['SessionStart'],
};
const KEYS = { w: 'working', b: 'blocked', d: 'done', i: 'idle' };
const { VAULTOS_TERM_ID: id, VAULTOS_TERM_TOKEN: token, VAULTOS_HOOK_URL: url } = process.env;
const first = process.argv[2];
if (!EVENTS[first] || !id || !token || !url) {
  console.error('Usage: node term-fake-agent.js <working|blocked|done|idle>  (inside a VaultOS terminal)');
  process.exit(1);
}

async function report(state) {
  for (const hook_event_name of EVENTS[state]) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, token, hook_event_name, session_id: 'fake' }),
    });
    if (!r.ok) console.error(`\nhook ${hook_event_name} -> ${r.status}`);
  }
}

(async () => {
  await report(first);
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    for (const k of d.toString()) {
      if (k === 'q' || k === '\x03') process.exit(0);
      if (KEYS[k]) report(KEYS[k]).catch(() => {});
    }
  });
  setInterval(() => process.stdout.write('.'), 2000);
})();
