'use strict';

// ========================================================================
// CalendarClear — the calendar's Clear button (card 84): take one date off
// the calendar. A one-off goes to Recently deleted (restorable for 30 days);
// a repeat loses only that date. An Undo toast puts it back: a restore for a
// one-off, the skip taken out again for a repeat. Done keeps its own meaning
// (it only stops the ping). Globals used at call time: toast, showLogin,
// CalendarView, CalendarDue, Calendar, Today.
// ========================================================================

(function () {
  const HEADERS = { 'Content-Type': 'application/json' };

  function refreshAll() {
    if (window.CalendarDue) CalendarDue.refresh();
    if (window.Calendar && Calendar.refresh) Calendar.refresh();
    if (window.Today && Today.refreshComing) Today.refreshComing();
  }

  // fetch → { res, data }, or null after saying why (signed out, VaultOS not answering).
  async function send(url, method, body) {
    let res;
    try { res = await fetch(url, { method, headers: HEADERS, body: JSON.stringify(body || {}) }); } catch {
      toast("VaultOS isn't answering");
      return null;
    }
    if (res.status === 401) { if (typeof showLogin === 'function') showLogin(); return null; }
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function undo(c) {
    const e = c.entry;
    const r = c.cleared === 'date'
      ? await send(`/api/calendar/entry/${encodeURIComponent(e.id)}`, 'PUT', { skip: (e.skip || []).filter((d) => d !== c.date) })
      : await send(`/api/calendar/deleted/${encodeURIComponent(e.id)}/restore`, 'POST');
    if (!r) return;
    if (!r.res.ok) { toast(r.data.error || 'It could not be put back'); return; }
    toast(`Back on the calendar: ${e.title}`, { tone: 'info' });
    refreshAll();
  }

  // date: the occurrence's YYYY-MM-DD (a one-off may leave it out).
  async function clear(entryId, date) {
    const r = await send(`/api/calendar/entry/${encodeURIComponent(entryId)}/clear`, 'POST', date ? { date } : {});
    if (!r) return;
    if (!r.res.ok) { toast(r.res.status === 404 ? 'This reminder was deleted.' : r.data.error || 'It could not be cleared'); return; }
    const c = r.data;
    refreshAll();
    const what = c.cleared === 'date' ? `Cleared ${CalendarView.dMon(c.date)}: ${c.entry.title}` : `Cleared: ${c.entry.title}`;
    toast(what, { action: 'Undo', onAction: () => undo(c), ms: 8000, tone: 'info' });
  }

  window.CalendarClear = { clear };
})();
