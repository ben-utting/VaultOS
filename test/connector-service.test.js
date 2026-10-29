'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startFake } = require('../scripts/fake-mcp-oauth');
const { createConnectorService } = require('../lib/connector-service');

const EXPIRED = 'This sign-in link has expired. Start again from VaultOS.';
const REFUSED = "Atlassian didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost.";
const ORIGIN = 'http://localhost:7684';
const SUB = '11111111-1111-1111-1111-111111111111';
const AZ_LINE = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKNPLV to authenticate.';

function fakeRun(installed = ['claude', 'agent', 'az', 'azmcp']) {
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    const m = /^command -v -- '(.+)'$/.exec(cmd);
    if (m) return { code: installed.includes(m[1]) ? 0 : 1, stdout: '', stderr: '' };
    if (cmd.startsWith('az account show')) {
      return { code: 0, stdout: JSON.stringify({ user: { name: 'alex@example.com' }, tenantId: '0', id: SUB, name: 'Sub One' }), stderr: '' };
    }
    if (cmd.startsWith('az account list')) {
      return { code: 0, stdout: JSON.stringify([{ id: SUB, name: 'Sub One', isDefault: true }, { id: 'sub-2', name: 'Sub Two', isDefault: false }]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {};
    calls.push({ cmd, args, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}

async function setup(t, { agents = ['cursor'], clock } = {}) {
  const fake = await startFake();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-svc-'));
  const spawn = fakeSpawn();
  const run = fakeRun();
  const time = { t: 1000000 };
  const svc = createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base },
    fetch: globalThis.fetch, run, spawn, now: clock || (() => time.t),
    installedAgents: async () => agents,
  });
  await svc.init();
  t.after(async () => { await fake.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { fake, home, svc, spawn, run, time };
}

async function signIn(svc, nonce = 'n1', origin = ORIGIN) {
  const { url } = await svc.atlassianStart({ origin, nonce });
  const r = await fetch(url, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  await svc.atlassianCallback({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), nonce });
}
const row = async (svc, id) => (await svc.view()).connectors.find((c) => c.id === id);
const store = (home) => JSON.parse(fs.readFileSync(path.join(home, '.vaultos/connectors.json'), 'utf8'));

test('full OAuth: start, follow the fake\'s redirect, callback; view says connected', async (t) => {
  const { svc } = await setup(t);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'not-connected');
  const { url } = await svc.atlassianStart({ origin: ORIGIN, nonce: 'n1' });
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connecting');
  const r = await fetch(url, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  assert.strictEqual(loc.origin + loc.pathname, `${ORIGIN}/api/connectors/atlassian/callback`);
  await svc.atlassianCallback({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), nonce: 'n1' });
  const a = await row(svc, 'atlassian');
  assert.strictEqual(a.state, 'connected');
  assert.strictEqual(a.method, 'oauth');
  assert.strictEqual(a.account, 'alex@example.com');
  assert.strictEqual(a.site, 'example.atlassian.net');
  assert.strictEqual(a.lastTest.ok, true);
  assert.strictEqual(a.lastTest.tools, 2);
  assert.ok(a.tokenHelp);
  assert.strictEqual(svc.needsAttention(), false);
});

test('cursor gets the atlassian entry with the relay URL and key after connect', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  const j = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.strictEqual(j.mcpServers.atlassian.url, 'http://127.0.0.1:7684/mcp/atlassian');
  assert.strictEqual(j.mcpServers.atlassian.headers['X-VaultOS-Key'], store(home).relayKey);
  const a = await row(svc, 'atlassian');
  assert.deepStrictEqual(a.agents.find((x) => x.id === 'cursor'), { id: 'cursor', label: 'Cursor CLI', chip: 'Added' });
  assert.strictEqual(a.agents.find((x) => x.id === 'claude').chip, 'Not installed');
});

test('state from another nonce is refused with the expired-link sentence', async (t) => {
  const { svc, home } = await setup(t);
  const { url } = await svc.atlassianStart({ origin: ORIGIN, nonce: 'n1' });
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await assert.rejects(
    svc.atlassianCallback({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), nonce: 'other' }),
    { message: EXPIRED },
  );
  await assert.rejects(svc.atlassianCallback({ code: 'x', state: 'nope', nonce: 'n1' }), { message: EXPIRED });
  assert.strictEqual(store(home).connectors.atlassian.tokens, undefined);
});

test('a new origin re-registers the client', async (t) => {
  const { svc, fake, home } = await setup(t);
  const regs = () => fake.state.seen.filter((s) => s.path === '/v1/register').length;
  await svc.atlassianStart({ origin: ORIGIN, nonce: 'a' });
  await svc.atlassianStart({ origin: ORIGIN, nonce: 'b' });
  assert.strictEqual(regs(), 1);
  await svc.atlassianStart({ origin: 'http://127.0.0.1:7684', nonce: 'c' });
  assert.strictEqual(regs(), 2);
  assert.strictEqual(store(home).connectors.atlassian.client.redirect_uri, 'http://127.0.0.1:7684/api/connectors/atlassian/callback');
});

test('a refused redirect gives the sentence', async (t) => {
  const { svc, fake } = await setup(t);
  fake.state.refuseRedirect = 'vault.example';
  await assert.rejects(svc.atlassianStart({ origin: 'https://vault.example', nonce: 'n' }), { message: REFUSED });
  assert.strictEqual((await row(svc, 'atlassian')).state, 'not-connected');
});

test('token method: bad token keeps the previous method; good token connects', async (t) => {
  const { svc, home } = await setup(t);
  await signIn(svc);
  await assert.rejects(svc.atlassianToken({ email: 'alex@example.com', token: 'wrong' }), /401/);
  assert.strictEqual(store(home).connectors.atlassian.method, 'oauth');
  await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
  const a = await row(svc, 'atlassian');
  assert.strictEqual(a.state, 'connected');
  assert.strictEqual(a.method, 'token');
  assert.strictEqual(a.account, 'alex@example.com');
  assert.strictEqual(store(home).connectors.atlassian.tokens, undefined);
  await svc.atlassianToken({ key: 'svc-key' });
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connected');
  const target = svc.relayTarget('atlassian');
  assert.strictEqual(await target.authorization(), 'Bearer svc-key');
});

test('token method authorization is Basic base64(email:token)', async (t) => {
  const { svc } = await setup(t);
  await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
  const auth = await svc.relayTarget('atlassian').authorization();
  assert.strictEqual(auth, `Basic ${Buffer.from('alex@example.com:tok').toString('base64')}`);
});

test('refresh refused marks needs-sign-in and needsAttention() is true; network failure does not', async (t) => {
  const { svc, fake, time } = await setup(t);
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  const before = await target.authorization();
  assert.match(before, /^Bearer /);
  time.t += 3600 * 1000; // inside the 60 s window
  fake.setMode('refuse-refresh');
  assert.strictEqual(await target.authorization(), null);
  assert.strictEqual(target.missing(), 'expired');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(svc.needsAttention(), true);
  const a = await row(svc, 'atlassian');
  assert.strictEqual(a.state, 'needs-sign-in');
});

test('refresh over the network failing leaves the sign-in alone', async (t) => {
  const { svc, fake, time } = await setup(t);
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  time.t += 3600 * 1000;
  await fake.stop();
  assert.strictEqual(await target.authorization(), null);
  target.markNeedsSignIn(); // what the relay does after a null renew
  assert.strictEqual(svc.needsAttention(), false);
  assert.strictEqual(target.missing(), 'not-connected');
  fake.stop = async () => {};
});

test('renew returns the stored credential when it already differs, and refreshes once for two callers', async (t) => {
  const { svc, fake, time } = await setup(t);
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  time.t += 3600 * 1000;
  const [a, b] = await Promise.all([target.authorization(), svc.relayTarget('atlassian').authorization()]);
  assert.strictEqual(a, b);
  assert.strictEqual(fake.state.refreshes, 1);
  assert.strictEqual(await target.renew('Bearer stale'), a);
  assert.strictEqual(fake.state.refreshes, 1);
  const c = await target.renew(a);
  assert.notStrictEqual(c, a);
  assert.strictEqual(fake.state.refreshes, 2);
});

test('disconnect revokes, removes the cursor entry and the sign-in', async (t) => {
  const { svc, fake, home } = await setup(t);
  await signIn(svc);
  const rt = store(home).connectors.atlassian.tokens.refresh_token;
  await svc.disconnect('atlassian');
  assert.ok(fake.state.revoked.includes(rt));
  assert.strictEqual(store(home).connectors.atlassian, undefined);
  const j = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.strictEqual(j.mcpServers.atlassian, undefined);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'not-connected');
  assert.strictEqual(await svc.relayTarget('atlassian').authorization(), null);
});

