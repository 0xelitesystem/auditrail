// Accounting OUTPUT contract (DESIGN 4, 5, rule A33).
//
// Accounting consumes NormalizedEvents (adapters/contract.js) and produces an AccountingResult:
// deduped per-response records with integer money, tool call records with statuses, time
// figures, and per-class, per-model, per-session, per-project and per-day aggregates.
// Insights read ONLY the AccountingResult. The Summary (summary-schema.js) is built from the
// AccountingResult plus insight results.
//
// Money: per-response amounts are safe-integer Numbers of nanodollars; aggregates are BigInt
// nanodollars (see ../money.js). Nothing here is ever a float amount.
//
// Isomorphic: no node:* imports and no DOM.

import { rateToMilli } from '../money.js';

export const ACCOUNTING_SCHEMA = 1;

/* ------------------------------------------------------------------------------------------
 * Price table (DESIGN 5.1). File: src/core/prices/anthropic-YYYY-MM-DD.json
 * ---------------------------------------------------------------------------------------- */

/**
 * Rates in USD per million tokens, at most 3 decimals each.
 * @typedef {Object} RateSet
 * @property {number} input
 * @property {number} output
 * @property {number} cacheWrite5m
 * @property {number} cacheWrite1h
 * @property {number} cacheRead
 */

/**
 * @typedef {RateSet & {
 *   id: string,
 *   displayName: string,
 *   fast: (RateSet & { derived?: boolean }) | null,
 *   geoUsMultiplier: 1.1 | null,
 *   effectiveFrom: string|null,
 *   effectiveUntil: string|null,
 *   source: string,
 * }} PriceRow
 *
 * id          normalized model id (rule A9), matched EXACTLY
 * fast        fast-mode rates (rule A10) or null; derived:true marks computed cache rates
 * geoUsMultiplier  1.1 when inference_geo "us" applies (rule A11), else null
 */

/**
 * @typedef {Object} PriceTable
 * @property {1} schema
 * @property {string} provider   'anthropic'
 * @property {string} fetched    'YYYY-MM-DD' (the "as of" date printed with every dollar figure)
 * @property {string} source     URL of the pricing page
 * @property {string} label      'API-equivalent value at list price'
 * @property {PriceRow[]} models
 */

/** Model ids whose cache read is 0.025x input instead of 0.1x (DESIGN 5.3 footnote). */
export const CACHE_READ_0025_IDS = Object.freeze(['claude-fable-5-1']);

/**
 * Structural and arithmetic check of a price table (DESIGN 5.1 unit test): every rate has at
 * most 3 decimals and is a multiple of 10 milli (so 1.1x stays exact), ids are unique and
 * normalized, and cacheWrite5m = 1.25x, cacheWrite1h = 2x, cacheRead = 0.1x input (0.025x for
 * CACHE_READ_0025_IDS). Returns a list of problems; empty means valid.
 * @param {unknown} table
 * @returns {string[]}
 */
export function checkPriceTable(table) {
  const problems = [];
  const t = /** @type {any} */ (table);
  if (!t || typeof t !== 'object') return ['table must be an object'];
  if (t.schema !== 1) problems.push('schema must be 1');
  if (typeof t.fetched !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.fetched)) problems.push('fetched must be YYYY-MM-DD');
  if (!Array.isArray(t.models) || t.models.length === 0) return problems.concat('models must be a non-empty array');
  const seen = new Set();
  for (const row of t.models) {
    const id = row && row.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.\-]*$/.test(id) || /-\d{8}$/.test(id)) { problems.push('bad id: ' + String(id)); continue; }
    if (seen.has(id)) problems.push('duplicate id: ' + id);
    seen.add(id);
    if (typeof row.displayName !== 'string' || !/^[A-Za-z0-9 .]+$/.test(row.displayName)) problems.push(id + ': displayName must be plain ASCII words');
    const sets = [['', row]];
    if (row.fast) sets.push(['fast.', row.fast]);
    for (const [pfx, rs] of sets) {
      for (const k of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']) {
        let milli;
        try { milli = rateToMilli(rs[k]); } catch { problems.push(id + ': ' + pfx + k + ' is not a rate with at most 3 decimals'); continue; }
        if (milli % 10 !== 0) problems.push(id + ': ' + pfx + k + ' is not a multiple of 10 milli');
      }
      const inM = safeMilli(rs.input);
      if (inM === null) continue;
      if (safeMilli(rs.cacheWrite5m) !== inM * 5 / 4) problems.push(id + ': ' + pfx + 'cacheWrite5m must be 1.25x input');
      if (safeMilli(rs.cacheWrite1h) !== inM * 2) problems.push(id + ': ' + pfx + 'cacheWrite1h must be 2x input');
      const readMult = CACHE_READ_0025_IDS.includes(id) ? 0.025 : 0.1;
      if (safeMilli(rs.cacheRead) !== Math.round(inM * readMult)) problems.push(id + ': ' + pfx + 'cacheRead must be ' + readMult + 'x input');
    }
    if (row.geoUsMultiplier !== null && row.geoUsMultiplier !== 1.1) problems.push(id + ': geoUsMultiplier must be 1.1 or null');
  }
  return problems;
}

