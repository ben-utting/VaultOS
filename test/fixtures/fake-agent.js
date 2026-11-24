'use strict';
// Stand-in for a coding agent in automation tests. Reads the prompt on stdin and acts on the first
// FAKE: directive in it (see test/automation-agents.test.js). Every MARK:<word> token in the prompt is
// echoed into the note, so a test can tell which prompt a card got.
const fs = require('node:fs');

// `fake-agent.js models` stands in for `cursor-agent --list-models`; AUTOMATION_TEST_MODELS=fail makes it fail.
if (process.argv[2] === 'models') {
  if (process.env.AUTOMATION_TEST_MODELS === 'fail') {
    process.stderr.write('Error: not signed in\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Available models\n\nauto - Auto (current, default)\ngpt-5 - GPT-5\nclaude-opus-4-8[context=1m,effort=high,fast=false] - Opus 4.8 1M High\n');
  }
  return;
}

// FAKE:mcp:<id>:<tool>: call <tool> on server <id> from the --mcp-config file and say how it went.
async function callMcp(id, tool) {
  const i = process.argv.indexOf('--mcp-config');
  const server = i > 0 ? (JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')).mcpServers || {})[id] : null;
  if (!server || server.type !== 'http') return 'unsupported';
  try {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...(server.headers || {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
    });
    let text = await res.text();
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      const line = text.split(/\r?\n/).find((l) => l.startsWith('data:'));
      text = line ? line.slice(5).trim() : '';
    }
    const msg = JSON.parse(text);
    return msg.result && !msg.result.isError && !msg.error ? 'ok' : 'refused';
  } catch { return 'refused'; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const marks = (input.match(/MARK:\S+/g) || []).join(' ');
  const note = (text = 'Fake note.') => `\`\`\`vaultos-note\n${text}${marks ? ` ${marks}` : ''}\n\`\`\`\n`;
  const has = (d) => input.includes(`FAKE:${d}`);
  const mcpCall = /FAKE:mcp:([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)/.exec(input);
  if (mcpCall) { callMcp(mcpCall[1], mcpCall[2]).then((r) => process.stdout.write(`ok\n${note(`MCP:${mcpCall[2]}:${r}`)}`)); return; }
  if (has('hang')) { process.stdout.write('thinking...\n'); setInterval(() => {}, 1e9); return; }
  if (has('slow')) { setTimeout(() => process.stdout.write(note('Slow note.')), 1200); return; }
  if (has('lines')) { process.stdout.write(note('line one\nline two')); return; }
  if (has('orphan')) {
    // A grandchild in its own process group, holding our stdout open for 12 s after we exit.
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    process.stdout.write(note('Left one behind.'));
    return;
  }
  if (has('crash')) { process.stderr.write('boom\n'); process.exit(3); }
  if (has('none')) { process.stdout.write('I looked but wrote no note.\n'); return; }
  if (has('touch')) { fs.writeFileSync('touched.txt', 'x'); process.stdout.write(note('Touched a file.')); return; }
  const up = /FAKE:update:([a-z-]+)/.exec(input);
  if (up) {
    process.stdout.write(`\`\`\`vaultos-update\nstatus: ${up[1]}\nblocked_by: fake blocker\n\`\`\`\n${note('Proposed a move.')}`);
    return;
  }
  if (has('done')) {
    fs.writeFileSync('task.md', fs.readFileSync('task.md', 'utf8').replace(/^status: .*$/m, 'status: done'));
    process.stdout.write(note('Set it done.'));
    return;
  }
  if (has('flood')) {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 32; i++) process.stdout.write(chunk);
    process.stdout.write(`\n${note('After the flood.')}`);
    return;
  }
  process.stdout.write(`ok\n${note()}`);
});
