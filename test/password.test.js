'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pw = require('../lib/password');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-pw-'));

test('writePassword creates the dir and a verifiable config', () => {
  const dir = path.join(tmp(), 'nested', 'data');
  const cfg = pw.writePassword(dir, 'correct horse');
  assert.match(cfg.salt, /^[0-9a-f]{32}$/);
  assert.match(cfg.passwordHash, /^[0-9a-f]{128}$/);
  assert.equal(pw.verifyPassword(cfg, 'correct horse'), true);
  assert.equal(pw.verifyPassword(cfg, 'wrong'), false);
  assert.deepEqual(pw.readConfig(dir), cfg);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('a new password gets a new sessionSecret', () => {
  const dir = tmp();
  const first = pw.writePassword(dir, 'password one', { sessionSecret: 'abc' });
  const second = pw.writePassword(dir, 'password two');
  assert.equal(first.sessionSecret, 'abc');
  assert.match(second.sessionSecret, /^[0-9a-f]{64}$/);
  assert.equal(pw.readConfig(dir).sessionSecret, second.sessionSecret);
  assert.equal(pw.verifyPassword(second, 'password two'), true);
});

test('uses the given sessionSecret when there is no config', () => {
  assert.equal(pw.writePassword(tmp(), 'password one', { sessionSecret: 'given' }).sessionSecret, 'given');
  assert.match(pw.writePassword(tmp(), 'password one').sessionSecret, /^[0-9a-f]{64}$/);
});

test('lockout.json is rewritten in place', () => {
  const dir = tmp();
  const f = path.join(dir, 'lockout.json');
  pw.writeLockout(dir, { attempts: 4, lockedUntil: 99, lockLevel: 2 });
  const ino = fs.statSync(f).ino;
  pw.writePassword(dir, 'password one');
  assert.equal(fs.statSync(f).ino, ino);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { attempts: 0, lockedUntil: 0, lockLevel: 0 });
  assert.deepEqual(pw.readLockout(dir), { attempts: 0, lockedUntil: 0, lockLevel: 0 });
});

test('readLockout defaults when missing', () => {
  assert.deepEqual(pw.readLockout(tmp()), { attempts: 0, lockedUntil: 0, lockLevel: 0 });
});

test('refuses a 7-character password', () => {
  const dir = tmp();
  assert.throws(() => pw.writePassword(dir, '1234567'), /Password must be at least 8 characters/);
  assert.equal(pw.readConfig(dir), null);
});

test('readConfig returns null when missing, throws on bad JSON', () => {
  const dir = tmp();
  assert.equal(pw.readConfig(dir), null);
  fs.writeFileSync(path.join(dir, 'config.json'), '{nope');
  assert.throws(() => pw.readConfig(dir));
});

test('dataDirFrom', () => {
  assert.equal(pw.dataDirFrom({ DATA_DIR: '/x' }), '/x');
  assert.equal(pw.dataDirFrom({}), path.join(os.homedir(), '.vaultos'));
});
