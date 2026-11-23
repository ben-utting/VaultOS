'use strict';
// The Outlook connectors: read-only access to the signed-in person's own mailbox (delegated Mail.Read) and calendar
// (delegated Calendars.Read) through an app they register. Two MCP servers over Graph. Every call is a GET; there is
// no tool that sends, moves, deletes, accepts or changes anything. Bodies come back as plain text; attachments are
// never fetched.
const G = require('./connector-graph');

const { GraphError, when, time, oneLine, cut, capText, bodyText, checkLimit } = G;
const enc = encodeURIComponent;

// Graph message and event ids are base64-like. They go into a URL path (encoded), so only these characters.
const ITEM_ID_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;
function checkItemId(s, bad) {
  if (typeof s !== 'string' || !ITEM_ID_RE.test(s)) throw new GraphError(bad);
  return s;
}

const person = (r) => {
  const a = (r && r.emailAddress) || {};
  const name = oneLine(a.name || '');
  const addr = oneLine(a.address || '');
  if (name && addr && name !== addr) return `${name} <${addr}>`;
  return name || addr || 'Unknown';
};
const people = (list) => (Array.isArray(list) && list.length ? list.map(person).join(', ') : '');
const PREVIEW = 120;
const TEXT = { Prefer: 'outlook.body-content-type="text"' };

// ---------------------------------------------------------------- mail
const MAIL_FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'];
const DEFAULT_MAIL = 10;
const MAX_MAIL = 50;
const MAX_SEARCH = 25;
const MAIL_GONE = 'The Outlook mail sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
const MAIL_CONSENT = "Microsoft Graph refused: your app registration doesn't have consent for Mail.Read. If your organisation blocks user consent, ask an admin to grant consent for Mail.Read on your app registration, then sign in again.";
const MAIL_MISSING = "That message wasn't found in your mailbox. Use an id from mail_list or mail_search.";
const BAD_MAIL_ID = "That isn't a message id. Use an id from mail_list or mail_search.";
const MAIL_SELECT = 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview';

