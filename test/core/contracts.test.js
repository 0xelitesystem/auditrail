import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEvent, EVENT_SCHEMAS, EVENT_KINDS, compareObservations, compareByFileOrder, defaultDedupKey, defaultMerge,
  normalizeLogPath, isPathInside, fileLabelOf, countLines, defineAdapter, FILE_CLASS_DEPTH, TEXT_BEARING_RECORD_TYPES,
} from '../../src/core/adapters/contract.js';
import { toolNameClass, toolDisplayName, normalizeModelId, TOOL_DISPLAY_NAMES, BUILTIN_TOOLS } from '../../src/core/constants.js';
import { checkPriceTable, emptyAggregate, addResponse, aggregateToJson, tokenTotal, CACHE_READ_0025_IDS } from '../../src/core/accounting/contract.js';
import { INSIGHT_IDS, INSIGHT_META, defineInsight, checkInsightResult } from '../../src/core/insights/contract.js';
import { checkSummary, assertSummary, findNonJsonValue } from '../../src/core/summary-schema.js';
import { makeSummary } from '../helpers/sample-summary.js';

const usage = (over = {}) => ({
  inputUncached: 100, output: 120, cacheRead: 0, cacheWrite: 2000, cacheWriteSplit: { m5: 0, h1: 2000 }, reasoning: null,
  reasoningIncludedInOutput: true, speed: 'standard', inferenceGeo: 'not_available', serviceTier: 'standard', webSearchRequests: 0,
  iterations: null, costSource: 'computed', ...over,
});

/** One valid example of every event kind. */
export const EXAMPLES = {
  response: {
    kind: 'response', fileIdx: 0, lineNo: 3, ts: 1772442012000, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', uuid: 'u-1',
    messageId: 'msg_01', requestId: 'req_01', isSidechain: false, rawModel: 'claude-opus-5', final: true, usage: usage(), cwd: '/fake/alpha',
    attribution: null, effort: 'high', visibleChars: 42,
  },
  tool_use: {
    kind: 'tool_use', fileIdx: 0, lineNo: 3, ts: 1772442012000, sessionId: 's', isSidechain: false, toolUseId: 'toolu_01', name: 'Edit',
    filePathHash: 'a'.repeat(64), fileLabel: 'fake/a.txt', editNewLines: 1, writeLines: null, commandIntents: [],
  },
  tool_result: { kind: 'tool_result', fileIdx: 0, lineNo: 4, ts: null, sessionId: 's', toolUseId: 'toolu_01', isError: true, denialKind: 'permission-rule', errorCategory: 'permission_or_hook' },
  prompt: { kind: 'prompt', fileIdx: 0, lineNo: 1, ts: 1, sessionId: 's', uuid: 'u' },
  interrupt: { kind: 'interrupt', fileIdx: 0, lineNo: 1, ts: 1, sessionId: 's', uuid: null },
  activity: { kind: 'activity', fileIdx: 0, lineNo: 1, ts: 1, sessionId: 's', uuid: 'u', isSidechain: false, recordType: 'user', cwd: 'C:\\Fake\\Alpha', agentVersion: '2.1.200' },
  synthetic: { kind: 'synthetic', fileIdx: 0, lineNo: 9, ts: 2, sessionId: 's', apiErrorStatus: 429 },
  quota: { kind: 'quota', fileIdx: 0, lineNo: 9, ts: 2, sessionId: 's', status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1772460000 },
  workflow: { kind: 'workflow', fileIdx: 1, lineNo: 1, ts: null, event: 'failed' },
  cost_state: {
    kind: 'cost_state', fileIdx: 0, lineNo: 5, ts: null, sessionId: 's', startTime: 1, reportedCostNano: 5,
    models: [{ model: 'claude-opus-5[1m]', inputUncached: 1, output: 2, cacheRead: 3, cacheWrite: 4, webSearchRequests: 0, reportedCostNano: 5 }],
  },
  secret: { kind: 'secret', fileIdx: 0, lineNo: 7, ts: 3, sessionId: 's', secretType: 'anthropic', fingerprint12: '0123456789ab', severity: 'critical', source: 'tool_result_local', expired: null },
  skipped: { kind: 'skipped', fileIdx: 0, lineNo: 1, reason: 'text_bearing', recordType: 'custom-title' },
};

test('every event kind has a valid example that passes assertEvent', () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...EVENT_KINDS].sort());
  for (const ev of Object.values(EXAMPLES)) assertEvent(ev);
  const withIterations = structuredClone(EXAMPLES.response);
  withIterations.usage.iterations = [
    { model: 'claude-fable-5', type: 'message', inputUncached: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cacheWriteSplit: null },
    { model: null, type: 'fallback_message', inputUncached: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cacheWriteSplit: null },
  ];
  assertEvent(withIterations);
});

