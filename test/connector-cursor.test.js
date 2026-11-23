'use strict';
// The Cursor CLI's sign-in to Cursor's own Microsoft 365 servers, with a fake CLI process and a fake local listener.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const { createCursorLogins, cursorTools, readLink, scrub } = require('../lib/connector-cursor');

const LINK = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=aaaaaaaa-0000-0000-0000-000000000000'
  + '&code_challenge=cc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback&state=st4te&scope=offline_access';

// A fake `agent mcp login`: prints the banner and the link, then waits for the callback and exits with `exitCode`.
function fakeCli({ print = LINK, exitCode = 0, exitAfterLink = false } = {}) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)); };
    child.finish = (code = exitCode) => child.emit('exit', code);
    spawned.push({ cmd, args, opts, child });
    setImmediate(() => {
      child.stdout.write('\x1b[1mMCP Login\x1b[0m\nPreparing login...\nOpening your browser...\n');
      if (print) child.stdout.write(`${print}\n\nListening on http://localhost:8787/callback for the OAuth callback...\n`);
      if (exitAfterLink) setImmediate(() => child.emit('exit', exitCode));
    });
    return child;
  };
  return { spawn, spawned };
}

function fakeListener(spawned, { exitCode = 0, refuse = false } = {}) {
  const hits = [];
  const fetch = async (url) => {
    hits.push(String(url));
    if (refuse) throw new Error('ECONNREFUSED');
    setImmediate(() => spawned[spawned.length - 1].child.finish(exitCode));
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetch, hits };
}

const BACK = 'http://localhost:8787/callback?code=0.AAA-secret-code&state=st4te&session_state=s1';

test('readLink takes Microsoft link, the local redirect and the state; anything else is refused', () => {
  assert.deepEqual(readLink(LINK), { url: LINK, port: '8787', path: '/callback', state: 'st4te' });
  assert.equal(readLink(LINK.replace('https://login.microsoftonline.com', 'https://evil.example')), null);
  assert.equal(readLink(LINK.replace('localhost%3A8787', 'evil.example%3A8787')), null);
  assert.equal(readLink(LINK.replace('&state=st4te', '')), null);
  assert.equal(readLink('not a url'), null);
});

test('start runs `agent mcp login <id>` with no browser and answers the link', async () => {
  const cli = fakeCli();
  const L = createCursorLogins({ spawn: cli.spawn, home: '/home/x' });
  const r = await L.start('cursor-teams');
  assert.equal(r.url, LINK);
  const s = cli.spawned[0];
  assert.deepEqual([s.cmd, s.args], ['bash', ['-lc', "agent mcp login 'cursor-teams'"]]);
  assert.equal(s.opts.cwd, '/home/x');
  assert.equal(s.opts.env.BROWSER, 'true');
  const { startedAt, ...st } = L.status('cursor-teams');
  assert.deepEqual(st, { status: 'waiting', url: LINK, port: '8787' });
  assert.equal(typeof startedAt, 'number');
  L.cancel('cursor-teams');
});

test('finish hands exactly the pasted query to the CLI listener on localhost, then reports done', async () => {
  const cli = fakeCli();
  const net = fakeListener(cli.spawned);
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', fetch: net.fetch });
  await L.start('cursor-teams');
  assert.deepEqual(await L.finish('cursor-teams', `  ${BACK}\n`), { ok: true });
  assert.deepEqual(net.hits, ['http://localhost:8787/callback?code=0.AAA-secret-code&state=st4te&session_state=s1']);
  assert.equal(L.status('cursor-teams').status, 'done');
});

test('finish refuses an address that is not the CLI listener, another state, or no code, and forwards nothing', async () => {
  const cli = fakeCli();
  const net = fakeListener(cli.spawned);
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', fetch: net.fetch });
  await L.start('cursor-teams');
  for (const bad of [
    'https://evil.example/callback?code=x&state=st4te',
    'http://localhost:9999/callback?code=x&state=st4te',
    'http://localhost:8787/other?code=x&state=st4te',
    'http://169.254.169.254:8787/callback?code=x&state=st4te',
    'nonsense',
    '',
  ]) await assert.rejects(() => L.finish('cursor-teams', bad), /isn't the address your browser ended on/, bad);
  await assert.rejects(() => L.finish('cursor-teams', 'http://localhost:8787/callback?code=x&state=other'), /different sign-in/);
  await assert.rejects(() => L.finish('cursor-teams', 'http://localhost:8787/callback?state=st4te'), /no sign-in code/);
  assert.deepEqual(net.hits, []);
  assert.equal(L.status('cursor-teams').status, 'waiting', 'a wrong paste does not end the sign-in');
  L.cancel('cursor-teams');
});

test('a blocked consent coming back from Microsoft says who can fix it, without Microsoft\'s code', async () => {
  const cli = fakeCli();
  const net = fakeListener(cli.spawned, { exitCode: 1 });
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', fetch: net.fetch, consent: { 'cursor-teams': 'Chat.Read, ChatMessage.Send' } });
  await L.start('cursor-teams');
  const back = 'http://localhost:8787/callback?error=access_denied&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented&state=st4te';
  await assert.rejects(() => L.finish('cursor-teams', back), (e) => /ask an admin to grant consent for Chat\.Read, ChatMessage\.Send/i.test(e.message) && !/AADSTS/.test(e.message));
  assert.equal(net.hits.length, 1, 'the CLI is still told, so it stops waiting');
  assert.equal(L.status('cursor-teams').status, 'failed');
});

test('a CLI that fails after the callback reports its last line, scrubbed', async () => {
  const cli = fakeCli();
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', fetch: async () => {
    const c = cli.spawned[0].child;
    setImmediate(() => { c.stdout.write('Token exchange failed for http://localhost:8787/callback?code=0.AAA-secret-code&state=st4te\n'); setImmediate(() => c.finish(1)); });
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  } });
  await L.start('cursor-teams');
  await assert.rejects(() => L.finish('cursor-teams', BACK), (e) => /Token exchange failed/.test(e.message) && !/secret-code|st4te/.test(e.message));
});

