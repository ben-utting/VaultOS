'use strict';
// `vaultos-calendar`: what an agent in a VaultOS terminal runs to read and change the calendar (spec §7).
// It talks to /api/term/calendar/<command> with the terminal's own id and token, like `vaultos-automations`.
// The server holds every rule and is the only judge of an entry; this shapes requests and prints answers.
// main() takes its world as arguments so the tests can run it without a server or a terminal.
const fsp = require('node:fs/promises');
const CC = require('../public/calendar-core');
const { procNames } = require('./automation-cli');

const USAGE = `vaultos-calendar <command> [--json]
  today                              now (date, time, zone), today's entries, what's due
  list [--from D] [--to D] [--search TEXT]   entries by day; default today + 13 days
  show <id>
  add --title T --date D [--time HH:MM] [--end HH:MM] [--all-day]
      [--repeat daily|weekdays|weekly:mon,wed|monthly|yearly] [--until D]
      [--ping none|start|5m|10m|15m|30m|1h|1d] [--card PATH] [--note TEXT]
  add --file <entry.json>            (--file - reads stdin)
  edit <id> [any add flag] | --file <changes.json>   changes the whole series
  skip <id> --date D                 drop one date from a repeat
  delete <id>                        to Recently deleted (30 days)
  deleted                            what's in Recently deleted
  restore <id>
  due                                what's due now
  done <id|key>  dismiss <id|key>  snooze <id|key> --for 10m|1h|tomorrow|Nm|Nh`;

const COMMANDS = ['today', 'list', 'show', 'add', 'edit', 'skip', 'delete', 'deleted', 'restore', 'due', 'done', 'dismiss', 'snooze'];
const NEEDS_ID = ['show', 'edit', 'skip', 'delete', 'restore', 'done', 'dismiss', 'snooze'];
const VALUE_FLAGS = ['title', 'date', 'time', 'end', 'repeat', 'until', 'ping', 'card', 'note', 'file', 'from', 'to', 'search', 'for'];
const ENTRY_FLAGS = ['title', 'date', 'time', 'end', 'all-day', 'repeat', 'until', 'ping', 'card', 'note'];

function parse(argv) {
  const a = { json: false, pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--all-day') a.flags['all-day'] = true;
    else if (x.startsWith('--')) {
      const k = x.slice(2);
      if (!VALUE_FLAGS.includes(k) || argv[i + 1] === undefined) return null;
      a.flags[k] = argv[++i];
    } else a.pos.push(x);
  }
  a.command = a.pos.shift();
  return a;
}

// ---------- Output ----------
const longDate = (d) => {
  if (!CC.isDate(d)) return String(d);
  const [y, m, day] = d.split('-').map(Number);
  return `${CC.DAY_SHORT[CC.weekday(d)]} ${day} ${CC.MONTH_SHORT[m - 1]} ${y}`;
};
const when = (x) => (x.allDay ? 'All day' : `${x.start}${x.end ? `–${x.end}` : ''}`);
const MINUTES = { '5m': '5 min', '10m': '10 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day' };
function pingWords(x) {
  if (!x.ping) return 'no ping';
  if (x.allDay) return x.ping === '1d' ? 'pings at 08:00 the day before' : 'pings at 08:00';
  return x.ping === 'start' ? 'pings at start' : `pings ${MINUTES[x.ping] || x.ping} before`;
}
function cardWords(card) {
  if (!card) return '';
  if (typeof card === 'string') return `card ${card}`;
  return `card ${card.title}${card.exists === false ? ' (not found)' : ''}`;
}
// <id> · <Ddd D Mon YYYY> <HH:MM|All day> · <title>[ · <repeat>] · <ping>[ · card <title>]
function line(id, date, x) {
  const repeat = x.repeatText !== undefined ? x.repeatText : CC.describeRepeat(x);
  return [id, `${longDate(date)} ${when(x)}`, x.title, repeat, pingWords(x), cardWords(x.card)].filter(Boolean).join(' · ');
}
const occLine = (o) => line(o.entryId, o.date, o);
const entryLine = (e) => line(e.id, e.date, e);
function dueLine(i) {
  const parts = [i.key, `${longDate(i.date)} ${i.allDay ? 'All day' : i.start}`, i.title, cardWords(i.card), i.by ? `added by ${i.by}` : ''];
  return parts.filter(Boolean).join(' · ') + (i.missedEarlier ? ` [+${i.missedEarlier} missed earlier]` : '');
}
const whoText = (w) => (w && w.kind === 'agent' ? w.agent || 'an agent' : 'the person');
function showText(e) {
  const lines = [entryLine(e)];
  if (e.note) lines.push(`Note: ${e.note}`);
  if (e.skip && e.skip.length) lines.push(`Skipped: ${e.skip.join(', ')}`);
  if (e.created) lines.push(`Added by ${whoText(e.created.by)} · ${e.created.at}`);
  if (e.updated && e.created && e.updated.at !== e.created.at) lines.push(`Changed by ${whoText(e.updated.by)} · ${e.updated.at}`);
  return lines.join('\n');
}
function todayText(b) {
  const n = b.now;
  const lines = [`Now: ${longDate(n.date)} ${n.time} ${n.timezone}`, 'Today:'];
  lines.push(...(b.entries.length ? b.entries.map((o) => `  ${occLine(o)}`) : ['  Nothing today.']));
  lines.push('Due:');
  lines.push(...(b.due.length ? b.due.map((i) => `  ${dueLine(i)}`) : ['  Nothing due.']));
  return lines.join('\n');
}

