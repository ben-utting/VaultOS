'use strict';

// ========================================================================
// First-run setup (setup.html). GET /api/setup/state says which steps are
// due; this walks them in order, one form in the card at a time:
//   1 Folder        what the server found at /vault: mounted, writable, contents
//   2 Password      sets the password and signs this browser in
//   3 Boards        the first board names → starter files and settings.json
//   4 Coding agent  the agent, with an inline terminal to install / sign in
//   5 Extras        Today, its time zone, theme and reading font → Finish
// Steps 2 and 3 cannot be redone, so Back only returns to step 1 or step 4.
// Every string from the server or the vault goes in as text (h() below), never as HTML.
// ========================================================================

const CARD = document.getElementById('su-card');
const MIN_PASSWORD = 8;
const MAX_BOARDS = 10;
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
// The spec's command, one option a line so the longest still fits a phone. This container
// already has the name, so it goes first (a different name: rm says so, and run goes ahead).
const RUN_CMD = [
  'docker rm -f vaultos',
  'docker run -d --name vaultos \\',
  '  -p 127.0.0.1:7684:8080 \\',
  '  -v "<your folder>:/vault" \\',
  '  -v vaultos-home:/home/vaultos \\',
  '  vaultos:latest',
].join('\n');

let STATE = null;   // the last /api/setup/state
let STEPS = [];     // the steps this visit walks, in order
let AT = 0;         // index into STEPS
let leaveStep = null;   // undoes what the current step started (step 4's terminal and poll)
// What was typed on a step, kept for when Back returns to it.
const KEEP = {
  agent: null,   // the agent chosen on step 4, so Back shows None as chosen too
  custom: { label: '', detect: '', install: '', login: '', start: '' },
  today: false,
  timezone: TZ,
};

// ---------- DOM helpers ----------
// h('p', { class, text, onclick, ...attributes }, ...children). Strings become text nodes.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// Fixed icon markup only; nothing from the server goes through here.
const ICONS = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

// A labelled input with an optional hint and an error line under it.
let fieldSeq = 0;
function field({ label, hint, cls, mono, ...attrs }) {
  const id = `su-f${++fieldSeq}`;
  const input = h('input', { id, class: mono ? 'su-input mono' : 'su-input', ...attrs });
  const hintEl = hint ? h('p', { class: 'su-hint', id: `${id}-hint`, text: hint }) : null;
  const err = h('p', { class: 'su-err', id: `${id}-err`, 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', [hintEl && hintEl.id, err.id].filter(Boolean).join(' '));
  const wrap = h('div', { class: `su-field${cls ? ` ${cls}` : ''}` }, h('label', { for: id, text: label }), input, hintEl, err);
  const error = (msg) => {
    err.textContent = msg || '';
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  };
  input.addEventListener('input', () => error(''));
  return { wrap, input, error };
}
const errLine = () => h('p', { class: 'su-err', 'aria-live': 'polite' });
const btn = (text, props) => h('button', { type: 'button', class: 'su-btn', ...props }, text);
const submit = (text) => h('button', { type: 'submit', class: 'su-btn primary' }, text);

// A command in a <pre> with a Copy button above it. termCopy (term.js) has the plain-HTTP fallback.
function codeBlock(caption, text) {
  const label = h('span', { text: 'Copy' });
  const copy = h('button', { type: 'button', class: 'su-copy' }, icon('copy'), label);
  copy.addEventListener('click', async () => {
    const ok = await termCopy(text);
    label.textContent = ok ? 'Copied' : 'Select it and copy';
    clearTimeout(copy._t);
    copy._t = setTimeout(() => { label.textContent = 'Copy'; }, 1800);
  });
  return h('div', { class: 'su-code' },
    h('div', { class: 'su-code-bar' }, h('span', { text: caption }), copy),
    h('pre', { tabindex: '0', text }));
}

// ---------- Server ----------
async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty or not JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Can't reach VaultOS. Check the container is running, then try again" } };
  }
}
// Signed out (the session is gone) or overtaken (another browser got there first): the state
// says where setup now stands, so load it again rather than print the error.
const overtaken = (r) => r.status === 401 || r.status === 409;
// The server's message for the person. The settings rules prefix theirs with the file name, which means nothing here.
function errText(r, fallback) {
  const e = r && r.data && typeof r.data.error === 'string' ? r.data.error.replace(/^settings\.json: /, '') : '';
  return e ? e[0].toUpperCase() + e.slice(1) : fallback;
}

