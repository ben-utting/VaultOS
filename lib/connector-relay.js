'use strict';
// The agent relay: agents inside the container call /mcp/:id on loopback with X-VaultOS-Key;
// VaultOS adds the real credential and streams to the connector's MCP endpoint. An agent never
// sees a token and is never sent a 401 (a 401 would start the agent's own OAuth flow).
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const REQ_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const RES_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control'];
const MAX_BODY = 4 * 1024 * 1024;
const NOT_CONNECTED = 'not-connected';

const messages = {
  notConnected: (label) => `${label} isn't connected yet. Open Settings → Connectors in VaultOS to connect it.`,
  expired: (label) => `${label} sign-in has run out. Open Settings → Connectors in VaultOS to sign in again.`,
};

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function keyMatches(given, key) {
  if (typeof given !== 'string' || typeof key !== 'string' || !key) return false;
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serialised(fn) {
  let inflight = null;
  return (...args) => {
    if (inflight) return inflight;
    const run = (async () => fn(...args))();
    inflight = run;
    const clear = () => { if (inflight === run) inflight = null; };
    run.then(clear, clear);
    return run;
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; finish({ tooBig: true }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ failed: true }));
    req.on('close', () => finish({ failed: true }));
  });
}

function sendJson(res, status, obj) {
  const text = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const sendPlain = (res, status, text, extra = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
};

// What an agent hears when there is no usable sign-in. It still connects, so it can show the sentence.
function answerWithoutSignIn(res, rpc, sentence) {
  if (rpc === null) return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const msg = rpc && typeof rpc === 'object' && !Array.isArray(rpc) ? rpc : {};
  const id = msg.id === undefined ? null : msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (msg.id === undefined || (msg.id === null && method.startsWith('notifications/'))) return sendJson(res, 202);
  const reply = (result) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
    return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'VaultOS', version: '1' } });
  }
  if (method === 'tools/list') {
    return reply({ tools: [{ name: 'vaultos_sign_in', description: sentence, inputSchema: { type: 'object', properties: {} } }] });
  }
  if (method === 'tools/call' && msg.params && msg.params.name === 'vaultos_sign_in') {
    return reply({ content: [{ type: 'text', text: sentence }], isError: true });
  }
  return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32001, message: sentence } });
}

