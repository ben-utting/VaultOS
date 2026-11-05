'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/connector-msapp');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const DEVICE = { user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, device_code: 'dc-secret' };

const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const wait = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setImmediate(r)); };

// script: array of replies (or functions / Errors) consumed in order
function make(script, over = {}) {
  const calls = [];
  const queue = [...script];
  const fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
    calls.push({ url: String(url), init, body });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('script exhausted');
    return typeof next === 'function' ? next() : next;
  };
  const sleeps = [];
  const saved = [];
  const clock = { t: 1000000 };
  const app = M.createMsApp({
    fetch, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); },
    onRefreshToken: over.onRefreshToken || (async (rt) => { saved.push(rt); }),
  });
  return { app, calls, sleeps, saved, clock };
}
const tok = (at = 'at1', rt = 'rt1', exp = 3600) => reply(200, { access_token: at, refresh_token: rt, expires_in: exp });
const err = (error, error_description, status = 400) => reply(status, { error, error_description });

async function failWith(response) {
  const { app } = make([reply(200, DEVICE), response]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => app.status().status !== 'waiting');
  return app.status();
}

test('isGuid', () => {
  assert.equal(M.isGuid(TENANT), true);
  assert.equal(M.isGuid('abc'), false);
  assert.equal(M.isGuid('../x'), false);
  assert.equal(M.isGuid(`${TENANT} `), false);
  assert.equal(M.isGuid('1111111 1-2222-3333-4444-555555555555'), false);
});

test('SCOPES is exact', () => {
  assert.equal(M.SCOPES, 'OnlineMeetingTranscript.Read.All OnlineMeetings.Read Calendars.Read User.Read offline_access');
});

test('start refuses non-GUID ids with kind config and makes no request', async () => {
  const { app, calls } = make([]);
  await assert.rejects(app.start({ tenantId: '../x', clientId: CLIENT }), (e) => e instanceof M.MsAppError && e.kind === 'config');
  await assert.rejects(app.start({ tenantId: TENANT, clientId: 'nope' }), (e) => e.kind === 'config');
  assert.equal(calls.length, 0);
});

test('start posts to devicecode and resolves the code', async () => {
  const { app, calls } = make([reply(200, DEVICE), err('authorization_pending', 'x')]);
  const info = await app.start({ tenantId: TENANT, clientId: CLIENT });
  assert.deepEqual(info, { url: 'https://microsoft.com/devicelogin', code: 'ABCD1234', expiresAt: 1000000 + 900000 });
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.client_id, CLIENT);
  assert.equal(calls[0].body.scope, M.SCOPES);
  app.cancel();
});

test('polling: pending, slow_down, success -> done; slow_down adds 5 s; onRefreshToken once', async () => {
  const { app, sleeps, saved, calls } = make([reply(200, DEVICE), err('authorization_pending', 'p'), err('slow_down', 's'), tok()]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  assert.equal(app.status().status, 'waiting');
  await wait(() => app.status().status === 'done');
  assert.deepEqual(app.status(), { status: 'done' });
  assert.deepEqual(saved, ['rt1']);
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.equal(calls[1].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[1].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(calls[1].body.device_code, 'dc-secret');
  assert.equal(calls[1].body.client_id, CLIENT);
});

test('done is not reported until onRefreshToken has resolved', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { app } = make([reply(200, DEVICE), tok()], { onRefreshToken: () => gate });
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => false);
  assert.equal(app.status().status, 'waiting');
  release();
  await wait(() => app.status().status === 'done');
  assert.equal(app.status().status, 'done');
});

test('expired_token', async () => {
  const s = await failWith(err('expired_token', 'AADSTS70020: expired'));
  assert.deepEqual(s, { status: 'failed', error: 'The code expired before it was entered. Start again.' });
});

test('AADSTS7000218 arriving as invalid_client', async () => {
  const s = await failWith(err('invalid_client', 'AADSTS7000218: The request body must contain … client_assertion …\r\nTrace ID: t'));
  assert.equal(s.status, 'failed');
  assert.match(s.error, /public client flows/i);
});

