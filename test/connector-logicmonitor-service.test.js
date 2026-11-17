'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startFakeLm } = require('../scripts/fake-logicmonitor');
const { createConnectorService } = require('../lib/connector-service');

const PORTAL = 'Enter your LogicMonitor portal name, like acme or acme.logicmonitor.com.';
const MISSING = 'Paste a bearer token, or an access ID and key.';
const SPACES = 'That token has spaces or line breaks in it. Copy it again from LogicMonitor.';
const LOST = 'LogicMonitor no longer accepts this token. Open Settings → Connectors in VaultOS and paste a new one.';

function fakeRun() {
  return async (cmd) => {
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: m[1] === 'agent' ? 0 : 1, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
}
const fakeSpawn = () => () => {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {};
  return p;
};

async function setup(t) {
  const fake = await startFakeLm();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-lm-'));
  const svc = createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_LOGICMONITOR: fake.origin },
    fetch: (...a) => globalThis.fetch(...a), run: fakeRun(), spawn: fakeSpawn(), now: () => Date.now(),
    installedAgents: async () => ['cursor'],
  });
  await svc.init();
  t.after(async () => { await fake.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { fake, home, svc };
}
const row = async (svc) => (await svc.view()).connectors.find((c) => c.id === 'logicmonitor');
const cursorFile = (home) => path.join(home, '.cursor/mcp.json');
const stored = (home) => JSON.parse(fs.readFileSync(path.join(home, '.vaultos/connectors.json'), 'utf8')).connectors.logicmonitor;
const call = (svc, args) => svc.relayTarget('logicmonitor').serve({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lm_get', arguments: args } });

test('a bad portal or a missing credential is refused', async (t) => {
  const { svc, fake } = await setup(t);
  await assert.rejects(svc.saveToken('logicmonitor', { portal: 'evil.example', token: 'lmb-good' }), { message: PORTAL });
  await assert.rejects(svc.saveToken('logicmonitor', { portal: 'acme' }), { message: MISSING });
  await assert.rejects(svc.saveToken('logicmonitor', { portal: 'acme', accessId: 'lm-id' }), { message: MISSING });
  await assert.rejects(svc.saveToken('logicmonitor', { portal: 'acme', token: 'a b' }), { message: SPACES });
  assert.equal((await row(svc)).state, 'not-connected');
  assert.equal(fake.state.seen.length, 0);
});

test('a refused token changes nothing', async (t) => {
  const { svc, home } = await setup(t);
  await assert.rejects(svc.saveToken('logicmonitor', { portal: 'acme', token: 'nope' }), { message: "LogicMonitor didn't accept this token: Authentication failed" });
  assert.equal((await row(svc)).state, 'not-connected');
  assert.equal(fs.existsSync(path.join(home, '.vaultos/connectors.json')) ? stored(home) : undefined, undefined);
});

test('a good bearer token connects, tests, and reaches Cursor without the token', async (t) => {
  const { svc, home } = await setup(t);
  await svc.saveToken('logicmonitor', { portal: ' acme ', token: ' lmb-good ' });
  const r = await row(svc);
  assert.equal(r.state, 'connected');
  assert.equal(r.account, 'acme.logicmonitor.com');
  assert.equal(r.portal, 'acme');
  assert.equal(r.lastTest.tools, 2);
  assert.equal(r.lmv1, undefined);
  assert.equal(r.tokenHelp, 'https://www.logicmonitor.com/support/bearer-token');
  const cursor = fs.readFileSync(cursorFile(home), 'utf8');
  assert.equal(JSON.parse(cursor).mcpServers.logicmonitor.url, 'http://127.0.0.1:7684/mcp/logicmonitor');
  assert.doesNotMatch(cursor, /lmb-good/);
  assert.doesNotMatch(JSON.stringify(await svc.view()), /lmb-good/);
  assert.equal(stored(home).token, 'lmb-good');
});

test('an access ID and key connect too', async (t) => {
  const { svc } = await setup(t);
  await svc.saveToken('logicmonitor', { portal: 'Acme.logicmonitor.com', accessId: 'lm-id', accessKey: 'lm-key' });
  const r = await row(svc);
  assert.equal(r.state, 'connected');
  assert.equal(r.lmv1, true);
  assert.equal(r.portal, 'acme');
  assert.doesNotMatch(JSON.stringify(await svc.view()), /lm-key/);
});

test('the relay serves lm_get', async (t) => {
  const { svc } = await setup(t);
  await svc.saveToken('logicmonitor', { portal: 'acme', token: 'lmb-good' });
  assert.equal(await svc.relayTarget('logicmonitor').authorization(), '');
  const reply = await call(svc, { path: '/alert/alerts' });
  assert.equal(reply.result.isError, undefined);
  assert.match(reply.result.content[0].text, /LMA1[\s\S]*LMA2/);
});

test('a revoked token turns the card to sign-in again, and a new token works at once', async (t) => {
  const { svc, fake } = await setup(t);
  await svc.saveToken('logicmonitor', { portal: 'acme', token: 'lmb-good' });
  fake.state.goodToken = 'lmb-new';
  const lost = await call(svc, { path: '/alert/alerts' });
  assert.equal(lost.result.isError, true);
  assert.equal(lost.result.content[0].text, LOST);
  assert.equal((await row(svc)).state, 'needs-sign-in');
  assert.equal(svc.needsAttention(), true);
  await svc.saveToken('logicmonitor', { portal: 'acme', token: 'lmb-new' });
  assert.equal((await row(svc)).state, 'connected');
  assert.equal(svc.needsAttention(), false);
  const back = await call(svc, { path: '/alert/alerts' });
  assert.equal(back.result.isError, undefined);
});

test('sign-out removes the record and the Cursor entry', async (t) => {
  const { svc, home } = await setup(t);
  await svc.saveToken('logicmonitor', { portal: 'acme', token: 'lmb-good' });
  await svc.disconnect('logicmonitor');
  assert.equal((await row(svc)).state, 'not-connected');
  assert.equal(stored(home), undefined);
  assert.equal(JSON.parse(fs.readFileSync(cursorFile(home), 'utf8')).mcpServers.logicmonitor, undefined);
});
