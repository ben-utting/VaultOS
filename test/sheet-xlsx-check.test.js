'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const {
  loadWorkbook, partCounts, drawingAnchors, carryOverPackageParts, checkEditable, cellSignature, applyOps, writeVerified,
} = require('../lib/sheet-xlsx');
const { makeTracker, makePack } = require('./fixtures');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// the zip's bytes with extra parts added (name -> content)
async function inject(buf, parts) {
  const zip = await JSZip.loadAsync(buf);
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const check = async (buf) => checkEditable(buf, await loadWorkbook(buf));

// a workbook with one picture on its first sheet, so the output keeps one drawing part
async function withPicture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Pic');
  ws.getCell('A1').value = 'x';
  const id = wb.addImage({ buffer: PNG, extension: 'png' });
  ws.addImage(id, { tl: { col: 2, row: 2 }, ext: { width: 20, height: 20 } });
  return wb.xlsx.writeBuffer();
}

// ---- partCounts ---------------------------------------------------------------

test('partCounts normalises digits and skips bookkeeping parts', async () => {
  const buf = await inject(await makeTracker(), {
    'xl/charts/chart12.xml': '<c/>',
    'xl/calcChain.xml': '<c/>',
    'docProps/thumbnail.jpeg': 'x',
  });
  const counts = await partCounts(buf);
  assert.ok(counts instanceof Map);
  assert.equal(counts.get('xl/worksheets/sheetN.xml'), 1);
  assert.equal(counts.get('xl/charts/chartN.xml'), 1);
  for (const name of counts.keys()) {
    assert.doesNotMatch(name, /_rels\/|\.rels$|Content_Types|^docProps\/|calcChain|sharedStrings/);
    assert.doesNotMatch(name, /\d/);
  }
});

test('partCounts counts parts that normalise to the same name', async () => {
  const counts = await partCounts(await inject(await makeTracker(), {
    'xl/worksheets/sheet2.xml': '<w/>', 'xl/worksheets/sheet10.xml': '<w/>',
  }));
  assert.equal(counts.get('xl/worksheets/sheetN.xml'), 3);
});

// ---- checkEditable --------------------------------------------------------------

test('tracker is editable', async () => {
  assert.deepEqual(await check(await makeTracker()), { editable: true, lost: [], reason: null });
});

test('pack (hidden sheet, formula, cross-sheet list) is editable', async () => {
  assert.deepEqual(await check(await makePack()), { editable: true, lost: [], reason: null });
});

test('an injected chart part is a loss', async () => {
  const r = await check(await inject(await makeTracker(), { 'xl/charts/chart1.xml': '<c:chartSpace/>' }));
  assert.equal(r.editable, false);
  assert.ok(r.lost.includes('charts'));
  assert.match(r.reason, /would lose charts/);
  assert.match(r.reason, /edit it in Excel/);
});

test('printer settings and custom XML are harmless', async () => {
  const r = await check(await inject(await makeTracker(), {
    'xl/printerSettings/printerSettings1.bin': 'x', 'xl/printerSettings/printerSettings2.bin': 'x', 'customXml/item1.xml': '<a/>',
  }));
  assert.deepEqual(r, { editable: true, lost: [], reason: null });
});

// ---- parts a save carries over (custom properties, sensitivity-label metadata) ------------------

const CUSTOM_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const LABEL_TYPE = 'application/x-label-info-from-the-source+xml';   // deliberately not the usual one
const LABEL_REL = 'http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels';
const CUSTOM_XML = '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_0000_Enabled"><vt:lpwstr xmlns:vt="x">true</vt:lpwstr></property></Properties>';
const LABEL_XML = '<clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{0}" enabled="1"/></clbl:labelList>';

