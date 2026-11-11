'use strict';

// ========================================================================
// Workbench terminal — shared by the dock in index.html and the pop-out
// terminal.html. One xterm.js instance talking JSON over /api/term to a pty
// on the server (see "Workbench: Terminal" in server.js).
//
// Globals come from the UMD bundles in /vendor: Terminal, FitAddon, WebLinksAddon,
// WebglAddon, Unicode11Addon.
//
// Tuned to match VS Code's integrated terminal (itself xterm.js), because a
// full-screen TUI like Claude Code falls apart without these:
//  - WebGL renderer: draws box-drawing/block characters as custom glyphs that
//    meet cell edge to cell edge. The default DOM renderer leaves hairline gaps
//    and misaligned rows, which is the "broken up" look.
//  - Unicode 11 widths: emoji and symbols (✻ ⏺ ⎿) take the width the program
//    expects; with the old tables every such line wraps one cell early.
//  - lineHeight 1 + a real coding font: taller rows split stacked blocks apart.
// ========================================================================

// Top-level vault folders whose paths become clickable in terminal output.
// Filled from /api/fs/tree at startup, so a new top-level folder needs no edit here.
let VAULT_TOPS = [];
fetch('/api/fs/tree').then((r) => r.ok ? r.json() : null).then((d) => {
  if (d && d.items) VAULT_TOPS = d.items.filter((i) => i.dir).map((i) => i.name);
}).catch(() => {});

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Vault folder names have spaces in them ("2. website"), so a path can't
// be cut at whitespace. Instead: start at a known top-level folder (optionally
// behind /vault/) and run lazily to the first thing that
// looks like a file extension. Directories without an extension aren't linked.
// null while there are no folders (before /api/fs/tree answers, or an empty vault): an empty
// alternation would link every path with a dot in it.
function vaultPathRegex() {
  if (!VAULT_TOPS.length) return null;
  const tops = VAULT_TOPS.map(reEsc).join('|');
  return new RegExp(
    `(?:/vault/)?((?:${tops})/[^\\n\`'"<>|*?]*?\\.[A-Za-z0-9]{1,8})(?![A-Za-z0-9_.-])`, 'g');
}

// Background/foreground/cursor come off the live CSS tokens so the terminal
// follows Dark/Sepia. The 16 ANSI colours are VS Code's own Dark+/Light+
// terminal palettes: programs pick their colours assuming a standard palette,
// and these are the ones Claude Code and friends are tested against.
const ANSI_DARK = {
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8',
  magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c',
  brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
  brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};
const ANSI_LIGHT = {
  black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5',
  magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131',
  brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
  brightCyan: '#0598bc', brightWhite: '#a5a5a5',
};
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const light = document.documentElement.dataset.theme === 'light';
  return {
    ...(light ? ANSI_LIGHT : ANSI_DARK),
    background: v('--bg', light ? '#fbf6ea' : '#0b0d12'),
    foreground: v('--text', light ? '#2b2417' : '#cccccc'),
    cursor: v('--brand', '#d7b46a'),
    cursorAccent: v('--bg', '#0b0d12'),
    selectionBackground: light ? 'rgba(107,75,18,.25)' : 'rgba(215,180,106,.30)',
  };
}

// VS Code's defaults: 14px, Consolas on Windows / Menlo on macOS. Cascadia
// first where it's installed (Windows Terminal ships it), JetBrains Mono
// (self-hosted) as the fallback everywhere else.
const TERM_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "JetBrains Mono", "DejaVu Sans Mono", monospace';
function termDefaultFontSize() {
  return window.matchMedia('(max-width: 700px)').matches ? 12 : 14;
}

