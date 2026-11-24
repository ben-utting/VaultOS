#!/usr/bin/env node
'use strict';
// A stdio wrapper for the connectors an agent starts itself (Azure, Azure DevOps), so an automation run stays
// read-only and VaultOS can see what it called:
//   node automation-mcp-stdio.js --id <id> --log <file> -- <command> [args...]
// Messages pass through untouched, except a tools/call for a tool the server didn't list (or that arrives before
// any list) is answered here with an isError result. Every call is appended to the log file as one JSON line.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const STDIO_WRAPPER = __filename;

const parse = (l) => { try { return JSON.parse(l); } catch { return undefined; } };
const isObj = (m) => m !== null && typeof m === 'object' && !Array.isArray(m);

// Per-connector rules for calls the server lists but automations must not make. Azure runs in namespace mode: one
// tool per service, with the sub-command in arguments.command, and even read-only it offers Key Vault secret values.
const BLOCKED = {
  azure: (name, command) => (name === 'keyvault' && /secret/i.test(command)) || /^keyvault_secret/i.test(name),
};
const BLOCKED_TEXT = (what) => `VaultOS doesn't let automations read Key Vault secrets, so ${what} is off.`;

// The filter, kept apart from the process plumbing so the tests can drive it.
function createFilter({ id, log }) {
  const listed = new Set();
  const lists = new Set(); // ids of forwarded tools/list requests still waiting for an answer
  const key = (v) => JSON.stringify(v);

  function fromAgent(line) {
    if (!line.trim()) return {};
    const m = parse(line);
    if (m === undefined || (m !== null && typeof m !== 'object')) {
      return { reply: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
    }
    if (Array.isArray(m)) {
      const errs = m.filter((x) => isObj(x) && x.id !== undefined && x.id !== null).map((x) => ({
        jsonrpc: '2.0', id: x.id, error: { code: -32600, message: 'Send this request on its own.' },
      }));
      return errs.length ? { reply: JSON.stringify(errs) } : {};
    }
    if (isObj(m) && m.method === 'tools/list' && m.id !== undefined) lists.add(key(m.id));
    if (isObj(m) && m.method === 'tools/call') {
      const name = m.params && typeof m.params.name === 'string' ? m.params.name : '';
      const args = m.params && isObj(m.params.arguments) ? m.params.arguments : {};
      const command = typeof args.command === 'string' ? args.command : '';
      const unlisted = !listed.has(name);
      const blocked = !unlisted && !!(BLOCKED[id] && BLOCKED[id](name, command));
      const refused = unlisted || blocked;
      try { log({ id, tool: command ? `${name}:${command}` : name, refused }); } catch { /* logging must not break the call */ }
      if (!refused) return { forward: line };
      if (m.id === undefined) return {};
      const text = blocked ? BLOCKED_TEXT(command || name) : `VaultOS has ${id} read-only for automations, so ${name} is off.`;
      return { reply: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text }] } }) };
    }
    return { forward: line };
  }

  function fromServer(line) {
    if (!lists.size) return line;
    const m = parse(line);
    if (!isObj(m) || m.method !== undefined || m.id === undefined || !lists.has(key(m.id))) return line;
    lists.delete(key(m.id));
    if (m.result && Array.isArray(m.result.tools)) {
      for (const t of m.result.tools) if (t && typeof t.name === 'string') listed.add(t.name);
    }
    return line;
  }
  return { fromAgent, fromServer };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') o.id = argv[++i];
    else if (argv[i] === '--log') o.log = argv[++i];
    else if (argv[i] === '--') { o.command = argv[i + 1]; o.args = argv.slice(i + 2); break; }
  }
  return o;
}

function lines(stream, onLine, onEnd) {
  let buf = '';
  stream.setEncoding('utf8'); // a StringDecoder keeps a character split across two reads whole
  stream.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  stream.on('end', () => { if (buf) onLine(buf); buf = ''; if (onEnd) onEnd(); });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.id || !o.log || !o.command) {
    process.stderr.write('usage: automation-mcp-stdio.js --id <id> --log <file> -- <command> [args...]\n');
    process.exit(2);
  }
  const child = spawn(o.command, o.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => {
    process.stderr.write(`Couldn't start ${o.id}: ${(e && e.message) || e}\n`);
    process.exit(1);
  });
  child.stdin.on('error', () => {});
  const f = createFilter({ id: o.id, log: (e) => fs.appendFileSync(o.log, JSON.stringify(e) + '\n', { mode: 0o600 }) });
  lines(process.stdin, (l) => {
    const r = f.fromAgent(l);
    if (r.reply) process.stdout.write(r.reply + '\n');
    if (r.forward !== undefined) { try { child.stdin.write(r.forward + '\n'); } catch { /* the close handler ends us */ } }
  }, () => { try { child.stdin.end(); } catch { /* gone */ } });
  lines(child.stdout, (l) => process.stdout.write(f.fromServer(l) + '\n'));
  child.on('close', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
}

if (require.main === module) main();

module.exports = { createFilter, parseArgs, STDIO_WRAPPER };
