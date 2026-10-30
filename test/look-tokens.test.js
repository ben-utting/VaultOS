'use strict';
// The readability floor, read straight from public/styles.css (no browser):
// muted text clears WCAG AA in both themes, every font size comes from one type
// scale whose smallest step is 12px, and placeholders follow the theme.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

// ---------- a small CSS reader ----------
// Comments go first (quoted strings are kept intact so a "/*" or "{" inside
// content: '' can't confuse it), then the text is walked into a tree of blocks.
// Each block has its prelude (selector or at-rule), its own declarations and the
// preludes of the blocks around it, so a :root inside @media print is told apart
// from the top-level one.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

function parseBlocks(src) {
  const text = stripComments(src);
  const blocks = [];
  const stack = [{ prelude: '', own: '', ancestors: [] }];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      buf += text.slice(i, j + 1);
      i = j;
    } else if (c === '{') {
      const parent = stack[stack.length - 1];
      // Text before the brace, after the last ';', is this block's prelude; the rest belongs to the parent.
      const cut = buf.lastIndexOf(';');
      parent.own += buf.slice(0, cut + 1);
      const node = {
        prelude: buf.slice(cut + 1).replace(/\s+/g, ' ').trim(),
        own: '',
        ancestors: [...parent.ancestors, parent.prelude].filter(Boolean),
      };
      stack.push(node);
      buf = '';
    } else if (c === '}') {
      const node = stack.pop();
      node.own += buf;
      node.decls = declarations(node.own);
      blocks.push(node);
      buf = '';
    } else buf += c;
  }
  return blocks;
}

function declarations(body) {
  const out = [];
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).replace(/\s+/g, ' ').replace(/!important/i, '').trim();
    if (prop) out.push({ prop, value });
  }
  return out;
}

const BLOCKS = parseBlocks(CSS);
const topLevel = (b) => b.ancestors.length === 0;

// Later declarations win, as in the cascade.
function tokens(selector) {
  const map = {};
  for (const b of BLOCKS) {
    if (!topLevel(b) || b.prelude !== selector) continue;
    for (const d of b.decls) if (d.prop.startsWith('--')) map[d.prop] = d.value;
  }
  return map;
}
const DARK = tokens(':root');
const SEPIA = { ...DARK, ...tokens(':root[data-theme="light"]') };

// ---------- WCAG contrast ----------
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