// ---------- Card frame ----------
// One screen: the step line (on numbered steps), a title, an intro, the body and a row of buttons.
// The form's submit (Enter in a field, or the primary button) runs onSubmit, once at a time.
function screen({ numbered, title, intro, body = [], foot = [], onSubmit }) {
  stopStep();
  const form = h('form', { class: 'su-form', novalidate: true });
  if (numbered) form.append(progress());
  form.append(h('h1', { class: 'su-title', text: title }));
  for (const p of [].concat(intro || [])) form.append(h('p', { class: 'su-intro', text: p }));
  form.append(...body);
  if (foot.length) form.append(h('div', { class: 'su-foot' }, ...foot));
  // Enter submits from a radio or a switch too (the browser only does it from text fields).
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type=radio], input[type=checkbox]')) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit || form.getAttribute('aria-busy')) return;
    form.setAttribute('aria-busy', 'true');
    const btns = [...form.querySelectorAll('.su-foot button')];
    for (const b of btns) b.disabled = true;
    try { await onSubmit(); } finally {
      form.removeAttribute('aria-busy');
      for (const b of btns) b.disabled = false;
    }
  });
  CARD.replaceChildren(form);
  window.scrollTo(0, 0);
  // The first field of the step, else its main button (so Enter goes on). Not the button on a touch
  // screen: there's no Enter, and the ring reads as stuck. preventScroll: on a phone the button can be
  // below the fold, and the step should open at its top.
  const first = form.querySelector('.ap-tile[aria-checked="true"]')
    || form.querySelector('input:not([type=hidden]):not(:disabled), select, textarea')
    || (matchMedia('(pointer: coarse)').matches ? null : form.querySelector('.su-foot .primary'));
  if (first) first.focus({ preventScroll: true });
  return form;
}
function progress() {
  const bar = h('div', { class: 'su-bar', 'aria-hidden': 'true' },
    STEPS.map((_, k) => h('span', { class: k < AT ? 'done' : k === AT ? 'now' : null })));
  return h('div', { class: 'su-progress' }, h('p', { class: 'su-stepline', text: `Step ${AT + 1} of ${STEPS.length}` }), bar);
}
function stopStep() {
  if (leaveStep) { const f = leaveStep; leaveStep = null; f(); }
}
// The buttons at the foot of a step: Back where the step before can be revisited, then the forward ones.
function stepFoot(...forward) {
  const canBack = AT > 0 && [1, 4].includes(STEPS[AT - 1]);
  return [canBack ? btn('Back', { onclick: () => go(AT - 1) }) : null, h('span', { class: 'su-gap' }), ...forward];
}

// ---------- Flow ----------
// Step 4 needs the terminal; with TERMINAL=0 it is not offered at all.
const usable = (st) => (st.steps || []).filter((n) => n !== 4 || st.terminalAllowed);

async function load() {
  stopStep();
  const r = await api('GET', '/api/setup/state');
  if (!r.ok) return unreachable(errText(r, 'Something went wrong reading the setup state'));
  STATE = r.data;
  if (STATE.stage === 'done') return location.replace('/');
  // A password exists: everything left needs a signed-in browser.
  if (!STATE.authed && (STATE.stage === 'boards' || STATE.stage === 'resume')) return signIn();
  // The password step only works inside the window; a broken settings file is only shown inside it (or signed in).
  if (((STATE.stage === 'full' || STATE.stage === 'existing-folder') && !STATE.windowOpen)
    || (STATE.stage === 'broken' && !STATE.folder)) return windowClosed();
  STEPS = usable(STATE);
  if (!STEPS.length) return location.replace('/');
  go(0);
}

