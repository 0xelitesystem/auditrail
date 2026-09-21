// The shipped single file (DESIGN 8.3, 8.10 layers a and c, 9.8 parity). The build runs into a
// temporary folder, then:
// - size: one file, under the 400 KB budget, importing only harmless node: builtins;
// - layer (a): the static no-network scan passes on the bundle, on the standalone page and on
//   the report page the bundle carries compressed (unpacked here and checked by SHA-256);
// - layer (c): a report the bundle writes carries the exact CSP with the hash of its only
//   executable script;
// - parity: the bundle (short names, tight spacing, packed page) computes exactly what the
//   source tree computes, on every fixture and every command: the report data, terminal
//   output, card PNG bytes, exports, secret locations and the ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  build, MAX_BUNDLE_BYTES, scanForNetwork, checkAnchors, cspFor, cspHash, cliTemplate, readGlyphAtlas,
  versionModuleSource, VERSION_FALLBACK, BuildError,
} from '../../scripts/build.mjs';
import { REPO, FIXTURES, CLI, tempDir } from '../node/helpers.js';

// The installed package layout: <pkg>/dist/auditrail.mjs next to <pkg>/package.json (the
// program reads its version from there).
const OUT = tempDir();
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(OUT, 'package.json'));
const built = build({ out: path.join(OUT, 'dist', 'auditrail.mjs'), htmlOut: path.join(OUT, 'dist', 'auditrail.html') });
const BUNDLE = /** @type {string} */ (built.out);
const CODE = fs.readFileSync(BUNDLE, 'utf8');
const PAGE = fs.readFileSync(/** @type {string} */ (built.htmlOut), 'utf8');

const ROOTS = {
  'golden-core': path.join(FIXTURES, 'golden-core', 'projects'),
  'golden-pricing': path.join(FIXTURES, 'golden-pricing', 'projects'),
  canary: path.join(FIXTURES, 'canary', 'projects'),
  'cache-miss-spender': path.join(FIXTURES, 'personas', 'cache-miss-spender', 'projects'),
  'solo-night-owl': path.join(FIXTURES, 'personas', 'solo-night-owl', 'projects'),
  'subagent-lead': path.join(FIXTURES, 'personas', 'subagent-lead', 'projects'),
};

/**
 * The report page inside the bundle: the one base64 string literal followed by a SHA-256 hex
 * literal (the arguments of the unpack call report.js gets from the build).
 * @returns {{ html: string, sha: string }}
 */
function embeddedPage() {
  const m = /"([A-Za-z0-9+/]{1000,}={0,2})","([0-9a-f]{64})"/.exec(CODE);
  assert.ok(m, 'the packed report page in the bundle');
  const atlas = readGlyphAtlas(REPO).base64;
  const html = zlib.brotliDecompressSync(Buffer.from(m[1], 'base64')).toString('utf8').split(String.fromCharCode(0)).join(atlas);
  return { html, sha: m[2] };
}

/**
 * Run a program (the bundle or src/node/cli.js) like a user would, HOME in a temporary folder.
 * @param {string} program
 * @param {string[]} args
 * @param {string} home
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
function run(program, args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'AUDITRAIL_DEBUG']) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * @template T
 * @param {(() => Promise<T>)[]} jobs
 * @param {number} width
 * @returns {Promise<T[]>}
 */
async function pool(jobs, width) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const k = next++; out[k] = await jobs[k](); } };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  return out;
}

/** @param {string} html */
const dataOf = (html) => {
  const m = /<script type="application\/json" id="ar-data">([^<]*)<\/script>/.exec(html);
  assert.ok(m, 'ar-data block');
  return JSON.parse(m[1]);
};

/**
 * Drop the fields that change from run to run (clock and timing), nothing else.
 * @param {any} v
 * @returns {any}
 */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'generatedAt' || k === 'takenAt' || k === 'updatedAt') continue;
      if (k === 'seconds' && typeof x === 'number') continue;
      o[k] = stable(x);
    }
    return o;
  }
  return v;
}

/**
 * Terminal text without its clock, timing and the run's own temporary folders.
 * @param {string} text
 * @param {string[]} dirs
 */
function stableText(text, dirs) {
  let t = text.replace(/\r\n/g, '\n');
  for (const d of dirs) t = t.split(d).join('<tmp>');
  return t
    .replace(/^scan taken .*$/gm, 'scan taken <clock>')
    .replace(/ in [0-9.]+ s, peak memory [0-9]+ MB/g, ' in <s> s, peak memory <mb> MB')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>');
}

