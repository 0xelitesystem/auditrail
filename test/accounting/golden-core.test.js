// DESIGN 9.2 golden-core, end to end: the Claude Code adapter reads the synthetic fixture from
// disk and the accounting core must reproduce every hand-computed value in the design to the
// nanodollar. The expected numbers below are typed in from DESIGN 9.2 on purpose: they are NOT
// read from expected.json and NOT computed by any src/ helper, so a regression anywhere in the
// reader, the adapter, dedup, TTL resolution, pricing or time shows up here.
//
// Fixture (test/fixtures/golden-core, fictional): one session on 2026-03-02 UTC, a main file
// and one subagent file. Opus 5 rates 5 / 6.25 / 10 / 0.50 / 25, Sonnet 5 rates 2 / 2.50 / 4 /
// 0.20 / 10 (USD per million tokens, DESIGN 5.3).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPipeline, FIXTURES } from './_harness.js';

const ROOT = path.join(FIXTURES, 'golden-core', 'projects');

/** 1 USD = 1e9 nanodollars; 1 micro-dollar = 1,000 nanodollars. */
const usdNano = (micro) => micro * 1000;

/** @type {Awaited<ReturnType<typeof runPipeline>>} */
let run;
/** @type {import('../../src/core/accounting/contract.js').AccountingResult} */
let r;
/** @type {Map<string, import('../../src/core/accounting/contract.js').ResponseRecord>} */
let byKey;

before(async () => {
  run = await runPipeline(ROOT, { tz: 'UTC', idleMinutes: 15 });
  r = run.result;
  byKey = new Map(r.responses.map((x) => [x.key, x]));
});

test('9.2 scan: 2 files, 0 parse errors, 1 truncated trailing line', () => {
  assert.equal(r.scanByClass.main.files, 1);
  assert.equal(r.scanByClass.subagent.files, 1);
  assert.equal(r.scanByClass.workflow_agent.files, 0);
  const sum = (k) => Object.values(r.scanByClass).reduce((a, c) => a + c[k], 0);
  assert.equal(sum('parseErrors'), 0, 'parse errors');
  assert.equal(sum('trailingPartial'), 1, 'trailing partial lines');
  assert.equal(r.scanByClass.main.trailingPartial, 1, 'the truncated line is in the main file');
});

test('9.2 responses: 4 unique responses from 10 usage lines, 1 incomplete (25%), 1 session', () => {
  assert.equal(r.totals.responses, 4);
  assert.equal(r.dedup.observations, 10, 'usage lines seen (3 + 2 + 2 forked + 2 + 1)');
  assert.equal(r.dedup.keys, 4);
  assert.equal(r.dedup.forkedKeys, 1, 'msg_02 appears in both files');
  assert.equal(r.dedup.syntheticLines, 1, 'the <synthetic> 429 line');
  assert.equal(r.dedup.gatewayConflicts, 0);
  assert.equal(r.dedup.invariantViolations, 0);
  assert.equal(r.totals.incomplete, 1);
  assert.equal(r.totals.incomplete * 4, r.totals.responses, 'incomplete share is exactly 25%');
  assert.deepEqual([...byKey.keys()].sort(), ['msg_01', 'msg_02', 'msg_03', 'msg_04']);
  assert.equal(byKey.get('msg_04').complete, false, 'R4 never got a final line');
  for (const k of ['msg_01', 'msg_02', 'msg_03']) assert.equal(byKey.get(k).complete, true, k);
  assert.equal(r.bySession.filter((s) => s.firstTs !== null).length, 1, 'sessions');
  assert.equal(r.bySession[0].responses, 4);
});

