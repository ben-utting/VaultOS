'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/connector-transcripts');

test('vttToText merges consecutive cues from one speaker', () => {
  const vtt = [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:03.000', '<v Alex Smith>Hello</v>', '',
    '00:00:04.000 --> 00:00:06.000', '<v Alex Smith>there</v>', '',
    '00:01:05.500 --> 00:01:07.000', '<v Sam Lee>Hi</v>', '',
  ].join('\n');
  assert.equal(T.vttToText(vtt), '[00:00] Alex Smith: Hello there\n[00:01] Sam Lee: Hi');
});

test('vttToText joins multi-line cues with one space', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alex Smith>Hello\nthere</v>\n';
  assert.equal(T.vttToText(vtt), '[00:00] Alex Smith: Hello there');
});

test('vttToText timestamps are hh:mm, long and short form', () => {
  assert.equal(T.vttToText('WEBVTT\n\n01:02:03.000 --> 01:02:05.000\n<v A>x</v>'), '[01:02] A: x');
  assert.equal(T.vttToText('WEBVTT\n\n02:03.000 --> 02:05.000\n<v A>x</v>'), '[00:02] A: x');
});

test('vttToText copes with BOM, CRLF, cue ids, NOTE blocks and no voice tags', () => {
  const vtt = '﻿WEBVTT\r\n\r\nNOTE secret note\r\nmore note\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nFirst line\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nSecond line\r\n';
  const out = T.vttToText(vtt);
  assert.equal(out, '[00:00] Unknown: First line Second line');
  assert.ok(!/WEBVTT|NOTE|secret/.test(out));
  assert.ok(!/^\d+$/m.test(out));
});

test('vttToText strips other tags and decodes entities', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A><c>R&amp;D</c> <b>&lt;ok&gt;</b></v>';
  assert.equal(T.vttToText(vtt), '[00:00] A: R&D <ok>');
});

test('vttToText returns empty string for empty input', () => {
  assert.equal(T.vttToText(''), '');
  assert.equal(T.vttToText('WEBVTT\n\n'), '');
});

test('checkId accepts safe ids and rejects the rest', () => {
  assert.equal(T.checkId('MSo1N2Y5ZGFj_LTQ3='), 'MSo1N2Y5ZGFj_LTQ3=');
  for (const bad of ['a/b', '../x', '', 5, 'a'.repeat(2001)]) {
    assert.throws(() => T.checkId(bad), T.TranscriptsError);
  }
});

// ---- MCP server over a fake Graph ----
const { MsAppError } = require('../lib/connector-msapp');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ME = { id: '11111111-2222-3333-4444-555555555555', userPrincipalName: 'alex@example.com' };
const reply = (status, body) => ({ status, body: { cancel: async () => {} }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// routes: function (url: URL, n: callIndex) -> reply | undefined
function make(routes = {}, over = {}) {
  const calls = [];
  let forgets = 0;
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: decodeURIComponent(u.pathname), search: u.search, init });
    const r = routes(u, calls.length - 1);
    return r || reply(404, { error: { code: 'NotFound' } });
  };
  const t = T.createTranscripts({ fetch, token: over.token || (async () => 'tok'), forget: () => { forgets++; }, now: () => NOW, graph: over.graph });
  return { t, calls, forgets: () => forgets };
}
const rpc = (t, name, args) => t.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const out = (r) => r.result.content[0].text;
const meRoute = (u) => (u.pathname === '/v1.0/me' ? reply(200, ME) : undefined);
const listPath = `/v1.0/users/${ME.id}/onlineMeetings/getAllTranscripts`;