test('a hand-made atlassian entry in Cursor is left alone and the row says why', async (t) => {
  const { svc, home } = await setup(t);
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { atlassian: { url: 'https://example.com/mine' } } }));
  await signIn(svc);
  const c = (await row(svc, 'atlassian')).agents.find((x) => x.id === 'cursor');
  assert.strictEqual(c.chip, 'Has its own entry');
  assert.strictEqual(c.note, 'Cursor CLI already has its own `atlassian` entry. Remove it to let VaultOS manage it.');
});

test('azure: start returns the code; status after exit 0 stores the account and writes the read-only entry; allowChanges rewrites it', async (t) => {
  const { svc, spawn, home } = await setup(t);
  const p = svc.azureStart();
  spawn.calls[0].proc.stderr.write(`${AZ_LINE}\n`);
  const info = await p;
  assert.strictEqual(info.code, 'DDVRKNPLV');
  assert.strictEqual((await row(svc, 'azure')).state, 'connecting');
  spawn.calls[0].proc.emit('close', 0);
  await new Promise((r) => setImmediate(r));
  const s = await svc.azureStatus();
  assert.strictEqual(s.status, 'done');
  const a = await row(svc, 'azure');
  assert.strictEqual(a.state, 'connected');
  assert.strictEqual(a.account, 'alex@example.com');
  assert.strictEqual(a.subscription, SUB);
  assert.strictEqual(a.subscriptions.length, 2);
  assert.strictEqual(a.allowChanges, false);
  const read = () => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.azure;
  assert.deepStrictEqual(read().args, ['server', 'start', '--read-only']);
  assert.strictEqual(read().command, path.join(home, '.local/bin/azmcp'));
  await svc.azureSettings({ allowChanges: true });
  assert.deepStrictEqual(read().args, ['server', 'start']);
  assert.strictEqual((await row(svc, 'azure')).allowChanges, true);
  await svc.azureSettings({ subscription: 'sub-2' });
  assert.strictEqual((await row(svc, 'azure')).subscription, 'sub-2');
  await svc.disconnect('azure');
  assert.strictEqual((await row(svc, 'azure')).state, 'not-connected');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.azure, undefined);
});

