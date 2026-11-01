'use strict';
// Reading the lines a note's template gives it: the stamp, `Status #baby|#child|#adult`, `Tags [[a]] [[b]]`.
// Pure. Notes have no frontmatter; these lines are the whole of their metadata.
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const LEVELS = ['baby', 'child', 'adult'];

const isStamp = (line) => STAMP.test(String(line).trim());
const lines = (text) => String(text || '').split(/\r?\n/);
const lineStarting = (text, word) => lines(text).find((l) => new RegExp(`^${word}\\b`).test(l));

function firstLine(text) {
  for (const raw of lines(text)) {
    const l = raw.trim();
    if (!l || isStamp(l) || /^(Status|Tags)\b/.test(l)) continue;
    const s = l.replace(/^#+\s*/, '').trim();
    if (s) return s.slice(0, 120);
  }
  return '';
}

function readStatus(text) {
  const l = lineStarting(text, 'Status');
  if (!l) return null;
  const m = l.match(/#(baby|child|adult)\b/);
  return m && LEVELS.includes(m[1]) ? m[1] : null;
}

function readTags(text) {
  const l = lineStarting(text, 'Tags');
  if (!l) return [];
  return [...l.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].split(/[|#]/)[0].trim()).filter(Boolean);
}

module.exports = { isStamp, firstLine, readStatus, readTags };
