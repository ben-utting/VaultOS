'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kb-reads');
const { zoneAtHour } = require('./helpers/zone');

const DAY = 86400000;
const at = (iso) => Date.parse(iso);
const words = (n, w = 'word') => Array(n).fill(w).join(' ');
const art = (key, extra) => ({ path: `Personal/1. a/${key}/article.md`, title: key, status: 'published', updated: '', created: '', ...extra });

test('constants', () => {
  assert.equal(K.READS_REL, '.vaultos/kb-reads.json');
  assert.equal(K.MORNING_START, 5);
  assert.equal(K.MORNING_END, 12);
  assert.equal(K.STALE_DAYS, 30);
  assert.equal(K.SKIP_DAYS, 90);
  assert.equal(K.WORDS_PER_MIN, 200);
  assert.deepEqual(K.emptyState(), { version: 1, articles: {}, morning: null });
});

test('articleKey is the job folder name', () => {
  assert.equal(K.articleKey('Personal/1. apps/_done/38-cloudflare/article.md'), '38-cloudflare');
  assert.equal(K.articleKey('Personal/1. apps/38-cloudflare/article.md'), '38-cloudflare');
});

test('readingMinutes: words / 200, rounded, at least 1, code and comments left out', () => {
  assert.equal(K.readingMinutes(words(400)), 2);
  assert.equal(K.readingMinutes(words(50)), 1);
  assert.equal(K.readingMinutes(''), 1);
  assert.equal(K.readingMinutes(`${words(1000)}\n\n\`\`\`sh\n${words(600, 'code')}\n\`\`\`\n`), 5);
  assert.equal(K.readingMinutes(`${words(400)}\n<!-- ${words(600, 'hidden')} -->\n`), 2);
});

test('readState: unread, read, or updated since the read (by date in the zone)', () => {
  const tz = 'Europe/London';
  assert.equal(K.readState({ updated: '2026-10-01' }, undefined, tz), 'unread');
  assert.equal(K.readState({ updated: '2026-10-01' }, { skipUntil: at('2027-01-01T00:00Z') }, tz), 'unread');
  assert.equal(K.readState({ updated: '2026-10-01' }, { read: at('2026-10-01T10:00Z') }, tz), 'read');
  assert.equal(K.readState({ updated: '2026-10-02' }, { read: at('2026-10-01T10:00Z') }, tz), 'updated');
  // 23:30 UTC on the 1st is 00:30 on the 2nd in London (BST): read the same day it was updated.
  assert.equal(K.readState({ updated: '2026-10-02' }, { read: at('2026-10-01T23:30Z') }, tz), 'read');
  assert.equal(K.readState({ updated: '' }, { read: at('2026-10-01T10:00Z') }, tz), 'read');
});

test('readState: a hand-edited read that is not a time counts as unread, never throws', () => {
  for (const read of ['yesterday', NaN, null, -5, {}]) {
    assert.equal(K.readState({ updated: '2026-10-01' }, { read }, 'UTC'), 'unread', String(read));
  }
  const now = at('2026-10-29T08:00Z');
  assert.deepEqual(K.morningCandidates([art('A', { updated: '2026-10-01' })], { A: { read: 'yesterday' } }, now, 'UTC')
    .map((c) => c.reason), ['unread']);
});

test('inMorning: 05:00 up to, not including, 12:00 in the zone', () => {
  assert.equal(K.inMorning(at('2026-10-29T04:59Z'), 'UTC'), false);
  assert.equal(K.inMorning(at('2026-10-29T05:00Z'), 'UTC'), true);
  assert.equal(K.inMorning(at('2026-10-29T11:59Z'), 'UTC'), true);
  assert.equal(K.inMorning(at('2026-10-29T12:00Z'), 'UTC'), false);
  assert.equal(K.inMorning(at('2026-07-01T04:30Z'), 'Europe/London'), true);   // 05:30 BST
});

test('zoneAtHour finds a zone at that local hour, at every UTC hour', () => {
  for (let h = 0; h < 24; h++) {
    const now = at(`2026-10-29T${String(h).padStart(2, '0')}:30Z`);
    assert.equal(K.inMorning(now, zoneAtHour(8, now)), true, `08:00 zone at ${h}:30 UTC`);
    assert.equal(K.inMorning(now, zoneAtHour(15, now)), false, `15:00 zone at ${h}:30 UTC`);
  }
});

