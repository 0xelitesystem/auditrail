// PublicSummary: the ALLOWLIST that is the privacy boundary of the card and the demo
// (DESIGN 7.2, 7.3, 7.4, 9.7, traps 47, 48).
//
// How it cannot leak:
// 1. PUBLIC_FIELDS is the complete list of keys. toPublicSummary() builds a fresh object
//    literal field by field from fixed Summary paths (PUBLIC_SOURCES); nothing is copied by
//    spreading or by iterating over Summary keys, so a new Summary field can never ride along.
// 2. Every string on the result is either a fixed constant, a member of a closed enum
//    (tool display names, archetypes, badges, value labels), a price-table display name
//    checked against the table, or a date, timestamp or version checked by a strict pattern.
//    A value that fails its check throws PublicSummaryError: the card fails closed.
// 3. assertPublicSummary() re-checks exact keys and types, and the card renderer must call it
//    before drawing anything.
// 4. The manifest and the alt text are generated from the PublicSummary only, with the same
//    formatters the card uses, so what the manifest lists is exactly what the card shows.
//
// Never on the card, not even behind a toggle: project, repo, folder, cwd or branch names;
// file names or paths; prompts or titles; MCP server, skill, plugin or agent names; model ids
// not in the price table; secrets findings; any free text from any log.
//
// Isomorphic: no node:* imports and no DOM.

import {
  VALUE_LABEL, CUSTOM_VALUE_LABEL, TOOL_DISPLAY_NAMES, toolDisplayName, BUILTIN_TOOLS, NOT_PAID_NOTE, REPO_DISPLAY,
} from './constants.js';
import { nanoFromJson, floorTwoSignificant, nanoToUsdNumber, shareAtLeast, formatUsdTwoSignificant } from './money.js';

export const PUBLIC_SUMMARY_SCHEMA = 1;

/** The complete, ordered key list of a PublicSummary. Adding a key is a reviewed contract change. */
export const PUBLIC_FIELDS = Object.freeze([
  'schema', 'toolVersion', 'pricesAsOf', 'scanTakenAt', 'filesScanned',
  'coverage', 'value', 'outputTokens', 'activeHours', 'toolCalls', 'topTool',
  'cacheHitRate', 'delegationShare', 'longestStreakDays', 'peakHourLocal',
  'maxEditsOneFile', 'topModel', 'archetype', 'badges', 'rateLimitWindows', 'heatmap',
]);

/** Complete key lists of the nested objects. */
export const PUBLIC_SUBFIELDS = Object.freeze({
  coverage: Object.freeze(['fromLocalDate', 'toLocalDate', 'activeDays']),
  value: Object.freeze(['shown', 'atLeastUsd2sf', 'label']),
  topTool: Object.freeze(['name', 'share']),
});

/**
 * Where each field comes from in the Summary (documentation and test fixture for the
 * contract; toPublicSummary reads exactly these paths and nothing else).
 */
export const PUBLIC_SOURCES = Object.freeze({
  toolVersion: 'tool.version',
  pricesAsOf: 'pricing.asOf',
  scanTakenAt: 'scan.takenAt',
  filesScanned: 'scan.filesRead',
  coverage: 'insights.i12.data.earliestAnyLocalDate, insights.i12.data.latestLocalDate, insights.i09.data.activeDays',
  value: 'insights.i01.data.totalNano, .pricedTokens, .allTokens, pricing.custom',
  outputTokens: 'totals.tokens.output',
  activeHours: 'insights.i09.data.activeHours',
  toolCalls: 'insights.i07.data.toolCalls',
  topTool: 'insights.i07.data.topTool',
  cacheHitRate: 'insights.i02.data.cacheHitRate',
  delegationShare: 'insights.i04.data.delegationShare',
  longestStreakDays: 'insights.i09.data.longestStreakDays',
  peakHourLocal: 'insights.i09.data.peakHourLocal',
  maxEditsOneFile: 'insights.i08.data.maxEditsOneFile',
  topModel: 'insights.i13.data.topModel.model checked against pricing.tableModels',
  archetype: 'selectArchetype(archetypeMetrics(summary))',
  badges: 'selectBadges(summary, options)',
  rateLimitWindows: 'insights.i06.data.windows, only with include rate-limits',
  heatmap: 'insights.i09.data.heatmap (prompts by local weekday and hour), reduced to levels 0 to HEAT_LEVELS',
});

/** Heatmap intensity levels above 0 (HEAT_LEVELS is the busiest cell). */
export const HEAT_LEVELS = 4;