/** @param {unknown} v @returns {number|null} */
function safeMilli(v) {
  try { return rateToMilli(/** @type {number} */ (v)); } catch { return null; }
}

/**
 * User price overrides (DESIGN 5.2), compatible with Claude Code's modelPricing setting.
 * An override row is used exactly as written: no fast-mode and no US-inference surcharge.
 * `cacheWrite` covers both TTLs unless cacheWrite5m / cacheWrite1h are given.
 * `multiplier` (at most 3 decimals) applies on top of every value, per bucket, rounded half up
 * to whole nanodollars (money.applyMultiplierMilli).
 *
 * @typedef {Object} PriceOverrides
 * @property {string} fileName          base name only, shown as "value at your custom rates (<fileName>)"
 * @property {number|null} multiplier
 * @property {Record<string, { input: number, output: number, cacheRead: number, cacheWrite?: number, cacheWrite5m?: number, cacheWrite1h?: number }>} overrides
 */

/* ------------------------------------------------------------------------------------------
 * Per-response records (after dedup and pricing)
 * ---------------------------------------------------------------------------------------- */

/**
 * The five priced token categories. input is UNCACHED input.
 * @typedef {Object} TokenCounts
 * @property {number} input
 * @property {number} output
 * @property {number} cw5m
 * @property {number} cw1h
 * @property {number} cacheRead
 */

/**
 * Value per category, nanodollars. Per response these are safe-integer Numbers.
 * @typedef {Object} BucketsNano
 * @property {number} input
 * @property {number} output
 * @property {number} cw5m
 * @property {number} cw1h
 * @property {number} cacheRead
 * @property {number} webSearch   rule A13 ($10 per 1,000 web_search_requests)
 */

/**
 * One billed attempt of a response (rule A8). A response without a multi-entry iterations
 * array has exactly one part built from top-level usage.
 *
 * @typedef {Object} BilledPart
 * @property {string} model        normalized id of the model that ran this attempt
 * @property {boolean} priced      false when model is not in the price table (unpriced bucket)
 * @property {TokenCounts} tokens  after the rule A7 TTL resolution
 * @property {number} valueNano    sum of bucketsNano; 0 when unpriced
 * @property {BucketsNano} bucketsNano
 */

/**
 * One API response after dedup (rules A1 to A4) and pricing (A7 to A14, A33).
 *
 * @typedef {Object} ResponseRecord
 * @property {string} key            dedup key; 'id|requestId' after a rule A2 split
 * @property {string|null} sessionId
 * @property {number} fileIdx        file of the KEPT observation
 * @property {import('../adapters/contract.js').FileClass} fileClass
 * @property {boolean} isSidechain   from the kept line
 * @property {string|null} rawModel  top-level model as written (in memory; unpriced names reach the local report only)
 * @property {string} model          normalized top-level model id (rule A9)
 * @property {boolean} priced        true when every billed part is priced
 * @property {number|null} tsStart   min timestamp over all observations of the key (epoch ms)
 * @property {number|null} tsEnd     max timestamp over all observations of the key
 * @property {boolean} complete      rule A5 on the kept line
 * @property {boolean} fast          usage.speed === 'fast' on a model with fast rates (rule A10)
 * @property {boolean} geoUs         usage.inference_geo === 'us' on a model with geoUsMultiplier (rule A11)
 * @property {string|null} serviceTier
 * @property {boolean} ttlEstimated  the cache split was absent and all writes were priced at 5m (rule A7)
 * @property {TokenCounts} tokens    sums over billed parts
 * @property {number} valueNano      sums over billed parts (priced parts only)
 * @property {BucketsNano} bucketsNano
 * @property {BilledPart[]} parts
 * @property {number} webSearchRequests
 * @property {number|null} thinkingTokens  inside output (rule A14), breakdown only
 * @property {number} visibleChars   summed over distinct line uuids of the key (rule A6 band)
 * @property {string|null} effort
 * @property {string|null} projectKey  normalized launch-folder key (rule A29); sensitive, local only
 * @property {import('../adapters/contract.js').Attribution|null} attribution
 * @property {number} observations   lines seen for this key (all files)
 * @property {number} files          distinct files the key appeared in (more than 1 means a fork)
 */

