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

// ----- Context7 -----
const C7 = { id: 'context7', label: 'Context7', by: 'Current docs for code libraries', state: 'not-connected', tokenHelp: 'https://context7.com/dashboard', agents: [] };
const withC7 = (over) => ({ connectors: [...FOUR, { ...C7, ...over }], planned: PLANNED5 });

test('context7 not connected shows the key card, a password input and the dashboard link', () => {
  const html = C.paneHtml({ view: withC7({}), picked: 'context7' });
  assert.match(html, /Paste a Context7 API key/);
  assert.match(html, /<label for="cx-c7-key">API key<\/label>/);
  assert.match(html, /id="cx-c7-key"[^>]*type="password"/);
  assert.match(html, /data-act="c7-token"[^>]*>Save key</);
  assert.match(html, /href="https:\/\/context7\.com\/dashboard"[^>]*>Get a key</);
  assert.doesNotMatch(html, /cx-gh-token/);
});

test('context7 connected shows the tool count, Replace key and the sign-out note; replacing shows the card', () => {
  const row = { state: 'connected', method: 'token', lastTest: { ok: true, tools: 2, at: new Date().toISOString() }, agents: [{ id: 'claude', label: 'Claude Code', chip: 'Added' }] };
  const html = C.paneHtml({ view: withC7(row), picked: 'context7' });
  assert.match(html, /Connected with an API key/);
  assert.match(html, /Context7 answered with 2 tools/);
  assert.match(html, /data-act="c7-replace"[^>]*>Replace key</);
  assert.match(html, /Signing out here doesn't delete the key on Context7\./);
  const replacing = C.paneHtml({ view: withC7(row), picked: 'context7', options: { context7: true } });
  assert.match(replacing, /data-act="c7-keep"[^>]*>Keep my current key</);
});

test('context7 needs-sign-in says the key stopped working', () => {
  const html = C.paneHtml({ view: withC7({ state: 'needs-sign-in' }), picked: 'context7' });
  assert.match(html, /Context7 no longer accepts your key\. Paste a new one\./);
  assert.match(html, /data-act="test"/);
});

test('context7 save posts the trimmed key; Enter in the field saves too; an empty field is refused', async () => {
  const calls = [];
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const ui = { api: async (m, u, b) => { calls.push([m, u, b]); return m === 'GET' ? withC7({}) : {}; } };
  const pane = C.mountConnectors(el, ui);
  await pane.refresh();
  await els.click({ target: { closest: (s) => (s === '.cx-ready .ap-tile' ? { dataset: { id: 'context7' } } : null) } });
  await els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'c7-token' } } : null) } });
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 0);
  assert.match(el.innerHTML, /Paste the Context7 API key first\./);
  els.input({ target: { id: 'cx-c7-key', value: '  ctx7sk-abc\n' } });
  await els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'c7-token' } } : null) } });
  assert.deepEqual(calls.find((c) => c[0] === 'POST'), ['POST', '/api/connectors/context7/token', { token: 'ctx7sk-abc' }]);
  pane.stop();
});

// ----- Azure DevOps -----
const adoView = (c) => ({ connectors: [{ id: 'azuredevops', label: 'Azure DevOps', by: 'x', agents: [], ...c }], planned: [] });

test('azure devops: needs Azure first, then asks for the organization', () => {
  const gate = C.paneHtml({ view: adoView({ state: 'not-connected', needsAzure: true }), picked: 'azuredevops' });
  assert.match(gate, /Connect Azure first/);
  assert.doesNotMatch(gate, /cx-ado-org/);
  const form = C.paneHtml({ view: adoView({ state: 'not-connected', org: 'old<b>' }), picked: 'azuredevops' });
  assert.match(form, /id="cx-ado-org"[^>]*value="old&lt;b&gt;"/);
  assert.match(form, /data-act="ado-on"[^>]*>Turn on</);
});

test('azure devops: not installed offers the install', () => {
  const html = C.paneHtml({ view: adoView({ state: 'not-installed', install: 'npm install -g --prefix ~/.local @azure-devops/mcp@2.11.0' }), picked: 'azuredevops' });
  assert.match(html, /@azure-devops\/mcp@2\.11\.0/);
  assert.match(html, /data-act="install"/);
});

test('azure devops: connected shows the organization, the test, read-only and the switch', () => {
  const view = adoView({ state: 'connected', org: 'contoso', allowChanges: false, lastTest: { ok: true, tools: 29, projects: 1, at: new Date(1000).toISOString() } });
  const html = C.paneHtml({ view, picked: 'azuredevops' }, 1000);
  assert.match(html, /Organization: contoso/);
  assert.match(html, /Tested just now: 29 tools, 1 project</);
  assert.match(html, /Read-only: agents can look things up/);
  assert.match(html, /id="cx-ado-allow"(?![^>]*checked)/);
  assert.match(html, /data-act="ado-change"/);
  const on = C.paneHtml({ view: adoView({ state: 'connected', org: 'contoso', allowChanges: true }), picked: 'azuredevops' });
  assert.match(on, /id="cx-ado-allow"[^>]*checked/);
  assert.match(on, /Agents can make changes/);
  const change = C.paneHtml({ view, picked: 'azuredevops', options: { azuredevops: true } });
  assert.match(change, /data-act="ado-keep"[^>]*>Keep contoso</);
});

