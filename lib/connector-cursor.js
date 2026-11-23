'use strict';
// Cursor's own Microsoft 365 servers (Teams, Outlook, Outlook calendar on api.cursor.com) sign in through the Cursor
// CLI: `agent mcp login <name>` prints Microsoft's sign-in link and waits on http://localhost:<port>/callback inside
// VaultOS's container, which the person's browser can't reach. So VaultOS runs the login, shows the link, and takes
// the address the browser ended on (pasted by the person) to that waiting listener. It checks the pasted address
// against the CLI's own redirect address and state first, and only ever forwards to that one local listener.
// The pasted address carries a one-time code: it is never logged, stored or shown.
const { spawn: nodeSpawn } = require('node:child_process');
const { shellQuote } = require('./agents');
const { classify } = require('./connector-msapp');

const LINK_RE = /https:\/\/login\.microsoftonline\.com\/[^\s"'<>]+/;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const LINK_WAIT_MS = 45000;
const FINISH_WAIT_MS = 60000;
const LIFE_MS = 15 * 60 * 1000;

class CursorLoginError extends Error {}

const lastLine = (out) => String(out || '').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && !/^(MCP Login|Preparing|Checking status|Loading MCP|Opening your browser|Listening on)/i.test(l)).pop() || '';
// Never repeat a code, a state or a whole address back.
const scrub = (s) => String(s || '').replace(/(code|state|session_state|code_challenge)=[^&\s]+/gi, '$1=…').replace(/https?:\/\/\S+/g, (u) => u.split('?')[0]);

// The sign-in the CLI asked for: Microsoft's link, and where and with what state Microsoft will send the browser back.
function readLink(url) {
  let u; let back;
  try { u = new URL(url); back = new URL(u.searchParams.get('redirect_uri') || ''); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'login.microsoftonline.com') return null;
  if (back.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(back.hostname) || !back.port) return null;
  const state = u.searchParams.get('state');
  if (!state) return null;
  return { url: u.href, port: back.port, path: back.pathname, state };
}