/**
 * Everything a command leaves behind: exit code, terminal text, and every file it wrote under
 * the run folder (report data parsed, PNG bytes hashed, text files with the clock removed).
 * @param {string} program
 * @param {string} root
 * @param {string[]} cmd
 * @returns {Promise<{ result: Record<string, any>, minute: string }>}
 */
async function outcome(program, root, cmd) {
  const dir = tempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const args = cmd.map((a) => a.replace('<out>', path.join(dir, 'out')));
  const r = await run(program, [...args, '--dir', root, '--tz', 'UTC', '--no-open'], home);
  // The scan minute, taken before the clock is normalized away: the card prints the scan time to
  // the minute, so two runs are comparable only when they scanned in the same minute.
  const m = /^scan taken (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/m.exec(r.stdout);
  const minute = m ? m[1] : '';
  const res = { status: r.status, stdout: stableText(r.stdout, [dir]), stderr: stableText(r.stderr, [dir]) };
  const files = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const k = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(p, k); continue; }
      const buf = fs.readFileSync(p);
      const key = k.replace(/\d{4}-\d{2}-\d{2}-\d{4}/g, '<stamp>');
      if (/\.png$/.test(k)) files[key] = crypto.createHash('sha256').update(buf).digest('hex');
      else if (/\.html$/.test(k)) files[key] = stable(dataOf(buf.toString('utf8')));
      else if (/\.json$/.test(k)) files[key] = stable(JSON.parse(buf.toString('utf8')));
      else files[key] = stableText(buf.toString('utf8'), [dir]);
    }
  })(dir, '');
  return { result: { ...res, files }, minute };
}

