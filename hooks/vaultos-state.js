#!/usr/bin/env node
'use strict';
// Claude Code hook → VaultOS agent badge. Registered in the container user's
// ~/.claude/settings.json for SessionStart, UserPromptSubmit, PreToolUse,
// PostToolUse, PermissionRequest, Notification, Stop and SessionEnd.
//
// Installed copy lives at /home/coder/.claude/hooks/vaultos-state.js (the
// shared code-server home volume); this file in board/hooks/ is the source.
// Reinstall after editing:
//   docker exec -u 1000 -i vault-board sh -c 'cat > ~/.claude/hooks/vaultos-state.js' < board/hooks/vaultos-state.js
//
// Only does anything inside a VaultOS Workbench terminal, which sets
// VAULTOS_TERM_ID / VAULTOS_TERM_TOKEN / VAULTOS_HOOK_URL. Never blocks Claude:
// no output, short timeout, always exit 0. Node rather than curl because the
// board image has no curl.

const { VAULTOS_TERM_ID: id, VAULTOS_TERM_TOKEN: token, VAULTOS_HOOK_URL: url } = process.env;
if (!id || !token || !url) process.exit(0);

const done = () => process.exit(0);
setTimeout(done, 1500).unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { return done(); }
  // Only the fields the server maps on; tool inputs and prompts stay here.
  const body = JSON.stringify({
    id, token,
    hook_event_name: ev.hook_event_name,
    notification_type: ev.notification_type,
    tool_name: ev.tool_name,
    session_id: ev.session_id,
  });
  try {
    const req = require('http').request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 1200,
    }, (res) => { res.resume(); res.on('end', done); });
    req.on('error', done);
    req.on('timeout', () => { req.destroy(); done(); });
    req.end(body);
  } catch { done(); }
});