// --title … flags → an entry (add) or the changes (edit: only the flags given).
function entryFrom(f, { edit }) {
  const e = {};
  if ('title' in f) e.title = f.title;
  if ('date' in f) e.date = f.date;
  if ('time' in f) e.start = f.time;
  if ('end' in f) e.end = f.end;
  if (f['all-day']) e.allDay = true;
  else if (!edit || 'time' in f) e.allDay = false;   // a time makes an all-day entry timed again
  if ('repeat' in f) {
    const r = CC.parseRepeatFlag(f.repeat);
    if (r && r.error) return { error: r.error };
    e.repeat = r === null ? null : { ...r, ...('until' in f ? { until: f.until } : {}) };
    if (r === null && 'until' in f) return { error: '--until needs a repeat' };
  } else if ('until' in f && !edit) return { error: '--until goes with --repeat' };
  if ('ping' in f) e.ping = f.ping === 'none' ? null : f.ping;
  if ('card' in f) e.card = f.card === 'none' ? null : f.card;
  if ('note' in f) e.note = f.note;
  return { entry: e };
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const doFetch = deps.fetch || fetch;
  const readFile = deps.readFile || ((p) => (p === '-' ? readStdin() : fsp.readFile(p, 'utf8')));
  const names = deps.procNames || procNames;
  const say = (s) => out.write(`${s}\n`);
  const usage = (why) => { err.write(`${why ? `${why}\n\n` : ''}${USAGE}\n`); return 2; };

  const a = parse(argv);
  if (a && a.help) { say(USAGE); return 0; }
  if (!a || !a.command || !COMMANDS.includes(a.command)) return usage();
  const f = a.flags;
  const id = a.pos[0];
  if (NEEDS_ID.includes(a.command) && !id) return usage();
  if (a.command === 'skip' && !f.date) return usage('skip needs --date');
  if (a.command === 'snooze' && !f.for) return usage('snooze needs --for');
  let built = null;
  if ((a.command === 'add' || a.command === 'edit') && !f.file) {
    if (a.command === 'edit' && !ENTRY_FLAGS.some((k) => k in f)) return usage('edit needs a flag to change, or --file');
    built = entryFrom(f, { edit: a.command === 'edit' });
    if (built.error) return usage(built.error);
  }
  if (!env.VAULTOS_HOOK_URL || !env.VAULTOS_TERM_ID || !env.VAULTOS_TERM_TOKEN) { err.write('Run this in a VaultOS terminal.\n'); return 2; }

  let file = null;
  if (f.file && (a.command === 'add' || a.command === 'edit')) {
    let text;
    try { text = await readFile(f.file); } catch (e) { err.write(`Couldn't read ${f.file}: ${e.message}\n`); return 2; }
    try { file = JSON.parse(text); } catch (e) { err.write(`Couldn't read ${f.file} as JSON: ${e.message}\n`); return 2; }
  }
  const hint = names();
  // One request; returns the body, or an exit code after printing why.
  async function ask(command, args = {}) {
    let res;
    try {
      res = await doFetch(new URL(`/api/term/calendar/${command}`, env.VAULTOS_HOOK_URL).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: env.VAULTOS_TERM_ID, token: env.VAULTOS_TERM_TOKEN, args, agentHint: hint }),
      });
    } catch { err.write("VaultOS isn't answering.\n"); return { code: 3 }; }
    let body = {};
    try { body = await res.json(); } catch { /* not json */ }
    if (res.status === 200) return { body };
    if (res.status === 403 && body.error === 'Forbidden') { err.write("This terminal's VaultOS session has ended; open a new terminal.\n"); return { code: 2 }; }
    const lines = [body.error || `VaultOS said ${res.status}`];
    for (const [k, v] of Object.entries(body.errors || {})) lines.push(`  ${k}: ${v}`);
    err.write(`${lines.join('\n')}\n`);
    return { code: 1 };
  }
  const print = (r, text) => { if (!r.body) return r.code; say(a.json ? JSON.stringify(r.body, null, 2) : text(r.body)); return 0; };

  switch (a.command) {
    case 'today': return print(await ask('today'), todayText);
    case 'list': {
      const args = {};
      for (const k of ['from', 'to', 'search']) if (k in f) args[k] = f[k];
      return print(await ask('list', args), (b) => (b.days.length
        ? b.days.flatMap((d) => d.occurrences.map(occLine)).join('\n')
        : `Nothing from ${longDate(b.from)} to ${longDate(b.to)}.`));
    }
    case 'show': return print(await ask('show', { id }), (b) => showText(b.entry));
    case 'add': return print(await ask('add', { entry: file || built.entry }), (b) => `Added: ${entryLine(b.entry)}`);
    case 'edit': {
      let changes = file || built.entry;
      // --until on its own changes the end of the repeat the entry already has.
      if (!file && 'until' in f && !('repeat' in f)) {
        const shown = await ask('show', { id });
        if (!shown.body) return shown.code;
        const r = shown.body.entry.repeat;
        if (!r) return usage("This entry doesn't repeat; give --repeat with --until.");
        changes = { ...changes, repeat: { ...r, until: f.until } };
      }
      return print(await ask('edit', { id, changes }), (b) => `Changed: ${entryLine(b.entry)}`);
    }
    case 'skip': return print(await ask('skip', { id, date: f.date }), (b) => `Skipped ${f.date}: ${entryLine(b.entry)}`);
    case 'delete':
      return print(await ask('delete', { id }), (b) => `Deleted ${b.entry.id} (${b.entry.title}). It stays in Recently deleted for 30 days; vaultos-calendar restore ${b.entry.id} brings it back.`);
    case 'deleted':
      return print(await ask('deleted'), (b) => (b.entries.length
        ? b.entries.map((e) => `${e.id} · ${e.title} · deleted ${longDate(String(e.deletedAt).slice(0, 10))} by ${whoText(e.deletedBy)}`).join('\n')
        : 'Recently deleted is empty.'));
    case 'restore': return print(await ask('restore', { id }), (b) => `Restored: ${entryLine(b.entry)}`);
    case 'due': return print(await ask('due'), (b) => (b.items.length ? b.items.map(dueLine).join('\n') : 'Nothing due.'));
    case 'done': return print(await ask('done', { target: id }), () => `Done: ${id}`);
    case 'dismiss': return print(await ask('dismiss', { target: id }), () => `Dismissed: ${id}`);
    case 'snooze': return print(await ask('snooze', { target: id, for: f.for }), (b) => `Snoozed: ${id} until ${b.until}`);
    default: return usage();
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

module.exports = { main, USAGE };
