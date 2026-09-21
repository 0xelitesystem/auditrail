// Insight module interface (DESIGN 6, I1 to I14).
//
// One file per insight: src/core/insights/i01-value.js ... i14-receipts.js, each exporting
//   export const insight = defineInsight({ id: 'i01', title: '...', compute(input) { ... } });
// compute() is pure arithmetic over the AccountingResult. No insight calls a model, reads a
// file or touches the network. The returned `data` must be JSON-safe (money as nanodollar
// digit strings) because it is embedded in the Summary as is.
//
// `action` is fixed copy written in the module source. It must never interpolate text taken
// from logs (project names, file names, tool names outside the allowlist, model ids outside
// the price table). Numbers may be interpolated.
//
// Isomorphic: no node:* imports and no DOM.

/** @typedef {'i01'|'i02'|'i03'|'i04'|'i05'|'i06'|'i07'|'i08'|'i09'|'i10'|'i11'|'i12'|'i13'|'i14'} InsightId */

/** Every insight id in display order. */
export const INSIGHT_IDS = Object.freeze(['i01', 'i02', 'i03', 'i04', 'i05', 'i06', 'i07', 'i08', 'i09', 'i10', 'i11', 'i12', 'i13', 'i14']);

/**
 * Static facts about each insight (DESIGN 6). `cardFields` names the PublicSummary fields the
 * insight's data may feed (via public.js only); an empty list means report only.
 */
export const INSIGHT_META = Object.freeze({
  i01: { file: 'i01-value.js', title: 'What the work was worth', cardFields: ['value', 'outputTokens'] },
  i02: { file: 'i02-money-map.js', title: 'Where the value goes', cardFields: ['cacheHitRate'] },
  i03: { file: 'i03-idle-resume.js', title: 'Idle-resume tax', cardFields: [] },
  i04: { file: 'i04-delegation.js', title: 'Delegation', cardFields: ['delegationShare'] },
  i05: { file: 'i05-repricing.js', title: 'Repricing what-if', cardFields: [] },
  i06: { file: 'i06-rate-limits.js', title: 'Rate-limit walls', cardFields: ['rateLimitWindows'] },
  i07: { file: 'i07-tools.js', title: 'Tool reliability', cardFields: ['toolCalls', 'topTool'] },
  i08: { file: 'i08-churn.js', title: 'Churn hot spots', cardFields: ['maxEditsOneFile'] },
  i09: { file: 'i09-patterns.js', title: 'Working patterns', cardFields: ['activeHours', 'coverage', 'longestStreakDays', 'peakHourLocal'] },
  i10: { file: 'i10-workflows.js', title: 'Workflow agent outcomes', cardFields: [] },
  i11: { file: 'i11-secrets.js', title: 'Secrets in transcripts', cardFields: [] },
  i12: { file: 'i12-history.js', title: 'History at risk', cardFields: ['coverage'] },
  i13: { file: 'i13-models.js', title: 'Model and effort mix', cardFields: ['topModel'] },
  i14: { file: 'i14-receipts.js', title: 'Activity receipts', cardFields: [] },
});

/**
 * @typedef {Object} InsightOptions
 * @property {string} tz
 * @property {number} idleMinutes
 * @property {{ name: string|null, usdPerMonth: number }|null} plan   --plan or --plan-price; never inferred
 * @property {boolean} redact                  replace labels with "Project A", ... (the Summary builder
 *                                             also enforces this; insights must not bypass it)
 * @property {number|null} cleanupPeriodDays   from ~/.claude/settings(.local).json, null when unset
 * @property {string[]|null} statsCacheDays    local dates from ~/.claude/stats-cache.json, null when absent
 * @property {number} nowMs                    the scan clock (injected so tests are reproducible)
 */

/**
 * @typedef {Object} InsightInput
 * @property {import('../accounting/contract.js').AccountingResult} acc
 * @property {import('../accounting/contract.js').PriceTable} prices
 * @property {InsightOptions} options
 */

