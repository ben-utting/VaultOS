'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomationAccess, AUTOMATION_IDS } = require('../lib/connector-automation');
const { STDIO_WRAPPER } = require('../lib/automation-mcp-stdio');
const { toClaude } = require('../lib/connector-agents');
const { entryFor, CONNECTORS } = require('../lib/connectors');

function setup(t, records = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-acc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.cache/vaultos/automation-mcp');
  const on = new Set(['atlassian', 'azure']);
  const acc = createAutomationAccess({
    dir, port: 7684, home, connected: (id) => on.has(id), record: (id) => records[id], label: (id) => CONNECTORS[id].label,
  });
  return { home, dir, acc };
}
const ids = ['atlassian', 'azure', 'vantage'];

test('open() builds entries for the connected ticks and names the rest missing', async (t) => {
  const { home, acc } = setup(t);
  const a = await acc.open({ runId: 'r1', cardPath: 'x', ids });
  const key = JSON.parse(fs.readFileSync(a.configFile, 'utf8')).mcpServers.atlassian.headers['X-VaultOS-Key'];
  assert.deepStrictEqual(a.entries.atlassian, { kind: 'http', url: 'http://127.0.0.1:7684/mcp/atlassian', headers: { 'X-VaultOS-Key': key } });
  const log = a.entries.azure.args[4];
  assert.ok(log.startsWith(path.join(home, '.cache/vaultos/automation-mcp')) && log.endsWith('.log'));
  assert.deepStrictEqual(a.entries.azure, { kind: 'stdio', command: process.execPath,
    args: [STDIO_WRAPPER, '--id', 'azure', '--log', log, '--', path.join(home, '.local/bin/azmcp'), 'server', 'start', '--read-only'] });
  assert.deepStrictEqual(a.missing, ['vantage']);
  assert.deepStrictEqual(a.ids, ['atlassian', 'azure']);
  assert.deepStrictEqual(a.labels, { atlassian: CONNECTORS.atlassian.label, azure: CONNECTORS.azure.label, vantage: CONNECTORS.vantage.label });
});

test('azure and azure devops are read-only even with Allow changes on', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-acc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a2 = createAutomationAccess({ dir: path.join(home, 'd'), port: 1, home, connected: () => true,
    record: (id) => ({ azure: { allowChanges: true }, azuredevops: { allowChanges: true, org: 'acme' } }[id]), label: (id) => id });
  const a = await a2.open({ runId: 'r', cardPath: 'x', ids: ['azure', 'azuredevops'] });
  assert.strictEqual(a.entries.azure.args.at(-1), '--read-only');
  assert.ok(!a.entries.azuredevops.args.includes('--allow-changes'));
  assert.ok(a.entries.azuredevops.args.includes('acme'));
});

test('the config file holds Claude-format servers, 0600 in a 0700 dir', async (t) => {
  const { dir, acc } = setup(t);
  const a = await acc.open({ runId: 'r', cardPath: 'x', ids });
  assert.strictEqual(path.dirname(a.configFile), dir);
  assert.match(path.basename(a.configFile), /^[0-9a-f]+\.json$/);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(a.configFile).mode & 0o777, 0o600);
  const text = fs.readFileSync(a.configFile, 'utf8');
  assert.deepStrictEqual(JSON.parse(text), { mcpServers: { atlassian: toClaude(a.entries.atlassian), azure: toClaude(a.entries.azure) } });
  const key = a.entries.atlassian.headers['X-VaultOS-Key'];
  assert.ok(text.includes(key));
  for (const e of Object.values(a.entries)) if (e.kind === 'stdio') assert.ok(![e.command, ...e.args].some((x) => x.includes(key)));
});

test('each open() mints its own key, and revoking one leaves the other', async (t) => {
  const { acc } = setup(t);
  const a = await acc.open({ runId: 'r1', cardPath: 'x', ids: ['atlassian'] });
  const b = await acc.open({ runId: 'r2', cardPath: 'y', ids: ['atlassian'] });
  const ka = a.entries.atlassian.headers['X-VaultOS-Key'], kb = b.entries.atlassian.headers['X-VaultOS-Key'];
  assert.notStrictEqual(ka, kb);
  await a.revoke();
  assert.strictEqual(acc.grant(ka), null);
  assert.ok(acc.grant(kb).ids.has('atlassian'));
});

