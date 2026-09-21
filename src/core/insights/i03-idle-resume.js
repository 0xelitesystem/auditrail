// I3. Idle-resume tax (DESIGN 6 I3, the flagship actionable finding).
//
// Per file, responses in tsStart order. Each response's cache-write value (5m + 1h writes) goes
// into exactly one bucket, checked in this order: first in its file; model switch (model
// differs from the previous response in the file); gap to the previous response at most
// 5 minutes; 5 to 60 minutes; over 60 minutes. A response without a timestamp cannot have a
// gap and is counted as "first". Full misses: no cache read at all and more than 20,000
// tokens written.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { share } from './_util.js';
import { shareAtLeast } from '../money.js';

export const ACTION_IDLE = 'Before a break of more than an hour, run /compact or wrap up and start a fresh session with a short handoff note, and avoid switching models mid-session.';

/** Gap limits in milliseconds. */
export const GAP_5M_MS = 5 * 60 * 1000;
export const GAP_60M_MS = 60 * 60 * 1000;
/** A full miss writes more than this many tokens with no cache read. */
export const FULL_MISS_WRITE_TOKENS = 20_000;
/** Shown when the over-60-minute bucket is at least this share of total value (percent). */
export const SHOW_AT_PERCENT = 5;

/**
 * @param {import('../accounting/contract.js').AccountingResult} acc
 */
export function idleBuckets(acc) {
  const keys = /** @type {const} */ (['first', 'modelSwitch', 'le5m', 'm5to60', 'gt60m']);
  /** @type {Record<string, { responses: number, nano: bigint }>} */
  const b = {};
  for (const k of keys) b[k] = { responses: 0, nano: 0n };
  let fullMisses = 0;
  let fullMissesAfterGap60 = 0;

  /** @type {Map<number, import('../accounting/contract.js').ResponseRecord[]>} */
  const byFile = new Map();
  for (const r of acc.responses) {
    let list = byFile.get(r.fileIdx);
    if (!list) { list = []; byFile.set(r.fileIdx, list); }
    list.push(r);
  }
  for (const list of byFile.values()) {
    list.sort((x, y) => {
      const tx = x.tsStart ?? -Infinity;
      const ty = y.tsStart ?? -Infinity;
      if (tx !== ty) return tx < ty ? -1 : 1;
      return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
    });
    /** @type {import('../accounting/contract.js').ResponseRecord|null} */
    let prev = null;
    for (const r of list) {
      let bucket;
      if (prev === null || r.tsStart === null || prev.tsStart === null) bucket = 'first';
      else if (r.model !== prev.model) bucket = 'modelSwitch';
      else {
        const gap = r.tsStart - prev.tsStart;
        bucket = gap <= GAP_5M_MS ? 'le5m' : gap <= GAP_60M_MS ? 'm5to60' : 'gt60m';
      }
      const writeNano = BigInt(r.bucketsNano.cw5m) + BigInt(r.bucketsNano.cw1h);
      b[bucket].responses++;
      b[bucket].nano += writeNano;
      const full = r.tokens.cacheRead === 0 && r.tokens.cw5m + r.tokens.cw1h > FULL_MISS_WRITE_TOKENS;
      if (full) {
        fullMisses++;
        if (bucket === 'gt60m') fullMissesAfterGap60++;
      }
      prev = r;
    }
  }
  return { buckets: b, fullMisses, fullMissesAfterGap60 };
}

export const insight = defineInsight({
  id: 'i03',
  title: 'Idle-resume tax',
  compute({ acc }) {
    const { buckets, fullMisses, fullMissesAfterGap60 } = idleBuckets(acc);
    const out = (/** @type {string} */ k) => ({ responses: buckets[k].responses, cacheWriteNano: buckets[k].nano.toString() });
    const total = acc.totals.valueNano;
    const gt = buckets.gt60m.nano;
    const data = {
      buckets: { first: out('first'), modelSwitch: out('modelSwitch'), le5m: out('le5m'), m5to60: out('m5to60'), gt60m: out('gt60m') },
      gt60mShareOfTotal: share(gt, total),
      fullMisses,
      fullMissesAfterGap60,
    };
    const shown = total > 0n && shareAtLeast(gt, total, SHOW_AT_PERCENT, 100);
    return { id: 'i03', shown, data, evidence: { count: buckets.gt60m.responses, unit: 'responses' }, action: ACTION_IDLE };
  },
});
