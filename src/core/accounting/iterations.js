// Billed parts of one response: cache TTL resolution (rule A7) and refusal-fallback
// iterations (rule A8).
//
// Primary source for A8 (platform.claude.com/docs/en/build-with-claude/refusals-and-fallback,
// "Billing and rate limits"): an attempt that declined before producing any output is not
// billed; every attempt that produced output is billed separately at the rates of the model
// that ran it; usage.iterations is the per-attempt billing record, and the top-level usage
// describes only the attempt that produced the returned message.
//
// Isomorphic: no node:* imports and no DOM.

import { normalizeModelId } from '../constants.js';

/**
 * Split a cache write total into 5-minute and 1-hour tokens (rule A7, INTERFACES 13.2).
 * - Nothing written: nothing to split, never "estimated".
 * - Split present and consistent: use it.
 * - Split present but disagreeing with the total: integer rescale,
 *   w5 = floor(total * s5 / (s5 + s1)), w1 = total - w5.
 * - Split absent, or all zero while the total is not: every write at 5m, ttlEstimated.
 * @param {number} total cache_creation_input_tokens (authoritative)
 * @param {{ m5: number, h1: number }|null} split usage.cache_creation
 * @returns {{ cw5m: number, cw1h: number, ttlEstimated: boolean }}
 */
export function resolveTtl(total, split) {
  if (!total) return { cw5m: 0, cw1h: 0, ttlEstimated: false };
  if (!split) return { cw5m: total, cw1h: 0, ttlEstimated: true };
  const s5 = split.m5 || 0;
  const s1 = split.h1 || 0;
  if (s5 + s1 === total) return { cw5m: s5, cw1h: s1, ttlEstimated: false };
  if (s5 + s1 === 0) return { cw5m: total, cw1h: 0, ttlEstimated: true };
  const w5 = Number((BigInt(total) * BigInt(s5)) / BigInt(s5 + s1));
  return { cw5m: w5, cw1h: total - w5, ttlEstimated: false };
}

/**
 * One billed attempt before pricing.
 * @typedef {Object} RawPart
 * @property {string|null} rawModel   model as written (entry.model, else the top-level model)
 * @property {string} model           normalized id (rule A9)
 * @property {import('./contract.js').TokenCounts} tokens  after TTL resolution
 * @property {boolean} ttlEstimated
 */

/**
 * @param {string|null} rawModel
 * @param {{ inputUncached: number, output: number, cacheRead: number, cacheWrite: number, cacheWriteSplit: { m5: number, h1: number }|null }} x
 * @returns {RawPart}
 */
function part(rawModel, x) {
  const ttl = resolveTtl(x.cacheWrite, x.cacheWriteSplit);
  return {
    rawModel,
    model: normalizeModelId(rawModel),
    tokens: { input: x.inputUncached, output: x.output, cw5m: ttl.cw5m, cw1h: ttl.cw1h, cacheRead: x.cacheRead },
    ttlEstimated: ttl.ttlEstimated,
  };
}

/**
 * Billed attempts of a response (rule A8). With zero or one iteration entry the response is
 * one part built from top-level usage. With more, every entry is billed at its own model
 * (null means the top-level model), except an entry with 0 output that is not the last one.
 * Each entry uses its own cache_creation split (rule A7).
 * @param {import('../adapters/contract.js').NormalizedUsage} usage
 * @param {string|null} topRawModel
 * @returns {RawPart[]}
 */
export function billedParts(usage, topRawModel) {
  const its = usage.iterations;
  if (!Array.isArray(its) || its.length <= 1) return [part(topRawModel, usage)];
  const out = [];
  const last = its.length - 1;
  for (let i = 0; i <= last; i++) {
    const e = its[i];
    if (e.output === 0 && i !== last) continue;
    out.push(part(e.model ?? topRawModel, e));
  }
  return out;
}
