'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const az = require('../lib/connector-azure');

const LINE = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code DDVRKNPLV to authenticate.';
const OLD = 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.';
const TENANT = '00000000-0000-0000-0000-000000000000';

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.killed = false;
    p.kill = () => { p.killed = true; };
    calls.push({ cmd, args, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}
const tick = () => new Promise((r) => setImmediate(r));

test('parseDeviceCode reads az\'s line', () => {
  assert.deepStrictEqual(az.parseDeviceCode(LINE), { url: 'https://login.microsoft.com/device', code: 'DDVRKNPLV' });
  assert.deepStrictEqual(az.parseDeviceCode(OLD), { url: 'https://microsoft.com/devicelogin', code: 'ABCD12345' });
});

test('parseDeviceCode returns null for other text', () => {
  assert.strictEqual(az.parseDeviceCode('Opening a browser...'), null);
  assert.strictEqual(az.parseDeviceCode(''), null);
  assert.strictEqual(az.parseDeviceCode(null), null);
});

test('start resolves with the code and expiresAt = now + ttl', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn, now: () => 1000, ttlMs: 5000 });
  const p = login.start({ tenant: TENANT });
  spawn.calls[0].proc.stderr.write(LINE + '\n');
  assert.deepStrictEqual(await p, { url: 'https://login.microsoft.com/device', code: 'DDVRKNPLV', expiresAt: 6000 });
  assert.strictEqual(login.status().status, 'waiting');
  const c = spawn.calls[0];
  assert.strictEqual(c.cmd, 'bash');
  assert.strictEqual(c.args[0], '-lc');
  assert.match(c.args[1], /^az login --use-device-code --tenant '00000000-0000-0000-0000-000000000000' -o none$/);
  login.cancel();
});

test('code on stdout also resolves; no tenant omits the flag', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  spawn.calls[0].proc.stdout.write(OLD + '\n');
  assert.strictEqual((await p).code, 'ABCD12345');
  assert.doesNotMatch(spawn.calls[0].args[1], /--tenant/);
  login.cancel();
});

test('tenant is shell-quoted', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  login.start({ tenant: "x'; rm -rf ~; '" }).catch(() => {});
  assert.ok(!/--tenant x'; rm/.test(spawn.calls[0].args[1]));
  assert.match(spawn.calls[0].args[1], /--tenant 'x'\\''; rm -rf ~; '\\'''/);
  login.cancel();
});

test('exit 0 is done', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  const proc = spawn.calls[0].proc;
  proc.stderr.write(LINE + '\n');
  await p;
  proc.emit('close', 0);
  assert.deepStrictEqual(login.status(), { status: 'done' });
});

test('exit 1 is failed with the last 5 lines of az text', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  const proc = spawn.calls[0].proc;
  proc.stderr.write(LINE + '\n');
  await p;
  proc.stderr.write('one\n\ntwo\nthree\nfour\nfive\nsix\n');
  await tick();
  proc.emit('close', 1);
  const s = login.status();
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(s.error, 'two\nthree\nfour\nfive\nsix');
});

test('AADSTS70016 reports that the code expired', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  const proc = spawn.calls[0].proc;
  proc.stderr.write(LINE + '\n');
  await p;
  proc.stderr.write('ERROR: AADSTS70016: OAuth 2.0 device flow error. Authorization is pending. Continue polling.\naz logout\naz login\n');
  await tick();
  proc.emit('close', 1);
  assert.deepStrictEqual(login.status(), { status: 'failed', error: 'The code expired before it was entered. Start again.' });
});

test('exit before any code rejects start and reports failed', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  const proc = spawn.calls[0].proc;
  proc.stderr.write('az: command not found\n');
  await tick();
  proc.emit('close', 127);
  await assert.rejects(p, /command not found/);
  assert.strictEqual(login.status().status, 'failed');
});

test('a second start while waiting reuses the process', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p1 = login.start();
  spawn.calls[0].proc.stderr.write(LINE + '\n');
  const r1 = await p1;
  const r2 = await login.start();
  assert.deepStrictEqual(r2, r1);
  assert.strictEqual(spawn.calls.length, 1);
  login.cancel();
});