/** The card's heading for the heatmap: the manifest text of the heatmap field. */
export const HEATMAP_TITLE = 'when you and your agent work';

/** Shown instead of a model id that is not in the price table. */
export const OTHER_MODEL_LABEL = 'other model';

/* ------------------------------------------------------------------------------------------
 * Archetypes and badges (DESIGN 7.4)
 * ---------------------------------------------------------------------------------------- */

/** Tie order is the array order. */
export const ARCHETYPES = Object.freeze([
  Object.freeze({ id: 'conductor', name: 'The Conductor', line: "You don't type code. You run a crew.", threshold: 0.25 }),
  Object.freeze({ id: 'surgeon', name: 'The Surgeon', line: 'Small cuts, clean diffs.', threshold: 0.60 }),
  Object.freeze({ id: 'builder', name: 'The Builder', line: 'New files, every day.', threshold: 0.60 }),
  Object.freeze({ id: 'researcher', name: 'The Researcher', line: 'Reads everything before touching anything.', threshold: 0.40 }),
  Object.freeze({ id: 'operator', name: 'The Operator', line: 'Terminal first, questions later.', threshold: 0.45 }),
]);

export const GENERALIST = Object.freeze({ id: 'generalist', name: 'The Generalist', line: 'A bit of everything, done daily.', threshold: null });

/** Every archetype id, fallback last. */
export const ARCHETYPE_IDS = Object.freeze([...ARCHETYPES.map((a) => a.id), GENERALIST.id]);

/** Badge ids in display order. */
export const BADGES = Object.freeze([
  Object.freeze({ id: 'night-shift', name: 'Night Shift' }),
  Object.freeze({ id: 'weekend-builder', name: 'Weekend Builder' }),
  Object.freeze({ id: 'streak', name: 'Streak' }),
  Object.freeze({ id: 'cache-pro', name: 'Cache Pro' }),
  Object.freeze({ id: 'wall-hitter', name: 'Wall Hitter' }),
]);
export const BADGE_IDS = Object.freeze(BADGES.map((b) => b.id));

/** Badge thresholds (DESIGN 7.4), fixed for V1. */
export const BADGE_RULES = Object.freeze({
  nightShiftPromptShare: 0.35, // prompts between 20:00 and 04:59 local
  weekendDayShare: 0.30,       // active days that are Saturday or Sunday
  streakDays: 14,
  cacheProHitRate: 0.90,
  wallHitterWindows: 5,        // only when rate limits are opted in
});

/** Surgeon secondary condition: median editNewLines per Edit at most this. */
export const SURGEON_MAX_MEDIAN_EDIT_LINES = 10;
/** Builder secondary condition: at least this many files created. */
export const BUILDER_MIN_FILES_CREATED = 50;

/**
 * @typedef {Object} ArchetypeMetrics
 * @property {number} conductor         value of sidechain responses / total value
 * @property {number} surgeon           ok (Edit + MultiEdit) / ok (Edit + MultiEdit + Write)
 * @property {number} builder           ok Write / ok (Edit + MultiEdit + Write)
 * @property {number} researcher        (WebFetch + WebSearch + Read + Grep + Glob) calls / all tool calls
 * @property {number} operator          (Bash + PowerShell) calls / all tool calls
 * @property {number|null} medianEditNewLines
 * @property {number} filesCreated
 */

/**
 * Archetype metrics from the Summary's fixed insight fields.
 * @param {any} summary
 * @returns {ArchetypeMetrics}
 */
export function archetypeMetrics(summary) {
  const i04 = dataOf(summary, 'i04');
  const i07 = dataOf(summary, 'i07');
  const i08 = dataOf(summary, 'i08');
  const i14 = dataOf(summary, 'i14');
  const calls = countMap(i07.callsByDisplayName);
  const ok = countMap(i07.okCallsByDisplayName);
  const allCalls = nonNegInt(i07.toolCalls, 'insights.i07.data.toolCalls');
  const okEdit = ok.Edit + ok.MultiEdit;
  const okWrite = ok.Write;
  const okAll = okEdit + okWrite;
  const research = calls.WebFetch + calls.WebSearch + calls.Read + calls.Grep + calls.Glob;
  const shell = calls.Bash + calls.PowerShell;
  const median = i08.medianEditNewLines;
  return {
    conductor: share01(i04.delegationShare, 'insights.i04.data.delegationShare'),
    surgeon: okAll ? okEdit / okAll : 0,
    builder: okAll ? okWrite / okAll : 0,
    researcher: allCalls ? research / allCalls : 0,
    operator: allCalls ? shell / allCalls : 0,
    medianEditNewLines: median === null || median === undefined ? null : finiteNonNeg(median, 'insights.i08.data.medianEditNewLines'),
    filesCreated: nonNegInt(i14.filesCreated, 'insights.i14.data.filesCreated'),
  };
}