/**
 * @template [D=Record<string, unknown>]
 * @typedef {Object} InsightResult
 * @property {InsightId} id
 * @property {boolean} shown          the insight's "Shown" rule from DESIGN 6 evaluated on this data
 * @property {D} data                 JSON-safe, per-insight shape below
 * @property {{ count: number, unit: string }|null} evidence  e.g. { count: 320, unit: 'responses' }
 * @property {string|null} action     the one recommended action (fixed copy)
 */

/**
 * @typedef {Object} InsightModule
 * @property {InsightId} id
 * @property {string} title
 * @property {(input: InsightInput) => InsightResult} compute
 */

/**
 * Validate and freeze an insight module definition.
 * @param {InsightModule} m
 * @returns {InsightModule}
 */
export function defineInsight(m) {
  if (!m || typeof m !== 'object') throw new TypeError('insight must be an object');
  if (!INSIGHT_IDS.includes(m.id)) throw new TypeError('insight id must be one of ' + INSIGHT_IDS.join(', '));
  if (typeof m.title !== 'string' || !m.title) throw new TypeError(m.id + ': title must be a non-empty string');
  if (typeof m.compute !== 'function') throw new TypeError(m.id + ': compute must be a function');
  return Object.freeze({ ...m });
}

/**
 * Check one InsightResult. Returns problems; empty means valid.
 * @param {unknown} r
 * @param {InsightId} [expectedId]
 * @returns {string[]}
 */
export function checkInsightResult(r, expectedId) {
  const p = [];
  const x = /** @type {any} */ (r);
  if (!x || typeof x !== 'object') return ['result must be an object'];
  const allowed = new Set(['id', 'shown', 'data', 'evidence', 'action']);
  for (const k of Object.keys(x)) if (!allowed.has(k)) p.push('unexpected key ' + k);
  if (!INSIGHT_IDS.includes(x.id)) p.push('bad id');
  if (expectedId && x.id !== expectedId) p.push('id must be ' + expectedId);
  if (typeof x.shown !== 'boolean') p.push('shown must be a boolean');
  if (!x.data || typeof x.data !== 'object' || Array.isArray(x.data)) p.push('data must be an object');
  if (x.evidence !== null && (typeof x.evidence !== 'object' || !Number.isFinite(x.evidence.count) || typeof x.evidence.unit !== 'string')) {
    p.push('evidence must be null or { count, unit }');
  }
  if (x.action !== null && (typeof x.action !== 'string' || x.action.length > 400)) p.push('action must be null or a string of at most 400 characters');
  return p;
}

/* ------------------------------------------------------------------------------------------
 * Per-insight data shapes. Money fields are nanodollar digit strings. Fields marked LOCAL
 * hold labels that exist only in the local report (replaced under --redact) and are never
 * read by public.js. Fields marked PUBLIC-SOURCE are read by the PublicSummary allowlist and
 * must keep their exact name and type.
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} I01ValueData
 * @property {string} label                 VALUE_LABEL or custom-rates label
 * @property {string} pricesAsOf
 * @property {boolean} customRates          PUBLIC-SOURCE
 * @property {string} totalNano             PUBLIC-SOURCE (lower bound)
 * @property {number} responses
 * @property {number} incompleteResponses
 * @property {number} incompleteShare
 * @property {number} pricedTokens          PUBLIC-SOURCE
 * @property {number} allTokens             PUBLIC-SOURCE
 * @property {number} pricedTokenShare
 * @property {{ model: string, responses: number, tokens: number }[]} unpriced   LOCAL (model ids as written)
 * @property {number} fastResponses         "possibly billed as usage credits" (rule A10)
 * @property {number} prompts
 * @property {string|null} valuePerPromptNano
 * @property {{ month: string, valueNano: string, responses: number }[]} byMonth
 * @property {{ date: string, valueNano: string, responses: number }[]} byDay
 * @property {{ model: string, displayName: string|null, valueNano: string, responses: number }[]} byModel
 * @property {{ label: string, valueNano: string, responses: number, sessions: number }[]} byProject  LOCAL
 * @property {{ main: string, subagent: string, workflow_agent: string }} byClassNano
 * @property {{ name: string|null, usdPerMonth: number }|null} plan
 * @property {number|null} valueMultiple    (totalNano / months with responses) / plan price; null without --plan
 * @property {{ lowTokens: number, highTokens: number, lowNano: string, highNano: string }|null} incompleteBand
 *   rule A6: report only, never in any total, the card or an export total
 */

