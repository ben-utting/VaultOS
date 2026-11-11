'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { replaceSection, insertInSection, parseFrontmatter, setFrontmatterField } = require('../lib/task-file');

test('replaceSection adds the section above the first ## heading, below top callouts', () => {
  const raw = '---\nid: x\n---\n\n> [!agent] hi\n\n## Goal\ng\n';
  assert.equal(
    replaceSection(raw, 'Latest check-in', ['_stamp_', '', 'note']),
    '---\nid: x\n---\n\n> [!agent] hi\n\n## Latest check-in\n_stamp_\n\nnote\n\n## Goal\ng\n',
  );
});

test('replaceSection replaces an existing section only', () => {
  const head = '---\nid: x\ntitle: "A: b"\n---\n';
  const raw = `${head}\n## Latest check-in\nold\n\n## Plan\n- [ ] a\n`;
  const out = replaceSection(raw, 'Latest check-in', ['new']);
  assert.equal(out, `${head}\n## Latest check-in\nnew\n\n## Plan\n- [ ] a\n`);
  assert.ok(out.startsWith(head));
});

test('replaceSection ignores a heading inside a code fence', () => {
  const raw = '---\nid: x\n---\n\n## Goal\n```\n## Latest check-in\nfenced\n```\n\n## Latest check-in\nold\n';
  const out = replaceSection(raw, 'Latest check-in', ['new']);
  assert.equal(out, '---\nid: x\n---\n\n## Goal\n```\n## Latest check-in\nfenced\n```\n\n## Latest check-in\nnew\n');
});

test('replaceSection with no ## heading appends at the end', () => {
  const raw = '---\nid: x\n---\n\nJust text.\n';
  assert.equal(replaceSection(raw, 'Latest check-in', ['n']), '---\nid: x\n---\n\nJust text.\n\n## Latest check-in\nn\n');
});

test('replaceSection keeps CRLF', () => {
  const raw = '---\r\nid: x\r\n---\r\n\r\n## Goal\r\ng\r\n';
  const out = replaceSection(raw, 'Latest check-in', ['a', 'b']);
  assert.equal(out, '---\r\nid: x\r\n---\r\n\r\n## Latest check-in\r\na\r\nb\r\n\r\n## Goal\r\ng\r\n');
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
});

test('replaceSection with the heading twice replaces the first and leaves the second', () => {
  const raw = '---\nid: x\n---\n\n## Latest check-in\none\n\n## Plan\np\n\n## Latest check-in\ntwo\n';
  assert.equal(
    replaceSection(raw, 'Latest check-in', ['new']),
    '---\nid: x\n---\n\n## Latest check-in\nnew\n\n## Plan\np\n\n## Latest check-in\ntwo\n',
  );
});

test('heading match is case-insensitive and escapes regex characters', () => {
  const raw = '---\nid: x\n---\n\n## check (daily)\nold\n\n## Goal\ng\n';
  assert.equal(
    replaceSection(raw, 'Check (daily)', ['new']),
    '---\nid: x\n---\n\n## Check (daily)\nnew\n\n## Goal\ng\n',
  );
});

test('insertInSection still puts Progress log entries at the top', () => {
  const raw = '---\nid: x\n---\n\n## Progress log\n\n- 2026-01-01 — old.\n';
  assert.equal(
    insertInSection(raw, 'Progress log', ['- 2026-01-02 — new.'], 'top'),
    '---\nid: x\n---\n\n## Progress log\n\n- 2026-01-02 — new.\n- 2026-01-01 — old.\n',
  );
});

test('frontmatter helpers still round-trip', () => {
  const raw = '---\nid: x\nstatus: blocked\n---\nbody\n';
  assert.equal(parseFrontmatter(raw).meta.status, 'blocked');
  assert.equal(setFrontmatterField(raw, 'status', 'review'), '---\nid: x\nstatus: review\n---\nbody\n');
});
