'use strict';

// ========================================================================
// Connectors — Settings → Connectors (window.Connectors; also a Node module for the tests).
// The sibling of the agent picker (agent-form.js): tiles for the services VaultOS can connect, a detail
// panel for the picked one, the same chips, marks and buttons. The page passes a `ui`:
//   ui.api(method, url, body?)  → Promise<object>; rejects (or answers { error }) with a message for the person
//   ui.openTerm(cmd)            run a command in a terminal (Azure's install)
//   ui.openTab(url)             → Window | null; a new tab of this browser (Atlassian's approve page, which
//                               sends the person back and tells this page through postMessage)
//   ui.onView(view)             optional; every GET /api/connectors answer, for the Settings dot
//   ui.active()                 optional; false once Settings is closed or on another section: polling stops
//   ui.copy(text)               optional; → Promise<boolean>
//   ui.canTerm()                optional; false when there is no terminal to install in
// Every server string (an account, a site, az's error text, an agent's note) goes through esc().
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.Connectors = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const Marks = typeof AgentMarks !== 'undefined' ? AgentMarks : (typeof require === 'function' ? require('./agent-marks') : null);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATE_CHIP = {
    'not-installed': { text: 'Not installed', tone: 'plain' },
    'not-connected': { text: 'Not connected', tone: 'plain' },
    connecting: { text: 'Connecting…', tone: 'plain' },
    connected: { text: 'Connected', tone: 'ok' },
    'needs-sign-in': { text: 'Sign in again', tone: 'warn' },
    error: { text: 'Error', tone: 'warn' },
  };
  const stateChip = (state) => STATE_CHIP[state] || STATE_CHIP['not-connected'];
  const agentChip = (chip) => ({ text: chip, tone: chip === 'Added' ? 'ok' : chip === 'Has its own entry' ? 'warn' : 'plain' });
  const minutesLeft = (expiresAt, now) => Math.max(0, Math.ceil((expiresAt - now) / 60000));

  const ago = (at, now) => {
    const t = typeof at === 'number' ? at : Date.parse(at);   // lastTest.at is an ISO string
    if (!Number.isFinite(t)) return 'earlier';
    const s = Math.max(0, Math.floor((now - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) { const m = Math.floor(s / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
    if (s < 86400) { const h = Math.floor(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  };

  // Only https links from the server become links. "login.microsoft.com/device" for the Open button.
  const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x : null; } catch { return null; } };
  const hostPath = (u) => { const x = httpsUrl(u); return x ? x.host + (x.pathname === '/' ? '' : x.pathname) : ''; };

  const chipHtml = (c, extra = '') => `<span class="ap-chip${c.tone === 'ok' ? ' ok' : c.tone === 'warn' ? ' warn' : ''}${extra}">${esc(c.text)}</span>`;
  const mark = (id, cls = '') => `<span class="ap-mark${cls}">${Marks ? Marks.connector(id) : ''}</span>`;
  const agentMark = (id) => `<span class="ap-mark small">${Marks ? Marks.svg(id) : ''}</span>`;

  // ---- rendering --------------------------------------------------------------
  // st: { view: GET /api/connectors' answer, picked, err: { region: message }, email, token, waiting, azure: { url, code,
  // expiresAt } | null, options: { id: true }, notice }
  function tileHtml(c, st) {
    const on = c.id === st.picked;
    return `<button type="button" class="ap-tile cx-tile" data-id="${esc(c.id)}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}">`
      + `${mark(c.id)}<span class="ap-txt"><span class="ap-nm">${esc(c.label)}</span><span class="ap-by">${esc(c.by)}</span>`
      + `<span class="ap-chips">${chipHtml(stateChip(c.state))}</span></span></button>`;
  }
  const plannedHtml = (p) => `<div class="ap-tile cx-tile cx-later"><span class="ap-mark cx-mono">${esc(p.mono)}</span>`
    + `<span class="ap-txt"><span class="ap-nm">${esc(p.label)}</span><span class="ap-by">${esc(p.by)}</span></span></div>`;

  const errP = (st, region) => (st.err && st.err[region] ? `<p class="su-err cx-err" role="alert">${esc(st.err[region])}</p>` : '');
  const btn = (act, text, cls = '') => `<button type="button" class="su-btn${cls}" data-act="${act}">${esc(text)}</button>`;

  function agentRowsHtml(c) {
    const rows = c.agents || [];
    if (!rows.length) return '';
    const cursorAdded = rows.some((a) => a.id === 'cursor' && a.chip === 'Added');
    return '<h5 class="cx-sub">Added to your agents</h5><div class="cx-arows">'
      + rows.map((a) => `<div class="cx-arow">${agentMark(a.id)}<span class="cx-anm">${esc(a.label)}</span>`
        + `${a.chip ? chipHtml(agentChip(a.chip)) : ''}${a.note ? `<span class="cx-anote">${esc(a.note)}</span>` : ''}</div>`).join('')
      + '</div>'
      + (cursorAdded ? '<p class="cx-muted">If the Cursor CLI asks to approve a server, approve it once.</p>' : '');
  }

  function optionCardsHtml(c, st) {
    const help = httpsUrl(c.tokenHelp);
    return '<div class="cx-opts">'
      + '<div class="cx-opt main"><h5>Sign in with Atlassian <span class="ap-chip gold">Recommended</span></h5>'
      + "<p>Opens Atlassian's approve page in a new tab of this browser. When you approve, Atlassian sends you straight back here. No extra ports.</p>"
      + `<div class="ap-btns">${btn('oauth', 'Sign in with Atlassian', ' primary')}</div>${errP(st, 'oauth')}</div>`
      + '<div class="cx-opt"><h5>Use an API token</h5>'
      + "<p>Only works if your Atlassian admin has turned tokens on for agents. A token lasts up to a year, and a few tools don't work with one.</p>"
      + '<div class="su-field"><label for="cx-email">Atlassian email</label>'
      + `<input id="cx-email" class="su-input" type="email" autocomplete="off" spellcheck="false" value="${esc(st.email)}"></div>`
      + '<div class="su-field"><label for="cx-token">API token</label>'
      + `<input id="cx-token" class="su-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the token" value="${esc(st.token)}"></div>`
      + `<div class="ap-btns">${btn('token', 'Save token')}${help ? `<a class="cx-link" href="${esc(help.href)}" target="_blank" rel="noopener noreferrer">Create a token</a>` : ''}</div>${errP(st, 'token')}</div>`
      + '</div>';
  }

  function atlassianBody(c, st, now) {
    const connectedLike = c.state === 'connected' || c.state === 'error';
    if (connectedLike && !st.options.atlassian) {
      const via = c.method === 'token'
        ? (c.account ? `Signed in as ${c.account} with an API token. A token lasts up to a year.` : 'Signed in with an API token. A token lasts up to a year.')
        : (c.account ? `Signed in as ${c.account} through Atlassian. VaultOS renews the sign-in by itself.` : 'Signed in through Atlassian. VaultOS renews the sign-in by itself.');
      const t = c.lastTest;
      const tested = t ? (t.ok ? `Tested ${ago(t.at, now)}: Atlassian answered with ${t.tools} tools` : `Tested ${ago(t.at, now)}: it didn't answer`) : '';
      return `<ul class="ap-facts"><li>${esc(c.site ? `Jira and Confluence on ${c.site}` : 'Jira and Confluence')}</li><li>${esc(via)}</li>${tested ? `<li>${esc(tested)}</li>` : ''}</ul>`
        + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test again')}${btn('switch', c.method === 'token' ? 'Sign in with Atlassian instead' : 'Use an API token instead')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}`;
    }
    if (st.waiting && c.state !== 'connected') {
      return '<ul class="ap-facts"><li>Jira and Confluence, through Atlassian\'s own hosted server</li></ul>'
        + '<div class="cx-wait" aria-live="polite"><div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span>'
        + '<span>Waiting for you to approve in the Atlassian tab…</span></div>'
        + `<div class="ap-btns">${btn('reopen', 'Open the tab again')}${btn('cancel', 'Cancel')}</div>${errP(st, 'oauth')}</div>`;
    }
    const lead = c.state === 'needs-sign-in'
      ? '<p class="su-err cx-err" role="alert">Your Atlassian sign-in has run out. Sign in again.</p>' : '';
    const note = c.state !== 'needs-sign-in' && c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '';
    return '<ul class="ap-facts"><li>Jira and Confluence, through Atlassian\'s own hosted server</li><li>Pick one way to connect. You can switch later.</li></ul>'
      + lead + note + optionCardsHtml(c, st)
      + (st.options.atlassian && connectedLike ? `<div class="ap-btns">${btn('keep', 'Keep my current sign-in')}</div>` : '');
  }

  function codePanelHtml(st, now) {
    const a = st.azure;
    const open = a && httpsUrl(a.url);
    const mins = a ? minutesLeft(a.expiresAt, now) : 0;
    if (!a) {
      return '<div class="cx-wait" aria-live="polite"><div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>Waiting for Microsoft…</span></div>'
        + `<div class="ap-btns">${btn('azure-start', 'Sign in')}${btn('azure-cancel', 'Cancel')}</div>${errP(st, 'azure')}</div>`;
    }
    return '<div class="cx-code" aria-live="polite">'
      + `<div class="cx-codebox" id="cx-code">${esc(a.code)}</div>`
      + `<div class="ap-btns">${btn('copy', 'Copy code')}${open ? `<a class="su-btn primary" href="${esc(open.href)}" target="_blank" rel="noopener noreferrer">Open ${esc(hostPath(a.url))}</a>` : ''}</div>`
      + `<div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>Waiting for Microsoft… the code works for ${mins} more minute${mins === 1 ? '' : 's'}</span></div>`
      + `<div class="ap-btns">${btn('azure-cancel', 'Cancel')}</div>${errP(st, 'azure')}</div>`;
  }

  function azureBody(c, st, now) {
    if (c.state === 'not-installed') {
      return '<ul class="ap-facts"><li>Subscriptions, resources and Key Vault through Microsoft\'s Azure tools</li>'
        + '<li>The install takes about 900 MB in VaultOS\'s home folder.</li></ul>'
        + (c.install ? `<p class="ap-cmd"><span aria-hidden="true">$ </span>${esc(c.install)}</p>` : '')
        + `<div class="ap-btns">${st.canTerm !== false ? btn('install', 'Install', ' primary') : ''}</div>${errP(st, 'azure')}`;
    }
    if (c.state === 'connecting') return `<ul class="ap-facts"><li>Sign in with the code below.</li></ul>${codePanelHtml(st, now)}`;
    if (c.state === 'connected' || c.state === 'error' || c.state === 'needs-sign-in') {
      const t = c.lastTest;
      const tested = t ? (t.ok ? `Tested ${ago(t.at, now)}: Azure answered` : `Tested ${ago(t.at, now)}: it didn't answer`) : '';
      const subs = c.subscriptions || [];
      const sel = subs.find((s) => s.id === c.subscription || s.name === c.subscription);
      const subHtml = subs.length
        ? '<div class="su-field cx-sub-field"><label for="cx-sub">Subscription</label><select id="cx-sub" class="su-input">'
          + subs.map((s) => `<option value="${esc(s.id)}"${sel && sel.id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '</select></div>' : '';
      return `<ul class="ap-facts"><li>${esc(c.account ? `Signed in as ${c.account}.` : 'Signed in.')}</li>${tested ? `<li>${esc(tested)}</li>` : ''}</ul>`
        + (c.state === 'needs-sign-in' ? '<p class="su-err cx-err" role="alert">Your Azure sign-in has run out. Sign out and sign in again.</p>' : '')
        + (c.error && c.state !== 'needs-sign-in' ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + subHtml
        + '<div class="su-row cx-switchrow"><div class="su-row-t"><label for="cx-allow" class="su-label">Allow changes</label>'
        + '<span class="su-hint">Applies to agents you start after changing it.</span></div>'
        + `<input type="checkbox" id="cx-allow" class="su-switch" role="switch"${c.allowChanges ? ' checked' : ''}></div>`
        + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test again')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}${errP(st, 'azure')}`;
    }
    // not connected
    return '<ul class="ap-facts"><li>Subscriptions, resources and Key Vault through Microsoft\'s Azure tools</li><li>Sign in with a code you type on Microsoft\'s page.</li></ul>'
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + `<div class="ap-btns">${btn('azure-start', 'Sign in', ' primary')}</div>${errP(st, 'azure')}`;
  }

  function paneHtml(st, now = Date.now()) {
    st = { err: {}, email: '', token: '', options: {}, azure: null, ...st };
    const list = (st.view && st.view.connectors) || [];
    const planned = (st.view && st.view.planned) || [];
    const picked = list.find((c) => c.id === st.picked) || list[0];
    const s2 = { ...st, picked: picked && picked.id };
    const detail = !picked ? '' : (() => {
      const body = picked.id === 'atlassian' ? atlassianBody(picked, s2, now) : azureBody(picked, s2, now);
      return `<div class="ap-detail cx-detail" aria-live="polite">${mark(picked.id, ' big')}<div class="ap-dbody">`
        + `<h4 class="ap-dname">${esc(picked.label)} ${chipHtml(stateChip(picked.state))}</h4>${body}</div></div>`;
    })();
    const hint = picked && picked.id === 'atlassian' && picked.state !== 'connected' && picked.state !== 'error'
      ? 'Either way, VaultOS holds the sign-in and adds Atlassian to Cursor CLI and Claude Code.'
      : 'Installing another agent later? VaultOS adds your connectors to it straight away.';
    return '<h3 class="cx-title">Connectors</h3>'
      + '<p class="su-hint">Connect a service once. VaultOS adds it to every agent it can set up, so it works in every folder. Your agents never see your passwords or tokens.</p>'
      + (st.view && st.view.reset ? "<p class=\"cx-reset\" role=\"status\">Your connector sign-ins couldn't be read, so they were reset. Connect again.</p>" : '')
      + '<div class="ap-tiles"><h3 class="ap-h">Ready</h3>'
      + `<div class="ap-grid cx-ready" role="radiogroup" aria-label="Connectors">${list.map((c) => tileHtml(c, s2)).join('')}</div>`
      + `${planned.length ? `<h3 class="ap-h">Planned <span>· not built yet</span></h3><div class="ap-grid cx-planned">${planned.map(plannedHtml).join('')}</div>` : ''}</div>`
      + detail + `<p class="ap-foot cx-hint">${esc(hint)}</p>`;
  }

  // ---- the mounted pane ---------------------------------------------------------
  const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const ATLASSIAN_POLL_MS = 2000, AZURE_POLL_MS = 3000, GIVE_UP_MS = 10 * 60 * 1000;

  function mountConnectors(el, ui) {
    const st = { view: null, picked: null, err: {}, email: '', token: '', waiting: false, azure: null, options: {}, canTerm: true };
    let lastKey = '';
    let seq = 0;
    let busy = false;
    let atlTimer = null, azTimer = null, instTimer = null;
    let atlUntil = 0;
    const active = () => (ui.active ? ui.active() : true);

    function render(force) {
      const now = Date.now();
      st.canTerm = ui.canTerm ? !!ui.canTerm() : true;
      // The pane redraws only when something it shows changed: a poll answering the same view must not replace a
      // field that is being typed in. Typed text is kept in st and the focus is put back.
      const key = JSON.stringify([st.view, st.picked, st.err, st.waiting, st.azure && [st.azure.code, minutesLeft(st.azure.expiresAt, now)], st.options, st.canTerm, st.view && st.view.connectors.map((c) => c.lastTest && ago(c.lastTest.at, now))]);
      if (!force && key === lastKey) return;
      lastKey = key;
      const had = el.ownerDocument && el.ownerDocument.activeElement;
      const focusId = had && el.contains && el.contains(had) ? had.id || (had.dataset && had.dataset.act ? `[data-act="${had.dataset.act}"]` : '') || (had.dataset && had.dataset.id ? `.ap-tile[data-id="${had.dataset.id}"]` : '') : '';
      el.innerHTML = paneHtml(st, now);
      if (focusId) {
        const t = el.querySelector(focusId.startsWith('[') || focusId.startsWith('.') ? focusId : `#${focusId}`);
        if (t && t.focus) t.focus();
      }
    }

    function setView(v) {
      st.view = v;
      if (ui.onView) ui.onView(v);
      const list = v.connectors || [];
      if (!st.picked || !list.some((c) => c.id === st.picked)) st.picked = list[0] && list[0].id;
      const atl = list.find((c) => c.id === 'atlassian');
      const az = list.find((c) => c.id === 'azure');
      if (atl) {
        if (atl.state === 'connecting' && !st.dismissed) { st.waiting = true; if (!atlTimer) startAtlPoll(); }
        else if (atl.state !== 'connecting') { st.waiting = false; st.dismissed = false; }
        if (atl.state === 'connected') { delete st.options.atlassian; st.err.oauth = ''; st.err.token = ''; st.token = ''; stopAtlPoll(); }
        if (!st.waiting) stopAtlPoll();
      }
      if (az) {
        if (az.state === 'connecting' && !azTimer) startAzPoll();
        if (az.state !== 'connecting') { st.azure = null; stopAzPoll(); }
        if (az.state !== 'not-installed') stopInstPoll();
      }
    }

    async function call(method, url, body) {
      const r = await ui.api(method, url, body);
      if (r && r.error) throw new Error(r.error);
      return r || {};
    }

    async function refresh() {
      const mine = ++seq;
      let v;
      try { v = await call('GET', '/api/connectors'); } catch (e) {
        if (mine === seq) { st.err.actions = e.message; render(); }
        return;
      }
      if (mine !== seq) return;
      st.err.actions = '';
      setView(v);
      render();
    }

    // Atlassian: poll the list every 2 s until connected, Cancel, 10 minutes, or Settings closes.
    function startAtlPoll() {
      stopAtlPoll();
      atlUntil = Date.now() + GIVE_UP_MS;
      atlTimer = setInterval(() => {
        if (!active() || Date.now() > atlUntil) { stopAtlPoll(); if (Date.now() > atlUntil) { st.waiting = false; st.dismissed = true; render(); } return; }
        refresh();
      }, ATLASSIAN_POLL_MS);
    }
    function stopAtlPoll() { if (atlTimer) { clearInterval(atlTimer); atlTimer = null; } }
    // Azure: GET /api/connectors/azure/status every 3 s while the code is out.
    function startAzPoll() {
      stopAzPoll();
      const until = Date.now() + GIVE_UP_MS;
      azTimer = setInterval(async () => {
        if (!active() || Date.now() > until) { stopAzPoll(); return; }
        try {
          const s = await call('GET', '/api/connectors/azure/status');
          if (s.status === 'failed') { st.err.azure = s.error || 'The sign-in did not finish.'; st.azure = null; stopAzPoll(); await refresh(); return; }
          if (s.status === 'done' || s.status === 'idle') { st.azure = null; stopAzPoll(); await refresh(); return; }
          render();   // the minutes count down
        } catch (e) { /* the next tick tries again */ }
      }, AZURE_POLL_MS);
    }
    function stopAzPoll() { if (azTimer) { clearInterval(azTimer); azTimer = null; } }
    // After Install the terminal runs on its own: look for the tools every 3 s.
    function startInstPoll() {
      stopInstPoll();
      const until = Date.now() + GIVE_UP_MS;
      instTimer = setInterval(() => { if (!active() || Date.now() > until) stopInstPoll(); else refresh(); }, AZURE_POLL_MS);
    }
    function stopInstPoll() { if (instTimer) { clearInterval(instTimer); instTimer = null; } }
    function stop() { stopAtlPoll(); stopAzPoll(); stopInstPoll(); }

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('message', (e) => {
        if (e.origin === window.location.origin && e.data === 'vaultos-connectors') refresh();
      });
    }

    // A click that talks to the server: one at a time, an error lands under the button that caused it.
    async function run(region, f) {
      if (busy) return;
      busy = true;
      st.err[region] = '';
      try { await f(); } catch (e) { st.err[region] = (e && e.message) || 'Something went wrong.'; } finally { busy = false; }
      render();
    }

    async function startAtlassian(reuse) {
      // The tab opens inside the click, before the wait for the server, so the browser does not block it.
      const w = reuse ? ui.openTab(reuse) : ui.openTab('about:blank');
      if (reuse) {
        if (!w) throw new Error('Your browser blocked the new tab. Allow pop-ups for VaultOS, then try again.');
        return;
      }
      try {
        const r = await call('POST', '/api/connectors/atlassian/start');
        st.url = r.url;
        if (!w) throw new Error('Your browser blocked the new tab. Allow pop-ups for VaultOS, then try again.');
        w.location.href = r.url;
      } catch (e) {
        if (w && w.close) try { w.close(); } catch { /* gone */ }
        throw e;
      }
      st.waiting = true; st.dismissed = false;
      startAtlPoll();
    }

    async function onAct(act, b) {
      const id = st.picked;
      if (act === 'oauth') return run('oauth', () => startAtlassian());
      if (act === 'reopen') return run('oauth', () => (st.url ? startAtlassian(st.url) : startAtlassian()));
      if (act === 'cancel') { st.waiting = false; st.dismissed = true; stopAtlPoll(); st.err.oauth = ''; render(); return; }
      if (act === 'token') {
        return run('token', async () => {
          const email = st.email.trim(), token = st.token.trim();
          if (!email || !token) throw new Error('Enter the Atlassian email and the API token.');
          await call('POST', '/api/connectors/atlassian/token', { email, token });
          st.token = '';
          await refresh();
        });
      }
      if (act === 'switch') { st.options.atlassian = true; st.err.actions = ''; render(); return; }
      if (act === 'keep') { delete st.options.atlassian; render(); return; }
      if (act === 'test') return run('actions', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/test`); await refresh(); });
      if (act === 'disconnect') return run('actions', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/disconnect`); st.azure = null; await refresh(); });
      if (act === 'install') {
        const c = st.view.connectors.find((x) => x.id === 'azure');
        if (c && c.install) { ui.openTerm(c.install); startInstPoll(); }
        return;
      }
      if (act === 'azure-start') {
        return run('azure', async () => {
          const r = await call('POST', '/api/connectors/azure/start');
          st.azure = { url: r.url, code: r.code, expiresAt: r.expiresAt };
          startAzPoll();
          await refresh();
        });
      }
      if (act === 'azure-cancel') {
        return run('azure', async () => { await call('POST', '/api/connectors/azure/cancel'); st.azure = null; stopAzPoll(); await refresh(); });
      }
      if (act === 'copy') {
        const ok = st.azure && ui.copy ? await ui.copy(st.azure.code) : false;
        if (b) { const t = b.textContent; b.textContent = ok ? 'Copied' : "Couldn't copy"; setTimeout(() => { if (b.isConnected) b.textContent = t; }, 1500); }
      }
    }

    el.addEventListener('click', (e) => {
      const tile = e.target.closest('.cx-ready .ap-tile');
      if (tile) { st.picked = tile.dataset.id; render(); const t = el.querySelector(`.ap-tile[data-id="${tile.dataset.id}"]`); if (t) t.focus(); return; }
      const b = e.target.closest('[data-act]');
      if (b) onAct(b.dataset.act, b);
    });
    el.addEventListener('input', (e) => {
      if (e.target.id === 'cx-email') st.email = e.target.value;
      else if (e.target.id === 'cx-token') st.token = e.target.value;
    });
    el.addEventListener('change', (e) => {
      if (e.target.id === 'cx-allow') {
        const on = e.target.checked;
        run('actions', async () => { await call('POST', '/api/connectors/azure/settings', { allowChanges: on }); await refresh(); });
      } else if (e.target.id === 'cx-sub') {
        run('actions', async () => { await call('POST', '/api/connectors/azure/settings', { subscription: e.target.value }); await refresh(); });
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target.id === 'cx-email' || e.target.id === 'cx-token')) { e.preventDefault(); onAct('token'); return; }
      const tile = e.target.closest && e.target.closest('.cx-ready .ap-tile');
      if (!tile || !st.view) return;
      const ids = st.view.connectors.map((c) => c.id);
      let next = null;
      if (e.key === 'Home') next = ids[0];
      else if (e.key === 'End') next = ids[ids.length - 1];
      else if (STEP[e.key]) next = ids[(ids.indexOf(st.picked) + STEP[e.key] + ids.length) % ids.length];
      if (!next) return;
      e.preventDefault();
      st.picked = next;
      render();
      const t = el.querySelector(`.ap-tile[data-id="${next}"]`);
      if (t) t.focus();
    });

    return { refresh, stop };
  }

  return { esc, stateChip, agentChip, minutesLeft, hostPath, paneHtml, mountConnectors };
});
