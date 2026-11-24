'use strict';
// The one module that knows the connector rules. server.js is a thin layer of routes over it,
// and Settings renders view(). It composes the catalogue, store, OAuth client, relay target,
// agent writers and Azure helpers; it does none of their work itself.
const path = require('node:path');
const { CONNECTORS, PLANNED, entryFor } = require('./connectors');
const { createStore } = require('./connector-store');
const oauth = require('./connector-oauth');
const { messages, serialised, mcpProbe } = require('./connector-relay');
const { createRelayed, basic } = require('./connector-relayed');
const { claudeWriter, cursorWriter, codexWriter, copilotWriter, opencodeWriter, kiloWriter, antigravityWriter, syncAgents } = require('./connector-agents');
const azure = require('./connector-azure');
const { createEntra } = require('./connector-entra');
const ado = require('./connector-ado');
const { createMsAppService } = require('./connector-msapp-service');
const { createTranscripts } = require('./connector-transcripts');
const { createTeamsChats } = require('./connector-teamschats');
const { createOutlookMail, createOutlookCalendar } = require('./connector-outlook');
const { createCursorLogins, cursorTools, CursorLoginError } = require('./connector-cursor');
const { createLogicMonitorService } = require('./connector-logicmonitor-service');
const { createSignIn } = require('./connector-signin');
const { vantageReadOnly, automationFilter } = require('./connector-tools');
const { createAutomationAccess } = require('./connector-automation');
const { PROFILES, isInstalled } = require('./agents');

// The MCP server behind each connector that signs in through the person's own app registration (signIn 'msapp').
const MSAPP_SERVERS = { transcripts: createTranscripts, teamschats: createTeamsChats, outlookmail: createOutlookMail, outlookcalendar: createOutlookCalendar };
// Every agent VaultOS writes connector entries for, in the order their rows show. Pi has no MCP.
const WRITERS = { claude: claudeWriter, cursor: cursorWriter, codex: codexWriter, copilot: copilotWriter, opencode: opencodeWriter, kilo: kiloWriter, antigravity: antigravityWriter };
const agentLabel = (a) => (PROFILES[a] && PROFILES[a].label) || a;

// Only a ConnectorError carries a message written for the person; the routes answer anything else generically.
class ConnectorError extends Error {}