/**
 * Exactly one archetype (DESIGN 7.4): score = metric / threshold; eligible when score >= 1 and
 * the secondary condition holds; the highest score wins; exact ties break in ARCHETYPES order;
 * none eligible gives The Generalist.
 * @param {ArchetypeMetrics} m
 * @returns {{ id: string, score: number|null }}
 */
export function selectArchetype(m) {
  let best = null;
  for (const a of ARCHETYPES) {
    const metric = /** @type {number} */ (m[/** @type {keyof ArchetypeMetrics} */ (a.id)]);
    const score = metric / a.threshold;
    let eligible = score >= 1;
    if (a.id === 'surgeon') eligible = eligible && m.medianEditNewLines !== null && m.medianEditNewLines <= SURGEON_MAX_MEDIAN_EDIT_LINES;
    if (a.id === 'builder') eligible = eligible && m.filesCreated >= BUILDER_MIN_FILES_CREATED;
    if (eligible && (best === null || score > best.score)) best = { id: a.id, score };
  }
  return best ?? { id: GENERALIST.id, score: null };
}

/**
 * Badges (any number, DESIGN 7.4), in BADGE_IDS order.
 * @param {{ nightPromptShare: number, weekendDayShare: number, longestStreakDays: number, cacheHitRate: number, rateLimitWindows: number|null }} x
 * @returns {string[]}
 */
export function selectBadges(x) {
  const out = [];
  if (x.nightPromptShare >= BADGE_RULES.nightShiftPromptShare) out.push('night-shift');
  if (x.weekendDayShare >= BADGE_RULES.weekendDayShare) out.push('weekend-builder');
  if (x.longestStreakDays >= BADGE_RULES.streakDays) out.push('streak');
  if (x.cacheHitRate >= BADGE_RULES.cacheProHitRate) out.push('cache-pro');
  if (x.rateLimitWindows !== null && x.rateLimitWindows >= BADGE_RULES.wallHitterWindows) out.push('wall-hitter');
  return out;
}

/* ------------------------------------------------------------------------------------------
 * The builder
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} PublicSummary
 * @property {1} schema
 * @property {string} toolVersion
 * @property {string} pricesAsOf          'YYYY-MM-DD'
 * @property {string} scanTakenAt         ISO UTC
 * @property {number} filesScanned        rule A28: the card footer prints scan time and file count
 * @property {{ fromLocalDate: string, toLocalDate: string, activeDays: number }|null} coverage
 * @property {{ shown: boolean, atLeastUsd2sf: number|null, label: string }} value
 * @property {number|null} outputTokens
 * @property {number|null} activeHours
 * @property {number|null} toolCalls
 * @property {{ name: string, share: number }|null} topTool
 * @property {number|null} cacheHitRate
 * @property {number|null} delegationShare
 * @property {number|null} longestStreakDays
 * @property {number|null} peakHourLocal
 * @property {number|null} maxEditsOneFile
 * @property {string|null} topModel       a price-table display name or OTHER_MODEL_LABEL
 * @property {string|null} archetype      an ARCHETYPE_IDS entry
 * @property {string[]} badges            BADGE_IDS entries, in order
 * @property {number|null} rateLimitWindows  null unless opted in
 * @property {number[][]|null} heatmap   7 rows (Monday first) of 24 local hours, levels 0 to HEAT_LEVELS;
 *                                        null when hidden or when there are no prompts
 */

/** Stats a user can hide (--card-hide <stat>, report toggles). Keys are CLI names. */
export const CARD_HIDE_KEYS = Object.freeze({
  value: 'value',
  'output-tokens': 'outputTokens',
  'active-hours': 'activeHours',
  tools: 'toolCalls',
  'top-tool': 'topTool',
  'cache-hit-rate': 'cacheHitRate',
  delegation: 'delegationShare',
  streak: 'longestStreakDays',
  'peak-hour': 'peakHourLocal',
  'max-edits': 'maxEditsOneFile',
  'top-model': 'topModel',
  archetype: 'archetype',
  badges: 'badges',
  coverage: 'coverage',
  heatmap: 'heatmap',
});

