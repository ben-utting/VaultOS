#!/usr/bin/env node
'use strict';
// vault-search <query…> [--kind article|task|note] [--board <name>] [--limit N] [--json]
// Ranked search of the vault for any agent: newer and curated (article) first.
const { searchVault } = require('../lib/search-client');

const USAGE = 'usage: vault-search <words…> [--kind article|task|note] [--board <name>] [--limit N] [--json]';

function parse(argv) {
  const words = [];
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--kind' || a === '--board' || a === '--limit') {
      const v = argv[++i];
      if (v === undefined) return null;
      if (a === '--limit') { opts.limit = Number(v); if (!(opts.limit >= 1)) return null; } else opts[a.slice(2)] = v;
      continue;
    }
    if (a === '-h' || a === '--help') return null;
    words.push(a);
  }
  return words.length ? { query: words.join(' '), opts, json } : null;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args) { console.error(USAGE); process.exit(2); }
  const results = await searchVault(args.query, { limit: 10, ...args.opts });
  if (args.json) { console.log(JSON.stringify(results, null, 2)); return; }
  if (!results.length) { console.log('No matches.'); return; }
  console.log(results.map((r, i) => [
    `${i + 1}. ${r.title}   [${r.kind} · ${r.date}]`,
    `   ${r.path}`,
    ...(r.snippet ? [`   ${r.snippet.length > 200 ? r.snippet.slice(0, 199) + '…' : r.snippet}`] : []),
  ].join('\n')).join('\n\n'));
}

main().catch((err) => { console.error(`vault-search: ${err.message || err}`); process.exit(1); });
