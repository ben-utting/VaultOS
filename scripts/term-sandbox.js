'use strict';
// Synthetic vault for the terminal-spaces preview (:7690) and its e2e tests.
//
//   node scripts/term-sandbox.js <outDir>      → writes the vault tree under <outDir>
//
// Deterministic and invented: a Personal workspace with a few task folders (one with an HTML-ish, long
// title to test escaping and truncation) and a Code/ tree with a git repo and a linked worktree.
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/term-sandbox.js <outDir>');
  process.exit(1);
}
const put = (rel, text) => {
  const f = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const dir = (rel) => fs.mkdirSync(path.join(outDir, rel), { recursive: true });
const task = (rel, title, status) => put(rel, [
  '---', `title: '${title}'`, `status: ${status}`, 'priority: med', 'updated: 2026-10-07', '---', '', `# ${title}`, '',
].join('\n'));

put('Personal/_tasks/Board.md', [
  '---', 'kanban-plugin: board', '---', '',
  ...['Backlog', 'In Progress', 'Blocked', 'Review', 'Done'].flatMap((c) => [`## ${c}`, '']),
  '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', '',
].join('\n'));

task('Personal/1. apps/01-api-refactor/task.md', 'API refactor', 'in-progress');
dir('Personal/1. apps/01-api-refactor/data');
task('Personal/1. apps/02-web-login/task.md', 'Web login flow', 'in-progress');
dir('Personal/1. apps/_done');
task('Personal/2. platform/03-ops-dns/task.md',
  '<b>Ops & "DNS" — rebuild the internal resolver pair, move every zone and retire the old boxes</b>', 'backlog');

put('Code/DevOps/demo-repo/.git/HEAD', 'ref: refs/heads/feature-x\n');
put('Code/DevOps/demo-wt/.git', 'gitdir: ../demo-repo/.git/worktrees/wt\n');
put('Code/DevOps/demo-repo/.git/worktrees/wt/HEAD', 'ref: refs/heads/wt-branch\n');