/** Opt-in extras (--card-include <name>). */
export const CARD_INCLUDE_KEYS = Object.freeze({ 'rate-limits': 'rateLimitWindows' });

export class PublicSummaryError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PublicSummaryError';
  }
}

/**
 * @typedef {Object} PublicOptions
 * @property {string[]} [hide]     CARD_HIDE_KEYS keys (CLI names) or PublicSummary field names
 * @property {string[]} [include]  CARD_INCLUDE_KEYS keys
 * @property {{ models: { id: string, displayName: string }[] }} [priceTable]
 *   the BUNDLED price table; callers should always pass it (topModel is checked against it)
 */

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,20})?$/;

/**
 * Build the PublicSummary from a Summary. Reads only the paths in PUBLIC_SOURCES.
 * Throws PublicSummaryError when any source value fails its type or pattern check.
 * @param {any} summary
 * @param {PublicOptions} [options]
 * @returns {Readonly<PublicSummary>}
 */
export function toPublicSummary(summary, options = {}) {
  if (!summary || typeof summary !== 'object') throw new PublicSummaryError('summary must be an object');
  const hidden = resolveHidden(options.hide ?? []);
  const include = new Set(options.include ?? []);
  for (const k of include) {
    if (!Object.prototype.hasOwnProperty.call(CARD_INCLUDE_KEYS, k)) throw new PublicSummaryError('unknown --card-include value');
  }

  const i01 = dataOf(summary, 'i01');
  const i02 = dataOf(summary, 'i02');
  const i04 = dataOf(summary, 'i04');
  const i06 = dataOf(summary, 'i06');
  const i07 = dataOf(summary, 'i07');
  const i08 = dataOf(summary, 'i08');
  const i09 = dataOf(summary, 'i09');
  const i12 = dataOf(summary, 'i12');
  const i13 = dataOf(summary, 'i13');

  const toolVersion = pattern(summary.tool && summary.tool.version, VERSION_RE, 'tool.version');
  const pricesAsOf = pattern(summary.pricing && summary.pricing.asOf, DATE_RE, 'pricing.asOf');
  const scanTakenAt = pattern(summary.scan && summary.scan.takenAt, ISO_RE, 'scan.takenAt');
  const filesScanned = nonNegInt(summary.scan && summary.scan.filesRead, 'scan.filesRead');

  // Value (DESIGN 7.2): shown only when priced token share >= 99% and total >= $1; floored to
  // two significant figures and labelled "at least".
  const custom = summary.pricing && summary.pricing.custom;
  const customRates = custom !== null && custom !== undefined;
  const totalNano = nanoFromJsonChecked(i01.totalNano, 'insights.i01.data.totalNano');
  const pricedTokens = nonNegInt(i01.pricedTokens, 'insights.i01.data.pricedTokens');
  const allTokens = nonNegInt(i01.allTokens, 'insights.i01.data.allTokens');
  const valueEligible = shareAtLeast(pricedTokens, allTokens, 99, 100) && totalNano >= 1_000_000_000n;
  const valueShown = valueEligible && !hidden.has('value');
  const value = Object.freeze({
    shown: valueShown,
    atLeastUsd2sf: valueShown ? nanoToUsdNumber(floorTwoSignificant(totalNano)) : null,
    label: customRates ? CUSTOM_VALUE_LABEL : VALUE_LABEL,
  });

  // Coverage.
  let coverage = null;
  if (!hidden.has('coverage')) {
    const from = i12.earliestAnyLocalDate;
    const to = i12.latestLocalDate;
    if (from !== null && to !== null && from !== undefined && to !== undefined) {
      coverage = Object.freeze({
        fromLocalDate: pattern(from, DATE_RE, 'insights.i12.data.earliestAnyLocalDate'),
        toLocalDate: pattern(to, DATE_RE, 'insights.i12.data.latestLocalDate'),
        activeDays: nonNegInt(i09.activeDays, 'insights.i09.data.activeDays'),
      });
    }
  }

  // Top tool: display names only.
  let topTool = null;
  if (!hidden.has('topTool') && !hidden.has('toolCalls') && i07.topTool) {
    // Enum members pass through; anything else is collapsed by toolDisplayName, which can only
    // return BUILTIN_TOOLS entries, MCP_TOOLS_LABEL or OTHER_TOOLS_LABEL.
    const raw = String(i07.topTool.displayName);
    const name = TOOL_DISPLAY_NAMES.includes(raw) ? raw : toolDisplayName(raw);
    topTool = Object.freeze({ name, share: round4(share01(i07.topTool.share, 'insights.i07.data.topTool.share')) });
  }

  // Top model: display names from the price table only.
  let topModel = null;
  if (!hidden.has('topModel') && i13.topModel) {
    const id = i13.topModel.model;
    // Prefer the bundled price table (options.priceTable) over the Summary's copy of it, so a
    // tampered Summary cannot smuggle a label in through tableModels.
    const table = options.priceTable && Array.isArray(options.priceTable.models) ? options.priceTable.models
      : Array.isArray(summary.pricing && summary.pricing.tableModels) ? summary.pricing.tableModels : [];
    const row = table.find((r) => r && r.id === id);
    topModel = row ? pattern(row.displayName, /^[A-Za-z0-9 .]{1,40}$/, 'pricing.tableModels.displayName') : OTHER_MODEL_LABEL;
  }

  // Rate limits: opt-in only.
  const rateLimitWindows = include.has('rate-limits') ? nonNegInt(i06.windows, 'insights.i06.data.windows') : null;

  const cacheHitRate = share01(i02.cacheHitRate, 'insights.i02.data.cacheHitRate');
  const longestStreakDays = nonNegInt(i09.longestStreakDays, 'insights.i09.data.longestStreakDays');

  const archetype = hidden.has('archetype') ? null : selectArchetype(archetypeMetrics(summary)).id;
  const badges = hidden.has('badges') ? [] : selectBadges({
    nightPromptShare: share01(i09.nightPromptShare, 'insights.i09.data.nightPromptShare'),
    weekendDayShare: share01(i09.weekendDayShare, 'insights.i09.data.weekendDayShare'),
    longestStreakDays,
    cacheHitRate,
    rateLimitWindows,
  });

  const peak = i09.peakHourLocal;
  /** @type {PublicSummary} */
  const ps = {
    schema: PUBLIC_SUMMARY_SCHEMA,
    toolVersion,
    pricesAsOf,
    scanTakenAt,
    filesScanned,
    coverage,
    value,
    outputTokens: hidden.has('outputTokens') ? null : nonNegInt(summary.totals && summary.totals.tokens && summary.totals.tokens.output, 'totals.tokens.output'),
    activeHours: hidden.has('activeHours') ? null : round1(finiteNonNeg(i09.activeHours, 'insights.i09.data.activeHours')),
    toolCalls: hidden.has('toolCalls') ? null : nonNegInt(i07.toolCalls, 'insights.i07.data.toolCalls'),
    topTool,
    cacheHitRate: hidden.has('cacheHitRate') ? null : round4(cacheHitRate),
    delegationShare: hidden.has('delegationShare') ? null : round4(share01(i04.delegationShare, 'insights.i04.data.delegationShare')),
    longestStreakDays: hidden.has('longestStreakDays') ? null : longestStreakDays,
    peakHourLocal: hidden.has('peakHourLocal') || peak === null || peak === undefined ? null : hour(peak),
    maxEditsOneFile: hidden.has('maxEditsOneFile') ? null : nonNegInt(i08.maxEditsOneFile, 'insights.i08.data.maxEditsOneFile'),
    topModel,
    archetype,
    badges: Object.freeze([...badges]),
    rateLimitWindows,
    heatmap: hidden.has('heatmap') ? null : heatLevels(i09.heatmap),
  };
  assertPublicSummary(ps);
  return Object.freeze(ps);
}

