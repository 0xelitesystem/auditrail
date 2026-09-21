// I1 to I5: value, money map, idle-resume tax, delegation, repricing. Every expected number is
// computed by hand from the fixture rates (milli dollars per MTok; value nano = tokens x milli):
//   opus-5   input 5000, output 25000, cw5m 6250, cw1h 10000, cacheRead 500 (fast: all doubled)
//   sonnet-5 input 2000, output 10000, cw5m 2500, cw1h 4000,  cacheRead 200
//   haiku    input 1000, output 5000,  cw5m 1250, cw1h 2000,  cacheRead 100
//   fable-5  input 10000, output 50000, cw5m 12500, cw1h 20000, cacheRead 1000

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPriceTable } from '../../../src/core/accounting/contract.js';
import { checkInsightResult } from '../../../src/core/insights/contract.js';
import { insight as i01, incompleteBand } from '../../../src/core/insights/i01-value.js';
import { insight as i02 } from '../../../src/core/insights/i02-money-map.js';
import { insight as i03 } from '../../../src/core/insights/i03-idle-resume.js';
import { insight as i04 } from '../../../src/core/insights/i04-delegation.js';
import { insight as i05, REPRICING_LABEL, isRepricingEligible } from '../../../src/core/insights/i05-repricing.js';
import { VALUE_LABEL, CUSTOM_VALUE_LABEL } from '../../../src/core/constants.js';
import { makeAcc, resp, input, TEST_PRICES, T0, MIN, HOUR } from './_acc.js';

const DAY = 24 * HOUR;

/** Shares are exact to 12 decimal places (money.ratio). */
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-11, a + ' vs ' + b);

test('the test price table is itself a valid price table', () => {
  assert.deepEqual(checkPriceTable(TEST_PRICES), []);
});

function valueAcc() {
  return makeAcc({
    responses: [
      // 100*5000 + 1000*25000 + 2000*10000 + 10000*500 = 50,500,000
      resp({ key: 'r1', ts: T0, tokens: { input: 100, output: 1000, cw1h: 2000, cacheRead: 10000 }, thinkingTokens: 200, visibleChars: 3200 }),
      // 10*2000 + 500*10000 + 1000*2500 + 4000*200 = 8,320,000
      resp({ key: 'r2', ts: T0 + DAY, model: 'claude-sonnet-5', fileClass: 'subagent', fileIdx: 1, tokens: { input: 10, output: 500, cw5m: 1000, cacheRead: 4000 }, projectKey: '/fake/beta' }),
      // unpriced: 0
      resp({ key: 'r3', ts: T0 + 32 * DAY, model: 'claude-imaginary-9', tokens: { input: 5, output: 25 } }),
      // incomplete: 7*25000 + 1000*500 = 675,000
      resp({ key: 'r4', ts: T0 + 2 * HOUR, fileClass: 'subagent', fileIdx: 1, tokens: { output: 7, cacheRead: 1000 }, complete: false, visibleChars: 4000 }),
    ],
    time: { prompts: 5 },
  });
}

test('i01: total, coverage figures, groupings and value per prompt', () => {
  const r = i01.compute(input(valueAcc()));
  assert.deepEqual(checkInsightResult(r, 'i01'), []);
  const d = r.data;
  assert.equal(d.totalNano, '59495000');
  assert.equal(d.label, VALUE_LABEL);
  assert.equal(d.customRates, false);
  assert.equal(d.pricesAsOf, '2026-09-14');
  assert.equal(d.responses, 4);
  assert.equal(d.incompleteResponses, 1);
  assert.equal(d.incompleteShare, 0.25);
  assert.equal(d.pricedTokens, 13100 + 5510 + 1007);
  assert.equal(d.allTokens, 13100 + 5510 + 1007 + 30);
  assert.deepEqual(d.unpriced, [{ model: 'claude-imaginary-9', responses: 1, tokens: 30 }]);
  assert.equal(d.valuePerPromptNano, String(59495000 / 5));
  assert.deepEqual(d.byMonth, [
    { month: '2026-03', valueNano: '59495000', responses: 3 },
    { month: '2026-04', valueNano: '0', responses: 1 },
  ]);
  assert.deepEqual(d.byDay.map((x) => x.date), ['2026-03-02', '2026-03-03', '2026-04-03']);
  assert.deepEqual(d.byProject.map((p) => [p.label, p.valueNano]), [['alpha', '51175000'], ['beta', '8320000']]);
  assert.deepEqual(d.byClassNano, { main: '50500000', subagent: '8995000', workflow_agent: '0' });
  assert.equal(d.byModel.find((m) => m.model === 'claude-opus-5').displayName, 'Claude Opus 5');
  assert.equal(d.byModel.find((m) => m.model === 'claude-imaginary-9').displayName, null);
  assert.equal(d.plan, null);
  assert.equal(d.valueMultiple, null);
  assert.equal(r.shown, true);
});