test('assertEvent rejects extra keys, missing keys, wrong types and enums', () => {
  const extra = { ...EXAMPLES.prompt, text: 'fictional prompt' };
  assert.throws(() => assertEvent(extra), /unexpected key "text"/);
  const { uuid, ...missing } = EXAMPLES.prompt;
  assert.throws(() => assertEvent(missing), /missing key "uuid"/);
  assert.throws(() => assertEvent({ ...EXAMPLES.workflow, event: 'resultPayload' }), /enum/);
  assert.throws(() => assertEvent({ ...EXAMPLES.tool_use, commandIntents: ['rm -rf'] }), /enum/);
  assert.throws(() => assertEvent({ ...EXAMPLES.response, ts: 'yesterday' }), /finite number/);
  assert.throws(() => assertEvent({ ...EXAMPLES.response, lineNo: 0 }), /lineNo/);
  assert.throws(() => assertEvent({ ...EXAMPLES.secret, fingerprint12: 'NOT-A-FINGERPRINT' }), /pattern/);
  assert.throws(() => assertEvent({ kind: 'transcript_text' }), /unknown event kind/);
  assert.throws(() => assertEvent(null), TypeError);
});

test('assertEvent rejects a free-text payload smuggled into a string field', () => {
  const blob = 'fictional words '.repeat(400);
  assert.throws(() => assertEvent({ ...EXAMPLES.activity, cwd: blob }), /longer than/);
  assert.throws(() => assertEvent({ ...EXAMPLES.tool_use, name: blob }), /longer than/);
  assert.throws(() => assertEvent({ ...EXAMPLES.tool_result, denialKind: 'user said: stop it' }), /pattern/);
  const nested = structuredClone(EXAMPLES.response);
  nested.usage.extra = 'x';
  assert.throws(() => assertEvent(nested), /unexpected key "extra"/);
});

test('text-bearing record types are the five from rule A19', () => {
  assert.deepEqual([...TEXT_BEARING_RECORD_TYPES].sort(), ['agent-name', 'ai-title', 'custom-title', 'last-prompt', 'queue-operation']);
  for (const kind of EVENT_KINDS) {
    for (const [k, spec] of Object.entries(EVENT_SCHEMAS[kind])) {
      assert.ok(!/^(text|content|prompt|title|input|output|command|message)$/.test(k), `${kind}.${k} looks like a text field`);
      void spec;
    }
  }
});

const FILES = [
  { idx: 0, rootIdx: 0, relPath: '-fake-alpha/S1.jsonl', fileClass: 'main', depth: 0, size: 1 },
  { idx: 1, rootIdx: 0, relPath: '-fake-alpha/S1/subagents/agent-a1.jsonl', fileClass: 'subagent', depth: 1, size: 1 },
  { idx: 2, rootIdx: 0, relPath: '-fake-alpha/S1/subagents/agent-a0.jsonl', fileClass: 'subagent', depth: 1, size: 1 },
  { idx: 3, rootIdx: 1, relPath: '-fake-alpha/S1/subagents/agent-a0.jsonl', fileClass: 'subagent', depth: 1, size: 1 },
  { idx: 4, rootIdx: 0, relPath: '-fake-alpha/S1/subagents/workflows/wf_1/agent-w.jsonl', fileClass: 'workflow_agent', depth: 2, size: 1 },
];
const ob = (fileIdx, lineNo, output) => ({ fileIdx, lineNo, usage: { output } });

test('rule A3 order: max output, then shallower file, then smaller relPath, then root, then later line', () => {
  assert.ok(compareObservations(ob(1, 1, 300), ob(0, 1, 10), FILES) < 0, 'output wins over depth');
  assert.ok(compareObservations(ob(0, 1, 300), ob(1, 1, 300), FILES) < 0, 'main over subagent');
  assert.ok(compareObservations(ob(1, 1, 300), ob(4, 1, 300), FILES) < 0, 'subagent over workflow agent');
  assert.ok(compareObservations(ob(2, 1, 300), ob(1, 1, 300), FILES) < 0, 'agent-a0 < agent-a1');
  assert.ok(compareObservations(ob(2, 1, 300), ob(3, 1, 300), FILES) < 0, 'smaller rootIdx');
  assert.ok(compareObservations(ob(0, 9, 300), ob(0, 2, 300), FILES) < 0, 'later line');
  assert.equal(compareObservations(ob(0, 2, 300), ob(0, 2, 300), FILES), 0);
  // Antisymmetric and independent of argument order.
  const all = [ob(0, 1, 5), ob(1, 1, 300), ob(0, 2, 300), ob(4, 3, 300), ob(2, 1, 300), ob(3, 1, 300)];
  for (const a of all) for (const b of all) assert.equal(Math.sign(compareObservations(a, b, FILES)) + Math.sign(compareObservations(b, a, FILES)), 0);
  const kept = (xs) => xs.reduce((k, x) => defaultMerge(k, x, FILES));
  assert.deepEqual(kept(all), ob(0, 2, 300));
  assert.deepEqual(kept([...all].reverse()), ob(0, 2, 300));
  assert.throws(() => compareByFileOrder(ob(9, 1, 1), ob(0, 1, 1), FILES), RangeError);
});