// A part added the way Excel writes one: the part, a content-type override (unless type is null) and a
// package relationship (unless relType is null).
async function withPart(buf, { name, content, type, relType, relId = 'rId99' }) {
  const zip = await JSZip.loadAsync(buf);
  zip.file(name, content);
  if (relType) {
    const rels = await zip.file('_rels/.rels').async('string');
    zip.file('_rels/.rels', rels.replace('</Relationships>', `<Relationship Id="${relId}" Type="${relType}" Target="${name}"/></Relationships>`));
  }
  if (type) {
    const types = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${name}" ContentType="${type}"/></Types>`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const withCustomProperties = (buf) => withPart(buf, { name: 'docProps/custom.xml', content: CUSTOM_XML, type: CUSTOM_TYPE, relType: CUSTOM_REL });
const withLabelInfo = (buf) => withPart(buf, { name: 'docMetadata/LabelInfo.xml', content: LABEL_XML, type: LABEL_TYPE, relType: LABEL_REL });

// what ExcelJS writes for the workbook in `buf`, then carried over from `buf`
async function saved(buf) {
  const out = await (await loadWorkbook(buf)).xlsx.writeBuffer();
  return { out, carried: await carryOverPackageParts(buf, out) };
}
const text = async (buf, name) => (await JSZip.loadAsync(buf)).file(name).async('string');
const countOf = (haystack, re) => (haystack.match(re) || []).length;

test('ExcelJS writes neither custom properties nor label metadata', async () => {
  const { out } = await saved(await withLabelInfo(await withCustomProperties(await makeTracker())));
  const names = Object.keys((await JSZip.loadAsync(out)).files);
  assert.ok(!names.includes('docProps/custom.xml'));
  assert.ok(!names.some((n) => n.startsWith('docMetadata/')));
});

test('custom properties carry over: editable, byte-identical, one override, one relationship', async () => {
  const buf = await withCustomProperties(await makeTracker());
  assert.ok((await partCounts(buf)).has('docProps/custom.xml'));
  assert.deepEqual(await check(buf), { editable: true, lost: [], reason: null });

  const { out, carried } = await saved(buf);
  assert.notEqual(carried, out);
  assert.deepEqual(await (await JSZip.loadAsync(carried)).file('docProps/custom.xml').async('nodebuffer'), Buffer.from(CUSTOM_XML));
  const types = await text(carried, '[Content_Types].xml');
  assert.equal(countOf(types, /<Override PartName="\/docProps\/custom\.xml"/g), 1);
  assert.match(types, new RegExp(`PartName="/docProps/custom\\.xml" ContentType="${CUSTOM_TYPE.replace(/[.+]/g, '\\$&')}"`));
  const rels = await text(carried, '_rels/.rels');
  assert.equal(countOf(rels, /<Relationship\b[^>]*Target="docProps\/custom\.xml"/g), 1);
  assert.equal(countOf(rels, new RegExp(`Type="${CUSTOM_REL.replace(/[.]/g, '\\.')}"`, 'g')), 1);
  await new ExcelJS.Workbook().xlsx.load(carried);     // reads back without error
  assert.deepEqual(await partCounts(carried), await partCounts(buf));
});

test('label metadata carries over with the source\'s own content type and relationship type', async () => {
  const buf = await withLabelInfo(await makeTracker());
  assert.deepEqual(await check(buf), { editable: true, lost: [], reason: null });

  const { carried } = await saved(buf);
  assert.deepEqual(await (await JSZip.loadAsync(carried)).file('docMetadata/LabelInfo.xml').async('nodebuffer'), Buffer.from(LABEL_XML));
  const types = await text(carried, '[Content_Types].xml');
  assert.equal(countOf(types, /<Override PartName="\/docMetadata\/LabelInfo\.xml"/g), 1);
  assert.ok(types.includes(`PartName="/docMetadata/LabelInfo.xml" ContentType="${LABEL_TYPE}"`));
  const rels = await text(carried, '_rels/.rels');
  const relTags = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes('Target="docMetadata/LabelInfo.xml"'));
  assert.equal(relTags.length, 1);
  assert.ok(relTags[0].includes(`Type="${LABEL_REL}"`));
  await new ExcelJS.Workbook().xlsx.load(carried);
});

test('the content type comes from the source\'s Default when it has no override for the part', async () => {
  const buf = await withPart(await makeTracker(), { name: 'docProps/custom.xml', content: CUSTOM_XML, type: null, relType: CUSTOM_REL });
  const defaultXml = /<Default Extension="xml" ContentType="([^"]+)"/.exec(await text(buf, '[Content_Types].xml'));
  assert.ok(defaultXml);
  const { carried } = await saved(buf);
  assert.ok((await text(carried, '[Content_Types].xml')).includes(`PartName="/docProps/custom.xml" ContentType="${defaultXml[1]}"`));
});