test('a start after done or failed spawns again', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  spawn.calls[0].proc.stderr.write(LINE + '\n');
  await p;
  spawn.calls[0].proc.emit('close', 0);
  const p2 = login.start();
  assert.strictEqual(spawn.calls.length, 2);
  spawn.calls[1].proc.stderr.write(OLD + '\n');
  await p2;
  login.cancel();
});

test('cancel kills and returns to idle', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  const proc = spawn.calls[0].proc;
  proc.stderr.write(LINE + '\n');
  await p;
  login.cancel();
  assert.strictEqual(proc.killed, true);
  assert.deepStrictEqual(login.status(), { status: 'idle' });
  proc.emit('close', null); // the late exit must not flip the status
  assert.deepStrictEqual(login.status(), { status: 'idle' });
});

test('cancel before the code arrives rejects start', async () => {
  const spawn = fakeSpawn();
  const login = az.createDeviceLogin({ spawn });
  const p = login.start();
  login.cancel();
  await assert.rejects(p);
  assert.strictEqual(spawn.calls[0].proc.killed, true);
  assert.strictEqual(login.status().status, 'idle');
});

test('past the ttl a waiting login is killed and fails as expired', async () => {
  const spawn = fakeSpawn();
  let t = 0;
  const login = az.createDeviceLogin({ spawn, now: () => t, ttlMs: 1000 });
  const p = login.start();
  spawn.calls[0].proc.stderr.write(LINE + '\n');
  await p;
  t = 1001;
  const s = login.status();
  assert.strictEqual(s.status, 'failed');
  assert.match(s.error, /expired/);
  assert.strictEqual(spawn.calls[0].proc.killed, true);
});

test('account parses az account show', async () => {
  const seen = [];
  const run = async (cmd) => {
    seen.push(cmd);
    return { code: 0, stdout: JSON.stringify({ id: 'sub-1', name: 'Sub One', tenantId: TENANT, user: { name: 'alex@example.com', type: 'user' } }), stderr: '' };
  };
  assert.deepStrictEqual(await az.account({ run }), { user: 'alex@example.com', tenantId: TENANT, subscriptionId: 'sub-1', subscriptionName: 'Sub One' });
  assert.strictEqual(seen[0], 'az account show -o json');
});

test('account is null when not logged in', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Please run \'az login\'' });
  assert.strictEqual(await az.account({ run }), null);
});

test('subscriptions, setSubscription and logout', async () => {
  const seen = [];
  const run = async (cmd) => {
    seen.push(cmd);
    if (cmd.startsWith('az account list')) return { code: 0, stdout: JSON.stringify([{ id: 'a', name: 'A', isDefault: true, extra: 1 }, { id: 'b', name: 'B', isDefault: false }]), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  assert.deepStrictEqual(await az.subscriptions({ run }), [{ id: 'a', name: 'A', isDefault: true }, { id: 'b', name: 'B', isDefault: false }]);
  await az.setSubscription("a b'c", { run });
  assert.strictEqual(seen[1], "az account set --subscription 'a b'\\''c'");
  await az.logout({ run });
  assert.strictEqual(seen[2], 'az logout');
});

test('testAzure ok, and AADSTS or az login means needsSignIn', async () => {
  const mk = (r) => async () => r;
  assert.deepStrictEqual(await az.testAzure({ run: mk({ code: 0, stdout: '2026-10-29\n', stderr: '' }) }), { ok: true, needsSignIn: false });
  const a = await az.testAzure({ run: mk({ code: 1, stdout: '', stderr: 'ERROR: AADSTS700082: refresh token expired' }) });
  assert.strictEqual(a.ok, false); assert.strictEqual(a.needsSignIn, true);
  const b = await az.testAzure({ run: mk({ code: 1, stdout: '', stderr: "Please run 'az login' to setup account." }) });
  assert.strictEqual(b.needsSignIn, true);
  const c = await az.testAzure({ run: mk({ code: 1, stdout: '', stderr: 'network down' }) });
  assert.strictEqual(c.needsSignIn, false); assert.match(c.error, /network down/);
});
