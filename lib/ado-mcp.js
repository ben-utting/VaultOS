#!/usr/bin/env node
'use strict';
// VaultOS's wrapper around Microsoft's Azure DevOps MCP server, which agents start over stdio:
//   node ado-mcp.js --server <path to mcp-server-azuredevops> --org <organization> [--allow-changes]
// It starts the server with `--authentication azcli` (the Azure connector's `az` login) and passes every message
// through untouched, except: without --allow-changes, tools that change something are left out of tools/list, and a
// call to one is answered here with an isError result instead of reaching Azure DevOps (see connector-ado.js).
const { spawn } = require('node:child_process');
const { allowed, READ_ONLY_TEXT } = require('./connector-ado');

function parseArgs(argv) {
  const o = { allowChanges: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server') o.server = argv[++i];
    else if (argv[i] === '--org') o.org = argv[++i];
    else if (argv[i] === '--allow-changes') o.allowChanges = true;
  }
  return o;
}

// One newline-delimited JSON-RPC stream -> lines, each handed to onLine (without the newline).
function lines(stream, onLine, onEnd) {
  let buf = '';
  stream.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  stream.on('end', () => { if (buf) onLine(buf); buf = ''; if (onEnd) onEnd(); });
}

// The filter, kept apart from the process plumbing so the tests can drive it.
// toServer(line) / toClient(line) send a line on; fromClient / fromServer take one line each.
function createFilter({ allowChanges, toServer, toClient }) {
  const lists = new Set(); // ids of the client's tools/list requests still waiting for an answer
  const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
  function fromClient(line) {
    const m = allowChanges ? null : parse(line);
    if (m && m.method === 'tools/list' && m.id !== undefined) lists.add(JSON.stringify(m.id));
    if (m && m.method === 'tools/call' && m.id !== undefined && m.params && !allowed(m.params.name, m.params.arguments)) {
      toClient(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: READ_ONLY_TEXT }], isError: true } }));
      return;
    }
    toServer(line);
  }
  function fromServer(line) {
    if (!lists.size) return toClient(line);
    const m = parse(line);
    const key = m && m.method === undefined && m.id !== undefined ? JSON.stringify(m.id) : null;
    if (!key || !lists.has(key)) return toClient(line);
    lists.delete(key);
    if (m.result && Array.isArray(m.result.tools)) {
      m.result.tools = m.result.tools.filter((t) => t && allowed(t.name, null));
      return toClient(JSON.stringify(m));
    }
    toClient(line);
  }
  return { fromClient, fromServer };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.server || !o.org) {
    process.stderr.write('usage: ado-mcp.js --server <mcp-server-azuredevops> --org <organization> [--allow-changes]\n');
    process.exit(2);
  }
  const child = spawn(o.server, [o.org, '--authentication', 'azcli'], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => {
    process.stderr.write(e && e.code === 'ENOENT'
      ? `Azure DevOps isn't installed (${o.server} is missing). Install it from Settings → Connectors in VaultOS.\n`
      : `Couldn't start Azure DevOps: ${(e && e.message) || e}\n`);
    process.exit(1);
  });
  child.stdin.on('error', () => {});
  const f = createFilter({
    allowChanges: o.allowChanges,
    toServer: (l) => { try { child.stdin.write(l + '\n'); } catch { /* the close handler ends us */ } },
    toClient: (l) => process.stdout.write(l + '\n'),
  });
  lines(process.stdin, f.fromClient, () => { try { child.stdin.end(); } catch { /* gone */ } });
  lines(child.stdout, f.fromServer);
  child.on('close', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
}

if (require.main === module) main();

module.exports = { parseArgs, createFilter };