// Terminal zoom: one text size for every terminal, in the dock and the pop-out
// alike, independent of the browser's page zoom. Stored as a px size (absent =
// the default above); the storage event carries a change to the other window.
const TERM_ZOOM_KEY = 'vaultboard.term.fontsize';
const TERM_ZOOM_MIN = 8;
const TERM_ZOOM_MAX = 32;
const LIVE_TERMS = new Set();   // { term, fit } of every open terminal in this window
function termFontSize() {
  let v = null;
  try { v = Number(localStorage.getItem(TERM_ZOOM_KEY)) || null; } catch { /* private mode */ }
  return v ? Math.min(Math.max(v, TERM_ZOOM_MIN), TERM_ZOOM_MAX) : termDefaultFontSize();
}
function applyTermFontSize() {
  const px = termFontSize();
  for (const t of LIVE_TERMS) {
    if (t.term.options.fontSize === px) continue;
    t.term.options.fontSize = px;
    try { t.fit.fit(); } catch { /* hidden */ }
  }
  window.dispatchEvent(new CustomEvent('vaultos-termzoom', { detail: px }));
}
// setTermZoom(+1 | -1 | 0): one px bigger / smaller, or 0 back to the default.
function setTermZoom(step) {
  const px = step ? Math.min(Math.max(termFontSize() + step, TERM_ZOOM_MIN), TERM_ZOOM_MAX) : null;
  try { if (px == null) localStorage.removeItem(TERM_ZOOM_KEY); else localStorage.setItem(TERM_ZOOM_KEY, String(px)); } catch { /* private mode */ }
  applyTermFontSize();
}
window.addEventListener('storage', (e) => { if (e.key === TERM_ZOOM_KEY) applyTermFontSize(); });

