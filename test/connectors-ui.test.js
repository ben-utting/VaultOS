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

test('atlassianStep: a connected view clears the token form only on the way in', () => {
  const tok = { state: 'connected', method: 'token' };
  // already connected by token, same view again (focus refresh, Test again, a poll tick): nothing cleared
  assert.equal(C.atlassianStep({ waiting: false }, tok, tok).clear, false);
  // first connected view after not-connected clears; so does a changed method
  assert.equal(C.atlassianStep({ waiting: false }, { state: 'not-connected' }, tok).clear, true);
  assert.equal(C.atlassianStep({ waiting: false }, { state: 'connected', method: 'oauth' }, tok).clear, true);
});

test('atlassianStep: switching from a token sign-in keeps waiting until the method changes', () => {
  const st = { waiting: true, waitFrom: 'token' };
  const still = C.atlassianStep(st, { state: 'connected', method: 'token' }, { state: 'connected', method: 'token' });
  assert.deepEqual([still.waiting, still.poll], [true, true]);
  const done = C.atlassianStep(st, { state: 'connected', method: 'token' }, { state: 'connected', method: 'oauth' });
  assert.deepEqual([done.waiting, done.poll, done.clear], [false, false, true]);
  // a first sign-in ends as soon as it is connected
  assert.equal(C.atlassianStep({ waiting: true, waitFrom: null }, { state: 'connecting' }, { state: 'connected', method: 'oauth' }).waiting, false);
});

test('the waiting panel shows while this pane waits, even over a connected sign-in', () => {
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'x', state: 'connected', method: 'token', agents: [] }], planned: [] };
  const html = C.paneHtml({ view, picked: 'atlassian', waiting: true, options: { atlassian: true } });
  assert.match(html, /Waiting for you to approve in the Atlassian tab…/);
});

test('atlassianStep: a wait ends on any state but connecting (or the old method while switching)', () => {
  const first = { waiting: true, waitFrom: null };
  assert.equal(C.atlassianStep(first, { state: 'connecting' }, { state: 'connecting' }).waiting, true);
  assert.equal(C.atlassianStep(first, { state: 'connecting' }, { state: 'not-connected' }).waiting, false);
  const sw = { waiting: true, waitFrom: 'token' };
  const old = { state: 'connected', method: 'token' };
  assert.equal(C.atlassianStep(sw, old, old).waiting, true);
  assert.equal(C.atlassianStep(sw, old, { state: 'needs-sign-in', method: 'token' }).waiting, false);
  assert.equal(C.atlassianStep(sw, old, { state: 'error', method: 'token' }).waiting, false);
  assert.equal(C.atlassianStep(sw, old, { state: 'not-connected' }).waiting, false);
});

test('the 10-minute give-up clears the waiting panel', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const el = { addEventListener() {}, querySelector() { return null; }, contains() { return false; }, innerHTML: '' };
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'x', state: 'not-connected', agents: [] }], planned: [] };
  const w = { open: () => ({ location: {}, close() {} }) };
  let startView = view;
  const ui = {
    api: async (m, u) => (u === '/api/connectors/atlassian/start' ? { url: 'https://example.atlassian.net/x' } : startView),
    openTerm() {}, openTab: w.open,
  };
  const handlers = {};
  el.addEventListener = (n, f) => { handlers[n] = f; };
  const m = C.mountConnectors(el, ui);
  await m.refresh();
  const pane = { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'oauth' } } : null) };
  handlers.click({ target: pane });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(el.innerHTML, /Waiting for you to approve/);
  startView = { connectors: [{ ...view.connectors[0], state: 'connecting' }], planned: [] };
  t.mock.timers.tick(11 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.doesNotMatch(el.innerHTML, /Waiting for you to approve/);
});
