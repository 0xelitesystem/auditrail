// Summary schema: the PRIVATE, LOCAL, schema-versioned object (DESIGN 6, 8.8).
//
// The Summary is what the HTML report embeds (<script type="application/json" id="ar-data">),
// what `export --json` writes, and the ONLY input of the PublicSummary allowlist (public.js).
// It may contain local-only labels (project labels, hot-file labels, MCP server, skill and
// agent names, unpriced model ids). It never contains prompts, assistant text, tool inputs or
// outputs, secret values, full paths or titles.
//
// The Summary builder (src/core/summary.js) assembles it from the AccountingResult and the
// fourteen InsightResults. Money is always a nanodollar digit string (field names end in Nano).
//
// Isomorphic: no node:* imports and no DOM.

import { isNanoString } from './money.js';
import { INSIGHT_IDS } from './insights/contract.js';
import { FILE_CLASSES } from './adapters/contract.js';

export const SUMMARY_SCHEMA = 1;
export const SUMMARY_KIND = 'auditrail.summary';

/**
 * @typedef {Object} SummaryPricing
 * @property {string} asOf          price table date 'YYYY-MM-DD' (printed with every dollar figure)
 * @property {string} source        pricing page URL
 * @property {string} label         VALUE_LABEL, or 'value at your custom rates (<fileName>)'
 * @property {{ fileName: string, multiplier: number|null }|null} custom   set when an override file is active
 * @property {number} staleDays     days between asOf and the local clock at scan time
 * @property {{ id: string, displayName: string }[]} tableModels  every row of the table used, in table order
 */

/**
 * @typedef {Object} SummaryScan
 * @property {string} takenAt       ISO UTC timestamp of the stat pass (rule A28)
 * @property {number} filesRead     files read (all classes)
 * @property {number} bytes
 * @property {number} lines
 * @property {number} parseErrors
 * @property {number} trailingPartial
 * @property {number} oversizeLines
 * @property {Record<import('./adapters/contract.js').FileClass, import('./accounting/contract.js').ClassScanStats>} byClass
 * @property {{ compressed: number, 'unknown-extension': number, 'unknown-shape': number }} skippedFiles
 * @property {number|null} seconds  wall time of the scan, null in reproducible test runs
 */

/**
 * @typedef {Object} SummaryTotals
 * @property {number} responses
 * @property {number} incompleteResponses
 * @property {number} sessions
 * @property {import('./accounting/contract.js').TokenCounts} tokens
 * @property {string} valueNano       priced parts only; a LOWER BOUND (rule A6)
 * @property {number} pricedTokens
 * @property {number} allTokens
 */

/**
 * @typedef {Object} SummaryAudit
 * @property {import('./accounting/contract.js').DedupStats} dedup
 * @property {{ fast: number, geoUs: number, nonStandardTier: number, ttlEstimated: number, webSearchRequests: number }} modifiers
 * @property {Record<string, number>} skippedRecords
 * @property {string[]} agentVersions
 */

/**
 * @typedef {Object} Summary
 * @property {1} schema
 * @property {'auditrail.summary'} kind
 * @property {{ name: 'auditrail', version: string }} tool
 * @property {string} generatedAt   ISO UTC
 * @property {string} tz            IANA zone used for every local bucket
 * @property {number} idleMinutes
 * @property {boolean} redacted     true under --redact or share-safe mode: every label is replaced
 * @property {SummaryPricing} pricing
 * @property {SummaryScan} scan
 * @property {SummaryTotals} totals
 * @property {SummaryAudit} audit
 * @property {{ [K in import('./insights/contract.js').InsightId]: import('./insights/contract.js').InsightResult }} insights
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * True when `v` survives JSON.stringify unchanged: null, booleans, finite numbers, strings,
 * arrays and plain objects only (no BigInt, undefined, functions, Maps, Dates or NaN).
 * @param {unknown} v
 * @param {string} [path]
 * @returns {string|null} the first offending path, or null when safe
 */
export function findNonJsonValue(v, path = '$') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const bad = findNonJsonValue(v[i], path + '[' + i + ']');
      if (bad) return bad;
    }
    return null;
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return path;
    for (const [k, x] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
      const bad = findNonJsonValue(x, path + '.' + k);
      if (bad) return bad;
    }
    return null;
  }
  return path;
}