test('carrying over twice changes nothing the second time', async () => {
  for (const make of [withCustomProperties, withLabelInfo]) {
    const buf = await make(await makeTracker());
    const { carried } = await saved(buf);
    assert.equal(await carryOverPackageParts(buf, carried), carried, 'same buffer back');
    assert.equal(countOf(await text(carried, '[Content_Types].xml'), /<Override PartName="\/(?:docProps\/custom|docMetadata\/LabelInfo)\.xml"/g), 1);
    assert.equal(countOf(await text(carried, '_rels/.rels'), /Target="(?:docProps\/custom|docMetadata\/LabelInfo)\.xml"/g), 1);
  }
});

test('with nothing to carry the same buffer comes back', async () => {
  const buf = await makeTracker();
  const out = await (await loadWorkbook(buf)).xlsx.writeBuffer();
  assert.equal(await carryOverPackageParts(buf, out), out);
});

test('the new relationship id never collides with one already there', async () => {
  const buf = await withCustomProperties(await makeTracker());
  const out = await (await loadWorkbook(buf)).xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(out);
  const rels = await zip.file('_rels/.rels').async('string');
  zip.file('_rels/.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdVaultOS1" Type="http://example.invalid/t" Target="x.xml"/><Relationship Id="rIdVaultOS2" Type="http://example.invalid/t" Target="y.xml"/></Relationships>'));
  const carried = await carryOverPackageParts(buf, await zip.generateAsync({ type: 'nodebuffer' }));
  const ids = [...(await text(carried, '_rels/.rels')).matchAll(/<Relationship\b[^>]*\bId="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('rIdVaultOS3'));
});

test('other parts are left byte for byte as they were', async () => {
  const buf = await withCustomProperties(await makeTracker());
  const { out, carried } = await saved(buf);
  const before = await JSZip.loadAsync(out);
  const after = await JSZip.loadAsync(carried);
  for (const name of Object.keys(before.files)) {
    if (before.files[name].dir || name === '[Content_Types].xml' || name === '_rels/.rels') continue;
    assert.deepEqual(await after.file(name).async('nodebuffer'), await before.file(name).async('nodebuffer'), name);
  }
});

test('docProps parts that are not carried over are still a loss', async () => {
  const r = await check(await inject(await makeTracker(), { 'docProps/extra.xml': '<x/>' }));
  assert.deepEqual(r.lost, ['document properties (such as sensitivity labels)']);
  assert.match(r.reason, /would lose document properties \(such as sensitivity labels\)/);
});

test('app.xml, core.xml and a thumbnail are rebuilt or irrelevant, not counted', async () => {
  const plain = await partCounts(await inject(await makeTracker(), { 'docProps/thumbnail.jpeg': 'x' }));
  assert.ok(![...plain.keys()].some((n) => n.startsWith('docProps/')));
});

test('the check is by count: two drawings in, one out is a loss', async () => {
  const pic = await withPicture();
  assert.equal((await check(pic)).editable, true);
  const r = await check(await inject(pic, { 'xl/drawings/drawing7.xml': '<xdr:wsDr/>' }));
  assert.equal(r.editable, false);
  assert.deepEqual(r.lost, ['shapes or pictures']);
});

// the first sheet's drawing with one more anchor in it: a text box (an xdr:sp shape)
async function withTextBox(buf) {
  const zip = await JSZip.loadAsync(buf);
  const name = Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
  const xml = await zip.file(name).async('string');
  const box = '<xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
    + '<xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
    + '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="9" name="TextBox 1"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>'
    + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
    + '<xdr:txBody><a:bodyPr/><a:p><a:r><a:t>note</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>';
  assert.match(xml, /<\/xdr:wsDr>/);
  zip.file(name, xml.replace('</xdr:wsDr>', box + '</xdr:wsDr>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('a text box in a drawing that also holds a picture is a loss, though the part count holds', async () => {
  const buf = await withTextBox(await withPicture());
  const before = await partCounts(buf);
  const wb = await loadWorkbook(buf);
  const out = await wb.xlsx.writeBuffer();
  assert.deepEqual([...await partCounts(out)], [...before], 'same parts in and out');
  const r = await checkEditable(buf, wb);
  assert.equal(r.editable, false);
  assert.ok(r.lost.includes('shapes or pictures'));
  assert.match(r.reason, /would lose shapes or pictures/);
});

test('drawingAnchors counts anchors whatever the namespace prefix, in drawings only', async () => {
  const buf = await inject(await makeTracker(), {
    'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="x"><xdr:twoCellAnchor/><xdr:oneCellAnchor></xdr:oneCellAnchor><xdr:absoluteAnchor/></xdr:wsDr>',
    'xl/drawings/drawing2.xml': '<wsDr xmlns="x"><twoCellAnchor><from/></twoCellAnchor><a:twoCellAnchorX/></wsDr>',
    'xl/drawings/vmlDrawing1.vml': '<twoCellAnchor/>',
    'xl/charts/chart1.xml': '<twoCellAnchor/>',
  });
  assert.equal(await drawingAnchors(buf), 4);
});

test('part folders map to plain names, de-duplicated, in a stable order', async () => {
  const parts = {
    'xl/charts/chart1.xml': '<c/>', 'xl/charts/chart2.xml': '<c/>',
    'xl/drawings/drawing1.xml': '<d/>',
    'xl/pivotTables/pivotTable1.xml': '<p/>', 'xl/pivotCache/pivotCacheDefinition1.xml': '<p/>',
    'xl/persons/person.xml': '<p/>', 'xl/threadedComments/threadedComment1.xml': '<t/>',
    'xl/externalLinks/externalLink1.xml': '<e/>',
    'xl/vbaProject.bin': 'x',
    'xl/slicers/slicer1.xml': '<s/>', 'xl/timelines/timeline1.xml': '<t/>',
    'xl/ctrlProps/ctrlProp1.xml': '<c/>',
    'xl/queryTables/queryTable1.xml': '<q/>',
  };
  const buf = await inject(await makeTracker(), parts);
  const a = await check(buf);
  const b = await check(buf);
  assert.deepEqual(a, b);
  assert.deepEqual([...a.lost].sort(), [
    'charts', 'form controls', 'links to other workbooks', 'macros', 'pivot tables', 'queryTables',
    'shapes or pictures', 'slicers', 'threaded comments', 'timelines',
  ]);
  assert.equal(new Set(a.lost).size, a.lost.length);
  assert.match(a.reason, /^Saving here would lose .+ — edit it in Excel$/);
});

// What ExcelJS's writer edits in a workbook it writes: conditional-format rules (it stamps dxfId and a
// ref on each, numbers rules without a priority). cellSignature hides exactly those, so this reads the
// workbook raw: every sheet's conditional formats and its whole model.
function rawSnapshot(wb) {
  return wb.worksheets.map((ws) => JSON.stringify([ws.conditionalFormattings, ws.model]));
}

test('checkEditable leaves the workbook as it found it', async () => {
  for (const make of [makeTracker, makePack]) {
    const buf = await make();
    const wb = await loadWorkbook(buf);
    const signature = cellSignature(wb);
    const raw = rawSnapshot(wb);
    await checkEditable(buf, wb);
    assert.deepEqual(cellSignature(wb), signature);
    assert.deepEqual(rawSnapshot(wb), raw);
  }
});

test('the raw snapshot does see what a direct write does to a workbook', async () => {
  const wb = await loadWorkbook(await makeTracker());
  const raw = rawSnapshot(wb);
  await wb.xlsx.writeBuffer();
  assert.notDeepEqual(rawSnapshot(wb), raw);
});

// `wb` is what the person sees; the check compares it with what a save of `srcBuf` would give. A wb
// edited after loading stands in for a save that came out different.
async function checkAgainst(srcBuf, edit) {
  const wb = await loadWorkbook(await makeTracker());
  edit(wb.worksheets[0]);
  return checkEditable(srcBuf, wb);
}

test('merges that do not survive the save are a loss', async () => {
  const r = await checkAgainst(await makeTracker(), (ws) => ws.unMergeCells('A2:G2'));
  assert.equal(r.editable, false);
  assert.deepEqual(r.lost, ['merged cells']);
  assert.match(r.reason, /would lose merged cells/);
});

test('column widths that do not survive the save are a loss', async () => {
  const r = await checkAgainst(await makeTracker(), (ws) => { ws.getColumn(2).width = 5; });
  assert.deepEqual(r.lost, ['column widths']);
});

test('losses from parts and from sheet details are listed together', async () => {
  const src = await inject(await makeTracker(), { 'xl/charts/chart1.xml': '<c/>' });
  const r = await checkAgainst(src, (ws) => ws.unMergeCells('A2:G2'));
  assert.deepEqual(r.lost, ['charts', 'merged cells']);
  assert.match(r.reason, /would lose charts and merged cells/);
});

test('a one-cell merge is a loss too: ExcelJS drops it on save', async () => {
  const zip = await JSZip.loadAsync(await makeTracker());
  const part = zip.file(/^xl\/worksheets\/sheet1\.xml$/)[0];
  const xml = (await part.async('string')).replace(/<mergeCells count="(\d+)">/, (_m, n) => `<mergeCells count="${Number(n) + 1}"><mergeCell ref="B5"/>`);
  assert.match(xml, /<mergeCell ref="B5"\/>/);
  zip.file('xl/worksheets/sheet1.xml', xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const wb = await loadWorkbook(buf);
  assert.ok(cellSignature(wb)[0].merges.includes('B5'));
  const r = await checkEditable(buf, wb);
  assert.deepEqual(r.lost, ['merged cells']);
});

test('a save that cannot be read back is not editable', async () => {
  const r = await checkAgainst(Buffer.from('not a zip'), () => {});
  assert.equal(r.editable, false);
  assert.ok(r.lost.length > 0);
});

// ---- cellSignature ----------------------------------------------------------------

test('cellSignature is deterministic and JSON-safe', async () => {
  const buf = await makeTracker();
  const a = cellSignature(await loadWorkbook(buf));
  const b = cellSignature(await loadWorkbook(buf));
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('cellSignature covers sheets, merges (including their non-masters), rows and columns', async () => {
  const sig = cellSignature(await loadWorkbook(await makeTracker()));
  assert.equal(sig.length, 1);
  const s = sig[0];
  assert.equal(s.name, 'Tracker');
  assert.equal(s.state, 'visible');
  assert.deepEqual(s.merges, ['A16:G16', 'A2:G2']);
  assert.equal(s.cols[0].width, 30);
  assert.equal(s.rows[1].height, 30);
  assert.equal(s.printArea, 'A1:G20');
  assert.ok(s.cells.G2, 'a merged non-master is present');
  assert.ok(s.cells.B2, 'so is every other cell of the band');
  assert.equal(s.cells.A3[0], 'Task 01');
  assert.equal(s.cells.F4[0], 'Open');
});

test('cellSignature: values, formulas, rich text and links read as plain data', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('V');
  ws.getCell('A1').value = { richText: [{ text: 'Hel' }, { font: { bold: true }, text: 'lo' }] };
  ws.getCell('A2').value = { text: 'site', hyperlink: 'https://example.invalid/' };
  ws.getCell('A3').value = { formula: 'SUM(1,2)', result: 3 };
  ws.getCell('A4').value = new Date(Date.UTC(2026, 0, 2));
  const sig = cellSignature(await loadWorkbook(await wb.xlsx.writeBuffer()))[0];
  assert.equal(sig.cells.A1[0], 'Hello');
  assert.deepEqual(sig.cells.A2[0], { text: 'site', hyperlink: 'https://example.invalid/' });
  assert.deepEqual(sig.cells.A3[0], { formula: 'SUM(1,2)', result: 3 });
  assert.equal(sig.cells.A4[0], '2026-01-02T00:00:00.000Z');
});

test('cellSignature differs when a cell border changes', async () => {
  const buf = await makeTracker();
  const wb = await loadWorkbook(buf);
  const before = cellSignature(wb);
  const cell = wb.worksheets[0].getCell('C5');
  cell.style = { ...JSON.parse(JSON.stringify(cell.style)), border: { bottom: { style: 'thin', color: { argb: 'FF000000' } } } };
  const after = cellSignature(wb);
  assert.notDeepEqual(after, before);
  assert.notDeepEqual(after[0].cells.C5, before[0].cells.C5);
  assert.deepEqual(after[0].cells.C4, before[0].cells.C4);
});

test('cellSignature: empty fills and borders compare equal to none', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 'a';
  ws.getCell('B1').value = 'a';
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'none' };
  ws.getCell('A1').border = {};
  const sig = cellSignature(await loadWorkbook(await wb.xlsx.writeBuffer()))[0];
  assert.deepEqual(sig.cells.A1, sig.cells.B1);
  assert.equal(sig.cells.A1[3], null);   // fill
  assert.equal(sig.cells.A1[4], null);   // border
});

test('cellSignature: equal data stringifies alike whatever order its keys were in', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 1;
  ws.getCell('B1').value = 1;
  ws.getCell('A1').font = { bold: true, size: 11, name: 'Calibri' };
  ws.getCell('B1').font = { name: 'Calibri', size: 11, bold: true };
  const sig = cellSignature(wb);
  assert.equal(JSON.stringify(sig[0].cells.A1), JSON.stringify(sig[0].cells.B1));
});

test('a plain save changes nothing the signature can see', async () => {
  for (const make of [makeTracker, makePack, withPicture]) {
    const wb = await loadWorkbook(await make());
    const before = cellSignature(wb);
    const again = await loadWorkbook(await wb.xlsx.writeBuffer());
    assert.deepEqual(cellSignature(again), before);
    assert.equal(JSON.stringify(cellSignature(again)), JSON.stringify(before));
    assert.deepEqual(cellSignature(wb), before, 'the writer left the workbook alone as far as the signature goes');
  }
});

// ---- Fix round 1: dependent dropdowns, notes, page breaks ---------------------------------------

const DEPENDENT = 'dropdowns that depend on other cells';

// a sheet S with a list validation on C3:C6 whose source is `formula`, and a Lists sheet beside it
const withList = (formula, type = 'list') => async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  const lists = wb.addWorksheet('Lists');
  ['a', 'b', 'c'].forEach((v, i) => { lists.getCell(i + 1, 1).value = v; ws.getCell(`B${i + 3}`).value = v; });
  for (let r = 3; r <= 6; r++) ws.getCell(`C${r}`).dataValidation = { type, allowBlank: true, formulae: [formula] };
  return wb.xlsx.writeBuffer();
};

