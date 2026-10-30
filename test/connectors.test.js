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
  assert.deepEqual(Object.keys(CONNECTORS), ['atlassian', 'azure', 'entra', 'github', 'mslearn']);
});

test('PLANNED has the six ids in order', () => {
  assert.deepEqual(PLANNED.map((p) => p.id), ['m365', 'notion', 'homeassistant', 'n8n', 'linear', 'sentry']);
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

test('github and mslearn are relayed with the exact catalogue values', () => {
  assert.deepEqual(CONNECTORS.github, {
    id: 'github', label: 'GitHub', by: 'Repos · issues · pull requests', kind: 'relayed', signIn: ['token'],
    base: 'https://api.githubcopilot.com', mcpPath: '/mcp/', tokenHelp: 'https://github.com/settings/personal-access-tokens/new',
  });
  assert.deepEqual(CONNECTORS.mslearn, {
    id: 'mslearn', label: 'Microsoft Learn', by: 'Microsoft docs and code samples', kind: 'relayed', signIn: ['none'],
    base: 'https://learn.microsoft.com', mcpPath: '/api/mcp',
  });
});

test('baseFor reads CONNECTOR_UPSTREAM_<ID> for github and mslearn, not for azure', () => {
  const env = { CONNECTOR_UPSTREAM_GITHUB: 'http://127.0.0.1:1', CONNECTOR_UPSTREAM_MSLEARN: 'http://127.0.0.1:2', CONNECTOR_UPSTREAM_AZURE: 'http://127.0.0.1:3' };
  assert.equal(baseFor('github', env), 'http://127.0.0.1:1');
  assert.equal(baseFor('mslearn', env), 'http://127.0.0.1:2');
  assert.equal(baseFor('github', {}), 'https://api.githubcopilot.com');
  assert.equal(baseFor('mslearn', {}), 'https://learn.microsoft.com');
  assert.equal(baseFor('azure', env), undefined);
});

test('entryFor github and mslearn point at the loopback relay with the key', () => {
  for (const id of ['github', 'mslearn']) {
    assert.deepEqual(entryFor(id, { port: 8080, key: 'k' }), {
      kind: 'http', url: `http://127.0.0.1:8080/mcp/${id}`, headers: { 'X-VaultOS-Key': 'k' },
    });
  }
});