test('muted text meets 4.5:1 in both themes', () => {
  const misses = [];
  for (const [name, theme] of [['dark', DARK], ['sepia', SEPIA]]) {
    for (const fg of ['--muted', '--muted-2']) {
      for (const bg of ['--bg', '--panel', '--panel-2']) {
        assert.match(theme[fg] || '', HEX, `${name} ${fg} should be a hex colour`);
        assert.match(theme[bg] || '', HEX, `${name} ${bg} should be a hex colour`);
        const r = ratio(theme[fg], theme[bg]);
        if (r < 4.5) misses.push(`${name} ${fg} ${theme[fg]} on ${bg} ${theme[bg]}: ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(misses, [], `below 4.5:1:\n  ${misses.join('\n  ')}`);
});

// The spreadsheet's chrome has its own colour tokens. Its exemption from the type scale covers sizes only,
// so each text colour must still clear 4.5:1 on the surface it sits on.
function mix(a, b, p) {   // color-mix(in srgb, a p, b)
  const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return `#${x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}
test('sheet text meets 4.5:1 in both themes', () => {
  const misses = [];
  for (const [name, theme] of [['dark', DARK], ['sepia', SEPIA]]) {
    const pairs = [
      ['--sheet-ink', '--sheet-paper', theme['--sheet-paper']],                // .xlsx cells
      ['--sheet-head-fg', '--sheet-head-bg', theme['--sheet-head-bg']],        // row numbers, column letters
      ['--text', '--sheet-head-sel-bg', theme['--sheet-head-sel-bg']],         // a selected header (.sg-hsel)
      ['--sheet-changed', '--sheet-head-bg', theme['--sheet-head-bg']],        // an inserted row's number (.sg-newrow)
      ['--sheet-changed', '--sheet-head-sel-bg', theme['--sheet-head-sel-bg']],
      // a spare header (.sg-spare): color-mix(in srgb, --sheet-head-bg 55%, --bg)
      ['--muted-2', 'spare header', theme['--sheet-head-bg'] && theme['--bg'] && mix(theme['--sheet-head-bg'], theme['--bg'], 0.55)],
    ];
    for (const [fg, bgName, bg] of pairs) {
      assert.match(theme[fg] || '', HEX, `${name} ${fg} should be a hex colour`);
      assert.match(bg || '', HEX, `${name} ${bgName} should be a hex colour`);
      const r = ratio(theme[fg], bg);
      if (r < 4.5) misses.push(`${name} ${fg} ${theme[fg]} on ${bgName} ${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(misses, [], `below 4.5:1:\n  ${misses.join('\n  ')}`);
});

// ---------- the type scale ----------
const TYPE_TOKEN = /^--t-[a-z0-9]+$/;
const px = (v) => { const m = /^(\d*\.?\d+)px$/.exec(v.trim()); return m ? Number(m[1]) : NaN; };

// The A−/A+ reading control scales text by --fs, down to FS_MIN (app.js). A scaled step whose smallest size falls
// under 12px must carry the floor itself: max(var(--t-xs), calc(var(--t-*) * var(--fs))).
const FS_MIN = Number(/const FS_MIN = (\d*\.?\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'))[1]);
function sizeAllowed(v) {
  if (v === 'inherit') return true;
  if (/^var\(--t-[a-z0-9]+\)$/.test(v)) return true;
  const scaled = /^calc\(var\((--t-[a-z0-9]+)\) \* var\(--fs\)\)$/.exec(v);
  if (scaled) return px(DARK[scaled[1]] || '') * FS_MIN >= 12;
  if (/^max\(var\(--t-xs\), calc\(var\(--t-[a-z0-9]+\) \* var\(--fs\)\)\)$/.test(v)) return true;
  if (/^\d*\.?\d+(em|rem|%)$/.test(v)) return true;
  const clamp = /^clamp\(([^,]+),/.exec(v);
  if (clamp) {
    const min = clamp[1].trim();
    return px(min) >= 12 || /^var\(--t-[a-z0-9]+\)$/.test(min);
  }
  return false;
}

// @font-face, print and the spreadsheet grid (.sg-*, which copies Excel's sizes) are exempt.
function exempt(b) {
  const scope = [...b.ancestors, b.prelude];
  if (scope.some((p) => /^@font-face\b/i.test(p) || /^@media print\b/i.test(p))) return true;
  return b.prelude.split(',').every((s) => s.trim().startsWith('.sg-'));
}

test('every font-size uses the type scale', () => {
  const misses = [];
  for (const b of BLOCKS) {
    if (exempt(b)) continue;
    for (const d of b.decls) {
      if (d.prop === 'font-size' && !sizeAllowed(d.value)) misses.push(`${b.prelude} { font-size: ${d.value} }`);
      // The font shorthand carries a size too: a literal length there (not the /line-height after it)
      // dodges the scale the same way.
      if (d.prop === 'font' && /(^|\s)\d*\.?\d+px/.test(d.value)) misses.push(`${b.prelude} { font: ${d.value} }`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} font sizes off the scale:\n  ${misses.join('\n  ')}`);
});

test('no type token is below 12px', () => {
  const scale = Object.entries(DARK).filter(([k]) => TYPE_TOKEN.test(k));
  assert.deepEqual(Object.fromEntries(scale), {
    '--t-xs': '12px', '--t-sm': '13px', '--t-md': '14px', '--t-lg': '16px',
    '--t-xl': '20px', '--t-2xl': '26px', '--t-3xl': '32px',
  });
  // No theme or media block may redefine a step below the floor either.
  for (const b of BLOCKS) {
    for (const d of b.decls) {
      if (TYPE_TOKEN.test(d.prop)) assert.ok(px(d.value) >= 12, `${b.prelude} { ${d.prop}: ${d.value} } is below 12px`);
    }
  }
  // And every var(--t-*) in use names a step that exists.
  const used = new Set(CSS.match(/var\(--t-[a-z0-9]+\)/g) || []);
  for (const u of used) assert.ok(DARK[u.slice(4, -1)], `${u} is used but not defined`);
});

test('placeholders are themed', () => {
  const global = BLOCKS.find((b) => topLevel(b)
    && b.prelude.split(',').some((s) => /^\*?::placeholder$/.test(s.trim()))
    && b.decls.some((d) => d.prop === 'color' && d.value === 'var(--muted)'));
  assert.ok(global, 'a global ::placeholder { color: var(--muted) } rule');
});

// ---------- gold means "VaultOS" or "act on me"; one way to show "selected" ----------
const sel = (b) => b.prelude.split(',').map((s) => s.trim());
const where = (b) => [...b.ancestors, b.prelude].join(' > ');
const GOLD_FILL = /^var\(--(accent|brand)\)$/;
// A selector counts once, however many blocks (or media queries) fill it.
const goldFilled = () => {
  const found = new Set();
  for (const b of BLOCKS) {
    if (!b.decls.some((d) => (d.prop === 'background' || d.prop === 'background-color') && GOLD_FILL.test(d.value))) continue;
    for (const s of sel(b)) found.add(s);
  }
  return found;
};

test('only the mode pill and primary buttons fill with gold', () => {
  // Written down from the file as it stood. The filled surfaces below are the identity (--brand) or an
  // action (--accent): a mode pill, a primary button, or a small badge, dot or rule that is gold on purpose.
  const IDENTITY_AND_ACTION = [
    '.mode.active',                                    // the active mode pill: the one "you are here" in the shell
    '.mobile-nav button.active::before',               // the same pill on the phone's bottom bar
    '.login-card button', '.su-btn.primary', '.td-btn.primary',                  // primary buttons
    '.fx-sheet-save:not(:disabled)', '.sg-note-warn .sg-note-acts button:first-child:not(:disabled)',
    '.tw-compose-btns .tw-compose-send',
    '.kb-eyebrow::before', '.km-eyebrow::before',      // the 18px brand rule before a heading
    '.tw-prefix', '.fx-fresh', '.su-bar span.now',     // brand marks: tmux prefix, new file, current setup step
    '#termbtn[data-n]:not([data-n=""])::after', '#mnav-term[data-n]:not([data-n=""])::after',   // "an agent wants you"
    '.set-dot', '.ss-nav .n', '.cx-dots span',         // unsaved dot, count badge, working dots
    '.tw-split[data-dir]::after',                      // the split-pane drop hint
  ];
  // Solid gold that is a state or progress mark, not a selection (ruling 9): stays gold on purpose.
  const ASKED_ABOUT = [
    '.tw-keys button[aria-pressed="true"]',   // a latched modifier key on the phone key bar
    '.ap-chip.def',                           // the "default" tag on an agent card
    '.su-switch:checked',                     // a toggle that is on
    '.td-fill',                               // a goal habit's progress fill
    '.td-dots i.on',                          // Pomodoro progress dots
  ];
  // The selected day's score bar on Today is brand-coloured on purpose (the brief for this change).
  const allowed = new Set([...IDENTITY_AND_ACTION, ...ASKED_ABOUT, '.td-bar.sel .td-col']);
  const found = goldFilled();
  for (const s of ['.seg button.on', '.viewseg button.on', '.td-tick[aria-pressed="true"]', '.td-cell.on', '.td-tchk[aria-pressed="true"]']) {
    assert.ok(!found.has(s), `${s} must not fill with gold`);
  }
  const extra = [...found].filter((s) => !allowed.has(s));
  const gone = [...allowed].filter((s) => !found.has(s));
  assert.deepEqual(extra, [], `gold fills not on the allowlist:\n  ${extra.join('\n  ')}`);
  assert.deepEqual(gone, [], `allowlisted but no longer gold (tidy the list):\n  ${gone.join('\n  ')}`);
});

test('selected states share one treatment', () => {
  const want = [
    ['background', 'var(--panel-2)'],
    ['color', 'var(--text)'],
    ['box-shadow', 'inset 0 0 0 1px var(--accent)'],
  ];
  const lacking = [];
  for (const s of ['.seg button.on', '.viewseg button.on', '.ss-nav button.active', '.ws-row.active', '.ws-menu [aria-checked="true"]']) {
    const blocks = BLOCKS.filter((b) => topLevel(b) && sel(b).includes(s));
    for (const [prop, value] of want) {
      const last = blocks.flatMap((b) => b.decls).filter((d) => d.prop === prop).pop();
      if (!last || last.value !== value) lacking.push(`${s} { ${prop}: ${last ? last.value : '(none)'} } should be ${value}`);
    }
  }
  assert.deepEqual(lacking, [], lacking.join('\n'));
  // Radios follow the interaction colour, not the brand.
  const radio = BLOCKS.find((b) => topLevel(b) && sel(b).includes('.ws-row input[type="radio"]') && b.decls.some((d) => d.prop === 'accent-color'));
  assert.equal(radio && radio.decls.find((d) => d.prop === 'accent-color').value, 'var(--accent)');
  // In the menu the selected item is also bolder, so "selected" doesn't rest on the ring alone.
  const weight = BLOCKS.filter((b) => topLevel(b) && sel(b).includes('.ws-menu [aria-checked="true"]')).flatMap((b) => b.decls).filter((d) => d.prop === 'font-weight').pop();
  assert.equal(weight && weight.value, '600');
  // The menu item that has keyboard focus must not look like the selected one.
  const outline = BLOCKS.filter((b) => topLevel(b) && sel(b).includes('.ws-menu button:focus-visible')).flatMap((b) => b.decls).filter((d) => d.prop === 'outline').pop();
  assert.ok(outline && outline.value === '2px solid var(--accent)', '.ws-menu button:focus-visible keeps the 2px accent ring');
});

// Resolve a token value to a hex: a hex, var(--x), or color-mix(in srgb, A p%, B) of those.
function resolve(spec, theme, what) {
  const v = String(spec).trim();
  if (HEX.test(v)) return v;
  let m = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (m) return resolve(theme[m[1]], theme, what);
  m = /^color-mix\(in srgb, (.+?) (\d+)%, (.+)\)$/.exec(v);
  if (m) return mix(resolve(m[1], theme, what), resolve(m[3], theme, what), Number(m[2]) / 100);
  assert.fail(`${what} "${spec}" is not a form this test can measure`);
}

// A finished habit steps back from solid green: a soft green tick whose check is --done (--done-ink, which
// is --done itself in dark and a darker mix in sepia, where --done is only 2.6:1 on the soft fill). The check
// is a graphic, so it needs 3:1 on that fill. The quiet score bars (--done-bar) and the selected bar (--brand)
// need 3:1 on the card.
test('done ticks and score bars stay readable in both themes', () => {
  const decl = (selector, prop) => {
    const hit = BLOCKS.filter((b) => topLevel(b) && sel(b).includes(selector)).flatMap((b) => b.decls).filter((d) => d.prop === prop).pop();
    return hit && hit.value;
  };
  for (const s of ['.td-tick[aria-pressed="true"]', '.td-cell.on', '.td-tchk[aria-pressed="true"]']) {
    assert.equal(decl(s, 'background'), 'color-mix(in srgb, var(--done) 24%, var(--panel-2))', `${s} background`);
    assert.equal(decl(s, 'border-color'), 'color-mix(in srgb, var(--done) 60%, transparent)', `${s} border-color`);
    assert.equal(decl(s, 'color'), 'var(--done-ink)', `${s} check colour`);
  }
  assert.equal(decl('.td-bar.sel .td-col', 'background'), 'var(--brand)');
  assert.equal(decl('.td-col', 'background'), 'var(--done-bar)');
  const misses = [];
  for (const [name, t] of [['dark', DARK], ['sepia', SEPIA]]) {
    const fill = mix(t['--done'], t['--panel-2'], 0.24);
    const ink = resolve(t['--done-ink'], t, `${name} --done-ink`);
    const check = ratio(ink, fill);
    if (check < 3) misses.push(`${name} check ${ink} on ${fill}: ${check.toFixed(2)}`);
    // The quiet bars sit on the Today card (--panel): WCAG 1.4.11 asks 3:1 for a graphic that carries information.
    const bar = resolve(t['--done-bar'], t, `${name} --done-bar`);
    const barRatio = ratio(bar, t['--panel']);
    if (barRatio < 3) misses.push(`${name} quiet bar ${bar} on --panel ${t['--panel']}: ${barRatio.toFixed(2)}`);
    for (const card of ['--panel', '--panel-2']) {
      const r = ratio(t['--brand'], t[card]);
      if (r < 3) misses.push(`${name} selected bar ${t['--brand']} on ${card}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(misses, [], `below 3:1:\n  ${misses.join('\n  ')}`);
});