const MAIL_TOOLS = [
  {
    name: 'mail_list',
    description: `List the newest messages in one of your mail folders, newest first, with a short preview. folder is one of ${MAIL_FOLDERS.join(', ')} (default inbox); limit 1-${MAX_MAIL} (default ${DEFAULT_MAIL}); unreadOnly shows only unread mail. Each message shows id=..., the messageId mail_get needs.`,
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', enum: MAIL_FOLDERS, description: 'Default inbox.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MAIL, description: `How many, 1-${MAX_MAIL}. Default ${DEFAULT_MAIL}.` },
        unreadOnly: { type: 'boolean', description: 'Only unread messages.' },
      },
    },
  },
  {
    name: 'mail_search',
    description: `Search your mailbox (all folders) the way Outlook search does: words, a sender, a subject. limit 1-${MAX_SEARCH} (default ${DEFAULT_MAIL}). Each message shows id=... for mail_get.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "budget review" or from:sam@example.com.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH, description: `How many, 1-${MAX_SEARCH}. Default ${DEFAULT_MAIL}.` },
      },
      required: ['query'],
    },
  },
  {
    name: 'mail_get',
    description: 'Read one message: subject, sender, recipients, date and the body as plain text. Attachments are not opened. Read-only.',
    inputSchema: { type: 'object', properties: { messageId: { type: 'string', description: 'The id=... value from mail_list or mail_search.' } }, required: ['messageId'] },
  },
  {
    name: 'mail_help',
    description: 'Explain what the Outlook mail tools can and cannot see.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const MAIL_HELP = [
  `mail_list {"folder": "inbox", "limit": ${DEFAULT_MAIL}, "unreadOnly": false} lists the newest messages in a folder (${MAIL_FOLDERS.join(', ')}).`,
  `mail_search {"query": "budget review"} searches every folder, up to ${MAX_SEARCH} results.`,
  'mail_get {"messageId": "..."} reads one message as plain text. Output is cut at 400 KB.',
  'Can see: the mailbox of the account you signed in with (delegated Mail.Read).',
  "Cannot see: attachments (a message only says it has some), shared or other people's mailboxes.",
  'Cannot send, reply, move, flag, mark as read or delete anything: every call only reads.',
].join('\n');

function mailLine(m) {
  const flags = [m.isRead === false ? 'unread' : '', m.hasAttachments ? 'attachments' : ''].filter(Boolean);
  const head = `${when(m.receivedDateTime) || 'unknown time'} · ${person(m.from)} · ${oneLine(m.subject) || '(no subject)'}${flags.length ? ` · ${flags.join(', ')}` : ''} · id=${m.id}`;
  const pv = cut(oneLine(m.bodyPreview || ''), PREVIEW);
  return pv ? `${head}\n    ${pv}` : head;
}

function createOutlookMail({ fetch = globalThis.fetch, token, forget = () => {}, graph = 'https://graph.microsoft.com/v1.0' } = {}) {
  const client = G.createGraphClient({ fetch, token, forget, graph, gone: MAIL_GONE, consent: MAIL_CONSENT, notFound: MAIL_MISSING });
  const keep = (m) => m && typeof m.id === 'string' && ITEM_ID_RE.test(m.id);

  async function list({ folder, limit, unreadOnly } = {}) {
    const f = folder === undefined || folder === null ? 'inbox' : folder;
    if (!MAIL_FOLDERS.includes(f)) throw new GraphError(`folder must be one of ${MAIL_FOLDERS.join(', ')}.`);
    if (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') throw new GraphError('unreadOnly must be true or false.');
    const n = checkLimit(limit, DEFAULT_MAIL, MAX_MAIL);
    // Graph wants a $filter to name the $orderby property first, hence the always-true date test before isRead.
    const filter = unreadOnly ? '&$filter=receivedDateTime%20ge%201900-01-01T00:00:00Z%20and%20isRead%20eq%20false' : '';
    const first = `${graph}/me/mailFolders/${f}/messages?$select=${MAIL_SELECT}&$orderby=receivedDateTime%20desc&$top=${n}${filter}`;
    const { rows, more } = await client.collect(first, n, keep, { item: true, missing: `Your mailbox has no ${f} folder.` });
    const shown = rows.sort((a, b) => time(b.receivedDateTime) - time(a.receivedDateTime)).slice(0, n);
    if (!shown.length) return unreadOnly ? `No unread messages in ${f}.` : `No messages in ${f}.`;
    const lines = shown.map(mailLine);
    if (more) lines.push(`More messages exist. Ask for a higher limit (up to ${MAX_MAIL}) to see more.`);
    return lines.join('\n');
  }

  async function search({ query, limit } = {}) {
    const q = typeof query === 'string' ? query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!q || q.length > 200) throw new GraphError('query must be some words to look for, at most 200 characters.');
    const n = checkLimit(limit, DEFAULT_MAIL, MAX_SEARCH);
    const first = `${graph}/me/messages?$search=${enc(`"${q}"`)}&$select=${MAIL_SELECT}&$top=${n}`;
    const { rows } = await client.collect(first, n, keep);
    const shown = rows.slice(0, n);
    if (!shown.length) return `Nothing in your mailbox matches ${q}.`;
    return shown.map(mailLine).join('\n');
  }

  async function get({ messageId } = {}) {
    const id = checkItemId(messageId, BAD_MAIL_ID);
    const m = await client.ok(`${graph}/me/messages/${enc(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,body`, { item: true, headers: TEXT });
    const head = [
      `Subject: ${oneLine(m.subject) || '(no subject)'}`,
      `From: ${person(m.from)}`,
      people(m.toRecipients) ? `To: ${people(m.toRecipients)}` : '',
      people(m.ccRecipients) ? `Cc: ${people(m.ccRecipients)}` : '',
      `Date: ${when(m.receivedDateTime) || 'unknown'}`,
      m.hasAttachments ? 'Attachments: yes, not shown' : '',
    ].filter(Boolean).join('\n');
    return capText(`${head}\n\n${bodyText(m.body)}`);
  }

  const handle = G.mcpHandler({
    name: 'VaultOS Outlook mail', tools: MAIL_TOOLS,
    run: async (tool, a) => {
      if (tool === 'mail_help') return MAIL_HELP;
      if (tool === 'mail_list') return list({ folder: a.folder, limit: a.limit, unreadOnly: a.unreadOnly });
      if (tool === 'mail_search') return search({ query: a.query, limit: a.limit });
      return get({ messageId: a.messageId });
    },
  });
  const probe = () => G.probeWith(client, MAIL_TOOLS, `${graph}/me/mailFolders/inbox/messages?$top=1&$select=id`);
  return { handle, probe, list, search, get };
}

// ---------------------------------------------------------------- calendar
const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const MAX_EVENTS = 200;
const CAL_GONE = 'The Outlook calendar sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
const CAL_CONSENT = "Microsoft Graph refused: your app registration doesn't have consent for Calendars.Read. If your organisation blocks user consent, ask an admin to grant consent for Calendars.Read on your app registration, then sign in again.";
const CAL_MISSING = "That event wasn't found in your calendar. Use an id from calendar_list.";
const BAD_EVENT_ID = "That isn't an event id. Use an id from calendar_list.";
const UTC = { Prefer: 'outlook.timezone="UTC"' };

const CAL_TOOLS = [
  {
    name: 'calendar_list',
    description: `List the events in your Outlook calendar from a day onwards, earliest first, times in UTC. from is a date like 2026-11-24 (default today, UTC); days is how many days (1-${MAX_DAYS}, default ${DEFAULT_DAYS}). Each event shows id=..., the eventId calendar_get needs.`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD. Default today (UTC).' },
        days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: `How many days, 1-${MAX_DAYS}. Default ${DEFAULT_DAYS}.` },
      },
    },
  },
  {
    name: 'calendar_get',
    description: 'Read one event: when, where, organiser, attendees and their responses, the meeting link, and the description as plain text. Read-only.',
    inputSchema: { type: 'object', properties: { eventId: { type: 'string', description: 'The id=... value from calendar_list.' } }, required: ['eventId'] },
  },
  {
    name: 'calendar_help',
    description: 'Explain what the Outlook calendar tools can and cannot see.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const CAL_HELP = [
  `calendar_list {"from": "2026-11-24", "days": ${DEFAULT_DAYS}} lists events from that day for 1-${MAX_DAYS} days, earliest first, in UTC, at most ${MAX_EVENTS}.`,
  'calendar_get {"eventId": "..."} reads one event in full. Output is cut at 400 KB.',
  'Can see: the calendar of the account you signed in with (delegated Calendars.Read), recurring events as their single occurrences.',
  "Cannot see: other people's or shared calendars, or attachments.",
  'Cannot create, accept, decline, move or delete anything: every call only reads.',
].join('\n');

// Graph answers in the Prefer'd time zone with no offset ("2026-11-24T09:00:00.0000000"): read it as UTC.
const utc = (dt) => (dt && typeof dt.dateTime === 'string' ? `${dt.dateTime.replace(/Z$/, '')}Z` : '');
const hhmm = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 16); };
const day = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
function span(e) {
  const s = utc(e.start); const t = utc(e.end);
  if (e.isAllDay) {
    const last = new Date(Date.parse(t) - 1);
    return day(s) === day(last) || !day(t) ? `${day(s)} (all day)` : `${day(s)} to ${last.toISOString().slice(0, 10)} (all day)`;
  }
  if (day(s) && day(s) === day(t)) return `${day(s)} ${hhmm(s)}–${hhmm(t)} UTC`;
  return `${when(s) || 'unknown'} to ${when(t) || 'unknown'}`;
}
const where = (e) => oneLine((e.location && e.location.displayName) || '');

function createOutlookCalendar({ fetch = globalThis.fetch, token, forget = () => {}, now = Date.now, graph = 'https://graph.microsoft.com/v1.0' } = {}) {
  const client = G.createGraphClient({ fetch, token, forget, graph, gone: CAL_GONE, consent: CAL_CONSENT, notFound: CAL_MISSING });

  async function list({ from, days } = {}) {
    let start;
    if (from === undefined || from === null) start = Date.parse(`${new Date(now()).toISOString().slice(0, 10)}T00:00:00Z`);
    else {
      start = typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(`${from}T00:00:00Z`) : NaN;
      if (Number.isNaN(start)) throw new GraphError('from must be a date like 2026-11-24.');
    }
    const n = checkLimit(days, DEFAULT_DAYS, MAX_DAYS, 'days');
    const a = new Date(start).toISOString();
    const b = new Date(start + n * 86400000).toISOString();
    const first = `${graph}/me/calendarView?startDateTime=${a}&endDateTime=${b}&$orderby=start/dateTime&$top=50`
      + '&$select=id,subject,start,end,location,organizer,isAllDay,isCancelled,showAs';
    const { rows, more } = await client.collect(first, MAX_EVENTS, (e) => e && typeof e.id === 'string' && ITEM_ID_RE.test(e.id), { headers: UTC });
    const shown = rows.sort((x, y) => time(utc(x.start)) - time(utc(y.start))).slice(0, MAX_EVENTS);
    const range = `${a.slice(0, 10)} to ${new Date(start + n * 86400000 - 1).toISOString().slice(0, 10)}`;
    if (!shown.length) return `No events from ${range}.`;
    const lines = shown.map((e) => [
      span(e), oneLine(e.subject) || '(no subject)', where(e), e.organizer ? `organiser ${person(e.organizer)}` : '',
      e.isCancelled ? 'cancelled' : '', `id=${e.id}`,
    ].filter(Boolean).join(' · '));
    lines.unshift(`Events from ${range}, earliest first (UTC):`);
    if (more) lines.push(`More than ${MAX_EVENTS} events: ask for fewer days to see the rest.`);
    return lines.join('\n');
  }

  async function get({ eventId } = {}) {
    const id = checkItemId(eventId, BAD_EVENT_ID);
    const e = await client.ok(`${graph}/me/events/${enc(id)}?$select=subject,start,end,location,organizer,attendees,body,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting,showAs`,
      { item: true, headers: { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } });
    const attendees = Array.isArray(e.attendees) ? e.attendees.map((x) => {
      const r = x && x.status && x.status.response;
      return `${person(x)}${r && r !== 'none' ? ` (${r})` : ''}`;
    }) : [];
    const join = e.onlineMeeting && typeof e.onlineMeeting.joinUrl === 'string' ? e.onlineMeeting.joinUrl : '';
    const head = [
      `Subject: ${oneLine(e.subject) || '(no subject)'}`,
      `When: ${span(e)}`,
      where(e) ? `Where: ${where(e)}` : '',
      e.organizer ? `Organiser: ${person(e.organizer)}` : '',
      attendees.length ? `Attendees: ${attendees.join(', ')}` : '',
      join ? `Meeting link: ${join}` : '',
      e.isCancelled ? 'Cancelled: yes' : '',
    ].filter(Boolean).join('\n');
    return capText(`${head}\n\n${bodyText(e.body)}`.trim());
  }

  const handle = G.mcpHandler({
    name: 'VaultOS Outlook calendar', tools: CAL_TOOLS,
    run: async (tool, a) => {
      if (tool === 'calendar_help') return CAL_HELP;
      if (tool === 'calendar_list') return list({ from: a.from, days: a.days });
      return get({ eventId: a.eventId });
    },
  });
  const probe = () => G.probeWith(client, CAL_TOOLS, `${graph}/me/events?$top=1&$select=id`);
  return { handle, probe, list, get };
}

module.exports = { MAIL_TOOLS, CAL_TOOLS, MAIL_FOLDERS, checkItemId, createOutlookMail, createOutlookCalendar };
