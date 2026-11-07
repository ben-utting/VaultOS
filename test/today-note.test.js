'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedDate, zonedTime, DEFAULT_HABITS_MD, londonDate, londonTime, addDays, isISODate, weekdayShort, parseHabits, parseDay, setHabit, setQuote, newDay, addHabit, updateHabit, removeHabit } = require('../lib/today-note');
const { LEGACY_HABITS_MD } = require('./today-fixtures');

test('londonDate crosses midnight in BST and GMT', () => {
  assert.equal(londonDate(new Date('2026-10-11T23:30:00Z')), '2026-10-12'); // BST
  assert.equal(londonDate(new Date('2026-12-11T23:30:00Z')), '2026-12-11'); // GMT
  assert.equal(londonTime(new Date('2026-10-25T00:30:00Z')), '01:30');      // BST ends 01:00 UTC that day
});
test('addDays and isISODate', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(isISODate('2026-02-29'), false);
  assert.equal(isISODate('2026-10-11'), true);
  assert.equal(weekdayShort('2026-10-11'), 'Sun');
});
test('parseHabits reads the default file', () => {
  const { habits, warnings } = parseHabits(LEGACY_HABITS_MD);
  assert.deepEqual(habits.map((h) => h.id), ['wake', 'gym', 'outside', 'business', 'vitamins', 'read', 'learn', 'nocoffee']);
  assert.deepEqual(habits.find((h) => h.id === 'read'), { id: 'read', name: 'Read 30m', icon: 'book', goal: 30 });
  assert.equal(habits.find((h) => h.id === 'wake').goal, null);
  assert.deepEqual(warnings, []);
});
test('parseHabits skips bad rows with warnings', () => {
  const md = '| id | Habit | Icon | Focus goal (min) |\n|---|---|---|---|\n| Bad Id | X | sun | |\n| ok | Fine | nope | 3 |\n| ok | Again | sun | |\n| fine | Fine | sun | 45 |\n';
  const { habits, warnings } = parseHabits(md);
  assert.deepEqual(habits.map((h) => h.id), ['fine']);
  assert.equal(warnings.length, 3);              // bad id, goal 3 out of range, duplicate id
  assert.equal(habits[0].icon, 'sun');
});
test('parseHabits: missing table', () => {
  assert.deepEqual(parseHabits('# Habits\n\nnothing here\n'), { habits: [], warnings: ['No habit table found in habits.md'] });
});