test('revoke() deletes the files and the grant', async (t) => {
  const { acc } = setup(t);
  const a = await acc.open({ runId: 'r', cardPath: 'x', ids });
  const log = a.entries.azure.args[4];
  fs.writeFileSync(log, '');
  const key = a.entries.atlassian.headers['X-VaultOS-Key'];
  await a.revoke();
  assert.strictEqual(acc.grant(key), null);
  assert.ok(!fs.existsSync(a.configFile) && !fs.existsSync(log));
});

test('grant() never throws and is null for anything that is not a live key', (t) => {
  const { acc } = setup(t);
  for (const k of [undefined, null, 5, {}, '', 'nope', '__proto__']) assert.strictEqual(acc.grant(k), null);
});

test('usage() merges relay counts and the wrapper log, capped at 50 tools per connector', async (t) => {
  const { acc } = setup(t);
  const a = await acc.open({ runId: 'r', cardPath: 'x', ids });
  const g = acc.grant(a.entries.atlassian.headers['X-VaultOS-Key']);
  g.count('atlassian', 'search', false); g.count('atlassian', 'search', false); g.count('atlassian', 'edit', true);
  g.count('vantage', 'x', false); // not ticked/connected: ignored
  const log = a.entries.azure.args[4];
  const lines = [{ id: 'azure', tool: 'list', refused: false }, { id: 'azure', tool: 'list', refused: false }, { id: 'azure', tool: 'del', refused: true }];
  for (let i = 0; i < 60; i++) lines.push({ id: 'azure', tool: 't' + i, refused: false });
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  const u = await a.usage();
  assert.deepStrictEqual(u.lookups.atlassian, { search: 2 });
  assert.deepStrictEqual(u.refusedCalls.atlassian, { edit: 1 });
  assert.strictEqual(u.lookups.azure.list, 2);
  assert.strictEqual(Object.keys(u.lookups.azure).length, 50);
  assert.deepStrictEqual(u.refusedCalls.azure, { del: 1 });
  assert.strictEqual(u.lookups.vantage, undefined);
});

test('cursor-kind connectors are never usable', async (t) => {
  const { acc } = setup(t);
  assert.ok(!AUTOMATION_IDS.includes('cursor-teams'));
  assert.ok(AUTOMATION_IDS.every((id) => CONNECTORS[id].kind !== 'cursor'));
  await assert.rejects(acc.open({ runId: 'r', cardPath: 'x', ids: ['cursor-teams'] }));
  assert.deepStrictEqual(acc.choices().map((c) => c.id), AUTOMATION_IDS);
  assert.strictEqual(acc.choices().find((c) => c.id === 'atlassian').connected, true);
  assert.strictEqual(acc.choices().find((c) => c.id === 'vantage').connected, false);
});

test('clearLeftovers() removes strays but keeps the files of an access that is open', async (t) => {
  const { dir, acc } = setup(t);
  const a = await acc.open({ runId: 'r', cardPath: 'x', ids });
  const log = a.configFile.replace(/\.json$/, '.log');
  fs.writeFileSync(log, 'x');
  fs.writeFileSync(path.join(dir, 'stray.log'), 'x');
  await acc.clearLeftovers();
  assert.ok(fs.existsSync(a.configFile) && fs.existsSync(log));
  assert.ok(!fs.existsSync(path.join(dir, 'stray.log')));
  await a.revoke();
  fs.writeFileSync(path.join(dir, 'stray2.log'), 'x');
  await acc.clearLeftovers();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('choices() never throws: a connected() that throws counts as not connected', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-acc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const acc = createAutomationAccess({ dir: path.join(home, 'd'), port: 1, home, record: () => undefined, label: (id) => CONNECTORS[id].label,
    connected: () => { throw new TypeError("Cannot read properties of null (reading 'connectors')"); } });
  const c = acc.choices();
  assert.deepStrictEqual(c.map((x) => x.id), AUTOMATION_IDS);
  assert.ok(c.every((x) => x.connected === false));
});

test('a clearLeftovers() that lands while open() writes its files never takes them', async (t) => {
  const { dir, acc } = setup(t);
  const realWrite = fs.promises.writeFile;
  let swept = 0;
  // The sweep reads the folder just after the config file is written, before open() returns.
  fs.promises.writeFile = async (file, ...rest) => {
    await realWrite.call(fs.promises, file, ...rest);
    if (String(file).startsWith(dir)) { swept++; await acc.clearLeftovers(); }
  };
  let a;
  try { a = await acc.open({ runId: 'r', cardPath: 'x', ids: ['atlassian'] }); } finally { fs.promises.writeFile = realWrite; }
  assert.strictEqual(swept, 1);
  assert.ok(fs.existsSync(a.configFile));
  await a.revoke();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
