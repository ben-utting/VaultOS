'use strict';
// Learn mode's names on disk: notebook folders, saved transcripts and Studio images. The vault sits on a Windows
// share (CIFS), so Windows rules apply: no / \ : * ? " < > |, no control characters, no trailing dot or space, no
// device names (CON, NUL, COM1…). A leading dot hides a file from Files; a leading _ marks a folder VaultOS skips.
const fsp = require('node:fs/promises');

class LearnError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ILLEGAL = /[\\/:*?"<>|]/;
const ILLEGAL_ALL = /[\\/:*?"<>|]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const NOTEBOOK_MAX = 60;

function checkNotebookName(raw) {
  if (typeof raw !== 'string') throw new LearnError(400, 'Give the notebook a name.');
  const name = raw.trim();
  if (!name) throw new LearnError(400, 'Give the notebook a name.');
  if (name.length > NOTEBOOK_MAX) throw new LearnError(400, `A notebook name can be at most ${NOTEBOOK_MAX} characters.`);
  if (CONTROL.test(name)) throw new LearnError(400, 'A notebook name can\'t contain tabs or other control characters.');
  if (ILLEGAL.test(name)) throw new LearnError(400, 'A notebook name can\'t contain / \\ : * ? " < > |');
  if (/^[._]/.test(name)) throw new LearnError(400, 'A notebook name can\'t start with . or _');
  if (/\.$/.test(name)) throw new LearnError(400, 'A notebook name can\'t end with a dot.');
  if (DEVICE.test(name)) throw new LearnError(400, `"${name}" is a name Windows keeps for itself. Pick another.`);
  return name;
}

// Cut to at most `max` UTF-16 units without splitting a surrogate pair (an emoji).
function cut(s, max) {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const tidyEnds = (s) => s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

function safeTitle(raw, { max, fallback }) {
  let t = String(raw == null ? '' : raw).replace(ILLEGAL_ALL, ' ').replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ');
  t = tidyEnds(t);
  t = tidyEnds(cut(t, max));
  if (!t) return fallback;
  if (DEVICE.test(t)) t = tidyEnds(cut(`${t} video`, max));
  return t || fallback;
}

// A file name in dirAbs that isn't taken, ignoring case: base + ext, else "base (2)" + ext, "base (3)"…
async function uniqueName(dirAbs, base, ext) {
  let names = [];
  try { names = await fsp.readdir(dirAbs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const taken = new Set(names.map((n) => n.toLowerCase()));
  if (!taken.has(`${base}${ext}`.toLowerCase())) return `${base}${ext}`;
  for (let n = 2; ; n++) {
    const name = `${base} (${n})${ext}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// The date and time of `date` in time zone `tz`, for file names: { day: 'YYYY-MM-DD', time: 'HHMM' }.
function stamp(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}` };
}

module.exports = { LearnError, checkNotebookName, safeTitle, uniqueName, stamp };
