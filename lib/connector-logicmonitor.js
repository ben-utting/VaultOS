'use strict';
// The LogicMonitor connector: a small read-only MCP server VaultOS answers itself over LogicMonitor's REST API v3.
// It only ever sends GET, only to the person's own <portal>.logicmonitor.com, and only for the core monitoring
// paths below. Device config backups are never readable. The credential (a bearer token, or an LMv1 access ID and
// key) is never put in a reply or an error.
const crypto = require('node:crypto');

const REST = '/santaba/rest';
const MAX_TEXT = 100 * 1024;
const MASK = '(hidden by VaultOS)';
const HINT = 'Call lm_help for what lm_get can read.';

// First two path segments an agent may read: core monitoring only.
const PATHS = ['alert/alerts', 'device/devices', 'device/groups', 'device/devicedatasourceinstances', 'sdt/sdts'];
const QUERY_KEYS = ['fields', 'size', 'offset', 'filter', 'sort', 'start', 'end', 'period', 'datapoints', 'format', 'aggregate', 'needMessage'];
// A property whose name looks like this has its value hidden, on top of LogicMonitor's own masking.
const SECRET_NAME = /(pass|password|key|secret|token|community|credential)/i;

class LmError extends Error {}

// acme · acme.logicmonitor.com · https://acme.logicmonitor.com/santaba/rest → 'acme'; anything else → null.
function normalisePortal(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  const host = /^([^/]+\.logicmonitor\.com)(\/.*)?$/.exec(s);
  s = host ? host[1] : s.replace(/\/$/, '');
  s = s.replace(/\.logicmonitor\.com$/, '');
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

function baseUrl(portal, env = process.env) {
  const override = env.CONNECTOR_UPSTREAM_LOGICMONITOR;
  return override ? `${String(override).replace(/\/+$/, '')}${REST}` : `https://${portal}.logicmonitor.com${REST}`;
}

const invalid = () => new LmError(`That path is not valid. ${HINT}`);

// { path, query } → the URL to GET under `base`, or throws LmError saying why not.
function buildUrl(args, base) {
  const input = args && args.path;
  if (typeof input !== 'string' || !input.trim()) throw new LmError(`path is required. ${HINT}`);
  const b = new URL(base);
  // Checked on the text as given: the URL parser would quietly resolve .. and turn \ into /.
  const raw = input.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  if (/%2f|%5c/i.test(raw) || raw.includes('\\')) throw invalid();
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw invalid(); }
  if (decoded.split('/').some((s) => s === '..' || s === '.')) throw invalid();
  let u;
  try { u = /^https?:\/\//i.test(input) ? new URL(input) : new URL(input.startsWith('/') ? input : `/${input}`, b.origin); } catch { throw invalid(); }
  if (u.origin !== b.origin) throw new LmError(`Only ${b.host} can be read. ${HINT}`);

  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (p === REST || p.startsWith(`${REST}/`)) p = p.slice(REST.length);
  p = p.replace(/\/+$/, '');
  const segs = p.split('/').slice(1);
  if (segs.length < 2 || !PATHS.includes(`${segs[0]}/${segs[1]}`)) throw new LmError(`${p || '/'} is not available. ${HINT}`);
  if (segs.includes('config')) throw new LmError(`Device config backups are not available. ${HINT}`);

  const out = new URL(`${b.href.replace(/\/+$/, '')}${p}`);
  const allow = (k) => { if (!QUERY_KEYS.includes(k)) throw new LmError(`Query option ${k} is not allowed. Use ${QUERY_KEYS.join(', ')}.`); };
  for (const [k, v] of u.searchParams) { allow(k); out.searchParams.set(k, v); }
  const q = args.query;
  if (q !== undefined && q !== null) {
    if (typeof q !== 'object' || Array.isArray(q)) throw new LmError('query must be an object.');
    for (const [k, v] of Object.entries(q)) {
      allow(k);
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new LmError(`Query option ${k} must be text, a number or true/false.`);
      out.searchParams.set(k, String(v));
    }
  }
  return out;
}

// The path LMv1 signs: after /santaba/rest, without the query.
function resourcePath(url, base) {
  const bp = new URL(base).pathname.replace(/\/+$/, '');
  return url.pathname.startsWith(bp) ? url.pathname.slice(bp.length) : url.pathname;
}

// LMv1 <accessId>:<base64 of the hex HMAC-SHA256 of verb + epoch + body + path>:<epoch>
function lmv1Header({ accessId, accessKey }, verb, epochMs, resource, body = '') {
  const hex = crypto.createHmac('sha256', accessKey).update(`${verb}${epochMs}${body}${resource}`).digest('hex');
  return `LMv1 ${accessId}:${Buffer.from(hex).toString('base64')}:${epochMs}`;
}

// A copy with secret-looking property values hidden, at any depth.
function maskSecrets(v) {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = maskSecrets(x);
  if (typeof out.name === 'string' && Object.hasOwn(out, 'value') && SECRET_NAME.test(out.name)) out.value = MASK;
  return out;
}

const TOOLS = [
  {
    name: 'lm_get',
    description: 'Read LogicMonitor monitoring data (GET only, REST API v3): alerts (/alert/alerts), devices with their datasources, instances and metric data (/device/devices/…), device groups (/device/groups/…), graph data (/device/devicedatasourceinstances/…) and scheduled downtime (/sdt/sdts). query takes fields, filter, size, offset, sort, start, end and the like, e.g. /alert/alerts with {"filter":"severity>:3,cleared:false","size":"20"}. Call lm_help for the paths and the filter syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A REST API v3 path such as /alert/alerts or /device/devices/{id}/devicedatasources.' },
        query: { type: 'object', description: `Options: ${QUERY_KEYS.join(', ')}.`, additionalProperties: { type: ['string', 'number', 'boolean'] } },
      },
      required: ['path'],
    },
  },
  {
    name: 'lm_help',
    description: 'List what lm_get can read, with the filter syntax and examples.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HELP = [
  'lm_get reads (GET only) these LogicMonitor paths:',
  '- /alert/alerts, /alert/alerts/{id}',
  '- /device/devices, /device/devices/{id}, and below it: /alerts, /properties, /sdts, /historysdts, /devicedatasources, /devicedatasources/{id}/instances, /devicedatasources/{id}/instances/{id}/data, …/graphs/{graphId}/data, /alertsettings',
  '- /device/groups, /device/groups/{id}, /device/groups/{id}/devices, /device/groups/{id}/alerts, /device/groups/{id}/sdts',
  '- /device/devicedatasourceinstances/{instanceId}/graphs/{graphId}/data',
  '- /sdt/sdts, /sdt/sdts/{id} (scheduled downtime)',
  'Filters: field, operator, value. Operators are : (equals), !: (not equal), ~ (contains), !~ (does not contain), > < >: <: (compare). A comma means AND, and text values are quoted, for example {"filter":"displayName~\\"web\\",hostStatus:\\"normal\\""}.',
  'Alert severity is 1 info, 2 warning, 3 error, 4 critical: {"filter":"severity>:3,cleared:false"} is the active error and critical alerts.',
  'Paging: size (up to 1000) and offset. fields picks the fields to return, e.g. {"fields":"id,displayName,hostStatus"}. On …/data paths, start and end are epoch seconds and datapoints names the datapoints.',
  'Collectors, websites, dashboards, settings, users and device config backups are not available through this connector.',
].join('\n');

