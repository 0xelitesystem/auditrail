// I2. Money map: where the value goes (DESIGN 6 I2, trap 25).
//
// Five value buckets (uncached input, output, 5m writes, 1h writes, cache reads), the cache
// hit rate and the net caching saving. Token headlines are always three separate figures
// (output, fresh input, cache reads), never one "total tokens" number.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { share, ratesFor } from './_util.js';

export const ACTION_MONEY_MAP = 'Most of this value is context being re-read, not generation. Trim what loads every turn (a long CLAUDE.md, large MCP tool lists) and see the idle-resume finding before long breaks.';

/**
 * Net caching saving over priced parts: what the cached tokens would have cost as uncached
 * input, minus what they cost as cache reads and writes. Rates come from the price table the
 * run used (including fast and US-inference modifiers). Parts whose model is not in the table
 * are skipped. May be negative when writes outweigh reads.
 * @param {import('../accounting/contract.js').AccountingResult} acc
 * @param {import('../accounting/contract.js').PriceTable} prices
 * @returns {bigint}
 */
export function netCachingSaving(acc, prices) {
  let asInput = 0n;
  let asCache = 0n;
  for (const r of acc.responses) {
    for (const p of r.parts) {
      if (!p.priced) continue;
      const rates = ratesFor(prices, p.model, { fast: r.fast, geoUs: r.geoUs });
      if (!rates) continue;
      const cached = BigInt(p.tokens.cacheRead + p.tokens.cw5m + p.tokens.cw1h);
      asInput += cached * BigInt(rates.input);
      asCache += BigInt(p.bucketsNano.cacheRead) + BigInt(p.bucketsNano.cw5m) + BigInt(p.bucketsNano.cw1h);
    }
  }
  return asInput - asCache;
}

export const insight = defineInsight({
  id: 'i02',
  title: 'Where the value goes',
  compute({ acc, prices }) {
    const b = acc.totals.bucketsNano;
    const five = b.input + b.output + b.cw5m + b.cw1h + b.cacheRead;
    const t = acc.totals.tokens;
    const hitDen = t.cacheRead + t.cw5m + t.cw1h + t.input;
    const data = {
      bucketsNano: {
        input: b.input.toString(), output: b.output.toString(), cw5m: b.cw5m.toString(), cw1h: b.cw1h.toString(), cacheRead: b.cacheRead.toString(),
      },
      bucketShares: {
        input: share(b.input, five), output: share(b.output, five), cw5m: share(b.cw5m, five), cw1h: share(b.cw1h, five), cacheRead: share(b.cacheRead, five),
      },
      cacheHitRate: share(t.cacheRead, hitDen),
      netCachingSavingNano: netCachingSaving(acc, prices).toString(),
      tokens: { output: t.output, freshInput: t.input + t.cw5m + t.cw1h, cacheRead: t.cacheRead },
    };
    return { id: 'i02', shown: true, data, evidence: { count: acc.totals.responses, unit: 'responses' }, action: ACTION_MONEY_MAP };
  },
});
