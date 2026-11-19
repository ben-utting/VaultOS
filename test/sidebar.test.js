'use strict';
// The sidebar's pure decisions (spec 2026-11-19 §5): first state, storage, phone width, when Ctrl+B may toggle,
// tooltip text, and what each count slot shows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../public/sidebar-core');

test('initialState: the stored choice wins, else the width default', () => {
  assert.equal(SC.initialState(1440, null), 'open');
  assert.equal(SC.initialState(1280, null), 'open');
  assert.equal(SC.initialState(1279, null), 'rail');
  assert.equal(SC.initialState(701, null), 'rail');
  assert.equal(SC.initialState(1440, 'rail'), 'rail');
  assert.equal(SC.initialState(900, 'open'), 'open');
  assert.equal(SC.initialState(1440, 'junk'), 'open');
});
test('readStored: a blocked or odd storage reads as nothing', () => {
  assert.equal(SC.readStored({ getItem: () => 'rail' }), 'rail');
  assert.equal(SC.readStored({ getItem: () => 'wide' }), null);
  assert.equal(SC.readStored({ getItem: () => { throw new Error('SecurityError'); } }), null);
  assert.equal(SC.readStored(undefined), null);
});
test('isPhone at the existing 700px breakpoint', () => {
  assert.equal(SC.isPhone(700), true);
  assert.equal(SC.isPhone(701), false);
});
test('shortcutAllowed: never while typing or in a terminal', () => {
  const el = (tagName, { editable = false, inside = [] } = {}) => ({ tagName, isContentEditable: editable, closest: (s) => (s.split(',').some((x) => inside.includes(x.trim())) ? {} : null) });
  assert.equal(SC.shortcutAllowed(el('BODY')), true);
  assert.equal(SC.shortcutAllowed(el('BUTTON')), true);
  for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(SC.shortcutAllowed(el(t)), false, t);
  assert.equal(SC.shortcutAllowed(el('DIV', { editable: true })), false);
  assert.equal(SC.shortcutAllowed(el('DIV', { inside: ['.xterm'] })), false);
  assert.equal(SC.shortcutAllowed(el('DIV', { inside: ['#term-area'] })), false);
  assert.equal(SC.shortcutAllowed(null), true);
});
test('tipText: name, then status when there is one', () => {
  assert.equal(SC.tipText('Calendar', '2 due'), 'Calendar · 2 due');
  assert.equal(SC.tipText('Files', ''), 'Files');
  assert.equal(SC.tipText('Terminals', null), 'Terminals');
});
test('constants', () => {
  assert.equal(SC.STORE_KEY, 'vaultboard.sidebar');
  assert.equal(SC.OPEN_MIN, 1280);
  assert.equal(SC.PHONE_MAX, 700);
});
