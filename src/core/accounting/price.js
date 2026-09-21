// Price lookup (DESIGN 5; rules A9 to A12): exact normalized ids, fast rates, the US
// inference multiplier and user overrides. Rates are resolved to integer milli-dollars per
// million tokens here; money.js turns tokens into nanodollars.
//
// Isomorphic: no node:* imports and no DOM.

import { rateToMilli, geoUsMilli } from '../money.js';
import { normalizeModelId, PRICE_TABLE_STALE_DAYS } from '../constants.js';
import { checkPriceTable } from './contract.js';

/**
 * Rates of one priced part in integer milli-dollars per million tokens.
 * @typedef {{ input: number, output: number, cw5m: number, cw1h: number, cacheRead: number }} MilliRates
 */

/**
 * @typedef {Object} ResolvedRates
 * @property {MilliRates} milli
 * @property {boolean} fast      the row's fast rates were used (rule A10)
 * @property {boolean} geoUs     the 1.1x US inference multiplier was applied (rule A11)
 * @property {boolean} override  a user override row was used exactly as written (DESIGN 5.2)
 */

/**
 * @typedef {Object} Pricer
 * @property {import('./contract.js').PriceTable} table
 * @property {string} asOf                    table.fetched
 * @property {import('./contract.js').PriceOverrides|null} overrides
 * @property {number|null} multiplierMilli    rateToMilli(overrides.multiplier) or null
 * @property {(model: string) => boolean} has  priced by the table or an override
 * @property {(model: string) => (import('./contract.js').PriceRow|null)} row
 * @property {(model: string) => string|null} displayName
 * @property {(model: string, mods?: { speed?: string|null, inferenceGeo?: string|null }) => ResolvedRates|null} rates
 * @property {(model: string, mods?: { speed?: string|null, inferenceGeo?: string|null }) => { fast: boolean, geoUs: boolean }} flags
 */

/** @param {import('./contract.js').RateSet} rs @returns {MilliRates} */
function milliOf(rs) {
  return {
    input: rateToMilli(rs.input),
    output: rateToMilli(rs.output),
    cw5m: rateToMilli(rs.cacheWrite5m),
    cw1h: rateToMilli(rs.cacheWrite1h),
    cacheRead: rateToMilli(rs.cacheRead),
  };
}

/** @param {MilliRates} m @returns {MilliRates} */
function geo(m) {
  return { input: geoUsMilli(m.input), output: geoUsMilli(m.output), cw5m: geoUsMilli(m.cw5m), cw1h: geoUsMilli(m.cw1h), cacheRead: geoUsMilli(m.cacheRead) };
}

/**
 * Validate a user price override object (DESIGN 5.2, Claude Code modelPricing compatible)
 * and return a clean PriceOverrides. Throws a TypeError naming the first problem.
 * @param {unknown} obj   parsed JSON of ~/.auditrail/prices.json or --prices <file>
 * @param {string} fileName base name only (shown in the custom-rates label)
 * @returns {import('./contract.js').PriceOverrides}
 */
export function parsePriceOverrides(obj, fileName) {
  const o = /** @type {any} */ (obj);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new TypeError('price overrides must be a JSON object');
  const name = String(fileName || 'prices.json').replace(/^.*[\\/]/, '');
  let multiplier = null;
  if (o.multiplier !== undefined && o.multiplier !== null) {
    rateToMilli(o.multiplier); // at most 3 decimals, non-negative
    multiplier = o.multiplier;
  }
  /** @type {import('./contract.js').PriceOverrides['overrides']} */
  const overrides = {};
  if (o.overrides !== undefined && o.overrides !== null) {
    if (typeof o.overrides !== 'object' || Array.isArray(o.overrides)) throw new TypeError('overrides must be an object keyed by model id');
    for (const [rawId, row] of Object.entries(o.overrides)) {
      const id = normalizeModelId(rawId);
      if (!id) throw new TypeError('override with an empty model id');
      const r = /** @type {any} */ (row);
      if (!r || typeof r !== 'object') throw new TypeError('override ' + id + ' must be an object');
      for (const k of ['input', 'output', 'cacheRead']) rateOrThrow(r[k], id + '.' + k);
      const w5 = r.cacheWrite5m ?? r.cacheWrite;
      const w1 = r.cacheWrite1h ?? r.cacheWrite;
      rateOrThrow(w5, id + '.cacheWrite5m (or cacheWrite)');
      rateOrThrow(w1, id + '.cacheWrite1h (or cacheWrite)');
      /** @type {{ input: number, output: number, cacheRead: number, cacheWrite?: number, cacheWrite5m?: number, cacheWrite1h?: number }} */
      const clean = { input: r.input, output: r.output, cacheRead: r.cacheRead };
      if (r.cacheWrite !== undefined) clean.cacheWrite = r.cacheWrite;
      if (r.cacheWrite5m !== undefined) clean.cacheWrite5m = r.cacheWrite5m;
      if (r.cacheWrite1h !== undefined) clean.cacheWrite1h = r.cacheWrite1h;
      overrides[id] = clean;
    }
  }
  return { fileName: name, multiplier, overrides };
}