test('Ruling 18: a validation formula with a relative row reference makes the workbook view-only', async () => {
  for (const [formula, type] of [['INDIRECT($B3)'], ['Lists!A1:A3'], ["'Lists'!$A1:$A3"], ['LEN(B3)<5', 'custom'], ['$B3:$B6']]) {
    const r = await check(await withList(formula, type)());
    assert.equal(r.editable, false, formula);
    assert.deepEqual(r.lost, [DEPENDENT], formula);
    assert.equal(r.reason, `Saving here would lose ${DEPENDENT} — edit it in Excel`);
  }
});

test('Rulings 18, 26: literal lists and fully absolute references stay editable', async () => {
  for (const formula of ['"a,b,c"', '$B$3:$B$5', 'Lists!$A$1:$A$3', "'Lists'!$A$1:$A$3", 'Lists!$A:$A', 'INDIRECT("Lists!A1")', 'StatusList']) {
    assert.deepEqual(await check(await withList(formula)()), { editable: true, lost: [], reason: null }, formula);
  }
});

// ExcelJS writes a note on a cell with no value but drops it when it reads the file back
async function withNotes({ onBlank }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 'x';
  ws.getCell('A1').note = 'kept';
  if (onBlank) ws.getCell('C5').note = 'on a blank cell';
  return wb.xlsx.writeBuffer();
}