// Copy that also works over plain-HTTP LAN, where navigator.clipboard is
// undefined (see "navigator.clipboard does not exist" in CLAUDE.md).
// With a pane, it also flashes what happened over that pane's corner, so a
// failed copy shows up as a failed copy rather than an empty paste later.
function termCopy(text, pane, src) {
  let p;
  if (navigator.clipboard && window.isSecureContext) {
    p = navigator.clipboard.writeText(text).then(() => 'clipboard', () => (legacyCopy(text) ? 'fallback' : null));
  } else {
    p = Promise.resolve(legacyCopy(text) ? 'fallback' : null);
  }
  return p.then((how) => {
    if (pane) copyFlash(pane, how ? `Copied ${text.length} chars · ${src}${how === 'fallback' ? ' · fallback' : ''}` : `Copy failed · ${src}`, !how);
    return !!how;
  });
}
function copyFlash(pane, msg, bad) {
  const doc = pane.ownerDocument;
  let el = pane._copyFlash;
  if (!el) {
    el = pane._copyFlash = doc.createElement('div');
    el.style.cssText = 'position:fixed;z-index:9999;padding:4px 10px;border-radius:6px;font:12px/1.4 system-ui,sans-serif;pointer-events:none;transition:opacity .3s;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    doc.body.appendChild(el);
  }
  const r = pane.getBoundingClientRect();
  el.textContent = msg;
  el.style.background = bad ? '#b3261e' : '#2e7d32';
  el.style.color = '#fff';
  el.style.top = (r.top + 8) + 'px';
  el.style.right = (doc.documentElement.clientWidth - r.right + 8) + 'px';
  el.style.left = 'auto';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, bad ? 3000 : 1200);
}
// Claude Code hard-wraps its own output at the terminal width and indents
// code blocks, so a raw selection of a long command comes out as several
// indented lines. Undo both: drop the common indent, trim trailing padding and
// rejoin a line with the next when the next one's first word couldn't have fit
// (i.e. the break was a wrap, not a real newline). A line ending in `\` is a
// real shell continuation and is left alone. Ctrl+Shift+C copies raw.
//
// Some agents (Cursor CLI) wrap their own prose at a fixed width well short of
// the terminal edge, so nothing reaches `cols`. Then the wrap width is read off
// the selection: its longest line, but only when another line ends within 10
// cells of it (a shared right margin, not one long command among short ones).
// A line that starts like a command (a cmdlet, `$ `, `./`, docker/git/npm...)
// or ends in `;`/`{` doesn't set the margin, and isn't glued to a command or a
// finished sentence before it unless that was hard-wrapped at the edge or
// ended in a pipe. A line holding a 30+ cell token (a path) can overflow the
// margin, so it doesn't set it either. The margin also applies when Cursor
// wraps near (not at) the edge of a wide terminal, which leaves more slack than
// the 4 cells allowed below.
//
// A paragraph (run of non-blank lines) holding script syntax - `$x = `,
// `if (`, a line that starts with a brace, ends in `{`/`;`/a backtick, a
// `-Param` continuation - is code. Code never takes the Cursor margin: a block
// of long script lines of similar length looks like wrapped prose to it, which
// glued `})` onto the `if` below and a backtick line onto its continuation.
// Code is only rejoined where it was hard-wrapped at the terminal edge.
//
// `lead` is how many cells of text sit left of the selection on its first row
// (a drag started mid-line): that line is wider on screen than its text, and
// its indent says nothing about the gutter.
function tidySelection(text, cols, lead = 0) {
  const CMD_START = /^\s*(\$ |> |PS[ >]|[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\.{0,2}\/|~\/|(sudo|docker|git|npm|npx|node|python3?|pip3?|cd|ls|curl|wget|ssh|scp|kubectl|winget|choco|apt|apt-get|brew|systemctl|journalctl|grep|mkdir|rm|cp|mv|chmod|chown|tar|cargo|dotnet|az|aws|gcloud|terraform|certutil|netsh|reg|icacls|robocopy|msiexec|pwsh|powershell|wsl|sc|sc\.exe|openssl|keytool)\s)/;
  const isCmd = (l) => CMD_START.test(l) || /[;{]\s*$/.test(l) || /^\s*[}\])]/.test(l);
  const isCode = (l) => /^\s*\$[\w:{]+(\[[^\]]*\])?(\.\w+)*\s*([-+*/]?=|\||\.|\[|\)|$)/.test(l)  // $x = / $_.Name / $rows |
    || /^\s*(if|elseif|foreach|for|while|switch|catch|until)\s*\(/i.test(l)
    || /^\s*(else|try|finally|do|begin|process|end)\s*\{/i.test(l)
    || /^\s*(function|filter)\s+[\w-]+\s*[({]?\s*$/i.test(l) || /^\s*param\s*\(/i.test(l)
    || /^\s*[{}]/.test(l) || /^\s*[)\]]\s*[;)}\]|.]*\s*$/.test(l) || /^\s*@[{(]/.test(l)
    || /^\s*\[[\w.]+(\[\])?\]\s*\$/.test(l)                       // [string]$x
    || /[{;`]\s*$/.test(l) || /\\$/.test(l)
    || /^\s+-[A-Za-z]\w*(\s|$)/.test(l);                          // -Param continuation
  const raw = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  if (raw.length < 2) return raw.join('').trim();
  const code = [];
  for (let s = 0; s < raw.length;) {
    let e = s;
    while (e < raw.length && raw[e].trim()) e++;
    const isBlock = raw.slice(s, e).some(isCode);
    for (let i = s; i < e; i++) code[i] = isBlock;
    s = Math.max(e, s + 1);
  }
  const ind = (l) => l.match(/^ */)[0].length;
  const cells = (i) => raw[i].length + (i === 0 ? lead : 0);   // width on screen
  const rest = raw.slice(1).filter((l) => l.trim()).map(ind);
  const first = raw[0].trim() && !lead ? [ind(raw[0])] : [];
  const indents = first.concat(rest);
  let cut = indents.length ? Math.min(...indents) : 0;
  // A drag that starts at the first word leaves that line without the agent's
  // 1-2 cell gutter; take the gutter from the other lines. A deeper shared
  // indent (a code body under `def`) is real indentation and is kept.
  if (first[0] === 0 && rest.length && Math.min(...rest) <= 2) cut = Math.min(...rest);
  // A command-looking line mid-sentence ("...health with / Get-Service or...") is prose.
  const cmd = [];
  raw.forEach((l, i) => { cmd[i] = isCmd(l) && (i === 0 || !raw[i - 1].trim() || cmd[i - 1] || /[.:!?]$/.test(raw[i - 1])); });
  const prose = raw.map((l, i) => i).filter((i) => !cmd[i] && !code[i] && !/\S{30}/.test(raw[i])).map(cells);
  const longest = Math.max(0, ...prose);
  const margin = longest >= 60 && prose.filter((w) => w >= longest - 10).length >= 2;
  let out = lead ? raw[0].trimStart() : raw[0].slice(Math.min(cut, ind(raw[0])));
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1], line = raw[i];
    const width = cells(i - 1);                         // cells used on screen, indent included
    const newCmd = cmd[i] && width < cols - 1 && !/(\||&&)$/.test(prev);
    const cols_ = margin && !cmd[i - 1] && !cmd[i] && !code[i] ? Math.min(cols, longest + 1) : cols;
    const firstWord = line.trimStart().split(/\s/)[0].length;
    const wrapped = line.trim() && prev.trim() && !/[\\`]$/.test(prev)
      && line.match(/^ */)[0].length <= cut + 4
      && !/^\s*(\d+[.)]|[-*•])\s/.test(line)               // a list item starts a real line
      && !newCmd;                                         // so does a new command
    // A line that fills to the edge is either a long token (path, URL) broken
    // mid-way, or an ordinary word wrap that happened to land exactly there.
    // Only glue without a space when the last token looks like a path/URL or is
    // too long to be a word, e.g. "you|can" and "Descending |Select-Object" keep theirs.
    const lastTok = prev.trim().split(/\s/).pop();
    const midToken = lastTok.length >= 20 || /[\\/]/.test(lastTok);
    if (wrapped && width >= cols_ - 1 && midToken) out += line.trimStart();               // broken mid-token
    else if (wrapped && width + 1 + firstWord > cols_ - 4) out += ' ' + line.trimStart(); // next word would not have fit
    else out += '\n' + line.slice(cut);
  }
  return out.replace(/^\n+|\n+$/g, '');
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* nothing more to try */ }
  ta.remove();
  return ok;
}

