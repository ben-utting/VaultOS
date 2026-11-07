'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { themePalette, resolveColor, cellCss, dxfCss } = require('../lib/sheet-style');

// every channel within +-1 (the tint maths is rounded; Excel's own is integer HLS)
const near = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ch = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const x = ch(a), y = ch(b);
  return x.every((v, i) => Math.abs(v - y[i]) <= 1);
};

// ---- the plan's tests, verbatim -------------------------------------------

test('palette order', () => { const p = themePalette(`<a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1></a:clrScheme>`); assert.equal(p[0], '#ffffff'); assert.equal(p[1], '#000000'); assert.equal(p[3], '#1f497d'); assert.equal(p[4], '#4f81bd'); });
test('tint', () => { const p = themePalette(); assert.ok(near(resolveColor({ theme: 4, tint: 0.7999816888943144 }, p), '#ddebf7')); assert.ok(near(resolveColor({ theme: 0, tint: -0.1499984740745262 }, p), '#d9d9d9')); });
test('argb and indexed', () => { assert.equal(resolveColor({ argb: 'FFC00000' }), '#c00000'); assert.equal(resolveColor({ indexed: 10 }), '#ff0000'); assert.equal(resolveColor({ indexed: 64 }), null); });
test('cell fill without pattern is no fill', () => assert.equal(cellCss({ fill: { type: 'pattern' } }, themePalette()), ''));
test('dxf uses bgColor, with or without a pattern type', () => { const p = themePalette(); assert.match(dxfCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { indexed: 64 }, bgColor: { argb: 'FFC00000' } }, font: { color: { argb: 'FFFFFFFF' } } }, p), /background:#c00000.*color:#ffffff/); assert.match(dxfCss({ fill: { type: 'pattern', bgColor: { argb: 'FFED7D31' } } }, p), /background:#ed7d31/); });

// ---- the theme palette ----------------------------------------------------

test('no theme gives the Office 2013 defaults, in index order', () => {
  const want = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47', '#0563c1', '#954f72'];
  assert.deepEqual(themePalette(), want);
  assert.deepEqual(themePalette(undefined), want);
  assert.deepEqual(themePalette(null), want);
  assert.deepEqual(themePalette(''), want);
  assert.deepEqual(themePalette(42), want);
  assert.deepEqual(themePalette('<not a theme/>'), want);
});

