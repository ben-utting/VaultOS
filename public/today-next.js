'use strict';

// ========================================================================
// TodayNext — which one item Today shows as "Next" at the top (window.TodayNext).
// Pure: no DOM, no fetching. today.js hands it what it already has.
//   pickNext({ todayTasks, boardTasks, agentState, viewingToday, wsLabel }) -> Next
//     todayTasks    [{ text, done, moved? }]  the day's own task list
//     boardTasks    [{ title, path, status, mtime }] | null   null = no board data
//     agentState    (path) => string | undefined   'blocked' means the agent needs you
//     viewingToday  false on any other day: the board is never a fallback there
//     wsLabel       the workspace's display name, passed through on board picks
//   Next is one of
//     { kind: 'today', text, target: 'task:' + text }
//     { kind: 'board', title, path, wsLabel, needsYou, target: 'task: ' + title }
//     { kind: 'clear' }
// Order: the first open (not done, not moved) today task; else, on today only,
// an in-progress board task, one whose agent needs you first, then the newest.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.TodayNext = f();
})(typeof self !== 'undefined' ? self : this, function () {
  function pickNext({ todayTasks, boardTasks, agentState, viewingToday, wsLabel } = {}) {
    const open = (todayTasks || []).find((t) => t && !t.done && !t.moved);
    if (open) return { kind: 'today', text: open.text, target: 'task:' + open.text };

    if (!viewingToday || !Array.isArray(boardTasks)) return { kind: 'clear' };
    const state = typeof agentState === 'function' ? agentState : () => undefined;
    const needs = (t) => state(t.path) === 'blocked';
    const live = boardTasks.filter((t) => t && t.status === 'in-progress');
    if (!live.length) return { kind: 'clear' };

    // Needs-you first, then newest mtime; Array.sort is stable, so ties keep board order.
    live.sort((a, b) => (needs(b) - needs(a)) || ((b.mtime || 0) - (a.mtime || 0)));
    const t = live[0];
    return { kind: 'board', title: t.title, path: t.path, wsLabel, needsYou: needs(t), target: 'task: ' + t.title };
  }

  return { pickNext };
});