test('rule A1 key fallbacks', () => {
  const r = EXAMPLES.response;
  assert.equal(defaultDedupKey(r), 'msg_01');
  assert.equal(defaultDedupKey({ ...r, messageId: null }), 'req_01');
  assert.equal(defaultDedupKey({ ...r, messageId: null, requestId: null }), 'u-1');
  assert.equal(defaultDedupKey({ ...r, messageId: null, requestId: null, uuid: null }), 'line:0:3');
});

test('log path normalization (rules A29, A32; F20)', () => {
  assert.equal(normalizeLogPath('C:\\Fake\\Alpha\\', 'auto'), 'c:/fake/alpha');
  assert.equal(normalizeLogPath('c:/fake/ALPHA/api', 'auto'), 'c:/fake/alpha/api');
  assert.equal(normalizeLogPath('C:\\', 'auto'), 'c:/');
  assert.equal(normalizeLogPath('/fake/Alpha//api/', 'posix'), '/fake/Alpha/api');
  assert.equal(normalizeLogPath('/fake/Alpha', 'win32'), '/fake/alpha');
  assert.equal(normalizeLogPath('\\\\wsl.localhost\\Distro\\fake', 'auto'), '//wsl.localhost/distro/fake');
  assert.equal(normalizeLogPath('/', 'posix'), '/');
  assert.equal(normalizeLogPath(undefined), '');
  assert.ok(isPathInside('c:/fake/alpha/api', 'c:/fake/alpha'));
  assert.ok(isPathInside('c:/fake/alpha', 'c:/fake/alpha'));
  assert.ok(!isPathInside('c:/fake/alphabet', 'c:/fake/alpha'));
  assert.ok(isPathInside('c:/x', 'c:/'));
});

