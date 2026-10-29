'use strict';
// OAuth 2.1 client for the hosted Atlassian MCP server: discovery, dynamic
// client registration (public client), PKCE S256, code exchange, refresh,
// revoke, and a short-lived store of pending sign-ins. Tokens are never logged
// and never put in error messages.
const crypto = require('node:crypto');
const { CONNECTORS } = require('./connectors');

class OAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'OAuthError'; this.code = code; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

async function call(fetchFn, code, url, init) {
  try { return await fetchFn(url, init); } catch (e) {
    throw new OAuthError(code, `request failed: ${e && e.message ? e.message : 'network error'}`);
  }
}
const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
const readText = async (res) => { try { return await res.text(); } catch { return ''; } };

async function discover(base, { fetch = globalThis.fetch } = {}) {
  const url = String(base).replace(/\/+$/, '') + CONNECTORS.atlassian.metadataPath;
  const res = await call(fetch, 'discovery', url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new OAuthError('discovery', `metadata request answered ${res.status}`);
  const meta = await readJson(res);
  if (!meta || typeof meta !== 'object') throw new OAuthError('discovery', 'metadata is not JSON');
  if (!meta.registration_endpoint) throw new OAuthError('discovery', 'no registration endpoint');
  if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes('S256')) {
    throw new OAuthError('discovery', 'S256 is not offered');
  }
  return meta;
}

async function registerClient(meta, redirectUri, { fetch = globalThis.fetch } = {}) {
  const res = await call(fetch, 'register', meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'VaultOS',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const text = await readText(res);
    if (res.status === 400 && /redirect/i.test(text)) throw new OAuthError('redirect-refused', 'the redirect address was refused');
    throw new OAuthError('register', `registration answered ${res.status}`);
  }
  const body = await readJson(res);
  if (!body || !body.client_id) throw new OAuthError('register', 'registration returned no client_id');
  return { client_id: body.client_id, redirect_uri: redirectUri };
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function authorizeUrl(meta, { clientId, redirectUri, state, challenge }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function toTokens(body, now, fallbackRefresh) {
  if (!body || !body.access_token) return null;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || fallbackRefresh,
    expires_at: now() + (Number(body.expires_in) || 0) * 1000,
  };
}

async function exchangeCode(meta, { clientId, redirectUri, code, verifier }, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const res = await call(fetch, 'exchange', meta.token_endpoint, {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: clientId, redirect_uri: redirectUri }).toString(),
  });
  if (!res.ok) throw new OAuthError('exchange', `code exchange answered ${res.status}`);
  const tokens = toTokens(await readJson(res), now);
  if (!tokens) throw new OAuthError('exchange', 'code exchange returned no access token');
  return tokens;
}

async function refreshTokens(meta, { clientId, refreshToken }, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const res = await call(fetch, 'network', meta.token_endpoint, {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  if (!res.ok) throw new OAuthError('refresh-refused', `refresh answered ${res.status}`);
  const tokens = toTokens(await readJson(res), now, refreshToken);
  if (!tokens) throw new OAuthError('refresh-refused', 'refresh returned no access token');
  return tokens;
}

// Best effort: true when the server accepted it, false otherwise. Never throws.
async function revoke(meta, { clientId, token }, { fetch = globalThis.fetch } = {}) {
  const endpoint = meta.revocation_endpoint || meta.token_endpoint;
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: FORM,
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
    });
    return !!res.ok;
  } catch { return false; }
}

function createPending({ ttlMs = 600000, now = Date.now } = {}) {
  const map = new Map();
  const sweep = () => { const t = now(); for (const [k, v] of map) if (v.expires <= t) map.delete(k); };
  return {
    add(nonce, data) {
      sweep();
      const state = b64url(crypto.randomBytes(16));
      map.set(state, { nonce, data, expires: now() + ttlMs });
      return state;
    },
    take(nonce, state) {
      const e = map.get(state);
      if (!e) return null;
      if (e.expires <= now()) { map.delete(state); return null; }
      if (e.nonce !== nonce) return null;
      map.delete(state);
      return e.data;
    },
  };
}

module.exports = { OAuthError, discover, registerClient, pkcePair, authorizeUrl, exchangeCode, refreshTokens, revoke, createPending };
