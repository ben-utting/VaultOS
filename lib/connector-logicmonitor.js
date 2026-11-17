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

module.exports = { LmError, normalisePortal, baseUrl, buildUrl, resourcePath, lmv1Header, maskSecrets, MASK, PATHS, QUERY_KEYS, MAX_TEXT };
