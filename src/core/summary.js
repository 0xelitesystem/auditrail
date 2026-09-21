// Summary builder: the PRIVATE, LOCAL, schema-versioned object (summary-schema.js, DESIGN 6, 8.8).
//
// buildSummary() assembles the Summary from the AccountingResult and the fourteen insight
// results. The Summary is what the HTML report embeds and what export --json writes, and it is
// the ONLY input of the PublicSummary allowlist (public.js).
//
// What it may hold: aggregates, money as nanodollar strings, and the local-only labels the
// design allows (project labels, "<parent>/<basename>" hot-file labels, attribution names,
// non-builtin tool names, unpriced model ids). Under --redact every one of those is replaced
// with "Project A", "File B", ... and checkRedacted() proves it.
//
// What it may never hold, redacted or not: full paths, relative log paths or encoded project
// folder names, project keys, launch folders, session ids, file path hashes, prompts, any text
// from any log, and secret values. findSummaryLeaks() searches the finished object for every
// such string the AccountingResult knows about and buildSummary() throws if one is present.
// Error messages name the JSON path and the category only, never the offending string.
//
// Isomorphic: no node:* imports and no DOM.

import { SUMMARY_SCHEMA, SUMMARY_KIND, assertSummary } from './summary-schema.js';
import { VALUE_LABEL, CUSTOM_VALUE_LABEL, CUSTOM_VALUE_LABEL_NO_FILE, NOT_PAID_NOTE, REPO_DISPLAY, TOOL_DISPLAY_NAMES, toolNameClass, REDACTED_PRICE_FILE, customValueLabel } from './constants.js';
import { FILE_CLASSES, COMMAND_INTENTS, ERROR_CATEGORIES, SKIP_REASONS } from './adapters/contract.js';
import { runInsights, insightOptions } from './insights/index.js';
import { REDACTED_LABEL_RE, basename } from './insights/_util.js';
import { ACTION_PLAN } from './insights/i01-value.js';
import { ACTION_MONEY_MAP } from './insights/i02-money-map.js';
import { ACTION_IDLE } from './insights/i03-idle-resume.js';
import { ACTION_DELEGATION } from './insights/i04-delegation.js';
import { ACTION_REPRICE, REPRICING_LABEL } from './insights/i05-repricing.js';
import { ACTION_RATE_LIMITS } from './insights/i06-rate-limits.js';
import { TOOL_ACTIONS } from './insights/i07-tools.js';
import { ACTION_CHURN } from './insights/i08-churn.js';
import { ACTION_PATTERNS } from './insights/i09-patterns.js';
import { ACTION_WORKFLOWS } from './insights/i10-workflows.js';
import { ACTION_SECRETS } from './insights/i11-secrets.js';
import { ACTION_HISTORY } from './insights/i12-history.js';
import { ACTION_MODELS } from './insights/i13-models.js';
import { ACTION_RECEIPTS, LINES_WRITTEN_LABEL } from './insights/i14-receipts.js';

export class SummaryLeakError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SummaryLeakError';
  }
}

const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * @typedef {Object} BuildSummaryInput
 * @property {import('./accounting/contract.js').AccountingResult} acc
 * @property {import('./accounting/contract.js').PriceTable} prices   the table accounting priced with
 * @property {string} toolVersion        package version
 * @property {string} scanTakenAt        ISO UTC of the stat pass (rule A28)
 * @property {number|null} [scanSeconds] wall time of the scan; null in reproducible runs
 * @property {Partial<import('./insights/contract.js').InsightOptions> & {
 *   custom?: { fileName: string, multiplier: number|null } | null
 * }} [options]  tz, idleMinutes, plan, redact, cleanupPeriodDays, statsCacheDays, nowMs, custom
 */

/**
 * Build, validate and leak-check the Summary.
 * @param {BuildSummaryInput} input
 * @returns {import('./summary-schema.js').Summary}
 */
