'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, csvToSheet, csvEditable, applyCsvOps, serializeCsv } = require('../lib/sheet-csv');

const B = (s) => Buffer.from(s, 'utf8'), run = (s, ops) => serializeCsv(applyCsvOps(parseCsv(B(s)), ops)).toString();
const set = (r, c, v) => ({ op: 'set', sheet: 0, r, c, v }), ins = (at, n, like = null) => ({ op: 'insertRows', sheet: 0, at, n, like }), del = (at, n) => ({ op: 'deleteRows', sheet: 0, at, n });

// ---- the plan's tests, verbatim -------------------------------------------

test('untouched files are byte-identical', () => { for (const s of ['﻿a,b\r\n1,"x,y"\r\n', 'a,b\n1,2', 'a,b\r\n1,2\n3,"multi\r\nline"\r\n', 'h1;h2\n1;2\n']) assert.equal(run(s, []), s); });
test('set changes only that record', () => assert.equal(run('a,b\r\n1,2\r\n3,4\n', [set(1, 1, 'x,y')]), 'a,b\r\n1,"x,y"\r\n3,4\n'));
test('insert/delete and the trailing-eol rule', () => {
  assert.equal(run('a,b\n1,2', [ins(2, 1), set(2, 0, 'z')]), 'a,b\n1,2\nz,');
  assert.equal(run('a,b\n1,2', [ins(1, 1)]), 'a,b\n,\n1,2');
  assert.equal(run('a,b\n1,2', [del(1, 1)]), 'a,b');
});
test('set past the last record appends records', () => assert.equal(run('a,b\n1,2\n', [set(3, 0, 'z')]), 'a,b\n1,2\n,\nz,\n'));
test('quoteAll files quote new fields', () => assert.equal(run('"a","b"\n"1","2"\n', [ins(2, 1), set(2, 0, 'q')]), '"a","b"\n"1","2"\n"q",""\n'));
test('delimiter detection', () => { assert.equal(parseCsv(B('a;b;c\n1;2;3\n')).delimiter, ';'); assert.equal(parseCsv(B('a\tb\n1\t2\n')).delimiter, '\t'); assert.equal(parseCsv(B('name\nx, y\n')).delimiter, ','); });
test('ragged rows pad on set', () => assert.equal(run('a,b,c\n1\n', [set(1, 2, 'v')]), 'a,b,c\n1,,v\n'));
test('newline in an edited value is quoted', () => assert.equal(run('a\n1\n', [set(1, 0, 'x\ny')]), 'a\n"x\ny"\n'));
test('utf-16 and latin1 are view-only', () => { assert.ok(csvEditable(parseCsv(Buffer.from([0xFF, 0xFE, 0x61, 0x00])))); assert.ok(csvEditable(parseCsv(Buffer.from([0x61, 0xE9, 0x0A])))); });
test('csvToSheet shape', () => { const s = csvToSheet(parseCsv(B('a,b\n1,2\n')), 'x.csv'); assert.equal(s.rowCount, 2); assert.equal(s.cells['1,1'].t, '2'); assert.deepEqual(s.frozen, { rows: 1, cols: 0 }); });

// ---- parsing --------------------------------------------------------------

test('parse result shape and encodings', () => {
  const p = parseCsv(B('a,b\r\n1,2\r\n'));
  assert.equal(p.encoding, 'utf-8');
  assert.equal(p.delimiter, ',');
  assert.equal(p.eolDominant, '\r\n');
  assert.equal(p.endsWithEol, true);
  assert.equal(p.quoteAll, false);
  assert.equal(p.records.length, 2);
  assert.deepEqual(p.records[1], { fields: [{ v: '1', q: false }, { v: '2', q: false }], raw: '1,2', eol: '\r\n' });
  assert.equal(parseCsv(B('﻿a\n')).encoding, 'utf-8-bom');
  assert.equal(csvEditable(parseCsv(B('a\n'))), null);
  assert.equal(csvEditable(parseCsv(B('﻿a\n'))), null);
  assert.equal(csvEditable(parseCsv(Buffer.from([0x61, 0xE9, 0x0A]))), "This CSV isn't UTF-8, so it's view-only here");
});

