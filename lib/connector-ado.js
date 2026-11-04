'use strict';
// The Azure DevOps connector: Microsoft's own server (@azure-devops/mcp, stdio) run through VaultOS's wrapper
// (lib/ado-mcp.js) with `--authentication azcli`, so it rides the Azure connector's `az` login and needs no sign-in
// of its own. Microsoft's server has no read-only mode, so the wrapper hides and refuses every tool not on READ below
// unless the person allows changes. This module is the policy, the organization parsing, and a stdio probe for Test.
const { spawn: nodeSpawn } = require('node:child_process');
const path = require('node:path');

const PACKAGE = '@azure-devops/mcp@2.11.0'; // pinned: READ was checked against this version's tools
const BIN = 'mcp-server-azuredevops';
const WRAPPER = path.join(__dirname, 'ado-mcp.js');

// Every tool in 2.11.0 that only reads. Anything not here (the *_write tools, wiki_upsert_page, repo_create_branch,
// the attachment upload and link, and any tool a later version adds) is hidden and refused while changes are off.
const READ = new Set([
  'core_list_project_teams', 'core_list_projects', 'core_get_identity_ids',
  'advsec_get_alerts', 'advsec_get_alert_details',
  'mcp_apps_ping',
  'pipelines_build', 'pipelines_build_log', 'pipelines_definition', 'pipelines_run', 'pipelines_artifact',
  'repo_repository', 'repo_pull_request', 'repo_pull_request_org', 'repo_pull_request_thread', 'repo_branch',
  'repo_file', 'repo_search_commits',
  'search_code', 'search_wiki', 'search_workitem',
  'testplan', 'testplan_show_test_results_from_build_id',
  'wiki',
  'wit_work_item', 'wit_query', 'wit_backlog', 'wit_work_item_attachment',
  'work',
]);
// Read tools with one action that changes something.
const WRITE_ACTIONS = { wit_backlog: ['reorder'] };

const READ_ONLY_TEXT = 'VaultOS has Azure DevOps read-only, so this tool is off. To let agents make changes, turn on "Allow changes" in Settings → Connectors → Azure DevOps.';

function allowed(name, args) {
  if (typeof name !== 'string' || !READ.has(name)) return false;
  const action = args && typeof args === 'object' ? args.action : undefined;
  return !(Object.hasOwn(WRITE_ACTIONS, name) && WRITE_ACTIONS[name].includes(action));
}

// An organization name, or a pasted dev.azure.com / *.visualstudio.com address, -> the name; null if it isn't one.
// Names are letters, digits and hyphens, up to 50, not starting or ending with a hyphen.
function parseOrg(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(dev\.azure\.com|[^/]+\.visualstudio\.com)(\/|$)/i.test(s)) {
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host === 'dev.azure.com') s = decodeURIComponent(u.pathname.split('/')[1] || '');
    else if (host.endsWith('.visualstudio.com')) s = host.slice(0, -'.visualstudio.com'.length);
    else return null;
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/.test(s) ? s : null;
}

// The agent entry: the wrapper, run by the same Node as VaultOS, starting Microsoft's server from ~/.local/bin.
function entry({ home, org, allowChanges, node = process.execPath }) {
  return {
    kind: 'stdio',
    command: node,
    args: [WRAPPER, '--server', path.join(home, '.local/bin', BIN), '--org', org, ...(allowChanges ? ['--allow-changes'] : [])],
  };
}

// Starts a stdio MCP server, says hello, lists its tools and can call one. Never throws: failures come back as
// { ok: false, error }. close() ends the process. The text of a failure is the server's own last stderr line when it
// has one (Microsoft's server says why it can't get a token there), so it is cut short and never holds a token.
function stdioProbe(command, args, { spawn = nodeSpawn, env = process.env, timeoutMs = 60000 } = {}) {
  let child;
  try { child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) {
    return Promise.resolve({ ok: false, tools: [], error: (e && e.message) || "couldn't start", close() {} });
  }
  let buf = '', errText = '', seq = 0, dead = null;
  const waiting = new Map();
  const close = () => { try { child.stdin.end(); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } };
  const lastErr = () => errText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  const fail = (why) => {
    if (dead) return;
    dead = why;
    for (const w of waiting.values()) w.reject(new Error(why));
    waiting.clear();
  };
  child.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.method && msg.id !== undefined) { // the server asks something (a project picker): decline
        write({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
        continue;
      }
      const w = msg && waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || 'the server returned an error'));
      else w.resolve(msg.result || {});
    }
  });
  child.stderr.on('data', (c) => { errText = (errText + c.toString()).slice(-4000); });
  child.on('error', (e) => fail((e && e.message) || "couldn't start"));
  child.on('close', (code) => fail(lastErr() || `the server stopped (exit ${code})`));
  child.stdin.on('error', () => {});
  function write(obj) { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* close reports it */ } }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(dead));
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('the server did not answer in time')); }, timeoutMs);
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    write({ jsonrpc: '2.0', id, method, params });
  });
  const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 300);
  return (async () => {
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'VaultOS', version: '1' } });
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await rpc('tools/list', {});
      const tools = (list.tools || []).map((x) => x && x.name).filter((x) => typeof x === 'string');
      return { ok: true, tools, call: (name, a) => rpc('tools/call', { name, arguments: a || {} }), close };
    } catch (e) {
      close();
      return { ok: false, tools: [], error: short((e && e.message) || "couldn't start"), close() {} };
    }
  })();
}

// Microsoft's server fences tool output with <<random>> markers and an "[UNTRUSTED … CONTENT …]" label; neither is for people.
const textOf = (res) => {
  const part = res && Array.isArray(res.content) ? res.content.find((c) => c && typeof c.text === 'string') : null;
  return part ? part.text.replace(/<<[0-9a-f]{16,}>>/gi, '').replace(/\[UNTRUSTED[^\]]*\]/g, '').trim() : '';
};

// Test: start the agents' own entry, list the tools, and list one project (the call that needs the sign-in).
// { ok, tools, projects?, error? }
async function test({ home, org, allowChanges, spawn, env, timeoutMs } = {}) {
  const e = entry({ home, org, allowChanges });
  const probe = await stdioProbe(e.command, e.args, { spawn, env, timeoutMs });
  if (!probe.ok) return { ok: false, tools: 0, error: probe.error };
  try {
    const res = await probe.call('core_list_projects', { top: 100 });
    const text = textOf(res);
    if (res && res.isError) return { ok: false, tools: probe.tools.length, error: text.replace(/\s+/g, ' ').slice(0, 300) || 'Azure DevOps refused the request.' };
    let projects;
    try { const j = JSON.parse(text); if (Array.isArray(j)) projects = j.length; else if (j && Array.isArray(j.value)) projects = j.value.length; } catch { /* count unknown */ }
    return { ok: true, tools: probe.tools.length, ...(projects !== undefined ? { projects } : {}) };
  } catch (err) {
    return { ok: false, tools: probe.tools.length, error: String((err && err.message) || 'Azure DevOps did not answer').slice(0, 300) };
  } finally { probe.close(); }
}

module.exports = { PACKAGE, BIN, WRAPPER, READ, WRITE_ACTIONS, READ_ONLY_TEXT, allowed, parseOrg, entry, stdioProbe, test };