test('Ruling 22: a note the reader drops makes the workbook view-only', async () => {
  const buf = await withNotes({ onBlank: true });
  assert.match(await text(buf, 'xl/comments1.xml'), /on a blank cell/);
  const r = await check(buf);
  assert.deepEqual(r.lost, ['notes']);
  assert.match(r.reason, /would lose notes/);
  assert.deepEqual(await check(await withNotes({ onBlank: false })), { editable: true, lost: [], reason: null });
});

test('Ruling 23: manual page breaks make the workbook view-only', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  for (let r = 1; r <= 10; r++) ws.getCell(r, 1).value = r;
  ws.getRow(5).addPageBreak();
  const buf = await wb.xlsx.writeBuffer();
  assert.match(await text(buf, 'xl/worksheets/sheet1.xml'), /<brk /);
  const r = await check(buf);
  assert.deepEqual(r.lost, ['page breaks']);
  assert.match(r.reason, /would lose page breaks/);
});

// ---- Fix round 1b: relative columns, cell-bounded rules, hidden and grouped rows -----------------

const CELL_BOUNDS = 'validation rules that refer to other cells';
const VALIDATIONS = 'validation rules';
const ROW_STATES = 'hidden or grouped rows';
const sayList = (items) => (items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

// sheet S with one validation on `ref` (cells made per row and column)
const withRule = (ref, rule) => async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  wb.addWorksheet('Lists').getCell('A1').value = 'a';
  ws.getCell('B1').value = 5;
  const [from, to] = ref.split(':');
  const a = /^([A-Z])(\d+)$/.exec(from);
  const b = /^([A-Z])(\d+)$/.exec(to || from);
  for (let c = a[1].charCodeAt(0); c <= b[1].charCodeAt(0); c++) {
    for (let r = Number(a[2]); r <= Number(b[2]); r++) ws.getCell(`${String.fromCharCode(c)}${r}`).dataValidation = rule;
  }
  return wb.xlsx.writeBuffer();
};

