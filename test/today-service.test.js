'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToday } = require('../lib/today-service');
const N = require('../lib/today-note');
const { LEGACY_HABITS_MD } = require('./today-fixtures');

function mk(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-'));
  const q = { next: opts.today ?? null, today: async () => q.next, random: async () => q.next };
  const base = opts.now || new Date('2026-10-11T07:00:00Z');
  const now = typeof base === 'function' ? base : () => base;
  if (opts.legacy) fs.writeFileSync(path.join(dir, 'habits.md'), LEGACY_HABITS_MD);   // the old wake/gym rows
  return { dir, quotes: q, svc: createToday({ dir, now, quotes: q, timers: opts.timers, secondsPerMinute: opts.spm, timeZone: opts.timeZone }) };
}
const notePath = (t, date) => path.join(t.dir, 'days', date.slice(0, 7), `${date}.md`);
function seedNote(t, date, { quote, done = [], tasks = [], focus = [] } = {}) {
  let md = N.newDay(date, { carried: tasks, quote: quote || null });
  for (const id of done) md = N.setHabit(md, id, true, done);
  const lines = focus.map((f) => (typeof f === 'string' ? f : `- ${f.time} ${f.min}m ${f.target}`));
  if (lines.length) md = md.replace(/## Focus\n\n$/, `## Focus\n${lines.join('\n')}\n\n`);
  fs.mkdirSync(path.dirname(notePath(t, date)), { recursive: true });
  fs.writeFileSync(notePath(t, date), md);
}
const readNote = (t, date) => fs.readFileSync(notePath(t, date), 'utf8');

test('read path never writes', async () => {
  const t = mk(); const p = await t.svc.payload(undefined, { canWrite: false });
  assert.equal(fs.existsSync(path.join(t.dir, 'habits.md')), false);
  assert.deepEqual(p.habits, []); assert.equal(p.day.exists, false);
  assert.equal(fs.existsSync(path.join(t.dir, 'days')), false);
});
test('first authenticated load seeds habits.md and creates today with the quote', async () => {
  const t = mk({ today: { text: 'Q', by: 'A' } });
  const p = await t.svc.payload(undefined, { canWrite: true });
  assert.equal(fs.readFileSync(path.join(t.dir, 'habits.md'), 'utf8'), N.DEFAULT_HABITS_MD);
  assert.equal(p.today, '2026-10-11'); assert.equal(p.day.exists, true);
  assert.deepEqual(p.day.quote, { text: 'Q', by: 'A', date: '2026-10-11' });
  assert.equal(p.habits.length, 0); assert.equal(p.week.length, 7); assert.equal(p.summary.total, 0);
  assert.equal(p.timer.state, 'idle'); assert.equal(p.timer.phase, 'focus'); assert.equal(p.timer.leftMs, null);
});
test('failed quote falls back to the latest earlier one, then fills in on retry', async () => {
  const t = mk({ today: null }); seedNote(t, '2026-10-09', { quote: { text: 'Old', by: 'B' } });
  let p = await t.svc.payload(undefined, { canWrite: true });
  assert.equal(p.day.quoteFallback, true); assert.equal(p.day.quote.date, '2026-10-09');
  t.quotes.next = { text: 'New', by: 'C' };
  p = await t.svc.payload(undefined, { canWrite: true });
  assert.equal(p.day.quoteFallback, false); assert.equal(p.day.quote.text, 'New');
});
test('setHabit: unknown id 404, past day created, future date 400', async () => {
  const t = mk({ legacy: true }); await t.svc.payload(undefined, { canWrite: true });
  await assert.rejects(t.svc.setHabit('2026-10-11', 'nope', true), (e) => e.status === 404);
  const p = await t.svc.setHabit('2026-10-08', 'gym', true);
  assert.deepEqual(p.day.done, ['gym']); assert.equal(p.date, '2026-10-08');
  await assert.rejects(t.svc.payload('2026-10-12', { canWrite: true }), (e) => e.status === 400);
  await assert.rejects(t.svc.payload('nope'), (e) => e.status === 400);
});
test('concurrent writes to one note both land', async () => {
  const t = mk({ legacy: true }); await t.svc.payload(undefined, { canWrite: true });
  await Promise.all([t.svc.setHabit('2026-10-11', 'wake', true), t.svc.setHabit('2026-10-11', 'gym', true)]);
  assert.deepEqual((await t.svc.payload(undefined, { canWrite: false })).day.done, ['wake', 'gym']);
});
test('writes re-read the file, so a hand edit between calls survives', async () => {
  const t = mk({ legacy: true }); await t.svc.payload(undefined, { canWrite: true });
  await t.svc.payload(undefined, { canWrite: false });   // warm the cache
  fs.appendFileSync(notePath(t, '2026-10-11'), '\nhand note\n');
  await t.svc.setHabit('2026-10-11', 'wake', true);
  assert.match(readNote(t, '2026-10-11'), /hand note/);
});
test('streaks, week, focus labels, task minutes and summary', async () => {
  const t = mk();
  fs.writeFileSync(path.join(t.dir, 'habits.md'), LEGACY_HABITS_MD);
  seedNote(t, '2026-10-09', { done: ['gym'] });
  seedNote(t, '2026-10-10', { done: ['gym', 'read'] });
  seedNote(t, '2026-10-11', {
    done: ['gym', 'gone'], tasks: ['- [ ] Write'],
    focus: [{ time: '08:00', min: 25, target: 'read' }, { time: '09:00', min: 10, target: 'task: Write' }, { time: '10:00', min: 5, target: 'focus' }],
  });
  const p = await t.svc.payload(undefined, { canWrite: false });
  assert.equal(p.streaks.gym, 3); assert.equal(p.streaks.read, 1);
  assert.deepEqual(p.day.focus.map((f) => f.label), ['Read 30m', 'Write', 'Just focus']);
  assert.equal(p.day.tasks[0].min, 10);
  assert.deepEqual(p.focusByHabit, { read: 25 });
  assert.deepEqual(p.summary, { done: 1, total: 8, focusMin: 40 });
  assert.equal(p.week[6].date, '2026-10-11');
  const old = await t.svc.payload('2026-10-01', { canWrite: false });
  assert.equal(old.week[6].date, '2026-10-01'); assert.equal(old.summary.focusMin, 40);
});
test('shuffleQuote needs today note, then replaces the quote', async () => {
  const t = mk({ today: { text: 'A', by: 'B' } });
  await assert.rejects(t.svc.shuffleQuote(), (e) => e.status === 400);
  await t.svc.payload(undefined, { canWrite: true });
  t.quotes.next = { text: 'Z', by: 'Y' };
  const p = await t.svc.shuffleQuote();
  assert.equal(p.day.quote.text, 'Z');
});
test('London date, not UTC, picks today', async () => {
  const t = mk({ now: new Date('2026-06-30T23:30:00Z') });
  const p = await t.svc.payload(undefined, { canWrite: false });
  assert.equal(p.today, '2026-07-01');
});

test('payload after midnight creates the new day with rollover', async () => {
  const t = mk(); seedNote(t, '2026-10-09', { tasks: ['- [ ] Dentist', '- [x] Done thing'] }); // 10-10 skipped
  const p = await t.svc.payload(undefined, { canWrite: true });
  assert.deepEqual(p.day.tasks.map((x) => [x.text, x.from]), [['Dentist', '2026-10-09']]);
  assert.match(readNote(t, '2026-10-09'), /^- \[>\] Dentist$/m);
});
test('add, toggle, delete through the service', async () => {
  const t = mk(); await t.svc.payload(undefined, { canWrite: true });
  let p = await t.svc.task('2026-10-11', { op: 'add', text: 'Renew insurance' });
  p = await t.svc.task('2026-10-11', { op: 'toggle', index: 0, text: 'Renew insurance' });
  assert.equal(p.day.tasks[0].done, true);
  p = await t.svc.task('2026-10-11', { op: 'delete', index: 0, text: 'Renew insurance' });
  assert.equal(p.day.tasks.length, 0);
});
test('task validation and no re-rollover on second load', async () => {
  const t = mk(); seedNote(t, '2026-10-10', { tasks: ['- [ ] A'] });
  await t.svc.payload(undefined, { canWrite: true });
  const p = await t.svc.payload(undefined, { canWrite: true });
  assert.equal(p.day.tasks.length, 1);
  await assert.rejects(t.svc.task('2026-10-11', { op: 'bogus' }), (e) => e.status === 400);
  await assert.rejects(t.svc.task('2026-10-11', { op: 'toggle', index: 0, text: 'B' }), (e) => e.status === 409);
  await assert.rejects(t.svc.task('2099-01-01', { op: 'add', text: 'x' }), (e) => e.status === 400);
});

test('rollover from the previous month folder', async () => {
  const t = mk({ now: new Date('2026-11-01T07:00:00Z') });
  seedNote(t, '2026-10-30', { tasks: ['- [ ] Old (from 2026-10-20)'] });
  const p = await t.svc.payload(undefined, { canWrite: true });
  assert.deepEqual(p.day.tasks.map((x) => [x.text, x.from]), [['Old', '2026-10-20']]);
  assert.match(readNote(t, '2026-10-30'), /^- \[>\] Old \(from 2026-10-20\)$/m);
});
test('a task added to the source mid-rollover stays open there', async () => {
  const t = mk(); seedNote(t, '2026-10-10', { tasks: ['- [ ] A'] });
  let release; const gate = new Promise((r) => { release = r; });
  const src = t.svc.noteFile('2026-10-10');
  const hold = t.svc.edit(src, async (raw) => { await gate; return raw.replace('- [ ] A\n', '- [ ] A\n- [ ] Late\n'); });
  const pay = t.svc.payload(undefined, { canWrite: true });
  for (let i = 0; i < 100 && !fs.existsSync(notePath(t, '2026-10-11')); i++) await new Promise((r) => setTimeout(r, 10));
  release(); await hold; await pay;
  const md = readNote(t, '2026-10-10');
  assert.match(md, /^- \[>\] A$/m); assert.match(md, /^- \[ \] Late$/m);
});

// ---------- Pomodoro ----------
function mkTimer(opts = {}) {
  const armed = { cur: null };
  const timers = { set: (fn, ms) => (armed.cur = { fn, ms }), clear: () => { armed.cur = null; } };
  const clock = { d: opts.now || new Date('2026-10-11T07:00:00Z') };
  const t = mk({ ...opts, now: () => clock.d, timers });
  return Object.assign(t, { armed, clock });
}
const timerFile = (t) => path.join(t.dir, '.timer.json');

test('a session on read crosses the goal and auto-ticks', async () => {
  const t = mkTimer({ legacy: true }); seedNote(t, '2026-10-11', { focus: ['- 06:00 25m read'] });
  await t.svc.payload(undefined, { canWrite: true });
  let p = await t.svc.timer('start', 'read');
  assert.equal(p.timer.state, 'running'); assert.equal(t.armed.cur.ms, 25 * 60 * 1000);
  assert.equal(JSON.parse(fs.readFileSync(timerFile(t), 'utf8')).state, 'running');
  await t.armed.cur.fn();
  assert.match(readNote(t, '2026-10-11'), /- 08:00 25m read\n/);
  p = await t.svc.payload(undefined, { canWrite: false });
  assert.ok(p.day.done.includes('read'));
  assert.equal(p.timer.lastEvent.text, 'Read 30m ticked. 50 of 30 minutes today.');
  assert.equal(p.timer.lastEvent.kind, 'focus-done'); assert.equal(p.timer.lastEvent.id, 1);
  assert.equal(p.timer.phase, 'short'); assert.equal(p.timer.state, 'idle'); assert.equal(p.timer.targetLabel, 'Read 30m');
});
test('unticking sticks', async () => {
  const t = mkTimer({ legacy: true }); seedNote(t, '2026-10-11', { focus: ['- 06:00 25m read'] });
  await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'read'); await t.armed.cur.fn();
  await t.svc.setHabit('2026-10-11', 'read', false);
  await t.svc.timer('skip'); await t.svc.timer('start', 'read'); await t.armed.cur.fn();
  const p = await t.svc.payload(undefined, { canWrite: false });
  assert.ok(!p.day.done.includes('read'));
  assert.equal(p.timer.lastEvent.text, 'Session logged: 25 min on Read 30m.'); assert.equal(p.timer.lastEvent.id, 2);
});
test('a session started 23:50 logs to its start day', async () => {
  const t = mkTimer({ now: new Date('2026-10-11T22:50:00Z') });
  await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'focus');
  t.clock.d = new Date('2026-10-11T23:15:00Z'); await t.armed.cur.fn();
  assert.match(readNote(t, '2026-10-11'), /- 23:50 25m focus\n/);
  assert.equal(fs.existsSync(notePath(t, '2026-10-12')), false);
});
test('break completion says Break over and logs nothing', async () => {
  const t = mkTimer(); await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'focus'); await t.armed.cur.fn();
  await t.svc.timer('start'); await t.armed.cur.fn();
  const p = await t.svc.payload();
  assert.equal(p.timer.lastEvent.text, 'Break over.'); assert.equal(p.timer.lastEvent.kind, 'break-done');
  assert.equal(p.timer.phase, 'focus'); assert.equal(p.day.focus.length, 1);
});
test('boot completes an expired session', async () => {
  const t = mkTimer({ now: new Date('2026-10-11T08:00:00Z') });
  await t.svc.payload(undefined, { canWrite: true });
  const started = Date.parse('2026-10-11T07:00:00Z');
  fs.writeFileSync(timerFile(t), JSON.stringify({ phase: 'focus', state: 'running', target: 'focus', startedAt: started,
    endsAt: started + 25 * 60000, leftMs: null, cycle: 0, cycleDate: '2026-10-11', lastEvent: { id: 7, kind: 'break-done', at: 'x', text: 'Break over.' } }));
  await t.svc.boot();
  assert.match(readNote(t, '2026-10-11'), /- 08:00 25m focus\n/);
  assert.equal((await t.svc.payload()).timer.lastEvent.id, 8);
});
test('boot re-arms a live session', async () => {
  const t = mkTimer(); await t.svc.payload(undefined, { canWrite: true });
  const n = t.clock.d.getTime();
  fs.writeFileSync(timerFile(t), JSON.stringify({ phase: 'focus', state: 'running', target: 'focus', startedAt: n - 900000,
    endsAt: n + 600000, leftMs: null, cycle: 0, cycleDate: '2026-10-11', lastEvent: null }));
  await t.svc.boot();
  assert.equal(t.armed.cur.ms, 600000);
});
test('boot survives corrupt timer json', async () => {
  const t = mkTimer(); fs.writeFileSync(timerFile(t), '{nope');
  await t.svc.boot();
  assert.equal((await t.svc.payload()).timer.state, 'idle');
});
test('bad target 400, open task target accepted, pause then stale completion ignored', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', { tasks: ['- [ ] write report'] });
  await t.svc.payload(undefined, { canWrite: true });
  await assert.rejects(t.svc.timer('start', 'wake'), (e) => e.status === 400);
  await assert.rejects(t.svc.timer('start', 'task:nope'), (e) => e.status === 400);
  await assert.rejects(t.svc.timer('dance'), (e) => e.status === 400);
  await t.svc.timer('start', 'task:write report');
  const stale = t.armed.cur.fn;
  await t.svc.timer('pause'); assert.equal(t.armed.cur, null);
  await stale();
  assert.equal((await t.svc.payload()).timer.state, 'paused');
  assert.equal((await t.svc.payload()).day.focus.length, 0);
  await t.svc.timer('resume'); await t.armed.cur.fn();
  assert.match(readNote(t, '2026-10-11'), /- 08:00 25m task: write report\n/);
});

