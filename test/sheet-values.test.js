'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayText, editText, isDateFmt, coerceInput } = require('../lib/sheet-values');

const utc = (...a) => new Date(Date.UTC(...a));

// ---- the plan's tests, verbatim -------------------------------------------

test('display', () => { assert.equal(displayText(0.125, '0.0%'), '12.5%'); assert.equal(displayText(1234.5, '#,##0.00'), '1,234.50'); assert.equal(displayText(1234.5, '"£"#,##0'), '£1,235'); assert.equal(displayText(0.1 + 0.2), '0.3'); assert.equal(displayText(new Date(Date.UTC(2026, 2, 12)), 'dd/mm/yyyy'), '12/03/2026'); assert.equal(displayText({ formula: 'SUM(A1:A2)', result: 3 }), '3'); assert.equal(displayText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab'); });
test('lookalikes stay text', () => { for (const s of ['007', '0123 456', '1234567890123456', '1,234', '1e5', '=SUM(A1)', ' 12']) assert.equal(coerceInput(s, { value: null }), s); assert.equal(coerceInput('42', { value: '41' }), '42'); assert.equal(coerceInput('42', { value: null, numFmt: '@' }), '42'); });
test('numbers, blanks, booleans, dates', () => { assert.equal(coerceInput('42', { value: 7 }), 42); assert.equal(coerceInput('-0.5', { value: null }), -0.5); assert.equal(coerceInput('', { value: 3 }), null); assert.equal(coerceInput('true', { value: false }), true); assert.equal(coerceInput('true', { value: null }), 'true'); assert.deepEqual(coerceInput('12/03/2026', { value: new Date(0) }), new Date(Date.UTC(2026, 2, 12))); assert.equal(coerceInput('12/03/2026', { value: null }), '12/03/2026'); });
test('hyperlink keeps its target', () => assert.deepEqual(coerceInput('New', { value: { text: 'Old', hyperlink: 'https://x' } }), { text: 'New', hyperlink: 'https://x' }));

// ---- isDateFmt ------------------------------------------------------------

test('isDateFmt: dates, times, and things that only look like them', () => {
  for (const f of ['dd/mm/yyyy', 'mm-dd-yy', 'd-mmm-yy', 'yyyy-mm-dd', '[$-409]d-mmm-yy', 'h:mm', 'hh:mm:ss', '[h]:mm', 'mm:ss', 'h:mm AM/PM', 'm/d/yy h:mm', 'DD/MM/YYYY']) assert.equal(isDateFmt(f), true, f);
  for (const f of ['General', '0.00', '#,##0', '0.0%', '@', '[Red]0.00', '[$£-809]#,##0.00', '"d"0', '0 "days"', '\\d0', '_-* #,##0.00_-', undefined, null, '']) assert.equal(isDateFmt(f), false, String(f));
});

// ---- displayText: numbers -------------------------------------------------

test('display: General strips float noise and never pads', () => {
  assert.equal(displayText(5), '5');
  assert.equal(displayText(-1234.5678), '-1234.5678');
  assert.equal(displayText(0.1 + 0.7, 'General'), '0.8');
  assert.equal(displayText(1234.5, 'General'), '1234.5');
  assert.equal(displayText(1234.5, ''), '1234.5');
});

test('display: fixed decimals, thousands, padding, percent', () => {
  assert.equal(displayText(5, '0.00'), '5.00');
  assert.equal(displayText(1234.5, '0'), '1235');
  assert.equal(displayText(1234567.891, '#,##0.00'), '1,234,567.89');
  assert.equal(displayText(7, '000'), '007');
  assert.equal(displayText(0.07, '0%'), '7%');
  assert.equal(displayText(0.5, '.00'), '.50');
  assert.equal(displayText(0, '#,##0.00'), '0.00');
  assert.equal(displayText(1.5, '0.##'), '1.5');
  assert.equal(displayText(2, '0.##'), '2');
});

test('display: rounds half away from zero, on the 15-digit value Excel uses', () => {
  assert.equal(displayText(1.005, '0.00'), '1.01');
  assert.equal(displayText(2.5, '0'), '3');
  assert.equal(displayText(-2.5, '0'), '-3');
  assert.equal(displayText(0.285, '0.00'), '0.29');
  assert.equal(displayText(0.1 + 0.2, '0.0000000000'), '0.3000000000');
});

test('display: literal prefix and suffix, currency brackets', () => {
  assert.equal(displayText(1234.5, '£#,##0'), '£1,235');
  assert.equal(displayText(1234.5, '[$£-809]#,##0.00'), '£1,234.50');
  assert.equal(displayText(1234.5, '[$€-x]#,##0.00'), '€1,234.50');
  assert.equal(displayText(12, '0 "kg"'), '12 kg');
  assert.equal(displayText(12, '#,##0 "units"'), '12 units');
  assert.equal(displayText(99.5, '$#,##0.00'), '$99.50');
});

test('display: negatives, with and without a negative section', () => {
  assert.equal(displayText(-1234.5, '#,##0.00'), '-1,234.50');
  assert.equal(displayText(-5, '"£"#,##0'), '-£5');
  assert.equal(displayText(1234.5, '#,##0;(#,##0)'), '1,235');
  assert.equal(displayText(-1234.5, '#,##0;(#,##0)'), '(1,235)');
  assert.equal(displayText(-3, '0;-0;"-"'), '-3');
  assert.equal(displayText(0, '0;-0;"-"'), '-');
  assert.equal(displayText(-0.5, '0.0%'), '-50.0%');
});

test('display: an unread section only matters if the number lands in it', () => {
  const accounting = '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-';   // the zero section uses ??
  assert.equal(displayText(1234.5, accounting), '1,234.50');
  assert.equal(displayText(-1234.5, accounting), '-1,234.50');
  assert.equal(displayText(0, accounting), '0');
});

test('display: colour brackets are ignored', () => {
  assert.equal(displayText(3.14159, '[Red]0.00'), '3.14');
  assert.equal(displayText(-3.14159, '0.00;[Red]-0.00'), '-3.14');
});

test('display: formats we cannot read confidently fall back to General', () => {
  assert.equal(displayText(1234.5, '0.00E+00'), '1234.5');
  assert.equal(displayText(0.5, '# ?/?'), '0.5');
  assert.equal(displayText(1234.5, '[>100]0.0;0'), '1234.5');
  assert.equal(displayText(-5, '[>100]0.0;0'), '-5');
  assert.equal(displayText(1234.5, '@'), '1234.5');
  assert.equal(displayText(1234.5, '0 0'), '1234.5');
  assert.equal(displayText(1234567, '#,##0,'), '1234567');
});

// ---- displayText: other value shapes --------------------------------------

test('display: booleans, errors, blanks, text', () => {
  assert.equal(displayText(true), 'TRUE');
  assert.equal(displayText(false, '0.00'), 'FALSE');
  assert.equal(displayText({ error: '#N/A' }), '#N/A');
  assert.equal(displayText(null), '');
  assert.equal(displayText(undefined, '0.00'), '');
  assert.equal(displayText('007', '0.00'), '007');
});

test('display: hyperlinks, plain and rich', () => {
  assert.equal(displayText({ text: 'Site', hyperlink: 'https://x' }), 'Site');
  assert.equal(displayText({ text: { richText: [{ text: 'a' }, { text: 'b' }] }, hyperlink: 'https://x' }), 'ab');
});

test('display: formula results', () => {
  assert.equal(displayText({ formula: 'A1*2', result: 1234.5 }, '#,##0.00'), '1,234.50');
  assert.equal(displayText({ sharedFormula: 'A1', result: 4 }), '4');
  assert.equal(displayText({ formula: 'TODAY()', result: utc(2026, 2, 12) }, 'dd/mm/yyyy'), '12/03/2026');
  assert.equal(displayText({ formula: '1/0', result: { error: '#DIV/0!' } }), '#DIV/0!');
  assert.equal(displayText({ formula: 'A1', result: undefined }), '');
  assert.equal(displayText({ formula: 'A1' }), '');
  assert.equal(displayText({ formula: 'A1&"x"', result: 'ax' }), 'ax');
  assert.equal(displayText({ formula: 'A1>0', result: true }), 'TRUE');
});

// ---- displayText: dates ---------------------------------------------------

test('display: every date is dd/mm/yyyy whatever the format\'s token order', () => {
  const d = utc(2026, 2, 12);
  assert.equal(displayText(d, 'mm-dd-yy'), '12/03/2026');   // ExcelJS maps built-in id 14 to this
  assert.equal(displayText(d, 'd-mmm-yy'), '12/03/2026');
  assert.equal(displayText(d, 'dd/mm/yyyy'), '12/03/2026');
  assert.equal(displayText(d), '12/03/2026');
  assert.equal(displayText(d, 'General'), '12/03/2026');
  assert.equal(displayText(utc(2026, 0, 5), 'd/m/yy'), '05/01/2026');
});

test('display: ISO-like (year first) formats show yyyy-mm-dd', () => {
  assert.equal(displayText(utc(2026, 2, 12), 'yyyy-mm-dd'), '2026-03-12');
  assert.equal(displayText(utc(2026, 2, 12, 9, 5), 'yyyy-mm-dd hh:mm'), '2026-03-12 09:05');
  assert.equal(displayText(utc(2026, 2, 12), '[$-409]yyyy/mm/dd'), '2026-03-12');
});

test('display: date plus time when the format has h or s', () => {
  assert.equal(displayText(utc(2026, 2, 12, 9, 5), 'dd/mm/yyyy hh:mm'), '12/03/2026 09:05');
  assert.equal(displayText(utc(2026, 2, 12, 9, 5), 'm/d/yy h:mm'), '12/03/2026 09:05');
  assert.equal(displayText(utc(2026, 2, 12, 0, 0), 'dd/mm/yyyy hh:mm'), '12/03/2026 00:00');
  assert.equal(displayText(utc(2026, 2, 12, 9, 5, 7), 'dd/mm/yyyy hh:mm:ss'), '12/03/2026 09:05:07');
  assert.equal(displayText(utc(2026, 2, 12, 9, 5), 'dd/mm/yyyy'), '12/03/2026');
});

test('display: time-only formats show just the time', () => {
  const t = utc(1899, 11, 30, 9, 5);
  assert.equal(displayText(t, 'h:mm'), '09:05');
  assert.equal(displayText(t, 'hh:mm'), '09:05');
  assert.equal(displayText(utc(1899, 11, 30, 9, 5, 7), 'hh:mm:ss'), '09:05:07');
  assert.equal(displayText(t, '[h]:mm'), '09:05');
  assert.equal(displayText(t, 'h:mm AM/PM'), '09:05');
});

test('display: date arithmetic is UTC, so the machine time zone cannot move a date', () => {
  assert.equal(displayText(utc(2026, 2, 12, 23, 59), 'dd/mm/yyyy'), '12/03/2026');
  assert.equal(displayText(utc(2026, 2, 12, 0, 0), 'dd/mm/yyyy'), '12/03/2026');
  assert.equal(displayText(utc(2026, 11, 31), 'dd/mm/yyyy'), '31/12/2026');
});

test('display: a time ExcelJS rounded 1ms short of the minute still reads as that minute', () => {
  assert.equal(displayText(new Date(Date.UTC(1899, 11, 30, 9, 5) - 1), 'hh:mm'), '09:05');
  assert.equal(displayText(new Date(Date.UTC(2026, 2, 12, 9, 5) + 1), 'dd/mm/yyyy hh:mm'), '12/03/2026 09:05');
});

test('display: an invalid Date is blank', () => assert.equal(displayText(new Date(NaN), 'dd/mm/yyyy'), ''));

// ---- editText -------------------------------------------------------------

test('editText: numbers are unformatted', () => {
  assert.equal(editText(0.125, '0.0%'), '0.125');
  assert.equal(editText(1234.5, '"£"#,##0.00'), '1234.5');
  assert.equal(editText(0.1 + 0.2, '0.00'), '0.3');
  assert.equal(editText(-7), '-7');
});

test('editText: dates are dd/mm/yyyy, with the time when there is one', () => {
  assert.equal(editText(utc(2026, 2, 12), 'dd/mm/yyyy'), '12/03/2026');
  assert.equal(editText(utc(2026, 2, 12), 'yyyy-mm-dd'), '12/03/2026');
  assert.equal(editText(utc(2026, 2, 12, 9, 5), 'dd/mm/yyyy'), '12/03/2026 09:05');
  assert.equal(editText(utc(2026, 2, 12), 'dd/mm/yyyy hh:mm'), '12/03/2026 00:00');
  assert.equal(editText(utc(2026, 2, 12, 9, 5, 7), 'dd/mm/yyyy'), '12/03/2026 09:05:07');
  assert.equal(editText(utc(2026, 2, 12, 9, 5), undefined), '12/03/2026 09:05');
});

test('editText: time-only cells edit as a time', () => {
  assert.equal(editText(utc(1899, 11, 30, 9, 5), 'h:mm'), '09:05');
  assert.equal(editText(utc(1899, 11, 30, 9, 5), 'hh:mm:ss'), '09:05:00');
});

test('editText: everything else reads like displayText', () => {
  assert.equal(editText(null), '');
  assert.equal(editText('007', '0.00'), '007');
  assert.equal(editText(true), 'TRUE');
  assert.equal(editText({ error: '#N/A' }), '#N/A');
  assert.equal(editText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(editText({ text: 'Site', hyperlink: 'https://x' }), 'Site');
  assert.equal(editText({ formula: 'A1', result: 3 }), '3');
});

test('editText: numbers in the exponent range are written out in full', () => {
  assert.equal(editText(5e-7), '0.0000005');
  assert.equal(editText(-5e-7), '-0.0000005');
  assert.equal(editText(1.5e-7), '0.00000015');
  assert.equal(editText(1e21), '1000000000000000000000');
  assert.equal(editText(-1e21), '-1000000000000000000000');
  assert.equal(editText(1.25e22), '12500000000000000000000');
  assert.equal(editText(123456789012345678901234), '123456789012346000000000');
  assert.equal(editText(1234567890123456), '1234567890123460');   // 15 significant digits, like General
  assert.equal(editText(0.000001), '0.000001');
});

test('editText then coerceInput hands back the same value (no-op edits change nothing)', () => {
  const cases = [
    [utc(2026, 2, 12), 'dd/mm/yyyy'],
    [utc(2026, 2, 12, 9, 5), 'dd/mm/yyyy hh:mm'],
    [utc(2026, 2, 12, 9, 5, 7), 'dd/mm/yyyy'],
    [utc(2026, 11, 31, 23, 59), 'yyyy-mm-dd'],
    [utc(1899, 11, 30, 9, 5), 'h:mm'],
    [utc(1899, 11, 30, 9, 5, 7), 'hh:mm:ss'],
    [utc(2026, 2, 12, 9, 0), 'h:mm'],
    // ExcelJS reads a plain 0, 1 or 0.5 under a date format as 1899 dates
    [utc(1899, 11, 30), 'dd/mm/yyyy'],
    [utc(1899, 11, 31), 'mm-dd-yy'],
    [utc(1899, 11, 30, 12, 0), 'dd/mm/yyyy hh:mm'],
    [utc(1904, 0, 1), 'dd/mm/yyyy'],
    // sub-second noise survives
    [new Date(Date.UTC(2026, 2, 12, 9, 5) + 400), 'dd/mm/yyyy hh:mm'],
    [new Date(Date.UTC(2026, 2, 12) + 1), 'dd/mm/yyyy'],
    [0.1 + 0.2, '0.00'],
    [1234.5, '"£"#,##0.00'],
    [-0.5, '0%'],
    [5e-7, 'General'],
    [-5e-7, '0.00'],
    [1e21, 'General'],
    [-1e21, 'General'],
    [1234567890123456, 'General'],
    [123456789012345678, '0'],
    ['007', 'General'],
    [true, 'General'],
  ];
  for (const [value, numFmt] of cases) {
    const back = coerceInput(editText(value, numFmt), { value, numFmt });
    if (value instanceof Date) {
      assert.ok(back instanceof Date, String(value));
      assert.equal(back.getTime(), value.getTime(), `${value.toISOString()} ${numFmt}`);
      assert.notEqual(back, value, 'a copy, not the cell\'s own object');
    } else assert.equal(back, value, String(value));
  }
});

test('coerceInput: only the editor\'s own text is an identity; typed input keeps the strict rules', () => {
  // a different date cell: 1899 and 2-digit years are still not typeable dates
  assert.equal(coerceInput('30/12/1899', { value: new Date(0) }), '30/12/1899');
  assert.equal(coerceInput('30/12/1899', { value: utc(2026, 2, 12), numFmt: 'dd/mm/yyyy' }), '30/12/1899');
  assert.equal(coerceInput('30/12/1899', { value: null, numFmt: 'dd/mm/yyyy' }), '30/12/1899');
  // typed numbers follow the number regex
  assert.equal(coerceInput('0.0000005', { value: null }), 5e-7);
  assert.equal(coerceInput('0.0000005', { value: 7 }), 5e-7);
  assert.equal(coerceInput('1000000000000000000000', { value: 7 }), '1000000000000000000000');
  assert.equal(coerceInput('1234567890123460', { value: 7 }), '1234567890123460');
  assert.equal(coerceInput('1234567890123460', { value: null }), '1234567890123460');
  assert.equal(coerceInput('5e-7', { value: 5e-7 }), '5e-7');
  // changing the offered text changes the value
  assert.equal(coerceInput('0.000001', { value: 5e-7 }), 1e-6);
  assert.deepEqual(coerceInput('13/03/2026', { value: utc(2026, 2, 12), numFmt: 'dd/mm/yyyy' }), utc(2026, 2, 13));
  // a text-format cell is still text, even if the text matches
  assert.equal(coerceInput('12/03/2026', { value: utc(2026, 2, 12), numFmt: '@' }), '12/03/2026');
  assert.equal(coerceInput('5', { value: 5, numFmt: '@' }), '5');
});

// ---- coerceInput ----------------------------------------------------------

test('coerceInput: numbers need a plain, lossless decimal', () => {
  assert.equal(coerceInput('0', { value: null }), 0);
  assert.equal(coerceInput('3.14', { value: null }), 3.14);
  assert.equal(coerceInput('123456789012345', { value: null }), 123456789012345);
  assert.ok(Object.is(coerceInput('-0', { value: null }), 0), '-0 is stored as 0');
  for (const s of ['.5', '5.', '+5', '1_000', '0x10', 'NaN', 'Infinity', '- 5', '5 ', '--5', '0.30000000000000004', '123456789012345.6', '3.14159265358979323846']) assert.equal(coerceInput(s, { value: null }), s, s);
});

test('coerceInput: text cells stay text, whatever the typing looks like', () => {
  assert.equal(coerceInput('007', { value: 'old' }), '007');
  assert.equal(coerceInput('1', { value: 'x', numFmt: '0.00' }), '1');
  assert.equal(coerceInput('12/03/2026', { value: 'old', numFmt: 'dd/mm/yyyy' }), '12/03/2026');
  assert.equal(coerceInput('true', { value: 'old' }), 'true');
  assert.equal(coerceInput('42', { value: { richText: [{ text: 'a' }] } }), '42');
  assert.equal(coerceInput('42', { value: 5, numFmt: '@' }), '42');
  assert.equal(coerceInput('12/03/2026', { value: new Date(0), numFmt: '@' }), '12/03/2026');
});

test('coerceInput: blanks clear the cell, even a link', () => {
  assert.equal(coerceInput('', { value: 'x' }), null);
  assert.equal(coerceInput('', { value: new Date(0) }), null);
  assert.equal(coerceInput('', { value: { text: 'a', hyperlink: 'https://x' } }), null);
  assert.equal(coerceInput('', {}), null);
});

test('coerceInput: booleans only for boolean cells, any case', () => {
  assert.equal(coerceInput('TRUE', { value: false }), true);
  assert.equal(coerceInput('False', { value: true }), false);
  assert.equal(coerceInput('yes', { value: true }), 'yes');
  assert.equal(coerceInput('TRUE', { value: 1 }), 'TRUE');
  assert.equal(coerceInput('FALSE', { value: undefined }), 'FALSE');
});

test('coerceInput: hyperlink keeps target and tooltip, text is always text', () => {
  assert.deepEqual(coerceInput('42', { value: { text: 'Old', hyperlink: 'https://x', tooltip: 'tip' } }), { text: '42', hyperlink: 'https://x', tooltip: 'tip' });
  assert.deepEqual(coerceInput('New', { value: { text: { richText: [{ text: 'Old' }] }, hyperlink: 'https://x' } }), { text: 'New', hyperlink: 'https://x' });
});

test('coerceInput: dd/mm/yyyy with 1 or 2 digit day and month', () => {
  const dateCell = { value: new Date(0) };
  assert.deepEqual(coerceInput('1/3/2026', dateCell), utc(2026, 2, 1));
  assert.deepEqual(coerceInput('01/03/2026', dateCell), utc(2026, 2, 1));
  assert.deepEqual(coerceInput('31/12/2026', dateCell), utc(2026, 11, 31));
  assert.deepEqual(coerceInput('29/02/2028', dateCell), utc(2028, 1, 29));
});

test('coerceInput: a date can carry a time', () => {
  const dateCell = { value: new Date(0) };
  assert.deepEqual(coerceInput('1/3/2026 9:05', dateCell), utc(2026, 2, 1, 9, 5));
  assert.deepEqual(coerceInput('12/03/2026 09:05', dateCell), utc(2026, 2, 12, 9, 5));
  assert.deepEqual(coerceInput('12/03/2026 09:05:07', dateCell), utc(2026, 2, 12, 9, 5, 7));
  assert.deepEqual(coerceInput('12/03/2026 23:59', dateCell), utc(2026, 2, 12, 23, 59));
});

test('coerceInput: yyyy-mm-dd is accepted too', () => {
  assert.deepEqual(coerceInput('2026-03-12', { value: new Date(0) }), utc(2026, 2, 12));
  assert.deepEqual(coerceInput('2026-03-12 09:05', { value: new Date(0) }), utc(2026, 2, 12, 9, 5));
});

test('coerceInput: a date format alone makes a blank cell a date cell', () => {
  assert.deepEqual(coerceInput('12/03/2026', { value: null, numFmt: 'dd/mm/yyyy' }), utc(2026, 2, 12));
  assert.deepEqual(coerceInput('12/03/2026', { value: undefined, numFmt: 'mm-dd-yy' }), utc(2026, 2, 12));
  assert.equal(coerceInput('12/03/2026', { value: null, numFmt: '0.00' }), '12/03/2026');
  assert.equal(coerceInput('12/03/2026', { value: 5, numFmt: 'General' }), '12/03/2026');
});

test('coerceInput: impossible dates and short years stay text', () => {
  const dateCell = { value: new Date(0) };
  for (const s of ['31/02/2026', '29/02/2027', '00/03/2026', '12/00/2026', '12/13/2026', '32/01/2026', '12/03/26', '12/03/202', '12-03-2026', '2026-02-30', '2026-13-01', '12/03/2026 24:00', '12/03/2026 09:60', '12/03/2026 9:5', '12/03/2026  09:05', '12/03/1899', ' 12/03/2026']) assert.equal(coerceInput(s, dateCell), s, s);
});

test('coerceInput: a number typed into a date cell is a number', () => {
  assert.equal(coerceInput('46000', { value: new Date(0) }), 46000);
});

test('coerceInput: time-only cells take a time and keep their date part', () => {
  const t = utc(1899, 11, 30, 9, 5);
  assert.deepEqual(coerceInput('10:30', { value: t, numFmt: 'h:mm' }), utc(1899, 11, 30, 10, 30));
  assert.deepEqual(coerceInput('9:05:07', { value: t, numFmt: 'hh:mm:ss' }), utc(1899, 11, 30, 9, 5, 7));
  assert.deepEqual(coerceInput('10:30', { value: null, numFmt: 'h:mm' }), utc(1899, 11, 30, 10, 30));
  assert.deepEqual(coerceInput('10:30', { value: utc(1904, 0, 1, 9, 0), numFmt: 'h:mm' }), utc(1904, 0, 1, 10, 30));
  assert.equal(coerceInput('25:00', { value: t, numFmt: 'h:mm' }), '25:00');
  assert.equal(coerceInput('10:30', { value: utc(2026, 2, 12), numFmt: 'dd/mm/yyyy' }), '10:30');
  assert.equal(coerceInput('10:30', { value: null }), '10:30');
});

test('coerceInput: a formula or error value never throws', () => {
  assert.equal(coerceInput('5', { value: { formula: 'A1', result: 1 } }), 5);
  assert.equal(coerceInput('abc', { value: { formula: 'A1', result: 1 } }), 'abc');
  assert.equal(coerceInput('5', { value: { error: '#N/A' } }), 5);
  assert.equal(coerceInput('5', { value: { sharedFormula: 'A1', result: undefined } }), 5);
  assert.equal(coerceInput('5'), 5);
});

test('coerceInput: formulas are text, never run', () => {
  assert.equal(coerceInput('=SUM(A1:A2)', { value: 5 }), '=SUM(A1:A2)');
  assert.equal(coerceInput('=1+1', { value: null, numFmt: '0.00' }), '=1+1');
});
