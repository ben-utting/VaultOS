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
    fetch: (...a) => globalThis.fetch(...a), run, spawn, now: clock || (() => time.t),
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
  assert.strictEqual((store(home).connectors.atlassian || {}).tokens, undefined);
});

test('a new origin re-registers the client', async (t) => {
  const { svc, fake, home } = await setup(t);
  const regs = () => fake.state.seen.filter((s) => s.path === '/v1/register').length;
  await svc.atlassianStart({ origin: ORIGIN, nonce: 'a' });
  await svc.atlassianStart({ origin: ORIGIN, nonce: 'b' });
  assert.strictEqual(regs(), 1);
  await svc.atlassianStart({ origin: 'http://127.0.0.1:7684', nonce: 'c' });
  assert.strictEqual(regs(), 2);
  assert.strictEqual(store(home).connectors.atlassian, undefined, 'a started flow writes nothing to the store');
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
  assert.strictEqual(svc.relayTarget('azure'), null);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(svc.needsAttention(), true);
  const a = await row(svc, 'atlassian');
  assert.strictEqual(a.state, 'needs-sign-in');
});

test('a network-failed refresh throws, keeps the sign-in, and the next call after recovery works', async (t) => {
  const { svc, time } = await setup(t);
  await signIn(svc);
  const target = svc.relayTarget('atlassian');
  time.t += 3600 * 1000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try { await assert.rejects(target.authorization()); } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(svc.needsAttention(), false);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connected');
  assert.match(await target.authorization(), /^Bearer /);
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

test('a failed revoke note shows only while not connected and clears on sign-in', async (t) => {
  const { svc } = await setup(t);
  await signIn(svc);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (init && init.method === 'POST' && String(u).endsWith('/v1/token')) throw new Error('down'); return realFetch(u, init); };
  try { await svc.disconnect('atlassian'); } finally { globalThis.fetch = realFetch; }
  const gone = await row(svc, 'atlassian');
  assert.strictEqual(gone.state, 'not-connected');
  assert.match(gone.error, /didn't confirm the sign-out/);
  await svc.atlassianToken({ key: 'svc-key' });
  assert.strictEqual((await row(svc, 'atlassian')).error, undefined);
  await svc.disconnect('atlassian'); // token method: nothing to revoke
  assert.strictEqual((await row(svc, 'atlassian')).error, undefined);
});

test('test(): oauth 401 renews first and only then marks needs-sign-in', async (t) => {
  const { svc, fake } = await setup(t);
  await signIn(svc);
  fake.state.access.clear(); // the access token is refused; a refresh issues a fresh one
  const r = await svc.test('atlassian');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fake.state.refreshes, 1);
  assert.strictEqual(svc.needsAttention(), false);
  fake.setMode('refuse-refresh');
  fake.state.access.clear();
  const r2 = await svc.test('atlassian');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(svc.needsAttention(), true);
});

test('token method: needs-sign-in is shown but the token still goes out, and a good test clears it', async (t) => {
  const { svc } = await setup(t);
  await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
  const target = svc.relayTarget('atlassian');
  target.markNeedsSignIn();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await row(svc, 'atlassian')).state, 'needs-sign-in');
  assert.match(await target.authorization(), /^Basic /);
  assert.strictEqual((await svc.test('atlassian')).ok, true);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connected');
});

test('starting from another origin leaves the live session refreshable', async (t) => {
  const { svc, fake, time } = await setup(t);
  await signIn(svc);
  await svc.atlassianStart({ origin: 'http://127.0.0.1:7684', nonce: 'b' }); // abandoned
  time.t += 3600 * 1000;
  const auth = await svc.relayTarget('atlassian').authorization();
  assert.match(auth, /^Bearer /);
  assert.strictEqual(fake.state.refreshes, 1);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connected');
});

test('a refresh that finishes after a token switch is dropped', async (t) => {
  const { svc, fake, time } = await setup(t);
  await signIn(svc);
  time.t += 3600 * 1000;
  fake.setMode('refuse-refresh');
  const realFetch = globalThis.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (u, init) => { if (String(u).endsWith('/v1/token')) await gate; return realFetch(u, init); };
  let late;
  try {
    late = svc.relayTarget('atlassian').authorization(); // in flight, will be refused
    await new Promise((r) => setTimeout(r, 20));
    globalThis.fetch = realFetch;
    await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
    release();
    await late;
  } finally { globalThis.fetch = realFetch; release(); }
  assert.strictEqual(svc.needsAttention(), false);
  assert.strictEqual((await row(svc, 'atlassian')).state, 'connected');
});

test('switching OAuth to token revokes the old refresh token; view holds no key, Basic value or relay key', async (t) => {
  const { svc, fake, home } = await setup(t, { agents: ['cursor', 'pi'] });
  await signIn(svc);
  const rt = store(home).connectors.atlassian.tokens.refresh_token;
  await svc.atlassianToken({ email: 'alex@example.com', token: 'tok' });
  assert.ok(fake.state.revoked.includes(rt));
  const basicVal = Buffer.from('alex@example.com:tok').toString('base64');
  const relayKey = store(home).relayKey;
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(await svc.view());
  await svc.atlassianToken({ key: 'svc-key' });
  walk(await svc.view());
  for (const x of ['svc-key', basicVal, relayKey]) assert.ok(!strings.some((y) => y.includes(x)), `leaked ${x}`);
  assert.ok(!strings.includes('tok'));
});

