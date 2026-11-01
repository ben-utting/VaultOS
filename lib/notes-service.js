'use strict';
// Notes mode's file work: list the inbox and main notes, capture a thought, remove a rough note with undo.
// Paths given out and taken in are vault-relative with '/'. Every folder is checked with realpath to stay
// inside the vault, so a symlinked notes folder can't send a write elsewhere.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./atomic-write');
const { captureBase, captureBody, uniqueName } = require('./notes-names');
const { firstLine, readStatus, readTags } = require('./notes-parse');

const TEXT_MAX = 1024 * 1024;
const HEAD_BYTES = 4096;
const OLD_MS = 7 * 86400000;
const TRASH_KEEP_MS = 86400000;
const WALK_SKIP = new Set(['_tasks', '_Templates', 'node_modules']);

class NotesError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isMd = (name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.');
const joinRel = (...parts) => parts.join('/').replace(/\/+/g, '/');

async function readHead(full) {
  const fh = await fsp.open(full, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

function createNotesService({ vaultDir, settings, now = () => new Date(), undoMs = 30000 }) {
  const trashDir = path.join(vaultDir, '.vaultos', 'notes-trash');
  const held = new Map();   // token -> { trash, rel, atime, mtime, timer }
  let chain = Promise.resolve();

  const cfg = () => settings().notes;
  const tz = () => settings().today.timezone;
  const abs = (rel) => path.resolve(vaultDir, ...rel.split('/'));
  const relOf = (key) => (key === 'dir' ? cfg().dir : joinRel(cfg().dir, cfg()[key]));

  // The real path of a vault-relative folder or file: null when it doesn't exist; throws when it leaves the vault.
  async function real(rel) {
    const full = abs(rel);
    const root = await fsp.realpath(vaultDir);
    if (full !== path.resolve(vaultDir) && !full.startsWith(path.resolve(vaultDir) + path.sep)) throw new NotesError(400, 'Path outside vault');
    let r;
    try { r = await fsp.realpath(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
    if (r !== root && !r.startsWith(root + path.sep)) throw new NotesError(400, 'Path outside vault');
    return r;
  }
  async function folder(key) {
    try { const r = await real(relOf(key)); return r && (await fsp.stat(r)).isDirectory() ? r : null; } catch (e) {
      if (e instanceof NotesError) return null;
      throw e;
    }
  }

  async function mdFiles(dirReal) {
    if (!dirReal) return [];
    const ents = await fsp.readdir(dirReal, { withFileTypes: true });
    return ents.filter((e) => e.isFile() && isMd(e.name)).map((e) => e.name);
  }

  async function walkNames(dirReal, dirRel, out) {
    let ents;
    try { ents = await fsp.readdir(dirReal, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || WALK_SKIP.has(e.name)) continue;
      if (e.isDirectory()) await walkNames(path.join(dirReal, e.name), joinRel(dirRel, e.name), out);
      else if (e.isFile() && isMd(e.name)) out.push({ name: e.name.slice(0, -3), path: joinRel(dirRel, e.name) });
    }
  }

  async function list() {
    const at = now().getTime();
    const f = {};
    for (const k of ['dir', 'inbox', 'main', 'tags']) f[k] = await folder(k);
    const missing = ['dir', 'inbox', 'main', 'tags'].filter((k) => !f[k]);

    // A file that can't be read (another owner, or gone since readdir) is left out rather than failing the list.
    const inbox = [];
    for (const name of await mdFiles(f.inbox)) {
      try {
        const full = path.join(f.inbox, name);
        const st = await fsp.stat(full);
        inbox.push({ path: joinRel(relOf('inbox'), name), name, first: firstLine(await readHead(full)), mtime: st.mtimeMs, old: at - st.mtimeMs > OLD_MS });
      } catch { /* skipped */ }
    }
    const main = [];
    for (const name of await mdFiles(f.main)) {
      try {
        const full = path.join(f.main, name);
        const st = await fsp.stat(full);
        const head = await readHead(full);
        main.push({ path: joinRel(relOf('main'), name), title: name.slice(0, -3), status: readStatus(head), tags: readTags(head), mtime: st.mtimeMs });
      } catch { /* skipped */ }
    }
    const newest = (a, b) => b.mtime - a.mtime;
    inbox.sort(newest);
    main.sort(newest);
    const tags = (await mdFiles(f.tags)).map((n) => n.slice(0, -3)).sort((a, b) => a.localeCompare(b));

    const all = [];
    if (f.dir) await walkNames(f.dir, relOf('dir'), all);
    const mainRel = relOf('main') + '/';
    const isMain = (p) => p.startsWith(mainRel) && !p.slice(mainRel.length).includes('/');
    all.sort((a, b) => (isMain(b.path) - isMain(a.path)) || a.path.localeCompare(b.path));
    const seen = new Set();
    const names = all.filter((n) => { const k = n.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

    return { inbox, main, tags, names, missing };
  }

  async function doCapture(text) {
    if (!(await folder('dir'))) throw new NotesError(409, `The notes folder ${cfg().dir} does not exist.`);
    let inboxReal = await real(relOf('inbox'));
    if (!inboxReal) {
      try { await fsp.mkdir(abs(relOf('inbox'))); } catch (e) {
        if (e.code !== 'EEXIST') throw new NotesError(409, `The inbox folder ${relOf('inbox')} could not be made.`);
      }
      inboxReal = await real(relOf('inbox'));
    }
    if (!inboxReal || !(await fsp.stat(inboxReal)).isDirectory()) throw new NotesError(409, `The inbox folder ${relOf('inbox')} is not a folder.`);
    const when = now();
    const name = uniqueName(captureBase(text, when, tz()), (n) => fs.existsSync(path.join(inboxReal, n)));
    await atomicWrite(path.join(inboxReal, name), captureBody(text, when, tz()));
    return { path: joinRel(relOf('inbox'), name), name };
  }

  function capture(text) {
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(new NotesError(400, 'Type something first.'));
    if (text.includes('\0')) return Promise.reject(new NotesError(400, 'That text has a NUL byte.'));
    if (Buffer.byteLength(text) > TEXT_MAX) return Promise.reject(new NotesError(413, 'That is too long for one note.'));
    // One capture at a time, so two at once can't both pick the same free name.
    const run = chain.then(() => doCapture(text));
    chain = run.catch(() => {});
    return run;
  }

  async function remove(rel) {
    if (typeof rel !== 'string' || !rel) throw new NotesError(400, 'Only rough notes can be removed here.');
    const r = await real(rel);
    if (!r) throw new NotesError(404, 'Already gone.');
    const gone = (e) => (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? new NotesError(404, 'Already gone.') : e);
    const inboxReal = await folder('inbox');
    let st;
    try { st = await fsp.stat(r); } catch (e) { throw gone(e); }
    if (!inboxReal || path.dirname(r) !== inboxReal || !st.isFile() || !isMd(path.basename(r))) {
      throw new NotesError(400, 'Only rough notes can be removed here.');
    }
    await fsp.mkdir(trashDir, { recursive: true });
    // The removal time is in the name, so the sweep needn't touch the file's own times (which needs owning it).
    const trash = path.join(trashDir, `${now().getTime()}-${crypto.randomBytes(8).toString('hex')}.md`);
    try { await fsp.rename(r, trash); } catch (e) { throw gone(e); }   // a second Done at once finds it gone
    const token = crypto.randomBytes(16).toString('hex');
    const timer = setTimeout(() => { held.delete(token); fsp.unlink(trash).catch(() => {}); }, undoMs);
    if (timer.unref) timer.unref();
    held.set(token, { trash, rel, timer });
    return { token };
  }

  async function undo(token) {
    const h = typeof token === 'string' ? held.get(token) : null;
    if (!h) throw new NotesError(410, 'Too late to undo.');
    const dest = abs(h.rel);
    if (fs.existsSync(dest)) throw new NotesError(409, 'A note with that name exists again.');
    clearTimeout(h.timer);
    held.delete(token);
    await fsp.rename(h.trash, dest);
    return { path: h.rel };
  }

  async function sweep() {
    let names;
    try { names = await fsp.readdir(trashDir); } catch { return; }
    const cutoff = now().getTime() - TRASH_KEEP_MS;
    for (const n of names) {
      const f = path.join(trashDir, n);
      const m = /^(\d{12,})-/.exec(n);   // <removed at, epoch ms>-<random>.md; anything else goes by its mtime
      try {
        const when = m ? Number(m[1]) : (await fsp.stat(f)).mtimeMs;
        if (when < cutoff) await fsp.unlink(f);
      } catch { /* gone already */ }
    }
  }

  return { list, capture, remove, undo, sweep };
}

module.exports = { createNotesService, NotesError };
