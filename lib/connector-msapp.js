'use strict';
// Sign-in through a public-client Microsoft app the user registers (device-code flow,
// plain HTTPS, no MSAL). Hands out access tokens with single-flight refresh. Delegated scopes only, as the
// connector asks for them (SCOPES is Teams transcripts'); there is never a client secret.
// Tokens are never logged and never put in error messages.

const SCOPES = 'OnlineMeetingTranscript.Read.All OnlineMeetings.Read Calendars.Read User.Read offline_access';
const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';
const EXPIRED_MSG = 'The code expired before it was entered. Start again.';
const SKEW_MS = 5 * 60 * 1000; // refresh when less than 5 minutes remain
const TIMEOUT_MS = 30000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class MsAppError extends Error {
  constructor(kind, message) { super(message); this.name = 'MsAppError'; this.kind = kind; }
}

const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);

const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim();

// A consent problem is still 'refused' (the person must act), with a sentence that says who can fix it.
// `consent` names the permissions an admin would grant, e.g. 'Chat.Read'. Scopes are never widened to get past it.
const CONSENT = (p) => `Your organisation doesn't let you approve this app yourself. Ask an admin to grant consent for ${p || 'its permissions'} on your app registration, then sign in again.`;
const DECLINED = (p) => `The sign-in was declined on Microsoft's page. If it said the app needs admin approval, ask an admin to grant consent for ${p || 'its permissions'} on your app registration, then sign in again.`;
const FIXED = {
  AADSTS7000218: ['config', 'Public client flows are not allowed on this app registration. In Entra, open the app, go to Authentication and turn on "Allow public client flows".'],
  AADSTS700016: ['config', 'That app was not found in this directory. Check the Application (client) ID and the Directory (tenant) ID.'],
  AADSTS90002: ['config', 'The directory (tenant) was not found. Check the Directory (tenant) ID.'],
  AADSTS50173: ['refused', null],
  AADSTS700082: ['refused', null],
  AADSTS65001: ['refused', CONSENT], // no consent yet (or it was taken away)
  AADSTS90094: ['refused', CONSENT], // admin consent required
  AADSTS90095: ['refused', CONSENT], // admin consent required, through the request-access workflow
  AADSTS65004: ['refused', DECLINED], // the person declined the consent prompt
};
const BY_ERROR = {
  authorization_pending: ['pending', 'Waiting for you to enter the code.'],
  slow_down: ['slow_down', 'Microsoft asked us to poll more slowly.'],
  expired_token: ['expired', EXPIRED_MSG],
  code_expired: ['expired', EXPIRED_MSG],
  authorization_declined: ['refused', DECLINED],
  consent_required: ['refused', CONSENT],
  invalid_grant: ['refused', null],
  interaction_required: ['refused', null],
  invalid_scope: ['config', null],
  invalid_client: ['config', null],
};

function classify(status, body, { consent } = {}) {
  if (!body || typeof body !== 'object' || status >= 500 || status === 429) {
    return { kind: 'transient', message: 'Microsoft sign-in is unavailable right now. Try again shortly.' };
  }
  const desc = firstLine(body.error_description);
  const code = (String(body.error_description || '').match(/AADSTS\d+/) || [])[0];
  // AADSTS codes first: AADSTS7000218 arrives as invalid_client.
  const hit = (code && Object.hasOwn(FIXED, code) && FIXED[code]) || (Object.hasOwn(BY_ERROR, String(body.error)) && BY_ERROR[body.error]);
  const fixed = hit && (typeof hit[1] === 'function' ? hit[1](consent) : hit[1]);
  if (hit) return { kind: hit[0], message: fixed || desc || String(body.error || 'Sign-in was refused.') };
  return { kind: 'refused', message: desc || String(body.error || 'Sign-in was refused.') };
}

