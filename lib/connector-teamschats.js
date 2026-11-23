'use strict';
// The Teams chats connector: read-only access to the signed-in person's own Teams chats through an app they register
// (delegated Chat.Read). This file holds the pure helpers (message HTML to plain text, chat id checks) and the MCP
// server over Graph. Every Graph call is a GET; there is no tool that sends, edits or deletes anything.
const { MsAppError } = require('./connector-msapp');

class ChatsError extends Error {
  constructor(message, detail) { super(message); if (detail) this.detail = detail; } // detail: the reason Test shows on the card
}

// Teams chat ids look like 19:…@thread.v2 or 19:…@unq.gbl.spaces. They go into a URL path (encoded), so only these characters.
const CHAT_ID_RE = /^[A-Za-z0-9:@._=-]{1,512}$/;
const BAD_ID = "That isn't a chat id. Use an id from chats_list.";

function checkChatId(s) {
  if (typeof s !== 'string' || !CHAT_ID_RE.test(s)) throw new ChatsError(BAD_ID);
  return s;
}

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

// Teams message HTML -> plain text. Mentions become @Name, emoji their alt text, inline images "[image]"; attachment
// placeholders are dropped (the message line says how many were skipped). Entities are decoded last, so escaped
// markup stays text.
function htmlToText(html) {
  const s = String(html == null ? '' : html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
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

const DEFAULT_CHATS = 10;
const MAX_CHATS = 50; // Graph's $top limit for chats
const DEFAULT_MESSAGES = 30;
const MAX_MESSAGES = 200;
const PAGE = 50; // Graph's $top limit for messages
const MAX_PAGES = 20;
const MAX_TEXT = 400 * 1024;
const LOOKUPS_AT_ONCE = 5;
const PREVIEW = 120;
const GONE = 'The Teams chats sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
const UNREACHABLE = "Couldn't reach Microsoft. Try again in a moment.";
const CONSENT = "Microsoft Graph refused: your app registration doesn't have consent for Chat.Read. If your organisation blocks user consent, ask an admin to grant consent for Chat.Read on your app registration, then sign in again.";
const NOT_IN = "Couldn't open that chat: it wasn't found, or you aren't in it. chat_get only reads chats you are a member of; use chats_list to see them.";
const EMPTY = 'No chats found. This connector sees only Teams chats you are a member of (one-to-one, group and meeting chats), not channel posts.';

const TOOLS = [
  {
    name: 'chats_list',
    description: `List your most recent Teams chats, newest first, with a short preview of the last message. limit is how many (1-${MAX_CHATS}, default ${DEFAULT_CHATS}). Each chat shows id=..., the chatId that chat_get needs.`,
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_CHATS, description: `How many chats, 1-${MAX_CHATS}. Default ${DEFAULT_CHATS}.` } } },
  },
  {
    name: 'chat_get',
    description: `Read one Teams chat's messages, newest first, as "[time] Name: text" lines in plain text. limit is how many messages (1-${MAX_MESSAGES}, default ${DEFAULT_MESSAGES}). Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'The id=... value from chats_list.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MESSAGES, description: `How many messages, 1-${MAX_MESSAGES}. Default ${DEFAULT_MESSAGES}.` },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'chats_help',
    description: 'Explain what the Teams chats tools can and cannot see.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HELP = [
  `chats_list {"limit": ${DEFAULT_CHATS}} lists your most recent chats, newest first (1-${MAX_CHATS}). Each chat ends with id=..., the chatId for chat_get.`,
  `chat_get {"chatId": "19:...", "limit": ${DEFAULT_MESSAGES}} reads one chat's messages, newest first (1-${MAX_MESSAGES}), as plain text. Output is cut at 400 KB.`,
  'Can see: one-to-one, group and meeting chats you are a member of, as yourself (delegated Chat.Read).',
  'Cannot see: Teams channel posts, chats you are not in, other people\'s chats, or images, files and other attachments (a message says how many it skipped).',
  'Cannot send, change, react to or delete anything: every call only reads.',
].join('\n');

const enc = encodeURIComponent;
const when = (s) => { const d = new Date(s); return typeof s === 'string' && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''; };
const time = (s) => (typeof s === 'string' && Date.parse(s)) || 0;
const TYPES = { oneOnOne: 'one-to-one', group: 'group', meeting: 'meeting' };
const typeName = (t) => (Object.hasOwn(TYPES, String(t)) ? TYPES[t] : 'chat');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const senderOf = (m) => {
  const f = (m && m.from) || {};
  const n = (f.user && f.user.displayName) || (f.application && f.application.displayName) || (f.device && f.device.displayName);
  return typeof n === 'string' && n.trim() ? oneLine(n) : 'Unknown';
};
const bodyText = (b) => (b && b.contentType === 'html' ? htmlToText(b.content) : String((b && b.content) || '').trim());