test('a theme only overrides the slots it defines, and invalid hex falls back', () => {
  const p = themePalette('<a:clrScheme name="x"><a:accent2><a:srgbClr val="112233"/></a:accent2><a:accent3><a:srgbClr val="red; background:url(x)"/></a:accent3><a:hlink><a:srgbClr val="ABCDEF"/></a:hlink><a:folHlink><a:srgbClr val="010203"/></a:folHlink></a:clrScheme>');
  assert.equal(p.length, 12);
  assert.equal(p[5], '#112233');
  assert.equal(p[6], '#a5a5a5');   // invalid value -> default for that slot
  assert.equal(p[4], '#5b9bd5');   // absent -> default
  assert.equal(p[10], '#abcdef');  // hlink is not confused with folHlink
  assert.equal(p[11], '#010203');
  for (const c of p) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('sysClr uses lastClr; a sysClr without it keeps the default', () => {
  const p = themePalette('<a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="101010"/></a:dk1><a:lt1><a:sysClr val="window"/></a:lt1></a:clrScheme>');
  assert.equal(p[1], '#101010');
  assert.equal(p[0], '#ffffff');
});

// ---- colours --------------------------------------------------------------

test('indexed colours: 0-7 mirror 8-15, the table end, and automatic', () => {
  assert.equal(resolveColor({ indexed: 0 }), '#000000');
  assert.equal(resolveColor({ indexed: 1 }), '#ffffff');
  assert.equal(resolveColor({ indexed: 7 }), '#00ffff');
  assert.equal(resolveColor({ indexed: 8 }), '#000000');
  assert.equal(resolveColor({ indexed: 22 }), '#c0c0c0');
  assert.equal(resolveColor({ indexed: 63 }), '#333333');
  assert.equal(resolveColor({ indexed: 64 }), null);
  assert.equal(resolveColor({ indexed: 65 }), null);
  assert.equal(resolveColor({ indexed: 66 }), null);
  assert.equal(resolveColor({ indexed: -1 }), null);
  assert.equal(resolveColor({ indexed: 1.5 }), null);
  assert.equal(resolveColor({ indexed: '10' }), null);
});

test('theme colours resolve through the palette; out of range is null', () => {
  const p = themePalette();
  assert.equal(resolveColor({ theme: 0 }, p), '#ffffff');
  assert.equal(resolveColor({ theme: 1 }, p), '#000000');
  assert.equal(resolveColor({ theme: 11 }, p), '#954f72');
  assert.equal(resolveColor({ theme: 12 }, p), null);
  assert.equal(resolveColor({ theme: -1 }, p), null);
  assert.equal(resolveColor({ theme: 4 }), '#5b9bd5');  // no palette -> defaults
});

test('invalid argb is ignored', () => {
  for (const bad of ['', 'red', 'FFC0000', 'FFC000000', 'GGGGGGGG', 'FFC00000;color:red', 'url(x)', '#C00000', 12345678, null, {}, ['FFC00000']]) {
    assert.equal(resolveColor({ argb: bad }), null, JSON.stringify(bad));
  }
  assert.equal(resolveColor({ argb: 'ffc00000' }), '#c00000');
  assert.equal(resolveColor({ argb: 'C00000' }), '#c00000');   // rgb without alpha
  assert.equal(resolveColor(null), null);
  assert.equal(resolveColor(undefined), null);
  assert.equal(resolveColor('FFC00000'), null);
  assert.equal(resolveColor({}), null);
});

test('tint applies to argb and indexed colours too, and is clamped', () => {
  assert.ok(near(resolveColor({ argb: 'FFFFFFFF', tint: -0.5 }), '#808080'));
  assert.ok(near(resolveColor({ indexed: 10, tint: 0.5 }), '#ff8080'));
  assert.equal(resolveColor({ argb: 'FF336699', tint: 0 }), '#336699');
  assert.equal(resolveColor({ argb: 'FF336699', tint: 'x' }), '#336699');   // junk tint ignored
  assert.equal(resolveColor({ argb: 'FF336699', tint: NaN }), '#336699');
  assert.equal(resolveColor({ argb: 'FF336699', tint: 9 }), '#ffffff');     // clamped to +1
  assert.equal(resolveColor({ argb: 'FF336699', tint: -9 }), '#000000');    // clamped to -1
  assert.equal(resolveColor({ indexed: 64, tint: 0.5 }), null);             // automatic stays automatic
});

test('tint on a grey leaves it grey (no hue drift)', () => {
  const c = resolveColor({ argb: 'FF808080', tint: 0.5 });
  assert.match(c, /^#([0-9a-f]{2})\1\1$/);
});

// ---- cell styles ----------------------------------------------------------

test('empty and non-object styles give an empty string', () => {
  const p = themePalette();
  assert.equal(cellCss(undefined, p), '');
  assert.equal(cellCss(null, p), '');
  assert.equal(cellCss({}, p), '');
  assert.equal(cellCss({ font: {}, border: {}, alignment: {}, fill: {} }, p), '');
  assert.equal(cellCss('background:red', p), '');
  assert.equal(dxfCss(undefined, p), '');
  assert.equal(dxfCss({}, p), '');
});

test('solid fill and the "none" pattern', () => {
  const p = themePalette();
  assert.equal(cellCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { theme: 5 } } }, p), 'background:#ed7d31');
  assert.equal(cellCss({ fill: { type: 'pattern', pattern: 'none', fgColor: { argb: 'FFFF0000' } } }, p), '');
  assert.equal(cellCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { indexed: 64 } } }, p), '');
  assert.equal(cellCss({ fill: { type: 'pattern', pattern: 'solid' } }, p), '');
  assert.equal(cellCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } } }, p), 'background:#d9e1f2');
});

test('gradient fill uses the first stop', () => {
  const p = themePalette();
  const g = { type: 'gradient', gradient: 'angle', degree: 90, stops: [{ position: 0, color: { argb: 'FF00FF00' } }, { position: 1, color: { argb: 'FF0000FF' } }] };
  assert.equal(cellCss({ fill: g }, p), 'background:#00ff00');
  assert.equal(cellCss({ fill: { type: 'gradient', stops: [] } }, p), '');
  assert.equal(cellCss({ fill: { type: 'gradient' } }, p), '');
  assert.equal(cellCss({ fill: { type: 'gradient', stops: [{ position: 0, color: { theme: 4, tint: 0.8 } }] } }, p).slice(0, 12), 'background:#');
});

