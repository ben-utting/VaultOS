'use strict';

// The grid's clipboard parser (Excel TSV → rows of cells). sheet-grid.js is a browser script; it is loaded
// here in a bare context with only what it reads when it loads (window.SheetCore), and its pure parser taken
// from window.SheetGrid.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const window = { SheetCore: require('../public/sheet-core') };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sheet-grid.js'), 'utf8'), { window });
const { parseClip } = window.SheetGrid;
// The context's arrays come from another realm, so compare plain copies.
const parse = (text) => JSON.parse(JSON.stringify(parseClip(text)));

test('one cell, no line break', () => assert.deepEqual(parse('abc'), [['abc']]));

test('Excel adds one trailing CRLF; it is not an extra row', () => {
  assert.deepEqual(parse('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parse('a\n'), [['a']]);
});

test('a second trailing line break is a blank row', () => assert.deepEqual(parse('a\r\n\r\n'), [['a'], ['']]));

test('quoted fields keep tabs, line breaks and doubled quotes', () => {
  assert.deepEqual(parse('a\t"multi\nline"\r\nb\tc'), [['a', 'multi\nline'], ['b', 'c']]);
  assert.deepEqual(parse('"say ""hi"""\t"x\ty"'), [['say "hi"', 'x\ty']]);
  assert.deepEqual(parse('"crlf\r\ninside"\r\n'), [['crlf\ninside']]);
});

test('empty fields and ragged rows are kept as they are', () => {
  assert.deepEqual(parse('\t\tz\r\nq'), [['', '', 'z'], ['q']]);
  assert.deepEqual(parse(''), [['']]);
});

test('a quote that never closes is plain text', () => {
  assert.deepEqual(parse('"open\tb\r\nc'), [['"open', 'b'], ['c']]);
});

test('text after a closing quote stays with its field', () => {
  assert.deepEqual(parse('"a"b\tc'), [['ab', 'c']]);
});

test('a quote inside an unquoted field is just a character', () => {
  assert.deepEqual(parse('5" pipe\tx'), [['5" pipe', 'x']]);
});

test('with a limit, parsing gives up (null) as soon as there are more cells than that', () => {
  assert.equal(parseClip('a\tb\r\nc\td', 3), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parseClip('a\tb\r\nc\td', 4))), [['a', 'b'], ['c', 'd']]);
  // 150,000 lines: no stack overflow, and it stops long before the end.
  assert.equal(parseClip('x\n'.repeat(150000), 20000), null);
  assert.equal(parseClip('x\n'.repeat(150000)).length, 150000);
});
