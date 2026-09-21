// DESIGN 9.3 golden-pricing, end to end over the fixture on disk, plus the shipped price table
// pinned to DESIGN 5.3. Every expected number is typed in from the design (not read from
// expected.json or cases.json), in micro-dollars where the design prints dollars.
//
// Cases: R5 fallback, R5b declined attempt, R6 Fable 5.1 cache-read footnote, R7 fast mode,
// R8 US inference geo, R9 dated model id, R12 TTL split mismatch, R13 missing TTL split,
// R10 unknown model (unpriced, tokens listed).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPipeline, FIXTURES } from './_harness.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { createPricer, priceResponse } from '../../src/core/accounting/index.js';
import { checkPriceTable } from '../../src/core/accounting/contract.js';
import { resolveTtl, billedParts } from '../../src/core/accounting/iterations.js';
import { normalizeUsage } from '../../src/core/adapters/claude-code/parse.js';
import { normalizeModelId } from '../../src/core/constants.js';

const ROOT = path.join(FIXTURES, 'golden-pricing', 'projects');
/** @param {number} micro micro-dollars @returns {number} nanodollars */
const micro = (micro) => micro * 1000;

/** @type {import('../../src/core/accounting/contract.js').AccountingResult} */
let r;
/** @type {Map<string, import('../../src/core/accounting/contract.js').ResponseRecord>} */
let byKey;
const pricer = createPricer(getPriceTable());

before(async () => {
  r = (await runPipeline(ROOT, { tz: 'UTC' })).result;
  byKey = new Map(r.responses.map((x) => [x.key, x]));
});

/** @param {string} id */
const resp = (id) => {
  const x = byKey.get('msg_p_' + id);
  assert.ok(x, 'response ' + id + ' present');
  return x;
};

test('shipped price table equals DESIGN 5.3 row by row and passes checkPriceTable', () => {
  const t = getPriceTable();
  assert.deepEqual(checkPriceTable(t), []);
  assert.equal(t.fetched, '2026-09-14');
  // id: [input, 5m write, 1h write, cache read, output, US geo 1.1x]
  const DESIGN_5_3 = {
    'claude-fable-5-1': [10, 12.5, 20, 0.25, 50, true],
    'claude-fable-5': [10, 12.5, 20, 1, 50, true],
    'claude-opus-5': [5, 6.25, 10, 0.5, 25, true],
    'claude-opus-4-8': [5, 6.25, 10, 0.5, 25, true],
    'claude-opus-4-7': [5, 6.25, 10, 0.5, 25, true],
    'claude-opus-4-6': [5, 6.25, 10, 0.5, 25, true],
    'claude-opus-4-5': [5, 6.25, 10, 0.5, 25, false],
    'claude-sonnet-5': [2, 2.5, 4, 0.2, 10, true],
    'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15, true],
    'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15, false],
    'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5, false],
  };
  assert.deepEqual(t.models.map((m) => m.id).sort(), Object.keys(DESIGN_5_3).sort());
  for (const m of t.models) {
    const [inp, w5, w1, rd, out, geo] = DESIGN_5_3[m.id];
    assert.deepEqual([m.input, m.cacheWrite5m, m.cacheWrite1h, m.cacheRead, m.output], [inp, w5, w1, rd, out], m.id);
    assert.equal(m.geoUsMultiplier, geo ? 1.1 : null, m.id + ' geo');
    const fastExpected = m.id === 'claude-opus-5' || m.id === 'claude-opus-4-8';
    assert.equal(m.fast !== null, fastExpected, m.id + ' fast row');
    if (fastExpected) {
      assert.deepEqual([m.fast.input, m.fast.cacheWrite5m, m.fast.cacheWrite1h, m.fast.cacheRead, m.fast.output], [10, 12.5, 20, 1, 50], m.id + ' fast');
    }
  }
});

test('9.3 fixture: 9 responses, 0 incomplete, 1 session', () => {
  assert.equal(r.totals.responses, 9);
  assert.equal(r.totals.incomplete, 0);
  assert.deepEqual([...byKey.keys()].sort(), ['R10', 'R12', 'R13', 'R5', 'R5b', 'R6', 'R7', 'R8', 'R9'].map((x) => 'msg_p_' + x).sort());
});

test('9.3 R5 fallback: Fable 5 attempt (in 1,000, out 50) billed plus Opus 4.8 (in 1,000, out 200) = $0.022500', () => {
  const x = resp('R5');
  assert.equal(x.valueNano, micro(22_500));
  assert.equal(x.parts.length, 2, 'both attempts billed');
  assert.deepEqual(x.parts.map((p) => [p.model, p.valueNano]), [['claude-fable-5', micro(12_500)], ['claude-opus-4-8', micro(10_000)]]);
  assert.deepEqual(x.tokens, { input: 2000, output: 250, cw5m: 0, cw1h: 0, cacheRead: 0 }, 'tokens are sums over billed attempts');
  assert.equal(x.model, 'claude-opus-4-8', 'top-level model is the fallback model');
});

test('9.3 R5 counterfactual: top-level usage only would be $0.010000', () => {
  const u = normalizeUsage({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, speed: 'standard' });
  assert.equal(priceResponse(pricer, 'claude-opus-4-8', u).valueNano, micro(10_000));
  assert.notEqual(resp('R5').valueNano, micro(10_000), 'the accounting must not ignore the billed first attempt');
});

