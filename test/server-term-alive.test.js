'use strict';
// A page that went away without saying so (a laptop asleep, a tab the browser dropped, a phone app closed in the
// background) must not keep its terminals "attached": a page coming back would leave them dimmed, held by nobody.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');

const PASSWORD = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (base, method, url, { cookie, body } = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
};

async function ready(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-term-alive-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {});
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { TERMINAL: '1', ...env } });
  const open = [];
  t.after(async () => { for (const x of open) x.close(); await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  const term = async (o) => { const x = await openTerm({ base, cookie }, o); open.push(x); return x; };
  const attached = async (id) => (await call(base, 'GET', '/api/term/list', { cookie })).body.sessions.find((x) => x.id === id).attached;
  return { base, cookie, term, attached };
}

test('the heartbeat lets go of a page that stopped answering, and the shell keeps running', { timeout: 30000 }, async (t) => {
  const s = await ready(t, { TERM_PING_MS: '300' });
  const gone = await s.term();
  const here = await s.term();
  gone.freeze();
  let freed = false;
  for (let i = 0; i < 20 && !freed; i++) { await sleep(150); freed = !(await s.attached(gone.id)); }
  assert.equal(freed, true, 'the frozen page was let go within a few beats');
  assert.equal(await s.attached(here.id), true, 'a page that answers is kept');
  const back = await s.term({ id: gone.id });   // the page comes back: same shell, not a new one
  assert.equal(back.id, gone.id);
  assert.equal(await s.attached(gone.id), true);
});

test('a probe lets go of a holder that does not answer and keeps one that does', { timeout: 30000 }, async (t) => {
  const s = await ready(t);   // the default heartbeat (30s) never runs during this test
  const gone = await s.term();
  const here = await s.term();
  gone.freeze();
  assert.equal(await s.attached(gone.id), true, 'without a check the frozen page still counts as attached');
  const t0 = Date.now();
  const r = await call(s.base, 'POST', '/api/term/probe', { cookie: s.cookie, body: { ids: [gone.id, here.id, 'nope-not-a-terminal', 42] } });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 4000, 'the probe answers within a couple of seconds');
  assert.deepEqual(r.body.dropped, [gone.id]);
  assert.equal(await s.attached(gone.id), false);
  assert.equal(await s.attached(here.id), true);
});

test('the probe needs a signed-in session', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const r = await call(s.base, 'POST', '/api/term/probe', { body: { ids: [] } });
  assert.equal(r.status, 401);
  const bad = await call(s.base, 'POST', '/api/term/probe', { cookie: s.cookie, body: { ids: 'x' } });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.body.dropped, []);
});

test('TERM_PING_MS stays out of the shell environment', { timeout: 30000 }, async (t) => {
  const s = await ready(t, { TERM_PING_MS: '300' });
  const tm = await s.term();
  assert.ok(tm.id);
  // openTerm read VAULTOS_TERM_ID from the shell; ask the same shell for TERM_PING_MS.
  const out = await new Promise((resolve) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`${s.base.replace('http', 'ws')}/api/term?id=${tm.id}`, { headers: { cookie: s.cookie, origin: s.base } });
    let buf = '';
    ws.once('open', () => ws.send(JSON.stringify({ t: 'in', d: `printf '%s%s[%s]\\n' P M "\${TERM_PING_MS-unset}"\r` })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'o') return;
      buf += m.d;
      const hit = /PM\[([^\]]*)\]/.exec(buf);
      if (hit) { ws.close(); resolve(hit[1]); }
    });
  });
  assert.equal(out, 'unset');
});
