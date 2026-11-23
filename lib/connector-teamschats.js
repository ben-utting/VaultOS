'use strict';
// The Teams chats connector: read-only access to the signed-in person's own Teams chats through an app they register
// (delegated Chat.Read). This file holds the pure helpers (message HTML to plain text, chat id checks) and the MCP
// server over Graph. Every Graph call is a GET; there is no tool that sends, edits or deletes anything.
const G = require('./connector-graph');

const { GraphError: ChatsError, htmlToText, when, time, oneLine, cut, capText, bodyText, checkLimit } = G;

// Teams chat ids look like 19:…@thread.v2 or 19:…@unq.gbl.spaces. They go into a URL path (encoded), so only these characters.
const CHAT_ID_RE = /^[A-Za-z0-9:@._=-]{1,512}$/;
const BAD_ID = "That isn't a chat id. Use an id from chats_list.";

function checkChatId(s) {
  if (typeof s !== 'string' || !CHAT_ID_RE.test(s)) throw new ChatsError(BAD_ID);
  return s;
}

const DEFAULT_CHATS = 10;
const MAX_CHATS = 50; // Graph's $top limit for chats
const DEFAULT_MESSAGES = 30;
const MAX_MESSAGES = 200;
const PAGE = 50; // Graph's $top limit for messages
const LOOKUPS_AT_ONCE = 5;
const PREVIEW = 120;
const GONE = 'The Teams chats sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
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
const TYPES = { oneOnOne: 'one-to-one', group: 'group', meeting: 'meeting' };
const typeName = (t) => (Object.hasOwn(TYPES, String(t)) ? TYPES[t] : 'chat');
const senderOf = (m) => {
  const f = (m && m.from) || {};
  const n = (f.user && f.user.displayName) || (f.application && f.application.displayName) || (f.device && f.device.displayName);
  return typeof n === 'string' && n.trim() ? oneLine(n) : 'Unknown';
};

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
  const client = G.createGraphClient({ fetch, token, forget, graph, gone: GONE, consent: CONSENT, notFound: NOT_IN });
  const { ok, collect, whoAmI } = client;

  // A chat's title: its topic, else the other members' names, else "(no title)". Never throws.
  async function titleOf(chat) {
    if (chat && typeof chat.topic === 'string' && chat.topic.trim()) return oneLine(chat.topic);
    try {
      const mine = (await whoAmI()).id;
      const j = await ok(`${graph}/me/chats/${enc(checkChatId(chat.id))}/members`, { item: true });
      const names = (Array.isArray(j.value) ? j.value : [])
        .filter((m) => m && m.userId !== mine && typeof m.displayName === 'string' && m.displayName.trim())
        .map((m) => oneLine(m.displayName));
      if (!names.length) return '(no title)';
      return names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
    } catch { return '(no title)'; }
  }

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
        const t = pv.isDeleted ? '(message deleted)' : cut(oneLine(bodyText(pv.body)), PREVIEW);
        if (t) lines.push(`    ${senderOf(pv)}: ${t}`);
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
    const { rows, more } = await collect(first, n, (m) => m && (m.messageType === undefined || m.messageType === 'message'), { item: true });
    const shown = rows.sort((a, b) => time(b.createdDateTime) - time(a.createdDateTime)).slice(0, n);
    let chat = null;
    try { chat = await ok(`${graph}/me/chats/${enc(id)}`, { item: true }); } catch { /* header only */ }
    const title = chat ? await titleOf(chat) : '(no title)';
    const header = `Chat: ${title}${chat && chat.chatType ? ` (${typeName(chat.chatType)})` : ''}\n`
      + `${shown.length ? `The newest ${shown.length} message${shown.length === 1 ? '' : 's'}, newest first.` : 'No messages.'}\n\n`;
    const parts = shown.map(messageLine);
    if (more) parts.push('', `Older messages exist. Ask for a higher limit (up to ${MAX_MESSAGES}) to read further back.`);
    return capText(header + parts.join('\n'));
  }

  const handle = G.mcpHandler({
    name: 'VaultOS Teams chats', tools: TOOLS,
    run: async (tool, a) => {
      if (tool === 'chats_help') return HELP;
      if (tool === 'chats_list') return listChats({ limit: a.limit });
      return getChat({ chatId: a.chatId, limit: a.limit });
    },
  });

  // For the Test button: re-reads /me so a lost sign-in shows up, then one chat so missing consent does too.
  const probe = () => G.probeWith(client, TOOLS, `${graph}/me/chats?$top=1`);

  return { handle, probe, list: listChats, get: getChat };
}

module.exports = { ChatsError, checkChatId, htmlToText, TOOLS, createTeamsChats };
