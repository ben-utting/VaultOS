'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/sheet-store');

const CHANGED = 'This file changed on disk since you opened it.';
const ORIGINAL = Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x00, 0xff, 0xfe, 0x0a, 0x31, 0x2c, 0x32, 0x0a]); // not valid utf-8 on purpose
const NEWER = Buffer.from('a,b\n9,9\n');
const OLD_TIME = new Date('2024-03-04T05:06:07.000Z');

// A sandbox with `vault/` and `backups/` as siblings (like the two bind mounts), and vault/sub/data.csv in place with
// an old mtime so a "now" mtime can never be confused with it.
async function sandbox(t, { mode = 0o640 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sheet-store-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const vaultDir = path.join(root, 'vault');
  const backupDir = path.join(root, 'backups');
  await fsp.mkdir(path.join(vaultDir, 'sub'), { recursive: true });
  await fsp.mkdir(backupDir);
  const rel = 'sub/data.csv';
  const full = path.join(vaultDir, rel);
  await fsp.writeFile(full, ORIGINAL);
  await fsp.chmod(full, mode);
  await fsp.utimes(full, OLD_TIME, OLD_TIME);
  return { root, vaultDir, backupDir, rel, full, backupFull: path.join(backupDir, rel) };
}

async function walk(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}
const leftovers = async (...dirs) => (await Promise.all(dirs.map(walk))).flat().filter((p) => p.includes('.tmp-'));

// The real fs, except rename refuses (EXDEV) when source and target sit under different roots — what a rename
// between the two bind mounts does in production.
function exdevFs(roots) {
  const real = require('fs/promises');
  const rootOf = (p) => roots.find((r) => path.resolve(p).startsWith(r + path.sep));
  return {
    ...real,
    rename: async (a, b) => {
      if (rootOf(a) !== rootOf(b)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return real.rename(a, b);
    },
  };
}

const rejects409 = (p) => assert.rejects(p, (e) => e.status === 409 && e.message === CHANGED);

// ---- readGuarded -----------------------------------------------------------

test('readGuarded returns the exact bytes and the stat', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const { buf, stat } = await store.readGuarded(s.full);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, ORIGINAL);
  assert.equal(stat.size, ORIGINAL.length);
  assert.equal(stat.mtimeMs, OLD_TIME.getTime());
});

test('readGuarded: matching or near mtime passes, stale mtime is a 409', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await store.readGuarded(s.full, OLD_TIME.getTime());
  await store.readGuarded(s.full, String(OLD_TIME.getTime() + 1)); // within 1ms, and clients may send strings
  await rejects409(store.readGuarded(s.full, OLD_TIME.getTime() + 2));
  await rejects409(store.readGuarded(s.full, 12345));
  await rejects409(store.readGuarded(s.full, 'not-a-number'));
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL); // untouched
});

test('readGuarded: a missing file is a plain 404', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await assert.rejects(store.readGuarded(path.join(s.vaultDir, 'nope.csv')), (e) => e.status === 404 && /no longer exists/.test(e.message));
});

// ---- replace ---------------------------------------------------------------

