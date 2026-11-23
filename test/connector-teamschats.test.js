'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/connector-teamschats');
const { MsAppError } = require('../lib/connector-msapp');

// ---- message HTML to plain text ----
test('htmlToText: paragraphs, line breaks, lists and entities', () => {
  assert.equal(C.htmlToText('<p>Hello&nbsp;there</p><p>R&amp;D &lt;b&gt; &quot;x&quot; &#39;y&#39; &#x1F600; &#8364;</p>'), 'Hello there\nR&D <b> "x" \'y\' 😀 €');
  assert.equal(C.htmlToText('one<br>two<br/>three'), 'one\ntwo\nthree');
  assert.equal(C.htmlToText('<div>Steps<ul><li>first</li><li>second</li></ul></div>'), 'Steps\n- first\n- second');
});

test('htmlToText: mentions, emoji, images and attachments', () => {
  assert.equal(C.htmlToText('<p><at id="0">Sam Sample</at> can you look?</p>'), '@Sam Sample can you look?');
  assert.equal(C.htmlToText('Nice <emoji id="1f44d_thumbsup" alt="👍" title="Thumbs up"></emoji>'), 'Nice 👍');
  assert.equal(C.htmlToText('<p>see <img src="https://graph.microsoft.com/v1.0/chats/x/messages/1/hostedContents/a/$value" alt="image"></p>'), 'see [image]');
  assert.equal(C.htmlToText('<attachment id="abc"></attachment><p>the file</p>'), 'the file');
});

test('htmlToText: script and style bodies go, escaped markup stays text, empty input is empty', () => {
  assert.equal(C.htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>ok</p>'), 'ok');
  assert.equal(C.htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script>alert(1)</script>');
  assert.equal(C.htmlToText(''), '');
  assert.equal(C.htmlToText(null), '');
  assert.equal(C.htmlToText('&bogus; &#0; &#xZZ;'), '&bogus; &#0; &#xZZ;');
});

test('checkChatId accepts Teams chat ids and refuses anything that could leave the path', () => {
  for (const ok of ['19:abc-DEF_123@thread.v2', '19:11111111-2222-3333-4444-555555555555_66666666-7777-8888-9999-000000000000@unq.gbl.spaces', '19:meeting_Zm9v@thread.v2']) {
    assert.equal(C.checkChatId(ok), ok);
  }
  for (const bad of ['', 'a/b', '../x', '19:x?y', '19:x#y', '19:x y', 'a%2Fb', 5, null, 'a'.repeat(513)]) {
    assert.throws(() => C.checkChatId(bad), C.ChatsError, String(bad));
  }
});

// ---- MCP server over a fake Graph ----
const GRAPH = 'https://graph.microsoft.com/v1.0';
const ME = { id: 'aaaaaaaa-1111-2222-3333-444444444444', userPrincipalName: 'alex@example.com', displayName: 'Alex Example' };
const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const CHAT_A = '19:aaaa@thread.v2';
const CHAT_B = '19:aaaaaaaa-1111-2222-3333-444444444444_bbbbbbbb-1111-2222-3333-444444444444@unq.gbl.spaces';
const CHAT_C = '19:meeting_cccc@thread.v2';
const preview = (at, who, html) => ({ id: 'p', createdDateTime: at, isDeleted: false, messageType: 'message', body: { contentType: 'html', content: html }, from: { user: { displayName: who } } });
const CHATS = [
  { id: CHAT_B, topic: null, chatType: 'oneOnOne', lastUpdatedDateTime: '2026-11-20T09:00:00Z', lastMessagePreview: preview('2026-11-20T09:00:00Z', 'Sam Sample', '<p>Lunch at <b>one</b>?</p>') },
  { id: CHAT_A, topic: 'Release plan', chatType: 'group', lastUpdatedDateTime: '2026-11-21T15:30:00Z', lastMessagePreview: preview('2026-11-21T15:30:00Z', 'Alex Example', '<p>Shipping Thursday</p>') },
  { id: CHAT_C, topic: 'Weekly sync', chatType: 'meeting', lastUpdatedDateTime: '2026-11-19T08:00:00Z', lastMessagePreview: null },
];
const MEMBERS_B = { value: [
  { '@odata.type': '#microsoft.graph.aadUserConversationMember', userId: ME.id, displayName: 'Alex Example' },
  { '@odata.type': '#microsoft.graph.aadUserConversationMember', userId: 'bbbbbbbb-1111-2222-3333-444444444444', displayName: 'Sam Sample' },
] };
const msg = (id, at, who, html, extra = {}) => ({ id, messageType: 'message', createdDateTime: at, from: { user: { displayName: who } }, body: { contentType: 'html', content: html }, attachments: [], ...extra });

// routes: (url: URL, n) -> reply | undefined (undefined answers 404)
function make(routes = () => undefined, over = {}) {
  const calls = [];
  let forgets = 0;
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: decodeURIComponent(u.pathname), rawPath: u.pathname, search: decodeURIComponent(u.search), init });
    const r = routes(u, calls.length - 1);
    return r || reply(404, { error: { code: 'NotFound', message: 'Not found' } });
  };
  const s = C.createTeamsChats({ fetch, token: over.token || (async () => 'tok'), forget: () => { forgets++; }, graph: over.graph });
  return { s, calls, forgets: () => forgets };
}
const rpc = (s, name, args) => s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const out = (r) => r.result.content[0].text;
const p = (u) => decodeURIComponent(u.pathname);
// A Graph with the three chats, one-to-one members, and messages for CHAT_A.
function graphRoutes(extra = () => undefined) {
  return (u, n) => {
    const hit = extra(u, n);
    if (hit) return hit;
    if (p(u) === '/v1.0/me') return reply(200, ME);
    if (p(u) === '/v1.0/me/chats') return reply(200, { value: CHATS });
    if (p(u) === `/v1.0/me/chats/${CHAT_B}/members`) return reply(200, MEMBERS_B);
    if (p(u) === `/v1.0/me/chats/${CHAT_A}`) return reply(200, CHATS[1]);
    return undefined;
  };
}