// ---- Teams transcripts card ----
const TR_T = '11111111-2222-3333-4444-555555555555', TR_C = '66666666-7777-8888-9999-000000000000';
const trView = (c) => ({ connectors: [{ id: 'transcripts', label: 'Teams transcripts', by: 'Meeting transcripts from an app you register', state: 'not-connected', agents: [], ...c }], planned: [] });

test('transcripts: signed out shows the two IDs, the registration needs and Sign in', () => {
  const html = C.paneHtml({ view: trView({ tenantId: TR_T, clientId: TR_C }), picked: 'transcripts' });
  assert.match(html, /id="tr-tenant"[^>]*value="11111111-2222-3333-4444-555555555555"/);
  assert.match(html, /id="tr-client"[^>]*value="66666666-7777-8888-9999-000000000000"/);
  assert.match(html, /<details[^>]*>[\s\S]*What the app registration needs/);
  for (const s of ['OnlineMeetingTranscript.Read.All', 'OnlineMeetings.Read', 'Calendars.Read', 'User.Read']) assert.ok(html.includes(s), s);
  assert.match(html, /public client flows/);
  assert.match(html, /admin consent/);
  assert.match(html, /data-act="tr-start"[^>]*>Sign in</);
});

test('transcripts: connecting with a code reuses the code panel', () => {
  const html = C.paneHtml({ view: trView({ state: 'connecting' }), picked: 'transcripts', transcripts: { url: 'https://microsoft.com/devicelogin', code: 'ABCD1234', expiresAt: 10 * 60 * 1000 } }, 0);
  assert.match(html, /ABCD1234/);
  assert.match(html, /Copy code/);
  assert.match(html, /href="https:\/\/microsoft\.com\/devicelogin"/);
  assert.match(html, /data-act="tr-cancel"[^>]*>Cancel</);
  assert.doesNotMatch(html, /azure-cancel/);
  assert.doesNotMatch(html, /id="tr-tenant"/);
});

test('transcripts: connected shows the account, Test, Sign out and agents, no inputs', () => {
  const html = C.paneHtml({ view: trView({ state: 'connected', account: 'alex@example.com', agents: [{ id: 'claude', label: 'Claude Code', chip: 'Added' }] }), picked: 'transcripts' });
  assert.match(html, /Signed in as alex@example\.com/);
  assert.match(html, /data-act="test"/);
  assert.match(html, /data-act="disconnect"[^>]*>Sign out</);
  assert.match(html, /Claude Code/);
  assert.doesNotMatch(html, /id="tr-tenant"/);
});

test('transcripts: needs sign-in offers Sign in again with the IDs kept', () => {
  const html = C.paneHtml({ view: trView({ state: 'needs-sign-in', tenantId: TR_T, clientId: TR_C }), picked: 'transcripts' });
  assert.match(html, /data-act="tr-start"[^>]*>Sign in again</);
  assert.match(html, /value="11111111-2222-3333-4444-555555555555"/);
});

test('transcripts: server text is escaped', () => {
  const a = C.paneHtml({ view: trView({ state: 'connected', account: '<img src=x>', error: '<b>x</b>' }), picked: 'transcripts' });
  assert.doesNotMatch(a, /<img src=x>|<b>x<\/b>/);
  assert.match(a, /&lt;img src=x&gt;/);
  const b = C.paneHtml({ view: trView({ tenantId: '"><i>', error: '<b>x</b>' }), picked: 'transcripts' });
  assert.doesNotMatch(b, /<i>|<b>x<\/b>/);
});

test('transcripts: Sign in posts the two IDs and shows the code', async () => {
  const calls = []; let status = 'waiting', state = 'not-connected';
  let html = ''; const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.endsWith('/transcripts/start')) { state = 'connecting'; return { url: 'https://microsoft.com/devicelogin', code: 'WXYZ9876', expiresAt: Date.now() + 600000 }; }
    if (url.endsWith('/transcripts/status')) { if (status === 'done') state = 'connected'; return { status }; }
    return trView({ state, account: 'alex@example.com' });
  }, openTerm() {}, openTab() {} });
  await m.refresh();
  handlers.input({ target: { id: 'tr-tenant', value: TR_T } });
  handlers.input({ target: { id: 'tr-client', value: TR_C } });
  handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'tr-start' } } : null) } });
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.find((c) => c[1].endsWith('/transcripts/start')), ['POST', '/api/connectors/transcripts/start', { tenantId: TR_T, clientId: TR_C }]);
  assert.match(html, /WXYZ9876/);
  m.stop && m.stop();
});

test('transcripts: Cancel posts to the cancel route', async () => {
  const calls = []; let html = ''; const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url) => { calls.push([method, url]); return trView({}); }, openTerm() {}, openTab() {} });
  await m.refresh();
  handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'tr-cancel' } } : null) } });
  await tick(); await tick();
  assert.ok(calls.some((c) => c[0] === 'POST' && c[1] === '/api/connectors/transcripts/cancel'));
});

