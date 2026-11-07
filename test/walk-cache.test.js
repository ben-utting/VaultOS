'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWalkCache } = require('../lib/walk-cache');

// A walk that counts its calls and finishes when told to.
function fakeWalk() {
  const w = { calls: 0, pending: [] };
  w.fn = () => { w.calls++; return new Promise((resolve) => w.pending.push(resolve)); };
  w.finish = (v) => w.pending.shift()(v);
  return w;
}
const tick = () => new Promise((r) => setImmediate(r));

test('two concurrent gets share one walk', async () => {
  const w = fakeWalk();
  const c = createWalkCache(w.fn, { maxAgeMs: 30e3 });
  const a = c.get();
  const b = c.get();
  await tick();
  assert.equal(w.calls, 1);
  w.finish(['x']);
  assert.deepEqual(await a, ['x']);
  assert.equal(await b, await a);
});

test('within maxAgeMs the cached listing answers; past it a new walk runs', async () => {
  let now = 1000;
  const w = fakeWalk();
  const c = createWalkCache(w.fn, { maxAgeMs: 30e3, now: () => now });
  const first = c.get(); await tick(); w.finish(['one']); await first;
  now += 29e3;
  assert.deepEqual(await c.get(), ['one']);
  assert.equal(w.calls, 1);
  now += 1e3;
  const second = c.get(); await tick();
  assert.equal(w.calls, 2);
  w.finish(['two']);
  assert.deepEqual(await second, ['two']);
  assert.deepEqual(await c.get(), ['two']);
  assert.equal(w.calls, 2);
});

test('invalidate makes the next get walk again', async () => {
  const w = fakeWalk();
  const c = createWalkCache(w.fn);
  const first = c.get(); await tick(); w.finish(['old']); await first;
  c.invalidate();
  const next = c.get(); await tick();
  assert.equal(w.calls, 2);
  w.finish(['new']);
  assert.deepEqual(await next, ['new']);
});

test('a walk running when invalidate came answers its callers but is not kept', async () => {
  const w = fakeWalk();
  const c = createWalkCache(w.fn);
  const early = c.get(); await tick();
  c.invalidate();
  const late = c.get(); await tick();
  assert.equal(w.calls, 2);
  w.finish(['before the write']);
  w.finish(['after the write']);
  assert.deepEqual(await early, ['before the write']);
  assert.deepEqual(await late, ['after the write']);
  assert.deepEqual(await c.get(), ['after the write']);
  assert.equal(w.calls, 2);
});

test('a failed walk is not kept: the next get walks again', async () => {
  let calls = 0;
  const c = createWalkCache(async () => { calls++; if (calls === 1) throw new Error('EIO'); return ['ok']; });
  await assert.rejects(c.get(), /EIO/);
  assert.deepEqual(await c.get(), ['ok']);
  assert.equal(calls, 2);
});
