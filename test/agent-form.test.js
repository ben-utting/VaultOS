'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AF = require('../public/agent-form');
const S = require('../lib/settings');

// What the server makes of a custom agent: the saved one, or the SettingsError it throws.
const serverSays = (custom) => {
  try { return S.validate({ version: 1, agent: { profile: 'custom', custom } }).agent.custom; } catch (e) { return e; }
};

test('the custom fields cover every field of a custom agent', () => {
  assert.deepEqual(AF.CUSTOM_FIELDS.map((f) => f.key), ['label', 'detect', 'install', 'login', 'start']);
  assert.ok(AF.CUSTOM_FIELDS.every((f) => f.label && f.placeholder));
});

test('customBody trims, and sends the optional commands only when filled in', () => {
  const vals = { label: '  Fake ', detect: ' fakeagent', install: '   ', login: ' fake login ', start: 'fakeagent {prompt} ' };
  assert.deepEqual(AF.customBody((k) => vals[k]), { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}', login: 'fake login' });
  assert.deepEqual(AF.customBody(() => undefined), { label: '', detect: '', start: '' });
});

test('customProblem names the field and says what is wrong', () => {
  const ok = { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}' };
  assert.equal(AF.customProblem(ok), null);
  assert.deepEqual(AF.customProblem({ ...ok, label: '' }), { key: 'label', message: 'Give the agent a name' });
  assert.equal(AF.customProblem({ ...ok, detect: '' }).key, 'detect');
  assert.equal(AF.customProblem({ ...ok, detect: 'rm -rf' }).key, 'detect');
  assert.deepEqual(AF.customProblem({ ...ok, start: 'fakeagent go' }), { key: 'start', message: 'The start command needs {prompt}' });
  // The first problem wins, in the order the fields are shown.
  assert.equal(AF.customProblem({ label: '', detect: '', start: '' }).key, 'label');
});

test('a body customProblem passes is one the server saves, and the reverse', () => {
  const bodies = [
    { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}' },
    { label: 'Fake', detect: 'fake-agent.2+x_y', start: 'x {prompt}', install: 'npm i -g x', login: 'x login' },
    { label: 'Fake', detect: 'a'.repeat(64), start: '{prompt}' },
    { label: 'Fake', detect: 'a'.repeat(65), start: '{prompt}' },
    { label: 'Fake', detect: '-x', start: '{prompt}' },
    { label: 'Fake', detect: '.x', start: '{prompt}' },
    { label: 'Fake', detect: 'x;y', start: '{prompt}' },
    { label: 'Fake', detect: 'x y', start: '{prompt}' },
    { label: 'Fake', detect: 'x', start: 'x' },
    { label: '', detect: 'x', start: '{prompt}' },
  ];
  for (const b of bodies) {
    const server = serverSays(b);
    assert.equal(AF.customProblem(b) === null, !(server instanceof Error), JSON.stringify(b));
    if (!(server instanceof Error)) assert.deepEqual(server, b);
  }
});

// ---- the status line and the flows, with stand-ins for the page's elements and its `ui`


// A page's `ui` that records what the flows asked of it. save() answers with `answer` (a value or a function).
function fakeUi({ saved = null, answer = { ok: true }, values = {} } = {}) {
  const log = [];
  const ui = {
    log,
    save: async (body) => { log.push(['save', body]); return typeof answer === 'function' ? answer(body) : answer; },
    saved: () => saved,
    showCustom: (on) => log.push(['showCustom', on]),
    showStatus: (a) => log.push(['showStatus', a.profile]),
    revert: (a) => log.push(['revert', a && a.profile]),
    chooseError: (msg) => log.push(['chooseError', msg]),
    value: (k) => values[k],
    fieldError: (k, msg) => { if (msg) log.push(['fieldError', k, msg]); },
    focus: (k) => log.push(['focus', k]),
    customError: (msg) => { if (msg) log.push(['customError', msg]); },
  };
  return ui;
}

test('saveCustom checks the fields first and points at the bad one', async () => {
  const ui = fakeUi({ values: { label: 'Fake', detect: 'bad name', start: 'x {prompt}' } });
  assert.equal(await AF.saveCustom(ui), null);
  assert.deepEqual(ui.log, [['fieldError', 'detect', "Use the program's name: letters, digits, . _ + -"], ['focus', 'detect']]);
});

test('saveCustom saves the trimmed body and resolves it; a server error goes by Save agent', async () => {
  const values = { label: ' Fake ', detect: 'fakeagent', start: 'fakeagent {prompt}', install: '' };
  const ok = fakeUi({ values });
  assert.deepEqual(await AF.saveCustom(ok), { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}' });
  assert.deepEqual(ok.log, [['save', { profile: 'custom', custom: { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}' } }]]);
  const bad = fakeUi({ values, answer: { error: 'Nope' } });
  assert.equal(await AF.saveCustom(bad), null);
  assert.deepEqual(bad.log.at(-1), ['customError', 'Nope']);
  const stale = fakeUi({ values, answer: { stale: true } });
  assert.equal(await AF.saveCustom(stale), null);
  assert.equal(stale.log.length, 1);   // just the save
});

test('saveCustom sends one save at a time, and frees the flag after a throw', async () => {
  let release;
  const values = { label: 'Fake', detect: 'fakeagent', start: 'fakeagent {prompt}' };
  const ui = fakeUi({ values, answer: () => new Promise((r) => { release = r; }) });
  const first = AF.saveCustom(ui);
  assert.equal(await AF.saveCustom(ui), null);   // the second is turned away while the first runs
  release({ ok: true });
  assert.ok(await first);
  assert.equal(ui.log.filter((x) => x[0] === 'save').length, 1);
  const boom = fakeUi({ values, answer: () => { throw new Error('network'); } });
  await assert.rejects(AF.saveCustom(boom));
  assert.equal(boom.busy, false);
});

// What GET /api/agents answers: the eight built-ins (tiers and makers as lib/agents.js has them).
const AGENTS_FIXTURE = require('../lib/agents').PROFILE_IDS.filter((id) => !['custom', 'none'].includes(id)).map((id) => {
  const p = require('../lib/agents').PROFILES[id];
  return { id, label: p.label, maker: p.maker, tier: p.tier, installed: id === 'claude' || id === 'pi', install: p.install, login: p.login, loginNote: p.loginNote, hooks: p.hooks };
});

test('chips: Default first, then installed state', () => {
  assert.deepEqual(AF.chipsFor({ id: 'pi', installed: true }, 'pi'), ['Default', 'Installed']);
  assert.deepEqual(AF.chipsFor({ id: 'cursor', installed: false }, 'pi'), ['Not installed']);
  assert.deepEqual(AF.chipsFor({ id: 'cursor', installed: false }, 'cursor'), ['Default', 'Not installed']);
  assert.deepEqual(AF.chipsFor({ id: 'none' }, 'none'), ['Default']);
  assert.deepEqual(AF.chipsFor({ id: 'none' }, 'pi'), []);
});

test('groups put custom and none last, always', () => {
  const g = AF.groups(AGENTS_FIXTURE);
  assert.deepEqual(g.tested.map((a) => a.id), ['claude', 'cursor', 'pi']);
  assert.deepEqual(g.more.map((a) => a.id), ['codex', 'antigravity', 'copilot', 'opencode', 'kilo']);
  assert.deepEqual(g.minor.map((a) => a.id), ['custom', 'none']);
  assert.equal(g.minor[0].saved, false);
  const withCustom = AF.groups([...AGENTS_FIXTURE, { id: 'custom', label: 'Mine', tier: 'other', installed: true }]);
  assert.deepEqual([withCustom.minor[0].label, withCustom.minor[0].saved, withCustom.minor[0].installed], ['Mine', true, true]);
});

test('arrow keys move through every tile and wrap', () => {
  const ids = ['claude', 'cursor', 'pi', 'codex'];
  assert.equal(AF.moveFocus(ids, 'pi', 'ArrowRight'), 'codex');
  assert.equal(AF.moveFocus(ids, 'pi', 'ArrowDown'), 'codex');
  assert.equal(AF.moveFocus(ids, 'codex', 'ArrowRight'), 'claude');
  assert.equal(AF.moveFocus(ids, 'claude', 'ArrowLeft'), 'codex');
  assert.equal(AF.moveFocus(ids, 'cursor', 'Home'), 'claude');
  assert.equal(AF.moveFocus(ids, 'claude', 'End'), 'codex');
  assert.equal(AF.moveFocus(ids, 'pi', 'Enter'), null);
});

test('pickerHtml: ten tiles, the copy, the picked one checked, the default in the footer', () => {
  const html = AF.pickerHtml({ agents: AGENTS_FIXTURE, def: 'claude', picked: 'pi' });
  assert.equal((html.match(/class="ap-tile"/g) || []).length, 10);
  for (const t of ['Tested with VaultOS', 'More agents', 'Default', 'Installed', 'Not installed', 'Sign in', 'Make default']) assert.ok(html.includes(t), t);
  assert.match(html, /data-id="pi"[^>]*aria-checked="true"[^>]*tabindex="0"/);
  assert.match(html, /data-id="claude"[^>]*aria-checked="false"[^>]*tabindex="-1"/);
  assert.match(html, /Then type \/login/);
  assert.match(html, /class="ap-foot"[^]*Claude Code/);
  const cursor = AF.pickerHtml({ agents: AGENTS_FIXTURE, def: 'cursor', picked: 'cursor' });
  assert.match(cursor, /data-act="install"/);
  assert.match(cursor, /data-act="default"[^>]*disabled/);
});

test('pickerHtml keeps a markup label as text everywhere', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = AF.pickerHtml({ agents: [...AGENTS_FIXTURE, { id: 'custom', label: evil, tier: 'other', installed: false }], def: 'custom', picked: 'custom' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// A host element with just what mountPicker uses: innerHTML, one delegated listener per type, querySelector.
function fakeHost() {
  const on = {};
  return {
    innerHTML: '', on,
    addEventListener: (type, fn) => { on[type] = fn; },
    querySelector: () => null,
  };
}
const ev = (attrs) => ({ preventDefault() {}, target: { closest: (sel) => (sel.split(',').some((x) => attrs[x.trim()]) ? { dataset: attrs.dataset || {}, disabled: !!attrs.disabled } : null) } });

test('mountPicker: a tile click picks it; Make default saves it; Install opens its terminal', async () => {
  const saves = []; const terms = [];
  const host = fakeHost();
  const p = AF.mountPicker(host, { save: async (b) => { saves.push(b); return { ok: true }; }, openTerm: (k, a) => terms.push([k, a.id]), customFields: null });
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE });
  host.on.click(ev({ '.ap-tile': true, dataset: { id: 'cursor' } }));
  assert.match(host.innerHTML, /data-id="cursor"[^>]*aria-checked="true"/);
  host.on.click(ev({ '[data-act]': true, dataset: { act: 'install' } }));
  assert.deepEqual(terms, [['install', 'cursor']]);
  await host.on.click(ev({ '[data-act]': true, dataset: { act: 'default' } }));
  assert.deepEqual(saves, [{ profile: 'cursor' }]);
  assert.match(host.innerHTML, /class="ap-foot"[^]*Cursor CLI/);
});

test('mountPicker: a failed save keeps the old default and says why', async () => {
  const host = fakeHost();
  const p = AF.mountPicker(host, { save: async () => ({ error: 'Could not save the agent' }), openTerm() {}, customFields: null });
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE });
  p.pick('pi');
  await host.on.click(ev({ '[data-act]': true, dataset: { act: 'default' } }));
  assert.match(host.innerHTML, /class="ap-foot"[^]*Claude Code/);
  assert.match(host.innerHTML, /Could not save the agent/);
});

test('mountPicker: refreshing with the same agents leaves the tiles alone, so a click mid-poll still lands', () => {
  const host = fakeHost();
  const p = AF.mountPicker(host, { save: async () => ({ ok: true }), openTerm() {}, customFields: null });
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE });
  host.innerHTML = 'untouched';
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE.map((a) => ({ ...a })) });
  assert.equal(host.innerHTML, 'untouched');
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE.map((a) => (a.id === 'cursor' ? { ...a, installed: true } : a)) });
  assert.match(host.innerHTML, /data-id="cursor"[^]*Installed/);
});