const NOTE = '---\ndate: 2026-10-11\nhabits: [wake, gym]\n---\n\n## Quote\n> Be one.\n> — Marcus Aurelius\n\n## Tasks\n- [x] Food shop\n- [ ] Dentist (from 2026-10-09)\n- [>] Old thing\n```\n- [ ] not a task\n```\n\n## Focus\n- 06:05 25m read\n- 07:20 25m task: Dentist\n\nmy own note\n';
test('parseDay reads every part', () => {
  const d = parseDay(NOTE);
  assert.equal(d.date, '2026-10-11');
  assert.deepEqual(d.done, ['wake', 'gym']);
  assert.deepEqual(d.quote, { text: 'Be one.', by: 'Marcus Aurelius' });
  assert.deepEqual(d.tasks.map((t) => [t.index, t.text, t.done, t.moved, t.from]),
    [[0, 'Food shop', true, false, null], [1, 'Dentist', false, false, '2026-10-09'], [2, 'Old thing', false, true, null]]);
  assert.deepEqual(d.focus, [{ time: '06:05', min: 25, target: 'read' }, { time: '07:20', min: 25, target: 'task: Dentist' }]);
});
test('parseDay tolerates CRLF and * bullets', () => {
  const d = parseDay(NOTE.replace(/\n/g, '\r\n').replace('- [x] Food shop', '* [x] Food shop'));
  assert.equal(d.tasks[0].text, 'Food shop');
  assert.deepEqual(d.done, ['wake', 'gym']);
});
test('setHabit is idempotent and keeps habits.md order', () => {
  const order = ['wake', 'gym', 'outside', 'read'];
  let md = setHabit(NOTE, 'read', true, order);
  md = setHabit(md, 'outside', true, order);
  assert.match(md, /^habits: \[wake, gym, outside, read\]$/m);
  assert.equal(setHabit(md, 'read', true, order), md);
  assert.match(setHabit(setHabit(setHabit(setHabit(md, 'wake', false, order), 'gym', false, order), 'outside', false, order), 'read', false, order), /^habits: \[\]$/m);
});
test('edits preserve unknown lines', () => {
  const md = setQuote(setHabit(NOTE, 'read', true, ['wake', 'gym', 'read']), { text: 'New', by: 'Someone' });
  assert.ok(md.endsWith('my own note\n'));
  assert.equal(md.split('\n').filter((l) => l.startsWith('> ')).length, 2);
  assert.deepEqual(parseDay(md).quote, { text: 'New', by: 'Someone' });
});
test('setQuote inserts after frontmatter when missing; newDay layout', () => {
  const fresh = newDay('2026-10-12', { carried: ['- [ ] Dentist (from 2026-10-09)'] });
  assert.equal(fresh, '---\ndate: 2026-10-12\nhabits: []\n---\n\n## Tasks\n- [ ] Dentist (from 2026-10-09)\n\n## Focus\n\n');
  assert.match(setQuote(fresh, { text: 'Q', by: 'A' }), /^---\n[\s\S]*?\n---\n\n## Quote\n> Q\n> — A\n\n## Tasks/);
});
test('edits keep CRLF and unknown habit ids; newDay with quote', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const md = setHabit(setQuote(crlf, { text: 'N', by: 'B' }), 'read', true, ['wake', 'read']);
  assert.ok(!/[^\r]\n/.test(md));
  assert.match(md, /^habits: \[wake, read, gym\]\r$/m);
  assert.equal(newDay('2026-10-12', { quote: { text: 'Q', by: 'A' } }), '---\ndate: 2026-10-12\nhabits: []\n---\n\n## Quote\n> Q\n> — A\n\n## Tasks\n\n## Focus\n\n');
});

test('block-list habits are read and rewritten inline', () => {
  const block = NOTE.replace('habits: [wake, gym]', 'habits:\n  - wake\n  - "gym"\ntags: [x]');
  assert.deepEqual(parseDay(block).done, ['wake', 'gym']);
  const md = setHabit(block, 'read', true, ['wake', 'gym', 'outside', 'read']);
  assert.equal(md, NOTE.replace('habits: [wake, gym]', 'habits: [wake, gym, read]\ntags: [x]'));
  assert.ok(!/^\s+- /m.test(md.split('\n---')[0]));
});
test('comma-form habits are parsed and rewritten inline', () => {
  const comma = NOTE.replace('habits: [wake, gym]', 'habits: wake, gym');
  assert.deepEqual(parseDay(comma).done, ['wake', 'gym']);
  assert.equal(setHabit(comma, 'read', true, ['wake', 'gym', 'read']), NOTE.replace('[wake, gym]', '[wake, gym, read]'));
});
test('setQuote folds line breaks', () => {
  const md = setQuote(NOTE, { text: 'a\n## Evil', by: 'x\ny' });
  assert.ok(md.includes('\n> a ## Evil\n> — x y\n'));
  const d = parseDay(md);
  assert.deepEqual(d.quote, { text: 'a ## Evil', by: 'x y' });
  assert.equal(d.tasks.length, 3);
  assert.equal(d.focus.length, 2);
  assert.ok(newDay('2026-10-12', { quote: { text: 'a\nb', by: 'c' } }).includes('> a b\n> — c\n'));
});

