'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AgentMarks = require('../public/agent-marks');
const { PROFILE_IDS } = require('../lib/agents');

test('a single-colour 24px mark for every profile id', () => {
  for (const id of PROFILE_IDS) {
    const s = AgentMarks.svg(id);
    assert.match(s, /^<svg [^>]*viewBox="0 0 24 24"/, id);
    assert.match(s, /currentColor/, id);
    assert.match(s, /aria-hidden="true"/, id);
    assert.doesNotMatch(s, /<script|\son\w+=|#[0-9a-f]{3,6}\b|url\(/i, id);
  }
});

test('each agent has its own mark; an unknown id gets the Other agent mark', () => {
  const marks = PROFILE_IDS.map((id) => AgentMarks.svg(id));
  assert.equal(new Set(marks).size, PROFILE_IDS.length);
  assert.equal(AgentMarks.svg('nope'), AgentMarks.svg('custom'));
});

test('connector marks for atlassian and azure are single-colour 24px and distinct', () => {
  const a = AgentMarks.connector('atlassian'), z = AgentMarks.connector('azure');
  for (const s of [a, z]) {
    assert.match(s, /^<svg [^>]*viewBox="0 0 24 24"/);
    assert.match(s, /currentColor/);
    assert.match(s, /aria-hidden="true"/);
    assert.doesNotMatch(s, /<script|\son\w+=|#[0-9a-f]{3,6}\b|url\(/i);
  }
  assert.notEqual(a, z);
});

test('github and mslearn connector marks are single-colour 24px and distinct', () => {
  const all = ['atlassian', 'azure', 'github', 'mslearn'].map((id) => AgentMarks.connector(id));
  for (const s of all.slice(2)) {
    assert.match(s, /^<svg [^>]*viewBox="0 0 24 24"/);
    assert.match(s, /currentColor/);
    assert.match(s, /aria-hidden="true"/);
    assert.doesNotMatch(s, /<script|\son\w+=|#[0-9a-f]{3,6}\b|url\(/i);
  }
  assert.equal(new Set(all).size, 4);
  assert.notEqual(all[2], AgentMarks.connector('nope'));
  assert.notEqual(all[3], AgentMarks.connector('nope'));
});
