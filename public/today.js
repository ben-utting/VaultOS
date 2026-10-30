'use strict';

// ========================================================================
// Today — the landing mode: Next across the top (the date line, then the one
// thing to do now), the day's other cards in #td-main, and the quote last.
// Loaded after app.js and shares its globals ($, api, svg, toast, setMode,
// segSet, STATE, WORKSPACE_LIST, TASK_AGENTS, openTask, esc), termtoast.js's TermToast
// and today-next.js's TodayNext. One global, Today = { init, show, hide, onWorkspace, reload }.
//
// The Pomodoro belongs to the server. This file counts its time down locally,
// and keeps the header chip, the tab title and the completion toasts going in
// every mode, not only while Today is on screen.
//
// Dates are calendar dates in Today's time zone, as the ISO strings the server sends. The
// weekday, ISO week and day of the year are worked out from that string in
// UTC, so the browser's own clock and time zone never move a day.
// Anything read from the vault (quotes, authors) goes in with textContent.
// ========================================================================

const Today = (() => {
  const POLL_MS = 60000;      // a quiet reload: a tab left open crosses midnight, and hears of timer changes made elsewhere
  const SHUFFLE_MS = 6000;    // ZenQuotes' free tier; the server refuses a shuffle sooner anyway (429)
  const TICK_MS = 250;        // the countdown's repaint, only while a session runs
  // At zero, reload after the first wait; while the server still says "running" (its completion is late or
  // failed), wait longer each time rather than asking every second and a half forever.
  const ZERO_WAITS = [1500, 5000, 15000, 60000];
  // A phone waking up often fails its first fetch: the poll on becoming visible tries again after 2 s, then 5 s.
  const WAKE_RETRY_MS = [2000, 5000];
  const NEW_DAY = 'New day. Refreshed.';
  const TOAST_MAX_AGE = 120000;   // an older completion shows in the log, never as a toast
  const SEEN_KEY = 'vaultboard.today.seen';     // sessionStorage: lastEvent ids this tab has toasted
  const SOUND_KEY = 'vaultboard.today.sound';   // localStorage: 'off' silences the chime; 'on' or missing plays it
  const CIRC = 2 * Math.PI * 74;                // the ring's circumference (r = 74 in a 168 box)
  const PHASES = { focus: 'Focus', short: 'Short break', long: 'Long break' };
  const CHIP_PREFIX = /^\d{2,3}:\d{2} · /;     // the tab title's countdown, stripped before a new one goes on
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  const ICON = {
    prev: svg('<path d="m15 18-6-6 6-6"/>'),
    next: svg('<path d="m9 18 6-6-6-6"/>'),
    shuffle: svg('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>'),
    play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
    pause: svg('<path d="M8 5v14M16 5v14"/>'),
    skip: svg('<path d="M5 4.5l10 7.5-10 7.5z"/><path d="M19 5v14"/>'),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  };

  // Habit icons: Lucide-style 24x24 strokes, drawn by habitIcon(). An unknown name draws a dot.
  const ICON_PATHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    dumbbell: '<path d="M6.5 6.5l11 11M21 21l-1-1M3 3l1 1M18 22l4-4M2 6l4-4M3 10l7-7M14 21l7-7"/>',
    tree: '<path d="M17 14l3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17z"/><path d="M12 22v-3"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    pill: '<path d="M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z"/><path d="M8.5 8.5l7 7"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    cap: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    'coffee-off': '<path d="M10 2v2M14 2v2M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h12z"/><path d="M17 9h1a3 3 0 0 1 0 6h-1"/><path d="M3 3l18 18"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
    pen: '<path d="M12 20h9"/><path d="M16.38 3.62a2.12 2.12 0 0 1 3 3L7.37 18.63a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    walk: '<circle cx="13" cy="4" r="1.5"/><path d="M9 21l3-6 3 6"/><path d="M12 15v-4l-3 1-2 3"/><path d="M12 11l3 1 2 2"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  const CHECK = svg(ICON_PATHS.check);
  const XICON = svg(ICON_PATHS.x);
  const PLUS = svg(ICON_PATHS.plus);
  const habitIcon = (name) => (Object.prototype.hasOwnProperty.call(ICON_PATHS, name)
    ? svg(ICON_PATHS[name]) : '<span class="td-dot" aria-hidden="true"></span>');
  // The icons a habit can have (the server's ICONS, in the same order).
  const HABIT_ICONS = ['check', 'sun', 'dumbbell', 'walk', 'tree', 'rocket', 'pill', 'book', 'cap', 'coffee-off', 'heart', 'moon', 'droplet', 'pen', 'music'];

  let inited = false;
  let shown = false;
  let P = null;           // the payload on screen
  let cur = null;         // the date on screen, or the one a step is fetching
  let seq = 0;            // bumped per request: only the latest answer paints
  let inFlight = 0;
  let shuffleUntil = 0;   // Date.now() before which Shuffle stays disabled
  let shuffleT = null;

  // The timer, from whichever payload came last (every payload carries it, whatever day it's for).
  let tm = null;          // payload.timer
  let offset = 0;         // serverNow − Date.now() at that answer: the countdown runs on the server's clock
  let sum = null;         // payload.summary: today's habits done and focus minutes
  let todayDay = null;    // today's tasks and minutes per habit, for the picker even while a past day shows
  let pick = null;        // the picker's choice: what Start sends as the target
  let followed = null;    // startedAt of the session the picker last took its target from
  let pickKey = '';       // the picker's options as last built, so an unchanged list isn't rebuilt
  let tickT = null;       // the 250 ms countdown interval
  let zeroT = null;       // the wait between zero and the reload
  let zeroFor = null;     // the endsAt that zeroTries counts for
  let zeroTries = 0;
  let timerBusy = false;  // one timer write at a time
  let toasts = null;      // TermToast's box, made at the first toast

  // ---------- Calendar maths on 'YYYY-MM-DD' ----------
  const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const pad = (n) => String(n).padStart(2, '0');
  function addDays(iso, n) {
    const t = utc(iso);
    t.setUTCDate(t.getUTCDate() + n);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const weekday = (iso) => WEEKDAYS[utc(iso).getUTCDay()];
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  function dayOfYear(iso) {
    const t = utc(iso);
    return Math.round((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  }
  // ISO 8601: weeks start on Monday, and the week's Thursday decides which year it belongs to.
  function isoWeek(iso) {
    const t = utc(iso);
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
  }

  // Today's date in Today's time zone by the server's clock. The zone (Settings → Features) and the offset come
  // again with every payload, so after a reload this agrees with P.today.
  let zone = null;
  let zoneFmt = null;
  function setZone(tz) {
    if (tz === zone) return;
    zone = tz;
    zoneFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  function zoneToday() {
    const p = Object.fromEntries(zoneFmt.formatToParts(new Date(Date.now() + offset)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  // A tab left on "today" past midnight, with no poll through since, still shows yesterday as today, and a write
  // from it would land on yesterday. Then nothing is sent: the page loads the new day and says so, and the next tap
  // goes to the right day. A past day stepped back to on purpose (cur !== P.today) is written as asked.
  let rolling = false;    // the new-day reload is on its way
  function staleToday() {
    if (!P || cur !== P.today || !(zoneToday() > P.today)) return false;
    if (!rolling) {
      rolling = true;
      load(null).then((ok) => { if (ok) toast(NEW_DAY); }).finally(() => { rolling = false; });
    }
    return true;
  }

  // ---------- DOM ----------
  // Static markup only; everything from the payload is set with textContent in paint().
  function build() {
    $('today-view').innerHTML = `
      <div class="td-page">
        <p class="td-err hidden" id="td-err" role="alert"></p>
        <section class="td-card td-next" id="td-next" data-kind="clear" aria-labelledby="td-next-date">
          <div class="td-next-h">
            <button type="button" class="td-nav" id="td-prev" aria-label="Previous day" title="Previous day">${ICON.prev}</button>
            <h2 class="td-next-date" id="td-next-date"></h2>
            <button type="button" class="td-nav" id="td-nextday" aria-label="Next day" title="Next day" disabled>${ICON.next}</button>
            <button type="button" class="td-back hidden" id="td-back" aria-label="Back to today"><span class="td-back-l">Back to today</span><span class="td-back-s">Today</span></button>
          </div>
          <div class="td-next-b">
            <div class="td-next-what">
              <div class="td-next-l"><span id="td-next-label"></span><span class="card-agent td-next-needs hidden" id="td-next-needs" data-agent="blocked"><span class="agent-dot" data-agent="blocked"></span>needs you</span></div>
              <p class="td-next-t" id="td-next-text"></p>
              <p class="td-next-sum hidden" id="td-next-sum"></p>
            </div>
            <div class="td-btns td-next-acts">
              <button type="button" class="td-btn primary" id="td-next-start"></button>
              <button type="button" class="td-btn td-ghost" id="td-next-open">Open</button>
            </div>
          </div>
        </section>
        <div class="td-main" id="td-main"><div class="td-cols">
          <section class="td-card td-habits" id="td-habits-card" aria-labelledby="td-habits-h">
            <div class="td-card-h"><h2 id="td-habits-h">Habits</h2><span class="td-hcount" id="td-hcount"></span><span class="td-hrange" id="td-hrange"></span></div>
            <ul class="td-warn hidden" id="td-warn"></ul>
            <div class="td-habits" id="td-habits"></div>
            <p class="td-empty td-hnone hidden" id="td-hnone">No habits yet. Add the ones you want to track each day.</p>
            <form class="td-hform hidden" id="td-hform" novalidate>
              <h3 id="td-hf-h">New habit</h3>
              <label class="td-hf"><span>Name</span><input id="td-hf-name" type="text" maxlength="60" autocomplete="off" placeholder="e.g. Read 30m"></label>
              <div class="td-hf"><span id="td-hf-icons-l">Icon</span><div class="td-hf-icons" id="td-hf-icons" role="radiogroup" aria-labelledby="td-hf-icons-l"></div></div>
              <label class="td-hf"><span>Focus goal <small>minutes a day, optional</small></span><input id="td-hf-goal" type="number" min="5" max="600" step="5" inputmode="numeric" placeholder="None"></label>
              <p class="td-task-msg" id="td-hf-msg" role="alert"></p>
              <div class="td-btns">
                <button type="submit" class="td-btn primary" id="td-hf-save">Add habit</button>
                <button type="button" class="td-btn" id="td-hf-cancel">Cancel</button>
                <button type="button" class="td-btn td-hf-del hidden" id="td-hf-del">Remove</button>
              </div>
            </form>
            <button type="button" class="td-hadd" id="td-hadd">${PLUS}Add habit</button>
            <div class="td-score">
              <h3>Daily score <span id="td-score-of"></span></h3>
              <div class="td-bars" id="td-bars"></div>
              <div class="td-wk"><b id="td-week"></b><small>this week</small></div>
            </div>
          </section>
          <div class="td-side" id="td-side">
            <section class="td-card td-focus" id="td-focus" aria-labelledby="td-focus-h">
              <div class="td-card-h"><h2 id="td-focus-h">Focus</h2><span class="td-dots" id="td-dots" role="img"></span><span class="td-hrange">25 min focus · 5 break · 15 after four</span></div>
              <div class="td-fbody">
                <div class="td-ring">
                  <svg viewBox="0 0 168 168" aria-hidden="true">
                    <circle class="td-ring-track" cx="84" cy="84" r="74"/>
                    <circle class="td-ring-arc" id="td-ring-arc" cx="84" cy="84" r="74" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"/>
                  </svg>
                  <div class="td-ring-t"><div class="td-phase" id="td-phase">Focus</div><div class="td-clock" id="td-clock" role="timer" aria-live="off"></div></div>
                </div>
                <div class="td-fctl">
                  <label for="td-target">Working on</label>
                  <select id="td-target"></select>
                  <p class="td-fhint hidden" id="td-fhint">Applies from the next session.</p>
                  <div class="td-btns">
                    <button type="button" class="td-btn primary" id="td-go"></button>
                    <button type="button" class="td-btn" id="td-skip">${ICON.skip}Skip</button>
                    <button type="button" class="td-btn" id="td-reset" aria-label="Reset timer" title="Reset timer">${ICON.reset}</button>
                  </div>
                </div>
              </div>
              <ul class="td-flog" id="td-log"></ul>
              <p class="td-note hidden" id="td-fnote">The timer always logs to today, whichever day you're looking at.</p>
            </section>
            <section class="td-card td-tasks" aria-labelledby="td-tasks-h">
              <div class="td-card-h"><h2 id="td-tasks-h">Today's tasks</h2><span class="td-hcount" id="td-tcount"></span></div>
              <ul class="td-tlist" id="td-tasks"></ul>
              <p class="td-task-msg" id="td-task-msg" role="alert"></p>
              <form class="td-tadd" id="td-task-form">
                <input id="td-task-input" type="text" placeholder="Add a task for this day" autocomplete="off" maxlength="500" aria-label="New task">
                <button type="submit" class="td-addbtn" id="td-task-add" aria-label="Add task" title="Add task">${PLUS}</button>
              </form>
              <p class="td-note">Separate from the Board. Anything left unticked moves to the next day by itself.</p>
            </section>
          </div>
        </div></div>
        <figure class="td-card td-quote">
          <div class="td-qt">
            <blockquote class="td-qtext" id="td-quote-text"></blockquote>
            <figcaption class="td-qcap"><span id="td-quote-by"></span><span id="td-quote-from"></span></figcaption>
            <a class="td-zq" href="https://zenquotes.io/" target="_blank" rel="noopener">Quotes from ZenQuotes</a>
          </div>
          <button type="button" class="td-ibtn hidden" id="td-shuffle" aria-label="Show another quote" title="Show another quote">${ICON.shuffle}</button>
        </figure>
      </div>`;
  }

  function paint(p) {
    if (P && P.date !== p.date) setTaskMsg('');   // a message belongs to the day it was shown on
    P = p;
    cur = p.date;
    const onToday = p.date === p.today;
    const t = utc(p.date);
    const year = t.getUTCFullYear();
    $('today-view').dataset.ready = '1';
    $('td-err').classList.add('hidden');
    // One line in Next's header: "Fri 30 Oct · week 44" (the year too when it isn't this one).
    const nd = $('td-next-date');
    nd.textContent = `${shortDay(p.date)} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()].slice(0, 3)}`
      + `${year === utc(p.today).getUTCFullYear() ? '' : ` ${year}`} · week ${isoWeek(p.date)}`;
    nd.title = `day ${dayOfYear(p.date)} of ${isLeap(year) ? 366 : 365}`;
    $('td-next').dataset.day = onToday ? 'today' : 'other';
    $('td-nextday').disabled = onToday;
    $('td-back').classList.toggle('hidden', onToday);

    const q = p.day.quote;
    $('td-quote-text').textContent = q ? q.text : '';
    $('td-quote-text').classList.toggle('hidden', !q);
    $('td-quote-by').textContent = q ? q.by || '' : '';
    $('td-quote-from').textContent = !q ? (onToday ? 'No quote yet today.' : 'No quote that day.')
      : p.day.quoteFallback ? `from ${weekday(q.date).slice(0, 3)}` : '';
    $('td-shuffle').classList.toggle('hidden', !(onToday && p.day.exists));
    syncShuffle();
    paintHabits(p);
    paintTasks(p);
    absorb(p);
    paintNext();
  }

  // ---------- Next: the one thing to do now (TodayNext.pickNext picks it) ----------
  // The day's first open task; on today, else the In Progress task of the header chip's workspace; else
  // "clear". Board tasks are fetched per workspace (show, onWorkspace, Today's own refresh; no polling), kept
  // under the workspace they were fetched for, and an answer for a workspace that's no longer current, or one
  // a newer fetch overtook, is dropped. No answer yet, or a failed one, is null: Next goes to clear, never an error.
  const boardBy = Object.create(null);    // workspace key → its last good /api/tasks list
  const boardSeq = Object.create(null);   // workspace key → the latest fetch's number
  let next = null;        // the Next on screen
  let extra = null;       // a one-off "Working on" option for a target that isn't in the list: { value, label }
  async function loadBoard() {
    const key = STATE.workspace;
    const n = (boardSeq[key] = (boardSeq[key] || 0) + 1);
    paintNext();
    let tasks = null;
    try {
      const d = await api('/api/tasks?ws=' + encodeURIComponent(key));
      tasks = d && Array.isArray(d.tasks) ? d.tasks : null;
    } catch { /* Next never shows an error: no list means clear */ }
    if (key !== STATE.workspace || n !== boardSeq[key]) return;
    if (tasks) boardBy[key] = tasks; else delete boardBy[key];
    paintNext();
  }
  const wsName = () => {
    const w = (WORKSPACE_LIST || []).find((x) => x.key === STATE.workspace);
    return w ? w.label : STATE.workspace;
  };
  const daySummary = () => (!sum ? '' : `${sum.total ? `${sum.done}/${sum.total} habits · ` : ''}${fmtMin(sum.focusMin)} focus`);

  function paintNext() {
    if (!P) return;
    const onToday = P.date === P.today;
    next = TodayNext.pickNext({
      todayTasks: P.day.tasks || [],
      boardTasks: boardBy[STATE.workspace] || null,
      agentState: (path) => (TASK_AGENTS[path] || {}).state,
      viewingToday: onToday,
      wsLabel: wsName(),
    });
    const k = next.kind;
    $('td-next').dataset.kind = k;
    $('td-next-label').textContent = k === 'today' ? (onToday ? "Today's tasks" : `Tasks · ${dayLabel(P.date)}`)
      : k === 'board' ? `Board · ${next.wsLabel}` : '';
    $('td-next-needs').classList.toggle('hidden', !(k === 'board' && next.needsYou));
    $('td-next-text').textContent = k === 'today' ? next.text : k === 'board' ? next.title
      : onToday ? "You're clear for today" : 'Nothing left open that day';
    const s = $('td-next-sum');
    s.textContent = k === 'clear' && onToday ? daySummary() : '';
    s.classList.toggle('hidden', !s.textContent);
    $('td-next-open').setAttribute('aria-label', k === 'board' ? `Open ${next.title} on the Board` : k === 'today' ? `Show ${next.text} in the list` : 'Open');
    // One solid-gold action on the screen: Next's Start while it has an item, Focus's own Start otherwise.
    $('td-go').classList.toggle('primary', k === 'clear');
    paintNextStart();
  }
  // Start, by the timer: Running · 12:34 (disabled) while a session runs, Paused while paused, disabled in a
  // break (Start would start the break). The strip never starts a second session.
  function paintNextStart() {
    const b = $('td-next-start');
    if (!b || !next || next.kind === 'clear') return;
    let label = 'Start';
    let why = next.kind === 'board' ? `Focus on ${next.title}` : `Focus on ${next.text}`;
    if (tm && tm.state === 'running') { label = `Running · ${clock(leftMs())}`; why = `${PHASES[tm.phase] || 'Focus'} is running`; }
    else if (tm && tm.state === 'paused') { label = `Paused · ${clock(leftMs())}`; why = 'Resume or reset it in Focus'; }
    else if (tm && tm.phase !== 'focus') why = 'A break is next: start or skip it in Focus';
    const off = !tm || tm.state !== 'idle' || tm.phase !== 'focus';
    if (b.dataset.label !== label) {
      b.dataset.label = label;
      b.innerHTML = (off && tm && tm.state !== 'idle' ? '' : ICON.play) + esc(label);
    }
    b.disabled = off;
    b.title = why;
  }
  function onNextStart() {
    if (!next || next.kind === 'clear' || !tm || timerBusy || tm.state !== 'idle' || tm.phase !== 'focus') return;
    const sel = $('td-target');
    if (![...sel.options].some((o) => o.value === next.target)) {
      extra = { value: next.target, label: next.kind === 'board' ? next.title : next.text };
    }
    aim(next.target);
    timerOp('start');
  }
  function onNextOpen() {
    if (!next || next.kind === 'clear') return;
    if (next.kind === 'board') {
      const path = next.path;
      setMode('board');
      openTask(path);
      return;
    }
    const t = (P.day.tasks || []).find((x) => !x.done && !x.moved && x.text === next.text);
    const row = t && $('td-tasks').querySelector(`.td-trow[data-index="${t.index}"]`);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (row || $('td-tasks')).closest('.td-card').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    const chk = row && row.querySelector('.td-tchk');
    if (chk) chk.focus({ preventScroll: true });
  }

  // ---------- Habits card ----------
  const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  const shortDay = (iso) => weekday(iso).slice(0, 3);
  const dayLabel = (iso) => `${shortDay(iso)} ${utc(iso).getUTCDate()}`;

  function paintHabits(p) {
    const host = $('td-habits');
    const a = document.activeElement;
    const focusKey = a && host.contains(a) ? [a.className, a.closest('.td-hrow') && a.closest('.td-hrow').dataset.id, a.dataset.date] : null;
    const total = p.habits.length;
    const doneToday = new Set(p.day.done);
    const kids = [];

    $('td-hnone').classList.toggle('hidden', total > 0);
    $('td-habits-card').querySelector('.td-score').classList.toggle('hidden', total === 0);
    const head = el('div', 'td-hrow td-head');
    head.setAttribute('aria-hidden', 'true');
    head.append(el('span'), el('span'));
    const hc = el('div', 'td-cells');
    for (const w of p.week) hc.append(el('span', 'td-dl' + (w.date === p.date ? ' sel' : ''), shortDay(w.date).slice(0, 2)));
    head.append(hc, el('span', 'td-streak', ''));
    head.lastChild.append(el('small', '', 'streak'));
    if (total) kids.push(head);

    for (const h of p.habits) {
      const on = doneToday.has(h.id);
      const row = el('div', 'td-hrow');
      row.dataset.id = h.id;
      const tick = el('button', 'td-tick');
      tick.type = 'button';
      tick.setAttribute('aria-pressed', String(on));
      tick.setAttribute('aria-label', `${h.name}, ${on ? 'done' : 'not done'}`);
      tick.innerHTML = CHECK;
      const main = el('div', 'td-hmain');
      const name = el('div', 'td-hname');
      name.insertAdjacentHTML('afterbegin', habitIcon(h.icon));
      name.append(el('span', '', h.name));
      const ed = el('button', 'td-hedit');
      ed.type = 'button';
      ed.title = 'Edit habit';
      ed.setAttribute('aria-label', `Edit ${h.name}`);
      ed.innerHTML = svg(ICON_PATHS.pen);
      name.append(ed);
      main.append(name);
      if (h.goal) {
        const mins = (p.focusByHabit && p.focusByHabit[h.id]) || 0;
        const prog = el('div', 'td-prog');
        const track = el('span', 'td-track');
        const fill = el('span', 'td-fill' + (mins >= h.goal ? ' full' : ''));
        fill.style.width = `${Math.min(100, Math.round((mins / h.goal) * 100))}%`;
        track.append(fill);
        prog.append(track, el('span', '', `${mins} / ${h.goal} min`));
        if (p.date === p.today) {   // the timer always logs to today, so the link only shows there
          const f = el('button', 'td-hfocus');
          f.type = 'button';
          f.setAttribute('aria-label', `Focus on ${h.name}`);
          f.innerHTML = ICON.play;
          f.append('Focus');
          prog.append(f);
        }
        main.append(prog);
      }
      const cells = el('div', 'td-cells');
      for (const w of p.week) {
        const c = w.done.includes(h.id);
        const b = el('button', 'td-cell' + (c ? ' on' : '') + (w.date === p.date ? ' sel' : ''));
        b.type = 'button';
        b.dataset.date = w.date;
        b.setAttribute('aria-pressed', String(c));
        const lbl = `${dayLabel(w.date)} · ${c ? 'done' : 'not done'}`;
        b.title = lbl;
        b.setAttribute('aria-label', lbl);
        b.innerHTML = CHECK;
        cells.append(b);
      }
      const n = (p.streaks && p.streaks[h.id]) || 0;
      const st = el('div', 'td-streak' + (n ? '' : ' zero'));
      st.append(el('b', '', n ? String(n) : '–'), el('small', '', n ? (n === 1 ? 'day' : 'days') : ''));
      row.append(tick, main, cells, st);
      kids.push(row);
    }
    host.replaceChildren(...kids);
    if (focusKey) {
      const [cls, id, date] = focusKey;
      const row = id ? host.querySelector(`.td-hrow[data-id="${CSS.escape(id)}"]`) : null;
      const t = row && (date ? row.querySelector(`.td-cell[data-date="${date}"]`)
        : row.querySelector(/td-hfocus/.test(cls) ? '.td-hfocus' : /td-hedit/.test(cls) ? '.td-hedit' : '.td-tick'));
      if (t && /td-(tick|cell|hfocus|hedit)/.test(cls)) t.focus({ preventScroll: true });
    }

    const warn = $('td-warn');
    warn.replaceChildren(...p.warnings.map((w) => el('li', '', w)));
    warn.classList.toggle('hidden', !p.warnings.length);

    const onToday = p.date === p.today;
    $('td-hcount').textContent = total ? `${p.day.done.length} of ${total}${onToday ? ' today' : ' that day'}` : '';
    $('td-hrange').textContent = `${dayLabel(p.week[0].date)} – ${dayLabel(p.week[p.week.length - 1].date)}`;
    $('td-score-of').textContent = `· habits done out of ${total}`;
    let sum = 0;
    const bars = p.week.map((w) => {
      const n = w.done.filter((id) => p.habits.some((h) => h.id === id)).length;
      sum += n;
      const bar = el('div', 'td-bar' + (w.date === p.date ? ' sel' : ''));
      bar.title = `${dayLabel(w.date)}: ${n} of ${total}`;
      const col = el('div', 'td-col');
      col.style.height = `${total ? Math.max(3, (n / total) * 100) : 3}%`;
      if (w.date === p.date) col.append(el('span', 'td-val', `${n}/${total}`));
      bar.append(col, el('div', 'td-lab', shortDay(w.date).slice(0, 2)));
      return bar;
    });
    $('td-bars').replaceChildren(...bars);
    $('td-week').textContent = total ? `${Math.round((sum / (total * p.week.length)) * 100)}%` : '0%';
  }

  // A tick or a cell: set one habit on one date, then show the answer. A cell on another day than the one on
  // screen answers with that day's payload, so the page reloads its own day instead.
  async function setHabit(date, id, done) {
    if (staleToday()) return;
    const n = ++seq;
    let again = false;
    inFlight++;
    try {
      const p = await api('/api/today/habit', { method: 'POST', body: JSON.stringify({ date, id, done }) });
      // Overtaken by another request, whose answer may predate this write, or answered for another day: fetch again.
      if (n === seq && p.date === cur) paint(p); else again = true;
    } catch (err) {
      toast(err.message);
    } finally {
      inFlight--;
    }
    if (again) reload({ quiet: true });
  }
  function onHabitClick(e) {
    const ed = e.target.closest('.td-hedit');
    const erow = ed && ed.closest('.td-hrow[data-id]');
    if (erow) { openHabitForm(P && P.habits.find((h) => h.id === erow.dataset.id)); return; }
    const f = e.target.closest('.td-hfocus');
    const frow = f && f.closest('.td-hrow[data-id]');
    if (frow) { aim(frow.dataset.id); return; }
    const b = e.target.closest('.td-tick, .td-cell');
    const row = b && b.closest('.td-hrow[data-id]');
    if (!row || !P) return;
    const date = b.classList.contains('td-cell') ? b.dataset.date : P.date;
    setHabit(date, row.dataset.id, b.getAttribute('aria-pressed') !== 'true');
  }

  // ---------- Adding, editing and removing habits ----------
  // One form under the list, for a new habit or the one being edited. It lives outside #td-habits, so the
  // repaints of a poll leave what's typed alone.
  let editing = null;     // the habit id the form edits, or null for a new one
  let habitBusy = false;
  let formIcon = 'check';
  function paintIconPicker() {
    $('td-hf-icons').replaceChildren(...HABIT_ICONS.map((name) => {
      const b = el('button', 'td-hf-icon');
      b.type = 'button';
      b.dataset.icon = name;
      b.title = name.replace('-', ' ');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(name === formIcon));
      b.setAttribute('aria-label', b.title);
      b.tabIndex = name === formIcon ? 0 : -1;
      b.innerHTML = svg(ICON_PATHS[name]);
      return b;
    }));
  }
  function openHabitForm(h) {
    editing = h ? h.id : null;
    formIcon = h && HABIT_ICONS.includes(h.icon) ? h.icon : 'check';
    $('td-hf-h').textContent = h ? 'Edit habit' : 'New habit';
    $('td-hf-save').textContent = h ? 'Save' : 'Add habit';
    $('td-hf-del').classList.toggle('hidden', !h);
    $('td-hf-name').value = h ? h.name : '';
    $('td-hf-goal').value = h && h.goal ? String(h.goal) : '';
    $('td-hf-msg').textContent = '';
    paintIconPicker();
    $('td-hform').classList.remove('hidden');
    $('td-hadd').classList.add('hidden');
    $('td-hform').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('td-hf-name').focus({ preventScroll: true });
  }
  function closeHabitForm() {
    editing = null;
    $('td-hform').classList.add('hidden');
    $('td-hadd').classList.remove('hidden');
  }
  function setHabitBusy(on) {
    habitBusy = on;
    for (const id of ['td-hf-save', 'td-hf-cancel', 'td-hf-del']) $(id).disabled = on;
  }
  async function habitOp(body) {
    if (!P || habitBusy) return;
    const n = ++seq;
    let again = false;
    setHabitBusy(true);
    inFlight++;
    try {
      const p = await api('/api/today/habits', { method: 'POST', body: JSON.stringify({ date: P.date, ...body }) });
      closeHabitForm();
      if (n === seq && p.date === cur) paint(p); else again = true;
    } catch (err) {
      $('td-hf-msg').textContent = err.message;
    } finally {
      inFlight--;
      setHabitBusy(false);
    }
    if (again) reload({ quiet: true });
  }
  function onHabitSave(e) {
    e.preventDefault();
    const name = $('td-hf-name').value.trim();
    if (!name) { $('td-hf-msg').textContent = 'A habit needs a name.'; $('td-hf-name').focus(); return; }
    const g = $('td-hf-goal').value.trim();
    const goal = g === '' ? null : Number(g);
    habitOp(editing ? { op: 'update', id: editing, name, icon: formIcon, goal } : { op: 'add', name, icon: formIcon, goal });
  }
  function onHabitRemove() {
    const h = P && P.habits.find((x) => x.id === editing);
    if (!h || !confirm(`Remove "${h.name}"?\n\nIts past ticks stay in your day notes, so adding it back with the same name brings them back.`)) return;
    habitOp({ op: 'remove', id: h.id });
  }
  function onIconPick(e) {
    const b = e.target.closest('.td-hf-icon');
    if (!b) return;
    formIcon = b.dataset.icon;
    paintIconPicker();
    $('td-hf-icons').querySelector(`[data-icon="${formIcon}"]`).focus();
  }
  // Arrow keys move through the icons, as in any radio group.
  function onIconKey(e) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = (HABIT_ICONS.indexOf(formIcon) + step + HABIT_ICONS.length) % HABIT_ICONS.length;
    formIcon = HABIT_ICONS[i];
    paintIconPicker();
    $('td-hf-icons').querySelector(`[data-icon="${formIcon}"]`).focus();
  }

  // ---------- Tasks card ----------
  const fmtMin = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
  // "from Tue" within 6 days of the row's day, else "from 9 Oct".
  function fromTag(from, date) {
    const gap = Math.round((utc(date) - utc(from)) / 864e5);
    return gap >= 0 && gap <= 6 ? `from ${shortDay(from)}` : `from ${utc(from).getUTCDate()} ${MONTHS[utc(from).getUTCMonth()].slice(0, 3)}`;
  }
  const setTaskMsg = (m) => { $('td-task-msg').textContent = m || ''; };

  function paintTasks(p) {
    const host = $('td-tasks');
    const a = document.activeElement;
    const focusKey = a && host.contains(a) && a.closest('.td-trow')
      ? [['td-tdel', 'td-tfocus'].find((c) => a.classList.contains(c)) || 'td-tchk', a.closest('.td-trow').dataset.index] : null;
    const list = p.day.tasks || [];
    const kids = list.map((t) => {
      const row = el('li', 'td-trow' + (t.done ? ' done' : '') + (t.moved ? ' moved' : ''));
      row.dataset.index = String(t.index);
      const chk = el('button', 'td-tchk');
      chk.type = 'button';
      chk.disabled = !!t.moved;
      chk.setAttribute('aria-pressed', String(!!t.done));
      chk.setAttribute('aria-label', t.text);
      chk.innerHTML = CHECK;
      const txt = el('div', 'td-ttext');
      txt.append(el('span', '', t.text));
      if (t.from) txt.append(el('span', 'td-tag', fromTag(t.from, p.date)));
      if (t.moved) txt.append(el('span', 'td-tag', 'moved to next day'));
      if (t.min > 0) txt.append(el('span', 'td-tag min', `${fmtMin(t.min)} focus`));
      row.append(chk, txt);
      if (!t.moved) {
        const acts = el('div', 'td-tact');
        if (p.date === p.today && !t.done) {
          const go = el('button', 'td-tfocus');
          go.type = 'button';
          go.setAttribute('aria-label', `Focus on ${t.text}`);
          go.title = 'Focus on this';
          go.innerHTML = ICON.play;
          acts.append(go);
        }
        const del = el('button', 'td-tdel');
        del.type = 'button';
        del.setAttribute('aria-label', `Delete ${t.text}`);
        del.title = 'Delete';
        del.innerHTML = XICON;
        acts.append(del);
        row.append(acts);
      }
      return row;
    });
    host.replaceChildren(...(kids.length ? kids : [el('li', 'td-empty', 'Nothing set for this day.')]));
    if (focusKey) {
      const row = host.querySelector(`.td-trow[data-index="${focusKey[1]}"]`);
      const t = row && (row.querySelector('.' + focusKey[0]) || row.querySelector('.td-tchk'));
      if (t && !t.disabled) t.focus({ preventScroll: true });
    }
    const live = list.filter((t) => !t.moved);
    $('td-tcount').textContent = `${live.filter((t) => t.done).length} of ${live.length}`;
    $('td-tasks-h').textContent = p.date === p.today ? "Today's tasks" : `Tasks · ${dayLabel(p.date)}`;
  }

  // One write: add, toggle or delete. Toggle and delete go by index and are checked against the text the server
  // reads from the file; a mismatch answers 409 and the day is fetched again, so the page shows the file as it is.
  let taskBusy = false;   // one task write at a time: a second click or Enter meanwhile is dropped, never sent twice
  function setTaskBusy(on) {
    taskBusy = on;
    const input = $('td-task-input');
    const had = document.activeElement === input;
    input.disabled = on;
    $('td-task-add').disabled = on;
    $('td-tasks').closest('.td-card').setAttribute('aria-busy', String(on));
    if (!on && had) input.focus({ preventScroll: true });
  }
  async function taskOp(op, t) {
    if (!P || taskBusy || staleToday()) return;   // before the box is emptied, so a stopped add keeps its text
    const date = P.date;
    const n = ++seq;
    const input = $('td-task-input');
    // An add empties the box at once, so nothing typed can be sent twice; a failed write puts the text back.
    if (op === 'add') input.value = '';
    setTaskBusy(true);
    inFlight++;
    let refetch = false;
    try {
      const body = { date, op };
      if (t && t.index !== undefined) { body.index = t.index; body.text = t.text; } else if (t) body.text = t.text;
      const p = await api('/api/today/task', { method: 'POST', body: JSON.stringify(body) });
      setTaskMsg('');
      if (n === seq) paint(p); else refetch = true;   // another request overtook this one: its answer may predate this write
    } catch (err) {
      if (op === 'add' && !input.value) input.value = t.text;
      if (n === seq) setTaskMsg(err.message);
      refetch = true;
    } finally {
      inFlight--;
      setTaskBusy(false);
    }
    if (refetch) reload({ quiet: true });
  }
  function onTaskClick(e) {
    const b = e.target.closest('.td-tchk, .td-tdel, .td-tfocus');
    const row = b && b.closest('.td-trow[data-index]');
    const t = row && P && P.day.tasks.find((x) => String(x.index) === row.dataset.index);
    if (!t || b.disabled) return;
    if (b.classList.contains('td-tfocus')) { aim(`task:${t.text}`); return; }
    taskOp(b.classList.contains('td-tdel') ? 'delete' : 'toggle', t);
  }
  function onTaskAdd(e) {
    e.preventDefault();
    const text = $('td-task-input').value.trim();
    if (text) taskOp('add', { text });
  }

  // #count is Today's while it's showing: today's habits and focus, whichever day is on screen.
  function paintCount() {
    if (!shown) return;
    $('count').textContent = daySummary();
  }

  function syncShuffle() {
    const left = shuffleUntil - Date.now();
    $('td-shuffle').disabled = left > 0;
    clearTimeout(shuffleT);
    if (left > 0) shuffleT = setTimeout(syncShuffle, left);
  }

  // ---------- Focus card, header chip, toasts ----------
  // Every payload, whatever day it's for, brings today's summary, the timer and the server's clock.
  function absorb(p) {
    setZone(p.timeZone);
    sum = p.summary;
    paintCount();
    if (!p.timer) return;
    tm = p.timer;
    offset = p.serverNow - Date.now();
    if (p.date === p.today) todayDay = { date: p.today, habits: p.habits, tasks: p.day.tasks || [], byHabit: p.focusByHabit || {} };
    // The picker follows a session it hasn't seen yet (started here or on another device); otherwise it keeps
    // the choice made on this page.
    if (tm.phase === 'focus' && tm.state !== 'idle' && tm.startedAt !== followed) { followed = tm.startedAt; pick = tm.target; }
    if (pick === null) pick = tm.target;
    paintFocus();
    syncLoop();
    toastEvent(p);
  }

  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };
  // Time left: counted from endsAt on the server's clock while running, as the server last said otherwise.
  function leftMs() {
    if (!tm) return 0;
    if (tm.state === 'running') return Math.max(0, tm.endsAt - (Date.now() + offset));
    if (tm.state === 'paused') return tm.leftMs;
    return tm.totalMs;
  }

  function paintFocus() {
    if (!tm || !P) return;
    const brk = tm.phase !== 'focus';
    const card = $('td-focus');
    card.classList.toggle('brk', brk);
    card.classList.toggle('run', tm.state === 'running');
    $('td-phase').textContent = PHASES[tm.phase] || tm.phase;
    const go = $('td-go');
    const label = tm.state === 'running' ? 'Pause' : tm.state === 'paused' ? 'Resume' : brk ? 'Start break' : 'Start';
    if (go.dataset.label !== label) {
      go.dataset.label = label;
      go.innerHTML = (tm.state === 'running' ? ICON.pause : ICON.play) + label;
    }
    const skip = $('td-skip');
    skip.title = brk ? 'Skip the break' : 'Skip to the break';
    $('td-reset').disabled = tm.state === 'idle';
    const dots = $('td-dots');
    if (dots.dataset.n !== String(tm.cycle)) {
      dots.dataset.n = String(tm.cycle);
      dots.replaceChildren(...[0, 1, 2, 3].map((i) => el('i', i < tm.cycle ? 'on' : '')));
      dots.setAttribute('aria-label', `${tm.cycle} of 4 sessions this cycle`);
    }
    paintPicker();
    paintLog();
    paintNextStart();
  }

  // Working on: the goal habits with today's minutes, today's open tasks, then Just focus. Locked in a break.
  function paintPicker() {
    const sel = $('td-target');
    const d = todayDay || { habits: [], tasks: [], byHabit: {} };
    const goals = d.habits.filter((h) => h.goal);
    const open = d.tasks.filter((t) => !t.done && !t.moved);
    // Next's Start on a target the list doesn't have (a Board task) adds it as a one-off option under Board.
    // It stays while it's picked or the session runs on it, and goes once the picker moves on.
    if (extra && extra.value !== pick && !(tm && tm.state !== 'idle' && tm.target === extra.value)) extra = null;
    const listed = (v) => v === 'focus' || goals.some((h) => h.id === v) || open.some((t) => `task:${t.text}` === v);
    const one = extra && !listed(extra.value) ? extra : null;
    const key = JSON.stringify([goals.map((h) => [h.id, h.name, d.byHabit[h.id] || 0, h.goal]), open.map((t) => t.text), one && [one.value, one.label]]);
    if (key !== pickKey) {
      pickKey = key;
      const kids = [];
      const group = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; g.append(...opts); return g; };
      if (goals.length) kids.push(group('Habits with a time goal', goals.map((h) => new Option(`${h.name} (${d.byHabit[h.id] || 0}/${h.goal})`, h.id))));
      if (open.length) kids.push(group("Today's tasks", open.map((t) => new Option(t.text, `task:${t.text}`))));
      if (one) kids.push(group('Board', [new Option(one.label, one.value)]));
      kids.push(new Option('Just focus', 'focus'));
      sel.replaceChildren(...kids);
    }
    sel.value = pick;
    if (sel.value !== pick) { pick = 'focus'; sel.value = 'focus'; }   // its task was done or deleted
    sel.disabled = !tm || tm.phase !== 'focus';
    // The server takes the target at Start only, so a change mid-session waits for the next one.
    $('td-fhint').classList.toggle('hidden', !tm || tm.phase !== 'focus' || tm.state === 'idle' || pick === tm.target);
  }

  // The log of the day on screen: time, target, minutes, then the day's total.
  function paintLog() {
    const list = P.day.focus || [];
    const onToday = P.date === P.today;
    const rows = list.map((f) => {
      const li = el('li');
      li.append(el('span', '', f.time), el('span', '', f.label), el('span', '', `${f.min}m`));
      return li;
    });
    if (list.length) {
      const tot = el('li', 'tot');
      const n = list.length;
      tot.append(el('span', '', onToday ? 'Today' : dayLabel(P.date)),
        el('span', '', `${fmtMin(list.reduce((a, f) => a + f.min, 0))} · ${n} session${n === 1 ? '' : 's'}`));
      rows.push(tot);
    } else rows.push(el('li', 'td-empty', onToday ? 'No sessions yet today.' : 'No sessions that day.'));
    $('td-log').replaceChildren(...rows);
    $('td-fnote').classList.toggle('hidden', onToday);
  }

  // The countdown runs only while a session does; it never stops because Today is hidden.
  function syncLoop() {
    const run = !!tm && tm.state === 'running';
    if (run && !tickT) tickT = setInterval(tick, TICK_MS);
    if (!run) {
      clearInterval(tickT); tickT = null;
      clearTimeout(zeroT); zeroT = null;
    }
    tick();
  }
  function tick() {
    const left = leftMs();
    const signedIn = !$('app').classList.contains('hidden');
    if (P) {
      $('td-clock').textContent = clock(left);
      $('td-ring-arc').setAttribute('stroke-dashoffset', (CIRC * (1 - (tm && tm.totalMs ? left / tm.totalMs : 1))).toFixed(2));
    }
    paintChip(left);
    if (P) paintNextStart();
    const base = document.title.replace(CHIP_PREFIX, '');
    const title = tm && tm.state === 'running' && signedIn ? `${clock(left)} · ${base}` : base;
    if (document.title !== title) document.title = title;
    // Zero: give the server a moment to log the session, then ask for the new state.
    if (tm && tm.state === 'running' && left <= 0 && !zeroT && signedIn) {
      if (zeroFor !== tm.endsAt) { zeroFor = tm.endsAt; zeroTries = 0; }
      zeroT = setTimeout(() => { zeroT = null; reload({ quiet: true }); }, ZERO_WAITS[Math.min(zeroTries++, ZERO_WAITS.length - 1)]);
    }
  }
  // The header chip, in every mode: time left and what it's for, while a session runs or is paused.
  function paintChip(left) {
    const c = $('today-chip');
    const on = !!tm && (tm.state === 'running' || tm.state === 'paused');
    c.classList.toggle('hidden', !on);
    if (!on) return;
    const brk = tm.phase !== 'focus';
    const what = brk ? PHASES[tm.phase] : tm.targetLabel;   // a break isn't spent on the last session's target
    c.querySelector('.tc-time').textContent = clock(left);
    const lbl = c.querySelector('.tc-label');
    if (lbl.textContent !== what) lbl.textContent = what;
    c.classList.toggle('paused', tm.state === 'paused');
    c.classList.toggle('brk', brk);
    const t = `${tm.state === 'paused' ? 'Paused: ' : ''}${what}. Open Today`;
    if (c.title !== t) c.title = t;
  }

  // A completion toasts once per tab, and only while it's news: under 2 minutes old by the server's own clock,
  // so a device whose clock is off can't age or freshen it. Ids are compared as a set, not "newer than": the
  // server's count starts again at 1 if .timer.json is ever lost.
  function seenIds() {
    try { const v = JSON.parse(sessionStorage.getItem(SEEN_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
  function toastEvent(p) {
    const e = p.timer.lastEvent;
    if (!e || e.id == null) return;
    const seen = seenIds();
    if (seen.includes(e.id) || !(p.serverNow - Date.parse(e.at) < TOAST_MAX_AGE)) return;
    if (!toasts) {
      toasts = TermToast.create({ onClick: () => setMode('today') });
      toasts.el.classList.add('td-toasts');
    }
    toasts.el.dataset.phone = window.matchMedia('(max-width: 700px)').matches ? '1' : '';
    toasts.push({ kind: 'done', title: e.text, id: `today-${e.id}` });
    if (soundOn()) TermToast.tone('focus');
    try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen, e.id].slice(-20))); } catch { /* private mode */ }
  }

  // One timer write at a time; the answer is today's payload. A past day on screen keeps its own cards.
  async function timerOp(action) {
    if (!tm || timerBusy) return;
    const body = { action };
    if (action === 'start' && tm.phase === 'focus') body.target = pick || 'focus';
    const n = ++seq;
    timerBusy = true;
    $('td-focus').setAttribute('aria-busy', 'true');
    inFlight++;
    let refetch = false;
    try {
      const p = await api('/api/today/timer', { method: 'POST', body: JSON.stringify(body) });
      if (n !== seq) refetch = true;   // overtaken: the newer answer may predate this write
      else if (p.date === cur) paint(p);
      else absorb(p);
    } catch (err) {
      toast(err.message);
      refetch = true;
    } finally {
      inFlight--;
      timerBusy = false;
      $('td-focus').setAttribute('aria-busy', 'false');
    }
    if (refetch) reload({ quiet: true });
  }
  function onFocusClick(e) {
    const b = e.target.closest('#td-go, #td-skip, #td-reset');
    if (!b || b.disabled || !tm) return;
    if (b.id === 'td-go') timerOp(tm.state === 'running' ? 'pause' : tm.state === 'paused' ? 'resume' : 'start');
    else timerOp(b.id === 'td-skip' ? 'skip' : 'reset');
  }
  function onPickerChange(e) {
    if (e.target.id !== 'td-target') return;
    pick = e.target.value;
    paintPicker();
  }
  // The Focus link on a goal habit and ▶ on a task: aim the picker there and bring the card into view.
  function aim(target) {
    pick = target;
    paintPicker();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('td-focus').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    const sel = $('td-target');
    (sel.disabled ? $('td-go') : sel).focus({ preventScroll: true });
  }

  // ---------- Loading ----------
  // Resolves false only when this request failed and no newer one has taken over.
  async function load(date, { quiet = false } = {}) {
    const n = ++seq;
    inFlight++;
    try {
      const p = await api('/api/today' + (date ? '?date=' + date : ''));
      if (n === seq) paint(p);
      return true;
    } catch (err) {
      if (n !== seq) return true;
      if (!P) { $('td-err').textContent = `Couldn't load Today. ${err.message}`; $('td-err').classList.remove('hidden'); return false; }
      cur = P.date;   // a failed step stays on the day that's showing
      if (!quiet) toast(err.message);
      return false;
    } finally {
      inFlight--;
    }
  }
  // The same day again. On "today" it asks for no date, so a tab left open over midnight moves to the new day.
  const reload = (opts) => load(!P || cur === P.today ? null : cur, opts);

  function step(n) {
    if (!P) return;
    const d = addDays(cur, n);
    if (d > P.today) return;
    cur = d;
    load(d === P.today ? null : d);
  }

  async function shuffle() {
    if (Date.now() < shuffleUntil) return;
    shuffleUntil = Date.now() + SHUFFLE_MS;
    syncShuffle();
    const n = ++seq;
    inFlight++;
    try {
      const p = await api('/api/today/quote', { method: 'POST', body: '{}' });
      if (n === seq) paint(p);
    } catch (err) {
      toast(err.message);
    } finally {
      inFlight--;
    }
  }

  // Quiet: a failed background reload leaves the page as it was, with no toast. It runs in every mode, so the
  // chip and the toasts hear of a session started or finished on another device within a minute. Resolves null
  // when skipped, else whether it worked.
  function poll() {
    if (inFlight || document.visibilityState !== 'visible' || $('app').classList.contains('hidden')) return Promise.resolve(null);
    return reload({ quiet: true });
  }
  // Becoming visible polls at once, and again after each wait in WAKE_RETRY_MS while it fails. A newer wake-up
  // takes over from an older one's retries.
  let wakeN = 0;
  async function onVisible() {
    if (document.visibilityState !== 'visible') return;
    const n = ++wakeN;
    for (const wait of [0, ...WAKE_RETRY_MS]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (n !== wakeN || (await poll()) !== false) return;
    }
  }

  function init() {
    if (inited) return;   // a second sign-in in the same page
    inited = true;
    build();
    $('td-prev').addEventListener('click', () => step(-1));
    $('td-nextday').addEventListener('click', () => step(1));
    $('td-next-start').addEventListener('click', onNextStart);
    $('td-next-open').addEventListener('click', onNextOpen);
    $('td-back').addEventListener('click', () => { if (P) { cur = P.today; load(null); } });
    $('td-shuffle').addEventListener('click', shuffle);
    $('td-habits').addEventListener('click', onHabitClick);
    $('td-hadd').addEventListener('click', () => openHabitForm(null));
    $('td-hform').addEventListener('submit', onHabitSave);
    $('td-hf-cancel').addEventListener('click', closeHabitForm);
    $('td-hf-del').addEventListener('click', onHabitRemove);
    $('td-hf-icons').addEventListener('click', onIconPick);
    $('td-hf-icons').addEventListener('keydown', onIconKey);
    $('td-hform').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeHabitForm(); $('td-hadd').focus(); } });
    $('td-tasks').addEventListener('click', onTaskClick);
    $('td-task-form').addEventListener('submit', onTaskAdd);
    $('td-focus').addEventListener('click', onFocusClick);
    $('td-focus').addEventListener('change', onPickerChange);
    $('today-chip').addEventListener('click', () => setMode('today'));
    // Settings → Appearance: the chime when a session ends (on unless set to 'off').
    segSet('segTodaySound', soundOn() ? 'on' : 'off');
    for (const b of document.querySelectorAll('#segTodaySound button')) b.addEventListener('click', () => {
      try { localStorage.setItem(SOUND_KEY, b.dataset.v); } catch { /* private mode */ }
      segSet('segTodaySound', b.dataset.v);
    });
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    // A page that opens on another mode still needs the timer for the chip: fetch once unless show() just did.
    setTimeout(() => { if (!P && !inFlight) load(null, { quiet: true }); }, 0);
  }
  function show() {
    shown = true;
    paintCount();
    reload();
    loadBoard();
  }
  // Hiding Today leaves the countdown, the chip and the toasts running.
  function hide() { shown = false; }
  // The header chip picked another workspace while Today shows: Next's Board fallback follows it.
  function onWorkspace() {
    if (!inited) return;
    loadBoard();
  }

  return { init, show, hide, onWorkspace, reload: () => { if (shown) loadBoard(); return reload(); } };
})();
