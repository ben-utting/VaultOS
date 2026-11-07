'use strict';
// Synthetic vault for the Notes preview (notes-preview, 127.0.0.1:7695) and its e2e (scripts/notes-e2e.js).
//
//   node scripts/notes-sandbox.js <outDir>
//
// Notes/ at the default folder names. What the e2e relies on:
//   Inbox: 3 rough notes; "Old idea" is 9 days old (the "old" mark), the others hours old.
//   Main:  Small steps compound (child, [[habits]]), Tools shape thinking (baby, [[tools]]),
//          Rest is part of work (adult, [[habits]] [[work]]). Small steps links to [[Tools shape thinking]],
//          [[Missing note]] and [[Sample Book]] (a source note, which opens in Files).
//   Tags: habits, tools, work.   Sources/Books/Sample Book.md.   Templates/Note.md.
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
if (!outDir) { console.error('Usage: node scripts/notes-sandbox.js <outDir>'); process.exit(1); }
const HOUR = 3600000;
const put = (rel, text, agoMs = 0) => {
  const f = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  if (agoMs) { const d = new Date(Date.now() - agoMs); fs.utimesSync(f, d, d); }
};
const main = (title, status, tags, body, refs = '') =>
  `2026-10-20 08:00\n\nStatus #${status}\n\nTags ${tags.map((t) => `[[${t}]]`).join(' ')}\n\n## ${title}\n${body}\n\n## References\n${refs}\n`;

put('.vaultos/settings.json', JSON.stringify({
  version: 1, setupDone: true,
  boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
  features: { today: false, terminal: false, morningRead: false, notes: true },
  today: { dir: 'Work/Today', timezone: 'Europe/London' },
}, null, 2) + '\n');
put('Work/_tasks/Board.md', '---\n\nkanban-plugin: board\n\n---\n');
put('Work/01-sample-job/task.md', '---\ntitle: Sample job\nstatus: in-progress\nupdated: 2026-10-31\n---\n\n## Goal\nA card so the Board has something.\n');

put('Notes/Inbox/2026-11-01 0830 Walks help me think.md', '2026-11-01 08:30\n\nWalks help me think\n', 2 * HOUR);
put('Notes/Inbox/2026-10-31 2015 Ask about the timetable.md', '2026-10-31 20:15\n\nAsk about the timetable\nand the second stop\n', 5 * HOUR);
put('Notes/Inbox/Old idea.md', 'An old idea that sat here\n', 9 * 24 * HOUR);

put('Notes/Main/Small steps compound.md', main('Small steps compound', 'child', ['habits'],
  'Tiny changes add up. This links to [[Tools shape thinking]] and to [[Missing note]].', '[[Sample Book#12]]'), 1 * HOUR);
put('Notes/Main/Tools shape thinking.md', main('Tools shape thinking', 'baby', ['tools'], 'What I write with changes what I write.'), 3 * HOUR);
put('Notes/Main/Rest is part of work.md', main('Rest is part of work', 'adult', ['habits', 'work'], 'Stopping is part of the job.'), 4 * HOUR);

for (const t of ['habits', 'tools', 'work']) put(`Notes/Tags/${t}.md`, '');
put('Notes/Sources/Books/Sample Book.md', '# Sample Book\n\n## 12\n"A quote."\n\nMy words about it.\n');
put('Notes/Templates/Note.md', '{{date}} {{time}}\n\nStatus\n\nTags\n\n## {{Title}}\n\n\n## References\n');