test('Ruling 26a: a relative column reference counts too, as do relative whole columns', async () => {
  for (const [ref, formula] of [['C3:D6', 'B$3:B$5'], ['C3:C6', 'B$3:B$5'], ['C3:C6', 'Lists!A:A'], ['C3:C6', 'Lists!$A:A']]) {
    const r = await check(await withRule(ref, { type: 'list', allowBlank: true, formulae: [formula] })());
    assert.deepEqual(r.lost, [DEPENDENT], `${ref} ${formula}`);
  }
});

test('Ruling 26b: a number, date or custom rule bounded by a cell or a formula is view-only', async () => {
  // ExcelJS also rewrites the number bounds (parseInt / parseFloat: NaN), so those are lost as rules too
  const rules = [
    [{ type: 'whole', operator: 'between', formulae: ['$B$1', 10] }, [CELL_BOUNDS, VALIDATIONS]],
    [{ type: 'decimal', operator: 'lessThan', formulae: ['$B$1'] }, [CELL_BOUNDS, VALIDATIONS]],
    [{ type: 'textLength', operator: 'lessThanOrEqual', formulae: ['Lists!$A$1'] }, [CELL_BOUNDS, VALIDATIONS]],
    [{ type: 'custom', formulae: ['$B$1>0'] }, [CELL_BOUNDS]],
  ];
  for (const [rule, lost] of rules) {
    const r = await check(await withRule('C3:C6', { allowBlank: true, ...rule })());
    assert.deepEqual(r.lost, lost, rule.type);
    assert.equal(r.reason, `Saving here would lose ${sayList(lost)} — edit it in Excel`);
  }
});