test('initialize, tools/list, unknown method, notification', async () => {
  const { t } = make();
  const init = await t.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.serverInfo.name, 'VaultOS Teams transcripts');
  const list = await t.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((x) => x.name), ['transcripts_list', 'transcript_get', 'transcripts_help']);
  assert.equal((await t.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  assert.equal(await t.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});

test('transcripts_list: /me cached, window, nextLink, one lookup per meeting, newest first', async () => {
  const { t, calls } = make((u) => {
    if (u.pathname === '/v1.0/me') return reply(200, ME);
    if (u.pathname.startsWith(listPath)) {
      if (u.searchParams.get('$skiptoken')) return reply(200, { value: [{ id: 't2', meetingId: 'm2', createdDateTime: '2026-11-03T10:00:00Z' }] });
      return reply(200, { value: [{ id: 't1', meetingId: 'm1', createdDateTime: '2026-11-04T14:00:00Z' }, { id: 't3', meetingId: 'm1', createdDateTime: '2026-11-04T15:00:00Z' }], '@odata.nextLink': `${GRAPH}/users/${ME.id}/onlineMeetings/getAllTranscripts(x)?$skiptoken=abc` });
    }
    if (u.pathname === '/v1.0/me/onlineMeetings/m1') return reply(200, { subject: 'Weekly planning', startDateTime: '2026-11-04T14:00:00Z' });
    if (u.pathname === '/v1.0/me/onlineMeetings/m2') return reply(200, { subject: 'Review', startDateTime: '2026-11-03T10:00:00Z' });
  });
  const r1 = await rpc(t, 'transcripts_list', {});
  await rpc(t, 'transcripts_list', {});
  assert.equal(calls.filter((c) => c.path === '/v1.0/me').length, 1);
  const first = calls.find((c) => c.path.includes('getAllTranscripts'));
  assert.equal(first.path, `${listPath}(meetingOrganizerUserId='${ME.id}',startDateTime=2026-10-29T12:00:00.000Z,endDateTime=2026-11-05T12:00:00.000Z)`);
  const m1 = calls.filter((c) => c.path === '/v1.0/me/onlineMeetings/m1');
  assert.equal(m1.length, 2); // once per call, not per transcript
  assert.equal(m1[0].search, '?$select=subject,startDateTime,endDateTime');
  const lines = out(r1).split('\n');
  assert.equal(lines[0], '2026-11-04 15:00 UTC · Weekly planning · meetingId=m1 transcriptId=t3');
  assert.equal(lines[1], '2026-11-04 14:00 UTC · Weekly planning · meetingId=m1 transcriptId=t1');
  assert.ok(lines.some((l) => l === '2026-11-03 10:00 UTC · Review · meetingId=m2 transcriptId=t2'));
  assert.equal(lines.filter((l) => l.includes('·')).length, 3);
});

test('transcripts_list days is 1-30', async () => {
  const { t, calls } = make(meRoute);
  for (const days of [0, 31, 'x', 1.5]) {
    const r = await rpc(t, 'transcripts_list', { days });
    assert.equal(r.result.isError, true);
    assert.match(out(r), /1.{1,3}30/);
  }
  assert.equal(calls.length, 0);
});

test('transcripts_help names the tools and limits', async () => {
  const { t } = make();
  const s = out(await rpc(t, 'transcripts_help', {}));
  for (const w of ['transcripts_list', 'transcript_get', 'organised', 'transcription', 'expire']) assert.ok(s.includes(w), w);
});

test('empty result explains why', async () => {
  const { t } = make((u) => meRoute(u) || reply(200, { value: [] }));
  const r = await rpc(t, 'transcripts_list', {});
  assert.ok(!r.result.isError);
  for (const w of ['only meetings you organised', 'transcription', 'expire']) assert.ok(out(r).includes(w), w);
});

test('150 transcripts over 3 pages: 100 lines and a note; failed lookups are (no subject); evil nextLink is not fetched', async () => {
  const mk = (a, b) => Array.from({ length: b - a }, (_, i) => ({ id: `t${a + i}`, meetingId: `m${a + i}`, createdDateTime: new Date(NOW - (a + i) * 60000).toISOString() }));
  const { t, calls } = make((u) => {
    if (u.pathname === '/v1.0/me') return reply(200, ME);
    if (u.pathname.startsWith(listPath)) {
      const p = u.searchParams.get('p') || '1';
      if (p === '1') return reply(200, { value: mk(0, 50), '@odata.nextLink': `${GRAPH}/users/${ME.id}/onlineMeetings/getAllTranscripts(a)?p=2` });
      if (p === '2') return reply(200, { value: mk(50, 100), '@odata.nextLink': `${GRAPH}/users/${ME.id}/onlineMeetings/getAllTranscripts(a)?p=3` });
      return reply(200, { value: mk(100, 150) });
    }
    if (u.pathname.startsWith('/v1.0/me/onlineMeetings/m')) return /m[0-4]$/.test(u.pathname) ? reply(429, {}) : reply(404, {});
  });
  const s = out(await rpc(t, 'transcripts_list', {}));
  assert.equal(s.split('\n').filter((l) => l.includes('meetingId=')).length, 100);
  assert.match(s, /more/i);
  assert.ok(s.includes('(no subject)'));

  const evil = make((u) => {
    if (u.pathname === '/v1.0/me') return reply(200, ME);
    if (u.pathname.startsWith(listPath)) return reply(200, { value: mk(0, 2), '@odata.nextLink': 'https://evil.example/v1.0/steal' });
  });
  const e = await rpc(evil.t, 'transcripts_list', {});
  assert.ok(!evil.calls.some((c) => c.url.includes('evil.example')));
  assert.equal(out(e).split('\n').filter((l) => l.includes('meetingId=')).length, 2);
  assert.equal(calls.filter((c) => c.path.includes('getAllTranscripts')).length, 3);
});

test('a bad meetingId from Graph gets (no subject) and no lookup', async () => {
  const { t, calls } = make((u) => meRoute(u) || (u.pathname.startsWith(listPath) ? reply(200, { value: [{ id: 't1', meetingId: 'a/../b', createdDateTime: '2026-11-04T14:00:00Z' }] }) : undefined));
  const s = out(await rpc(t, 'transcripts_list', {}));
  assert.ok(s.includes('(no subject)'));
  assert.ok(!calls.some((c) => c.path.includes('..')));
});

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Sam>Hello there</v>\n';
const getRoutes = (content = VTT) => (u) => {
  if (u.pathname === '/v1.0/me/onlineMeetings/m1/transcripts/t1/content') return reply(200, content);
  if (u.pathname === '/v1.0/me/onlineMeetings/m1/transcripts/t1') return reply(200, { createdDateTime: '2026-11-04T14:05:00Z', endDateTime: '2026-11-04T14:35:00Z' });
  if (u.pathname === '/v1.0/me/onlineMeetings/m1') return reply(200, { subject: 'Weekly planning', startDateTime: '2026-10-01T09:00:00Z', endDateTime: '2026-10-01T09:30:00Z' });
};

test('transcript_get: header then text; raw; $format', async () => {
  const { t, calls } = make(getRoutes());
  const s = out(await rpc(t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1' }));
  assert.equal(s, 'Subject: Weekly planning\nStart: 2026-11-04 14:05 UTC\nEnd: 2026-11-04 14:35 UTC\n\n[00:00] Sam: Hello there');
  const c = calls.find((x) => x.path.endsWith('/content'));
  assert.equal(c.search, '?$format=text/vtt');
  const raw = out(await rpc(t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1', raw: true }));
  assert.ok(raw.endsWith(VTT));
});

test('transcript_get cuts at 400 KB', async () => {
  const big = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>${'x'.repeat(500 * 1024)}</v>\n`;
  const { t } = make(getRoutes(big));
  const s = out(await rpc(t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1' }));
  assert.ok(s.endsWith('[cut at 400 KB]'));
  assert.ok(s.length < 400 * 1024 + 100);
});

test('transcript_get with a bad id is a tool error and makes no request', async () => {
  const { t, calls } = make(getRoutes());
  const r = await rpc(t, 'transcript_get', { meetingId: '../x', transcriptId: 't1' });
  assert.equal(r.result.isError, true);
  assert.equal(calls.length, 0);
});

test('Graph errors in plain words', async () => {
  const run = (status, body) => rpc(make(() => reply(status, body)).t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1' });
  let r = await run(403, { error: { code: 'GraphAccessToTranscriptsDisabled' } });
  assert.equal(out(r), 'Your organisation has turned off transcript access through Graph.');
  r = await run(403, { error: { code: 'Forbidden' } });
  assert.equal(out(r), "The app registration doesn't carry the permission for this (or admin consent is missing).");
  r = await run(404, {});
  assert.equal(out(r), "Not found. It may have expired, or you didn't organise that meeting.");
  assert.equal(r.result.isError, true);
});

test('a 401 forgets the token and retries once', async () => {
  let n = 0;
  const { t, calls, forgets } = make((u) => {
    if (u.pathname.endsWith('/content')) return ++n === 1 ? reply(401, {}) : reply(200, VTT);
    return getRoutes()(u);
  });
  const r = await rpc(t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1' });
  assert.ok(!r.result.isError);
  assert.equal(forgets(), 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/content')).length, 2);
});

test('token failures become plain sentences', async () => {
  const run = (e) => rpc(make(meRoute, { token: async () => { throw e; } }).t, 'transcripts_list', {});
  const gone = 'The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
  assert.equal(out(await run(new MsAppError('refused', 'secret-refresh-token'))), gone);
  assert.equal(out(await run(new MsAppError('signed-out', 'x'))), gone);
  assert.equal(out(await run(new MsAppError('transient', 'x'))), "Couldn't reach Microsoft. Try again in a moment.");
  const r = await run(new Error('boom secret'));
  assert.equal(out(r), "Couldn't reach Microsoft. Try again in a moment.");
  assert.equal(r.result.isError, true);
});

test('probe returns the account, re-fetching /me; failure carries the error text', async () => {
  const { t, calls } = make(meRoute);
  await rpc(t, 'transcripts_list', {});
  const p = await t.probe();
  assert.deepEqual(p, { ok: true, tools: 3, error: null, account: 'alex@example.com' });
  assert.equal(calls.filter((c) => c.path === '/v1.0/me').length, 2);
  const bad = await make(meRoute, { token: async () => { throw new MsAppError('refused', 'x'); } }).t.probe();
  assert.equal(bad.ok, false);
  assert.equal(bad.tools, 0);
  assert.match(bad.error, /sign-in has run out/);
});

test('every request is a GET with redirect manual', async () => {
  const { t, calls } = make(getRoutes());
  await rpc(t, 'transcript_get', { meetingId: 'm1', transcriptId: 't1' });
  await t.probe();
  assert.ok(calls.length >= 2);
  for (const c of calls) { assert.equal(c.init.method, 'GET'); assert.equal(c.init.redirect, 'manual'); }
});

test('paging continues past the cap so newer transcripts on later pages are not missed', async () => {
  const old = Array.from({ length: 120 }, (_, i) => ({ id: `o${i}`, meetingId: 'm1', createdDateTime: new Date(NOW - (i + 10) * 3600000).toISOString() }));
  const { t } = make((u) => {
    if (u.pathname === '/v1.0/me') return reply(200, ME);
    if (u.pathname.startsWith(listPath)) {
      return u.searchParams.get('p') ? reply(200, { value: [{ id: 'newest', meetingId: 'm1', createdDateTime: new Date(NOW - 60000).toISOString() }] })
        : reply(200, { value: old, '@odata.nextLink': `${GRAPH}/users/${ME.id}/onlineMeetings/getAllTranscripts(a)?p=2` });
    }
    if (u.pathname === '/v1.0/me/onlineMeetings/m1') return reply(200, { subject: 'S' });
  });
  const s = out(await rpc(t, 'transcripts_list', { days: 30 }));
  assert.ok(s.split('\n')[0].endsWith('transcriptId=newest'));
});

test('a config error at refresh time: the tool says to sign in again, the probe records the reason', async () => {
  const reason = 'That app was not found in this directory. Check the Application (client) ID and the Directory (tenant) ID.';
  const mk = () => make(meRoute, { token: async () => { throw new MsAppError('config', reason); } }).t;
  const r = await rpc(mk(), 'transcripts_list', {});
  assert.equal(out(r), 'The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.');
  const p = await mk().probe();
  assert.deepEqual(p, { ok: false, tools: 0, error: reason });
});
