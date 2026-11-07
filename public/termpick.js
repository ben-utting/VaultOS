'use strict';

// ========================================================================
// The terminal workspace's "Go to" picker: every terminal, grouped under its
// space, filtered as you type. On a desktop it is a centred modal; on a phone
// the same list is a full-screen sheet with 44px rows and a New terminal
// button. Rendering and input only: createTermPicker(ctx) draws ctx's data
// and calls ctx back; the workspace (termui.js) owns every action.
//
//   ctx = { spaces(), rows(), goTo(id), onNew(), refocus() }
//
// Every piece of text (a task title can be anything) goes through twEsc, from
// termui.js, which loads after this file and is only called at render time.
// ========================================================================
const createTermPicker = (() => {
  const MARK = { blocked: '×', working: '◐', done: '✓', idle: '○' };

  return function createTermPicker(ctx) {
    let el = null;
    let query = '';
    let sel = null;            // the selected row's id
    let visible = [];          // ids of the rows on show, in order

    const stateOf = (r) => (r.agent && r.agent.state) || '';
    const titleOf = (r) => TermTree.paneTitle({ title: r.title, osc: r.osc, cmd: r.cmd });

    function groups() {
      const rows = new Map(ctx.rows().map((r) => [r.id, r]));
      const q = query.trim().toLowerCase();
      const out = [];
      for (const sp of ctx.spaces()) {
        const own = sp.ids.map((id) => rows.get(id)).filter(Boolean);
        const hit = own.filter((r) => !q || [sp.name, titleOf(r), r.cmd, r.cwd, stateOf(r)].some((t) => String(t || '').toLowerCase().includes(q)));
        if (hit.length) out.push({ sp, rows: hit });
      }
      return out;
    }

    function rowHtml(r) {
      const st = stateOf(r);
      const away = r.where !== 'here';
      return `<div class="tw-pick-row${r.id === sel ? ' sel' : ''}${away ? ' dim' : ''}" role="option" data-id="${twEsc(r.id)}" aria-selected="${r.id === sel}">`
        + `<span class="tw-pick-mark" data-agent="${twEsc(st)}">${MARK[st] || '·'}</span>`
        + `<span class="tw-pick-title">${twEsc(titleOf(r))}</span>`
        + `<span class="tw-pick-cmd">${twEsc(r.cmd || '')}</span>`
        + `<span class="tw-pick-state" data-agent="${twEsc(st)}">${twEsc(st)}</span></div>`;
    }

    function renderList() {
      const gs = groups();
      visible = gs.flatMap((g) => g.rows.map((r) => r.id));
      if (!visible.includes(sel)) sel = visible[0] || null;
      const list = el.querySelector('.tw-pick-list');
      list.innerHTML = gs.length
        ? gs.map((g) => `<div class="tw-pick-group"><div class="tw-pick-head"><span class="tw-pick-space">${twEsc(g.sp.name)}</span>`
          + `<span class="tw-pick-detail">${twEsc(g.sp.detail || '')}</span></div>${g.rows.map(rowHtml).join('')}</div>`).join('')
        : '<div class="tw-pick-empty">No terminals match</div>';
      const cur = list.querySelector('.sel');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }

    function move(d) {
      if (!visible.length) return;
      const i = visible.indexOf(sel);
      sel = visible[(i + d + visible.length) % visible.length];
      renderList();
    }

    function pick(id) {
      if (!id) return;
      close(false);
      ctx.goTo(id);
    }

    function close(refocus = true) {
      if (!el) return;
      el.remove();
      el = null;
      if (refocus) ctx.refocus();
    }

    function open({ present = 'modal' } = {}) {
      if (el) close(false);
      const sheet = present === 'sheet';
      query = '';
      sel = null;
      el = document.createElement('div');
      el.className = 'tw-pick';
      el.dataset.present = sheet ? 'sheet' : 'modal';
      el.tabIndex = -1;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Go to a terminal');
      el.innerHTML = '<div class="tw-pick-box">'
        + '<div class="tw-pick-bar"><input type="text" class="tw-pick-q" placeholder="Go to a terminal…" aria-label="Filter terminals" autocomplete="off" spellcheck="false">'
        + (sheet ? '<button type="button" class="tw-pick-close" aria-label="Close">Close</button>' : '') + '</div>'
        + '<div class="tw-pick-list" role="listbox"></div>'
        + (sheet ? '<div class="tw-pick-foot"><button type="button" class="tw-pick-new">New terminal</button></div>' : '')
        + '</div>';
      const input = el.querySelector('.tw-pick-q');
      const node = el;
      // Escape lives on the overlay itself and stops there: the task drawer
      // closes on any Escape that reaches the document.
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (e.target !== input) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
      });
      input.addEventListener('input', () => { query = input.value; sel = null; renderList(); });
      // Rows aren't focusable: a press on one must not pull focus off the input.
      node.addEventListener('mousedown', (e) => { if (e.target.closest('.tw-pick-row')) e.preventDefault(); });
      node.addEventListener('click', (e) => {
        const row = e.target.closest('.tw-pick-row');
        if (row) { pick(row.dataset.id); return; }
        if (e.target === node || e.target.closest('.tw-pick-close')) { close(true); return; }
        if (e.target.closest('.tw-pick-new')) { close(false); ctx.onNew(); }
      });
      document.body.appendChild(node);
      renderList();
      // A sheet never raises the phone keyboard on its own: the overlay holds focus (so Escape still works).
      if (sheet) node.focus({ preventScroll: true }); else input.focus();
    }

    return {
      open,
      close: () => close(true),
      isOpen: () => !!el,
      // Redraw with fresh data (the 3s list poll), keeping the filter and the selection.
      refresh() { if (el) renderList(); },
    };
  };
})();
