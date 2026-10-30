'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/connectors');

test('stateChip covers the six states with the exact copy', () => {
  assert.deepEqual(C.stateChip('not-installed'), { text: 'Not installed', tone: 'plain' });
  assert.deepEqual(C.stateChip('not-connected'), { text: 'Not connected', tone: 'plain' });
  assert.deepEqual(C.stateChip('connecting'), { text: 'Connecting…', tone: 'plain' });
  assert.deepEqual(C.stateChip('connected'), { text: 'Connected', tone: 'ok' });
  assert.deepEqual(C.stateChip('needs-sign-in'), { text: 'Sign in again', tone: 'warn' });
  assert.deepEqual(C.stateChip('error'), { text: 'Error', tone: 'warn' });
});

test('agentChip tones', () => {
  assert.deepEqual(C.agentChip('Added'), { text: 'Added', tone: 'ok' });
  assert.deepEqual(C.agentChip('Has its own entry'), { text: 'Has its own entry', tone: 'warn' });
  assert.deepEqual(C.agentChip('Not installed'), { text: 'Not installed', tone: 'plain' });
  assert.deepEqual(C.agentChip('No connectors in Pi'), { text: 'No connectors in Pi', tone: 'plain' });
});

test('minutesLeft rounds up and stops at 0', () => {
  const now = 1_000_000;
  assert.equal(C.minutesLeft(now + 61_000, now), 2);
  assert.equal(C.minutesLeft(now + 60_000, now), 1);
  assert.equal(C.minutesLeft(now + 1, now), 1);
  assert.equal(C.minutesLeft(now, now), 0);
  assert.equal(C.minutesLeft(now - 5000, now), 0);
});

test('server text with markup is escaped in the rendered pane', () => {
  const evil = '<img src=x onerror=alert(1)>@example.com';
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'Jira', state: 'connected', method: 'token', account: evil, site: '<b>s</b>',
    lastTest: { ok: true, tools: 3, at: new Date().toISOString() }, agents: [{ id: 'cursor', label: '<i>C</i>', chip: 'Added', note: '<u>/x</u>' }] }], planned: [] };
  const html = C.paneHtml({ view, picked: 'atlassian' });
  assert.match(html, /Tested just now: Atlassian answered with 3 tools/);
  assert.doesNotMatch(html, /<img|<b>s|<i>C|<u>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;@example\.com/);
});

test('atlassianStep: a connected view clears the token form only on the way in', () => {
  const tok = { state: 'connected', method: 'token' };
  // already connected by token, same view again (focus refresh, Test again, a poll tick): nothing cleared
  assert.equal(C.atlassianStep({ waiting: false }, tok, tok).clear, false);
  // first connected view after not-connected clears; so does a changed method
  assert.equal(C.atlassianStep({ waiting: false }, { state: 'not-connected' }, tok).clear, true);
  assert.equal(C.atlassianStep({ waiting: false }, { state: 'connected', method: 'oauth' }, tok).clear, true);
});

test('atlassianStep: switching from a token sign-in keeps waiting until the method changes', () => {
  const st = { waiting: true, waitFrom: 'token' };
  const still = C.atlassianStep(st, { state: 'connected', method: 'token' }, { state: 'connected', method: 'token' });
  assert.deepEqual([still.waiting, still.poll], [true, true]);
  const done = C.atlassianStep(st, { state: 'connected', method: 'token' }, { state: 'connected', method: 'oauth' });
  assert.deepEqual([done.waiting, done.poll, done.clear], [false, false, true]);
  // a first sign-in ends as soon as it is connected
  assert.equal(C.atlassianStep({ waiting: true, waitFrom: null }, { state: 'connecting' }, { state: 'connected', method: 'oauth' }).waiting, false);
});

test('the waiting panel shows while this pane waits, even over a connected sign-in', () => {
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'x', state: 'connected', method: 'token', agents: [] }], planned: [] };
  const html = C.paneHtml({ view, picked: 'atlassian', waiting: true, options: { atlassian: true } });
  assert.match(html, /Waiting for you to approve in the Atlassian tab…/);
});

test('atlassianStep: a wait ends on any state but connecting (or the old method while switching)', () => {
  const first = { waiting: true, waitFrom: null };
  assert.equal(C.atlassianStep(first, { state: 'connecting' }, { state: 'connecting' }).waiting, true);
  assert.equal(C.atlassianStep(first, { state: 'connecting' }, { state: 'not-connected' }).waiting, false);
  const sw = { waiting: true, waitFrom: 'token' };
  const old = { state: 'connected', method: 'token' };
  assert.equal(C.atlassianStep(sw, old, old).waiting, true);
  assert.equal(C.atlassianStep(sw, old, { state: 'needs-sign-in', method: 'token' }).waiting, false);
  assert.equal(C.atlassianStep(sw, old, { state: 'error', method: 'token' }).waiting, false);
  assert.equal(C.atlassianStep(sw, old, { state: 'not-connected' }).waiting, false);
});