test('RFC 4180 quoting: escaped quotes, embedded delimiter/newline; a quote inside an unquoted field is literal', () => {
  const p = parseCsv(B('a,b\n"he said ""hi""","x,y"\nab"c,"line1\r\nline2"\n'));
  assert.deepEqual(p.records[1].fields, [{ v: 'he said "hi"', q: true }, { v: 'x,y', q: true }]);
  assert.deepEqual(p.records[2].fields, [{ v: 'ab"c', q: false }, { v: 'line1\r\nline2', q: true }]);
  assert.equal(p.records.length, 3);
});

test('eolDominant is the most common record terminator; endsWithEol and quoteAll', () => {
  assert.equal(parseCsv(B('a\r\nb\r\nc\nd')).eolDominant, '\r\n');
  assert.equal(parseCsv(B('a\nb\nc\r\nd')).eolDominant, '\n');
  assert.equal(parseCsv(B('a,b')).eolDominant, '\n');
  assert.equal(parseCsv(B('a,b')).endsWithEol, false);
  assert.equal(parseCsv(B('"a","b"\n"1","2"\n')).quoteAll, true);
  assert.equal(parseCsv(B('"a","b"\n"1",2\n')).quoteAll, false);
});

test('utf-16 decodes for display (LE and BE) and latin1 decodes for display', () => {
  const le = parseCsv(Buffer.from([0xFF, 0xFE, 0x61, 0x00, 0x2C, 0x00, 0x62, 0x00, 0x0A, 0x00, 0xE9, 0x00, 0x2C, 0x00, 0x32, 0x00]));
  assert.equal(le.encoding, 'utf-16le');
  assert.deepEqual(le.records.map((r) => r.fields.map((f) => f.v)), [['a', 'b'], ['é', '2']]);
  const be = parseCsv(Buffer.from([0xFE, 0xFF, 0x00, 0x61, 0x00, 0x2C, 0x00, 0x62, 0x00, 0x0A]));
  assert.equal(be.encoding, 'utf-16be');
  assert.deepEqual(be.records.map((r) => r.fields.map((f) => f.v)), [['a', 'b']]);
  const l1 = parseCsv(Buffer.from([0x61, 0x2C, 0xE9, 0x0A]));
  assert.equal(l1.encoding, 'latin1');
  assert.deepEqual(l1.records[0].fields.map((f) => f.v), ['a', 'é']);
});

test('empty file: zero records, empty buffer, 1-field rows when inserted into', () => {
  const p = parseCsv(Buffer.alloc(0));
  assert.deepEqual(p.records, []);
  assert.equal(serializeCsv(p).length, 0);
  const s = csvToSheet(p, 'e.csv');
  assert.equal(s.rowCount, 0);
  assert.equal(s.colCount, 1);
  assert.deepEqual(s.cells, {});
  assert.equal(run('', [ins(0, 2), set(0, 0, 'x')]), 'x\n');
  assert.equal(run('', [set(1, 0, 'y')]), '\ny');
});

test('a blank line is a record with one empty field and round-trips', () => {
  const p = parseCsv(B('a,b\n\n1,2\n'));
  assert.equal(p.records.length, 3);
  assert.deepEqual(p.records[1].fields, [{ v: '', q: false }]);
  assert.equal(run('a,b\n\n1,2\n', []), 'a,b\n\n1,2\n');
});

// ---- ops ------------------------------------------------------------------

test('a quoted record with an embedded CRLF survives untouched while another record is edited', () => {
  const src = 'a,b\r\n1,"multi\r\nline"\r\n3,4\r\n';
  assert.equal(run(src, [set(2, 0, '9')]), 'a,b\r\n1,"multi\r\nline"\r\n9,4\r\n');
});

