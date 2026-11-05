'use strict';
// The Teams transcripts connector: read-only access to Microsoft Teams meeting transcripts through an app the user
// registers. This part holds the pure helpers (VTT to readable text, ID checks).

class TranscriptsError extends Error {}

const ID_RE = /^[A-Za-z0-9_=\-]{1,2000}$/;

// Graph IDs go into URL paths, so only a tight character set is allowed.
function checkId(s) {
  if (typeof s !== 'string' || !ID_RE.test(s)) throw new TranscriptsError('Invalid ID.');
  return s;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// "00:01:05.500" or "01:05.500" -> "[hh:mm]"
function stamp(t) {
  const parts = t.split(':');
  const h = parts.length >= 3 ? parts[0] : '0';
  const m = parts.length >= 3 ? parts[1] : parts[0];
  return `[${h.padStart(2, '0')}:${m.padStart(2, '0')}]`;
}

// WebVTT -> "[hh:mm] Speaker: text" lines; consecutive cues from one speaker merge under the first cue's time.
function vttToText(vtt) {
  const src = String(vtt || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out = [];
  let last = null;
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const start = lines[at].split('-->')[0].trim();
    let text = lines.slice(at + 1).join(' ').trim();
    let speaker = 'Unknown';
    const v = /^<v(?:\.[^\s>]*)*\s+([^>]*)>/.exec(text);
    if (v) { speaker = decode(v[1].trim()) || 'Unknown'; text = text.slice(v[0].length); }
    text = decode(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (last && last.speaker === speaker) { last.text += ` ${text}`; continue; }
    last = { stamp: stamp(start), speaker, text };
    out.push(last);
  }
  return out.map((c) => `${c.stamp} ${c.speaker}: ${c.text}`).join('\n');
}

module.exports = { TranscriptsError, checkId, vttToText };
