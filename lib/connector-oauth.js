'use strict';
// OAuth 2.1 client for the hosted Atlassian MCP server: discovery, dynamic
// client registration (public client), PKCE S256, code exchange, refresh,
// revoke, and a short-lived store of pending sign-ins. Tokens are never logged
// and never put in error messages.
const crypto = require('node:crypto');

class OAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'OAuthError'; this.code = code; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

const TIMEOUT_MS = 20000;
// Every request has a deadline; a timeout is a failure of the request like any other (a 'network' one for a refresh).
async function call(fetchFn, code, url, init) {
  try { return await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new OAuthError(code, `request failed: ${timedOut ? 'timed out' : e && e.message ? e.message : 'network error'}`);
  }
}
const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
const readText = async (res) => { try { return await res.text(); } catch { return ''; } };

// RFC 9728 / RFC 8414: the well-known document goes between the host and the path of the address it describes.
function wellKnown(address, name) {
  const u = new URL(address);
  const p = u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/${name}${p}`;
}
const sameAddress = (a, b) => typeof a === 'string' && a.replace(/\/+$/, '') === String(b).replace(/\/+$/, '');

async function fetchJson(fetchFn, url, what) {
  const res = await call(fetchFn, 'discovery', url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new OAuthError('discovery', `${what} request answered ${res.status}`);
  const body = await readJson(res);
  if (!body || typeof body !== 'object') throw new OAuthError('discovery', `${what} is not JSON`);
  return body;
}

// From the MCP server's address: its resource metadata names the authorization server, whose own metadata has the
// endpoints. Each document must be about what was asked for. A connector that asks (rootFallback: Vantage, whose
// path-specific resource metadata sits behind a challenge page) reads the root one instead when the path one answered
// with a refusal (4xx) or something that isn't JSON, as the MCP spec allows; the root one must name the origin. Never on
// a network failure, a timeout or a 5xx: one blip must not pin another server's metadata in the cache. The result is that metadata plus `scopes` (asked for in full at sign-in, as the MCP spec says when the
// server names none) and `resource`, the identifier the metadata names, which sign-in sends as RFC 8707's resource.
async function discover(resource, { fetch = globalThis.fetch, rootFallback = false } = {}) {
  const plain = /^http:/i.test(String(resource)); // only a resource that is itself http (the test fake) may name http addresses
  const isHttps = (v) => { try { const p = new URL(v).protocol; return p === 'https:' || (plain && p === 'http:'); } catch { return false; } };
  const origin = new URL(resource).origin;
  const pathUrl = wellKnown(resource, 'oauth-protected-resource');
  const rootUrl = `${origin}/.well-known/oauth-protected-resource`;
  const mayFallBack = rootFallback && pathUrl !== rootUrl;
  let prm = null;
  const res = await call(fetch, 'discovery', pathUrl, { headers: { accept: 'application/json' } });
  if (res.ok) {
    const body = await readJson(res);
    if (body && typeof body === 'object') prm = body;
    else if (!mayFallBack) throw new OAuthError('discovery', 'resource metadata is not JSON');
  } else {
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* already closed */ }
    if (!(mayFallBack && res.status >= 400 && res.status < 500)) throw new OAuthError('discovery', `resource metadata request answered ${res.status}`);
  }
  if (prm) {
    if (!sameAddress(prm.resource, resource)) throw new OAuthError('discovery', 'resource metadata is for another server');
  } else {
    prm = await fetchJson(fetch, rootUrl, 'resource metadata');
    if (!sameAddress(prm.resource, origin)) throw new OAuthError('discovery', 'resource metadata is for another server');
  }
  const issuer = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : null;
  if (typeof issuer !== 'string' || !issuer) throw new OAuthError('discovery', 'no authorization server');
  if (!isHttps(issuer)) throw new OAuthError('discovery', 'the authorization server is not an https address');
  const meta = await fetchJson(fetch, wellKnown(issuer, 'oauth-authorization-server'), 'metadata');
  if (!sameAddress(meta.issuer, issuer)) throw new OAuthError('discovery', 'metadata is for another issuer');
  if (!meta.registration_endpoint) throw new OAuthError('discovery', 'no registration endpoint');
  if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes('S256')) {
    throw new OAuthError('discovery', 'S256 is not offered');
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
    if (meta[k] === undefined) continue;
    if (!isHttps(meta[k])) throw new OAuthError('discovery', `${k} is not an https address`);
  }
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((v) => typeof v === 'string' && /^\S+$/.test(v)) : [];
  return { ...meta, scopes, resource: prm.resource };
}

// RFC 9207: an authorization server that names itself in the redirect must be the one the sign-in started with.
const issOk = (meta, iss) => iss === undefined || iss === null || iss === '' || sameAddress(String(iss), meta.issuer);

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
  return { client_id: body.client_id, redirect_uri: redirectUri, issuer: meta.issuer };
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function authorizeUrl(meta, { clientId, redirectUri, state, challenge, resource }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (resource) u.searchParams.set('resource', resource); // RFC 8707: the MCP server this token is for
  if (Array.isArray(meta.scopes) && meta.scopes.length) u.searchParams.set('scope', meta.scopes.join(' '));
  return u.toString();
}

function toTokens(body, now, fallbackRefresh) {
  if (!body || !body.access_token) return null;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || fallbackRefresh,
    expires_at: now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
  };
}

async function exchangeCode(meta, { clientId, redirectUri, code, verifier, resource }, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const res = await call(fetch, 'exchange', meta.token_endpoint, {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: clientId, redirect_uri: redirectUri, ...(resource ? { resource } : {}) }).toString(),
  });
  if (!res.ok) throw new OAuthError('exchange', `code exchange answered ${res.status}`);
  const tokens = toTokens(await readJson(res), now);
  if (!tokens) throw new OAuthError('exchange', 'code exchange returned no access token');
  return tokens;
}

async function refreshTokens(meta, { clientId, refreshToken, resource }, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const res = await call(fetch, 'network', meta.token_endpoint, {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...(resource ? { resource } : {}) }).toString(),
  });
  // Only an answer that says "this refresh token is no good" (400/401) ends the sign-in. A busy or broken server
  // (408, 429, 5xx, or a 400 that names a temporary fault) is a blip: the sign-in stays and the next call tries again.
  if (!res.ok) {
    const err = res.status === 400 || res.status === 401 ? (await readJson(res) || {}).error : null;
    const transient = err === 'temporarily_unavailable' || err === 'server_error';
    if ((res.status !== 400 && res.status !== 401) || transient) throw new OAuthError('network', `refresh answered ${res.status}`);
    throw new OAuthError('refresh-refused', `refresh answered ${res.status}`);
  }
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    // Forgets every sign-in this nonce started; answers their data. size() is what is still waiting.
    drop(nonce) {
      const out = [];
      for (const [k, v] of map) if (v.nonce === nonce) { out.push(v.data); map.delete(k); }
      return out;
    },
    size() { sweep(); return map.size; },
  };
}

module.exports = { OAuthError, discover, registerClient, pkcePair, authorizeUrl, exchangeCode, refreshTokens, revoke, createPending, issOk };
