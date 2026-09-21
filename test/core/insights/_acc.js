// Test helper: builds complete AccountingResult objects (accounting/contract.js) from compact,
// hand-written response and tool specs, so every insight can be tested with numbers computed
// by hand. Pricing here is independent of src/: it uses the fixture rate table in
// scripts/fixtures/_lib.mjs (integer milli rates), not the insight helpers under test.
// Everything is fictional: /fake paths, -fake- folders, aaaaaaaa- ids.

import { RATES_MILLI } from '../../../scripts/fixtures/_lib.mjs';
import { emptyAggregate, addResponse, tokenTotal } from '../../../src/core/accounting/contract.js';
import { toolNameClass, toolDisplayName, VALUE_LABEL } from '../../../src/core/constants.js';
import { SAMPLE_TABLE_MODELS } from '../../helpers/sample-summary.js';

const DISPLAY = Object.fromEntries(SAMPLE_TABLE_MODELS.map((m) => [m.id, m.displayName]));

const rate = (milli) => milli / 1000;
const rateSet = (r) => ({ input: rate(r.input), output: rate(r.output), cacheWrite5m: rate(r.cw5m), cacheWrite1h: rate(r.cw1h), cacheRead: rate(r.cacheRead) });

/** A PriceTable built from the fixture rates (same numbers as the golden fixtures). */
export const TEST_PRICES = Object.freeze({
  schema: 1,
  provider: 'anthropic',
  fetched: '2026-09-14',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  label: VALUE_LABEL,
  models: Object.entries(RATES_MILLI).map(([id, r]) => ({
    id,
    displayName: DISPLAY[id],
    ...rateSet(r),
    fast: r.fast ? rateSet(r.fast) : null,
    geoUsMultiplier: r.geo ? 1.1 : null,
    effectiveFrom: null,
    effectiveUntil: null,
    source: 'fixture',
  })),
});

export const S1 = 'aaaaaaaa-0000-4000-8000-00000000a001';
export const S2 = 'aaaaaaaa-0000-4000-8000-00000000a002';
export const T0 = Date.UTC(2026, 2, 2, 9, 0, 0); // 2026-03-02 09:00 UTC, a Monday
export const MIN = 60_000;
export const HOUR = 3_600_000;

const ZERO = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };

/**
 * Value of one part at the fixture rates (rules A10, A11, A33).
 * @returns {{ priced: boolean, valueNano: number, bucketsNano: object }}
 */
export function priceTokens(model, tokens, { fast = false, geoUs = false } = {}) {
  const row = RATES_MILLI[model];
  if (!row) return { priced: false, valueNano: 0, bucketsNano: { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, webSearch: 0 } };
  const r = fast && row.fast ? row.fast : row;
  const m = (x) => (geoUs && row.geo ? (x * 11) / 10 : x);
  const b = {
    input: tokens.input * m(r.input), output: tokens.output * m(r.output), cw5m: tokens.cw5m * m(r.cw5m),
    cw1h: tokens.cw1h * m(r.cw1h), cacheRead: tokens.cacheRead * m(r.cacheRead), webSearch: 0,
  };
  return { priced: true, valueNano: b.input + b.output + b.cw5m + b.cw1h + b.cacheRead, bucketsNano: b };
}

/**
 * One ResponseRecord from a compact spec. `parts` (fallback) is a list of { model, tokens }.
 */
