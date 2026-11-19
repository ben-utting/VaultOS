'use strict';

// ========================================================================
// CalendarAgent — the calendar's Agent button (spec 2026-11-19 §5): which
// agent a button shows, and what a press does. The server builds the start
// command (GET /api/calendar/entry/:id/agent): the agent's start command with
// a fixed check-in that only carries the entry id and the date. A press opens
// a terminal the way the card drawer's Start agent does, or goes to the agent
// already working that card. Nothing here marks a reminder Done.
// Globals used at call time: ME, termOn, calendarOn, termOpen, twNewId,
// goToAgent, TASK_AGENTS, toast, showLogin, AgentMarks.
// ========================================================================

(function () {
  const GUARD_MS = 2000;
  const recent = new Map();   // entryId@date → when it was pressed (a double-click opens one agent)

  // { label, mark } for a button, or null where there's no button: terminals off, no default agent, the
  // same-box read view, or Calendar off. agentId/agentLabel: the entry's own agent (null = the default).
  function forItem(agentId, agentLabel) {
    if (typeof ME === 'undefined' || !ME.agent || ME.localRead) return null;
    if (!(typeof termOn === 'function' && termOn()) || !(typeof calendarOn === 'function' && calendarOn())) return null;
    const id = agentId || ME.agent.profile;
    const label = (agentId && agentLabel) || ME.agent.label;
    const mark = typeof AgentMarks !== 'undefined' ? AgentMarks.svg(id).replace('<svg ', '<svg class="icon" ') : '';
    return { label, mark };
  }

  async function launch(entryId, date) {
    const key = `${entryId}@${date || ''}`;
    const t = Date.now();
    for (const [k, at] of recent) if (t - at > GUARD_MS) recent.delete(k);
    if (recent.has(key)) return;
    recent.set(key, t);

    let res;
    let data = {};
    try {
      res = await fetch(`/api/calendar/entry/${encodeURIComponent(entryId)}/agent${date ? `?date=${encodeURIComponent(date)}` : ''}`);
      data = await res.json().catch(() => ({}));
    } catch {
      toast("VaultOS isn't answering");
      return;
    }
    if (res.status === 401) { if (typeof showLogin === 'function') showLogin(); return; }
    if (res.status === 404 && data.error === 'No such entry') { toast('This reminder was deleted.'); return; }
    if (!res.ok) { toast(data.error || 'The agent could not be started'); return; }

    const running = data.task && typeof TASK_AGENTS !== 'undefined' ? TASK_AGENTS[data.task] : null;
    if (running) {
      goToAgent(running.id);
      toast('An agent is already on this card.', { tone: 'info' });
      return;
    }
    if (data.task) termOpen({ cwd: data.cwd, task: data.task, run: data.command });
    else termOpen({ cwd: '', run: data.command, space: twNewId().replace(/[^A-Za-z0-9]/g, '').slice(0, 8), spaceName: data.spaceName });
    if (data.fellBack) toast(`${data.fellBack}, so this opened ${data.agent.label}.`);
  }

  window.CalendarAgent = { forItem, launch };
})();
