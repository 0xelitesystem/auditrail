// I12. History at risk (DESIGN 6 I12, rule A27, traps 9, 10, 11, 64).
//
// Coverage from event timestamps only (never file mtime): the earliest main-thread event, the
// earliest event in any file (orphaned subagent files outlive their parents), and the latest
// event. cleanupPeriodDays comes from the user's settings (null when unset, so the 30-day
// default applies). Days present in stats-cache that are earlier than the earliest main-thread
// transcript are history already deleted. Orphan days are local days with sidechain responses
// but no main-thread response or prompt (the AccountingResult keeps per-response classes and
// per-day prompts, which is what this can be computed from).
//
// Never edits settings. Never recommends 0 (it fails validation); recommends the ledger, or a
// large value such as 3650 with the secret-retention warning.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { CLAUDE_CODE_DEFAULT_RETENTION_DAYS } from '../constants.js';
import { localDate, daysBetween } from './_util.js';

/** Put this insight at the top of the report when the coverage window is shorter than this. */
export const URGENT_COVERAGE_DAYS = 60;

export const RETENTION_LINE = '"cleanupPeriodDays": 3650';

export const ACTION_HISTORY = 'Turn on auditrail remember (numbers only) so later cards still cover the whole run, or add ' + RETENTION_LINE
  + ' to ~/.claude/settings.json, knowing that this also keeps anything pasted into a session, secrets included, on disk that long.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const insight = defineInsight({
  id: 'i12',
  title: 'History at risk',
  compute({ acc, options }) {
    const tz = options.tz;
    const t = acc.time;
    const earliestMainLocalDate = localDate(t.earliestMainTs, tz);
    const earliestAnyLocalDate = localDate(t.earliestAnyTs, tz);
    const latestLocalDate = localDate(t.latestTs, tz);
    const coverageDays = earliestAnyLocalDate && latestLocalDate ? daysBetween(earliestAnyLocalDate, latestLocalDate) + 1 : 0;

    const cleanup = typeof options.cleanupPeriodDays === 'number' && Number.isFinite(options.cleanupPeriodDays) ? options.cleanupPeriodDays : null;

    let deletedHistoryDays = null;
    if (Array.isArray(options.statsCacheDays)) {
      const days = new Set(options.statsCacheDays.filter((d) => typeof d === 'string' && DATE_RE.test(d)));
      deletedHistoryDays = earliestMainLocalDate ? [...days].filter((d) => d < earliestMainLocalDate).length : days.size;
    }

    /** @type {Set<string>} */
    const mainDays = new Set(Object.keys(t.promptsByLocalDay || {}));
    /** @type {Set<string>} */
    const sideDays = new Set();
    for (const r of acc.responses) {
      const d = localDate(r.tsStart, tz);
      if (!d) continue;
      if (r.fileClass === 'main') mainDays.add(d); else sideDays.add(d);
    }
    let orphanDays = 0;
    for (const d of sideDays) if (!mainDays.has(d)) orphanDays++;

    const data = {
      earliestMainLocalDate,
      earliestAnyLocalDate,
      latestLocalDate,
      coverageDays,
      cleanupPeriodDays: cleanup,
      retentionIsDefault: cleanup === null,
      effectiveRetentionDays: cleanup === null ? CLAUDE_CODE_DEFAULT_RETENTION_DAYS : cleanup,
      deletedHistoryDays,
      orphanDays,
      topOfReport: coverageDays < URGENT_COVERAGE_DAYS,
    };
    return { id: 'i12', shown: true, data, evidence: { count: coverageDays, unit: 'days covered' }, action: ACTION_HISTORY };
  },
});
