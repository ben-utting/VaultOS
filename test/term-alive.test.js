'use strict';
// lib/term-alive.js: is the page holding a terminal still there? (heartbeat + on-the-spot probe)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAlive } = require('../lib/term-alive');

// A socket stand-in: answers pings when `answers` is true, like a page that is open; a frozen one doesn't.
class FakeWs extends EventEmitter {
  constructor(answers = true) { super(); this.answers = answers; this.readyState = 1; this.pings = 0; this.terminated = false; }
  ping() { this.pings++; if (this.answers) setImmediate(() => this.emit('pong')); }
  terminate() { this.terminated = true; this.readyState = 3; }
}
const tick = () => new Promise((r) => setImmediate(r));

test('a beat pings every socket; one that never answered by the next beat is ended', async () => {
  const alive = createAlive({ probeMs: 50 });
  const open = new FakeWs(true);
  const frozen = new FakeWs(false);
  alive.track(open);
  alive.track(frozen);
  alive.beat([open, frozen]);
  await tick();
  assert.equal(open.pings, 1);
  assert.equal(frozen.pings, 1);
  assert.equal(frozen.terminated, false, 'one missed answer is not enough yet');
  alive.beat([open, frozen]);
  await tick();
  assert.equal(open.terminated, false);
  assert.equal(frozen.terminated, true);
});

test('a socket that answers late, but before the next beat, is kept', async () => {
  const alive = createAlive({ probeMs: 50 });
  const slow = new FakeWs(false);
  alive.track(slow);
  alive.beat([slow]);
  slow.emit('pong');
  alive.beat([slow]);
  assert.equal(slow.terminated, false);
});

test('a probe says true for a socket that answers and leaves it open', async () => {
  const alive = createAlive({ probeMs: 200 });
  const ws = new FakeWs(true);
  alive.track(ws);
  assert.equal(await alive.probe(ws), true);
  assert.equal(ws.terminated, false);
  assert.equal(ws.listenerCount('pong'), 1, 'the probe removes its own listener');
});

test('a probe ends a socket that does not answer in time and says false', async () => {
  const alive = createAlive({ probeMs: 40 });
  const ws = new FakeWs(false);
  alive.track(ws);
  const t0 = Date.now();
  assert.equal(await alive.probe(ws), false);
  assert.ok(Date.now() - t0 >= 35);
  assert.equal(ws.terminated, true);
});

test('a probe of a socket that is already closing says false without pinging', async () => {
  const alive = createAlive({ probeMs: 40 });
  const ws = new FakeWs(true);
  ws.readyState = 2;
  assert.equal(await alive.probe(ws), false);
  assert.equal(ws.pings, 0);
});

test('a ping that throws counts as no answer', async () => {
  const alive = createAlive({ probeMs: 40 });
  const ws = new FakeWs(true);
  ws.ping = () => { throw new Error('not open'); };
  alive.track(ws);
  assert.equal(await alive.probe(ws), false);
  assert.equal(ws.terminated, true);
  assert.doesNotThrow(() => alive.beat([ws]));
});
