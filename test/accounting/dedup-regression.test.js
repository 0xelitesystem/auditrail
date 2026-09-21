// DESIGN 9.4 dedup regression on golden-core. The wrong methods must produce the wrong values the
// design lists, both through the audit diagnostics function (the one `audit --methods` and the
// README table use) and through an independent re-derivation from the raw lines in this file.
// If the accounting ever regresses to summing lines, keeping the first line, deduping per file
// or pricing every cache write at 5m, the correct total below turns into one of these numbers
// and the suite fails loudly with the method named.
//
// Plus the 9.4 property tests: file enumeration order, line interleaving across files and a
// duplicate copy of a file change nothing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipeline, toExpectedShape, FIXTURES } from './_harness.js';
import { methodsToJson, createPricer, priceResponse } from '../../src/core/accounting/index.js';
import { getPriceTable } from '../../src/core/prices/index.js';

const ROOT = path.join(FIXTURES, 'golden-core', 'projects');
const pricer = createPricer(getPriceTable());

// DESIGN 9.4, typed in: nanodollars and the ratio to the correct value at 3 decimals.
const DESIGN_9_4 = {
  correct: [42_080_000n, 1.0],
  sumEveryLine: [113_495_000n, 2.697],
  keepFirstLine: [29_975_000n, 0.712],
  dedupPerFile: [55_830_000n, 1.327],
  allWritesAt5m: [32_705_000n, 0.777],
  mainFilesOnly: [37_250_000n, 0.885],
};

/** @type {Awaited<ReturnType<typeof runPipeline>>} */
let base;
/** @type {string|null} */
let tmp = null;

