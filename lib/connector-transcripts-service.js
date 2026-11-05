'use strict';
// The Teams transcripts connector's glue for connector-service.js: the app sign-in (device code), the saved
// refresh token, the MCP server over Graph, and the fold that follows a finished sign-in.
// Tokens live in the store record (refresh) and in memory (access); neither reaches a view, a log or an agent.
const { createMsApp, isGuid, MsAppError } = require('./connector-msapp');
const { createTranscripts } = require('./connector-transcripts');
const { serialised } = require('./connector-relay');

const ID = 'transcripts';

function createTranscriptsService({ store, env, fetch, now, sleep, ConnectorError, stamp, sync }) {
  const rec = () => store.get().connectors[ID];
  const patch = (fn) => store.update((d) => { if (d.connectors[ID]) fn(d.connectors[ID]); });
  const sameIds = (r, ids) => !!r && r.tenantId === ids.tenantId && r.clientId === ids.clientId;

  let active = null; // signed in (or restored): the one tools use
  let candidate = null; // a sign-in in progress; it replaces `active` only once it completes
  let inFold = false;
  const cur = () => active;

  function makeApp(ids) {
    const app = createMsApp({
      fetch, now, ...(sleep ? { sleep } : {}),
      authority: env.CONNECTOR_UPSTREAM_TRANSCRIPTS_LOGIN || undefined,
      onRefreshToken: async (refreshToken) => {
        if (candidate === app) {
          // the new sign-in's first token: it replaces whatever was saved
          await store.update((d) => { d.connectors[ID] = { method: 'msapp', tenantId: ids.tenantId, clientId: ids.clientId, refreshToken }; });
        } else {
          // a refresh of the saved sign-in: only while the record is still that sign-in
          await store.update((d) => {
            const r = d.connectors[ID];
            if (sameIds(r, ids) && r.refreshToken) r.refreshToken = refreshToken;
          });
        }
      },
    });
    return app;
  }

  const transcripts = createTranscripts({
    fetch, now,
    graph: (env.CONNECTOR_UPSTREAM_TRANSCRIPTS_GRAPH || 'https://graph.microsoft.com') + '/v1.0',
    token: async () => {
      if (!inFold) await fold(); // (not from inside the fold itself: it would wait on its own promise) a finished sign-in nobody polled for is picked up here
      const app = cur();
      try {
        if (!app) throw new MsAppError('signed-out', 'Not signed in.');
        return await app.accessToken();
      } catch (e) {
        if (e && e.kind === 'refused') await patch((r) => { r.needsSignIn = true; });
        throw e;
      }
    },
    forget: () => { const app = cur(); if (app) app.forget(); },
  });

  const connected = () => !!(rec() && rec().refreshToken);

  function restore() {
    const r = rec();
    if (!r || !r.refreshToken || !r.tenantId || !r.clientId) return;
    active = makeApp({ tenantId: r.tenantId, clientId: r.clientId });
    active.restore({ tenantId: r.tenantId, clientId: r.clientId, refreshToken: r.refreshToken });
  }

  async function test() {
    const res = await transcripts.probe();
    const lastTest = stamp({ ok: res.ok, tools: res.tools, error: res.error });
    await patch((r) => {
      r.lastTest = lastTest;
      if (res.ok) { delete r.needsSignIn; if (res.account) r.account = res.account; }
    });
    return lastTest;
  }

  async function start({ tenantId, clientId } = {}) {
    if (!isGuid(tenantId)) throw new ConnectorError("That doesn't look like a Directory (tenant) ID.");
    if (!isGuid(clientId)) throw new ConnectorError("That doesn't look like an Application (client) ID.");
    if (candidate) candidate.cancel();
    const app = makeApp({ tenantId, clientId });
    candidate = app;
    try {
      return await app.start({ tenantId, clientId });
    } catch (e) {
      if (e instanceof MsAppError) throw new ConnectorError(e.message); // kept as candidate: status shows the failure
      candidate = null;
      throw e;
    }
  }

  // A completed sign-in becomes the active one, then its account is read and the agents are synced.
  const fold = serialised(async () => {
    if (!candidate || candidate.status().status !== 'done') return;
    inFold = true;
    const old = active;
    active = candidate; candidate = null;
    if (old) old.signOut(); // a refresh it has in flight must not reach the store
    try {
      await test();
      try { await sync(); } catch (e) { console.error('connectors sync failed after the Teams transcripts sign-in:', e && e.message); }
    } catch (e) {
      console.error('Teams transcripts sign-in follow-up failed:', e && e.message);
    } finally {
      inFold = false;
    }
  });

  async function status() {
    await fold();
    if (candidate) {
      const s = candidate.status();
      if (s.status === 'done') return { status: 'done' };
      return s;
    }
    return { status: connected() ? 'done' : 'idle' };
  }

  function cancel() {
    if (candidate) candidate.cancel();
    candidate = null;
  }

  async function signOut() {
    if (active) active.signOut();
    cancel();
    active = null;
    const r = rec();
    if (r) {
      const { tenantId, clientId } = r;
      await store.update((d) => { d.connectors[ID] = { method: 'msapp', ...(tenantId ? { tenantId } : {}), ...(clientId ? { clientId } : {}) }; });
    }
    await sync();
  }

  // Fields for the view row: the saved IDs (also when signed out), the waiting sign-in's error.
  function viewFields(on) {
    const r = rec() || {};
    const out = {};
    if (r.tenantId) out.tenantId = r.tenantId;
    if (r.clientId) out.clientId = r.clientId;
    const s = candidate ? candidate.status() : null;
    return { fields: out, waiting: !!s && s.status === 'waiting' && !on, failed: s && s.status === 'failed' && !on ? s.error : undefined };
  }

  return { handle: (rpc) => transcripts.handle(rpc), connected, restore, test, start, status, cancel, signOut, fold, viewFields };
}

module.exports = { createTranscriptsService };