const LOST = 'LogicMonitor no longer accepts this token. Open Settings → Connectors in VaultOS and paste a new one.';
const NOT_CONNECTED = "LogicMonitor isn't connected. Open Settings → Connectors in VaultOS to connect it.";
const CUT = '\n…[cut at 100 KB; narrow it with fields, filter or size]';

// credentials() is read on every call, so a newly saved token is used at once. onLost runs on a 401.
function createLogicMonitor({ fetch = globalThis.fetch, now = Date.now, env = process.env, credentials = () => null, onLost = () => {} } = {}) {
  const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });
  const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}${CUT}` : s);

  // One GET: { ok: true, text } | { ok: false, text, status?, upstream?, lost? }.
  async function get(args) {
    const cred = credentials();
    if (!cred || !cred.portal) return { ok: false, text: NOT_CONNECTED };
    const base = baseUrl(cred.portal, env);
    let url;
    try { url = buildUrl(args || {}, base); } catch (e) {
      if (e instanceof LmError) return { ok: false, text: e.message };
      throw e;
    }
    const authorization = cred.token ? `Bearer ${cred.token}` : lmv1Header(cred, 'GET', now(), resourcePath(url, base));
    let res, body;
    try {
      res = await fetch(url, { method: 'GET', headers: { accept: 'application/json', 'X-Version': '3', authorization }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      body = await res.text();
    } catch {
      return { ok: false, text: `Couldn't reach ${new URL(base).host}. Try again in a moment.` };
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      let out = body;
      try { out = JSON.stringify(maskSecrets(JSON.parse(body)), null, 1); } catch { /* not JSON: as it came */ }
      return { ok: true, text: cut(out) };
    }
    let upstream = '';
    try { const j = JSON.parse(body); if (j && typeof j.errorMessage === 'string') upstream = j.errorMessage.slice(0, 300); } catch { /* not JSON */ }
    const fail = (t, extra = {}) => ({ ok: false, text: t, status, upstream, ...extra });
    if (status === 401) {
      try { await onLost(); } catch { /* the reply still says what happened */ }
      return fail(LOST, { lost: true });
    }
    if (status === 403) return fail(`LogicMonitor answered 403${upstream ? `: ${upstream}` : ''}. The token's role can't read this.`);
    if (status === 429) return fail('LogicMonitor is rate-limiting these requests. Try again in a minute.');
    return fail(`LogicMonitor answered ${status}.${upstream ? ` ${upstream}` : ''}`);
  }

  async function callTool(name, args) {
    if (name === 'lm_help') return text(HELP);
    if (name !== 'lm_get') return text(`Unknown tool: ${name}`, true);
    const r = await get(args);
    return text(r.text, !r.ok);
  }

  // One JSON-RPC message in; the reply object out, or undefined for a notification.
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return undefined;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method === 'initialize') {
      const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'VaultOS LogicMonitor', version: '1' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const p = msg.params || {};
      return reply(await callTool(p.name, p.arguments));
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }

  // For save and Test: one small read. status/upstream come from a non-2xx reply only.
  async function probe() {
    const r = await get({ path: '/device/devices', query: { size: 1, fields: 'id' } });
    if (r.ok) return { ok: true, tools: TOOLS.length, error: null };
    return { ok: false, tools: 0, error: r.text, ...(r.status ? { status: r.status, upstream: r.upstream } : {}), ...(r.lost ? { lost: true } : {}) };
  }

  return { handle, callTool, probe };
}

module.exports = { LmError, normalisePortal, baseUrl, buildUrl, resourcePath, lmv1Header, maskSecrets, createLogicMonitor, TOOLS, HELP, MASK, PATHS, QUERY_KEYS, MAX_TEXT };