// createTerminal(container, opts) → handle
//   opts.id        stable id: reconnecting with the same id reattaches to the same shell
//   opts.cwd       vault-relative folder to start in (only used when the shell is new)
//   opts.task      vault-relative task.md this shell works on (only used when new)
//   opts.space     the new space it belongs to (spaces +), and opts.spaceName; sent on every connect
//   opts.run       command typed once the socket first opens (a pty buffers it
//                  until the shell reads it, so no prompt wait is needed)
//   opts.onAgent({state, since} | null)  Claude's state in this shell (hooks → server)
//   opts.onOpenPath(relPath)  a vault path in the output was clicked
//   opts.onExit()  the shell exited (or was killed)
//   opts.onState(state)  'connecting' | 'open' | 'closed' | 'denied' | 'moved'
function createTerminal(container, opts = {}) {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    lineHeight: 1,
    letterSpacing: 0,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    drawBoldTextInBrightColors: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    // VS Code's default. Programs (Claude Code's syntax highlighting included)
    // sometimes paint text in ANSI black or a near-black truecolour that
    // assumes a lighter background; at 1 that was black-on-black. 4.5 lifts any
    // foreground too close to its background until it reads, and leaves the
    // rest alone.
    minimumContrastRatio: 4.5,
    scrollback: 10000,
    smoothScrollDuration: 0,
    macOptionIsMeta: true,
    // Right-click is paste (see the mouse clipboard block below), not select-word.
    rightClickSelectsWord: false,
    allowProposedApi: true,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // FitAddon counts rows with the cell height it measured; at a fractional device-pixel ratio the renderer
  // rounds the cell up, so the last row can poke out below the box and paint over a pane's border (seen at
  // dpr 2 on a phone). Same as fit.fit(), but drops a row when the rendered rows would overflow the host.
  // `sized`: the fit has run on a real box at least once. Until then term.cols/rows are xterm's 80x24 default,
  // never a size to give the pty; after it they are the pane's last real size (see connect()).
  let sized = false;
  fit.fit = () => {
    if (!container.offsetWidth || !container.offsetHeight) return;   // hidden: keep the last real size
    const d = fit.proposeDimensions();
    if (!d || isNaN(d.cols) || isNaN(d.rows)) return;
    const el = container.querySelector('.xterm-screen');
    const cs = getComputedStyle(container);
    // Cols from the renderer's unrounded cell width. FitAddon divides by the css cell width, which is the
    // canvas rounded to whole pixels over the cols already set, so the answer depended on history: two panes
    // in the same box could settle a column apart (51 and 52 on a phone after a split). Same available width
    // as FitAddon's; its answer stands if anything here is missing.
    try {
      const dims = term._core._renderService.dimensions;
      const cellW = dims.device.cell.width / ((container.ownerDocument.defaultView || window).devicePixelRatio || 1);
      const es = getComputedStyle(term.element);
      const bar = term.options.scrollback === 0 ? 0 : ((term.options.overviewRuler && term.options.overviewRuler.width) || 14);
      const availW = Math.max(0, parseInt(cs.width, 10)) - (parseInt(es.paddingLeft, 10) || 0) - (parseInt(es.paddingRight, 10) || 0) - bar;
      const cols = Math.floor(availW / cellW + 1e-6);
      if (cellW > 0 && cols > 0 && Math.abs(cols - d.cols) <= 1) d.cols = Math.max(2, cols);
    } catch { /* private API moved: FitAddon's cols */ }
    const availH = container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const h = el ? el.getBoundingClientRect().height : 0;
    if (h > 0 && availH > 0 && term.rows > 0) {
      const cellH = h / term.rows;
      d.rows = Math.max(1, Math.min(d.rows, Math.floor(availH / cellH + 1e-6)));
    }
    sized = true;
    if (d.cols !== term.cols || d.rows !== term.rows) {
      try { term._core._renderService.clear(); } catch { /* private API moved: resize alone is fine */ }
      term.resize(d.cols, d.rows);   // term.onResize tells the server
    }
    payOwedSize();
  };
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
  const uni = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  term.open(container);
  const live = { term, fit };
  LIVE_TERMS.add(live);

  // Ctrl + wheel (and a trackpad pinch, which arrives as one) zooms the
  // terminals, not the page. Pinch deltas are tiny, so they add up to a step.
  let wheelAcc = 0;
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 40) return;
    setTermZoom(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
  }, { passive: false, capture: true });

  // Touch scrolling. xterm 6's scrollable doesn't follow a finger reliably on
  // a phone, so a swipe moved the page instead of the scrollback. One-finger
  // drags are ours: the normal buffer scrolls its scrollback; a full-screen
  // app (alternate buffer) or one tracking the mouse gets wheel events, which
  // xterm turns into arrow keys or mouse reports as it would for a mouse.
  // A flick keeps going and slows down. Taps are left alone (termui.js focuses
  // on tap).
  let touchY = null, touchAcc = 0, touchMoved = false, touchV = 0, touchT = 0, fling = 0;
  const cellH = () => (container.clientHeight / term.rows) || 16;
  const scrollPx = (px) => {
    touchAcc += px;
    const n = Math.trunc(touchAcc / cellH());
    if (!n) return;
    touchAcc -= n * cellH();
    if (term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none') term.scrollLines(n);
    else {
      const target = container.querySelector('.xterm-screen') || container;
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: n * cellH(), deltaMode: 0, bubbles: true, cancelable: true }));
    }
  };
  container.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(fling);
    if (e.touches.length !== 1) { touchY = null; return; }
    touchY = e.touches[0].clientY; touchAcc = 0; touchMoved = false; touchV = 0; touchT = performance.now();
  }, { passive: true, capture: true });
  container.addEventListener('touchmove', (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!touchMoved && Math.abs(y - touchY) < 8) return;
    touchMoved = true;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const dy = touchY - y;
    touchV = dy / Math.max(now - touchT, 1);
    touchY = y; touchT = now;
    scrollPx(dy);
  }, { passive: false, capture: true });
  container.addEventListener('touchend', () => {
    if (touchMoved) {
      let v = touchV, last = performance.now();
      const step = (now) => {
        const dt = now - last; last = now;
        v *= Math.pow(0.995, dt);
        if (Math.abs(v) < 0.05) return;
        scrollPx(v * dt);
        fling = requestAnimationFrame(step);
      };
      if (Math.abs(v) > 0.3 && performance.now() - touchT < 80) fling = requestAnimationFrame(step);
    }
    touchY = null;
  }, { capture: true });

  // GPU renderer, falling back to the DOM renderer if WebGL isn't available
  // (or the context is lost, e.g. after a laptop sleeps).
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* no WebGL: the DOM renderer still works, just less crisply */ }

  // The first measurement may use a fallback font if JetBrains Mono is still
  // downloading. Re-measure once it's in, or every cell is the wrong width.
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`${termFontSize()}px "JetBrains Mono"`).then(() => {
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = TERM_FONT;
      try { fit.fit(); } catch { /* hidden */ }
    }).catch(() => {});
  }

  // VS Code's key behaviour:
  //  - Ctrl+C copies when there's a selection (otherwise it's ^C as usual);
  //    Ctrl+Shift+C always copies.
  //  - Ctrl+V / Ctrl+Shift+V paste via the browser's paste event instead of
  //    sending a literal ^V.
  //  - Shift+Enter sends ESC+CR, which Claude Code reads as "new line, don't
  //    submit" — the same sequence its /terminal-setup installs for VS Code.
  //  - Ctrl+Space belongs to the page (prefix key); xterm would send NUL.
  //  - Ctrl+` / Ctrl+Shift+` / Alt+1…9 belong to the page (dock, new
  //    terminal, switch terminal), not the shell.
  // Copy the selection, tidied. A drag that starts at the first word leaves the
  // agent's gutter out, which makes the first line look short of the margin:
  // put a blank gutter back, or tell the tidy how many cells of text a mid-line
  // start skipped. The flash says how many lines were joined.
  const copySelection = (src) => {
    const sel = term.getSelection();
    const pos = term.getSelectionPosition();             // 0-based, whatever the typings say
    const row = pos && pos.start.x > 0 ? term.buffer.active.getLine(pos.start.y) : null;
    const before = row ? row.translateToString(false, 0, pos.start.x) : '';
    const out = before.trim() ? tidySelection(sel, term.cols, pos.start.x) : tidySelection(before + sel, term.cols);
    const lines = (t) => t.replace(/\r/g, '').replace(/^\n+|\n+$/g, '').split('\n').length;
    const joined = lines(sel) - lines(out);
    termCopy(out, container, joined > 0 ? `${src} · joined ${joined} line${joined === 1 ? '' : 's'}` : src);
  };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Space') return false;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) return false;       // dock / new terminal
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) return false;   // Alt+N: switch terminal
    if (e.ctrlKey && !e.altKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) {
        if (e.shiftKey) termCopy(term.getSelection(), container, 'Ctrl+Shift+C raw');
        else { copySelection('Ctrl+C'); term.clearSelection(); }
      }
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && !e.altKey && k === 'v') return false;   // let the browser raise `paste`
    // Ctrl + / Ctrl - / Ctrl 0 zoom the terminals instead of the whole page.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const z = (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') ? 1
        : (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') ? -1
        : (e.key === '0' || e.code === 'Numpad0') ? 0 : null;
      if (z != null) { setTermZoom(z); e.preventDefault(); return false; }
    }
    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
      send({ t: 'in', d: '\x1b\r' });
      e.preventDefault();
      return false;
    }
    return true;
  });

  // Termius-style mouse clipboard:
  //  - Letting go of a drag (or a double/triple-click word/line select) copies
  //    the selection straight away; the highlight stays so you can see what went.
  //  - Right-click pastes, through term.paste() so bracketed paste still applies.
  //    Reading the clipboard needs a secure context (the vb hostname); over plain
  //    HTTP there's no readText, so the browser's own menu is left alone there.
  //  The release is watched on the whole document, not just this pane: a drag
  //  that ends past the pane's edge (over the tab bar, key row, another tile)
  //  still leaves a selection, and used to go uncopied.
  let selecting = false;
  container.addEventListener('mousedown', (e) => { if (e.button === 0) selecting = true; });
  const onRelease = (e) => {
    if (e.button !== 0 || !selecting) return;
    selecting = false;
    // The selection settles after this event on a double-click, so read it next tick.
    setTimeout(() => { if (term.hasSelection()) copySelection('mouse select'); }, 0);
  };
  const doc = container.ownerDocument;
  doc.addEventListener('mouseup', onRelease);

  // OSC 52: a program asking the terminal to set the clipboard. This is how
  // Claude Code's /copy (and tmux, nvim over SSH…) reach the browser clipboard,
  // since the shell runs in a container with no clipboard of its own.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?') return true;          // clipboard *reads* are refused
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      termCopy(new TextDecoder().decode(bytes), container, '/copy (OSC 52)');
    } catch { /* malformed payload */ }
    return true;
  });
  if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) { term.paste(text); term.focus(); }
      }).catch(() => { /* permission refused: nothing to paste */ });
    });
  }

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      const re = vaultPathRegex();
      if (!re) return callback(undefined);
      let m;
      while ((m = re.exec(text))) {
        const rel = m[1];
        const start = m.index + 1;             // 1-based cells
        links.push({
          range: { start: { x: start, y }, end: { x: start + m[0].length - 1, y } },
          text: rel,
          decorations: { underline: true, pointerCursor: true },
          activate: (ev, t) => opts.onOpenPath && opts.onOpenPath(rel),
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  let ws = null;
  let closedByUs = false;
  let exited = false;
  let retry = 0;
  let retryTimer = null;
  let retryAttached = false;   // true once we reconnect to a shell whose output is already on screen
  let moved = false;           // another window took this session; don't grab it back unasked
  let pendingRun = opts.run || '';

  let sizeOwed = false;        // the server may not have the pane's real size yet (see payOwedSize)

  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  // A connect from a hidden box (a minimised dock, the phone's dock behind the Board), or a resize while the
  // socket was down, leaves the server without the pane's real size: a reconnect to a fresh pty (any server
  // restart) starts it at 100x30, and a later fit that finds xterm already at its size sends nothing. So the
  // first fit on a real box with the socket open sends the size, changed or not.
  function payOwedSize() {
    if (!sizeOwed || !sized || !ws || ws.readyState !== 1 || !container.offsetWidth || !container.offsetHeight) return;
    sizeOwed = false;
    send({ t: 'resize', cols: term.cols, rows: term.rows });
  }

  function connect() {
    clearTimeout(retryTimer);
    try { fit.fit(); } catch { /* not laid out yet */ }
    // A hidden pane can't be measured. One that never was (not `sized`) sends no size: xterm's default 80x24
    // would squeeze a live pty (the server keeps its size, or starts a new one at 100x30). One that was sends
    // its last real size. Either way the first visible fit sends the size again (sizeOwed).
    const shown = !!(container.offsetWidth && container.offsetHeight);
    const q = new URLSearchParams({ id: opts.id });
    if (shown || sized) { q.set('cols', term.cols); q.set('rows', term.rows); }
    sizeOwed = !shown;
    if (opts.cwd) q.set('cwd', opts.cwd);
    if (opts.task) q.set('task', opts.task);
    // Always sent, empty or not: the server keeps the latest, and an empty one is how a pane leaves a space.
    q.set('space', opts.space || '');
    q.set('spaceName', opts.spaceName || '');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    opts.onState && opts.onState('connecting');
    ws = new WebSocket(`${proto}//${location.host}/api/term?${q}`);
    let opened = false;
    let replayed = false;
    ws.onopen = () => {
      opened = true; retry = 0; opts.onState && opts.onState('open');
      payOwedSize();   // shown again before the socket opened: the size first, then any command
      if (pendingRun) { send({ t: 'in', d: pendingRun + '\r' }); pendingRun = ''; }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'o') {
        // The first message after a reconnect is the server's scrollback replay;
        // clear first so it isn't printed twice on top of what's already shown.
        if (!replayed) { replayed = true; if (retryAttached) term.reset(); }
        term.write(m.d);
      } else if (m.t === 'agent') {
        opts.onAgent && opts.onAgent(m.a || null);
      } else if (m.t === 'exit') {
        exited = true;
        term.write('\r\n\x1b[2m[shell exited]\x1b[0m\r\n');
        opts.onExit && opts.onExit();
      }
    };
    ws.onclose = (ev) => {
      if (!opened) {
        // The upgrade was refused (401/403) or the server/network is down: the
        // browser can't tell us which. A laptop waking from sleep hits the
        // second for a few seconds, so keep trying (backing off) for a while.
        opts.onState && opts.onState(retry < 6 ? 'connecting' : 'denied');
        if (retry < 6) retryTimer = setTimeout(connect, Math.min(1500 * 2 ** retry++, 30000));
        return;
      }
      if (ev.code === 4000) { moved = true; opts.onState && opts.onState('moved'); return; }   // attached from another window
      if (closedByUs || exited) { opts.onState && opts.onState('closed'); return; }
      opts.onState && opts.onState('connecting');
      retryAttached = true;
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
    };
  }
  // Back from sleep or offline: reconnect now rather than waiting out a
  // backoff timer (or a retry budget spent while the network was down).
  const wake = () => {
    if (closedByUs || exited || moved || (ws && ws.readyState <= 1)) return;
    if (doc.visibilityState === 'hidden') return;
    retry = 0; retryAttached = true; connect();
  };
  doc.addEventListener('visibilitychange', wake);
  doc.defaultView.addEventListener('online', wake);

  // One-shot input rewrite, set by the phone key row's sticky Ctrl: the next
  // thing typed on the on-screen keyboard goes through it, then it's cleared.
  let inputHook = null;
  term.onData((d) => {
    if (inputHook) { const h = inputHook; inputHook = null; d = h(d); }
    send({ t: 'in', d });
  });
  // A resize while the socket is down is owed, and sent once it is back (payOwedSize).
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === 1) { sizeOwed = false; send({ t: 'resize', cols, rows }); } else sizeOwed = true;
  });
  let lastTitle = '';
  term.onTitleChange((t) => { lastTitle = t; opts.onTitle && opts.onTitle(t); });

  // One fit per frame at most: a drag-resize fires this dozens of times, and
  // each fit that changes the size makes a TUI redraw the whole screen.
  let fitQueued = false;
  const ro = new ResizeObserver(() => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;   // hidden: nothing to fit
      try { fit.fit(); } catch { /* mid-layout */ }
    });
  });
  ro.observe(container);

  connect();

  return {
    term,
    fit: () => { try { fit.fit(); } catch { /* hidden */ } },
    focus: () => term.focus(),
    title: () => lastTitle,
    blur: () => term.blur(),
    onNextInput: (fn) => { inputHook = fn; },
    type: (text) => send({ t: 'in', d: text }),
    seen: () => send({ t: 'seen' }),
    retheme: () => { term.options.theme = termTheme(); },
    kill: () => { closedByUs = true; send({ t: 'kill' }); setTimeout(() => ws && ws.close(), 200); },
    detach: () => { closedByUs = true; if (ws) ws.close(); },
    reconnect: () => { closedByUs = false; moved = false; retry = 0; retryAttached = true; connect(); },
    dispose: () => { closedByUs = true; LIVE_TERMS.delete(live); doc.removeEventListener('mouseup', onRelease); doc.removeEventListener('visibilitychange', wake); doc.defaultView.removeEventListener('online', wake); ro.disconnect(); clearTimeout(retryTimer); if (ws) ws.close(); term.dispose(); },
  };
}
