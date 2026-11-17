#!/usr/bin/env node
'use strict';
// A fake Atlassian laid out like its v2 MCP server: /v2/mcp takes OAuth tokens from a separate authorization server
// (found through the resource metadata, RFC 9728, at /as), /v1/mcp takes only API tokens (Basic, or the svc-key
// Bearer). OAuth 2.1 with dynamic client registration + PKCE; streamable-HTTP MCP. node:http only, so it runs inside
// the image.
const http = require('node:http');
const crypto = require('node:crypto');

const TOOLS = [
  { name: 'atlassianUserInfo', description: 'Who is signed in', inputSchema: { type: 'object', properties: {} } },
  { name: 'getAccessibleAtlassianResources', description: 'Sites the user can reach', inputSchema: { type: 'object', properties: {} } },
];
// Listed only when standing in for a connector with no OAuth (noAuth), so the Atlassian tool list stays at two.
const GET_ME = { name: 'get_me', description: 'The signed-in login', inputSchema: { type: 'object', properties: {} } };
const SCOPES = ['read:me', 'offline_access', 'read:jira:agent-interface', 'write:jira:agent-interface'];
// shape 'vantage': read and write tools, as Vantage names them.
const VT_TOOLS = ['query-costs', 'list-budgets', 'get-myself', 'list-ingest-tokens', 'create-budget', 'delete-folder']
  .map((name) => ({ name, description: name.replace(/-/g, ' '), inputSchema: { type: 'object', properties: {} } }));
const VT_DATA = {
  'query-costs': { costs: [{ service: 'EC2', amount: '12.34' }] }, 'list-budgets': { budgets: [] },
  'get-myself': { email: 'alex@example.com', workspace: 'Main' }, 'list-ingest-tokens': { tokens: ['ingest-secret'] },
  'create-budget': { created: true }, 'delete-folder': { deleted: true },
};

