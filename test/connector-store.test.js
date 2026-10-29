'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, STORE_REL } = require('../lib/connector-store');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-conn-'));

test('load on an empty home creates the file with a 43-character relayKey, mode 0600, folder 0700', async () => {
  const home = tmpHome();
  const store = createStore({ home });
  const s = await store.load();
  assert.equal(s.version, 1);
  assert.equal(s.relayKey.length, 43);
  assert.deepEqual(s.connectors, {});
  assert.deepEqual(s.written, {});
  const file = path.join(home, STORE_REL);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(store.wasReset(), false);
});

test('the relayKey survives a second load', async () => {
  const home = tmpHome();
  const a = await createStore({ home }).load();
  const b = await createStore({ home }).load();
  assert.equal(a.relayKey, b.relayKey);
});

test('update writes are serialised', async () => {
  const home = tmpHome();
  const store = createStore({ home });
  await store.load();
  await Promise.all([
    store.update((d) => { d.connectors.a = { n: 1 }; }),
    store.update((d) => { d.connectors.b = { n: 2 }; }),
  ]);
  assert.deepEqual(Object.keys(store.get().connectors).sort(), ['a', 'b']);
  const disk = JSON.parse(fs.readFileSync(path.join(home, STORE_REL), 'utf8'));
  assert.deepEqual(Object.keys(disk.connectors).sort(), ['a', 'b']);
  assert.equal(fs.statSync(path.join(home, STORE_REL)).mode & 0o777, 0o600);
});

for (const bad of ['{', '{"version":2}']) {
  test(`a damaged file is moved to connectors.json.bad-<now> and load starts empty with wasReset() true (${bad})`, async () => {
    const home = tmpHome();
    const file = path.join(home, STORE_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bad);
    const store = createStore({ home, now: () => 1234 });
    const s = await store.load();
    assert.equal(store.wasReset(), true);
    assert.deepEqual(s.connectors, {});
    assert.equal(s.relayKey.length, 43);
    assert.equal(fs.readFileSync(`${file}.bad-1234`, 'utf8'), bad);
  });
}

test('get() returns a copy', async () => {
  const store = createStore({ home: tmpHome() });
  await store.load();
  store.get().connectors.x = 1;
  assert.deepEqual(store.get().connectors, {});
});
