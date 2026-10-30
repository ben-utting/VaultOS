'use strict';
// The Entra connector: a small MCP server VaultOS answers itself. It asks the shared `az` login for a Microsoft
// Graph token on demand (nothing is stored) and only ever sends GET, so it is read-only whatever the token allows.
const { runCapture } = require('./connector-azure');

const GRAPH = 'https://graph.microsoft.com';
const MAX_TEXT = 100 * 1024;
const TOKEN_MS = 10 * 60 * 1000;
const TOKEN_CMD = 'az account get-access-token --resource-type ms-graph --query accessToken -o tsv';

// First path segments an agent may read. The az token only carries directory scopes, so mail, files and Teams are not here.
const AREAS = [
  'me', 'organization', 'users', 'groups', 'applications', 'servicePrincipals', 'directoryRoles',
  'roleManagement', 'domains', 'devices', 'subscribedSkus', 'auditLogs',
];

const TOOLS = [
  {
    name: 'graph_get',
    description: 'Read Microsoft Entra data from Microsoft Graph (GET only). path is like /users, /users/{id}, /groups/{id}/members, /me or /auditLogs/signIns. query takes OData options such as {"$select":"displayName,mail","$top":"10","$filter":"..."}. Pass an @odata.nextLink as path to get the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A Graph v1.0 path, or an @odata.nextLink URL.' },
        query: { type: 'object', description: 'OData options; keys start with $ ($select, $filter, $top, $search, $count, $expand, $orderby).', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      },
      required: ['path'],
    },
  },
  {
    name: 'graph_help',
    description: 'List the Graph areas graph_get can read, with example calls.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HELP = [
  `graph_get reads (GET only) these areas: ${AREAS.map((a) => `/${a}`).join(', ')}.`,
  'Examples: /me · /organization · /users with {"$select":"displayName,userPrincipalName","$top":"10"} · /users/{id}/memberOf · /groups with {"$filter":"startswith(displayName,\'Eng\')"} · /applications · /servicePrincipals · /directoryRoles · /auditLogs/signIns with {"$top":"20"}.',
  'Mail, files, calendars and Teams are not available through this connector.',
].join('\n');

class EntraError extends Error {}

// A path or nextLink URL -> { path, search } on v1.0, or throws EntraError saying why not.
function resolveTarget(input) {
  if (typeof input !== 'string' || !input.trim()) throw new EntraError('path is required.');
  let u;
  try { u = /^https?:\/\//i.test(input) ? new URL(input) : new URL(input.startsWith('/') ? input : `/${input}`, GRAPH); } catch { throw new EntraError('That path is not valid.'); }
  if (u.origin !== GRAPH) throw new EntraError('Only graph.microsoft.com paths can be read.');
  let p = u.pathname.replace(/\/{2,}/g, '/');
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { throw new EntraError('That path is not valid.'); }
  if (decoded.split('/').includes('..') || decoded.includes('\\')) throw new EntraError('That path is not valid.');
  if (/^\/v1\.0(\/|$)/.test(p)) p = p.slice(5);
  else if (/^\/(beta|v\d)/i.test(p)) throw new EntraError('Only the v1.0 API can be read.');
  const first = p.split('/')[1] || '';
  if (!AREAS.includes(first)) throw new EntraError(`/${first} is not available. Call graph_help for the areas that are.`);
  if (p.includes('$batch')) throw new EntraError('Batching is not available.');
  return { path: p.replace(/\/+$/, '') || '/', search: u.search };
}

function buildUrl(args) {
  const { path, search } = resolveTarget(args && args.path);
  const url = new URL(GRAPH + '/v1.0' + path + search);
  const q = args && args.query;
  if (q !== undefined && q !== null) {
    if (typeof q !== 'object' || Array.isArray(q)) throw new EntraError('query must be an object.');
    for (const [k, v] of Object.entries(q)) {
      if (!/^\$[A-Za-z]+$/.test(k)) throw new EntraError(`Query option ${k} is not allowed. Use OData options that start with $.`);
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new EntraError(`Query option ${k} must be text or a number.`);
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

function createEntra({ run = runCapture, fetch = globalThis.fetch, now = Date.now } = {}) {
  let cached = null; // { token, at }

  async function token(fresh) {
    if (!fresh && cached && now() - cached.at < TOKEN_MS) return cached.token;
    const r = await run(TOKEN_CMD);
    const t = r && r.code === 0 ? String(r.stdout).trim() : '';
    if (!/^eyJ[\w.-]+$/.test(t)) { cached = null; throw new EntraError('The Azure sign-in has run out. Open Settings → Connectors in VaultOS and sign in to Azure again.'); }
    cached = { token: t, at: now() };
    return t;
  }

  // One GET. Returns { status, body }; a 401 gets one retry with a fresh token.
  async function get(url) {
    const once = async (fresh) => {
      const t = await token(fresh);
      const headers = { authorization: `Bearer ${t}`, accept: 'application/json' };
      if (url.searchParams.has('$search') || url.searchParams.has('$count') || url.searchParams.has('$filter')) headers.consistencylevel = 'eventual';
      return fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    };
    let res = await once(false);
    if (res.status === 401) { try { await res.body.cancel(); } catch { /* closed */ } res = await once(true); }
    return { status: res.status, body: await res.text() };
  }

  const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

  async function callTool(name, args) {
    if (name === 'graph_help') return text(HELP);
    if (name !== 'graph_get') return text(`Unknown tool: ${name}`, true);
    try {
      const { status, body } = await get(buildUrl(args || {}));
      if (status >= 200 && status < 300) {
        return text(body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n…[cut at ${MAX_TEXT / 1024} KB; narrow it with $select, $filter or $top]` : body);
      }
      let msg = `Microsoft Graph answered ${status}.`;
      try { const e = JSON.parse(body).error; if (e && e.message) msg += ` ${e.code ? `${e.code}: ` : ''}${e.message}`; } catch { /* not JSON */ }
      if (status === 403) msg += ' The Azure sign-in does not carry the permission for this.';
      return text(msg, true);
    } catch (e) {
      if (e instanceof EntraError) return text(e.message, true);
      return text("Couldn't reach Microsoft Graph. Try again in a moment.", true);
    }
  }

  // One JSON-RPC message in; the reply object out, or undefined for a notification.
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return undefined;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method === 'initialize') {
      const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'VaultOS Entra', version: '1' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const p = msg.params || {};
      return reply(await callTool(p.name, p.arguments));
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }

  // For the Test button: can a Graph token be had and used? Returns { ok, tools, error, org }.
  async function probe() {
    cached = null; // Test must notice a lost sign-in, so it never trusts the saved token
    const r = await callTool('graph_get', { path: '/organization', query: { $select: 'displayName' } });
    if (r.isError) return { ok: false, tools: 0, error: r.content[0].text };
    let org;
    try { org = JSON.parse(r.content[0].text).value[0].displayName; } catch { /* best effort */ }
    return { ok: true, tools: TOOLS.length, error: null, org };
  }

  return { handle, probe };
}

module.exports = { createEntra, resolveTarget, buildUrl, AREAS, TOOLS, EntraError };
