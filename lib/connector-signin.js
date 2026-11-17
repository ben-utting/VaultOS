'use strict';
// Browser sign-in for one relayed connector (Atlassian, Vantage): OAuth 2.1 with dynamic client registration and
// PKCE, the pending sign-ins, the code exchange, keeping the access token fresh, and revoking on sign-out.
// One instance per connector, so one connector's sign-in link can never finish another's. Tokens are never logged
// and never put in an error.
const { serialised } = require('./connector-relay');

const PENDING_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 60 * 1000;
const EXPIRED_LINK = 'This sign-in link has expired. Start again from VaultOS.';

// credentialFor/markNeedsSignIn come from connector-relayed (the credential rules for every method); stale(r) says a
// record can't be used with today's server (Atlassian's v1 sign-ins); notes holds the text a row shows after a sign-out.
function createSignIn({ id, label, store, fetch, now, oauth, ConnectorError, mcpUrl, credentialFor, markNeedsSignIn, stale = () => false, rootFallback = false, notes, test, sync }) {
  const rec = () => store.get().connectors[id];
  const patch = (fn) => store.update((d) => { if (d.connectors[id]) fn(d.connectors[id]); });
  const pending = oauth.createPending({ ttlMs: PENDING_MS, now });
  const newClients = new Map(); // redirect uri -> client registered by a sign-in not yet finished
  let pendingUntil = 0; // a sign-in was started and not yet finished

  let metaCache = null;
  async function meta() {
    if (!metaCache) metaCache = await oauth.discover(mcpUrl(), { fetch, rootFallback });
    return metaCache;
  }

  async function start({ origin, nonce }) {
    const redirectUri = `${origin}/api/connectors/${id}/callback`;
    let m, client;
    try {
      m = await meta();
      // A client belongs to the server that registered it: one from another server (no issuer, or a different one) is registered again.
      const usable = (c) => (c && c.redirect_uri === redirectUri && c.issuer === m.issuer ? c : null);
      client = usable(rec() && rec().client) || usable(newClients.get(redirectUri));
      if (!client) {
        client = await oauth.registerClient(m, redirectUri, { fetch });
        newClients.set(redirectUri, client); // kept in memory only: the live session still uses the stored client
      }
    } catch (e) {
      if (e instanceof oauth.OAuthError && e.code === 'redirect-refused') {
        throw new ConnectorError(`${label} didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost.`);
      }
      throw new ConnectorError(`Couldn't reach ${label} to start sign-in. Try again, or use an API token.`);
    }
    const { verifier, challenge } = oauth.pkcePair();
    const state = pending.add(nonce, { verifier, redirectUri, client });
    pendingUntil = now() + PENDING_MS;
    return { url: oauth.authorizeUrl(m, { clientId: client.client_id, redirectUri, state, challenge, resource: m.resource }) };
  }

  // Cancel in the pane: this session's pending sign-ins go, and so does the client registered for them (kept in memory
  // only), so the row stops saying "connecting" unless another session is still waiting.
  async function cancel({ nonce }) {
    for (const d of pending.drop(nonce)) {
      const stored = rec() && rec().client;
      if (!stored || stored.client_id !== d.client.client_id) newClients.delete(d.redirectUri);
    }
    if (!pending.size()) pendingUntil = 0;
    return {};
  }

  async function callback({ code, state, iss, nonce }) {
    const data = pending.take(nonce, state);
    if (!data) throw new ConnectorError(EXPIRED_LINK);
    let tokens, m;
    try {
      m = await meta();
    } catch {
      if (!pending.size()) pendingUntil = 0;
      throw new ConnectorError(`${label} didn't finish the sign-in. Start again from VaultOS.`);
    }
    if (!oauth.issOk(m, iss)) { // RFC 9207: the answer came from another server than the one the sign-in started with
      if (!pending.size()) pendingUntil = 0;
      throw new ConnectorError(EXPIRED_LINK);
    }
    try {
      tokens = await oauth.exchangeCode(m, { clientId: data.client.client_id, redirectUri: data.redirectUri, code, verifier: data.verifier, resource: m.resource }, { fetch, now });
    } catch {
      if (!pending.size()) pendingUntil = 0;
      throw new ConnectorError(`${label} didn't finish the sign-in. Start again from VaultOS.`);
    }
    newClients.clear();
    delete notes[id];
    await store.update((d) => {
      const r = (d.connectors[id] ||= {});
      r.method = 'oauth'; r.tokens = tokens; r.client = data.client; r.resource = m.resource;
      delete r.email; delete r.token; delete r.key; delete r.needsSignIn;
    });
    pendingUntil = 0; // only now: the option cards must not flash back while the exchange, test and sync run
    await test(id);
    await sync();
  }

  // null only when the sign-in is unusable; a transient failure throws (see the Target contract in the relay).
  const refresh = serialised(async (rejected) => {
    const r = rec();
    const stored = credentialFor(id);
    if (!stored) return null;
    if (rejected && stored !== rejected) return stored; // someone refreshed first, or the sign-in changed
    if (r.method !== 'oauth') return null;
    const started = r.tokens.refresh_token;
    if (!started) return null; // the server gave no refresh token: nothing to renew with
    const same = (x) => x && x.method === 'oauth' && x.tokens && x.tokens.refresh_token === started;
    let tokens;
    try {
      const m = await meta();
      tokens = await oauth.refreshTokens(m, { clientId: r.client.client_id, refreshToken: started, resource: r.resource || m.resource }, { fetch, now });
    } catch (e) {
      if (e instanceof oauth.OAuthError && e.code === 'refresh-refused') {
        await patch((x) => { if (same(x)) x.needsSignIn = true; }); // a late result for an old sign-in is dropped
        return null;
      }
      throw e;
    }
    let applied = false;
    await patch((x) => { if (same(x)) { x.tokens = tokens; delete x.needsSignIn; applied = true; } });
    return applied ? `Bearer ${tokens.access_token}` : credentialFor(id);
  });

  // For a usable OAuth record: the access token, renewed first when it runs out within a minute.
  async function authorization(r) {
    if (r.tokens.expires_at - now() > REFRESH_WINDOW_MS) return credentialFor(id);
    const stored = credentialFor(id);
    if (!r.tokens.refresh_token) {
      if (r.tokens.expires_at > now()) return stored; // still valid; it cannot be renewed, so it runs out
      await markNeedsSignIn(id);
      return null;
    }
    try { return await refresh(stored); } catch (e) {
      // A failed early refresh costs nothing while the access token is still good.
      if (r.tokens.expires_at > now()) return stored;
      throw e;
    }
  }

  // Best effort: true when the server accepted it (or there was nothing to revoke). Never throws.
  async function revoke(r) {
    if (!r || r.method !== 'oauth' || !r.tokens || !r.client) return true;
    if (stale(r)) return true; // tokens from another server: never sent to this one; they run out
    try { return await oauth.revoke(await meta(), { clientId: r.client.client_id, token: r.tokens.refresh_token }, { fetch }); } catch { return false; }
  }

  return { start, cancel, callback, refresh, authorization, revoke, connecting: () => now() < pendingUntil, reset: () => { pendingUntil = 0; } };
}

module.exports = { createSignIn, EXPIRED_LINK };
