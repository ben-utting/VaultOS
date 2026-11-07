'use strict';

// ========================================================================
// Cell values <-> text, for the spreadsheet viewer/editor.
//
//   displayText(value, numFmt)  what the grid shows
//   editText(value, numFmt)     what the cell editor starts with
//   coerceInput(text, cell)     what a typed string becomes in the real file
//   isDateFmt(numFmt)           does this number format mean "date / time"?
//
// Values are ExcelJS 4.4.0's `cell.value` shapes: null, number, string,
// boolean, Date, { formula | sharedFormula, result }, { richText },
// { text, hyperlink, tooltip? } and { error }. A Date's UTC fields ARE the
// wall-clock value ExcelJS read (it converts the serial with no zone), so
// every date read or built here uses getUTC* / Date.UTC and the machine's
// time zone never matters.
//
// coerceInput is the one that can silently change someone's data, so it is
// deliberately conservative: text stays text unless it is unmistakably a
// number (or a date, in a cell that already holds dates). A ticket id like
// 007 or a 16-digit reference never becomes a number.
//
// The number-format reader is a small subset of Excel's, on purpose. Whatever
// it can't read with confidence is shown as General.
// ========================================================================

const GENERAL_DIGITS = 15;   // Excel keeps 15 significant digits

// ---- number formats: tokenising -----------------------------------------

// Split a format string into tokens:
//   { t: 'q', v }  quoted or backslash-escaped literal text
//   { t: 'b', v }  the inside of a [bracket]
//   { t: 'c', v }  any other single character
// `_x` (a spacer) and `*x` (a fill) carry no text, so they vanish.
function tokenize(fmt) {
  const s = String(fmt);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      const j = s.indexOf('"', i + 1), end = j < 0 ? s.length : j;
      out.push({ t: 'q', v: s.slice(i + 1, end) });
      i = end;
    } else if (ch === '[') {
      const j = s.indexOf(']', i + 1), end = j < 0 ? s.length : j;
      out.push({ t: 'b', v: s.slice(i + 1, end) });
      i = end;
    } else if (ch === '\\') {
      out.push({ t: 'q', v: s[i + 1] || '' });
      i++;
    } else if (ch === '_' || ch === '*') {
      i++;
    } else {
      out.push({ t: 'c', v: ch });
    }
  }
  return out;
}

const ELAPSED = /^(?:h+|m+|s+)$/i;   // [h] [mm] [ss]: elapsed-time brackets keep their letter

// The format's date/time letters, lower-cased, with everything quoted, escaped
// or bracketed (colours, locales, currency) taken out.
function dateLetters(fmt) {
  let out = '';
  for (const k of tokenize(fmt)) {
    if (k.t === 'c' || (k.t === 'b' && ELAPSED.test(k.v))) out += k.v.toLowerCase();
  }
  return out;
}

function isDateFmt(numFmt) {
  if (typeof numFmt !== 'string' || numFmt === '') return false;
  const l = dateLetters(numFmt);
  return /[dy]/.test(l) || (l.includes('m') && /[hs]/.test(l));
}

// ---- number formats: numbers --------------------------------------------

const general = (n) => String(Number(n.toPrecision(GENERAL_DIGITS)));

// General, but never in exponent notation (5e-7 -> 0.0000005, 1e21 -> 1 followed
// by 21 zeros): the editor must offer text a person can read and retype.
function plainDecimal(n) {
  const s = general(n);
  if (!s.includes('e')) return s;
  const [mant, exp] = (s[0] === '-' ? s.slice(1) : s).split('e');
  const [ip, fp = ''] = mant.split('.');
  const digits = ip + fp, point = ip.length + Number(exp);   // `point` digits sit left of the decimal point
  let out;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  return (s[0] === '-' ? '-' : '') + out;
}

// Currency symbols and the plain punctuation Excel lets through unquoted.
const LITERAL_CHARS = new Set(['$', '£', '€', '¥', '-', '+', '/', '(', ')', ':', '!', '^', '&', '\'', '~', '{', '}', '<', '>', '=', ' ']);
const COLOUR = /^(?:black|white|red|green|blue|yellow|magenta|cyan|color\s*\d+)$/i;

