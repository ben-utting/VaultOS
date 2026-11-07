'use strict';
// Password, session secret and lockout state, all stored in DATA_DIR.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_PASSWORD = 8;
const EMPTY_LOCKOUT = { attempts: 0, lockedUntil: 0, lockLevel: 0 };

function dataDirFrom(env) {
  return env.DATA_DIR || path.join(os.homedir(), '.vaultos');
}

// null when no config exists yet; throws on unparseable JSON.
function readConfig(dataDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(raw);
}

// Synchronous on purpose: callers rely on it to make concurrent setup requests safe.
// A new password always gets a new session secret, so every cookie signed under the
// old one stops working. Setup passes the secret its session middleware already holds.
function writePassword(dataDir, password, { sessionSecret } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const existing = readConfig(dataDir);
  const salt = crypto.randomBytes(16);
  const config = {
    ...existing,
    salt: salt.toString('hex'),
    passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'),
    sessionSecret: sessionSecret || crypto.randomBytes(32).toString('hex'),
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  // Reset any lockout by REWRITING the file, never unlinking it: it may be a bind-mounted
  // file, and deleting it destroys the inode the mount points at.
  writeLockout(dataDir, EMPTY_LOCKOUT);
  return config;
}

function verifyPassword(config, password) {
  const salt = Buffer.from(config.salt, 'hex');
  const hash = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(config.passwordHash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

function readLockout(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'lockout.json'), 'utf8')); }
  catch { return { ...EMPTY_LOCKOUT }; }
}
function writeLockout(dataDir, state) {
  fs.writeFileSync(path.join(dataDir, 'lockout.json'), JSON.stringify(state));
}

module.exports = { MIN_PASSWORD, dataDirFrom, readConfig, writePassword, verifyPassword, readLockout, writeLockout };