test('a CLI that is no longer listening, or a finish with no sign-in running, asks to start again', async () => {
  const cli = fakeCli();
  const net = fakeListener(cli.spawned, { refuse: true });
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', fetch: net.fetch });
  await assert.rejects(() => L.finish('cursor-teams', BACK), /start again/);
  await L.start('cursor-teams');
  await assert.rejects(() => L.finish('cursor-teams', BACK), /wasn't listening any more/);
});

test('an already signed-in CLI exits without a link: start answers done', async () => {
  const cli = fakeCli({ print: '', exitAfterLink: true });
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h' });
  assert.deepEqual(await L.start('cursor-teams'), { url: null, done: true });
  assert.equal(L.status('cursor-teams').status, 'done');
});

test('a CLI that fails before printing a link rejects with its own last line', async () => {
  const cli = fakeCli({ print: '✗ MCP login failed\nFailed to load MCP \'cursor-teams\': it has not been approved', exitCode: 1, exitAfterLink: true });
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h' });
  await assert.rejects(() => L.start('cursor-teams'), /has not been approved/);
  assert.equal(L.status('cursor-teams').status, 'failed');
});

test('starting again stops the first CLI', async () => {
  const cli = fakeCli();
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h' });
  await L.start('cursor-teams');
  await L.start('cursor-teams');
  assert.equal(cli.spawned[0].child.killed, true);
  assert.equal(cli.spawned[1].child.killed, false);
  L.cancel('cursor-teams');
  assert.equal(cli.spawned[1].child.killed, true);
  assert.deepEqual(L.status('cursor-teams'), { status: 'idle' });
});

test('cursorTools: signed out, signed in, or failing', async () => {
  const at = (stdout, code = 0) => async (cmd) => { assert.equal(cmd, "agent mcp list-tools 'cursor-teams'"); return { code, stdout, stderr: '' }; };
  assert.deepEqual(await cursorTools(at("MCP 'cursor-teams' requires authentication.\nPlease run: agent mcp login cursor-teams"), 'cursor-teams', 'Teams (Cursor)'),
    { ok: false, tools: 0, signedIn: false, error: 'Not signed in to Teams (Cursor) in Cursor yet.' });
  assert.deepEqual(await cursorTools(at('Tools for cursor-teams:\n- list_chats\n- send_message'), 'cursor-teams', 'Teams (Cursor)'), { ok: true, tools: null, signedIn: true, error: null });
  const bad = await cursorTools(at('Failed to load MCP: boom', 1), 'cursor-teams', 'Teams (Cursor)');
  assert.equal(bad.ok, false);
  assert.equal(bad.signedIn, null);
});

test('scrub never repeats a code, a state or a query string', () => {
  assert.equal(scrub('see http://localhost:8787/callback?code=abc&state=def now'), 'see http://localhost:8787/callback now');
  assert.equal(scrub('code=abc&state=def'), 'code=…&state=…');
});

test('a CLI that stops waiting before anything is pasted is not a sign-in: the card and Finish both say why', async () => {
  const cli = fakeCli();
  let t = 1000000;
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', now: () => t });
  await L.start('cursor-teams');
  t += 5 * 60 * 1000;
  cli.spawned[0].child.stdout.write('Timed out waiting for the OAuth callback\n');
  await new Promise((r) => setImmediate(r));
  cli.spawned[0].child.finish(0); // exits cleanly, but nobody signed in
  const s = L.status('cursor-teams');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /stopped waiting for Microsoft after 5 minutes \(Timed out waiting for the OAuth callback\)\. Select Sign in to start again\./);
  await assert.rejects(() => L.finish('cursor-teams', BACK), (e) => e.message === s.error);
});

test('Finish with nothing waiting says VaultOS may have restarted', async () => {
  const L = createCursorLogins({ spawn: fakeCli().spawn, home: '/h' });
  await assert.rejects(() => L.finish('cursor-teams', BACK), /may have restarted since you selected Sign in/);
});

test('status while waiting says when it started', async () => {
  const cli = fakeCli();
  const L = createCursorLogins({ spawn: cli.spawn, home: '/h', now: () => 42 });
  await L.start('cursor-teams');
  assert.equal(L.status('cursor-teams').startedAt, 42);
  L.cancel('cursor-teams');
});