test('file label and line counting (rule A32)', () => {
  assert.equal(fileLabelOf('/fake/alpha/src/app.js'), 'src/app.js');
  assert.equal(fileLabelOf('C:\\Fake\\notes.md'), 'Fake/notes.md');
  assert.equal(fileLabelOf('app.js'), 'app.js');
  assert.equal(countLines(''), 0);
  assert.equal(countLines('x'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\n'), 2);
  assert.equal(countLines(null), 0);
});

test('tool name classes and display names (rule A31, DESIGN 7.3)', () => {
  assert.equal(toolNameClass('Bash'), 'builtin');
  assert.equal(toolNameClass('mcp__fake-server__lookup'), 'mcp');
  assert.equal(toolNameClass('FictionalCustomTool'), 'other');
  assert.equal(toolDisplayName('mcp__fake-server__lookup'), 'MCP tools');
  assert.equal(toolDisplayName('FictionalCustomTool'), 'other tools');
  assert.equal(toolDisplayName('Read'), 'Read');
  assert.equal(TOOL_DISPLAY_NAMES.length, BUILTIN_TOOLS.length + 2);
  assert.equal(BUILTIN_TOOLS.length, 17);
});

test('model id normalization is exact (rule A9, F14)', () => {
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(normalizeModelId('claude-imaginary-9'), 'claude-imaginary-9');
  assert.equal(normalizeModelId('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(normalizeModelId(null), '');
});

test('defineAdapter validates the interface shape', () => {
  const a = defineAdapter({ id: 'claude-code', displayName: 'Claude Code', roots: () => [], classify: () => ({ action: 'skip', reason: 'unknown-shape' }), parseLine: () => [], dedupKey: defaultDedupKey, merge: defaultMerge });
  assert.ok(Object.isFrozen(a));
  assert.throws(() => defineAdapter({ id: 'x', displayName: 'X' }), /roots/);
  assert.equal(FILE_CLASS_DEPTH.main, 0);
});

const row = (id, displayName, input, read, extra = {}) => ({
  id, displayName, input, output: input * 5, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: read,
  fast: null, geoUsMultiplier: 1.1, effectiveFrom: null, effectiveUntil: null, source: 'https://platform.claude.com/docs/en/about-claude/pricing', ...extra,
});

test('price table checker enforces the 5.1 arithmetic and the Fable 5.1 exception', () => {
  const good = {
    schema: 1, provider: 'anthropic', fetched: '2026-09-14', source: 'x', label: 'API-equivalent value at list price',
    models: [
      row('claude-fable-5-1', 'Claude Fable 5.1', 10, 0.25),
      row('claude-opus-5', 'Claude Opus 5', 5, 0.5, { fast: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, derived: true } }),
      row('claude-haiku-4-5', 'Claude Haiku 4.5', 1, 0.1, { geoUsMultiplier: null }),
    ],
  };
  assert.deepEqual(checkPriceTable(good), []);
  assert.deepEqual(CACHE_READ_0025_IDS, ['claude-fable-5-1']);
  const bad = structuredClone(good);
  bad.models[1].cacheRead = 0.25;
  bad.models.push(row('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 1, 0.1));
  bad.models.push(row('claude-opus-5', 'Claude Opus 5', 5, 0.5));
  bad.models[0].input = 10.0001;
  const problems = checkPriceTable(bad);
  assert.ok(problems.some((p) => p.includes('claude-opus-5: cacheRead')));
  assert.ok(problems.some((p) => p.includes('bad id')));
  assert.ok(problems.some((p) => p.includes('duplicate id')));
  assert.ok(problems.some((p) => p.includes('at most 3 decimals')));
});

test('aggregate helpers accumulate exactly and serialize money as strings', () => {
  const agg = emptyAggregate();
  const rec = (value, complete) => ({
    complete, tokens: { input: 1, output: 2, cw5m: 3, cw1h: 4, cacheRead: 5 }, valueNano: value,
    bucketsNano: { input: value, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, webSearch: 0 },
  });
  addResponse(agg, /** @type {any} */ (rec(Number.MAX_SAFE_INTEGER, true)));
  addResponse(agg, /** @type {any} */ (rec(Number.MAX_SAFE_INTEGER, false)));
  assert.equal(agg.responses, 2);
  assert.equal(agg.incomplete, 1);
  assert.equal(agg.valueNano, 2n * BigInt(Number.MAX_SAFE_INTEGER));
  const j = aggregateToJson(agg);
  assert.equal(j.valueNano, '18014398509481982');
  assert.equal(findNonJsonValue(j), null);
  assert.equal(tokenTotal(agg.tokens), 30);
});

test('insight contract: fourteen ids, meta, definition and result checks', () => {
  assert.equal(INSIGHT_IDS.length, 14);
  assert.deepEqual(Object.keys(INSIGHT_META), [...INSIGHT_IDS]);
  const m = defineInsight({ id: 'i03', title: 'Idle-resume tax', compute: () => ({ id: 'i03', shown: false, data: {}, evidence: null, action: null }) });
  assert.deepEqual(checkInsightResult(m.compute(/** @type {any} */ ({})), 'i03'), []);
  assert.throws(() => defineInsight({ id: 'i15', title: 'x', compute: () => ({}) }));
  assert.ok(checkInsightResult({ id: 'i01', shown: 'yes', data: {}, evidence: null, action: null, extra: 1 }).length >= 2);
});

test('summary schema: the sample Summary is valid; defects are reported', () => {
  const s = makeSummary();
  assert.deepEqual(checkSummary(s), []);
  assertSummary(s);
  const bad = makeSummary();
  bad.totals.valueNano = 12.5;
  bad.insights.i07.id = 'i08';
  bad.scan.takenAt = 'yesterday';
  delete bad.insights.i14;
  const p = checkSummary(bad);
  assert.ok(p.some((x) => x.includes('totals.valueNano')));
  assert.ok(p.some((x) => x.includes('insights.i07.id')));
  assert.ok(p.some((x) => x.includes('insights.i14 missing')));
  assert.ok(p.some((x) => x.includes('scan.takenAt')));
  assert.throws(() => assertSummary(bad), TypeError);
});

test('findNonJsonValue catches values JSON would corrupt', () => {
  assert.equal(findNonJsonValue({ a: [1, 'x', null, { b: true }] }), null);
  assert.equal(findNonJsonValue({ a: 1n }), '$.a');
  assert.equal(findNonJsonValue({ a: [NaN] }), '$.a[0]');
  assert.equal(findNonJsonValue({ a: new Map() }), '$.a');
  assert.equal(findNonJsonValue({ a: undefined }), '$.a');
  assert.equal(findNonJsonValue({ a: new Date(0) }), '$.a');
});
