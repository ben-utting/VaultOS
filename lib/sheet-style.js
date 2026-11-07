'use strict';

// ========================================================================
// xlsx colours and cell styles -> CSS for the spreadsheet viewer.
//
// The CSS strings built here end up in inline `style` attributes in the
// browser, so nothing a workbook supplies is ever copied into them: colours
// are rebuilt as `#rrggbb` from validated hex digits, numbers are computed and
// clamped, and every keyword comes from a fixed table in this file. Anything
// that doesn't validate is ignored.
//
// Input shapes are ExcelJS 4.4.0's: `cell.style` parts (fill / font /
// alignment / border) and conditional-format `rule.style` (a dxf).
// ========================================================================

// Office 2013 theme, in Excel's colour-index order: lt1 dk1 lt2 dk2 accent1-6 hlink folHlink
const DEFAULT_PALETTE = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47', '#0563c1', '#954f72'];

// theme XML element names in palette-index order (the XML itself lists dk1, lt1, dk2, lt2)
const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

// legacy indexed colours 8-63; indexes 0-7 repeat 8-15
const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 '
  + '9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF '
  + '00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 '
  + '003366 339966 003300 333300 993300 993366 333399 333333').split(' ').map((h) => '#' + h.toLowerCase());

const HEX6 = /^[0-9a-fA-F]{6}$/;
const ARGB = /^(?:[0-9a-fA-F]{2})?[0-9a-fA-F]{6}$/;   // AARRGGBB, or RRGGBB; alpha is ignored
const CSS_HEX = /^#[0-9a-f]{6}$/;

const MIN_FONT_PT = 1, MAX_FONT_PT = 409;   // Excel's font-size limits
const BASE_FONT_PT = 11;                    // the size the grid font stands for (--sg-fs)
const MAX_INDENT = 15;                      // indent levels
const INDENT_PX = 9;                        // ~ one Excel indent level

const HORIZONTAL = new Map([
  ['left', 'left'], ['right', 'right'], ['center', 'center'], ['justify', 'justify'],
  ['centerContinuous', 'center'], ['fill', 'left'], ['distributed', 'justify'],
]);
const VERTICAL = new Map([['top', 'top'], ['bottom', 'bottom'], ['middle', 'middle'], ['center', 'middle']]);
const UNDERLINES = new Set([true, 'single', 'double', 'singleAccounting', 'doubleAccounting']);
const BORDER_STYLES = new Map([
  ['thin', '1px solid'], ['medium', '2px solid'], ['thick', '3px solid'],
  ['dashed', '1px dashed'], ['dotted', '1px dotted'], ['hair', '1px dotted'], ['double', '3px double'],
  ['mediumDashed', '2px dashed'], ['dashDot', '1px dashed'], ['mediumDashDot', '2px dashed'],
  ['dashDotDot', '1px dashed'], ['mediumDashDotDot', '2px dashed'], ['slantDashDot', '2px dashed'],
]);
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];

const isObj = (v) => v !== null && typeof v === 'object';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

// ---- theme ----------------------------------------------------------------

// `xml` is the workbook's theme part as a string (ExcelJS: wb._themes.theme1); it may be missing.
// Slots the theme doesn't define, or defines with something that isn't six hex digits, keep the default.
function themePalette(xml) {
  const palette = DEFAULT_PALETTE.slice();
  if (typeof xml !== 'string') return palette;
  const scheme = /<(?:\w+:)?clrScheme\b[\s\S]*?<\/(?:\w+:)?clrScheme>/.exec(xml);
  if (!scheme) return palette;
  THEME_SLOTS.forEach((name, i) => {
    const slot = new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?' + name + '>').exec(scheme[0]);
    if (!slot) return;
    const m = /<(?:\w+:)?sysClr\b[^>]*?\blastClr="([^"]*)"/.exec(slot[1]) || /<(?:\w+:)?srgbClr\b[^>]*?\bval="([^"]*)"/.exec(slot[1]);
    if (m && HEX6.test(m[1])) palette[i] = '#' + m[1].toLowerCase();
  });
  return palette;
}

// ---- colour maths ---------------------------------------------------------

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// Excel's tint: lighten (tint > 0) or darken (tint < 0) the colour's HSL lightness.
function applyTint(css, tint) {
  const r = parseInt(css.slice(1, 3), 16), g = parseInt(css.slice(3, 5), 16), b = parseInt(css.slice(5, 7), 16);
  const [h, s, l] = rgbToHsl(r, g, b);
  const l2 = clamp(tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint, 0, 1);
  const [r2, g2, b2] = hslToRgb(h, s, l2);
  return '#' + hex2(r2) + hex2(g2) + hex2(b2);
}