test('9.2 per response: kept line, file class and tokens (max-output line wins, fork goes to main)', () => {
  const want = {
    msg_01: { cls: 'main', model: 'claude-opus-5', t: { input: 100, output: 120, cw5m: 0, cw1h: 2000, cacheRead: 0 }, obs: 3, files: 1 },
    msg_02: { cls: 'main', model: 'claude-opus-5', t: { input: 50, output: 300, cw5m: 0, cw1h: 500, cacheRead: 2000 }, obs: 4, files: 2 },
    msg_03: { cls: 'subagent', model: 'claude-sonnet-5', t: { input: 10, output: 200, cw5m: 1000, cw1h: 0, cacheRead: 0 }, obs: 2, files: 1 },
    msg_04: { cls: 'subagent', model: 'claude-sonnet-5', t: { input: 20, output: 7, cw5m: 0, cw1h: 0, cacheRead: 1000 }, obs: 1, files: 1 },
  };
  for (const [k, w] of Object.entries(want)) {
    const x = byKey.get(k);
    assert.equal(x.fileClass, w.cls, k + ' class');
    assert.equal(x.model, w.model, k + ' model');
    assert.deepEqual(x.tokens, w.t, k + ' tokens');
    assert.equal(x.observations, w.obs, k + ' lines');
    assert.equal(x.files, w.files, k + ' files');
    assert.equal(x.parts.length, 1, k + ' one billed part');
  }
  assert.equal(byKey.get('msg_02').isSidechain, false, 'the forked copy is attributed to the main thread');
});

test('9.2 tokens by class: input 180, output 627, writes 3,500 (5m 1,000 + 1h 2,500), reads 3,000', () => {
  assert.deepEqual(r.totals.tokens, { input: 180, output: 627, cw5m: 1000, cw1h: 2500, cacheRead: 3000 });
  assert.equal(r.totals.tokens.cw5m + r.totals.tokens.cw1h, 3500, 'cache writes total');
  assert.equal(r.pricedTokens, 7307);
  assert.equal(r.allTokens, 7307);
  assert.deepEqual(r.unpriced, []);
  assert.equal(r.modifiers.ttlEstimated, 0, 'every write had a 5m/1h split');
});

test('9.2 value per response to the nanodollar: R1 23,500,000; R2 13,750,000; R3 4,520,000; R4 310,000', () => {
  assert.equal(byKey.get('msg_01').valueNano, 23_500_000);
  assert.equal(byKey.get('msg_02').valueNano, 13_750_000);
  assert.equal(byKey.get('msg_03').valueNano, 4_520_000);
  assert.equal(byKey.get('msg_04').valueNano, 310_000);
});

test('9.2 total value: $0.042080 (42,080,000 nanodollars)', () => {
  assert.equal(r.totals.valueNano, 42_080_000n);
  assert.equal(r.totals.valueNano, BigInt(usdNano(42_080)), '$0.042080 in micro-dollars');
});

test('9.2 buckets: input $0.000810, output $0.012570, 5m $0.002500, 1h $0.025000, reads $0.001200', () => {
  const b = r.totals.bucketsNano;
  assert.equal(b.input, BigInt(usdNano(810)));
  assert.equal(b.output, BigInt(usdNano(12_570)));
  assert.equal(b.cw5m, BigInt(usdNano(2_500)));
  assert.equal(b.cw1h, BigInt(usdNano(25_000)));
  assert.equal(b.cacheRead, BigInt(usdNano(1_200)));
  assert.equal(b.webSearch, 0n);
  assert.equal(b.input + b.output + b.cw5m + b.cw1h + b.cacheRead, r.totals.valueNano, 'buckets sum to the total');
});

test('9.2 by file class: main $0.037250, subagent $0.004830, delegation share 11.48%', () => {
  assert.equal(r.byClass.main.valueNano, BigInt(usdNano(37_250)));
  assert.equal(r.byClass.subagent.valueNano, BigInt(usdNano(4_830)));
  assert.equal(r.byClass.workflow_agent.valueNano, 0n);
  assert.equal(r.byClass.main.responses, 2);
  assert.equal(r.byClass.subagent.responses, 2);
  const sidechain = r.responses.filter((x) => x.isSidechain).reduce((a, x) => a + BigInt(x.valueNano), 0n);
  assert.equal(sidechain, 4_830_000n);
  // 4,830,000 / 42,080,000 = 0.114781..., 11.48% at two decimals (integer math, half up).
  assert.equal((sidechain * 10_000n * 2n + r.totals.valueNano) / (2n * r.totals.valueNano), 1148n);
});

test('9.2 by model: Opus 5 $0.037250, Sonnet 5 $0.004830', () => {
  const m = Object.fromEntries(r.byModel.map((x) => [x.model, x.valueNano]));
  assert.deepEqual(m, { 'claude-opus-5': 37_250_000n, 'claude-sonnet-5': 4_830_000n });
});

