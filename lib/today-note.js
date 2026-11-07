'use strict';
// Pure helpers behind Today mode: calendar dates in a chosen timezone and habits.md parsing. No server state.
// The container runs on UTC, so every date/time here goes through Intl with an explicit timezone.

// One formatter per zone, built on first use.
const fmts = new Map();
function partsIn(d, timeZone) {
  let f = fmts.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmts.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

const zonedDate = (d, timeZone) => { const p = partsIn(d, timeZone); return `${p.year}-${p.month}-${p.day}`; };
const zonedTime = (d, timeZone) => { const p = partsIn(d, timeZone); return `${p.hour}:${p.minute}`; };
const londonDate = (d) => zonedDate(d, 'Europe/London');
const londonTime = (d) => zonedTime(d, 'Europe/London');

function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

// Calendar arithmetic on the date alone, done in UTC so no DST hour can shift it.
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayShort = (iso) => DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

const ICONS = ['sun', 'dumbbell', 'tree', 'rocket', 'pill', 'book', 'cap', 'coffee-off', 'heart', 'moon', 'droplet', 'pen', 'music', 'walk', 'check'];

const DEFAULT_HABITS_MD = `# Habits

Add habits from the Today page, or edit the table here. Keep the id when you rename a habit, or its history won't line up.

| id | Habit | Icon | Focus goal (min) |
| --- | --- | --- | --- |
`;

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line) => cells(line).every((c) => /^:?-{3,}:?$/.test(c));

// First run of |-rows that has a --- separator row; the rows after it are habits (id, name, icon, goal).
// Bad rows are skipped with a warning. An unknown icon is kept as written (the UI draws a dot).
function parseHabits(md) {
  const lines = String(md).split(/\r?\n/);
  let rows = null;
  for (let i = 0; i < lines.length && !rows; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const run = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) run.push(lines[i++]);
    const sep = run.findIndex(isSeparator);
    if (sep >= 0) rows = run.slice(sep + 1);
  }
  if (!rows) return { habits: [], warnings: ['No habit table found in habits.md'] };

  const habits = [];
  const warnings = [];
  const seen = new Set();   // every id seen so far, kept or not
  rows.forEach((line, i) => {
    const [id = '', name = '', icon = '', goalRaw = ''] = cells(line);
    const row = `Row ${i + 1}`;
    const dup = seen.has(id);
    seen.add(id);
    if (!/^[a-z0-9-]{1,32}$/.test(id)) { warnings.push(`${row}: id "${id}" must be lowercase letters, digits or dashes`); return; }
    if (dup) { warnings.push(`${row}: id "${id}" is used more than once`); return; }
    let goal = null;
    if (goalRaw !== '') {
      goal = /^\d+$/.test(goalRaw) ? Number(goalRaw) : NaN;
      if (!(goal >= 5 && goal <= 600)) { warnings.push(`${row}: focus goal "${goalRaw}" must be empty or a whole number from 5 to 600`); return; }
    }
    habits.push({ id, name: name || id, icon, goal });
  });
  return { habits, warnings };
}

// ---------- Habit editing ----------
// Add, edit and remove rows of the habit table from the app. Like the day notes, only the row in question
// changes: text around the table, other rows and the file's line endings stay as written.
const TABLE_HEAD = ['| id | Habit | Icon | Focus goal (min) |', '| --- | --- | --- | --- |'];

// The habit table as { sep, end }: the separator row's index and the index after the last row, or null.
function habitTable(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const start = i;
    while (i < lines.length && lines[i].trim().startsWith('|')) i++;
    for (let j = start; j < i; j++) if (isSeparator(lines[j])) return { sep: j, end: i };
  }
  return null;
}

// Name, icon and goal as the app sends them, checked and tidied, or a 400.
function habitFields({ name, icon = '', goal = null } = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!n) throw bad('A habit needs a name');
  if (n.length > 60) throw bad('Keep the name to 60 characters');
  if (n.includes('|')) throw bad('The name can\'t contain "|"');
  const ic = icon == null ? '' : String(icon);
  if (ic && !ICONS.includes(ic)) throw bad(`Unknown icon "${ic}"`);
  const g = goal == null || goal === '' ? null : goal;
  if (g !== null && !(Number.isInteger(g) && g >= 5 && g <= 600)) throw bad('The focus goal must be empty or a whole number from 5 to 600');
  return { name: n, icon: ic, goal: g };
}
const habitRow = (id, f) => `| ${[id, f.name, f.icon, f.goal == null ? '' : f.goal].map((c) => (c === '' ? '' : `${c} `)).join('| ')}|`;
const rowId = (line) => cells(line)[0];
function findHabitRow(lines, id) {
  const t = habitTable(lines);
  const i = t ? lines.findIndex((l, k) => k > t.sep && k < t.end && rowId(l) === id) : -1;
  if (i < 0) throw Object.assign(new Error('Unknown habit'), { status: 404 });
  return i;
}