// {argb} | {theme} | {indexed}, plus an optional tint -> '#rrggbb', or null for anything that isn't a
// usable colour (invalid values, "automatic" = indexed 64/65).
function resolveColor(color, palette) {
  if (!isObj(color)) return null;
  let css = null;
  if (color.argb !== undefined) {
    if (typeof color.argb !== 'string' || !ARGB.test(color.argb)) return null;
    css = '#' + color.argb.slice(-6).toLowerCase();
  } else if (color.theme !== undefined) {
    if (!Number.isInteger(color.theme) || color.theme < 0 || color.theme >= DEFAULT_PALETTE.length) return null;
    const mine = Array.isArray(palette) ? palette[color.theme] : undefined;
    css = typeof mine === 'string' && CSS_HEX.test(mine) ? mine : DEFAULT_PALETTE[color.theme];
  } else if (color.indexed !== undefined) {
    const i = color.indexed;
    if (!Number.isInteger(i) || i < 0 || i > 63) return null;   // 64/65 are "automatic"; beyond is invalid
    css = INDEXED[i < 8 ? i : i - 8];
  }
  if (css === null) return null;
  if (typeof color.tint === 'number' && Number.isFinite(color.tint) && color.tint !== 0) css = applyTint(css, clamp(color.tint, -1, 1));
  return css;
}

// ---- CSS ------------------------------------------------------------------

const firstStop = (fill) => (Array.isArray(fill.stops) && isObj(fill.stops[0]) ? fill.stops[0].color : undefined);

function cellFill(fill, palette) {
  if (!isObj(fill)) return [];
  let c = null;
  if (fill.type === 'gradient') c = resolveColor(firstStop(fill), palette);
  else if (fill.type === 'pattern' && typeof fill.pattern === 'string' && fill.pattern !== 'none') c = resolveColor(fill.fgColor, palette);
  return c ? ['background:' + c] : [];
}

// a conditional format's fill is stored the other way round: the colour is the bgColor
function dxfFill(fill, palette) {
  if (!isObj(fill)) return [];
  let c = null;
  if (fill.type === 'gradient') c = resolveColor(firstStop(fill), palette);
  else if (fill.pattern !== 'none') c = resolveColor(fill.bgColor, palette) || resolveColor(fill.fgColor, palette);
  return c ? ['background:' + c] : [];
}

function fontCss(font, palette, withSize) {
  if (!isObj(font)) return [];
  const out = [];
  if (font.bold === true) out.push('font-weight:700');
  if (font.italic === true) out.push('font-style:italic');
  const deco = [];
  if (UNDERLINES.has(font.underline)) deco.push('underline');
  if (font.strike === true) deco.push('line-through');
  if (deco.length) out.push('text-decoration:' + deco.join(' '));
  const c = resolveColor(font.color, palette);
  if (c) out.push('color:' + c);
  if (withSize && typeof font.size === 'number' && Number.isFinite(font.size) && font.size > 0) {
    const ratio = Math.round(clamp(font.size, MIN_FONT_PT, MAX_FONT_PT) / BASE_FONT_PT * 1e4) / 1e4;
    out.push('font-size:calc(var(--sg-fs)*' + ratio + ')');
  }
  return out;
}

function alignmentCss(al) {
  if (!isObj(al)) return [];
  const out = [];
  const h = typeof al.horizontal === 'string' ? HORIZONTAL.get(al.horizontal) : undefined;
  if (h) out.push('text-align:' + h);
  const v = typeof al.vertical === 'string' ? VERTICAL.get(al.vertical) : undefined;
  if (v) out.push('vertical-align:' + v);
  if (al.wrapText === true) out.push('white-space:pre-wrap');
  if (typeof al.indent === 'number' && Number.isFinite(al.indent) && al.indent > 0 && h !== 'center') {
    const px = Math.round(clamp(al.indent, 0, MAX_INDENT)) * INDENT_PX;
    if (px > 0) out.push((h === 'right' ? 'padding-right:' : 'padding-left:') + px + 'px');
  }
  return out;
}

function borderCss(border, palette) {
  if (!isObj(border)) return [];
  const out = [];
  for (const side of BORDER_SIDES) {
    const b = border[side];
    if (!isObj(b) || typeof b.style !== 'string') continue;
    const look = BORDER_STYLES.get(b.style);
    if (look) out.push('border-' + side + ':' + look + ' ' + (resolveColor(b.color, palette) || '#000000'));
  }
  return out;
}

// An ExcelJS cell style -> CSS declarations (no spaces, no trailing ';'), or ''.
function cellCss(style, palette) {
  if (!isObj(style)) return '';
  return [].concat(
    cellFill(style.fill, palette),
    fontCss(style.font, palette, true),
    alignmentCss(style.alignment),
    borderCss(style.border, palette),
  ).join(';');
}

// A conditional-format (dxf) style -> CSS: fill and font only. Conditional formats can't change the font
// size, so the size is left out (it would also change the row's layout).
function dxfCss(style, palette) {
  if (!isObj(style)) return '';
  return [].concat(dxfFill(style.fill, palette), fontCss(style.font, palette, false)).join(';');
}

module.exports = { themePalette, resolveColor, cellCss, dxfCss };
