'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/connectors');

test('stateChip covers the six states with the exact copy', () => {
  assert.deepEqual(C.stateChip('not-installed'), { text: 'Not installed', tone: 'plain' });
  assert.deepEqual(C.stateChip('not-connected'), { text: 'Not connected', tone: 'plain' });
  assert.deepEqual(C.stateChip('connecting'), { text: 'Connecting…', tone: 'plain' });
  assert.deepEqual(C.stateChip('connected'), { text: 'Connected', tone: 'ok' });
  assert.deepEqual(C.stateChip('needs-sign-in'), { text: 'Sign in again', tone: 'warn' });
  assert.deepEqual(C.stateChip('error'), { text: 'Error', tone: 'warn' });
});

test('agentChip tones', () => {
  assert.deepEqual(C.agentChip('Added'), { text: 'Added', tone: 'ok' });
  assert.deepEqual(C.agentChip('Has its own entry'), { text: 'Has its own entry', tone: 'warn' });
  assert.deepEqual(C.agentChip('Not installed'), { text: 'Not installed', tone: 'plain' });
  assert.deepEqual(C.agentChip('No connectors in Pi'), { text: 'No connectors in Pi', tone: 'plain' });
});

test('minutesLeft rounds up and stops at 0', () => {
  const now = 1_000_000;
  assert.equal(C.minutesLeft(now + 61_000, now), 2);
  assert.equal(C.minutesLeft(now + 60_000, now), 1);
  assert.equal(C.minutesLeft(now + 1, now), 1);
  assert.equal(C.minutesLeft(now, now), 0);
  assert.equal(C.minutesLeft(now - 5000, now), 0);
});

test('server text with markup is escaped in the rendered pane', () => {
  const evil = '<img src=x onerror=alert(1)>@example.com';
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'Jira', state: 'connected', method: 'token', account: evil, site: '<b>s</b>',
    lastTest: { ok: true, tools: 3, at: new Date().toISOString() }, agents: [{ id: 'cursor', label: '<i>C</i>', chip: 'Added', note: '<u>/x</u>' }] }], planned: [] };
  const html = C.paneHtml({ view, picked: 'atlassian' });
  assert.match(html, /Tested just now: Atlassian answered with 3 tools/);
  assert.doesNotMatch(html, /<img|<b>s|<i>C|<u>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;@example\.com/);
});
