'use strict';
// Stand-in for a coding agent in automation tests. Reads the prompt on stdin and acts on the first
// FAKE: directive in it (see test/automation-agents.test.js). Every MARK:<word> token in the prompt is
// echoed into the note, so a test can tell which prompt a card got.
const fs = require('node:fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const marks = (input.match(/MARK:\S+/g) || []).join(' ');
  const note = (text = 'Fake note.') => `\`\`\`vaultos-note\n${text}${marks ? ` ${marks}` : ''}\n\`\`\`\n`;
  const has = (d) => input.includes(`FAKE:${d}`);
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