test('9.3 R5b declined before output: Fable 5 (out 0) not billed, Opus 4.8 (in 800, out 100) = $0.006500', () => {
  const x = resp('R5b');
  assert.equal(x.valueNano, micro(6_500));
  assert.equal(x.parts.length, 1);
  assert.equal(x.parts[0].model, 'claude-opus-4-8');
  assert.deepEqual(x.tokens, { input: 800, output: 100, cw5m: 0, cw1h: 0, cacheRead: 0 });
});

test('9.3 R6 Fable 5.1: in 10, read 100,000, out 100 = $0.030100 (reads at 0.025x input)', () => {
  const x = resp('R6');
  assert.equal(x.model, 'claude-fable-5-1', 'exact id, never prefix-matched to claude-fable-5');
  assert.equal(x.valueNano, micro(30_100));
  assert.equal(x.bucketsNano.cacheRead, micro(25_000), '100,000 reads at $0.25/MTok');
});

test('9.3 R6 counterfactual: priced as Fable 5 it would be $0.105100', () => {
  const u = normalizeUsage({ input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, speed: 'standard' });
  assert.equal(priceResponse(pricer, 'claude-fable-5', u).valueNano, micro(105_100));
  assert.equal(priceResponse(pricer, 'claude-fable-5-1', u).valueNano, micro(30_100));
});

test('9.3 R7 fast mode on Opus 5: in 1,000, out 1,000 = $0.060000, counted as fast', () => {
  const x = resp('R7');
  assert.equal(x.valueNano, micro(60_000));
  assert.equal(x.fast, true);
  assert.equal(x.geoUs, false);
});

test('9.3 R8 US inference geo on Opus 5: in 1,000, out 1,000 = $0.033000 (1.1x)', () => {
  const x = resp('R8');
  assert.equal(x.valueNano, micro(33_000));
  assert.equal(x.geoUs, true);
  assert.equal(x.fast, false);
});

test('9.3 R9 dated id claude-haiku-4-5-20251001: in 1,000, out 1,000 = $0.006000', () => {
  const x = resp('R9');
  assert.equal(x.rawModel, 'claude-haiku-4-5-20251001');
  assert.equal(x.model, 'claude-haiku-4-5');
  assert.equal(x.valueNano, micro(6_000));
  assert.equal(normalizeModelId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(normalizeModelId('claude-fable-5-1'), 'claude-fable-5-1');
});

test('9.3 R12 TTL split mismatch: total 1,000, split 300 + 900 rescales to 5m 250, 1h 750 = $0.0093125', () => {
  const x = resp('R12');
  assert.deepEqual(x.tokens, { input: 0, output: 10, cw5m: 250, cw1h: 750, cacheRead: 0 });
  assert.equal(x.valueNano, 9_312_500);
  assert.equal(x.ttlEstimated, false);
  assert.deepEqual(resolveTtl(1000, { m5: 300, h1: 900 }), { cw5m: 250, cw1h: 750, ttlEstimated: false });
});

test('9.3 R13 missing TTL split: all 1,000 writes at 5m = $0.006500, ttlEstimated', () => {
  const x = resp('R13');
  assert.deepEqual(x.tokens, { input: 0, output: 10, cw5m: 1000, cw1h: 0, cacheRead: 0 });
  assert.equal(x.valueNano, micro(6_500));
  assert.equal(x.ttlEstimated, true);
});

test('9.3 R10 unknown model claude-imaginary-9: unpriced, never $0, 1,000 tokens listed', () => {
  const x = resp('R10');
  assert.equal(x.priced, false);
  assert.equal(x.parts[0].priced, false);
  assert.deepEqual(r.unpriced, [{ model: 'claude-imaginary-9', responses: 1, tokens: 1000 }]);
  assert.equal(r.allTokens - r.pricedTokens, 1000);
  assert.equal(pricer.has('claude-imaginary-9'), false);
  const m = r.byModel.find((b) => b.model === 'claude-imaginary-9');
  assert.equal(m.priced, false);
  assert.equal(m.valueNano, 0n);
});

test('9.3 fixture total for R5, R5b, R6, R7, R8, R9, R12, R13 = $0.1739125', () => {
  assert.equal(r.totals.valueNano, 173_912_500n);
  const sum = ['R5', 'R5b', 'R6', 'R7', 'R8', 'R9', 'R12', 'R13'].reduce((a, id) => a + resp(id).valueNano, 0);
  assert.equal(sum, 173_912_500);
  assert.equal(r.pricedTokens, 111_280);
  assert.equal(r.allTokens, 112_280);
});

test('9.3 modifier counts: fast 1, US geo 1, ttlEstimated 1, nothing else', () => {
  assert.deepEqual(r.modifiers, { fast: 1, geoUs: 1, nonStandardTier: 0, ttlEstimated: 1, webSearchRequests: 0 });
});

test('9.3 token totals across the fixture include both billed fallback attempts', () => {
  assert.deepEqual(r.totals.tokens, { input: 6310, output: 3970, cw5m: 1250, cw1h: 750, cacheRead: 100000 });
});

test('rule A8 edge: a declined entry is skipped only when it is not the last one', () => {
  const u = normalizeUsage({
    input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    iterations: [
      { type: 'message', model: 'claude-fable-5', input_tokens: 5, output_tokens: 7 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 5, output_tokens: 0 },
    ],
  });
  assert.deepEqual(billedParts(u, 'claude-opus-4-8').map((p) => p.model), ['claude-fable-5', 'claude-opus-4-8']);
});
