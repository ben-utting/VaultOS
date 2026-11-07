'use strict';

// Disk store for the spreadsheet editor: a guarded read, a per-file lock, an atomic replace that re-checks the file
// right before it lands, and a one-step backup ("previous version") that restore swaps back in.
//
// Rules, all deliberate:
//  - Everything is a Buffer. These are csv/xlsx files; nothing here decodes them.
//  - The vault (`/vault`) and the backups folder (`/app/sheet-backups`) are separate bind mounts in production, so a
//    rename between them fails with EXDEV. Every temp file is created in the folder of its final destination and only
//    ever renamed within that folder.
//  - The vault is synced by Syncthing and its Files tree hides dot-files, so temps are `.<base>.tmp-sheet-<pid>-<n>`
//    (a leading dot, and the `.tmp-` marker the "Changed recently" walker skips).
//  - Nothing becomes visible until the last re-check has passed: both temps are written first, the file is stat-ed
//    again right before the first rename, and on any error every temp this call created is unlinked. A failed save
//    leaves the original file exactly as it was.
//  - The backup is written from `guard.buf`, the bytes the caller actually checked and parsed — never a fresh read.

const fsDefault = require('fs/promises');
const path = require('path');

const CHANGED_MSG = 'This file changed on disk since you opened it.';
const MISSING_MSG = 'That file no longer exists.';
const NO_BACKUP_MSG = 'There is no earlier version to restore.';
const BAD_PATH_MSG = 'That path is not allowed.';
const ELIGIBILITY_MAX = 100;
const TEMP_BASE_MAX = 120; // keeps `.<base>.tmp-sheet-…` inside the 255-byte filename limit

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const changed = () => httpError(409, CHANGED_MSG);
const isGone = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
const sameFile = (a, b) => a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
const secs = (ms) => ms / 1000; // fs.utimes takes seconds; a float keeps sub-millisecond precision

