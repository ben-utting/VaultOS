'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../lib/kb-reads');

function vault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-kbreads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (dir) => path.join(dir, K.READS_REL);

test('no file is an empty store', (t) => {
  const store = K.createReadStore(vault(t));
  assert.deepEqual(store.get(), K.emptyState());
  assert.equal(store.damaged(), null);
});

test('update writes .vaultos/kb-reads.json, and a new store reads it back', async (t) => {
  const dir = vault(t);
  const store = K.createReadStore(dir);
  await store.update((s) => { s.articles.personal = { '01-a': { read: 1000 } }; return s; });
  const raw = fs.readFileSync(file(dir), 'utf8');
  assert.equal(raw, JSON.stringify(store.get(), null, 2) + '\n');
  assert.deepEqual(K.createReadStore(dir).get().articles, { personal: { '01-a': { read: 1000 } } });
});

test('update hands fn a copy: a throwing fn leaves memory and disk alone', async (t) => {
  const dir = vault(t);
  const store = K.createReadStore(dir);
  await assert.rejects(store.update((s) => { s.articles.x = {}; throw new Error('no'); }), /no/);
  assert.deepEqual(store.get(), K.emptyState());
  assert.equal(fs.existsSync(file(dir)), false);
});

test('parallel updates all land, in memory and on disk', async (t) => {
  const dir = vault(t);
  const store = K.createReadStore(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update((s) => {
    s.articles.personal = { ...s.articles.personal, [`k${i}`]: { read: i + 1 } };
    return s;
  })));
  assert.equal(Object.keys(store.get().articles.personal).length, 20);
  assert.equal(Object.keys(K.createReadStore(dir).get().articles.personal).length, 20);
});

for (const [name, text] of [['unparseable', '{not json'], ['another version', '{"version":2}'], ['articles not an object', '{"version":1,"articles":[]}']]) {
  test(`a damaged file (${name}) reads as empty and is never overwritten`, async (t) => {
    const dir = vault(t);
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    fs.writeFileSync(file(dir), text);
    const store = K.createReadStore(dir);
    assert.deepEqual(store.get(), K.emptyState());
    assert.equal(store.damaged(), K.DAMAGED_MSG);
    assert.equal(K.DAMAGED_MSG, '.vaultos/kb-reads.json is damaged. Fix or delete it.');
    await assert.rejects(store.update((s) => s), (err) => err.message === K.DAMAGED_MSG && err.status === 500);
    assert.equal(fs.readFileSync(file(dir), 'utf8'), text);
  });
}