test('edited fields keep their quoting; BOM survives edits', () => {
  assert.equal(run('a,b\n"1",2\n', [set(1, 0, 'x')]), 'a,b\n"x",2\n');
  assert.equal(run('a,b\n1,2\n', [set(1, 0, 'say "hi"')]), 'a,b\n"say ""hi""",2\n');
  assert.equal(run('﻿a,b\n1,2\n', [set(1, 0, 'x')]), '﻿a,b\nx,2\n');
  assert.equal(run('a;b\n1;2\n', [set(1, 0, 'x;y')]), 'a;b\n"x;y";2\n');
});

test('new records use the dominant eol; deleting several rows; insert n rows', () => {
  assert.equal(run('a,b\r\n1,2\r\n', [ins(1, 2)]), 'a,b\r\n,\r\n,\r\n1,2\r\n');
  assert.equal(run('a\nb\nc\nd\n', [del(1, 2)]), 'a\nd\n');
  assert.equal(run('a\nb\n', [del(5, 3)]), 'a\nb\n');
  assert.equal(run('a\n', [del(0, 1)]), '');
});

test('ops apply in order and a touched record loses raw', () => {
  const out = applyCsvOps(parseCsv(B('a,b\n1,2\n3,4\n')), [set(1, 0, 'x'), ins(1, 1), del(0, 1)]);
  assert.deepEqual(out.records.map((r) => r.fields.map((f) => f.v)), [['', ''], ['x', '2'], ['3', '4']]);
  assert.equal(out.records[0].raw, null);
  assert.equal(out.records[1].raw, null);
  assert.equal(out.records[2].raw, '3,4');
});

test('applyCsvOps does not mutate its input', () => {
  const p = parseCsv(B('a,b\n1,2\n'));
  const before = JSON.stringify(p);
  const out = applyCsvOps(p, [set(1, 0, 'x'), set(1, 0, 'y'), ins(0, 1), del(2, 1)]);
  assert.notEqual(out, p);
  assert.equal(JSON.stringify(p), before);
  assert.equal(serializeCsv(p).toString(), 'a,b\n1,2\n');
});

test('bad ops are rejected with status 400', () => {
  const p = parseCsv(B('a,b\n1,2\n'));
  const bad = [
    { op: 'set', sheet: 1, r: 0, c: 0, v: 'x' },
    { op: 'set', sheet: '0', r: 0, c: 0, v: 'x' },
    { op: 'set', r: 0, c: 0, v: 'x' },
    { op: 'frobnicate', sheet: 0 },
    { op: 'set', sheet: 0, r: 0.5, c: 0, v: 'x' },
    { op: 'set', sheet: 0, r: -1, c: 0, v: 'x' },
    { op: 'set', sheet: 0, r: 0, c: -1, v: 'x' },
    { op: 'set', sheet: 0, r: 0, c: '1', v: 'x' },
    { op: 'set', sheet: 0, r: 0, c: 0, v: 5 },
    { op: 'set', sheet: 0, r: 0, c: 0 },
    { op: 'set', sheet: 0, r: 2000000, c: 0, v: 'x' },
    { op: 'set', sheet: 0, r: 0, c: 20000, v: 'x' },
    ins(-1, 1), ins(0, 0), ins(0, 1001), ins(0.5, 1), ins(0, 1.5),
    del(-1, 1), del(0, 0), del(0, 1001), del(1.5, 1),
    null, 'set', 7,
  ];
  for (const op of bad) {
    assert.throws(() => applyCsvOps(p, [op]), (e) => e instanceof Error && e.status === 400, JSON.stringify(op));
  }
  assert.throws(() => applyCsvOps(p, 'nope'), (e) => e.status === 400);
  assert.doesNotThrow(() => applyCsvOps(p, [ins(0, 1000), del(0, 1000)]));
});

