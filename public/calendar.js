'use strict';

// ========================================================================
// Calendar mode (window.Calendar): Agenda, Week and Month over
// /api/calendar (lib/calendar-service.js), Recently deleted, and the entry
// panel (the Automations builder's right-hand panel). The layouts and every
// string come from CalendarView; titles, notes and card names reach the page
// through its esc(). Refreshes on show, after every write, and every 60 s
// while shown and the page is visible.
// Uses app.js's globals: $, toast, setMode, showLogin, calendarOn, ME.
// ========================================================================

(function () {
  const CC = window.CalendarCore;
  const CV = window.CalendarView;
  const esc = CV.esc;
  const VIEW_KEY = 'vaultboard.calendar.view';
  const REFRESH_MS = 60000;
  const VIEWS = ['agenda', 'week', 'month'];
  const REPEAT_CHOICES = [['none', 'None'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
  const PING_TIMED = [['none', 'None'], ['start', 'At start'], ['5m', '5 min'], ['10m', '10 min'], ['15m', '15 min'], ['30m', '30 min'], ['1h', '1 hour'], ['1d', 'Day before']];
  const PING_ALLDAY = [['none', 'None'], ['start', '08:00 on the day'], ['1d', 'Day before']];
  const FIELDS = ['title', 'date', 'allDay', 'start', 'end', 'repeat', 'ping', 'card', 'note', 'skip'];

  const readView = () => { try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : 'agenda'; } catch { return 'agenda'; } };
  const CAL = {
    view: readView(), anchor: null, tz: null, data: null, deleted: [], showDeleted: false,
    visible: false, timer: null, loading: 0,
  };
  const today = () => CC.todayIn(CAL.tz || 'UTC', Date.now());

  // fetch that keeps the field errors (app.js's api() keeps only the message).
  async function call(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { if (typeof showLogin === 'function') showLogin(); throw new Error('Not authenticated'); }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // ---------- Ranges ----------
  function rangeOf(view, anchor) {
    if (view === 'week') { const m = CC.mondayOf(anchor); return [m, CC.addDays(m, 6)]; }
    if (view === 'month') {
      const [y, mo] = anchor.split('-').map(Number);
      const first = `${y}-${String(mo).padStart(2, '0')}-01`;
      const last = `${y}-${String(mo).padStart(2, '0')}-${String(CC.daysInMonth(y, mo)).padStart(2, '0')}`;
      return [CC.mondayOf(first), CC.addDays(CC.mondayOf(last), 6)];
    }
    return [anchor, CC.addDays(anchor, 13)];
  }
  function step(dir) {
    const a = CAL.anchor || today();
    if (CAL.view === 'week') CAL.anchor = CC.addDays(CC.mondayOf(a), 7 * dir);
    else if (CAL.view === 'month') {
      let [y, mo] = a.split('-').map(Number);
      mo += dir;
      if (mo < 1) { mo = 12; y--; } else if (mo > 12) { mo = 1; y++; }
      CAL.anchor = `${y}-${String(mo).padStart(2, '0')}-01`;
    } else CAL.anchor = CC.addDays(a, 14 * dir);
    load();
  }

  // ---------- Loading ----------
  async function load() {
    const n = ++CAL.loading;
    try {
      if (!CAL.tz) {
        const first = await call('/api/calendar');
        if (!first.ok) throw new Error(first.data.error || 'The calendar could not be read');
        CAL.tz = first.data.timezone;
      }
      if (!CAL.anchor) CAL.anchor = today();
      const [from, to] = rangeOf(CAL.view, CAL.anchor);
      const [r, d] = await Promise.all([call(`/api/calendar?from=${from}&to=${to}`), call('/api/calendar/deleted')]);
      if (n !== CAL.loading) return;   // a newer load started
      if (!r.ok) throw new Error(r.data.error || 'The calendar could not be read');
      CAL.data = r.data;
      CAL.tz = r.data.timezone;
      CAL.deleted = d.ok ? d.data.entries : [];
      banner('');
      render();
    } catch (err) {
      if (n !== CAL.loading) return;
      banner(err.message);
    }
  }
  function banner(msg) {
    $('cal-banner').textContent = msg;
    $('cal-banner').classList.toggle('hidden', !msg);
  }
  function schedule() {
    clearTimeout(CAL.timer);
    CAL.timer = null;
    if (!CAL.visible) return;
    CAL.timer = setTimeout(() => { if (document.visibilityState === 'visible') load(); schedule(); }, REFRESH_MS);
  }

  // ---------- Rendering ----------
  function render() {
    const d = CAL.data;
    if (!d) return;
    const t = today();
    const [from] = rangeOf(CAL.view, CAL.anchor);
    $('cal-title').textContent = CV.rangeTitle(CAL.view, CAL.view === 'month' ? CAL.anchor : from);
    for (const b of $('cal-views').querySelectorAll('button')) {
      const on = b.dataset.v === CAL.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    if (CAL.visible) $('count').textContent = `${d.counts.today} today · ${d.counts.week} this week`;
    const body = $('cal-body');
    body.dataset.view = CAL.view;
    if (CAL.view === 'week') body.innerHTML = weekHtml(d.occurrences, CC.mondayOf(CAL.anchor), t);
    else if (CAL.view === 'month') body.innerHTML = monthHtml(d.occurrences, CAL.anchor, t);
    else body.innerHTML = agendaHtml(d.occurrences, from, t);
    renderDeleted();
  }
  function agendaHtml(occ, from, t) {
    const groups = CV.agendaGroups(occ, from, 14, t);
    const out = groups.map((g) => {
      if (g.kind === 'gap') return `<p class="cal-gap">${esc(g.label)}</p>`;
      const rows = g.items.length ? g.items.map(CV.entryRowHtml).join('') : '<p class="cal-none">Nothing today.</p>';
      return `<section class="cal-day${g.today ? ' is-today' : ''}${g.past ? ' is-past' : ''}"><h3 class="cal-day-h">${esc(g.label)}</h3><div class="cal-rows">${rows}</div></section>`;
    });
    return out.join('');
  }
  const miniHtml = (o) => `<button type="button" class="cal-mini" data-entry="${esc(o.entryId)}" data-date="${esc(o.date)}">`
    + `<span class="cal-mini-t">${esc(o.allDay ? 'All day' : o.start)}</span><span class="cal-mini-title">${esc(o.title)}</span>`
    + `${o.created && o.created.by && o.created.by.kind === 'agent' ? `<span class="cal-mini-by">${esc(CV.byText(o.created.by))}</span>` : ''}</button>`;
  function weekHtml(occ, monday, t) {
    return `<div class="cal-week">${CV.weekColumns(occ, monday, t).map((c) => `<section class="cal-col${c.today ? ' is-today' : ''}${c.past ? ' is-past' : ''}">`
      + `<h3 class="cal-col-h">${esc(c.label)}</h3>${c.items.length ? c.items.map(miniHtml).join('') : '<p class="cal-none">Nothing</p>'}</section>`).join('')}</div>`;
  }
  function monthHtml(occ, anchor, t) {
    const [y, mo] = anchor.split('-').map(Number);
    const head = CC.DAY_SHORT.map((d) => `<span class="cal-wd">${d}</span>`).join('');
    const cells = CV.monthCells(occ, y, mo, t).map((c) => {
      const lines = c.items.map((o) => `<span class="cal-cell-e"><span class="cal-cell-t">${esc(o.allDay ? '' : o.start)}</span> ${esc(o.title)}</span>`).join('');
      const n = c.items.length + (c.more ? Number(c.more.replace(/\D/g, '')) : 0);
      const label = `${CV.dMon(c.date)}${n ? `, ${n} ${n === 1 ? 'entry' : 'entries'}` : ''}`;
      return `<button type="button" class="cal-cell${c.inMonth ? '' : ' is-out'}${c.today ? ' is-today' : ''}${c.past ? ' is-past' : ''}" data-day="${c.date}" aria-label="${esc(label)}">`
        + `<span class="cal-cell-n">${c.day}</span>${lines}${c.more ? `<span class="cal-cell-more">${esc(c.more)}</span>` : ''}`
        + `${n ? `<span class="cal-cell-dots" aria-hidden="true">${'•'.repeat(Math.min(n, 4))}</span>` : ''}</button>`;
    }).join('');
    return `<div class="cal-month"><div class="cal-wds">${head}</div><div class="cal-grid">${cells}</div></div>`;
  }
  function renderDeleted() {
    const n = CAL.deleted.length;
    $('cal-deleted-btn').textContent = `Recently deleted (${n})`;
    $('cal-deleted-btn').classList.toggle('hidden', !n);
    $('cal-deleted-btn').setAttribute('aria-expanded', String(CAL.showDeleted && n > 0));
    const box = $('cal-deleted');
    box.classList.toggle('hidden', !(CAL.showDeleted && n));
    box.innerHTML = CAL.deleted.map((e) => `<div class="cal-del-row"><span class="cal-del-t">${esc(e.title)}</span>`
      + `<span class="cal-del-m">${esc([CV.dMon(e.date), e.repeatText, `deleted ${CV.dMon(String(e.deletedAt).slice(0, 10))}`].filter(Boolean).join(' · '))}</span>`
      + `<button type="button" class="su-btn su-sm" data-restore="${esc(e.id)}">Restore</button></div>`).join('');
  }

  // ---------- The entry panel ----------
  const P = { id: null, date: null, entry: null, repeat: 'none', days: [], until: null, ping: 'start', card: null, confirming: false };
  const repeatOf = () => {
    if (P.repeat === 'none') return null;
    const r = { every: P.repeat };
    if (P.repeat === 'weekly') r.days = [...P.days].sort((a, b) => a - b);
    if (P.until) r.until = P.until;
    return r;
  };
  function nextHour() {
    const w = CV.wallHm(Date.now() + 3600000, CAL.tz || 'UTC');
    return `${w.slice(0, 2)}:00`;
  }
  function chips(el, list, value) {
    el.innerHTML = list.map(([v, label]) => `<button type="button" class="ab-chip" data-v="${v}" aria-pressed="${v === value}">${esc(label)}</button>`).join('');
  }
  function paintRepeat() {
    chips($('ce-repeat'), REPEAT_CHOICES, P.repeat);
    $('ce-days').classList.toggle('hidden', P.repeat !== 'weekly');
    $('ce-days').innerHTML = CC.DAY_SHORT.map((d, i) => `<button type="button" class="ab-chip" data-v="${i}" aria-pressed="${P.days.includes(i)}">${d}</button>`).join('');
    $('ce-until-row').classList.toggle('hidden', P.repeat === 'none');
    $('ce-until-none').classList.toggle('hidden', !!P.until);
    $('ce-until-set').classList.toggle('hidden', !P.until);
    $('ce-until').value = P.until || '';
  }
  function paintPing() {
    const allDay = $('ce-allday').checked;
    const list = allDay ? PING_ALLDAY : PING_TIMED;
    if (!list.some(([v]) => v === P.ping)) P.ping = 'start';
    chips($('ce-ping'), list, P.ping);
  }
  function paintAllDay() {
    const allDay = $('ce-allday').checked;
    $('ce-times').classList.toggle('hidden', allDay);
    paintPing();
  }
  function paintCard() {
    const c = P.card;
    $('ce-card-chip').classList.toggle('hidden', !c);
    $('ce-card-edit').classList.toggle('hidden', !c);
    $('ce-card-link').classList.toggle('hidden', !!c);
    if (c) $('ce-card-chip').textContent = c.exists === false ? `${c.title} (card not found)` : c.title;
    $('ce-card-pick').classList.add('hidden');
  }
  function clearErrors() {
    for (const f of FIELDS) { const el = $(`ce-${f}-err`); if (el) el.textContent = ''; }
    $('ce-err').textContent = '';
  }
  function showErrors(errors) {
    let shown = false;
    for (const [f, msg] of Object.entries(errors || {})) {
      const el = $(`ce-${f}-err`);
      if (el) { el.textContent = msg; shown = true; } else $('ce-err').textContent = msg;
    }
    if (!shown && !$('ce-err').textContent) $('ce-err').textContent = 'Check the fields above';
  }
  const whoName = (w) => (w && w.kind === 'agent' ? w.agent || 'an agent' : 'you');
  const stamp = (at) => (at ? `${CV.dMon(CC.todayIn(CAL.tz || 'UTC', Date.parse(at)))} ${CV.wallHm(Date.parse(at), CAL.tz || 'UTC')}` : '');
  function metaLine(e) {
    if (!e || !e.created) return '';
    const parts = [`Added by ${whoName(e.created.by)} · ${stamp(e.created.at)}`];
    if (e.updated && e.updated.at !== e.created.at) parts.push(`Changed by ${whoName(e.updated.by)} · ${stamp(e.updated.at)}`);
    return parts.join(' · ');
  }

  function fill(e, date) {
    P.entry = e;
    P.id = e ? e.id : null;
    P.date = date || null;
    P.confirming = false;
    $('ce-head').textContent = e ? 'Edit entry' : 'New entry';
    $('ce-title').value = e ? e.title : '';
    $('ce-date').value = e ? e.date : (CAL.anchor && CAL.view === 'agenda' && CAL.anchor > today() ? CAL.anchor : today());
    $('ce-allday').checked = e ? e.allDay : false;
    $('ce-start').value = e && e.start ? e.start : nextHour();
    $('ce-end').value = e && e.end ? e.end : '';
    P.repeat = e && e.repeat ? e.repeat.every : 'none';
    P.days = e && e.repeat && e.repeat.days ? [...e.repeat.days] : [CC.weekday($('ce-date').value || today())];
    P.until = e && e.repeat && e.repeat.until ? e.repeat.until : null;
    P.ping = e ? (e.ping || 'none') : 'start';
    P.card = e && e.card ? e.card : null;
    $('ce-note').value = e ? e.note : '';
    $('ce-meta').textContent = metaLine(e);
    $('ce-delete').classList.toggle('hidden', !e);
    $('ce-skip').classList.toggle('hidden', !(e && e.repeat && date));
    $('ce-save').textContent = e ? 'Save' : 'Add';
    $('ce-confirm').classList.add('hidden');
    $('ce-actions').classList.remove('hidden');
    clearErrors();
    paintRepeat();
    paintAllDay();
    paintCard();
  }
  function openPanel() {
    $('cal-panel').classList.remove('hidden');
    $('cal-scrim').classList.remove('hidden');
    $('cal-panel').scrollTop = 0;
    $('ce-title').focus({ preventScroll: true });
  }
  function closePanel() {
    $('cal-panel').classList.add('hidden');
    $('cal-scrim').classList.add('hidden');
    P.entry = null;
    P.id = null;
  }
  const panelOpen = () => !$('cal-panel').classList.contains('hidden');
  function openNew() { fill(null, null); openPanel(); }
  async function openEntry(entryId, date) {
    const r = await call(`/api/calendar/entry/${encodeURIComponent(entryId)}`);
    if (!r.ok) { toast(r.data.error || 'That entry is gone'); return; }
    fill(r.data.entry, date);
    openPanel();
  }
  function formValue() {
    const allDay = $('ce-allday').checked;
    return {
      title: $('ce-title').value, date: $('ce-date').value, allDay,
      start: allDay ? null : $('ce-start').value || null, end: allDay ? null : $('ce-end').value || null,
      repeat: repeatOf(), ping: P.ping === 'none' ? null : P.ping, card: P.card ? P.card.path : null, note: $('ce-note').value,
    };
  }
  async function save() {
    clearErrors();
    const body = formValue();
    if (P.repeat === 'weekly' && !P.days.length) { $('ce-repeat-err').textContent = 'Pick at least one day'; return; }
    $('ce-save').disabled = true;
    try {
      const r = P.id
        ? await call(`/api/calendar/entry/${encodeURIComponent(P.id)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await call('/api/calendar/entry', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) {
        if (r.data.errors) showErrors(r.data.errors); else $('ce-err').textContent = r.data.error || 'Not saved';
        return;
      }
      closePanel();
      toast(P.id ? 'Saved' : `Added: ${r.data.entry.title}`, { tone: 'info' });
      await afterWrite();
    } catch (err) {
      $('ce-err').textContent = err.message;
    } finally {
      $('ce-save').disabled = false;
    }
  }
  async function afterWrite() {
    await load();
    if (window.CalendarDue) CalendarDue.refresh();
    if (window.Today && Today.refreshComing) Today.refreshComing();
  }
  function askDelete() {
    const e = P.entry;
    if (!e) return;
    const series = !!(e.repeat && P.date);
    $('ce-confirm-t').textContent = series ? 'Delete this one, or the whole series?' : 'Delete this entry? It stays in Recently deleted for 30 days.';
    $('ce-del-one').classList.toggle('hidden', !series);
    $('ce-del-all').textContent = series ? 'Whole series' : 'Delete';
    P.confirming = true;
    $('ce-actions').classList.add('hidden');
    $('ce-confirm').classList.remove('hidden');
    (series ? $('ce-del-one') : $('ce-del-all')).focus();
  }
  function cancelDelete() {
    P.confirming = false;
    $('ce-confirm').classList.add('hidden');
    $('ce-actions').classList.remove('hidden');
    $('ce-delete').focus();
  }
  async function skipDate() {
    const r = await call(`/api/calendar/entry/${encodeURIComponent(P.id)}/skip`, { method: 'POST', body: JSON.stringify({ date: P.date }) });
    if (!r.ok) { $('ce-err').textContent = r.data.error || 'Not skipped'; return; }
    closePanel();
    toast(`Skipped ${CV.dMon(P.date || r.data.entry.date)}`, { tone: 'info' });
    await afterWrite();
  }
  async function deleteAll() {
    const id = P.id;
    const title = P.entry ? P.entry.title : '';
    const r = await call(`/api/calendar/entry/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) { $('ce-err').textContent = r.data.error || 'Not deleted'; cancelDelete(); return; }
    closePanel();
    toast(`Deleted: ${title}`, { action: 'Undo', onAction: () => restore(id) });
    await afterWrite();
  }
  async function restore(id) {
    const r = await call(`/api/calendar/deleted/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if (!r.ok) { toast(r.data.error || 'Not restored'); return; }
    toast(`Restored: ${r.data.entry.title}`, { tone: 'info' });
    await afterWrite();
  }

  // The card picker: titles across every workspace.
  let pickTimer = null;
  function openPicker() {
    $('ce-card-pick').classList.remove('hidden');
    $('ce-card-link').classList.add('hidden');
    $('ce-card-q').value = '';
    $('ce-card-q').focus();
    searchCards('');
  }
  async function searchCards(q) {
    const r = await call(`/api/calendar/cards?q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const ws = (typeof WORKSPACE_LIST !== 'undefined' ? WORKSPACE_LIST : []);
    const label = (k) => { const w = ws.find((x) => x.key === k); return w ? w.label : k || ''; };
    $('ce-card-res').innerHTML = r.data.cards.length
      ? r.data.cards.map((c) => `<li><button type="button" class="cal-pick" data-path="${esc(c.path)}" data-title="${esc(c.title)}" data-board="${esc(c.board)}">`
        + `<span>${esc(c.title)}</span><span class="cal-pick-b">${esc(label(c.board))}</span></button></li>`).join('')
      : '<li class="cal-none">No cards match</li>';
  }

  // ---------- Events ----------
  $('mode-calendar').addEventListener('click', () => setMode('calendar'));
  $('cal-prev').addEventListener('click', () => step(-1));
  $('cal-next').addEventListener('click', () => step(1));
  $('cal-today').addEventListener('click', () => { CAL.anchor = today(); load(); });
  $('cal-views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === CAL.view) return;
    CAL.view = b.dataset.v;
    try { localStorage.setItem(VIEW_KEY, CAL.view); } catch { /* private window: not remembered */ }
    CAL.anchor = CAL.view === 'week' ? CC.mondayOf(CAL.anchor || today()) : CAL.anchor || today();
    load();
  });
  $('cal-new').addEventListener('click', openNew);
  $('cal-body').addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]');
    if (day) { CAL.view = 'agenda'; CAL.anchor = day.dataset.day; try { localStorage.setItem(VIEW_KEY, 'agenda'); } catch { /* not remembered */ } load(); return; }
    const row = e.target.closest('[data-entry]');
    if (row) openEntry(row.dataset.entry, row.dataset.date);
  });
  $('cal-deleted-btn').addEventListener('click', () => { CAL.showDeleted = !CAL.showDeleted; renderDeleted(); });
  $('cal-deleted').addEventListener('click', (e) => { const b = e.target.closest('[data-restore]'); if (b) restore(b.dataset.restore); });

  $('ce-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('ce-save').addEventListener('click', save);
  $('ce-cancel').addEventListener('click', closePanel);
  $('ce-close').addEventListener('click', closePanel);
  $('cal-scrim').addEventListener('click', closePanel);
  $('ce-allday').addEventListener('change', paintAllDay);
  $('ce-date').addEventListener('change', () => { if (P.repeat === 'weekly' && P.days.length <= 1) { P.days = [CC.weekday($('ce-date').value)]; paintRepeat(); } });
  $('ce-repeat').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    P.repeat = b.dataset.v;
    if (P.repeat === 'weekly' && !P.days.length && CC.isDate($('ce-date').value)) P.days = [CC.weekday($('ce-date').value)];
    paintRepeat();
  });
  $('ce-days').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const d = Number(b.dataset.v);
    P.days = P.days.includes(d) ? P.days.filter((x) => x !== d) : [...P.days, d];
    paintRepeat();
  });
  $('ce-until-add').addEventListener('click', () => { P.until = CC.addDays($('ce-date').value || today(), 28); paintRepeat(); $('ce-until').focus(); });
  $('ce-until-clear').addEventListener('click', () => { P.until = null; paintRepeat(); });
  $('ce-until').addEventListener('change', () => { P.until = $('ce-until').value || null; });
  $('ce-ping').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { P.ping = b.dataset.v; paintPing(); } });
  $('ce-card-link').addEventListener('click', openPicker);
  $('ce-card-change').addEventListener('click', openPicker);
  $('ce-card-remove').addEventListener('click', () => { P.card = null; paintCard(); });
  $('ce-card-q').addEventListener('input', () => { clearTimeout(pickTimer); pickTimer = setTimeout(() => searchCards($('ce-card-q').value), 200); });
  $('ce-card-res').addEventListener('click', (e) => {
    const b = e.target.closest('.cal-pick');
    if (!b) return;
    P.card = { path: b.dataset.path, title: b.dataset.title, exists: true, board: b.dataset.board };
    paintCard();
  });
  $('ce-delete').addEventListener('click', askDelete);
  $('ce-keep').addEventListener('click', cancelDelete);
  $('ce-del-one').addEventListener('click', skipDate);
  $('ce-del-all').addEventListener('click', deleteAll);
  $('ce-skip').addEventListener('click', skipDate);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen()) { e.stopPropagation(); if (P.confirming) cancelDelete(); else closePanel(); }
  }, true);
  document.addEventListener('visibilitychange', () => { if (CAL.visible && document.visibilityState === 'visible') load(); });

  // ---------- The mode ----------
  window.Calendar = {
    init() {},
    show() {
      CAL.visible = true;
      if (CAL.data) render();
      load();
      schedule();
    },
    hide() {
      CAL.visible = false;
      schedule();
      if (panelOpen()) closePanel();
    },
    // Settings changed what is on (applyMe).
    featureChanged() {
      if (!calendarOn()) { CAL.data = null; CAL.tz = null; clearTimeout(CAL.timer); CAL.timer = null; }
    },
    openEntry,
    openNew,
    refresh() { if (CAL.visible) return load(); return Promise.resolve(); },
  };
})();
