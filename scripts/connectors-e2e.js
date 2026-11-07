'use strict';
// End-to-end scenarios for Connectors, run against the connectors preview container (127.0.0.1:7695) with
// the fake Atlassian/GitHub (scripts/fake-mcp-oauth.js) inside it. Never the live board (:7684).
//
//   node scripts/connectors-e2e.js C1 C2 C3 C4 C5 C6 C7 C8 C9
//
// C7 is GitHub against the fake. C8 is Microsoft Learn against the REAL https://learn.microsoft.com/api/mcp, so
// it needs outbound internet and the preview must run without CONNECTOR_UPSTREAM_MSLEARN.
// C9 is Teams transcripts against scripts/fake-msapp.js (a fake Microsoft login + Graph on :5557, control on :5558, started
// inside the container); the preview needs CONNECTOR_UPSTREAM_TRANSCRIPTS_LOGIN and _GRAPH set to http://127.0.0.1:5557.
// Scenarios build on each other (C1 signs in, C6 signs out; C7 and C8 stand alone after C1), so run them in order. C1 installs Claude Code and
// the Cursor CLI into the preview's home when they are missing (about 1.5 minutes, a few hundred MB: check
// `df -h /` first). Neither agent is signed in to its own model provider, which `mcp list` does not need.
// The session cookie is minted from the preview's data dir and never printed or written. Exit code: 1 when a
// check failed, 2 on bad usage.

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const PREVIEW = '/opt/vault/connectors-preview';
const CONTAINER = 'connectors-preview';
const BASE = 'http://127.0.0.1:7695';
const FAKE = 'http://127.0.0.1:5555';
const CTRL = 'http://127.0.0.1:5556';
const MSCTRL = 'http://127.0.0.1:5558';
const T_TENANT = '11111111-2222-3333-4444-555555555555';
const T_CLIENT = '66666666-7777-8888-9999-000000000000';
const T_GONE = 'The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again.';
const HOME = '/home/vaultos';
const EXPIRED = 'Atlassian sign-in has run out. Open Settings → Connectors in VaultOS to sign in again.';
const INSTALL = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  agent: 'curl https://cursor.com/install -fsS | bash',
};

