'use strict';
// `vaultos-automations`: what an agent in a VaultOS terminal runs to read, draft, try and review automations
// (spec §4). It talks to /api/term/automations/<command> with the terminal's own id and token, the way
// `vault-search` talks to /api/term/search. The server holds every rule; this only shapes requests and output.
// main() takes its world as arguments so the tests can run it without a server or a terminal.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AC = require('../public/automation-core');

const USAGE = `usage: vaultos-automations <command> [--json]
  options                          what this VaultOS offers: boards, agents and levels, templates, limits
  list                             every automation, on or off, with its last run
  show <id>                        one automation in full
  match <id> | --file <draft.json> the cards it would pick up now
  runs [--automation <id>] [--limit N]
  run <runId>                      one run: each card's note, skips and failures
  create --file <automation.json>  saved switched off; the person switches it on in the Automations tab
  edit <id> --file <changes.json>  agent, level, prompt or cards changes switch it off
  off <id>                         switch one off
  try <id> [--no-wait]             a trial on up to 3 cards; notes stay in the run history
  delete <id>                      only one that is off
  --file - reads JSON from stdin.`;

const POLL_MS = 3000;

// Names of this process's ancestors, nearest first (comm, and the base names of argv[0] and argv[1]), so the
// server can tell which agent is asking. Linux /proc only; anywhere else it's empty.
function procNames(start = process.ppid, max = 12) {
  const out = [];
  let pid = start;
  for (let i = 0; i < max && pid > 1; i++) {
    try {
      out.push(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      out.push(...argv.slice(0, 2).map((a) => path.basename(a)));
      const m = /^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      pid = m ? Number(m[1]) : 0;
    } catch { break; }
  }
  return [...new Set(out.filter(Boolean))];
}

function parse(argv) {
  const a = { json: false, wait: true, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--no-wait') a.wait = false;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--file' || x === '--automation' || x === '--limit') {
      if (argv[i + 1] === undefined) return null;
      a[x.slice(2)] = argv[++i];
    } else a.pos.push(x);
  }
  a.command = a.pos.shift();
  return a;
}