test('azure is not-installed when az or azmcp is missing', async (t) => {
  const fake = await startFake();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-svc-'));
  t.after(async () => { await fake.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const svc = createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base }, run: fakeRun(['az']), spawn: fakeSpawn(),
    installedAgents: async () => [],
  });
  await svc.init();
  const a = await row(svc, 'azure');
  assert.strictEqual(a.state, 'not-installed');
  assert.ok(a.install);
});

test('pi row only when pi is installed', async (t) => {
  const one = await setup(t, { agents: ['cursor'] });
  assert.strictEqual((await row(one.svc, 'atlassian')).agents.find((x) => x.id === 'pi'), undefined);
  const two = await setup(t, { agents: ['cursor', 'pi'] });
  const pi = (await row(two.svc, 'atlassian')).agents.find((x) => x.id === 'pi');
  assert.strictEqual(pi.chip, 'No connectors in Pi');
});

test('view never contains a secret', async (t) => {
  const { svc, home, fake } = await setup(t, { agents: ['cursor', 'pi'] });
  await signIn(svc);
  const s = store(home);
  const secrets = [s.relayKey, s.connectors.atlassian.tokens.access_token, s.connectors.atlassian.tokens.refresh_token, s.connectors.atlassian.client.client_id];
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(await svc.view());
  for (const x of secrets) assert.ok(x && !strings.some((y) => y.includes(x)), 'secret leaked');
  await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
  strings.length = 0; walk(await svc.view());
  assert.ok(!strings.some((y) => y === 'tok' || y.includes(':tok')));
  assert.ok(fake);
});