test('applyCsvOps and serializeCsv refuse a non-UTF-8 parse', () => {
  const p = parseCsv(Buffer.from([0x61, 0xE9, 0x0A]));
  assert.throws(() => applyCsvOps(p, []), (e) => e.status === 400);
  assert.throws(() => serializeCsv(p), (e) => e.status === 400);
});

test('insertRows ignores like', () => {
  assert.equal(run('a,b\n1,2\n', [ins(1, 1, 0)]), 'a,b\n,\n1,2\n');
  assert.equal(run('a,b\n1,2\n', [ins(1, 1, 1)]), 'a,b\n,\n1,2\n');
});

// ---- sheet model ----------------------------------------------------------

test('csvToSheet returns every Sheet field', () => {
  const s = csvToSheet(parseCsv(B('name,qty\napple,3\n,\npear\n')), 'f.csv');
  assert.equal(s.index, 0);
  assert.equal(s.name, 'f.csv');
  assert.equal(s.rowCount, 4);
  assert.equal(s.colCount, 2);
  assert.deepEqual(s.cells, {
    '0,0': { t: 'name', s: 0 }, '0,1': { t: 'qty', s: 0 },
    '1,0': { t: 'apple' }, '1,1': { t: '3' },
    '3,0': { t: 'pear' },
  });
  assert.deepEqual(s.styles, ['font-weight:600']);
  assert.deepEqual(s.colWidths, [5 * 7 + 16, 48]);
  assert.deepEqual(s.rowHeights, {});
  assert.equal(s.defaultRowHeight, 20);
  assert.deepEqual(s.hiddenRows, []);
  assert.deepEqual(s.hiddenCols, []);
  assert.deepEqual(s.merges, []);
  assert.deepEqual(s.frozen, { rows: 1, cols: 0 });
  assert.deepEqual(s.lists, []);
  assert.deepEqual(s.cf, []);
  assert.equal(s.cfSkipped, 0);
  assert.equal(s.readOnly, null);
  assert.equal(s.rowOps, null);
  assert.deepEqual(s.locked, []);
  assert.equal(s.tooBig, false);
});

test('csvToSheet clamps column widths and flags over-cap sheets', () => {
  const wide = csvToSheet(parseCsv(B('x'.repeat(100) + ',y\n')), 'w.csv');
  assert.deepEqual(wide.colWidths, [320, 48]);
  const rows = ['a,b,c'];
  for (let i = 0; i < 20000; i++) rows.push('1,2,3');
  const big = csvToSheet(parseCsv(B(rows.join('\n'))), 'big.csv');
  assert.equal(big.rowCount, 20001);
  assert.equal(big.colCount, 3);
  assert.equal(big.tooBig, true);
  assert.deepEqual(big.cells, {});
  const edge = csvToSheet(parseCsv(B(Array(60).fill(Array(1000).fill('1').join(',')).join('\n'))), 'edge.csv');
  assert.equal(edge.tooBig, false);
  assert.equal(Object.keys(edge.cells).length, 60000);
});

test('csvToSheet uses the widest record for colCount', () => {
  const s = csvToSheet(parseCsv(B('a\n1,2,3\n4,5\n')), 'r.csv');
  assert.equal(s.colCount, 3);
  assert.equal(s.cells['1,2'].t, '3');
});

test('setting a field to the text it already has leaves the record byte-identical', () => {
  assert.equal(run('a,b\n"1" ,2\n', [set(1, 1, '2')]), 'a,b\n"1" ,2\n');
  const out = applyCsvOps(parseCsv(B('a,b\n1,2\n')), [set(1, 0, '1')]);
  assert.equal(out.records[1].raw, '1,2');
});

test('an op cannot grow the file without bound', () => {
  const p = parseCsv(B('a,b\n1,2\n'));
  assert.throws(() => applyCsvOps(p, [set(1048575, 0, 'x')]), (e) => e.status === 400);
  assert.throws(() => applyCsvOps(p, [ins(1048575, 1)]), (e) => e.status === 400);
});
