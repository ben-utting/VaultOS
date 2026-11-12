'use strict';
// Is the page holding a terminal still there?
//
// A page that goes away without closing its socket (a laptop asleep, a tab the browser dropped, a phone app closed
// in the background) leaves the server holding a dead connection that still counts as "attached" until TCP gives
// up, which can be hours. A page that loads meanwhile won't take a terminal another page holds, so that terminal
// stays dimmed until it is clicked. Two checks, both websocket pings (a browser answers them by itself, even for a
// hidden tab):
//   beat(sockets)  every TERM_PING_MS: a socket that didn't answer the previous beat's ping is ended.
//   probe(ws)      on the spot (a page restoring its terminals asks): no answer within probeMs ends it.
// Ending a socket fires its 'close', which detaches the terminal; the shell keeps running.
function createAlive({ probeMs = 1500 } = {}) {
  const answered = new WeakMap();   // ws -> answered since the last beat

  function track(ws) {
    answered.set(ws, true);
    ws.on('pong', () => answered.set(ws, true));
  }

  function end(ws) {
    try { ws.terminate(); } catch { /* already gone */ }
  }

  function beat(sockets) {
    for (const ws of sockets) {
      if (answered.get(ws) === false) { end(ws); continue; }
      answered.set(ws, false);
      try { ws.ping(); } catch { /* not open: the next beat ends it */ }
    }
  }

  function probe(ws) {
    return new Promise((resolve) => {
      if (ws.readyState !== 1) return resolve(false);
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeListener('pong', onPong);
        if (!ok) end(ws);
        resolve(ok);
      };
      const onPong = () => { answered.set(ws, true); finish(true); };
      const timer = setTimeout(() => finish(false), probeMs);
      ws.on('pong', onPong);
      try { ws.ping(); } catch { finish(false); }
    });
  }

  return { track, beat, probe };
}

module.exports = { createAlive };
