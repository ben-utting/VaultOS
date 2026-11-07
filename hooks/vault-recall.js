'use strict';
// Claude Code UserPromptSubmit hook: before the agent answers, add the Knowledge
// Base articles that best match the prompt. Silent unless a match is good (half
// the prompt's meaningful words), and it can never block or fail a prompt: any
// problem means it prints nothing and exits 0. Runs in place from the app's
// hooks/ folder, so it uses the app's own lib/.
const path = require('node:path');
const { tokenize } = require('../lib/search');
const { searchVault } = require('../lib/search-client');

const MIN_TOKENS = 3;
const TLDR_MAX = 300;

async function recall({ prompt, cwd } = {}, { env = process.env, vaultDir = env.VAULT_DIR || '/vault' } = {}) {
  const text = String(prompt || '').trim();
  if (!text || text.startsWith('/') || tokenize(text).length < MIN_TOKENS) return '';
  const rel = cwd ? path.relative(vaultDir, String(cwd)) : '';
  const board = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : undefined;
  // In a VaultOS terminal only the warm server index is fast enough to wait on;
  // outside one (no terminal token) there is no server, so read the vault directly.
  const local = !env.VAULTOS_TERM_TOKEN;
  const hits = await searchVault(text, { kind: 'article', board, limit: 3, minCoverage: 0.5 }, { env, vaultDir, local });
  if (!hits || !hits.length) return '';
  const clip = (s) => (s.length > TLDR_MAX ? s.slice(0, TLDR_MAX - 1) + '…' : s);
  return [
    '## Possibly relevant from the Knowledge Base (auto-recalled)',
    ...hits.map((h) => `- **${h.title}** — \`${h.path}\` (updated ${h.date}): ${clip(h.snippet || '')}`),
    '_Open a file if it bears on the request; ignore these if not._',
    '',
  ].join('\n');
}

module.exports = { recall };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', async () => {
    try { process.stdout.write(await recall(JSON.parse(input))); } catch { /* say nothing */ }
    process.exit(0);
  });
}
