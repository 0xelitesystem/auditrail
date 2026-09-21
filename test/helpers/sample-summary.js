// A complete, valid, entirely fictional Summary for contract tests (summary-schema.js,
// public.js, card tests). Numbers are small and synthetic. Teams may import it; do not put
// real figures here.

import { VALUE_LABEL } from '../../src/core/constants.js';

/** The table rows a Summary carries (ids and display names only). */
export const SAMPLE_TABLE_MODELS = [
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
];

const classStats = (files) => ({ files, bytes: files * 1000, lines: files * 10, records: files * 10, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 });

/** @param {Record<string, any>} [data] @param {string} id */
function ins(id, data, shown = true) {
  return { id, shown, data, evidence: null, action: null };
}

/**
 * @returns {any} a fresh Summary object every call (safe to mutate in tests)
 */
export function makeSummary() {
  return {
    schema: 1,
    kind: 'auditrail.summary',
    tool: { name: 'auditrail', version: '0.1.0' },
    generatedAt: '2026-03-16T09:00:00.000Z',
    tz: 'UTC',
    idleMinutes: 15,
    redacted: false,
    pricing: {
      asOf: '2026-09-14',
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
      label: VALUE_LABEL,
      custom: null,
      staleDays: 0,
      tableModels: SAMPLE_TABLE_MODELS.map((m) => ({ ...m })),
    },
    scan: {
      takenAt: '2026-03-16T09:00:00.000Z',
      filesRead: 12,
      bytes: 12000,
      lines: 120,
      parseErrors: 0,
      trailingPartial: 1,
      oversizeLines: 0,
      byClass: { main: classStats(3), subagent: classStats(6), workflow_agent: classStats(2), workflow_journal: classStats(1) },
      skippedFiles: { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 },
      seconds: null,
    },
    totals: {
      responses: 400,
      incompleteResponses: 40,
      sessions: 5,
      tokens: { input: 5000, output: 90000, cw5m: 300000, cw1h: 700000, cacheRead: 9000000 },
      valueNano: '12345678900',
      pricedTokens: 10095000,
      allTokens: 10095000,
    },
    audit: {
      dedup: { observations: 1000, keys: 400, gatewayConflicts: 0, ambiguousAttach: 0, invariantViolations: 0, forkedKeys: 2, syntheticLines: 3, duplicateToolUseIds: 2, orphanToolResults: 0 },
      modifiers: { fast: 0, geoUs: 0, nonStandardTier: 0, ttlEstimated: 0, webSearchRequests: 0 },
      skippedRecords: { text_bearing: 10, no_usage_type: 20 },
      agentVersions: ['2.1.200'],
    },
    insights: {
      i01: ins('i01', {
        label: VALUE_LABEL, pricesAsOf: '2026-09-14', customRates: false, totalNano: '12345678900', responses: 400,
        incompleteResponses: 40, incompleteShare: 0.1, pricedTokens: 10095000, allTokens: 10095000, pricedTokenShare: 1,
        unpriced: [], fastResponses: 0, prompts: 60, valuePerPromptNano: '205761315',
        byMonth: [{ month: '2026-03', valueNano: '12345678900', responses: 400 }],
        byDay: [{ date: '2026-03-02', valueNano: '12345678900', responses: 400 }],
        byModel: [{ model: 'claude-opus-5', displayName: 'Claude Opus 5', valueNano: '12345678900', responses: 400 }],
        byProject: [{ label: 'fake-alpha', valueNano: '12345678900', responses: 400, sessions: 5 }],
        byClassNano: { main: '8000000000', subagent: '3000000000', workflow_agent: '1345678900' },
        plan: null, valueMultiple: null, incompleteBand: null,
      }),
      i02: ins('i02', {
        bucketsNano: { input: '25000000', output: '2250000000', cw5m: '1875000000', cw1h: '7000000000', cacheRead: '1195678900' },
        bucketShares: { input: 0.002, output: 0.182, cw5m: 0.152, cw1h: 0.567, cacheRead: 0.097 },
        cacheHitRate: 0.9, netCachingSavingNano: '1000000', tokens: { output: 90000, freshInput: 1005000, cacheRead: 9000000 },
      }),
      i03: ins('i03', {
        buckets: {
          first: { responses: 5, cacheWriteNano: '100' }, modelSwitch: { responses: 0, cacheWriteNano: '0' }, le5m: { responses: 380, cacheWriteNano: '100' },
          m5to60: { responses: 10, cacheWriteNano: '100' }, gt60m: { responses: 5, cacheWriteNano: '100' },
        },
        gt60mShareOfTotal: 0.01, fullMisses: 1, fullMissesAfterGap60: 0,
      }, false),
      i04: ins('i04', {
        delegationShare: 0.3521, sidechainNano: '4345678900', subagent: { responses: 200, valueNano: '3000000000' },
        workflowAgent: { responses: 50, valueNano: '1345678900' }, agentRuns: 8,
        byAttribution: { agent: [], skill: [], mcpServer: [] },
      }),
      i05: ins('i05', { eligibleResponses: 0, eligibleNano: '0', atSonnet5Nano: '0', differenceNano: '0', eligibleShareOfTotal: 0, label: 'fixed caveat' }, false),
      i06: ins('i06', { windows: 6, byType: [{ rateLimitType: 'five_hour', windows: 6 }], synthetic429Lines: 3, episodes: 2, episodeStartsByLocalHour: new Array(24).fill(0), valueBeforeWindows: [] }),
      i07: ins('i07', {
        toolCalls: 1000, paired: 990, statusCounts: { ok: 900, denied: 5, shell_exit: 60, failed: 25, unpaired: 10 }, failureRate: 0.086,
        byTool: [],
        callsByDisplayName: { Bash: 420, Read: 200, Edit: 180, Write: 60, Grep: 40, Glob: 20, WebFetch: 10, WebSearch: 5, 'MCP tools': 50, 'other tools': 15 },
        okCallsByDisplayName: { Bash: 380, Read: 195, Edit: 170, Write: 55, Grep: 40, Glob: 20, WebFetch: 9, WebSearch: 5, 'MCP tools': 45, 'other tools': 15 },
        topTool: { displayName: 'Bash', calls: 420, share: 0.42 },
        errorCategories: { timeout: 1, not_found: 2, permission_or_hook: 3, edit_string_not_found: 4, file_not_read_first: 0, user_rejected: 1, other: 5 },
        interrupts: 2, flagged: [],
      }),
      i08: ins('i08', { distinctFiles: 90, filesWithTenPlusEdits: 3, maxEditsOneFile: 23, maxEditsOneFileOneBlock: 9, top: [{ label: 'fake/app.js', edits: 23 }], medianEditNewLines: 4 }),
      i09: ins('i09', {
        activeSeconds: 45000, activeHours: 12.5, agentSeconds: 90000, agentHours: 25, workBlocks: 40, longestBlockSeconds: 7200,
        medianBlockSeconds: 600, p90BlockSeconds: 3000, prompts: 60, interrupts: 2, activeDays: 15, longestStreakDays: 15,
        peakHourLocal: 21, heatmap: new Array(7).fill(0).map(() => new Array(24).fill(0)), nightPromptShare: 0.4, weekendDayShare: 0.2,
        firstActiveLocalDate: '2026-03-02', lastActiveLocalDate: '2026-03-16',
      }),
      i10: ins('i10', { launched: 2, started: 10, result: 8, failed: 2, failureRate: 0.2 }),
      i11: ins('i11', { findings: [], bySeverity: { critical: 0, likely_fixture: 0, third_party_public: 0 } }, false),
      i12: ins('i12', {
        earliestMainLocalDate: '2026-03-02', earliestAnyLocalDate: '2026-03-01', latestLocalDate: '2026-03-16', coverageDays: 16,
        cleanupPeriodDays: null, retentionIsDefault: true, deletedHistoryDays: null, orphanDays: 1,
      }),
      i13: ins('i13', {
        byModel: [{ model: 'claude-opus-5', displayName: 'Claude Opus 5', responses: 400, valueNano: '12345678900', share: 1 }],
        topModel: { model: 'claude-opus-5', displayName: 'Claude Opus 5' }, thinkingShare: 0.35, effort: { high: 400 },
      }),
      i14: ins('i14', {
        activeDays: 15, workBlocks: 40, prompts: 60, interrupts: 2, filesCreated: 12, filesEdited: 80, linesWritten: 3000,
        commandIntents: [{ intent: 'test', count: 20, failures: 3 }], models: ['Claude Opus 5'], totalNano: '12345678900',
      }),
    },
  };
}