function createMsApp({
  fetch,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  authority = DEFAULT_AUTHORITY,
  scopes = SCOPES,
  consent, // the permissions to name when a tenant blocks consent, e.g. 'Chat.Read'
  onRefreshToken = async () => {},
} = {}) {
  let state = 'idle', error;
  let gen = 0; // bumped by start/cancel/signOut to stop an old poll
  let ids = null; // { tenantId, clientId }
  let refreshToken = null;
  let access = null; // { token, expiresAt }
  let inflight = null;
  let saving = 0; // the gen of a finished sign-in whose refresh token is being saved: too late to cancel it
  const secrets = new Set(); // live secrets, redacted from any message built from server text
  const redact = (m) => { let o = String(m); for (const x of secrets) if (x) o = o.split(x).join('[redacted]'); return o; };

  const endpoint = (t, name) => `${authority.replace(/\/+$/, '')}/${t}/oauth2/v2.0/${name}`;

  async function post(url, form) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MsAppError('transient', 'Could not reach Microsoft sign-in. Check the connection and try again.');
    }
    let body = null;
    try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
    return { status: res.status, body };
  }

  async function start({ tenantId, clientId } = {}) {
    if (!isGuid(tenantId)) throw new MsAppError('config', 'The Directory (tenant) ID must be a GUID like 11111111-2222-3333-4444-555555555555.');
    if (!isGuid(clientId)) throw new MsAppError('config', 'The Application (client) ID must be a GUID like 11111111-2222-3333-4444-555555555555.');
    const my = ++gen;
    state = 'waiting'; error = undefined;
    let r;
    try {
      r = await post(endpoint(tenantId, 'devicecode'), { client_id: clientId, scope: scopes });
    } catch (e) {
      if (my === gen) { state = 'failed'; error = e.message; }
      throw e;
    }
    const b = r.body;
    if (r.status !== 200 || !b || !b.device_code || !b.user_code) {
      const c = classify(r.status, b, { consent });
      if (my === gen) { state = 'failed'; error = c.message; }
      throw new MsAppError(c.kind === 'pending' || c.kind === 'slow_down' || c.kind === 'expired' ? 'refused' : c.kind, c.message);
    }
    const startedAt = now();
    const expiresAt = startedAt + (Number(b.expires_in) || 900) * 1000;
    const info = { url: b.verification_uri, code: b.user_code, expiresAt };
    poll(my, { tenantId, clientId }, b.device_code, (Number(b.interval) || 5) * 1000, expiresAt)
      .catch((e) => { if (my === gen) { state = 'failed'; error = e.message; } });
    return info;
  }

  async function poll(my, who, deviceCode, intervalMs, expiresAt) {
    secrets.add(deviceCode);
    const fail = (msg) => { if (my === gen) { state = 'failed'; error = redact(msg); } };
    for (;;) {
      await sleep(intervalMs);
      if (my !== gen) return;
      if (now() >= expiresAt) return fail(EXPIRED_MSG);
      let r;
      try {
        r = await post(endpoint(who.tenantId, 'token'), {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: who.clientId, device_code: deviceCode,
        });
      } catch (e) { if (my !== gen) return; if (e.kind === 'transient') continue; return fail(e.message); }
      if (my !== gen) return;
      const b = r.body;
      if (r.status === 200 && b && b.access_token) {
        if (b.refresh_token) { // stored before we report done
          saving = my;
          try { await onRefreshToken(b.refresh_token, undefined); } finally { if (saving === my) saving = 0; }
        }
        if (my !== gen) return;
        ids = who;
        refreshToken = b.refresh_token || null;
        access = { token: b.access_token, expiresAt: now() + (Number(b.expires_in) || 3600) * 1000 };
        state = 'done';
        return;
      }
      const c = classify(r.status, b, { consent });
      if (c.kind === 'pending' || c.kind === 'transient') continue;
      if (c.kind === 'slow_down') { intervalMs += 5000; continue; }
      return fail(c.message);
    }
  }

  function status() {
    return state === 'failed' && error ? { status: state, error } : { status: state };
  }

  // false when the sign-in has already finished (or is being saved): it is no longer the caller's to stop.
  function cancel() {
    if (state === 'done' || (saving && saving === gen)) return false;
    gen++; state = 'idle'; error = undefined;
    return true;
  }

  function restore({ tenantId, clientId, refreshToken: rt }) {
    gen++; inflight = null; ids = { tenantId, clientId }; refreshToken = rt; access = null;
  }

  async function refresh() {
    const used = refreshToken;
    const g = gen;
    secrets.add(used);
    const r = await post(endpoint(ids.tenantId, 'token'), {
      grant_type: 'refresh_token', refresh_token: used, client_id: ids.clientId, scope: scopes,
    });
    const b = r.body;
    if (g !== gen) throw new MsAppError('signed-out', 'Not signed in.');
    if (r.status === 200 && b && b.access_token) {
      if (b.refresh_token && b.refresh_token !== used) {
        await onRefreshToken(b.refresh_token, used); // persisted before the caller sees the access token; `used` lets the saver compare-and-swap
        if (g !== gen) throw new MsAppError('signed-out', 'Not signed in.');
        refreshToken = b.refresh_token;
      }
      access = { token: b.access_token, expiresAt: now() + (Number(b.expires_in) || 3600) * 1000 };
      return access.token;
    }
    const c = classify(r.status, b, { consent });
    const kind = c.kind === 'transient' ? 'transient' : c.kind === 'config' ? 'config' : 'refused';
    throw new MsAppError(kind, redact(c.message));
  }

  async function accessToken() {
    if (!ids || !refreshToken) throw new MsAppError('signed-out', 'Not signed in.');
    if (access && now() < access.expiresAt - SKEW_MS) return access.token;
    if (!inflight) {
      const p = refresh().finally(() => { if (inflight === p) inflight = null; });
      inflight = p;
    }
    return inflight;
  }

  function forget() { access = null; }
  function signOut() { gen++; inflight = null; secrets.clear(); state = 'idle'; error = undefined; ids = null; refreshToken = null; access = null; }

  return { start, status, cancel, restore, accessToken, forget, signOut };
}

module.exports = { SCOPES, isGuid, classify, createMsApp, MsAppError };
