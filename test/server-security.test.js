'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { writePassword } = require('../lib/password');

const PASSWORD = 'correct horse';

// A running, set-up server. env overrides the helper's defaults.
async function ready(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-sec-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  const srv = await startServer({ ...d, env });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const post = (url, body, cookie) => fetch(srv.base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/setup/password', { password: PASSWORD })).status, 200);
  const cookie = await login(srv.base, PASSWORD);
  assert.equal((await post('/api/setup/boards', { labels: ['Work'], timezone: 'Europe/London' }, cookie)).status, 200);
  assert.equal((await post('/api/setup/finish', { today: false }, cookie)).status, 200);
  return { ...srv, cookie };
}

// Raw request so the Host header can be anything.
function raw(base, p, host, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(base, host, cookie, origin = base) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET /api/term?id=abcdefgh1 HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
    sock.setTimeout(3000, () => { sock.destroy(); });
    sock.on('error', reject);
  });
}

test('bad Host gets 421 naming ALLOWED_HOSTS', async (t) => {
  const s = await ready(t);
  const r = await raw(s.base, '/api/me', 'evil.example');
  assert.equal(r.status, 421);
  assert.match(r.type, /^text\/plain/);
  assert.match(r.body, /ALLOWED_HOSTS/);
  assert.match(r.body, /"evil\.example"/);
  assert.equal((await raw(s.base, '/', 'evil.example')).status, 421);
  assert.equal((await raw(s.base, '/api/me', 'localhost:1234')).status, 200);
  // Logged once per host.
  await raw(s.base, '/api/me', 'evil.example');
  assert.equal(s.output().split('host rejected: evil.example').length - 1, 1);
});

test('the echoed host is sanitised', async (t) => {
  const s = await ready(t);
  const r = await raw(s.base, '/api/me', 'ev<script>il.example');
  assert.equal(r.status, 421);
  assert.ok(!r.body.includes('<script'));
  assert.match(r.body, /"evscriptil\.example"/);
});

test('ALLOWED_HOSTS lets a configured name in', async (t) => {
  const s = await ready(t, { ALLOWED_HOSTS: 'Board.Example,127.0.0.1' });
  assert.equal((await raw(s.base, '/api/me', 'board.example:443')).status, 200);
  assert.equal((await raw(s.base, '/api/me', 'localhost')).status, 421);
});

test('health ignores Host', async (t) => {
  const s = await ready(t);
  assert.equal((await raw(s.base, '/health', 'evil.example')).status, 200);
});

test('X-Forwarded-Host does not stand in for Host', async (t) => {
  const s = await ready(t, { TRUST_PROXY: '1' });
  assert.equal((await raw(s.base, '/api/me', 'evil.example', { 'x-forwarded-host': 'localhost' })).status, 421);
});

test('local reads are off by default', async (t) => {
  const s = await ready(t);
  assert.equal((await fetch(`${s.base}/api/tasks`)).status, 401);
  assert.ok(!s.output().includes('same-box read path trusts'));
  const on = await ready(t, { LOCAL_READ: '1' });
  assert.equal((await fetch(`${on.base}/api/tasks`)).status, 200);
  assert.ok(on.output().includes('same-box read path trusts'));
});

test('TERMINAL unset means on, TERMINAL=0 means off', async (t) => {
  const me = async (s) => (await (await fetch(`${s.base}/api/me`, { headers: { cookie: s.cookie } })).json()).features.terminal;
  assert.equal(await me(await ready(t, { TERMINAL: undefined })), true);
  assert.equal(await me(await ready(t, { TERMINAL: '0' })), false);
});

test('socket with a bad Host gets 421', async (t) => {
  const s = await ready(t, { TERMINAL: undefined });
  const host = new URL(s.base).host;
  assert.match(await upgrade(s.base, host, ''), / 401 /);
  assert.match(await upgrade(s.base, 'evil.example', s.cookie), / 421 /);
});

test('the host named in a 421 can be pasted into ALLOWED_HOSTS', async (t) => {
  const s = await ready(t);
  const r = await raw(s.base, '/api/me', 'mybox.lan:7684');
  const name = /add "([^"]+)" to ALLOWED_HOSTS/.exec(r.body)[1];
  assert.equal(name, 'mybox.lan');
  const s2 = await ready(t, { ALLOWED_HOSTS: `${name},127.0.0.1` });
  assert.equal((await raw(s2.base, '/api/me', 'mybox.lan:7684')).status, 200);
});

test('a malformed upgrade target gets 400 and the server survives', async (t) => {
  const s = await ready(t, { TERMINAL: undefined });
  const u = new URL(s.base);
  const line = await new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET //[ HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
    sock.setTimeout(3000, () => sock.destroy());
    sock.on('error', reject);
  });
  assert.match(line, / 400 /);
  assert.equal((await fetch(`${s.base}/health`)).status, 200);
});

