import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateToMilli, geoUsMilli, tokensToNano, sumNano, toBigNano, nanoToJson, nanoFromJson, isNanoString, nanoToCents,
  formatUsd, floorTwoSignificant, nanoToUsdNumber, formatUsdTwoSignificant, shareAtLeast, ratio, applyMultiplierMilli,
  NANO_PER_USD, WEB_SEARCH_NANO_PER_REQUEST,
} from '../../src/core/money.js';

test('every DESIGN 5.3 rate converts to an exact multiple of 10 milli', () => {
  const rates = [10, 12.5, 20, 0.25, 50, 1, 5, 6.25, 0.5, 25, 2, 2.5, 4, 0.2, 3, 3.75, 6, 0.3, 15, 1.25, 0.1];
  for (const r of rates) {
    const m = rateToMilli(r);
    assert.equal(m % 10, 0, String(r));
    assert.equal(m, Math.round(r * 1000));
    assert.equal(geoUsMilli(m) * 10, m * 11);
  }
});

test('rateToMilli rejects more than 3 decimals and bad input', () => {
  assert.throws(() => rateToMilli(0.0001), RangeError);
  assert.throws(() => rateToMilli(-1), RangeError);
  assert.throws(() => rateToMilli(NaN), RangeError);
  assert.equal(rateToMilli(0.025), 25);
});

test('geoUsMilli refuses rates that would not stay exact', () => {
  assert.equal(geoUsMilli(5000), 5500);
  assert.throws(() => geoUsMilli(25), RangeError);
});

test('golden-core value is 42,080,000 nanodollars by integer math (DESIGN 9.2)', () => {
  const opus = { input: 5000, output: 25000, cw1h: 10000, read: 500 };
  const sonnet = { input: 2000, output: 10000, cw5m: 2500, read: 200 };
  const r1 = tokensToNano(100, opus.input) + tokensToNano(2000, opus.cw1h) + tokensToNano(120, opus.output);
  const r2 = tokensToNano(50, opus.input) + tokensToNano(500, opus.cw1h) + tokensToNano(2000, opus.read) + tokensToNano(300, opus.output);
  const r3 = tokensToNano(10, sonnet.input) + tokensToNano(1000, sonnet.cw5m) + tokensToNano(200, sonnet.output);
  const r4 = tokensToNano(20, sonnet.input) + tokensToNano(1000, sonnet.read) + tokensToNano(7, sonnet.output);
  assert.deepEqual([r1, r2, r3, r4], [23_500_000, 13_750_000, 4_520_000, 310_000]);
  assert.equal(sumNano([r1, r2, r3, r4]), 42_080_000n);
  assert.equal(formatUsd(42_080_000, { decimals: 6 }), '$0.042080');
});

test('US geo is exact at the rate level (R8 = 33,000,000)', () => {
  assert.equal(tokensToNano(1000, geoUsMilli(5000)) + tokensToNano(1000, geoUsMilli(25000)), 33_000_000);
});

test('tokensToNano refuses unsafe results and non-integers', () => {
  assert.throws(() => tokensToNano(1.5, 10), RangeError);
  assert.throws(() => tokensToNano(-1, 10), RangeError);
  assert.throws(() => tokensToNano(2 ** 52, 50000), RangeError);
});

test('JSON money is a digit string; BigInt round trip is exact beyond 2^53', () => {
  const big = 12_345_678_901_234_567_890n;
  assert.equal(nanoToJson(big), '12345678901234567890');
  assert.equal(nanoFromJson('12345678901234567890'), big);
  assert.equal(nanoToJson(-5), '-5');
  assert.equal(toBigNano('42'), 42n);
  assert.ok(isNanoString('0'));
  assert.ok(!isNanoString('1.5'));
  assert.ok(!isNanoString(42));
  assert.throws(() => nanoFromJson('1e9'), TypeError);
  assert.throws(() => nanoFromJson(' 1'), TypeError);
  assert.throws(() => toBigNano(1.5), RangeError);
  assert.throws(() => JSON.stringify({ v: 1n }), TypeError, 'BigInt must never reach JSON directly');
});