/**
 * Re-check a PublicSummary: exact keys (nested too), types, enums and patterns. The card
 * renderer calls this before drawing; anything with an extra key is rejected.
 * @param {unknown} ps
 * @returns {asserts ps is PublicSummary}
 */
export function assertPublicSummary(ps) {
  const x = /** @type {any} */ (ps);
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new PublicSummaryError('PublicSummary must be an object');
  exactKeys(x, PUBLIC_FIELDS, 'PublicSummary');
  if (x.schema !== PUBLIC_SUMMARY_SCHEMA) throw new PublicSummaryError('schema');
  pattern(x.toolVersion, VERSION_RE, 'toolVersion');
  pattern(x.pricesAsOf, DATE_RE, 'pricesAsOf');
  pattern(x.scanTakenAt, ISO_RE, 'scanTakenAt');
  nonNegInt(x.filesScanned, 'filesScanned');
  if (x.coverage !== null) {
    exactKeys(x.coverage, PUBLIC_SUBFIELDS.coverage, 'coverage');
    pattern(x.coverage.fromLocalDate, DATE_RE, 'coverage.fromLocalDate');
    pattern(x.coverage.toLocalDate, DATE_RE, 'coverage.toLocalDate');
    nonNegInt(x.coverage.activeDays, 'coverage.activeDays');
  }
  exactKeys(x.value, PUBLIC_SUBFIELDS.value, 'value');
  if (typeof x.value.shown !== 'boolean') throw new PublicSummaryError('value.shown');
  if (x.value.shown) finiteNonNeg(x.value.atLeastUsd2sf, 'value.atLeastUsd2sf');
  else if (x.value.atLeastUsd2sf !== null) throw new PublicSummaryError('value.atLeastUsd2sf must be null when not shown');
  if (x.value.label !== VALUE_LABEL && x.value.label !== CUSTOM_VALUE_LABEL) throw new PublicSummaryError('value.label');
  for (const k of ['outputTokens', 'toolCalls', 'longestStreakDays', 'maxEditsOneFile', 'rateLimitWindows']) {
    if (x[k] !== null) nonNegInt(x[k], k);
  }
  if (x.activeHours !== null) finiteNonNeg(x.activeHours, 'activeHours');
  for (const k of ['cacheHitRate', 'delegationShare']) if (x[k] !== null) share01(x[k], k);
  if (x.peakHourLocal !== null) hour(x.peakHourLocal);
  if (x.topTool !== null) {
    exactKeys(x.topTool, PUBLIC_SUBFIELDS.topTool, 'topTool');
    if (!TOOL_DISPLAY_NAMES.includes(x.topTool.name)) throw new PublicSummaryError('topTool.name outside the allowlist');
    share01(x.topTool.share, 'topTool.share');
  }
  if (x.topModel !== null) {
    if (typeof x.topModel !== 'string' || !/^[A-Za-z0-9 .]{1,40}$/.test(x.topModel)) throw new PublicSummaryError('topModel');
    if (x.topModel !== OTHER_MODEL_LABEL && !/^Claude [A-Za-z]+( [0-9.]+)?$/.test(x.topModel)) throw new PublicSummaryError('topModel must be a price-table display name');
  }
  if (x.archetype !== null && !ARCHETYPE_IDS.includes(x.archetype)) throw new PublicSummaryError('archetype');
  if (!Array.isArray(x.badges)) throw new PublicSummaryError('badges');
  let last = -1;
  for (const b of x.badges) {
    const i = BADGE_IDS.indexOf(b);
    if (i <= last) throw new PublicSummaryError('badges must be unique BADGE_IDS in order');
    last = i;
  }
  if (x.heatmap !== null) {
    if (!Array.isArray(x.heatmap) || x.heatmap.length !== 7) throw new PublicSummaryError('heatmap must be 7 rows');
    for (const row of x.heatmap) {
      if (!Array.isArray(row) || row.length !== 24 || row.some((v) => !Number.isInteger(v) || v < 0 || v > HEAT_LEVELS)) throw new PublicSummaryError('heatmap rows must be 24 levels 0 to ' + HEAT_LEVELS);
    }
  }
}

