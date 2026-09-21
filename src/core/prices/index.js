// Bundled, dated price tables (DESIGN 5.1, 5.4). Prices are never fetched at runtime: a new
// fetch produces a new dated file and old files stay for reproducibility (--prices-as-of).
// The JSON files are the source of truth; the build embeds them into the single-file bundle.
//
// Isomorphic: no node:* imports and no DOM (JSON modules via import attributes).

import anthropic20260914 from './anthropic-2026-09-14.json' with { type: 'json' };
import plans20260914 from './plans-2026-09-14.json' with { type: 'json' };

/** The "as of" date of the default table (printed with every dollar figure). */
export const DEFAULT_PRICES_AS_OF = '2026-09-14';

/** Every bundled Anthropic table by its fetch date. */
export const PRICE_TABLES = Object.freeze({ '2026-09-14': anthropic20260914 });

/** Every bundled plan table by its fetch date. */
export const PLAN_TABLES = Object.freeze({ '2026-09-14': plans20260914 });

/**
 * The bundled price table for a date (default: the newest).
 * @param {string} [asOf] 'YYYY-MM-DD'
 * @returns {import('../accounting/contract.js').PriceTable}
 */
export function getPriceTable(asOf = DEFAULT_PRICES_AS_OF) {
  const t = /** @type {Record<string, any>} */ (PRICE_TABLES)[asOf];
  if (!t) throw new RangeError('no bundled price table as of ' + asOf + '; available: ' + Object.keys(PRICE_TABLES).join(', '));
  return t;
}

/**
 * A plan row by its CLI id (pro, pro-annual, max5x, max20x, team, team-premium), or null.
 * Used only for the optional value multiple; a plan is never inferred.
 * @param {string} id
 * @param {string} [asOf]
 * @returns {{ id: string, displayName: string, usdPerMonth: number, source: string }|null}
 */
export function getPlan(id, asOf = DEFAULT_PRICES_AS_OF) {
  const t = /** @type {Record<string, any>} */ (PLAN_TABLES)[asOf];
  if (!t) return null;
  return t.plans.find((/** @type {{ id: string }} */ p) => p.id === id) || null;
}

/** CLI ids accepted by --plan. */
export const PLAN_IDS = Object.freeze(plans20260914.plans.map((/** @type {{ id: string }} */ p) => p.id));
