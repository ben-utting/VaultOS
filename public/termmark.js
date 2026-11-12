'use strict';

// ========================================================================
// TermMark: one mark per agent and state, for the terminal sidebar, the
// Go-to picker, pane strips and Board card pills (spec 2026-11-12 §5).
// Each agent wears its own one-colour mark (AgentMarks, the same logos the
// agent tiles and Start agent show), coloured by state. Motion is CSS
// (styles.css "Agent marks"): working = the agent's own movement (Claude
// turns, Cursor taps, the rest bob), needs you = a breath, done = one pop on
// arrival. motion 'quiet' keeps only the breath. Reduced motion: none.
// window.TermMark in the page (after agent-marks.js); a Node module for tests.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f(require('./agent-marks'));
  else root.TermMark = f(root.AgentMarks);
})(typeof self !== 'undefined' ? self : this, function (AgentMarks) {
  const WORD = { working: 'working', blocked: 'needs you', done: 'done', idle: 'idle' };
  const PERIOD = { claude: 3000, cursor: 1200, other: 2400, blocked: 1600 };
  const KNOWN = new Set(['claude', 'cursor', 'codex', 'copilot', 'pi', 'opencode', 'kilo', 'antigravity', 'custom']);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const word = (state) => (Object.prototype.hasOwnProperty.call(WORD, state) ? WORD[state] : '');
  const family = (kind) => (kind === 'claude' || kind === 'cursor' ? kind : 'other');
  const glyph = (kind) => (AgentMarks ? AgentMarks.svg(KNOWN.has(kind) ? kind : 'custom') : '');
  // The done ✓, drawn (the type scale has no size this small, and an icon isn't text).
  const OK = '<span class="tm-ok"><svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.3 4.2 7.5 8.2 2.8"/></svg></span>';

  function html({ kind = '', state = '', motion = 'full', id = '' } = {}) {
    return `<span class="tm" data-family="${family(kind)}" data-agent="${esc(state)}" data-motion="${motion === 'quiet' ? 'quiet' : 'full'}"`
      + ` data-tid="${esc(id)}" aria-hidden="true">${glyph(kind)}${state === 'done' ? OK : ''}</span>`;
  }

  // After a render that may have replaced marks: a running animation takes its phase from the clock, so a redraw
  // (the 3s list poll, the minute tick) never restarts it; and a mark whose terminal just turned done pops once.
  // What each terminal's mark showed is remembered per container, so the same terminal in two places pops in both.
  const seen = new WeakMap();
  function sync(container, now = Date.now()) {
    if (!container || !container.querySelectorAll) return;
    let mem = seen.get(container);
    if (!mem) { mem = new Map(); seen.set(container, mem); }
    for (const el of container.querySelectorAll('.tm')) {
      const state = el.dataset.agent || '';
      // Once per drawn mark: re-setting the delay of a running animation would make it jump.
      if ((state === 'working' || state === 'blocked') && !el.dataset.tmSync) {
        el.dataset.tmSync = '1';
        const period = state === 'blocked' ? PERIOD.blocked : PERIOD[el.dataset.family] || PERIOD.other;
        const delay = `-${now % period}ms`;
        el.style.animationDelay = delay;
        const svg = el.querySelector(':scope > svg');
        if (svg) svg.style.animationDelay = delay;
      }
      const tid = el.dataset.tid;
      if (!tid) continue;
      const prev = mem.get(tid);
      if (prev !== undefined && prev !== state && state === 'done') el.classList.add('tm-arrive');
      mem.set(tid, state);
    }
  }

  return { html, word, sync, PERIOD };
});