function go(i) {
  AT = i;
  ({ 1: stepFolder, 2: stepPassword, 3: stepBoards, 4: stepAgent, 5: stepExtras })[STEPS[AT]]();
}
// Past the last step of this visit, the server says what (if anything) is still due: an existing
// folder that never finished setup still has step 5 to go.
async function next() {
  if (AT + 1 < STEPS.length) return go(AT + 1);
  const r = await api('GET', '/api/setup/state');
  if (r.ok && r.data.stage !== 'done') {
    const last = STEPS[STEPS.length - 1];
    const more = usable(r.data).filter((n) => n > last);
    if (more.length) {
      STATE = r.data;
      STEPS = STEPS.concat(more);
      return go(AT + 1);
    }
  }
  location.replace('/');
}

// ---------- Screens outside the steps ----------
function unreachable(msg) {
  screen({
    title: "Can't load setup",
    intro: msg,
    foot: [h('span', { class: 'su-gap' }), submit('Try again')],
    onSubmit: load,
  });
}

function windowClosed() {
  screen({
    title: 'Setup window closed',
    intro: 'For safety, the first part of setup only works for a few minutes after VaultOS starts. Restart the container to finish setup, then reload this page.',
    body: [
      codeBlock('Restart', 'docker restart vaultos'),
      h('p', { class: 'su-hint su-after', text: "Use your container's name if it isn't vaultos." }),
    ],
    foot: [h('span', { class: 'su-gap' }), submit('Reload')],
    onSubmit: () => location.reload(),
  });
}

function signIn() {
  const pw = field({ label: 'Password', type: 'password', autocomplete: 'current-password' });
  screen({
    title: 'Sign in to finish setup',
    intro: 'VaultOS already has a password. Sign in to carry on where setup left off.',
    body: [pw.wrap],
    foot: [h('span', { class: 'su-gap' }), submit('Sign in')],
    onSubmit: async () => {
      if (!pw.input.value) { pw.error('Enter your password'); return pw.input.focus(); }
      const r = await api('POST', '/api/login', { password: pw.input.value });
      if (r.ok) return load();
      pw.error(errText(r, 'Could not sign in'));
      pw.input.select();
    },
  });
}

// ---------- Step 1: Folder ----------
// One row of the folder card: an icon, a line, and anything that explains it.
function check(kind, title, ...body) {
  return h('li', { class: `su-check ${kind}` }, icon(kind === 'info' ? 'folder' : kind),
    h('div', null, h('p', { class: 'su-check-t', text: title }),
      body.length ? h('div', { class: 'su-check-b' }, ...body) : null));
}
const para = (text) => h('p', { text });

function folderState(f) {
  if (f.state === 'existing') {
    const n = f.boardCount;
    return check('info', `Found ${n} workspace${n === 1 ? '' : 's'}`,
      para('This folder already has VaultOS workspaces. They are kept as they are.'));
  }
  if (f.state === 'has-files') {
    return check('info', 'This folder already has files',
      para('VaultOS adds its own folders next to yours. Nothing is moved or changed.'));
  }
  return check('info', 'This folder is empty', para('Your first workspace goes here.'));
}

