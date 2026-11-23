'use strict';

// ========================================================================
// Connectors — Settings → Connectors (window.Connectors; also a Node module for the tests).
// The sibling of the agent picker (agent-form.js): tiles for the services VaultOS can connect, a detail
// panel for the picked one, the same chips, marks and buttons. The page passes a `ui`:
//   ui.api(method, url, body?)  → Promise<object>; rejects (or answers { error }) with a message for the person
//   ui.openTerm(cmd)            run a command in a terminal (Azure's install)
//   ui.openTab(url)             → Window | null; a new tab of this browser (Atlassian's approve page, which
//                               sends the person back and tells this page over a BroadcastChannel)
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
    'not-signed-in': { text: 'Not signed in', tone: 'warn' },
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

  // The switch only governs Azure's own tools for agents; `az` itself is signed in for every agent that has a shell.
  const ALLOW_NOTE = "Azure's tools for agents are read-only unless you allow changes. Agents that can run shell commands can still use az with this sign-in. Applies to agents you start after changing it.";

  // The sign-in page VaultOS opens: https, or http only on this machine (the preview's stand-in server).
  const signInUrl = (u) => {
    try {
      const x = new URL(u);
      if (x.protocol === 'https:') return x.href;
      return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost') ? x.href : null;
    } catch { return null; }
  };

  const chipHtml = (c, extra = '') => `<span class="ap-chip${c.tone === 'ok' ? ' ok' : c.tone === 'warn' ? ' warn' : ''}${extra}">${esc(c.text)}</span>`;
  const mark = (id, cls = '') => `<span class="ap-mark${cls}">${Marks ? Marks.connector(id) : ''}</span>`;
  const agentMark = (id) => `<span class="ap-mark small">${Marks ? Marks.svg(id) : ''}</span>`;

  // What a new Atlassian view does to the pane's own state. st: { waiting, dismissed, waitFrom } (waitFrom: the method signed in
  // when this pane started a sign-in over a connected one, else null); prev: { state, method } of the view before, if any.
  // The form and the pasted token are cleared only on the way INTO a connected state (or a changed method), never on every
  // connected view: a focus refresh must not wipe a token being pasted. While this pane's sign-in runs the wait goes on until
  // the connection is a different method than before (a switch) or connected at all (a first sign-in).
  function signInStep(st, prev, atl) {
    const connected = atl.state === 'connected';
    const into = connected && !(prev && prev.state === 'connected' && prev.method === atl.method);
    let waiting = !!st.waiting, dismissed = !!st.dismissed;
    if (waiting) {
      // Only `connecting` keeps a wait going, except over a connected sign-in being switched: there the old method still
      // reads `connected` until the new one lands. A change of method ends it; so does any other state (failed, expired).
      const same = connected && st.waitFrom != null && atl.method === st.waitFrom;
      if (!(atl.state === 'connecting' || same)) waiting = false;
    } else if (atl.state === 'connecting' && !dismissed) waiting = true;
    if (atl.state !== 'connecting' && !waiting) dismissed = false;
    return { waiting, dismissed, clear: into, poll: waiting };
  }

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

  const atlassianStep = signInStep; // its first name, for older callers

  // The panel shown while this pane waits for a browser sign-in to finish.
  const waitPanelHtml = (text, st) => '<div class="cx-wait" aria-live="polite"><div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span>'
    + `<span>${esc(text)}</span></div>`
    + `<div class="ap-btns">${btn('reopen', 'Open the tab again')}${btn('cancel', 'Cancel')}</div>${errP(st, 'oauth')}</div>`;
  // Which connector a waiting pane waits for: one browser sign-in at a time, Atlassian when the state predates the field.
  const waitsFor = (st, id) => !!st.waiting && (st.waitingFor || 'atlassian') === id;

  function atlassianBody(c, st, now) {
    const connectedLike = c.state === 'connected' || c.state === 'error';
    if (waitsFor(st, 'atlassian')) {
      return '<ul class="ap-facts"><li>Jira and Confluence, through Atlassian\'s own hosted server</li></ul>'
        + waitPanelHtml('Waiting for you to approve in the Atlassian tab…', st);
    }
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
    const lead = c.state === 'needs-sign-in'
      ? '<p class="su-err cx-err" role="alert">Your Atlassian sign-in has run out. Sign in again.</p>' : '';
    const note = c.state !== 'needs-sign-in' && c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '';
    return '<ul class="ap-facts"><li>Jira and Confluence, through Atlassian\'s own hosted server</li><li>Pick one way to connect. You can switch later.</li></ul>'
      + lead + note + optionCardsHtml(c, st)
      + (st.options.atlassian && connectedLike ? `<div class="ap-btns">${btn('keep', 'Keep my current sign-in')}</div>` : '')
      + (c.state === 'needs-sign-in' ? `<div class="ap-btns">${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}` : '');
  }

  function codePanelHtml(st, now, o = { code: st.azure, start: 'azure-start', cancel: 'azure-cancel', err: 'azure' }) {
    const a = o.code;
    const open = a && httpsUrl(a.url);
    const mins = a ? minutesLeft(a.expiresAt, now) : 0;
    if (!a) {
      return '<div class="cx-wait" aria-live="polite"><div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>Waiting for Microsoft…</span></div>'
        + `<div class="ap-btns">${btn(o.start, 'Sign in')}${btn(o.cancel, 'Cancel')}</div>${errP(st, o.err)}</div>`;
    }
    return '<div class="cx-code" aria-live="polite">'
      + `<div class="cx-codebox" id="cx-code">${esc(a.code)}</div>`
      + `<div class="ap-btns">${btn('copy', 'Copy code')}${open ? `<a class="su-btn primary" href="${esc(open.href)}" target="_blank" rel="noopener noreferrer">Open ${esc(hostPath(a.url))}</a>` : ''}</div>`
      + `<div class="cx-row"><span class="cx-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>Waiting for Microsoft… the code works for ${mins} more minute${mins === 1 ? '' : 's'}</span></div>`
      + `<div class="ap-btns">${btn(o.cancel, 'Cancel')}</div>${errP(st, o.err)}</div>`;
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
        + `<span class="su-hint">${esc(ALLOW_NOTE)}</span></div>`
        + `<input type="checkbox" id="cx-allow" class="su-switch" role="switch"${c.allowChanges ? ' checked' : ''}></div>`
        + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test again')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}${errP(st, 'azure')}`;
    }
    // not connected
    return '<ul class="ap-facts"><li>Subscriptions, resources and Key Vault through Microsoft\'s Azure tools</li><li>Sign in with a code you type on Microsoft\'s page.</li></ul>'
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + `<div class="ap-btns">${btn('azure-start', 'Sign in', ' primary')}</div>${errP(st, 'azure')}`;
  }

  // Connectors that sign in with one pasted key (GitHub, Context7): the copy, and the pane state each one uses.
  const KEYED = {
    github: {
      id: 'github', name: 'GitHub', field: 'ghToken', input: 'cx-gh-token', err: 'ghtoken', act: 'gh', what: 'token',
      intro: 'Repos, issues and pull requests, through GitHub\'s own hosted server',
      title: 'Paste a GitHub token', fieldLabel: 'Personal access token', placeholder: 'Paste the token', create: 'Create a token',
      blurb: 'Create a token on GitHub and paste it here. VaultOS checks it with GitHub before saving it. Agents can do what the token allows, so a fine-grained token limited to the repos you choose keeps it tight.',
      dead: 'GitHub no longer accepts your token. Paste a new one.', signedIn: 'Signed in with a token',
      save: 'Save token', replace: 'Replace token', keep: 'Keep my current token',
      note: 'Signing out here doesn\'t delete the token on GitHub.',
    },
    context7: {
      id: 'context7', name: 'Context7', field: 'c7Key', input: 'cx-c7-key', err: 'c7key', act: 'c7', what: 'API key',
      intro: 'Current documentation and code examples for the libraries your code uses',
      title: 'Paste a Context7 API key', fieldLabel: 'API key', placeholder: 'ctx7sk-…', create: 'Get a key',
      blurb: 'Copy a key from your Context7 dashboard and paste it here. VaultOS checks it with Context7 before saving it. The key only lets agents look up documentation.',
      dead: 'Context7 no longer accepts your key. Paste a new one.', signedIn: 'Connected with an API key',
      save: 'Save key', replace: 'Replace key', keep: 'Keep my current key',
      note: 'Signing out here doesn\'t delete the key on Context7.',
    },
  };

  KEYED.vantage = {
    id: 'vantage', name: 'Vantage', field: 'vtKey', input: 'cx-vt-key', err: 'vtkey', act: 'vt', what: 'API token',
    intro: 'Cloud costs, reports and budgets from your Vantage account',
    title: 'Paste a Vantage API token', fieldLabel: 'API token', placeholder: 'Paste the token', create: 'Get a token',
    blurb: "VaultOS checks it with Vantage before saving it. A token with only the Read scope keeps agents read-only on Vantage's side too.",
    dead: 'Vantage no longer accepts your token. Paste a new one.', signedIn: 'Signed in with an API token',
    save: 'Save token', replace: 'Replace token', keep: 'Keep my current sign-in',
    note: "Signing out here doesn't delete the token in Vantage.",
  };

  const keyedInput = (elId) => Object.values(KEYED).find((k) => k.input === elId) || null;

  // Vantage: Sign in like Atlassian, or a pasted API token; read-only for agents unless "Allow changes" is on.
  const VT_FACTS = 'Cloud costs, cost reports, budgets and anomalies from your Vantage account. Read-only unless you allow changes.';
  const VT_ALLOW_NOTE = "Agents can only read Vantage unless you allow changes. With changes on they can create, change and delete reports, budgets and folders, and some deletes can't be undone. Applies to agents' next requests.";

  function vantageBody(c, st, now) {
    const facts = (extra = '') => `<ul class="ap-facts"><li>${esc(VT_FACTS)}</li>${extra}</ul>`;
    if (waitsFor(st, 'vantage')) return facts() + waitPanelHtml('Finish signing in to Vantage in the tab that opened.', st);
    const connectedLike = c.state === 'connected' || c.state === 'error';
    if (connectedLike && !st.options.vantage) {
      const via = c.account ? `Signed in as ${c.account}` : (c.method === 'token' ? 'Signed in with an API token' : 'Signed in through Vantage');
      const tested = testedLine(c, now, c.label);
      const note = c.method === 'token' ? "Signing out here doesn't delete the token in Vantage." : "Signing out here revokes VaultOS's sign-in at Vantage.";
      return facts(`<li>${esc(via)}</li>${tested ? `<li>${esc(tested)}</li>` : ''}`)
        + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + '<div class="su-row cx-switchrow"><div class="su-row-t"><label for="cx-vt-allow" class="su-label">Allow changes</label>'
        + `<span class="su-hint">${esc(VT_ALLOW_NOTE)}</span></div>`
        + `<input type="checkbox" id="cx-vt-allow" class="su-switch"${c.allowChanges ? ' checked' : ''} role="switch"></div>`
        + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test again')}${c.method === 'token' ? btn('oauth', 'Sign in instead') : btn('vt-switch', 'Use an API token instead')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}`
        + `<p class="cx-muted">${esc(note)}</p>`;
    }
    const replacing = !!st.options.vantage && connectedLike;
    const lead = c.state === 'needs-sign-in' ? `<p class="su-err cx-err" role="alert">${esc('Your Vantage sign-in has run out. Sign in again.')}</p>` : '';
    const note = c.state !== 'needs-sign-in' && c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '';
    return facts() + lead + note
      + `<div class="ap-btns">${btn('oauth', 'Sign in', ' primary')}${st.options.vtToken ? '' : btn('vt-switch', 'Use an API token instead')}</div>${errP(st, 'oauth')}`
      + (st.options.vtToken ? keyCard(c, st, replacing) : (replacing ? `<div class="ap-btns">${btn('vt-keep', 'Keep my current sign-in')}</div>` : ''))
      + (c.state === 'needs-sign-in' ? agentRowsHtml(c) + `<div class="ap-btns">${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}` : '');
  }

  // One card for a key. `replacing` shows it over a connected panel.
  function keyCard(c, st, replacing) {
    const k = KEYED[c.id];
    const help = httpsUrl(c.tokenHelp);
    return `<div class="cx-opts"><div class="cx-opt main"><h5>${esc(k.title)}</h5><p>${esc(k.blurb)}</p>`
      + `<div class="su-field"><label for="${k.input}">${esc(k.fieldLabel)}</label>`
      + `<input id="${k.input}" class="su-input" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(k.placeholder)}" value="${esc(st[k.field])}"></div>`
      + `<div class="ap-btns">${btn(`${k.act}-token`, k.save, ' primary')}${help ? `<a class="cx-link" href="${esc(help.href)}" target="_blank" rel="noopener noreferrer">${esc(k.create)}</a>` : ''}`
      + `${replacing ? btn(`${k.act}-keep`, k.keep) : ''}</div>${errP(st, k.err)}</div></div>`;
  }

  function testedLine(c, now, who) {
    const t = c.lastTest;
    if (!t) return '';
    if (!t.ok) return `Tested ${ago(t.at, now)}: it didn't answer`;
    return typeof t.tools === 'number' ? `Tested ${ago(t.at, now)}: ${who} answered with ${t.tools} tools` : `Tested ${ago(t.at, now)}: ${who} answered`;
  }

  function keyedBody(c, st, now) {
    const k = KEYED[c.id];
    const connectedLike = c.state === 'connected' || c.state === 'error';
    const intro = `<li>${esc(k.intro)}</li>`;
    const note = `<p class="cx-muted">${k.note}</p>`; // fixed copy, no markup
    if (!connectedLike) {
      const lead = c.state === 'needs-sign-in' ? `<p class="su-err cx-err" role="alert">${esc(k.dead)}</p>` : '';
      const signedOut = c.state === 'needs-sign-in'
        ? agentRowsHtml(c) + `<div class="ap-btns">${btn('test', 'Test again')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}` + note : '';
      return `<ul class="ap-facts">${intro}</ul>${lead}${c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : ''}${keyCard(c, st, false)}${signedOut}`;
    }
    if (st.options[c.id]) return `<ul class="ap-facts">${intro}</ul>${keyCard(c, st, true)}`;
    const tested = testedLine(c, now, c.label);
    return `<ul class="ap-facts">${intro}<li>${esc(c.account ? `Signed in as ${c.account}` : k.signedIn)}</li>${tested ? `<li>${esc(tested)}</li>` : ''}</ul>`
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + agentRowsHtml(c)
      + `<div class="ap-btns">${btn('test', 'Test again')}${btn(`${k.act}-replace`, k.replace)}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}`
      + note;
  }

  function mslearnBody(c, st, now) {
    const on = c.state === 'connected' || c.state === 'error';
    if (!on) {
      return '<ul class="ap-facts"><li>Microsoft\'s documentation and code samples. No sign-in.</li></ul>'
        + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + `<div class="ap-btns">${btn('ms-on', 'Turn on', ' primary')}</div>${errP(st, 'actions')}`;
    }
    const t = c.lastTest;
    const line = t && t.ok ? `Connected · ${t.tools} tools` : 'Connected';
    const stale = t && !t.ok ? `Tested ${ago(t.at, now)}: it didn't answer` : '';
    return `<ul class="ap-facts"><li>${esc(line)}</li>${stale ? `<li>${esc(stale)}</li>` : ''}</ul>`
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + agentRowsHtml(c)
      + `<div class="ap-btns">${btn('test', 'Test again')}${btn('ms-off', 'Turn off')}</div>${errP(st, 'actions')}`;
  }

  function entraBody(c, st, now) {
    const on = c.state === 'connected' || c.state === 'error';
    const intro = '<li>Read-only access to your Microsoft Entra directory: users, groups, apps and sign-in logs. It uses your Azure sign-in, so there is nothing else to sign in to.</li>';
    if (!on) {
      const gate = c.needsAzure
        ? '<li>Connect Azure first. Entra uses the same sign-in.</li>'
        : '';
      return `<ul class="ap-facts">${intro}${gate}</ul>`
        + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + (c.needsAzure ? '' : `<div class="ap-btns">${btn('en-on', 'Turn on', ' primary')}</div>`) + errP(st, 'actions');
    }
    const t = c.lastTest;
    const line = t && t.ok ? `Connected${c.account ? ` to ${c.account}` : ''} · ${t.tools} tools` : 'Connected';
    const stale = t && !t.ok ? `Tested ${ago(t.at, now)}: it didn't answer` : '';
    return `<ul class="ap-facts"><li>${esc(line)}</li>${stale ? `<li>${esc(stale)}</li>` : ''}<li>Read-only: agents can look things up but not change them.</li></ul>`
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + agentRowsHtml(c)
      + `<div class="ap-btns">${btn('test', 'Test again')}${btn('en-off', 'Turn off')}</div>${errP(st, 'actions')}`;
  }

  // Azure DevOps: Microsoft's server, started for each agent, signed in with the Azure connector's az login.
  const ADO_ALLOW_NOTE = 'Off, agents can read work items, repos, pipelines and the wiki but not change them. On, they can also create and edit work items, push files, open and update pull requests and run pipelines. Agents that can run shell commands can still use az with this sign-in. Applies to agents you start after changing it.';

  function adoOrgCard(c, st, replacing) {
    const val = st.adoOrg != null ? st.adoOrg : (c.org || '');
    return '<div class="cx-opts"><div class="cx-opt main"><h5>Your organization</h5>'
      + '<p>The name after dev.azure.com/ in your organization\'s address. You can paste the whole address. VaultOS starts Azure DevOps once to check it before saving.</p>'
      + '<div class="su-field"><label for="cx-ado-org">Organization</label>'
      + `<input id="cx-ado-org" class="su-input" type="text" autocomplete="off" spellcheck="false" placeholder="your-organization" value="${esc(val)}"></div>`
      + `<div class="ap-btns">${btn('ado-on', replacing ? 'Save' : 'Turn on', ' primary')}${replacing ? btn('ado-keep', 'Keep ' + (c.org || 'the current one')) : ''}</div>${errP(st, 'ado')}</div></div>`;
  }

  function adoBody(c, st, now) {
    const intro = "<li>Work items, repos, pull requests, pipelines and the wiki, through Microsoft's Azure DevOps tools. It uses your Azure sign-in, so there is nothing else to sign in to.</li>";
    if (c.state === 'not-installed') {
      return `<ul class="ap-facts">${intro}<li>The install takes about 150 MB in VaultOS's home folder.</li></ul>`
        + (c.install ? `<p class="ap-cmd"><span aria-hidden="true">$ </span>${esc(c.install)}</p>` : '')
        + `<div class="ap-btns">${st.canTerm !== false ? btn('install', 'Install', ' primary') : ''}</div>${errP(st, 'ado')}`;
    }
    const on = c.state === 'connected' || c.state === 'error';
    if (!on) {
      if (c.needsAzure) {
        return `<ul class="ap-facts">${intro}<li>Connect Azure first. Azure DevOps uses the same sign-in.</li></ul>`
          + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '');
      }
      return `<ul class="ap-facts">${intro}</ul>`
        + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
        + adoOrgCard(c, st, false);
    }
    if (st.options.azuredevops) return `<ul class="ap-facts">${intro}</ul>${adoOrgCard(c, st, true)}`;
    const t = c.lastTest;
    const found = t && t.ok ? `: ${t.tools} tools${typeof t.projects === 'number' ? `, ${t.projects} project${t.projects === 1 ? '' : 's'}` : ''}` : '';
    const tested = t ? (t.ok ? `Tested ${ago(t.at, now)}${found}` : `Tested ${ago(t.at, now)}: it didn't answer`) : '';
    return `<ul class="ap-facts"><li>${esc(`Organization: ${c.org || ''}`)}</li>${tested ? `<li>${esc(tested)}</li>` : ''}`
      + `<li>${c.allowChanges ? 'Agents can make changes.' : 'Read-only: agents can look things up but not change them.'}</li></ul>`
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + '<div class="su-row cx-switchrow"><div class="su-row-t"><label for="cx-ado-allow" class="su-label">Allow changes</label>'
      + `<span class="su-hint">${esc(ADO_ALLOW_NOTE)}</span></div>`
      + `<input type="checkbox" id="cx-ado-allow" class="su-switch" role="switch"${c.allowChanges ? ' checked' : ''}></div>`
      + agentRowsHtml(c)
      + `<div class="ap-btns">${btn('test', 'Test again')}${btn('ado-change', 'Change organization')}${btn('ado-off', 'Turn off')}</div>${errP(st, 'actions')}`;
  }

  // LogicMonitor: the person's portal plus a bearer token, or an LMv1 access ID and key. Read-only, core monitoring only.
  const LM_BLURB = 'VaultOS checks it with LogicMonitor before saving it. Agents can only read: alerts, devices and their metrics, and scheduled downtime. A token on an API-only user with a read-only role keeps it tight.';
  const LM_INPUTS = { 'cx-lm-portal': 'lmPortal', 'cx-lm-token': 'lmToken', 'cx-lm-id': 'lmId', 'cx-lm-key': 'lmKey' };

  function lmCard(c, st, replacing) {
    const keys = !!st.options.lmKeys;
    const help = httpsUrl(c.tokenHelp);
    const field = (id, label, type, placeholder, value) => `<div class="su-field"><label for="${id}">${esc(label)}</label>`
      + `<input id="${id}" class="su-input" type="${type}" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}"></div>`;
    const creds = keys
      ? field('cx-lm-id', 'Access ID', 'text', 'Access ID', st.lmId) + field('cx-lm-key', 'Access key', 'password', 'Access key', st.lmKey)
      : field('cx-lm-token', 'Bearer token', 'password', 'Paste the token', st.lmToken);
    return `<div class="cx-opts"><div class="cx-opt main"><h5>Connect your LogicMonitor portal</h5><p>${esc(LM_BLURB)}</p>`
      + field('cx-lm-portal', 'Portal', 'text', 'acme or acme.logicmonitor.com', st.lmPortal || c.portal || '') + creds
      + `<div class="ap-btns">${btn('lm-save', replacing ? 'Save token' : 'Save', ' primary')}`
      + (help ? `<a class="cx-link" href="${esc(help.href)}" target="_blank" rel="noopener noreferrer">Get a token</a>` : '')
      + btn(keys ? 'lm-bearer' : 'lm-keys', keys ? 'Use a bearer token instead' : 'Use an access ID and key instead')
      + `${replacing ? btn('lm-keep', 'Keep my current token') : ''}</div>${errP(st, 'lm')}</div></div>`;
  }

  function lmBody(c, st, now) {
    const intro = '<li>Alerts, devices and their metrics, and scheduled downtime from your LogicMonitor portal, read-only</li>';
    const note = `<p class="cx-muted">${esc("Signing out here doesn't delete the token in LogicMonitor.")}</p>`;
    const connectedLike = c.state === 'connected' || c.state === 'error';
    if (!connectedLike) {
      const lead = c.state === 'needs-sign-in' ? `<p class="su-err cx-err" role="alert">${esc('LogicMonitor no longer accepts this token. Paste a new one.')}</p>` : '';
      const signedOut = c.state === 'needs-sign-in'
        ? agentRowsHtml(c) + `<div class="ap-btns">${btn('test', 'Test again')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}` + note : '';
      return `<ul class="ap-facts">${intro}</ul>${lead}${c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : ''}${lmCard(c, st, false)}${signedOut}`;
    }
    if (st.options.logicmonitor) return `<ul class="ap-facts">${intro}</ul>${lmCard(c, st, true)}`;
    const tested = testedLine(c, now, c.label);
    return `<ul class="ap-facts">${intro}<li>${esc(`Connected to ${c.account || ''}`)}</li>`
      + `<li>${c.lmv1 ? 'Signed in with an access ID and key' : 'Signed in with a bearer token'}</li>${tested ? `<li>${esc(tested)}</li>` : ''}</ul>`
      + (c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '')
      + agentRowsHtml(c)
      + `<div class="ap-btns">${btn('test', 'Test again')}${btn('lm-replace', 'Replace token')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}`
      + note;
  }

  // Teams transcripts and Teams chats: the person's own app registration, signed in with a device code. One card,
  // per-connector words; `pre` names its fields, actions and error region (tr-tenant, tc-start, st.err.tc, ...).
  const codes = (xs) => xs.map((x) => `<code>${x}</code>`).join(', ');
  const MSAPP = {
    transcripts: {
      pre: 'tr',
      intro: 'Teams meeting transcripts, through an app registration you own',
      need: [
        'Allow public client flows (device code sign-in needs this). No client secret.',
        `Delegated permissions: ${codes(['OnlineMeetingTranscript.Read.All', 'OnlineMeetings.Read', 'Calendars.Read', 'User.Read'])}`,
        'Granted with admin consent.',
      ],
    },
    teamschats: {
      pre: 'tc',
      intro: 'Your Teams chats, read-only, through an app registration you own',
      // static copy, no server text: it may hold markup
      need: [
        'Registered in your own tenant (Entra admin center → App registrations). Single tenant is simplest; any account type works.',
        `Authentication: the Mobile and desktop applications platform with redirect URIs ${codes(['http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient'])}, and Allow public client flows turned on. No client secret.`,
        `Microsoft Graph delegated permissions: ${codes(['User.Read', 'Chat.Read', 'offline_access'])}, and nothing more.`,
        "Chat.Read doesn't need admin consent, but your organisation may block user consent. If Microsoft's page asks for admin approval, ask an admin to grant consent for Chat.Read on your app.",
      ],
      can: "Agents can list your chats and read their messages. They can't send, edit or delete anything, and channel posts aren't included.",
    },
    outlookmail: {
      pre: 'om',
      intro: 'Your Outlook mail, read-only, through an app registration you own',
      need: [
        'Registered in your own tenant (Entra admin center → App registrations). Single tenant is simplest; any account type works.',
        `Authentication: the Mobile and desktop applications platform with redirect URIs ${codes(['http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient'])}, and Allow public client flows turned on. No client secret.`,
        `Microsoft Graph delegated permissions: ${codes(['User.Read', 'Mail.Read', 'offline_access'])}, and nothing more.`,
        "Mail.Read doesn't need admin consent, but your organisation may block user consent. If Microsoft's page asks for admin approval, ask an admin to grant consent for Mail.Read on your app.",
      ],
      can: "Agents can list, search and read your mail. They can't send, reply, move or delete anything, and attachments aren't opened.",
    },
    outlookcalendar: {
      pre: 'oc',
      intro: 'Your Outlook calendar, read-only, through an app registration you own',
      need: [
        'Registered in your own tenant (Entra admin center → App registrations). Single tenant is simplest; any account type works.',
        `Authentication: the Mobile and desktop applications platform with redirect URIs ${codes(['http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient'])}, and Allow public client flows turned on. No client secret.`,
        `Microsoft Graph delegated permissions: ${codes(['User.Read', 'Calendars.Read', 'offline_access'])}, and nothing more.`,
        "Calendars.Read doesn't need admin consent, but your organisation may block user consent. If Microsoft's page asks for admin approval, ask an admin to grant consent for Calendars.Read on your app.",
      ],
      can: "Agents can list your events and read one in full. They can't create, accept, decline or change anything.",
    },
  };
  const MSAPP_ACTS = {}; // 'tc-start' -> { id, step: 'start' }
  for (const [id, m] of Object.entries(MSAPP)) for (const step of ['start', 'cancel']) MSAPP_ACTS[`${m.pre}-${step}`] = { id, step };
  // 'tc-tenant' -> 'tcTenant': where a typed ID is kept in the pane's state until a sign-in succeeds
  const msappField = (elId) => {
    const hit = /^([a-z]+)-(tenant|client)$/.exec(String(elId || ''));
    return hit && Object.values(MSAPP).some((m) => m.pre === hit[1]) ? hit[1] + (hit[2] === 'tenant' ? 'Tenant' : 'Client') : null;
  };

  function msappBody(c, st, now) {
    const m = MSAPP[c.id];
    const intro = `<li>${m.intro}</li>`;
    const tested = testedLine(c, now, c.label);
    const err = c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '';
    // a failed sign-in's reason comes back on the row and from the status poll: show it once
    const ownErr = st.err && st.err[m.pre] && st.err[m.pre] !== c.error ? errP(st, m.pre) : '';
    const can = (m.can ? `<li>${m.can}</li>` : '') // static copy
      + (c.cursorAltLabel ? `<li>${esc(c.cursorAltOn ? `The Cursor CLI uses ${c.cursorAltLabel} instead.` : `The Cursor CLI gets it too, until you turn on ${c.cursorAltLabel}.`)}</li>` : '');
    if (c.state === 'connecting') {
      return `<ul class="ap-facts">${intro}<li>Sign in with the code below.</li></ul>`
        + codePanelHtml(st, now, { code: st[c.id], start: `${m.pre}-start`, cancel: `${m.pre}-cancel`, err: m.pre });
    }
    if (c.state === 'connected' || c.state === 'error') {
      return `<ul class="ap-facts">${intro}<li>${esc(c.account ? `Signed in as ${c.account}` : 'Signed in')}</li>${can}${tested ? `<li>${esc(tested)}</li>` : ''}</ul>`
        + err + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test')}${btn('disconnect', 'Sign out', ' danger')}</div>${errP(st, 'actions')}${ownErr}`;
    }
    const again = c.state === 'needs-sign-in';
    const typed = (k) => st[m.pre + k];
    // one app registration can carry every permission: offer the IDs another app sign-in already uses
    const other = !c.tenantId && ((st.view && st.view.connectors) || []).find((x) => Object.hasOwn(MSAPP, x.id) && x.id !== c.id && x.tenantId && x.clientId);
    const tenant = typed('Tenant') != null ? typed('Tenant') : (c.tenantId || (other ? other.tenantId : ''));
    const client = typed('Client') != null ? typed('Client') : (c.clientId || (other ? other.clientId : ''));
    return `<ul class="ap-facts">${intro}<li>Sign in with a code you type on Microsoft's page.</li>${can}</ul>`
      + (again ? '<p class="su-err cx-err" role="alert">Your Microsoft sign-in has run out. Sign in again.</p>' : '')
      + err
      + `<div class="su-field"><label for="${m.pre}-tenant">Directory (tenant) ID</label>`
      + `<input id="${m.pre}-tenant" class="su-input" type="text" autocomplete="off" spellcheck="false" value="${esc(tenant)}"></div>`
      + `<div class="su-field"><label for="${m.pre}-client">Application (client) ID</label>`
      + `<input id="${m.pre}-client" class="su-input" type="text" autocomplete="off" spellcheck="false" value="${esc(client)}"></div>`
      + '<details class="cx-need"><summary>What the app registration needs</summary><ul class="ap-facts">'
      + m.need.map((x) => `<li>${x}</li>`).join('')
      + '</ul></details>'
      + (again ? agentRowsHtml(c) : '')
      + `<div class="ap-btns">${btn(`${m.pre}-start`, again ? 'Sign in again' : 'Sign in', ' primary')}${again ? btn('disconnect', 'Sign out', ' danger') : ''}</div>${ownErr}${errP(st, 'actions')}`;
  }

  // Cursor's own Microsoft 365 servers: the entry goes to the Cursor CLI only, and the CLI signs in with Cursor's own
  // Microsoft app. Its sign-in waits on localhost inside VaultOS, so the person pastes back the address their browser
  // ended on. Not read-only: the card says what agents can change.
  function cursorBody(c, st, now) {
    const on = c.state !== 'not-connected';
    const facts = [
      `<li>${esc(`Cursor's own connector, for the Cursor CLI only${c.insteadOf ? `. While it's on, Cursor uses it instead of ${c.insteadOf}` : ''}.`)}</li>`,
      "<li>Cursor signs in with its own Microsoft app, so you don't register one. Your organisation has to allow that app.</li>",
      `<li class="cx-warn">${esc(`Not read-only: agents in Cursor can ${c.sends || 'change things'} as you.`)}</li>`,
    ];
    const asks = `<details class="cx-need"><summary>What Cursor asks Microsoft for</summary><ul class="ap-facts"><li>${codes((c.scopes || []).map(esc))}</li></ul></details>`;
    const err = c.error ? `<p class="su-err cx-err" role="alert">${esc(c.error)}</p>` : '';
    if (c.needsCursor) {
      return `<ul class="ap-facts">${facts.join('')}<li>Install the Cursor CLI first, in Settings → Agent.</li></ul>${asks}`;
    }
    if (c.state === 'connecting' && c.login) {
      const open = httpsUrl(c.login.url);
      const port = esc(c.login.port || '');
      return `<ul class="ap-facts">${facts[0]}</ul>`
        + '<ol class="cx-steps">'
        + `<li>${open ? `<a class="su-btn primary" href="${esc(open.href)}" target="_blank" rel="noopener noreferrer">Open Microsoft sign-in</a>` : 'Open the sign-in link from Cursor.'}</li>`
        + `<li>Sign in. Your browser then lands on a page that doesn't load, at <code>localhost:${port}</code>. That's expected.</li>`
        + '<li><label for="cu-paste">Copy that page\'s whole address and paste it here</label>'
        + `<input id="cu-paste" class="su-input" type="text" autocomplete="off" spellcheck="false" placeholder="http://localhost:${port}/callback?code=…" value="${esc((st.cuPaste && st.cuPaste[c.id]) || '')}"></li>`
        + '</ol>'
        + `<div class="ap-btns">${btn('cu-finish', 'Finish sign-in', ' primary')}${btn('cu-cancel', 'Cancel')}</div>${errP(st, 'cu')}${err}`;
    }
    if (c.state === 'connected' || c.state === 'error') {
      const tested = testedLine(c, now, c.label);
      return `<ul class="ap-facts">${facts.join('')}<li>Signed in through Cursor</li>${tested ? `<li>${esc(tested)}</li>` : ''}</ul>${asks}`
        + err + agentRowsHtml(c)
        + `<div class="ap-btns">${btn('test', 'Test')}${btn('cu-start', 'Sign in again')}${btn('disconnect', 'Turn off', ' danger')}</div>${errP(st, 'actions')}${errP(st, 'cu')}`
        + `<p class="cx-muted">${esc("Turning it off takes it out of Cursor's config. Cursor keeps its own sign-in.")}</p>`;
    }
    return `<ul class="ap-facts">${facts.join('')}${on ? '<li>Added to Cursor, not signed in yet.</li>' : ''}</ul>${asks}${err}`
      + (on ? agentRowsHtml(c) : '')
      + `<div class="ap-btns">${btn('cu-start', on ? 'Sign in' : 'Turn on and sign in', ' primary')}${on ? btn('disconnect', 'Turn off', ' danger') : ''}</div>${errP(st, 'cu')}${errP(st, 'actions')}`;
  }

  const BODIES = { atlassian: atlassianBody, azure: azureBody, entra: entraBody, azuredevops: adoBody, logicmonitor: lmBody, vantage: vantageBody, github: keyedBody, mslearn: mslearnBody, context7: keyedBody, transcripts: msappBody, teamschats: msappBody, outlookmail: msappBody, outlookcalendar: msappBody,
    'cursor-teams': cursorBody, 'cursor-outlook': cursorBody, 'cursor-outlook-calendar': cursorBody };

  function paneHtml(st, now = Date.now()) {
    st = { err: {}, email: '', token: '', ghToken: '', c7Key: '', vtKey: '', lmPortal: '', lmToken: '', lmId: '', lmKey: '', adoOrg: null, options: {}, azure: null, transcripts: null, teamschats: null, outlookmail: null, outlookcalendar: null, cuPaste: {}, ...st };
    const list = (st.view && st.view.connectors) || [];
    const planned = (st.view && st.view.planned) || [];
    const picked = list.find((c) => c.id === st.picked) || list[0];
    const s2 = { ...st, picked: picked && picked.id };
    const detail = !picked ? '' : (() => {
      const body = (BODIES[picked.id] || azureBody)(picked, s2, now);
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
  const SIGN_IN = ['atlassian', 'vantage']; // connectors with a browser sign-in
  const ATLASSIAN_POLL_MS = 2000, AZURE_POLL_MS = 3000, GIVE_UP_MS = 10 * 60 * 1000;

  function mountConnectors(el, ui) {
    const st = { view: null, picked: null, err: {}, email: '', token: '', ghToken: '', c7Key: '', vtKey: '', waitingFor: undefined, lmPortal: '', lmToken: '', lmId: '', lmKey: '', adoOrg: null, waiting: false, azure: null, transcripts: null, teamschats: null, outlookmail: null, outlookcalendar: null, cuPaste: {}, options: {}, canTerm: true, installing: null };
    let lastKey = '';
    let seq = 0;
    let busy = false;
    let atlTimer = null, azTimer = null, instTimer = null;
    const msTimers = {}; // app sign-in connector id -> its status poll
    let atlUntil = 0;
    const active = () => (ui.active ? ui.active() : true);

    function render(force) {
      const now = Date.now();
      st.canTerm = ui.canTerm ? !!ui.canTerm() : true;
      // The pane redraws only when something it shows changed: a poll answering the same view must not replace a
      // field that is being typed in. Typed text is kept in st and the focus is put back.
      const key = JSON.stringify([st.view, st.picked, st.err, st.waiting, st.azure && [st.azure.code, minutesLeft(st.azure.expiresAt, now)], Object.keys(MSAPP).map((id) => st[id] && [st[id].code, minutesLeft(st[id].expiresAt, now)]), st.options, st.canTerm, st.view && st.view.connectors.map((c) => c.lastTest && ago(c.lastTest.at, now))]);
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
      // One browser sign-in at a time: the one this pane waits for, else one some other session started, else Atlassian.
      const sid = st.waitingFor || (list.find((c) => SIGN_IN.includes(c.id) && c.state === 'connecting') || {}).id || 'atlassian';
      const atl = list.find((c) => c.id === sid);
      const az = list.find((c) => c.id === 'azure');
      if (atl) {
        st.prevSign = st.prevSign || {};
        const step = signInStep(st, st.prevSign[sid], atl);
        st.prevSign[sid] = { state: atl.state, method: atl.method };
        st.waiting = step.waiting; st.dismissed = step.dismissed;
        st.waitingFor = step.waiting ? sid : undefined;
        if (!step.waiting) st.waitFrom = null;
        if (step.clear) {
          delete st.options[sid]; st.err.oauth = '';
          if (sid === 'atlassian') { st.err.token = ''; st.token = ''; } else delete st.options.vtToken;
        }
        if (step.poll && !atlTimer) startAtlPoll();
        if (!step.poll) stopAtlPoll();
      }
      if (az) {
        if (az.state === 'connecting' && !azTimer) startAzPoll();
        if (az.state !== 'connecting') { st.azure = null; stopAzPoll(); }
      }
      for (const [mid, ma] of Object.entries(MSAPP)) {
        const row = list.find((c) => c.id === mid);
        if (!row) continue;
        if (row.state === 'connecting' && !msTimers[mid]) startMsPoll(mid);
        if (row.state === 'connected') { st[`${ma.pre}Tenant`] = null; st[`${ma.pre}Client`] = null; } // finished (also when no poll saw it)
        if (row.state !== 'connecting') { st[mid] = null; stopMsPoll(mid); }
      }
      const inst = st.installing && list.find((c) => c.id === st.installing);
      if (!inst || inst.state !== 'not-installed') { st.installing = null; stopInstPoll(); }
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

    // A tick is skipped while the last poll is still in flight: a slow server would otherwise have every answer discarded
    // by the newer request's sequence number.
    let polling = false;
    function pollRefresh() {
      if (polling) return;
      polling = true;
      refresh().finally(() => { polling = false; });
    }

    // Atlassian: poll the list every 2 s until connected, Cancel, 10 minutes, or Settings closes.
    function startAtlPoll() {
      stopAtlPoll();
      atlUntil = Date.now() + GIVE_UP_MS;
      atlTimer = setInterval(() => {
        if (!active() || Date.now() > atlUntil) { stopAtlPoll(); if (Date.now() > atlUntil) { st.waiting = false; st.dismissed = true; render(); } return; }
        pollRefresh();
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
    // Teams transcripts and Teams chats: the same loop, each on its own status route.
    function startMsPoll(id) {
      stopMsPoll(id);
      const pre = MSAPP[id].pre;
      const until = Date.now() + GIVE_UP_MS;
      msTimers[id] = setInterval(async () => {
        if (!active() || Date.now() > until) { stopMsPoll(id); return; }
        try {
          // ui.api, not call(): a failed sign-in answers { status: 'failed', error }, and call() would throw on that error
          const s = (await ui.api('GET', `/api/connectors/${id}/status`)) || {};
          if (s.status === 'failed') { st.err[pre] = s.error || 'The sign-in did not finish.'; st[id] = null; stopMsPoll(id); await refresh(); return; }
          if (s.status === 'done' || s.status === 'idle') {
            if (s.status === 'done') { st[`${pre}Tenant`] = null; st[`${pre}Client`] = null; } // typed IDs are kept until a sign-in succeeds
            st[id] = null; stopMsPoll(id); await refresh(); return;
          }
          render();
        } catch (e) { /* the next tick tries again */ }
      }, AZURE_POLL_MS);
    }
    function stopMsPoll(id) { if (msTimers[id]) { clearInterval(msTimers[id]); msTimers[id] = null; } }
    // After Install the terminal runs on its own: look for the tools every 3 s.
    function startInstPoll() {
      stopInstPoll();
      const until = Date.now() + GIVE_UP_MS;
      instTimer = setInterval(() => { if (!active() || Date.now() > until) stopInstPoll(); else pollRefresh(); }, AZURE_POLL_MS);
    }
    function stopInstPoll() { if (instTimer) { clearInterval(instTimer); instTimer = null; } }
    function stop() { stopAtlPoll(); stopAzPoll(); for (const id of Object.keys(MSAPP)) stopMsPoll(id); stopInstPoll(); }

    // The approve tab says it is done over a same-origin channel (it has no opener); polling is the fallback.
    if (typeof BroadcastChannel !== 'undefined') {
      try { const bc = new BroadcastChannel('vaultos-connectors'); bc.onmessage = () => { refresh(); }; if (bc.unref) bc.unref(); } catch { /* polling covers it */ }
    }

    // A click that talks to the server: one at a time, an error lands under the button that caused it.
    // Answers true when it did the work. When it didn't (busy, or it failed) the pane is redrawn from its own state, so a
    // switch or a list the person just touched can't keep showing a value the server never applied.
    async function run(region, f) {
      if (busy) return false;
      busy = true;
      st.err[region] = '';
      let ok = true;
      const btns = el.querySelectorAll ? Array.from(el.querySelectorAll('button[data-act]')) : [];
      btns.forEach((b) => { b.disabled = true; });
      try { await f(); } catch (e) { ok = false; st.err[region] = (e && e.message) || 'Something went wrong.'; } finally { busy = false; btns.forEach((b) => { b.disabled = false; }); }
      render(!ok);
      return ok;
    }

    async function startSignIn(id, reuse) {
      const cur = st.view && st.view.connectors.find((x) => x.id === id);
      const name = (cur && cur.label) || 'Atlassian';
      if (!reuse) st.waitFrom = cur && (cur.state === 'connected' || cur.state === 'error') ? cur.method : null;
      // The tab opens inside the click, before the wait for the server, so the browser does not block it.
      const w = reuse ? ui.openTab(reuse) : ui.openTab('about:blank');
      if (reuse) {
        if (!w) throw new Error('Your browser blocked the new tab. Allow pop-ups for VaultOS, then try again.');
        return;
      }
      try {
        const r = await call('POST', `/api/connectors/${id}/start`);
        const href = signInUrl(r.url);
        if (!href) throw new Error(`${name} sent a sign-in address VaultOS does not trust. Try again, or use an API token.`);
        st.url = href;
        if (!w) throw new Error('Your browser blocked the new tab. Allow pop-ups for VaultOS, then try again.');
        w.location.href = href;
      } catch (e) {
        if (w && w.close) try { w.close(); } catch { /* gone */ }
        throw e;
      }
      st.waiting = true; st.dismissed = false; st.waitingFor = id;
      startAtlPoll();
    }

    async function onAct(act, b) {
      const id = st.picked;
      if (act === 'oauth') return run('oauth', () => startSignIn(SIGN_IN.includes(id) ? id : 'atlassian'));
      if (act === 'reopen') {
        const wid = st.waitingFor || 'atlassian';
        return run('oauth', () => (st.url ? startSignIn(wid, st.url) : startSignIn(wid)));
      }
      if (act === 'vt-switch') { st.options.vantage = true; st.options.vtToken = true; st.err.vtkey = ''; render(); return; }
      if (act === 'vt-keep') { delete st.options.vantage; delete st.options.vtToken; st.err.vtkey = ''; st.vtKey = ''; render(); return; }
      if (act === 'cancel') {
        const wid = st.waitingFor || 'atlassian';
        return run('oauth', async () => {
          st.waiting = false; st.waitFrom = null; st.waitingFor = undefined; stopAtlPoll();
          await call('POST', `/api/connectors/${wid}/cancel`);
          st.dismissed = false;
          await refresh();
        });
      }
      if (act === 'token') {
        return run('token', async () => {
          const email = st.email.trim(), token = st.token.trim();
          if (!email || !token) throw new Error('Enter the Atlassian email and the API token.');
          await call('POST', '/api/connectors/atlassian/token', { email, token });
          st.token = '';
          await refresh();
        });
      }
      if (act === 'lm-keys' || act === 'lm-bearer') { st.options.lmKeys = act === 'lm-keys'; st.err.lm = ''; render(); return; }
      if (act === 'lm-replace') { st.options.logicmonitor = true; st.err.lm = ''; render(); return; }
      if (act === 'lm-keep') { delete st.options.logicmonitor; st.err.lm = ''; st.lmToken = ''; st.lmId = ''; st.lmKey = ''; render(); return; }
      if (act === 'lm-save') {
        return run('lm', async () => {
          const row = (st.view && st.view.connectors.find((x) => x.id === 'logicmonitor')) || {};
          const portal = (st.lmPortal || row.portal || '').trim();
          if (!portal) throw new Error('Enter the LogicMonitor portal name first.');
          let body;
          if (st.options.lmKeys) {
            const accessId = st.lmId.trim(), accessKey = st.lmKey.trim();
            if (!accessId || !accessKey) throw new Error('Paste the access ID and key first.');
            body = { portal, accessId, accessKey };
          } else {
            const token = st.lmToken.trim();
            if (!token) throw new Error('Paste the LogicMonitor bearer token first.');
            body = { portal, token };
          }
          await call('POST', '/api/connectors/logicmonitor/token', body);
          st.lmPortal = ''; st.lmToken = ''; st.lmId = ''; st.lmKey = ''; delete st.options.logicmonitor;
          await refresh();
        });
      }
      const k = Object.values(KEYED).find((x) => act.startsWith(`${x.act}-`));
      if (k && act === `${k.act}-token`) {
        return run(k.err, async () => {
          const token = st[k.field].trim();
          if (!token) throw new Error(`Paste the ${k.name} ${k.what} first.`);
          await call('POST', `/api/connectors/${k.id}/token`, { token });
          st[k.field] = ''; delete st.options[k.id];
          await refresh();
        });
      }
      if (k && act === `${k.act}-replace`) { st.options[k.id] = true; st.err[k.err] = ''; render(); return; }
      if (k && act === `${k.act}-keep`) { delete st.options[k.id]; st.err[k.err] = ''; st[k.field] = ''; render(); return; }
      if (act === 'en-on') return run('actions', async () => { await call('POST', '/api/connectors/entra/enable'); await refresh(); });
      if (act === 'en-off') return run('actions', async () => { await call('POST', '/api/connectors/entra/disconnect'); await refresh(); });
      if (act === 'ms-on') return run('actions', async () => { await call('POST', '/api/connectors/mslearn/enable'); await refresh(); });
      if (act === 'ms-off') return run('actions', async () => { await call('POST', '/api/connectors/mslearn/disconnect'); await refresh(); });
      if (act === 'switch') { st.options.atlassian = true; st.err.actions = ''; render(); return; }
      if (act === 'keep') { delete st.options.atlassian; render(); return; }
      if (act === 'test') return run('actions', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/test`); await refresh(); });
      if (act === 'disconnect') return run('actions', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/disconnect`); st.azure = null; for (const mid of Object.keys(MSAPP)) st[mid] = null; await refresh(); });
      if (act === 'install') {
        const c = st.view.connectors.find((x) => x.id === id);
        if (c && c.install) { ui.openTerm(c.install); st.installing = id; startInstPoll(); }
        return;
      }
      if (act === 'ado-on') {
        return run('ado', async () => {
          const cur = st.view.connectors.find((x) => x.id === 'azuredevops') || {};
          const org = (st.adoOrg != null ? st.adoOrg : (cur.org || '')).trim();
          if (!org) throw new Error('Enter your Azure DevOps organization first.');
          await call('POST', '/api/connectors/azuredevops/enable', { org });
          st.adoOrg = null; delete st.options.azuredevops;
          await refresh();
        });
      }
      if (act === 'ado-change') { st.options.azuredevops = true; st.err.ado = ''; render(); return; }
      if (act === 'ado-keep') { delete st.options.azuredevops; st.err.ado = ''; st.adoOrg = null; render(); return; }
      if (act === 'ado-off') return run('actions', async () => { await call('POST', '/api/connectors/azuredevops/disconnect'); await refresh(); });
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
      if (act === 'cu-start') return run('cu', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/start`); await refresh(); });
      if (act === 'cu-finish') {
        return run('cu', async () => {
          await call('POST', `/api/connectors/${encodeURIComponent(id)}/finish`, { url: ((st.cuPaste || {})[id] || '').trim() });
          st.cuPaste[id] = '';
          await refresh();
        });
      }
      if (act === 'cu-cancel') return run('cu', async () => { await call('POST', `/api/connectors/${encodeURIComponent(id)}/cancel`); st.cuPaste[id] = ''; await refresh(); });
      const ms = Object.hasOwn(MSAPP_ACTS, act) ? MSAPP_ACTS[act] : null;
      if (ms && ms.step === 'start') {
        const pre = MSAPP[ms.id].pre;
        return run(pre, async () => {
          const cur = st.view.connectors.find((x) => x.id === ms.id) || {};
          const tenantId = (st[`${pre}Tenant`] != null ? st[`${pre}Tenant`] : (cur.tenantId || '')).trim();
          const clientId = (st[`${pre}Client`] != null ? st[`${pre}Client`] : (cur.clientId || '')).trim();
          const r = await call('POST', `/api/connectors/${ms.id}/start`, { tenantId, clientId });
          st[ms.id] = { url: r.url, code: r.code, expiresAt: r.expiresAt };
          startMsPoll(ms.id);
          await refresh();
        });
      }
      if (ms && ms.step === 'cancel') {
        return run(MSAPP[ms.id].pre, async () => { await call('POST', `/api/connectors/${ms.id}/cancel`); st[ms.id] = null; stopMsPoll(ms.id); await refresh(); });
      }
      if (act === 'copy') {
        const code = Object.hasOwn(MSAPP, st.picked) ? st[st.picked] : st.azure;
        const ok = code && ui.copy ? await ui.copy(code.code) : false;
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
      else if (e.target.id === 'cx-ado-org') st.adoOrg = e.target.value;
      else if (msappField(e.target.id)) st[msappField(e.target.id)] = e.target.value;
      else if (e.target.id === 'cu-paste') st.cuPaste[st.picked] = e.target.value;
      else if (Object.hasOwn(LM_INPUTS, e.target.id)) st[LM_INPUTS[e.target.id]] = e.target.value;
      else { const k = keyedInput(e.target.id); if (k) st[k.field] = e.target.value; }
    });
    el.addEventListener('change', (e) => {
      if (e.target.id === 'cx-allow') {
        const on = e.target.checked;
        run('actions', async () => { await call('POST', '/api/connectors/azure/settings', { allowChanges: on }); await refresh(); })
          .then((ok) => { if (!ok) { render(true); } });
      } else if (e.target.id === 'cx-vt-allow') {
        const on = e.target.checked;
        run('actions', async () => { await call('POST', '/api/connectors/vantage/settings', { allowChanges: on }); await refresh(); })
          .then((ok) => { if (!ok) { render(true); } });
      } else if (e.target.id === 'cx-ado-allow') {
        const on = e.target.checked;
        run('actions', async () => { await call('POST', '/api/connectors/azuredevops/settings', { allowChanges: on }); await refresh(); })
          .then((ok) => { if (!ok) { render(true); } });
      } else if (e.target.id === 'cx-sub') {
        const pick = e.target.value;
        run('actions', async () => { await call('POST', '/api/connectors/azure/settings', { subscription: pick }); await refresh(); })
          .then((ok) => { if (!ok) { render(true); } });
      }
    });
    el.addEventListener('keydown', (e) => {
      const ki = keyedInput(e.target.id);
      if (e.key === 'Enter' && ki) { e.preventDefault(); onAct(`${ki.act}-token`); return; }
      if (e.key === 'Enter' && Object.hasOwn(LM_INPUTS, e.target.id)) { e.preventDefault(); onAct('lm-save'); return; }
      if (e.key === 'Enter' && e.target.id === 'cx-ado-org') { e.preventDefault(); onAct('ado-on'); return; }
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

  return { esc, stateChip, agentChip, minutesLeft, hostPath, signInUrl, atlassianStep, signInStep, paneHtml, mountConnectors };
});