test('the 10-minute give-up clears the waiting panel', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const el = { addEventListener() {}, querySelector() { return null; }, contains() { return false; }, innerHTML: '' };
  const view = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'x', state: 'not-connected', agents: [] }], planned: [] };
  const w = { open: () => ({ location: {}, close() {} }) };
  let startView = view;
  const ui = {
    api: async (m, u) => (u === '/api/connectors/atlassian/start' ? { url: 'https://example.atlassian.net/x' } : startView),
    openTerm() {}, openTab: w.open,
  };
  const handlers = {};
  el.addEventListener = (n, f) => { handlers[n] = f; };
  const m = C.mountConnectors(el, ui);
  await m.refresh();
  const pane = { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'oauth' } } : null) };
  handlers.click({ target: pane });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(el.innerHTML, /Waiting for you to approve/);
  startView = { connectors: [{ ...view.connectors[0], state: 'connecting' }], planned: [] };
  t.mock.timers.tick(11 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.doesNotMatch(el.innerHTML, /Waiting for you to approve/);
});

// A switch or a list the person touched must not keep a value the server never applied.
function azurePane(api) {
  let renders = 0, html = '';
  const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false;  },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; renders++; } };
  const view = { connectors: [{ id: 'azure', label: 'Azure', by: 'x', state: 'connected', allowChanges: false, subscription: 's1',
    subscriptions: [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }], agents: [] }], planned: [] };
  const m = C.mountConnectors(el, { api: (method, url, body) => api(method, url, body, view), openTerm() {}, openTab() {} });
  return { el, handlers, m, renders: () => renders, html: () => html };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a failed Allow-changes request puts the switch back and says why', async () => {
  const p = azurePane(async (method, url, body, view) => { if (url.endsWith('/azure/settings')) throw new Error('Azure said no'); return view; });
  await p.m.refresh();
  p.handlers.change({ target: { id: 'cx-allow', checked: true } });
  await tick(); await tick();
  assert.doesNotMatch(p.html(), /id="cx-allow"[^>]*checked/);
  assert.match(p.html(), /Azure said no/);
  // The same error again must still redraw, or the old state would show.
  const before = p.renders();
  p.handlers.change({ target: { id: 'cx-allow', checked: true } });
  await tick(); await tick();
  assert.ok(p.renders() > before);
  assert.doesNotMatch(p.html(), /id="cx-allow"[^>]*checked/);
});

test('a change made while another request runs is redrawn from the server state', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = azurePane(async (method, url, body, view) => { if (url.endsWith('/azure/settings')) { await gate; return {}; } return view; });
  await p.m.refresh();
  p.handlers.change({ target: { id: 'cx-sub', value: 's2' } });
  await tick();
  const before = p.renders();
  p.handlers.change({ target: { id: 'cx-allow', checked: true } }); // busy: the request is never sent
  await tick(); await tick();
  assert.ok(p.renders() > before, 'forced redraw');
  assert.doesNotMatch(p.html(), /id="cx-allow"[^>]*checked/);
  release(); await tick();
});

test('the approve address is opened only when it is https, or http on this machine', () => {
  assert.equal(C.signInUrl('https://auth.example.com/authorize?x=1'), 'https://auth.example.com/authorize?x=1');
  assert.ok(C.signInUrl('http://127.0.0.1:5555/v1/authorize'));
  assert.ok(C.signInUrl('http://localhost:5555/a'));
  for (const bad of ['http://auth.example.com/a', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '', undefined]) assert.equal(C.signInUrl(bad), null, String(bad));
});

test('the switch note says what read-only does and does not cover', () => {
  const html = C.paneHtml({ view: { connectors: [{ id: 'azure', label: 'Azure', by: 'x', state: 'connected', subscriptions: [], agents: [] }], planned: [] }, picked: 'azure' });
  assert.match(html, /Azure&#39;s tools for agents are read-only unless you allow changes\. Agents that can run shell commands can still use az with this sign-in\./);
});

test('a poll tick is skipped while the last poll is still in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let gets = 0; const waiters = [];
  const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; }, innerHTML: '' };
  const connecting = { connectors: [{ id: 'atlassian', label: 'Atlassian', by: 'x', state: 'connecting', agents: [] }], planned: [] };
  const m = C.mountConnectors(el, { api: (method, url) => { gets++; return new Promise((r) => waiters.push(() => r(connecting))); }, openTerm() {}, openTab() {} });
  const first = m.refresh();
  waiters.shift()(); await first;
  const base = gets;
  t.mock.timers.tick(2000); // poll 1: never answers yet
  t.mock.timers.tick(2000); t.mock.timers.tick(2000); // slow server: these ticks must not stack requests
  assert.equal(gets - base, 1);
  waiters.shift()(); await tick(); await tick();
  t.mock.timers.tick(2000);
  assert.equal(gets - base, 2);
  m.stop();
});

