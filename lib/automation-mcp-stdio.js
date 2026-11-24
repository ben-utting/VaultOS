#!/usr/bin/env node
'use strict';
// A stdio wrapper for the connectors an agent starts itself (Azure, Azure DevOps), so an automation run stays
// read-only and VaultOS can see what it called:
//   node automation-mcp-stdio.js --id <id> --log <file> -- <command> [args...]
// Messages pass through untouched, except a tools/call is answered here with an isError result when the tool wasn't
// listed (or arrives before any list), or when it would read a secret (see BLOCKED). Every call is appended to the log file as one JSON line.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const STDIO_WRAPPER = __filename;

const parse = (l) => { try { return JSON.parse(l); } catch { return undefined; } };
const isObj = (m) => m !== null && typeof m === 'object' && !Array.isArray(m);

// Per-connector rules for calls the server lists but automations must not make. Azure runs in namespace mode (one
// tool per service, sub-command in arguments.command) or single mode (one tool, `azure`), and even read-only it
// offers reads azmcp itself marks secret: Key Vault secrets, App Service app settings, download URLs, insights.
// So the test looks at the tool name and the sub-command alike, in any namespace.
const AZURE_SECRET = /secret|appsettings|download-url/i;
const BLOCKED = {
  azure: (name, command) => [name, command].some((v) => AZURE_SECRET.test(v) || v.toLowerCase() === 'insights_get'),
};
const BLOCKED_TEXT = (what) => `VaultOS doesn't let automations read secrets, so ${what} is off.`;

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
      const raw = typeof args.command === 'string' ? args.command : '';
      const command = raw;
      const unlisted = !listed.has(name);
      const blocked = !unlisted && !!(BLOCKED[id] && BLOCKED[id](name, command));
      const refused = unlisted || blocked;
      try { log({ id, tool: !raw ? name : (/^[A-Za-z0-9_.-]{1,80}$/.test(raw) ? `${name}:${raw}` : `${name}:?`), refused }); } catch { /* logging must not break the call */ }
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
