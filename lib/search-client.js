'use strict';
// How `vault-search` and the recall hook run a search. Inside a VaultOS terminal
// they ask the server, whose index is already warm (a cold walk of a vault on a
// network share takes seconds). Anywhere else, or if the server says no, the CLI
// reads the vault itself; the hook passes local:false and gets null instead,
// because a prompt must never wait on a cold walk.
const { createIndex } = require('./search');

const SERVER_TIMEOUT_MS = 3000;

function searchUrl(env) {
  if (!env.VAULTOS_HOOK_URL || !env.VAULTOS_TERM_ID || !env.VAULTOS_TERM_TOKEN) return null;
  try { return new URL('/api/term/search', env.VAULTOS_HOOK_URL).href; } catch { return null; }
}

async function askServer(url, env, query, opts) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: env.VAULTOS_TERM_ID, token: env.VAULTOS_TERM_TOKEN, q: query, ...opts }),
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.results) ? body.results : null;
  } catch {
    return null;
  }
}

// Results as lib/search.js returns them, or null (local:false and no server answer).
async function searchVault(query, opts = {}, { env = process.env, vaultDir = env.VAULT_DIR || '/vault', local = true } = {}) {
  const url = searchUrl(env);
  const viaServer = url ? await askServer(url, env, query, opts) : null;
  if (viaServer) return viaServer;
  if (!local) return null;
  return createIndex(vaultDir).search(query, opts);
}

module.exports = { searchVault };
