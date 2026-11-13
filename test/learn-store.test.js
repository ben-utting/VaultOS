'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLearnStore } = require('../lib/learn-store');
const { LearnError } = require('../lib/learn-names');

const KEY = 'sk-or-v1-abcdefgh1234wxyz';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (h) => path.join(h, '.vaultos', 'learn.json');
const mode = (p) => fs.statSync(p).mode & 0o777;

test('no key anywhere', async (t) => {
  const s = createLearnStore({ home: home(t), env: {} });
  assert.deepEqual(await s.status(), { set: false, source: null, last4: null });
  assert.equal(await s.key(), null);
});

test('a saved key: 0600 file in a 0700 folder, status shows only the last four', async (t) => {
  const h = home(t);
  const s = createLearnStore({ home: h, env: {} });
  await s.save(KEY);
  assert.equal(mode(file(h)), 0o600);
  assert.equal(mode(path.dirname(file(h))), 0o700);
  assert.deepEqual(await s.status(), { set: true, source: 'saved', last4: 'wxyz' });
  assert.ok(!JSON.stringify(await s.status()).includes('sk-or-'));
  assert.equal(await s.key(), KEY);
  assert.equal(JSON.parse(fs.readFileSync(file(h), 'utf8')).openrouterKey, KEY);
});

test('a pasted key loses spaces, newlines and one pair of quotes (Review Focus 3)', async (t) => {
  const s = createLearnStore({ home: home(t), env: {} });
  await s.save(`  "${KEY}"\n`);
  assert.equal(await s.key(), KEY);
  await s.save(`'${KEY}'`);
  assert.equal(await s.key(), KEY);
  await s.save(`\t${KEY}\r\n`);
  assert.equal(await s.key(), KEY);
});

test('something that is not an OpenRouter key is 400 and changes nothing', async (t) => {
  const h = home(t);
  const s = createLearnStore({ home: h, env: {} });
  for (const bad of ['hello', 'sk-or-', 'sk-ant-abcdefghijk', `sk-or-${'a'.repeat(200)}`, 'sk-or-abc def ghij', '', 42, null]) {
    await assert.rejects(s.save(bad), (e) => e instanceof LearnError && e.status === 400 && /OpenRouter key/.test(e.message), JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(file(h)), false);
});

test('the environment key is used when none is saved, and a saved key wins', async (t) => {
  const s = createLearnStore({ home: home(t), env: { OPENROUTER_API_KEY: 'sk-or-v1-fromtheenv9876' } });
  assert.deepEqual(await s.status(), { set: true, source: 'env', last4: '9876' });
  assert.equal(await s.key(), 'sk-or-v1-fromtheenv9876');
  await s.save(KEY);
  assert.deepEqual(await s.status(), { set: true, source: 'saved', last4: 'wxyz' });
  assert.equal(await s.key(), KEY);
});

test('an environment value that is not a key is ignored', async (t) => {
  const s = createLearnStore({ home: home(t), env: { OPENROUTER_API_KEY: 'REPLACE_ME' } });
  assert.deepEqual(await s.status(), { set: false, source: null, last4: null });
});

test('a damaged file is moved aside, never overwritten', async (t) => {
  const h = home(t);
  fs.mkdirSync(path.dirname(file(h)), { recursive: true });
  fs.writeFileSync(file(h), '{not json');
  const s = createLearnStore({ home: h, env: {}, now: () => 1234 });
  assert.deepEqual(await s.status(), { set: false, source: null, last4: null });
  assert.equal(fs.readFileSync(`${file(h)}.bad-1234`, 'utf8'), '{not json');
  assert.equal(fs.existsSync(file(h)), false);
  await s.save(KEY);
  assert.equal(await s.key(), KEY);
});

test('remove deletes the saved key, and is fine when there is none', async (t) => {
  const h = home(t);
  const s = createLearnStore({ home: h, env: {} });
  await s.remove();
  await s.save(KEY);
  await s.remove();
  assert.equal(fs.existsSync(file(h)), false);
  assert.deepEqual(await s.status(), { set: false, source: null, last4: null });
});
