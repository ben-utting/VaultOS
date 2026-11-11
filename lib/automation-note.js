'use strict';
// The text contract between VaultOS and an automation's agent: the prompt that goes in
// (buildPrompt) and the note block that comes back (parseOutput), plus the section text
// VaultOS writes into the card. No I/O.
const { NOTE_MAX, CARD_STATUSES, LEVEL_PARAGRAPHS, wallParts } = require('../public/automation-core');

const TASK_MAX = 60 * 1024;
const FENCE = '```';

function noteInstructions(level) {
  const note = [
    "When you're done, end your reply with exactly one block like this, with nothing after it:",
    `${FENCE}vaultos-note`,
    '(your note: markdown, at most 1,500 characters)',
    FENCE,
  ].join('\n');
  if (level !== 'update') return note;
  return [
    "If the card should move, put this block just before the note block (leave out lines you don't need):",
    `${FENCE}vaultos-update`,
    'status: backlog | in-progress | blocked | needs-decision | review | scheduled',
    "blocked_by: what it's waiting on",
    'decision_note: what Ben must decide',
    'review_note: what Ben should check',
    'scheduled_for: YYYY-MM-DD',
    FENCE,
    'Never propose done.',
    '',
    note,
  ].join('\n');
}

function buildPrompt({ automation, card, taskRaw, today, tz }) {
  const task = taskRaw.length > TASK_MAX ? `${taskRaw.slice(0, TASK_MAX)}\n(cut short: read task.md for the rest)` : taskRaw.replace(/\n$/, '');
  return [
    `You are running unattended for the VaultOS automation "${automation.name}". Nobody is watching: don't ask questions, don't wait for input.`,
    `Today is ${today} (${tz}). Card: "${card.title}", status ${card.status}, last updated ${card.updated || 'unknown'}.`,
    'Its folder is your working directory.',
    LEVEL_PARAGRAPHS[automation.level],
    "Here is the card's task.md:",
    '----- task.md -----',
    task,
    '----- end of task.md -----',
    '',
    automation.prompt.trim(),
    '',
    noteInstructions(automation.level),
  ].join('\n');
}

// Every ```vaultos-<kind> block in the text, in order: [{ kind, body }]. A block closes on a fence
// line at least as long as the one that opened it; an unclosed block is dropped.
function blocks(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,})vaultos-(note|update)\s*$/.exec(lines[i]);
    if (!open) continue;
    const close = new RegExp(`^\\s*\`{${open[1].length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    if (j >= lines.length) break;
    out.push({ kind: open[2], body: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return out;
}

const UPDATE_KEYS = ['status', 'blocked_by', 'decision_note', 'review_note', 'scheduled_for'];
function parseUpdate(body) {
  const update = {};
  const ignored = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const kv = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv || !UPDATE_KEYS.includes(kv[1])) { ignored.push(kv ? kv[1] : line.trim()); continue; }
    const [, key] = kv;
    const value = kv[2].trim().slice(0, 300);
    if (!value) continue;
    if (key === 'status' && !CARD_STATUSES.includes(value)) { ignored.push(`status: ${value}`); continue; }
    if (key === 'scheduled_for' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { ignored.push(`scheduled_for: ${value}`); continue; }
    update[key] = value;
  }
  return { update, ignored };
}

function parseOutput(text, level) {
  const found = blocks(text);
  const lastOf = (kind) => found.filter((b) => b.kind === kind).pop();
  let note = null;
  let cut = false;
  const n = lastOf('note');
  if (n && n.body.trim()) {
    note = n.body.trim();
    if (note.length > NOTE_MAX) {
      const head = note.slice(0, NOTE_MAX);
      const at = head.lastIndexOf('\n');
      note = `${(at > 0 ? head.slice(0, at) : head).trimEnd()}\n(cut short)`;
      cut = true;
    }
  }
  const u = lastOf('update');
  if (!u) return { note, cut, update: null, ignored: [] };
  if (level !== 'update') return { note, cut, update: null, ignored: ['vaultos-update block (not an Update automation)'] };
  const { update, ignored } = parseUpdate(u.body);
  return { note, cut, update, ignored };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "11 Nov 2026, 08:03" on the wall clock in tz.
function stampText(ms, tz) {
  const w = wallParts(ms, tz);
  const pad = (x) => String(x).padStart(2, '0');
  return `${w.d} ${MONTHS[w.mo - 1]} ${w.y}, ${pad(w.h)}:${pad(w.mi)}`;
}

function sectionLines({ stamp, automationName, agentLabel, note }) {
  return [`_${stamp} · ${automationName} · ${agentLabel}_`, '', ...note.split('\n')];
}

module.exports = { buildPrompt, noteInstructions, parseOutput, stampText, sectionLines, TASK_MAX };