/* ------------------------------------------------------------------------------------------
 * Tool call records (rules A30 to A32)
 * ---------------------------------------------------------------------------------------- */

/** @typedef {'ok'|'denied'|'shell_exit'|'failed'|'unpaired'} ToolStatus */
export const TOOL_STATUSES = Object.freeze(['ok', 'denied', 'shell_exit', 'failed', 'unpaired']);

/**
 * @typedef {Object} ToolCallRecord
 * @property {string} id
 * @property {string} name           raw name (local report only when not builtin)
 * @property {'builtin'|'mcp'|'other'} nameClass
 * @property {string} displayName    toolDisplayName(name)
 * @property {string|null} sessionId
 * @property {number} fileIdx        file of the kept tool_use (rule A3 file order)
 * @property {import('../adapters/contract.js').FileClass} fileClass
 * @property {number|null} ts
 * @property {ToolStatus} status
 * @property {string|null} denialKind
 * @property {string|null} errorCategory
 * @property {number|null} resultTs
 * @property {string|null} filePathHash
 * @property {string|null} fileLabel     sensitive, local only
 * @property {number|null} editNewLines  counted only when status === 'ok' (rule A32)
 * @property {number|null} writeLines    counted only when status === 'ok'
 * @property {string[]} commandIntents
 */

/* ------------------------------------------------------------------------------------------
 * Aggregates
 * ---------------------------------------------------------------------------------------- */

/**
 * Exact aggregate over a set of responses. BigInt money.
 * @typedef {Object} Aggregate
 * @property {number} responses
 * @property {number} incomplete
 * @property {TokenCounts} tokens
 * @property {bigint} valueNano
 * @property {{ input: bigint, output: bigint, cw5m: bigint, cw1h: bigint, cacheRead: bigint, webSearch: bigint }} bucketsNano
 */