test('initialize, tools/list, unknown method, notification', async () => {
  const { s } = make();
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'VaultOS Teams chats');
  const list = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name), ['chats_list', 'chat_get', 'chats_help']);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await s.handle([1])).error.code, -32600);
});

test('no tool can send, edit or delete: the names and schemas only read', () => {
  for (const t of C.TOOLS) {
    assert.doesNotMatch(t.name, /send|post|create|update|edit|delete|reply|react|write|set/i, t.name);
    for (const k of Object.keys(t.inputSchema.properties)) assert.ok(['limit', 'chatId'].includes(k), `${t.name}.${k}`);
  }
});

test('chats_help says what it can and cannot see, without calling Graph', async () => {
  const { s, calls } = make();
  const text = out(await rpc(s, 'chats_help', {}));
  for (const w of [/chats_list/, /chat_get/, /member/i, /channel/i, /attachments?/i, /cannot (send|change)/i, /400 KB/]) assert.match(text, w);
  assert.equal(calls.length, 0);
});

test('chats_list: the documented query, newest first, titles, previews and ids', async () => {
  const { s, calls } = make(graphRoutes());
  const r = await rpc(s, 'chats_list', {});
  assert.equal(r.result.isError, undefined);
  const list = calls.find((c) => c.path === '/v1.0/me/chats');
  const q = new URL(list.url).searchParams;
  assert.equal(q.get('$top'), '10');
  assert.equal(q.get('$expand'), 'lastMessagePreview');
  assert.equal(q.get('$orderby'), 'lastMessagePreview/createdDateTime desc');
  const text = out(r);
  const lines = text.split('\n');
  assert.equal(lines[0], `2026-11-21 15:30 UTC · Release plan · group · id=${CHAT_A}`);
  assert.equal(lines[1], '    Alex Example: Shipping Thursday');
  assert.equal(lines[2], `2026-11-20 09:00 UTC · Sam Sample · one-to-one · id=${CHAT_B}`);
  assert.equal(lines[3], '    Sam Sample: Lunch at one?');
  assert.equal(lines[4], `2026-11-19 08:00 UTC · Weekly sync · meeting · id=${CHAT_C}`);
  assert.equal(lines.length, 5); // no preview line for a chat without one
  // members are looked up only for the chat with no topic
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/members')).map((c) => c.path), [`/v1.0/me/chats/${CHAT_B}/members`]);
  // the chat id is encoded in the path
  assert.ok(calls.find((c) => c.path.endsWith('/members')).rawPath.includes('19%3A'));
});