export function buildSummary(input) {
  const { acc, prices } = input;
  if (!acc || typeof acc !== 'object') throw new TypeError('buildSummary: acc is required');
  if (!prices || typeof prices !== 'object') throw new TypeError('buildSummary: prices is required');
  const options = insightOptions({ ...(input.options || {}), tz: (input.options && input.options.tz) || (acc.time && acc.time.tz) || 'UTC' });
  // The basename of a price file is a name from the user's disk ("prices-acme-merger-q4.json"),
  // so --redact replaces it with the same stand-in src/web/share-safe.js uses, and the label
  // loses the parenthesis. Otherwise a redacted report would carry a file name under a banner
  // that says file names were replaced.
  const custom = options.custom && typeof options.custom.fileName === 'string'
    ? {
      fileName: options.redact ? REDACTED_PRICE_FILE : basename(options.custom.fileName.replace(/\\/g, '/')),
      multiplier: typeof options.custom.multiplier === 'number' ? options.custom.multiplier : null,
    }
    : null;
  options.custom = custom;

  const insights = runInsights({ acc, prices, options });

  const byClass = {};
  let filesRead = 0, bytes = 0, lines = 0, parseErrors = 0, trailingPartial = 0, oversizeLines = 0;
  for (const c of FILE_CLASSES) {
    const s = (acc.scanByClass && acc.scanByClass[c]) || { files: 0, bytes: 0, lines: 0, records: 0, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 };
    byClass[c] = {
      files: s.files, bytes: s.bytes, lines: s.lines, records: s.records,
      parseErrors: s.parseErrors, trailingPartial: s.trailingPartial, oversizeLines: s.oversizeLines,
    };
    filesRead += s.files; bytes += s.bytes; lines += s.lines;
    parseErrors += s.parseErrors; trailingPartial += s.trailingPartial; oversizeLines += s.oversizeLines;
  }

  const asOfMs = Date.parse(prices.fetched + 'T00:00:00Z');
  const staleDays = Number.isFinite(asOfMs) ? Math.max(0, Math.floor((options.nowMs - asOfMs) / 86_400_000)) : 0;
  const sk = acc.skippedFiles || {};

  const summary = {
    schema: SUMMARY_SCHEMA,
    kind: SUMMARY_KIND,
    tool: { name: 'auditrail', version: String(input.toolVersion) },
    generatedAt: new Date(options.nowMs).toISOString(),
    tz: options.tz,
    idleMinutes: options.idleMinutes,
    redacted: options.redact,
    pricing: {
      asOf: prices.fetched,
      source: typeof prices.source === 'string' ? prices.source : '',
      label: custom ? customValueLabel(custom.fileName) : VALUE_LABEL,
      custom,
      staleDays,
      tableModels: prices.models.map((m) => ({ id: m.id, displayName: m.displayName })),
    },
    scan: {
      takenAt: input.scanTakenAt,
      filesRead, bytes, lines, parseErrors, trailingPartial, oversizeLines,
      byClass,
      skippedFiles: { compressed: sk.compressed || 0, 'unknown-extension': sk['unknown-extension'] || 0, 'unknown-shape': sk['unknown-shape'] || 0 },
      seconds: typeof input.scanSeconds === 'number' && Number.isFinite(input.scanSeconds) ? input.scanSeconds : null,
    },
    totals: {
      responses: acc.totals.responses,
      incompleteResponses: acc.totals.incomplete,
      sessions: Array.isArray(acc.bySession) ? acc.bySession.length : 0,
      tokens: { ...acc.totals.tokens },
      valueNano: acc.totals.valueNano.toString(),
      pricedTokens: acc.pricedTokens,
      allTokens: acc.allTokens,
    },
    audit: {
      dedup: { ...acc.dedup },
      modifiers: { ...acc.modifiers },
      skippedRecords: { ...(acc.skippedRecords || {}) },
      agentVersions: (Array.isArray(acc.agentVersions) ? acc.agentVersions : []).filter((v) => typeof v === 'string' && VERSION_RE.test(v)),
    },
    insights,
  };

  assertSummary(summary);
  if (summary.redacted) {
    const problems = checkRedacted(summary);
    if (problems.length) throw new SummaryLeakError('redacted Summary still carries labels at: ' + problems.join(', '));
  }
  const leaks = findSummaryLeaks(summary, acc);
  if (leaks.length) throw new SummaryLeakError('Summary would carry private strings: ' + leaks.map((l) => l.category + ' at ' + l.path).join(', '));
  return summary;
}

