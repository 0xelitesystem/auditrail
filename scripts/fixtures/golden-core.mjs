// golden-core (DESIGN 9.2 and 9.4): the hand-computed fixture. Every expected value below is
// written out by hand from the design and ALSO recomputed from the fixture's own data; the
// builder throws if the two disagree, so the fixture and the design cannot drift apart.
//
// Layout: projects/-fake-alpha/<S1>.jsonl (main) and
//         projects/-fake-alpha/<S1>/subagents/agent-a1.jsonl (subagent), one session, 2026-03-02 UTC.

import { jsonl, usage, fakeSessionId, priceNano, prettyJson, usd, round4 } from './_lib.mjs';

export const name = 'golden-core';

const S1 = fakeSessionId(1);
const CWD = '/fake/alpha';

/** @param {number} h @param {number} m @param {number} s */
const ts = (h, m, s) => `2026-03-02T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

/**
 * Assistant line (one content block per line, usage repeated on every line).
 * @param {string} mid @param {string} rid @param {string} model @param {object} blk @param {object} u
 * @param {string} t @param {{ side?: boolean, stop?: string|null, final?: boolean }} [o]
 */
function asst(mid, rid, model, blk, u, t, o = {}) {
  const uu = { ...u };
  if (o.final) uu.speed = 'standard';
  return {
    type: 'assistant', sessionId: S1, isSidechain: !!o.side, timestamp: t, uuid: `u-${mid}-${t}`, cwd: CWD,
    requestId: rid,
    message: { id: mid, model, role: 'assistant', stop_reason: o.stop ?? null, content: [blk], usage: uu },
  };
}

/**
 * User line.
 * @param {string} t @param {unknown} content @param {boolean} [side] @param {object} [extra]
 */
function usr(t, content, side = false, extra = undefined) {
  const e = { type: 'user', sessionId: S1, isSidechain: side, timestamp: t, uuid: `uu-${t}-${side}`, cwd: CWD, message: { role: 'user', content } };
  if (extra) Object.assign(e, extra);
  return e;
}

export function build() {
  const main = [
    usr(ts(9, 0, 0), 'fictional prompt'),
    asst('msg_01', 'req_01', 'claude-opus-5', { type: 'thinking', thinking: '' }, usage(100, 0, 2000, 0, 5), ts(9, 0, 10)),
    asst('msg_01', 'req_01', 'claude-opus-5', { type: 'text', text: 'ok' }, usage(100, 0, 2000, 0, 40), ts(9, 0, 11)),
    asst('msg_01', 'req_01', 'claude-opus-5', { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'false' } },
      usage(100, 0, 2000, 0, 120), ts(9, 0, 12), { stop: 'tool_use', final: true }),
    usr(ts(9, 5, 0), [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: true, content: 'Exit code 1' }]),
    asst('msg_02', 'req_02', 'claude-opus-5', { type: 'text', text: 'fixing' }, usage(50, 0, 500, 2000, 10), ts(9, 5, 5)),
    asst('msg_02', 'req_02', 'claude-opus-5', {
      type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { file_path: '/fake/a.txt', old_string: 'a', new_string: 'b' },
    }, usage(50, 0, 500, 2000, 300), ts(9, 5, 6), { stop: 'tool_use', final: true }),
    usr(ts(9, 12, 0), [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'done' }]),
    {
      type: 'assistant', sessionId: S1, isSidechain: false, timestamp: ts(9, 40, 0), uuid: 'u-syn', cwd: CWD,
      isApiErrorMessage: true, apiErrorStatus: 429,
      message: { id: 'msg_syn', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'rate limited' }], usage: usage(0, 0, 0, 0, 0) },
    },
    usr(ts(9, 41, 0), 'fictional prompt two'),
  ];
  const mainText = jsonl(main) + '{"type":"assistant","message":{"id":"msg_99"'; // truncated trailing line

  const sub = [
    main[5], main[6], // forked copy of msg_02 (same uuids, isSidechain false as copied)
    usr(ts(9, 6, 0), 'fictional task', true),
    asst('msg_03', 'req_03', 'claude-sonnet-5', { type: 'text', text: 'writing' }, usage(10, 1000, 0, 0, 2), ts(9, 6, 5), { side: true }),
    asst('msg_03', 'req_03', 'claude-sonnet-5', { type: 'tool_use', id: 'toolu_03', name: 'Write', input: { file_path: '/fake/b.txt', content: 'x' } },
      usage(10, 1000, 0, 0, 200), ts(9, 6, 6), { side: true, stop: 'tool_use', final: true }),
    usr(ts(9, 6, 7), [{ type: 'tool_result', tool_use_id: 'toolu_03', is_error: true, content: 'denied' }], true, { toolDenialKind: 'permission-rule' }),
    asst('msg_04', 'req_04', 'claude-sonnet-5', { type: 'tool_use', id: 'toolu_04', name: 'Read', input: { file_path: '/fake/c.txt' } },
      usage(20, 0, 0, 1000, 7), ts(9, 20, 0), { side: true }),
  ];
  const subText = jsonl(sub);

  const expected = computeAndCheck();
  return {
    files: [
      { path: `projects/-fake-alpha/${S1}.jsonl`, content: mainText },
      { path: `projects/-fake-alpha/${S1}/subagents/agent-a1.jsonl`, content: subText },
      { path: 'expected.json', content: prettyJson(expected) },
    ],
  };
}

/** Recompute every 9.2 and 9.4 value from the responses' true usage and compare with the design. */
function computeAndCheck() {
  const R = [
    { key: 'msg_01', model: 'claude-opus-5', cls: 'main', t: { input: 100, output: 120, cw5m: 0, cw1h: 2000, cacheRead: 0 }, complete: true },
    { key: 'msg_02', model: 'claude-opus-5', cls: 'main', t: { input: 50, output: 300, cw5m: 0, cw1h: 500, cacheRead: 2000 }, complete: true },
    { key: 'msg_03', model: 'claude-sonnet-5', cls: 'subagent', t: { input: 10, output: 200, cw5m: 1000, cw1h: 0, cacheRead: 0 }, complete: true },
    { key: 'msg_04', model: 'claude-sonnet-5', cls: 'subagent', t: { input: 20, output: 7, cw5m: 0, cw1h: 0, cacheRead: 1000 }, complete: false },
  ];
  const per = {};
  const buckets = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
  const byClass = { main: 0, subagent: 0, workflow_agent: 0 };
  const tokens = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
  let total = 0;
  for (const r of R) {
    const p = priceNano(r.model, r.t);
    per[r.key] = String(p.total);
    total += p.total;
    byClass[r.cls] += p.total;
    for (const k of Object.keys(buckets)) buckets[k] += p.buckets[k];
    for (const k of Object.keys(tokens)) tokens[k] += r.t[k];
  }

  // Wrong methods (9.4), from the line-level view of the same fixture.
  const line = (model, i, c5, c1, cr, o) => priceNano(model, { input: i, output: o, cw5m: c5, cw1h: c1, cacheRead: cr }).total;
  const sumEveryLine = [5, 40, 120].reduce((a, o) => a + line('claude-opus-5', 100, 0, 2000, 0, o), 0)
    + 2 * [10, 300].reduce((a, o) => a + line('claude-opus-5', 50, 0, 500, 2000, o), 0)
    + [2, 200].reduce((a, o) => a + line('claude-sonnet-5', 10, 1000, 0, 0, o), 0)
    + line('claude-sonnet-5', 20, 0, 0, 1000, 7);
  const keepFirstLine = line('claude-opus-5', 100, 0, 2000, 0, 5) + line('claude-opus-5', 50, 0, 500, 2000, 10)
    + line('claude-sonnet-5', 10, 1000, 0, 0, 2) + line('claude-sonnet-5', 20, 0, 0, 1000, 7);
  const allWritesAt5m = line('claude-opus-5', 100, 2000, 0, 0, 120) + line('claude-opus-5', 50, 500, 0, 2000, 300)
    + line('claude-sonnet-5', 10, 1000, 0, 0, 200) + line('claude-sonnet-5', 20, 0, 0, 1000, 7);
  const dedupPerFile = total + line('claude-opus-5', 50, 0, 500, 2000, 300);
  const mainFilesOnly = byClass.main;

  // Hand-computed values from DESIGN 9.2 and 9.4, written out literally.
  const DESIGN = {
    total: 42_080_000,
    per: { msg_01: 23_500_000, msg_02: 13_750_000, msg_03: 4_520_000, msg_04: 310_000 },
    buckets: { input: 810_000, output: 12_570_000, cw5m: 2_500_000, cw1h: 25_000_000, cacheRead: 1_200_000 },
    byClass: { main: 37_250_000, subagent: 4_830_000 },
    tokens: { input: 180, output: 627, cw5m: 1000, cw1h: 2500, cacheRead: 3000 },
    methods: { sumEveryLine: 113_495_000, keepFirstLine: 29_975_000, dedupPerFile: 55_830_000, allWritesAt5m: 32_705_000, mainFilesOnly: 37_250_000 },
  };
  const mismatches = [];
  const eq = (a, b, what) => { if (a !== b) mismatches.push(`${what}: computed ${a}, design ${b}`); };
  eq(total, DESIGN.total, 'total');
  for (const k of Object.keys(DESIGN.per)) eq(Number(per[k]), DESIGN.per[k], 'value ' + k);
  for (const k of Object.keys(DESIGN.buckets)) eq(buckets[k], DESIGN.buckets[k], 'bucket ' + k);
  eq(byClass.main, DESIGN.byClass.main, 'main');
  eq(byClass.subagent, DESIGN.byClass.subagent, 'subagent');
  for (const k of Object.keys(DESIGN.tokens)) eq(tokens[k], DESIGN.tokens[k], 'tokens ' + k);
  const methods = { sumEveryLine, keepFirstLine, dedupPerFile, allWritesAt5m, mainFilesOnly };
  for (const k of Object.keys(DESIGN.methods)) eq(methods[k], DESIGN.methods[k], 'method ' + k);
  if (mismatches.length) throw new Error('golden-core disagrees with DESIGN 9.2/9.4:\n' + mismatches.join('\n'));

  const hitDen = tokens.cacheRead + tokens.cw5m + tokens.cw1h + tokens.input;
  return {
    fixture: name,
    description: 'DESIGN 9.2 golden-core: 4 responses in 18 lines across a main and a subagent file, with a forked copy, a synthetic 429 line, a truncated trailing line and one of each tool status.',
    tz: 'UTC',
    idleMinutes: 15,
    scan: {
      files: { main: 1, subagent: 1, workflow_agent: 0, workflow_journal: 0 },
      linesByClass: { main: 11, subagent: 7, workflow_agent: 0, workflow_journal: 0 },
      recordsByClass: { main: 10, subagent: 7, workflow_agent: 0, workflow_journal: 0 },
      parseErrors: 0,
      trailingPartial: 1,
      oversizeLines: 0,
    },
    dedup: { observations: 10, keys: 4, gatewayConflicts: 0, invariantViolations: 0, forkedKeys: 1, syntheticLines: 1, duplicateToolUseIds: 1, orphanToolResults: 0 },
    responses: 4,
    incompleteResponses: 1,
    incompleteShare: 0.25,
    sessions: 1,
    tokens,
    cacheWriteTotal: tokens.cw5m + tokens.cw1h,
    pricedTokens: tokens.input + tokens.output + tokens.cw5m + tokens.cw1h + tokens.cacheRead,
    allTokens: tokens.input + tokens.output + tokens.cw5m + tokens.cw1h + tokens.cacheRead,
    valueNano: String(total),
    valueUsd: usd(total),
    responseValueNano: per,
    responseClass: { msg_01: 'main', msg_02: 'main', msg_03: 'subagent', msg_04: 'subagent' },
    responseComplete: { msg_01: true, msg_02: true, msg_03: true, msg_04: false },
    bucketsNano: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, String(v)])),
    byClassNano: { main: String(byClass.main), subagent: String(byClass.subagent), workflow_agent: '0' },
    byModelNano: { 'claude-opus-5': String(DESIGN.per.msg_01 + DESIGN.per.msg_02), 'claude-sonnet-5': String(DESIGN.per.msg_03 + DESIGN.per.msg_04) },
    delegationShare: { numNano: String(byClass.subagent), denNano: String(total), rounded4: round4(byClass.subagent, total) },
    cacheHitRate: { num: tokens.cacheRead, den: hitDen, rounded4: round4(tokens.cacheRead, hitDen) },
    unpriced: [],
    modifiers: { fast: 0, geoUs: 0, nonStandardTier: 0, ttlEstimated: 0, webSearchRequests: 0 },
    tools: {
      calls: 4, paired: 3,
      status: { ok: 1, denied: 1, shell_exit: 1, failed: 0, unpaired: 1 },
      byId: { toolu_01: 'shell_exit', toolu_02: 'ok', toolu_03: 'denied', toolu_04: 'unpaired' },
      callsByName: { Bash: 1, Edit: 1, Write: 1, Read: 1 },
      okEditNewLines: 1,
      okWriteLines: 0,
    },
    time: {
      activeSeconds: 1260,
      workBlockSeconds: [60, 1200],
      agentSeconds: 1620,
      agentSecondsByClass: { main: 780, subagent: 840, workflow_agent: 0 },
    },
    prompts: 2,
    interrupts: 0,
    activeDays: ['2026-03-02'],
    longestStreakDays: 1,
    peakHourLocal: 9,
    rateLimits: { quotaRejectWindows: 0, synthetic429Lines: 1, episodes: 1 },
    workflows: { launched: 0, started: 0, result: 0, failed: 0 },
    coverage: { earliestMainTs: '2026-03-02T09:00:00.000Z', earliestAnyTs: '2026-03-02T09:00:00.000Z', latestTs: '2026-03-02T09:41:00.000Z' },
    methods: {
      correct: { valueNano: String(total), ratio: 1 },
      sumEveryLine: { valueNano: String(sumEveryLine), ratio: round3(sumEveryLine, total) },
      keepFirstLine: { valueNano: String(keepFirstLine), ratio: round3(keepFirstLine, total) },
      dedupPerFile: { valueNano: String(dedupPerFile), ratio: round3(dedupPerFile, total) },
      allWritesAt5m: { valueNano: String(allWritesAt5m), ratio: round3(allWritesAt5m, total) },
      mainFilesOnly: { valueNano: String(mainFilesOnly), ratio: round3(mainFilesOnly, total) },
    },
  };
}

/** @param {number} a @param {number} b */
function round3(a, b) {
  return Math.round((a / b) * 1000) / 1000;
}