// One section of a format ("#,##0.00", "(#,##0)", "0%" ...) -> how to print a
// non-negative number, or null if it isn't a shape we read.
function parseSection(tokens) {
  let prefix = '', suffix = '', pattern = '', percent = 0;
  for (const k of tokens) {
    let lit = null;
    if (k.t === 'q') lit = k.v;
    else if (k.t === 'b') {
      if (k.v[0] === '$') lit = k.v.slice(1).split('-')[0];   // [$£-809] -> £ ; [$-409] -> nothing
      else if (COLOUR.test(k.v)) lit = '';
      else return null;                                       // [>100] conditions, [h] elapsed time ...
    } else if ('0#,.'.includes(k.v)) {
      if (suffix) return null;                                // digits again after the suffix: not a shape we read
      pattern += k.v;
      continue;
    } else if (k.v === '%') {
      percent++;
      lit = '%';
    } else if (LITERAL_CHARS.has(k.v)) lit = k.v;
    else return null;                                         // E+, ?, @, letters ...

    if (pattern) suffix += lit;
    else prefix += lit;
  }
  if (percent > 1) return null;
  if (!pattern) return { prefix, suffix, digits: false };

  const dot = pattern.indexOf('.');
  if (dot !== pattern.lastIndexOf('.')) return null;
  const intPart = dot < 0 ? pattern : pattern.slice(0, dot);
  const decPart = dot < 0 ? '' : pattern.slice(dot + 1);
  if (decPart.includes(',') || intPart.endsWith(',')) return null;   // a trailing comma scales by 1000: not read
  const intDigits = intPart.replace(/,/g, '');
  if (!intDigits && !decPart) return null;
  return {
    prefix, suffix, digits: true, percent: percent === 1,
    thousands: intPart.includes(','),
    minInt: intDigits.split('0').length - 1,
    minDec: decPart.split('0').length - 1,
    maxDec: decPart.length,
  };
}

// "pos;neg;zero;text" -> the first three sections, each parsed or null (a
// section we don't read is only a problem if a number lands in it). Null for
// the whole format = General. A [>100]-style condition changes which section a
// number picks, which isn't modelled, so any condition means General.
const fmtCache = new Map();
function parseNumFmt(numFmt) {
  if (typeof numFmt !== 'string') return null;
  if (fmtCache.has(numFmt)) return fmtCache.get(numFmt);
  let result = null;
  if (numFmt.trim() !== '' && numFmt.trim().toLowerCase() !== 'general') {
    const sections = [[]];
    let conditional = false;
    for (const k of tokenize(numFmt)) {
      if (k.t === 'c' && k.v === ';') sections.push([]);
      else {
        if (k.t === 'b' && /^[<>=]/.test(k.v)) conditional = true;
        sections[sections.length - 1].push(k);
      }
    }
    if (!conditional && sections.length <= 4) result = sections.slice(0, 3).map(parseSection);
  }
  if (fmtCache.size > 500) fmtCache.clear();
  fmtCache.set(numFmt, result);
  return result;
}

// x >= 0 rounded half away from zero to `dec` places, as digit strings.
// Works from the 15-significant-digit value (what Excel does), so 1.005 -> 1.01.
function fixed(x, dec) {
  if (!(x < 1e15)) return null;
  const [mant, exp] = Number(x.toPrecision(GENERAL_DIGITS)).toExponential().split('e');
  const scaled = Math.round(Number(`${mant}e${Number(exp) + dec}`));
  if (!Number.isSafeInteger(scaled)) return null;
  const digits = String(scaled).padStart(dec + 1, '0');
  return { int: digits.slice(0, digits.length - dec), frac: digits.slice(digits.length - dec) };
}

function printSection(sec, x) {
  if (!sec.digits) return sec.prefix + sec.suffix;
  const f = fixed(sec.percent ? x * 100 : x, sec.maxDec);
  if (!f) return null;
  let frac = f.frac;
  while (frac.length > sec.minDec && frac.endsWith('0')) frac = frac.slice(0, -1);
  let int = f.int.replace(/^0+/, '').padStart(sec.minInt, '0');
  if (sec.thousands) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sec.prefix + int + (frac ? '.' + frac : '') + sec.suffix;
}

function formatNumber(n, numFmt) {
  if (!Number.isFinite(n)) return String(n);
  const secs = parseNumFmt(numFmt);
  if (!secs) return general(n);
  let sec = secs[0], sign = '', x = Math.abs(n);
  if (n < 0 && secs.length >= 2) sec = secs[1];          // a negative section prints the absolute value itself
  else if (n === 0 && secs.length >= 3) sec = secs[2];
  else if (n < 0) sign = '-';
  const out = sec ? printSection(sec, x) : null;
  return out === null ? general(n) : sign + out;
}