test('dist is one file under the 400 KB budget and imports only harmless node: builtins', () => {
  assert.ok(built.bytes <= MAX_BUNDLE_BYTES, 'dist/auditrail.mjs is ' + built.bytes + ' bytes');
  assert.equal(Buffer.byteLength(CODE), built.bytes);
  assert.ok(CODE.startsWith('#!/usr/bin/env node\n'));
  const imports = [...CODE.matchAll(/^import\b.*$/gm)].map((m) => m[0]);
  assert.ok(imports.length > 0);
  for (const line of imports) assert.match(line, /^import \* as __arn_[a-z_]+ from 'node:(fs|path|os|url|util|crypto|zlib|child_process)';$/, line);
  assert.ok(!/\brequire\s*\(/.test(CODE), 'require(');
});

test('layer (a): the static scan passes on the bundle, the standalone page and the page the bundle carries', () => {
  assert.deepEqual(scanForNetwork(CODE), []);
  assert.deepEqual(scanForNetwork(PAGE), []);
  const { html, sha } = embeddedPage();
  assert.equal(crypto.createHash('sha256').update(html, 'utf8').digest('hex'), sha, 'the packed page matches its SHA-256');
  assert.equal(sha, built.cliTemplateSha256);
  assert.equal(html, cliTemplate(PAGE), 'the embedded page is the standalone page without the drop-mode worker');
  assert.deepEqual(scanForNetwork(html), []);
  assert.deepEqual(checkAnchors(html).filter((h) => /^https?:/.test(h)), ['https://github.com/0xelitesystem/auditrail', 'https://elitesystem.ai/']);
  // The worker block of the standalone page holds the drop-mode scanner; the embedded one is empty.
  assert.ok(/<script type="text\/plain" id="ar-worker">\n\(function/.test(PAGE));
  assert.ok(html.includes('<script type="text/plain" id="ar-worker"></script>'));
});

test('layer (c): a report written by the bundle has the exact CSP, hashing its only executable script', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'report.html');
  const r = await run(BUNDLE, ['--no-open', '--tz', 'UTC', '--dir', ROOTS['golden-core'], '--out', out], path.join(dir));
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  const meta = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  assert.equal(meta.length, 1);
  const csp = meta[0][1].replace(/&#39;/g, "'");
  const main = /<script id="ar-main">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(main);
  assert.equal(csp, cspFor(cspHash(main[1])));
  assert.match(csp, /default-src 'none'.*connect-src 'none'/);
  const executable = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]).filter((a) => !/type="(application\/json|text\/plain)"/.test(a));
  assert.deepEqual(executable, [' id="ar-main"']);
  assert.equal(String(dataOf(html).totals.valueNano), String(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-core', 'expected.json'), 'utf8')).valueNano));
});

test('privacy (DESIGN 9.7): the bundle\'s report from the canary corpus alone carries only the allowed canaries', async () => {
  const canaries = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canary', 'expected.json'), 'utf8')).canaries;
  for (const redact of [false, true]) {
    const dir = tempDir();
    const out = path.join(dir, 'report.html');
    const r = await run(BUNDLE, ['--no-open', '--tz', 'UTC', '--dir', ROOTS.canary, '--out', out, ...(redact ? ['--redact'] : [])], dir);
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(out, 'utf8');
    for (const [k, c] of Object.entries(canaries)) {
      const allowed = !redact && c.mayAppearIn.length > 0;
      if (!allowed) assert.ok(!html.includes(c.value), 'canary ' + k + ' in the report' + (redact ? ' with --redact' : ''));
      assert.ok(!(r.stdout + r.stderr).includes(c.value), 'canary ' + k + ' on the terminal');
    }
  }
});

test('parity: the bundle and the source tree produce the same results on every fixture and command', async () => {
  const commands = [
    ['--out', '<out>.html'],
    ['--redact', '--out', '<out>.html'],
    ['card', '--size', 'landscape', '--theme', 'dark', '--out', '<out>.png'],
    ['card', '--size', 'portrait', '--theme', 'light', '--out', '<out>.png'],
    ['audit', '--methods'],
    ['export', '--json', '--by', 'day', '--out', '<out>.json'],
    ['export', '--csv', '--by', 'project', '--out', '<out>.csv'],
    ['export', '--md', '--by', 'model', '--out', '<out>.md'],
    ['secrets', '--locations'],
    ['remember'],
  ];
  const jobs = [];
  for (const [name, root] of Object.entries(ROOTS)) {
    for (const cmd of commands) {
      jobs.push(async () => {
        // Re-run a pair that straddled a minute boundary (see outcome()); everything else is
        // compared exactly on the first try.
        let pair;
        for (let attempt = 0; attempt < 4; attempt++) {
          pair = await Promise.all([outcome(BUNDLE, root, cmd), outcome(CLI, root, cmd)]);
          if (pair[0].minute === pair[1].minute) break;
        }
        return { label: name + ': ' + cmd.filter((x) => !x.startsWith('<')).join(' '), a: pair[0].result, b: pair[1].result };
      });
    }
  }
  const results = await pool(jobs, 4);
  let compared = 0;
  for (const { label, a, b } of results) {
    assert.equal(a.status, 0, label + ' (bundle) exit ' + a.status + ': ' + a.stderr);
    assert.deepEqual(a, b, label);
    assert.ok(Object.keys(/** @type {object} */ (a.files)).length > 0 || /audit|secrets/.test(label), label + ' wrote nothing');
    compared++;
  }
  assert.equal(compared, Object.keys(ROOTS).length * commands.length);
});

test('the bundle carries its version: a copy without package.json reports it, never 0.0.0-unknown', async () => {
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  assert.ok(!CODE.includes(VERSION_FALLBACK), 'the fallback literal is replaced in the bundle');
  const dir = tempDir();
  const lone = path.join(dir, 'loose', 'copy.mjs');
  fs.mkdirSync(path.dirname(lone), { recursive: true });
  fs.copyFileSync(BUNDLE, lone);
  assert.ok(!fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'loose', 'package.json')));
  const r = await run(lone, ['--version'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'auditrail ' + version);
  // The installed layout still reads the same version.
  const inst = await run(BUNDLE, ['--version'], dir);
  assert.equal(inst.stdout.trim(), 'auditrail ' + version);
});

test('versionModuleSource replaces the one fallback and refuses anything else', () => {
  const src = "export function v() { return { version: " + VERSION_FALLBACK + " }; }\n";
  assert.equal(versionModuleSource(src, '1.2.3-beta.1'), "export function v() { return { version: '1.2.3-beta.1' }; }\n");
  assert.throws(() => versionModuleSource('export const x = 1;\n', '1.2.3'), BuildError);
  assert.throws(() => versionModuleSource(src + src, '1.2.3'), BuildError);
  assert.throws(() => versionModuleSource(src, "1.2.3'; evil()"), BuildError);
});

test('the bundle never carries the source-checkout page builder or the build script', () => {
  assert.ok(!built.modules.some((m) => /dev-template|scripts\//.test(m)), built.modules.join(', '));
  assert.ok(!CODE.includes('buildTemplate') && !CODE.includes('dev-template'));
});