function stepFolder() {
  // A settings file that doesn't load stops setup here; restarting after the fix loads it again.
  if (STATE.settingsError) {
    return screen({
      title: 'Folder',
      body: [h('ul', { class: 'su-checks' }, check('bad', "VaultOS can't read the settings in this folder",
        h('pre', { class: 'su-errbox', text: STATE.settingsError }),
        para('Fix or remove .vaultos/settings.json in your folder, then restart the container.')))],
    });
  }
  const f = STATE.folder;
  const rows = [
    f.mounted
      ? check('ok', 'Your folder is mounted')
      : check('warn', 'No folder is mounted',
        para('Anything you add lives only inside this container, and is lost when the container is removed. To keep your work in a folder on your computer, remove this container and start VaultOS again with one:'),
        codeBlock('On your computer', RUN_CMD),
        // Not writable as well: there is no Continue anyway to offer.
        f.writable ? para('Only trying VaultOS out? Continue anyway.') : null),
    f.writable
      ? check('ok', 'VaultOS can write to it')
      : check('bad', "VaultOS can't write to this folder",
        para('On a Linux host, run the container as your own user: add this to the docker run command, then start it again.'),
        codeBlock('Add to docker run', '--user $(id -u):$(id -g)')),
    folderState(f),
  ];
  screen({
    numbered: true,
    title: 'Folder',
    intro: 'VaultOS keeps everything as plain files in the folder you started it with.',
    body: [h('ul', { class: 'su-checks' }, rows)],
    // Not writable: setup stops here until the container is started again.
    foot: f.writable
      ? stepFoot(submit(f.mounted ? 'Next' : 'Continue anyway'))
      : stepFoot(btn('Check again', { onclick: load })),
    onSubmit: f.writable ? next : null,
  });
}

