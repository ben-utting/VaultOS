'use strict';
// What every Microsoft Graph connector server shares (Teams chats, Outlook mail, Outlook calendar): a GET with the
// person's token (a 401 forgets it and retries once), plain-words errors, paging that only follows Graph's own next
// links, message HTML to plain text, and the MCP methods. Every call is a GET; nothing here can change anything.
const { MsAppError } = require('./connector-msapp');

class GraphError extends Error {
  constructor(message, detail) { super(message); if (detail) this.detail = detail; } // detail: the reason Test shows on the card
}

const UNREACHABLE = "Couldn't reach Microsoft. Try again in a moment.";
const MAX_PAGES = 20;
const MAX_TEXT = 400 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const k = e.toLowerCase();
    return Object.hasOwn(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

// Message HTML -> plain text. Mentions become @Name, emoji their alt text, inline images "[image]"; attachment
// placeholders are dropped (the caller says how many were skipped). Entities are decoded last, so escaped markup stays text.
function htmlToText(html) {
  const s = String(html == null ? '' : html)
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment\s*>/gi, '')
    .replace(/<emoji\b[^>]*?\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<img\b[^>]*>/gi, ' [image] ')
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at\s*>/gi, '@$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|tr|h[1-6]|blockquote|pre|table)\s*>|<hr\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n').replace(/\n{2,}/g, '\n').trim();
}

const when = (s) => { const d = new Date(s); return typeof s === 'string' && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''; };
const time = (s) => (typeof s === 'string' && Date.parse(s)) || 0;
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const capText = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[cut at 400 KB]` : s);
const bodyText = (b) => (b && b.contentType === 'html' ? htmlToText(b.content) : String((b && b.content) || '').trim());

// A whole number from 1-max, or the default when it's left out.
function checkLimit(v, dflt, max, what = 'limit') {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new GraphError(`${what} must be a whole number from 1–${max}.`);
  return v;
}

// gone: the sentence when the sign-in is lost; consent: the sentence when Graph says a scope is missing;
// notFound: the sentence when a URL that names one thing (a chat, a message, an event) isn't there or isn't yours.
function createGraphClient({ fetch, token, forget = () => {}, graph, gone, consent, notFound }) {
  const base = new URL(graph);

  async function tokenOrThrow() {
    try { return await token(); } catch (e) {
      // refused or signed out, or the app itself is wrong now (deleted, public client flows off, consent taken away):
      // sign in again; Test shows Microsoft's reason
      if (e instanceof MsAppError && (e.kind === 'refused' || e.kind === 'signed-out' || e.kind === 'config')) throw new GraphError(gone, e.kind === 'signed-out' ? undefined : e.message);
      throw new GraphError(UNREACHABLE);
    }
  }

  async function get(url, headers = {}) {
    const once = async () => {
      const t = await tokenOrThrow();
      try { return await fetch(url, { method: 'GET', headers: { ...headers, authorization: `Bearer ${t}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30000) }); } catch { throw new GraphError(UNREACHABLE); }
    };
    let res = await once();
    if (res.status === 401) { try { await res.body.cancel(); } catch { /* closed */ } forget(); res = await once(); }
    if (res.status === 401) throw new GraphError(gone);
    let body = '';
    try { body = await res.text(); } catch { throw new GraphError(UNREACHABLE); }
    return { status: res.status, body };
  }

  const json = (s) => { try { return JSON.parse(s); } catch { throw new GraphError(UNREACHABLE); } };

  // A GET that must succeed, as parsed JSON. item: the URL names one thing, so "not found" or "forbidden" means it isn't
  // there or isn't the person's (unless Graph says a scope is missing).
  async function ok(url, { item = false, headers, missing = notFound } = {}) {
    const r = await get(url, headers);
    if (r.status >= 200 && r.status < 300) return json(r.body);
    let message = '';
    try { message = String(JSON.parse(r.body).error.message || ''); } catch { /* not JSON */ }
    if (r.status === 403 && (!item || /scope|consent/i.test(message))) throw new GraphError(consent);
    if (item && (r.status === 403 || r.status === 404 || r.status === 400)) throw new GraphError(missing);
    if (r.status === 429 || r.status >= 500) throw new GraphError(UNREACHABLE);
    throw new GraphError(`Microsoft Graph answered ${r.status}.`);
  }

  // Only a next page on the same Graph is followed.
  function nextOf(j) {
    const link = j && j['@odata.nextLink'];
    if (typeof link !== 'string') return null;
    try {
      const u = new URL(link);
      return u.origin === base.origin && u.pathname.startsWith(base.pathname) ? link : null;
    } catch { return null; }
  }

  // Pages through a collection until `enough` items are kept, the pages run out or the page cap is hit.
  async function collect(first, enough, keep = () => true, opts) {
    const rows = [];
    let next = first;
    for (let page = 0; next && page < MAX_PAGES && rows.length < enough; page++) {
      const j = await ok(next, opts);
      if (Array.isArray(j.value)) rows.push(...j.value.filter(keep));
      next = nextOf(j);
    }
    return { rows, more: rows.length > enough || !!next };
  }

  let me = null;
  async function whoAmI(fresh) {
    if (!fresh && me) return me;
    const j = await ok(`${graph}/me?$select=id,userPrincipalName`);
    me = { id: typeof j.id === 'string' ? j.id : '', upn: typeof j.userPrincipalName === 'string' ? j.userPrincipalName : '' };
    return me;
  }

  return { get, ok, json, nextOf, collect, whoAmI };
}

const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

// The MCP methods. run(name, args) -> string answers a tool; a GraphError becomes an isError result with its sentence.
function mcpHandler({ name, tools, run }) {
  async function callTool(tool, args) {
    if (!tools.some((t) => t.name === tool)) return text(`Unknown tool: ${tool}`, true);
    try { return text(await run(tool, args && typeof args === 'object' && !Array.isArray(args) ? args : {})); } catch (e) {
      return text(e instanceof GraphError ? e.message : UNREACHABLE, true);
    }
  }
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return undefined;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method === 'initialize') {
      const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name, version: '1' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools });
    if (method === 'tools/call') {
      const p = msg.params || {};
      return reply(await callTool(p.name, p.arguments));
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  };
}

// For the Test button: reads /me (a lost sign-in shows up) and then `check` (missing consent shows up).
async function probeWith(client, tools, check) {
  try {
    const u = await client.whoAmI(true);
    await client.ok(check);
    return { ok: true, tools: tools.length, error: null, account: u.upn };
  } catch (e) {
    return { ok: false, tools: 0, error: e instanceof GraphError ? e.detail || e.message : UNREACHABLE };
  }
}

module.exports = {
  GraphError, UNREACHABLE, MAX_TEXT, htmlToText, decodeEntities, when, time, oneLine, cut, capText, bodyText, checkLimit,
  createGraphClient, mcpHandler, probeWith,
};
