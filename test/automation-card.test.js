'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyResult } = require('../lib/automation-card');

const card = (status, extra = '') => `---
id: x
title: "T"
status: ${status}
updated: 2026-11-01
blocked_by: ""
${extra}---

## Goal
g

## Plan
- [ ] a

## Progress log

- 2026-11-01 — created.
`;
const opts = (level, more = {}) => ({
  automation: { name: 'Morning check-in', level, section: 'Latest check-in' },
  agentLabel: 'Claude Code', stamp: '11 Nov 2026, 08:03', note: 'Where it stands: fine.', update: null,
  statusAtStart: 'in-progress', today: '2026-11-11', ...more,
});

test('report: only the section changes', () => {
  const raw = card('in-progress');
  const r = applyResult(raw, opts('report'));
  assert.equal(r.raw, raw.replace('## Goal', '## Latest check-in\n_11 Nov 2026, 08:03 · Morning check-in · Claude Code_\n\nWhere it stands: fine.\n\n## Goal'));
  assert.deepEqual({ ...r, raw: undefined }, { raw: undefined, statusChange: null, proposalIgnored: '', doneReverted: false });
});

test('report ignores an update even if one is passed', () => {
  const r = applyResult(card('in-progress'), opts('report', { update: { status: 'blocked' } }));
  assert.match(r.raw, /^status: in-progress$/m);
  assert.equal(r.statusChange, null);
});

test('update: status change is applied with a Progress log line', () => {
  const r = applyResult(card('in-progress'), opts('update', { update: { status: 'blocked', blocked_by: 'vendor' } }));
  assert.match(r.raw, /^status: blocked$/m);
  assert.match(r.raw, /^blocked_by: vendor$/m);
  assert.match(r.raw, /^updated: 2026-11-11$/m);
  assert.ok(r.raw.includes('## Progress log\n\n- 2026-11-11 — status in-progress → blocked (automation: Morning check-in).\n- 2026-11-01 — created.'));
  assert.deepEqual(r.statusChange, { from: 'in-progress', to: 'blocked' });
  assert.ok(r.raw.includes('## Latest check-in\n_11 Nov 2026, 08:03'));
});

test('update: Ben moved it mid-run, so the proposal is dropped', () => {
  const r = applyResult(card('review'), opts('update', { update: { status: 'blocked' } }));
  assert.match(r.raw, /^status: review$/m);
  assert.match(r.raw, /^updated: 2026-11-01$/m);
  assert.equal(r.proposalIgnored, 'status changed during the run');
  assert.equal(r.statusChange, null);
});

test('update: same status proposed means no change and no log line', () => {
  const raw = card('in-progress');
  const r = applyResult(raw, opts('update', { update: { status: 'in-progress' } }));
  assert.equal(r.raw, applyResult(raw, opts('report')).raw);
  assert.equal(r.statusChange, null);
});

test('update: a note field for the new status is only written with it', () => {
  const r = applyResult(card('in-progress'), opts('update', { update: { status: 'needs-decision', decision_note: 'Pick A or B', blocked_by: 'x' } }));
  assert.match(r.raw, /^decision_note: Pick A or B$/m);
  assert.match(r.raw, /^blocked_by: ""$/m);
});

test('work: agent set done, so it is put back', () => {
  const r = applyResult(card('done'), opts('work', { statusAtStart: 'blocked' }));
  assert.match(r.raw, /^status: blocked$/m);
  assert.ok(r.raw.includes('- 2026-11-11 — status done → blocked (automation: Morning check-in set done; VaultOS put it back).'));
  assert.equal(r.doneReverted, true);
});

test('work: other status changes by the agent stand', () => {
  const r = applyResult(card('review'), opts('work', { statusAtStart: 'in-progress' }));
  assert.match(r.raw, /^status: review$/m);
  assert.equal(r.doneReverted, false);
});
