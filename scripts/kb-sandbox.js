'use strict';
// Synthetic vault for the KB-reading preview (kb-preview, 127.0.0.1:7693) and its e2e tests.
//
//   node scripts/kb-sandbox.js <outDir> --zone=<IANA zone>   → writes the vault tree under <outDir>
//
// The zone becomes Today's time zone, which the morning read's 05:00-12:00 window is judged in, so
// reset.sh passes one where it is 08:00 right now (test/helpers/zone.js). Dates count back from today
// there (D). What the e2e relies on:
//   Personal: 01 Long read (D-1, unread, ~7 min), 02 Short note (D-40, read D-50: updated since),
//             03 Moved job (in _done/, D-60, read D-45: stale), 04 Draft idea (draft, D-5, unread).
//   Work:   05 Work runbook (D-2, unread).   Business: no articles.
// So the morning pick on Personal is Short note, for "Updated since you read it".
const fs = require('fs');
const path = require('path');
const { zonedDate, addDays } = require('../lib/today-note');

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
const zoneArg = args.find((a) => a.startsWith('--zone='));
if (!outDir || !zoneArg) {
  console.error('Usage: node scripts/kb-sandbox.js <outDir> --zone=<IANA zone>');
  process.exit(1);
}
const ZONE = zoneArg.slice('--zone='.length);
const D = zonedDate(new Date(), ZONE);
const ago = (n) => addDays(D, -n);
const noonUTC = (n) => Date.parse(`${ago(n)}T12:00:00Z`);

const put = (rel, text) => {
  const f = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

const SENTENCES = [
  'The proxy sat in front of every app and forwarded each request by its host name.',
  'A certificate renewed itself every sixty days, and nobody had to remember to do it.',
  'When the tunnel dropped, the health check noticed within a minute and restarted it.',
  'Logs went to one place, so a failure at night could be read in the morning.',
  'Each change was written down first, which made the rollback a single command.',
];
const prose = (words) => {
  const out = [];
  let n = 0;
  for (let i = 0; n < words; i++) {
    const s = SENTENCES[i % SENTENCES.length];
    out.push(s);
    n += s.split(' ').length;
  }
  return out.join(' ');
};
const article = ({ title, updated, status, tldr, sections }) => [
  '---', 'type: article', `title: "${title}"`, ...(status ? [`status: ${status}`] : []), `updated: ${updated}`, '---', '',
  `> **TL;DR** ${tldr}`, '',
  ...sections.flatMap(([h, words]) => [`## ${h}`, '', prose(words), '']),
].join('\n');
const BOARD = ['---', '', 'kanban-plugin: board', '', '---', ''].join('\n');

put('.vaultos/settings.json', JSON.stringify({
  version: 1, setupDone: true,
  boards: [
    { key: 'personal', dir: 'Personal', label: 'Personal', hidden: false },
    { key: 'work', dir: 'Work', label: 'Work', hidden: false },
    { key: 'business', dir: 'Business', label: 'Business', hidden: false },
  ],
  features: { today: false, terminal: false, morningRead: true },
  today: { dir: 'Personal/Today', timezone: ZONE },
  agent: { profile: 'none' },
}, null, 2) + '\n');
for (const b of ['Personal', 'Work', 'Business']) put(`${b}/_tasks/Board.md`, BOARD);

put('Personal/1. apps/01-long-read/article.md', article({
  title: 'Long read', updated: ago(1), tldr: 'A long article, so its end is several screens down.',
  sections: ['Why', 'What changed', 'How it works', 'Setup', 'Checks', 'Rollback', 'Costs', 'Next'].map((h) => [h, 160]),
}));
put('Personal/1. apps/02-short-note/article.md', article({
  title: 'Short note', updated: ago(40), tldr: 'A note short enough to fit on one screen.', sections: [['Note', 50]],
}));
put('Personal/1. apps/_done/03-moved-job/article.md', article({
  title: 'Moved job', updated: ago(60), tldr: 'A finished job, moved into _done/ after it was read.', sections: [['Outcome', 140]],
}));
put('Personal/2. platform/04-draft-idea/article.md', article({
  title: 'Draft idea', status: 'draft', updated: ago(5), tldr: 'Not published yet.', sections: [['Idea', 60]],
}));
put('Work/1. ops/05-work-runbook/article.md', article({
  title: 'Work runbook', updated: ago(2), tldr: 'What to do when the overnight job fails.', sections: [['Steps', 120]],
}));

put('.vaultos/kb-reads.json', JSON.stringify({
  version: 1,
  articles: { personal: { '02-short-note': { read: noonUTC(50) }, '03-moved-job': { read: noonUTC(45) } } },
  morning: null,
}, null, 2) + '\n');