/** @returns {TokenCounts} */
export function emptyTokens() {
  return { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
}

/**
 * Add `b` into `a` in place.
 * @param {TokenCounts} a
 * @param {TokenCounts} b
 * @returns {TokenCounts} a
 */
export function addTokens(a, b) {
  a.input += b.input; a.output += b.output; a.cw5m += b.cw5m; a.cw1h += b.cw1h; a.cacheRead += b.cacheRead;
  return a;
}

/**
 * All tokens of a TokenCounts (input + output + both writes + reads). Used for the priced
 * token share (I1). Never a headline (I2: output, fresh input and cache reads are always
 * shown as three figures).
 * @param {TokenCounts} t
 * @returns {number}
 */
export function tokenTotal(t) {
  return t.input + t.output + t.cw5m + t.cw1h + t.cacheRead;
}

/** @returns {Aggregate} */
export function emptyAggregate() {
  return {
    responses: 0,
    incomplete: 0,
    tokens: emptyTokens(),
    valueNano: 0n,
    bucketsNano: { input: 0n, output: 0n, cw5m: 0n, cw1h: 0n, cacheRead: 0n, webSearch: 0n },
  };
}

/**
 * Add one response into an aggregate in place. Unpriced parts add tokens but no value.
 * @param {Aggregate} agg
 * @param {ResponseRecord} r
 * @returns {Aggregate} agg
 */
export function addResponse(agg, r) {
  agg.responses++;
  if (!r.complete) agg.incomplete++;
  addTokens(agg.tokens, r.tokens);
  agg.valueNano += BigInt(r.valueNano);
  const b = agg.bucketsNano;
  b.input += BigInt(r.bucketsNano.input);
  b.output += BigInt(r.bucketsNano.output);
  b.cw5m += BigInt(r.bucketsNano.cw5m);
  b.cw1h += BigInt(r.bucketsNano.cw1h);
  b.cacheRead += BigInt(r.bucketsNano.cacheRead);
  b.webSearch += BigInt(r.bucketsNano.webSearch);
  return agg;
}

/**
 * JSON form of an Aggregate: money as nanodollar digit strings.
 * @typedef {Object} AggregateJson
 * @property {number} responses
 * @property {number} incomplete
 * @property {TokenCounts} tokens
 * @property {string} valueNano
 * @property {{ input: string, output: string, cw5m: string, cw1h: string, cacheRead: string, webSearch: string }} bucketsNano
 */

/**
 * @param {Aggregate} agg
 * @returns {AggregateJson}
 */
export function aggregateToJson(agg) {
  const b = agg.bucketsNano;
  return {
    responses: agg.responses,
    incomplete: agg.incomplete,
    tokens: { ...agg.tokens },
    valueNano: agg.valueNano.toString(),
    bucketsNano: {
      input: b.input.toString(), output: b.output.toString(), cw5m: b.cw5m.toString(),
      cw1h: b.cw1h.toString(), cacheRead: b.cacheRead.toString(), webSearch: b.webSearch.toString(),
    },
  };
}

/**
 * @typedef {Aggregate & { model: string, displayName: string|null, priced: boolean }} ModelAggregate
 *   grouped by BilledPart.model (a fallback response contributes to both models)
 */

/**
 * @typedef {Aggregate & {
 *   sessionId: string,
 *   launchFolder: string|null,
 *   firstTs: number|null,
 *   lastTs: number|null,
 *   activeSeconds: number,
 *   workBlocks: number,
 * }} SessionAggregate
 *   launchFolder: normalized first main-thread cwd (rule A29); sensitive, local only
 */

/**
 * @typedef {Aggregate & { projectKey: string, label: string, sessions: number }} ProjectAggregate
 *   projectKey sensitive, local only. label = basename of the key or the rules-file label;
 *   the Summary builder replaces it with "Project A", "Project B", ... under --redact.
 */

/* ------------------------------------------------------------------------------------------
 * Time (rules A21 to A25)
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} TimeResult
 * @property {string} tz                    IANA zone used for every local bucket (rule A21)
 * @property {number} idleSeconds           cutoff; a gap counts iff gap <= idleSeconds
 * @property {number} activeSeconds         rule A22: per-session union of user and assistant
 *                                          timestamps across the whole session tree, line uuids
 *                                          deduped globally, gaps <= cutoff summed, then summed
 *                                          over sessions
 * @property {number} agentSeconds          rule A23: the same per FILE, summed (forked lines
 *                                          counted once, in the file the rule A3 order prefers)
 * @property {{ main: number, subagent: number, workflow_agent: number }} agentSecondsByClass
 * @property {number[]} workBlockSeconds    rule A24: duration (last minus first timestamp) of every
 *                                          maximal run with no gap above the cutoff, over all
 *                                          sessions, sorted ascending; a lone timestamp is a 0 s block
 * @property {number} prompts               rule A25, deduped by uuid
 * @property {number} interrupts
 * @property {Record<string, number>} promptsByLocalDay   'YYYY-MM-DD' -> prompts
 * @property {number[]} promptsByLocalHour  24 entries
 * @property {number[][]} promptHeatmap     7 x 24, weekday index 0 = Monday ... 6 = Sunday
 * @property {string[]} activeDays          sorted local dates with at least one prompt
 * @property {number} longestStreakDays     longest run of consecutive active days
 * @property {number|null} peakHourLocal    local hour with the most prompts (ties: earlier hour)
 * @property {number|null} earliestMainTs   earliest main-thread event (rule A27), epoch ms
 * @property {number|null} earliestAnyTs    earliest event in any file
 * @property {number|null} latestTs         latest event in any file
 */

/* ------------------------------------------------------------------------------------------
 * The whole result
 * ---------------------------------------------------------------------------------------- */

/**
 * Scan receipts per file class (rules A28, trap 1).
 * @typedef {Object} ClassScanStats
 * @property {number} files
 * @property {number} bytes
 * @property {number} lines
 * @property {number} records
 * @property {number} parseErrors
 * @property {number} trailingPartial
 * @property {number} oversizeLines
 */

/**
 * @typedef {Object} DedupStats
 * @property {number} observations          non-synthetic assistant lines with usage
 * @property {number} keys                  distinct responses after rules A1 and A2
 * @property {number} gatewayConflicts      message ids split by rule A2
 * @property {number} ambiguousAttach       empty-requestId lines attached to the smallest requestId of a split id
 * @property {number} invariantViolations   keys whose input or cache fields differ across lines (rule A4)
 * @property {number} forkedKeys            keys observed in more than one file (rule A3 attribution)
 * @property {number} syntheticLines        rule A15
 * @property {number} duplicateToolUseIds   rule A30
 * @property {number} orphanToolResults     results with no matching tool_use
 */

/**
 * @typedef {Object} AccountingResult
 * @property {1} schema
 * @property {import('../adapters/contract.js').FileRef[]} files   in-memory only (relPath is sensitive)
 * @property {Record<import('../adapters/contract.js').FileClass, ClassScanStats>} scanByClass
 * @property {{ compressed: number, 'unknown-extension': number, 'unknown-shape': number }} skippedFiles
 * @property {Record<string, number>} skippedRecords   SkippedEvent.reason -> count
 * @property {DedupStats} dedup
 * @property {ResponseRecord[]} responses   sorted by (tsStart, key) so output order never depends on walk order
 * @property {Aggregate} totals              priced and unpriced responses; value from priced parts only
 * @property {number} pricedTokens           tokenTotal over priced parts
 * @property {number} allTokens              tokenTotal over all non-synthetic responses
 * @property {{ model: string, responses: number, tokens: number }[]} unpriced  sorted by model; names local only
 * @property {Record<'main'|'subagent'|'workflow_agent', Aggregate>} byClass
 * @property {ModelAggregate[]} byModel      sorted by valueNano desc, then model
 * @property {SessionAggregate[]} bySession  sorted by firstTs, then sessionId
 * @property {ProjectAggregate[]} byProject  sorted by valueNano desc, then projectKey
 * @property {Record<string, Aggregate>} byLocalDay    'YYYY-MM-DD' (tsStart in tz)
 * @property {Record<string, Aggregate>} byLocalMonth  'YYYY-MM'
 * @property {{ fast: number, geoUs: number, nonStandardTier: number, ttlEstimated: number, webSearchRequests: number }} modifiers
 * @property {ToolCallRecord[]} tools        sorted by (ts, id)
 * @property {TimeResult} time
 * @property {{ quotaRejectWindows: { resetsAt: number, rateLimitType: string|null, firstRejectTs: number|null }[], synthetic429Ts: number[] }} rateLimits
 * @property {{ launched: number, started: number, result: number, failed: number }} workflows
 * @property {{ secretType: string, fingerprint12: string, severity: string, source: string, copies: number, files: number, newestTs: number|null, expired: boolean|null, projectKeys: string[] }[]} secrets
 * @property {{ sessionId: string, startTime: number|null, lastTs: number|null, reportedCostNano: number|null, models: import('../adapters/contract.js').CostStateModel[] }[]} costStateWindows
 *   last snapshot per (sessionId, startTime); AUDIT ONLY (rules A17, A26)
 * @property {string[]} agentVersions        distinct versions seen, sorted (audit)
 */

/**
 * Value of the golden-core fixture under each counting method (DESIGN 4.3, 9.4). The same
 * function feeds `auditrail audit --methods` and the README ratio table.
 *
 * @typedef {Object} MethodsDiagnostics
 * @property {bigint} correct         rules A1 to A33
 * @property {bigint} sumEveryLine    every usage line priced as if it were a response
 * @property {bigint} keepFirstLine   global dedup, first line kept instead of the max-output line
 * @property {bigint} dedupPerFile    dedup keyed per file instead of globally
 * @property {bigint} allWritesAt5m   correct dedup, every cache write priced at the 5m rate
 * @property {bigint} mainFilesOnly   correct dedup over main-thread files only (non-recursive glob)
 */

/**
 * Options for the accounting pipeline.
 * @typedef {Object} AccountingOptions
 * @property {string} tz
 * @property {number} idleMinutes
 * @property {'win32'|'posix'|'auto'} pathStyle
 * @property {PriceTable} prices
 * @property {PriceOverrides|null} overrides
 * @property {{ prefix: string, label: string }[]} projectRules   ~/.auditrail/projects.json (rule A29)
 * @property {number|null} since   epoch ms, inclusive (--since)
 * @property {number|null} until   epoch ms, exclusive (--until)
 */