test('AADSTS700016 and AADSTS90002', async () => {
  const a = await failWith(err('unauthorized_client', 'AADSTS700016: Application not found in the directory.\r\nTrace ID: t'));
  assert.match(a.error, /app.*not found.*directory/i);
  const b = await failWith(err('invalid_request', 'AADSTS90002: Tenant not found.\r\nTrace ID: t'));
  assert.match(b.error, /directory \(tenant\).*not found/i);
});

test('Conditional Access block shows the first line of error_description', async () => {
  const s = await failWith(err('invalid_grant', 'AADSTS53003: Access has been blocked by Conditional Access policies.\r\nTrace ID: x'));
  assert.deepEqual(s, { status: 'failed', error: 'AADSTS53003: Access has been blocked by Conditional Access policies.' });
});

test('unknown error and server error still end as failed with a message', async () => {
  const a = await failWith(err('weird', 'AADSTS99999: Something odd.\r\nTrace ID: x'));
  assert.equal(a.error, 'AADSTS99999: Something odd.');
  // a 503 keeps the poll going until the code expires
  const { app, clock } = make([reply(200, DEVICE), reply(503, 'oops'), () => { clock.t += 901000; return reply(503, 'oops'); }]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => app.status().status === 'failed');
  assert.equal(app.status().error, 'The code expired before it was entered. Start again.');
});

test('cancel stops polling', async () => {
  const { app, calls } = make([reply(200, DEVICE), err('authorization_pending', 'p'), err('authorization_pending', 'p')]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  app.cancel();
  assert.equal(app.status().status, 'idle');
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.length <= 2);
});

test('polling stops when the code expires', async () => {
  const { app, clock } = make([reply(200, DEVICE), () => { clock.t += 901000; return err('authorization_pending', 'p'); }]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => app.status().status === 'failed');
  assert.equal(app.status().error, 'The code expired before it was entered. Start again.');
});

test('restore then accessToken refreshes once, caches, refreshes near expiry', async () => {
  const { app, calls, clock, saved } = make([tok('at2', 'rt2', 3600), tok('at3', 'rt3', 3600)]);
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  assert.equal(calls.length, 0);
  assert.equal(await app.accessToken(), 'at2');
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[0].body.grant_type, 'refresh_token');
  assert.equal(calls[0].body.refresh_token, 'rt1');
  assert.equal(calls[0].body.client_id, CLIENT);
  assert.equal(calls[0].body.scope, M.SCOPES);
  assert.equal(await app.accessToken(), 'at2');
  assert.equal(calls.length, 1);
  clock.t += 3600000 - 4 * 60000;
  assert.equal(await app.accessToken(), 'at3');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.refresh_token, 'rt2');
  assert.deepEqual(saved, ['rt2', 'rt3']);
});

test('the new refresh token is stored before accessToken resolves', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { app } = make([tok('at2', 'rt2')], { onRefreshToken: () => gate });
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  let resolved = false;
  const p = app.accessToken().then((v) => { resolved = true; return v; });
  await wait(() => false);
  assert.equal(resolved, false);
  release();
  assert.equal(await p, 'at2');
});

test('single flight', async () => {
  const { app, calls } = make([tok('at2', 'rt2')]);
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  const [a, b] = await Promise.all([app.accessToken(), app.accessToken()]);
  assert.equal(a, 'at2'); assert.equal(b, 'at2');
  assert.equal(calls.length, 1);
});

test('refresh invalid_grant -> refused; network / 503 -> transient and keep the refresh token', async () => {
  const r = make([err('invalid_grant', 'AADSTS50173: expired\r\nTrace ID: t')]);
  r.app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  await assert.rejects(r.app.accessToken(), (e) => e instanceof M.MsAppError && e.kind === 'refused');

  const t = make([new Error('ECONNRESET'), reply(503, 'down'), tok('at2', 'rt2')]);
  t.app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  await assert.rejects(t.app.accessToken(), (e) => e.kind === 'transient');
  await assert.rejects(t.app.accessToken(), (e) => e.kind === 'transient');
  assert.equal(await t.app.accessToken(), 'at2');
  assert.equal(t.calls[2].body.refresh_token, 'rt1');
});