function createConnectorService({
  home, port, env = process.env, fetch = globalThis.fetch, run = azure.runCapture, spawn, now = Date.now,
  installedAgents = async () => [], adoTest = ado.test, sleep,
}) {
  const store = createStore({ home, now });
  const login = azure.createDeviceLogin({ spawn, now });
  // Ids come from requests: a prototype key such as "constructor" is not a connector.
  const known = (id) => {
    if (typeof id !== 'string' || !Object.hasOwn(CONNECTORS, id)) throw new ConnectorError('Unknown connector.');
    return id;
  };
  const label = (id) => CONNECTORS[id].label;
  const entra = createEntra({ run, fetch, now });
  const signIns = {}; // connector id -> its browser sign-in (connector-signin.js), for every connector that offers one
  const relayed = createRelayed({ store, env, signIns });
  const isRelayed = (id) => Object.hasOwn(CONNECTORS, id) && CONNECTORS[id].kind === 'relayed';
  // Cursor's own servers: VaultOS writes the Cursor entry and helps the CLI's sign-in; Cursor holds that sign-in.
  const isCursor = (id) => Object.hasOwn(CONNECTORS, id) && CONNECTORS[id].kind === 'cursor';
  const logins = createCursorLogins({ spawn, fetch, now, home, consent: Object.fromEntries(Object.values(CONNECTORS).filter((c) => c.kind === 'cursor').map((c) => [c.id, c.scopes.filter((x) => x !== 'offline_access').join(', ')])) });
  // Entra and Azure DevOps ride the Azure sign-in; Teams transcripts and Teams chats each have their own app sign-in.
  const ridesAzure = (id) => Object.hasOwn(CONNECTORS, id) && CONNECTORS[id].signIn.includes('azure');
  const msapp = (id) => (typeof id === 'string' && Object.hasOwn(msapps, id) ? msapps[id] : null); // msapps is filled below
  const rec = (id) => store.get().connectors[id];
  const patch = (id, fn) => store.update((d) => { if (d.connectors[id]) fn(d.connectors[id]); });

  let azureFoldError = null;
  let agentResults = {};
  let azureSubs = null;
  const notes = {}; // text kept after a record is deleted (a failed revoke)

  // ----- credentials (see connector-relayed.js) -----
  const azureConnected = (r) => !!r && !!r.account;
  // Entra is turned on by the person but rides the Azure sign-in: signing Azure out switches it off until Azure is back.
  // Azure DevOps rides it the same way, and also needs its organization.
  const connected = (id) => {
    if (isRelayed(id)) return relayed.connected(id);
    if (msapp(id)) return msapp(id).connected();
    if (isCursor(id)) return !!rec(id);
    if (id === 'logicmonitor') return lm.connected();
    if (id === 'azuredevops') return !!rec(id) && !!rec(id).org && azureConnected(rec('azure'));
    if (ridesAzure(id)) return !!rec(id) && azureConnected(rec('azure'));
    return azureConnected(rec(id));
  };

  function relayTarget(id, opts) {
    if (id === 'entra' || msapp(id) || id === 'logicmonitor') {
      const serve = msapp(id) ? (rpc) => msapp(id).handle(rpc) : { entra: (rpc) => entra.handle(rpc), logicmonitor: (rpc) => lm.handle(rpc) }[id];
      return {
        label: label(id),
        authorization: async () => (connected(id) ? '' : null),
        renew: async () => null,
        markNeedsSignIn() {},
        missing: () => 'not-connected',
        serve,
      };
    }
    if (!isRelayed(id)) return null;
    return {
      label: label(id),
      url: relayed.urlFor(id),
      authorization: () => relayed.authorization(id),
      renew: (rejected) => relayed.renew(id, rejected),
      // The relay does not call this for a sign-in that was just renewed and still got a 401: that stays usable and Test again can tell.
      markNeedsSignIn() { Promise.resolve(relayed.markNeedsSignIn(id)).catch(() => {}); },
      missing: () => relayed.missing(id),
      // An automation always gets the read-only filter, whatever "Allow changes" says.
      ...(opts && opts.automation ? (automationFilter(id) ? { tools: automationFilter(id) } : {}) : toolFilter(id) ? { tools: toolFilter(id) } : {}),
    };
  }

  // Read per request, so "Allow changes" applies to an agent's very next call.
  const toolFilter = (id) => (id === 'vantage' && !(rec(id) || {}).allowChanges ? vantageReadOnly : null);
  // The tool count Test shows: what agents can see.
  const visibleTools = (id, names) => { const f = toolFilter(id); return f ? names.filter((n) => f.allow(n)) : names; };

  const msappOnly = (id) => {
    known(id);
    if (!msapp(id)) throw new ConnectorError(`${label(id)} doesn't sign in with an app.`);
    return msapp(id);
  };
  // sync and stamp are function declarations/consts further down; the glue only calls them later.
  const msapps = {}; // connector id -> its app sign-in service (connector-msapp-service.js)
  for (const id of Object.keys(CONNECTORS)) {
    const c = CONNECTORS[id];
    if (!c.signIn.includes('msapp')) continue;
    msapps[id] = createMsAppService({
      id, label: c.label, scopes: c.scopes.join(' '), consent: c.consent, createServer: MSAPP_SERVERS[id],
      store, env, fetch, now, sleep, ConnectorError, stamp: (r) => stamp(r), sync: () => sync(),
    });
  }
  const lm = createLogicMonitorService({ store, env, fetch, now, ConnectorError, stamp: (r) => stamp(r), sync: () => sync() });
  for (const id of Object.keys(CONNECTORS)) {
    if (!CONNECTORS[id].signIn.includes('oauth')) continue;
    signIns[id] = createSignIn({
      id, label: label(id), store, fetch, now, oauth, ConnectorError, notes,
      mcpUrl: () => relayed.mcpUrl(id),
      credentialFor: (x) => relayed.credentialFor(x),
      markNeedsSignIn: (x) => relayed.markNeedsSignIn(x),
      stale: (r) => relayed.stale(id, r),
      rootFallback: !!CONNECTORS[id].rootMetadata,
      test: (x) => test(x), sync: () => sync(),
    });
  }

  // ----- tests -----
  const textOf = (res) => {
    const part = res && Array.isArray(res.content) ? res.content.find((c) => c && typeof c.text === 'string') : null;
    try { return part ? JSON.parse(part.text) : null; } catch { return null; }
  };

  async function identify(id, probe) {
    const out = {};
    if (id === 'github') {
      try {
        const u = textOf(await probe.call('get_me'));
        if (u && typeof u.login === 'string' && u.login) out.account = u.login;
      } catch { /* best effort */ }
    }
    if (id === 'vantage') {
      try {
        const u = textOf(await probe.call('get-myself'));
        const email = u && (u.email || u.name);
        if (typeof email === 'string' && email) out.account = typeof u.workspace === 'string' && u.workspace ? `${email} · ${u.workspace}` : email;
      } catch { /* best effort */ }
    }
    if (id !== 'atlassian') return out;
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

  // Context7 answers initialize and tools/list for any key and refuses a bad one only on a tool call, so one real
  // lookup is the check. The refusal's own text is not shown. Anything else (a slow lookup, a quota) is not a refusal.
  async function keyRefused(id, probe) {
    if (id !== 'context7') return false;
    try {
      const res = await probe.call('resolve-library-id', { libraryName: 'react', query: 'check the key' });
      const part = res && Array.isArray(res.content) ? res.content.find((c) => c && typeof c.text === 'string') : null;
      return !!(res && res.isError && part && /api key/i.test(part.text));
    } catch { return false; }
  }

  const stamp = (r) => ({ at: new Date(now()).toISOString(), ...r });

  async function testRelayed(id) {
    const target = relayTarget(id);
    const record = (lastTest, fn) => patch(id, (r) => { r.lastTest = lastTest; if (fn) fn(r); }).then(() => lastTest);
    let first;
    try { first = await target.authorization(); } catch (e) {
      return record(stamp({ ok: false, tools: 0, error: `Couldn't reach ${label(id)}. Try again in a moment.` }));
    }
    // '' is connected with no credential; only a non-string is "not signed in".
    if (typeof first !== 'string') return record(stamp({ ok: false, tools: 0, error: messages.expired(label(id)) }), (r) => { r.needsSignIn = true; });
    let used = first;
    const authFn = async () => { used = await target.authorization(); return used; };
    const url = relayed.urlFor(id);
    let probe = await mcpProbe(url, authFn, { fetch });
    const is401 = (p) => !p.ok && /answered 401/.test(p.error);
    let lost = false;
    const method = (rec(id) || {}).method; // a sign-out can remove the record while the probe was in flight
    if (is401(probe) && method !== 'none') {
      if (method === 'oauth') {
        let fresh = null;
        try { fresh = await target.renew(used); } catch { /* transient: not a lost sign-in */ lost = null; }
        if (fresh) probe = await mcpProbe(url, fresh, { fetch }); // renewed and still refused: shown as an error, the sign-in stays usable
        else if (lost !== null) lost = true;
      } else lost = true;
    }
    if (probe.ok && method === 'token' && await keyRefused(id, probe)) {
      probe = { ok: false, tools: [], error: `${label(id)} no longer accepts this key.` };
      lost = true;
    }
    const info = probe.ok ? await identify(id, probe) : {};
    return record(stamp({ ok: probe.ok, tools: probe.ok ? visibleTools(id, probe.tools).length : 0, error: probe.ok ? null : probe.error }), (r) => {
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
    known(id);
    if (!connected(id)) throw new ConnectorError(`${label(id)} isn't connected yet.`);
    if (msapp(id)) return msapp(id).test();
    if (isCursor(id)) return testCursor(id);
    if (id === 'logicmonitor') return lm.test();
    if (id === 'entra') return testEntra(id);
    if (id === 'azuredevops') return testAdo();
    return isRelayed(id) ? testRelayed(id) : testAzure();
  }

  // Starts the agents' own entry, lists the tools and one page of projects. A failing test leaves it on with the error shown.
  async function testAdo() {
    const r = rec('azuredevops');
    const res = await adoTest({ home, org: r.org, allowChanges: !!r.allowChanges, env });
    const lastTest = stamp({ ok: res.ok, tools: res.tools, error: res.ok ? null : adoError(r.org, res.error), ...(res.projects !== undefined ? { projects: res.projects } : {}) });
    await patch('azuredevops', (x) => { x.lastTest = lastTest; });
    return lastTest;
  }

  async function testEntra(id) {
    const res = await entra.probe();
    const lastTest = stamp({ ok: res.ok, tools: res.tools, error: res.error });
    await patch(id, (r) => { r.lastTest = lastTest; if (res.ok && res.org) r.account = res.org; });
    return lastTest;
  }

  // Vantage's "Allow changes": off, agents only see and call its read tools (the relay filters them).
  async function vantageSettings(input) {
    if (!connected('vantage')) throw new ConnectorError("Vantage isn't connected yet.");
    if (input && typeof input.allowChanges === 'boolean') await patch('vantage', (r) => { r.allowChanges = input.allowChanges; });
    return {};
  }

  // ----- Cursor's own servers (Teams, Outlook, Outlook calendar) -----
  const cursorOnly = async (id) => {
    known(id);
    if (!isCursor(id)) throw new ConnectorError(`${label(id)} isn't one of Cursor's own connectors.`);
    if (!(await installedAgents()).includes('cursor')) throw new ConnectorError('Install the Cursor CLI first (Settings → Agent).');
    return id;
  };

  // Asks the Cursor CLI for the server's tools: a sign-in that is missing or lost shows up here.
  async function testCursor(id) {
    const res = await cursorTools(run, id, label(id));
    const lastTest = stamp({ ok: res.ok, tools: res.tools, error: res.error });
    await patch(id, (r) => { r.lastTest = lastTest; if (res.signedIn !== null) r.signedIn = res.signedIn; });
    return lastTest;
  }

  // Turns it on (the entry must be in Cursor's config before the CLI can sign in to it), then starts the CLI's sign-in.
  async function cursorStart(id) {
    await cursorOnly(id);
    if (!rec(id)) {
      delete notes[id];
      await store.update((d) => { d.connectors[id] = { method: 'cursor', signedIn: false }; });
      await sync();
    }
    try {
      const r = await logins.start(id);
      if (r.done) { await patch(id, (x) => { x.signedIn = true; }); await testCursor(id); }
      return r;
    } catch (e) {
      if (e instanceof CursorLoginError) throw new ConnectorError(e.message);
      throw e;
    }
  }

  async function cursorFinish(id, input) {
    await cursorOnly(id);
    try { await logins.finish(id, input && input.url); } catch (e) {
      if (e instanceof CursorLoginError) throw new ConnectorError(e.message);
      throw e;
    }
    await patch(id, (x) => { x.signedIn = true; });
    return testCursor(id);
  }

  async function cursorCancel(id) { known(id); if (isCursor(id)) logins.cancel(id); }
  async function cursorStatus(id) { known(id); return isCursor(id) ? logins.status(id) : { status: 'idle' }; }

  // ----- browser sign-in (Atlassian, Vantage) -----
  const browserOnly = (id) => {
    known(id);
    if (!signIns[id]) throw new ConnectorError(`${label(id)} doesn't sign in with a browser.`);
    return signIns[id];
  };
  const signInStart = async (id, a) => browserOnly(id).start(a);
  const signInCancel = async (id, a) => browserOnly(id).cancel(a);
  const signInCallback = async (id, a) => browserOnly(id).callback(a);

  const FRESH = ['tokens', 'resource', 'needsSignIn', 'email', 'token', 'key', 'site', 'account', 'lastTest'];

  // Atlassian: { email, token } | { key }. GitHub, Context7: { token }. Probes first; a refused credential changes nothing.
  async function saveToken(id, input) {
    known(id);
    if (id === 'logicmonitor') { delete notes[id]; return lm.save(input || {}); }
    if (!isRelayed(id) || !CONNECTORS[id].signIn.includes('token')) throw new ConnectorError(`${label(id)} doesn't use a token.`);
    const text = (v) => (input && typeof input[v] === 'string' ? input[v].trim() : '');
    let key = '', email = '', token = '';
    if (id === 'atlassian') {
      key = text('key'); email = text('email'); token = text('token');
      if (!key && !(email && token)) throw new ConnectorError('Enter your email and API token, or a service account key.');
    } else {
      key = text('token');
      if (!key) throw new ConnectorError(`Paste a ${label(id)} token.`);
    }
    if ([key, token].some((v) => /[\s\x00-\x1f\x7f]/.test(v))) {
      throw new ConnectorError(`That token has spaces or line breaks in it. Copy it again from ${label(id)}.`);
    }
    const probe = await mcpProbe(relayed.urlFor(id, 'token'), key ? `Bearer ${key}` : basic(email, token), { fetch });
    if (!probe.ok) throw new ConnectorError(id === 'github' || id === 'vantage' ? `${label(id)} didn't accept this token (${probe.error}).` : probe.error);
    if (await keyRefused(id, probe)) throw new ConnectorError(`${label(id)} didn't accept this key. Copy it again from your Context7 dashboard.`);
    const info = await identify(id, probe);
    const prev = rec(id); // a copy: the store hands out clones
    delete notes[id];
    await store.update((d) => {
      const r = (d.connectors[id] ||= {});
      for (const k of FRESH) delete r[k];
      r.method = 'token';
      if (key) r.key = key; else { r.email = email; r.token = token; }
      const account = info.account || (key ? undefined : email);
      if (account) r.account = account;
      if (info.site) r.site = info.site;
      r.lastTest = stamp({ ok: true, tools: visibleTools(id, probe.tools).length, error: null });
    });
    if (prev && prev.method === 'oauth' && signIns[id]) await signIns[id].revoke(prev);
    await sync();
  }

  // What Microsoft's server said, as a sentence for the person. Its own text stays at the end, cut short.
  function adoError(org, raw) {
    const t = String(raw || '');
    if (/obtain Azure DevOps token|AADSTS|az login|AzureCliCredential|ChainedTokenCredential|CredentialUnavailable/i.test(t)) return `Your Azure sign-in can't open ${org}. Check that the account you signed in to Azure with is a member of it.`;
    if (/\bnot found\b|\b404\b|does not exist|TF400813|\b401\b|unauthori[sz]ed/i.test(t)) return `Azure DevOps didn't let this sign-in into ${org} (${t.slice(0, 160)}). Check the organization name.`;
    return `Azure DevOps didn't answer for ${org}: ${t.slice(0, 200) || 'no reason given'}`;
  }

  // Azure DevOps: { org } (a name or a dev.azure.com address). Checked by starting it before anything is saved, so a
  // mistyped organization changes nothing; the switch keeps its setting when the organization changes.
  async function enableAdo(input) {
    const org = ado.parseOrg(input && input.org);
    if (!org) throw new ConnectorError('Enter your Azure DevOps organization: the name after dev.azure.com/ in its address.');
    if (!connected('azure')) throw new ConnectorError('Connect Azure first. Azure DevOps uses the same sign-in.');
    if (!(await toolsInstalled('azuredevops'))) throw new ConnectorError('Install Azure DevOps first.');
    const prev = rec('azuredevops');
    const allowChanges = !!(prev && prev.allowChanges);
    const res = await adoTest({ home, org, allowChanges, env });
    if (!res.ok) throw new ConnectorError(adoError(org, res.error));
    delete notes.azuredevops;
    await store.update((d) => {
      d.connectors.azuredevops = { method: 'azure', org, allowChanges, lastTest: stamp({ ok: true, tools: res.tools, error: null, ...(res.projects !== undefined ? { projects: res.projects } : {}) }) };
    });
    return sync();
  }

  async function adoSettings({ allowChanges } = {}) {
    if (!connected('azuredevops')) throw new ConnectorError("Azure DevOps isn't connected yet.");
    if (typeof allowChanges !== 'boolean') return;
    await patch('azuredevops', (x) => { x.allowChanges = allowChanges; });
    await sync();
  }

  // A connector that needs no sign-in: record it, test it (a failing test leaves it on with the error shown), sync.
  async function enable(id, input) {
    known(id);
    if (id === 'azuredevops') return enableAdo(input);
    if (msapp(id)) throw new ConnectorError('Sign in first.');
    if (id === 'entra') {
      if (!connected('azure')) throw new ConnectorError('Connect Azure first. Entra uses the same sign-in.');
      delete notes[id];
      await store.update((d) => { d.connectors[id] = { method: 'azure' }; });
      await test(id);
      return sync();
    }
    if (isCursor(id)) {
      await cursorOnly(id);
      delete notes[id];
      if (!rec(id)) await store.update((d) => { d.connectors[id] = { method: 'cursor', signedIn: false }; });
      return sync();
    }
    const si = isRelayed(id) ? CONNECTORS[id].signIn : [];
    if (si.length !== 1 || si[0] !== 'none') throw new ConnectorError(`${label(id)} needs a sign-in.`);
    delete notes[id];
    await store.update((d) => { d.connectors[id] = { method: 'none' }; });
    await test(id);
    await sync();
  }

  // The record goes first and the agents are synced, so a slow or failing sign-out never leaves the connector in place;
  // the saved copy is then revoked (or logged out), and a failure there is noted on the row.
  async function disconnect(id) {
    known(id);
    delete notes[id];
    if (msapp(id)) return msapp(id).signOut(); // keeps the app's IDs so signing in again is one click
    const saved = rec(id); // a copy: the store hands out clones
    if (signIns[id]) signIns[id].reset();
    else if (isCursor(id)) logins.cancel(id); // Cursor keeps its own sign-in; the entry goes from Cursor's config
    else if (id === 'azure') { login.cancel(); azureFoldError = null; azureSubs = null; }
    await store.update((d) => { delete d.connectors[id]; });
    await sync();
    if (signIns[id]) {
      if (!(await signIns[id].revoke(saved))) notes[id] = `${label(id)} didn't confirm the sign-out. The sign-in may still be active there.`;
    } else if (id === 'azure') {
      const res = await azure.logout({ run });
      if (res && res.code !== 0) notes[id] = "Azure didn't confirm the sign-out.";
    }
  }

  // ----- Azure -----
  const azureStart = () => { azureFoldError = null; return login.start({ tenant: (rec('azure') || {}).tenant }); };

  // Never throws: a failure becomes an error on the Azure row and the login is reset so the person can start again.
  const foldLogin = serialised(async () => {
    if (login.status().status !== 'done') return;
    try {
      const acct = await azure.account({ run });
      if (!acct) throw new Error('az account show returned nothing');
      azureSubs = (await azure.subscriptions({ run })) || null;
      await store.update((d) => {
        const r = (d.connectors.azure ||= {});
        r.method = 'device-code'; r.allowChanges = !!r.allowChanges; delete r.needsSignIn;
        r.account = acct.user; r.subscription = acct.subscriptionId; if (acct.tenantId) r.tenant = acct.tenantId;
      });
      azureFoldError = null; delete notes.azure;
      login.cancel();
      await test('azure');
      try { await sync(); } catch (e) { console.error('connectors sync failed after the Azure sign-in:', e && e.message); }
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
  // Whether an agent gets a connector: one made for some agents only (Cursor's own) goes to those, and Cursor gets
  // Cursor's own Teams or Outlook instead of VaultOS's while that one is on.
  const forAgent = (id, agent) => {
    const c = CONNECTORS[id];
    if (c.agents && !c.agents.includes(agent)) return false;
    return !(agent === 'cursor' && c.cursorAlt && connected(c.cursorAlt));
  };

  async function doSync() {
    const s = store.get();
    const entries = {};
    for (const id of Object.keys(CONNECTORS)) {
      const r = s.connectors[id] || {};
      if (connected(id)) entries[id] = entryFor(id, { port, key: s.relayKey, home, allowChanges: !!r.allowChanges, org: r.org });
    }
    const wanted = (agent) => Object.fromEntries(Object.entries(entries).filter(([id]) => forAgent(id, agent)));
    const installed = await installedAgents();
    const writers = [];
    for (const [a, make] of Object.entries(WRITERS)) if (installed.includes(a)) writers.push(await make({ home, run, env }));
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
  async function toolsInstalled(id) {
    for (const name of CONNECTORS[id].detect) if (!(await isInstalled({ detect: [name] }, { run }))) return false;
    return true;
  }

  // Claude Code and the Cursor CLI always have a row; the other agents once they are installed.
  function agentRows(id, installed) {
    const s = store.get();
    const c = CONNECTORS[id];
    const rows = [];
    for (const a of Object.keys(WRITERS)) {
      if (!installed.includes(a) && a !== 'claude' && a !== 'cursor') continue;
      if (c.agents && !c.agents.includes(a)) continue;
      const base = { id: a, label: agentLabel(a) };
      if (!installed.includes(a)) { rows.push({ ...base, chip: 'Not installed' }); continue; }
      if (a === 'cursor' && c.cursorAlt && connected(c.cursorAlt)) { rows.push({ ...base, chip: `Uses ${label(c.cursorAlt)}` }); continue; }
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
    if (installed.includes('pi') && !c.agents) rows.push({ id: 'pi', label: PROFILES.pi.label, chip: 'No connectors in Pi' });
    return rows;
  }

  async function view() {
    await foldLogin();
    for (const m of Object.values(msapps)) await m.fold();
    const installed = await installedAgents();
    const s = store.get();
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
      if (c.tokenHelp) v.tokenHelp = c.tokenHelp;
      if (c.cursorAlt) { v.cursorAlt = c.cursorAlt; v.cursorAltLabel = label(c.cursorAlt); v.cursorAltOn = connected(c.cursorAlt); }
      if (isCursor(id)) {
        v.url = c.url; v.scopes = c.scopes; v.sends = c.sends;
        const instead = Object.values(CONNECTORS).find((x) => x.cursorAlt === id);
        if (instead) v.insteadOf = instead.label;
        if (!installed.includes('cursor')) v.needsCursor = true;
        const ls = logins.status(id);
        if (on) {
          v.signedIn = !!r.signedIn;
          if (ls.status === 'waiting') state = 'connecting';
          else if (!r.signedIn) { state = 'not-signed-in'; error = undefined; }
        }
        if (ls.status === 'waiting') v.login = { url: ls.url, port: ls.port };
        else if (ls.status === 'failed' && ls.error) error = ls.error;
      } else if (msapp(id)) {
        const t = msapp(id).viewFields();
        Object.assign(v, t.fields);
        if (t.waiting) state = 'connecting';
        else if (t.failed) error = t.failed;
      } else if (id === 'logicmonitor') {
        Object.assign(v, lm.viewFields());
      } else if (id === 'entra') {
        if (!on && !connected('azure')) v.needsAzure = true;
      } else if (id === 'azuredevops') {
        if (r && r.org) v.org = r.org;
        if (on) v.allowChanges = !!r.allowChanges;
        if (!on && !connected('azure')) v.needsAzure = true;
        if (!(await toolsInstalled(id))) { state = 'not-installed'; v.install = c.install; }
      } else if (id === 'atlassian') {
        if (on && r.site) v.site = r.site;
      } else if (id === 'vantage') {
        v.allowChanges = !!(r && r.allowChanges);
      } else if (id === 'azure') {
        const ls = login.status();
        if (!(await toolsInstalled('azure'))) { state = 'not-installed'; v.install = c.install; }
        else if (ls.status === 'waiting' && state !== 'connected') state = 'connecting';
        else if (!on && azureFoldError) error = azureFoldError;
        else if (ls.status === 'failed' && !on) error = ls.error;
        if (on) {
          v.allowChanges = !!r.allowChanges;
          v.subscription = r.subscription;
          if (!azureSubs) azureSubs = (await azure.subscriptions({ run })) || null; // a failed listing is not remembered
          v.subscriptions = (azureSubs || []).map(({ id: sid, name }) => ({ id: sid, name }));
        }
      }
      // A browser sign-in this server started and hasn't finished: the row waits, unless a sign-in already works.
      if (signIns[id] && signIns[id].connecting() && state !== 'connected' && state !== 'error') state = 'connecting';
      v.state = state;
      if (error) v.error = error;
      v.agents = agentRows(id, installed);
      out.push(v);
    }
    return { connectors: out, planned: PLANNED, reset: store.wasReset() };
  }

  const automation = createAutomationAccess({
    dir: path.join(home, '.cache', 'vaultos', 'automation-mcp'), port, home, connected, record: rec, label,
  });

  async function init() {
    await store.load();
    await automation.clearLeftovers().catch(() => {}); // a crash can leave a run's key file behind
    // An Atlassian sign-in from before v2 can't be used on it: ask for a new one now, not at the first failed call.
    const a = rec('atlassian');
    if (relayed.stale('atlassian', a) && !a.needsSignIn) await patch('atlassian', (r) => { r.needsSignIn = true; });
    for (const m of Object.values(msapps)) m.restore();
    await sync();
  }

  const needsAttention = () => Object.values(store.get().connectors).some((r) => r && r.needsSignIn);

  return {
    init, view, relayTarget, automationChoices: () => automation.choices(), automationAccess: (o) => automation.open(o), runGrant: (k) => automation.grant(k),
    relayKey: () => store.get().relayKey, signInStart, signInCancel, signInCallback, saveToken, enable, test, disconnect, vantageSettings,
    // Atlassian's own names, kept for its callers and tests.
    atlassianStart: (a) => signInStart('atlassian', a), atlassianCancel: (a) => signInCancel('atlassian', a), atlassianCallback: (a) => signInCallback('atlassian', a),
    azureStart, azureStatus, azureCancel, azureSettings, adoSettings, sync, needsAttention,
    cursorStart, cursorFinish, cursorCancel, cursorStatus,
    msappStart: async (id, input) => msappOnly(id).start(input),
    msappStatus: async (id) => msappOnly(id).status(),
    msappCancel: async (id) => { await msappOnly(id).cancel(); },
  };
}

module.exports = { createConnectorService, ConnectorError };
