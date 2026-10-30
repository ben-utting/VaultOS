'use strict';

// ========================================================================
// MoreMenu — the "⋯" menu behaviour (window.MoreMenu), shared by the task
// drawer's header (app.js) and the Files bar (workbench.js).
//
//   const m = MoreMenu.attach(button, menu, { onOpen })   → { close, open, isOpen }
//
// `button` opens `menu`; `menu` is a .fx-menu element (role="menu") whose items
// are [role=menuitem] or [role=menuitemradio] buttons. The owner keeps its own
// click handlers on the items (bound by id or data- attribute); this module only
// adds what every menu needs:
//   - a click on the button toggles; ArrowDown on the closed button opens it
//   - aria-expanded on the button, kept true only while the menu is open
//   - ArrowUp / ArrowDown (wrapping), Home and End move between the items, the
//     first one has focus on open; Enter and Space press the focused item, and
//     the menu closes once the item's own handler has run
//   - Escape closes it and returns focus to the button, and is swallowed (window
//     capture) so the Escape that closes the menu doesn't also close the drawer
//     behind it
//   - Tab closes it with focus on the button, so Tab carries on from there; a
//     click outside and a window resize close it too
//   - close() for the owner, { focus: false } when the caller is moving on. It also
//     closes itself when the button stops being rendered (the drawer it is in is
//     hidden), so no menu is left open over a page its owner has left.
// attach() moves the menu to the end of <body>: it is position: fixed, and inside a
// transformed ancestor (the drawer, mid slide-in) fixed means "relative to that
// ancestor", which put it off the drawer's edge and scrolled the drawer sideways.
// onOpen() runs just before the menu is shown, to enable, hide or relabel items.
// The model is the workspace menu (#ws-menu in app.js), which this doesn't replace.
// ========================================================================

(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.MoreMenu = f();
})(typeof self !== 'undefined' ? self : this, function () {
  const ITEMS = '[role=menuitem], [role=menuitemradio]';
  const GAP = 6, EDGE = 8;   // px under the button; px kept clear of the viewport edge

  function attach(button, menu, { onOpen } = {}) {
    if (!button || !menu) throw new Error('MoreMenu.attach needs a button and a menu');
    const isOpen = () => !menu.classList.contains('hidden');
    // Items that can take focus: not disabled, not hidden.
    const items = () => [...menu.querySelectorAll(ITEMS)].filter((e) =>
      !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.hidden && !e.closest('.hidden'));
    const rendered = (e) => e.isConnected && e.getClientRects().length > 0;
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    // While open: the button disappearing (display: none on an ancestor) closes the menu.
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (isOpen() && !rendered(button)) close({ focus: false }); }) : null;

    function place() {
      const b = button.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;   // layout sizes: the pop-in animation scales getBoundingClientRect
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      // Right edge under the button's right edge (these buttons sit at the right of their bar), kept on screen.
      menu.style.left = Math.max(EDGE, Math.min(b.right - w, vw - w - EDGE)) + 'px';
      const below = b.bottom + GAP;
      const flip = below + h > vh - EDGE && b.top - GAP - h >= EDGE;
      menu.style.top = Math.max(EDGE, flip ? b.top - GAP - h : below) + 'px';
    }

    function open() {
      if (isOpen() || !rendered(button)) return;
      if (onOpen) onOpen();
      menu.classList.remove('hidden');
      place();
      button.setAttribute('aria-expanded', 'true');
      if (watch) watch.observe(button);
      const first = items()[0];
      if (first) first.focus();
    }

    // focus: false when the caller is moving on (the owner closing, a resize), where handing focus back to
    // the button would be the wrong place for it.
    function close({ focus = true } = {}) {
      if (watch) watch.disconnect();
      if (!isOpen()) { button.setAttribute('aria-expanded', 'false'); return; }
      const hadFocus = menu.contains(document.activeElement);
      menu.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      if (focus && rendered(button) && (hadFocus || !document.activeElement || document.activeElement === document.body)) button.focus();
    }

    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', String(isOpen()));
    button.addEventListener('click', () => { if (isOpen()) close(); else open(); });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !isOpen()) { e.preventDefault(); open(); }
    });

    menu.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      const to = { ArrowDown: (i + 1) % list.length, ArrowUp: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
      if (to !== undefined && list.length) { e.preventDefault(); list[to].focus(); }
      else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); list[i].click(); }
      // The menu may sit after its button in the page's Tab order, so the browser's own Tab from inside it is
      // wrong both ways. Shift+Tab goes back to the button; Tab puts focus on the button and lets the Tab go on.
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close();
    });
    // The item's own handler has run by the time the click bubbles here.
    menu.addEventListener('click', (e) => {
      const it = e.target.closest(ITEMS);
      if (it && menu.contains(it) && !it.disabled && it.getAttribute('aria-disabled') !== 'true') close();
    });
    // Window capture, like the Settings sheet's: one Escape closes the menu and nothing behind it.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);
    // A click elsewhere closes it. Focus goes back to the button unless the click landed on something that
    // takes focus itself: that click has already moved it, and it stays there.
    document.addEventListener('click', (e) => {
      if (!isOpen() || menu.contains(e.target) || button.contains(e.target)) return;
      const a = document.activeElement;
      close({ focus: !a || a === document.body || menu.contains(a) });
    }, true);
    window.addEventListener('resize', () => close({ focus: false }));

    return { close, open, isOpen };
  }

  return { attach };
});
