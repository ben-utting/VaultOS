'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/connector-logicmonitor');

const B = 'https://acme.logicmonitor.com/santaba/rest';
const url = (path, query) => L.buildUrl({ path, query }, B).toString();
const refused = (path, query) => assert.throws(() => L.buildUrl({ path, query }, B), L.LmError, String(path));

test('normalisePortal takes a name, a host or a URL and refuses anything else', () => {
  for (const ok of ['acme', ' ACME ', 'acme.logicmonitor.com', 'https://Acme.LogicMonitor.com/santaba/rest/', 'http://acme.logicmonitor.com/']) assert.equal(L.normalisePortal(ok), 'acme', ok);
  assert.equal(L.normalisePortal('my-co2'), 'my-co2');
  for (const bad of ['', '  ', 'acme.logicmonitor.com.evil.example', 'evil.example', 'acme.example.com', '-acme', 'acme-', 'a b', 'acme/x', 'a'.repeat(64), null, 42]) {
    assert.equal(L.normalisePortal(bad), null, String(bad));
  }
});

test('baseUrl is the portal host unless the test override is set', () => {
  assert.equal(L.baseUrl('acme', {}), B);
  assert.equal(L.baseUrl('acme', { CONNECTOR_UPSTREAM_LOGICMONITOR: 'http://127.0.0.1:5599/' }), 'http://127.0.0.1:5599/santaba/rest');
});

test('core monitoring paths are readable', () => {
  assert.equal(url('/alert/alerts', { filter: 'severity>:3,cleared:false', size: 5 }), `${B}/alert/alerts?filter=severity%3E%3A3%2Ccleared%3Afalse&size=5`);
  for (const p of ['/device/devices', 'device/devices/12', '/device/devices/12/devicedatasources/3/instances/4/data', '/device/devices/12/properties',
    '/device/groups/7/devices', '/device/devicedatasourceinstances/4/graphs/9/data', '/sdt/sdts', '/santaba/rest/device/devices', `${B}/device/devices/12`]) {
    assert.doesNotThrow(() => url(p), p);
  }
});

test('everything else is refused', () => {
  for (const p of ['/setting/admins', '/setting/admins/apitokens', '/setting/collector/collectors', '/dashboard/dashboards', '/device', '/',
    '/device/devices/1/devicedatasources/2/instances/3/config', '/device/devices/1/config/2', '/device/../setting/admins', '/device/devices%2f..%2fsetting',
    '/device/devices\\1', 'https://evil.example/santaba/rest/device/devices', 'https://acme.logicmonitor.com.evil.example/santaba/rest/device/devices', '', '%zz']) refused(p);
  refused('/device/devices', { token: 'x' });
  refused('/device/devices', { size: { a: 1 } });
  refused('/alert/alerts?filter=x&debug=1');
});

test('the config guard holds against encoding, path parameters and case', () => {
  const inst = '/device/devices/1/devicedatasources/2/instances/3';
  for (const p of [`${inst}/conf%69g`, `${inst}/%63onfig`, `${inst}/config;x=1`, '/device/devices/..;/..;/setting/admins/apitokens',
    `${inst}/Config`, `${inst}/config.json`, '/device/devices/1/.../x', '/device/devices/1/a%20b']) refused(p);
  assert.doesNotThrow(() => url('/device/devices/12/properties/system.hostname'));
});

test('format is only for data paths, where there are no properties to mask', () => {
  refused('/device/devices', { format: 'csv' });
  refused('/device/devices?format=csv');
  assert.doesNotThrow(() => url('/device/devices/12/devicedatasources/3/instances/4/data', { format: 'csv' }));
  assert.doesNotThrow(() => url('/device/devicedatasourceinstances/4/graphs/9/data?format=json'));
});

test('a query in the path is checked like query, and query wins on a clash', () => {
  assert.equal(url('/alert/alerts?filter=a:1&size=5', { size: 9 }), `${B}/alert/alerts?filter=a%3A1&size=9`);
});

test('resourcePath drops /santaba/rest and the query', () => {
  assert.equal(L.resourcePath(L.buildUrl({ path: '/device/devices', query: { size: 1 } }, B), B), '/device/devices');
});

test('lmv1Header matches a worked example', () => {
  assert.equal(L.lmv1Header({ accessId: 'lm-id', accessKey: 'lm-key' }, 'GET', 1700000000000, '/device/devices'),
    'LMv1 lm-id:ZWQzZDIxZTAyODg1NzZlYTNhODNkM2ExODU0NjcxYWI5NTllODk4MmExZTk5ZGE5ZmM5NGVkMjBmOWE3NGQxYg==:1700000000000');
});

test('maskSecrets hides secret-looking property values at any depth and keeps the rest', () => {
  const v = { items: [{ id: 1, customProperties: [{ name: 'snmp.community', value: 'public' }, { name: 'wmi.pass', value: 'pw' }, { name: 'system.hostname', value: 'web01' }],
    inner: { autoProperties: [{ name: 'auto.api.token', value: 't' }, { name: 'ssh.Credential', value: 'c' }] } }] };
  const m = L.maskSecrets(v);
  assert.deepEqual(m.items[0].customProperties.map((p) => p.value), [L.MASK, L.MASK, 'web01']);
  assert.deepEqual(m.items[0].inner.autoProperties.map((p) => p.value), [L.MASK, L.MASK]);
  assert.equal(v.items[0].customProperties[0].value, 'public', 'the input is not changed');
});
