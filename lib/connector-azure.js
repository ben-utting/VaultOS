'use strict';
// Azure CLI helpers for the Azure connector: device-code sign-in, account info,
// and a token check. Agents use the shared az login via `azmcp`; nothing here
// prints or stores a token.
const { execFile } = require('node:child_process');
const nodeSpawn = require('node:child_process').spawn;
const { shellQuote } = require('./agents');

const EXPIRED_MSG = 'The code expired before it was entered. Start again.';
const CODE_RE = /open the page (https:\/\/\S+) and enter the code ([A-Z0-9]{8,12})\b/;

// Login shell so PATH matches a VaultOS terminal; unlike agents.js defaultRun it keeps the output.
function runCapture(cmd, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', cmd], { env: process.env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function parseDeviceCode(text) {
  const m = CODE_RE.exec(String(text || ''));
  return m ? { url: m[1], code: m[2] } : null;
}

function lastLines(text, n) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join('\n');
}

function createDeviceLogin({ spawn = nodeSpawn, now = Date.now, ttlMs = 900000 } = {}) {
  let state = 'idle', error, proc = null, info = null, pending = null, output = '';

  function settlePending(err) {
    if (pending) { const p = pending; pending = null; p.reject(err); }
  }

  function start({ tenant } = {}) {
    if (state === 'waiting' && proc) return info ? Promise.resolve(info) : pending.promise;
    const cmd = `az login --use-device-code${tenant ? ` --tenant ${shellQuote(tenant)}` : ''} -o none`;
    const child = spawn('bash', ['-lc', cmd], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child; state = 'waiting'; error = undefined; info = null; output = '';
    const p = {};
    p.promise = new Promise((resolve, reject) => { p.resolve = resolve; p.reject = reject; });
    p.promise.catch(() => {});
    pending = p;

    const onData = (chunk) => {
      if (proc !== child) return;
      output += chunk.toString();
      if (!info) {
        const found = parseDeviceCode(output);
        if (found) {
          info = { ...found, expiresAt: now() + ttlMs };
          if (pending) { const q = pending; pending = null; q.resolve(info); }
        }
      }
    };
    child.stdout && child.stdout.on('data', onData);
    child.stderr && child.stderr.on('data', onData);
    const onEnd = (code) => {
      if (proc !== child) return; // cancelled or replaced
      proc = null;
      if (code === 0) state = 'done';
      else {
        state = 'failed';
        error = /AADSTS70016/.test(output) ? EXPIRED_MSG : (lastLines(output, 5) || 'az login failed');
      }
      settlePending(new Error(error || 'az login ended before showing a code'));
    };
    child.on('close', onEnd);
    child.on('error', (e) => {
      if (proc !== child) return;
      output += `${e.message}\n`;
      onEnd(1);
    });
    return p.promise;
  }

  function status() {
    if (state === 'waiting' && info && now() > info.expiresAt) {
      const child = proc;
      proc = null; state = 'failed'; error = EXPIRED_MSG;
      try { child && child.kill(); } catch { /* already gone */ }
    }
    return error && state === 'failed' ? { status: state, error } : { status: state };
  }

  function cancel() {
    const child = proc;
    proc = null; state = 'idle'; error = undefined; info = null;
    settlePending(new Error('Sign-in cancelled'));
    try { child && child.kill(); } catch { /* already gone */ }
  }

  return { start, status, cancel };
}

async function account({ run = runCapture } = {}) {
  const r = await run('az account show -o json');
  if (!r || r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return {
      user: j.user && j.user.name, tenantId: j.tenantId,
      subscriptionId: j.id, subscriptionName: j.name,
    };
  } catch { return null; }
}

async function subscriptions({ run = runCapture } = {}) {
  const r = await run('az account list --all -o json');
  if (!r || r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout).map((s) => ({ id: s.id, name: s.name, isDefault: !!s.isDefault }));
  } catch { return []; }
}

function setSubscription(id, { run = runCapture } = {}) {
  return run(`az account set --subscription ${shellQuote(id)}`);
}

function logout({ run = runCapture } = {}) {
  return run('az logout');
}

async function testAzure({ run = runCapture } = {}) {
  const r = await run('az account get-access-token --query expiresOn -o tsv');
  if (r && r.code === 0) return { ok: true, needsSignIn: false };
  const err = String((r && (r.stderr || r.stdout)) || '');
  const needsSignIn = /AADSTS|az login/.test(err);
  return { ok: false, needsSignIn, error: lastLines(err, 5) || 'az failed' };
}

module.exports = { runCapture, parseDeviceCode, createDeviceLogin, account, subscriptions, setSubscription, logout, testAzure };
