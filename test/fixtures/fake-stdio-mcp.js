#!/usr/bin/env node
'use strict';
// A tiny stdio MCP server for tests: lists read_x, answers any call with {"ok":true}.
// Appends each called tool name to the file in FAKE_STDIO_SEEN.
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'read_x', inputSchema: { type: 'object' } }] } });
  else if (m.method === 'tools/call') {
    if (process.env.FAKE_STDIO_SEEN) fs.appendFileSync(process.env.FAKE_STDIO_SEEN, ((m.params && m.params.name) || '') + '\n');
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  } else if (m.method === 'x/echo') send({ jsonrpc: '2.0', id: m.id, result: { text: m.params.text } });
  else send({ jsonrpc: '2.0', id: m.id, result: {} });
});
