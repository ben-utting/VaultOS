'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuote, createQuotes } = require('../lib/today-quote');

test('normalizeQuote rejects the rate-limit quote', () => {
  assert.equal(normalizeQuote([{ q: 'Too many requests. Obtain an auth key for unlimited access.', a: 'zenquotes.io' }]), null);
  assert.deepEqual(normalizeQuote([{ q: '  Be\n one. ', a: ' Marcus ' }]), { text: 'Be one.', by: 'Marcus' });
  assert.equal(normalizeQuote([{ q: 'x'.repeat(500), a: 'A' }]).text.length, 400);
  assert.equal(normalizeQuote([{ q: 'Q', a: 'A'.repeat(200) }]).by.length, 100);
});

test('normalizeQuote rejects malformed bodies', () => {
  assert.equal(normalizeQuote({}), null);
  assert.equal(normalizeQuote(null), null);
  assert.equal(normalizeQuote([]), null);
  assert.equal(normalizeQuote([{ q: '   ', a: 'A' }]), null);
  assert.equal(normalizeQuote([{ q: 'Too many requests, slow down', a: 'X' }]), null);
  assert.deepEqual(normalizeQuote([{ q: 'Q' }]), { text: 'Q', by: '' });
});

test('today() backs off 10 minutes after a failure', async () => {
  let t = 0; const calls = [];
  const q = createQuotes({ now: () => t, fetch: async (u) => { calls.push(u); throw new Error('down'); } });
  assert.equal(await q.today(), null);
  t += 9 * 60e3; assert.equal(await q.today(), null); assert.equal(calls.length, 1);
  t += 2 * 60e3; await q.today(); assert.equal(calls.length, 2);
  assert.equal(calls[0], 'https://zenquotes.io/api/today');
});

test('today() treats the rate-limit quote as a failure and passes a timeout signal', async () => {
  let t = 0; let opts;
  const q = createQuotes({ now: () => t, fetch: async (u, o) => { opts = o; return { ok: true, json: async () => [{ q: 'Too many requests.', a: 'zenquotes.io' }] }; } });
  assert.equal(await q.today(), null);
  assert.ok(opts.signal instanceof AbortSignal);
  const good = createQuotes({ now: () => t, fetch: async () => ({ ok: true, json: async () => [{ q: 'Q', a: 'A' }] }) });
  assert.deepEqual(await good.today(), { text: 'Q', by: 'A' });
});

test('random() refuses within 6 s and maps failures to 502', async () => {
  let t = 0; const calls = [];
  const q = createQuotes({ now: () => t, fetch: async (u) => { calls.push(u); return { ok: true, json: async () => [{ q: 'Q', a: 'A' }] }; } });
  assert.deepEqual(await q.random(), { text: 'Q', by: 'A' });
  assert.equal(calls[0], 'https://zenquotes.io/api/random');
  t += 5000; await assert.rejects(q.random(), (e) => e.status === 429);
  t += 1000; assert.deepEqual(await q.random(), { text: 'Q', by: 'A' });
  const bad = createQuotes({ now: () => 0, fetch: async () => ({ ok: false, json: async () => ({}) }) });
  await assert.rejects(bad.random(), (e) => e.status === 502);
});
