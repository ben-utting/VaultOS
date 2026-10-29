'use strict';
// The one module that knows the connector rules. server.js is a thin layer of routes over it,
// and Settings renders view(). It composes the catalogue, store, OAuth client, relay target,
// agent writers and Azure helpers; it does none of their work itself.
const { CONNECTORS, PLANNED, baseFor, entryFor } = require('./connectors');
const { createStore } = require('./connector-store');
const oauth = require('./connector-oauth');
const { messages, serialised, mcpProbe } = require('./connector-relay');
const { claudeWriter, cursorWriter, syncAgents } = require('./connector-agents');
const azure = require('./connector-azure');
const { PROFILES, isInstalled } = require('./agents');

const EXPIRED_LINK = 'This sign-in link has expired. Start again from VaultOS.';
const REDIRECT_REFUSED = "Atlassian didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost.";
const PENDING_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 60 * 1000;
const CALLBACK = '/api/connectors/atlassian/callback';
const AGENT_LABEL = { claude: 'Claude Code', cursor: 'Cursor CLI' };

// Only a ConnectorError carries a message written for the person; the routes answer anything else generically.
class ConnectorError extends Error {}

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

function createConnectorService({
  home, port, env = process.env, fetch = globalThis.fetch, run = azure.runCapture, spawn, now = Date.now,
  installedAgents = async () => [],
}) {
  const store = createStore({ home, now });
  const pending = oauth.createPending({ ttlMs: PENDING_MS, now });
  const login = azure.createDeviceLogin({ spawn, now });
  const label = (id) => CONNECTORS[id].label;
  const upstream = () => baseFor('atlassian', env);
  const mcpUrl = () => upstream().replace(/\/+$/, '') + CONNECTORS.atlassian.mcpPath;
  const rec = (id) => store.get().connectors[id];
  const patch = (id, fn) => store.update((d) => { if (d.connectors[id]) fn(d.connectors[id]); });

  let metaCache = null;
  let pendingUntil = 0; // an Atlassian sign-in was started and not yet finished
  const newClients = new Map(); // redirect uri -> client registered by a sign-in not yet finished
  let azureFoldError = null;
  let agentResults = {};
  let azureSubs = null;
  const notes = {}; // text kept after a record is deleted (a failed revoke)

  async function meta() {
    if (!metaCache) metaCache = await oauth.discover(upstream(), { fetch });
    return metaCache;
  }

  // ----- Atlassian credential -----
  const atlassianConnected = (r) => !!r && ((r.method === 'oauth' && !!r.tokens) || (r.method === 'token' && !!(r.key || (r.email && r.token))));
  const azureConnected = (r) => !!r && !!r.account;
  const connected = (id) => (id === 'atlassian' ? atlassianConnected(rec(id)) : azureConnected(rec(id)));

  function currentAuth(r) {
    if (!atlassianConnected(r) || (r.method === 'oauth' && r.needsSignIn)) return null;
    if (r.method === 'token') return r.key ? `Bearer ${r.key}` : basic(r.email, r.token);
    return `Bearer ${r.tokens.access_token}`;
  }

  const markNeedsSignIn = () => patch('atlassian', (r) => { r.needsSignIn = true; });

  // null only when the sign-in is unusable; a transient failure throws (see the Target contract in the relay).
  const doRefresh = serialised(async (rejected) => {
    const r = rec('atlassian');
    const stored = currentAuth(r);
    if (!stored) return null;
    if (rejected && stored !== rejected) return stored; // someone refreshed first
    if (r.method !== 'oauth') return null;
    const started = r.tokens.refresh_token;
    const same = (x) => x && x.method === 'oauth' && x.tokens && x.tokens.refresh_token === started;
    let tokens;
    try {
      tokens = await oauth.refreshTokens(await meta(), { clientId: r.client.client_id, refreshToken: started }, { fetch, now });
    } catch (e) {
      if (e instanceof oauth.OAuthError && e.code === 'refresh-refused') {
        await patch('atlassian', (x) => { if (same(x)) x.needsSignIn = true; }); // a late result for an old sign-in is dropped
        return null;
      }
      throw e;
    }
    let applied = false;
    await patch('atlassian', (x) => { if (same(x)) { x.tokens = tokens; delete x.needsSignIn; applied = true; } });
    return applied ? `Bearer ${tokens.access_token}` : currentAuth(rec('atlassian'));
  });

  async function atlassianAuthorization() {
    const r = rec('atlassian');
    if (r && r.method === 'oauth' && r.tokens && !r.needsSignIn && r.tokens.expires_at - now() <= REFRESH_WINDOW_MS) {
      return doRefresh(currentAuth(r));
    }
    return currentAuth(rec('atlassian'));
  }

  function relayTarget(id) {
    if (id !== 'atlassian') return null;
    return {
      label: label(id),
      url: mcpUrl(),
      authorization: atlassianAuthorization,
      renew: (rejected) => doRefresh(rejected),
      markNeedsSignIn() {
        patch('atlassian', (r) => { if (atlassianConnected(r)) r.needsSignIn = true; }).catch(() => {});
      },
      missing: () => (atlassianConnected(rec('atlassian')) ? 'expired' : 'not-connected'),
    };
  }

  // ----- tests -----
  const textOf = (res) => {
    const part = res && Array.isArray(res.content) ? res.content.find((c) => c && typeof c.text === 'string') : null;
    try { return part ? JSON.parse(part.text) : null; } catch { return null; }
  };

  async function identify(probe) {
    const out = {};
    try {
      const u = textOf(await probe.call('atlassianUserInfo'));
      const email = u && (u.email || u.account_email);
      if (typeof email === 'string') out.account = email;
    } catch { /* best effort */ }
    try {
      const sites = textOf(await probe.call('getAccessibleAtlassianResources'));
      const url = Array.isArray(sites) && sites[0] && sites[0].url;
      if (typeof url === 'string') out.site = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    } catch { /* best effort */ }
    return out;
  }

  const stamp = (r) => ({ at: new Date(now()).toISOString(), ...r });

  async function testAtlassian() {
    const target = relayTarget('atlassian');
    const record = (lastTest, fn) => patch('atlassian', (r) => { r.lastTest = lastTest; if (fn) fn(r); }).then(() => lastTest);
    let first;
    try { first = await target.authorization(); } catch (e) {
      return record(stamp({ ok: false, tools: 0, error: "Couldn't reach Atlassian. Try again in a moment." }));
    }
    if (!first) return record(stamp({ ok: false, tools: 0, error: messages.expired(label('atlassian')) }), (r) => { r.needsSignIn = true; });
    let used = first;
    const authFn = async () => { used = await target.authorization(); return used; };
    let probe = await mcpProbe(mcpUrl(), authFn, { fetch });
    const is401 = (p) => !p.ok && /answered 401/.test(p.error);
    let lost = false;
    if (is401(probe)) {
      if (rec('atlassian').method === 'oauth') {
        let fresh = null;
        try { fresh = await target.renew(used); } catch { /* transient: not a lost sign-in */ lost = null; }
        if (fresh) { probe = await mcpProbe(mcpUrl(), fresh, { fetch }); lost = is401(probe); } else if (lost !== null) lost = true;
      } else lost = true;
    }
    const info = probe.ok ? await identify(probe) : {};
    return record(stamp({ ok: probe.ok, tools: probe.ok ? probe.tools.length : 0, error: probe.ok ? null : probe.error }), (r) => {
      if (probe.ok) { delete r.needsSignIn; if (info.account) r.account = info.account; if (info.site) r.site = info.site; }
      else if (lost) r.needsSignIn = true;
    });
  }

  async function testAzure() {
    const res = await azure.testAzure({ run });
    const acct = res.ok ? await azure.account({ run }) : null;
    const lastTest = stamp({ ok: res.ok, tools: null, error: res.ok ? null : res.error });
    await patch('azure', (r) => {
      r.lastTest = lastTest;
      if (res.ok) { delete r.needsSignIn; if (acct && acct.user) r.account = acct.user; }
      else if (res.needsSignIn) r.needsSignIn = true;
    });
    return lastTest;
  }

  async function test(id) {
    if (!connected(id)) throw new ConnectorError(`${label(id)} isn't connected yet.`);
    return id === 'atlassian' ? testAtlassian() : testAzure();
  }

  // ----- Atlassian sign-in -----
  async function atlassianStart({ origin, nonce }) {
    const redirectUri = `${origin}${CALLBACK}`;
    let m, client;
    try {
      m = await meta();
      const stored = rec('atlassian') && rec('atlassian').client;
      client = (stored && stored.redirect_uri === redirectUri && stored) || newClients.get(redirectUri);
      if (!client) {
        client = await oauth.registerClient(m, redirectUri, { fetch });
        newClients.set(redirectUri, client); // kept in memory only: the live session still uses the stored client
      }
    } catch (e) {
      if (e instanceof oauth.OAuthError && e.code === 'redirect-refused') throw new ConnectorError(REDIRECT_REFUSED);
      throw new ConnectorError("Couldn't reach Atlassian to start sign-in. Try again, or use an API token.");
    }
    const { verifier, challenge } = oauth.pkcePair();
    const state = pending.add(nonce, { verifier, redirectUri, client });
    pendingUntil = now() + PENDING_MS;
    return { url: oauth.authorizeUrl(m, { clientId: client.client_id, redirectUri, state, challenge }) };
  }

  // Cancel in the pane: this session's pending sign-ins go, and so does the client registered for them (kept in memory
  // only), so view() stops saying "connecting" unless another session is still waiting.
  async function atlassianCancel({ nonce }) {
    for (const d of pending.drop(nonce)) {
      const stored = rec('atlassian') && rec('atlassian').client;
      if (!stored || stored.client_id !== d.client.client_id) newClients.delete(d.redirectUri);
    }
    if (!pending.size()) pendingUntil = 0;
    return {};
  }

  async function atlassianCallback({ code, state, nonce }) {
    const data = pending.take(nonce, state);
    if (!data) throw new ConnectorError(EXPIRED_LINK);
    pendingUntil = 0;
    let tokens;
    try {
      tokens = await oauth.exchangeCode(await meta(), { clientId: data.client.client_id, redirectUri: data.redirectUri, code, verifier: data.verifier }, { fetch, now });
    } catch {
      throw new ConnectorError("Atlassian didn't finish the sign-in. Start again from VaultOS.");
    }
    newClients.clear();
    delete notes.atlassian;
    await store.update((d) => {
      const r = (d.connectors.atlassian ||= {});
      r.method = 'oauth'; r.tokens = tokens; r.client = data.client;
      delete r.email; delete r.token; delete r.key; delete r.needsSignIn;
    });
    await test('atlassian');
    await sync();
  }

  async function revokeTokens(r) {
    if (!r || r.method !== 'oauth' || !r.tokens || !r.client) return true;
    try { return await oauth.revoke(await meta(), { clientId: r.client.client_id, token: r.tokens.refresh_token }, { fetch }); } catch { return false; }
  }

  async function atlassianToken(input) {
    const key = input && typeof input.key === 'string' ? input.key.trim() : '';
    const email = input && typeof input.email === 'string' ? input.email.trim() : '';
    const token = input && typeof input.token === 'string' ? input.token.trim() : '';
    if (!key && !(email && token)) throw new ConnectorError('Enter your email and API token, or a service account key.');
    const auth = key ? `Bearer ${key}` : basic(email, token);
    const probe = await mcpProbe(mcpUrl(), auth, { fetch });
    if (!probe.ok) throw new ConnectorError(probe.error);
    const info = await identify(probe);
    const prev = rec('atlassian'); // a copy: the store hands out clones
    delete notes.atlassian;
    await store.update((d) => {
      const r = (d.connectors.atlassian ||= {});
      delete r.tokens; delete r.needsSignIn; delete r.email; delete r.token; delete r.key; delete r.site; delete r.account;
      r.method = 'token';
      if (key) r.key = key; else { r.email = email; r.token = token; }
      r.account = info.account || (key ? undefined : email);
      if (info.site) r.site = info.site;
      r.lastTest = stamp({ ok: true, tools: probe.tools.length, error: null });
    });
    if (prev && prev.method === 'oauth') await revokeTokens(prev);
    await sync();
  }

  async function disconnect(id) {
    if (!CONNECTORS[id]) throw new ConnectorError(`Unknown connector: ${id}`);
    delete notes[id];
    if (id === 'atlassian') {
      const ok = await revokeTokens(rec(id));
      if (!ok) notes[id] = "Atlassian didn't confirm the sign-out. The sign-in may still be active there.";
      pendingUntil = 0;
    } else {
      login.cancel();
      azureFoldError = null;
      const res = await azure.logout({ run });
      if (res && res.code !== 0) notes[id] = "Azure didn't confirm the sign-out.";
      azureSubs = null;
    }
    await store.update((d) => { delete d.connectors[id]; });
    await sync();
  }

  // ----- Azure -----
  const azureStart = () => { azureFoldError = null; return login.start({ tenant: (rec('azure') || {}).tenant }); };

  // Never throws: a failure becomes an error on the Azure row and the login is reset so the person can start again.
  const foldLogin = serialised(async () => {
    if (login.status().status !== 'done') return;
    try {
      const acct = await azure.account({ run });
      if (!acct) throw new Error('az account show returned nothing');
      azureSubs = await azure.subscriptions({ run });
      await store.update((d) => {
        const r = (d.connectors.azure ||= {});
        r.method = 'device-code'; r.allowChanges = !!r.allowChanges; delete r.needsSignIn;
        r.account = acct.user; r.subscription = acct.subscriptionId; if (acct.tenantId) r.tenant = acct.tenantId;
      });
      azureFoldError = null; delete notes.azure;
      login.cancel();
      await test('azure');
      await sync();
    } catch (e) {
      login.cancel();
      if (!connected('azure')) azureFoldError = `Signed in, but VaultOS couldn't read your Azure account: ${(e && e.message) || 'unknown error'}`;
    }
  });

  async function azureStatus() {
    await foldLogin();
    const s = login.status();
    if (azureFoldError && !connected('azure')) return { status: 'failed', error: azureFoldError };
    if (s.status === 'idle' && connected('azure')) return { status: 'done' };
    return s;
  }
  const azureCancel = () => login.cancel();

  async function azureSettings({ allowChanges, subscription } = {}) {
    if (!connected('azure')) throw new ConnectorError("Azure isn't connected yet.");
    if (typeof subscription === 'string' && subscription) {
      const r = await azure.setSubscription(subscription, { run });
      if (!r || r.code !== 0) throw new ConnectorError("Azure didn't switch to that subscription.");
      await patch('azure', (x) => { x.subscription = subscription; });
      azureSubs = null;
    }
    if (typeof allowChanges === 'boolean') {
      await patch('azure', (x) => { x.allowChanges = allowChanges; });
      await sync();
    }
  }

  // ----- agents -----
  let syncQueue = Promise.resolve();
  async function doSync() {
    const s = store.get();
    const wanted = {};
    for (const id of Object.keys(CONNECTORS)) {
      if (connected(id)) wanted[id] = entryFor(id, { port, key: s.relayKey, home, allowChanges: !!(s.connectors.azure && s.connectors.azure.allowChanges) });
    }
    const installed = await installedAgents();
    const writers = [];
    if (installed.includes('claude')) writers.push(claudeWriter({ home, run }));
    if (installed.includes('cursor')) writers.push(cursorWriter({ home }));
    const res = await syncAgents({ wanted, writers, written: s.written });
    agentResults = res.agents;
    await store.update((d) => { for (const [a, w] of Object.entries(res.written)) d.written[a] = w; });
  }
  function sync() {
    const next = syncQueue.then(doSync);
    syncQueue = next.catch(() => {});
    return next;
  }

  // ----- view -----
  async function azureInstalled() {
    for (const name of CONNECTORS.azure.detect) if (!(await isInstalled({ detect: [name] }, { run }))) return false;
    return true;
  }

  function agentRows(id, installed) {
    const s = store.get();
    const rows = [];
    for (const a of ['claude', 'cursor']) {
      const base = { id: a, label: AGENT_LABEL[a] };
      if (!installed.includes(a)) { rows.push({ ...base, chip: 'Not installed' }); continue; }
      const res = agentResults[a];
      if (!connected(id) || !res) { rows.push({ ...base, chip: null }); continue; }
      if (!res.ok) { rows.push({ ...base, chip: null, note: res.error }); continue; }
      const parts = [];
      let chip = null;
      if (res.foreign.includes(id)) {
        chip = 'Has its own entry';
        parts.push(`${base.label} already has its own \`${id}\` entry. Remove it to let VaultOS manage it.`);
      } else if ((s.written[a] || {})[id]) chip = 'Added';
      const folders = (res.perFolder || {})[id];
      if (folders && folders.length) parts.push(`Claude Code also has per-folder \`${id}\` entries in: ${folders.join(', ')}.`);
      rows.push({ ...base, chip, ...(parts.length ? { note: parts.join(' ') } : {}) });
    }
    if (installed.includes('pi')) rows.push({ id: 'pi', label: PROFILES.pi.label, chip: 'No connectors in Pi' });
    return rows;
  }

  async function view() {
    await foldLogin();
    const installed = await installedAgents();
    const s = store.get();
    const connecting = now() < pendingUntil;
    const out = [];
    for (const id of Object.keys(CONNECTORS)) {
      const c = CONNECTORS[id];
      const r = s.connectors[id];
      const v = { id, label: c.label, by: c.by, kind: c.kind };
      const on = connected(id);
      let state = on ? 'connected' : 'not-connected';
      let error = on ? undefined : notes[id];
      if (on) {
        v.method = r.method;
        if (r.account) v.account = r.account;
        if (r.lastTest) v.lastTest = r.lastTest;
        if (r.needsSignIn) state = 'needs-sign-in';
        else if (r.lastTest && !r.lastTest.ok) { state = 'error'; error = r.lastTest.error || 'The last test failed.'; }
      }
      if (id === 'atlassian') {
        v.tokenHelp = c.tokenHelp;
        if (on && r.site) v.site = r.site;
        if (connecting && state !== 'connected' && state !== 'error') state = 'connecting';
      } else {
        const ls = login.status();
        if (!(await azureInstalled())) { state = 'not-installed'; v.install = c.install; }
        else if (ls.status === 'waiting' && state !== 'connected') state = 'connecting';
        else if (!on && azureFoldError) error = azureFoldError;
        else if (ls.status === 'failed' && !on) error = ls.error;
        if (on) {
          v.allowChanges = !!r.allowChanges;
          v.subscription = r.subscription;
          azureSubs = azureSubs || await azure.subscriptions({ run });
          v.subscriptions = azureSubs.map(({ id: sid, name }) => ({ id: sid, name }));
        }
      }
      v.state = state;
      if (error) v.error = error;
      v.agents = agentRows(id, installed);
      out.push(v);
    }
    return { connectors: out, planned: PLANNED, reset: store.wasReset() };
  }

  async function init() {
    await store.load();
    await sync();
  }

  const needsAttention = () => Object.values(store.get().connectors).some((r) => r && r.needsSignIn);

  return {
    init, view, relayTarget, relayKey: () => store.get().relayKey, atlassianStart, atlassianCancel, atlassianCallback, atlassianToken, test, disconnect,
    azureStart, azureStatus, azureCancel, azureSettings, sync, needsAttention,
  };
}

module.exports = { createConnectorService, ConnectorError };
