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
  if (process.env.FAKE_KEY_OUT && server.headers && server.headers['X-VaultOS-Key']) fs.writeFileSync(process.env.FAKE_KEY_OUT, server.headers['X-VaultOS-Key']);
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
    if (!res.ok) return `error:${res.status}`;
    const msg = JSON.parse(text);
    if (msg.error || !msg.result) return 'error';
    return msg.result.isError ? 'refused' : 'ok';
  } catch { return 'error'; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_PROMPT_OUT) fs.appendFileSync(process.env.FAKE_PROMPT_OUT, input + '\n=====\n');
  const marks = (input.match(/MARK:\S+/g) || []).join(' ');
  const note = (text = 'Fake note.') => `\`\`\`vaultos-note\n${text}${marks ? ` ${marks}` : ''}\n\`\`\`\n`;
  const has = (d) => input.includes(`FAKE:${d}`);
  const mcpCalls = [...input.matchAll(/FAKE:mcp:([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)/g)];
  if (mcpCalls.length) {
    (async () => {
      const marks = [];
      for (const [, id, tool] of mcpCalls) marks.push(`MCP:${tool}:${await callMcp(id, tool)}`);
      process.stdout.write(`ok\n${note(marks.join(' '))}`);
    })();
    return;
  }
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
  // FAKE:card:<KEY or ->:<Title_with_underscores> (repeatable): propose a new card (a vaultos-card block before the
  // note); FAKE:cardsonly leaves the note out.
  const cards = [...input.matchAll(/FAKE:card:([^:\s]+):(\S+)/g)].map(([, key, title]) =>
    `\`\`\`vaultos-card\ntitle: ${title.replace(/_/g, ' ')}\n${key === '-' ? '' : `key: ${key}\n`}goal: Fake goal.\nplan:\n- first\n- second\n\`\`\`\n`).join('');
  if (has('cardsonly')) { process.stdout.write(`ok\n${cards}`); return; }
  if (has('touch')) { fs.writeFileSync('touched.txt', 'x'); process.stdout.write(note('Touched a file.')); return; }
  // FAKE:remind:<YYYY-MM-DD>[@HH:MM]: propose a calendar reminder for the card (a vaultos-remind block before the note).
  const rm = /FAKE:remind:(\S+?)(?:@(\d\d:\d\d))?(?=\s|$)/.exec(input);
  const remind = rm ? `\`\`\`vaultos-remind\ndate: ${rm[1]}\n${rm[2] ? `time: ${rm[2]}\n` : ''}note: Fake reminder.\n\`\`\`\n` : '';
  const up = /FAKE:update:([a-z-]+)/.exec(input);
  if (up) {
    process.stdout.write(`\`\`\`vaultos-update\nstatus: ${up[1]}\nblocked_by: fake blocker\n\`\`\`\n${remind}${note('Proposed a move.')}`);
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
  process.stdout.write(`ok\n${remind}${cards}${note()}`);
});