// A mounted pane whose fake server answers the transcripts routes; `srv` holds what the server says.
function trPane(srv) {
  const calls = []; let html = ''; const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.endsWith('/transcripts/start')) { srv.onStart && srv.onStart(); return { url: 'https://microsoft.com/devicelogin', code: 'WXYZ9876', expiresAt: Date.now() + 600000 }; }
    if (url.endsWith('/transcripts/status')) { srv.onStatus && srv.onStatus(); return { status: srv.status, ...(srv.error ? { error: srv.error } : {}) }; }
    return trView(srv.row);
  }, openTerm() {}, openTab() {} });
  const act = (a) => handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: a } } : null) } });
  return { m, calls, handlers, act, html: () => html };
}

test('transcripts: Sign in again from needs-sign-in shows the code once the server says connecting', async () => {
  const srv = { row: { state: 'needs-sign-in', tenantId: TR_T, clientId: TR_C }, status: 'waiting' };
  srv.onStart = () => { srv.row = { ...srv.row, state: 'connecting' }; };
  const p = trPane(srv);
  await p.m.refresh();
  assert.match(p.html(), /data-act="tr-start"[^>]*>Sign in again</);
  p.act('tr-start');
  await tick(); await tick(); await tick();
  assert.deepEqual(p.calls.find((c) => c[1].endsWith('/transcripts/start'))[2], { tenantId: TR_T, clientId: TR_C });
  assert.match(p.html(), /WXYZ9876/);
  assert.doesNotMatch(p.html(), /id="tr-tenant"/);
  p.m.stop && p.m.stop();
});

test('transcripts: a failed first sign-in keeps the typed IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const srv = { row: { state: 'not-connected' }, status: 'waiting' };
  srv.onStart = () => { srv.row = { state: 'connecting' }; };
  const p = trPane(srv);
  await p.m.refresh();
  p.handlers.input({ target: { id: 'tr-tenant', value: TR_T } });
  p.handlers.input({ target: { id: 'tr-client', value: TR_C } });
  p.act('tr-start');
  await tick(); await tick(); await tick();
  assert.match(p.html(), /WXYZ9876/);
  srv.status = 'failed'; srv.error = 'AADSTS50126: The user declined the sign-in.';
  srv.row = { state: 'not-connected', error: srv.error };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(p.html().split('declined the sign-in').length - 1, 1, 'the reason is shown once');
  assert.match(p.html(), /id="tr-tenant"[^>]*value="11111111-2222-3333-4444-555555555555"/);
  assert.match(p.html(), /id="tr-client"[^>]*value="66666666-7777-8888-9999-000000000000"/);
  p.m.stop && p.m.stop();
});

test('transcripts: a finished sign-in clears the typed IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const srv = { row: { state: 'not-connected' }, status: 'waiting' };
  srv.onStart = () => { srv.row = { state: 'connecting' }; };
  const p = trPane(srv);
  await p.m.refresh();
  p.handlers.input({ target: { id: 'tr-tenant', value: TR_T } });
  p.handlers.input({ target: { id: 'tr-client', value: TR_C } });
  p.act('tr-start');
  await tick(); await tick(); await tick();
  srv.status = 'done'; srv.row = { state: 'connected', account: 'alex@example.com', tenantId: TR_T, clientId: TR_C };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await tick();
  assert.match(p.html(), /Signed in as alex@example\.com/);
  // signed out later: the form shows the saved IDs, not leftovers typed before
  srv.row = { state: 'not-connected', tenantId: '22222222-2222-3333-4444-555555555555', clientId: TR_C };
  await p.m.refresh();
  assert.match(p.html(), /id="tr-tenant"[^>]*value="22222222-2222-3333-4444-555555555555"/);
  p.m.stop && p.m.stop();
});

// ----- LogicMonitor -----
const LMROW = { id: 'logicmonitor', label: 'LogicMonitor', by: 'Alerts · devices · metrics', state: 'not-connected', tokenHelp: 'https://www.logicmonitor.com/support/bearer-token', agents: [] };
const withLm = (over) => ({ connectors: [...FOUR, { ...LMROW, ...over }], planned: PLANNED5 });
const LM_BLURB = 'VaultOS checks it with LogicMonitor before saving it. Agents can only read: alerts, devices and their metrics, and scheduled downtime. A token on an API-only user with a read-only role keeps it tight.';
const LM_NOTE = /Signing out here doesn(&#39;|')t delete the token in LogicMonitor\./;

function mountLm(viewFn) {
  const calls = [];
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const ui = { api: async (m, u, b) => { calls.push([m, u, b]); return m === 'GET' ? viewFn() : {}; } };
  const pane = C.mountConnectors(el, ui);
  // The pane's click handler doesn't return the action's promise: wait for a save to settle before the next click.
  const click = async (act) => { els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act } } : null) } }); await new Promise((r) => setTimeout(r, 20)); };
  const pick = () => els.click({ target: { closest: (s) => (s === '.cx-ready .ap-tile' ? { dataset: { id: 'logicmonitor' } } : null) } });
  const type = (id, value) => els.input({ target: { id, value } });
  const posts = () => calls.filter((c) => c[0] === 'POST');
  return { pane, el, els, click, pick, type, posts };
}

test('logicmonitor not connected shows portal and token fields, the blurb and Get a token', () => {
  const html = C.paneHtml({ view: withLm({}), picked: 'logicmonitor' });
  assert.match(html, /id="cx-lm-portal"[^>]*placeholder="acme or acme\.logicmonitor\.com"/);
  assert.match(html, /id="cx-lm-token"[^>]*type="password"/);
  assert.ok(html.includes(LM_BLURB));
  assert.match(html, /href="https:\/\/www\.logicmonitor\.com\/support\/bearer-token"[^>]*>Get a token</);
  assert.match(html, /data-act="lm-keys"/);
  assert.doesNotMatch(html, /cx-lm-id/);
});