test('chats_list limit is 1-50, checked before any call', async () => {
  const { s, calls } = make(graphRoutes());
  for (const limit of [0, 51, 'x', 1.5, -1]) {
    const r = await rpc(s, 'chats_list', { limit });
    assert.equal(r.result.isError, true);
    assert.match(out(r), /1.{1,3}50/);
  }
  assert.equal(calls.length, 0);
  await rpc(s, 'chats_list', { limit: 2 });
  assert.equal(new URL(calls.find((c) => c.path === '/v1.0/me/chats').url).searchParams.get('$top'), '2');
});

test('chats_list follows @odata.nextLink on Graph only, stops at the limit and says when there are more', async () => {
  const page2 = `${GRAPH}/me/chats?$skiptoken=two`;
  const { s, calls } = make(graphRoutes((u) => {
    if (p(u) === '/v1.0/me/chats' && u.searchParams.get('$skiptoken') === 'two') return reply(200, { value: [CHATS[2]], '@odata.nextLink': `${GRAPH}/me/chats?$skiptoken=three` });
    if (p(u) === '/v1.0/me/chats') return reply(200, { value: [CHATS[1]], '@odata.nextLink': page2 });
  }));
  const text = out(await rpc(s, 'chats_list', { limit: 2 }));
  assert.equal(calls.filter((c) => c.path === '/v1.0/me/chats').length, 2); // not the third page: the limit is reached
  assert.match(text, /Release plan/);
  assert.match(text, /Weekly sync/);
  assert.match(text, /More chats exist.*limit/);

  const evil = make(graphRoutes((u) => (p(u) === '/v1.0/me/chats' ? reply(200, { value: [CHATS[1]], '@odata.nextLink': 'https://evil.example/v1.0/me/chats?$skiptoken=x' }) : undefined)));
  await rpc(evil.s, 'chats_list', {});
  assert.ok(evil.calls.every((c) => c.url.startsWith(GRAPH)));
});

test('chats_list with no chats says so', async () => {
  const { s } = make(graphRoutes((u) => (p(u) === '/v1.0/me/chats' ? reply(200, { value: [] }) : undefined)));
  assert.match(out(await rpc(s, 'chats_list', {})), /No chats found/);
});

test('chats_list: a member lookup that fails leaves a plain title', async () => {
  const { s } = make(graphRoutes((u) => (p(u).endsWith('/members') ? reply(500, {}) : undefined)));
  assert.match(out(await rpc(s, 'chats_list', {})), new RegExp(`· \\(no title\\) · one-to-one · id=${CHAT_B.replace(/[.]/g, '\\.')}`));
});

test('chats_list: a 403 means the app lacks consent for Chat.Read', async () => {
  const { s } = make(graphRoutes((u) => (p(u) === '/v1.0/me/chats' ? reply(403, { error: { code: 'Forbidden', message: "Missing scope permissions on the request. API requires one of 'Chat.ReadBasic, Chat.Read, Chat.ReadWrite'." } }) : undefined)));
  const r = await rpc(s, 'chats_list', {});
  assert.equal(r.result.isError, true);
  assert.match(out(r), /Chat\.Read/);
  assert.match(out(r), /admin/);
});

