'use strict';
// Spawns server.js from this checkout on a free port against temp folders, so
// server tests exercise the real HTTP edge. Not a suite: `node --test
// 'test/*.test.js'` never picks it up.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const READY_MS = 10e3;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A minimal environment rather than this process's own, so nothing from the
// shell running the tests (LOCAL_READ, SECURE_COOKIE, TZ…) leaks into the
// server. An `env` value of undefined removes that variable.
async function startServer({ vault, data, home, env = {} }) {
  const port = await freePort();
  const full = {
    PATH: process.env.PATH, HOME: home, VAULT_DIR: vault, DATA_DIR: data, PORT: String(port),
    TERMINAL: '0', TODAY_QUOTES: '0', ...env,
  };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`server did not start in ${READY_MS / 1000}s:\n${out}`)), READY_MS);
    function fail(err) { clearTimeout(timer); child.kill(); reject(err); }
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => fail(new Error(`server exited (${code}) before listening:\n${out}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => out,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

// The cookie header for a logged-in session.
async function login(base, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// files: { 'relative/path': 'content' }
function seedVault(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

module.exports = { startServer, login, seedVault };
