'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTORS, PLANNED, baseFor, entryFor } = require('../lib/connectors');

test('every connector has id, label, by, kind and signIn', () => {
  for (const [id, c] of Object.entries(CONNECTORS)) {
    assert.equal(c.id, id);
    for (const k of ['label', 'by', 'kind']) assert.equal(typeof c[k], 'string', `${id}.${k}`);
    assert.ok(Array.isArray(c.signIn) && c.signIn.length > 0, `${id}.signIn`);
  }
  assert.deepEqual(Object.keys(CONNECTORS), ['atlassian', 'azure']);
});

test('PLANNED has the eight ids in order', () => {
  assert.deepEqual(PLANNED.map((p) => p.id), ['github', 'notion', 'gitea', 'homeassistant', 'n8n', 'linear', 'sentry', 'mslearn']);
  for (const p of PLANNED) for (const k of ['label', 'by', 'mono']) assert.equal(typeof p[k], 'string');
});

test('baseFor uses CONNECTOR_UPSTREAM_ATLASSIAN only for atlassian', () => {
  assert.equal(baseFor('atlassian', {}), 'https://mcp.atlassian.com');
  assert.equal(baseFor('atlassian', { CONNECTOR_UPSTREAM_ATLASSIAN: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9');
  assert.equal(baseFor('azure', { CONNECTOR_UPSTREAM_ATLASSIAN: 'http://127.0.0.1:9' }), undefined);
});

test('entryFor atlassian points at the loopback relay with the key', () => {
  assert.deepEqual(entryFor('atlassian', { port: 8080, key: 'k' }), {
    kind: 'http', url: 'http://127.0.0.1:8080/mcp/atlassian', headers: { 'X-VaultOS-Key': 'k' },
  });
});

test('entryFor azure is read-only unless allowChanges', () => {
  assert.deepEqual(entryFor('azure', { home: '/h' }), { kind: 'stdio', command: '/h/.local/bin/azmcp', args: ['server', 'start', '--read-only'] });
  assert.deepEqual(entryFor('azure', { home: '/h', allowChanges: true }), { kind: 'stdio', command: '/h/.local/bin/azmcp', args: ['server', 'start'] });
});

test('the Azure server is pinned to the version whose --read-only flag was checked', () => {
  assert.match(CONNECTORS.azure.install, /@azure\/mcp@4\.0\.0-beta\.3 /);
});
