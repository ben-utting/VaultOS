'use strict';
// Synthetic vault for the Learn preview (learn-preview, 127.0.0.1:7696) and its e2e (scripts/learn-e2e.js).
//
//   node scripts/learn-sandbox.js <outDir> [--empty] [--off]
//
// Default: Learn and terminals on, the default agent Claude Code, one notebook "Sample notebook" with
//   Sources/sample.txt (a transcript), Sources/doc.pdf, Notes/2026-11-12 study.md (the newest text file in Notes),
//   Studio/old.png. --empty: Learn on with no Learn folder yet. --off: Learn switched off.
// Invented, neutral content only (the repo is public).
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
if (!outDir) { console.error('Usage: node scripts/learn-sandbox.js <outDir> [--empty] [--off]'); process.exit(1); }
const empty = args.includes('--empty');
const off = args.includes('--off');
const HOUR = 3600000;
const put = (rel, data, agoMs = 0) => {
  const f = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  if (agoMs) { const d = new Date(Date.now() - agoMs); fs.utimesSync(f, d, d); }
};

put('.vaultos/settings.json', JSON.stringify({
  version: 1, setupDone: true,
  boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
  features: { today: false, terminal: true, morningRead: false, notes: false, automations: false, learn: !off },
  today: { dir: 'Today', timezone: 'UTC' },
  agent: { profile: 'claude' },
  learn: { dir: 'Learning' },
}, null, 2));
put('Work/_tasks/Board.md', '---\n\nkanban-plugin: board\n\n---\n\n## Backlog\n\n');

if (!empty) {
  const nb = 'Learning/Sample notebook';
  put(`${nb}/Sources/sample.txt`, [
    'Title: How rivers shape the land', 'Channel: A sample channel', 'Link: https://www.youtube.com/watch?v=abcdefghijk',
    'Length: 9:53', 'Fetched: 2026-11-12', '',
    '[0:00] So today I want to talk about rivers, where they start and where they end. Most rivers start high up in the hills.', '',
    '[0:41] Small streams join into bigger ones. By the time a river reaches the sea it carries sand and stones.', '',
  ].join('\n'), 3 * HOUR);
  put(`${nb}/Sources/doc.pdf`, '%PDF-1.4\n% a stand-in, not a real PDF\n', 3 * HOUR);
  put(`${nb}/Notes/2026-11-12 study.md`, [
    '# 2026-11-12', '', '## Where do rivers start?', '', 'Most start high in the hills, where rain gathers into small streams.', '',
    'Sources: sample.txt [0:00]', '',
  ].join('\n'), 2 * HOUR);
  // A 1x1 PNG.
  put(`${nb}/Studio/old.png`, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6a35f0000000049454e44ae426082', 'hex'), HOUR);
}
