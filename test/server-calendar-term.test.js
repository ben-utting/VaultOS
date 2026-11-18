'use strict';
// The calendar's terminal-only routes (spec §7.1): loopback + a live terminal's token, Calendar on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, seedVault } = require('./helpers/server');
const { openTerm } = require('./helpers/term');
const CC = require('../public/calendar-core');

const PASSWORD = 'correct horse battery';
const OFF = 'The calendar is switched off in VaultOS Settings → Features.';
const call = async (base, method, url, { cookie, body, headers = {} } = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

async function ready(t, { calendar = true, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-cal-term-'));
  const d = { vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home') };
  fs.mkdirSync(d.vault);
  fs.mkdirSync(d.home);
  seedVault(d.vault, {});
  const srv = await startServer({ vault: d.vault, data: d.data, home: d.home, env: { TERMINAL: '1', TZ: 'Europe/London', ...env } });
  const terms = [];
  t.after(async () => { for (const x of terms) x.close(); await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = srv.base;
  assert.equal((await call(base, 'POST', '/api/setup/password', { body: { password: PASSWORD } })).status, 200);
  const cookie = await login(base, PASSWORD);
  assert.equal((await call(base, 'POST', '/api/setup/boards', { cookie, body: { labels: ['Work', 'Home'], timezone: 'Europe/London' } })).status, 200);
  assert.equal((await call(base, 'POST', '/api/setup/finish', { cookie, body: { today: false } })).status, 200);
  if (calendar) assert.equal((await call(base, 'POST', '/api/settings/features', { cookie, body: { calendar: true } })).status, 200);
  const term = async () => { const x = await openTerm({ base, cookie }); terms.push(x); return x; };
  const as = (tm, command, args, more = {}) => call(base, 'POST', `/api/term/calendar/${command}`, { body: { id: tm.id, token: tm.token, args, ...more } });
  const person = (method, url, body) => call(base, method, url, { cookie, body });
  return { ...d, base, cookie, term, as, person };
}

test('terminal routes need a live terminal token from loopback', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  assert.equal((await s.as(tm, 'today')).status, 200);
  const bare = await call(s.base, 'POST', '/api/term/calendar/today', { body: {} });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.error, 'Forbidden');
  assert.equal((await s.as({ id: tm.id, token: 'x'.repeat(tm.token.length) }, 'today')).status, 403);
  assert.equal((await call(s.base, 'POST', '/api/term/calendar/today', { cookie: s.cookie, body: {} })).status, 403);
  assert.equal((await call(s.base, 'POST', '/api/term/calendar/today', { body: {}, headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
  assert.equal((await s.as(tm, 'nonsense')).status, 404);
  assert.equal((await s.as(tm, 'nonsense')).body.error, 'No such command');
});

test('a Host header outside the allowlist still reaches /api/term/calendar', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-cal-host-'));
  fs.mkdirSync(path.join(root, 'vault'));
  fs.mkdirSync(path.join(root, 'home'));
  const srv = await startServer({ vault: path.join(root, 'vault'), data: path.join(root, 'data'), home: path.join(root, 'home'),
    env: { TERMINAL: '1', ALLOWED_HOSTS: 'example.test' } });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const post = (u) => fetch(`${srv.base}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const r = await post('/api/term/calendar/today');
  assert.notEqual(r.status, 421);
  assert.equal(r.status, (await post('/api/term/search')).status);
  assert.equal((await fetch(`${srv.base}/api/me`)).status, 421);
});

test('calendar off: terminal routes answer the switched-off message', { timeout: 30000 }, async (t) => {
  const s = await ready(t, { calendar: false });
  const tm = await s.term();
  for (const cmd of ['today', 'list', 'add', 'delete', 'done']) {
    const r = await s.as(tm, cmd, {});
    assert.equal(r.status, 403, cmd);
    assert.equal(r.body.error, OFF);
  }
});

test('an entry an agent adds shows Added by in the browser range', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  const tm = await s.term();
  const a = await s.as(tm, 'add', { entry: { title: 'Stretch', date: 'today', start: '23:59' } }, { agentHint: ['bash', 'claude'] });
  assert.equal(a.status, 200, a.text);
  const r = await s.person('GET', '/api/calendar');
  const occ = r.body.occurrences.find((o) => o.entryId === a.body.entry.id);
  assert.deepEqual(occ.created.by, { kind: 'agent', agent: 'Claude Code' });
  const d = await s.as(tm, 'delete', { id: a.body.entry.id }, { agentHint: ['bash', 'agent'] });
  assert.deepEqual(d.body.entry.deletedBy, { kind: 'agent', agent: 'Cursor CLI' });
  const today = await s.as(tm, 'today');
  assert.equal(today.body.now.date, CC.todayIn('Europe/London', Date.now()));
});

const SKILL_SRC = path.join(__dirname, '..', 'skills', 'vaultos-calendar');
test('switching Calendar on writes the skill into ~/.claude/skills and ~/.agents/skills', { timeout: 30000 }, async (t) => {
  const s = await ready(t);
  for (const root of ['.claude', '.agents']) {
    for (const f of ['SKILL.md', 'reference.md']) {
      const dest = path.join(s.home, root, 'skills', 'vaultos-calendar', f);
      assert.ok(fs.existsSync(dest), dest);
      assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(path.join(SKILL_SRC, f), 'utf8'));
    }
  }
});

test('with Calendar off, or terminals not allowed, nothing is written', { timeout: 30000 }, async (t) => {
  const off = await ready(t, { calendar: false });
  assert.equal(fs.existsSync(path.join(off.home, '.claude', 'skills', 'vaultos-calendar')), false);
  const noTerm = await ready(t, { env: { TERMINAL: '0' } });
  assert.equal(fs.existsSync(path.join(noTerm.home, '.claude', 'skills', 'vaultos-calendar')), false);
  assert.equal(fs.existsSync(path.join(noTerm.home, '.agents', 'skills', 'vaultos-calendar')), false);
});