test('morningCandidates: updated, then unread, then stale; drafts, skips and recent reads left out', () => {
  const now = at('2026-10-29T08:00Z');
  const articles = [
    art('A', { updated: '2026-10-20' }),
    art('B', { updated: '2026-10-25' }),
    art('C', { updated: '2026-10-10' }),
    art('D', { updated: '2026-10-27' }),
    art('E', { updated: '2026-08-01' }),
    art('F', { updated: '2026-07-01' }),
    art('G', { status: 'draft', updated: '2026-10-28' }),
    art('H', { updated: '2026-10-28' }),
    art('I', { updated: '2026-10-28' }),
    art('J', { updated: '2026-10-01' }),
  ];
  const entries = {
    A: { read: at('2026-09-01T12:00Z') },
    B: { read: at('2026-10-26T12:00Z') },
    E: { read: at('2026-09-10T12:00Z') },
    F: { read: at('2026-08-01T12:00Z') },
    H: { skipUntil: now + DAY },
    I: { read: at('2026-10-27T12:00Z') },
    J: { skipUntil: now - DAY },
  };
  const got = K.morningCandidates(articles, entries, now, 'UTC');
  assert.deepEqual(got.map((c) => [c.article.title, c.reason]), [
    ['I', 'updated'], ['A', 'updated'],
    ['D', 'unread'], ['C', 'unread'], ['J', 'unread'],
    ['F', 'stale'], ['E', 'stale'],
  ]);
  assert.equal(K.morningPick(articles, entries, now, 'UTC').article.title, 'I');
  assert.equal(K.morningPick([], {}, now, 'UTC'), null);
});

test('morningCandidates: equal dates order by title; unread falls back to created', () => {
  const now = at('2026-10-29T08:00Z');
  const got = K.morningCandidates([
    art('k2', { title: 'Zebra', updated: '2026-10-01' }),
    art('k1', { title: 'Apple', updated: '2026-10-01' }),
    art('k3', { title: 'Mango', created: '2026-10-05' }),
  ], {}, now, 'UTC');
  assert.deepEqual(got.map((c) => c.article.title), ['Mango', 'Apple', 'Zebra']);
});

test('mergeImport: newer wins, junk and unknown boards dropped, input untouched', () => {
  const now = at('2026-10-29T08:00Z');
  const boards = [{ key: 'personal', dir: 'Personal' }, { key: 'work', dir: 'Work' }];
  const state = { ...K.emptyState(), articles: { personal: { '38-x': { read: 5000 } } } };
  const before = JSON.stringify(state);
  const { state: next, imported } = K.mergeImport(state, boards, {
    'Personal/1. apps/38-x/article.md': 4000,
    'Personal/1. apps/_done/39-y/article.md': 6000,
    'Work/2. ops/05-z/article.md': 7000,
    'Archive/1. a/09-q/article.md': 8000,
    'Personal/a/../40-w/article.md': 1,
    'Personal/1. apps/41-v/article.md': 'yesterday',
    'Personal/1. apps/42-u/article.md': now + 2 * DAY,
    'Personal/1. apps/43-t/task.md': 9000,
  }, now);
  assert.equal(imported, 2);
  assert.deepEqual(next.articles, {
    personal: { '38-x': { read: 5000 }, '39-y': { read: 6000 } },
    work: { '05-z': { read: 7000 } },
  });
  assert.equal(JSON.stringify(state), before);
});

test('mergeImport: a newer import replaces an older read and keeps skipUntil', () => {
  const state = { ...K.emptyState(), articles: { personal: { '38-x': { read: 1000, skipUntil: 99 } } } };
  const { state: next, imported } = K.mergeImport(state, [{ key: 'personal', dir: 'Personal' }],
    { 'Personal/1. apps/_done/38-x/article.md': 2000 }, 5000);
  assert.equal(imported, 1);
  assert.deepEqual(next.articles.personal['38-x'], { read: 2000, skipUntil: 99 });
});