test('the access-ID switch swaps the token field for ID and key, and back', async () => {
  const keys = C.paneHtml({ view: withLm({}), picked: 'logicmonitor', options: { lmKeys: true } });
  assert.match(keys, /id="cx-lm-id"/);
  assert.match(keys, /id="cx-lm-key"[^>]*type="password"/);
  assert.doesNotMatch(keys, /cx-lm-token/);
  assert.match(keys, /data-act="lm-bearer"/);
  const m = mountLm(() => withLm({}));
  await m.pane.refresh();
  await m.pick();
  await m.click('lm-keys');
  assert.match(m.el.innerHTML, /id="cx-lm-id"/);
  await m.click('lm-bearer');
  assert.match(m.el.innerHTML, /id="cx-lm-token"/);
  m.pane.stop();
});

test('logicmonitor save posts portal and token; keys mode posts ID and key; empty fields are refused; Enter saves', async () => {
  const m = mountLm(() => withLm({}));
  await m.pane.refresh();
  await m.pick();
  await m.click('lm-save');
  assert.equal(m.posts().length, 0);
  assert.match(m.el.innerHTML, /Enter the LogicMonitor portal name first\./);
  m.type('cx-lm-portal', ' acme ');
  await m.click('lm-save');
  assert.equal(m.posts().length, 0);
  assert.match(m.el.innerHTML, /Paste the LogicMonitor bearer token first\./);
  m.type('cx-lm-token', '  lmb_x\n');
  await m.click('lm-save');
  assert.deepEqual(m.posts()[0], ['POST', '/api/connectors/logicmonitor/token', { portal: 'acme', token: 'lmb_x' }]);
  await m.click('lm-keys');
  m.type('cx-lm-portal', 'acme');
  await m.click('lm-save');
  assert.equal(m.posts().length, 1);
  assert.match(m.el.innerHTML, /Paste the access ID and key first\./);
  m.type('cx-lm-id', 'id1');
  m.type('cx-lm-key', ' k1 ');
  m.els.keydown({ key: 'Enter', preventDefault() {}, target: { id: 'cx-lm-key', closest: () => null } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m.posts()[1], ['POST', '/api/connectors/logicmonitor/token', { portal: 'acme', accessId: 'id1', accessKey: 'k1' }]);
  m.pane.stop();
});

test('logicmonitor connected shows the portal, the test and the buttons', () => {
  const at = new Date(1000).toISOString();
  const html = C.paneHtml({ view: withLm({ state: 'connected', method: 'token', account: 'acme.logicmonitor.com', portal: 'acme', lastTest: { ok: true, tools: 2, at } }), picked: 'logicmonitor' }, 1000);
  assert.match(html, /Connected to acme\.logicmonitor\.com/);
  assert.match(html, /Signed in with a bearer token/);
  assert.match(html, /Tested just now: LogicMonitor answered with 2 tools/);
  for (const a of ['test', 'lm-replace', 'disconnect']) assert.match(html, new RegExp(`data-act="${a}"`));
  assert.match(html, />Replace token</);
  assert.match(html, LM_NOTE);
  assert.doesNotMatch(html, /cx-lm-token/);
  const keys = C.paneHtml({ view: withLm({ state: 'connected', account: 'acme.logicmonitor.com', portal: 'acme', lmv1: true }), picked: 'logicmonitor' });
  assert.match(keys, /Signed in with an access ID and key/);
});

test('replacing prefills the portal, and saving only a new token keeps it', async () => {
  const row = { state: 'connected', method: 'token', account: 'acme.logicmonitor.com', portal: 'acme' };
  const html = C.paneHtml({ view: withLm(row), picked: 'logicmonitor', options: { logicmonitor: true } });
  assert.match(html, /id="cx-lm-portal"[^>]*value="acme"/);
  assert.match(html, /data-act="lm-keep"/);
  const m = mountLm(() => withLm(row));
  await m.pane.refresh();
  await m.pick();
  await m.click('lm-replace');
  m.type('cx-lm-token', 'lmb_new');
  await m.click('lm-save');
  assert.deepEqual(m.posts()[0], ['POST', '/api/connectors/logicmonitor/token', { portal: 'acme', token: 'lmb_new' }]);
  m.pane.stop();
});

test('logicmonitor needs-sign-in says the token stopped working and offers the card, Test again, Sign out and agent rows', () => {
  const html = C.paneHtml({ view: withLm({ state: 'needs-sign-in', account: 'acme.logicmonitor.com', portal: 'acme', agents: [{ id: 'cursor', label: 'Cursor CLI', chip: 'Added' }] }), picked: 'logicmonitor' });
  assert.match(html, /LogicMonitor no longer accepts this token\. Paste a new one\./);
  assert.match(html, /id="cx-lm-token"/);
  assert.match(html, /id="cx-lm-portal"[^>]*value="acme"/);
  assert.match(html, /data-act="test"/);
  assert.match(html, /data-act="disconnect"/);
  assert.match(html, /Cursor CLI/);
  assert.match(html, LM_NOTE);
});

test('markup in the LogicMonitor portal or account is escaped', () => {
  const evil = { state: 'connected', account: '<b>x</b>.logicmonitor.com', portal: '"><i>p' };
  const shown = C.paneHtml({ view: withLm(evil), picked: 'logicmonitor' });
  const replacing = C.paneHtml({ view: withLm(evil), picked: 'logicmonitor', options: { logicmonitor: true } });
  for (const h of [shown, replacing]) assert.doesNotMatch(h, /<b>x|"><i>p/);
  assert.match(shown, /Connected to &lt;b&gt;x&lt;\/b&gt;\.logicmonitor\.com/);
  assert.match(replacing, /id="cx-lm-portal"[^>]*value="&quot;&gt;&lt;i&gt;p"/);
});

// ----- Vantage -----
const VTROW = { id: 'vantage', label: 'Vantage', by: 'Cloud costs · reports · budgets', state: 'not-connected', tokenHelp: 'https://docs.vantage.sh/api/authentication', allowChanges: false, agents: [] };
const ATLROW = { id: 'atlassian', label: 'Atlassian', by: 'Jira', state: 'not-connected', agents: [] };
const withVt = (over) => ({ connectors: [ATLROW, { ...VTROW, ...over }], planned: [] });
const VT_FACTS = 'Cloud costs, cost reports, budgets and anomalies from your Vantage account. Read-only unless you allow changes.';
const VT_NOTE = "Agents can only read Vantage unless you allow changes. With changes on they can create, change and delete reports, budgets and folders, and some deletes can't be undone. Applies to agents' next requests.";
const VT_BLURB = "VaultOS checks it with Vantage before saving it. A token with only the Read scope keeps agents read-only on Vantage's side too.";
const plain = (html) => html.replace(/&#39;/g, "'");

function mountVt(viewFn, extra = {}) {
  const calls = [];
  const els = {};
  const el = { innerHTML: '', addEventListener(t, f) { els[t] = f; }, contains: () => false, querySelector: () => null };
  const tab = { location: {}, close() {} };
  const ui = { api: async (m, u, b) => { calls.push([m, u, b]); return m === 'GET' ? viewFn() : (u.endsWith('/start') ? { url: 'https://mcp.vantage.sh/authorize?x=1' } : {}); },
    openTerm() {}, openTab: () => tab, ...extra };
  const pane = C.mountConnectors(el, ui);
  const click = async (act) => { els.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act } } : null) } }); await new Promise((r) => setTimeout(r, 20)); };
  const pick = () => els.click({ target: { closest: (s) => (s === '.cx-ready .ap-tile' ? { dataset: { id: 'vantage' } } : null) } });
  const posts = () => calls.filter((c) => c[0] === 'POST');
  return { pane, el, els, click, pick, posts, tab };
}