// shape 'vantage' stands in for Vantage: the path-specific resource metadata is an HTML 403 (a challenge page), the
// root documents name the origin, the redirect carries iss, POST /mcp takes an OAuth token or `Bearer vt-key`, and
// tools/list answers SSE with a notification first and the result's JSON split over two data lines.
function startFake({ port = 0, host = '127.0.0.1', publicBase = '', noAuth = false, shape = 'atlassian' } = {}) {
  const vantage = shape === 'vantage';
  const state = {
    seen: [], resources: [], scopes: [], calls: [], refreshes: 0, revoked: [], refuseRedirect: null, mode: 'normal',
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

  // Returns the signed-in email, or null for an unauthorised caller. `takes` limits it to 'oauth' or 'token' credentials.
  function who(req, takes) {
    const h = req.headers.authorization || '';
    if (takes === 'vantage' && h === 'Bearer vt-key') return 'alex@example.com';
    const isToken = h === 'Bearer svc-key' || h.startsWith('Basic ');
    if (takes === 'vantage' ? isToken : (takes && takes !== (isToken ? 'token' : 'oauth'))) return null;
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
    if (grant === 'authorization_code' || grant === 'refresh_token') state.resources.push({ at: grant, resource: p.get('resource') }); // RFC 8707
    if (grant === 'authorization_code') {
      const c = state.codes[p.get('code')];
      delete state.codes[p.get('code')];
      const v = p.get('code_verifier') || '';
      const ok = c && c.clientId === p.get('client_id') && c.redirectUri === p.get('redirect_uri')
        && crypto.createHash('sha256').update(v).digest('base64url') === c.challenge;
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

  const PRM_PATH = '/.well-known/oauth-protected-resource/v2/mcp';

  async function mcp(req, res, takes) {
    const email = who(req, takes);
    const raw = await readBody(req);
    if (!email && !noAuth) {
      const challenge = takes === 'oauth' ? `Bearer resource_metadata="${base}${PRM_PATH}"`
        : takes === 'vantage' ? `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` : 'Bearer';
      return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': challenge });
    }
    let msg; try { msg = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
    const hdr = {};
    if (req.headers['mcp-session-id']) hdr['mcp-session-id'] = req.headers['mcp-session-id'];
    else if (msg.method === 'initialize') hdr['mcp-session-id'] = rand('sess');
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'notifications/initialized') { res.writeHead(202, hdr); return res.end(); }
    if (msg.method === 'initialize') {
      return send(res, 200, reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: vantage ? 'fake-vantage' : 'fake-atlassian', version: '1.0.0' } }), hdr);
    }
    if (vantage && msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...hdr });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      const json = JSON.stringify(reply({ tools: VT_TOOLS }));
      const cut = json.indexOf('"tools":'); // a line break here keeps the joined JSON valid
      res.write(`event: message\nid: 1\ndata: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\n`);
      return res.end();
    }
    if (vantage && msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      state.calls.push(name);
      if (!Object.hasOwn(VT_DATA, name)) return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } }, hdr);
      return send(res, 200, reply({ content: [{ type: 'text', text: JSON.stringify(VT_DATA[name]) }] }), hdr);
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...hdr });
      const ev = (o) => res.write(`event: message\ndata: ${JSON.stringify(o)}\n\n`);
      if (state.mode === 'slow-sse') {
        ev({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing' } });
        const t = setTimeout(() => { ev(reply({ tools: noAuth ? [...TOOLS, GET_ME] : TOOLS })); res.end(); }, 300);
        res.on('close', () => clearTimeout(t));
      } else { ev(reply({ tools: noAuth ? [...TOOLS, GET_ME] : TOOLS })); res.end(); }
      return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const data = name === 'atlassianUserInfo' ? { email }
        : name === 'get_me' ? { login: 'alex-example' }
        : name === 'getAccessibleAtlassianResources' ? [{ url: 'https://example.atlassian.net' }] : null;
      if (!data) return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } }, hdr);
      return send(res, 200, reply({ content: [{ type: 'text', text: JSON.stringify(data) }] }), hdr);
    }
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }, hdr);
  }

  async function register(req, res) {
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch { /* empty */ }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (state.refuseRedirect && uris.some((u) => String(u).includes(state.refuseRedirect))) {
      return send(res, 400, { error: 'invalid_redirect_uri' });
    }
    const client_id = `fake-${++n}`;
    state.clients[client_id] = uris;
    return send(res, 201, { client_id, redirect_uris: uris });
  }

  function authorize(res, url, iss) {
    const q = url.searchParams;
    const uri = q.get('redirect_uri');
    const reg = state.clients[q.get('client_id')];
    if (!reg) return send(res, 400, { error: 'invalid_client' });
    if (!uri || !reg.includes(uri)) return send(res, 400, { error: 'invalid_redirect_uri' });
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, { error: 'invalid_request' });
    state.resources.push({ at: 'authorize', resource: q.get('resource') });
    state.scopes.push(q.get('scope'));
    const code = rand('code');
    state.codes[code] = { challenge: q.get('code_challenge'), clientId: q.get('client_id'), redirectUri: uri };
    const to = new URL(uri); to.searchParams.set('code', code);
    if (q.get('state') !== null) to.searchParams.set('state', q.get('state'));
    if (iss) to.searchParams.set('iss', iss);
    res.writeHead(302, { location: to.toString() }); return res.end();
  }

  async function vantageRoute(k, req, res, url) {
    if (k === 'GET /.well-known/oauth-protected-resource/mcp') {
      res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>');
    }
    if (k === 'GET /.well-known/oauth-protected-resource') return send(res, 200, { resource: base, authorization_servers: [base], bearer_methods_supported: ['header'] });
    if (k === 'GET /.well-known/oauth-authorization-server') {
      return send(res, 200, {
        issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'], revocation_endpoint: base + '/token',
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
      });
    }
    if (k === 'POST /register') return register(req, res);
    if (k === 'GET /authorize') return authorize(res, url, base);
    if (k === 'POST /token') return token(req, res);
    if (k === 'POST /mcp') return mcp(req, res, 'vantage');
    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base || 'http://x');
    state.seen.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });
    try {
      const k = `${req.method} ${url.pathname}`;
      if (vantage) return await vantageRoute(k, req, res, url);
      if (k === `GET ${PRM_PATH}`) {
        return send(res, 200, { resource: base + '/v2/mcp', authorization_servers: [base + '/as'], bearer_methods_supported: ['header'], scopes_supported: SCOPES });
      }
      if (k === 'GET /.well-known/oauth-authorization-server/as') { // RFC 8414: the issuer's path goes after the well-known part
        return send(res, 200, {
          issuer: base + '/as', authorization_endpoint: base + '/as/authorize', token_endpoint: base + '/as/token',
          registration_endpoint: base + '/as/register', response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
          revocation_endpoint: base + '/as/token', code_challenge_methods_supported: ['S256'],
        });
      }
      if (k === 'POST /as/register') return await register(req, res);
      if (k === 'GET /as/authorize') return authorize(res, url);
      if (k === 'POST /as/token') return await token(req, res);
      if (k === 'POST /v2/mcp') return await mcp(req, res, 'oauth');
      if (k === 'POST /v1/mcp') return await mcp(req, res, 'token');
      if (k === 'POST /mcp/' || k === 'POST /api/mcp') return await mcp(req, res);
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
        base, state, scopes: SCOPES,
        setMode: (m) => { state.mode = m; },
        stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFake };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  startFake({ port: i > 0 ? Number(process.argv[i + 1]) : 5555, host: process.env.FAKE_HOST || '0.0.0.0', publicBase: process.env.FAKE_BASE || '', noAuth: process.argv.includes('--no-auth') })
    .then((f) => console.log(`fake MCP/OAuth listening on ${f.base}`));
}
