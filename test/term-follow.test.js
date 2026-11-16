'use strict';

// followAfterScrollbackClear lives in the browser-only public/term.js; lift its source out and run it against a
// stand-in terminal. The real-xterm behaviour (a scrolled-up view no longer lands on line 0 after Cursor's
// resize redraw) was checked in headless Chrome against xterm 6.0.0; this guards the wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../public/term.js'), 'utf8');
const match = /^function followAfterScrollbackClear[\s\S]*?^}$/m.exec(src);
const followAfterScrollbackClear = match && new Function(`${match[0]}; return followAfterScrollbackClear;`)();

function fakeTerm({ scrolledUp = true, core = true } = {}) {
  const t = {
    handlers: [],
    calls: [],
    parser: { registerCsiHandler(id, cb) { t.handlers.push({ id, cb }); return { dispose() {} }; } },
    scrollToBottom() { t.calls.push('scrollToBottom'); },
  };
  if (core) t._core = { _bufferService: { isUserScrolling: scrolledUp } };
  return t;
}

test('term.js has followAfterScrollbackClear', () => {
  assert.equal(typeof followAfterScrollbackClear, 'function');
});

test('it hooks CSI J (no prefix, no intermediates)', () => {
  const t = fakeTerm();
  followAfterScrollbackClear(t);
  assert.equal(t.handlers.length, 1);
  assert.deepEqual(t.handlers[0].id, { final: 'J' });
});

test('CSI 3 J: back to the bottom, the scrolled-up flag cleared, and xterm still does the clearing', () => {
  const t = fakeTerm({ scrolledUp: true });
  followAfterScrollbackClear(t);
  const handled = t.handlers[0].cb([3]);
  assert.equal(handled, false, 'returning false lets xterm\'s own CSI J run');
  assert.deepEqual(t.calls, ['scrollToBottom']);
  assert.equal(t._core._bufferService.isUserScrolling, false);
});

test('CSI J and CSI 2 J (screen only) leave the view alone', () => {
  for (const params of [[0], [1], [2]]) {
    const t = fakeTerm({ scrolledUp: true });
    followAfterScrollbackClear(t);
    assert.equal(t.handlers[0].cb(params), false);
    assert.deepEqual(t.calls, [], `params ${params}`);
    assert.equal(t._core._bufferService.isUserScrolling, true, `params ${params}`);
  }
});

test('without xterm\'s private buffer service it still scrolls to the bottom and lets the clear through', () => {
  const t = fakeTerm({ core: false });
  followAfterScrollbackClear(t);
  assert.equal(t.handlers[0].cb([3]), false);
  assert.deepEqual(t.calls, ['scrollToBottom']);
});

test('createTerminal installs it on every terminal', () => {
  const create = /^function createTerminal[\s\S]*?^}$/m.exec(src);
  assert.ok(create, 'createTerminal found');
  assert.match(create[0], /followAfterScrollbackClear\(term\)/);
});
