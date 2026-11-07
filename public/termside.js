'use strict';

// ========================================================================
// The terminal workspace's sidebar: spaces and agents (blocked first), or,
// collapsed, a narrow rail of "number mark" rows. A space with a pane here has
// its Alt+N number; one without (detached, or held by another page) has none,
// is dimmed, and its tooltip says where it is. Pure
// rendering: createTermSide(el, ctx) draws a model and calls ctx back; the
// workspace (termui.js) owns every action.
//
//   model = { mode: 'side'|'rail', brand, spaces: Space[], agents: Row[], activeKey, focusedId }
//   ctx   = { onSpace(key), onAgent(id), onNew(), onMenu(anchorEl), onRenameSpace(key), onToggle() }
//
// Every piece of text (a task title can be anything) goes through twEsc,
// from termui.js, which loads after this file and is only called at render
// time. Rows are buttons; their text truncates with an ellipsis.
// ========================================================================
const createTermSide = (() => {
  const MARK = { blocked: '×', working: '◐', done: '✓', idle: '○' };
  const mark = (state) => MARK[state] || '·';
  const WORD = { blocked: 'blocked', working: 'working', done: 'done', idle: 'idle' };

  // Where a row that isn't held by this page is: the tooltip says so.
  function whereNote(where) {
    if (where === 'detached') return 'detached: running in the background';
    if (where === 'window' || where === 'dock') return `elsewhere: open in the ${where === 'window' ? 'Terminals window' : 'dock'}`;
    return 'elsewhere: open in another window';
  }

  return function createTermSide(el, ctx) {
    let mode = 'rail';
    let last = null;
    const cache = { head: null, list: null, agents: null, foot: null };
    el.innerHTML = '<div class="tw-side-head"></div><div class="tw-side-scroll"></div><div class="tw-side-foot"></div>';
    const headEl = el.querySelector('.tw-side-head');
    const scrollEl = el.querySelector('.tw-side-scroll');
    const footEl = el.querySelector('.tw-side-foot');

    function spaceRow(sp, activeKey, rail) {
      const cls = ['tw-sp-row', sp.key === activeKey ? 'active' : '', sp.dim ? 'dim' : ''].filter(Boolean).join(' ');
      const tip = [sp.name, sp.detail].filter(Boolean).join(' · ') + (sp.dim && sp.goWhere ? ` (${whereNote(sp.goWhere)})` : '');
      // No number without a pane here: the rail shows the mark alone; the sidebar keeps the column, so marks line up.
      const num = sp.num ? `<span class="tw-sp-num">${sp.num}</span> ` : rail ? '' : '<span class="tw-sp-num"></span> ';
      return `<button type="button" class="${cls}" data-key="${twEsc(sp.key)}" title="${twEsc(tip)}"${sp.key === activeKey ? ' aria-current="true"' : ''}>`
        + `${num}<span class="tw-sp-mark" data-agent="${twEsc(sp.rollup || '')}">${mark(sp.rollup)}</span>`
        + (rail ? '' : ` <span class="tw-sp-name">${twEsc(sp.name)}</span>`)
        + '</button>';
    }

    function agentRow(r, names, focusedId) {
      const state = r.agent.state;
      const line = `${r.cmd || 'agent'} · ${WORD[state] || state}`;
      const away = r.where !== 'here';
      const cls = ['tw-ag-row', away ? 'dim' : '', r.id === focusedId ? 'active' : ''].filter(Boolean).join(' ');
      const space = names.get(r.key) || '';
      const tip = `${line} · ${space}${away ? ` (${whereNote(r.where)})` : ''}`;
      return `<button type="button" class="${cls}" data-id="${twEsc(r.id)}" title="${twEsc(tip)}">`
        + `<span class="tw-ag-line">${twEsc(r.cmd || 'agent')} · <span class="tw-ag-state" data-agent="${twEsc(state)}">${twEsc(WORD[state] || state)}</span></span>`
        + `<span class="tw-ag-space">${twEsc(space)}</span></button>`;
    }

    // Replace a section's HTML only when it changed, so a 3s poll never
    // drops the keyboard focus from a row.
    function put(node, slot, html) {
      if (cache[slot] === html) return;
      cache[slot] = html;
      const had = node.contains(document.activeElement) ? document.activeElement : null;
      const key = had && (had.dataset.key ? `[data-key="${CSS.escape(had.dataset.key)}"]` : had.dataset.id ? `[data-id="${CSS.escape(had.dataset.id)}"]` : had.className ? '.' + had.className.split(' ')[0] : null);
      node.innerHTML = html;
      if (key) { const again = node.querySelector(key); if (again) again.focus({ preventScroll: true }); }
    }

    function render(model) {
      last = model || last;
      if (!last) return;
      if (last.mode === 'side' || last.mode === 'rail') mode = last.mode;
      const rail = mode === 'rail';
      el.dataset.mode = mode;
      const spaces = last.spaces || [];
      const agents = last.agents || [];
      const names = new Map(spaces.map((s) => [s.key, s.name]));
      put(headEl, 'head', !rail && last.brand ? 'Vault<span class="brand-os">OS</span>' : '');
      headEl.classList.toggle('brand', !rail && !!last.brand);
      let body = '';
      if (rail) {
        body = spaces.map((s) => spaceRow(s, last.activeKey, true)).join('')
          + '<button type="button" class="tw-side-new" title="New terminal" aria-label="New terminal">+</button>';
      } else {
        body = '<div class="tw-side-h"><span>spaces</span><button type="button" class="tw-side-new" title="New terminal" aria-label="New terminal">+</button></div>'
          + (spaces.length ? spaces.map((s) => spaceRow(s, last.activeKey, false)).join('') : '<div class="tw-side-empty">no terminals</div>')
          + '<div class="tw-side-h"><span>agents</span></div>'
          + (agents.length ? agents.map((r) => agentRow(r, names, last.focusedId)).join('') : '<div class="tw-side-empty">none running</div>');
      }
      put(scrollEl, 'list', body);
      put(footEl, 'foot', rail
        ? '<button type="button" class="tw-side-menu" title="Menu" aria-label="Menu" aria-haspopup="menu">⋯</button>'
          + '<button type="button" class="tw-side-toggle" title="Expand the sidebar" aria-label="Expand the sidebar">»</button>'
        : '<button type="button" class="tw-side-menu" title="Menu" aria-haspopup="menu">menu</button>'
          + '<button type="button" class="tw-side-toggle" title="Collapse to a rail" aria-label="Collapse to a rail">«</button>');
    }

    el.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !el.contains(t)) return;
      if (t.classList.contains('tw-sp-row')) ctx.onSpace(t.dataset.key);
      else if (t.classList.contains('tw-ag-row')) ctx.onAgent(t.dataset.id);
      else if (t.classList.contains('tw-side-new')) ctx.onNew();
      else if (t.classList.contains('tw-side-menu')) ctx.onMenu(t);
      else if (t.classList.contains('tw-side-toggle')) ctx.onToggle();
    });
    el.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.tw-sp-row');
      if (!row) return;
      e.preventDefault();
      ctx.onRenameSpace(row.dataset.key);
    });

    return {
      render,
      setMode(m) { mode = m === 'side' ? 'side' : 'rail'; if (last) last = { ...last, mode }; render(); },
    };
  };
})();