// ---------- Step 2: Password ----------
function stepPassword() {
  const pw = field({ label: 'Password', type: 'password', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD} characters.` });
  const pw2 = field({ label: 'Confirm password', type: 'password', autocomplete: 'new-password' });
  screen({
    numbered: true,
    title: 'Password',
    intro: "You'll sign in to VaultOS with this password. It is kept on this machine, not in your folder.",
    body: [pw.wrap, pw2.wrap],
    foot: stepFoot(submit('Set password')),
    onSubmit: async () => {
      if (pw.input.value.length < MIN_PASSWORD) {
        pw.error(`Password must be at least ${MIN_PASSWORD} characters`);
        return pw.input.focus();
      }
      if (pw.input.value !== pw2.input.value) {
        pw2.error("Passwords don't match");
        return pw2.input.focus();
      }
      const r = await api('POST', '/api/setup/password', { password: pw.input.value });
      if (r.ok) return next();
      // The window closed while this step was open, or a password was set elsewhere (set-password.js).
      if (r.status === 403) return windowClosed();
      if (r.status === 409) return load();
      (r.status === 400 ? pw : pw2).error(errText(r, 'Could not save the password'));
    },
  });
}

// ---------- Step 3: Boards ----------
function stepBoards() {
  const rows = [];
  const list = h('div', { class: 'su-boards' });
  const err = errLine();
  const add = h('button', { type: 'button', class: 'su-add' }, icon('plus'), 'Add another');
  const go3 = submit('Create workspace');
  function sync() {
    add.classList.toggle('hidden', rows.length >= MAX_BOARDS);
    rows.forEach((r, i) => {
      r.del.classList.toggle('hidden', rows.length === 1);
      r.input.setAttribute('aria-label', `Workspace ${i + 1} name`);
    });
    go3.textContent = rows.length > 1 ? 'Create workspaces' : 'Create workspace';
  }
  function addRow(value) {
    const input = h('input', { class: 'su-input', type: 'text', maxlength: '60', autocomplete: 'off', value });
    const del = h('button', { type: 'button', class: 'su-iconbtn', 'aria-label': 'Remove this workspace', title: 'Remove' }, icon('x'));
    const r = { input, del, row: h('div', { class: 'su-board' }, input, del) };
    del.addEventListener('click', () => {
      const i = rows.indexOf(r);
      rows.splice(i, 1);
      r.row.remove();
      sync();
      rows[Math.max(0, i - 1)].input.focus();
    });
    input.addEventListener('input', () => { err.textContent = ''; });
    rows.push(r);
    list.append(r.row);
    sync();
    return r;
  }
  add.addEventListener('click', () => addRow('').input.focus());
  addRow('Work');
  screen({
    numbered: true,
    title: 'Workspaces',
    intro: 'A workspace is a folder of task cards, each with its own Knowledge Base. Start with one or a few; you can add, rename and hide workspaces later in Settings.',
    body: [h('div', { class: 'su-field' }, h('span', { class: 'su-label', text: 'Workspace names' }), list, err), add],
    foot: stepFoot(go3),
    onSubmit: async () => {
      err.textContent = '';
      const labels = rows.map((r) => r.input.value.trim());
      const blank = labels.findIndex((l) => !l);
      if (blank >= 0) {
        err.textContent = 'Give every workspace a name, or remove the empty one';
        return rows[blank].input.focus();
      }
      // Clashes and bad names are the server's rules (it says which board).
      const r = await api('POST', '/api/setup/boards', { labels, timezone: TZ });
      if (r.ok) return next();
      if (overtaken(r)) return load();
      err.textContent = errText(r, 'Could not create the workspaces');
    },
  });
}

// ---------- Step 4: Coding agents ----------
// The agent tiles, the detail panel and the Other fields are AgentForm's (agent-form.js), shared with
// Settings → Agent. This step owns the order of saves and the terminal Install and Sign in run in.

function stepAgent() {
  let list = null;         // the last GET /api/agents payload: every agent, installed or not, and the default
  let chose = !!KEEP.agent;   // a default was picked on this visit
  let savedCustom = '';    // the Other fields as last saved, to tell whether Next must save them first
  let term = null;
  let poll = null;

  // Other: the fields of a custom agent, shown in the picker's detail panel when Other is picked.
  const C = KEEP.custom;
  const cf = Object.fromEntries(AgentForm.CUSTOM_FIELDS.map((d) => [d.key, field({
    label: d.label, hint: d.hint, placeholder: d.placeholder, maxlength: d.maxlength, autocomplete: 'off',
    cls: d.wide ? 'wide' : null, mono: d.code, ...(d.code ? { spellcheck: 'false', autocapitalize: 'off' } : {}),
  })]));
  for (const [k, f] of Object.entries(cf)) {
    f.input.value = C[k];
    f.input.addEventListener('input', () => { C[k] = f.input.value; customErr.textContent = ''; });
  }
  const customErr = errLine();
  const customSave = btn('Save agent', { onclick: () => saveCustom() });
  const customBox = h('div', { class: 'su-custom' }, Object.values(cf).map((f) => f.wrap),
    h('div', { class: 'su-custom-foot' }, customSave, customErr));
  // Enter in these fields saves them; Next would leave the step.
  customBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.stopPropagation(); saveCustom(); }
  });

  const pickerHost = h('div', { class: 'ap' });
  const loadErr = errLine();

  // The terminal Install and Sign in run in.
  const termTitle = h('span', { class: 'su-term-t' });
  const termState = h('span', { class: 'su-term-s' });
  const termSlot = h('div', { class: 'su-term-slot' });
  const termBox = h('div', { class: 'su-termbox hidden' },
    h('div', { class: 'su-termbar' }, termTitle, termState, btn('Close', { class: 'su-btn su-sm', onclick: () => closeTerm() })),
    termSlot);

  const fwd = h('button', { type: 'submit', class: 'su-btn' }, 'Skip');
  const form = screen({
    numbered: true,
    title: 'Your coding agents',
    intro: 'Install the agents you use (inside VaultOS, not on your computer) and pick a default: Start agent on a card opens it. You can change this later in Settings.',
    body: [pickerHost, loadErr, termBox],
    foot: stepFoot(fwd),
    onSubmit: async () => {
      // Other, typed but not saved yet: save it first, and stay if that fails.
      if (picker.state.picked === 'custom' && customKey() !== savedCustom && !(await saveCustom())) return;
      next();
    },
  });
  leaveStep = () => closeTerm();

  const customKey = () => JSON.stringify(customBody());
  const customBody = () => AgentForm.customBody((k) => cf[k].input.value);

  // Skip until there's a default; Next after.
  function syncFwd() {
    const on = chose || (list && list.default !== 'none');
    fwd.textContent = on ? 'Next' : 'Skip';
    fwd.classList.toggle('primary', !!on);
  }
  function show(payload) {
    list = payload;
    picker.refresh(payload);
    syncFwd();
  }
  // The server applies saves in order; only the last one's answer counts.
  let saving = 0;
  async function save(body) {
    const mine = ++saving;
    const r = await api('POST', '/api/settings/agent', body);
    if (mine !== saving) return { ...r, stale: true };
    if (overtaken(r)) { load(); return { ...r, stale: true }; }
    if (r.ok) { chose = true; KEEP.agent = r.data.profile; refresh(); }
    return r;
  }
  const answer = (r) => (r.stale ? { stale: true } : r.ok ? { ok: true } : { error: errText(r, 'Could not save the agent') });
  const picker = AgentForm.mountPicker(pickerHost, {
    save: async (body) => answer(await save(body)),
    openTerm: (kind, a) => openTerm(kind, a),
    customFields: customBox,
  });
  // AgentForm.saveCustom's side of this step: the Other fields and their messages.
  const customUi = {
    save: async (body) => answer(await save(body)),
    value: (k) => cf[k].input.value,
    fieldError: (k, msg) => cf[k].error(msg),
    focus: (k) => cf[k].input.focus(),
    customError: (msg) => { customErr.textContent = msg; },
  };
  // Other is saved on Save agent, Enter in its fields, or Next.
  async function saveCustom() {
    const c = await AgentForm.saveCustom(customUi);
    if (c) savedCustom = JSON.stringify(c);
    return !!c;
  }

  // Install / Sign in: a VaultOS terminal that types the agent's command once it connects.
  function openTerm(kind, a) {
    closeTerm();
    const cmd = a && a[kind];
    if (!cmd) return;
    termTitle.textContent = kind === 'install' ? `Installing ${a.label}` : `Signing in to ${a.label}`;
    termState.textContent = 'Connecting…';
    termBox.classList.remove('hidden');
    const host = h('div', { class: 'term-host su-term' });
    termSlot.replaceChildren(host);
    term = createTerminal(host, {
      id: `setup-${Math.random().toString(36).slice(2, 12)}`,
      run: cmd,
      // 'closed' comes after the shell's exit (or the kill on Close), so what onExit wrote stays.
      onState: (st) => {
        if (st === 'connecting') termState.textContent = 'Connecting…';
        else if (st === 'denied') termState.textContent = "Couldn't open a terminal. Reload the page and try again.";
        else if (st === 'open') termState.textContent = '';
      },
      onExit: () => { termState.textContent = 'The shell has ended'; },
    });
    // A tap focuses the terminal inside the gesture, the only focus a phone raises its keyboard for
    // (as termui.js does). Opening it doesn't: the keyboard would cover the installer's output.
    let tap = null;
    host.addEventListener('pointerdown', (e) => { tap = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null; });
    host.addEventListener('pointerup', (e) => {
      if (tap && term && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) term.focus();
      tap = null;
    });
    if (!matchMedia('(pointer: coarse)').matches) term.focus();
    termBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Installed or not, while the terminal is open.
    poll = setInterval(refresh, 3000);
  }
  function closeTerm() {
    clearInterval(poll);
    poll = null;
    if (term) {
      // The shell goes with the panel; it was only opened for this. Disposed a beat later, as
      // termui.js does: closing the socket at once can beat the kill to the server.
      const t = term;
      term = null;
      t.kill();
      setTimeout(() => t.dispose(), 250);
      refresh();
    }
    termSlot.replaceChildren();
    termBox.classList.add('hidden');
  }
  // A read that a save started after can carry the default from before that save: dropped, as
  // save() drops an answer that a later save overtook.
  async function refresh() {
    const mine = saving;
    const r = await api('GET', '/api/agents');
    if (!r.ok || !form.isConnected || mine !== saving) return;
    show(r.data);
  }

  // What the server already has (an existing folder, or Back from step 5).
  (async () => {
    const mine = saving;
    const r = await api('GET', '/api/agents');
    if (!form.isConnected || mine !== saving) return;
    if (!r.ok) { loadErr.textContent = errText(r, 'Could not read the agents'); return; }
    const saved = r.data.agents.find((a) => a.id === 'custom');
    if (saved) {
      // The server hands back the name and commands it can; detect and start stay as typed here.
      if (!C.label) cf.label.input.value = C.label = saved.label || '';
      if (!C.install) cf.install.input.value = C.install = saved.install || '';
      if (!C.login) cf.login.input.value = C.login = saved.login || '';
      savedCustom = customKey();
    }
    show(r.data);
  })();
}

// ---------- Step 5: Extras ----------
const validTz = (tz) => {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};
// The per-browser preferences app.js keeps (PREF), with the same keys and defaults.
function readPref(key, fallback) {
  try { return localStorage.getItem(`vaultboard.${key}`) || fallback; } catch { return fallback; }
}
function setPref(key, v) {
  try { localStorage.setItem(`vaultboard.${key}`, v); } catch { /* private mode: this page only */ }
  document.documentElement.dataset[key] = v;
  if (key === 'theme') {
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', v === 'light' ? '#f4ecd9' : '#0b0d12');
  }
}
function seg(key, fallback, choices, labelId) {
  const cur = readPref(key, fallback);
  const el = h('div', { class: 'seg su-seg', role: 'group', 'aria-labelledby': labelId });
  for (const [v, text] of choices) {
    const b = h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(v === cur), class: v === cur ? 'on' : null }, text);
    b.addEventListener('click', () => {
      setPref(key, v);
      for (const x of el.children) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      }
    });
    el.append(b);
  }
  return el;
}

function stepExtras() {
  const today = h('input', { type: 'checkbox', class: 'su-switch', id: 'su-today', role: 'switch', 'aria-describedby': 'su-today-d' });
  today.checked = KEEP.today;
  today.addEventListener('change', () => { KEEP.today = today.checked; });
  const tz = field({
    label: 'Time zone', type: 'text', value: KEEP.timezone, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
    list: 'su-tzs', hint: "Today's days start at midnight here.",
  });
  tz.input.addEventListener('input', () => { KEEP.timezone = tz.input.value; });
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: no suggestions */ }
  const tzList = h('datalist', { id: 'su-tzs' }, zones.map((z) => h('option', { value: z })));
  const err = errLine();
  screen({
    numbered: true,
    title: 'Extras',
    intro: 'A few preferences. You can change all of them later.',
    body: [
      h('div', { class: 'su-row' },
        h('div', { class: 'su-row-t' }, h('label', { class: 'su-label', for: 'su-today', text: 'Today mode' }),
          h('p', { class: 'su-hint', id: 'su-today-d', text: "A daily page with habits, the day's tasks and a focus timer." })),
        today),
      tz.wrap, tzList,
      h('div', { class: 'su-field' }, h('span', { class: 'su-label', id: 'su-theme-l', text: 'Theme' }),
        seg('theme', 'dark', [['dark', 'Dark'], ['light', 'Sepia']], 'su-theme-l')),
      h('div', { class: 'su-field' }, h('span', { class: 'su-label', id: 'su-font-l', text: 'Reading font' }),
        seg('font', 'dyslexic', [['system', 'Standard'], ['dyslexic', 'OpenDyslexic']], 'su-font-l'),
        h('p', { class: 'su-hint', text: 'For Knowledge Base articles. Theme and font are saved in this browser.' })),
      err,
    ],
    foot: stepFoot(submit('Finish')),
    onSubmit: async () => {
      const zone = tz.input.value.trim();
      if (!validTz(zone)) { tz.error('Unknown time zone. Use a name like Asia/Tokyo'); return tz.input.focus(); }
      // Both are per-browser: written now so the app opens with them even if nothing was clicked.
      setPref('theme', readPref('theme', 'dark'));
      setPref('font', readPref('font', 'dyslexic'));
      const r = await api('POST', '/api/setup/finish', { today: today.checked, timezone: zone });
      if (r.ok) return location.replace('/');
      // Already finished elsewhere: load() opens the app. No boards yet: it goes back to step 3.
      if (overtaken(r)) return load();
      err.textContent = errText(r, 'Could not finish setup');
    },
  });
}

load();
