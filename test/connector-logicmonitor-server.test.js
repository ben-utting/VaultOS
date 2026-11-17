'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogicMonitor, MASK, MAX_TEXT } = require('../lib/connector-logicmonitor');
const { startFakeLm } = require('../scripts/fake-logicmonitor');

const BEARER = { portal: 'acme', token: 'lmb-good' };
const KEYS = { portal: 'acme', accessId: 'lm-id', accessKey: 'lm-key' };
const LOST = 'LogicMonitor no longer accepts this token. Open Settings → Connectors in VaultOS and paste a new one.';
const SECRET = /lmb-good|lm-key/;

async function setup(t, { cred = BEARER, env } = {}) {
  const fake = await startFakeLm(); t.after(() => fake.stop());
  let lost = 0;
  const lm = createLogicMonitor({ env: env || { CONNECTOR_UPSTREAM_LOGICMONITOR: fake.origin }, credentials: () => cred, onLost: () => { lost++; } });
  return { fake, lm, lost: () => lost };
}
const get = (lm, path, query) => lm.callTool('lm_get', { path, ...(query ? { query } : {}) });
const textOf = (r) => r.content[0].text;

test('tools/list returns lm_get and lm_help; initialize names the server; a notification gets no reply', async (t) => {
  const { lm } = await setup(t);
  const list = await lm.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name), ['lm_get', 'lm_help']);
  const init = await lm.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'VaultOS LogicMonitor');
  assert.equal(await lm.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const help = await lm.callTool('lm_help', {});
  assert.match(textOf(help), /severity>:3,cleared:false/);
});

test('lm_get with a bearer token reads devices, masks secrets and sends X-Version 3', async (t) => {
  const { fake, lm } = await setup(t);
  const r = await get(lm, '/device/devices');
  assert.equal(r.isError, undefined);
  const props = JSON.parse(textOf(r)).items[0].customProperties;
  assert.deepEqual(props.map((p) => p.value), [MASK, MASK, 'web01']);
  const last = fake.state.seen.at(-1);
  assert.equal(last.headers['x-version'], '3');
  assert.equal(last.headers.authorization, 'Bearer lmb-good');
});

test('LMv1 credentials sign a filtered request the fake accepts', async (t) => {
  const { fake, lm } = await setup(t, { cred: KEYS });
  const filter = 'severity>:3,displayName~"web, 01"';
  const r = await get(lm, '/alert/alerts', { filter });
  assert.equal(r.isError, undefined, textOf(r));
  assert.match(textOf(r), /LMA1/);
  assert.equal(fake.state.seen.at(-1).query.filter, filter);
  assert.match(fake.state.seen.at(-1).headers.authorization, /^LMv1 lm-id:/);
});

test('401 says the token stopped working and calls onLost once', async (t) => {
  const { fake, lm, lost } = await setup(t);
  fake.state.goodToken = 'other';
  const r = await get(lm, '/alert/alerts');
  assert.equal(r.isError, true);
  assert.equal(textOf(r), LOST);
  assert.equal(lost(), 1);
  assert.doesNotMatch(textOf(r), SECRET);
});

test('403, 429, 500 and an unreachable portal give their messages, with no secret in them', async (t) => {
  const { fake, lm } = await setup(t);
  const cases = [['403', "LogicMonitor answered 403: Permission denied. The token's role can't read this."],
    ['429', 'LogicMonitor is rate-limiting these requests. Try again in a minute.'],
    ['500', 'LogicMonitor answered 500. Internal error']];
  for (const [mode, msg] of cases) {
    fake.setMode(mode);
    const r = await get(lm, '/alert/alerts');
    assert.equal(r.isError, true, mode);
    assert.equal(textOf(r), msg);
    assert.doesNotMatch(textOf(r), SECRET);
  }
  const { lm: away } = await setup(t, { env: { CONNECTOR_UPSTREAM_LOGICMONITOR: 'http://127.0.0.1:9' } });
  const r = await get(away, '/alert/alerts');
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "Couldn't reach 127.0.0.1:9. Try again in a moment.");
});

test('a redirect is not followed', async (t) => {
  const { fake, lm } = await setup(t);
  fake.setMode('redirect');
  const r = await get(lm, '/alert/alerts');
  assert.equal(r.isError, true);
  assert.ok(!fake.state.seen.some((s) => s.path === '/elsewhere'));
});

test('a 200 that is not JSON comes back as text', async (t) => {
  const { fake, lm } = await setup(t);
  fake.setMode('html');
  const r = await get(lm, '/alert/alerts');
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /<html/);
});

test('a big reply is cut at 100 KB with the hint', async (t) => {
  const { fake, lm } = await setup(t);
  fake.setMode('big');
  const text = textOf(await get(lm, '/device/devices'));
  assert.ok(text.length <= MAX_TEXT + 80, String(text.length));
  assert.ok(text.endsWith('\n…[cut at 100 KB; narrow it with fields, filter or size]'));
});

test('a refused path sends nothing', async (t) => {
  const { fake, lm } = await setup(t);
  const r = await get(lm, '/setting/admins');
  assert.equal(r.isError, true);
  assert.match(textOf(r), /lm_help/);
  assert.equal(fake.state.seen.length, 0);
});

test('not connected says so', async (t) => {
  const { lm } = await setup(t, { cred: null });
  const r = await get(lm, '/alert/alerts');
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "LogicMonitor isn't connected. Open Settings → Connectors in VaultOS to connect it.");
});

test('probe: ok, a refused token, a 403 and an unreachable portal', async (t) => {
  const { fake, lm } = await setup(t);
  assert.deepEqual(await lm.probe(), { ok: true, tools: 2, error: null });
  assert.deepEqual(fake.state.seen.at(-1).query, { size: '1', fields: 'id' });
  fake.state.goodToken = 'other';
  const lostP = await lm.probe();
  assert.equal(lostP.ok, false);
  assert.equal(lostP.lost, true);
  assert.equal(lostP.status, 401);
  assert.equal(lostP.upstream, 'Authentication failed');
  assert.equal(lostP.error, LOST);
  fake.state.goodToken = 'lmb-good';
  fake.setMode('403');
  const denied = await lm.probe();
  assert.equal(denied.status, 403);
  assert.equal(denied.lost, undefined);
  const { lm: away } = await setup(t, { env: { CONNECTOR_UPSTREAM_LOGICMONITOR: 'http://127.0.0.1:9' } });
  const gone = await away.probe();
  assert.equal(gone.ok, false);
  assert.equal(gone.status, undefined);
});