// Cache of "is this workbook safe to edit?" results, so listing a folder of xlsx files doesn't re-parse each one.
// An entry is only returned while the file's mtime and size are exactly what they were when it was stored.
function createEligibilityCache(max = ELIGIBILITY_MAX) {
  const map = new Map(); // rel → { mtime, size, result }; insertion order = age
  return {
    get(rel, stat) {
      const e = map.get(rel);
      return e && e.mtime === stat.mtimeMs && e.size === stat.size ? e.result : undefined;
    },
    set(rel, stat, result) {
      map.delete(rel); // re-setting makes it the newest
      map.set(rel, { mtime: stat.mtimeMs, size: stat.size, result });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete(rel) { return map.delete(rel); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

function createStore({ vaultDir, backupDir, fs = fsDefault } = {}) {
  if (!vaultDir || !backupDir) throw new TypeError('createStore needs vaultDir and backupDir');
  const vaultRoot = path.resolve(vaultDir);
  const backupRoot = path.resolve(backupDir);
  const locks = new Map(); // full → tail of that file's promise chain (never rejects)
  const eligibility = createEligibilityCache(ELIGIBILITY_MAX);
  let counter = 0;

  // ---- paths ---------------------------------------------------------------

  // backupDir/rel, refusing anything that would land outside backupDir.
  function backupPathFor(rel) {
    if (typeof rel !== 'string' || !rel) throw httpError(400, BAD_PATH_MSG);
    const p = path.resolve(backupRoot, rel);
    if (!p.startsWith(backupRoot + path.sep)) throw httpError(400, BAD_PATH_MSG);
    return p;
  }

  // `rel` must be the vault-relative path of `full`: a mismatch would write the backup under the wrong name.
  function backupPathForFile(full, rel) {
    const expect = path.relative(vaultRoot, path.resolve(full)).split(path.sep).join('/');
    if (!expect || expect.startsWith('..') || path.isAbsolute(expect) || expect !== rel) throw httpError(400, BAD_PATH_MSG);
    return backupPathFor(rel);
  }

  // ---- low-level helpers ---------------------------------------------------

  // Creates `.<base>.tmp-sheet-<pid>-<n>` next to `dest`. 'wx' so an existing file (a stale temp from a crashed run
  // that had the same pid and counter) is never clobbered or later unlinked — we just take the next number.
  async function createTemp(dest) {
    const dir = path.dirname(dest);
    const base = path.basename(dest).slice(0, TEMP_BASE_MAX);
    for (let tries = 0; tries < 50; tries++) {
      const tmp = path.join(dir, `.${base}.tmp-sheet-${process.pid}-${++counter}`);
      try {
        return { tmp, fh: await fs.open(tmp, 'wx', 0o600) };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error(`Could not create a temporary file next to ${base}`);
  }

  // Temp in dest's folder holding `buf`, flushed to disk, with the given mode and (optionally) times. Pushed onto
  // `temps` as soon as it exists so the caller's cleanup can remove it.
  async function writeTemp(dest, buf, { mode, stat }, temps) {
    const { tmp, fh } = await createTemp(dest);
    temps.push(tmp);
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.chmod(tmp, mode);
    if (stat) await fs.utimes(tmp, secs(stat.atimeMs), secs(stat.mtimeMs));
    return tmp;
  }

  async function publish(tmp, dest, temps) {
    await fs.rename(tmp, dest); // same folder, so never EXDEV
    temps.splice(temps.indexOf(tmp), 1);
  }

  async function cleanup(temps) {
    for (const tmp of temps.splice(0)) await fs.unlink(tmp).catch(() => {});
  }

  // 409 unless `full` is still the very file (mtime, size, inode) that was read.
  async function recheck(full, expected) {
    let st;
    try {
      st = await fs.stat(full);
    } catch (e) {
      if (isGone(e)) throw changed();
      throw e;
    }
    if (!sameFile(st, expected)) throw changed();
  }

  function checkGuard(guard) {
    if (!guard || !guard.stat || !(guard.buf instanceof Uint8Array)) throw new TypeError('guard must be { buf, stat } from readGuarded');
  }

  const fileMode = (stat) => stat.mode & 0o777;
  const backupMode = (stat) => (stat.mode & 0o777) | 0o600; // we must always be able to read our own backup back

  // ---- public API ----------------------------------------------------------

  // Bytes + stat of a file. With `expectedMtime` (what the client last saw), 409 when it has moved on. The stat is
  // taken both before and after the read, so the bytes are known to belong to that stat.
  async function readGuarded(full, expectedMtime) {
    let before, buf, after;
    try {
      before = await fs.stat(full);
      buf = await fs.readFile(full);
      after = await fs.stat(full);
    } catch (e) {
      if (isGone(e)) throw httpError(404, MISSING_MSG);
      throw e;
    }
    if (!sameFile(before, after)) throw changed(); // being written while we read it
    if (expectedMtime !== undefined && expectedMtime !== null && !(Math.abs(after.mtimeMs - Number(expectedMtime)) <= 1)) throw changed();
    return { buf, stat: after };
  }

  // Runs fn after every earlier call for the same path has settled. A rejection only fails its own caller.
  function withLock(full, fn) {
    const key = path.resolve(full);
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(() => {}, () => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  // null when there is no previous version; otherwise when that version was last written (ms, like `stat.mtimeMs`).
  async function backupInfo(rel) {
    let st;
    try {
      st = await fs.stat(backupPathFor(rel));
    } catch (e) {
      if (isGone(e)) return null;
      throw e;
    }
    return st.isFile() ? { mtime: st.mtimeMs } : null;
  }

  // Replace `full` with `newBuf`, keeping what was there (guard.buf) as the previous version. 409 if the file is no
  // longer the one `guard` describes. Returns the fresh stat of the replaced file. Call inside withLock.
  async function replace(full, rel, newBuf, guard) {
    checkGuard(guard);
    if (!(newBuf instanceof Uint8Array)) throw new TypeError('newBuf must be a Buffer');
    const bakFull = backupPathForFile(full, rel);
    const { buf: oldBuf, stat: oldStat } = guard;

    await recheck(full, oldStat); // nothing is written for a file that already moved on
    await fs.mkdir(path.dirname(bakFull), { recursive: true, mode: 0o755 });

    const temps = [];
    try {
      const bakTmp = await writeTemp(bakFull, oldBuf, { mode: backupMode(oldStat), stat: oldStat }, temps);
      const newTmp = await writeTemp(full, newBuf, { mode: fileMode(oldStat) }, temps);
      await recheck(full, oldStat); // as late as possible: nothing is visible yet
      await publish(bakTmp, bakFull, temps);
      await publish(newTmp, full, temps);
    } catch (e) {
      await cleanup(temps);
      throw e;
    }
    return fs.stat(full);
  }

  // Swap the file and its previous version: the file gets the backup's bytes and times, the backup gets what the file
  // held (guard.buf) and its times. Run it twice and you are back where you started. Call inside withLock.
  async function restore(full, rel, guard) {
    checkGuard(guard);
    const bakFull = backupPathForFile(full, rel);
    const { buf: curBuf, stat: curStat } = guard;

    await recheck(full, curStat);
    let bakStat, bakBuf;
    try {
      bakStat = await fs.stat(bakFull);
      if (!bakStat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      bakBuf = await fs.readFile(bakFull);
    } catch (e) {
      if (isGone(e)) throw httpError(404, NO_BACKUP_MSG);
      throw e;
    }

    const temps = [];
    try {
      const bakTmp = await writeTemp(bakFull, curBuf, { mode: backupMode(curStat), stat: curStat }, temps);
      const fileTmp = await writeTemp(full, bakBuf, { mode: fileMode(curStat), stat: bakStat }, temps);
      await recheck(full, curStat);
      await publish(bakTmp, bakFull, temps); // the backup first: until the file is swapped, both hold the same bytes
      try {
        await publish(fileTmp, full, temps);
      } catch (e) {
        // The file is untouched but the backup already holds its bytes. Put the earlier version back (best effort).
        try {
          const back = await writeTemp(bakFull, bakBuf, { mode: backupMode(bakStat), stat: bakStat }, temps);
          await publish(back, bakFull, temps);
        } catch (_) { /* the original error is the one worth reporting */ }
        throw e;
      }
    } catch (e) {
      await cleanup(temps);
      throw e;
    }
    return fs.stat(full);
  }

  return {
    readGuarded,
    withLock,
    replace,
    restore,
    backupInfo,
    eligibility,
    lockCount: () => locks.size,
  };
}

module.exports = { createStore };
