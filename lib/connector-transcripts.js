'use strict';
// The Teams transcripts connector: read-only access to Microsoft Teams meeting transcripts through an app the user
// registers. This file holds the pure helpers (VTT to readable text, ID checks) and the MCP server over Graph.
const { MsAppError } = require('./connector-msapp');

class TranscriptsError extends Error {}

const ID_RE = /^[A-Za-z0-9_=\-]{1,2000}$/;

// Graph IDs go into URL paths, so only a tight character set is allowed.
function checkId(s) {
  if (typeof s !== 'string' || !ID_RE.test(s)) throw new TranscriptsError('Invalid ID.');
  return s;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// "00:01:05.500" or "01:05.500" -> "[hh:mm]"
function stamp(t) {
  const parts = t.split(':');
  const h = parts.length >= 3 ? parts[0] : '0';
  const m = parts.length >= 3 ? parts[1] : parts[0];
  return `[${h.padStart(2, '0')}:${m.padStart(2, '0')}]`;
}

// WebVTT -> "[hh:mm] Speaker: text" lines; consecutive cues from one speaker merge under the first cue's time.
function vttToText(vtt) {
  const src = String(vtt || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out = [];
  let last = null;
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const start = lines[at].split('-->')[0].trim();
    let text = lines.slice(at + 1).join(' ').trim();
    let speaker = 'Unknown';
    const v = /^<v(?:\.[^\s>]*)*\s+([^>]*)>/.exec(text);
    if (v) { speaker = decode(v[1].trim()) || 'Unknown'; text = text.slice(v[0].length); }
    text = decode(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (last && last.speaker === speaker) { last.text += ` ${text}`; continue; }
    last = { stamp: stamp(start), speaker, text };
    out.push(last);
  }
  return out.map((c) => `${c.stamp} ${c.speaker}: ${c.text}`).join('\n');
}


const MAX_LINES = 100;
const MAX_PAGES = 20;
const MAX_TEXT = 400 * 1024;
const LOOKUPS_AT_ONCE = 5;
const GONE = 'The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
const UNREACHABLE = "Couldn't reach Microsoft. Try again in a moment.";

const TOOLS = [
  {
    name: 'transcripts_list',
    description: 'List Teams meeting transcripts from meetings you organised, newest first. days is how far back to look (1-30, default 7). Each line gives the meetingId and transcriptId that transcript_get needs.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: 'Days back, 1-30. Default 7.' } } },
  },
  {
    name: 'transcript_get',
    description: 'Read one meeting transcript as "[hh:mm] Speaker: text" lines, under a Subject/Start/End header. Set raw to true for the original WebVTT.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'From transcripts_list.' },
        transcriptId: { type: 'string', description: 'From transcripts_list.' },
        raw: { type: 'boolean', description: 'Return the WebVTT unchanged.' },
      },
      required: ['meetingId', 'transcriptId'],
    },
  },
  {
    name: 'transcripts_help',
    description: 'Explain what the Teams transcripts tools can and cannot see.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HELP = [
  'transcripts_list {"days": 7} lists transcripts from the last 1-30 days, newest first, at most 100 lines. Each line ends with meetingId=... transcriptId=...',
  'transcript_get {"meetingId": "...", "transcriptId": "..."} reads one transcript as "[hh:mm] Speaker: text" (add "raw": true for the WebVTT). Output is cut at 400 KB.',
  'Limits: only meetings you organised are visible; a meeting needs transcription turned on while it ran; transcripts expire after a while (set by your organisation).',
].join('\n');

const EMPTY = 'No transcripts found in that time. This connector sees only meetings you organised, and only ones that ran with transcription on. Transcripts also expire after a while, so try a shorter window or a recent meeting.';

const enc = encodeURIComponent;
const when = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' '); };

