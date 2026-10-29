'use strict';
// The credential rules for relayed connectors: what Authorization to send for a stored sign-in, how an
// Atlassian OAuth sign-in is refreshed and when it is given up on. The service builds the relay targets on this.
// A stored record is { method: 'oauth', tokens, client } | { method: 'token', key } | { method: 'token', email, token }
// | { method: 'none' }. authorization() follows the Target contract in connector-relay.js: a string (a Bearer or Basic
// value, or '' for connected-with-no-credential), or null when not signed in.
const { CONNECTORS, baseFor } = require('./connectors');
const { serialised } = require('./connector-relay');

const REFRESH_WINDOW_MS = 60 * 1000;

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

function createRelayed({ store, env = process.env, fetch = globalThis.fetch, now = Date.now, oauth }) {
  const rec = (id) => store.get().connectors[id];
  const patch = (id, fn) => store.update((d) => { if (d.connectors[id]) fn(d.connectors[id]); });
  const upstream = (id) => baseFor(id, env);
  const mcpUrl = (id) => upstream(id).replace(/\/+$/, '') + CONNECTORS[id].mcpPath;

  let metaCache = null; // OAuth server metadata (Atlassian only)
  async function meta() {
    if (!metaCache) metaCache = await oauth.discover(upstream('atlassian'), { fetch });
    return metaCache;
  }

  const connectedRec = (r) => {
    if (!r) return false;
    if (r.method === 'oauth') return !!r.tokens;
    if (r.method === 'token') return !!(r.key || (r.email && r.token));
    return r.method === 'none';
  };
  const connected = (id) => connectedRec(rec(id));

  // The stored credential as an Authorization value: '' for none, null when absent or needing a new sign-in.
  // Only an OAuth sign-in can be marked as needing one; a token keeps being sent, so a good Test can clear it.
  function credentialFor(id) {
    const r = rec(id);
    if (!connectedRec(r) || (r.method === 'oauth' && r.needsSignIn)) return null;
    if (r.method === 'none') return '';
    if (r.method === 'token') return r.key ? `Bearer ${r.key}` : basic(r.email, r.token);
    return `Bearer ${r.tokens.access_token}`;
  }

  const markNeedsSignIn = (id) => patch(id, (r) => { if (connectedRec(r) && r.method !== 'none') r.needsSignIn = true; });

  // null only when the sign-in is unusable; a transient failure throws (see the Target contract in the relay).
  const doRefresh = serialised(async (rejected) => {
    const r = rec('atlassian');
    const stored = credentialFor('atlassian');
    if (!stored) return null;
    if (rejected && stored !== rejected) return stored; // someone refreshed first
    if (r.method !== 'oauth') return null;
    const started = r.tokens.refresh_token;
    if (!started) return null; // the server gave no refresh token: nothing to renew with
    const same = (x) => x && x.method === 'oauth' && x.tokens && x.tokens.refresh_token === started;
    let tokens;
    try {
      tokens = await oauth.refreshTokens(await meta(), { clientId: r.client.client_id, refreshToken: started, resource: mcpUrl('atlassian') }, { fetch, now });
    } catch (e) {
      if (e instanceof oauth.OAuthError && e.code === 'refresh-refused') {
        await patch('atlassian', (x) => { if (same(x)) x.needsSignIn = true; }); // a late result for an old sign-in is dropped
        return null;
      }
      throw e;
    }
    let applied = false;
    await patch('atlassian', (x) => { if (same(x)) { x.tokens = tokens; delete x.needsSignIn; applied = true; } });
    return applied ? `Bearer ${tokens.access_token}` : credentialFor('atlassian');
  });

  async function authorization(id) {
    const r = rec(id);
    if (id === 'atlassian' && r && r.method === 'oauth' && r.tokens && !r.needsSignIn && r.tokens.expires_at - now() <= REFRESH_WINDOW_MS) {
      const stored = credentialFor(id);
      if (!r.tokens.refresh_token) {
        if (r.tokens.expires_at > now()) return stored; // still valid; it cannot be renewed, so it runs out
        await markNeedsSignIn(id);
        return null;
      }
      try { return await doRefresh(stored); } catch (e) {
        // A failed early refresh costs nothing while the access token is still good.
        if (r.tokens.expires_at > now()) return stored;
        throw e;
      }
    }
    return credentialFor(id);
  }

  // Only an Atlassian OAuth sign-in can be renewed; for anything else the current credential is all there is.
  const renew = (id, rejected) => (id === 'atlassian' ? doRefresh(rejected) : Promise.resolve(credentialFor(id) === rejected ? null : credentialFor(id)));

  // 'expired' while a sign-in record exists but is unusable, 'not-connected' when there is none (and for a connector that needs none).
  const missing = (id) => { const r = rec(id); return connectedRec(r) && r.method !== 'none' ? 'expired' : 'not-connected'; };

  return { authorization, renew, markNeedsSignIn, missing, connected, credentialFor, mcpUrl, meta, upstream };
}

module.exports = { createRelayed, basic };
