'use strict';
// File names and bodies for captured thoughts. Pure: no file system, no server state.
// A capture is `<inbox>/YYYY-MM-DD HHMM <first words>.md` in the vault's time zone, holding the stamp, a blank
// line and the text. Names avoid what Obsidian or Windows refuse, so the file syncs everywhere.
const { zonedDate, zonedTime } = require('./today-note');

const NAME_MAX = 60;
const STAMP_LEN = 'YYYY-MM-DD HHMM '.length;
// eslint-disable-next-line no-control-regex
const BANNED = /[\/\\:*?"<>|#^\[\]\u0000-\u001f\u007f]/g;

function cleanName(text, max = NAME_MAX) {
  let s = String(text || '').split(/\r?\n/)[0].replace(BANNED, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = s[max] === ' ' ? max : cut.lastIndexOf(' ');
    s = sp > 0 ? cut.slice(0, sp) : cut;
  }
  return s.replace(/[. ]+$/, '');
}

function captureBase(text, date, tz) {
  const stamp = `${zonedDate(date, tz)} ${zonedTime(date, tz).replace(':', '')}`;
  const words = cleanName(text, NAME_MAX - STAMP_LEN);
  return words ? `${stamp} ${words}` : stamp;
}

function uniqueName(base, taken) {
  if (!taken(`${base}.md`)) return `${base}.md`;
  for (let n = 2; ; n++) if (!taken(`${base} ${n}.md`)) return `${base} ${n}.md`;
}

function captureBody(text, date, tz) {
  return `${zonedDate(date, tz)} ${zonedTime(date, tz)}\n\n${String(text).replace(/\s+$/, '')}\n`;
}

module.exports = { NAME_MAX, cleanName, captureBase, uniqueName, captureBody };