function createCursorLogins({ spawn = nodeSpawn, fetch = globalThis.fetch, now = Date.now, home, consent = {} } = {}) {
  const logins = {}; // connector id -> { child, link, out, exit, startedAt, state: 'waiting'|'done'|'failed', error }

  function stop(id) {
    const l = logins[id];
    if (l && l.child && l.exit === undefined) { try { l.child.kill('SIGTERM'); } catch { /* gone */ } }
  }

  // Starts the CLI's login and answers Microsoft's link once the CLI prints it.
  function start(id) {
    stop(id);
    const child = spawn('bash', ['-lc', `agent mcp login ${shellQuote(id)}`], {
      cwd: home, env: { ...process.env, BROWSER: 'true', NO_OPEN_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const l = { child, link: null, out: '', exit: undefined, startedAt: now(), state: 'waiting', error: undefined };
    logins[id] = l;
    const timer = setTimeout(() => { if (logins[id] === l && l.exit === undefined) { l.state = 'failed'; l.error = 'The sign-in took too long. Start again.'; stop(id); } }, LIFE_MS);
    if (timer.unref) timer.unref();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(wait); fn(v); } };
      const wait = setTimeout(() => {
        l.state = 'failed'; l.error = "Cursor didn't start the sign-in. Try again."; stop(id);
        done(reject, new CursorLoginError(l.error));
      }, LINK_WAIT_MS);
      const onData = (d) => {
        if (l.out.length < 65536) l.out += String(d);
        if (!l.link) {
          const m = LINK_RE.exec(l.out.replace(ANSI_RE, ''));
          const link = m && readLink(m[0]);
          if (link) { l.link = link; done(resolve, { url: link.url }); }
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', () => { l.exit = -1; l.state = 'failed'; l.error = "Couldn't run the Cursor CLI."; done(reject, new CursorLoginError(l.error)); });
      child.on('exit', (code) => {
        l.exit = code === null ? -1 : code;
        clearTimeout(timer);
        if (l.state === 'waiting') {
          if (l.exit === 0) l.state = 'done'; // with no link printed: it was already signed in
          else { l.state = 'failed'; l.error = scrub(lastLine(l.out)) || `The Cursor CLI stopped (exit ${l.exit}).`; }
        }
        if (l.state === 'done') done(resolve, { url: null, done: true });
        else done(reject, new CursorLoginError(l.error || 'The sign-in stopped.'));
      });
    });
  }

  const waitExit = (l, ms) => new Promise((resolve) => {
    if (l.exit !== undefined) return resolve(l.exit);
    const t = setTimeout(() => resolve(undefined), ms);
    l.child.on('exit', (code) => { clearTimeout(t); resolve(code === null ? -1 : code); });
  });

  // pasted: the address the browser ended on. Checked, then handed to the CLI's own listener; answers when the CLI is done.
  async function finish(id, pasted) {
    const l = logins[id];
    if (!l || !l.link || l.exit !== undefined || l.state !== 'waiting') throw new CursorLoginError('That sign-in has ended. Select Sign in to start again.');
    let p;
    try { p = new URL(String(pasted || '').trim()); } catch { p = null; }
    const want = l.link;
    if (!p || p.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(p.hostname) || p.port !== want.port || p.pathname !== want.path) {
      throw new CursorLoginError(`That isn't the address your browser ended on. After signing in, copy the whole address of the page that didn't load. It starts http://localhost:${want.port}${want.path}`);
    }
    if (p.searchParams.get('state') !== want.state) throw new CursorLoginError('That address is from a different sign-in. Select Sign in to start again.');
    const msError = p.searchParams.get('error');
    if (!msError && !p.searchParams.get('code')) throw new CursorLoginError("That address has no sign-in code in it. Copy the whole address, including everything after the '?'.");
    try {
      const r = await fetch(`http://localhost:${want.port}${want.path}${p.search}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) });
      try { await r.arrayBuffer(); } catch { /* the page itself doesn't matter */ }
    } catch {
      l.state = 'failed'; l.error = "The Cursor CLI wasn't listening any more. Select Sign in to start again."; stop(id);
      throw new CursorLoginError(l.error);
    }
    const code = await waitExit(l, FINISH_WAIT_MS);
    if (msError) {
      // Microsoft said no (a blocked consent, a declined prompt): say who can fix it, never Microsoft's code
      const c = classify(400, { error: msError, error_description: p.searchParams.get('error_description') || '' }, { consent: consent[id] });
      l.state = 'failed'; l.error = c.message; stop(id);
      throw new CursorLoginError(l.error);
    }
    if (code === 0) { l.state = 'done'; return { ok: true }; }
    l.state = 'failed';
    l.error = code === undefined ? "Cursor didn't finish the sign-in. Select Sign in to start again." : (scrub(lastLine(l.out)) || `The Cursor CLI stopped (exit ${code}).`);
    stop(id);
    throw new CursorLoginError(l.error);
  }

  function cancel(id) { stop(id); delete logins[id]; }

  // For the card: a sign-in in progress (with its link, so a reload can show it again), or how the last one ended.
  function status(id) {
    const l = logins[id];
    if (!l) return { status: 'idle' };
    if (l.state === 'waiting' && l.link) return { status: 'waiting', url: l.link.url, port: l.link.port };
    if (l.state === 'failed') return { status: 'failed', error: l.error };
    return { status: l.state };
  }

  return { start, finish, cancel, status };
}

// Test: asks the Cursor CLI for the server's tools. Answers { ok, tools, signedIn, error }.
async function cursorTools(run, id, label) {
  const r = await run(`agent mcp list-tools ${shellQuote(id)}`);
  const out = String(`${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`).replace(ANSI_RE, '');
  if (/requires authentication|mcp login/i.test(out)) return { ok: false, tools: 0, signedIn: false, error: `Not signed in to ${label} in Cursor yet.` };
  if (!r || r.code !== 0 || /\b(error|failed)\b/i.test(out)) return { ok: false, tools: 0, signedIn: null, error: scrub(lastLine(out)) || `The Cursor CLI couldn't list ${label}'s tools.` };
  return { ok: true, tools: null, signedIn: true, error: null }; // the CLI's listing has no fixed format to count from
}

module.exports = { createCursorLogins, cursorTools, readLink, CursorLoginError, scrub };