/** @param {unknown} v @param {string} what */
function rateOrThrow(v, what) {
  try { rateToMilli(/** @type {number} */ (v)); } catch { throw new TypeError(what + ' must be a non-negative rate in USD per million tokens with at most 3 decimals'); }
}

/**
 * Build a pricer over one validated price table and optional overrides.
 * Throws when the table fails checkPriceTable (a broken table must never price anything).
 * @param {import('./contract.js').PriceTable} table
 * @param {import('./contract.js').PriceOverrides|null} [overrides]
 * @returns {Pricer}
 */
export function createPricer(table, overrides = null) {
  const problems = checkPriceTable(table);
  if (problems.length) throw new Error('invalid price table: ' + problems.join('; '));
  /** @type {Map<string, { row: import('./contract.js').PriceRow, std: MilliRates, fast: MilliRates|null, geo: boolean }>} */
  const rows = new Map();
  for (const row of table.models) {
    rows.set(row.id, { row, std: milliOf(row), fast: row.fast ? milliOf(row.fast) : null, geo: row.geoUsMultiplier === 1.1 });
  }
  /** @type {Map<string, MilliRates>} */
  const ov = new Map();
  let multiplierMilli = null;
  if (overrides) {
    if (overrides.multiplier !== null && overrides.multiplier !== undefined) multiplierMilli = rateToMilli(overrides.multiplier);
    for (const [id, r] of Object.entries(overrides.overrides || {})) {
      ov.set(normalizeModelId(id), {
        input: rateToMilli(r.input),
        output: rateToMilli(r.output),
        cw5m: rateToMilli(/** @type {number} */ (r.cacheWrite5m ?? r.cacheWrite)),
        cw1h: rateToMilli(/** @type {number} */ (r.cacheWrite1h ?? r.cacheWrite)),
        cacheRead: rateToMilli(r.cacheRead),
      });
    }
  }

  /** @param {string} model @param {{ speed?: string|null, inferenceGeo?: string|null }} [mods] */
  function flags(model, mods = {}) {
    if (ov.has(model)) return { fast: false, geoUs: false };
    const e = rows.get(model);
    if (!e) return { fast: false, geoUs: false };
    return { fast: mods.speed === 'fast' && e.fast !== null, geoUs: mods.inferenceGeo === 'us' && e.geo };
  }

  return {
    table,
    asOf: table.fetched,
    overrides,
    multiplierMilli,
    has: (model) => ov.has(model) || rows.has(model),
    row: (model) => (rows.get(model) || { row: null }).row,
    displayName: (model) => {
      const e = rows.get(model);
      return e ? e.row.displayName : null;
    },
    flags,
    rates(model, mods = {}) {
      const o = ov.get(model);
      if (o) return { milli: o, fast: false, geoUs: false, override: true };
      const e = rows.get(model);
      if (!e) return null;
      const f = flags(model, mods);
      let milli = f.fast && e.fast ? e.fast : e.std;
      if (f.geoUs) milli = geo(milli);
      return { milli, fast: f.fast, geoUs: f.geoUs, override: false };
    },
  };
}

/**
 * Days between the table's fetch date and the local clock (DESIGN 5.1 staleness warning).
 * @param {import('./contract.js').PriceTable} table
 * @param {number} nowMs
 * @returns {{ days: number, stale: boolean }}
 */
export function priceTableAge(table, nowMs) {
  const fetched = Date.parse(table.fetched + 'T00:00:00Z');
  const days = Math.max(0, Math.floor((nowMs - fetched) / 86_400_000));
  return { days, stale: days > PRICE_TABLE_STALE_DAYS };
}

export { normalizeModelId };
