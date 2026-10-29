#!/usr/bin/env node
'use strict';
// A fake Atlassian: OAuth 2.1 (dynamic client registration + PKCE) and a
// streamable-HTTP MCP endpoint. node:http only, so it runs inside the image.
const http = require('node:http');
const crypto = require('node:crypto');

const TOOLS = [
  { name: 'atlassianUserInfo', description: 'Who is signed in', inputSchema: { type: 'object', properties: {} } },
  { name: 'getAccessibleAtlassianResources', description: 'Sites the user can reach', inputSchema: { type: 'object', properties: {} } },
];

function startFake({ port = 0, host = '127.0.0.1', publicBase = '' } = {}) {
  const state = {
    seen: [], refreshes: 0, revoked: [], refuseRedirect: null, mode: 'normal',
    clients: {}, codes: {}, access: new Set(), refresh: {}, current: null,
  };
  let n = 0;
  const rand = (p) => `${p}-${crypto.randomBytes(12).toString('hex')}`;
  let base = '';

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((ok) => {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString()));
  });

  function issue(clientId) {
    const access = rand('at'), refresh = rand('rt');
    state.access.add(access); state.current = access;
    state.refresh[refresh] = clientId;
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 };
  }

  // Returns the signed-in email, or null for an unauthorised caller.
  function who(req) {
    const h = req.headers.authorization || '';
    if (h === 'Bearer svc-key') return 'alex@example.com';
    if (h.startsWith('Basic ')) {
      const [email, tok] = (() => {
        const s = Buffer.from(h.slice(6), 'base64').toString(); const i = s.lastIndexOf(':');
        return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
      })();
      return tok === 'tok' && email ? email : null;
    }
    if (h.startsWith('Bearer ')) {
      const t = h.slice(7);
      if (!state.access.has(t)) return null;
      if (state.mode === 'expire' && t === state.current) return null;
      return 'alex@example.com';
    }
    return null;
  }

  async function token(req, res) {
    const p = new URLSearchParams(await readBody(req));
    if (p.get('token') && p.get('token_type_hint')) {
      state.revoked.push(p.get('token'));
      state.access.delete(p.get('token')); delete state.refresh[p.get('token')];
      return send(res, 200, {});
    }
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const c = state.codes[p.get('code')];
      delete state.codes[p.get('code')];
      const v = p.get('code_verifier') || '';
      const ok = c && crypto.createHash('sha256').update(v).digest('base64url') === c.challenge;
      if (!ok) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, issue(c.clientId));
    }
    if (grant === 'refresh_token') {
      const rt = p.get('refresh_token');
      if (state.mode === 'refuse-refresh' || !(rt in state.refresh)) return send(res, 400, { error: 'invalid_grant' });
      state.refreshes++;
      const cid = state.refresh[rt]; delete state.refresh[rt];
      state.access.delete(state.current); // rotation: the old access token dies with its refresh token
      return send(res, 200, issue(cid));
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  async function mcp(req, res) {
    const email = who(req);
    const raw = await readBody(req);
    if (!email) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    let msg; try { msg = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
    const hdr = {};
    if (req.headers['mcp-session-id']) hdr['mcp-session-id'] = req.headers['mcp-session-id'];
    else if (msg.method === 'initialize') hdr['mcp-session-id'] = rand('sess');
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'notifications/initialized') { res.writeHead(202, hdr); return res.end(); }
    if (msg.method === 'initialize') {
      return send(res, 200, reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'fake-atlassian', version: '1.0.0' } }), hdr);
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...hdr });
      const ev = (o) => res.write(`event: message\ndata: ${JSON.stringify(o)}\n\n`);
      if (state.mode === 'slow-sse') {
        ev({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing' } });
        const t = setTimeout(() => { ev(reply({ tools: TOOLS })); res.end(); }, 300);
        res.on('close', () => clearTimeout(t));
      } else { ev(reply({ tools: TOOLS })); res.end(); }
      return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const data = name === 'atlassianUserInfo' ? { email }
        : name === 'getAccessibleAtlassianResources' ? [{ url: 'https://example.atlassian.net' }] : null;
      if (!data) return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } }, hdr);
      return send(res, 200, reply({ content: [{ type: 'text', text: JSON.stringify(data) }] }), hdr);
    }
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }, hdr);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base || 'http://x');
    state.seen.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });
    try {
      const k = `${req.method} ${url.pathname}`;
      if (k === 'GET /.well-known/oauth-authorization-server') {
        return send(res, 200, {
          issuer: base, authorization_endpoint: base + '/v1/authorize', token_endpoint: base + '/v1/token',
          registration_endpoint: base + '/v1/register', response_types_supported: ['code'],
          response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
          revocation_endpoint: base + '/v1/token', code_challenge_methods_supported: ['plain', 'S256'],
        });
      }
      if (k === 'POST /v1/register') {
        let b = {}; try { b = JSON.parse(await readBody(req)); } catch { /* empty */ }
        const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
        if (state.refuseRedirect && uris.some((u) => String(u).includes(state.refuseRedirect))) {
          return send(res, 400, { error: 'invalid_redirect_uri' });
        }
        const client_id = `fake-${++n}`;
        state.clients[client_id] = uris;
        return send(res, 201, { client_id, redirect_uris: uris });
      }
      if (k === 'GET /v1/authorize') {
        const q = url.searchParams;
        const uri = q.get('redirect_uri');
        if (!state.clients[q.get('client_id')] || !uri) return send(res, 400, { error: 'invalid_client' });
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, { error: 'invalid_request' });
        const code = rand('code');
        state.codes[code] = { challenge: q.get('code_challenge'), clientId: q.get('client_id') };
        const to = new URL(uri); to.searchParams.set('code', code);
        if (q.get('state') !== null) to.searchParams.set('state', q.get('state'));
        res.writeHead(302, { location: to.toString() }); return res.end();
      }
      if (k === 'POST /v1/token') return await token(req, res);
      if (k === 'POST /v1/mcp') return await mcp(req, res);
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e.message) }); else res.end();
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      base = publicBase || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`;
      ok({
        base, state,
        setMode: (m) => { state.mode = m; },
        stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFake };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  startFake({ port: i > 0 ? Number(process.argv[i + 1]) : 5555, host: process.env.FAKE_HOST || '0.0.0.0', publicBase: process.env.FAKE_BASE || '' })
    .then((f) => console.log(`fake MCP/OAuth listening on ${f.base}`));
}