test('vantage not connected shows the facts, Sign in and the token option', async () => {
  const html = plain(C.paneHtml({ view: withVt({}), picked: 'vantage' }));
  assert.ok(html.includes(VT_FACTS));
  assert.match(html, /data-act="oauth"[^>]*>Sign in</);
  assert.match(html, /data-act="vt-switch"/);
  assert.doesNotMatch(html, /cx-vt-key/);
  const m = mountVt(() => withVt({}));
  await m.pane.refresh();
  await m.pick();
  await m.click('vt-switch');
  assert.match(m.el.innerHTML, /id="cx-vt-key"[^>]*type="password"/);
  assert.ok(plain(m.el.innerHTML).includes(VT_BLURB));
  m.pane.stop();
});

test('the vantage waiting panel shows only for vantage', () => {
  const vt = C.paneHtml({ view: withVt({}), picked: 'vantage', waiting: true, waitingFor: 'vantage' });
  assert.match(vt, /Finish signing in to Vantage in the tab that opened\./);
  const atl = C.paneHtml({ view: withVt({}), picked: 'atlassian', waiting: true, waitingFor: 'vantage' });
  assert.doesNotMatch(atl, /Waiting for you to approve/);
  const legacy = C.paneHtml({ view: withVt({}), picked: 'atlassian', waiting: true });
  assert.match(legacy, /Waiting for you to approve in the Atlassian tab/);
});

test('Sign in posts vantage/start and opens the tab; Cancel posts vantage/cancel', async () => {
  const m = mountVt(() => withVt({}));
  await m.pane.refresh();
  await m.pick();
  await m.click('oauth');
  assert.deepEqual(m.posts()[0].slice(0, 2), ['POST', '/api/connectors/vantage/start']);
  assert.equal(m.tab.location.href, 'https://mcp.vantage.sh/authorize?x=1');
  assert.match(m.el.innerHTML, /Finish signing in to Vantage/);
  await m.click('cancel');
  assert.deepEqual(m.posts()[1].slice(0, 2), ['POST', '/api/connectors/vantage/cancel']);
  m.pane.stop();
});

