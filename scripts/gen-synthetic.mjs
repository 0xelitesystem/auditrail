#!/usr/bin/env node
// Synthetic fixture generator (DESIGN 9.2, 9.3, 9.5, 9.7). Dev only; never shipped in dist/.
//
// Every fixture under test/fixtures/ is produced by a builder module in scripts/fixtures/.
// A builder is any scripts/fixtures/*.mjs whose name does not start with "_". It exports:
//   export const name = 'golden-core';            // output directory under --out
//   export function build(ctx) { return { files: [{ path, content }] }; }
// ctx = { seed, rng } where rng is a mulberry32 stream seeded from --seed and the builder name.
// Teams add fixtures by adding a builder file; this runner does not need to change.
//
// Usage:
//   node scripts/gen-synthetic.mjs                 write every builder into test/fixtures/
//   node scripts/gen-synthetic.mjs --check         regenerate in memory and diff against disk (CI)
//   node scripts/gen-synthetic.mjs --only golden-core --out <dir> --seed 42 --list
//
// Write mode replaces each builder's own directory only; other directories under --out are
// left alone. All content is fictional; the fixture guard test scans the output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mulberry32, fnv1a } from './fixtures/_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILDER_DIR = path.join(HERE, 'fixtures');

/**
 * @typedef {{ path: string, content: string|Uint8Array }} FixtureFile
 * @typedef {{ name: string, build: (ctx: { seed: number, rng: () => number }) => { files: FixtureFile[] } }} Builder
 */

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { out: path.join(ROOT, 'test', 'fixtures'), seed: 42, check: false, only: /** @type {string[]} */ ([]), list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--only') opts.only.push(argv[++i]);
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else throw new Error('unknown argument: ' + a);
  }
  if (!Number.isInteger(opts.seed)) throw new Error('--seed must be an integer');
  return opts;
}

/** @returns {Promise<Builder[]>} */
export async function loadBuilders() {
  const names = fs.readdirSync(BUILDER_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const out = [];
  for (const f of names) {
    const mod = await import(pathToFileURL(path.join(BUILDER_DIR, f)).href);
    if (typeof mod.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(mod.name) || typeof mod.build !== 'function') {
      throw new Error(`scripts/fixtures/${f}: must export a kebab-case "name" and a "build" function`);
    }
    out.push({ name: mod.name, build: mod.build });
  }
  const seen = new Set();
  for (const b of out) {
    if (seen.has(b.name)) throw new Error('duplicate builder name: ' + b.name);
    seen.add(b.name);
  }
  return out;
}

/**
 * Run one builder and return its files as normalized { rel, bytes } pairs.
 * @param {Builder} b
 * @param {number} seed
 * @returns {{ rel: string, bytes: Buffer }[]}
 */
export function runBuilder(b, seed) {
  const rng = mulberry32((seed ^ fnv1a(b.name)) >>> 0);
  const result = b.build({ seed, rng });
  if (!result || !Array.isArray(result.files)) throw new Error(b.name + ': build() must return { files: [...] }');
  const files = [];
  const seen = new Set();
  for (const f of result.files) {
    const rel = String(f.path).replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) throw new Error(b.name + ': bad path ' + rel);
    if (seen.has(rel)) throw new Error(b.name + ': duplicate path ' + rel);
    seen.add(rel);
    const bytes = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : Buffer.from(f.content);
    files.push({ rel, bytes });
  }
  files.sort((a, b2) => (a.rel < b2.rel ? -1 : a.rel > b2.rel ? 1 : 0));
  return files;
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('usage: node scripts/gen-synthetic.mjs [--check] [--out dir] [--seed 42] [--only name] [--list]\n');
    return 0;
  }
  let builders = await loadBuilders();
  if (opts.list) {
    for (const b of builders) process.stdout.write(b.name + '\n');
    return 0;
  }
  if (opts.only.length) {
    const unknown = opts.only.filter((n) => !builders.some((b) => b.name === n));
    if (unknown.length) throw new Error('unknown builder: ' + unknown.join(', '));
    builders = builders.filter((b) => opts.only.includes(b.name));
  }

  let problems = 0;
  for (const b of builders) {
    const files = runBuilder(b, opts.seed);
    const dir = path.join(opts.out, b.name);
    const bytes = files.reduce((a, f) => a + f.bytes.length, 0);
    if (opts.check) {
      const onDisk = listFiles(dir);
      const want = new Set(files.map((f) => f.rel));
      for (const rel of onDisk) if (!want.has(rel)) { problems++; process.stdout.write(`EXTRA   ${b.name}/${rel}\n`); }
      for (const f of files) {
        const p = path.join(dir, f.rel);
        if (!fs.existsSync(p)) { problems++; process.stdout.write(`MISSING ${b.name}/${f.rel}\n`); continue; }
        if (!fs.readFileSync(p).equals(f.bytes)) { problems++; process.stdout.write(`DIFFERS ${b.name}/${f.rel}\n`); }
      }
      process.stdout.write(`checked ${b.name}: ${files.length} files, ${bytes} bytes\n`);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      for (const f of files) {
        const p = path.join(dir, f.rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.bytes);
      }
      process.stdout.write(`wrote ${b.name}: ${files.length} files, ${bytes} bytes\n`);
    }
  }
  if (opts.check && problems) {
    process.stdout.write(`fixtures differ from the generator (${problems} problems). Run: node scripts/gen-synthetic.mjs\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exitCode = 2; });
}