test('i01: rule A6 band is fitted per model and never enters the total', () => {
  const acc = valueAcc();
  // Opus fit from r1: c = 3200 / (1000 - 200) = 4 chars per token, t = 200 / 1000 = 0.2.
  // r4: low = 4000 / 4 = 1000 tokens, high = 1000 / 0.8 = 1250 tokens, at 25000 milli.
  assert.deepEqual(incompleteBand(acc, TEST_PRICES), { lowTokens: 1000, highTokens: 1250, lowNano: '25000000', highNano: '31250000' });
  assert.equal(i01.compute(input(acc)).data.totalNano, '59495000', 'the band is report-only');
  // No incomplete responses: no band.
  const done = makeAcc({ responses: [resp({ key: 'a', tokens: { output: 10 } })] });
  assert.equal(incompleteBand(done, TEST_PRICES), null);
  // A model without its own fit borrows the pooled fit.
  const pooled = makeAcc({
    responses: [
      resp({ key: 'a', tokens: { output: 1000 }, thinkingTokens: 0, visibleChars: 2000 }),
      resp({ key: 'b', model: 'claude-sonnet-5', tokens: { output: 3 }, complete: false, visibleChars: 200, ts: T0 + MIN }),
    ],
  });
  // c = 2, t = 0: low = high = 100 tokens at sonnet output 10000 milli.
  assert.deepEqual(incompleteBand(pooled, TEST_PRICES), { lowTokens: 100, highTokens: 100, lowNano: '1000000', highNano: '1000000' });
});

test('i01: plan value multiple and custom-rate label', () => {
  // 12,000,000 output tokens on Opus 5 = 12e6 * 25000 nano = $300 in one month; plan $100.
  const acc = makeAcc({ responses: [resp({ key: 'a', tokens: { output: 12_000_000 } })] });
  const r = i01.compute(input(acc, { plan: { name: 'fictional', usdPerMonth: 100 }, custom: { fileName: 'rates.json', multiplier: null } }));
  assert.equal(r.data.valueMultiple, 3);
  assert.deepEqual(r.data.plan, { name: 'fictional', usdPerMonth: 100 });
  assert.equal(r.data.label, CUSTOM_VALUE_LABEL);
  assert.equal(r.data.customRates, true);
  assert.ok(!JSON.stringify(r).includes('rates.json'), 'the override file name is not an insight field');
});

test('i01: --redact replaces project labels and unpriced model ids', () => {
  const r = i01.compute(input(valueAcc(), { redact: true }));
  assert.deepEqual(r.data.byProject.map((p) => p.label), ['Project A', 'Project B']);
  assert.deepEqual(r.data.unpriced.map((u) => u.model), ['Unpriced model A']);
  assert.equal(r.data.byModel.find((m) => m.displayName === null).model, 'Unpriced model A');
  const json = JSON.stringify(r);
  for (const s of ['alpha', 'beta', 'imaginary']) assert.ok(!json.includes(s), s);
});

test('i02: five buckets, hit rate, net caching saving, three token headlines', () => {
  const t = { input: 100, output: 10, cw5m: 1000, cw1h: 2000, cacheRead: 10000 };
  const r = i02.compute(input(makeAcc({ responses: [resp({ key: 'a', tokens: t })] })));
  assert.deepEqual(checkInsightResult(r, 'i02'), []);
  assert.deepEqual(r.data.bucketsNano, { input: '500000', output: '250000', cw5m: '6250000', cw1h: '20000000', cacheRead: '5000000' });
  near(r.data.bucketShares.cw1h, 20_000_000 / 32_000_000);
  near(r.data.cacheHitRate, 10000 / 13100);
  // (10000 + 1000 + 2000) * 5000 - (5,000,000 + 6,250,000 + 20,000,000) = 33,750,000
  assert.equal(r.data.netCachingSavingNano, '33750000');
  assert.deepEqual(r.data.tokens, { output: 10, freshInput: 3100, cacheRead: 10000 });
  assert.ok(!('totalTokens' in r.data.tokens), 'never one total-tokens headline');
  // Fast mode doubles every Opus 5 rate, the saving follows the fast input rate.
  const fast = i02.compute(input(makeAcc({ responses: [resp({ key: 'a', tokens: t, fast: true })] })));
  assert.equal(fast.data.netCachingSavingNano, String(13000 * 10000 - 2 * 31_250_000));
});