// Returns { md, id }. The id comes from the name ("Read 30m" → read-30m), with -2, -3 … when taken.
function addHabit(md, fields) {
  const f = habitFields(fields);
  const eol = eolOf(md);
  const lines = splitLines(md);
  let t = habitTable(lines);
  if (!t) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', ...TABLE_HEAD, '');
    t = { sep: lines.length - 2, end: lines.length - 1 };
  }
  const taken = new Set(lines.slice(t.sep + 1, t.end).map(rowId));
  const base = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 29).replace(/-+$/, '') || 'habit';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  lines.splice(t.end, 0, habitRow(id, f));
  return { md: lines.join(eol), id };
}
function updateHabit(md, id, fields) {
  const f = habitFields(fields);
  const lines = splitLines(md);
  lines[findHabitRow(lines, id)] = habitRow(id, f);
  return lines.join(eolOf(md));
}
function removeHabit(md, id) {
  const lines = splitLines(md);
  lines.splice(findHabitRow(lines, id), 1);
  return lines.join(eolOf(md));
}

// ---------- Day notes ----------
// A day note is edited in place: split into lines, change only the lines we own, join with the
// file's own line ending. Anything not recognised stays as written.
const splitLines = (md) => String(md).split(/\r?\n/);
const eolOf = (md) => (String(md).includes('\r\n') ? '\r\n' : '\n');
const isFence = (l) => /^\s*```/.test(l);

// Frontmatter span as { open, close } line indexes, or null.
function frontmatter(lines) {
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  return close < 0 ? null : { open: 0, close };
}

// `## <heading>` section as { start, end }: start is the heading line, end the first line after the
// section, which is the next `#` or `##` heading (an H1 of the user's ends it too; `###` stays inside).
// Fence-aware, so headings inside code blocks are ignored.
function findSection(lines, heading) {
  const fm = frontmatter(lines);
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  let start = -1;
  let inFence = false;
  for (let i = fm ? fm.close + 1 : 0; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && re.test(lines[i].trim())) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// Lines of a section body as [index, text] pairs, outside code fences.
function sectionLines(lines, heading) {
  const sec = findSection(lines, heading);
  const out = [];
  if (!sec) return out;
  let inFence = false;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (!inFence) out.push([i, lines[i]]);
  }
  return out;
}