/**
 * Every label field of a Summary that must be a redacted label under --redact. Returns the JSON
 * paths that are not. Built-in tool names, price-table model ids and fixed copy are exempt.
 * @param {any} s
 * @param {string[]} [fields] when given, receives the path of every label field, redacted or not
 * @returns {string[]}
 */
export function checkRedacted(s, fields) {
  const bad = [];
  const tableIds = new Set((s.pricing && Array.isArray(s.pricing.tableModels) ? s.pricing.tableModels : []).map((m) => m.id));
  const label = (/** @type {unknown} */ v, /** @type {string} */ path) => {
    if (fields) fields.push(path);
    if (typeof v !== 'string' || !REDACTED_LABEL_RE.test(v)) bad.push(path);
  };
  // The custom price file basename is a name from the user's disk, not a "Project A" style
  // label, so it has its own fixed stand-in (REDACTED_PRICE_FILE) rather than a labeler. The
  // browser's Share-safe pass replaces it with the same text (src/web/share-safe.js).
  if (s.pricing && s.pricing.custom && s.pricing.custom.fileName !== REDACTED_PRICE_FILE) bad.push('pricing.custom.fileName');
  if (s.pricing && typeof s.pricing.label === 'string' &&
      s.pricing.label !== VALUE_LABEL && s.pricing.label !== CUSTOM_VALUE_LABEL && s.pricing.label !== CUSTOM_VALUE_LABEL_NO_FILE) {
    bad.push('pricing.label');
  }
  const ins = s.insights || {};
  const d = (/** @type {string} */ id) => (ins[id] && ins[id].data) || {};
  (d('i01').byProject || []).forEach((p, i) => label(p.label, 'insights.i01.data.byProject[' + i + '].label'));
  (d('i01').unpriced || []).forEach((u, i) => label(u.model, 'insights.i01.data.unpriced[' + i + '].model'));
  (d('i01').byModel || []).forEach((m, i) => { if (!tableIds.has(m.model)) label(m.model, 'insights.i01.data.byModel[' + i + '].model'); });
  const attr = d('i04').byAttribution || {};
  for (const k of ['agent', 'skill', 'mcpServer']) (attr[k] || []).forEach((a, i) => label(a.name, 'insights.i04.data.byAttribution.' + k + '[' + i + '].name'));
  (d('i07').byTool || []).forEach((t, i) => { if (toolNameClass(t.name) !== 'builtin') label(t.name, 'insights.i07.data.byTool[' + i + '].name'); });
  (d('i07').flagged || []).forEach((n, i) => { if (toolNameClass(n) !== 'builtin') label(n, 'insights.i07.data.flagged[' + i + ']'); });
  (d('i08').top || []).forEach((f, i) => label(f.label, 'insights.i08.data.top[' + i + '].label'));
  (d('i11').findings || []).forEach((f, i) => (f.projectLabels || []).forEach((p, j) => label(p, 'insights.i11.data.findings[' + i + '].projectLabels[' + j + ']')));
  (d('i13').byModel || []).forEach((m, i) => { if (!tableIds.has(m.model)) label(m.model, 'insights.i13.data.byModel[' + i + '].model'); });
  (d('i14').models || []).forEach((m, i) => {
    const isDisplayName = (s.pricing && s.pricing.tableModels || []).some((t) => t.displayName === m);
    if (!isDisplayName) label(m, 'insights.i14.data.models[' + i + ']');
  });
  return bad;
}