test('Ruling 26b: rules bounded by plain numbers and dates stay editable', async () => {
  const rules = [
    { type: 'whole', operator: 'between', formulae: [1, 10] },
    { type: 'decimal', operator: 'between', formulae: [0.5, 2.5] },
    { type: 'textLength', operator: 'lessThanOrEqual', formulae: [20] },
    { type: 'date', operator: 'between', formulae: [new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31))] },
  ];
  for (const rule of rules) {
    assert.deepEqual(await check(await withRule('C3:C6', { allowBlank: true, ...rule })()), { editable: true, lost: [], reason: null }, rule.type);
  }
});

test('Ruling 26: each validation is named once, relative references first', async () => {
  const buf = await (async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('B1').value = 1;
    ws.getCell('C3').dataValidation = { type: 'custom', formulae: ['LEN(B3)<5'] };          // relative: named once, as a dependent one
    ws.getCell('D3').dataValidation = { type: 'whole', operator: 'between', formulae: ['$B$1', 9] };
    return wb.xlsx.writeBuffer();
  })();
  assert.deepEqual((await check(buf)).lost, [DEPENDENT, CELL_BOUNDS, VALIDATIONS]);
});

// rows 1–3 and 7–8 hold values; `rowXml` is put in before row 7, as Excel writes an empty row it hides or groups
async function withBareRow(rowXml) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  for (const r of [1, 2, 3, 7, 8]) ws.getCell(r, 1).value = r;
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<row r="7"/);
  zip.file('xl/worksheets/sheet1.xml', xml.replace('<row r="7"', `${rowXml}<row r="7"`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Ruling 25: an empty hidden or grouped row makes the workbook view-only', async () => {
  for (const row of ['<row r="5" hidden="1"/>', '<row r="5" hidden="true"/>', '<row r="5" outlineLevel="1"/>', '<row r="5" spans="1:1" hidden="1" outlineLevel="2" collapsed="1"></row>']) {
    const buf = await withBareRow(row);
    const r = await check(buf);
    assert.deepEqual(r.lost, [ROW_STATES], row);
    assert.match(r.reason, /would lose hidden or grouped rows/);
  }
});