function createTranscripts({ fetch = globalThis.fetch, token, forget = () => {}, now = Date.now, graph = 'https://graph.microsoft.com/v1.0' } = {}) {
  const base = new URL(graph);
  let me = null;

  async function tokenOrThrow() {
    try { return await token(); } catch (e) {
      if (e instanceof MsAppError && (e.kind === 'refused' || e.kind === 'signed-out')) throw new TranscriptsError(GONE);
      throw new TranscriptsError(UNREACHABLE);
    }
  }

  // One GET; a 401 forgets the token and retries once. Returns { status, body }.
  async function get(url, accept = 'application/json') {
    const once = async () => {
      const t = await tokenOrThrow();
      try { return await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${t}`, accept }, redirect: 'manual', signal: AbortSignal.timeout(30000) }); } catch { throw new TranscriptsError(UNREACHABLE); }
    };
    let res = await once();
    if (res.status === 401) { try { await res.body.cancel(); } catch { /* closed */ } forget(); res = await once(); }
    if (res.status === 401) throw new TranscriptsError(GONE);
    let body = '';
    try { body = await res.text(); } catch { throw new TranscriptsError(UNREACHABLE); }
    return { status: res.status, body };
  }

  // GET that must succeed; other statuses become plain-words errors.
  async function ok(url, accept) {
    const r = await get(url, accept);
    if (r.status >= 200 && r.status < 300) return r.body;
    let code = '';
    try { code = JSON.parse(r.body).error.code || ''; } catch { /* not JSON */ }
    if (r.status === 403 && code === 'GraphAccessToTranscriptsDisabled') throw new TranscriptsError('Your organisation has turned off transcript access through Graph.');
    if (r.status === 403) throw new TranscriptsError("The app registration doesn't carry the permission for this (or admin consent is missing).");
    if (r.status === 404) throw new TranscriptsError("Not found. It may have expired, or you didn't organise that meeting.");
    if (r.status === 429 || r.status >= 500) throw new TranscriptsError(UNREACHABLE);
    throw new TranscriptsError(`Microsoft Graph answered ${r.status}.`);
  }

  const json = (s) => { try { return JSON.parse(s); } catch { throw new TranscriptsError(UNREACHABLE); } };

  async function whoAmI(fresh) {
    if (!fresh && me) return me;
    const j = json(await ok(`${graph}/me?$select=id,userPrincipalName`));
    me = { id: checkId(j.id), upn: typeof j.userPrincipalName === 'string' ? j.userPrincipalName : '' };
    return me;
  }

  // Subject and times of one meeting, or null if it can't be had for any reason.
  async function meeting(id) {
    try {
      const r = await get(`${graph}/me/onlineMeetings/${enc(checkId(id))}?$select=subject,startDateTime,endDateTime`);
      if (r.status !== 200) return null;
      return json(r.body);
    } catch { return null; }
  }

  async function list({ days } = {}) {
    if (days === undefined || days === null) days = 7;
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new TranscriptsError('days must be a whole number from 1–30.');
    const { id } = await whoAmI();
    const end = now();
    const first = `${graph}/users/${enc(id)}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${enc(id)}',startDateTime=${new Date(end - days * 86400000).toISOString()},endDateTime=${new Date(end).toISOString()})`;
    const rows = [];
    let next = first;
    for (let page = 0; next && page < MAX_PAGES && rows.length <= MAX_LINES; page++) {
      const j = json(await ok(next));
      if (Array.isArray(j.value)) rows.push(...j.value);
      next = null;
      const link = j['@odata.nextLink'];
      if (typeof link === 'string') {
        try {
          const u = new URL(link);
          if (u.origin === base.origin && u.pathname.startsWith(base.pathname)) next = link;
        } catch { /* ignore a bad link */ }
      }
    }
    const more = rows.length > MAX_LINES || !!next;
    const keep = rows.filter((r) => r && typeof r.id === 'string' && typeof r.meetingId === 'string')
      .sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime))).slice(0, MAX_LINES);
    const ids = [...new Set(keep.map((r) => r.meetingId))];
    const info = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, ids.length) }, async () => {
      while (i < ids.length) { const m = ids[i++]; info.set(m, await meeting(m)); }
    }));
    const items = keep.map((r) => {
      const m = info.get(r.meetingId);
      return { start: (m && when(m.startDateTime)) || when(r.createdDateTime), subject: (m && m.subject) || '(no subject)', meetingId: r.meetingId, transcriptId: r.id };
    }).sort((a, b) => b.start.localeCompare(a.start));
    items.more = more;
    return items;
  }

  async function getTranscript({ meetingId, transcriptId, raw } = {}) {
    const m = checkId(meetingId);
    const t = checkId(transcriptId);
    const vtt = await ok(`${graph}/me/onlineMeetings/${enc(m)}/transcripts/${enc(t)}/content?$format=text/vtt`, 'text/vtt');
    const info = await meeting(m);
    const header = `Subject: ${(info && info.subject) || '(no subject)'}\nStart: ${(info && when(info.startDateTime)) || 'unknown'}\nEnd: ${(info && when(info.endDateTime)) || 'unknown'}\n\n`;
    const body = raw === true ? vtt : vttToText(vtt);
    const s = header + body;
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[cut at 400 KB]` : s;
  }

  const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

  async function callTool(name, args) {
    if (name === 'transcripts_help') return text(HELP);
    try {
      if (name === 'transcripts_list') {
        const items = await list({ days: args && args.days });
        if (!items.length) return text(EMPTY);
        const lines = items.map((x) => `${x.start} · ${x.subject} · meetingId=${x.meetingId} transcriptId=${x.transcriptId}`);
        if (items.more) lines.push(`More transcripts exist than the ${MAX_LINES} shown. Use a smaller days value to see the rest.`);
        return text(lines.join('\n'));
      }
      if (name === 'transcript_get') return text(await getTranscript(args || {}));
      return text(`Unknown tool: ${name}`, true);
    } catch (e) {
      return text(e instanceof TranscriptsError ? e.message : UNREACHABLE, true);
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return undefined;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method === 'initialize') {
      const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'VaultOS Teams transcripts', version: '1' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const p = msg.params || {};
      return reply(await callTool(p.name, p.arguments));
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }

  // For the Test button: re-reads /me so a lost sign-in shows up.
  async function probe() {
    try {
      const u = await whoAmI(true);
      return { ok: true, tools: TOOLS.length, error: null, account: u.upn };
    } catch (e) {
      return { ok: false, tools: 0, error: e instanceof TranscriptsError ? e.message : UNREACHABLE };
    }
  }

  return { handle, probe, list, get: getTranscript };
}

module.exports = { TranscriptsError, checkId, vttToText, TOOLS, createTranscripts };