test('font: bold, italic, underline, strike, colour', () => {
  const p = themePalette();
  assert.equal(cellCss({ font: { bold: true } }, p), 'font-weight:700');
  assert.equal(cellCss({ font: { italic: true } }, p), 'font-style:italic');
  assert.equal(cellCss({ font: { bold: false, italic: false, underline: false, strike: false } }, p), '');
  assert.equal(cellCss({ font: { underline: true } }, p), 'text-decoration:underline');
  assert.equal(cellCss({ font: { underline: 'single' } }, p), 'text-decoration:underline');
  assert.equal(cellCss({ font: { underline: 'double' } }, p), 'text-decoration:underline');
  assert.equal(cellCss({ font: { underline: 'none' } }, p), '');
  assert.equal(cellCss({ font: { underline: 'bogus;x' } }, p), '');
  assert.equal(cellCss({ font: { strike: true } }, p), 'text-decoration:line-through');
  assert.equal(cellCss({ font: { underline: true, strike: true } }, p), 'text-decoration:underline line-through');
  assert.equal(cellCss({ font: { color: { argb: 'FF9C0006' } } }, p), 'color:#9c0006');
  assert.equal(cellCss({ font: { color: { indexed: 64 } } }, p), '');
  assert.equal(cellCss({ font: { color: { theme: 1 } } }, p), 'color:#000000');
  assert.equal(cellCss({ font: { name: 'Calibri', family: 2, scheme: 'minor' } }, p), '');
});

test('font size becomes a ratio of the grid font size', () => {
  const p = themePalette();
  assert.equal(cellCss({ font: { size: 11 } }, p), 'font-size:calc(var(--sg-fs)*1)');
  assert.equal(cellCss({ font: { size: 22 } }, p), 'font-size:calc(var(--sg-fs)*2)');
  assert.equal(cellCss({ font: { size: 10 } }, p), 'font-size:calc(var(--sg-fs)*0.9091)');
  assert.equal(cellCss({ font: { size: 12 } }, p), 'font-size:calc(var(--sg-fs)*1.0909)');
  assert.equal(cellCss({ font: { size: 8.5 } }, p), 'font-size:calc(var(--sg-fs)*0.7727)');
  // junk and absurd sizes never reach the CSS as-is
  assert.equal(cellCss({ font: { size: 0 } }, p), '');
  assert.equal(cellCss({ font: { size: -5 } }, p), '');
  assert.equal(cellCss({ font: { size: NaN } }, p), '');
  assert.equal(cellCss({ font: { size: Infinity } }, p), '');
  assert.equal(cellCss({ font: { size: '12; x:y' } }, p), '');
  assert.equal(cellCss({ font: { size: 1e9 } }, p), 'font-size:calc(var(--sg-fs)*37.1818)');   // clamped to Excel's 409pt
  assert.equal(cellCss({ font: { size: 0.1 } }, p), 'font-size:calc(var(--sg-fs)*0.0909)');    // clamped to 1pt
});

test('declaration order: fill, font, alignment, borders; joined with ; and no trailing ;', () => {
  const css = cellCss({
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
    font: { bold: true, color: { argb: 'FF000000' } },
    alignment: { horizontal: 'center' },
    border: { top: { style: 'thin' } },
  }, themePalette());
  assert.equal(css, 'background:#ffff00;font-weight:700;color:#000000;text-align:center;border-top:1px solid #000000');
  assert.ok(!css.endsWith(';'));
  assert.ok(!/;\s|\s;/.test(css));
});