// Puts one owned line into a section: after the last owned line (`last`, an index) and any indented lines
// under it; with none yet, under the heading, after one blank line when the user's text follows it, and with a
// blank line before that text so Obsidian doesn't read it as part of the new list item.
function insertLine(lines, sec, last, item) {
  if (last != null) {
    let at = last + 1;
    while (at < sec.end && /^[ \t]+\S/.test(lines[at])) at++;
    lines.splice(at, 0, item);
    return;
  }
  let at = sec.start + 1;
  if (at < sec.end && lines[at].trim() === '' && lines.slice(at, sec.end).some((l) => l.trim() !== '')) at++;
  lines.splice(at, 0, item, ...(at < sec.end && lines[at].trim() !== '' ? [''] : []));
}

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
const fmField = (lines, key) => {
  const fm = frontmatter(lines);
  if (!fm) return null;
  for (let i = fm.open + 1; i < fm.close; i++) {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`).exec(lines[i]);
    if (m) return { index: i, value: m[1] };
  }
  return null;
};
const parseList = (v) => {
  const m = /^\[(.*)\]\s*$/.exec(v.trim());
  return m ? m[1].split(',').map(unquote).filter(Boolean) : [];
};

// The `habits:` entry as an owned block: the key line plus any list items under it. Reads the
// inline `[a, b]`, Obsidian's block list (`  - a`) and a bare comma list.
function habitsField(lines) {
  const f = fmField(lines, 'habits');
  if (!f) return null;
  const fm = frontmatter(lines);
  const v = f.value.trim();
  if (v !== '') return { index: f.index, len: 1, ids: /^\[/.test(v) ? parseList(v) : v.split(',').map(unquote).filter(Boolean) };
  const ids = [];
  let len = 1;
  for (let i = f.index + 1; i < fm.close; i++) {
    const m = /^\s*-\s+(.*)$/.exec(lines[i]);
    if (!m) break;
    const id = unquote(m[1]);
    if (id) ids.push(id);
    len++;
  }
  return { index: f.index, len, ids };
}

const FOCUS_RE = /^- (\d\d:\d\d) (\d+)m (.+)$/;   // a `## Focus` line: time, minutes, target

function parseDay(md) {
  const lines = splitLines(md);
  const date = fmField(lines, 'date');
  const habits = habitsField(lines);

  const q = sectionLines(lines, 'Quote').filter(([, l]) => l.startsWith('>')).map(([, l]) => l.replace(/^>\s?/, '').trim());
  let quote = null;
  if (q.length) quote = { text: q[0], by: q[1] ? q[1].replace(/^—\s*/, '') : '' };

  const tasks = [];
  for (const [, l] of sectionLines(lines, 'Tasks')) {
    const m = /^[-*]\s+\[([ xX>])\]\s+(.*)$/.exec(l);
    if (!m) continue;
    const f = / \(from (\d{4}-\d{2}-\d{2})\)\s*$/.exec(m[2]);
    tasks.push({
      index: tasks.length,
      text: (f ? m[2].slice(0, f.index) : m[2]).trim(),
      done: m[1] === 'x' || m[1] === 'X',
      moved: m[1] === '>',
      from: f ? f[1] : null,
    });
  }

  const focus = [];
  for (const [, l] of sectionLines(lines, 'Focus')) {
    const m = FOCUS_RE.exec(l);
    if (m) focus.push({ time: m[1], min: Number(m[2]), target: m[3] });
  }

  return { date: date ? unquote(date.value) || null : null, done: habits ? habits.ids : [], quote, tasks, focus };
}

// Only the `habits:` line changes. Ids listed in `order` come first in that order; unknown ids
// already present stay at the end. A tick that changes nothing returns the note untouched.
function setHabit(md, id, on, order) {
  const lines = splitLines(md);
  const eol = eolOf(md);
  const field = habitsField(lines);
  const current = field ? field.ids : [];
  if (current.includes(id) === !!on) return md;
  const next = new Set(current);
  if (on) next.add(id); else next.delete(id);
  const ids = [...order.filter((h) => next.has(h)), ...[...next].filter((h) => !order.includes(h))];
  const line = `habits: [${ids.join(', ')}]`;
  if (field) lines.splice(field.index, field.len, line);
  else {
    const fm = frontmatter(lines);
    if (fm) lines.splice(fm.close, 0, line);
    else lines.unshift('---', line, '---', '');
  }
  return lines.join(eol);
}

// Line breaks inside a quote fold to spaces so it can't end the blockquote or inject lines.
const fold = (v) => String(v).replace(/\s*\r?\n\s*/g, ' ').trim();
const quoteLines = ({ text, by }) => [`> ${fold(text)}`, `> — ${fold(by)}`];

// Only the quote's own lines change: the first run of `>` lines in `## Quote` (after any blank lines), or,
// when there is none, two new lines under the heading. Anything the user wrote around it stays.
function setQuote(md, quote) {
  const lines = splitLines(md);
  const eol = eolOf(md);
  const sec = findSection(lines, 'Quote');
  if (sec) {
    let at = sec.start + 1;
    while (at < sec.end && lines[at].trim() === '') at++;
    let n = 0;
    while (at + n < sec.end && lines[at + n].startsWith('>')) n++;
    if (n) lines.splice(at, n, ...quoteLines(quote));
    else {
      // Prose straight under the heading would read as part of the blockquote, so a blank line goes between.
      const next = lines[sec.start + 1];
      const gap = sec.start + 1 < sec.end && next.trim() !== '' ? [''] : [];
      lines.splice(sec.start + 1, 0, ...quoteLines(quote), ...gap);
    }
  } else {
    const fm = frontmatter(lines);
    let at = fm ? fm.close + 1 : 0;
    const block = ['## Quote', ...quoteLines(quote), ''];
    if (fm && lines[at] !== undefined && lines[at].trim() === '') at++;
    else if (fm) block.unshift('');
    lines.splice(at, 0, ...block);
  }
  return lines.join(eol);
}

function newDay(date, { carried = [], quote = null } = {}) {
  let md = `---\ndate: ${date}\nhabits: []\n---\n\n`;
  if (quote) md += `## Quote\n${quoteLines(quote).join('\n')}\n\n`;
  md += `## Tasks\n${carried.map((l) => `${l}\n`).join('')}\n## Focus\n\n`;
  return md;
}

// ---------- Focus log ----------
const focusLine = ({ time, min, target }) => `- ${time} ${min}m ${String(target).replace(/^task:\s*/, 'task: ').replace(/^board:\s*/, 'board: ').replace(/\s*[\r\n]+\s*/g, ' ')}`;

// Adds one line to `## Focus` (created at the end when missing), after the section's last focus line.
function appendFocus(md, entry) {
  const lines = splitLines(md);
  const eol = eolOf(md);
  const item = focusLine(entry);
  const sec = findSection(lines, 'Focus');
  if (!sec) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '## Focus', item, '');
  } else {
    const own = sectionLines(lines, 'Focus').filter(([, l]) => FOCUS_RE.test(l));
    insertLine(lines, sec, own.length ? own[own.length - 1][0] : null, item);
  }
  return lines.join(eol);
}

