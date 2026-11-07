#!/usr/bin/env node
'use strict';
// A fake Microsoft for the Teams transcripts connector: the device-code login endpoints and the few Graph v1.0
// calls the connector makes, on one port, plus a small control port. node:http only, so it runs inside the image.
//
//   node scripts/fake-msapp.js --port 5557 --control 5558 [--state /tmp/fake-msapp.json]
//
// Login:   POST /{tenant}/oauth2/v2.0/devicecode, POST /{tenant}/oauth2/v2.0/token (device_code and refresh_token grants;
//          refresh tokens rotate, and a spent one is refused with invalid_grant like the real thing).
// Graph:   GET /v1.0/me, /v1.0/users/{id}/onlineMeetings/getAllTranscripts(...), /v1.0/me/onlineMeetings/{m},
//          /v1.0/me/onlineMeetings/{m}/transcripts/{t} and .../content?$format=text/vtt. One meeting, one transcript.
// Control: GET /approve (the pending device code is entered), /refuse-refresh (the next refresh answers invalid_grant),
//          /forget-access (every issued access token stops working until a refresh), /state (counters), /reset.
// Only made-up IDs and alex@example.com.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

const ME = { id: 'aaaaaaaa-1111-2222-3333-444444444444', userPrincipalName: 'alex@example.com' };
const MEETING_ID = 'MSoxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTU';
const TRANSCRIPT_ID = 'VHJhbnNjcmlwdC0wMDAxLWZha2U';
const SUBJECT = 'Weekly planning';
const LINES = [
  ['Alex Example', "Let's go through the plan for the week."],
  ['Sam Sample', 'The migration is on track for Thursday.'],
  ['Alex Example', 'Good. Please send the notes round afterwards.'],
];
const vtt = () => {
  const t = (s) => `00:00:${String(s).padStart(2, '0')}.000`;
  const cues = LINES.map(([who, text], i) => `${'aaaa1111-0000-0000-0000-00000000000'}${i}/1-0\n${t(i * 5 + 1)} --> ${t(i * 5 + 4)}\n<v ${who}>${text}</v>`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
};

function startFake({ port = 0, control = 0, host = '127.0.0.1', statePath = '' } = {}) {
  const state = {
    scopes: [], devicecodes: 0, deviceTokens: 0, refreshes: 0, refused: 0, graph: 0, unauthorised: 0,
    approved: false, refuseNext: false, device: null, access: new Set(), refresh: new Set(), tenants: new Set(),
  };
  // With statePath, the live refresh tokens survive this process dying (a container restart), like a real service.
  if (statePath) { try { for (const t of JSON.parse(fs.readFileSync(statePath, 'utf8'))) state.refresh.add(t); } catch { /* none yet */ } }
  const persist = () => { if (statePath) try { fs.writeFileSync(statePath, JSON.stringify([...state.refresh])); } catch { /* best effort */ } };
  const rand = (p) => `${p}-${crypto.randomBytes(12).toString('hex')}`;
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
  };
  const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString())); });
  const issue = (withRefresh = true) => {
    const access = rand('at'); state.access.add(access);
    const out = { token_type: 'Bearer', scope: state.scopes.join(' '), expires_in: 3600, access_token: access };
    if (withRefresh) { const rt = rand('rt'); state.refresh.add(rt); persist(); out.refresh_token = rt; }
    return out;
  };
  const oauthError = (res, error, description, status = 400) => send(res, status, { error, error_description: `${description}\r\nTrace ID: 0\r\nCorrelation ID: 0` });

  async function token(req, res, tenant) {
    const p = new URLSearchParams(await readBody(req));
    state.tenants.add(tenant);
    if (p.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      state.deviceTokens++;
      if (!state.device || p.get('device_code') !== state.device.code) return oauthError(res, 'invalid_grant', 'AADSTS70000: Unknown device code.');
      if (!state.approved) return oauthError(res, 'authorization_pending', 'AADSTS70016: Pending end-user authorization.');
      state.device = null; state.approved = false;
      return send(res, 200, issue());
    }
    if (p.get('grant_type') === 'refresh_token') {
      state.refreshes++;
      const rt = p.get('refresh_token');
      if (state.refuseNext) { state.refuseNext = false; state.refused++; return oauthError(res, 'invalid_grant', 'AADSTS700082: The refresh token has expired due to inactivity.'); }
      if (!state.refresh.has(rt)) { state.refused++; return oauthError(res, 'invalid_grant', 'AADSTS70000: The refresh token was already used.'); }
      state.refresh.delete(rt); // rotating; issue() persists
      return send(res, 200, issue());
    }
    return oauthError(res, 'unsupported_grant_type', 'AADSTS70003: Unsupported grant.');
  }

  async function login(req, res, u) {
    const m = /^\/([^/]+)\/oauth2\/v2\.0\/(devicecode|token)$/.exec(u.pathname);
    if (!m || req.method !== 'POST') return send(res, 404, { error: 'not_found' });
    if (m[2] === 'token') return token(req, res, m[1]);
    const p = new URLSearchParams(await readBody(req));
    state.devicecodes++; state.tenants.add(m[1]);
    state.scopes = (p.get('scope') || '').split(' ').filter(Boolean);
    state.device = { code: rand('dc'), client: p.get('client_id') };
    state.approved = false;
    return send(res, 200, {
      device_code: state.device.code, user_code: 'FAKE1234', verification_uri: 'http://127.0.0.1/devicelogin',
      expires_in: 900, interval: 1, message: 'Enter the code.',
    });
  }

  function graph(req, res, u) {
    state.graph++;
    const h = req.headers.authorization || '';
    if (req.method !== 'GET' || !h.startsWith('Bearer ') || !state.access.has(h.slice(7))) {
      state.unauthorised++;
      return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is invalid.' } });
    }
    const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    const now = Date.now();
    const created = new Date(now - 86400000).toISOString();
    const ended = new Date(now - 86400000 + 1800000).toISOString();
    if (path === '/me') return send(res, 200, ME);
    if (path.startsWith(`/users/${ME.id}/onlineMeetings/getAllTranscripts(`)) {
      return send(res, 200, { value: [{ id: TRANSCRIPT_ID, meetingId: MEETING_ID, createdDateTime: created, meetingOrganizerId: ME.id }] });
    }
    if (path === `/me/onlineMeetings/${MEETING_ID}`) return send(res, 200, { id: MEETING_ID, subject: SUBJECT, startDateTime: created, endDateTime: ended });
    if (path === `/me/onlineMeetings/${MEETING_ID}/transcripts/${TRANSCRIPT_ID}`) return send(res, 200, { id: TRANSCRIPT_ID, createdDateTime: created, endDateTime: ended });
    if (path === `/me/onlineMeetings/${MEETING_ID}/transcripts/${TRANSCRIPT_ID}/content`) return send(res, 200, vtt(), 'text/vtt');
    return send(res, 404, { error: { code: 'NotFound', message: 'Not found.' } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/v1.0/')) return graph(req, res, u);
      return await login(req, res, u);
    } catch (e) { if (!res.headersSent) send(res, 500, { error: String(e.message) }); else res.end(); }
  });
  const ctl = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/approve') state.approved = true;
    else if (p === '/refuse-refresh') state.refuseNext = true;
    else if (p === '/forget-access') state.access.clear();
    else if (p === '/reset') { state.devicecodes = state.deviceTokens = state.refreshes = state.refused = state.graph = state.unauthorised = 0; state.refuseNext = state.approved = false; state.device = null; }
    else if (p !== '/state') return send(res, 404, { error: 'not_found' });
    send(res, 200, {
      devicecodes: state.devicecodes, deviceTokens: state.deviceTokens, refreshes: state.refreshes, refused: state.refused,
      graph: state.graph, unauthorised: state.unauthorised, pending: !!state.device, approved: state.approved,
      refuseNext: state.refuseNext, scopes: state.scopes,
    });
  });
  const listen = (s, p) => new Promise((ok, fail) => { s.once('error', fail); s.listen(p, host, () => ok(s.address().port)); });
  return Promise.all([listen(server, port), listen(ctl, control)]).then(([pp, cp]) => ({
    port: pp, controlPort: cp, state, MEETING_ID, TRANSCRIPT_ID, SUBJECT, LINES,
    stop: () => Promise.all([server, ctl].map((s) => new Promise((done) => { s.close(() => done()); s.closeAllConnections(); }))),
  }));
}

module.exports = { startFake, MEETING_ID, TRANSCRIPT_ID, SUBJECT, ME };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  startFake({ port: Number(arg('--port', 5557)), control: Number(arg('--control', 5558)), statePath: arg('--state', ''), host: process.env.FAKE_HOST || '127.0.0.1' })
    .then((f) => console.log(`fake Microsoft on :${f.port}, control on :${f.controlPort}`));
}