test('Ruling 25: a hidden or grouped row with a value stays editable and saves as it was', async () => {
  const src = await (async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 6; r++) ws.getCell(r, 1).value = r;
    ws.getRow(4).hidden = true;
    ws.getRow(5).outlineLevel = 1;
    return wb.xlsx.writeBuffer();
  })();
  assert.deepEqual(await check(src), { editable: true, lost: [], reason: null });
  const wb = await loadWorkbook(src);
  applyOps(wb, [{ op: 'set', sheet: 0, r: 0, c: 1, v: 'edited' }]);
  const ws = (await loadWorkbook(await writeVerified(wb, src))).worksheets[0];
  assert.equal(ws.getRow(4).hidden, true);
  assert.equal(ws.getRow(5).outlineLevel, 1);
  assert.equal(ws.getCell('B1').value, 'edited');
});

// ---- Fix round 2: validation formulas as written --------------------------------------------------

// sheet S (B1 = 5, A3 = 'abc') with one <dataValidation> on C3:C6 written straight into the XML, as Excel would
async function withRawRule(attrs, formula1, formula2) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('B1').value = 5;
  ws.getCell('A3').value = 'abc';
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const f = (n, v) => (v === undefined ? '' : `<formula${n}>${v}</formula${n}>`);
  const dv = `<dataValidations count="1"><dataValidation ${attrs} allowBlank="1" sqref="C3:C6">${f(1, formula1)}${f(2, formula2)}</dataValidation></dataValidations>`;
  assert.match(xml, /<pageMargins/);
  zip.file('xl/worksheets/sheet1.xml', xml.replace('<pageMargins', `${dv}<pageMargins`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Finding 9: a bound that only starts with a number is caught from the raw formula', async () => {
  for (const [attrs, f1, f2] of [
    ['type="whole" operator="lessThan"', '10+$B$1'],
    ['type="textLength" operator="lessThanOrEqual"', '255-LEN(A3)'],
    ['type="decimal" operator="lessThan"', '0.2*$B$1'],
    ['type="date" operator="greaterThan"', '45000+$B$1'],
    ["type='whole'", '1', '10*$B$1'],
  ]) {
    const buf = await withRawRule(attrs, f1, f2);
    const r = await check(buf);
    assert.equal(r.editable, false, f1);
    assert.ok(r.lost.includes(VALIDATIONS), `${f1}: ExcelJS rewrites it`);
    assert.ok(r.lost.includes(CELL_BOUNDS) || r.lost.includes(DEPENDENT), f1);
  }
  assert.ok((await check(await withRawRule('type="textLength" operator="lessThanOrEqual"', '255-LEN(A3)'))).lost.includes(DEPENDENT));
});

test('Finding 9: a bound ExcelJS would rewrite (1E3, 10.5 in a whole-number rule) is lost as a rule', async () => {
  for (const f1 of ['1E3', '10.5']) {
    const r = await check(await withRawRule('type="whole" operator="between"', f1, '20000'));
    assert.deepEqual(r.lost, [VALIDATIONS], f1);
    assert.match(r.reason, /would lose validation rules — edit it in Excel$/);
  }
});

test('Finding 9: plain bounds and literal lists written by hand stay editable', async () => {
  for (const [attrs, f1, f2] of [
    ['type="whole" operator="between"', '1', '10'],
    ['type="decimal" operator="between"', '-0.5', '2.25'],
    ['type="date" operator="between"', '45000', '45300'],
    ['type="time" operator="lessThan"', '0.5'],
    ['type="list"', '&quot;Open,In Progress,Closed&quot;'],
    ['type="list"', '$B$1:$B$3'],
  ]) {
    assert.deepEqual(await check(await withRawRule(attrs, f1, f2)), { editable: true, lost: [], reason: null }, f1);
  }
});

test('Finding 9: x14 validations, which ExcelJS never reads, are lost as rules', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('S').getCell('A1').value = 1;
  wb.addWorksheet('Lists').getCell('A1').value = 'a';
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const ext = '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
    + '<x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1">'
    + '<x14:formula1><xm:f>Lists!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>C3:C6</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>';
  zip.file('xl/worksheets/sheet1.xml', xml.replace('</worksheet>', `${ext}</worksheet>`));
  const r = await check(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(r.lost, [VALIDATIONS]);
});
