// The built report template (scripts/build.mjs buildTemplate) and how the Node bundle carries it:
// the exact DESIGN 8.8 CSP with the hash of the inlined app script, the no-network scan, the
// footer anchors, the glyph atlas block, and src/node/report.js serving the built page, from the
// bundle and from a source checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  buildTemplate, bundle, cspFor, cspHash, scanForNetwork, checkAnchors, templateModuleSource, readGlyphAtlas,
  TEMPLATE_SOURCE_MODULE, REPORT_TEMPLATE_MARKER, DEV_TEMPLATE_IMPORT, BuildError, cliTemplate,
} from '../../scripts/build.mjs';
import * as sourceReport from '../../src/node/report.js';
import { makeSummary } from '../helpers/sample-summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tpl = buildTemplate({ root: ROOT });
const MAIN_RE = /<script id="ar-main">([\s\S]*?)<\/script>/;

test('the page CSP is the exact DESIGN 8.8 policy and hashes the inlined app script', () => {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(tpl.html);
  assert.ok(meta, 'CSP meta tag');
  const main = MAIN_RE.exec(tpl.html);
  assert.ok(main, 'ar-main script');
  assert.equal(main[1], tpl.appScript);
  assert.equal(meta[1], cspFor(cspHash(main[1])));
  assert.match(meta[1], /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'$/);
  // Only one executable script: every other script block is data or text.
  const scripts = [...tpl.html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts.filter((a) => !/type="(application\/json|text\/plain)"/.test(a)), [' id="ar-main"']);
});

test('the page passes the no-network scan and carries only the footer anchors', () => {
  assert.deepEqual(scanForNetwork(tpl.html), []);
  assert.deepEqual(checkAnchors(tpl.html).filter((h) => /^https?:/.test(h)), ['https://github.com/0xelitesystem/auditrail', 'https://elitesystem.ai/']);
  assert.ok(!tpl.html.includes('%%AR_'), 'an unfilled placeholder');
});

test('the app and worker scripts parse after escaping, and neither can end its script element', () => {
  for (const code of [tpl.appScript, tpl.workerScript]) {
    assert.doesNotThrow(() => new vm.Script(code));
    assert.ok(!/<\/script/i.test(code) && !code.includes('<!--'));
  }
  const worker = /<script type="text\/plain" id="ar-worker">([\s\S]*?)<\/script>/.exec(tpl.html);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.ok(worker && worker[1].includes("'" + version + "'"), 'the worker in the page carries the package version');
  assert.doesNotThrow(() => new vm.Script(worker[1]));
});

test('the glyph atlas is in the page once, as the ar-glyphs block, and the app does not bundle it again', () => {
  const atlas = readGlyphAtlas(ROOT);
  const block = /<script type="text\/plain" id="ar-glyphs">([^<]*)<\/script>/.exec(tpl.html);
  assert.ok(block);
  assert.equal(block[1], atlas.base64);
  assert.equal(block[1], fs.readFileSync(path.join(ROOT, 'src', 'core', 'card', 'glyphs.bin')).toString('base64'));
  assert.equal(tpl.html.split(atlas.base64.slice(0, 200)).length - 1, 1);
  assert.ok(tpl.appScript.includes("getElementById('ar-glyphs')"));
});

test('the Node bundle serves the built page: report.js gets the template, the atlas joined back in', async () => {
  const reportPath = path.join(ROOT, TEMPLATE_SOURCE_MODULE);
  const src = fs.readFileSync(reportPath, 'utf8');
  assert.equal(src.split(REPORT_TEMPLATE_MARKER).length - 1, 1, 'report.js keeps its build marker');
  const overridden = templateModuleSource(src, tpl.html, tpl.glyphs);
  assert.ok(!overridden.includes(tpl.glyphs.slice(0, 200)), 'the atlas is not copied into the template string');
  const res = bundle({ entry: reportPath, target: 'node', root: ROOT, overrides: new Map([[reportPath, overridden]]) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-build-test-'));
  try {
    const file = path.join(dir, 'report-bundle.mjs');
    fs.writeFileSync(file, res.code + '\nexport default __ar0;\n');
    const mod = (await import(pathToFileURL(file).href)).default;
    assert.equal(mod.loadTemplate(), tpl.html);
    const summary = makeSummary();
    const html = mod.renderReport(summary);
    const main = MAIN_RE.exec(html);
    assert.ok(html.includes('content="' + tpl.csp.replace(/'/g, '&#39;') + '"') || html.includes('content="' + tpl.csp + '"'), 'CSP unchanged after the data is injected');
    assert.equal(cspHash(main[1]), cspHash(tpl.appScript));
    const data = /<script type="application\/json" id="ar-data">([^<]*)<\/script>/.exec(html);
    assert.deepEqual(JSON.parse(data[1]), summary);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('templateModuleSource refuses a report.js without its marker', () => {
  assert.throws(() => templateModuleSource('export const x = 1;\n', tpl.html, tpl.glyphs), BuildError);
  const src = fs.readFileSync(path.join(ROOT, TEMPLATE_SOURCE_MODULE), 'utf8');
  assert.throws(() => templateModuleSource(src.replace(DEV_TEMPLATE_IMPORT, ''), tpl.html, tpl.glyphs), BuildError, 'without the dev-template import');
});

test('source checkout: report.js serves the page built from src/web, never the unbuilt template', () => {
  const page = sourceReport.loadTemplate();
  assert.ok(typeof page === 'string', 'a built page, not the static fallback');
  assert.ok(!page.includes('%%AR_'), 'an unfilled placeholder');
  assert.equal(page, cliTemplate(buildTemplate({ root: ROOT, mangle: false }).html), 'the CLI page, original names kept');
  const main = MAIN_RE.exec(page);
  assert.ok(main && main[1].length > 10_000, 'the app script is inlined');
  assert.deepEqual(scanForNetwork(page), []);
  const summary = makeSummary();
  const html = sourceReport.renderReport(summary);
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.equal(meta[1].replace(/&#39;/g, "'"), cspFor(cspHash(MAIN_RE.exec(html)[1])));
  const data = /<script type="application\/json" id="ar-data">([^<]*)<\/script>/.exec(html);
  assert.deepEqual(JSON.parse(data[1]), summary);
});

test('loadTemplate never serves a page with a build placeholder; without a page the static report is used', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'web', 'template.html'), 'utf8');
  assert.ok(raw.includes('%%AR_'));
  assert.equal(sourceReport.loadTemplate({ devTemplate: () => raw }), null);
  assert.equal(sourceReport.loadTemplate({ devTemplate: () => null }), null);
  const html = sourceReport.renderReport(makeSummary(), { template: null });
  assert.ok(html.includes('<h1>AUDITRAIL</h1>') && html.includes("script-src &#39;none&#39;"));
});

test('source checkout: the sandboxed scanner writes a report with the real app in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-src-report-'));
  try {
    const out = path.join(dir, 'report.html');
    const env = { ...process.env, HOME: dir, USERPROFILE: dir };
    for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'AUDITRAIL_DEBUG']) delete env[k];
    const cli = path.join(ROOT, 'src', 'node', 'cli.js');
    const fixture = path.join(ROOT, 'test', 'fixtures', 'golden-core', 'projects');
    const r = spawnSync(process.execPath, [cli, '--no-open', '--tz', 'UTC', '--dir', fixture, '--out', out], { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(!html.includes('%%AR_'));
    const main = MAIN_RE.exec(html);
    assert.ok(main && main[1].length > 10_000, 'the app script is inlined');
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    assert.equal(meta[1].replace(/&#39;/g, "'"), cspFor(cspHash(main[1])));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