test('9.2 cache hit rate 3,000 / 6,680 = 0.4491', () => {
  const t = r.totals.tokens;
  const num = t.cacheRead;
  const den = t.cacheRead + t.cw5m + t.cw1h + t.input;
  assert.equal(num, 3000);
  assert.equal(den, 6680);
  assert.equal(Math.round((num / den) * 10_000) / 10_000, 0.4491);
});

test('9.2 tools: 4 calls (duplicate Edit id once), 3 paired, shell_exit 1, denied 1, unpaired 1, failed 0', () => {
  assert.equal(r.tools.length, 4);
  const status = { ok: 0, denied: 0, shell_exit: 0, failed: 0, unpaired: 0 };
  for (const t of r.tools) status[t.status]++;
  assert.deepEqual(status, { ok: 1, denied: 1, shell_exit: 1, failed: 0, unpaired: 1 });
  assert.equal(r.tools.filter((t) => t.status !== 'unpaired').length, 3, 'paired');
  const byId = Object.fromEntries(r.tools.map((t) => [t.id, [t.name, t.status]]));
  assert.deepEqual(byId, {
    toolu_01: ['Bash', 'shell_exit'],
    toolu_02: ['Edit', 'ok'],
    toolu_03: ['Write', 'denied'],
    toolu_04: ['Read', 'unpaired'],
  });
  assert.equal(r.dedup.duplicateToolUseIds, 1, 'the forked Edit tool_use');
  assert.equal(r.dedup.orphanToolResults, 0);
  const edit = r.tools.find((t) => t.id === 'toolu_02');
  assert.equal(edit.fileClass, 'main', 'the duplicate Edit id is kept from the main file');
  assert.equal(edit.editNewLines, 1);
  assert.equal(r.tools.find((t) => t.id === 'toolu_03').denialKind, 'permission-rule');
  assert.equal(r.tools.find((t) => t.id === 'toolu_03').writeLines, null, 'line counts only on ok calls');
});

test('9.2 time: active 1,260 s (21 min), blocks 20 min and 1 min, agent 1,620 s (main 780, subagent 840)', () => {
  const tm = r.time;
  assert.equal(tm.idleSeconds, 900);
  assert.equal(tm.activeSeconds, 1260);
  assert.equal(tm.activeSeconds / 60, 21, 'active minutes');
  assert.deepEqual(tm.workBlockSeconds, [60, 1200]);
  assert.equal(tm.agentSeconds, 1620);
  assert.deepEqual(tm.agentSecondsByClass, { main: 780, subagent: 840, workflow_agent: 0 });
  assert.equal(r.bySession[0].activeSeconds, 1260);
  assert.equal(r.bySession[0].workBlocks, 2);
  assert.equal(tm.prompts, 2);
  assert.equal(tm.interrupts, 0);
  assert.deepEqual(tm.activeDays, ['2026-03-02']);
  assert.equal(tm.peakHourLocal, 9);
  assert.equal(tm.earliestMainTs, Date.UTC(2026, 2, 2, 9, 0, 0));
  assert.equal(tm.latestTs, Date.UTC(2026, 2, 2, 9, 41, 0));
});

test('9.2 the <synthetic> 429 line is excluded from tokens and feeds one rate-limit record', () => {
  assert.deepEqual(r.rateLimits.synthetic429Ts, [Date.UTC(2026, 2, 2, 9, 40, 0)]);
  assert.ok(!byKey.has('msg_syn'), 'never a response');
  assert.ok(!r.byModel.some((m) => m.model === '<synthetic>'), 'never a model');
});

test('idle cutoff is honoured: at 30 minutes the 20-minute gap counts', async () => {
  const wide = (await runPipeline(ROOT, { tz: 'UTC', idleMinutes: 30 })).result;
  // 09:00:00 to 09:20:00 is continuous at a 30-minute cutoff (1,200 s), then 09:20 to 09:40 (1,200 s)
  // and 09:40 to 09:41 (60 s): one block of 2,460 s.
  assert.equal(wide.time.activeSeconds, 2460);
  assert.deepEqual(wide.time.workBlockSeconds, [2460]);
  assert.equal(wide.totals.valueNano, 42_080_000n, 'money never depends on the cutoff');
});
