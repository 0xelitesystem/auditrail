// I1. What the work was worth (DESIGN 6 I1, rules A5, A6, A10, A33).
//
// Sum of value over priced responses, by local month, day, model and project, plus the
// coverage figures that make the number honest: priced token share, incomplete share,
// unpriced models, fast-mode responses and value per prompt. The headline is a LOWER BOUND.
// The rule A6 estimated band for missing output lives here too, for the local report only; it
// never enters totalNano, the card or any export total.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { VALUE_LABEL, CUSTOM_VALUE_LABEL } from '../constants.js';
import { share, roundTo, projectLabeler, ratesFor, displayNameFor, makeLabeler } from './_util.js';

export const ACTION_PLAN = 'Compare the monthly value with what your plan costs (pass --plan or --plan-price), and use export --csv --by project for client allocation, labelled API-equivalent.';

/**
 * Rule A6 band. Per model, fitted over COMPLETE responses that recorded thinking tokens:
 *   c = visible characters per non-thinking output token, t = thinking share of output.
 * For each incomplete response: low = visibleChars / c, high = low / (1 - t). A model with no
 * fit borrows the pooled fit over all models; with no pooled fit the response is left out.
 * @param {import('../accounting/contract.js').AccountingResult} acc
 * @param {import('../accounting/contract.js').PriceTable} prices
 * @returns {{ lowTokens: number, highTokens: number, lowNano: string, highNano: string }|null}
 */
export function incompleteBand(acc, prices) {
  const incomplete = acc.responses.filter((r) => !r.complete);
  if (!incomplete.length) return null;
  /** @type {Map<string, { chars: number, nonThinking: number, thinking: number, output: number }>} */
  const fits = new Map();
  const pooled = { chars: 0, nonThinking: 0, thinking: 0, output: 0 };
  for (const r of acc.responses) {
    if (!r.complete || r.thinkingTokens === null || r.thinkingTokens === undefined) continue;
    const out = r.tokens.output;
    const think = Math.min(r.thinkingTokens, out);
    if (out <= 0) continue;
    let f = fits.get(r.model);
    if (!f) { f = { chars: 0, nonThinking: 0, thinking: 0, output: 0 }; fits.set(r.model, f); }
    for (const x of [f, pooled]) {
      x.chars += r.visibleChars || 0;
      x.nonThinking += out - think;
      x.thinking += think;
      x.output += out;
    }
  }
  const usable = (/** @type {{ chars: number, nonThinking: number, thinking: number, output: number }} */ f) =>
    f && f.chars > 0 && f.nonThinking > 0 && f.thinking < f.output;
  let lowTokens = 0; let highTokens = 0; let lowNano = 0n; let highNano = 0n;
  for (const r of incomplete) {
    const f = usable(/** @type {any} */ (fits.get(r.model))) ? fits.get(r.model) : usable(pooled) ? pooled : null;
    if (!f || !(r.visibleChars > 0)) continue;
    const c = f.chars / f.nonThinking;
    const t = f.thinking / f.output;
    const low = Math.floor(r.visibleChars / c);
    const high = Math.floor(r.visibleChars / c / (1 - t));
    lowTokens += low;
    highTokens += high;
    const rates = ratesFor(prices, r.model, { fast: r.fast, geoUs: r.geoUs });
    if (rates) {
      lowNano += BigInt(low) * BigInt(rates.output);
      highNano += BigInt(high) * BigInt(rates.output);
    }
  }
  return { lowTokens, highTokens, lowNano: lowNano.toString(), highNano: highNano.toString() };
}

export const insight = defineInsight({
  id: 'i01',
  title: 'What the work was worth',
  compute(input) {
    const { acc, prices, options } = input;
    const redact = Boolean(options.redact);
    const custom = /** @type {any} */ (options).custom ?? null;
    const total = acc.totals.valueNano;
    const responses = acc.totals.responses;
    const prompts = acc.time.prompts;
    const unpricedLabel = makeLabeler('Unpriced model');

    const byMonth = Object.keys(acc.byLocalMonth).sort().map((month) => ({
      month, valueNano: acc.byLocalMonth[month].valueNano.toString(), responses: acc.byLocalMonth[month].responses,
    }));
    const byDay = Object.keys(acc.byLocalDay).sort().map((date) => ({
      date, valueNano: acc.byLocalDay[date].valueNano.toString(), responses: acc.byLocalDay[date].responses,
    }));
    const byModel = acc.byModel.map((m) => {
      const dn = displayNameFor(prices, m.model);
      return { model: dn || !redact ? m.model : unpricedLabel(m.model), displayName: dn, valueNano: m.valueNano.toString(), responses: m.responses };
    });
    const label = projectLabeler(acc, redact);
    const byProject = acc.byProject.map((p) => ({
      label: label(p.projectKey), valueNano: p.valueNano.toString(), responses: p.responses, sessions: p.sessions,
    }));
    const unpriced = acc.unpriced.map((u) => ({ model: redact ? unpricedLabel(u.model) : u.model, responses: u.responses, tokens: u.tokens }));

    const monthsWithResponses = byMonth.filter((m) => m.responses > 0).length;
    const plan = options.plan && typeof options.plan.usdPerMonth === 'number' && options.plan.usdPerMonth > 0
      ? { name: typeof options.plan.name === 'string' ? options.plan.name : null, usdPerMonth: options.plan.usdPerMonth }
      : null;
    let valueMultiple = null;
    if (plan && monthsWithResponses > 0) {
      // Integer cents first, then one float division for display.
      const cents = Number(total / 10_000_000n);
      valueMultiple = roundTo(cents / 100 / monthsWithResponses / plan.usdPerMonth, 2);
    }

    const data = {
      label: custom ? CUSTOM_VALUE_LABEL : VALUE_LABEL,
      pricesAsOf: prices.fetched,
      customRates: Boolean(custom),
      totalNano: total.toString(),
      responses,
      incompleteResponses: acc.totals.incomplete,
      incompleteShare: share(acc.totals.incomplete, responses),
      pricedTokens: acc.pricedTokens,
      allTokens: acc.allTokens,
      pricedTokenShare: share(acc.pricedTokens, acc.allTokens),
      unpriced,
      fastResponses: acc.modifiers.fast,
      prompts,
      valuePerPromptNano: prompts > 0 ? (total / BigInt(prompts)).toString() : null,
      byMonth,
      byDay,
      byModel,
      byProject,
      byClassNano: {
        main: acc.byClass.main.valueNano.toString(),
        subagent: acc.byClass.subagent.valueNano.toString(),
        workflow_agent: acc.byClass.workflow_agent.valueNano.toString(),
      },
      plan,
      valueMultiple,
      incompleteBand: incompleteBand(acc, prices),
    };
    return { id: 'i01', shown: true, data, evidence: { count: responses, unit: 'responses' }, action: ACTION_PLAN };
  },
});