const args = process.argv.slice(2);
if (args.some((a) => /^https?:\/\//.test(a) || /7684/.test(a))) { console.error(`this harness only runs against the preview, ${BASE}`); process.exit(2); }
const NAMES = args.filter((a) => /^C[1-9]$/.test(a));
if (!NAMES.length || NAMES.length !== args.length) { console.error('usage: node scripts/connectors-e2e.js C1 [C2 … C9]'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- the container -----
function sh(cmd, { cwd, timeout = 180000 } = {}) {
  const r = spawnSync('docker', ['exec', '-u', '1000', '-e', `HOME=${HOME}`, ...(cwd ? ['-w', cwd] : []), CONTAINER, 'bash', '-lc', cmd],
    { encoding: 'utf8', timeout });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
// Runs a node snippet in the container; the snippet reads its input from process.env.IN (JSON) and prints JSON.
function inNode(src, input) {
  const r = spawnSync('docker', ['exec', '-u', '1000', '-e', `IN=${JSON.stringify(input === undefined ? null : input)}`, CONTAINER, 'node', '-e', src],
    { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); } catch { return { error: (r.stdout + r.stderr).slice(0, 300) }; }
}

// ----- the app, as a signed-in session -----
const jar = {};
function seedCookie() {
  const { sessionSecret } = require(path.join(PREVIEW, 'data/config.json'));
  const value = Buffer.from('{"authed":true}').toString('base64');
  const sig = crypto.createHmac('sha1', sessionSecret).update('board_sess=' + value).digest('base64')
    .replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
  jar.board_sess = value; jar['board_sess.sig'] = sig;
}
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}
const view = async () => (await api('GET', '/api/connectors')).body;
const atlassian = (v) => v.connectors.find((c) => c.id === 'atlassian');

// ----- the fake Atlassian inside the container, with a small control port (mode, token wipe, counters) -----
const CONTROL_SRC = `
const http = require('http');
const { startFake } = require('/app/scripts/fake-mcp-oauth.js');
startFake({ port: 5555, host: '127.0.0.1' }).then((f) => {
  // 'expire' kills the current access token until a refresh hands out a fresh one (like a real expiry).
  let n = f.state.refreshes;
  Object.defineProperty(f.state, 'refreshes', { get: () => n, set: (v) => { n = v; if (f.state.mode === 'expire') f.setMode('normal'); } });
  http.createServer((q, r) => {
    const m = q.url.match(/^\\/mode\\/([a-z-]+)$/);
    if (m) f.setMode(m[1]);
    if (q.url === '/forget-access') f.state.access.clear();
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ mode: f.state.mode, refreshes: f.state.refreshes, revoked: f.state.revoked.length }));
  }).listen(5556, '127.0.0.1');
});`;
function restartFake() {
  sh("for p in $(ps -eo pid,args | grep '[f]ake-mcp-oauth\\|[n]ode -e .*startFake' | awk '{print $1}'); do kill $p; done; sleep 1");
  spawnSync('docker', ['exec', '-d', '-u', '1000', CONTAINER, 'node', '-e', CONTROL_SRC]);
}
const ctrl = async (p) => {
  const r = sh(`curl -s ${CTRL}${p}`);
  try { return JSON.parse(r.out); } catch { return { error: r.out }; }
};

// ----- an MCP client inside the container, talking to the relay with the key from the store -----
const relayKey = () => JSON.parse(sh(`cat ${HOME}/.vaultos/connectors.json`).out).relayKey;
const MCP_SRC = `
const { key, id, method, params } = JSON.parse(process.env.IN);
fetch('http://127.0.0.1:8080/mcp/' + id, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-vaultos-key': key },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then(async (r) => {
  const t = await r.text();
  const d = t.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  let msg = null; try { msg = JSON.parse(d.length ? d[d.length - 1] : t); } catch {}
  console.log(JSON.stringify({ status: r.status, msg }));
}).catch((e) => console.log(JSON.stringify({ error: String(e.message) })));`;
const mcp = (method, params, id = 'atlassian', key = relayKey()) => inNode(MCP_SRC, { key, id, method, params: params || {} });
const toolText = (res) => { try { return JSON.parse(res.msg.result.content[0].text); } catch { return null; } };

// ----- the scenarios -----
const SCENARIOS = {
  async C1() {
    const have = sh('command -v claude; command -v agent').out;
    for (const bin of ['claude', 'agent']) {
      if (!new RegExp(`/${bin}$`, 'm').test(have)) {
        const r = sh(INSTALL[bin], { timeout: 300000 });
        check(`installed ${bin}`, sh(`command -v ${bin}`).code === 0, r.out.slice(-200));
      }
    }
    check('both agents are installed', sh('command -v claude && command -v agent').code === 0);
    restartFake();
    await sleep(1500);
    check('fake Atlassian answers inside the container', (await ctrl('/state')).mode === 'normal');
    await api('POST', '/api/connectors/atlassian/disconnect');
    const start = await api('POST', '/api/connectors/atlassian/start');
    check('start returns an authorize URL on the fake', start.status === 200 && typeof start.body.url === 'string' && start.body.url.startsWith(FAKE), start.body);
    const redirect = sh(`curl -s -o /dev/null -w '%{redirect_url}' '${start.body.url}'`).out.trim();
    check('the fake redirects back to the callback with a code', redirect.startsWith(`${BASE}/api/connectors/atlassian/callback?`) && /[?&]code=/.test(redirect), redirect);
    const cb = await api('GET', redirect.slice(BASE.length));
    check('callback page says connected', cb.status === 200 && /Atlassian is connected/.test(cb.text), cb.text.slice(0, 200));
    const a = atlassian(await view());
    check('Atlassian shows Connected via OAuth', a.state === 'connected' && a.method === 'oauth', { state: a.state, method: a.method });
    check('both agents were set up', a.agents.every((x) => x.chip === 'Added') && a.agents.length === 2, a.agents);
  },

  async C2() {
    const claude = JSON.parse(sh(`cat ${HOME}/.claude.json`).out);
    const e = claude.mcpServers && claude.mcpServers.atlassian;
    check('~/.claude.json has the atlassian entry', e && e.type === 'http' && /\/mcp\/atlassian$/.test(e.url) && e.headers && e.headers['X-VaultOS-Key'] === relayKey(), e && { type: e.type, url: e.url });
    const cursor = JSON.parse(sh(`cat ${HOME}/.cursor/mcp.json`).out);
    const c = cursor.mcpServers && cursor.mcpServers.atlassian;
    check('~/.cursor/mcp.json has the atlassian entry', c && /\/mcp\/atlassian$/.test(c.url) && c.headers && c.headers['X-VaultOS-Key'] === relayKey(), c && { url: c.url });
    for (const cwd of ['/vault', '/tmp']) {
      const cl = sh('claude mcp list', { cwd, timeout: 120000 });
      check(`claude mcp list from ${cwd} shows atlassian connected`, /atlassian[^\n]*Connected/.test(cl.out) && !/atlassian[^\n]*(Failed|authentication)/.test(cl.out), cl.out.slice(-300));
      const ag = sh('agent mcp list', { cwd, timeout: 120000 });
      check(`agent mcp list from ${cwd} shows atlassian ready`, /atlassian[^\n]*ready/i.test(ag.out), ag.out.slice(-300));
    }
  },

  async C3() {
    const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    check('initialize works through the relay', init.status === 200 && init.msg && init.msg.result, init);
    const list = await mcp('tools/list');
    const names = list.msg && list.msg.result && list.msg.result.tools.map((t) => t.name);
    check('tools/list shows the Atlassian tools', Array.isArray(names) && names.includes('atlassianUserInfo'), names || list);
    const who = toolText(await mcp('tools/call', { name: 'atlassianUserInfo', arguments: {} }));
    check('atlassianUserInfo returns the account', who && who.email === 'alex@example.com', who);
    const bad = await mcp('tools/call', { name: 'atlassianUserInfo', arguments: {} }, 'atlassian', 'not-the-key');
    check('a wrong key is refused with 403 and no JSON-RPC answer', bad.status === 403, bad);
  },

  async C4() {
    const before = (await ctrl('/state')).refreshes;
    check('fake switched to expire mode', (await ctrl('/mode/expire')).mode === 'expire');
    const who = toolText(await mcp('tools/call', { name: 'atlassianUserInfo', arguments: {} }));
    check('the call still works after the access token expired', who && who.email === 'alex@example.com', who);
    const after = (await ctrl('/state')).refreshes;
    check('exactly one refresh reached the fake', after === before + 1, { before, after });
    check('Atlassian still Connected', atlassian(await view()).state === 'connected');
    await ctrl('/mode/normal');
  },

  async C5() {
    // Old access tokens stop working, and the refresh token is refused.
    await ctrl('/forget-access');
    check('fake switched to refuse-refresh mode', (await ctrl('/mode/refuse-refresh')).mode === 'refuse-refresh');
    const first = await mcp('tools/call', { name: 'atlassianUserInfo', arguments: {} });
    const firstText = first.msg && first.msg.result ? JSON.stringify(first.msg.result) : JSON.stringify(first.msg);
    check('the call returns the expired sentence, not a 401', first.status !== 401 && firstText.includes(EXPIRED), first);
    const v = await view();
    check('GET /api/connectors says attention: true', v.attention === true, v.attention);
    check('Atlassian shows Sign in again', atlassian(v).state === 'needs-sign-in', atlassian(v).state);
    const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    check('initialize still answers', init.status === 200 && init.msg && init.msg.result, init);
    const list = await mcp('tools/list');
    const tools = list.msg && list.msg.result && list.msg.result.tools;
    check('tools/list has one placeholder tool, vaultos_sign_in, whose description is the sentence',
      Array.isArray(tools) && tools.length === 1 && tools[0].name === 'vaultos_sign_in' && tools[0].description === EXPIRED, tools || list);
    const call = await mcp('tools/call', { name: 'vaultos_sign_in', arguments: {} });
    check('calling the placeholder returns the sentence as an error result',
      call.msg && call.msg.result && call.msg.result.isError === true && call.msg.result.content[0].text === EXPIRED, call);
    const other = await mcp('resources/list');
    check('other methods get JSON-RPC error -32001 with the sentence', other.status !== 401 && other.msg && other.msg.error && other.msg.error.code === -32001 && other.msg.error.message === EXPIRED, other);
    await ctrl('/mode/normal');
  },

  async C6() {
    // Another entry in each agent must survive the disconnect.
    const seed = `node -e "
      const fs=require('fs'),h='${HOME}';
      const a=JSON.parse(fs.readFileSync(h+'/.claude.json','utf8')); a.mcpServers.other={type:'http',url:'http://127.0.0.1:1/x'}; fs.writeFileSync(h+'/.claude.json',JSON.stringify(a,null,2));
      const c=JSON.parse(fs.readFileSync(h+'/.cursor/mcp.json','utf8')); c.mcpServers.other={url:'http://127.0.0.1:1/x'}; fs.writeFileSync(h+'/.cursor/mcp.json',JSON.stringify(c,null,2));"`;
    try {
      check('seeded an unrelated entry in both agents', sh(seed).code === 0);
      const d = await api('POST', '/api/connectors/atlassian/disconnect');
      check('disconnect answers 200', d.status === 200, d.status);
      const a = atlassian(await view());
      check('Atlassian is Not connected', a.state === 'not-connected', a.state);
      const claude = JSON.parse(sh(`cat ${HOME}/.claude.json`).out);
      const cursor = JSON.parse(sh(`cat ${HOME}/.cursor/mcp.json`).out);
      check('the atlassian entry is gone from Claude Code', !('atlassian' in claude.mcpServers), Object.keys(claude.mcpServers));
      check('the atlassian entry is gone from the Cursor CLI', !('atlassian' in cursor.mcpServers), Object.keys(cursor.mcpServers));
      check('the other entries are untouched', claude.mcpServers.other && claude.mcpServers.other.url === 'http://127.0.0.1:1/x' && cursor.mcpServers.other && cursor.mcpServers.other.url === 'http://127.0.0.1:1/x');
      const gone = await mcp('tools/call', { name: 'atlassianUserInfo', arguments: {} });
      check('the relay now says it is not connected', JSON.stringify(gone.msg).includes("Atlassian isn't connected yet."), gone);
    } finally {
      // Clean up the seeded entries so the preview is left tidy, even after a failure.
      sh(`node -e "
        const fs=require('fs'),h='${HOME}';
        for (const [f,k] of [['/.claude.json'],['/.cursor/mcp.json']]) { const j=JSON.parse(fs.readFileSync(h+f,'utf8')); delete j.mcpServers.other; fs.writeFileSync(h+f,JSON.stringify(j,null,2)); }"`);
    }
  },
  async C7() {
    restartFake();
    await sleep(1500);
    const bad = await api('POST', '/api/connectors/github/token', { token: 'wrong' });
    check('a token the service refuses is not saved', bad.status >= 400, bad.status);
    const save = await api('POST', '/api/connectors/github/token', { token: 'svc-key' });
    check('saving the GitHub token answers 200', save.status === 200, { status: save.status, text: save.text.slice(0, 200) });
    const g = (await view()).connectors.find((c) => c.id === 'github');
    check('GitHub shows connected as alex-example', g.state === 'connected' && g.account === 'alex-example', { state: g.state, account: g.account });
    check('both agents were set up', g.agents.length === 2 && g.agents.every((x) => x.chip === 'Added'), g.agents);
    const claudeRaw = sh(`cat ${HOME}/.claude.json`).out;
    const cursorRaw = sh(`cat ${HOME}/.cursor/mcp.json`).out;
    const e = JSON.parse(claudeRaw).mcpServers.github;
    const c = JSON.parse(cursorRaw).mcpServers.github;
    check('~/.claude.json has the github entry with the relay key', e && /^http:\/\/127\.0\.0\.1:8080\/mcp\/github$/.test(e.url) && e.headers['X-VaultOS-Key'] === relayKey(), e && { url: e.url });
    check('~/.cursor/mcp.json has the github entry with the relay key', c && /^http:\/\/127\.0\.0\.1:8080\/mcp\/github$/.test(c.url) && c.headers['X-VaultOS-Key'] === relayKey(), c && { url: c.url });
    check('the GitHub token is in neither agent file', !claudeRaw.includes('svc-key') && !cursorRaw.includes('svc-key'));
    for (const cwd of ['/vault', '/tmp']) {
      const cl = sh('claude mcp list', { cwd, timeout: 120000 });
      check(`claude mcp list from ${cwd} shows github connected`, /github[^\n]*Connected/.test(cl.out) && !/github[^\n]*(Failed|authentication)/.test(cl.out), cl.out.slice(-300));
      const ag = sh('agent mcp list', { cwd, timeout: 120000 });
      check(`agent mcp list from ${cwd} shows github ready`, /github[^\n]*ready/i.test(ag.out), ag.out.slice(-300));
    }
    const me = toolText(await mcp('tools/call', { name: 'get_me', arguments: {} }, 'github'));
    check('get_me through the relay returns alex-example', me && me.login === 'alex-example', me);
    const d = await api('POST', '/api/connectors/github/disconnect');
    check('disconnect answers 200', d.status === 200, d.status);
    const claude = JSON.parse(sh(`cat ${HOME}/.claude.json`).out);
    const cursor = JSON.parse(sh(`cat ${HOME}/.cursor/mcp.json`).out);
    check('the github entry is gone from both agents', !('github' in claude.mcpServers) && !('github' in cursor.mcpServers));
  },

  async C8() {
    const on = await api('POST', '/api/connectors/mslearn/enable', {});
    check('turning on Microsoft Learn answers 200', on.status === 200, { status: on.status, text: on.text.slice(0, 200) });
    const m = (await view()).connectors.find((c) => c.id === 'mslearn');
    check('Microsoft Learn is connected with tools (real service)', m.state === 'connected' && m.lastTest && m.lastTest.ok && m.lastTest.tools > 0, { state: m.state, lastTest: m.lastTest });
    check('both agents were set up', m.agents.length === 2 && m.agents.every((x) => x.chip === 'Added'), m.agents);
    const claude = JSON.parse(sh(`cat ${HOME}/.claude.json`).out).mcpServers.mslearn;
    const cursor = JSON.parse(sh(`cat ${HOME}/.cursor/mcp.json`).out).mcpServers.mslearn;
    check('both agent files have the mslearn entry', claude && /\/mcp\/mslearn$/.test(claude.url) && cursor && /\/mcp\/mslearn$/.test(cursor.url), { claude, cursor });
    for (const cwd of ['/vault', '/tmp']) {
      const cl = sh('claude mcp list', { cwd, timeout: 120000 });
      check(`claude mcp list from ${cwd} shows mslearn connected`, /mslearn[^\n]*Connected/.test(cl.out) && !/mslearn[^\n]*(Failed|authentication)/.test(cl.out), cl.out.slice(-300));
      const ag = sh('agent mcp list', { cwd, timeout: 120000 });
      check(`agent mcp list from ${cwd} shows mslearn ready`, /mslearn[^\n]*ready/i.test(ag.out), ag.out.slice(-300));
    }
    const res = await mcp('tools/call', { name: 'microsoft_docs_search', arguments: { query: 'azure key vault rotation' } }, 'mslearn');
    const text = res.msg && res.msg.result && res.msg.result.content && res.msg.result.content.map((x) => x.text || '').join('');
    check('microsoft_docs_search through the relay returns content', res.status === 200 && !(res.msg.result.isError) && typeof text === 'string' && text.length > 50, res);
    const d = await api('POST', '/api/connectors/mslearn/disconnect');
    check('disconnect answers 200', d.status === 200, d.status);
    const c2 = JSON.parse(sh(`cat ${HOME}/.claude.json`).out).mcpServers;
    const u2 = JSON.parse(sh(`cat ${HOME}/.cursor/mcp.json`).out).mcpServers;
    check('the mslearn entry is gone from both agents', !('mslearn' in c2) && !('mslearn' in u2));
    const gone = await mcp('tools/call', { name: 'microsoft_docs_search', arguments: { query: 'x' } }, 'mslearn');
    check('the next relay call says it is not connected', /isn't connected yet/.test(JSON.stringify(gone.msg)), gone);
  },
  async C9() {
    const row = async () => (await view()).connectors.find((c) => c.id === 'transcripts');
    const msctrl = async (p) => { const r = sh(`curl -s ${MSCTRL}${p}`); try { return JSON.parse(r.out); } catch { return { error: r.out }; } };
    const startMs = async () => {
      sh("for p in $(ps -eo pid,args | grep '[f]ake-msapp' | awk '{print $1}'); do kill $p; done; sleep 1");
      spawnSync('docker', ['exec', '-d', '-u', '1000', CONTAINER, 'node', '/app/scripts/fake-msapp.js', '--port', '5557', '--control', '5558', '--state', '/tmp/fake-msapp-state.json']);
      for (let i = 0; i < 20; i++) { if ((await msctrl('/state')).graph === 0) return true; await sleep(500); }
      return false;
    };
    const rawFiles = () => ({ claude: sh(`cat ${HOME}/.claude.json`).out, cursor: sh(`cat ${HOME}/.cursor/mcp.json`).out });
    const tool = async (name, args) => { const r = await mcp('tools/call', { name, arguments: args || {} }, 'transcripts'); return { r, text: r.msg && r.msg.result && r.msg.result.content ? r.msg.result.content.map((x) => x.text || '').join('') : '', isError: !!(r.msg && r.msg.result && r.msg.result.isError) }; };
    const health = async () => { for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/health')).ok) return true; } catch { /* starting */ } await sleep(500); } return false; };
    sh(`rm -f /tmp/fake-msapp-state.json`);
    try {
      check('fake Microsoft answers inside the container', await startMs());
      await api('POST', '/api/connectors/transcripts/disconnect');
      const bad = await api('POST', '/api/connectors/transcripts/start', { tenantId: 'not-a-guid', clientId: T_CLIENT });
      check('a tenant ID that is not a GUID is refused before any request', bad.status >= 400 && (await msctrl('/state')).devicecodes === 0, { status: bad.status, body: bad.body });
      const start = await api('POST', '/api/connectors/transcripts/start', { tenantId: T_TENANT, clientId: T_CLIENT });
      check('start with made-up GUIDs shows a code and a page to enter it on', start.status === 200 && start.body && start.body.code === 'FAKE1234' && /^http/.test(start.body.url || ''), { status: start.status, body: start.body });
      const ms0 = await msctrl('/state');
      check('the fake saw one device-code request with the exact scopes', ms0.devicecodes === 1 && ms0.scopes.join(' ') === 'OnlineMeetingTranscript.Read.All OnlineMeetings.Read Calendars.Read User.Read offline_access', ms0);
      check('status is waiting before the code is entered', (await api('GET', '/api/connectors/transcripts/status')).body.status === 'waiting');
      await msctrl('/approve');
      let st = null;
      for (let i = 0; i < 30; i++) { st = (await api('GET', '/api/connectors/transcripts/status')).body; if (st && st.status !== 'waiting') break; await sleep(1000); }
      check('status becomes done after the code is entered', st && st.status === 'done', st);
      const t = await row();
      check('Teams transcripts shows connected as alex@example.com', t && t.state === 'connected' && t.account === 'alex@example.com', t && { state: t.state, account: t.account });
      check('the view row carries the IDs', t && t.tenantId === T_TENANT && t.clientId === T_CLIENT, t && { tenantId: t.tenantId, clientId: t.clientId });
      check('both agents were set up', t && t.agents.length === 2 && t.agents.every((x) => x.chip === 'Added'), t && t.agents);
      const raw = rawFiles();
      const e = JSON.parse(raw.claude).mcpServers.transcripts;
      const c = JSON.parse(raw.cursor).mcpServers.transcripts;
      check('~/.claude.json has the transcripts entry with the relay URL and key', e && /^http:\/\/127\.0\.0\.1:8080\/mcp\/transcripts$/.test(e.url) && e.headers['X-VaultOS-Key'] === relayKey(), e && { url: e.url });
      check('~/.cursor/mcp.json has the transcripts entry with the relay URL and key', c && /^http:\/\/127\.0\.0\.1:8080\/mcp\/transcripts$/.test(c.url) && c.headers['X-VaultOS-Key'] === relayKey(), c && { url: c.url });
      const refreshToken = (JSON.parse(sh(`cat ${HOME}/.vaultos/connectors.json`).out).connectors.transcripts || {}).refreshToken;
      check('a refresh token is saved in the store', typeof refreshToken === 'string' && refreshToken.length > 8);
      check('no refresh or access token is in either agent file', !raw.claude.includes(refreshToken) && !raw.cursor.includes(refreshToken) && !/\b(rt|at)-[0-9a-f]{24}\b/.test(raw.claude + raw.cursor));
      for (const cwd of ['/vault', '/tmp']) {
        const cl = sh('claude mcp list', { cwd, timeout: 120000 });
        check(`claude mcp list from ${cwd} shows transcripts connected`, /transcripts[^\n]*Connected/.test(cl.out) && !/transcripts[^\n]*(Failed|authentication)/.test(cl.out), cl.out.slice(-300));
        const ag = sh('agent mcp list', { cwd, timeout: 120000 });
        check(`agent mcp list from ${cwd} shows transcripts ready`, /transcripts[^\n]*ready/i.test(ag.out), ag.out.slice(-300));
      }
      const list = await tool('transcripts_list', {});
      const ids = /meetingId=(\S+) transcriptId=(\S+)/.exec(list.text);
      check('transcripts_list through the relay returns the fake meeting', list.r.status === 200 && !list.isError && /Weekly planning/.test(list.text) && !!ids, list.text || list.r);
      const got = await tool('transcript_get', { meetingId: ids && ids[1], transcriptId: ids && ids[2] });
      check('transcript_get returns the header and both speakers\' lines', !got.isError && /Subject: Weekly planning/.test(got.text) && /\[00:00\] Alex Example: Let's go through the plan for the week\./.test(got.text) && /\[00:00\] Sam Sample: The migration is on track for Thursday\./.test(got.text), got.text || got.r);
      const rawVtt = await tool('transcript_get', { meetingId: ids && ids[1], transcriptId: ids && ids[2], raw: true });
      check('transcript_get with raw returns the WebVTT', !rawVtt.isError && /WEBVTT/.test(rawVtt.text) && /<v Sam Sample>/.test(rawVtt.text), rawVtt.text.slice(0, 200));

      // A restart of VaultOS: the sign-in is rebuilt from the store. The fake dies with the container but keeps its refresh tokens in a file.
      const rc = spawnSync('docker', ['restart', CONTAINER], { encoding: 'utf8', timeout: 120000 });
      check('the preview container restarted', rc.status === 0 && await health(), rc.stderr);
      check('the fake is back after the restart', await startMs());
      const again = await tool('transcripts_list', {});
      const ms1 = await msctrl('/state');
      check('listing after the restart works without signing in again', !again.isError && /Weekly planning/.test(again.text) && ms1.devicecodes === 0 && ms1.deviceTokens === 0, { text: again.text.slice(0, 200), ms1 });
      check('the restart cost one refresh and the fake accepted it', ms1.refreshes === 1 && ms1.refused === 0, ms1);
      check('still connected as alex@example.com', (await row()).state === 'connected' && (await row()).account === 'alex@example.com');

      // Microsoft refuses the refresh token.
      await msctrl('/forget-access');
      await msctrl('/refuse-refresh');
      const gone = await tool('transcripts_list', {});
      check('the call returns the sign-in-ran-out sentence as an error result', gone.r.status !== 401 && gone.isError && gone.text === T_GONE, gone.text || gone.r);
      const v = await view();
      check('the row shows needs-sign-in and the view says attention: true', (await row()).state === 'needs-sign-in' && v.attention === true, { state: (await row()).state, attention: v.attention });

      // Disconnect removes the entries and keeps the app's IDs.
      const d = await api('POST', '/api/connectors/transcripts/disconnect');
      check('disconnect answers 200', d.status === 200, d.status);
      const after = rawFiles();
      check('the transcripts entry is gone from both agents', !('transcripts' in JSON.parse(after.claude).mcpServers) && !('transcripts' in JSON.parse(after.cursor).mcpServers));
      const t2 = await row();
      check('the row is not connected but keeps the tenant and client IDs', t2.state === 'not-connected' && t2.tenantId === T_TENANT && t2.clientId === T_CLIENT, t2 && { state: t2.state, tenantId: t2.tenantId, clientId: t2.clientId });
      const saved = JSON.parse(sh(`cat ${HOME}/.vaultos/connectors.json`).out).connectors.transcripts;
      check('the store keeps only the method and the IDs', saved && !saved.refreshToken && saved.tenantId === T_TENANT && saved.clientId === T_CLIENT, saved && Object.keys(saved));
      const nope = await tool('transcripts_list', {});
      check('the next relay call says it is not connected', /isn't connected yet/.test(JSON.stringify(nope.r.msg)) || nope.isError, nope.text || nope.r);
    } finally {
      sh("for p in $(ps -eo pid,args | grep '[f]ake-msapp' | awk '{print $1}'); do kill $p; done; rm -f /tmp/fake-msapp-state.json");
    }
  },
};

(async () => {
  seedCookie();
  for (const name of NAMES) {
    console.log(`\n== ${name} ==`);
    try { await SCENARIOS[name](); } catch (e) { check(`${name} ran without throwing`, false, String(e && e.stack || e).slice(0, 400)); }
  }
  console.log(`\n${failures ? 'FAILED' : 'OK'}: ${failures} failed check(s)`);
  process.exit(failures ? 1 : 0);
})();
