'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isMounted, folderCheck, setupStage, stepsFor, windowOpen } = require('../lib/setup');
const S = require('../lib/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-setup-'));

test('isMounted compares device ids with /', () => {
  const stat = (dev) => (p) => ({ dev: p === '/' ? 1 : dev });
  assert.equal(isMounted('/vault', stat(2)), true);
  assert.equal(isMounted('/vault', stat(1)), false);
});

test('folderCheck states', async () => {
  const d = tmp();
  let r = await folderCheck(d);
  assert.equal(r.state, 'empty');
  assert.equal(r.writable, true);
  assert.equal(r.boardCount, 0);
  assert.equal(typeof r.mounted, 'boolean');
  assert.deepEqual(fs.readdirSync(d), []); // the probe leaves nothing behind

  fs.writeFileSync(path.join(d, '.stfolder'), '');
  assert.equal((await folderCheck(d)).state, 'empty');

  fs.writeFileSync(path.join(d, 'notes.md'), 'hi');
  assert.equal((await folderCheck(d)).state, 'has-files');

  const e = tmp();
  fs.mkdirSync(path.join(e, '.vaultos'));
  const s = { ...S.defaults(), boards: ['alpha', 'Beta'].map((dir) => ({ key: S.boardKey(dir), dir, label: dir, hidden: false })) };
  fs.writeFileSync(path.join(e, S.SETTINGS_REL), JSON.stringify(s));
  r = await folderCheck(e);
  assert.equal(r.state, 'existing');
  assert.equal(r.boardCount, 2);
});

test('folderCheck: invalid settings file is not "existing"', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.vaultos'));
  fs.writeFileSync(path.join(d, S.SETTINGS_REL), '{nope');
  assert.equal((await folderCheck(d)).state, 'empty');
});

test('folderCheck: a throwing probe means not writable', async () => {
  const d = tmp();
  const r = await folderCheck(d, { probeWrite: async () => { throw new Error('EACCES'); } });
  assert.equal(r.writable, false);
});

test('folderCheck uses the injected stat for mounted', async () => {
  const d = tmp();
  const r = await folderCheck(d, { stat: (p) => ({ dev: p === '/' ? 1 : 2 }) });
  assert.equal(r.mounted, true);
});

test('setupStage follows the table', () => {
  const st = S.defaults();
  assert.equal(setupStage({ hasPassword: false, settings: null }), 'full');
  assert.equal(setupStage({ hasPassword: false, settings: st }), 'existing-folder');
  assert.equal(setupStage({ hasPassword: true, settings: null }), 'boards');
  assert.equal(setupStage({ hasPassword: true, settings: st }), 'resume');
  assert.equal(setupStage({ hasPassword: true, settings: { ...st, setupDone: true } }), 'done');
  assert.equal(setupStage({ hasPassword: true, settings: null, settingsError: new Error('x') }), 'broken');
  assert.equal(setupStage({ hasPassword: false, settings: null, settingsError: 'bad' }), 'broken');
});

test('stepsFor', () => {
  assert.deepEqual(stepsFor('full'), [1, 2, 3, 4, 5]);
  assert.deepEqual(stepsFor('existing-folder'), [1, 2, 4]);
  assert.deepEqual(stepsFor('boards'), [3, 4, 5]);
  assert.deepEqual(stepsFor('resume', { boards: [{}] }), [4, 5]);
  assert.deepEqual(stepsFor('resume', { boards: [] }), [3, 4, 5]);
  assert.deepEqual(stepsFor('done'), []);
  assert.deepEqual(stepsFor('broken'), [1]);
});

test('windowOpen', () => {
  assert.equal(windowOpen(0, 899999, 15), true);
  assert.equal(windowOpen(0, 900000, 15), false);
  assert.equal(windowOpen(0, 0, 0), false);
  assert.equal(windowOpen(5, 5, 0), false);
});