/**
 * Prompt counts by weekday and hour to levels: 0 stays 0, the busiest cell is HEAT_LEVELS, the
 * rest scale by the square root of their share of the busiest cell (so quiet hours still show).
 * Only levels leave the Summary. Absent or all-zero input gives null.
 * @param {unknown} m
 * @returns {number[][]|null}
 */
function heatLevels(m) {
  if (m === null || m === undefined) return null;
  if (!Array.isArray(m) || m.length !== 7 || m.some((r) => !Array.isArray(r) || r.length !== 24)) throw new PublicSummaryError('insights.i09.data.heatmap must be 7 x 24');
  let max = 0;
  for (const r of m) for (const v of r) max = Math.max(max, nonNegInt(v, 'insights.i09.data.heatmap'));
  if (!max) return null;
  return Object.freeze(m.map((r) => Object.freeze(r.map((v) => (v ? Math.max(1, Math.ceil(HEAT_LEVELS * Math.sqrt(v / max) - 1e-9)) : 0)))));
}

/* ------------------------------------------------------------------------------------------
 * Formatting shared by the card, the manifest and the alt text
 * ---------------------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact count, floored so it never overstates: 999 -> "999", 1234 -> "1.2K", 58210 -> "58K",
 * 3456789 -> "3.4M".
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  const v = Math.floor(n);
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [div, suffix] of units) {
    if (v >= div) {
      const q = v / /** @type {number} */ (div);
      return (q < 10 ? (Math.floor(q * 10) / 10).toFixed(1) : String(Math.floor(q))) + suffix;
    }
  }
  return String(v);
}

