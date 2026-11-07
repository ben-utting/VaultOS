'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { searchVault } = require('../lib/search-client');
const { recall } = require('../hooks/vault-recall');

const CLI = path.join(__dirname, '..', 'bin', 'vault-search.js');
const HOOK = path.join(__dirname, '..', 'hooks', 'vault-recall.js');
const LONG_TLDR = 'Safeguard tests each asset connection over the REST API. '.repeat(10).trim();

function vault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-recall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, text) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put('Work/1. iam/conn/article.md',
    `---\ntitle: "Safeguard connection test"\nupdated: 2026-10-01\n---\n\n> **TL;DR** ${LONG_TLDR}\n\nbody\n`);
  put('Work/1. iam/conn/task.md', '---\ntitle: "Run the safeguard connection test"\n---\n\nnotes\n');
  put('Work/1. iam/other/article.md', '---\ntitle: "Printer toner"\n---\n\ntoner\n');
  return dir;
}

// A stand-in for the VaultOS server's /api/term/search: answers only the right token.
async function fakeServer(t, results) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      seen.push({ url: req.url, body: b });
      if (b.id !== 'term1' || b.token !== 'tok') { res.statusCode = 403; return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const env = { VAULTOS_TERM_ID: 'term1', VAULTOS_TERM_TOKEN: 'tok', VAULTOS_HOOK_URL: `http://127.0.0.1:${srv.address().port}/api/term/agent` };
  return { env, seen };
}

const cli = (dir, args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, VAULT_DIR: dir },
});
const hook = (dir, stdin) => spawnSync(process.execPath, [HOOK], {
  input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH, VAULT_DIR: dir },
});

test('searchVault asks the VaultOS server with the terminal token', async (t) => {
  const canned = [{ path: 'X/a.md', kind: 'note', title: 'From server', date: '2026-01-01', score: 1, coverage: 1, snippet: '' }];
  const { env, seen } = await fakeServer(t, canned);
  const got = await searchVault('anything', { kind: 'article', limit: 2 }, { env, vaultDir: '/nonexistent' });
  assert.deepEqual(got, canned);
  assert.equal(seen[0].url, '/api/term/search');
  assert.deepEqual({ q: seen[0].body.q, kind: seen[0].body.kind, limit: seen[0].body.limit }, { q: 'anything', kind: 'article', limit: 2 });
});

test('searchVault falls back to reading the vault when the server refuses', async (t) => {
  const dir = vault(t);
  const { env } = await fakeServer(t, []);
  const got = await searchVault('safeguard connection', { kind: 'article' }, { env: { ...env, VAULTOS_TERM_TOKEN: 'wrong' }, vaultDir: dir });
  assert.equal(got[0].path, 'Work/1. iam/conn/article.md');
});

test('searchVault with local:false gives null when the server is unreachable', async () => {
  const env = { VAULTOS_TERM_ID: 'a', VAULTOS_TERM_TOKEN: 'b', VAULTOS_HOOK_URL: 'http://127.0.0.1:9/api/term/agent' };
  assert.equal(await searchVault('x y z', {}, { env, vaultDir: '/nonexistent', local: false }), null);
});

test('vault-search prints a ranked block per hit', (t) => {
  const dir = vault(t);
  const r = cli(dir, ['safeguard', 'connection', '--kind', 'article', '--limit', '1']);
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^1\. Safeguard connection test {2,}\[article · 2026-10-01\]$/);
  assert.equal(lines[1].trim(), 'Work/1. iam/conn/article.md');
  assert.ok(lines[2].trim().startsWith('Safeguard tests each asset'));
  assert.ok(!r.stdout.includes('2. '));
});

test('vault-search --json, no-match and usage', (t) => {
  const dir = vault(t);
  const j = JSON.parse(cli(dir, ['safeguard', '--json', '--limit', '1']).stdout);
  assert.equal(j.length, 1);
  assert.ok(j[0].path && typeof j[0].score === 'number');
  const none = cli(dir, ['zzzunmatched']);
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), 'No matches.');
  assert.equal(cli(dir, []).status, 2);
  assert.equal(cli(dir, ['x', '--limit']).status, 2);
});

test('recall stays quiet for slash commands, short prompts and weak matches', async (t) => {
  const dir = vault(t);
  const opts = { vaultDir: dir, env: {} };
  assert.equal(await recall({ prompt: '/done safeguard connection test', cwd: dir }, opts), '');
  assert.equal(await recall({ prompt: 'fix it', cwd: dir }, opts), '');
  assert.equal(await recall({ prompt: 'plan the kitchen renovation budget', cwd: dir }, opts), '');
});

test('recall lists matching articles with a trimmed TL;DR', async (t) => {
  const dir = vault(t);
  const out = await recall({ prompt: 'why does the safeguard connection test fail', cwd: path.join(dir, 'Work') }, { vaultDir: dir, env: {} });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], '## Possibly relevant from the Knowledge Base (auto-recalled)');
  assert.ok(lines[1].startsWith('- **Safeguard connection test** — `Work/1. iam/conn/article.md` (updated 2026-10-01): '));
  const tldr = lines[1].split('(updated 2026-10-01): ')[1];
  assert.ok(tldr.length <= 300);
  assert.equal(lines[lines.length - 1], '_Open a file if it bears on the request; ignore these if not._');
  assert.ok(!out.includes('task.md'), 'articles only');
});

test('the recall hook script never fails a prompt', (t) => {
  const dir = vault(t);
  for (const stdin of ['not json', '', JSON.stringify({ prompt: 'safeguard connection test failing again', cwd: '/elsewhere' })]) {
    const r = hook(dir, stdin);
    assert.equal(r.status, 0, `stdin ${JSON.stringify(stdin)}`);
  }
  assert.equal(hook(dir, 'not json').stdout, '');
  assert.match(hook(dir, JSON.stringify({ prompt: 'safeguard connection test failing again', cwd: '/elsewhere' })).stdout, /Safeguard connection test/);
});
