'use strict';
// Pure helpers behind the terminal sidebar's metadata: which task a shell belongs to, that task's
// title/status, and the git branch of the shell's folder. No server state; server.js passes in its paths.
const fs = require('fs');
const path = require('path');

const isFile = async (f) => { try { return (await fs.promises.stat(f)).isFile(); } catch { return false; } };
const toRel = (vaultDir, full) => path.relative(vaultDir, full).split(path.sep).join('/');

// Walks up from cwdFull to the nearest job folder (one holding task.md) strictly inside a workspace.
// Folders that are, or sit under, a skipped or dot-named segment are walked past, not matched.
async function findJobTask(cwdFull, { vaultDir, wsDirs, skipDirs }) {
  let dir = path.resolve(cwdFull);
  const ws = wsDirs.map((w) => path.resolve(w));
  const inside = (d) => ws.some((w) => d.startsWith(w + path.sep));
  while (inside(dir)) {
    const segs = toRel(vaultDir, dir).split('/');
    const skipped = segs.some((s) => skipDirs.has(s) || s.startsWith('.'));
    if (!skipped && await isFile(path.join(dir, 'task.md'))) return toRel(vaultDir, path.join(dir, 'task.md'));
    dir = path.dirname(dir);
  }
  return '';
}

// taskRel → {task, title, status, missing}. A task that /done moved to _done/ (or _cancelled/) next to
// its old folder is found there and reported under its new path. Cached per task by file mtime.
function createTaskInfo({ vaultDir, parseFrontmatter, statuses }) {
  const cache = new Map();   // taskRel → {rel, mtimeMs, info}
  const statOf = async (rel) => { try { return await fs.promises.stat(path.join(vaultDir, rel)); } catch { return null; } };
  return async function taskInfo(taskRel) {
    let rel = taskRel;
    let st = await statOf(rel);
    if (!st) {
      const job = path.posix.dirname(taskRel);
      const parent = path.posix.dirname(job);
      for (const bin of ['_done', '_cancelled']) {
        const alt = path.posix.join(parent, bin, path.posix.basename(job), 'task.md');
        const s = await statOf(alt);
        if (s) { rel = alt; st = s; break; }
      }
    }
    if (!st) { cache.delete(taskRel); return { task: taskRel, title: '', status: '', missing: true }; }
    const hit = cache.get(taskRel);
    if (hit && hit.rel === rel && hit.mtimeMs === st.mtimeMs) return hit.info;
    let meta = {};
    try { meta = parseFrontmatter(await fs.promises.readFile(path.join(vaultDir, rel), 'utf8')).meta || {}; } catch { /* unreadable: no title */ }
    const status = String(meta.status || '');
    const info = { task: rel, title: String(meta.title || ''), status: statuses.includes(status) ? status : '', missing: false };
    cache.set(taskRel, { rel, mtimeMs: st.mtimeMs, info });
    return info;
  };
}

// cwdFull → current branch name, a 7-char sha for a detached HEAD, or ''. Walks up to (not into) the
// vault root; follows a worktree's `.git` file. Cached per folder for ttlMs.
function createGitBranch({ vaultDir, ttlMs = 10000 }) {
  const cache = new Map();
  const root = path.resolve(vaultDir);
  async function headOf(dir) {
    const dotGit = path.join(dir, '.git');
    let st;
    try { st = await fs.promises.stat(dotGit); } catch { return null; }
    let gitDir = dotGit;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
      if (!m) return '';
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = (await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : '';
  }
  return async function gitBranch(cwdFull) {
    const key = path.resolve(cwdFull);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
    let v = '';
    try {
      for (let dir = key; dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
        const b = await headOf(dir);
        if (b !== null) { v = b; break; }
      }
    } catch { v = ''; }
    cache.set(key, { at: Date.now(), v });
    return v;
  };
}

module.exports = { findJobTask, createTaskInfo, createGitBranch };