test('vantage connected shows the account, tools, the switch and the right sign-out note', () => {
  const at = new Date(1000).toISOString();
  const row = { state: 'connected', method: 'oauth', account: 'alex@example.com · Main', lastTest: { ok: true, tools: 3, at } };
  const html = plain(C.paneHtml({ view: withVt(row), picked: 'vantage' }, 1000));
  assert.match(html, /Signed in as alex@example\.com · Main/);
  assert.match(html, /Tested just now: Vantage answered with 3 tools/);
  assert.match(html, /<input type="checkbox" id="cx-vt-allow"[^>]*role="switch">/);
  assert.ok(html.includes(VT_NOTE));
  for (const t of ['Test again', 'Use an API token instead', 'Sign out']) assert.ok(html.includes(`>${t}<`), t);
  assert.ok(html.includes("Signing out here revokes VaultOS's sign-in at Vantage."));
  const tok = plain(C.paneHtml({ view: withVt({ ...row, method: 'token', allowChanges: true }), picked: 'vantage' }, 1000));
  assert.match(tok, />Sign in instead</);
  assert.match(tok, /id="cx-vt-allow"[^>]* checked/);
  assert.ok(tok.includes("Signing out here doesn't delete the token in Vantage."));
});

test('the vantage switch posts the setting', async () => {
  const m = mountVt(() => withVt({ state: 'connected', method: 'oauth', account: 'a' }));
  await m.pane.refresh();
  await m.pick();
  m.els.change({ target: { id: 'cx-vt-allow', checked: true } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m.posts()[0], ['POST', '/api/connectors/vantage/settings', { allowChanges: true }]);
  m.pane.stop();
});

test('vantage token save posts vantage/token', async () => {
  const m = mountVt(() => withVt({}));
  await m.pane.refresh();
  await m.pick();
  await m.click('vt-switch');
  m.els.input({ target: { id: 'cx-vt-key', value: '  vt-abc\n' } });
  await m.click('vt-token');
  assert.deepEqual(m.posts()[0], ['POST', '/api/connectors/vantage/token', { token: 'vt-abc' }]);
  m.pane.stop();
});

test('vantage needs-sign-in shows the copy and Sign in', () => {
  const html = C.paneHtml({ view: withVt({ state: 'needs-sign-in', method: 'oauth' }), picked: 'vantage' });
  assert.match(html, /Your Vantage sign-in has run out\. Sign in again\./);
  assert.match(html, /data-act="oauth"/);
  assert.match(html, /data-act="disconnect"/);
});

test('markup in the vantage account is escaped', () => {
  const html = C.paneHtml({ view: withVt({ state: 'connected', method: 'oauth', account: '<img src=x onerror=alert(1)>' }), picked: 'vantage' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Signed in as &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(plain(html).includes(VT_FACTS), 'the Vantage card, not a fallback');
});

// ---- Teams chats card (the same app sign-in card as transcripts, its own fields and routes) ----
const tcView = (c, more = []) => ({ connectors: [{ id: 'teamschats', label: 'Teams chats', by: 'Your chats, read-only, from an app you register', state: 'not-connected', agents: [], ...c }, ...more], planned: [] });

test('teamschats: signed out shows its own two IDs, the registration it needs and Sign in', () => {
  const html = C.paneHtml({ view: tcView({ tenantId: TR_T, clientId: TR_C }), picked: 'teamschats' });
  assert.match(html, /id="tc-tenant"[^>]*value="11111111-2222-3333-4444-555555555555"/);
  assert.match(html, /id="tc-client"[^>]*value="66666666-7777-8888-9999-000000000000"/);
  assert.match(html, /<details[^>]*>[\s\S]*What the app registration needs/);
  for (const s of ['User.Read', 'Chat.Read', 'offline_access', 'http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient']) assert.ok(html.includes(s), s);
  assert.match(html, /public client flows/i);
  assert.match(html, /ask an admin to grant consent for Chat\.Read/i);
  assert.doesNotMatch(html, /ReadWrite|Read\.All|client secret:/);
  assert.match(html, /data-act="tc-start"[^>]*>Sign in</);
  assert.doesNotMatch(html, /tr-start|OnlineMeeting/);
});

test('teamschats: connecting shows its code with its own Cancel', () => {
  const html = C.paneHtml({ view: tcView({ state: 'connecting' }), picked: 'teamschats', teamschats: { url: 'https://microsoft.com/devicelogin', code: 'CHAT1234', expiresAt: 10 * 60 * 1000 } }, 0);
  assert.match(html, /CHAT1234/);
  assert.match(html, /data-act="tc-cancel"[^>]*>Cancel</);
  assert.doesNotMatch(html, /tr-cancel|azure-cancel|id="tc-tenant"/);
});

test('teamschats: connected says what agents can and cannot do, with Test and Sign out', () => {
  const html = C.paneHtml({ view: tcView({ state: 'connected', account: 'alex@example.com', agents: [{ id: 'cursor', label: 'Cursor CLI', chip: 'Added' }] }), picked: 'teamschats' });
  assert.match(html, /Signed in as alex@example\.com/);
  assert.match(html, /can't send, edit or delete/);
  assert.match(html, /data-act="test"/);
  assert.match(html, /data-act="disconnect"[^>]*>Sign out</);
  assert.doesNotMatch(html, /id="tc-tenant"/);
});

test('teamschats: Sign in posts its IDs to its own route, polls its own status, and the code is the one copied', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const calls = []; let state = 'not-connected', status = 'waiting';
  let html = ''; const handlers = {}; const copied = [];
  const tr = { id: 'transcripts', label: 'Teams transcripts', by: 'x', state: 'not-connected', agents: [] };
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.endsWith('/teamschats/start')) { state = 'connecting'; return { url: 'https://microsoft.com/devicelogin', code: 'CHAT1234', expiresAt: Date.now() + 600000 }; }
    if (url.endsWith('/teamschats/status')) { if (status === 'done') state = 'connected'; return { status }; }
    return tcView({ state, account: 'alex@example.com' }, [tr]);
  }, copy: async (s) => { copied.push(s); return true; }, openTerm() {}, openTab() {} });
  await m.refresh();
  const act = (a) => handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: a } } : null) } });
  handlers.input({ target: { id: 'tr-tenant', value: '99999999-2222-3333-4444-555555555555' } }); // the other card's field
  handlers.input({ target: { id: 'tc-tenant', value: TR_T } });
  handlers.input({ target: { id: 'tc-client', value: TR_C } });
  act('tc-start');
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.find((c) => c[1].endsWith('/teamschats/start')), ['POST', '/api/connectors/teamschats/start', { tenantId: TR_T, clientId: TR_C }]);
  assert.ok(!calls.some((c) => c[1].includes('/transcripts/')));
  assert.match(html, /CHAT1234/);
  act('copy');
  await tick();
  assert.deepEqual(copied, ['CHAT1234']);
  status = 'done';
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(calls.some((c) => c[0] === 'GET' && c[1] === '/api/connectors/teamschats/status'));
  assert.match(html, /Signed in as alex@example\.com/);
  m.stop && m.stop();
});

