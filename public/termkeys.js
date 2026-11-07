'use strict';

// ========================================================================
// The terminal workspace's keys: the Ctrl+Space prefix (tmux-style), the mode
// bar that shows while it is armed, the Alt+1…9 / Ctrl+Shift+` direct keys,
// and the `?` shortcuts sheet. One BINDINGS table drives the handler, the
// bar's hints and the sheet.
//
//   installTermKeys(root, ctx) → { armed(), disarm(), openSheet() }
//   ctx = { host, isActive(), isPhone(), sendNul(), split(dir), toggleZoom(), closeFocused(),
//           focusDir(dir), openPicker(), nextNeedingYou(), toggleSide(), showSpaceN(n),
//           newPane(), refocus(), overlayOpen() }
//
// The direct keys (Alt+N, Ctrl+Shift+`) do nothing while the ? sheet or the Go-to
// picker (ctx.overlayOpen) is open: a key typed there belongs to the overlay.
//
// A window capture-phase keydown runs before xterm's helper-textarea listener,
// so it can hold back both Ctrl+Space and the key after it. Escape is never
// touched unless the prefix is armed; the sheet takes its own Escape on its own
// element with stopPropagation (app.js closes the task drawer on any document
// Escape). Rendering only; every action is a ctx callback into termui.js.
// ========================================================================
const installTermKeys = (() => {
  const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', h: 'left', l: 'right', k: 'up', j: 'down' };
  const plain = (e) => !e.ctrlKey && !e.altKey && !e.metaKey;

  return function installTermKeys(root, ctx) {
    if (ctx.isPhone && ctx.isPhone()) return { armed: () => false, disarm() {}, openSheet() {} };

    const bar = root.querySelector('.tw-modebar');
    let armed = false;
    let sheet = null;
    let watch = 0;
    // A focus queued before the sheet opened (a pane focus after a switch) must not take the keyboard from it.
    const keep = (e) => { if (sheet && !sheet.contains(e.target)) sheet.querySelector('input').focus(); };

    const BINDINGS = [
      { keys: '\\', label: 'Split right', match: (e) => plain(e) && e.key === '\\', run: () => ctx.split('right') },
      { keys: '-', label: 'Split down', match: (e) => plain(e) && e.key === '-', run: () => ctx.split('down') },
      { keys: 'z', label: 'Zoom pane', match: (e) => plain(e) && e.key === 'z', run: () => ctx.toggleZoom() },
      { keys: 'x', label: 'Close pane', match: (e) => plain(e) && e.key === 'x', run: () => ctx.closeFocused() },
      { keys: '← ↑ ↓ →', alt: 'h j k l', label: 'Move focus', match: (e) => plain(e) && !!DIRS[e.key], run: (e) => ctx.focusDir(DIRS[e.key]) },
      { keys: 'g', label: 'Go to…', match: (e) => plain(e) && e.key === 'g', run: () => ctx.openPicker() },
      { keys: 'n', label: 'Next agent that needs you', match: (e) => plain(e) && e.key === 'n', run: () => ctx.nextNeedingYou() },
      { keys: 'b', label: 'Sidebar ⇄ rail', match: (e) => plain(e) && e.key === 'b', run: () => ctx.toggleSide() },
      { keys: '?', label: 'All shortcuts', match: (e) => plain(e) && e.key === '?', run: () => openSheet() },
    ];
    // Shown on the sheet only: the keys that are not behind the prefix. Ctrl+` (workbench.js) shows or hides
    // the dock, so the pop-out window, which has none, doesn't list it.
    const EXTRA = [
      { keys: 'Ctrl+Space Ctrl+Space', label: 'Send Ctrl+Space to the shell' },
      { keys: 'Alt+1 … Alt+9', label: 'Show space 1 … 9' },
      { keys: 'Ctrl+Shift+`', label: 'New terminal' },
      ...(ctx.host === 'dock' ? [{ keys: 'Ctrl+`', label: 'Show or hide the terminals' }] : []),
    ];
    const text = (s) => (typeof twEsc === 'function' ? twEsc(s) : String(s));

    const eat = (e) => { e.preventDefault(); e.stopPropagation(); };

    function renderBar() {
      if (!bar) return;
      bar.innerHTML = '<span class="tw-prefix">PREFIX</span>' + BINDINGS.slice(0, 6)
        .map((b) => `<span class="tw-hint"><kbd>${text(b.keys)}</kbd> ${text(b.label.toLowerCase())}</span>`).join('');
    }
    function arm() {
      armed = true;
      if (bar) { renderBar(); bar.hidden = false; }
      clearInterval(watch);
      watch = setInterval(() => { if (!ctx.isActive()) disarm(); }, 300);   // the host went hidden
    }
    function disarm() {
      armed = false;
      clearInterval(watch);
      if (bar) bar.hidden = true;
    }

    function openSheet() {
      if (sheet) return;
      const rowsOf = [...BINDINGS.map((b) => ({ keys: 'Ctrl+Space ' + b.keys + (b.alt ? ' / ' + b.alt : ''), label: b.label })), ...EXTRA];
      sheet = document.createElement('div');
      sheet.className = 'tw-sheet';
      sheet.tabIndex = -1;   // a click on a non-focusable spot inside lands focus here, so its Escape still works
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Terminal shortcuts');
      sheet.innerHTML = '<div class="tw-sheet-box"><div class="tw-sheet-bar">'
        + '<input class="tw-sheet-q" type="text" placeholder="Filter shortcuts" aria-label="Filter shortcuts" autocomplete="off" spellcheck="false"></div>'
        + '<div class="tw-sheet-list"></div></div>';
      const q = sheet.querySelector('input');
      const list = sheet.querySelector('.tw-sheet-list');
      const draw = () => {
        const f = q.value.trim().toLowerCase();
        const hit = rowsOf.filter((r) => !f || (r.keys + ' ' + r.label).toLowerCase().includes(f));
        list.innerHTML = hit.length
          ? hit.map((r) => `<div class="tw-sheet-row"><kbd>${text(r.keys)}</kbd><span>${text(r.label)}</span></div>`).join('')
          : '<div class="tw-sheet-empty">No shortcuts match</div>';
      };
      q.addEventListener('input', draw);
      sheet.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(true); }
        else e.stopPropagation();   // typing here is never the terminal's or the page's
      });
      sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) closeSheet(true); });
      document.body.appendChild(sheet);
      document.addEventListener('focusin', keep, true);
      draw();
      q.focus();
    }
    function closeSheet(refocus) {
      if (!sheet) return;
      document.removeEventListener('focusin', keep, true);
      sheet.remove();
      sheet = null;
      if (refocus && ctx.refocus) ctx.refocus();
    }

    window.addEventListener('keydown', (e) => {
      if (e.isComposing || e.repeat) return;
      if (!ctx.isActive()) { if (armed) disarm(); return; }
      if (ctx.isPhone && ctx.isPhone()) return;
      const ae = document.activeElement;
      const inScope = root.contains(ae) || (ctx.host === 'window' && ae === document.body);
      const typing = ae && ae.matches('input,textarea,select,[contenteditable]') && !ae.classList.contains('xterm-helper-textarea');
      const isPrefix = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'Space';
      if (!armed) {
        if (isPrefix && inScope && !typing && !sheet) { eat(e); arm(); return; }
        if (sheet || (ctx.overlayOpen && ctx.overlayOpen())) return;   // the overlay's own keys
        // Direct keys. term.js lets both through from inside a terminal.
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'Backquote' || e.key === '~')) { eat(e); ctx.newPane(); return; }
        if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); ctx.showSpaceN(Number(e.code.slice(5))); }
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      eat(e); disarm();                        // eat = preventDefault + stopPropagation
      if (isPrefix) return ctx.sendNul();      // focused handle.type('\x00')
      const b = BINDINGS.find((x) => x.match(e)); if (b) b.run(e);   // anything unbound (Esc too) is swallowed
    }, true);
    window.addEventListener('blur', disarm);
    window.addEventListener('pointerdown', disarm, true);

    return { armed: () => armed, disarm, openSheet };
  };
})();
