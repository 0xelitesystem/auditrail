// golden-pricing (DESIGN 9.3): one final assistant line per pricing case in one main file,
// plus cases.json with the raw usage objects for unit tests of the price module. Expected
// values are written out from the design and recomputed; the builder throws on disagreement.

import { jsonl, fakeSessionId, priceNano, billedParts, resolveTtl, normModel, prettyJson, usd, RATES_MILLI } from './_lib.mjs';

export const name = 'golden-pricing';

const S2 = fakeSessionId(2);
const base = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, speed: 'standard' };
/** @param {Record<string, unknown>} k */
const u = (k) => ({ ...base, ...k });

/** Cases in fixture order. counterfactual cases are not written as responses. */
const CASES = [
  {
    id: 'R5', title: 'fallback: Fable 5 attempt billed, then Opus 4.8', model: 'claude-opus-4-8',
    usage: u({ input_tokens: 1000, output_tokens: 200, iterations: [
      { type: 'message', model: 'claude-fable-5', input_tokens: 1000, output_tokens: 50 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 200 }] }),
    design: 22_500_000,
  },
  { id: 'R5-top-level-only', counterfactual: true, title: 'R5 priced from top-level usage only (wrong)', model: 'claude-opus-4-8', usage: u({ input_tokens: 1000, output_tokens: 200 }), design: 10_000_000 },
  {
    id: 'R5b', title: 'declined before output: first attempt not billed', model: 'claude-opus-4-8',
    usage: u({ input_tokens: 800, output_tokens: 100, iterations: [
      { type: 'message', model: 'claude-fable-5', input_tokens: 800, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 800, output_tokens: 100 }] }),
    design: 6_500_000,
  },
  { id: 'R6', title: 'Fable 5.1 cache read at 0.025x', model: 'claude-fable-5-1', usage: u({ input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 100000 }), design: 30_100_000 },
  { id: 'R6-as-fable-5', counterfactual: true, title: 'R6 mispriced as Fable 5 (prefix match, wrong)', model: 'claude-fable-5', usage: u({ input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 100000 }), design: 105_100_000 },
  { id: 'R7', title: 'fast mode on Opus 5', model: 'claude-opus-5', usage: u({ input_tokens: 1000, output_tokens: 1000, speed: 'fast' }), design: 60_000_000 },
  { id: 'R8', title: 'US inference geo 1.1x', model: 'claude-opus-5', usage: u({ input_tokens: 1000, output_tokens: 1000, inference_geo: 'us' }), design: 33_000_000 },
  { id: 'R9', title: 'dated id normalizes to claude-haiku-4-5', model: 'claude-haiku-4-5-20251001', usage: u({ input_tokens: 1000, output_tokens: 1000 }), design: 6_000_000 },
  {
    id: 'R12', title: 'cache split disagrees with total: integer rescale', model: 'claude-opus-5',
    usage: u({ input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 900 } }),
    design: 9_312_500,
  },
  { id: 'R13', title: 'no cache split: all writes at 5m, ttlEstimated', model: 'claude-opus-5', usage: u({ input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 1000 }), design: 6_500_000 },
  { id: 'R10', title: 'unknown model: unpriced, tokens listed', model: 'claude-imaginary-9', usage: u({ input_tokens: 500, output_tokens: 500 }), design: null },
];

const DESIGN_FIXTURE_TOTAL = 173_912_500; // R5, R5b, R6, R7, R8, R9, R12, R13 (DESIGN 9.3)