const FOUR = [
  { id: 'atlassian', label: 'Atlassian', by: 'Jira', state: 'not-connected', agents: [] },
  { id: 'azure', label: 'Azure', by: 'az', state: 'not-connected', agents: [] },
  { id: 'entra', label: 'Microsoft Entra', by: 'Users · groups · apps · sign-in logs', state: 'not-connected', agents: [] },
  { id: 'github', label: 'GitHub', by: 'Repos · issues · pull requests', state: 'not-connected', tokenHelp: 'https://github.com/settings/personal-access-tokens/new', agents: [] },
  { id: 'mslearn', label: 'Microsoft Learn', by: 'Microsoft docs and code samples', state: 'not-connected', agents: [] },
];
const PLANNED5 = ['notion', 'homeassistant', 'n8n', 'linear', 'sentry'].map((id) => ({ id, label: id, by: 'x', mono: id[0].toUpperCase() }));
const withRow = (id, over) => ({ connectors: FOUR.map((c) => (c.id === id ? { ...c, ...over } : c)), planned: PLANNED5 });

test('paneHtml shows five Ready tiles and five Planned', () => {
  const html = C.paneHtml({ view: { connectors: FOUR, planned: PLANNED5 } });
  assert.equal((html.match(/class="ap-tile cx-tile" data-id=/g) || []).length, 5);
  assert.equal((html.match(/cx-later/g) || []).length, 5);
  for (const n of ['Atlassian', 'Azure', 'Microsoft Entra', 'GitHub', 'Microsoft Learn']) assert.ok(html.includes(`>${n}</span>`));
});

test('github not connected shows the token card copy and a password input', () => {
  const html = C.paneHtml({ view: withRow('github', {}), picked: 'github' });
  assert.match(html, /Paste a GitHub token/);
  assert.match(html, /Create a token on GitHub and paste it here\. VaultOS checks it with GitHub before saving it\. Agents can do what the token allows, so a fine-grained token limited to the repos you choose keeps it tight\./);
  assert.match(html, /<label for="cx-gh-token">Personal access token<\/label>/);
  assert.match(html, /id="cx-gh-token"[^>]*type="password"|type="password"[^>]*id="cx-gh-token"/);
  assert.match(html, /data-act="gh-token"[^>]*>Save token</);
  assert.match(html, /href="https:\/\/github\.com\/settings\/personal-access-tokens\/new"[^>]*>Create a token</);
});

test('github connected shows Signed in as, Replace token, Sign out and the sign-out note', () => {
  const row = { state: 'connected', method: 'token', account: 'alex-example', lastTest: { ok: true, tools: 41, at: new Date().toISOString() },
    agents: [{ id: 'claude', label: 'Claude Code', chip: 'Added' }] };
  const html = C.paneHtml({ view: withRow('github', row), picked: 'github' });
  assert.match(html, /Signed in as alex-example/);
  assert.match(html, /Tested just now: GitHub answered with 41 tools/);
  assert.match(html, /Claude Code/);
  for (const a of ['test', 'gh-replace', 'disconnect']) assert.match(html, new RegExp(`data-act="${a}"`));
  assert.match(html, />Test again</); assert.match(html, />Replace token</); assert.match(html, />Sign out</);
  assert.match(html, /Signing out here doesn't delete the token on GitHub\./);
  assert.doesNotMatch(html, /cx-gh-token/);
  const replacing = C.paneHtml({ view: withRow('github', row), picked: 'github', options: { github: true } });
  assert.match(replacing, /cx-gh-token/);
  assert.match(replacing, /data-act="gh-keep"[^>]*>Keep my current token</);
});

test('mslearn not connected shows Turn on; connected shows Connected · 3 tools and Turn off', () => {
  const off = C.paneHtml({ view: withRow('mslearn', {}), picked: 'mslearn' });
  assert.match(off, /Microsoft's documentation and code samples\. No sign-in\./);
  assert.match(off, /data-act="ms-on"[^>]*>Turn on</);
  const on = C.paneHtml({ view: withRow('mslearn', { state: 'connected', lastTest: { ok: true, tools: 3, at: new Date().toISOString() },
    agents: [{ id: 'cursor', label: 'Cursor CLI', chip: 'Added' }] }), picked: 'mslearn' });
  assert.match(on, /Connected · 3 tools/);
  assert.match(on, /Cursor CLI/);
  assert.match(on, /data-act="test"/);
  assert.match(on, /data-act="ms-off"[^>]*>Turn off</);
  assert.doesNotMatch(on, /data-act="ms-on"/);
});

test('markup in a github login is escaped', () => {
  const html = C.paneHtml({ view: withRow('github', { state: 'connected', account: '<img src=x onerror=1>', agents: [{ id: 'claude', label: '<b>x</b>', chip: 'Added' }] }), picked: 'github' });
  assert.doesNotMatch(html, /<img|<b>x/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test('github save posts the trimmed token', async () => {
  const calls = [];
  let view = withRow('github', {});
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const ui = { api: async (m, u, b) => { calls.push([m, u, b]); return m === 'GET' ? view : {}; } };
  const pane = C.mountConnectors(el, ui);
  await pane.refresh();
  els.input({ target: { id: 'cx-gh-token', value: '  ghp_abc\n' } });
  await els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'gh-token' } } : null) } });
  assert.deepEqual(calls.find((c) => c[0] === 'POST'), ['POST', '/api/connectors/github/token', { token: 'ghp_abc' }]);
  pane.stop();
});