/**
 * @typedef {Object} I02MoneyMapData
 * @property {{ input: string, output: string, cw5m: string, cw1h: string, cacheRead: string }} bucketsNano
 * @property {{ input: number, output: number, cw5m: number, cw1h: number, cacheRead: number }} bucketShares
 * @property {number} cacheHitRate          PUBLIC-SOURCE: cacheRead / (cacheRead + cw5m + cw1h + input)
 * @property {string} netCachingSavingNano  may be negative
 * @property {{ output: number, freshInput: number, cacheRead: number }} tokens  three headline figures, never one total
 */

/**
 * @typedef {{ responses: number, cacheWriteNano: string }} IdleBucket
 * @typedef {Object} I03IdleResumeData
 * @property {{ first: IdleBucket, modelSwitch: IdleBucket, le5m: IdleBucket, m5to60: IdleBucket, gt60m: IdleBucket }} buckets
 * @property {number} gt60mShareOfTotal
 * @property {number} fullMisses            cacheRead == 0 and cw5m + cw1h > 20,000
 * @property {number} fullMissesAfterGap60
 */

/**
 * @typedef {{ name: string, responses: number, valueNano: string }} NamedValue
 * @typedef {Object} I04DelegationData
 * @property {number} delegationShare       PUBLIC-SOURCE: value(isSidechain) / total value
 * @property {string} sidechainNano
 * @property {{ responses: number, valueNano: string }} subagent
 * @property {{ responses: number, valueNano: string }} workflowAgent
 * @property {number} agentRuns             subagent plus workflow agent files with at least one response
 * @property {{ agent: NamedValue[], skill: NamedValue[], mcpServer: NamedValue[] }} byAttribution  LOCAL
 */

/**
 * @typedef {Object} I05RepricingData
 * @property {number} eligibleResponses     sidechain responses on Opus or Fable models
 * @property {string} eligibleNano
 * @property {string} atSonnet5Nano
 * @property {string} differenceNano
 * @property {number} eligibleShareOfTotal
 * @property {string} label                 the verbatim caveat from DESIGN I5
 */

/**
 * @typedef {Object} I06RateLimitData
 * @property {number} windows               PUBLIC-SOURCE (opt-in only): distinct resetsAt with status rejected
 * @property {{ rateLimitType: string, windows: number }[]} byType
 * @property {number} synthetic429Lines
 * @property {number} episodes              synthetic 429 lines clustered with a 30-minute gap
 * @property {number[]} episodeStartsByLocalHour  24 entries
 * @property {{ model: string, valueNano: string }[]} valueBeforeWindows  5 hours before each window's first rejection
 */

/**
 * @typedef {Object} ToolRow
 * @property {string} name                  LOCAL when nameClass is not 'builtin'
 * @property {string} displayName
 * @property {'builtin'|'mcp'|'other'} nameClass
 * @property {number} calls
 * @property {number} paired
 * @property {number} ok
 * @property {number} denied
 * @property {number} shellExit
 * @property {number} failed
 * @property {number} unpaired
 * @property {number} failureRate           (shellExit + failed) / paired
 * @property {number} longestFailRun        consecutive failing results within one file
 */

/**
 * @typedef {Object} I07ToolsData
 * @property {number} toolCalls             PUBLIC-SOURCE: deduped tool_use count
 * @property {number} paired
 * @property {{ ok: number, denied: number, shell_exit: number, failed: number, unpaired: number }} statusCounts
 * @property {number} failureRate
 * @property {ToolRow[]} byTool             sorted by calls desc, then name
 * @property {Record<string, number>} callsByDisplayName    PUBLIC-SOURCE: keys from TOOL_DISPLAY_NAMES only
 * @property {Record<string, number>} okCallsByDisplayName  PUBLIC-SOURCE: keys from TOOL_DISPLAY_NAMES only
 * @property {{ displayName: string, calls: number, share: number }|null} topTool  PUBLIC-SOURCE
 *   top by calls over display names (all MCP tools count as one "MCP tools" entry); ties by TOOL_DISPLAY_NAMES order
 * @property {Record<string, number>} errorCategories  ERROR_CATEGORIES -> count
 * @property {number} interrupts
 * @property {string[]} flagged             ToolRow.name values shown in the table (>= 50 calls and >= 5% failure, plus top 3 by failures)
 */

