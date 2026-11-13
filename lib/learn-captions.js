'use strict';
// YouTube captions (WebVTT, as yt-dlp saves them) to the time-marked paragraphs Learn keeps as a source.
//
// Auto-captions come in YouTube's rolling layout: each cue shows the previous line plus the new words (with inline
// word timestamps), then a 10ms cue repeats the finished line, and there is no punctuation. dedupeRolling keeps each
// spoken line once, at the time it first appeared. Manual captions pass through it unchanged.

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3})/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function seconds(stamp) {
  const parts = stamp.split(':').map(Number);
  return parts.reduce((total, p) => total * 60 + p, 0);
}

// A numeric character reference; one past the last code point (or junk) reads as the replacement character.
function codePoint(e) {
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD';
}

function cleanLine(line) {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? codePoint(e) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
}

// Cues in order: { start, end, text } (seconds; text lines joined with '\n'). Blocks without a timing line (the
// header, NOTE, STYLE, REGION) are skipped, and so is a cue id above the timing line.
function parseVtt(text) {
  const cues = [];
  for (const block of String(text).replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l.trim()));
    if (at < 0) continue;
    const [, a, b] = lines[at].trim().match(TIMING);
    const body = lines.slice(at + 1).map(cleanLine).filter(Boolean);
    if (!body.length) continue;
    cues.push({ start: seconds(a), end: seconds(b), text: body.join('\n') });
  }
  return cues;
}

const flat = (t) => t.replace(/\n/g, ' ').trim();
const growsInto = (cur, next) => next.length > cur.length && next.startsWith(cur) && next[cur.length] === ' ';

// Each line said once. A cue whose text only grows into the next cue's is dropped, and its start moves on with it.
function dedupeRolling(cues) {
  const out = [];
  let last = null;
  let carried = null;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (next && growsInto(flat(cue.text), flat(next.text))) {
      if (carried === null) carried = cue.start;
      continue;
    }
    const start = carried === null ? cue.start : carried;
    carried = null;
    const fresh = [];
    for (const line of cue.text.split('\n')) {
      if (line === last) continue;
      fresh.push(line);
      last = line;
    }
    if (fresh.length) out.push({ start, end: cue.end, text: fresh.join(' ') });
  }
  return out;
}

const SENTENCE_END = /[.?!]["')\]]?$/;

// Paragraphs of roughly minSec to maxSec: a paragraph ends at the first sentence end once it has run minSec, and
// never runs past maxSec unless a single cue does.
function toParagraphs(cues, { minSec = 30, maxSec = 45 } = {}) {
  const out = [];
  let para = null;
  const close = () => {
    if (para) out.push({ start: para.start, text: para.parts.join(' ') });
    para = null;
  };
  for (const cue of cues) {
    const text = flat(cue.text);
    if (para && cue.end - para.start > maxSec) close();
    if (!para) para = { start: cue.start, parts: [] };
    para.parts.push(text);
    if (cue.end - para.start >= minSec && SENTENCE_END.test(text)) close();
  }
  close();
  return out;
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// The saved source: a few header lines, a blank line, then one "[m:ss] text" paragraph per block.
function transcriptText({ title, channel, url, duration, fetched }, paragraphs) {
  const head = [`Title: ${title}`];
  if (channel) head.push(`Channel: ${channel}`);
  head.push(`Link: ${url}`);
  if (Number.isFinite(duration) && duration > 0) head.push(`Length: ${formatTime(duration)}`);
  head.push(`Fetched: ${fetched}`);
  const body = paragraphs.map((p) => `[${formatTime(p.start)}] ${p.text}`).join('\n\n');
  return `${head.join('\n')}\n\n${body}\n`;
}

module.exports = { parseVtt, dedupeRolling, toParagraphs, formatTime, transcriptText };