test('i02: golden-core hit rate (DESIGN 9.2) from its token totals', () => {
  const acc = makeAcc({ responses: [resp({ key: 'a', tokens: { input: 180, output: 627, cw5m: 1000, cw1h: 2500, cacheRead: 3000 } })] });
  const r = i02.compute(input(acc));
  assert.equal(Math.round(r.data.cacheHitRate * 10000) / 10000, 0.4491);
});

function idleAcc() {
  const a = T0;
  const b = a + 3 * MIN;
  const c = b + 30 * MIN;
  const d = c + 2 * HOUR;
  const e = d + MIN;
  const f = e + 5 * MIN;
  const g = f + 60 * MIN;
  return makeAcc({
    responses: [
      resp({ key: 'a', ts: a, tokens: { cw1h: 1000 } }),                                    // first: 10,000,000
      resp({ key: 'b', ts: b, tokens: { cw1h: 100 } }),                                     // le5m: 1,000,000
      resp({ key: 'c', ts: c, tokens: { cw1h: 200 } }),                                     // m5to60: 2,000,000
      resp({ key: 'd', ts: d, tokens: { cw1h: 30000 } }),                                   // gt60m: 300,000,000, full miss
      resp({ key: 'e', ts: e, model: 'claude-sonnet-5', tokens: { cw5m: 400 } }),           // model switch: 1,000,000
      resp({ key: 'f', ts: f, model: 'claude-sonnet-5', tokens: { output: 1 } }),           // exactly 5 min: le5m, 0 writes
      resp({ key: 'g', ts: g, model: 'claude-sonnet-5', tokens: { output: 0 } }),           // exactly 60 min: m5to60
      resp({ key: 'h', ts: a + 10 * MIN, fileIdx: 1, fileClass: 'subagent', tokens: { cw5m: 21000 } }), // first in its file: 131,250,000, full miss
      resp({ key: 'i', ts: null, fileIdx: 2, fileClass: 'subagent', tokens: { output: 1 } }), // no timestamp: first
    ],
  });
}

test('i03: every response lands in exactly one bucket, boundaries inclusive', () => {
  const r = i03.compute(input(idleAcc()));
  assert.deepEqual(checkInsightResult(r, 'i03'), []);
  assert.deepEqual(r.data.buckets, {
    first: { responses: 3, cacheWriteNano: '141250000' },
    modelSwitch: { responses: 1, cacheWriteNano: '1000000' },
    le5m: { responses: 2, cacheWriteNano: '1000000' },
    m5to60: { responses: 2, cacheWriteNano: '2000000' },
    gt60m: { responses: 1, cacheWriteNano: '300000000' },
  });
  assert.equal(r.data.fullMisses, 2);
  assert.equal(r.data.fullMissesAfterGap60, 1);
  // total = writes 445,250,000 + output of f (10,000) + output of i (25,000) = 445,285,000
  near(r.data.gt60mShareOfTotal, 300_000_000 / 445_285_000);
  assert.equal(r.shown, true);
  assert.deepEqual(r.evidence, { count: 1, unit: 'responses' });
});

test('i03: not shown when the over-an-hour bucket is under 5% of value', () => {
  const acc = makeAcc({
    responses: [
      resp({ key: 'a', ts: T0, tokens: { output: 100000 } }), // 2,500,000,000
      resp({ key: 'b', ts: T0 + 2 * HOUR, tokens: { cw1h: 100 } }), // 1,000,000 after a 2 h gap
    ],
  });
  const r = i03.compute(input(acc));
  assert.equal(r.data.buckets.gt60m.responses, 1);
  assert.equal(r.shown, false);
});

