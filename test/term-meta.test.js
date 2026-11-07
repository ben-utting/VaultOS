'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findJobTask, createTaskInfo, createGitBranch } = require('../lib/term-meta');

const STATUSES = ['backlog', 'in-progress', 'blocked', 'needs-decision', 'review', 'scheduled', 'done'];
// Minimal stand-in for the server's parseFrontmatter (flat key: value, optional quotes).
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { meta, body: m[2] };
}

const JOB = 'Personal/1. apps/01-api-refactor';
const TASK = `${JOB}/task.md`;
const taskText = (title, status) => `---\ntitle: '${title}'\nstatus: ${status}\n---\n\n# ${title}\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-meta-'));
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put(TASK, taskText('API refactor', 'in-progress'));
  fs.mkdirSync(path.join(root, JOB, 'data'));
  fs.mkdirSync(path.join(root, JOB, '.cache'));
  put('Code/DevOps/demo-repo/.git/HEAD', 'ref: refs/heads/feature-x\n');
  put('Code/DevOps/demo-repo/sub/x.txt', '');
  put('Code/DevOps/demo-wt/.git', 'gitdir: ../demo-repo/.git/worktrees/wt\n');
  put('Code/DevOps/demo-repo/.git/worktrees/wt/HEAD', 'ref: refs/heads/wt-branch\n');
  put('Code/DevOps/demo-det/.git/HEAD', '0123456789abcdef0123456789abcdef01234567\n');
  return { root, put, abs: (rel) => path.join(root, rel), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('findJobTask', async (t) => {
  const f = fixture();
  t.after(f.done);
  const opts = { vaultDir: f.root, wsDirs: [f.abs('Personal')], skipDirs: new Set(['data', 'node_modules']) };
  await t.test('finds the task from the job folder', async () => assert.equal(await findJobTask(f.abs(JOB), opts), TASK));
  await t.test('finds it from a skipped subfolder', async () => assert.equal(await findJobTask(f.abs(`${JOB}/data`), opts), TASK));
  await t.test('stays inside a workspace', async () => {
    assert.equal(await findJobTask(f.abs('Personal'), opts), '');
    assert.equal(await findJobTask(f.abs('Personal/1. apps'), opts), '');
  });
  await t.test('ignores non-workspaces', async () => assert.equal(await findJobTask(f.abs('Code/DevOps/demo-repo'), opts), ''));
  await t.test('ignores dot folders', async () => assert.equal(await findJobTask(f.abs(`${JOB}/.cache`), opts), TASK));
});

test('taskInfo', async (t) => {
  const mk = () => {
    const f = fixture();
    return { f, info: createTaskInfo({ vaultDir: f.root, parseFrontmatter, statuses: STATUSES }) };
  };
  await t.test('reads title and status', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    assert.deepEqual(await info(TASK), { task: TASK, title: 'API refactor', status: 'in-progress', missing: false });
  });
  await t.test('rejects unknown status', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    f.put(TASK, taskText('API refactor', 'wibble'));
    assert.equal((await info(TASK)).status, '');
  });
  await t.test('relinks from _done', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    fs.mkdirSync(f.abs('Personal/1. apps/_done'));
    fs.renameSync(f.abs(JOB), f.abs('Personal/1. apps/_done/01-api-refactor'));
    const r = await info(TASK);
    assert.equal(r.task, 'Personal/1. apps/_done/01-api-refactor/task.md');
    assert.equal(r.missing, false);
    assert.equal(r.title, 'API refactor');
  });
  await t.test('relinks from _cancelled', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    fs.mkdirSync(f.abs('Personal/1. apps/_cancelled'));
    fs.renameSync(f.abs(JOB), f.abs('Personal/1. apps/_cancelled/01-api-refactor'));
    assert.equal((await info(TASK)).task, 'Personal/1. apps/_cancelled/01-api-refactor/task.md');
  });
  await t.test('missing', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    fs.rmSync(f.abs(TASK));
    const r = await info(TASK);
    assert.equal(r.missing, true);
    assert.equal(r.task, TASK);
  });
  await t.test('mtime cache', async (t2) => {
    const { f, info } = mk(); t2.after(f.done);
    assert.equal((await info(TASK)).title, 'API refactor');
    f.put(TASK, taskText('Renamed', 'in-progress'));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f.abs(TASK), future, future);
    assert.equal((await info(TASK)).title, 'Renamed');
  });
});

test('gitBranch', async (t) => {
  const f = fixture();
  t.after(f.done);
  const branch = createGitBranch({ vaultDir: f.root });
  await t.test('branch from HEAD', async () => {
    assert.equal(await branch(f.abs('Code/DevOps/demo-repo')), 'feature-x');
    assert.equal(await branch(f.abs('Code/DevOps/demo-repo/sub')), 'feature-x');
  });
  await t.test('worktree gitdir file', async () => assert.equal(await branch(f.abs('Code/DevOps/demo-wt')), 'wt-branch'));
  await t.test('detached HEAD', async () => assert.equal(await branch(f.abs('Code/DevOps/demo-det')), '0123456'));
  await t.test('no repo', async () => assert.equal(await branch(f.abs('Personal')), ''));
});