/**
 * Percent text, floored: 0.944 -> "94%", 0.004 -> "<1%", 0 -> "0%".
 * @param {number} share
 * @returns {string}
 */
export function formatPercent(share) {
  if (share > 0 && share < 0.01) return '<1%';
  return Math.floor(share * 100 + 1e-9) + '%';
}

/**
 * 0 -> "12 AM", 13 -> "1 PM".
 * @param {number} h
 * @returns {string}
 */
export function formatHour(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  const x = h % 12 === 0 ? 12 : h % 12;
  return x + ' ' + suffix;
}

/**
 * "Apr 3 to Aug 21, 2026" or "Dec 1, 2025 to Jan 5, 2026".
 * @param {string} from 'YYYY-MM-DD'
 * @param {string} to   'YYYY-MM-DD'
 * @returns {string}
 */
export function formatDateRange(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const f = MONTHS[fm - 1] + ' ' + fd;
  const t = MONTHS[tm - 1] + ' ' + td + ', ' + ty;
  return fy === ty ? f + ' to ' + t : f + ', ' + fy + ' to ' + t;
}

/**
 * @param {string} id
 * @returns {{ id: string, name: string, line: string }}
 */
export function archetypeInfo(id) {
  const a = ARCHETYPES.find((x) => x.id === id) ?? (id === GENERALIST.id ? GENERALIST : null);
  if (!a) throw new PublicSummaryError('unknown archetype');
  return { id: a.id, name: a.name, line: a.line };
}

/**
 * Badge pill text: "Night Shift", "Streak 16", ...
 * @param {string} id
 * @param {PublicSummary} ps
 * @returns {string}
 */
export function badgeText(id, ps) {
  const b = BADGES.find((x) => x.id === id);
  if (!b) throw new PublicSummaryError('unknown badge');
  return id === 'streak' ? b.name + ' ' + (ps.longestStreakDays ?? '') : b.name;
}

/**
 * The fixed card footer (DESIGN 7.1), from PublicSummary fields only.
 * @param {PublicSummary} ps
 * @returns {string}
 */
export function footerText(ps) {
  const label = ps.value.label === CUSTOM_VALUE_LABEL ? 'Value at custom rates' : 'API-equivalent value at list prices as of ' + ps.pricesAsOf;
  return label + '. ' + NOT_PAID_NOTE + ' Generated locally by auditrail | ' + REPO_DISPLAY;
}

/**
 * Scan receipt line for the footer (rule A28): "Scanned 2026-03-16 09:00 UTC, 12 files".
 * @param {PublicSummary} ps
 * @returns {string}
 */
export function scanText(ps) {
  const t = ps.scanTakenAt.slice(0, 10) + ' ' + ps.scanTakenAt.slice(11, 16) + ' UTC';
  return 'Scanned ' + t + ', ' + ps.filesScanned + (ps.filesScanned === 1 ? ' file' : ' files');
}

/**
 * @typedef {Object} ManifestEntry
 * @property {string} field  PublicSummary field name
 * @property {string} label  human label
 * @property {string} text   exactly the text the card draws for this field
 */

/**
 * The manifest printed next to the card: every field the card contains and its text.
 * Hidden or unavailable fields are omitted.
 * @param {PublicSummary} ps
 * @returns {ManifestEntry[]}
 */