test('chat_get: the documented query, newest first, plain text, skipped system events, attachments marked', async () => {
  const msgs = [
    msg('1', '2026-11-21T15:00:00Z', 'Sam Sample', '<p>Is the build green?</p>'),
    msg('3', '2026-11-21T15:30:00Z', 'Alex Example', '<p>Shipping <b>Thursday</b><br>after the review</p>', { attachments: [{ id: 'f', contentType: 'reference', name: 'plan.docx' }], lastEditedDateTime: '2026-11-21T15:31:00Z' }),
    { id: '2', messageType: 'systemEventMessage', createdDateTime: '2026-11-21T15:10:00Z', from: null, body: { contentType: 'html', content: '<systemEventMessage/>' } },
    msg('4', '2026-11-21T15:20:00Z', 'Sam Sample', '', { deletedDateTime: '2026-11-21T15:21:00Z' }),
    { id: '5', messageType: 'message', createdDateTime: '2026-11-21T15:25:00Z', from: { application: { displayName: 'Build bot' } }, body: { contentType: 'text', content: 'build 42 passed' }, attachments: [] },
  ];
  const { s, calls } = make(graphRoutes((u) => (p(u) === `/v1.0/me/chats/${CHAT_A}/messages` ? reply(200, { value: msgs }) : undefined)));
  const r = await rpc(s, 'chat_get', { chatId: CHAT_A });
  assert.equal(r.result.isError, undefined);
  const call = calls.find((c) => c.path.endsWith('/messages'));
  assert.ok(call.rawPath.includes('19%3Aaaaa%40thread.v2'));
  const q = new URL(call.url).searchParams;
  assert.equal(q.get('$top'), '30');
  assert.equal(q.get('$orderby'), 'createdDateTime desc');
  const text = out(r);
  assert.match(text, /^Chat: Release plan \(group\)\n/);
  const body = text.split('\n\n').slice(1).join('\n\n');
  assert.equal(body, [
    '[2026-11-21 15:30 UTC] Alex Example: Shipping Thursday',
    '    after the review [1 attachment not shown] (edited)',
    '[2026-11-21 15:25 UTC] Build bot: build 42 passed',
    '[2026-11-21 15:20 UTC] Sam Sample: (message deleted)',
    '[2026-11-21 15:00 UTC] Sam Sample: Is the build green?',
  ].join('\n'));
  assert.doesNotMatch(text, /systemEvent/);
});

test('chat_get follows nextLink until the limit, and limit is 1-200', async () => {
  let page = 0;
  const { s, calls } = make(graphRoutes((u) => {
    if (p(u) !== `/v1.0/me/chats/${CHAT_A}/messages`) return undefined;
    page++;
    const base = Date.parse('2026-11-21T12:00:00Z') - page * 3600000;
    const value = Array.from({ length: 50 }, (_, i) => msg(`${page}-${i}`, new Date(base - i * 1000).toISOString(), 'Sam Sample', `<p>m${page}-${i}</p>`));
    return reply(200, { value, '@odata.nextLink': `${GRAPH}/me/chats/${encodeURIComponent(CHAT_A)}/messages?$skiptoken=p${page}` });
  }));
  const text = out(await rpc(s, 'chat_get', { chatId: CHAT_A, limit: 120 }));
  assert.equal(calls.filter((c) => c.path.endsWith('/messages')).length, 3);
  assert.equal(new URL(calls.find((c) => c.path.endsWith('/messages')).url).searchParams.get('$top'), '50');
  assert.equal(text.split('\n').filter((l) => l.startsWith('[')).length, 120);
  assert.match(text, /Older messages exist/);
  for (const limit of [0, 201, 'x', 2.5]) {
    const r = await rpc(s, 'chat_get', { chatId: CHAT_A, limit });
    assert.equal(r.result.isError, true);
    assert.match(out(r), /1.{1,3}200/);
  }
});

test('chat_get refuses a missing or unsafe chat id without calling Graph', async () => {
  const { s, calls } = make(graphRoutes());
  for (const chatId of [undefined, '', '../me', '19:x/../../users', 'a b']) {
    const r = await rpc(s, 'chat_get', { chatId });
    assert.equal(r.result.isError, true);
    assert.match(out(r), /chats_list/);
  }
  assert.equal(calls.length, 0);
});