// Next's Start on a Board task: the target is 'board: <title>', not a line of today's list.
test('board: target starts with its title as the label, and logs as board: <title>', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', { tasks: ['- [ ] write report'] });
  await t.svc.payload(undefined, { canWrite: true });
  const p = await t.svc.timer('start', 'board:   Ship it ');
  assert.equal(p.timer.state, 'running');
  assert.equal(p.timer.target, 'board: Ship it');
  assert.equal(p.timer.targetLabel, 'Ship it');
  await t.armed.cur.fn();
  assert.match(readNote(t, '2026-10-11'), /- 08:00 25m board: Ship it\n/);
  const after = await t.svc.payload();
  assert.equal(after.day.focus[0].label, 'Ship it');
  assert.equal(after.timer.lastEvent.text, 'Session logged: 25 min on Ship it.');
});
test('board: target refused when empty, multi-line or over 200 characters; task: rule unchanged', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', { tasks: ['- [ ] write report'] });
  await t.svc.payload(undefined, { canWrite: true });
  for (const bad of ['board:', 'board:   ', 'board: a\nb', 'board: a\rb', 'board: ' + 'x'.repeat(201), 'task: not in the list']) {
    await assert.rejects(t.svc.timer('start', bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal((await t.svc.payload()).timer.state, 'idle');
  const ok = await t.svc.timer('start', 'board: ' + 'x'.repeat(200));
  assert.equal(ok.timer.targetLabel, 'x'.repeat(200));
});

test('a slow lazy load cannot overwrite state set by boot', async () => {
  const t = mkTimer({ now: new Date('2026-10-11T08:00:00Z') });
  const started = Date.parse('2026-10-11T07:00:00Z');
  const old = { phase: 'focus', state: 'running', target: 'focus', startedAt: started, endsAt: started + 25 * 60000, leftMs: null,
    cycle: 0, cycleDate: '2026-10-11', lastEvent: { id: 7, kind: 'break-done', at: 'x', text: 'Break over.' } };
  fs.writeFileSync(timerFile(t), JSON.stringify(old));
  const fsp = require('node:fs/promises'); const real = fsp.readFile; let release; let held = false;
  fsp.readFile = async function (f, ...a) {
    if (!held && String(f).endsWith('.timer.json')) { held = true; const v = await real.call(this, f, ...a); await new Promise((r) => { release = r; }); return v; }
    return real.call(this, f, ...a);
  };
  try {
    const lazy = t.svc.payload(undefined, { canWrite: false });   // timer read held open
    while (!release) await new Promise((r) => setImmediate(r));
    await t.svc.boot();
    release(); await lazy;
  } finally { fsp.readFile = real; }
  const p = await t.svc.payload();
  assert.equal(p.timer.lastEvent.id, 8); assert.equal(p.timer.state, 'idle');
  await t.svc.timer('skip'); await t.svc.timer('skip');
  assert.equal(JSON.parse(fs.readFileSync(timerFile(t), 'utf8')).lastEvent.id, 8);
  assert.equal((readNote(t, '2026-10-11').match(/08:00 25m focus/g) || []).length, 1);
});
test('finish skips a line already logged before a crash', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', { focus: ['- 08:00 25m focus'] });
  await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'focus'); await t.armed.cur.fn();
  assert.equal((readNote(t, '2026-10-11').match(/08:00 25m focus/g) || []).length, 1);
  assert.equal((await t.svc.payload()).timer.lastEvent.id, 1);
});
test('start without target falls back to focus when the carried target is stale', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', { tasks: ['- [ ] write report'] });
  await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'task:write report'); await t.armed.cur.fn();
  await t.svc.timer('skip');            // back to focus phase, target still the task
  const d = await t.svc.payload(); const idx = d.day.tasks[0].index;
  await t.svc.task('2026-10-11', { op: 'toggle', text: 'write report', index: idx });
  const p = await t.svc.timer('start');
  assert.equal(p.timer.target, 'focus'); assert.equal(p.timer.state, 'running');
});