test('mountPicker: the Other fields stay hidden in their own place until Other is picked', () => {
  const home = { appendChild: (el) => { el.parentNode = home; } };
  const slot = { appendChild: (el) => { el.parentNode = slot; } };
  const cls = new Set();
  const fields = { parentNode: home, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
  const host = fakeHost();
  host.querySelector = (sel) => (sel === '.ap-custom-slot' && /ap-custom-slot/.test(host.innerHTML) ? slot : null);
  const p = AF.mountPicker(host, { save: async () => ({ ok: true }), openTerm() {}, customFields: fields });
  assert.deepEqual([fields.parentNode, cls.has('hidden')], [home, true]);   // still on the page, so the page can reach its inputs
  p.refresh({ default: 'claude', agents: AGENTS_FIXTURE });
  assert.deepEqual([fields.parentNode, cls.has('hidden')], [home, true]);
  p.pick('custom');
  assert.deepEqual([fields.parentNode, cls.has('hidden')], [slot, false]);  // shown in the detail panel
  p.pick('pi');
  assert.deepEqual([fields.parentNode, cls.has('hidden')], [home, true]);
});

test('mountPicker: with no default yet, installing an agent makes it the default', async () => {
  const saves = []; const terms = [];
  const host = fakeHost();
  const p = AF.mountPicker(host, { save: async (b) => { saves.push(b); return { ok: true }; }, openTerm: (k, a) => terms.push([k, a.id]), customFields: null });
  p.refresh({ default: 'none', agents: AGENTS_FIXTURE });
  p.pick('cursor');
  await host.on.click(ev({ '[data-act]': true, dataset: { act: 'install' } }));
  assert.deepEqual(saves, [{ profile: 'cursor' }]);
  assert.deepEqual(terms, [['install', 'cursor']]);
  // With a default already, installing another agent leaves the default alone.
  p.pick('pi');
  await host.on.click(ev({ '[data-act]': true, dataset: { act: 'install' } }));
  assert.deepEqual(saves, [{ profile: 'cursor' }]);
  assert.deepEqual(terms, [['install', 'cursor'], ['install', 'pi']]);
});
