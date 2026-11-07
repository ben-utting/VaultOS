'use strict';
// Synthetic vault for the Today-mode preview (:7691) and its e2e tests.
//
//   node scripts/today-sandbox.js <outDir> [--date=YYYY-MM-DD]   → writes the vault tree under <outDir>
//
// Deterministic for a given date D (default: today in London). Day notes exist for D-11 .. D-1 except
// D-3 and D-8; there is deliberately no note for D, so the first authenticated load exercises rollover.
const fs = require('fs');
const path = require('path');
const { newDay, setHabit, setQuote, londonDate, addDays } = require('../lib/today-note');
const { LEGACY_HABITS_MD } = require('../test/today-fixtures');   // the e2e expects the old rows

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
const dateArg = args.find((a) => a.startsWith('--date='));
if (!outDir) {
  console.error('Usage: node scripts/today-sandbox.js <outDir> [--date=YYYY-MM-DD]');
  process.exit(1);
}
const D = dateArg ? dateArg.slice('--date='.length) : londonDate(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(D)) {
  console.error('Bad --date, expected YYYY-MM-DD');
  process.exit(1);
}

const put = (rel, text) => {
  const f = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

put('Personal/_tasks/Board.md', [
  '---', 'kanban-plugin: board', '---', '',
  ...['Backlog', 'In Progress', 'Blocked', 'Review', 'Done'].flatMap((c) => [`## ${c}`, '']),
  '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', '',
].join('\n'));
put('Personal/1. apps/01-demo/task.md', [
  '---', "title: 'Demo task'", 'status: in-progress', 'priority: med', `updated: ${D}`, '---', '', '# Demo task', '',
].join('\n'));

put('Personal/Today/habits.md', `${LEGACY_HABITS_MD}| Bad Id | Broken | sun | |\n`);

const order = ['wake', 'gym', 'outside', 'business', 'vitamins', 'read', 'learn', 'nocoffee'];
for (let n = 11; n >= 1; n--) {
  if (n === 3 || n === 8) continue;
  const date = addDays(D, -n);
  const carried = n === 1 ? ['- [x] Wash the car', `- [ ] Book dentist check-up (from ${addDays(D, -4)})`] : [];
  let md = newDay(date, { carried });
  md = setHabit(md, 'vitamins', true, order);
  if (n <= 2) md = setHabit(md, 'read', true, order);
  if (n === 1) {
    md = setQuote(md, { text: 'Waste no more time arguing about what a good man should be. Be one.', by: 'Marcus Aurelius' });
  }
  put(`Personal/Today/days/${date.slice(0, 7)}/${date}.md`, md);
}
