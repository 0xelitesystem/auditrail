// I9. Working patterns (DESIGN 6 I9, rules A21 to A25, traps 37, 38, 41).
//
// Everything comes from the accounting TimeResult, already bucketed in the viewer's zone:
// active hours (15-minute idle cutoff by default), agent-hours (parallel agents counted
// separately), work blocks (never "longest session"), prompts, active days, streak, peak hour
// and the weekday by hour heatmap. Night share = prompts from 20:00 to 04:59 local.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { roundTo, median, percentile, weekdayMon0 } from './_util.js';

/** Local hours that count as night for the Night Shift badge (20:00 to 04:59). */
export const NIGHT_HOURS = Object.freeze([20, 21, 22, 23, 0, 1, 2, 3, 4]);

export const ACTION_PATTERNS = 'Use these figures, with their method notes, as receipts in a portfolio or review (auditrail export --md).';

export const insight = defineInsight({
  id: 'i09',
  title: 'Working patterns',
  compute({ acc }) {
    const t = acc.time;
    const blocks = Array.isArray(t.workBlockSeconds) ? t.workBlockSeconds : [];
    const byHour = Array.isArray(t.promptsByLocalHour) ? t.promptsByLocalHour : new Array(24).fill(0);
    let night = 0;
    for (const h of NIGHT_HOURS) night += byHour[h] || 0;
    const days = Array.isArray(t.activeDays) ? [...t.activeDays].sort() : [];
    const weekend = days.filter((d) => weekdayMon0(d) >= 5).length;
    let longest = 0;
    for (const b of blocks) if (b > longest) longest = b;
    const heatmap = Array.isArray(t.promptHeatmap) && t.promptHeatmap.length === 7
      ? t.promptHeatmap.map((row) => (Array.isArray(row) && row.length === 24 ? row.map((x) => x || 0) : new Array(24).fill(0)))
      : new Array(7).fill(0).map(() => new Array(24).fill(0));
    const data = {
      activeSeconds: t.activeSeconds,
      activeHours: roundTo(t.activeSeconds / 3600, 1),
      agentSeconds: t.agentSeconds,
      agentHours: roundTo(t.agentSeconds / 3600, 1),
      workBlocks: blocks.length,
      longestBlockSeconds: longest,
      medianBlockSeconds: median(blocks) ?? 0,
      p90BlockSeconds: percentile(blocks, 90) ?? 0,
      prompts: t.prompts,
      interrupts: t.interrupts,
      activeDays: days.length,
      longestStreakDays: t.longestStreakDays,
      peakHourLocal: t.peakHourLocal,
      heatmap,
      nightPromptShare: t.prompts > 0 ? Math.min(1, night / t.prompts) : 0,
      weekendDayShare: days.length ? weekend / days.length : 0,
      firstActiveLocalDate: days.length ? days[0] : null,
      lastActiveLocalDate: days.length ? days[days.length - 1] : null,
    };
    return { id: 'i09', shown: true, data, evidence: { count: t.prompts, unit: 'prompts' }, action: ACTION_PATTERNS };
  },
});