function parseRpc(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

// Target = { label, url, authorization(), renew(rejected), markNeedsSignIn(), missing() }.
// renew(rejected) gets the Authorization value the upstream just refused. When the target's current
// credential already differs from `rejected` (another caller refreshed first) it must return the
// current one without refreshing again; otherwise it refreshes (serialised) and returns the new one.
// authorization() and renew() return null ONLY when the sign-in is unusable (refresh refused, or no record).
// On a transient failure (network, 5xx) they THROW: the relay answers the agent with an error status and
// does not call markNeedsSignIn, so a blip never costs the person their sign-in. missing() says
// 'expired' while a sign-in record exists but is unusable, 'not-connected' when there is none.
function createRelay({ getKey, target, fetch = globalThis.fetch, log = () => {} }) {
  const refused = new Map(); // address -> last logged, so a noisy peer logs once a minute
  const noteRefused = (addr, why) => {
    const now = Date.now(), k = addr || 'unknown';
    if (now - (refused.get(k) || 0) < 60000) return;
    refused.set(k, now);
    if (refused.size > 200) for (const [a, t] of refused) if (now - t >= 60000) refused.delete(a);
    try { log(`connector relay refused ${why} from ${k}`); } catch { /* logging never breaks a request */ }
  };

  return async function relay(req, res) {
    try {
      const addr = req.socket && req.socket.remoteAddress;
      if (!isLoopback(addr)) { noteRefused(addr, 'a non-loopback peer'); return sendPlain(res, 403, 'Forbidden'); }
      if (!keyMatches(req.headers['x-vaultos-key'], getKey())) { noteRefused(addr, 'a wrong or missing key'); return sendPlain(res, 403, 'Forbidden'); }
      const m = /^\/mcp\/([^/?#]+)/.exec(req.originalUrl || req.url || '');
      const t = m ? target(decodeURIComponent(m[1])) : null;
      if (!t) return sendPlain(res, 404, 'Not found');
      const method = req.method;
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return sendPlain(res, 405, 'Method not allowed', { allow: 'GET, POST, DELETE' });

      let body = null;
      if (method === 'POST') {
        const r = await readBody(req);
        if (r.failed) return;
        if (r.tooBig) return sendPlain(res, 413, 'Payload too large', { connection: 'close' });
        body = r.body;
      }

      const noSignIn = (kind) => {
        if (method !== 'POST') return sendPlain(res, 405, 'Method not allowed', { allow: 'POST' });
        const sentence = (kind === 'expired' ? messages.expired : messages.notConnected)(t.label);
        return answerWithoutSignIn(res, parseRpc(body), sentence);
      };
      const kindNow = () => { try { return t.missing() === 'expired' ? 'expired' : NOT_CONNECTED; } catch { return NOT_CONNECTED; } };

      let auth = await t.authorization();
      if (!auth) return noSignIn(kindNow());

      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const headers = (authorization) => {
        const h = { authorization };
        for (const k of REQ_HEADERS) if (typeof req.headers[k] === 'string') h[k] = req.headers[k];
        return h;
      };
      const send = (authorization) => fetch(t.url, { method, headers: headers(authorization), body, signal: ac.signal, redirect: 'manual' });

      let up = await send(auth);
      if (up.status === 401) {
        try { up.body && await up.body.cancel(); } catch { /* already closed */ }
        const fresh = await t.renew(auth);
        if (fresh) {
          up = await send(fresh);
          if (up.status === 401) { try { up.body && await up.body.cancel(); } catch { /* closed */ } }
        }
        // No usable renewal: the sign-in is gone. A renewal that worked and was still refused is not a lost sign-in
        // (the server may be wrong or mid-change), so only this call hears the expired sentence.
        if (!fresh) t.markNeedsSignIn();
        if (!fresh || up.status === 401) return noSignIn('expired');
      }

      const out = {};
      for (const k of RES_HEADERS) { const v = up.headers.get(k); if (v) out[k] = v; }
      // Never pass a 401 on, whatever the connector does.
      res.writeHead(up.status === 401 ? 502 : up.status, out);
      res.flushHeaders(); // an SSE stream may be quiet for a while; the agent must see the headers now
      if (!up.body) return res.end();
      const stream = Readable.fromWeb(up.body);
      stream.on('error', () => { if (!res.destroyed) res.destroy(); });
      stream.pipe(res);
    } catch (e) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      if (res.writableEnded) return;
      sendPlain(res, 502, 'Bad gateway');
    }
  };
}

// Connects to an MCP endpoint, lists its tools, and can call one. Never throws: failures come back as { ok: false, error }.
async function mcpProbe(url, authorization, { fetch = globalThis.fetch } = {}) {
  let session = null, version = null, seq = 0;
  const fail = (error) => ({ ok: false, tools: [], error, call: async () => { throw new Error(error); } });
  const post = async (payload) => {
    const auth = typeof authorization === 'function' ? await authorization() : authorization;
    const headers = { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    if (version) headers['mcp-protocol-version'] = version;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    if (r.headers.get('mcp-session-id')) session = r.headers.get('mcp-session-id');
    return r;
  };
  const rpc = async (method, params) => {
    const id = ++seq;
    const r = await post({ jsonrpc: '2.0', id, method, params });
    if (!r.ok) { try { await r.body.cancel(); } catch { /* closed */ } throw new Error(`the server answered ${r.status}`); }
    const text = await r.text();
    let msg = null;
    if (/text\/event-stream/i.test(r.headers.get('content-type') || '')) {
      for (const ev of text.split(/\r?\n\r?\n/)) {
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j && (j.result !== undefined || j.error !== undefined)) { msg = j; break; }
      }
    } else { try { msg = JSON.parse(text); } catch { msg = null; } }
    if (!msg) throw new Error('the server sent no answer');
    if (msg.error) throw new Error(msg.error.message || 'the server returned an error');
    return msg.result || {};
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'VaultOS', version: '1' } });
    if (typeof init.protocolVersion === 'string') version = init.protocolVersion;
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    try { await n.body.cancel(); } catch { /* closed */ }
    const list = await rpc('tools/list', {});
    const tools = (list.tools || []).map((x) => x.name).filter((x) => typeof x === 'string');
    return { ok: true, tools, call: (name, args) => rpc('tools/call', { name, arguments: args || {} }) };
  } catch (e) {
    return fail(e && e.name === 'TimeoutError' ? 'the server did not answer in time' : (e && e.message) || 'the server could not be reached');
  }
}

module.exports = { REQ_HEADERS, RES_HEADERS, isLoopback, keyMatches, messages, createRelay, mcpProbe, serialised };