test('cents round half up (away from zero for deltas)', () => {
  assert.equal(nanoToCents(4_999_999n), 0n);
  assert.equal(nanoToCents(5_000_000n), 1n);
  assert.equal(nanoToCents(42_080_000n), 4n);
  assert.equal(nanoToCents(-5_000_000n), -1n);
  assert.equal(nanoToCents(-4_999_999n), 0n);
});

test('formatUsd groups thousands and rounds at the requested decimals', () => {
  assert.equal(formatUsd(7_318_420_000_000n), '$7,318.42');
  assert.equal(formatUsd(42_080_000), '$0.04');
  assert.equal(formatUsd(9_312_500, { decimals: 7 }), '$0.0093125');
  assert.equal(formatUsd(173_912_500, { decimals: 7 }), '$0.1739125');
  assert.equal(formatUsd(1_234_567_890_123_456n, { decimals: 0 }), '$1,234,568');
  assert.equal(formatUsd(-1_500_000_000n), '-$1.50');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1, { decimals: 9 }), '$0.000000001');
  assert.throws(() => formatUsd(1, { decimals: 10 }), RangeError);
});

test('floor to two significant figures (card rule)', () => {
  assert.equal(floorTwoSignificant(7_318_420_000_000n), 7_300_000_000_000n);
  assert.equal(floorTwoSignificant(42_080_000n), 42_000_000n);
  assert.equal(floorTwoSignificant(99n), 99n);
  assert.equal(floorTwoSignificant(0n), 0n);
  assert.equal(floorTwoSignificant(1_999_999_999n), 1_900_000_000n);
  assert.throws(() => floorTwoSignificant(-1n), RangeError);
  assert.equal(nanoToUsdNumber(6_000_000_000_000n), 6000);
  assert.equal(nanoToUsdNumber(NANO_PER_USD), 1);
});

test('compact two-significant-figure card text keeps the trailing zero', () => {
  const cases = [
    [6_000_000_000_000n, '$6.0K'],
    [12_000_000_000_000n, '$12K'],
    [120_000_000_000_000n, '$120K'],
    [1_200_000_000_000_000n, '$1.2M'],
    [4_200_000_000n, '$4.2'],
    [42_000_000_000n, '$42'],
    [420_000_000_000n, '$420'],
    [42_000_000n, '$0.042'],
    [420_000_000n, '$0.42'],
    [1_000_000_000_000n, '$1.0K'],
    [0n, '$0'],
  ];
  for (const [n, want] of cases) assert.equal(formatUsdTwoSignificant(n), want, String(n));
  assert.equal(formatUsdTwoSignificant(7_318_420_000_000n), '$7.3K', 'floors unfloored input');
});

test('shareAtLeast is exact at the 99% boundary', () => {
  assert.equal(shareAtLeast(99, 100, 99, 100), true);
  assert.equal(shareAtLeast(9899, 10000, 99, 100), false);
  assert.equal(shareAtLeast(0, 0, 99, 100), false);
  assert.equal(shareAtLeast(10n ** 20n, 10n ** 20n + 1n, 99, 100), true);
});

test('ratio for display', () => {
  assert.equal(Math.round(ratio(4_830_000, 42_080_000) * 10000) / 10000, 0.1148);
  assert.equal(ratio('3000', '6680').toFixed(4), '0.4491');
  assert.equal(ratio(1, 0), 0);
});

test('override multiplier rounds half up per amount', () => {
  assert.equal(applyMultiplierMilli(1000, rateToMilli(0.85)), 850);
  assert.equal(applyMultiplierMilli(1, 500), 1);
  assert.equal(applyMultiplierMilli(1, 499), 0);
  assert.equal(WEB_SEARCH_NANO_PER_REQUEST * 1000, 10 * 1e9, '$10 per 1,000 searches');
});