test('toggle 409 on text mismatch; [>] cannot toggle', () => {
  const { toggleTask } = require('../lib/today-note');
  assert.throws(() => toggleTask(NOTE, 1, 'Something else'), (e) => e.status === 409 && e.message === 'This day changed since you loaded it. Refreshed.');
  assert.throws(() => toggleTask(NOTE, 2, 'Old thing'), (e) => e.status === 400);
  assert.match(toggleTask(NOTE, 1, 'Dentist'), /^- \[x\] Dentist \(from 2026-10-09\)$/m);
});
test('rollover keeps the first from-date and marks the source', () => {
  const { rollover } = require('../lib/today-note');
  const { carried, prevMd } = rollover(NOTE, '2026-10-11');
  assert.deepEqual(carried, ['- [ ] Dentist (from 2026-10-09)']);
  assert.match(prevMd, /^- \[>\] Dentist \(from 2026-10-09\)$/m);
  assert.match(prevMd, /^- \[x\] Food shop$/m);
});
test('cleanTaskText', () => {
  const { cleanTaskText } = require('../lib/today-note');
  assert.equal(cleanTaskText('  a\nb  '), 'a b');
  assert.equal(cleanTaskText('x'.repeat(300)).length, 200);
  assert.throws(() => cleanTaskText('   '), (e) => e.status === 400);
});
test('addTask appends to Tasks, deleteTask removes, CRLF kept', () => {
  const { addTask, deleteTask } = require('../lib/today-note');
  const added = addTask(NOTE, 'New one');
  assert.deepEqual(parseDay(added).tasks.map((t) => t.text), ['Food shop', 'Dentist', 'Old thing', 'New one']);
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const out = deleteTask(addTask(crlf, 'Z'), 0, 'Food shop');
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
  assert.deepEqual(parseDay(out).tasks.map((t) => t.text), ['Dentist', 'Old thing', 'Z']);
  assert.throws(() => deleteTask(NOTE, 0, 'nope'), (e) => e.status === 409);
  assert.equal(addTask('---\ndate: 2026-10-11\n---\n', 'A').includes('## Tasks'), true);
});

test('markMoved flips only the carried open lines, one-for-one', () => {
  const { markMoved } = require('../lib/today-note');
  const md = '## Tasks\n- [ ] A\n- [ ] A\n- [ ] Late add\n- [ ] B (from 2026-10-01)\n- [x] A\n';
  const out = markMoved(md, ['A', 'B']);
  assert.equal(out, '## Tasks\n- [>] A\n- [ ] A\n- [ ] Late add\n- [>] B (from 2026-10-01)\n- [x] A\n');
});

// ---------- Hand-written lines survive ----------
// The user writes in these notes in other editors too. Each edit below is checked against the whole note, so any line other
// than the ones the edit owns showing up changed is a failure.
const DAY = (quote) => `---\ndate: 2026-10-11\nhabits: [wake]\n---\n\n## Quote\n${quote}\n## Tasks\n- [ ] A\n\n## Focus\n- 06:00 25m read\n\nend note\n`;
test('setQuote replaces only the > lines and keeps prose under ## Quote', () => {
  const before = DAY('> Old words.\n> — Someone\n\nMy reflection on this quote.\n');
  const after = setQuote(before, { text: 'New', by: 'Who' });
  assert.equal(after, DAY('> New\n> — Who\n\nMy reflection on this quote.\n'));
  // Blank lines before the quote stay where they are; CRLF is kept.
  const spaced = DAY('\n> Old words.\n> — Someone\nMy reflection.\n').replace(/\n/g, '\r\n');
  assert.equal(setQuote(spaced, { text: 'New', by: 'Who' }), DAY('\n> New\n> — Who\nMy reflection.\n').replace(/\n/g, '\r\n'));
});
test('setQuote with prose but no > lines puts the quote right under the heading', () => {
  const before = DAY('\nMy reflection on this quote.\n');
  assert.equal(setQuote(before, { text: 'New', by: 'Who' }), DAY('> New\n> — Who\n\nMy reflection on this quote.\n'));
  // Prose straight under the heading gets a blank line after the quote, so Obsidian doesn't fold it into the blockquote.
  const tight = DAY('My reflection.\n');
  assert.equal(setQuote(tight, { text: 'New', by: 'Who' }), DAY('> New\n> — Who\n\nMy reflection.\n'));
  // An empty section is filled as before.
  assert.equal(setQuote(DAY(''), { text: 'New', by: 'Who' }), DAY('> New\n> — Who\n'));
});

