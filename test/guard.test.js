// Repository guards (DESIGN 9.7 fixture guard, plus the house rules for this public repo):
// 1. No en dash or em dash anywhere, in any text file.
// 2. No AI-authorship attribution anywhere.
// 3. Tests, fixtures, docs and README carry no real paths, emails or credential prefixes.
// Patterns are built from char codes so this file does not trip its own checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report', 'coverage', '.tmp', '__pycache__']);
const TEXT_EXT = /\.(m?js|cjs|json|jsonl|md|py|html|css|txt|ya?ml|svg)$|(^|\/)(LICENSE|NOTICE|\.gitignore|\.gitattributes)$|\.jsonl\.superseded-\d+$/;

function files() {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (TEXT_EXT.test(r)) out.push(r);
    }
  })(ROOT, '');
  return out;
}

const ALL = files();
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

// docs/index.html is a build output (scripts/make-demo.mjs): the report page from dist/ with the
// synthetic showcase summary embedded. Its executable scripts are this project's own source, which
// legitimately contains the secret-detector prefixes; dist/ is skipped everywhere for the same
// reason. Only those <script> elements are removed before the credential scan. The markup, the
// text and the embedded JSON data blocks, which is where a leak could actually land, stay in scope
// and are asserted below. Data blocks means application/json AND the application/ld+json block
// that scripts/make-demo.mjs writes into the head: the browser executes neither, neither comes
// from dist/, and a leak in either would be published, so both are scanned like any other text.
const GENERATED_PAGE = 'docs/index.html';
const APP_SCRIPT_RE = /<script(?![^>]*type="application\/(?:ld\+)?json")[^>]*>[\s\S]*?<\/script>/gi;
const scanText = (r) => (r === GENERATED_PAGE ? read(r).replace(APP_SCRIPT_RE, '') : read(r));
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

test('no en dash or em dash in any text file', () => {
  const bad = ALL.filter((r) => DASHES.test(read(r)));
  assert.deepEqual(bad, []);
});

test('no AI-authorship attribution', () => {
  const patterns = [
    new RegExp('co-authored' + '-by', 'i'),
    new RegExp('generated with \\[?' + 'claude', 'i'),
    new RegExp('noreply' + '@' + 'anthropic', 'i'),
  ];
  const bad = ALL.filter((r) => r !== SELF && patterns.some((p) => p.test(read(r))));
  assert.deepEqual(bad, []);
});

test('fixture guard: no real paths, emails or credential prefixes in tests, fixtures, docs or README', () => {
  const scoped = ALL.filter((r) => r !== SELF && (/^(test|docs|scripts\/fixtures)\//.test(r) || /^README/i.test(r)));
  const BS = String.fromCharCode(92);
  const patterns = [
    ['windows home path', new RegExp('[A-Z]:(' + BS + BS + '|' + BS + BS + BS + BS + '|/)Users(' + BS + BS + '|' + BS + BS + BS + BS + '|/)')],
    ['macOS home path', /\/Users\//],
    ['linux home path', /\/home\//],
    ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
    ['anthropic key prefix', new RegExp('sk-' + 'ant-(?!api03-CANARY)')],
    ['github token prefix', new RegExp('gh' + 'p_[A-Za-z0-9]')],
    ['aws key prefix', new RegExp('AK' + 'IA[A-Z0-9]{4}')],
  ];
  const bad = [];
  for (const r of scoped) {
    const text = scanText(r);
    for (const [label, re] of patterns) if (re.test(text)) bad.push(r + ': ' + label);
  }
  assert.deepEqual(bad, []);
});

test('the built demo page still exposes its embedded data to the fixture guard', () => {
  if (!ALL.includes(GENERATED_PAGE)) return; // docs/index.html is a build output; may not exist yet
  const text = scanText(GENERATED_PAGE);
  assert.match(text, /<script type="application\/json" id="ar-data">\{/, 'the embedded summary must stay in scope');
  assert.ok(text.length > 1000, 'stripping app scripts must not empty the file');
});

// The exemption above is only safe while the blocks it removes are BUILD OUTPUT FROM src, whose
// credential prefixes are this project's own secret-detector table. Prove that, rather than
// trusting it: every stripped block must appear verbatim inside dist/auditrail.html, which
// scripts/build.mjs produced from src/web in the same run. The one exception is the ar-worker
// block, which the CLI page deliberately leaves empty (scripts/build.mjs cliTemplate), so it is
// asserted to be empty instead. A block that carried data from someone's disk could satisfy
// neither, and would be back in scope of the credential scan.
test('the demo page exemption covers only build output, never data', () => {
  const DIST_PAGE = path.join(ROOT, 'dist', 'auditrail.html');
  if (!ALL.includes(GENERATED_PAGE) || !fs.existsSync(DIST_PAGE)) return; // both are build outputs
  const dist = fs.readFileSync(DIST_PAGE, 'utf8');
  const page = read(GENERATED_PAGE);
  const blocks = page.match(new RegExp(APP_SCRIPT_RE.source, 'gi')) ?? [];
  assert.ok(blocks.length >= 2, 'expected the glyph, worker and app blocks, got ' + blocks.length);
  const unaccounted = blocks.filter((b) => !dist.includes(b) && !/^<script[^>]*id="ar-worker"[^>]*><\/script>$/i.test(b));
  assert.deepEqual(unaccounted.map((b) => b.slice(0, 60)), [],
    'a stripped block of docs/index.html is not in dist/auditrail.html. If you just rebuilt dist, run: node scripts/make-demo.mjs');
  // And the strip is not silently removing the document: the markup, the footer notices and the
  // embedded Summary all stay in scope of the credential scan.
  const rest = scanText(GENERATED_PAGE);
  assert.ok(rest.length > 20000, 'stripping must leave the markup and the data behind, got ' + rest.length);
  assert.ok(rest.includes('id="ar-data"'), 'the embedded Summary must stay in scope');
  assert.ok(rest.includes('The Inter Project Authors'), 'the notices must stay in scope');
});