const statusText = (s) => AC.STATUS_LABEL[s] || s;
function runText(r) {
  const head = [r.automationName, AC.triggerText(r), r.state].filter(Boolean).join(' · ');
  const lines = [head];
  for (const c of r.cards || []) {
    lines.push(`${c.title} — ${c.state}${c.reason ? ` (${c.reason})` : ''}`);
    if (c.note) lines.push(...c.note.split('\n').map((l) => `  ${l}`));
    if (c.statusChange) lines.push(`  ${r.trigger === 'trial' ? 'Would move' : 'Status changed'}: ${statusText(c.statusChange.from)} → ${statusText(c.statusChange.to)}`);
    if (c.filesChanged && c.filesChanged.length) lines.push(`  Files changed: ${c.filesChanged.join(', ')}`);
  }
  return lines.join('\n');
}
function listText(body) {
  if (!(body.automations || []).length) return 'No automations yet.';
  return body.automations.map((a) => {
    const last = a.lastRun ? `last: ${a.lastRun.summary}` : 'never run';
    const parts = [a.name, a.scheduleText, AC.LEVEL_LABEL[a.level] || a.level, last, a.tag].filter(Boolean);
    return `${a.id}  ${a.enabled ? 'on ' : 'off'}  ${parts.join(' · ')}`;
  }).join('\n');
}
function optionsText(o) {
  const lines = [`Time zone: ${o.timezone}`, `Boards: ${o.boards.map((b) => `${b.label} (${b.key})`).join(', ')}`,
    `Statuses: ${o.statuses.map((s) => s.id).join(', ')}`, 'Levels:'];
  for (const l of o.levels) lines.push(`  ${l.id}: ${l.text}`);
  lines.push(`Default agent: ${o.defaultAgent || 'none set'}`, 'Agents:');
  for (const a of o.agents) lines.push(`  ${a.id} (${a.label}): ${a.levels.length ? a.levels.join(', ') : 'not available'}${a.installed ? '' : ', not installed'}`);
  lines.push(`Templates: ${o.templates.map((t) => t.id).join(', ')}`);
  const l = o.limits;
  lines.push(`Limits: ${l.maxCards} cards a run, trials ${l.trialCards} cards and ${l.trialsPerHour} an hour, ${l.agentDrafts} agent drafts, prompt ${l.promptMax} characters, time limit ${l.timeLimitMin[0]}–${l.timeLimitMin[1]} min`);
  return lines.join('\n');
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const doFetch = deps.fetch || fetch;
  const readFile = deps.readFile || ((p) => (p === '-' ? readStdin() : fsp.readFile(p, 'utf8')));
  const names = deps.procNames || procNames;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const say = (s) => out.write(`${s}\n`);
  const usage = () => { err.write(`${USAGE}\n`); return 2; };

  const a = parse(argv);
  if (a && a.help) { say(USAGE); return 0; }
  if (!a || !a.command) return usage();
  const needsId = ['show', 'run', 'off', 'try', 'delete', 'edit'];
  if (!['options', 'list', 'show', 'match', 'runs', 'run', 'create', 'edit', 'off', 'try', 'delete'].includes(a.command)) return usage();
  if (needsId.includes(a.command) && !a.pos[0]) return usage();
  if ((a.command === 'create' || a.command === 'edit') && !a.file) return usage();
  if (a.command === 'match' && !a.pos[0] && !a.file) return usage();
  if (!env.VAULTOS_HOOK_URL || !env.VAULTOS_TERM_ID || !env.VAULTOS_TERM_TOKEN) { err.write('Run this in a VaultOS terminal.\n'); return 2; }

  let file = null;
  if (a.file) {
    let text;
    try { text = await readFile(a.file); } catch (e) { err.write(`Couldn't read ${a.file}: ${e.message}\n`); return 2; }
    try { file = JSON.parse(text); } catch (e) { err.write(`Couldn't read ${a.file} as JSON: ${e.message}\n`); return 2; }
  }
  const hint = names();
  // One request; returns the body, or an exit code after printing why.
  async function ask(command, args = {}) {
    let res;
    try {
      res = await doFetch(new URL(`/api/term/automations/${command}`, env.VAULTOS_HOOK_URL).href, {
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
  const print = (body, text) => { say(a.json ? JSON.stringify(body, null, 2) : text(body)); return 0; };

  const id = a.pos[0];
  let r;
  switch (a.command) {
    case 'options': r = await ask('options'); return r.body ? print(r.body, optionsText) : r.code;
    case 'list': r = await ask('list'); return r.body ? print(r.body, listText) : r.code;
    case 'show': r = await ask('show', { id }); return r.body ? (say(JSON.stringify(r.body.automation, null, 2)), 0) : r.code;
    case 'match':
      r = await ask('match', file ? { draft: file } : { id });
      return r.body ? print(r.body, (b) => [`${b.count} card${b.count === 1 ? '' : 's'} would match:`, ...b.cards.map((c) => `- ${c.title} [${statusText(c.status)}] ${c.path}`)].join('\n')) : r.code;
    case 'runs':
      r = await ask('runs', { automation: a.automation, limit: a.limit });
      return r.body ? print(r.body, (b) => b.runs.map((x) => `${x.id}  ${x.automationName} · ${AC.triggerText(x)} · ${x.state} · ${AC.runSummary(x)}`).join('\n') || 'No runs yet.') : r.code;
    case 'run': r = await ask('run', { id }); return r.body ? print(r.body, runText) : r.code;
    case 'create':
      r = await ask('create', file);
      return r.body ? print(r.body, (b) => `Created ${b.automation.id} (off): ${b.automation.name}. The person switches it on in the Automations tab.`) : r.code;
    case 'edit':
      r = await ask('edit', { id, changes: file });
      return r.body ? print(r.body, (b) => {
        const x = b.automation;
        if (x.enabled) return `Saved ${x.id}. It's still on.`;
        if (x.agentChange && x.agentChange.switchedOff) return `Saved ${x.id}. It's off until the person switches it on in the Automations tab (changed: ${x.agentChange.fields.join(', ')}).`;
        return `Saved ${x.id}. It's off.`;
      }) : r.code;
    case 'off': r = await ask('off', { id }); return r.body ? print(r.body, (b) => `${b.automation.name} is off.`) : r.code;
    case 'delete': r = await ask('delete', { id }); return r.body ? print(r.body, () => `Deleted ${id}.`) : r.code;
    case 'try': {
      const shown = await ask('show', { id });
      if (!shown.body) return shown.code;
      const queued = await ask('try', { id });
      if (!queued.body) return queued.code;
      if (!a.wait) return print(queued.body, () => 'Trial queued. See it with: vaultos-automations runs --automation ' + id);
      const deadline = Date.now() + ((shown.body.automation.timeLimitMin || 10) * 3 + 5) * 60000;
      for (;;) {
        const list = await ask('runs', { automation: id, limit: 5 });
        if (!list.body) return list.code;
        const done = list.body.runs.find((x) => x.trigger === 'trial' && x.startedAt >= queued.body.since && x.state !== 'running');
        if (done) {
          const detail = await ask('run', { id: done.id });
          return detail.body ? print(detail.body, runText) : detail.code;
        }
        if (Date.now() > deadline) { err.write('The trial is taking longer than expected; check it later with runs.\n'); return 1; }
        await sleep(POLL_MS);
      }
    }
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

module.exports = { main, procNames, USAGE };
