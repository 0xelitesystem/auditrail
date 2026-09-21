// Integer valuation of responses (rules A7 to A14, A33) and exact aggregation helpers.
//
// tokens * rateMilli = nanodollars, a safe-integer Number per bucket and per response (asserted
// by ../money.js); aggregates are BigInt. Nothing here is ever a float amount.
//
// Isomorphic: no node:* imports and no DOM.

import { tokensToNano, applyMultiplierMilli, WEB_SEARCH_NANO_PER_REQUEST } from '../money.js';
import { emptyTokens, addTokens, emptyAggregate } from './contract.js';
import { billedParts } from './iterations.js';
import { normalizeModelId } from '../constants.js';

/** @returns {import('./contract.js').BucketsNano} */
export function emptyBuckets() {
  return { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, webSearch: 0 };
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function addSafe(a, b) {
  const v = a + b;
  if (!Number.isSafeInteger(v)) throw new RangeError('per-response value exceeds 2^53 nanodollars');
  return v;
}

/**
 * Value of one part's tokens at resolved milli rates, per bucket.
 * @param {import('./contract.js').TokenCounts} t
 * @param {import('./price.js').MilliRates} r
 * @param {number|null} multiplierMilli  user override multiplier (DESIGN 5.2), per bucket, half up
 * @returns {{ buckets: import('./contract.js').BucketsNano, total: number }}
 */
export function valueTokens(t, r, multiplierMilli = null) {
  const m = (/** @type {number} */ x) => (multiplierMilli === null ? x : applyMultiplierMilli(x, multiplierMilli));
  const buckets = {
    input: m(tokensToNano(t.input, r.input)),
    output: m(tokensToNano(t.output, r.output)),
    cw5m: m(tokensToNano(t.cw5m, r.cw5m)),
    cw1h: m(tokensToNano(t.cw1h, r.cw1h)),
    cacheRead: m(tokensToNano(t.cacheRead, r.cacheRead)),
    webSearch: 0,
  };
  let total = 0;
  for (const k of /** @type {const} */ (['input', 'output', 'cw5m', 'cw1h', 'cacheRead'])) total = addSafe(total, buckets[k]);
  return { buckets, total };
}

/**
 * The priced view of one response observation.
 * @typedef {Object} PricedResponse
 * @property {import('./contract.js').BilledPart[]} parts
 * @property {import('./contract.js').TokenCounts} tokens     sums over billed parts
 * @property {number} valueNano                               priced parts plus web search
 * @property {import('./contract.js').BucketsNano} bucketsNano
 * @property {boolean} priced                                 every part priced
 * @property {boolean} fast                                   rule A10 on the top-level model
 * @property {boolean} geoUs                                  rule A11 on the top-level model
 * @property {boolean} ttlEstimated                           any part priced all-5m for lack of a split
 */

/**
 * Price one response observation (rules A7 to A14). Unpriced parts contribute tokens but no
 * value; web search is added once per response (INTERFACES 13.12).
 * @param {import('./price.js').Pricer} pricer
 * @param {string|null} rawModel  top-level model as written
 * @param {import('../adapters/contract.js').NormalizedUsage} usage
 * @param {{ allWritesAt5m?: boolean }} [opts]  allWritesAt5m: the "all writes at 5m" wrong method (DESIGN 4.3)
 * @returns {PricedResponse}
 */
export function priceResponse(pricer, rawModel, usage, opts = {}) {
  const raw = billedParts(usage, rawModel);
  const mods = { speed: usage.speed, inferenceGeo: usage.inferenceGeo };
  /** @type {import('./contract.js').BilledPart[]} */
  const parts = [];
  const tokens = emptyTokens();
  const bucketsNano = emptyBuckets();
  let valueNano = 0;
  let priced = true;
  let ttlEstimated = false;
  for (const p of raw) {
    const t = { ...p.tokens };
    if (opts.allWritesAt5m) { t.cw5m += t.cw1h; t.cw1h = 0; }
    if (p.ttlEstimated) ttlEstimated = true;
    addTokens(tokens, t);
    const r = pricer.rates(p.model, mods);
    if (!r) {
      priced = false;
      parts.push({ model: p.model, priced: false, tokens: t, valueNano: 0, bucketsNano: emptyBuckets() });
      continue;
    }
    const v = valueTokens(t, r.milli, pricer.multiplierMilli);
    parts.push({ model: p.model, priced: true, tokens: t, valueNano: v.total, bucketsNano: v.buckets });
    valueNano = addSafe(valueNano, v.total);
    for (const k of /** @type {const} */ (['input', 'output', 'cw5m', 'cw1h', 'cacheRead'])) bucketsNano[k] = addSafe(bucketsNano[k], v.buckets[k]);
  }
  if (usage.webSearchRequests > 0) {
    let ws = tokensToNano(usage.webSearchRequests, WEB_SEARCH_NANO_PER_REQUEST);
    if (pricer.multiplierMilli !== null) ws = applyMultiplierMilli(ws, pricer.multiplierMilli);
    bucketsNano.webSearch = ws;
    valueNano = addSafe(valueNano, ws);
  }
  const f = pricer.flags(normalizeModelId(rawModel), mods);
  return { parts, tokens, valueNano, bucketsNano, priced, fast: f.fast, geoUs: f.geoUs, ttlEstimated };
}

/**
 * Add one billed part into an aggregate (ModelAggregate grouping: a fallback response adds to
 * both models). `countResponse` is false when the same response already counted for this key.
 * @param {import('./contract.js').Aggregate} agg
 * @param {import('./contract.js').BilledPart} part
 * @param {boolean} complete
 * @param {boolean} countResponse
 * @returns {import('./contract.js').Aggregate}
 */
export function addPart(agg, part, complete, countResponse) {
  if (countResponse) {
    agg.responses++;
    if (!complete) agg.incomplete++;
  }
  addTokens(agg.tokens, part.tokens);
  agg.valueNano += BigInt(part.valueNano);
  const b = agg.bucketsNano;
  b.input += BigInt(part.bucketsNano.input);
  b.output += BigInt(part.bucketsNano.output);
  b.cw5m += BigInt(part.bucketsNano.cw5m);
  b.cw1h += BigInt(part.bucketsNano.cw1h);
  b.cacheRead += BigInt(part.bucketsNano.cacheRead);
  b.webSearch += BigInt(part.bucketsNano.webSearch);
  return agg;
}

export { emptyAggregate };
