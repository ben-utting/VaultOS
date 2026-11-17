'use strict';
// The credential rules for relayed connectors: what Authorization to send for a stored sign-in, and when one is given
// up on. An OAuth sign-in's refresh is its connector's own (connector-signin.js, passed in as signIns[id]). The service
// builds the relay targets on this.
// A stored record is { method: 'oauth', tokens, client, resource } | { method: 'token', key }
// | { method: 'token', email, token } | { method: 'none' }. Atlassian OAuth goes to its v2 server and API tokens to v1
// (see connectors.js); an OAuth record whose `resource` is not v2's (every one made before v2) holds v1 tokens and is
// never sent anywhere. authorization() follows the Target contract in connector-relay.js: a string (a Bearer or Basic
// value, or '' for connected-with-no-credential), or null when not signed in.
const { CONNECTORS, baseFor } = require('./connectors');

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

function createRelayed({ store, env = process.env, signIns = {} }) {
  const rec = (id) => store.get().connectors[id];
  const patch = (id, fn) => store.update((d) => { if (d.connectors[id]) fn(d.connectors[id]); });
  const upstream = (id) => baseFor(id, env);
  const mcpUrl = (id) => upstream(id).replace(/\/+$/, '') + CONNECTORS[id].mcpPath;
  // Where a sign-in made with `method` is sent: an API token may have an address of its own.
  const urlFor = (id, method = (rec(id) || {}).method) => (method === 'token' && CONNECTORS[id].tokenMcpPath
    ? upstream(id).replace(/\/+$/, '') + CONNECTORS[id].tokenMcpPath : mcpUrl(id));
  // An Atlassian OAuth sign-in for some other server than today's (one from before its v2): it needs a new sign-in.
  const stale = (id, r) => id === 'atlassian' && !!r && r.method === 'oauth' && !!r.tokens && r.resource !== mcpUrl('atlassian');

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
    if (!connectedRec(r) || (r.method === 'oauth' && (r.needsSignIn || stale(id, r)))) return null;
    if (r.method === 'none') return '';
    if (r.method === 'token') return r.key ? `Bearer ${r.key}` : basic(r.email, r.token);
    return `Bearer ${r.tokens.access_token}`;
  }

  const markNeedsSignIn = (id) => patch(id, (r) => { if (connectedRec(r) && r.method !== 'none') r.needsSignIn = true; });

  // A usable OAuth sign-in is its connector's to renew; anything else is just the stored credential.
  async function authorization(id) {
    const r = rec(id);
    if (signIns[id] && r && r.method === 'oauth' && r.tokens && !r.needsSignIn && !stale(id, r)) return signIns[id].authorization(r);
    return credentialFor(id);
  }

  // Only an OAuth sign-in can be renewed; for anything else the current credential is all there is.
  const renew = (id, rejected) => {
    const r = rec(id);
    if (signIns[id] && r && r.method === 'oauth') return signIns[id].refresh(rejected);
    return Promise.resolve(credentialFor(id) === rejected ? null : credentialFor(id));
  };

  // 'expired' while a sign-in record exists but is unusable, 'not-connected' when there is none (and for a connector that needs none).
  const missing = (id) => { const r = rec(id); return connectedRec(r) && r.method !== 'none' ? 'expired' : 'not-connected'; };

  return { authorization, renew, markNeedsSignIn, missing, connected, credentialFor, mcpUrl, urlFor, stale, upstream };
}

module.exports = { createRelayed, basic };