export function build() {
  const lines = [];
  let minute = 0;
  const outCases = [];
  const mismatches = [];
  let total = 0;
  const tokens = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
  let pricedTokens = 0;
  let allTokens = 0;
  const unpriced = [];
  const perResponse = {};
  let fast = 0;
  let geoUs = 0;
  let ttlEstimated = 0;

  for (const c of CASES) {
    const parts = billedParts(c.model, c.usage);
    let value = 0;
    let priced = true;
    const partOut = [];
    for (const p of parts) {
      const v = priceNano(p.model, p.tokens, { speed: c.usage.speed, geo: c.usage.inference_geo });
      if (v === null) { priced = false; } else value += v.total;
      partOut.push({ model: normModel(p.model), tokens: p.tokens, valueNano: v === null ? null : String(v.total) });
    }
    if (c.design !== null && value !== c.design) mismatches.push(`${c.id}: computed ${value}, design ${c.design}`);
    const partTokens = parts.reduce((a, p) => a + p.tokens.input + p.tokens.output + p.tokens.cw5m + p.tokens.cw1h + p.tokens.cacheRead, 0);
    outCases.push({
      id: c.id,
      title: c.title,
      counterfactual: !!c.counterfactual,
      model: c.model,
      normalizedModel: normModel(c.model),
      usage: c.usage,
      billedParts: partOut,
      priced,
      expectedNano: priced ? String(value) : null,
      expectedUsd: priced ? usd(value, 7) : null,
      ttlEstimated: resolveTtl(c.usage).ttlEstimated,
    });
    if (c.counterfactual) continue;

    minute += 1;
    const t = `2026-03-03T10:${String(minute).padStart(2, '0')}:00.000Z`;
    lines.push({
      type: 'assistant', sessionId: S2, isSidechain: false, timestamp: t, uuid: `u-pricing-${c.id}`, cwd: '/fake/pricing',
      requestId: `req_p_${c.id}`,
      message: { id: `msg_p_${c.id}`, model: c.model, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fictional answer' }], usage: c.usage },
    });
    perResponse[`msg_p_${c.id}`] = priced ? String(value) : null;
    for (const p of parts) for (const k of Object.keys(tokens)) tokens[k] += p.tokens[k];
    allTokens += partTokens;
    if (priced) { total += value; pricedTokens += partTokens; } else unpriced.push({ model: normModel(c.model), responses: 1, tokens: partTokens });
    if (c.usage.speed === 'fast' && RATES_MILLI[normModel(c.model)] && RATES_MILLI[normModel(c.model)].fast) fast++;
    if (c.usage.inference_geo === 'us') geoUs++;
    if (resolveTtl(c.usage).ttlEstimated) ttlEstimated++;
  }
  if (total !== DESIGN_FIXTURE_TOTAL) mismatches.push(`fixture total: computed ${total}, design ${DESIGN_FIXTURE_TOTAL}`);
  if (mismatches.length) throw new Error('golden-pricing disagrees with DESIGN 9.3:\n' + mismatches.join('\n'));

  const expected = {
    fixture: name,
    description: 'DESIGN 9.3 golden-pricing: one final line per case (fallback iterations, declined attempt, Fable 5.1 reads, fast, US geo, dated id, split rescale, missing split, unknown model).',
    tz: 'UTC',
    scan: { files: { main: 1, subagent: 0, workflow_agent: 0, workflow_journal: 0 }, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 },
    responses: lines.length,
    incompleteResponses: 0,
    sessions: 1,
    tokens,
    valueNano: String(total),
    valueUsd: usd(total, 7),
    responseValueNano: perResponse,
    pricedTokens,
    allTokens,
    unpriced,
    modifiers: { fast, geoUs, nonStandardTier: 0, ttlEstimated, webSearchRequests: 0 },
    counterfactualNano: {
      'R5-top-level-only': outCases.find((c) => c.id === 'R5-top-level-only').expectedNano,
      'R6-as-fable-5': outCases.find((c) => c.id === 'R6-as-fable-5').expectedNano,
    },
  };

  return {
    files: [
      { path: `projects/-fake-pricing/${S2}.jsonl`, content: jsonl(lines) },
      { path: 'cases.json', content: prettyJson({ fixture: name, note: 'Raw Claude Code usage objects with expected integer values. counterfactual cases show what a wrong method would produce and are not written as responses.', cases: outCases }) },
      { path: 'expected.json', content: prettyJson(expected) },
    ],
  };
}
