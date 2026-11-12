'use strict';
// hooks/vaultos-state.js, the one hook script for Claude and Cursor (spec R2.4): tags each event with its agent and
// forwards only the fields the server maps on. Never prompts, commands or the email in Cursor's payload.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'vaultos-state.js');
const ALLOWED = ['id', 'token', 'agent', 'hook_event_name', 'notification_type', 'tool_name', 'session_id', 'status'];

// Runs the script with the payload on stdin; resolves { posted: body|null, stdout, code }.
function run(args, payload, { termEnv = true } = {}) {
  return new Promise((resolve) => {
    let posted = null;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => { posted = JSON.parse(b); res.end('{"ok":true}'); });
    });
    srv.listen(0, '127.0.0.1', () => {
      const env = { PATH: process.env.PATH };
      if (termEnv) Object.assign(env, { VAULTOS_TERM_ID: 't1', VAULTOS_TERM_TOKEN: 'k1', VAULTOS_HOOK_URL: `http://127.0.0.1:${srv.address().port}/api/term/agent` });
      const p = spawn(process.execPath, [SCRIPT, ...args], { env });
      let stdout = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.on('close', (code) => { srv.close(); resolve({ posted, stdout, code }); });
      p.stdin.end(JSON.stringify(payload));
    });
  });
}

const CURSOR = { hook_event_name: 'beforeShellExecution', command: 'rm -rf x', session_id: 's1', conversation_id: 'c1', cursor_version: '2026.11.11', user_email: 'someone@example.com', workspace_roots: ['/x'] };

test('argv cursor tags the event as Cursor\'s, and only the allowed fields travel', async () => {
  const r = await run(['cursor'], CURSOR);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.posted.agent, 'cursor');
  assert.equal(r.posted.hook_event_name, 'beforeShellExecution');
  assert.deepEqual(Object.keys(r.posted).filter((k) => r.posted[k] !== undefined).sort(), ['agent', 'hook_event_name', 'id', 'session_id', 'token']);
  for (const k of Object.keys(r.posted)) assert.ok(ALLOWED.includes(k), k);
  assert.ok(!JSON.stringify(r.posted).includes('someone@example.com'));
  assert.ok(!JSON.stringify(r.posted).includes('rm -rf'));
});

test('Cursor running Claude\'s hook (no argv) is still Cursor, by its cursor_version', async () => {
  const r = await run([], { ...CURSOR, hook_event_name: 'preToolUse', tool_name: 'Shell' });
  assert.equal(r.posted.agent, 'cursor');
  assert.equal(r.posted.tool_name, 'Shell');
});

test('a Claude event is Claude\'s; stop carries its status', async () => {
  assert.equal((await run([], { hook_event_name: 'Stop', session_id: 's2' })).posted.agent, 'claude');
  assert.equal((await run(['cursor'], { hook_event_name: 'stop', status: 'aborted', cursor_version: 'x' })).posted.status, 'aborted');
});

test('outside a VaultOS terminal it posts nothing and exits 0', async () => {
  const r = await run(['cursor'], CURSOR, { termEnv: false });
  assert.equal(r.posted, null);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