test('alignment mapping', () => {
  const p = themePalette();
  const h = (horizontal) => cellCss({ alignment: { horizontal } }, p);
  assert.equal(h('left'), 'text-align:left');
  assert.equal(h('right'), 'text-align:right');
  assert.equal(h('center'), 'text-align:center');
  assert.equal(h('justify'), 'text-align:justify');
  assert.equal(h('centerContinuous'), 'text-align:center');
  assert.equal(h('fill'), 'text-align:left');
  assert.equal(h('distributed'), 'text-align:justify');
  assert.equal(h('general'), '');
  assert.equal(h('left; color:red'), '');
  const v = (vertical) => cellCss({ alignment: { vertical } }, p);
  assert.equal(v('top'), 'vertical-align:top');
  assert.equal(v('bottom'), 'vertical-align:bottom');
  assert.equal(v('middle'), 'vertical-align:middle');
  assert.equal(v('center'), 'vertical-align:middle');
  assert.equal(v('justify'), '');
  assert.equal(v('top; x:y'), '');
  assert.equal(cellCss({ alignment: { wrapText: true } }, p), 'white-space:pre-wrap');
  assert.equal(cellCss({ alignment: { wrapText: false } }, p), '');
  assert.equal(cellCss({ alignment: { indent: 2 } }, p), 'padding-left:18px');
  assert.equal(cellCss({ alignment: { horizontal: 'left', indent: 1 } }, p), 'text-align:left;padding-left:9px');
  assert.equal(cellCss({ alignment: { indent: 0 } }, p), '');
  assert.equal(cellCss({ alignment: { indent: -3 } }, p), '');
  assert.equal(cellCss({ alignment: { indent: 'x' } }, p), '');
  assert.equal(cellCss({ alignment: { indent: 1e9 } }, p), 'padding-left:135px');   // clamped to 15 levels
  assert.equal(cellCss({ alignment: { textRotation: 90, shrinkToFit: true, readingOrder: 'rtl' } }, p), '');
  assert.equal(cellCss({ alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } }, p), 'text-align:center;vertical-align:middle;white-space:pre-wrap');
});

test('border mapping', () => {
  const p = themePalette();
  const side = (style, color) => cellCss({ border: { top: { style, color } } }, p);
  assert.equal(side('thin'), 'border-top:1px solid #000000');
  assert.equal(side('medium'), 'border-top:2px solid #000000');
  assert.equal(side('thick'), 'border-top:3px solid #000000');
  assert.equal(side('dashed'), 'border-top:1px dashed #000000');
  assert.equal(side('dotted'), 'border-top:1px dotted #000000');
  assert.equal(side('hair'), 'border-top:1px dotted #000000');
  assert.equal(side('double'), 'border-top:3px double #000000');
  assert.equal(side('mediumDashed'), 'border-top:2px dashed #000000');
  assert.equal(side('dashDot'), 'border-top:1px dashed #000000');
  assert.equal(side('mediumDashDot'), 'border-top:2px dashed #000000');
  assert.equal(side('dashDotDot'), 'border-top:1px dashed #000000');
  assert.equal(side('mediumDashDotDot'), 'border-top:2px dashed #000000');
  assert.equal(side('slantDashDot'), 'border-top:2px dashed #000000');
  // colours: resolved through the palette, default black when absent or automatic
  assert.equal(side('thin', { argb: 'FFBFBFBF' }), 'border-top:1px solid #bfbfbf');
  assert.equal(side('thin', { theme: 5 }), 'border-top:1px solid #ed7d31');
  assert.equal(side('thin', { indexed: 64 }), 'border-top:1px solid #000000');
  assert.equal(side('thin', { argb: 'nonsense' }), 'border-top:1px solid #000000');
  // unknown styles and missing sides draw nothing
  assert.equal(side('none'), '');
  assert.equal(side('thin; background:url(x)'), '');
  assert.equal(side(undefined), '');
  assert.equal(side('constructor'), '');
  assert.equal(cellCss({ border: { top: null, left: undefined, diagonal: { style: 'thin' } } }, p), '');
});

test('borders: all four sides in top, right, bottom, left order', () => {
  const b = { style: 'thin', color: { argb: 'FF112233' } };
  assert.equal(
    cellCss({ border: { left: b, bottom: b, right: b, top: b } }, themePalette()),
    'border-top:1px solid #112233;border-right:1px solid #112233;border-bottom:1px solid #112233;border-left:1px solid #112233',
  );
  assert.equal(cellCss({ border: { right: { style: 'medium' }, bottom: { style: 'medium' } } }, themePalette()), 'border-right:2px solid #000000;border-bottom:2px solid #000000');
});

