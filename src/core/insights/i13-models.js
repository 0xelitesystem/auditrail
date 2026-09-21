// I13. Model and effort mix (DESIGN 6 I13, rule A14).
//
// Responses and value by billed model (a fallback response counts under both models, as
// ModelAggregate does). Top model = highest value, ties by model id; public.js turns it into a
// price-table display name or "other model". Thinking share = thinking tokens / output tokens
// over responses that recorded thinking tokens (thinking is already inside output: breakdown
// only). Effort values pass through only when they are in the EFFORT_LEVELS allowlist.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { share, displayNameFor, makeLabeler } from './_util.js';

export const ACTION_MODELS = 'If an expensive model dominates work a cheaper one handles well, set the cheaper model as the default for that kind of task.';

/**
 * The closed set of effort levels. `effort` is copied out of the log (parse.js token()), and
 * i13 puts it in the Summary as an OBJECT KEY, where neither --redact nor the browser's
 * Share-safe sweep can reach it: both keep short lowercase tokens as enum-shaped. A shape test
 * would therefore let any lowercase word from a log through summary.js's "no text from any log"
 * rule, so this is an allowlist, not a pattern. Anything else is counted as 'other'.
 */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max', 'xhigh']);
const EFFORT_SET = new Set(EFFORT_LEVELS);

export const insight = defineInsight({
  id: 'i13',
  title: 'Model and effort mix',
  compute({ acc, prices, options }) {
    const redact = Boolean(options.redact);
    const unpricedLabel = makeLabeler('Unpriced model');
    const total = acc.totals.valueNano;
    const sorted = [...acc.byModel].sort((a, b) => (a.valueNano !== b.valueNano ? (a.valueNano > b.valueNano ? -1 : 1) : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    const byModel = sorted.map((m) => {
      const dn = displayNameFor(prices, m.model);
      return {
        model: dn || !redact ? m.model : unpricedLabel(m.model),
        displayName: dn,
        responses: m.responses,
        valueNano: m.valueNano.toString(),
        share: share(m.valueNano, total),
      };
    });
    let topModel = null;
    const top = sorted.find((m) => m.valueNano > 0n);
    if (top) topModel = { model: top.model, displayName: displayNameFor(prices, top.model) };
    if (topModel && topModel.displayName === null && redact) topModel = { model: unpricedLabel(top.model), displayName: null };

    let thinking = 0;
    let output = 0;
    /** @type {Record<string, number>} */
    const effort = {};
    for (const r of acc.responses) {
      if (typeof r.thinkingTokens === 'number') {
        thinking += r.thinkingTokens;
        output += r.tokens.output;
      }
      const e = typeof r.effort === 'string' && EFFORT_SET.has(r.effort) ? r.effort : r.effort === null || r.effort === undefined ? 'unset' : 'other';
      effort[e] = (effort[e] || 0) + 1;
    }
    const data = {
      byModel,
      topModel,
      thinkingShare: output > 0 ? Math.min(1, thinking / output) : null,
      effort: Object.fromEntries(Object.entries(effort).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    return { id: 'i13', shown: true, data, evidence: { count: acc.totals.responses, unit: 'responses' }, action: ACTION_MODELS };
  },
});