test('mslearn buttons hit enable and disconnect', async () => {
  const calls = [];
  let view = withRow('mslearn', {});
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const ui = { api: async (m, u, b) => { calls.push([m, u]); return m === 'GET' ? view : {}; } };
  const pane = C.mountConnectors(el, ui);
  await pane.refresh();
  const click = (act) => els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act } } : null) } });
  await click('ms-on'); await new Promise((r) => setTimeout(r, 20));
  await click('ms-off');
  assert.deepEqual(calls.filter((c) => c[0] === 'POST'), [['POST', '/api/connectors/mslearn/enable'], ['POST', '/api/connectors/mslearn/disconnect']]);
  pane.stop();
});

test('github needs-sign-in keeps the token card and offers Test again, Sign out, agent rows and the note', () => {
  const html = C.paneHtml({ view: withRow('github', { state: 'needs-sign-in', agents: [{ id: 'claude', label: 'Claude Code', chip: 'Added' }] }), picked: 'github' });
  assert.match(html, /GitHub no longer accepts your token/);
  assert.match(html, /data-act="gh-token"/);
  assert.match(html, /data-act="test"[^>]*>Test again</);
  assert.match(html, /data-act="disconnect"[^>]*>Sign out</);
  assert.match(html, /Claude Code/);
  assert.match(html, /Signing out here doesn't delete the token on GitHub\./);
});

test('atlassian needs-sign-in offers Sign out', () => {
  const html = C.paneHtml({ view: withRow('atlassian', { state: 'needs-sign-in' }), picked: 'atlassian' });
  assert.match(html, /data-act="disconnect"[^>]*>Sign out</);
});

test('entra: needs Azure first (no Turn on), then Turn on, then Connected with the read-only line and Turn off', () => {
  const gated = C.paneHtml({ view: withRow('entra', { needsAzure: true }), picked: 'entra' });
  assert.match(gated, /Connect Azure first/);
  assert.doesNotMatch(gated, /data-act="en-on"/);
  const off = C.paneHtml({ view: withRow('entra', {}), picked: 'entra' });
  assert.match(off, /data-act="en-on"[^>]*>Turn on</);
  const on = C.paneHtml({ view: withRow('entra', { state: 'connected', account: '<b>Acme</b>', lastTest: { ok: true, tools: 2, at: new Date().toISOString() },
    agents: [{ id: 'cursor', label: 'Cursor CLI', chip: 'Added' }] }), picked: 'entra' });
  assert.match(on, /Connected to &lt;b&gt;Acme&lt;\/b&gt; · 2 tools/);
  assert.match(on, /Read-only/);
  assert.match(on, /data-act="en-off"[^>]*>Turn off</);
  assert.doesNotMatch(on, /data-act="en-on"/);
});

test('entra buttons hit enable and disconnect', async () => {
  const calls = [];
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const ui = { api: async (m, u) => { calls.push([m, u]); return m === 'GET' ? withRow('entra', {}) : {}; } };
  const pane = C.mountConnectors(el, ui);
  await pane.refresh();
  const click = (act) => els.click({ target: { closest: (x) => (x === '[data-act]' ? { dataset: { act } } : null) } });
  await click('en-on'); await new Promise((r) => setTimeout(r, 20));
  await click('en-off');
  assert.deepEqual(calls.filter((c) => c[0] === 'POST'), [['POST', '/api/connectors/entra/enable'], ['POST', '/api/connectors/entra/disconnect']]);
  pane.stop();
});