test('signed-out, forget, signOut', async () => {
  const { app, calls } = make([tok('at2', 'rt2'), tok('at3', 'rt3')]);
  await assert.rejects(app.accessToken(), (e) => e.kind === 'signed-out');
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  await app.accessToken();
  app.forget();
  assert.equal(await app.accessToken(), 'at3');
  assert.equal(calls[1].body.refresh_token, 'rt2');
  app.signOut();
  await assert.rejects(app.accessToken(), (e) => e.kind === 'signed-out');
});

test('errors never contain live secrets', async () => {
  const { app } = make([err('invalid_grant', 'AADSTS50173: bad rt1 secret\r\nx')]);
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  await assert.rejects(app.accessToken(), (e) => !/rt1/.test(e.message) && /AADSTS50173/.test(e.message));
  const s = await failWith(err('invalid_grant', 'AADSTS53003: blocked dc-secret here\r\nx'));
  assert.ok(!/dc-secret/.test(s.error));
});

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test('signOut during a refresh discards the result and does not persist', async () => {
  const d = deferred();
  const { app, saved } = make([() => d.promise]);
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  const p = app.accessToken();
  await wait(() => false);
  app.signOut();
  d.resolve(tok('at2', 'rt2'));
  await assert.rejects(p, (e) => e.kind === 'signed-out');
  assert.deepEqual(saved, []);
  await assert.rejects(app.accessToken(), (e) => e.kind === 'signed-out');
});

test('cancel during the poll token request does not persist or finish', async () => {
  const d = deferred();
  const { app, saved } = make([reply(200, DEVICE), () => d.promise]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => false);
  app.cancel();
  d.resolve(tok());
  await wait(() => false);
  assert.deepEqual(saved, []);
  assert.equal(app.status().status, 'idle');
});

test('signOut then restore of another account does not join the old refresh', async () => {
  const d = deferred();
  const { app, calls } = make([() => d.promise, tok('atB', 'rtB2')]);
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rtA' });
  const old = app.accessToken();
  await wait(() => false);
  app.signOut();
  app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rtB' });
  const fresh = app.accessToken();
  d.resolve(tok('atA', 'rtA2'));
  await assert.rejects(old, (e) => e.kind === 'signed-out');
  assert.equal(await fresh, 'atB');
  assert.equal(calls[1].body.refresh_token, 'rtB');
});

test('429 is transient at refresh and polling keeps going through it', async () => {
  const r = make([err('too_many_requests', 'slow down please', 429)]);
  r.app.restore({ tenantId: TENANT, clientId: CLIENT, refreshToken: 'rt1' });
  await assert.rejects(r.app.accessToken(), (e) => e.kind === 'transient');
  assert.equal(M.classify(429, { error: 'x' }).kind, 'transient');
  const { app } = make([reply(200, DEVICE), err('x', 'y', 429), reply(503, 'down'), tok()]);
  await app.start({ tenantId: TENANT, clientId: CLIENT });
  await wait(() => app.status().status === 'done');
  assert.equal(app.status().status, 'done');
});

test('classify', () => {
  assert.equal(M.classify(400, { error: 'authorization_pending' }).kind, 'pending');
  assert.equal(M.classify(400, { error: 'slow_down' }).kind, 'slow_down');
  assert.equal(M.classify(400, { error: 'code_expired' }).kind, 'expired');
  assert.equal(M.classify(400, { error: 'interaction_required', error_description: 'x' }).kind, 'refused');
  assert.equal(M.classify(400, { error: 'x', error_description: 'AADSTS700082: y' }).kind, 'refused');
  assert.equal(M.classify(400, { error: 'invalid_scope', error_description: 'bad' }).kind, 'config');
  assert.equal(M.classify(502, { error: 'x' }).kind, 'transient');
  assert.equal(M.classify(400, null).kind, 'transient');
});
