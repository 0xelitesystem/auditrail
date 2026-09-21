// I6. Rate-limit walls (DESIGN 6 I6, rule A15).
//
// Windows = distinct quota resetsAt values with status rejected (accounting already dedupes
// them). Episodes = synthetic 429 lines clustered with a 30-minute gap (a gap of more than 30
// minutes starts a new episode). Episode starts are bucketed by local hour. Value before
// windows = value of responses whose tsStart falls in the 5 hours before a window's first
// rejection, by billed model; a response inside two overlapping lookbacks is counted once.
// Card: opt-in only (--card-include rate-limits), enforced by public.js.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { localParts } from './_util.js';

export const EPISODE_GAP_MS = 30 * 60 * 1000;
export const LOOKBACK_MS = 5 * 60 * 60 * 1000;

export const ACTION_RATE_LIMITS = 'Shift heavy workflows to your quiet hours and move subagents to cheaper models, so the 5-hour window lasts through your peak.';

/** rateLimitType values pass through only when they look like an enum token. */
const TYPE_RE = /^[a-z0-9_]{1,32}$/;

/**
 * @param {number[]} ts sorted or unsorted epoch ms
 * @returns {number[]} episode start timestamps
 */
export function episodeStarts(ts) {
  const s = ts.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (i === 0 || s[i] - s[i - 1] > EPISODE_GAP_MS) out.push(s[i]);
  }
  return out;
}

export const insight = defineInsight({
  id: 'i06',
  title: 'Rate-limit walls',
  compute({ acc, options }) {
    const tz = options.tz;
    const windows = acc.rateLimits.quotaRejectWindows;
    /** @type {Map<string, number>} */
    const types = new Map();
    for (const w of windows) {
      const t = typeof w.rateLimitType === 'string' && TYPE_RE.test(w.rateLimitType) ? w.rateLimitType : 'unknown';
      types.set(t, (types.get(t) || 0) + 1);
    }
    const byType = [...types.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([rateLimitType, n]) => ({ rateLimitType, windows: n }));

    const synth = acc.rateLimits.synthetic429Ts.filter((x) => typeof x === 'number' && Number.isFinite(x));
    const starts = episodeStarts(synth);
    const byHour = new Array(24).fill(0);
    for (const s of starts) byHour[localParts(s, tz).hour]++;

    const lookbacks = windows
      .filter((w) => typeof w.firstRejectTs === 'number' && Number.isFinite(w.firstRejectTs))
      .map((w) => [/** @type {number} */ (w.firstRejectTs) - LOOKBACK_MS, /** @type {number} */ (w.firstRejectTs)]);
    /** @type {Map<string, bigint>} */
    const valueByModel = new Map();
    if (lookbacks.length) {
      for (const r of acc.responses) {
        if (r.tsStart === null) continue;
        const inside = lookbacks.some(([a, b]) => r.tsStart >= a && r.tsStart < b);
        if (!inside) continue;
        for (const p of r.parts) {
          if (!p.priced) continue;
          valueByModel.set(p.model, (valueByModel.get(p.model) || 0n) + BigInt(p.valueNano));
        }
      }
    }
    const valueBeforeWindows = [...valueByModel.entries()]
      .sort((a, b) => (a[1] !== b[1] ? (a[1] > b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([model, v]) => ({ model, valueNano: v.toString() }));

    const data = {
      windows: windows.length,
      byType,
      synthetic429Lines: synth.length,
      episodes: starts.length,
      episodeStartsByLocalHour: byHour,
      valueBeforeWindows,
    };
    const shown = windows.length >= 1 || starts.length >= 1;
    return { id: 'i06', shown, data, evidence: { count: windows.length, unit: 'windows' }, action: ACTION_RATE_LIMITS };
  },
});