// ---------- The quote retry stays out of the write queue ----------
// quotes.today() answers the first call only when released; later calls answer null at once (as after a failure).
function heldQuote(t, quote) {
  const h = { calls: 0 };
  const gate = new Promise((r) => { h.release = r; });
  t.quotes.today = async () => (++h.calls === 1 ? (await gate, quote) : null);
  h.started = async () => { while (h.calls < 1) await new Promise((r) => setImmediate(r)); };
  return h;
}
const within = (p, ms) => {
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r('late'), ms); });
  return Promise.race([p.then(() => 'done'), late]).finally(() => clearTimeout(timer));
};
test('a slow quote fetch does not hold up a habit tick on today\'s note', async () => {
  const t = mk(); seedNote(t, '2026-10-11');   // today's note exists, with no quote yet
  fs.writeFileSync(path.join(t.dir, 'habits.md'), LEGACY_HABITS_MD);
  const q = heldQuote(t, { text: 'Late', by: 'Q' });
  const slow = t.svc.payload(undefined, { canWrite: true });
  await q.started();
  const tick = t.svc.setHabit('2026-10-11', 'wake', true);
  assert.equal(await within(tick, 500), 'done');
  assert.match(readNote(t, '2026-10-11'), /^habits: \[wake\]$/m);
  q.release(); await slow;
  const md = readNote(t, '2026-10-11');
  assert.match(md, /^## Quote\n> Late\n> — Q$/m); assert.match(md, /^habits: \[wake\]$/m);
});
test('a quote that arrives late never replaces one written meanwhile', async () => {
  const t = mk(); seedNote(t, '2026-10-11');
  fs.writeFileSync(path.join(t.dir, 'habits.md'), LEGACY_HABITS_MD);
  const q = heldQuote(t, { text: 'Late', by: 'Q' });
  const slow = t.svc.payload(undefined, { canWrite: true });
  await q.started();
  const hand = N.setQuote(readNote(t, '2026-10-11'), { text: 'Mine', by: 'Me' }) + 'hand note\n';
  fs.writeFileSync(notePath(t, '2026-10-11'), hand);   // another device, or a shuffle, got there first
  q.release(); await slow;
  assert.equal(readNote(t, '2026-10-11'), hand);
});
test('payload uses the configured timezone', async () => {
  const t = mk({ timeZone: 'America/New_York', now: new Date('2026-10-12T02:00:00Z') });
  const p = await t.svc.payload(undefined, { canWrite: false });
  assert.equal(p.today, '2026-10-11');
  assert.equal(p.timeZone, 'America/New_York');
});
test('stop cancels a running timer', async () => {
  const t = mkTimer(); seedNote(t, '2026-10-11', {});
  await t.svc.payload(undefined, { canWrite: true });
  await t.svc.timer('start', 'focus');
  assert.ok(t.armed.cur, 'timer armed');
  t.svc.stop();
  assert.equal(t.armed.cur, null);   // the fake clear ran, so no completion can fire
  t.svc.stop();                      // safe twice, and with nothing pending
  assert.equal((await t.svc.payload()).timer.state, 'running');   // saved state is left for the next boot
});

test('habits: add, edit and remove from the app', async () => {
  const t = mk(); await t.svc.payload(undefined, { canWrite: true });
  let p = await t.svc.editHabits('2026-10-11', { op: 'add', name: 'Stretch', icon: 'heart', goal: null });
  assert.deepEqual(p.habits, [{ id: 'stretch', name: 'Stretch', icon: 'heart', goal: null }]);
  p = await t.svc.setHabit('2026-10-11', 'stretch', true);
  assert.deepEqual(p.day.done, ['stretch']);
  p = await t.svc.editHabits('2026-10-11', { op: 'update', id: 'stretch', name: 'Stretch 10m', icon: 'heart', goal: 10 });
  assert.deepEqual(p.habits, [{ id: 'stretch', name: 'Stretch 10m', icon: 'heart', goal: 10 }]);
  assert.deepEqual(p.day.done, ['stretch']);
  p = await t.svc.editHabits('2026-10-11', { op: 'remove', id: 'stretch' });
  assert.deepEqual(p.habits, []);
  await assert.rejects(t.svc.editHabits('2026-10-11', { op: 'remove', id: 'stretch' }), (e) => e.status === 404);
  await assert.rejects(t.svc.editHabits('2026-10-11', { op: 'add', name: '' }), (e) => e.status === 400);
  await assert.rejects(t.svc.editHabits('2026-10-11', { op: 'nope' }), (e) => e.status === 400);
});
test('habits: adding to a vault with no habits.md creates it', async () => {
  const t = mk();
  const p = await t.svc.editHabits('2026-10-11', { op: 'add', name: 'Walk', icon: 'walk' });
  assert.deepEqual(p.habits.map((h) => h.id), ['walk']);
  assert.ok(fs.readFileSync(path.join(t.dir, 'habits.md'), 'utf8').startsWith('# Habits'));
});
