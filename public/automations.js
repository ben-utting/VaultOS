'use strict';

// ========================================================================
// Automations mode (window.Automations): the automations on the left, the
// runs on the right (or one run's detail), and the builder panel. Data comes
// from /api/automations (lib/automation-service.js). It polls every 3 s while
// the tab is open or a run is going, and every 30 s otherwise while the
// feature is on, so the tab dot and the card pills notice a scheduled run.
// Uses app.js's globals: $, esc, api, toast, openTask, setMode, ME, safeHtml.
// ========================================================================

(function () {
  const AC = window.AutomationCore;
  const AU = {
    data: null,          // the last GET /api/automations
    runs: [],            // the runs feed, newest first
    more: false,         // whether "Show older" has more to fetch
    filter: '',          // automation id, or '' for all
    openRun: null,       // run id whose detail is showing
    visible: false,
    timer: null,
    lastCurrent: null,   // run id that was running at the last poll
  };
  const FAST_MS = 3000;
  const SLOW_MS = 30000;
  const RUN_PAGE = 30;
  const TRIGGER = { 'schedule': 'scheduled', 'catch-up': 'catch-up', 'manual': 'run now' };
  const CARD_STATE = {
    noted: ['Noted', 'ok'], skipped: ['Skipped', 'plain'], failed: ['Failed', 'bad'], 'timed-out': ['Timed out', 'bad'],
    'not-run': ['Not run', 'plain'], moved: ['Moved', 'plain'], running: ['Running', 'live'], waiting: ['Waiting', 'plain'],
  };
  const tz = () => (AU.data ? AU.data.timezone : 'UTC');
  const when = (iso) => (iso ? AC.whenText(Date.parse(iso), Date.now(), tz()) : '');
  const boardLabel = (key) => {
    const b = (typeof WORKSPACE_LIST !== 'undefined' ? WORKSPACE_LIST : []).find((w) => w.key === key);
    return b ? b.label : key;
  };
  const markFor = (agent) => {
    const id = agent === 'default' ? (AU.data && AU.data.defaultAgent) || 'none' : agent;
    return window.AgentMarks ? AgentMarks.svg(id) : '';
  };

  // ---------- Polling ----------
  async function poll() {
    clearTimeout(AU.timer);
    AU.timer = null;
    if (!automationsOn()) return;
    try {
      AU.data = await api('/api/automations');
    } catch {
      schedule();
      return;
    }
    const cur = AU.data.current;
    const curId = cur ? cur.runId || 'starting' : null;
    if (AU.lastCurrent && AU.lastCurrent !== curId && AU.visible) loadRuns();   // a run just ended
    AU.lastCurrent = curId;
    $('mode-automations').querySelector('.mode-dot').classList.toggle('hidden', !cur);
    if (typeof paintCardAgents === 'function') paintCardAgents();
    if (AU.visible) {
      renderList();
      renderCurrent();
      if (AU.openRun && cur && cur.runId === AU.openRun) openRun(AU.openRun, { quiet: true });
    }
    schedule();
  }
  function schedule() {
    clearTimeout(AU.timer);
    if (!automationsOn()) return;
    const fast = AU.visible || (AU.data && AU.data.current);
    AU.timer = setTimeout(poll, fast ? FAST_MS : SLOW_MS);
  }

  // ---------- The automations list ----------
  function renderList() {
    const d = AU.data;
    if (!d) return;
    $('au-off').classList.toggle('hidden', d.live);
    $('au-new').disabled = !d.live;
    $('count').textContent = `${d.automations.length} automation${d.automations.length === 1 ? '' : 's'}`;
    if (!d.automations.length) {
      $('au-list').innerHTML = `<div class="au-empty">
        <p>Automations run an agent on your cards on a schedule and write what it found into each card.</p>
        <button type="button" class="su-btn primary" id="au-first"${d.live ? '' : ' disabled'}>Create the morning check-in</button></div>`;
      $('au-first').addEventListener('click', () => openBuilder(null, { name: 'Morning check-in' }));
    } else {
      $('au-list').innerHTML = d.automations.map(rowHtml).join('');
    }
    renderFilter();
  }
  function rowHtml(a) {
    const last = a.lastRun;
    let lastLine = '<span class="au-last muted">Not run yet</span>';
    if (last && last.state === 'failed') {
      lastLine = `<span class="au-last bad"><span class="au-dot" data-tone="bad"></span>Last run failed: ${esc(AC.failureText(last))}</span>`;
    } else if (last) {
      lastLine = `<span class="au-last"><span class="au-dot" data-tone="${AC.lastRunTone(last)}"></span>Last run ${esc(when(last.startedAt))} · ${esc(AC.runSummary(last))}</span>`;
    }
    const runLabel = a.running ? 'Running' : a.queued ? 'Queued' : 'Run now';
    return `<div class="au-row${a.enabled ? '' : ' is-off'}" data-id="${esc(a.id)}">
      <input type="checkbox" class="su-switch au-toggle" role="switch" aria-label="${esc(a.name)} on"${a.enabled ? ' checked' : ''}${AU.data.live ? '' : ' disabled'}>
      <button type="button" class="au-row-main" title="Edit ${esc(a.name)}">
        <span class="au-row-top"><span class="au-mark">${markFor(a.agent)}</span><span class="au-name">${esc(a.name)}</span></span>
        <span class="au-meta">${esc(a.scheduleText)} · ${esc(AC.cardsText(a.cards, boardLabel(a.cards.board)))} · ${esc(AC.LEVEL_LABEL[a.level])}</span>
        <span class="au-next">${a.nextRun ? `Next: ${esc(when(a.nextRun))}` : 'Off'}</span>
        ${lastLine}
      </button>
      <button type="button" class="su-btn su-sm au-run-now"${a.running || a.queued || !AU.data.live ? ' disabled' : ''}>${runLabel}</button>
    </div>`;
  }
  $('au-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.au-row');
    if (!row) return;
    const a = AU.data.automations.find((x) => x.id === row.dataset.id);
    if (!a) return;
    if (e.target.closest('.au-run-now')) {
      e.target.disabled = true;
      try { await api(`/api/automations/${a.id}/run`, { method: 'POST' }); } catch (err) { toast(err.message); }
      poll();
    } else if (e.target.closest('.au-row-main')) {
      openBuilder(a);
    }
  });
  $('au-list').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('au-toggle')) return;
    const row = e.target.closest('.au-row');
    const a = AU.data.automations.find((x) => x.id === row.dataset.id);
    if (!a) return;
    try {
      await api(`/api/automations/${a.id}`, { method: 'PUT', body: JSON.stringify({ ...definition(a), enabled: e.target.checked }) });
    } catch (err) {
      toast(err.message);
      e.target.checked = !e.target.checked;
    }
    poll();
  });
  $('au-new').addEventListener('click', () => openBuilder(null));
  // Only the fields an automation is saved with (the list adds scheduleText, nextRun and the like).
  function definition(a) {
    const { name, enabled, agent, template, prompt, level, cards, schedule, section, timeLimitMin } = a;
    return { name, enabled, agent, template, prompt, level, cards, schedule, section, timeLimitMin };
  }

  // ---------- Runs ----------
  function renderFilter() {
    const sel = $('au-filter');
    const want = ['', ...AU.data.automations.map((a) => a.id)].join('|');
    if (sel.dataset.ids !== want) {
      sel.innerHTML = '<option value="">All</option>' + AU.data.automations.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      sel.dataset.ids = want;
    }
    sel.value = AU.filter;
  }
  $('au-filter').addEventListener('change', (e) => { AU.filter = e.target.value; loadRuns(); });
  async function loadRuns({ older = false } = {}) {
    const before = older && AU.runs.length ? AU.runs[AU.runs.length - 1].id : '';
    const q = new URLSearchParams({ limit: String(RUN_PAGE) });
    if (AU.filter) q.set('automation', AU.filter);
    if (before) q.set('before', before);
    let runs;
    try { runs = (await api(`/api/automations/runs?${q}`)).runs; } catch (err) { toast(err.message); return; }
    AU.runs = older ? AU.runs.concat(runs) : runs;
    AU.more = runs.length === RUN_PAGE;
    renderRuns();
  }
  function renderCurrent() {
    const cur = AU.data && AU.data.current;
    const el = $('au-current');
    el.classList.toggle('hidden', !cur || !!AU.openRun);
    if (!cur) { el.innerHTML = ''; return; }
    const step = cur.index >= 0 ? ` · card ${cur.index + 1}/${cur.total}` : ' · starting';
    el.innerHTML = `<span class="agent-dot" data-agent="working"></span>
      <button type="button" class="au-current-t"${cur.runId ? '' : ' disabled'}>Running: ${esc(cur.automationName || '…')}${esc(step)}</button>
      ${cur.card ? `<span class="au-current-card">“${esc(cur.card.title)}”</span>` : ''}
      <button type="button" class="su-btn su-sm au-stop">Stop</button>`;
  }
  $('au-current').addEventListener('click', async (e) => {
    if (e.target.closest('.au-stop')) {
      e.target.disabled = true;
      try { await api('/api/automations/stop', { method: 'POST' }); } catch (err) { toast(err.message); }
      poll();
    } else if (e.target.closest('.au-current-t') && AU.data.current && AU.data.current.runId) {
      openRun(AU.data.current.runId);
    }
  });
  function renderRuns() {
    const done = AU.runs.filter((r) => r.state !== 'running');
    if (!done.length) {
      $('au-runs').innerHTML = `<p class="au-none">${AU.data && AU.data.automations.length ? 'No runs yet. Run now starts one straight away.' : 'Runs show up here.'}</p>`;
      return;
    }
    $('au-runs').innerHTML = done.map((r) => `<button type="button" class="au-run-item" data-run="${esc(r.id)}">
        <span class="au-run-when">${esc(when(r.startedAt))} · ${esc(r.automationName)}</span>
        <span class="au-run-sum"><span class="au-dot" data-tone="${AC.lastRunTone(r)}"></span>${esc(r.state === 'failed' ? `Failed: ${AC.failureText(r)}` : AC.runSummary(r))}${r.state === 'stopped' ? ' · stopped' : r.state === 'interrupted' ? ' · interrupted' : ''}</span>
      </button>`).join('') + (AU.more ? '<button type="button" class="su-btn su-sm au-older">Show older</button>' : '');
  }
  $('au-runs').addEventListener('click', (e) => {
    if (e.target.closest('.au-older')) { loadRuns({ older: true }); return; }
    const item = e.target.closest('.au-run-item');
    if (item) openRun(item.dataset.run);
  });

  // ---------- One run ----------
  async function openRun(id, { quiet = false } = {}) {
    let run;
    try { run = await api(`/api/automations/runs/${encodeURIComponent(id)}`); } catch (err) { if (!quiet) toast(err.message); return; }
    AU.openRun = id;
    $('au-runs').classList.add('hidden');
    $('au-runs-head').classList.add('hidden');
    $('au-current').classList.add('hidden');
    const el = $('au-run');
    el.classList.remove('hidden');
    const meta = [when(run.startedAt), AC.runSummary(run), TRIGGER[run.trigger] || run.trigger].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="au-run-head">
        <button type="button" class="ghost au-back" aria-label="Back to the runs"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <div><h2>${esc(run.automationName)}</h2><p class="au-run-meta">${esc(meta)}${run.state === 'stopped' ? ' · stopped' : run.state === 'interrupted' ? ' · interrupted by a restart' : ''}</p></div>
      </div>
      ${run.cards.length ? run.cards.map((c) => cardHtml(c, run)).join('') : '<p class="au-none">No cards matched.</p>'}`;
    if (!quiet) el.scrollIntoView({ block: 'nearest' });
  }
  function closeRun() {
    AU.openRun = null;
    $('au-run').classList.add('hidden');
    $('au-run').innerHTML = '';
    $('au-runs').classList.remove('hidden');
    $('au-runs-head').classList.remove('hidden');
    renderCurrent();
  }
  function cardHtml(c, run) {
    const [label, tone] = CARD_STATE[c.state] || [c.state, 'plain'];
    const warn = [];
    if (c.filesChanged && c.filesChanged.length) {
      warn.push(run.level === 'work'
        ? ['plain', `Files it changed: ${c.filesChanged.join(', ')}`]
        : ['bad', `Files changed during a read-only run: ${c.filesChanged.join(', ')}`]);
    }
    if (c.statusChange) warn.push(['warn', `Status changed: ${AC.STATUS_LABEL[c.statusChange.from] || c.statusChange.from} → ${AC.STATUS_LABEL[c.statusChange.to] || c.statusChange.to}`]);
    if (c.proposalIgnored) warn.push(['plain', 'Status proposal ignored: you changed it during the run']);
    if (c.doneReverted) warn.push(['warn', `Done was put back to ${AC.STATUS_LABEL[c.statusBefore] || c.statusBefore || 'its status'}`]);
    if (c.ignored && c.ignored.length) warn.push(['plain', `Ignored: ${c.ignored.join(', ')}`]);
    const body = c.noteHtml ? `<div class="au-note markdown">${safeHtml(c.noteHtml)}</div>` : (c.reason ? `<p class="au-reason">${esc(c.reason)}</p>` : '');
    return `<article class="au-card">
      <div class="au-card-head">
        <button type="button" class="au-card-t" data-path="${esc(c.path)}" data-board="${esc(c.board || '')}">${esc(c.title)}</button>
        <span class="au-chip" data-tone="${tone}">${esc(label)}</span>
        ${c.durationMs ? `<span class="au-dur">${esc(fmtDuration(c.durationMs))}</span>` : ''}
      </div>
      ${body}
      ${warn.map(([t, text]) => `<p class="au-warn" data-tone="${t}">${esc(text)}</p>`).join('')}
      ${c.outputTail ? `<details class="au-output"><summary>Output</summary><pre>${esc(c.outputTail)}</pre></details>` : ''}
    </article>`;
  }
  const fmtDuration = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);
  $('au-run').addEventListener('click', (e) => {
    if (e.target.closest('.au-back')) { closeRun(); return; }
    const t = e.target.closest('.au-card-t');
    if (t) openCard(t.dataset.path, t.dataset.board);
  });
  // A card on another board: switch the workspace first, so the drawer's reads and writes go to its board.
  function openCard(path, board) {
    if (board && STATE.workspace !== board) setWorkspace(board);
    openTask(path);
  }

  // ---------- The builder ----------
  // A right-hand panel over the page. B.editing is the automation being edited (null for a new one);
  // nothing is saved until Save. The server's checks are the real ones; validateAutomation gives the same
  // answers first, beside the fields.
  const B = { editing: null, matchTimer: null, matchSeq: 0, template: 'check-in' };
  const FIELD_OF = {
    name: 'ab-name', agent: 'ab-agent', level: 'ab-level', template: 'ab-template', prompt: 'ab-prompt', board: 'ab-board',
    statuses: 'ab-statuses', subtasks: 'ab-subtasks', schedule: 'ab-schedule', section: 'ab-section', timeLimitMin: 'ab-limit', enabled: 'ab',
  };
  const INPUT_FIELDS = new Set(['ab-name', 'ab-prompt', 'ab-section', 'ab-limit', 'ab-board', 'ab-template']);
  const defaults = () => ({
    name: '', enabled: true, agent: 'default', template: 'check-in', prompt: AC.TEMPLATES['check-in'].prompt, level: 'report',
    cards: { board: (typeof STATE !== 'undefined' && STATE.workspace) || 'all', statuses: ['in-progress', 'blocked'], subtasks: false },
    schedule: { repeat: 'weekdays', time: '08:00' }, section: 'Latest check-in', timeLimitMin: 10,
  });
  const radio = (group) => { const el = $(group).querySelector('[aria-checked="true"]'); return el ? el.dataset.v : ''; };
  const setRadio = (group, v) => { for (const el of $(group).querySelectorAll('[role="radio"]')) el.setAttribute('aria-checked', String(el.dataset.v === v)); };
  const checkedChips = (group) => [...$(group).querySelectorAll('[aria-pressed="true"]')].map((el) => el.dataset.v);
  const agentChoices = () => {
    const d = AU.data;
    const byId = Object.fromEntries((d ? d.agents : []).map((a) => [a.id, a]));
    const def = d && d.defaultAgent && byId[d.defaultAgent];
    return [
      { v: 'default', label: def ? `Default (${def.label})` : 'Default (none set)', mark: d && d.defaultAgent ? d.defaultAgent : 'none',
        installed: def ? def.installed : false, levels: def ? def.levels : [], none: !def },
      ...(d ? d.agents : []).map((a) => ({ v: a.id, label: a.label, mark: a.id, installed: a.installed, levels: a.levels })),
    ];
  };
  // Why an agent tile can't be picked at this level, or '' when it can.
  function agentBlock(c, level) {
    if (c.none) return 'Pick a default in Settings → Agent';
    if (!c.installed) return 'Not installed';
    if (!c.levels.includes(level)) return c.levels.length ? `Not yet available for ${AC.LEVEL_LABEL[level]}` : 'Not yet available';
    return '';
  }
  function renderAgents(selected) {
    const level = radio('ab-level') || 'report';
    $('ab-agent').innerHTML = agentChoices().map((c) => {
      const why = agentBlock(c, level);
      return `<button type="button" role="radio" class="ab-tile" data-v="${esc(c.v)}" aria-checked="${c.v === selected}"${why ? ' aria-disabled="true"' : ''}>
        <span class="ab-tile-mark">${window.AgentMarks ? AgentMarks.svg(c.mark) : ''}</span>
        <span class="ab-tile-t">${esc(c.label)}</span>${why ? `<span class="ab-tile-why">${esc(why)}</span>` : ''}</button>`;
    }).join('');
  }
  function renderLevels(selected) {
    $('ab-level').innerHTML = AC.LEVELS.map((l) => `<button type="button" role="radio" class="ab-level" data-v="${l}" aria-checked="${l === selected}">
      <span class="ab-level-t">${esc(AC.LEVEL_LABEL[l])}</span><span class="ab-level-d">${esc(AC.LEVEL_TEXT[l])}</span></button>`).join('');
  }
  function renderAdds() {
    const level = radio('ab-level') || 'report';
    const name = $('ab-name').value.trim() || '<name>';
    $('ab-adds').textContent = [
      `You are running unattended for the VaultOS automation "${name}". Nobody is watching: don't ask questions, don't wait for input.`,
      'Today is <date> (<time zone>). Card: "<title>", status <status>, last updated <date>.',
      'Its folder is your working directory.',
      AC.LEVEL_PARAGRAPHS[level],
      "Here is the card's task.md:",
      '----- task.md -----', '(the card\'s task.md)', '----- end of task.md -----',
      '', '(your prompt)', '',
      level === 'update' ? '(how to end with a vaultos-update block, if the card should move, and a vaultos-note block)' : '(how to end with a vaultos-note block: at most 1,500 characters)',
    ].join('\n');
  }
  const promptCount = () => { $('ab-prompt-n').textContent = `${$('ab-prompt').value.length.toLocaleString('en-GB')} / 8,000`; };
  function scheduleFromForm() {
    const repeat = $('ab-repeat').value;
    if (repeat === 'hours') return { repeat, every: Number($('ab-every').value), from: $('ab-from').value };
    if (repeat === 'weekly') return { repeat, days: checkedChips('ab-days'), time: $('ab-time').value };
    return { repeat, time: $('ab-time').value };
  }
  function syncRepeat() {
    const r = $('ab-repeat').value;
    $('ab-time-f').classList.toggle('hidden', r === 'hours');
    $('ab-every-f').classList.toggle('hidden', r !== 'hours');
    $('ab-from-f').classList.toggle('hidden', r !== 'hours');
    $('ab-days-f').classList.toggle('hidden', r !== 'weekly');
    const s = scheduleFromForm();
    const ok = AC.validateAutomation({ ...defaults(), schedule: s }, { boardKeys: [], agentIds: ['default'] });
    const bad = ok.errors && ok.errors.schedule;
    const next = bad ? null : AC.nextSlot(s, tz(), Date.now());
    $('ab-next').textContent = next ? `Next run: ${AC.whenText(next, Date.now(), tz())} (${tz()})` : '';
  }
  function formValue() {
    return {
      name: $('ab-name').value, enabled: B.editing ? B.editing.enabled : (B.enabled !== undefined ? B.enabled : true),
      agent: radio('ab-agent'), template: $('ab-template').value, prompt: $('ab-prompt').value, level: radio('ab-level'),
      cards: { board: $('ab-board').value, statuses: checkedChips('ab-statuses'), subtasks: $('ab-subtasks').checked },
      schedule: scheduleFromForm(), section: $('ab-section').value, timeLimitMin: Number($('ab-limit').value),
    };
  }
  function clearErrors() {
    for (const id of Object.values(FIELD_OF)) {
      const err = $(`${id}-err`);
      if (err) err.textContent = '';
      if (INPUT_FIELDS.has(id)) $(id).removeAttribute('aria-invalid');
    }
  }
  function showErrors(errors) {
    let first = null;
    for (const [k, msg] of Object.entries(errors)) {
      const id = FIELD_OF[k] || 'ab';
      const err = $(`${id}-err`);
      if (err) err.textContent = msg;
      if (INPUT_FIELDS.has(id)) $(id).setAttribute('aria-invalid', 'true');
      if (!first) first = id;
    }
    if (first && $(first)) {
      if (first === 'ab-section' || first === 'ab-limit') document.querySelector('.ab-more').open = true;
      $(first).scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (INPUT_FIELDS.has(first)) $(first).focus({ preventScroll: true });
    }
  }
  function refreshMatch() {
    clearTimeout(B.matchTimer);
    B.matchTimer = setTimeout(async () => {
      const seq = ++B.matchSeq;
      const statuses = checkedChips('ab-statuses');
      if (!statuses.length) { $('ab-match').textContent = ''; return; }
      const q = new URLSearchParams({ board: $('ab-board').value, statuses: statuses.join(','), subtasks: $('ab-subtasks').checked ? '1' : '0' });
      let m;
      try { m = await api(`/api/automations/match?${q}`); } catch { return; }
      if (seq !== B.matchSeq) return;
      const titles = m.titles.slice(0, 5);
      $('ab-match').innerHTML = `<p class="ab-match-n">${m.count ? `Matches ${m.count} card${m.count === 1 ? '' : 's'} right now` : 'Matches no cards right now'}</p>`
        + (titles.length ? `<ul class="ab-match-list">${titles.map((t) => `<li>${esc(t)}</li>`).join('')}${m.count > titles.length ? `<li class="muted">and ${m.count - titles.length} more</li>` : ''}</ul>` : '')
        + (m.count > AC.MAX_CARDS ? `<p class="ab-match-warn">Only the first ${AC.MAX_CARDS} run each time.</p>` : '');
    }, 300);
  }

  function openBuilder(a, { copy = false, name = '' } = {}) {
    if (!AU.data) { poll().then(() => { if (AU.data) openBuilder(a, { copy, name }); }); return; }
    const v = a ? definition(a) : defaults();
    if (!a && name) v.name = name;
    if (copy) { v.name = `${v.name} (copy)`.slice(0, AC.NAME_MAX); v.enabled = false; }
    B.editing = a && !copy ? a : null;
    B.enabled = v.enabled;
    B.template = v.template;
    $('ab-title').textContent = B.editing ? 'Edit automation' : 'New automation';
    $('ab-name').value = v.name;
    renderLevels(v.level);
    renderAgents(v.agent);
    $('ab-template').innerHTML = Object.entries(AC.TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('');
    $('ab-template').value = v.template;
    $('ab-prompt').value = v.prompt;
    promptCount();
    const boards = (typeof WORKSPACE_LIST !== 'undefined' ? WORKSPACE_LIST : []);
    const boardOpts = [{ key: 'all', label: 'All boards' }, ...boards];
    if (!boardOpts.some((b) => b.key === v.cards.board)) boardOpts.push({ key: v.cards.board, label: v.cards.board });
    $('ab-board').innerHTML = boardOpts.map((b) => `<option value="${esc(b.key)}">${esc(b.label)}</option>`).join('');
    $('ab-board').value = v.cards.board;
    $('ab-subtasks').checked = v.cards.subtasks;
    $('ab-statuses').innerHTML = AC.CARD_STATUSES.map((st) => `<button type="button" class="ab-chip" data-v="${st}" aria-pressed="${v.cards.statuses.includes(st)}">${esc(AC.STATUS_LABEL[st])}</button>`).join('');
    $('ab-repeat').value = v.schedule.repeat;
    $('ab-time').value = v.schedule.time || '08:00';
    $('ab-every').innerHTML = AC.HOURS_EVERY.map((n) => `<option value="${n}">${n === 1 ? 'hour' : `${n} hours`}</option>`).join('');
    $('ab-every').value = String(v.schedule.every || 4);
    $('ab-from').value = v.schedule.from || '08:00';
    $('ab-days').innerHTML = AC.DAYS.map((d) => `<button type="button" class="ab-chip" data-v="${d}" aria-pressed="${(v.schedule.days || ['mon']).includes(d)}">${AC.DAY_LABEL[d]}</button>`).join('');
    $('ab-section').value = v.section;
    $('ab-limit').value = String(v.timeLimitMin);
    document.querySelector('.ab-more').open = false;
    document.querySelector('.ab-adds').open = false;
    $('ab-delete').classList.toggle('hidden', !B.editing);
    $('ab-dup').classList.toggle('hidden', !B.editing);
    for (const b of [$('ab-save'), $('ab-save-run')]) b.disabled = false;
    clearErrors();
    syncRepeat();
    renderAdds();
    refreshMatch();
    $('au-builder').classList.remove('hidden');
    $('au-scrim').classList.remove('hidden');
    $('au-builder').scrollTop = 0;
    $('ab-name').focus({ preventScroll: true });
  }
  function closeBuilder() {
    $('au-builder').classList.add('hidden');
    $('au-scrim').classList.add('hidden');
    B.editing = null;
  }
  async function save({ run = false } = {}) {
    clearErrors();
    const value = formValue();
    const d = AU.data;
    const choice = agentChoices().find((c) => c.v === value.agent);
    const boardKeys = [...$('ab-board').options].map((o) => o.value).filter((k) => k !== 'all');
    const check = AC.validateAutomation(value, { boardKeys, agentIds: agentChoices().map((c) => c.v) });
    const errors = check.ok ? {} : { ...check.errors };
    if (!value.agent) errors.agent = 'Pick an agent';
    else if (choice && agentBlock(choice, value.level || 'report')) errors.agent = `${choice.label}: ${agentBlock(choice, value.level || 'report')}`;
    if (Object.keys(errors).length) { showErrors(errors); return; }
    for (const b of [$('ab-save'), $('ab-save-run')]) b.disabled = true;
    try {
      const url = B.editing ? `/api/automations/${B.editing.id}` : '/api/automations';
      const res = await fetch(url, { method: B.editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(check.value) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && body.errors) { showErrors(body.errors); return; }
      if (!res.ok) throw new Error(body.error || res.statusText);
      if (run) {
        try { await api(`/api/automations/${body.automation.id}/run`, { method: 'POST' }); } catch (err) { toast(err.message); }
      }
      closeBuilder();
      if (!d || d.automations.length === 0) AU.filter = '';
      await poll();
      loadRuns();
    } catch (err) {
      $('ab-err').textContent = err.message;
    } finally {
      for (const b of [$('ab-save'), $('ab-save-run')]) b.disabled = false;
    }
  }

  $('ab-agent').addEventListener('click', (e) => {
    const t = e.target.closest('.ab-tile');
    if (!t || t.getAttribute('aria-disabled') === 'true') return;
    setRadio('ab-agent', t.dataset.v);
    $('ab-agent-err').textContent = '';
  });
  $('ab-level').addEventListener('click', (e) => {
    const t = e.target.closest('.ab-level');
    if (!t) return;
    setRadio('ab-level', t.dataset.v);
    renderAgents(radio('ab-agent'));
    renderAdds();
    $('ab-level-err').textContent = '';
  });
  // Arrow keys move along a radio group, as a native radio set does.
  for (const id of ['ab-agent', 'ab-level']) {
    $(id).addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
      const items = [...$(id).querySelectorAll('[role="radio"]:not([aria-disabled="true"])')];
      const at = items.indexOf(document.activeElement);
      if (at === -1) return;
      e.preventDefault();
      const next = items[(at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
      next.focus();
      next.click();
    });
  }
  for (const id of ['ab-statuses', 'ab-days']) {
    $(id).addEventListener('click', (e) => {
      const c = e.target.closest('.ab-chip');
      if (!c) return;
      c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true'));
      if (id === 'ab-statuses') { $('ab-statuses-err').textContent = ''; refreshMatch(); } else syncRepeat();
    });
  }
  $('ab-template').addEventListener('change', (e) => {
    const next = e.target.value;
    const cur = $('ab-prompt').value;
    const untouched = !cur.trim() || cur === AC.TEMPLATES[B.template].prompt;
    if (!untouched && !window.confirm(`Replace your prompt with the ${AC.TEMPLATES[next].label} template?`)) {
      e.target.value = B.template;
      return;
    }
    B.template = next;
    $('ab-prompt').value = AC.TEMPLATES[next].prompt;
    promptCount();
  });
  $('ab-prompt').addEventListener('input', promptCount);
  $('ab-name').addEventListener('input', renderAdds);
  for (const id of ['ab-board', 'ab-subtasks']) $(id).addEventListener('change', refreshMatch);
  for (const id of ['ab-repeat', 'ab-time', 'ab-every', 'ab-from']) $(id).addEventListener('input', syncRepeat);
  $('ab-repeat').addEventListener('change', syncRepeat);
  $('ab-save').addEventListener('click', () => save());
  $('ab-save-run').addEventListener('click', () => save({ run: true }));
  $('ab-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('ab-close').addEventListener('click', closeBuilder);
  $('au-scrim').addEventListener('click', closeBuilder);
  $('ab-dup').addEventListener('click', () => { if (B.editing) openBuilder(B.editing, { copy: true }); });
  $('ab-delete').addEventListener('click', async () => {
    const a = B.editing;
    if (!a || !window.confirm(`Delete "${a.name}"? Its run history stays until it ages out.`)) return;
    try { await api(`/api/automations/${a.id}`, { method: 'DELETE' }); } catch (err) { $('ab-err').textContent = err.message; return; }
    if (AU.filter === a.id) AU.filter = '';
    closeBuilder();
    await poll();
    loadRuns();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('au-builder').classList.contains('hidden')) { e.stopPropagation(); closeBuilder(); }
  }, true);

  // ---------- The mode ----------
  window.Automations = {
    show() {
      AU.visible = true;
      if (AU.data) { renderList(); renderCurrent(); }
      poll();
      loadRuns();
    },
    hide() {
      AU.visible = false;
      schedule();
    },
    // Settings changed what is on (applyMe): start or stop polling.
    featureChanged() {
      if (automationsOn()) { if (!AU.timer) poll(); } else { clearTimeout(AU.timer); AU.timer = null; AU.data = null; }
    },
    openRun(id) { openRun(id); },
    current: () => (AU.data && AU.data.current) || null,
    poll,
    openBuilder,
    _state: AU,
  };
})();
