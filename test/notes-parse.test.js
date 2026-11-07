'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/notes-parse');

test('isStamp', () => {
  assert.equal(P.isStamp(' 2026-11-01 09:12 '), true);
  assert.equal(P.isStamp('2026-11-01'), false);
});

test('firstLine skips the stamp, Status and Tags lines and heading marks', () => {
  assert.equal(P.firstLine('2026-11-01 09:12\n\n## Big idea here\nrest'), 'Big idea here');
  assert.equal(P.firstLine('2026-11-01 09:12\n\nStatus #baby\n\nTags [[a]]\n\n## Title\n'), 'Title');
  assert.equal(P.firstLine('\n\n'), '');
  assert.equal(P.firstLine('y'.repeat(200)).length, 120);
});

test('readStatus', () => {
  assert.equal(P.readStatus('x\nStatus #child #quote\n'), 'child');
  assert.equal(P.readStatus('Status\n'), null);
  assert.equal(P.readStatus('no status'), null);
});

test('readTags', () => {
  assert.deepEqual(P.readTags('Tags [[productivity]] [[AI|ai]] [[Deep work#2]]\n'), ['productivity', 'AI', 'Deep work']);
  assert.deepEqual(P.readTags('Tags\n'), []);
  assert.deepEqual(P.readTags('nothing'), []);
});