test('replace: new bytes in place, backup holds the checked bytes with their old mtime, no temp leftovers', async (t) => {
  const s = await sandbox(t, { mode: 0o640 });
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  assert.equal(await store.backupInfo(s.rel), null);

  const guard = await store.readGuarded(s.full);
  const stat = await store.replace(s.full, s.rel, NEWER, guard);

  assert.deepEqual(await fsp.readFile(s.full), NEWER);
  assert.deepEqual(await fsp.readFile(s.backupFull), ORIGINAL);
  const bst = await fsp.stat(s.backupFull);
  assert.ok(Math.abs(bst.mtimeMs - OLD_TIME.getTime()) < 1, 'backup keeps the old mtime');
  assert.equal((await fsp.stat(s.full)).mode & 0o777, 0o640, 'file mode preserved');
  assert.equal(stat.size, NEWER.length);
  assert.equal(stat.mtimeMs, (await fsp.stat(s.full)).mtimeMs, 'returns the fresh stat');
  assert.ok(stat.mtimeMs > OLD_TIME.getTime());
  const info = await store.backupInfo(s.rel);
  assert.ok(Math.abs(info.mtime - OLD_TIME.getTime()) < 1);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('replace: a second save keeps only a one-step backup (the previous save)', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  const newest = Buffer.from('a,b\n7,7\n');
  await store.replace(s.full, s.rel, newest, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), newest);
  assert.deepEqual(await fsp.readFile(s.backupFull), NEWER);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('replace: file modified between readGuarded and replace is a 409, nothing written', async (t) => {
  for (const [name, tamper] of [
    ['content, same size, new mtime', async (s) => { await fsp.writeFile(s.full, Buffer.alloc(ORIGINAL.length, 0x78)); }],
    ['mtime only', async (s) => { const d = new Date(OLD_TIME.getTime() + 5000); await fsp.utimes(s.full, d, d); }],
    ['size changed, mtime restored', async (s) => { await fsp.appendFile(s.full, 'x'); await fsp.utimes(s.full, OLD_TIME, OLD_TIME); }],
    ['replaced by another file (new inode), same size and mtime', async (s) => {
      const other = path.join(s.vaultDir, 'sub', 'other.csv');
      await fsp.writeFile(other, Buffer.alloc(ORIGINAL.length, 0x79));
      await fsp.utimes(other, OLD_TIME, OLD_TIME);
      await fsp.rename(other, s.full);
    }],
  ]) {
    await t.test(name, async (t2) => {
      const s = await sandbox(t2);
      const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
      const guard = await store.readGuarded(s.full);
      await tamper(s);
      const before = await fsp.readFile(s.full);
      await rejects409(store.replace(s.full, s.rel, NEWER, guard));
      assert.deepEqual(await fsp.readFile(s.full), before, 'file is exactly what the other writer left');
      assert.equal(await store.backupInfo(s.rel), null, 'no backup written');
      assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
    });
  }
});

test('replace: a file that vanished since it was read is a 409', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const guard = await store.readGuarded(s.full);
  await fsp.unlink(s.full);
  await rejects409(store.replace(s.full, s.rel, NEWER, guard));
  assert.deepEqual(await walk(s.vaultDir), []);
  assert.deepEqual(await walk(s.backupDir), []);
});

test('replace writes the checked bytes to the backup, not a fresh read', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const guard = await store.readGuarded(s.full);
  guard.buf = Buffer.from('what the caller checked'); // distinguishable from what is on disk
  await store.replace(s.full, s.rel, NEWER, guard);
  assert.equal((await fsp.readFile(s.backupFull)).toString(), 'what the caller checked');
});

test('every temp lives in its destination folder and is named .<base>.tmp-sheet-<pid>-<n>', async (t) => {
  const s = await sandbox(t);
  const real = require('fs/promises');
  const opened = [];
  const fs = { ...real, open: async (p, ...rest) => { opened.push(p); return real.open(p, ...rest); } };
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  const re = new RegExp(`^\\.data\\.csv\\.tmp-sheet-${process.pid}-\\d+$`);
  assert.equal(opened.length, 2);
  const dirs = opened.map((p) => path.dirname(p)).sort();
  assert.deepEqual(dirs, [path.join(s.backupDir, 'sub'), path.join(s.vaultDir, 'sub')].sort());
  for (const p of opened) assert.match(path.basename(p), re);
});

test('a stale temp from a crashed run does not block a save', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await fsp.mkdir(path.join(s.backupDir, 'sub'));
  const stale = [s.vaultDir, s.backupDir].flatMap((d) => [1, 2, 3].map((n) => path.join(d, 'sub', `.data.csv.tmp-sheet-${process.pid}-${n}`)));
  for (const p of stale) await fsp.writeFile(p, 'stale');
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), NEWER);
  for (const p of stale) assert.equal(await fsp.readFile(p, 'utf8'), 'stale', 'only our own temps are ever removed');
});

