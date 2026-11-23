'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/connector-outlook');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ME = { id: 'aaaaaaaa-1111-2222-3333-444444444444', userPrincipalName: 'alex@example.com' };
const NOW = Date.parse('2026-11-23T15:00:00Z');
const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const p = (u) => decodeURIComponent(u.pathname);

function make(factory, routes = () => undefined) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), u, path: p(u), rawPath: u.pathname, init });
    if (p(u) === '/v1.0/me') return reply(200, ME);
    return routes(u, init) || reply(404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
  };
  const s = factory({ fetch, token: async () => 'tok', now: () => NOW });
  return { s, calls };
}
const rpc = (s, name, args) => s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const out = (r) => r.result.content[0].text;
const addr = (name, address) => ({ emailAddress: { name, address } });

// ---------------------------------------------------------------- mail
const MSG_ID = 'AAMkAGI2T/abc+def==';
const MSGS = [
  { id: 'AAMk1', subject: 'Budget review', from: addr('Sam Sample', 'sam@example.com'), receivedDateTime: '2026-11-22T09:00:00Z', isRead: true, hasAttachments: false, bodyPreview: 'Numbers attached below' },
  { id: MSG_ID, subject: 'Release  plan', from: addr('Alex Example', 'alex@example.com'), receivedDateTime: '2026-11-23T10:30:00Z', isRead: false, hasAttachments: true, bodyPreview: 'Shipping Thursday.\r\nNotes follow.' },
];

test('mail: the tools only read', async () => {
  const { s } = make(O.createOutlookMail);
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['mail_list', 'mail_search', 'mail_get', 'mail_help']);
  for (const t of O.MAIL_TOOLS) assert.doesNotMatch(t.name, /send|reply|forward|move|delete|flag|mark|draft|create|update/i);
  const init = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'VaultOS Outlook mail');
  const help = out(await rpc(s, 'mail_help', {}));
  assert.match(help, /Cannot send/);
  assert.match(help, /attachments/i);
});