// ---- dates ----------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// Wall-clock fields of a Date, to the nearest second: ExcelJS rounds the serial
// to the millisecond, which can leave 09:05 as 09:04:59.999.
function wallClock(date) {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  const d = new Date(Math.round(ms / 1000) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function dateInfo(numFmt) {
  const l = typeof numFmt === 'string' ? dateLetters(numFmt) : '';
  const hasDate = /[dy]/.test(l), hasTime = /[hs]/.test(l);
  const first = l.match(/[dmy]/);
  return { hasTime, hasSec: l.includes('s'), timeOnly: !hasDate && hasTime, iso: !!first && first[0] === 'y' };
}

const dmy = (w) => `${pad2(w.d)}/${pad2(w.mo)}/${String(w.y).padStart(4, '0')}`;
const isoDay = (w) => `${String(w.y).padStart(4, '0')}-${pad2(w.mo)}-${pad2(w.d)}`;
const hms = (w, withSec) => `${pad2(w.h)}:${pad2(w.mi)}${withSec ? ':' + pad2(w.s) : ''}`;

function formatDate(date, numFmt) {
  const w = wallClock(date);
  if (!w) return '';
  const i = dateInfo(numFmt);
  if (i.timeOnly) return hms(w, i.hasSec);
  const day = i.iso ? isoDay(w) : dmy(w);
  return i.hasTime ? `${day} ${hms(w, i.hasSec)}` : day;
}

// Always dd/mm/yyyy (what coerceInput reads back); the time is kept whenever
// the cell has one, so a no-op edit can't drop it.
function formatDateEdit(date, numFmt) {
  const w = wallClock(date);
  if (!w) return '';
  const i = dateInfo(numFmt);
  if (i.timeOnly) return hms(w, i.hasSec || w.s !== 0);
  const time = i.hasTime || w.h || w.mi || w.s;
  return time ? `${dmy(w)} ${hms(w, i.hasSec || w.s !== 0)}` : dmy(w);
}

// ---- display / edit text ----------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !(v instanceof Date);
const isLink = (v) => isObject(v) && typeof v.hyperlink === 'string' && v.hyperlink !== '';
const isRich = (v) => isObject(v) && Array.isArray(v.richText);

function displayText(value, numFmt) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatNumber(value, numFmt);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return formatDate(value, numFmt);
  if (isObject(value)) {
    if ('formula' in value || 'sharedFormula' in value) return displayText(value.result, numFmt);
    if (typeof value.error === 'string') return value.error;
    if (isRich(value)) return value.richText.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
    if ('hyperlink' in value) return displayText(value.text, numFmt);
  }
  return '';
}

function editText(value, numFmt) {
  if (typeof value === 'number') return Number.isFinite(value) ? plainDecimal(value) : String(value);
  if (value instanceof Date) return formatDateEdit(value, numFmt);
  return displayText(value, numFmt);
}

// ---- typed input -> value ---------------------------------------------------

const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const MIN_YEAR = 1900;   // Excel has no dates before it

// A real calendar date and time as a UTC Date, or null (31/02/2026 is not one).
function utcDate(y, mo, d, h, mi, s) {
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

function parseDate(s, value, numFmt) {
  let m = DMY.exec(s);
  if (m) return utcDate(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = YMD.exec(s);
  if (m) return utcDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = TIME.exec(s);
  if (m && dateInfo(numFmt).timeOnly) {
    const [h, mi, sec] = [+m[1], +m[2], +(m[3] || 0)];
    if (h > 23 || mi > 59 || sec > 59) return null;
    // a time-only cell keeps the date part it has (1899-12-30, or 1904-01-01 in a 1904 workbook)
    const base = value instanceof Date && !Number.isNaN(value.getTime())
      ? Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
      : Date.UTC(1899, 11, 30);
    return new Date(base + ((h * 60 + mi) * 60 + sec) * 1000);
  }
  return null;
}

// A plain decimal that survives being a double (15 significant digits), or null.
function parseNumber(s) {
  if (!NUMBER.test(s)) return null;
  const n = Number(s);
  if (Number(n.toPrecision(GENERAL_DIGITS)) !== n) return null;   // 0.30000000000000004, 3.14159265358979323846
  return n === 0 ? 0 : n;                                           // no negative zero
}

function coerceInput(text, { value, numFmt } = {}) {
  const s = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  if (s === '') return null;
  if (isLink(value)) {
    const out = { text: s, hyperlink: value.hyperlink };
    if (value.tooltip !== undefined) out.tooltip = value.tooltip;
    return out;
  }
  if (numFmt === '@') return s;
  // Exactly the text the editor offered: a no-op edit hands back the very value (a
  // 1899 date, 5e-7, a 16-digit number, a Date's milliseconds), whatever the typing rules below say.
  if (value instanceof Date && editText(value, numFmt) === s) return new Date(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value) && editText(value, numFmt) === s) return value;
  if (typeof value === 'string' || isRich(value)) return s;       // text cells stay text (ticket ids, codes)
  if (value instanceof Date || isDateFmt(numFmt)) {
    const date = parseDate(s, value, numFmt);
    if (date) return date;
  }
  const n = parseNumber(s);
  if (n !== null) return n;
  if (typeof value === 'boolean' && /^(?:true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

module.exports = { displayText, editText, isDateFmt, coerceInput };