// ---------- Task edits ----------
const CHANGED = 'This day changed since you loaded it. Refreshed.';
const noteError = (status, message) => Object.assign(new Error(message), { status });
const TASK_RE = /^([-*]\s+\[)([ xX>])(\]\s+)(.*)$/;
const FROM_RE = / \(from (\d{4}-\d{2}-\d{2})\)\s*$/;

function cleanTaskText(s) {
  const t = String(s == null ? '' : s).replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 200).trim();
  if (!t) throw noteError(400, 'Task text is required');
  return t;
}

// Task lines as { line, m } in document order; same rules as parseDay.
function taskLines(lines) {
  const out = [];
  for (const [i, l] of sectionLines(lines, 'Tasks')) {
    const m = TASK_RE.exec(l);
    if (m) out.push({ line: i, m });
  }
  return out;
}
const plainText = (body) => { const f = FROM_RE.exec(body); return (f ? body.slice(0, f.index) : body).trim(); };

function addTask(md, text) {
  const lines = splitLines(md);
  const eol = eolOf(md);
  const item = `- [ ] ${cleanTaskText(text)}`;
  const sec = findSection(lines, 'Tasks');
  if (!sec) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '## Tasks', item, '');
  } else {
    const own = taskLines(lines);
    insertLine(lines, sec, own.length ? own[own.length - 1].line : null, item);
  }
  return lines.join(eol);
}

function findTask(lines, index, expectText) {
  const t = taskLines(lines)[index];
  if (!t || plainText(t.m[4]) !== String(expectText == null ? '' : expectText).trim()) throw noteError(409, CHANGED);
  return t;
}

function toggleTask(md, index, expectText) {
  const lines = splitLines(md);
  const t = findTask(lines, index, expectText);
  if (t.m[2] === '>') throw noteError(400, 'A moved task cannot be ticked');
  const done = t.m[2] === ' ';
  lines[t.line] = `${t.m[1]}${done ? 'x' : ' '}${t.m[3]}${t.m[4]}`;
  return lines.join(eolOf(md));
}

function deleteTask(md, index, expectText) {
  const lines = splitLines(md);
  const t = findTask(lines, index, expectText);
  lines.splice(t.line, 1);
  return lines.join(eolOf(md));
}

// Open tasks of the previous note move on: `carried` are the lines for the new note, and in
// prevMd those lines become [>]. Everything else stays byte-identical.
function rollover(prevMd, prevDate) {
  const lines = splitLines(prevMd);
  const carried = [];
  for (const t of taskLines(lines)) {
    if (t.m[2] !== ' ') continue;
    const f = FROM_RE.exec(t.m[4]);
    const text = plainText(t.m[4]);
    if (!text) continue;
    carried.push(`- [ ] ${text} (from ${f ? f[1] : prevDate})`);
    lines[t.line] = `${t.m[1]}>${t.m[3]}${t.m[4]}`;
  }
  return { carried, prevMd: lines.join(eolOf(prevMd)) };
}

// Flip to [>] only the open lines whose plain text matches an entry of `texts`; each entry is
// used once, in order, so duplicates of one text are handled one-for-one. Other lines stay as is.
function markMoved(md, texts) {
  const lines = splitLines(md);
  const left = [...texts];
  for (const t of taskLines(lines)) {
    if (t.m[2] !== ' ') continue;
    const at = left.indexOf(plainText(t.m[4]));
    if (at < 0) continue;
    left.splice(at, 1);
    lines[t.line] = `${t.m[1]}>${t.m[3]}${t.m[4]}`;
  }
  return lines.join(eolOf(md));
}

module.exports = { focusLine, appendFocus, markMoved, cleanTaskText, addTask, toggleTask, deleteTask, rollover, zonedDate, zonedTime, londonDate, londonTime, addDays, isISODate, weekdayShort, ICONS, DEFAULT_HABITS_MD, parseHabits, addHabit, updateHabit, removeHabit, parseDay, setHabit, setQuote, newDay };
