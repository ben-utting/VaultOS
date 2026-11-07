'use strict';

// ========================================================================
// AgentForm — the coding-agent picker (window.AgentForm), shared by setup
// step 4 (setup.js) and Settings → Agent (app.js): the agent tiles from
// GET /api/agents with their logos (agent-marks.js), the detail panel with
// Install / Sign in / Make default, and the fields of an "Other" agent with
// their checks. mountPicker() renders into the element the page passes and
// calls back into the page through a `ui` object:
//   ui.save(body)            the page's POST /api/settings/agent, in order; resolves
//                            { ok: true }, { stale: true } (a later save overtook it)
//                            or { error } (a message for the person)
//   ui.openTerm(kind, agent) run the agent's install or login command in a terminal
//   ui.customFields          the page's Other-agent fields, shown when Other is picked
// saveCustom() takes the Other fields' own ui: save, value(key), fieldError(key, msg),
// focus(key), customError(msg).
// The server's rules (validate() in lib/settings.js) are the real ones; the
// checks here give the same answers first, with the message next to the field.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.AgentForm = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const Marks = typeof AgentMarks !== 'undefined' ? AgentMarks : (typeof require === 'function' ? require('./agent-marks') : null);

  // An Other agent's fields, in order. `code` fields hold commands (monospace, no spellcheck or
  // capitals); `wide` ones take the form's full width.
  const CUSTOM_FIELDS = [
    { key: 'label', label: 'Name', placeholder: 'My agent', maxlength: 60 },
    { key: 'detect', label: 'Command', hint: "The program's name, to check it's installed.", placeholder: 'my-agent', code: true },
    { key: 'install', label: 'Install command (optional)', placeholder: 'npm install -g my-agent', code: true, wide: true },
    { key: 'login', label: 'Sign-in command (optional)', placeholder: 'my-agent login', code: true, wide: true },
    { key: 'start', label: 'Start command', hint: '{prompt} becomes the check-in prompt, quoted.', placeholder: 'my-agent {prompt}', code: true, wide: true },
  ];

  // lib/settings.js's rule for agent.custom.detect: the server runs it through a shell, so a command name only.
  const DETECT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

  // The `custom` that POST /api/settings/agent takes, from value(key) for each field: trimmed, and the
  // optional commands only when filled in.
  function customBody(value) {
    const v = (k) => String(value(k) ?? '').trim();
    return {
      label: v('label'), detect: v('detect'), start: v('start'),
      ...(v('install') ? { install: v('install') } : {}),
      ...(v('login') ? { login: v('login') } : {}),
    };
  }

  // The first thing wrong with a customBody(), as { key, message } for the field it belongs to; null when it
  // can be saved.
  function customProblem(c) {
    if (!c.label) return { key: 'label', message: 'Give the agent a name' };
    if (!DETECT_RE.test(c.detect)) return { key: 'detect', message: "Use the program's name: letters, digits, . _ + -" };
    if (!c.start.includes('{prompt}')) return { key: 'start', message: 'The start command needs {prompt}' };
    return null;
  }

  // Save agent: checks the fields (the message goes next to the first bad one), then saves. Resolves the body it
  // saved, or null when it didn't (a bad field, a save already running, a later choice, or a server error).
  async function saveCustom(ui) {
    for (const f of CUSTOM_FIELDS) ui.fieldError(f.key, '');
    ui.customError('');
    const c = customBody(ui.value);
    const bad = customProblem(c);
    if (bad) {
      ui.fieldError(bad.key, bad.message);
      ui.focus(bad.key);
      return null;
    }
    // Not disabled while saving (that would drop the focus, and Enter with it): a flag stops a second save.
    if (ui.busy) return null;
    ui.busy = true;
    let r;
    try { r = await ui.save({ profile: 'custom', custom: c }); } finally { ui.busy = false; }
    if (r.error) ui.customError(r.error);
    return r.ok ? c : null;
  }

  // ---- the picker ------------------------------------------------------------
  // The agent tiles (GET /api/agents), a detail panel for the picked one and a footer naming the default. All agent
  // text goes in escaped: a custom agent's label is the person's own.
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINOR = {
    custom: { id: 'custom', label: 'Other agent', maker: 'Any command you give it', tier: 'other' },
    none: { id: 'none', label: 'No agent for now', maker: 'The terminal still works', tier: 'other' },
  };

  function chipsFor(a, def) {
    const out = a.id === def ? ['Default'] : [];
    if (a.id !== 'none' && (a.id !== 'custom' || a.saved !== false)) out.push(a.installed ? 'Installed' : 'Not installed');
    return out;
  }

  // custom and none are always there, last; a saved custom agent keeps its own label and installed state.
  function groups(list) {
    const saved = list.find((a) => a.id === 'custom');
    return {
      tested: list.filter((a) => a.tier === 'tested'),
      more: list.filter((a) => a.tier === 'more'),
      minor: [saved ? { ...MINOR.custom, ...saved, maker: MINOR.custom.maker, saved: true } : { ...MINOR.custom, saved: false }, MINOR.none],
    };
  }

  const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  function moveFocus(ids, current, key) {
    const i = ids.indexOf(current);
    if (key === 'Home') return ids[0];
    if (key === 'End') return ids[ids.length - 1];
    if (!STEP[key]) return null;
    return ids[(i + STEP[key] + ids.length) % ids.length];
  }

  const chipHtml = (c) => `<span class="ap-chip${c === 'Default' ? ' def' : c === 'Installed' ? ' ok' : ''}">${c}</span>`;
  const mark = (id, cls = '') => `<span class="ap-mark${cls}">${Marks ? Marks.svg(id) : ''}</span>`;
  function tileHtml(a, st) {
    const on = a.id === st.picked;
    const chips = chipsFor(a, st.def);
    return `<button type="button" class="ap-tile" data-id="${esc(a.id)}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}">`
      + `${mark(a.id)}<span class="ap-txt"><span class="ap-nm">${esc(a.label)}</span><span class="ap-by">${esc(a.maker)}</span>`
      + `${chips.length ? `<span class="ap-chips">${chips.map(chipHtml).join('')}</span>` : ''}</span></button>`;
  }
  function detailHtml(a, st) {
    const isDef = a.id === st.def;
    const makeDef = `<button type="button" class="su-btn primary" data-act="default"${isDef ? ' disabled' : ''}>${isDef ? 'Default' : 'Make default'}</button>`;
    const head = `${mark(a.id, ' big')}<div class="ap-dbody"><h4 class="ap-dname">${esc(a.label)} ${chipsFor(a, st.def).map(chipHtml).join('')}</h4>`;
    const err = st.error ? `<p class="su-err ap-err" role="alert">${esc(st.error)}</p>` : '';
    if (a.id === 'none') {
      return `${head}<p class="ap-fact">Start agent stays hidden until you pick a default. The terminal still works.</p>`
        + `<div class="ap-btns">${makeDef}</div>${err}</div>`;
    }
    if (a.id === 'custom') {
      return `${head}<p class="ap-fact">Give it a name, the command that starts it, and optional install and sign-in commands.</p>`
        + `<div class="ap-custom-slot"></div>${a.saved ? `<div class="ap-btns">${makeDef}</div>` : ''}${err}</div>`;
    }
    const cmd = a.installed ? a.login : a.install;
    const facts = [a.maker, "Reads AGENTS.md and the vault's skills",
      a.hooks === 'claude' ? 'Cards show its live status' : 'Cards show working or idle'];
    const act = a.installed
      ? (a.login ? '<button type="button" class="su-btn" data-act="login">Sign in</button>' : '')
      : (a.install ? '<button type="button" class="su-btn" data-act="install">Install</button>' : '');
    return `${head}<ul class="ap-facts">${facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      + (cmd ? `<p class="ap-cmd"><span aria-hidden="true">$ </span>${esc(cmd)}</p>` : '')
      + (a.installed && a.loginNote ? `<p class="ap-note">${esc(a.loginNote)}</p>` : '')
      + `<div class="ap-btns">${act}${makeDef}</div>${err}</div>`;
  }
  // state: { agents (GET /api/agents' list), def (the saved profile), picked, error? }
  function pickerHtml(st) {
    const g = groups(st.agents);
    const all = [...g.tested, ...g.more, ...g.minor];
    const picked = all.find((a) => a.id === st.picked) || all[0];
    const s2 = { ...st, picked: picked.id };
    const d = all.find((a) => a.id === st.def);
    const grid = (cls, list) => `<div class="ap-grid ${cls}">${list.map((a) => tileHtml(a, s2)).join('')}</div>`;
    return `<div class="ap-tiles" role="radiogroup" aria-label="Coding agents">`
      + `<h3 class="ap-h">Tested with VaultOS</h3>${grid('ap-tested', g.tested)}`
      + `<h3 class="ap-h">More agents <span>· install and start work; status badges and skills may vary</span></h3>${grid('ap-more', g.more)}`
      + `${grid('ap-minor', g.minor)}</div>`
      + `<div class="ap-detail" aria-live="polite">${detailHtml(picked, s2)}</div>`
      + `<p class="ap-foot">${d && d.id !== 'none' ? `${mark(d.id, ' small')}<span>Default: <b>${esc(d.label)}</b></span>` : '<span>No default agent</span>'}</p>`;
  }

  // Renders into host and wires it: tiles pick, arrow keys move, the detail buttons call the page's ui:
  //   ui.save({ profile }) → { ok } | { error } | { stale };  ui.openTerm('install' | 'login', agent);
  //   ui.customFields: the page's Other-agent fields element, shown in the detail when Other is picked.
  function mountPicker(host, ui) {
    const st = { agents: [], def: 'none', picked: null, error: '' };
    const order = () => { const g = groups(st.agents); return [...g.tested, ...g.more, ...g.minor].map((a) => a.id); };
    const find = (id) => { const g = groups(st.agents); return [...g.tested, ...g.more, ...g.minor].find((a) => a.id === id); };
    // The Other fields show only in the detail panel. Whenever another tile is picked they go back to where the page
    // put them, hidden: still in the document, so the page can reach its inputs by id.
    const fields = ui.customFields || null;
    const home = fields && fields.parentNode;
    function parkFields() {
      if (!fields) return;
      if (home && fields.parentNode !== home) home.appendChild(fields);
      fields.classList.toggle('hidden', true);
    }
    function render() {
      parkFields();
      host.innerHTML = pickerHtml(st);
      const slot = host.querySelector && host.querySelector('.ap-custom-slot');
      if (slot && fields) { slot.appendChild(fields); fields.classList.toggle('hidden', false); }
    }
    parkFields();
    function pick(id) { st.picked = id; st.error = ''; render(); }
    let last = '';
    // Polls answer the same list most of the time: redrawing then would replace the tile under a click in progress.
    function refresh(payload) {
      const key = JSON.stringify([payload.default, payload.agents]);
      if (key === last) return;
      last = key;
      st.agents = payload.agents || [];
      st.def = payload.default || 'none';
      if (!st.picked) st.picked = st.def === 'none' ? order()[0] : st.def;   // a new install opens on an agent, not on None
      render();
    }
    host.addEventListener('click', async (e) => {
      const tile = e.target.closest('.ap-tile');
      if (tile) { pick(tile.dataset.id); return; }
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const a = find(st.picked);
      if (!a) return;
      const makeDefault = async () => {
        const r = await ui.save({ profile: a.id });
        if (r && r.ok) { st.def = a.id; st.error = ''; } else if (r && r.error) st.error = r.error;
        render();
      };
      // The first agent installed becomes the default, so Start agent works without a second step.
      if (b.dataset.act === 'install' && st.def === 'none') await makeDefault();
      if (b.dataset.act === 'install' || b.dataset.act === 'login') { ui.openTerm(b.dataset.act, a); return; }
      if (b.dataset.act === 'default') await makeDefault();
    });
    host.addEventListener('keydown', (e) => {
      const tile = e.target.closest('.ap-tile');
      if (!tile) return;
      const next = moveFocus(order(), st.picked, e.key);
      if (!next) return;
      e.preventDefault();
      pick(next);
      const t = host.querySelector && host.querySelector(`.ap-tile[data-id="${next}"]`);
      if (t) t.focus();
    });
    return { refresh, pick, state: st };
  }

  return {
    chipsFor, groups, moveFocus, pickerHtml, mountPicker, CUSTOM_FIELDS, DETECT_RE, customBody, customProblem, saveCustom,
  };
});
