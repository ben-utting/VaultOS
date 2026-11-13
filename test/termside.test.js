'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TS = require('../public/termside');

test('where a row is held, in words: Learn has its own', () => {
  assert.equal(TS.whereNote('learn'), 'elsewhere: open in Learn');
  assert.equal(TS.whereNote('detached'), 'detached: running in the background');
  assert.equal(TS.whereNote('window'), 'elsewhere: open in the Terminals window');
  assert.equal(TS.whereNote('dock'), 'elsewhere: open in the dock');
  assert.equal(TS.whereNote('tab'), 'elsewhere: open in another window');
});
