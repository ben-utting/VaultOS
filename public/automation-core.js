'use strict';

// ========================================================================
// AutomationCore — the parts of Automations that the browser (the builder,
// the list) and the server (the scheduler, validation) must answer the same
// way (window.AutomationCore; also a Node module for lib/ and the tests).
// Schedules are wall-clock times in one IANA time zone; slots are epoch ms.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.AutomationCore = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_MS = 86400000;
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const HOURS_EVERY = [1, 2, 3, 4, 6, 8, 12];

  // ---------- Time zones ----------
  const fmtCache = new Map();
  function partsFmt(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      fmtCache.set(tz, f);
    }
    return f;
  }
  // The wall clock in tz at instant ms: { y, mo, d, h, mi, s }.
  function wallParts(ms, tz) {
    const p = {};
    for (const x of partsFmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
    return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
  }
  // tz's offset from UTC at instant ms, in ms (positive east of Greenwich).
  function offsetAt(ms, tz) {
    const w = wallParts(ms, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  }
  // The instant the wall clock in tz reads y-mo-d h:mi. A time that happens twice (clocks going back)
  // gives the first; a time that never happens (clocks going forward) gives the instant just after the
  // gap, read with the offset from before it (01:30 on a spring-forward night runs at 02:30).
  function wallToUtc(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const before = offsetAt(guess - DAY_MS, tz);
    const after = offsetAt(guess + DAY_MS, tz);
    const hits = [...new Set([before, after])].map((o) => guess - o).filter((t) => {
      const w = wallParts(t, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    });
    return hits.length ? Math.min(...hits) : guess - before;
  }

  // ---------- Schedules ----------
  const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  // Minutes after midnight at which the schedule fires on a day it fires at all.
  function timesOf(s) {
    if (s.repeat !== 'hours') return [hm(s.time)];
    const step = s.every * 60;
    const out = new Set();
    for (let k = 0; k < 1440 / step; k++) out.add((hm(s.from) + k * step) % 1440);
    return [...out].sort((a, b) => a - b);
  }
  // Whether the schedule fires on this calendar day (weekday 0 = Sunday, as Date.getUTCDay).
  function firesOn(s, weekday) {
    if (s.repeat === 'weekdays') return weekday >= 1 && weekday <= 5;
    if (s.repeat === 'weekly') return s.days.includes(DAYS[(weekday + 6) % 7]);
    return true;
  }
  // Every slot on the local calendar days start..end (offsets from the local date of ms), ascending.
  function slotsAround(s, tz, ms, start, end) {
    const w = wallParts(ms, tz);
    const out = [];
    for (let k = start; k <= end; k++) {
      const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + k));
      if (!firesOn(s, day.getUTCDay())) continue;
      for (const min of timesOf(s)) {
        out.push(wallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(min / 60), min % 60, tz));
      }
    }
    return out.sort((a, b) => a - b);
  }
  // The latest slot at or before atMs, or null (a weekly schedule with no days never fires).
  function lastSlot(s, tz, atMs) {
    const past = slotsAround(s, tz, atMs, -8, 1).filter((t) => t <= atMs);
    return past.length ? past[past.length - 1] : null;
  }
  // The earliest slot after afterMs, or null.
  function nextSlot(s, tz, afterMs) {
    const next = slotsAround(s, tz, afterMs, -1, 8).find((t) => t > afterMs);
    return next === undefined ? null : next;
  }
  function describeSchedule(s) {
    if (s.repeat === 'daily') return `Every day ${s.time}`;
    if (s.repeat === 'weekdays') return `Weekdays ${s.time}`;
    if (s.repeat === 'weekly') return `${DAYS.filter((d) => s.days.includes(d)).map((d) => DAY_LABEL[d]).join(', ')} ${s.time}`;
    return `Every ${s.every === 1 ? 'hour' : `${s.every} hours`} from ${s.from}`;
  }

  // ---------- Definitions ----------
  const LEVELS = ['report', 'update', 'work'];
  // What a run covers (spec 2026-11-25): one agent per matching card, or one agent per run that only proposes new cards.
  const RUNS_ON = ['cards', 'once'];
  const RUNS_ON_LABEL = { cards: 'Each matching card', once: 'Once' };
  // New cards a Work automation may propose (VaultOS writes them, spec 2026-11-25 §5–§6).
  const NEW_CARDS_DEFAULT = 5;
  const NEW_CARDS_LIMIT = 10;
  const NEW_CARDS_PER_HOUR = 30;
  const NEW_FOLDER_MAX = 200;
  const CARD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
  const CARD_STATUSES = ['backlog', 'in-progress', 'blocked', 'needs-decision', 'review', 'scheduled'];
  const STATUS_LABEL = {
    'backlog': 'Backlog', 'in-progress': 'In Progress', 'blocked': 'Blocked', 'needs-decision': 'Needs Decision',
    'review': 'Review', 'scheduled': 'Scheduled', 'done': 'Done',
  };
  // A card's own sections: an automation may never be pointed at one, so a typo can't wipe the Plan.
  const RESERVED_SECTIONS = ['goal', 'context / key facts', 'context', 'plan', 'progress log', 'findings / decisions', 'findings', 'comments', 'subtasks'];
  const MAX_CARDS = 20;
  const TRIAL_CARDS = 3;   // a trial (spec §5.3) looks at this many cards at most
  const NOTE_MAX = 1500;
  const PROMPT_MAX = 8000;
  const NAME_MAX = 60;
  const MODEL_MAX = 200;
  // A model id goes on the agent's command line, so it's one line with no control characters, and it can't
  // start with "-" (no model id does, and it must never read as another option).
  const MODEL_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const SECTION_RE = /^[A-Za-z0-9 -]{1,40}$/;

  const TEMPLATES = {
    'check-in': {
      label: 'Check-in',
      prompt: [
        "Look at this card and tell me where it stands. Read task.md and any files in this folder that help (notes, data, drafts). Don't do any of the work.",
        '',
        'Write your note as a short list of three items:',
        '- **Where it stands:** one or two sentences.',
        '- **Next step:** the one next action, and who does it.',
        '- **Waiting on you:** what I need to decide or do, or "Nothing".',
        '',
        'If the card already has a Latest check-in, compare with it and say plainly if nothing has moved.',
      ].join('\n'),
    },
    blank: { label: 'Blank', prompt: '' },
  };
  const LEVEL_LABEL = { report: 'Report', update: 'Update', work: 'Work' };
  const LEVEL_TEXT = {
    report: 'Reads the card and writes a note. Changes nothing else.',
    update: 'Can also move the card (never to Done).',
    work: "Can edit files in the card's folder and create new cards.",
  };
  const REPORT_PARAGRAPH = "You can read and search files. Don't try to change anything: VaultOS writes your note into the card.";
  const LEVEL_PARAGRAPHS = {
    report: REPORT_PARAGRAPH,
    update: `${REPORT_PARAGRAPH} You may propose a status change in a vaultos-update block.`,
    work: "You may edit files in this card's folder. Don't run shell commands and don't set the card to done. VaultOS writes your note into the card.",
  };
  const ONCE_PARAGRAPH = "There is no card in this run. You can read and search files and look things up, but don't try to change anything: VaultOS creates the cards you propose and keeps your note in the run history.";

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  function validSchedule(s) {
    if (!isObj(s)) return null;
    if (s.repeat === 'daily' || s.repeat === 'weekdays') return TIME_RE.test(s.time) ? { repeat: s.repeat, time: s.time } : null;
    if (s.repeat === 'weekly') {
      if (!TIME_RE.test(s.time) || !Array.isArray(s.days)) return null;
      const days = DAYS.filter((d) => s.days.includes(d));
      if (!days.length || s.days.some((d) => !DAYS.includes(d))) return null;
      return { repeat: 'weekly', days, time: s.time };
    }
    if (s.repeat === 'hours') {
      return HOURS_EVERY.includes(s.every) && TIME_RE.test(s.from) ? { repeat: 'hours', every: s.every, from: s.from } : null;
    }
    return null;
  }

  // A destination folder relative to the board's root: trimmed, outer slashes dropped, '' for the root. null when it
  // could name something outside the board (empty, '.' or '..' segments, backslashes, control characters, too long).
  function normalFolder(folder) {
    if (typeof folder !== 'string') return null;
    const f = folder.trim().replace(/^\/+|\/+$/g, '');
    if (f.length > NEW_FOLDER_MAX || /[\\\u0000-\u001f\u007f]/.test(f)) return null;
    if (f === '') return '';
    return f.split('/').every((seg) => seg.trim() !== '' && seg !== '.' && seg !== '..') ? f : null;
  }
  // newCards → { value } | { error } | { value: null } when absent. Whether the folder exists is the server's
  // check (ctx.newCardsFolderError), asked only once the shape is right.
  function validNewCards(nc, ctx) {
    if (nc === undefined || nc === null) return { value: null };
    if (!isObj(nc)) return { error: 'Pick where new cards go' };
    if (!ctx.boardKeys.includes(nc.board)) return { error: 'Pick a board for new cards' };
    const folder = normalFolder(nc.folder);
    if (folder === null) return { error: 'Pick a folder inside the board' };
    const max = nc.max === undefined || nc.max === null ? NEW_CARDS_DEFAULT : nc.max;
    if (!Number.isInteger(max) || max < 1 || max > NEW_CARDS_LIMIT) return { error: `New cards per run: 1 to ${NEW_CARDS_LIMIT}` };
    const missing = typeof ctx.newCardsFolderError === 'function' ? ctx.newCardsFolderError(nc.board, folder) : null;
    if (missing) return { error: missing };
    return { value: { board: nc.board, folder, max } };
  }

  // The builder and the server both run this; the server's answer is the one that counts.
  // ctx: { boardKeys: board keys from settings, agentIds: 'default' plus the agents automations can use }.
  function validateAutomation(input, ctx) {
    const a = isObj(input) ? input : {};
    const c = isObj(a.cards) ? a.cards : {};
    const errors = {};
    const runsOn = a.runsOn === undefined || a.runsOn === null ? 'cards' : a.runsOn;
    if (!RUNS_ON.includes(runsOn)) errors.runsOn = 'Pick each matching card or once';
    const once = runsOn === 'once';
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name || name.length > NAME_MAX) errors.name = `Give it a name of 1 to ${NAME_MAX} characters`;
    const enabled = a.enabled === undefined ? true : a.enabled;
    if (typeof enabled !== 'boolean') errors.enabled = 'Must be on or off';
    if (!ctx.agentIds.includes(a.agent)) errors.agent = 'Pick an agent that can run automations';
    // The model is optional (left out or null: the agent's own default) and isn't checked against a model list.
    let model = '';
    if (a.model !== undefined && a.model !== null) {
      model = typeof a.model === 'string' ? a.model.trim() : '';
      if (typeof a.model !== 'string' || MODEL_BAD.test(a.model) || !model || model.length > MODEL_MAX || model.startsWith('-')) {
        errors.model = `Give a model id of 1 to ${MODEL_MAX} characters on one line, or leave it blank`;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, a.template)) errors.template = 'Unknown template';
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    if (!prompt.trim()) errors.prompt = 'Write what the agent should do';
    else if (prompt.length > PROMPT_MAX) errors.prompt = `Keep it under ${PROMPT_MAX.toLocaleString('en-GB')} characters`;
    if (!LEVELS.includes(a.level)) errors.level = 'Pick Report, Update or Work';
    else if (once && a.level !== 'work') errors.level = 'Once runs create cards, so they need Work';
    // A Once run picks no cards and writes into none, so it has no card filter and no section.
    let statuses = [];
    let subtasks = false;
    let section = '';
    if (!once) {
      if (c.board !== 'all' && !ctx.boardKeys.includes(c.board)) errors.board = 'Pick a board';
      statuses = Array.isArray(c.statuses) ? CARD_STATUSES.filter((s) => c.statuses.includes(s)) : [];
      if (!statuses.length || c.statuses.some((s) => !CARD_STATUSES.includes(s))) errors.statuses = 'Pick at least one status (never Done)';
      subtasks = c.subtasks === undefined ? false : c.subtasks;
      if (typeof subtasks !== 'boolean') errors.subtasks = 'Must be on or off';
      section = typeof a.section === 'string' ? a.section.trim() : '';
      if (!SECTION_RE.test(section)) errors.section = 'Use 1 to 40 letters, digits, spaces or hyphens';
      else if (RESERVED_SECTIONS.includes(section.toLowerCase())) errors.section = "That's one of the card's own sections";
    }
    const schedule = validSchedule(a.schedule);
    if (!schedule) errors.schedule = 'Pick when it runs (times as HH:MM)';
    // New cards are a Work permission: at Report or Update the field is dropped unchecked, so a destination left
    // behind (an agent's level change, a folder deleted since) can't block a save.
    const nc = a.level === 'work' ? validNewCards(a.newCards, ctx) : { value: null };
    if (nc.error) errors.newCards = nc.error;
    else if (once && !nc.value) errors.newCards = 'Pick where new cards go';
    if (!Number.isInteger(a.timeLimitMin) || a.timeLimitMin < 2 || a.timeLimitMin > 30) errors.timeLimitMin = 'Between 2 and 30 minutes';
    // With ctx.agentLevels (the server and the builder pass it), the agent must be offered at the level.
    // 'default' is resolved to the current default agent; ctx.agentLevels.default is its levels.
    if (ctx.agentLevels && !errors.agent && !errors.level && !errors.runsOn) {
      const levels = (once ? (ctx.agentOnceLevels || {}) : ctx.agentLevels)[a.agent] || [];
      const labels = ctx.agentLabels || {};
      const onceLevels = (ctx.agentOnceLevels || {})[a.agent] || [];
      if (!levels.length && a.agent === 'default' && !once) errors.agent = 'Pick an agent that can run automations';
      else if (once && !levels.includes(a.level)) {
        const who = a.agent === 'default' ? ctx.defaultAgent : a.agent;
        errors.level = `${(who && (labels[who] || who)) || 'Your default agent'} can't run Once automations`;
      } else if (!levels.includes(a.level) && onceLevels.includes(a.level) && a.agent !== 'default') {
        errors.level = `${labels[a.agent] || a.agent} can't run at ${LEVEL_LABEL[a.level]} on each card; pick Once or another level`;
      } else if (!levels.includes(a.level)) {
        const lvl = LEVEL_LABEL[a.level];
        if (a.agent === 'default') {
          const others = Object.keys(ctx.agentLevels).filter((id) => id !== 'default' && ctx.agentLevels[id].includes(a.level)).map((id) => labels[id] || id);
          const label = labels[ctx.defaultAgent] || ctx.defaultAgent;
          errors.level = `Your default agent (${label}) can't run at ${lvl}; pick ${others.length ? `${others.join(' or ')} or ` : ''}another level`;
        } else errors.level = `${labels[a.agent] || a.agent} can't run at ${lvl}`;
      }
    }
    // Connectors the automation may look things up in, read-only. Absent, null or [] is off. Being signed in is
    // not checked here (spec §3); the agent must be one that can use them.
    let connectors = [];
    if (a.connectors !== undefined && a.connectors !== null) {
      const known = ctx.connectorIds || [];
      if (!Array.isArray(a.connectors) || a.connectors.some((id) => typeof id !== 'string' || !known.includes(id))
        || new Set(a.connectors).size !== a.connectors.length) errors.connectors = 'Pick connectors automations can use';
      else connectors = a.connectors;
    }
    if (connectors.length && !errors.connectors && !errors.agent && ctx.agentConnectors && !ctx.agentConnectors[a.agent]) {
      const labels = ctx.agentLabels || {};
      const who = a.agent === 'default' ? ctx.defaultAgent : a.agent;
      errors.connectors = `${(who && (labels[who] || who)) || 'Your default agent'} can't use connectors in automations yet`;
    }
    // Calendar reminders the agent may propose (a vaultos-remind block). Absent, null or false is off and not
    // stored. Saving doesn't need Calendar on: a run with Calendar off skips the reminder and says why.
    const reminders = a.reminders === undefined || a.reminders === null ? false : a.reminders;
    if (typeof reminders !== 'boolean') errors.reminders = 'Must be on or off';
    else if (once && reminders) errors.reminders = "Once runs can't add calendar reminders";
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        name, enabled, agent: a.agent, ...(model ? { model } : {}), template: a.template, prompt, level: a.level,
        ...(once ? { runsOn: 'once' } : {}), ...(nc.value ? { newCards: nc.value } : {}),
        ...(connectors.length ? { connectors: [...connectors] } : {}), ...(reminders ? { reminders: true } : {}),
        ...(once ? {} : { cards: { board: c.board, statuses, subtasks } }), schedule, ...(once ? {} : { section }), timeLimitMin: a.timeLimitMin,
      },
    };
  }

  // How a run started, for the runs list, the run detail and the command (spec §7). A trial writes nothing;
  // a Work automation's trial ran with Report permissions, so it shows what it would say, not what it would do.
  const TRIGGER_TEXT = { 'schedule': 'scheduled', 'catch-up': 'catch-up', 'manual': 'run now' };
  function triggerText(run) {
    if (run.trigger === 'trial' && run.runsOn === 'once') return 'trial · nothing created';
    if (run.trigger === 'trial') return run.level === 'work' ? 'trial · tried as Report · not written to cards' : 'trial · not written to cards';
    return TRIGGER_TEXT[run.trigger] || run.trigger || '';
  }

  // ---------- Agent tags (spec §7) ----------
  // The line under an automation an agent made or changed; '' when there's nothing to say.
  const listText = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  // The builder's reason the connectors switch is off when the agent can't use them. An automation with connectors
  // saved loses them on Save, so it says so.
  const connectorsAgentHint = (label, o) => `${label} can't use connectors in automations yet${o && Array.isArray(o.saved) && o.saved.length ? '; saving removes them.' : ''}`;
  function agentTagText(a, tz) {
    const ch = a && a.agentChange;
    const draft = a && a.origin && !a.enabled;
    // An agent's own draft stays "Draft from …" through its edits; a change that switched one off says so.
    if (ch && Array.isArray(ch.fields) && ch.fields.length && (ch.switchedOff || !draft)) {
      return `${ch.agent} changed the ${listText(ch.fields)}.${ch.switchedOff ? ' Off until you switch it on.' : ''}`;
    }
    const o = a && a.origin;
    if (!o || a.enabled) return '';
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(o.at));
    return `Draft from ${o.agent} · ${day}`;
  }

  // ---------- Calendar reminders in a run (spec: vaultos-remind) ----------
  // "Reminder added: Thu 26 Nov 09:15 · Chase", "Would remind: …" on a trial, "Reminder skipped: why", or ''.
  const WEEKDAY_OF = (date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function reminderText(c, trial) {
    const r = c && c.reminder;
    if (r && r.date) {
      const [, mo, d] = r.date.split('-').map(Number);
      const when = `${WEEKDAY_OF(r.date)} ${d} ${MONTH_ABBR[mo - 1]} ${r.start || ''}${r.end ? `–${r.end}` : ''}`.trim();
      return `${trial ? 'Would remind' : 'Reminder added'}: ${when}${r.title ? ` · ${r.title}` : ''}`;
    }
    return c && c.reminderSkipped ? `Reminder skipped: ${c.reminderSkipped}` : '';
  }

  // ---------- Run summaries ----------
  function runCounts(run) {
    const n = { noted: 0, skipped: 0, failed: 0, timedOut: 0, notRun: 0, moved: 0 };
    const key = { 'noted': 'noted', 'skipped': 'skipped', 'failed': 'failed', 'timed-out': 'timedOut', 'not-run': 'notRun', 'moved': 'moved' };
    for (const c of run.cards || []) if (key[c.state]) n[key[c.state]]++;
    return n;
  }
  const COUNT_LABEL = [['noted', 'noted'], ['skipped', 'skipped'], ['failed', 'failed'], ['timedOut', 'timed out'], ['notRun', 'not run'], ['moved', 'moved']];
  const cardsN = (n) => `${n} card${n === 1 ? '' : 's'}`;
  // "3 cards created", "would create 1 card" (a trial), "nothing created".
  function createdCountText(run) {
    const n = run.createdCount || 0;
    if (!n) return 'nothing created';
    return run.trigger === 'trial' ? `would create ${cardsN(n)}` : `${cardsN(n)} created`;
  }
  // "6 cards · 7 min · 5 noted, 1 skipped"; a run still going is just "running". A Once run has no cards to count, so
  // it ends with what it created; a per-card run that created cards says so at the end.
  function runSummary(run) {
    if (run.state === 'running') return 'running';
    const total = (run.cards || []).length;
    const mins = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000);
    const counts = runCounts(run);
    const once = run.runsOn === 'once';
    if (once) counts.noted = 0;   // the one entry being "noted" says nothing a Once run's summary needs
    const parts = COUNT_LABEL.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}`);
    const created = once ? createdCountText(run) : (run.createdCount ? createdCountText(run) : '');
    return [once ? '' : cardsN(total), mins >= 1 ? `${mins} min` : '<1 min', parts.join(', '), created].filter(Boolean).join(' · ');
  }

  // ---------- Display ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // "Today 08:00", "Tomorrow 08:00", "Yesterday 08:00", "Sat 08:00" (within the coming week),
  // "Sat 7 Nov 08:00" (within the past week), else "25 Dec 08:00". Wall clock in tz.
  function whenText(ms, nowMs, tz) {
    const w = wallParts(ms, tz);
    const n = wallParts(nowMs, tz);
    const days = Math.round((Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(n.y, n.mo - 1, n.d)) / DAY_MS);
    const time = `${pad(w.h)}:${pad(w.mi)}`;
    const wd = WEEKDAY[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()];
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Tomorrow ${time}`;
    if (days === -1) return `Yesterday ${time}`;
    if (days > 1 && days < 7) return `${wd} ${time}`;
    if (days < -1 && days > -7) return `${wd} ${w.d} ${MONTHS[w.mo - 1]} ${time}`;
    return `${w.d} ${MONTHS[w.mo - 1]} ${time}`;
  }
  // "In Progress + Blocked · Work", "Review · All boards · with subtasks".
  function cardsText(cards, boardLabel) {
    return [
      cards.statuses.map((s) => STATUS_LABEL[s] || s).join(' + '),
      cards.board === 'all' ? 'All boards' : (boardLabel || cards.board),
      cards.subtasks ? 'with subtasks' : '',
    ].filter(Boolean).join(' · ');
  }
  // "New cards → Work / tickets"; the board's root is "top of the board".
  function newCardsText(nc, boardLabel) {
    return `New cards → ${boardLabel || nc.board} / ${nc.folder || 'top of the board'}`;
  }
  // A run entry's new-card lines: "Created: <title> (<key>)" ("Would create: …" on a trial), then
  // "Not created: <key, else title> — <reason>".
  function createdText(c, trial) {
    const made = ((c && c.created) || []).map((x) => `${trial ? 'Would create' : 'Created'}: ${x.title}${x.key ? ` (${x.key})` : ''}`);
    const not = ((c && c.notCreated) || []).map((x) => `Not created: ${x.key || x.title} — ${x.reason}`);
    return [...made, ...not];
  }
  // The last run's dot: ok (finished clean), warn (finished with skips or failures, or stopped), bad.
  function lastRunTone(run) {
    if (run.state === 'failed' || run.state === 'interrupted') return 'bad';
    if (run.state === 'stopped') return 'warn';
    return (run.cards || []).some((c) => c.state !== 'noted') ? 'warn' : 'ok';
  }
  // The first line of why a failed run failed, for "Last run failed: …".
  function failureText(run) {
    if (run.state !== 'failed') return '';
    const c = (run.cards || []).find((x) => x.reason && ['failed', 'timed-out', 'not-run'].includes(x.state));
    return c ? c.reason.split('\n')[0] : 'see the run';
  }

  return {
    DAYS, DAY_LABEL, HOURS_EVERY, wallParts, wallToUtc, lastSlot, nextSlot, describeSchedule, hhmm,
    whenText, cardsText, lastRunTone, failureText,
    LEVELS, LEVEL_LABEL, CARD_STATUSES, STATUS_LABEL, RESERVED_SECTIONS, MAX_CARDS, TRIAL_CARDS, NOTE_MAX, PROMPT_MAX, NAME_MAX, MODEL_MAX,
    TEMPLATES, LEVEL_TEXT, LEVEL_PARAGRAPHS, validateAutomation, runCounts, runSummary, agentTagText, triggerText, listText, connectorsAgentHint, reminderText,
    RUNS_ON, RUNS_ON_LABEL, NEW_CARDS_DEFAULT, NEW_CARDS_LIMIT, NEW_CARDS_PER_HOUR, NEW_FOLDER_MAX, CARD_KEY_RE, ONCE_PARAGRAPH,
    newCardsText, createdText, normalFolder,
  };
});