before(async () => {
  base = await runPipeline(ROOT, { tz: 'UTC' });
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('9.4 diagnostics: every method returns the design value to the nanodollar', () => {
  const m = base.methods;
  for (const [k, [nano]] of Object.entries(DESIGN_9_4)) assert.equal(m[k], nano, k);
});

test('9.4 diagnostics: ratios to the correct value match the design at 3 decimals', () => {
  const j = methodsToJson(base.methods);
  for (const [k, [, ratio]] of Object.entries(DESIGN_9_4)) {
    assert.equal(Math.round(j[k].ratio * 1000) / 1000, ratio, k);
    assert.equal(j[k].valueNano, DESIGN_9_4[k][0].toString(), k + ' as a digit string');
  }
});

test('9.4 the correct total is none of the wrong-method values (a regression is named)', () => {
  const total = base.result.totals.valueNano;
  assert.equal(total, 42_080_000n);
  for (const k of ['sumEveryLine', 'keepFirstLine', 'dedupPerFile', 'allWritesAt5m', 'mainFilesOnly']) {
    assert.notEqual(total, DESIGN_9_4[k][0], 'the headline total equals the ' + k + ' wrong method');
  }
  assert.equal(base.methods.correct, total, 'diagnostics correct == headline total');
});

/**
 * Every response observation (usage line) in the parsed fixture, with its file.
 * @returns {{ ev: any, file: any }[]}
 */
function observations() {
  const out = [];
  for (const p of base.parsed) for (const ev of p.events) if (ev.kind === 'response') out.push({ ev, file: p.file });
  return out;
}
/** @param {any} ev @param {object} [o] */
const value = (ev, o) => BigInt(priceResponse(pricer, ev.rawModel, ev.usage, o).valueNano);

test('9.4 independent: summing every usage line gives $0.113495 (2.697x)', () => {
  const obs = observations();
  assert.equal(obs.length, 10);
  const naive = obs.reduce((a, o) => a + value(o.ev), 0n);
  assert.equal(naive, 113_495_000n);
  assert.notEqual(naive, base.result.totals.valueNano);
});

test('9.4 independent: keeping the first line per response gives $0.029975 (0.712x)', () => {
  const first = new Map();
  for (const o of observations()) {
    const k = o.ev.messageId;
    const cur = first.get(k);
    if (!cur || o.ev.ts < cur.ev.ts || (o.ev.ts === cur.ev.ts && o.file.depth < cur.file.depth)) first.set(k, o);
  }
  const v = [...first.values()].reduce((a, o) => a + value(o.ev), 0n);
  assert.equal(v, 29_975_000n);
  // Output is the running value: the first lines hold 5 + 10 + 2 + 7 = 24 of the 627 output tokens.
  assert.equal([...first.values()].reduce((a, o) => a + o.ev.usage.output, 0), 24);
});

test('9.4 independent: deduping per file instead of globally gives $0.055830 (1.327x, the fork counted twice)', () => {
  const perFile = new Map();
  for (const o of observations()) {
    const k = o.file.idx + ' ' + o.ev.messageId;
    const cur = perFile.get(k);
    if (!cur || o.ev.usage.output > cur.ev.usage.output) perFile.set(k, o);
  }
  assert.equal(perFile.size, 5, 'msg_02 survives once per file');
  const v = [...perFile.values()].reduce((a, o) => a + value(o.ev), 0n);
  assert.equal(v, 55_830_000n);
});

test('9.4 independent: correct dedup with every cache write at 5m gives $0.032705 (0.777x)', () => {
  const v = base.result.responses.reduce((a, r) => {
    const kept = observations().filter((o) => o.ev.messageId === r.key).sort((x, y) => y.ev.usage.output - x.ev.usage.output)[0];
    return a + value(kept.ev, { allWritesAt5m: true });
  }, 0n);
  assert.equal(v, 32_705_000n);
  // The 1h writes (2,500 tokens) are the whole gap: 2,000 Opus 5 1h + 500 Opus 5 1h at 10 - 6.25.
  assert.equal(base.result.totals.valueNano - v, 9_375_000n);
});

test('9.4 independent: main files only gives $0.037250 (0.885x)', () => {
  const main = new Map();
  for (const o of observations()) {
    if (o.file.fileClass !== 'main') continue;
    const cur = main.get(o.ev.messageId);
    if (!cur || o.ev.usage.output > cur.ev.usage.output) main.set(o.ev.messageId, o);
  }
  assert.equal([...main.values()].reduce((a, o) => a + value(o.ev), 0n), 37_250_000n);
});

/** Projection compared by the property tests (everything but scan receipts and dedup counters). */
function fingerprint(res, methods) {
  const e = toExpectedShape(res, methods);
  delete e.scan;
  delete e.dedup;
  return JSON.stringify(e);
}

test('9.4 property: reversing file enumeration order changes nothing', async () => {
  const rev = await runPipeline(ROOT, { tz: 'UTC', order: (refs) => refs.slice().reverse() });
  assert.equal(fingerprint(rev.result, rev.methods), fingerprint(base.result, base.methods));
  assert.deepEqual(rev.result.dedup, base.result.dedup);
});

test('9.4 property: interleaving lines across files (round robin and fully reversed) changes nothing', async () => {
  const roundRobin = (lists) => {
    const out = [];
    const n = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < n; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  };
  const reversed = (lists) => lists.flat().reverse();
  for (const interleave of [roundRobin, reversed]) {
    const x = await runPipeline(ROOT, { tz: 'UTC', interleave });
    assert.equal(fingerprint(x.result, x.methods), fingerprint(base.result, base.methods), interleave.name);
    assert.deepEqual(x.result.dedup, base.result.dedup, interleave.name);
  }
});

test('9.4 property: a duplicate copy of any file (orphaned or superseded variant) changes nothing', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dup-'));
  const src = ROOT;
  fs.cpSync(src, tmp, { recursive: true });
  const proj = path.join(tmp, '-fake-alpha');
  const mainName = fs.readdirSync(proj).find((n) => n.endsWith('.jsonl'));
  const sessionDir = path.join(proj, mainName.replace(/\.jsonl$/, ''), 'subagents');
  fs.copyFileSync(path.join(proj, mainName), path.join(proj, mainName + '.superseded-1'));
  fs.copyFileSync(path.join(sessionDir, 'agent-a1.jsonl'), path.join(sessionDir, '.orphaned-agent-a1.jsonl'));
  const dup = await runPipeline(tmp, { tz: 'UTC' });
  assert.equal(dup.refs.length, 4, 'both copies were discovered and read');
  assert.equal(fingerprint(dup.result, dup.methods).length > 0, true);
  const a = JSON.parse(fingerprint(dup.result, dup.methods));
  const b = JSON.parse(fingerprint(base.result, base.methods));
  // Summing lines and deduping per file are wrong precisely because they grow with copies:
  // they must move, everything else must not.
  assert.ok(BigInt(a.methods.sumEveryLine) > BigInt(b.methods.sumEveryLine), 'naive sum grows with a copy');
  assert.ok(BigInt(a.methods.dedupPerFile) > BigInt(b.methods.dedupPerFile), 'per-file dedup grows with a copy');
  for (const k of ['sumEveryLine', 'dedupPerFile']) { delete a.methods[k]; delete b.methods[k]; }
  assert.deepEqual(a, b);
  assert.equal(dup.result.totals.valueNano, 42_080_000n);
  assert.equal(dup.result.dedup.keys, 4);
});