test('agent hook is exempt from the Host check', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-sec-'));
  fs.mkdirSync(path.join(root, 'vault'));
  fs.mkdirSync(path.join(root, 'home'));
  const srv = await startServer({ vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home'),
    env: { TERMINAL: undefined, ALLOWED_HOSTS: 'example.test' } });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const r = await fetch(`${srv.base}/api/term/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  // Not 421: the setup gate answers 409 first (403 once set up, from the token check).
  assert.equal(r.status, 409);
  assert.equal((await fetch(`${srv.base}/api/me`)).status, 421);
});

test('socket whose Origin and Host are both the attacker gets 421', async (t) => {
  const s = await ready(t, { TERMINAL: undefined });
  assert.match(await upgrade(s.base, 'evil.example', s.cookie, 'http://evil.example'), / 421 /);
});

test('before setup a bad Host cannot set the password', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-sec-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  const srv = await startServer(d);
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const u = new URL(srv.base);
  const body = JSON.stringify({ password: PASSWORD });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/setup/password', method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(status, 421);
  assert.ok(!fs.existsSync(path.join(d.data, 'config.json')));
});

// A signed-in server over a seeded vault with one board (Work), plus a folder
// beside the vault for symlinks to point at.
async function seeded(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-sec-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home'), outside: path.join(root, 'outside') };
  for (const dir of [d.vault, d.home, d.outside]) fs.mkdirSync(dir);
  seedVault(d.vault, {
    '.vaultos/settings.json': JSON.stringify({
      version: 1, setupDone: true, boards: [{ key: 'work', dir: 'Work', label: 'Work', hidden: false }],
      features: { today: false }, today: { dir: 'Work/Today' },
    }),
    'Work/_tasks/Board.md': '---\n\nkanban-plugin: board\n\n---\n',
    ...files,
  });
  writePassword(d.data, PASSWORD);
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = async (url) => {
    const res = await fetch(srv.base + url, { headers: { cookie } });
    return { status: res.status, text: await res.text() };
  };
  const cookie = await login(srv.base, PASSWORD);
  return { ...srv, ...d, get };
}

const taskMd = (title) => `---\ntitle: ${title}\nstatus: backlog\n---\n\n${title} body\n`;
const q = encodeURIComponent;

test('a symlink cannot lead a Board or KB read out of its workspace', async (t) => {
  const s = await seeded(t, { 'Work/1. p/real/task.md': taskMd('Inside') });
  fs.writeFileSync(path.join(s.outside, 'task.md'), taskMd('Outside'));
  fs.writeFileSync(path.join(s.outside, 'notes.md'), 'Outside notes');
  fs.writeFileSync(path.join(s.outside, 'article.md'), '---\ntype: article\ntitle: Outside\n---\n\nOutside\n');
  fs.writeFileSync(path.join(s.outside, 'd.html'), '<svg viewBox="0 0 1 1"><title>Outside</title></svg>');
  const link = (rel, target) => {
    const f = path.join(s.vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.symlinkSync(target, f);
  };
  link('Work/1. p/file/task.md', path.join(s.outside, 'task.md'));
  link('Work/1. p/dir', s.outside);
  link('Work/1. p/real/notes.md', path.join(s.outside, 'notes.md'));
  link('Work/1. p/real/diagrams/d.html', path.join(s.outside, 'd.html'));
  link('Work/1. p/real/screenshots/x.png', path.join(s.data, 'config.json'));
  link('Work/1. p/art/article.md', path.join(s.outside, 'article.md'));
  link('Work/1. p/alias', path.join(s.vault, 'Work', '1. p', 'real'));
  for (const url of [
    `/api/task?ws=work&path=${q('Work/1. p/file/task.md')}`,
    `/api/task?ws=work&path=${q('Work/1. p/dir/task.md')}`,
    `/api/task/doc?ws=work&path=${q('Work/1. p/real/notes.md')}`,
    `/api/diagram?ws=work&path=${q('Work/1. p/real/diagrams/d.html')}`,
    `/api/screenshot?ws=work&path=${q('Work/1. p/real/screenshots/x.png')}`,
    `/api/kb/article?ws=work&path=${q('Work/1. p/art/article.md')}`,
    `/api/kb/article.pdf?ws=work&format=html&path=${q('Work/1. p/art/article.md')}`,
  ]) {
    const r = await s.get(url);
    assert.equal(r.status, 400, url);
    assert.doesNotMatch(r.text, /Outside|passwordHash/, url);
  }
  // One that stays inside the workspace still works.
  const ok = await s.get(`/api/task?ws=work&path=${q('Work/1. p/alias/task.md')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Inside/);
});

test('the PDF page lets Chromium run no script and load nothing but data: images', async (t) => {
  const s = await seeded(t, {
    'Work/1. p/a/article.md': '---\ntype: article\ntitle: A\n---\n\n## One\n\n<iframe src="file:///etc/hostname"></iframe><script>x()</script>\n',
  });
  const r = await s.get(`/api/kb/article.pdf?ws=work&format=html&path=${q('Work/1. p/a/article.md')}`);
  assert.equal(r.status, 200);
  const csp = r.text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(csp, 'no CSP meta');
  assert.equal(csp[1], "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.ok(r.text.indexOf(csp[0]) < r.text.indexOf('<style>'), 'the CSP must come before any content');
});

test('a password change closes open terminal sockets, and only the new cookie opens one', { timeout: 15e3 }, async (t) => {
  const WebSocket = require('ws');
  const s = await ready(t, { TERMINAL: undefined });
  const open = (cookie) => new Promise((resolve) => {
    const ws = new WebSocket(`${s.base.replace('http', 'ws')}/api/term?id=abcdefgh2`, { headers: { cookie, origin: s.base } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
    ws.on('error', () => {});
  });
  const ws = await open(s.cookie);
  assert.ok(ws instanceof WebSocket);
  const closed = new Promise((resolve) => ws.once('close', resolve));
  const res = await fetch(`${s.base}/api/settings/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: s.cookie },
    body: JSON.stringify({ current: PASSWORD, next: 'a brand new one' }),
  });
  assert.equal(res.status, 200);
  await closed;
  assert.equal(await open(s.cookie), 401);
  const again = await open(res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
  assert.ok(again instanceof WebSocket);
  again.close();
});
