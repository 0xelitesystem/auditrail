// I5. Repricing what-if (DESIGN 6 I5, trap 35).
//
// Sidechain responses that ran on an Opus or Fable model, re-priced with the SAME token counts
// at Sonnet 5 list prices. Per billed part (a fallback response has two). Web search fees are
// identical under both and left out. The caveat label is verbatim from the design.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { share, ratesFor } from './_util.js';
import { shareAtLeast } from '../money.js';

export const REPRICE_TARGET_MODEL = 'claude-sonnet-5';

/** Verbatim label (DESIGN 6 I5). */
export const REPRICING_LABEL = 'Same token counts at Sonnet 5 list prices. Models differ in quality and in tokenization (Claude 4.7 and later produce about 30% more tokens for the same text), so treat this as a rough bound, not a promise.';

export const ACTION_REPRICE = 'Set an explicit cheaper model for subagents or workflows where quality allows.';

/** Shown when Opus or Fable sidechain value is at least this percent of total value. */
export const SHOW_AT_PERCENT = 20;

/** Families eligible for the what-if, matched on the normalized id's family segment. */
const ELIGIBLE_FAMILY_RE = /^claude-(opus|fable)-/;

/**
 * @param {string} model
 * @returns {boolean}
 */
export function isRepricingEligible(model) {
  return typeof model === 'string' && ELIGIBLE_FAMILY_RE.test(model);
}

export const insight = defineInsight({
  id: 'i05',
  title: 'Repricing what-if',
  compute({ acc, prices }) {
    let eligibleResponses = 0;
    let eligible = 0n;
    let atSonnet = 0n;
    for (const r of acc.responses) {
      if (!r.isSidechain) continue;
      let hit = false;
      for (const p of r.parts) {
        if (!p.priced || !isRepricingEligible(p.model)) continue;
        const target = ratesFor(prices, REPRICE_TARGET_MODEL, { geoUs: r.geoUs });
        if (!target) continue;
        hit = true;
        eligible += BigInt(p.valueNano) - BigInt(p.bucketsNano.webSearch || 0);
        const t = p.tokens;
        atSonnet += BigInt(t.input) * BigInt(target.input) + BigInt(t.output) * BigInt(target.output)
          + BigInt(t.cw5m) * BigInt(target.cw5m) + BigInt(t.cw1h) * BigInt(target.cw1h) + BigInt(t.cacheRead) * BigInt(target.cacheRead);
      }
      if (hit) eligibleResponses++;
    }
    const total = acc.totals.valueNano;
    const data = {
      eligibleResponses,
      eligibleNano: eligible.toString(),
      atSonnet5Nano: atSonnet.toString(),
      differenceNano: (eligible - atSonnet).toString(),
      eligibleShareOfTotal: share(eligible, total),
      label: REPRICING_LABEL,
    };
    const shown = total > 0n && eligibleResponses > 0 && shareAtLeast(eligible, total, SHOW_AT_PERCENT, 100);
    return { id: 'i05', shown, data, evidence: { count: eligibleResponses, unit: 'responses' }, action: ACTION_REPRICE };
  },
});