test('azure fold never makes view() throw; the row says why and the person can start again', async (t) => {
  const fake = await startFake();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-svc-'));
  t.after(async () => { await fake.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const spawn = fakeSpawn();
  const base = fakeRun();
  let broken = true;
  const run = async (cmd) => { if (broken && cmd.startsWith('az account list')) throw new Error('boom'); return base(cmd); };
  const svc = createConnectorService({ home, port: 7684, env: { CONNECTOR_UPSTREAM_ATLASSIAN: fake.base }, run, spawn, installedAgents: async () => [] });
  await svc.init();
  const p = svc.azureStart();
  spawn.calls[0].proc.stderr.write(`${AZ_LINE}\n`);
  await p;
  spawn.calls[0].proc.emit('close', 0);
  await new Promise((r) => setImmediate(r));
  const a = await row(svc, 'azure');
  assert.strictEqual(a.state, 'not-connected');
  assert.match(a.error, /^Signed in, but VaultOS couldn't read your Azure account: boom/);
  assert.strictEqual((await row(svc, 'azure')).state, 'not-connected');
  broken = false;
  const p2 = svc.azureStart();
  spawn.calls[1].proc.stderr.write(`${AZ_LINE}\n`);
  await p2;
  assert.strictEqual((await row(svc, 'azure')).error, undefined);
  svc.azureCancel();
});

test('disconnect azure cancels a waiting device login', async (t) => {
  const { svc, spawn } = await setup(t);
  const p = svc.azureStart();
  spawn.calls[0].proc.stderr.write(`${AZ_LINE}\n`);
  await p;
  await svc.disconnect('azure');
  assert.strictEqual((await row(svc, 'azure')).state, 'not-connected');
});

test('cancel drops the pending sign-in: not connecting, and the callback gets the expired-link sentence', async (t) => {
  const { svc } = await setup(t);
  const { url } = await svc.atlassianStart({ origin: ORIGIN, nonce: 'n1' });
  assert.equal((await svc.view()).connectors[0].state, 'connecting');
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await svc.atlassianCancel({ nonce: 'n1' });
  assert.equal((await svc.view()).connectors[0].state, 'not-connected');
  await assert.rejects(svc.atlassianCallback({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), nonce: 'n1' }), { message: EXPIRED });
});

// ----- GitHub and Microsoft Learn -----
const http = require('node:http');
const { createRelay, messages } = require('../lib/connector-relay');

async function setupRelayed(t, { agents = ['cursor'] } = {}) {
  const gh = await startFake();
  const ms = await startFake({ noAuth: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rel-'));
  const svc = createConnectorService({
    home, port: 7684, env: { CONNECTOR_UPSTREAM_GITHUB: gh.base, CONNECTOR_UPSTREAM_MSLEARN: ms.base },
    fetch: (...a) => globalThis.fetch(...a), run: fakeRun(), spawn: fakeSpawn(), now: () => 1000000,
    installedAgents: async () => agents,
  });
  await svc.init();
  t.after(async () => { await gh.stop(); await ms.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { gh, ms, home, svc };
}
const cursorJson = (home) => JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));

test('github: a token with surrounding whitespace is trimmed, probed and saved; view says connected as alex-example', async (t) => {
  const { svc, home, gh } = await setupRelayed(t);
  await svc.saveToken('github', { token: '  svc-key\n' });
  assert.deepStrictEqual(
    { method: store(home).connectors.github.method, key: store(home).connectors.github.key }, { method: 'token', key: 'svc-key' });
  const g = await row(svc, 'github');
  assert.strictEqual(g.state, 'connected');
  assert.strictEqual(g.account, 'alex-example');
  assert.strictEqual(g.tokenHelp, 'https://github.com/settings/personal-access-tokens/new');
  assert.ok(gh.state.seen.some((s) => s.path === '/mcp/' && s.headers.authorization === 'Bearer svc-key'));
  assert.strictEqual(await svc.relayTarget('github').authorization(), 'Bearer svc-key');
});

test('github: an empty token is refused without calling GitHub; saveToken refuses ids that take no token', async (t) => {
  const { svc, gh } = await setupRelayed(t);
  await assert.rejects(svc.saveToken('github', { token: '  \n' }), { message: 'Paste a GitHub token.' });
  await assert.rejects(svc.saveToken('mslearn', { token: 'x' }), /doesn't use a token/);
  await assert.rejects(svc.saveToken('azure', { token: 'x' }), /doesn't use a token/);
  await assert.rejects(svc.saveToken('constructor', { token: 'x' }), { message: 'Unknown connector.' });
  await assert.rejects(svc.enable('github'), /needs a sign-in/);
  assert.strictEqual(gh.state.seen.length, 0);
});

test('github: a token that fails the probe keeps the previous token and throws the upstream error', async (t) => {
  const { svc, home } = await setupRelayed(t);
  await svc.saveToken('github', { token: 'svc-key' });
  await assert.rejects(svc.saveToken('github', { token: 'wrong' }), /401/);
  assert.strictEqual(store(home).connectors.github.key, 'svc-key');
  assert.strictEqual((await row(svc, 'github')).state, 'connected');
});

test('github: a 401 later shows needs-sign-in but keeps sending the token; a good Test clears it', async (t) => {
  const { svc, home } = await setupRelayed(t);
  await svc.saveToken('github', { token: 'svc-key' });
  const target = svc.relayTarget('github');
  target.markNeedsSignIn();
  for (let i = 0; i < 50 && !store(home).connectors.github.needsSignIn; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual((await row(svc, 'github')).state, 'needs-sign-in');
  assert.strictEqual(svc.needsAttention(), true);
  assert.strictEqual(await target.authorization(), 'Bearer svc-key');
  assert.strictEqual(await target.renew('Bearer other'), 'Bearer svc-key'); // someone changed it: current one
  assert.strictEqual(await target.renew('Bearer svc-key'), null); // nothing to renew with
  const r = await svc.test('github');
  assert.strictEqual(r.ok, true);
  assert.strictEqual((await row(svc, 'github')).state, 'connected');
  assert.strictEqual(store(home).connectors.github.needsSignIn, undefined);
});

test('github: the token never appears in view(), and cursor\'s entry holds only the relay url and key', async (t) => {
  const { svc, home } = await setupRelayed(t);
  await svc.saveToken('github', { token: 'svc-key' });
  assert.ok(!JSON.stringify(await svc.view()).includes('svc-key'));
  const e = cursorJson(home).mcpServers.github;
  assert.deepStrictEqual(Object.keys(e).sort(), ['headers', 'url']);
  assert.strictEqual(e.url, 'http://127.0.0.1:7684/mcp/github');
  assert.deepStrictEqual(Object.keys(e.headers), ['X-VaultOS-Key']);
  assert.ok(!JSON.stringify(e).includes('svc-key'));
});

test('github: an existing hand-written github entry in cursor is left alone and reported', async (t) => {
  const { svc, home } = await setupRelayed(t);
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const mine = { url: 'https://example.com/mine' };
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { github: mine } }));
  await svc.saveToken('github', { token: 'svc-key' });
  assert.deepStrictEqual(cursorJson(home).mcpServers.github, mine);
  const c = (await row(svc, 'github')).agents.find((x) => x.id === 'cursor');
  assert.strictEqual(c.chip, 'Has its own entry');
});

test('mslearn: enable gives connected with 3 tools, cursor gets the entry, the relay sends no Authorization', async (t) => {
  const { svc, home, ms } = await setupRelayed(t);
  await svc.enable('mslearn');
  const m = await row(svc, 'mslearn');
  assert.strictEqual(m.state, 'connected');
  assert.strictEqual(m.method, 'none');
  assert.strictEqual(m.lastTest.tools, 3);
  assert.strictEqual(m.account, undefined);
  assert.strictEqual(cursorJson(home).mcpServers.mslearn.url, 'http://127.0.0.1:7684/mcp/mslearn');
  const target = svc.relayTarget('mslearn');
  assert.strictEqual(await target.authorization(), '');
  const handler = createRelay({ getKey: () => 'k', target: (id) => svc.relayTarget(id) });
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const hdr = { 'x-vaultos-key': 'k', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/mslearn`, { method: 'POST', headers: hdr, body });
  assert.strictEqual(res.status, 200);
  await res.text();
  const seen = ms.state.seen.filter((s) => s.path === '/api/mcp');
  assert.ok(seen.length > 1);
  assert.ok(seen.every((s) => s.headers.authorization === undefined));

  // disconnect: the entry goes and the next relay call gets the not-connected sentence at once
  await svc.disconnect('mslearn');
  assert.strictEqual(cursorJson(home).mcpServers.mslearn, undefined);
  assert.strictEqual(store(home).connectors.mslearn, undefined);
  assert.strictEqual(target.missing(), 'not-connected');
  const res2 = await fetch(`http://127.0.0.1:${server.address().port}/mcp/mslearn`, {
    method: 'POST', headers: hdr, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.match(await res2.text(), new RegExp(messages.notConnected('Microsoft Learn').replace(/[.*+?^${}()|[\]\\→]/g, '.')));
  assert.strictEqual((await row(svc, 'mslearn')).state, 'not-connected');
});

test('mslearn: a failing test leaves it enabled with the error shown', async (t) => {
  const { svc, ms } = await setupRelayed(t);
  await ms.stop();
  await svc.enable('mslearn');
  const m = await row(svc, 'mslearn');
  assert.strictEqual(m.state, 'error');
  assert.ok(m.error);
  assert.strictEqual(m.method, 'none');
  assert.strictEqual(await svc.relayTarget('mslearn').authorization(), '');
});

test('planned in view() has the five ids', async (t) => {
  const { svc } = await setupRelayed(t);
  assert.deepStrictEqual((await svc.view()).planned.map((p) => p.id), ['notion', 'homeassistant', 'n8n', 'linear', 'sentry']);
});