// A section ends at the next # or ## heading, so checkboxes and focus-like lines under the user's own H1 are theirs.
const JOURNAL = '---\ndate: 2026-10-10\nhabits: []\n---\n\n## Focus\n- 06:00 25m read\n\n# Morning\n- 07:00 25m read\n\n## Tasks\n- [ ] Real\n- [x] Done\n\n# Notes\n- [ ] packing list\nSome thoughts.\n';
test('lines under a later # heading are not tasks or focus, and are never carried or marked', () => {
  const { rollover, markMoved } = require('../lib/today-note');
  const d = parseDay(JOURNAL);
  assert.deepEqual(d.tasks.map((t) => t.text), ['Real', 'Done']);
  assert.deepEqual(d.focus, [{ time: '06:00', min: 25, target: 'read' }]);
  const { carried, prevMd } = rollover(JOURNAL, '2026-10-10');
  assert.deepEqual(carried, ['- [ ] Real (from 2026-10-10)']);
  assert.equal(prevMd, JOURNAL.replace('- [ ] Real', '- [>] Real'));
  assert.equal(markMoved(JOURNAL, ['Real', 'packing list']), JOURNAL.replace('- [ ] Real', '- [>] Real'));
});
test('addTask goes after the last task line, and leaves prose in ## Tasks where it is', () => {
  const { addTask } = require('../lib/today-note');
  const tasks = (body) => `---\ndate: 2026-10-11\nhabits: []\n---\n\n## Tasks\n${body}\n## Focus\n- 06:00 25m read\n\n# Journal\nText\n`;
  // After the last task and the indented lines that belong to it.
  assert.equal(addTask(tasks('- [ ] A\n- [x] B\n  - a note on B\n\nSome paragraph about tasks.\n'), 'C'),
    tasks('- [ ] A\n- [x] B\n  - a note on B\n- [ ] C\n\nSome paragraph about tasks.\n'));
  // No task yet: under the heading, after one blank line, with a blank line kept before the prose.
  assert.equal(addTask(tasks('\nPlan: keep it light.\n'), 'C'), tasks('\n- [ ] C\n\nPlan: keep it light.\n'));
  // A fresh note's empty section keeps its layout.
  assert.equal(addTask(newDay('2026-10-12'), 'C'), '---\ndate: 2026-10-12\nhabits: []\n---\n\n## Tasks\n- [ ] C\n\n## Focus\n\n');
  // A missing section is still created at the end of the file.
  assert.equal(addTask('---\ndate: 2026-10-11\n---\n\n# Journal\nText\n', 'C'), '---\ndate: 2026-10-11\n---\n\n# Journal\nText\n\n## Tasks\n- [ ] C\n');
});
test('appendFocus goes after the last focus line, and leaves prose and a later # heading where they are', () => {
  const { appendFocus } = require('../lib/today-note');
  const e = { time: '07:00', min: 25, target: 'gym' };
  assert.equal(appendFocus(JOURNAL, e), JOURNAL.replace('- 06:00 25m read\n', '- 06:00 25m read\n- 07:00 25m gym\n'));
  assert.equal(appendFocus(NOTE, e), NOTE.replace('- 07:20 25m task: Dentist\n', '- 07:20 25m task: Dentist\n- 07:00 25m gym\n'));
  const empty = '## Focus\n\nNothing logged, but a note.\n';
  assert.equal(appendFocus(empty, e), '## Focus\n\n- 07:00 25m gym\n\nNothing logged, but a note.\n');
  assert.equal(appendFocus(newDay('2026-10-12'), e), '---\ndate: 2026-10-12\nhabits: []\n---\n\n## Tasks\n\n## Focus\n- 07:00 25m gym\n\n');
  assert.equal(appendFocus('# Journal\nText\n', e), '# Journal\nText\n\n## Focus\n- 07:00 25m gym\n');
});
test('zonedDate across midnight', () => {
  const d = new Date('2026-07-01T23:30:00Z');
  assert.equal(zonedDate(d, 'Europe/London'), '2026-07-02');
  assert.equal(zonedDate(d, 'America/New_York'), '2026-07-01');
  assert.equal(zonedTime(d, 'Europe/London'), '00:30');
});
test('a new habits.md starts empty, with no warnings', () => {
  const { habits, warnings } = parseHabits(DEFAULT_HABITS_MD);
  assert.deepEqual(habits, []);
  assert.deepEqual(warnings, []);
});

