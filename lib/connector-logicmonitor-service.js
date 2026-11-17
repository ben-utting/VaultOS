'use strict';
// The LogicMonitor connector's glue for connector-service.js: saving a portal + credential after one probe, Test,
// and the fields the pane shows. The credential lives in the store record only; it never reaches a view, an error
// or an agent's config. Agents reach LogicMonitor through the relay, which serves handle().
const { createLogicMonitor, normalisePortal } = require('./connector-logicmonitor');

const ID = 'logicmonitor';
const PORTAL_MSG = 'Enter your LogicMonitor portal name, like acme or acme.logicmonitor.com.';
const MISSING_MSG = 'Paste a bearer token, or an access ID and key.';
const SPACES_MSG = 'That token has spaces or line breaks in it. Copy it again from LogicMonitor.';

// The credential a record holds, or null when it is incomplete.
function credOf(r) {
  if (!r || !r.portal) return null;
  if (r.token) return { portal: r.portal, token: r.token };
  if (r.accessId && r.accessKey) return { portal: r.portal, accessId: r.accessId, accessKey: r.accessKey };
  return null;
}

function createLogicMonitorService({ store, env, fetch, now, ConnectorError, stamp, sync }) {
  const rec = () => store.get().connectors[ID];
  const patch = (fn) => store.update((d) => { if (d.connectors[ID]) fn(d.connectors[ID]); });
  const lm = createLogicMonitor({ fetch, now, env, credentials: () => credOf(rec()), onLost: () => patch((r) => { r.needsSignIn = true; }) });

  const connected = () => !!credOf(rec());

  async function test() {
    const p = await lm.probe();
    const lastTest = stamp({ ok: p.ok, tools: p.ok ? p.tools : 0, error: p.ok ? null : p.error });
    await patch((r) => {
      r.lastTest = lastTest;
      if (p.ok) delete r.needsSignIn;
      else if (p.lost) r.needsSignIn = true;
    });
    return lastTest;
  }

  // { portal, token } | { portal, accessId, accessKey }. Probes first; a refused credential changes nothing.
  async function save(input) {
    const text = (k) => (input && typeof input[k] === 'string' ? input[k].trim() : '');
    const portal = normalisePortal(text('portal'));
    if (!portal) throw new ConnectorError(PORTAL_MSG);
    const token = text('token'), accessId = text('accessId'), accessKey = text('accessKey');
    const cred = token ? { portal, token } : (accessId && accessKey ? { portal, accessId, accessKey } : null);
    if (!cred) throw new ConnectorError(MISSING_MSG);
    if ([token, accessId, accessKey].some((v) => /[\s\x00-\x1f\x7f]/.test(v))) throw new ConnectorError(SPACES_MSG);
    const p = await createLogicMonitor({ fetch, now, env, credentials: () => cred }).probe();
    if (!p.ok) {
      if (p.status === 401 || p.status === 403) throw new ConnectorError(`LogicMonitor didn't accept this token: ${p.upstream || `it answered ${p.status}`}`);
      throw new ConnectorError(p.error);
    }
    await store.update((d) => { d.connectors[ID] = { method: 'token', ...cred, account: `${portal}.logicmonitor.com` }; });
    await test();
    await sync();
  }

  function viewFields() {
    const r = rec();
    if (!r) return {};
    return { ...(r.portal ? { portal: r.portal } : {}), ...(r.accessId && !r.token ? { lmv1: true } : {}) };
  }

  return { connected, handle: (rpc) => lm.handle(rpc), test, save, viewFields };
}

module.exports = { createLogicMonitorService };
