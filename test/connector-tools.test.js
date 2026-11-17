'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/connector-tools');

const V = T.vantageReadOnly;
const names = (msg) => msg.result.tools.map((x) => x.name);
const listMsg = (list) => ({ jsonrpc: '2.0', id: 1, result: { tools: list.map((name) => ({ name, inputSchema: { type: 'object' } })) } });

test('vantageReadOnly allows get/list/query and hides writes, token lists and unknown verbs', () => {
  for (const n of ['query-costs', 'get-myself', 'list-budgets']) assert.equal(V.allow(n), true, n);
  for (const n of ['create-budget', 'delete-folder', 'add-team-member', 'print-version', 'list-ingest-tokens',
    'list-enrichment-source-ingest-tokens', 'new-thing', '', undefined]) assert.equal(V.allow(n), false, String(n));
  assert.equal(V.first[0], 'query-costs');
  assert.equal(V.first.length, 30);
});

test('tools are ordered by first, then by name', () => {
  assert.deepEqual(names(T.filterToolsMessage(listMsg(['list-zeta', 'get-myself', 'query-costs', 'list-alpha', 'create-x']), V)),
    ['query-costs', 'get-myself', 'list-alpha', 'list-zeta']);
});

test('an SSE tools/list keeps its notification and id lines and handles a two-line data payload', () => {
  const note = '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}';
  const result = JSON.stringify(listMsg(['create-budget', 'list-budgets', 'query-costs']));
  const cut = result.indexOf('"tools":');
  const text = `event: message\ndata: ${note}\n\nevent: message\nid: 1\ndata: ${result.slice(0, cut)}\ndata: ${result.slice(cut)}\n\n`;
  const out = T.rewriteToolsList(text, 'text/event-stream', V);
  assert.ok(out.endsWith('\n\n'));
  const events = out.split('\n\n').filter(Boolean);
  assert.equal(events.length, 2);
  assert.equal(events[0], `event: message\ndata: ${note}`);
  const lines = events[1].split('\n');
  assert.deepEqual(lines.slice(0, 2), ['event: message', 'id: 1']);
  assert.deepEqual(names(JSON.parse(lines[2].slice(6))), ['query-costs', 'list-budgets']);
});

test('an SSE event with empty data (a priming event) passes through unchanged', () => {
  const result = JSON.stringify(listMsg(['create-budget', 'list-budgets']));
  const text = `id: prime-1\ndata: \n\nid: prime-2\ndata:\n\nevent: message\nid: 1\ndata: ${result}\n\n`;
  const events = T.rewriteToolsList(text, 'text/event-stream', V).split('\n\n').filter(Boolean);
  assert.equal(events[0], 'id: prime-1\ndata: ');
  assert.equal(events[1], 'id: prime-2\ndata:');
  assert.deepEqual(names(JSON.parse(events[2].split('\n').find((l) => l.startsWith('data: ')).slice(6))), ['list-budgets']);
});

test('a JSON tools/list is filtered', () => {
  const out = T.rewriteToolsList(JSON.stringify(listMsg(['delete-folder', 'list-budgets'])), 'application/json', V);
  assert.deepEqual(names(JSON.parse(out)), ['list-budgets']);
});

test('unparseable input throws', () => {
  assert.throws(() => T.rewriteToolsList('{not json', 'application/json', V));
  assert.throws(() => T.rewriteToolsList('event: message\ndata: {nope\n\n', 'text/event-stream', V));
});

test('hiddenCallReply carries the exact copy and the request id, and leaves allowed calls alone', () => {
  assert.deepEqual(T.hiddenCallReply({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create-budget' } }, V), {
    jsonrpc: '2.0', id: 7,
    result: { isError: true, content: [{ type: 'text', text: 'VaultOS lets agents read Vantage only. Turn on Allow changes in Settings → Connectors to use create-budget.' }] },
  });
  assert.equal(T.hiddenCallReply({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'query-costs' } }, V), null);
  assert.equal(T.hiddenCallReply({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, V), null);
});