// ---------- Habit editing ----------
test('addHabit appends a row with an id made from the name', () => {
  let r = addHabit(DEFAULT_HABITS_MD, { name: 'Read 30m', icon: 'book', goal: 30 });
  assert.equal(r.id, 'read-30m');
  r = addHabit(r.md, { name: 'Read 30m!', icon: '', goal: null });
  assert.equal(r.id, 'read-30m-2');
  assert.deepEqual(parseHabits(r.md).habits, [
    { id: 'read-30m', name: 'Read 30m', icon: 'book', goal: 30 },
    { id: 'read-30m-2', name: 'Read 30m!', icon: '', goal: null },
  ]);
  assert.ok(r.md.startsWith('# Habits'));
});
test('addHabit keeps the text around the table and the file\'s line endings', () => {
  const md = 'Intro\r\n\r\n| id | Habit | Icon | Focus goal (min) |\r\n| --- | --- | --- | --- |\r\n| a | A | sun | |\r\n\r\nNotes after\r\n';
  const { md: out } = addHabit(md, { name: 'B', icon: 'moon' });
  assert.equal(out, 'Intro\r\n\r\n| id | Habit | Icon | Focus goal (min) |\r\n| --- | --- | --- | --- |\r\n| a | A | sun | |\r\n| b | B | moon | |\r\n\r\nNotes after\r\n');
});
test('addHabit on a file with no table adds one', () => {
  const { md, id } = addHabit('# My habits\n', { name: 'Walk', icon: 'walk' });
  assert.equal(id, 'walk');
  assert.deepEqual(parseHabits(md).habits.map((h) => h.id), ['walk']);
  assert.ok(md.startsWith('# My habits\n'));
});
test('addHabit falls back to "habit" when the name has no letters or digits', () => {
  assert.equal(addHabit(DEFAULT_HABITS_MD, { name: '🙂' }).id, 'habit');
});
test('habit fields are checked', () => {
  const bad = (f, re) => assert.throws(() => addHabit(DEFAULT_HABITS_MD, f), re);
  bad({ name: '  ' }, /name/i);
  bad({ name: 'x'.repeat(61) }, /name/i);
  bad({ name: 'a | b' }, /\|/);
  bad({ name: 'ok', icon: 'nope' }, /icon/i);
  bad({ name: 'ok', goal: 4 }, /goal/i);
  bad({ name: 'ok', goal: 601 }, /goal/i);
  bad({ name: 'ok', goal: 2.5 }, /goal/i);
  assert.equal(addHabit(DEFAULT_HABITS_MD, { name: ' line\nbreak ' }).md.includes('| line break |'), true);
});
test('updateHabit rewrites only that row and keeps the id', () => {
  const md = LEGACY_HABITS_MD;
  const out = updateHabit(md, 'read', { name: 'Read 20m', icon: 'moon', goal: 20 });
  const { habits } = parseHabits(out);
  assert.deepEqual(habits.find((h) => h.id === 'read'), { id: 'read', name: 'Read 20m', icon: 'moon', goal: 20 });
  assert.deepEqual(habits.map((h) => h.id), parseHabits(md).habits.map((h) => h.id));
  assert.equal(out.split('\n').filter((l, i) => l !== md.split('\n')[i]).length, 1);
  assert.throws(() => updateHabit(md, 'nope', { name: 'X' }), (e) => e.status === 404);
});
test('removeHabit drops the row and nothing else', () => {
  const out = removeHabit(LEGACY_HABITS_MD, 'gym');
  assert.deepEqual(parseHabits(out).habits.map((h) => h.id), ['wake', 'outside', 'business', 'vitamins', 'read', 'learn', 'nocoffee']);
  assert.equal(out.split('\n').length, LEGACY_HABITS_MD.split('\n').length - 1);
  assert.throws(() => removeHabit(LEGACY_HABITS_MD, 'nope'), (e) => e.status === 404);
});