export function buildManifest(ps) {
  assertPublicSummary(ps);
  /** @type {ManifestEntry[]} */
  const out = [];
  const add = (field, label, text) => out.push({ field, label, text });
  if (ps.archetype !== null) {
    const a = archetypeInfo(ps.archetype);
    add('archetype', 'Archetype', a.name + ': ' + a.line);
  }
  if (ps.badges.length) add('badges', 'Badges', ps.badges.map((b) => badgeText(b, ps)).join(', '));
  if (ps.coverage !== null) {
    add('coverage', 'Coverage', formatDateRange(ps.coverage.fromLocalDate, ps.coverage.toLocalDate) + ' | ' + ps.coverage.activeDays + ' active days');
  }
  if (ps.value.shown && ps.value.atLeastUsd2sf !== null) {
    add('value', 'Value', 'at least ' + formatUsdTwoSignificant(BigInt(Math.round(ps.value.atLeastUsd2sf * 1e9))) + ' ' + ps.value.label);
  } else if (ps.outputTokens !== null) {
    add('outputTokens', 'Output tokens', formatCount(ps.outputTokens) + ' output tokens');
  }
  // Card v2 shows four plain-English stats; top tool, cache hit rate, top model, most edited file
  // and rate-limit windows stay in the report (the Cache Pro and Wall Hitter badges carry two).
  if (ps.activeHours !== null) add('activeHours', 'Active hours (15-minute idle cutoff)', formatActiveHours(ps.activeHours) + ' hours with your agent');
  if (ps.toolCalls !== null) add('toolCalls', 'Tool calls', formatCount(ps.toolCalls) + ' actions by your agent');
  if (ps.longestStreakDays !== null) add('longestStreakDays', 'Longest streak', ps.longestStreakDays + (ps.longestStreakDays === 1 ? ' day' : ' days') + ' in a row');
  if (ps.delegationShare !== null) add('delegationShare', 'Delegation (share of value)', formatPercent(ps.delegationShare) + ' of the work done by subagents');
  if (ps.heatmap !== null) add('heatmap', 'Activity heatmap (prompts by weekday and hour, ' + HEAT_LEVELS + ' levels)', HEATMAP_TITLE);
  if (ps.peakHourLocal !== null) add('peakHourLocal', 'Peak hour', 'busiest hour ' + formatHour(ps.peakHourLocal));
  add('footer', 'Footer', footerText(ps) + ' ' + scanText(ps));
  return out;
}

/**
 * Card alt text, generated from the manifest.
 * @param {PublicSummary} ps
 * @returns {string}
 */
export function altText(ps) {
  return 'Auditrail card. ' + buildManifest(ps).map((e) => e.text).join('. ') + '.';
}

/**
 * @param {number} h
 * @returns {string}
 */
export function formatActiveHours(h) {
  return h >= 10 ? String(Math.floor(h)) : (Math.floor(h * 10) / 10).toFixed(1);
}

/* ------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {string[]} hide
 * @returns {Set<string>}
 */
function resolveHidden(hide) {
  const out = new Set();
  for (const h of hide) {
    if (Object.prototype.hasOwnProperty.call(CARD_HIDE_KEYS, h)) out.add(CARD_HIDE_KEYS[/** @type {keyof typeof CARD_HIDE_KEYS} */ (h)]);
    else if (Object.values(CARD_HIDE_KEYS).includes(h)) out.add(h);
    else throw new PublicSummaryError('unknown --card-hide value');
  }
  return out;
}

/**
 * @param {any} summary
 * @param {string} id
 * @returns {any}
 */
function dataOf(summary, id) {
  const r = summary && summary.insights && summary.insights[id];
  if (!r || typeof r !== 'object' || !r.data || typeof r.data !== 'object') throw new PublicSummaryError('insights.' + id + '.data missing');
  return r.data;
}

/**
 * @param {unknown} m
 * @returns {Record<string, number>}
 */
function countMap(m) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const n of BUILTIN_TOOLS) out[n] = 0;
  if (m && typeof m === 'object') {
    for (const n of BUILTIN_TOOLS) {
      const v = /** @type {Record<string, unknown>} */ (m)[n];
      if (v !== undefined) out[n] = nonNegInt(v, 'tool count ' + n);
    }
  }
  return out;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {bigint}
 */
function nanoFromJsonChecked(v, name) {
  try { return nanoFromJson(/** @type {string} */ (v)); } catch { throw new PublicSummaryError(name + ' must be a nanodollar string'); }
}

/**
 * @param {unknown} v
 * @param {RegExp} re
 * @param {string} name
 * @returns {string}
 */
function pattern(v, re, name) {
  if (typeof v !== 'string' || !re.test(v)) throw new PublicSummaryError(name + ' fails its pattern');
  return v;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function nonNegInt(v, name) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new PublicSummaryError(name + ' must be a non-negative integer');
  return v;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function finiteNonNeg(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PublicSummaryError(name + ' must be a finite non-negative number');
  return v;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function share01(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new PublicSummaryError(name + ' must be a share in [0, 1]');
  return v;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function hour(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) throw new PublicSummaryError('peakHourLocal must be 0 to 23');
  return v;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} keys
 * @param {string} name
 */
function exactKeys(obj, keys, name) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new PublicSummaryError(name + ' must be an object');
  const got = Object.keys(obj);
  if (got.length !== keys.length || got.some((k) => !keys.includes(k))) throw new PublicSummaryError(name + ' keys must be exactly: ' + keys.join(', '));
}

/** @param {number} x */
function round4(x) { return Math.round(x * 10000) / 10000; }
/** @param {number} x */
function round1(x) { return Math.round(x * 10) / 10; }