/**
 * @typedef {Object} I08ChurnData
 * @property {number} distinctFiles          distinct hashed paths with ok Edit, MultiEdit or Write calls
 * @property {number} filesWithTenPlusEdits
 * @property {number} maxEditsOneFile        PUBLIC-SOURCE
 * @property {number} maxEditsOneFileOneBlock
 * @property {{ label: string, edits: number }[]} top   LOCAL, at most 10, "<parent>/<basename>" only
 * @property {number|null} medianEditNewLines PUBLIC-SOURCE (Surgeon secondary condition): median editNewLines per ok Edit
 */

/**
 * @typedef {Object} I09PatternsData
 * @property {number} activeSeconds
 * @property {number} activeHours            PUBLIC-SOURCE: activeSeconds / 3600 rounded to 1 decimal
 * @property {number} agentSeconds
 * @property {number} agentHours
 * @property {number} workBlocks
 * @property {number} longestBlockSeconds
 * @property {number} medianBlockSeconds
 * @property {number} p90BlockSeconds
 * @property {number} prompts
 * @property {number} interrupts
 * @property {number} activeDays             PUBLIC-SOURCE
 * @property {number} longestStreakDays      PUBLIC-SOURCE
 * @property {number|null} peakHourLocal     PUBLIC-SOURCE
 * @property {number[][]} heatmap            7 x 24, weekday 0 = Monday
 * @property {number} nightPromptShare       PUBLIC-SOURCE (badge): prompts 20:00 to 04:59 local / prompts
 * @property {number} weekendDayShare        PUBLIC-SOURCE (badge): Saturday or Sunday active days / active days
 * @property {string|null} firstActiveLocalDate
 * @property {string|null} lastActiveLocalDate
 */

/**
 * @typedef {Object} I10WorkflowsData
 * @property {number} launched
 * @property {number} started
 * @property {number} result
 * @property {number} failed
 * @property {number} failureRate            failed / started
 */

/**
 * @typedef {Object} I11SecretsData
 * @property {{ secretType: string, fingerprint12: string, copies: number, files: number, newestLocalDate: string|null, severity: string, source: string, expired: boolean|null, projectLabels: string[] }[]} findings  LOCAL
 * @property {{ critical: number, likely_fixture: number, third_party_public: number }} bySeverity
 */

/**
 * @typedef {Object} I12HistoryData
 * @property {string|null} earliestMainLocalDate
 * @property {string|null} earliestAnyLocalDate   PUBLIC-SOURCE (card coverage from)
 * @property {string|null} latestLocalDate        PUBLIC-SOURCE (card coverage to)
 * @property {number} coverageDays
 * @property {number|null} cleanupPeriodDays      null when unset
 * @property {boolean} retentionIsDefault         true when unset (the 30-day default applies)
 * @property {number|null} deletedHistoryDays     stats-cache days earlier than the earliest main-thread transcript
 * @property {number} orphanDays                  local days with subagent events but no main-thread event
 */

/**
 * @typedef {Object} I13ModelsData
 * @property {{ model: string, displayName: string|null, responses: number, valueNano: string, share: number }[]} byModel
 * @property {{ model: string, displayName: string|null }|null} topModel  PUBLIC-SOURCE: top by value, ties by model id
 * @property {number|null} thinkingShare
 * @property {Record<string, number>} effort
 */

/**
 * @typedef {Object} I14ReceiptsData
 * @property {number} activeDays
 * @property {number} workBlocks
 * @property {number} prompts
 * @property {number} interrupts
 * @property {number} filesCreated           PUBLIC-SOURCE (Builder secondary condition): ok Write with no prior Write or Edit of that hash
 * @property {number} filesEdited
 * @property {number} linesWritten           "lines written by agent tool calls, not lines that survived"
 * @property {{ intent: string, count: number, failures: number }[]} commandIntents
 * @property {string[]} models               display names for priced models; LOCAL ids for unpriced
 * @property {string} totalNano
 */
