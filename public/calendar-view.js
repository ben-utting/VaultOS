'use strict';

// ========================================================================
// CalendarView — the strings and markup Calendar mode, the Due panel, the
// reminder toasts and Today's Coming up card show (window.CalendarView; also
// a Node module for the tests). Pure: no DOM, no clock of its own. Every text
// value an agent or the person wrote reaches the markup through esc().
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f(require('./calendar-core'));
  else root.CalendarView = f(root.CalendarCore);
})(typeof self !== 'undefined' ? self : this, function (CC) {
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MINUTES = { '5m': '5 min', '10m': '10 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day' };
  const MONTH_CELL_ITEMS = 3;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const parts = (d) => d.split('-').map(Number);
  const dShort = (d) => `${CC.DAY_SHORT[CC.weekday(d)]} ${parts(d)[2]}`;                          // Sat 21
  const dMon = (d) => `${dShort(d)} ${CC.MONTH_SHORT[parts(d)[1] - 1]}`;                          // Sat 21 Nov
  const dayMon = (d) => `${parts(d)[2]} ${CC.MONTH_SHORT[parts(d)[1] - 1]}`;                       // 21 Nov
  const wallHm = (ms, tz) => { const p = wall(ms, tz); return `${pad(p.h)}:${pad(p.mi)}`; };   // HH:MM in tz
  function wall(ms, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, h: p.hour === 24 ? 0 : p.hour, mi: p.minute };
  }
  const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

  // ---------- Labels ----------
  function dayLabel(date, today) {
    if (date === today) return `Today · ${dMon(date)}`;
    if (date === CC.addDays(today, 1)) return `Tomorrow · ${dMon(date)}`;
    return dMon(date);
  }
  const byText = (who) => (who && who.kind === 'agent' ? `Added by ${who.agent || 'an agent'}` : '');
  function pingText(o) {
    if (!o.ping) return '';
    if (o.allDay) return o.ping === '1d' ? 'Pings 08:00 the day before' : 'Pings 08:00 on the day';
    return o.ping === 'start' ? 'Pings at the start' : `Pings ${MINUTES[o.ping] || o.ping} before`;
  }
  const timeText = (o) => (o.allDay ? 'All day' : `${o.start}${o.end ? `–${o.end}` : ''}`);

  // ---------- Layouts ----------
  const order = (a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || String(a.start || '').localeCompare(String(b.start || '')) || String(a.title).localeCompare(String(b.title));
  function byDate(occurrences) {
    const m = new Map();
    for (const o of occurrences) { if (!m.has(o.date)) m.set(o.date, []); m.get(o.date).push(o); }
    for (const list of m.values()) list.sort(order);
    return m;
  }
  function gapLabel(a, b) {
    if (a === b) return `Nothing on ${dShort(a)}`;
    const sameMonth = parts(a)[1] === parts(b)[1];
    return sameMonth ? `Nothing on ${dShort(a)} – ${dShort(b)}` : `Nothing on ${dMon(a)} – ${dMon(b)}`;
  }
  // Agenda: one group per day with entries (today always), runs of empty days folded into one gap line.
  function agendaGroups(occurrences, from, days, today) {
    const m = byDate(occurrences);
    const out = [];
    let gap = null;
    const flush = () => { if (gap) out.push({ kind: 'gap', label: gapLabel(gap[0], gap[1]) }); gap = null; };
    for (let i = 0; i < days; i++) {
      const date = CC.addDays(from, i);
      const items = m.get(date) || [];
      if (!items.length && date !== today) { gap = gap ? [gap[0], date] : [date, date]; continue; }
      flush();
      out.push({ kind: 'day', date, label: dayLabel(date, today), today: date === today, past: date < today, items });
    }
    flush();
    return out;
  }
  function weekColumns(occurrences, monday, today) {
    const m = byDate(occurrences);
    return Array.from({ length: 7 }, (_, i) => {
      const date = CC.addDays(monday, i);
      return { date, label: dShort(date), today: date === today, past: date < today, items: m.get(date) || [] };
    });
  }
  // Month: Monday-first, the whole weeks that touch the month.
  function monthCells(occurrences, year, month, today) {
    const first = `${year}-${pad(month)}-01`;
    const last = `${year}-${pad(month)}-${pad(CC.daysInMonth(year, month))}`;
    const start = CC.mondayOf(first);
    const end = CC.addDays(CC.mondayOf(last), 6);
    const m = byDate(occurrences);
    const cells = [];
    for (let d = start; d <= end; d = CC.addDays(d, 1)) {
      const all = m.get(d) || [];
      cells.push({
        date: d, day: parts(d)[2], inMonth: parts(d)[1] === month, today: d === today, past: d < today,
        items: all.slice(0, MONTH_CELL_ITEMS), more: all.length > MONTH_CELL_ITEMS ? `+${all.length - MONTH_CELL_ITEMS} more` : '',
      });
    }
    return cells;
  }
  function rangeTitle(view, from) {
    if (view === 'month') return `${MONTH_LONG[parts(from)[1] - 1]} ${parts(from)[0]}`;
    if (view === 'week') {
      const mon = CC.mondayOf(from);
      const sun = CC.addDays(mon, 6);
      const [y1, m1, d1] = parts(mon);
      const [y2, m2, d2] = parts(sun);
      if (y1 !== y2) return `${dayMon(mon)} ${y1} – ${dayMon(sun)} ${y2}`;
      if (m1 !== m2) return `${dayMon(mon)} – ${dayMon(sun)} ${y2}`;
      return `${d1} – ${d2} ${CC.MONTH_SHORT[m2 - 1]} ${y2}`;
    }
    return `${dMon(from)} – ${dMon(CC.addDays(from, 13))}`;
  }

  // ---------- Due and toasts ----------
  function dueWhen(pingAt, tz, now) {
    const p = wall(toMs(pingAt), tz);
    const today = CC.todayIn(tz, now);
    const hm = `${pad(p.h)}:${pad(p.mi)}`;
    if (p.date === today) return `Due ${hm} today`;
    if (p.date === CC.addDays(today, -1)) return `Due yesterday ${hm}`;
    return `Due ${dMon(p.date)} ${hm}`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function toastWhen(item, tz, now) {
    const today = CC.todayIn(tz, now);
    const yesterday = CC.addDays(today, -1);
    const day = (d) => (d === yesterday ? 'Yesterday' : d === CC.addDays(today, 1) ? 'Tomorrow' : dMon(d));
    if (item.allDay) return item.date === today ? 'All day' : `${day(item.date)} · All day`;
    if (item.date !== today) return `${day(item.date)} ${item.start}`;
    const mins = Math.round((CC.wallMs(item.date, item.start, tz) - now) / 60000);
    if (mins <= 0) return `${item.start} · now`;
    if (mins < 60) return `${item.start} · in ${plural(mins, 'minute')}`;
    return `${item.start} · in ${plural(Math.round(mins / 60), 'hour')}`;
  }

  // ---------- What's new since the last poll ----------
  // A device remembers the due items it has toasted by key and the moment each became due, so one that comes
  // back when its snooze runs out (same key, later dueSince) counts as new again.
  const seenToken = (item) => `${item.key}|${item.dueSince || item.pingAt}`;
  function freshItems(items, seen) {
    const has = seen instanceof Set ? (t) => seen.has(t) : (t) => seen.includes(t);
    return items.filter((i) => !has(seenToken(i)));
  }
  // What the Due panel shows; the panel repaints only when this changes, so focus and an open menu survive a poll.
  const dueSignature = (items) => JSON.stringify(items.map((i) => [seenToken(i), i.missedEarlier, i.title, i.card ? [i.card.title, i.card.exists] : null, i.by]));

  // ---------- Markup ----------
  const BELL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const cardName = (c) => (c.exists === false ? `${c.title} (card not found)` : c.title);
  function entryRowHtml(o) {
    const meta = [];
    if (o.card) meta.push(`<span class="cal-chip${o.card.exists === false ? ' cal-chip-gone' : ''}">${esc(cardName(o.card))}</span>`);
    for (const t of [o.repeatText, pingText(o), byText(o.created && o.created.by)]) if (t) meta.push(`<span>${esc(t)}</span>`);
    return `<button type="button" class="cal-row" data-entry="${esc(o.entryId)}" data-date="${esc(o.date)}">`
      + `<span class="cal-row-time">${esc(timeText(o))}</span>`
      + `<span class="cal-row-main"><span class="cal-row-title">${esc(o.title)}</span>`
      + (meta.length ? `<span class="cal-row-meta">${meta.join('<span class="cal-dot" aria-hidden="true">·</span>')}</span>` : '')
      + '</span></button>';
  }
  // The Agent button (spec 2026-11-19 §5.1): agent = { label, mark } (mark: the agent's own SVG, from AgentMarks,
  // trusted) or null for no button. entryId/date say what to brief; compact (Today's Coming up) drops the word.
  function agentButtonHtml(agent, { entryId = '', date = '', compact = false } = {}) {
    if (!agent) return '';
    const label = String(agent.label || 'the agent');
    return `<button type="button" class="${compact ? 'cal-agent cal-agent-c' : 'su-btn su-sm cal-agent'}" data-act="agent"`
      + ` data-entry="${esc(entryId)}" data-date="${esc(date || '')}"`
      + ` data-tip="${esc(`Open ${label} on this reminder. It reads the note and the card, then asks you what to do.`)}"`
      + ` aria-label="${esc(`Open ${label} on this reminder`)}">${agent.mark || ''}${compact ? '' : '<span>Agent</span>'}</button>`;
  }
  // Clear (card 84): takes this date off the calendar (a one-off to Recently deleted), with an Undo toast.
  const CLEAR_BTN = '<button type="button" class="su-btn su-sm" data-act="clear" data-tip="Take it off the calendar. A one-off goes to Recently deleted; a repeat loses just this date.">Clear</button>';
  function dueItemHtml(item, tz = 'UTC', now = Date.now(), agent = null) {
    const meta = [`<span class="cal-due-when">${esc(dueWhen(item.pingAt, tz, now))}</span>`];
    if (item.missedEarlier) meta.push(`<span class="cal-due-missed">+${esc(item.missedEarlier)} missed earlier</span>`);
    if (item.by) meta.push(`<span>${esc(`Added by ${item.by}`)}</span>`);
    const card = item.card
      ? `<button type="button" class="cal-chip cal-card" data-card="${esc(item.card.path)}" data-board="${esc(item.card.board || '')}"${item.card.exists === false ? ' disabled' : ''}>${esc(cardName(item.card))}</button>`
      : '';
    return `<li class="cal-due-item" data-key="${esc(item.key)}" data-entry="${esc(item.entryId)}">`
      + `<div class="cal-due-main"><span class="cal-due-title">${esc(item.title)}</span>`
      + `<span class="cal-due-meta">${meta.join('<span class="cal-dot" aria-hidden="true">·</span>')}</span>${card}</div>`
      + '<div class="cal-due-acts">'
      + '<button type="button" class="su-btn su-sm primary" data-act="done">Done</button>'
      + '<button type="button" class="su-btn su-sm" data-act="snooze" aria-haspopup="menu" aria-expanded="false">Snooze ▾</button>'
      + '<button type="button" class="su-btn su-sm" data-act="dismiss">Dismiss</button>'
      + CLEAR_BTN
      + agentButtonHtml(agent, { entryId: item.entryId, date: item.date })
      + '</div></li>';
  }
  function toastHtml(item, tz, now, agent = null) {
    const sub = [toastWhen(item, tz, now), item.card ? item.card.title : ''].filter(Boolean).join(' · ');
    return `<div class="cal-toast" role="status" data-key="${esc(item.key || '')}" data-entry="${esc(item.entryId || '')}">`
      + `<span class="cal-toast-bell">${BELL}</span>`
      + `<div class="cal-toast-text"><strong>${esc(item.title)}</strong><span>${esc(sub)}</span></div>`
      + '<div class="cal-toast-acts"><button type="button" class="su-btn su-sm primary" data-act="done">Done</button>'
      + '<button type="button" class="su-btn su-sm" data-act="snooze10">Snooze 10m</button>'
      + CLEAR_BTN
      + agentButtonHtml(agent, { entryId: item.entryId, date: item.date })
      + `</div><button type="button" class="cal-toast-x" data-act="close" aria-label="Close (it stays in the Due list)">${CLOSE}</button></div>`;
  }

  return {
    esc, dayLabel, agendaGroups, weekColumns, monthCells, rangeTitle, dueWhen, toastWhen, byText, pingText, timeText,
    seenToken, freshItems, dueSignature,
    entryRowHtml, dueItemHtml, toastHtml, agentButtonHtml, BELL, MONTH_LONG, wallHm, dMon,
  };
});