/**
 * Structural validation of a Summary. Returns a list of problems; empty means valid.
 * Checks the top-level shape, JSON safety, money strings, and that every field the
 * PublicSummary allowlist reads (public.js PUBLIC_SOURCES) exists with the right type.
 * @param {unknown} summary
 * @returns {string[]}
 */
export function checkSummary(summary) {
  const p = [];
  const s = /** @type {any} */ (summary);
  if (!s || typeof s !== 'object') return ['summary must be an object'];
  const bad = findNonJsonValue(s);
  if (bad) p.push('not JSON-safe at ' + bad);
  if (s.schema !== SUMMARY_SCHEMA) p.push('schema must be ' + SUMMARY_SCHEMA);
  if (s.kind !== SUMMARY_KIND) p.push('kind must be ' + SUMMARY_KIND);
  if (!s.tool || s.tool.name !== 'auditrail' || typeof s.tool.version !== 'string') p.push('tool must be { name: "auditrail", version }');
  if (typeof s.generatedAt !== 'string' || !ISO_RE.test(s.generatedAt)) p.push('generatedAt must be ISO UTC');
  if (typeof s.tz !== 'string' || !s.tz) p.push('tz must be a non-empty string');
  if (typeof s.idleMinutes !== 'number' || !(s.idleMinutes > 0)) p.push('idleMinutes must be a positive number');
  if (typeof s.redacted !== 'boolean') p.push('redacted must be a boolean');

  const pr = s.pricing;
  if (!pr || typeof pr !== 'object') p.push('pricing missing');
  else {
    if (typeof pr.asOf !== 'string' || !DATE_RE.test(pr.asOf)) p.push('pricing.asOf must be YYYY-MM-DD');
    if (typeof pr.label !== 'string') p.push('pricing.label must be a string');
    if (pr.custom !== null && (typeof pr.custom !== 'object' || typeof pr.custom.fileName !== 'string')) p.push('pricing.custom must be null or { fileName, multiplier }');
    if (!Array.isArray(pr.tableModels)) p.push('pricing.tableModels must be an array');
  }

  const sc = s.scan;
  if (!sc || typeof sc !== 'object') p.push('scan missing');
  else {
    if (typeof sc.takenAt !== 'string' || !ISO_RE.test(sc.takenAt)) p.push('scan.takenAt must be ISO UTC');
    for (const k of ['filesRead', 'bytes', 'lines', 'parseErrors', 'trailingPartial', 'oversizeLines']) {
      if (!Number.isSafeInteger(sc[k]) || sc[k] < 0) p.push('scan.' + k + ' must be a non-negative integer');
    }
    if (!sc.byClass || typeof sc.byClass !== 'object') p.push('scan.byClass missing');
    else for (const c of FILE_CLASSES) if (!sc.byClass[c]) p.push('scan.byClass.' + c + ' missing');
  }

  const t = s.totals;
  if (!t || typeof t !== 'object') p.push('totals missing');
  else {
    for (const k of ['responses', 'incompleteResponses', 'sessions', 'pricedTokens', 'allTokens']) {
      if (!Number.isSafeInteger(t[k]) || t[k] < 0) p.push('totals.' + k + ' must be a non-negative integer');
    }
    if (!isNanoString(t.valueNano)) p.push('totals.valueNano must be a nanodollar string');
    if (!t.tokens || typeof t.tokens.output !== 'number') p.push('totals.tokens must be TokenCounts');
  }

  if (!s.insights || typeof s.insights !== 'object') p.push('insights missing');
  else {
    for (const id of INSIGHT_IDS) {
      const r = s.insights[id];
      if (!r || typeof r !== 'object') { p.push('insights.' + id + ' missing'); continue; }
      if (r.id !== id) p.push('insights.' + id + '.id must be "' + id + '"');
      if (typeof r.shown !== 'boolean') p.push('insights.' + id + '.shown must be a boolean');
      if (!r.data || typeof r.data !== 'object') p.push('insights.' + id + '.data must be an object');
    }
  }
  return p;
}

/**
 * Throwing form of checkSummary.
 * @param {unknown} summary
 * @returns {asserts summary is Summary}
 */
export function assertSummary(summary) {
  const problems = checkSummary(summary);
  if (problems.length) throw new TypeError('invalid Summary: ' + problems.join('; '));
}