test('chat_get on a chat you are not in fails cleanly (403, 404 or 400)', async () => {
  for (const [status, error] of [
    [403, { code: 'Forbidden', message: 'Forbidden' }],
    [404, { code: 'NotFound', message: 'Chat not found' }],
    [400, { code: 'BadRequest', message: 'Invalid ThreadId.' }],
  ]) {
    const { s } = make((u) => (p(u).endsWith('/messages') ? reply(status, { error }) : undefined));
    const r = await rpc(s, 'chat_get', { chatId: '19:someoneelse@thread.v2' });
    assert.equal(r.result.isError, true, String(status));
    assert.match(out(r), /aren't in it/, String(status));
    assert.doesNotMatch(out(r), /Forbidden|ThreadId/, String(status));
  }
  // a missing scope is a consent problem, not "not in it"
  const { s } = make((u) => (p(u).endsWith('/messages') ? reply(403, { error: { code: 'Forbidden', message: "Missing scope permissions on the request. API requires one of 'Chat.Read'." } }) : undefined));
  assert.match(out(await rpc(s, 'chat_get', { chatId: CHAT_A })), /consent for Chat\.Read/);
});

test('chat_get output is cut at 400 KB', async () => {
  const big = 'x'.repeat(10000);
  const { s } = make(graphRoutes((u) => (p(u).endsWith('/messages')
    ? reply(200, { value: Array.from({ length: 50 }, (_, i) => msg(String(i), new Date(Date.parse('2026-11-21T12:00:00Z') - i * 1000).toISOString(), 'Sam Sample', `<p>${big}</p>`)) })
    : undefined)));
  const text = out(await rpc(s, 'chat_get', { chatId: CHAT_A, limit: 50 }));
  assert.ok(text.length <= 400 * 1024 + 40, String(text.length));
  assert.match(text, /\[cut at 400 KB\]$/);
});

test('every Graph request is a GET with the bearer token, no redirects followed', async () => {
  const { s, calls } = make(graphRoutes((u) => (p(u).endsWith('/messages') ? reply(200, { value: [msg('1', '2026-11-21T15:00:00Z', 'Sam Sample', 'hi')] }) : undefined)));
  await rpc(s, 'chats_list', {});
  await rpc(s, 'chat_get', { chatId: CHAT_A });
  await s.probe();
  assert.ok(calls.length >= 5);
  for (const c of calls) {
    assert.equal(c.init.method, 'GET', c.url);
    assert.equal(c.init.redirect, 'manual');
    assert.equal(c.init.headers.authorization, 'Bearer tok');
    assert.equal(c.init.body, undefined);
  }
});

const GONE = 'The Teams chats sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';

test('a refused or missing sign-in gives the sign-in sentence; a 401 forgets the token and retries once', async () => {
  const refused = make(graphRoutes(), { token: async () => { throw new MsAppError('refused', 'AADSTS700082: expired'); } });
  assert.equal(out(await rpc(refused.s, 'chats_list', {})), GONE);
  const out1 = make(graphRoutes(), { token: async () => { throw new MsAppError('signed-out', 'Not signed in.'); } });
  assert.equal(out(await rpc(out1.s, 'chat_get', { chatId: CHAT_A })), GONE);

  let n = 0;
  const retry = make(graphRoutes((u) => (p(u) === '/v1.0/me/chats' && n++ === 0 ? reply(401, {}) : undefined)));
  assert.match(out(await rpc(retry.s, 'chats_list', {})), /Release plan/);
  assert.equal(retry.forgets(), 1);

  const always = make(() => reply(401, {}));
  assert.equal(out(await rpc(always.s, 'chats_list', {})), GONE);
  assert.equal(always.calls.length, 2);
});

test('a network error or a Graph outage is a plain try-again', async () => {
  const net = C.createTeamsChats({ fetch: async () => { throw new Error('ECONNRESET secret-ish detail'); }, token: async () => 'tok' });
  const r = await rpc(net, 'chats_list', {});
  assert.equal(r.result.isError, true);
  assert.equal(out(r), "Couldn't reach Microsoft. Try again in a moment.");
  const busy = make(() => reply(503, {}));
  assert.equal(out(await rpc(busy.s, 'chats_list', {})), "Couldn't reach Microsoft. Try again in a moment.");
  const transient = make(graphRoutes(), { token: async () => { throw new MsAppError('transient', 'x'); } });
  assert.equal(out(await rpc(transient.s, 'chats_list', {})), "Couldn't reach Microsoft. Try again in a moment.");
});

test('probe reads /me and one chat, so a missing consent shows on Test', async () => {
  const good = make(graphRoutes());
  assert.deepEqual(await good.s.probe(), { ok: true, tools: 3, error: null, account: 'alex@example.com' });
  assert.equal(new URL(good.calls.find((c) => c.path === '/v1.0/me/chats').url).searchParams.get('$top'), '1');

  const noConsent = make(graphRoutes((u) => (p(u) === '/v1.0/me/chats' ? reply(403, { error: { code: 'Forbidden', message: 'Missing scope permissions on the request.' } }) : undefined)));
  const r = await noConsent.s.probe();
  assert.equal(r.ok, false);
  assert.match(r.error, /Chat\.Read/);

  const refused = make(graphRoutes(), { token: async () => { throw new MsAppError('refused', 'Ask an admin to grant consent for Chat.Read on your app registration, then sign in again.'); } });
  assert.match((await refused.s.probe()).error, /grant consent for Chat\.Read/); // Test shows Microsoft's reason
});