test('mail_list: inbox, newest first, the documented query, flags, preview and ids', async () => {
  const { s, calls } = make(O.createOutlookMail, (u) => (p(u) === '/v1.0/me/mailFolders/inbox/messages' ? reply(200, { value: MSGS }) : undefined));
  const text = out(await rpc(s, 'mail_list', {}));
  const q = calls[0].u.searchParams;
  assert.equal(calls[0].path, '/v1.0/me/mailFolders/inbox/messages');
  assert.equal(q.get('$top'), '10');
  assert.equal(q.get('$orderby'), 'receivedDateTime desc');
  assert.equal(q.get('$select'), 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview');
  assert.equal(q.get('$filter'), null);
  assert.equal(text, [
    `2026-11-23 10:30 UTC · Alex Example <alex@example.com> · Release plan · unread, attachments · id=${MSG_ID}`,
    '    Shipping Thursday. Notes follow.',
    '2026-11-22 09:00 UTC · Sam Sample <sam@example.com> · Budget review · id=AAMk1',
    '    Numbers attached below',
  ].join('\n'));
});

test('mail_list: unread only, another folder, and the checks before any call', async () => {
  const { s, calls } = make(O.createOutlookMail, (u) => (p(u).startsWith('/v1.0/me/mailFolders/') ? reply(200, { value: [] }) : undefined));
  assert.equal(out(await rpc(s, 'mail_list', { folder: 'sentitems', unreadOnly: true, limit: 5 })), 'No unread messages in sentitems.');
  const q = calls[0].u.searchParams;
  assert.equal(calls[0].path, '/v1.0/me/mailFolders/sentitems/messages');
  assert.equal(q.get('$filter'), 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false');
  assert.equal(q.get('$top'), '5');
  calls.length = 0;
  for (const args of [{ folder: 'other' }, { folder: '../users' }, { limit: 0 }, { limit: 51 }, { unreadOnly: 'yes' }]) {
    const r = await rpc(s, 'mail_list', args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test('mail_list: a folder the mailbox lacks says so', async () => {
  const { s } = make(O.createOutlookMail);
  assert.equal(out(await rpc(s, 'mail_list', { folder: 'archive' })), 'Your mailbox has no archive folder.');
});

test('mail_search: one quoted search, quotes in the words dropped', async () => {
  const { s, calls } = make(O.createOutlookMail, (u) => (p(u) === '/v1.0/me/messages' ? reply(200, { value: [MSGS[0]] }) : undefined));
  const text = out(await rpc(s, 'mail_search', { query: 'budget "q4" review' }));
  assert.equal(calls[0].u.searchParams.get('$search'), '"budget q4 review"');
  assert.match(text, /Budget review · id=AAMk1/);
  for (const query of [undefined, '', '   ', 'x'.repeat(201)]) assert.equal((await rpc(s, 'mail_search', { query })).result.isError, true);
});

test('mail_get: plain-text body, headers, encoded id, attachments noted', async () => {
  const { s, calls } = make(O.createOutlookMail, (u) => (p(u) === `/v1.0/me/messages/${MSG_ID}` ? reply(200, {
    subject: 'Release plan', from: addr('Alex Example', 'alex@example.com'), toRecipients: [addr('Sam Sample', 'sam@example.com')],
    ccRecipients: [addr('', 'team@example.com')], receivedDateTime: '2026-11-23T10:30:00Z', hasAttachments: true,
    body: { contentType: 'text', content: 'Shipping Thursday.\nNotes follow.' },
  }) : undefined));
  const text = out(await rpc(s, 'mail_get', { messageId: MSG_ID }));
  assert.ok(calls[0].rawPath.endsWith('AAMkAGI2T%2Fabc%2Bdef%3D%3D'));
  assert.equal(calls[0].init.headers.Prefer, 'outlook.body-content-type="text"');
  assert.equal(text, 'Subject: Release plan\nFrom: Alex Example <alex@example.com>\nTo: Sam Sample <sam@example.com>\nCc: team@example.com\nDate: 2026-11-23 10:30 UTC\nAttachments: yes, not shown\n\nShipping Thursday.\nNotes follow.');
});

test('mail_get: html body becomes text; a bad id, a missing message and a missing scope each fail cleanly', async () => {
  const { s } = make(O.createOutlookMail, (u) => {
    if (p(u) === '/v1.0/me/messages/AAMkHTML') return reply(200, { subject: 's', from: addr('A', 'a@example.com'), receivedDateTime: '2026-11-23T10:30:00Z', body: { contentType: 'html', content: '<p>Hi&nbsp;there</p><p>Bye</p>' } });
    if (p(u) === '/v1.0/me/messages/AAMkNOSCOPE') return reply(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again. Missing scope Mail.Read' } });
    return undefined;
  });
  assert.match(out(await rpc(s, 'mail_get', { messageId: 'AAMkHTML' })), /\n\nHi there\nBye$/);
  for (const messageId of [undefined, '', '../me', 'a b', 'x'.repeat(1025)]) assert.match(out(await rpc(s, 'mail_get', { messageId })), /isn't a message id/);
  assert.match(out(await rpc(s, 'mail_get', { messageId: 'AAMkGONE' })), /wasn't found in your mailbox/);
  assert.match(out(await rpc(s, 'mail_get', { messageId: 'AAMkNOSCOPE' })), /consent for Mail\.Read/);
});

test('mail probe reads /me and the inbox', async () => {
  const { s, calls } = make(O.createOutlookMail, (u) => (p(u) === '/v1.0/me/mailFolders/inbox/messages' ? reply(200, { value: [] }) : undefined));
  assert.deepEqual(await s.probe(), { ok: true, tools: 4, error: null, account: 'alex@example.com' });
  assert.equal(calls[1].u.searchParams.get('$top'), '1');
});

// ---------------------------------------------------------------- calendar
const EVENTS = [
  { id: 'AAMkE2', subject: 'Planning', start: { dateTime: '2026-11-24T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-24T15:00:00.0000000', timeZone: 'UTC' }, location: { displayName: 'Room 2' }, organizer: addr('Sam Sample', 'sam@example.com'), isAllDay: false, isCancelled: true },
  { id: 'AAMkE1', subject: 'Standup', start: { dateTime: '2026-11-24T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-24T09:15:00.0000000', timeZone: 'UTC' }, location: { displayName: '' }, organizer: addr('Alex Example', 'alex@example.com'), isAllDay: false, isCancelled: false },
  { id: 'AAMkE3', subject: 'Offsite', start: { dateTime: '2026-11-25T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' }, isAllDay: true },
];

test('calendar: the tools only read', async () => {
  const { s } = make(O.createOutlookCalendar);
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['calendar_list', 'calendar_get', 'calendar_help']);
  for (const t of O.CAL_TOOLS) assert.doesNotMatch(t.name, /create|accept|decline|cancel|delete|update|move|respond/i);
  assert.match(out(await rpc(s, 'calendar_help', {})), /Cannot create, accept, decline/);
});

test('calendar_list: today for 7 days by default, in UTC, earliest first', async () => {
  const { s, calls } = make(O.createOutlookCalendar, (u) => (p(u) === '/v1.0/me/calendarView' ? reply(200, { value: EVENTS }) : undefined));
  const text = out(await rpc(s, 'calendar_list', {}));
  const q = calls[0].u.searchParams;
  assert.equal(q.get('startDateTime'), '2026-11-23T00:00:00.000Z');
  assert.equal(q.get('endDateTime'), '2026-11-30T00:00:00.000Z');
  assert.equal(q.get('$orderby'), 'start/dateTime');
  assert.equal(calls[0].init.headers.Prefer, 'outlook.timezone="UTC"');
  assert.equal(text, [
    'Events from 2026-11-23 to 2026-11-29, earliest first (UTC):',
    '2026-11-24 09:00–09:15 UTC · Standup · organiser Alex Example <alex@example.com> · id=AAMkE1',
    '2026-11-24 14:00–15:00 UTC · Planning · Room 2 · organiser Sam Sample <sam@example.com> · cancelled · id=AAMkE2',
    '2026-11-25 to 2026-11-26 (all day) · Offsite · id=AAMkE3',
  ].join('\n'));
});

test('calendar_list: from and days are checked before any call', async () => {
  const { s, calls } = make(O.createOutlookCalendar, (u) => (p(u) === '/v1.0/me/calendarView' ? reply(200, { value: [] }) : undefined));
  assert.equal(out(await rpc(s, 'calendar_list', { from: '2026-12-01', days: 2 })), 'No events from 2026-12-01 to 2026-12-02.');
  assert.equal(calls[0].u.searchParams.get('endDateTime'), '2026-12-03T00:00:00.000Z');
  calls.length = 0;
  for (const args of [{ from: 'tomorrow' }, { from: '2026-13-45' }, { days: 0 }, { days: 32 }, { days: 1.5 }]) assert.equal((await rpc(s, 'calendar_list', args)).result.isError, true, JSON.stringify(args));
  assert.equal(calls.length, 0);
});

test('calendar_get: when, where, people, the meeting link and the text', async () => {
  const { s, calls } = make(O.createOutlookCalendar, (u) => (p(u) === '/v1.0/me/events/AAMkE1' ? reply(200, {
    ...EVENTS[1], attendees: [{ ...addr('Sam Sample', 'sam@example.com'), status: { response: 'accepted' } }, { ...addr('Kim Sample', 'kim@example.com'), status: { response: 'none' } }],
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, body: { contentType: 'text', content: 'Daily check-in.' },
  }) : undefined));
  const text = out(await rpc(s, 'calendar_get', { eventId: 'AAMkE1' }));
  assert.equal(calls[0].init.headers.Prefer, 'outlook.timezone="UTC", outlook.body-content-type="text"');
  assert.equal(text, 'Subject: Standup\nWhen: 2026-11-24 09:00–09:15 UTC\nOrganiser: Alex Example <alex@example.com>\nAttendees: Sam Sample <sam@example.com> (accepted), Kim Sample <kim@example.com>\nMeeting link: https://teams.microsoft.com/l/meetup-join/x\n\nDaily check-in.');
  assert.match(out(await rpc(s, 'calendar_get', { eventId: 'AAMkGONE' })), /wasn't found in your calendar/);
  assert.match(out(await rpc(s, 'calendar_get', { eventId: '../x' })), /isn't an event id/);
});

test('every Outlook request is a GET with the bearer token, no redirects followed', async () => {
  const mail = make(O.createOutlookMail, () => reply(200, { value: [], subject: 's', body: { contentType: 'text', content: '' } }));
  await rpc(mail.s, 'mail_list', {}); await rpc(mail.s, 'mail_search', { query: 'x' }); await rpc(mail.s, 'mail_get', { messageId: 'AAMk1' }); await mail.s.probe();
  const cal = make(O.createOutlookCalendar, () => reply(200, { value: [], subject: 's', body: { contentType: 'text', content: '' } }));
  await rpc(cal.s, 'calendar_list', {}); await rpc(cal.s, 'calendar_get', { eventId: 'AAMkE1' }); await cal.s.probe();
  for (const c of [...mail.calls, ...cal.calls]) {
    assert.equal(c.init.method, 'GET', c.url);
    assert.equal(c.init.redirect, 'manual');
    assert.equal(c.init.headers.authorization, 'Bearer tok');
    assert.ok(c.url.startsWith(GRAPH), c.url);
  }
});