test('replace and restore never rename across vault and backups (EXDEV-safe)', async (t) => {
  const s = await sandbox(t);
  const fs = exdevFs([s.vaultDir, s.backupDir]);
  // sanity: the injected rename really does refuse a cross-root move
  await fsp.writeFile(path.join(s.vaultDir, 'x'), 'x');
  await assert.rejects(fs.rename(path.join(s.vaultDir, 'x'), path.join(s.backupDir, 'x')), { code: 'EXDEV' });
  await fsp.unlink(path.join(s.vaultDir, 'x'));

  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), NEWER);
  assert.deepEqual(await fsp.readFile(s.backupFull), ORIGINAL);
  await store.restore(s.full, s.rel, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.deepEqual(await fsp.readFile(s.backupFull), NEWER);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('replace failure (backup folder cannot be created) leaves the original intact and no temps', async (t) => {
  const s = await sandbox(t);
  const blocker = path.join(s.root, 'not-a-dir');
  await fsp.writeFile(blocker, 'a regular file');
  const store = createStore({ vaultDir: s.vaultDir, backupDir: path.join(blocker, 'backups') }); // parent is a file: ENOTDIR
  const guard = await store.readGuarded(s.full);
  await assert.rejects(store.replace(s.full, s.rel, NEWER, guard), (e) => e.code === 'ENOTDIR');
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  const st = await fsp.stat(s.full);
  assert.equal(st.mtimeMs, guard.stat.mtimeMs);
  assert.equal(st.ino, guard.stat.ino);
  assert.deepEqual(await leftovers(s.vaultDir, s.root), []);
});

test('replace failure at the last step (rename over the file) unlinks temps and keeps the original', async (t) => {
  const s = await sandbox(t);
  const real = require('fs/promises');
  const fs = { ...real, rename: async (a, b) => { if (b === s.full) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real.rename(a, b); } };
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  const guard = await store.readGuarded(s.full);
  await assert.rejects(store.replace(s.full, s.rel, NEWER, guard), { code: 'EIO' });
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.equal((await fsp.stat(s.full)).ino, guard.stat.ino);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('replace failure while writing the new bytes unlinks both temps', async (t) => {
  const s = await sandbox(t);
  const real = require('fs/promises');
  let n = 0;
  const fs = { ...real, chmod: async (...a) => { if (++n === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return real.chmod(...a); } };
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  await assert.rejects(store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full)), { code: 'EPERM' });
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
  assert.equal(await store.backupInfo(s.rel), null, 'backup not published when the save did not get that far');
});

test('replace re-checks again right before publishing: a write that lands mid-save wins, nothing is published', async (t) => {
  const s = await sandbox(t);
  const real = require('fs/promises');
  let chmods = 0;
  const fs = {
    ...real,
    chmod: async (...a) => {
      const r = await real.chmod(...a);
      if (++chmods === 2) await real.writeFile(s.full, 'another writer, mid-save'); // both temps exist by now
      return r;
    },
  };
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  await rejects409(store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full)));
  assert.equal(await fsp.readFile(s.full, 'utf8'), 'another writer, mid-save');
  assert.equal(await store.backupInfo(s.rel), null, 'backup not published either');
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('replace refuses a rel that would escape the backups folder', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const guard = await store.readGuarded(s.full);
  await assert.rejects(store.replace(s.full, '../outside.csv', NEWER, guard), (e) => e.status === 400);
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  await assert.rejects(fsp.stat(path.join(s.root, 'outside.csv')), { code: 'ENOENT' });
});

test('replace and restore refuse a rel that is not the vault-relative path of the file', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const guard = await store.readGuarded(s.full);
  for (const bad of ['other/place.csv', '', 'sub/../sub/data.csv/', '/sub/data.csv']) {
    await assert.rejects(store.replace(s.full, bad, NEWER, guard), (e) => e.status === 400, JSON.stringify(bad));
    await assert.rejects(store.restore(s.full, bad, guard), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.deepEqual(await walk(s.backupDir), []);
});

// ---- restore ---------------------------------------------------------------

test('restore twice gives the original bytes back, swapping mtimes each time', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  const savedAt = (await fsp.stat(s.full)).mtimeMs;

  const st1 = await store.restore(s.full, s.rel, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.deepEqual(await fsp.readFile(s.backupFull), NEWER);
  assert.ok(Math.abs(st1.mtimeMs - OLD_TIME.getTime()) < 1, 'file gets the backup\'s mtime');
  assert.equal(st1.mtimeMs, (await fsp.stat(s.full)).mtimeMs, 'returns the fresh stat');
  assert.ok(Math.abs((await fsp.stat(s.backupFull)).mtimeMs - savedAt) < 1, 'backup gets the replaced file\'s mtime');
  assert.ok(Math.abs((await store.backupInfo(s.rel)).mtime - savedAt) < 1);
  assert.equal((await fsp.stat(s.full)).mode & 0o777, 0o640);

  await store.restore(s.full, s.rel, await store.readGuarded(s.full));
  assert.deepEqual(await fsp.readFile(s.full), NEWER);
  assert.deepEqual(await fsp.readFile(s.backupFull), ORIGINAL);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('restore with no earlier version is a 404', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await assert.rejects(store.restore(s.full, s.rel, await store.readGuarded(s.full)),
    (e) => e.status === 404 && e.message === 'There is no earlier version to restore.');
  assert.deepEqual(await fsp.readFile(s.full), ORIGINAL);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('restore: file changed since it was read is a 409, nothing touched', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  const guard = await store.readGuarded(s.full);
  await fsp.writeFile(s.full, 'someone else was here');
  await rejects409(store.restore(s.full, s.rel, guard));
  assert.equal(await fsp.readFile(s.full, 'utf8'), 'someone else was here');
  assert.deepEqual(await fsp.readFile(s.backupFull), ORIGINAL);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('restore: if the final rename fails the previous backup is put back and nothing is lost', async (t) => {
  const s = await sandbox(t);
  const real = require('fs/promises');
  let failFinal = false;
  const fs = { ...real, rename: async (a, b) => { if (failFinal && b === s.full) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real.rename(a, b); } };
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir, fs });
  await store.replace(s.full, s.rel, NEWER, await store.readGuarded(s.full));
  failFinal = true;
  await assert.rejects(store.restore(s.full, s.rel, await store.readGuarded(s.full)), { code: 'EIO' });
  assert.deepEqual(await fsp.readFile(s.full), NEWER);
  assert.deepEqual(await fsp.readFile(s.backupFull), ORIGINAL, 'earlier version still restorable');
  assert.ok(Math.abs((await fsp.stat(s.backupFull)).mtimeMs - OLD_TIME.getTime()) < 1);
  assert.deepEqual(await leftovers(s.vaultDir, s.backupDir), []);
});

test('backupInfo: null when there is none, even if the backups folder itself is missing', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: path.join(s.root, 'no-such-dir') });
  assert.equal(await store.backupInfo(s.rel), null);
});

// ---- withLock --------------------------------------------------------------

test('two withLock calls on one path run in order', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const log = [];
  const slow = store.withLock(s.full, async () => { log.push('a-start'); await new Promise((r) => setTimeout(r, 40)); log.push('a-end'); return 'A'; });
  const fast = store.withLock(s.full, async () => { log.push('b-start'); log.push('b-end'); return 'B'; });
  assert.deepEqual(await Promise.all([slow, fast]), ['A', 'B']);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withLock: different paths do not wait for each other', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const log = [];
  const slow = store.withLock('/x/one', async () => { await new Promise((r) => setTimeout(r, 40)); log.push('one'); });
  const fast = store.withLock('/x/two', async () => { log.push('two'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ['two', 'one']);
});

test('withLock: a rejection (or a sync throw) does not block later calls, and the map empties when idle', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const bad = store.withLock(s.full, async () => { throw new Error('boom'); });
  const worse = store.withLock(s.full, () => { throw new Error('sync boom'); });
  const good = store.withLock(s.full, async () => 'ok');
  await assert.rejects(bad, /boom/);
  await assert.rejects(worse, /sync boom/);
  assert.equal(await good, 'ok');
  await new Promise((r) => setImmediate(r));
  assert.equal(store.lockCount(), 0);
  assert.equal(await store.withLock(s.full, async () => 'again'), 'again');
});

// ---- eligibility cache -----------------------------------------------------

test('eligibility cache: hit only while mtime and size match', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const stat = { mtimeMs: 1000.5, size: 10 };
  assert.equal(store.eligibility.get('a.xlsx', stat), undefined);
  const result = { editable: true, reason: null };
  store.eligibility.set('a.xlsx', stat, result);
  assert.equal(store.eligibility.get('a.xlsx', stat), result);
  assert.equal(store.eligibility.get('a.xlsx', { mtimeMs: 1000.5, size: 10, ino: 7 }), result);
  assert.equal(store.eligibility.get('a.xlsx', { mtimeMs: 1001.5, size: 10 }), undefined);
  assert.equal(store.eligibility.get('a.xlsx', { mtimeMs: 1000.5, size: 11 }), undefined);
  assert.equal(store.eligibility.get('b.xlsx', stat), undefined);
  store.eligibility.set('a.xlsx', { mtimeMs: 2000, size: 11 }, { editable: false, reason: 'x' });
  assert.equal(store.eligibility.get('a.xlsx', stat), undefined, 'set replaces the entry');
  assert.equal(store.eligibility.size, 1);
  store.eligibility.delete('a.xlsx');
  assert.equal(store.eligibility.size, 0);
});

test('eligibility cache is capped at 100 entries, evicting the oldest', async (t) => {
  const s = await sandbox(t);
  const store = createStore({ vaultDir: s.vaultDir, backupDir: s.backupDir });
  const st = (i) => ({ mtimeMs: i, size: i });
  for (let i = 0; i < 100; i++) store.eligibility.set(`f${i}.xlsx`, st(i), { i });
  assert.equal(store.eligibility.size, 100);
  store.eligibility.set('f0.xlsx', st(0), { i: 'refreshed' }); // re-setting makes it the newest
  store.eligibility.set('f100.xlsx', st(100), { i: 100 });
  assert.equal(store.eligibility.size, 100);
  assert.equal(store.eligibility.get('f1.xlsx', st(1)), undefined, 'oldest evicted');
  assert.deepEqual(store.eligibility.get('f0.xlsx', st(0)), { i: 'refreshed' });
  assert.deepEqual(store.eligibility.get('f100.xlsx', st(100)), { i: 100 });
  assert.deepEqual(store.eligibility.get('f2.xlsx', st(2)), { i: 2 });
});
