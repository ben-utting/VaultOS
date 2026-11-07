// Every place the frontend puts server-rendered markdown (`.html`) or a diagram (`.svg`) into the
// page must go through safeHtml()/safeSvg() (public/safe-html.js). Without that, raw HTML in any
// vault .md, such as <img onerror=…>, runs script on VaultOS's origin. This is a static guard:
// it reads the source, so a new render site that forgets the wrapper fails here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const SKIP = new Set(['purify.min.js', 'safe-html.js']);
const files = fs.readdirSync(PUB).filter((f) => f.endsWith('.js') && !SKIP.has(f));

// `x.html` / `x.svg` used as markup: assigned to innerHTML/outerHTML, or interpolated into a template.
const SINKS = [
  /(?:inner|outer)HTML\s*=\s*([A-Za-z_$][\w$]*)\.(html|svg)\b(?!\s*\()/g,
  /\$\{\s*([A-Za-z_$][\w$]*)\.(html|svg)\b(?!\s*\()/g,
];

test('rendered markdown and diagrams reach the page only through safeHtml/safeSvg', () => {
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(PUB, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of SINKS) {
        re.lastIndex = 0;
        if (re.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(bad, [], 'unsanitised render site(s):\n' + bad.join('\n'));
});

test('the known render sites are wrapped', () => {
  const src = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
  const app = src('app.js');
  assert.match(app, /\$\('d-body'\)\.innerHTML = safeHtml\(t\.html\)/);
  assert.match(app, /\$\('docv-body'\)\.innerHTML = safeHtml\(d\.html\)/);
  assert.match(app, /\$\{safeHtml\(a\.html\)\}/);
  assert.match(app, /stage\.innerHTML = safeSvg\(d\.svg\)/);
  assert.strictEqual((app.match(/slot\.innerHTML = safeSvg\(d\.svg\)/g) || []).length, 2);
  assert.match(src('workbench.js'), /\$\{safeHtml\(f\.html\)\}/);
  assert.match(src('notes.js'), /\$\{safeHtml\(f\.html\)\}/);
});

test('index.html loads DOMPurify, then safe-html.js, before app.js', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const at = (s) => html.indexOf(`<script src="${s}"></script>`);
  assert.ok(at('purify.min.js') > 0, 'purify.min.js not loaded');
  assert.ok(at('purify.min.js') < at('safe-html.js'), 'safe-html.js must load after purify.min.js');
  assert.ok(at('safe-html.js') < at('app.js'), 'safe-html.js must load before app.js');
  assert.match(fs.readFileSync(path.join(PUB, 'purify.min.js'), 'utf8').slice(0, 120), /DOMPurify 3\.4\.17/);
});
