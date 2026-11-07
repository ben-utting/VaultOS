'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowedHosts, hostAllowed, safeHost } = require('../lib/host-check');

test('parseAllowedHosts lowercases, trims and drops empties', () => {
  assert.deepEqual([...parseAllowedHosts(' Foo ,,bar,')], ['foo', 'bar']);
  assert.deepEqual([...parseAllowedHosts()], ['localhost', '127.0.0.1']);
});

test('hostAllowed strips the port and ignores case', () => {
  const a = parseAllowedHosts();
  for (const h of ['localhost:7684', '127.0.0.1', 'LOCALHOST:1']) assert.equal(hostAllowed(h, a), true, h);
  for (const h of ['evil.example', 'evil.example:80', 'localhost.evil.example', undefined, '']) assert.equal(hostAllowed(h, a), false, String(h));
});

test('IPv6 literals match without brackets', () => {
  assert.equal(hostAllowed('[::1]:7684', parseAllowedHosts()), false);
  assert.equal(hostAllowed('[::1]:7684', parseAllowedHosts('::1')), true);
  assert.equal(hostAllowed('[::1]', parseAllowedHosts('::1')), true);
});

test('safeHost keeps only host characters and caps the length', () => {
  assert.equal(safeHost('ev<il>.example:80'), 'evil.example');
  assert.equal(safeHost('a'.repeat(300)).length, 100);
});

test('parseAllowedHosts strips ports and brackets like a Host header', () => {
  const a = parseAllowedHosts('mybox.lan:7684,[::1]:7684, [::1] ');
  assert.ok(a.has('mybox.lan') && a.has('::1'));
  assert.equal(hostAllowed('mybox.lan:80', a), true);
});

test('safeHost drops the port', () => {
  assert.equal(safeHost('mybox.lan:7684'), 'mybox.lan');
  assert.equal(safeHost('[::1]:7684'), '::1');
});