test('teamschats: Cancel posts to its own cancel route', async () => {
  const calls = []; let html = ''; const handlers = {};
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url) => { calls.push([method, url]); return tcView({}); }, openTerm() {}, openTab() {} });
  await m.refresh();
  handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'tc-cancel' } } : null) } });
  await tick(); await tick();
  assert.ok(calls.some((c) => c[0] === 'POST' && c[1] === '/api/connectors/teamschats/cancel'));
});

// ---- Outlook cards (the app sign-in card) and Cursor's own connectors ----
test('outlook mail and calendar use the app sign-in card with their own one read permission', () => {
  for (const [id, pre, scope] of [['outlookmail', 'om', 'Mail.Read'], ['outlookcalendar', 'oc', 'Calendars.Read']]) {
    const view = { connectors: [{ id, label: id, by: 'x', state: 'not-connected', agents: [], cursorAltLabel: 'Outlook (Cursor)', cursorAltOn: false }], planned: [] };
    const html = C.paneHtml({ view, picked: id });
    assert.match(html, new RegExp(`id="${pre}-tenant"`));
    assert.match(html, new RegExp(`data-act="${pre}-start"`));
    assert.ok(html.includes(`<code>${scope}</code>`), scope);
    assert.doesNotMatch(html, /ReadWrite|Mail\.Send/);
    assert.match(html, /The Cursor CLI gets it too, until you turn on Outlook \(Cursor\)\./);
  }
});

test('a second app sign-in offers the IDs the first one uses; its own saved IDs win', () => {
  const chats = { id: 'teamschats', label: 'Teams chats', by: 'x', state: 'connected', tenantId: TR_T, clientId: TR_C, agents: [] };
  const mail = { id: 'outlookmail', label: 'Outlook mail', by: 'x', state: 'not-connected', agents: [] };
  let html = C.paneHtml({ view: { connectors: [chats, mail], planned: [] }, picked: 'outlookmail' });
  assert.match(html, /id="om-tenant"[^>]*value="11111111-2222-3333-4444-555555555555"/);
  assert.match(html, /id="om-client"[^>]*value="66666666-7777-8888-9999-000000000000"/);
  html = C.paneHtml({ view: { connectors: [chats, { ...mail, tenantId: '22222222-2222-3333-4444-555555555555', clientId: TR_C }], planned: [] }, picked: 'outlookmail' });
  assert.match(html, /id="om-tenant"[^>]*value="22222222-2222-3333-4444-555555555555"/);
});

test('the Teams chats card says when Cursor uses its own instead', () => {
  const view = { connectors: [{ id: 'teamschats', label: 'Teams chats', by: 'x', state: 'connected', account: 'a@example.com', agents: [], cursorAltLabel: 'Teams (Cursor)', cursorAltOn: true }], planned: [] };
  assert.match(C.paneHtml({ view, picked: 'teamschats' }), /The Cursor CLI uses Teams \(Cursor\) instead\./);
});

const CU = { id: 'cursor-teams', label: 'Teams (Cursor)', by: "Cursor's own", state: 'not-connected', agents: [], insteadOf: 'Teams chats', sends: 'post in your chats and channels', scopes: ['Chat.Read', 'ChatMessage.Send'] };
const cuView = (c) => ({ connectors: [{ ...CU, ...c }], planned: [] });

