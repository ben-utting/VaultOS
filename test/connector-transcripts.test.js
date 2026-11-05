'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/connector-transcripts');

test('vttToText merges consecutive cues from one speaker', () => {
  const vtt = [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:03.000', '<v Alex Smith>Hello</v>', '',
    '00:00:04.000 --> 00:00:06.000', '<v Alex Smith>there</v>', '',
    '00:01:05.500 --> 00:01:07.000', '<v Sam Lee>Hi</v>', '',
  ].join('\n');
  assert.equal(T.vttToText(vtt), '[00:00] Alex Smith: Hello there\n[00:01] Sam Lee: Hi');
});

test('vttToText joins multi-line cues with one space', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alex Smith>Hello\nthere</v>\n';
  assert.equal(T.vttToText(vtt), '[00:00] Alex Smith: Hello there');
});

test('vttToText timestamps are hh:mm, long and short form', () => {
  assert.equal(T.vttToText('WEBVTT\n\n01:02:03.000 --> 01:02:05.000\n<v A>x</v>'), '[01:02] A: x');
  assert.equal(T.vttToText('WEBVTT\n\n02:03.000 --> 02:05.000\n<v A>x</v>'), '[00:02] A: x');
});

test('vttToText copes with BOM, CRLF, cue ids, NOTE blocks and no voice tags', () => {
  const vtt = '﻿WEBVTT\r\n\r\nNOTE secret note\r\nmore note\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nFirst line\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nSecond line\r\n';
  const out = T.vttToText(vtt);
  assert.equal(out, '[00:00] Unknown: First line Second line');
  assert.ok(!/WEBVTT|NOTE|secret/.test(out));
  assert.ok(!/^\d+$/m.test(out));
});

test('vttToText strips other tags and decodes entities', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A><c>R&amp;D</c> <b>&lt;ok&gt;</b></v>';
  assert.equal(T.vttToText(vtt), '[00:00] A: R&D <ok>');
});

test('vttToText returns empty string for empty input', () => {
  assert.equal(T.vttToText(''), '');
  assert.equal(T.vttToText('WEBVTT\n\n'), '');
});

test('checkId accepts safe ids and rejects the rest', () => {
  assert.equal(T.checkId('MSo1N2Y5ZGFj_LTQ3='), 'MSo1N2Y5ZGFj_LTQ3=');
  for (const bad of ['a/b', '../x', '', 5, 'a'.repeat(2001)]) {
    assert.throws(() => T.checkId(bad), T.TranscriptsError);
  }
});
