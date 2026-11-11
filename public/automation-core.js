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
    work: "Can edit files in the card's folder.",
  };
  const REPORT_PARAGRAPH = "You can read and search files. Don't try to change anything: VaultOS writes your note into the card.";
  const LEVEL_PARAGRAPHS = {
    report: REPORT_PARAGRAPH,
    update: `${REPORT_PARAGRAPH} You may propose a status change in a vaultos-update block.`,
    work: "You may edit files in this card's folder. Don't run shell commands and don't set the card to done. VaultOS writes your note into the card.",
  };

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

  // The builder and the server both run this; the server's answer is the one that counts.
  // ctx: { boardKeys: board keys from settings, agentIds: 'default' plus the agents automations can use }.
  function validateAutomation(input, ctx) {
    const a = isObj(input) ? input : {};
    const c = isObj(a.cards) ? a.cards : {};
    const errors = {};
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name || name.length > NAME_MAX) errors.name = `Give it a name of 1 to ${NAME_MAX} characters`;
    const enabled = a.enabled === undefined ? true : a.enabled;
    if (typeof enabled !== 'boolean') errors.enabled = 'Must be on or off';
    if (!ctx.agentIds.includes(a.agent)) errors.agent = 'Pick an agent that can run automations';
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, a.template)) errors.template = 'Unknown template';
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    if (!prompt.trim()) errors.prompt = 'Write what the agent should do';
    else if (prompt.length > PROMPT_MAX) errors.prompt = `Keep it under ${PROMPT_MAX.toLocaleString('en-GB')} characters`;
    if (!LEVELS.includes(a.level)) errors.level = 'Pick Report, Update or Work';
    if (c.board !== 'all' && !ctx.boardKeys.includes(c.board)) errors.board = 'Pick a board';
    const statuses = Array.isArray(c.statuses) ? CARD_STATUSES.filter((s) => c.statuses.includes(s)) : [];
    if (!statuses.length || c.statuses.some((s) => !CARD_STATUSES.includes(s))) errors.statuses = 'Pick at least one status (never Done)';
    const subtasks = c.subtasks === undefined ? false : c.subtasks;
    if (typeof subtasks !== 'boolean') errors.subtasks = 'Must be on or off';
    const schedule = validSchedule(a.schedule);
    if (!schedule) errors.schedule = 'Pick when it runs (times as HH:MM)';
    const section = typeof a.section === 'string' ? a.section.trim() : '';
    if (!SECTION_RE.test(section)) errors.section = 'Use 1 to 40 letters, digits, spaces or hyphens';
    else if (RESERVED_SECTIONS.includes(section.toLowerCase())) errors.section = "That's one of the card's own sections";
    if (!Number.isInteger(a.timeLimitMin) || a.timeLimitMin < 2 || a.timeLimitMin > 30) errors.timeLimitMin = 'Between 2 and 30 minutes';
    // With ctx.agentLevels (the server and the builder pass it), the agent must be offered at the level.
    // 'default' is resolved to the current default agent; ctx.agentLevels.default is its levels.
    if (ctx.agentLevels && !errors.agent && !errors.level) {
      const levels = ctx.agentLevels[a.agent] || [];
      const labels = ctx.agentLabels || {};
      if (!levels.length && a.agent === 'default') errors.agent = 'Pick an agent that can run automations';
      else if (!levels.includes(a.level)) {
        const lvl = LEVEL_LABEL[a.level];
        if (a.agent === 'default') {
          const others = Object.keys(ctx.agentLevels).filter((id) => id !== 'default' && ctx.agentLevels[id].includes(a.level)).map((id) => labels[id] || id);
          const label = labels[ctx.defaultAgent] || ctx.defaultAgent;
          errors.level = `Your default agent (${label}) can't run at ${lvl}; pick ${others.length ? `${others.join(' or ')} or ` : ''}another level`;
        } else errors.level = `${labels[a.agent] || a.agent} can't run at ${lvl}`;
      }
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        name, enabled, agent: a.agent, template: a.template, prompt, level: a.level,
        cards: { board: c.board, statuses, subtasks }, schedule, section, timeLimitMin: a.timeLimitMin,
      },
    };
  }

  // ---------- Agent tags (spec §7) ----------
  // The line under an automation an agent made or changed; '' when there's nothing to say.
  const listText = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
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

  // ---------- Run summaries ----------
  function runCounts(run) {
    const n = { noted: 0, skipped: 0, failed: 0, timedOut: 0, notRun: 0, moved: 0 };
    const key = { 'noted': 'noted', 'skipped': 'skipped', 'failed': 'failed', 'timed-out': 'timedOut', 'not-run': 'notRun', 'moved': 'moved' };
    for (const c of run.cards || []) if (key[c.state]) n[key[c.state]]++;
    return n;
  }
  const COUNT_LABEL = [['noted', 'noted'], ['skipped', 'skipped'], ['failed', 'failed'], ['timedOut', 'timed out'], ['notRun', 'not run'], ['moved', 'moved']];
  // "6 cards · 7 min · 5 noted, 1 skipped"; a run still going is just "running".
  function runSummary(run) {
    if (run.state === 'running') return 'running';
    const total = (run.cards || []).length;
    const mins = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000);
    const counts = runCounts(run);
    const parts = COUNT_LABEL.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}`);
    return [`${total} card${total === 1 ? '' : 's'}`, mins >= 1 ? `${mins} min` : '<1 min', parts.join(', ')].filter(Boolean).join(' · ');
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
    LEVELS, LEVEL_LABEL, CARD_STATUSES, STATUS_LABEL, RESERVED_SECTIONS, MAX_CARDS, TRIAL_CARDS, NOTE_MAX, PROMPT_MAX, NAME_MAX,
    TEMPLATES, LEVEL_TEXT, LEVEL_PARAGRAPHS, validateAutomation, runCounts, runSummary, agentTagText,
  };
});