test("Cursor's own, off: says it's Cursor only, not read-only, what it asks for, and offers Turn on", () => {
  const html = C.paneHtml({ view: cuView({}), picked: 'cursor-teams' });
  assert.match(html, /for the Cursor CLI only\. While it&#39;s on, Cursor uses it instead of Teams chats\./);
  assert.match(html, /class="cx-warn">Not read-only: agents in Cursor can post in your chats and channels as you\./);
  assert.match(html, /<code>ChatMessage\.Send<\/code>/);
  assert.match(html, /data-act="cu-start"[^>]*>Turn on and sign in</);
  assert.doesNotMatch(html, /data-act="disconnect"/);
});

test("Cursor's own, signing in: the Microsoft link, the localhost hint, the paste box and Finish", () => {
  const html = C.paneHtml({ view: cuView({ state: 'connecting', login: { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1', port: '8787' } }), picked: 'cursor-teams', cuPaste: { 'cursor-teams': 'http://localhost:8787/callback?code=a' } });
  assert.match(html, /href="https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?x=1"[^>]*>Open Microsoft sign-in</);
  assert.match(html, /<code>localhost:8787<\/code>/);
  assert.match(html, /id="cu-paste"[^>]*value="http:\/\/localhost:8787\/callback\?code=a"/);
  assert.match(html, /data-act="cu-finish"[^>]*>Finish sign-in</);
  assert.match(html, /data-act="cu-cancel"/);
  const bad = C.paneHtml({ view: cuView({ state: 'connecting', login: { url: 'javascript:alert(1)', port: '8787' } }), picked: 'cursor-teams' });
  assert.doesNotMatch(bad, /javascript:/);
});

test("Cursor's own, on but not signed in, and signed in", () => {
  let html = C.paneHtml({ view: cuView({ state: 'not-signed-in' }), picked: 'cursor-teams' });
  assert.match(html, /Added to Cursor, not signed in yet\./);
  assert.match(html, /data-act="cu-start"[^>]*>Sign in</);
  assert.match(html, /data-act="disconnect"[^>]*>Turn off</);
  assert.match(html, /Not signed in/);
  html = C.paneHtml({ view: cuView({ state: 'connected', lastTest: { at: new Date(0).toISOString(), ok: true, tools: null }, agents: [{ id: 'cursor', label: 'Cursor CLI', chip: 'Added' }] }), picked: 'cursor-teams' }, 30000);
  assert.match(html, /Signed in through Cursor/);
  assert.match(html, /Tested just now: Teams \(Cursor\) answered</);
  assert.doesNotMatch(html, /null tools/);
  assert.match(html, /Cursor keeps its own sign-in/);
  html = C.paneHtml({ view: cuView({ needsCursor: true }), picked: 'cursor-teams' });
  assert.match(html, /Install the Cursor CLI first/);
  assert.doesNotMatch(html, /data-act="cu-start"/);
});

test("Cursor's own: Turn on, paste and Finish post to its own routes", async () => {
  const calls = []; let html = ''; const handlers = {};
  let row = { state: 'not-connected' };
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.endsWith('/start')) { row = { state: 'connecting', login: { url: 'https://login.microsoftonline.com/x', port: '8787' } }; return { url: 'https://login.microsoftonline.com/x' }; }
    if (url.endsWith('/finish')) { row = { state: 'connected' }; return { ok: true }; }
    return cuView(row);
  }, openTerm() {}, openTab() {} });
  await m.refresh();
  const act = (a) => handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: a } } : null) } });
  act('cu-start');
  await tick(); await tick(); await tick();
  assert.ok(calls.some((c) => c[0] === 'POST' && c[1] === '/api/connectors/cursor-teams/start'));
  assert.match(html, /id="cu-paste"/);
  handlers.input({ target: { id: 'cu-paste', value: '  http://localhost:8787/callback?code=a&state=b ' } });
  act('cu-finish');
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.find((c) => c[1].endsWith('/finish')), ['POST', '/api/connectors/cursor-teams/finish', { url: 'http://localhost:8787/callback?code=a&state=b' }]);
  assert.match(html, /Signed in through Cursor/);
});

test("Cursor's own: while it waits the card watches the sign-in, and shows why when the Cursor CLI stops", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const calls = []; let html = ''; const handlers = {};
  let row = { state: 'connecting', login: { url: 'https://login.microsoftonline.com/x', port: '8787' } };
  let status = { status: 'waiting' };
  const el = { addEventListener: (n, f) => { handlers[n] = f; }, querySelector() { return null; }, contains() { return false; },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; } };
  const m = C.mountConnectors(el, { api: async (method, url) => {
    calls.push([method, url]);
    if (url.endsWith('/cursor-teams/status')) return status;
    return cuView(row);
  }, openTerm() {}, openTab() {} });
  await m.refresh();
  handlers.input({ target: { id: 'cu-paste', value: 'http://localhost:8787/callback?code=half' } });
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(calls.some((c) => c[1] === '/api/connectors/cursor-teams/status'));
  assert.match(html, /id="cu-paste"/, 'still waiting: the paste box stays');
  status = { status: 'failed', error: 'The Cursor CLI stopped waiting for Microsoft after 5 minutes. Select Sign in to start again.' };
  row = { state: 'not-signed-in', error: status.error };
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await tick();
  assert.doesNotMatch(html, /id="cu-paste"/);
  assert.match(html, /stopped waiting for Microsoft after 5 minutes/);
  assert.match(html, /data-act="cu-start"[^>]*>Sign in</);
  const polls = calls.filter((c) => c[1].endsWith('/status')).length;
  t.mock.timers.tick(9000);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(calls.filter((c) => c[1].endsWith('/status')).length, polls, 'the poll stops once it ended');
  m.stop && m.stop();
});