export function resp(spec) {
  const model = spec.model ?? 'claude-opus-5';
  const fast = Boolean(spec.fast);
  const geoUs = Boolean(spec.geoUs);
  const partSpecs = spec.parts ?? [{ model, tokens: { ...ZERO, ...(spec.tokens || {}) } }];
  const parts = partSpecs.map((p) => {
    const t = { ...ZERO, ...p.tokens };
    const v = priceTokens(p.model, t, { fast, geoUs });
    return { model: p.model, priced: v.priced, tokens: t, valueNano: v.valueNano, bucketsNano: v.bucketsNano };
  });
  const tokens = { ...ZERO };
  const buckets = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, webSearch: 0 };
  let valueNano = 0;
  for (const p of parts) {
    for (const k of Object.keys(tokens)) tokens[k] += p.tokens[k];
    for (const k of Object.keys(buckets)) buckets[k] += p.bucketsNano[k];
    valueNano += p.valueNano;
  }
  const fileClass = spec.fileClass ?? 'main';
  return {
    key: spec.key,
    sessionId: spec.sessionId ?? S1,
    fileIdx: spec.fileIdx ?? 0,
    fileClass,
    isSidechain: spec.isSidechain ?? fileClass !== 'main',
    rawModel: spec.rawModel ?? model,
    model,
    priced: parts.every((p) => p.priced),
    tsStart: spec.ts === undefined ? T0 : spec.ts,
    tsEnd: spec.tsEnd ?? (spec.ts === undefined ? T0 : spec.ts),
    complete: spec.complete ?? true,
    fast,
    geoUs,
    serviceTier: 'standard',
    ttlEstimated: false,
    tokens,
    valueNano,
    bucketsNano: buckets,
    parts,
    webSearchRequests: 0,
    thinkingTokens: spec.thinkingTokens === undefined ? null : spec.thinkingTokens,
    visibleChars: spec.visibleChars ?? 0,
    effort: spec.effort === undefined ? 'high' : spec.effort,
    projectKey: spec.projectKey ?? '/fake/alpha',
    attribution: spec.attribution ?? null,
    observations: 1,
    files: 1,
  };
}

/** One ToolCallRecord from a compact spec. */
export function tool(spec) {
  const name = spec.name ?? 'Bash';
  return {
    id: spec.id,
    name,
    nameClass: toolNameClass(name),
    displayName: toolDisplayName(name),
    sessionId: spec.sessionId ?? S1,
    fileIdx: spec.fileIdx ?? 0,
    fileClass: spec.fileClass ?? 'main',
    ts: spec.ts === undefined ? T0 : spec.ts,
    status: spec.status ?? 'ok',
    denialKind: spec.denialKind ?? null,
    errorCategory: spec.errorCategory ?? null,
    resultTs: null,
    filePathHash: spec.hash ?? null,
    fileLabel: spec.fileLabel ?? null,
    editNewLines: spec.editNewLines ?? null,
    writeLines: spec.writeLines ?? null,
    commandIntents: spec.commandIntents ?? [],
  };
}

/** A 64-hex fake path hash from a small integer. */
export const hash = (n) => n.toString(16).padStart(64, '0');

function utcDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * A complete AccountingResult. Aggregates are computed from the responses with the contract's
 * own helpers (bucketed by UTC day and month, which is what the tests use as tz).
 */