test('a real-looking ExcelJS style object', () => {
  const css = cellCss({
    font: { color: { theme: 1 }, family: 2, scheme: 'minor', size: 11, name: 'Calibri' },
    border: { left: { style: 'thin', color: { argb: 'FFBFBFBF' } }, right: { style: 'thin', color: { argb: 'FFBFBFBF' } }, top: { style: 'thin', color: { argb: 'FFBFBFBF' } }, bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } },
    fill: { type: 'pattern', pattern: 'none' },
    alignment: { vertical: 'top', wrapText: true },
    numFmt: 'dd/mm/yyyy',
  }, themePalette());
  assert.equal(css, 'color:#000000;font-size:calc(var(--sg-fs)*1);vertical-align:top;white-space:pre-wrap;border-top:1px solid #bfbfbf;border-right:1px solid #bfbfbf;border-bottom:1px solid #bfbfbf;border-left:1px solid #bfbfbf');
});

test('nothing a file supplies is copied into the CSS', () => {
  const evil = '};background:url(//evil/x)';
  const css = cellCss({
    fill: { type: 'pattern', pattern: evil, fgColor: { argb: evil, theme: evil, indexed: evil, tint: evil } },
    font: { color: { argb: evil }, size: evil, bold: evil, italic: evil, underline: evil, strike: evil, name: evil },
    alignment: { horizontal: evil, vertical: evil, wrapText: evil, indent: evil },
    border: { top: { style: evil, color: { argb: evil } }, left: { style: evil } },
  }, themePalette());
  assert.ok(!/url|evil|\}/.test(css), css);
  const dxf = dxfCss({ fill: { pattern: evil, fgColor: { argb: evil }, bgColor: { argb: evil } }, font: { color: { argb: evil }, bold: evil } }, themePalette());
  assert.ok(!/url|evil|\}/.test(dxf), dxf);
});

// ---- dxf (conditional-format) styles --------------------------------------

test('dxf with only a font', () => {
  const p = themePalette();
  assert.equal(dxfCss({ font: { bold: true, color: { argb: 'FF9C0006' } } }, p), 'font-weight:700;color:#9c0006');
  assert.equal(dxfCss({ font: { italic: true, strike: true } }, p), 'font-style:italic;text-decoration:line-through');
  assert.equal(dxfCss({ font: { underline: 'single' } }, p), 'text-decoration:underline');
  assert.equal(dxfCss({ font: { size: 20, color: { argb: 'FF000000' } } }, p), 'color:#000000');   // CF never changes the font size
});

test('dxf in the shape ExcelJS gives (unused parts are null)', () => {
  const p = themePalette();
  const css = dxfCss({ alignment: null, border: null, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC00000' } }, font: { color: { argb: 'FFFFFFFF' } }, numFmt: null, protection: null }, p);
  assert.equal(css, 'background:#c00000;color:#ffffff');
  assert.equal(dxfCss({ alignment: null, border: null, fill: null, font: null, numFmt: null, protection: null }, p), '');
});

test('dxf fill: bgColor wins, fgColor is the fallback, theme colours and tints resolve', () => {
  const p = themePalette();
  assert.equal(dxfCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } } }, p), 'background:#00ff00');
  assert.equal(dxfCss({ fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' }, bgColor: { argb: 'FFFF0000' } } }, p), 'background:#ff0000');
  assert.equal(dxfCss({ fill: { type: 'pattern', bgColor: { indexed: 64 }, fgColor: { argb: 'FF00FF00' } } }, p), 'background:#00ff00');
  assert.equal(dxfCss({ fill: { type: 'pattern', bgColor: { indexed: 64 } } }, p), '');
  assert.equal(dxfCss({ fill: { type: 'pattern', pattern: 'none', bgColor: { argb: 'FFFF0000' } } }, p), '');
  assert.equal(dxfCss({ fill: { bgColor: { theme: 5 } } }, p), 'background:#ed7d31');
  assert.ok(near(resolveColor({ theme: 5, tint: 0.6 }, p), '#f8cbad'));
  assert.match(dxfCss({ fill: { bgColor: { theme: 5, tint: 0.6 } } }, p), /^background:#[0-9a-f]{6}$/);
  assert.match(dxfCss({ fill: { type: 'gradient', stops: [{ position: 0, color: { argb: 'FF123456' } }] } }, p), /^background:#123456$/);
});

test('dxf ignores alignment and borders', () => {
  assert.equal(dxfCss({ alignment: { horizontal: 'center' }, border: { top: { style: 'thin' } } }, themePalette()), '');
});