test('i04: delegation share from isSidechain value, runs, attribution (local, redactable)', () => {
  const att = (agent, skill) => ({ agent, skill, mcpServer: null, plugin: null });
  const acc = makeAcc({
    responses: [
      resp({ key: 'm', tokens: { output: 1000 } }), // 25,000,000
      resp({ key: 's', fileClass: 'subagent', fileIdx: 1, model: 'claude-sonnet-5', tokens: { output: 1000 }, attribution: att('fake-reviewer', 'fake-skill') }), // 10,000,000
      resp({ key: 'w', fileClass: 'workflow_agent', fileIdx: 2, model: 'claude-haiku-4-5', tokens: { output: 1000 }, attribution: att('fake-reviewer', null) }), // 5,000,000
      // A forked response kept in the main file is not delegation even though it is in a subagent's history.
      resp({ key: 'f', fileClass: 'main', isSidechain: false, tokens: { output: 400 } }), // 10,000,000
    ],
  });
  const r = i04.compute(input(acc));
  assert.deepEqual(checkInsightResult(r, 'i04'), []);
  assert.equal(r.data.sidechainNano, '15000000');
  near(r.data.delegationShare, 15 / 50);
  assert.equal(r.data.agentRuns, 2);
  assert.deepEqual(r.data.subagent, { responses: 1, valueNano: '10000000' });
  assert.deepEqual(r.data.workflowAgent, { responses: 1, valueNano: '5000000' });
  assert.deepEqual(r.data.byAttribution.agent, [{ name: 'fake-reviewer', responses: 2, valueNano: '15000000' }]);
  assert.deepEqual(r.data.byAttribution.skill, [{ name: 'fake-skill', responses: 1, valueNano: '10000000' }]);
  assert.equal(r.shown, true);
  const red = i04.compute(input(acc, { redact: true }));
  assert.deepEqual(red.data.byAttribution.agent.map((x) => x.name), ['Agent A']);
  assert.deepEqual(red.data.byAttribution.skill.map((x) => x.name), ['Skill A']);
  assert.ok(!JSON.stringify(red).includes('fake-'), 'no attribution names under --redact');
});

test('i04: not shown under 5% delegation', () => {
  const acc = makeAcc({
    responses: [
      resp({ key: 'm', tokens: { output: 10000 } }),
      resp({ key: 's', fileClass: 'subagent', fileIdx: 1, tokens: { output: 100 } }),
    ],
  });
  assert.equal(i04.compute(input(acc)).shown, false);
});

test('i05: sidechain Opus and Fable parts repriced at Sonnet 5 with the verbatim caveat', () => {
  const acc = makeAcc({
    responses: [
      // Opus sidechain: 75,750,000 at Opus; 30,300,000 at Sonnet 5.
      resp({ key: 'o', fileClass: 'subagent', fileIdx: 1, tokens: { input: 1000, output: 2000, cw5m: 3000, cacheRead: 4000 } }),
      // Fallback: only the Fable attempt is eligible: 5,000,000 vs 1,000,000; the Sonnet attempt adds 500,000 value.
      resp({ key: 'fb', fileClass: 'subagent', fileIdx: 1, model: 'claude-sonnet-5', parts: [{ model: 'claude-fable-5', tokens: { output: 100 } }, { model: 'claude-sonnet-5', tokens: { output: 50 } }], ts: T0 + MIN }),
      // Main-thread Opus and a sidechain Haiku are not eligible.
      resp({ key: 'm', tokens: { output: 100 } }),
      resp({ key: 'h', fileClass: 'subagent', fileIdx: 1, model: 'claude-haiku-4-5', tokens: { output: 100 } }),
    ],
  });
  const r = i05.compute(input(acc));
  assert.deepEqual(checkInsightResult(r, 'i05'), []);
  assert.equal(r.data.eligibleResponses, 2);
  assert.equal(r.data.eligibleNano, '80750000');
  assert.equal(r.data.atSonnet5Nano, '31300000');
  assert.equal(r.data.differenceNano, '49450000');
  assert.equal(r.data.label, REPRICING_LABEL);
  assert.ok(r.data.label.startsWith('Same token counts at Sonnet 5 list prices.'));
  assert.equal(r.shown, true);
  assert.ok(isRepricingEligible('claude-opus-4-8') && isRepricingEligible('claude-fable-5-1'));
  assert.ok(!isRepricingEligible('claude-sonnet-5') && !isRepricingEligible('claude-haiku-4-5'));
});