/**
 * The private strings the AccountingResult knows about, deduplicated, in one pass.
 *
 * `subs` maps each lower-cased substring needle to its rank: the position of the first needle
 * with that text in collection order. A string that contains several needles is reported under
 * the category of the lowest rank, which is exactly the needle a scan in collection order would
 * meet first. `exacts` maps each exact-match label to its category (a later label with the same
 * text replaces an earlier one, as a Map filled in collection order does). `lengths` lists the
 * distinct needle lengths, ascending.
 * @param {import('./accounting/contract.js').AccountingResult} acc
 * @param {boolean} redacted
 * @returns {{ subs: Map<string, number>, cats: string[], exacts: Map<string, string>, lengths: number[] }}
 */
function privateNeedles(acc, redacted) {
  /** @type {Map<string, number>} */
  const subs = new Map();
  /** @type {string[]} */
  const cats = [];
  /** @type {Map<string, string>} */
  const exacts = new Map();
  const add = (/** @type {string} */ category, /** @type {unknown} */ v, /** @type {number} */ min = 6) => {
    if (typeof v !== 'string' || v.length < min) return;
    const low = v.toLowerCase();
    if (!subs.has(low)) { subs.set(low, cats.length); cats.push(category); }
  };
  const exact = (/** @type {string} */ category, /** @type {unknown} */ v) => {
    if (typeof v === 'string' && v.length > 0) exacts.set(v, category);
  };
  for (const f of acc.files || []) {
    add('log path', f.relPath, 8);
    const first = typeof f.relPath === 'string' ? f.relPath.split('/')[0] : '';
    add('encoded project folder', first, 8);
  }
  for (const p of acc.byProject || []) add('project key', p.projectKey, 6);
  for (const s of acc.bySession || []) { add('session id', s.sessionId, 8); add('launch folder', s.launchFolder, 6); }
  for (const r of acc.responses || []) { add('session id', r.sessionId, 8); add('project key', r.projectKey, 6); }
  for (const t of acc.tools || []) { add('file path hash', t.filePathHash, 16); add('tool call id', t.id, 12); }
  for (const s of acc.secrets || []) for (const k of s.projectKeys || []) add('project key', k, 6);
  if (redacted) {
    for (const p of acc.byProject || []) { exact('project label', p.label); add('project label', p.label, 8); }
    for (const t of acc.tools || []) {
      exact('file label', t.fileLabel);
      add('file label', t.fileLabel, 8);
      if (toolNameClass(t.name) !== 'builtin') { exact('tool name', t.name); add('tool name', t.name, 8); }
    }
    for (const r of acc.responses || []) {
      const a = r.attribution;
      if (a) for (const k of ['agent', 'skill', 'mcpServer', 'plugin']) { exact('attribution name', a[k]); add('attribution name', a[k], 8); }
    }
    for (const u of acc.unpriced || []) { exact('unpriced model id', u.model); add('unpriced model id', u.model, 8); }
  }
  const lengths = [...new Set([...subs.keys()].map((k) => k.length))].sort((a, b) => a - b);
  return { subs, cats, exacts, lengths };
}

/**
 * Program text that reaches the Summary verbatim: the action and label copy of the insights,
 * evidence units, built-in tool names, fixed enum values, the schema kind and the tool name. It
 * is the same for every user and never comes from a log, so a private string found only INSIDE
 * one of these phrases is the program's own words, not a leak: under --redact a file labelled
 * ".claude/settings.json" matched the retention advice of I12, and a project called
 * "auditrail" would match the product name. An occurrence that reaches past the phrase, or
 * sits anywhere else, is still reported. The exemption never applies to a label field (the
 * fields checkRedacted() lists): a project literally named "auditrail" is private there.
 */
