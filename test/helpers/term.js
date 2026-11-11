'use strict';
// Opens a real VaultOS terminal over the websocket and reads its VAULTOS_TERM_ID / VAULTOS_TERM_TOKEN,
// for tests of the terminal-only routes (/api/term/*).
const crypto = require('node:crypto');
const WebSocket = require('ws');

// id: reattach to that terminal; query: extra parameters (space, spaceName, cwd…).
function openTerm({ base, cookie }, { timeoutMs = 10000, id: want, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const id = want || `test${crypto.randomBytes(4).toString('hex')}`;
    const q = new URLSearchParams({ id, ...query });
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/term?${q}`, { headers: { cookie, origin: base } });
    let out = '';
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no token from the terminal: ${out.slice(-300)}`)); }, timeoutMs);
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    // The marker is assembled by printf, so the terminal's echo of the typed command can't match it.
    ws.once('open', () => ws.send(JSON.stringify({ t: 'in', d: `printf '%s%s %s %s\\n' T K "$VAULTOS_TERM_ID" "$VAULTOS_TERM_TOKEN"\r` })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t !== 'o') return;
      out += m.d;
      const hit = /TK (\S+) (\S+)\r?\n/.exec(out);
      if (!hit) return;
      clearTimeout(timer);
      resolve({
        id: hit[1], token: hit[2],
        close: () => { try { ws.send(JSON.stringify({ t: 'kill' })); } catch { /* gone */ } ws.close(); },
        // Leave the shell running server-side (a hand-over or a reload), resolved once the socket has closed.
        detach: () => new Promise((done) => { ws.once('close', done); ws.close(); }),
        send: (msg) => ws.send(JSON.stringify(msg)),
      });
    });
  });
}

module.exports = { openTerm };
