'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseVtt, dedupeRolling, toParagraphs, formatTime, transcriptText } = require('../lib/learn-captions');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'learn', name), 'utf8');

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(750), '12:30');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(59.9), '0:59');
});

test('parseVtt reads manual captions: tags, entities, NOTE/STYLE blocks and cue ids are not text', () => {
  const cues = parseVtt(fixture('manual.vtt'));
  assert.equal(cues.length, 20);
  assert.deepEqual(cues[0], { start: 2, end: 5.6, text: "So, has everyone heard of a lighthouse?" });
  assert.equal(cues[2].text, 'It is a tower --\nit guides ships --');
  assert.equal(cues[3].text, 'and it has stood on coasts for centuries');
  assert.ok(cues[9].text.includes('all year & kept'));
  assert.ok(!cues.some((c) => /STYLE|NOTE|::cue|cue-4/.test(c.text)));
});

test('parseVtt reads short mm:ss stamps, hour-plus stamps, <c> tags and cue settings', () => {
  const cues = parseVtt(fixture('long.vtt'));
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].text, 'The first part starts here.');
  assert.equal(cues[1].start, 3590);
  assert.equal(cues[1].text, 'sentence number 1 goes past the hour.');
  assert.ok(!cues.some((c) => /<|align:/.test(c.text)));
});

test('dedupeRolling says each auto-caption line once, at the time it was first spoken', () => {
  const cues = dedupeRolling(parseVtt(fixture('auto-rolling.vtt')));
  const lines = cues.map((c) => c.text);
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
  assert.equal(lines.length, 20);
  assert.equal(lines[0], 'so today I want to talk about rivers');
  assert.equal(cues[0].start, 5.8);
  assert.equal(lines[1], 'where they start and where they end');
  const all = lines.join(' ');
  assert.equal(all.split('most rivers start high up in the hills').length, 2, 'said once');
});

test('dedupeRolling drops a cue that only grows into the next one', () => {
  const cues = dedupeRolling([
    { start: 1, end: 2, text: 'so I' },
    { start: 2, end: 3, text: 'so I want' },
    { start: 3, end: 4, text: 'so I want to start' },
    { start: 4, end: 5, text: 'with rivers' },
  ]);
  assert.deepEqual(cues.map((c) => [c.start, c.text]), [[1, 'so I want to start'], [4, 'with rivers']]);
});

test('dedupeRolling leaves manual captions alone', () => {
  const cues = parseVtt(fixture('manual.vtt'));
  assert.deepEqual(dedupeRolling(cues).map((c) => c.text), cues.map((c) => c.text.replace(/\n/g, ' ')));
});

test('toParagraphs: 30 to 45 seconds each, breaking at a sentence end where there is one', () => {
  const cues = parseVtt(fixture('manual.vtt'));
  const paras = toParagraphs(dedupeRolling(cues));
  assert.ok(paras.length >= 2);
  const ends = paras.map((p, i) => (i + 1 < paras.length ? paras[i + 1].start : cues[cues.length - 1].end));
  paras.forEach((p, i) => {
    const span = ends[i] - p.start;
    if (i < paras.length - 1) assert.ok(span >= 30, `paragraph ${i} spans ${span}s`);
    assert.ok(span <= 46, `paragraph ${i} spans ${span}s`);
    if (i < paras.length - 1) assert.match(p.text, /[.?!]$/, 'manual captions break at a sentence end');
  });
  assert.equal(paras[0].start, 2);
  assert.ok(!paras[0].text.includes('\n'));
});

test('toParagraphs: unpunctuated auto captions break hard at 45 seconds', () => {
  const cues = dedupeRolling(parseVtt(fixture('auto-rolling.vtt')));
  const paras = toParagraphs(cues);
  assert.equal(paras.length, 2);
  assert.ok(paras[1].start - paras[0].start <= 45);
  assert.ok(paras[1].start - paras[0].start >= 30);
});

test('toParagraphs: one cue longer than 45 seconds is still one paragraph', () => {
  const paras = toParagraphs([{ start: 0, end: 60, text: 'one long cue' }, { start: 61, end: 62, text: 'then more.' }]);
  assert.deepEqual(paras, [{ start: 0, text: 'one long cue' }, { start: 61, text: 'then more.' }]);
});

test('transcriptText lays the file out as the spec shows', () => {
  const text = transcriptText(
    { title: 'Rivers, start to end', channel: 'A channel', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 1421, fetched: '2026-11-13' },
    [{ start: 0, text: 'First part.' }, { start: 3723, text: 'Later part.' }],
  );
  assert.equal(text, 'Title: Rivers, start to end\nChannel: A channel\nLink: https://www.youtube.com/watch?v=abcdefghijk\nLength: 23:41\nFetched: 2026-11-13\n\n[0:00] First part.\n\n[1:02:03] Later part.\n');
});

test('transcriptText leaves out a channel or length it does not know', () => {
  const text = transcriptText({ title: 'T', url: 'https://youtu.be/x', fetched: '2026-11-13' }, [{ start: 5, text: 'Hi.' }]);
  assert.equal(text, 'Title: T\nLink: https://youtu.be/x\nFetched: 2026-11-13\n\n[0:05] Hi.\n');
});