// One message as "[time] Name: text", later lines indented. Skipped attachments and edits are noted at the end.
function messageLine(m) {
  const head = `[${when(m.createdDateTime) || 'unknown time'}] ${senderOf(m)}: `;
  if (m.deletedDateTime) return `${head}(message deleted)`;
  const subject = typeof m.subject === 'string' && m.subject.trim() ? `${oneLine(m.subject)}\n` : '';
  const files = Array.isArray(m.attachments) ? m.attachments.length : 0;
  const notes = [];
  if (files) notes.push(`[${files} attachment${files === 1 ? '' : 's'} not shown]`);
  if (m.lastEditedDateTime) notes.push('(edited)');
  const text = [subject + bodyText(m.body), ...notes].filter(Boolean).join(' ').trim();
  return head + text.split('\n').join('\n    ');
}

function createTeamsChats({ fetch = globalThis.fetch, token, forget = () => {}, graph = 'https://graph.microsoft.com/v1.0' } = {}) {
  const base = new URL(graph);
  let me = null;

  async function tokenOrThrow() {
    try { return await token(); } catch (e) {
      // refused or signed out, or the app itself is wrong now (deleted, public client flows off, consent taken away):
      // sign in again; Test shows Microsoft's reason
      if (e instanceof MsAppError && (e.kind === 'refused' || e.kind === 'signed-out' || e.kind === 'config')) throw new ChatsError(GONE, e.kind === 'signed-out' ? undefined : e.message);
      throw new ChatsError(UNREACHABLE);
    }
  }

  // One GET; a 401 forgets the token and retries once. Returns { status, body }.
  async function get(url) {
    const once = async () => {
      const t = await tokenOrThrow();
      try { return await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${t}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30000) }); } catch { throw new ChatsError(UNREACHABLE); }
    };
    let res = await once();
    if (res.status === 401) { try { await res.body.cancel(); } catch { /* closed */ } forget(); res = await once(); }
    if (res.status === 401) throw new ChatsError(GONE);
    let body = '';
    try { body = await res.text(); } catch { throw new ChatsError(UNREACHABLE); }
    return { status: res.status, body };
  }

  const json = (s) => { try { return JSON.parse(s); } catch { throw new ChatsError(UNREACHABLE); } };

  // A GET that must succeed, as parsed JSON; other statuses become plain-words errors. inChat: the URL names one chat,
  // so "not found" or "forbidden" means the person isn't in it (unless Graph says a scope is missing).
  async function ok(url, inChat) {
    const r = await get(url);
    if (r.status >= 200 && r.status < 300) return json(r.body);
    let message = '';
    try { message = String(JSON.parse(r.body).error.message || ''); } catch { /* not JSON */ }
    if (r.status === 403 && (!inChat || /scope|consent/i.test(message))) throw new ChatsError(CONSENT);
    if (inChat && (r.status === 403 || r.status === 404 || r.status === 400)) throw new ChatsError(NOT_IN);
    if (r.status === 429 || r.status >= 500) throw new ChatsError(UNREACHABLE);
    throw new ChatsError(`Microsoft Graph answered ${r.status}.`);
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

  // Pages through a Graph collection until `enough` items are kept, the pages run out or the page cap is hit.
  async function collect(first, enough, keep, inChat) {
    const rows = [];
    let next = first;
    for (let page = 0; next && page < MAX_PAGES && rows.length < enough; page++) {
      const j = await ok(next, inChat);
      if (Array.isArray(j.value)) rows.push(...j.value.filter(keep));
      next = nextOf(j);
    }
    return { rows, more: rows.length > enough || !!next };
  }

  async function whoAmI(fresh) {
    if (!fresh && me) return me;
    const j = await ok(`${graph}/me?$select=id,userPrincipalName`);
    me = { id: typeof j.id === 'string' ? j.id : '', upn: typeof j.userPrincipalName === 'string' ? j.userPrincipalName : '' };
    return me;
  }

  // A chat's title: its topic, else the other members' names, else "(no title)". Never throws.
  async function titleOf(chat) {
    if (chat && typeof chat.topic === 'string' && chat.topic.trim()) return oneLine(chat.topic);
    try {
      const mine = (await whoAmI()).id;
      const j = await ok(`${graph}/me/chats/${enc(checkChatId(chat.id))}/members`, true);
      const names = (Array.isArray(j.value) ? j.value : [])
        .filter((m) => m && m.userId !== mine && typeof m.displayName === 'string' && m.displayName.trim())
        .map((m) => oneLine(m.displayName));
      if (!names.length) return '(no title)';
      return names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
    } catch { return '(no title)'; }
  }

  const checkLimit = (v, dflt, max) => {
    if (v === undefined || v === null) return dflt;
    if (!Number.isInteger(v) || v < 1 || v > max) throw new ChatsError(`limit must be a whole number from 1–${max}.`);
    return v;
  };

  async function listChats({ limit } = {}) {
    const n = checkLimit(limit, DEFAULT_CHATS, MAX_CHATS);
    const first = `${graph}/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime%20desc&$top=${n}`;
    const { rows, more } = await collect(first, n, (c) => c && typeof c.id === 'string' && CHAT_ID_RE.test(c.id));
    const at = (c) => time(c.lastMessagePreview && c.lastMessagePreview.createdDateTime) || time(c.lastUpdatedDateTime) || time(c.createdDateTime);
    const keep = rows.sort((a, b) => at(b) - at(a)).slice(0, n);
    const titles = new Array(keep.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, keep.length) }, async () => {
      while (i < keep.length) { const k = i++; titles[k] = await titleOf(keep[k]); }
    }));
    const lines = [];
    keep.forEach((c, k) => {
      const stamp = when((c.lastMessagePreview && c.lastMessagePreview.createdDateTime) || c.lastUpdatedDateTime || c.createdDateTime) || 'unknown time';
      lines.push(`${stamp} · ${titles[k]} · ${typeName(c.chatType)} · id=${c.id}`);
      const pv = c.lastMessagePreview;
      if (pv && typeof pv === 'object') {
        const text = pv.isDeleted ? '(message deleted)' : cut(oneLine(bodyText(pv.body)), PREVIEW);
        if (text) lines.push(`    ${senderOf(pv)}: ${text}`);
      }
    });
    if (!keep.length) return EMPTY;
    if (more) lines.push(`More chats exist. Ask for a higher limit (up to ${MAX_CHATS}) to see more.`);
    return lines.join('\n');
  }

  async function getChat({ chatId, limit } = {}) {
    const id = checkChatId(chatId);
    const n = checkLimit(limit, DEFAULT_MESSAGES, MAX_MESSAGES);
    // the messages first: a chat the person isn't in fails here, before anything else is asked
    const first = `${graph}/me/chats/${enc(id)}/messages?$top=${Math.min(n, PAGE)}&$orderby=createdDateTime%20desc`;
    const { rows, more } = await collect(first, n, (m) => m && (m.messageType === undefined || m.messageType === 'message'), true);
    const shown = rows.sort((a, b) => time(b.createdDateTime) - time(a.createdDateTime)).slice(0, n);
    let chat = null;
    try { chat = await ok(`${graph}/me/chats/${enc(id)}`, true); } catch { /* header only */ }
    const title = chat ? await titleOf(chat) : '(no title)';
    const header = `Chat: ${title}${chat && chat.chatType ? ` (${typeName(chat.chatType)})` : ''}\n`
      + `${shown.length ? `The newest ${shown.length} message${shown.length === 1 ? '' : 's'}, newest first.` : 'No messages.'}\n\n`;
    const parts = shown.map(messageLine);
    if (more) parts.push('', `Older messages exist. Ask for a higher limit (up to ${MAX_MESSAGES}) to read further back.`);
    const s = header + parts.join('\n');
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[cut at 400 KB]` : s;
  }

  const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

  async function callTool(name, args) {
    if (name === 'chats_help') return text(HELP);
    const a = args && typeof args === 'object' ? args : {};
    try {
      if (name === 'chats_list') return text(await listChats({ limit: a.limit }));
      if (name === 'chat_get') return text(await getChat({ chatId: a.chatId, limit: a.limit }));
      return text(`Unknown tool: ${name}`, true);
    } catch (e) {
      return text(e instanceof ChatsError ? e.message : UNREACHABLE, true);
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return undefined;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method === 'initialize') {
      const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'VaultOS Teams chats', version: '1' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const p = msg.params || {};
      return reply(await callTool(p.name, p.arguments));
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }

  // For the Test button: re-reads /me so a lost sign-in shows up, then one chat so missing consent does too.
  async function probe() {
    try {
      const u = await whoAmI(true);
      await ok(`${graph}/me/chats?$top=1`);
      return { ok: true, tools: TOOLS.length, error: null, account: u.upn };
    } catch (e) {
      return { ok: false, tools: 0, error: e instanceof ChatsError ? e.detail || e.message : UNREACHABLE };
    }
  }

  return { handle, probe, list: listChats, get: getChat };
}

module.exports = { ChatsError, checkChatId, htmlToText, TOOLS, createTeamsChats };
