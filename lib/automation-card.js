'use strict';
// What an automation run writes into a card's task.md (spec §4.7). VaultOS writes, not the agent:
// the note replaces one section, an Update proposal moves the card the way a drag on the board
// does, and a Work run that set the card to done is put back. Pure: text in, text out.
const { parseFrontmatter, setFrontmatterField, insertInSection, replaceSection } = require('./task-file');
const { sectionLines } = require('./automation-note');

// The note field that goes with each status (the task template's names).
const FIELD_FOR = { 'blocked': 'blocked_by', 'needs-decision': 'decision_note', 'review': 'review_note', 'scheduled': 'scheduled_for' };

const statusOf = (raw) => parseFrontmatter(raw).meta.status || 'backlog';

function applyResult(raw, { automation, agentLabel, stamp, note, update, statusAtStart, today }) {
  const result = { raw, statusChange: null, proposalIgnored: '', doneReverted: false };
  let out = replaceSection(raw, automation.section, sectionLines({ stamp, automationName: automation.name, agentLabel, note }));
  const now = statusOf(out);
  const log = (line) => { out = insertInSection(out, 'Progress log', [`- ${today} — ${line}`], 'top'); };

  if (automation.level === 'update' && update && update.status) {
    if (now !== statusAtStart) {
      result.proposalIgnored = 'status changed during the run';
    } else if (update.status !== now) {
      out = setFrontmatterField(out, 'status', update.status);
      const field = FIELD_FOR[update.status];
      if (field && update[field]) out = setFrontmatterField(out, field, update[field]);
      out = setFrontmatterField(out, 'updated', today);
      log(`status ${now} → ${update.status} (automation: ${automation.name}).`);
      result.statusChange = { from: now, to: update.status };
    }
  }

  if (automation.level === 'work' && now === 'done' && statusAtStart !== 'done') {
    out = setFrontmatterField(out, 'status', statusAtStart);
    log(`status done → ${statusAtStart} (automation: ${automation.name} set done; VaultOS put it back).`);
    result.doneReverted = true;
  }

  result.raw = out;
  return result;
}

module.exports = { applyResult };