export const FIXED_COPY = Object.freeze([
  SUMMARY_KIND, 'auditrail', VALUE_LABEL, CUSTOM_VALUE_LABEL, CUSTOM_VALUE_LABEL_NO_FILE, REDACTED_PRICE_FILE, NOT_PAID_NOTE, REPO_DISPLAY,
  ...TOOL_DISPLAY_NAMES, ...FILE_CLASSES, ...COMMAND_INTENTS, ...ERROR_CATEGORIES, ...SKIP_REASONS,
  ACTION_PLAN, ACTION_MONEY_MAP, ACTION_IDLE, ACTION_DELEGATION, ACTION_REPRICE, REPRICING_LABEL, ACTION_RATE_LIMITS,
  ...Object.values(TOOL_ACTIONS), ACTION_CHURN, ACTION_PATTERNS, ACTION_WORKFLOWS, ACTION_SECRETS, ' Critical copies on disk: ',
  ACTION_HISTORY, ACTION_MODELS, ACTION_RECEIPTS, LINES_WRITTEN_LABEL,
  // Evidence units, written inline by the insights.
  'agent runs', 'critical findings', 'days covered', 'files', 'prompts', 'responses', 'tool calls', 'windows', 'workflow agents started',
]);

const FIXED_SET = new Set(FIXED_COPY);
const FIXED_LOWER = [...new Set(FIXED_COPY.map((p) => p.toLowerCase()))];

/**
 * Search every string (keys included) in a finished Summary for private strings. Returns
 * { category, path } only; the offending string is never part of the result.
 *
 * A string contains a needle exactly when one of its windows of the needle's length is that
 * needle, so each string is cut into windows of every needle length and each window is looked
 * up in the needle map. That costs the Summary's own size times the number of distinct needle
 * lengths, instead of every string times every needle (tens of thousands of tool-call ids and
 * paths on a large log folder), and finds the same needles. A window that lies entirely inside
 * a FIXED_COPY phrase is program text and does not count, and a string equal to a FIXED_COPY
 * phrase is never an exact-label hit, except in a label field.
 * @param {any} summary
 * @param {import('./accounting/contract.js').AccountingResult} acc
 * @returns {{ category: string, path: string }[]}
 */
export function findSummaryLeaks(summary, acc) {
  const { subs, cats, exacts, lengths } = privateNeedles(acc, Boolean(summary && summary.redacted));
  if (!subs.size && !exacts.size) return [];
  /** @type {{ category: string, path: string }[]} */
  const hits = [];
  const seen = new Set();
  /** @type {string[]} */
  const fields = [];
  if (summary && typeof summary === 'object') checkRedacted(summary, fields);
  const labelAt = new Set(fields.map((p) => '$.' + p));
  // Object keys are checked against the substring needles only: most keys are the schema's own
  // field names ("pricing", "scan", "totals", ...), and a short project or tool label that
  // happens to equal one of them is a coincidence, not a leak (a project named "pricing" made
  // --redact fail). A label long enough to be a substring needle is still caught in a key.
  const check = (/** @type {string} */ str, /** @type {string} */ path, isKey = false) => {
    if (seen.has(path)) return;
    const copyOk = !labelAt.has(path);
    const cat = isKey || (copyOk && FIXED_SET.has(str)) ? undefined : exacts.get(str);
    if (cat) { seen.add(path); hits.push({ category: cat, path }); return; }
    const low = str.toLowerCase();
    /** @type {number[]|null} start and end of every FIXED_COPY phrase in the string, found on the first hit */
    let spans = null;
    const fixed = (/** @type {number} */ at, /** @type {number} */ end) => {
      if (!copyOk) return false;
      if (!spans) {
        spans = [];
        for (const p of FIXED_LOWER) for (let k = low.indexOf(p); k >= 0; k = low.indexOf(p, k + 1)) spans.push(k, k + p.length);
      }
      for (let j = 0; j < spans.length; j += 2) if (spans[j] <= at && end <= spans[j + 1]) return true;
      return false;
    };
    let best = -1;
    for (const len of lengths) {
      if (len > low.length) break;
      for (let i = 0; i + len <= low.length; i++) {
        const rank = subs.get(len === low.length ? low : low.slice(i, i + len));
        if (rank !== undefined && (best < 0 || rank < best) && !fixed(i, i + len)) best = rank;
      }
    }
    if (best >= 0) { seen.add(path); hits.push({ category: cats[best], path }); }
  };
  (function walk(v, path) {
    if (typeof v === 'string') { check(v, path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        check(k, path + '{key}', true);
        walk(x, path + '.' + k);
      }
    }
  })(summary, '$');
  return hits;
}