export function makeAcc(o = {}) {
  const responses = [...(o.responses ?? [])].sort((a, b) => (a.tsStart ?? -Infinity) - (b.tsStart ?? -Infinity) || (a.key < b.key ? -1 : 1));
  const totals = emptyAggregate();
  const byClass = { main: emptyAggregate(), subagent: emptyAggregate(), workflow_agent: emptyAggregate() };
  const byModelMap = new Map();
  const byProjectMap = new Map();
  const byLocalDay = {};
  const byLocalMonth = {};
  let pricedTokens = 0;
  let allTokens = 0;
  const unpricedMap = new Map();
  for (const r of responses) {
    addResponse(totals, r);
    addResponse(byClass[r.fileClass], r);
    for (const p of r.parts) {
      const n = tokenTotal(p.tokens);
      allTokens += n;
      if (p.priced) pricedTokens += n;
      else {
        const u = unpricedMap.get(p.model) ?? { model: p.model, responses: 0, tokens: 0 };
        u.tokens += n;
        unpricedMap.set(p.model, u);
      }
      let m = byModelMap.get(p.model);
      if (!m) { m = { ...emptyAggregate(), model: p.model, displayName: DISPLAY[p.model] ?? null, priced: p.priced }; byModelMap.set(p.model, m); }
      m.responses++;
      m.tokens.input += p.tokens.input; m.tokens.output += p.tokens.output; m.tokens.cw5m += p.tokens.cw5m; m.tokens.cw1h += p.tokens.cw1h; m.tokens.cacheRead += p.tokens.cacheRead;
      m.valueNano += BigInt(p.valueNano);
    }
    if (!r.priced) { const bad = r.parts.find((p) => !p.priced); unpricedMap.get(bad.model).responses++; }
    if (r.projectKey) {
      let p = byProjectMap.get(r.projectKey);
      if (!p) {
        p = { ...emptyAggregate(), projectKey: r.projectKey, label: o.projectLabels?.[r.projectKey] ?? r.projectKey.split('/').pop(), sessions: 0, _s: new Set() };
        byProjectMap.set(r.projectKey, p);
      }
      addResponse(p, r);
      p._s.add(r.sessionId);
    }
    if (r.tsStart !== null) {
      const d = utcDate(r.tsStart);
      addResponse((byLocalDay[d] ??= emptyAggregate()), r);
      addResponse((byLocalMonth[d.slice(0, 7)] ??= emptyAggregate()), r);
    }
  }
  const byProject = [...byProjectMap.values()].map(({ _s, ...p }) => ({ ...p, sessions: _s.size }))
    .sort((a, b) => (a.valueNano !== b.valueNano ? (a.valueNano > b.valueNano ? -1 : 1) : a.projectKey < b.projectKey ? -1 : 1));
  const byModel = [...byModelMap.values()].sort((a, b) => (a.valueNano !== b.valueNano ? (a.valueNano > b.valueNano ? -1 : 1) : a.model < b.model ? -1 : 1));
  const sessions = [...new Set(responses.map((r) => r.sessionId))].sort().map((sessionId) => ({
    ...emptyAggregate(), sessionId, launchFolder: o.launchFolder ?? '/fake/alpha', firstTs: null, lastTs: null, activeSeconds: 0, workBlocks: 0,
  }));
  const cls = (files) => ({ files, bytes: files * 100, lines: files * 10, records: files * 10, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 });
  const time = {
    tz: 'UTC', idleSeconds: 900, activeSeconds: 0, agentSeconds: 0, agentSecondsByClass: { main: 0, subagent: 0, workflow_agent: 0 },
    workBlockSeconds: [], prompts: 0, interrupts: 0, promptsByLocalDay: {}, promptsByLocalHour: new Array(24).fill(0),
    promptHeatmap: new Array(7).fill(0).map(() => new Array(24).fill(0)), activeDays: [], longestStreakDays: 0, peakHourLocal: null,
    earliestMainTs: responses.length ? responses[0].tsStart : null, earliestAnyTs: responses.length ? responses[0].tsStart : null,
    latestTs: responses.length ? responses[responses.length - 1].tsEnd : null,
    ...(o.time || {}),
  };
  return {
    schema: 1,
    files: o.files ?? [{ idx: 0, rootIdx: 0, relPath: '-fake-alpha/' + S1 + '.jsonl', fileClass: 'main', depth: 0, size: 100 }],
    scanByClass: { main: cls(1), subagent: cls(0), workflow_agent: cls(0), workflow_journal: cls(0), ...(o.scanByClass || {}) },
    skippedFiles: { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 },
    skippedRecords: { text_bearing: 0 },
    dedup: { observations: responses.length, keys: responses.length, gatewayConflicts: 0, ambiguousAttach: 0, invariantViolations: 0, forkedKeys: 0, syntheticLines: 0, duplicateToolUseIds: 0, orphanToolResults: 0 },
    responses,
    totals,
    pricedTokens,
    allTokens,
    unpriced: [...unpricedMap.values()].sort((a, b) => (a.model < b.model ? -1 : 1)),
    byClass,
    byModel,
    bySession: sessions,
    byProject,
    byLocalDay,
    byLocalMonth,
    modifiers: { fast: responses.filter((r) => r.fast).length, geoUs: responses.filter((r) => r.geoUs).length, nonStandardTier: 0, ttlEstimated: 0, webSearchRequests: 0 },
    tools: [...(o.tools ?? [])].sort((a, b) => (a.ts ?? -Infinity) - (b.ts ?? -Infinity) || (a.id < b.id ? -1 : 1)),
    time,
    rateLimits: o.rateLimits ?? { quotaRejectWindows: [], synthetic429Ts: [] },
    workflows: o.workflows ?? { launched: 0, started: 0, result: 0, failed: 0 },
    secrets: o.secrets ?? [],
    costStateWindows: [],
    agentVersions: o.agentVersions ?? ['2.1.200'],
  };
}

/** Default insight input over an AccountingResult. */
export function input(acc, options = {}) {
  return {
    acc,
    prices: TEST_PRICES,
    options: { tz: 'UTC', idleMinutes: 15, plan: null, redact: false, cleanupPeriodDays: null, statsCacheDays: null, nowMs: Date.UTC(2026, 8, 14), custom: null, ...options },
  };
}
