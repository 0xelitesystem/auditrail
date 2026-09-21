// All fourteen insights in display order, and one entry point that runs them (DESIGN 6).
//
// runInsights() is pure arithmetic over the AccountingResult: no model calls, no files, no
// network. Each result is checked against the InsightResult contract and must be JSON-safe,
// because summary.js embeds it as is.
//
// Isomorphic: no node:* imports and no DOM.

import { INSIGHT_IDS, checkInsightResult } from './contract.js';
import { findNonJsonValue } from '../summary-schema.js';
import { insight as i01 } from './i01-value.js';
import { insight as i02 } from './i02-money-map.js';
import { insight as i03 } from './i03-idle-resume.js';
import { insight as i04 } from './i04-delegation.js';
import { insight as i05 } from './i05-repricing.js';
import { insight as i06 } from './i06-rate-limits.js';
import { insight as i07 } from './i07-tools.js';
import { insight as i08 } from './i08-churn.js';
import { insight as i09 } from './i09-patterns.js';
import { insight as i10 } from './i10-workflows.js';
import { insight as i11 } from './i11-secrets.js';
import { insight as i12 } from './i12-history.js';
import { insight as i13 } from './i13-models.js';
import { insight as i14 } from './i14-receipts.js';

/** The modules, in INSIGHT_IDS order. */
export const INSIGHTS = Object.freeze([i01, i02, i03, i04, i05, i06, i07, i08, i09, i10, i11, i12, i13, i14]);

/**
 * Default insight options: UTC, 15-minute cutoff, no plan, not redacted, settings unknown.
 * @param {Partial<import('./contract.js').InsightOptions> & { custom?: { fileName: string, multiplier: number|null }|null }} [o]
 */
export function insightOptions(o = {}) {
  return {
    tz: o.tz || 'UTC',
    idleMinutes: typeof o.idleMinutes === 'number' && o.idleMinutes > 0 ? o.idleMinutes : 15,
    plan: o.plan ?? null,
    redact: Boolean(o.redact),
    cleanupPeriodDays: o.cleanupPeriodDays ?? null,
    statsCacheDays: o.statsCacheDays ?? null,
    nowMs: typeof o.nowMs === 'number' ? o.nowMs : Date.now(),
    custom: o.custom ?? null,
  };
}

/**
 * Run every insight. Throws with the insight id when one fails its contract, so a bug can never
 * produce a silently wrong report.
 * @param {import('./contract.js').InsightInput} input
 * @returns {Record<import('./contract.js').InsightId, import('./contract.js').InsightResult>}
 */
export function runInsights(input) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const m of INSIGHTS) {
    const r = m.compute(input);
    const problems = checkInsightResult(r, m.id);
    const bad = findNonJsonValue(r);
    if (bad) problems.push('not JSON-safe at ' + bad);
    if (problems.length) throw new TypeError('insight ' + m.id + ' broke its contract: ' + problems.join('; '));
    out[m.id] = r;
  }
  for (const id of INSIGHT_IDS) if (!out[id]) throw new TypeError('insight ' + id + ' missing');
  return /** @type {any} */ (out);
}
