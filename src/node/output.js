// Terminal text and export files (DESIGN 8.2, I14, traps 49, 66).
//
// Terminal rule (people screen-record terminals): COUNTS ONLY. Version, sandbox status, scan
// timestamp, files, MB, seconds, responses, incomplete share, output path. Never a project name,
// a path fragment from the logs, a model id outside the price table, or free text from a log.
// The one exception is `secrets --locations`, which prints file locations on explicit request.
//
// Export files are local data files: they may carry the local labels the Summary carries
// (project labels, unless --redact), and every file states its method.

import { formatUsd, ratio } from '../core/money.js';
import { VALUE_LABEL } from '../core/constants.js';
import { FILE_CLASSES } from '../core/adapters/contract.js';

/**
 * @param {number} n
 * @returns {string}
 */
export function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function fmtMb(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * @param {number} share 0..1
 * @param {number} [decimals]
 * @returns {string}
 */
export function fmtPct(share, decimals = 1) {
  return (Number.isFinite(share) ? share * 100 : 0).toFixed(decimals) + '%';
}

/**
 * Peak resident memory of this process so far, in MB (resourceUsage().maxRSS is in kilobytes).
 * @returns {number}
 */
export function peakRssMb() {
  try { return Math.round(process.resourceUsage().maxRSS / 1024); } catch { return Math.round(process.memoryUsage().rss / 1048576); }
}

/**
 * The scan receipt lines printed by every command (counts only).
 * @param {{
 *   takenAt: string, filesRead: number, bytes: number, seconds: number, peakMb: number,
 *   skippedFiles: { compressed: number, 'unknown-extension': number, 'unknown-shape': number },
 *   parseErrors: number, trailingPartial: number, oversizeLines: number, unreadableFiles: number,
 * }} s
 * @returns {string[]}
 */
export function scanLines(s) {
  const skipped = s.skippedFiles.compressed + s.skippedFiles['unknown-extension'] + s.skippedFiles['unknown-shape'];
  const lines = [
    'scan taken ' + s.takenAt,
    'scanned ' + fmtInt(s.filesRead) + ' files (' + fmtMb(s.bytes) + ') in ' + s.seconds.toFixed(1) + ' s, peak memory ' + fmtInt(s.peakMb) + ' MB',
  ];
  const notes = [];
  if (skipped) notes.push(fmtInt(skipped) + ' files skipped (' + fmtInt(s.skippedFiles.compressed) + ' compressed, ' + fmtInt(skipped - s.skippedFiles.compressed) + ' unknown)');
  if (s.unreadableFiles) notes.push(fmtInt(s.unreadableFiles) + ' files vanished or unreadable after the stat pass');
  notes.push(fmtInt(s.parseErrors) + ' parse errors', fmtInt(s.trailingPartial) + ' partial trailing lines (sessions still writing)');
  if (s.oversizeLines) notes.push(fmtInt(s.oversizeLines) + ' oversize lines skipped');
  lines.push(notes.join(', '));
  return lines;
}

/**
 * @param {{ responses: number, incomplete: number }} t
 * @returns {string}
 */
export function responsesLine(t) {
  const share = t.responses ? t.incomplete / t.responses : 0;
  return 'responses ' + fmtInt(t.responses) + ', of which ' + fmtPct(share) + ' never recorded final output counts (value is a lower bound)';
}

/* ------------------------------------------------------------------------------------------
 * audit
 * ---------------------------------------------------------------------------------------- */

/**
 * Rule A26 cross-check: for each cost-state window (last snapshot per sessionId and startTime),
 * the transcript value of the same session over the same time range divided by the value Claude
 * Code reported. Audit only; never added to any total.
 * @param {import('../core/accounting/contract.js').AccountingResult} acc
 * @returns {{ windows: number, compared: number, ratios: number[], median: number|null }}
 */
export function costStateRatios(acc) {
  const windows = Array.isArray(acc.costStateWindows) ? acc.costStateWindows : [];
  /** @type {Map<string, { ts: number, nano: number }[]>} */
  const bySession = new Map();
  for (const r of acc.responses) {
    if (!r.sessionId || typeof r.tsStart !== 'number') continue;
    let a = bySession.get(r.sessionId);
    if (!a) { a = []; bySession.set(r.sessionId, a); }
    a.push({ ts: r.tsStart, nano: r.valueNano });
  }
  const ratios = [];
  for (const w of windows) {
    if (!w.sessionId || typeof w.startTime !== 'number' || typeof w.lastTs !== 'number' || !w.reportedCostNano) continue;
    let sum = 0n;
    for (const r of bySession.get(w.sessionId) ?? []) if (r.ts >= w.startTime && r.ts <= w.lastTs) sum += BigInt(r.nano);
    ratios.push(ratio(sum, BigInt(w.reportedCostNano)));
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  return { windows: windows.length, compared: ratios.length, ratios, median };
}

/**
 * `auditrail audit`: receipts, counts and money only (no names, no paths).
 * @param {{
 *   acc: import('../core/accounting/contract.js').AccountingResult,
 *   prices: { fetched: string, source: string, models: unknown[] },
 *   valueLabel: string,
 *   nowMs: number,
 *   methods?: import('../core/accounting/contract.js').MethodsDiagnostics|null,
 * }} o
 * @returns {string[]}
 */
export function auditLines(o) {
  const { acc } = o;
  const out = [];
  const asOf = o.prices.fetched;
  const usd = (nano) => formatUsd(nano, { decimals: 2 });
  out.push('files by class');
  for (const c of FILE_CLASSES) {
    const s = acc.scanByClass[c];
    out.push('  ' + c.padEnd(17) + fmtInt(s.files).padStart(8) + ' files ' + fmtMb(s.bytes).padStart(11) + fmtInt(s.lines).padStart(12) + ' lines ' + fmtInt(s.parseErrors) + ' parse errors, ' + fmtInt(s.trailingPartial) + ' partial');
  }
  const sk = acc.skippedFiles;
  out.push('  skipped: ' + fmtInt(sk.compressed) + ' compressed, ' + fmtInt(sk['unknown-extension']) + ' unknown extension, ' + fmtInt(sk['unknown-shape']) + ' unknown shape (never read)');

  const d = acc.dedup;
  out.push('responses');
  out.push('  ' + fmtInt(d.observations) + ' usage lines map to ' + fmtInt(d.keys) + ' distinct responses (' + (d.keys ? (d.observations / d.keys).toFixed(2) : '0') + ' lines per response); rule A1 global dedup by message id');
  out.push('  ' + fmtInt(d.syntheticLines) + ' synthetic placeholder lines excluded; ' + fmtInt(d.forkedKeys) + ' responses seen in more than one file (counted once)');
  out.push('  invariants: ' + fmtInt(d.invariantViolations) + ' responses with differing input or cache fields across lines, ' + fmtInt(d.gatewayConflicts) + ' gateway id conflicts, ' + fmtInt(d.ambiguousAttach) + ' ambiguous attaches');
  out.push('  tools: ' + fmtInt(d.duplicateToolUseIds) + ' duplicate tool ids, ' + fmtInt(d.orphanToolResults) + ' results without a call');
  const t = acc.totals;
  out.push('  ' + responsesLine({ responses: t.responses, incomplete: t.incomplete }));

  out.push('value');
  out.push('  at least ' + usd(t.valueNano) + ' ' + o.valueLabel + ' (as of ' + asOf + '). Not what you paid.');
  const pricedShare = acc.allTokens ? ratio(acc.pricedTokens, acc.allTokens) : 1;
  const unpricedTokens = acc.unpriced.reduce((s, u) => s + u.tokens, 0);
  out.push('  priced token share ' + fmtPct(pricedShare, 2) + '; unpriced: ' + fmtInt(acc.unpriced.length) + ' model ids, ' + fmtInt(unpricedTokens) + ' tokens (names in the report)');
  const m = acc.modifiers;
  out.push('  modifiers: ' + fmtInt(m.fast) + ' fast-mode responses, ' + fmtInt(m.geoUs) + ' US-inference responses, ' + fmtInt(m.nonStandardTier) + ' non-standard tier (priced at standard), ' + fmtInt(m.ttlEstimated) + ' cache splits estimated, ' + fmtInt(m.webSearchRequests) + ' web search requests');
  const tk = t.tokens;
  out.push('  tokens: output ' + fmtInt(tk.output) + ', fresh input ' + fmtInt(tk.input + tk.cw5m + tk.cw1h) + ' (uncached ' + fmtInt(tk.input) + ', 5m writes ' + fmtInt(tk.cw5m) + ', 1h writes ' + fmtInt(tk.cw1h) + '), cache reads ' + fmtInt(tk.cacheRead));

  out.push('price table');
  const ageDays = Math.max(0, Math.floor((o.nowMs - Date.parse(asOf + 'T00:00:00Z')) / 86_400_000));
  out.push('  anthropic list prices as of ' + asOf + ' (' + fmtInt(o.prices.models.length) + ' models, ' + ageDays + ' days old), applied to all dates; source ' + o.prices.source);
  if (ageDays > 180) out.push('  price table is ' + ageDays + ' days old; update auditrail');

  const cs = costStateRatios(acc);
  out.push('cost-state cross-check (audit only, never added to totals)');
  if (!cs.compared) out.push('  ' + fmtInt(cs.windows) + ' windows, none comparable');
  else out.push('  ' + fmtInt(cs.compared) + ' of ' + fmtInt(cs.windows) + ' windows compared; transcript value / Claude Code figure: median ' + (cs.median ?? 0).toFixed(3) + ', range ' + Math.min(...cs.ratios).toFixed(3) + ' to ' + Math.max(...cs.ratios).toFixed(3));

  if (o.methods) out.push(...methodsLines(o.methods, asOf));
  return out;
}

/** Method names for `audit --methods` (DESIGN 4.3 table, 9.4). */
export const METHOD_LABELS = Object.freeze({
  correct: 'correct (rules A1 to A33)',
  sumEveryLine: 'sum every line',
  keepFirstLine: 'dedup, keep first line',
  dedupPerFile: 'dedup per file instead of globally',
  allWritesAt5m: 'all cache writes priced at 5m',
  mainFilesOnly: 'main-thread files only',
});

/**
 * @param {import('../core/accounting/contract.js').MethodsDiagnostics} m
 * @param {string} asOf
 * @returns {string[]}
 */
export function methodsLines(m, asOf) {
  const out = ['value under each counting method (' + VALUE_LABEL + ', as of ' + asOf + ')'];
  for (const k of /** @type {(keyof typeof METHOD_LABELS)[]} */ (Object.keys(METHOD_LABELS))) {
    const v = m[k];
    if (typeof v !== 'bigint') continue;
    const r = m.correct ? ratio(v, m.correct) : 0;
    out.push('  ' + METHOD_LABELS[k].padEnd(38) + formatUsd(v, { decimals: 2 }).padStart(14) + '   ratio ' + r.toFixed(3));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * export
 * ---------------------------------------------------------------------------------------- */

/**
 * Plain decimal dollars with 6 decimals, no symbol or grouping (for CSV).
 * @param {string|bigint|number} nano
 * @returns {string}
 */
export function usdDecimal(nano) {
  return formatUsd(nano, { decimals: 6 }).replace(/[$,]/g, '');
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Rows for one --by dimension, from the Summary's I1 data.
 * @param {any} summary
 * @param {'day'|'month'|'model'|'project'} by
 * @returns {{ key: string, responses: number, valueNano: string, sessions?: number }[]}
 */
export function exportRows(summary, by) {
  const d = summary.insights.i01.data;
  if (by === 'day') return (d.byDay ?? []).map((r) => ({ key: r.date, responses: r.responses, valueNano: r.valueNano }));
  if (by === 'month') return (d.byMonth ?? []).map((r) => ({ key: r.month, responses: r.responses, valueNano: r.valueNano }));
  if (by === 'model') return (d.byModel ?? []).map((r) => ({ key: r.displayName ?? r.model, responses: r.responses, valueNano: r.valueNano }));
  return (d.byProject ?? []).map((r) => ({ key: r.label, responses: r.responses, valueNano: r.valueNano, sessions: r.sessions }));
}

/**
 * The method statement every export carries.
 * @param {any} s Summary
 * @returns {string}
 */
export function methodNote(s) {
  const share = s.totals.responses ? s.totals.incompleteResponses / s.totals.responses : 0;
  return s.pricing.label + (s.pricing.custom ? '' : ' as of ' + s.pricing.asOf) + '. A lower bound: ' + fmtPct(share) +
    ' of responses never recorded final output counts, and web search fees and side calls are not in local logs. Not what you paid. Scan taken ' +
    s.scan.takenAt + ', ' + s.scan.filesRead + ' files, time zone ' + s.tz + '.';
}

/**
 * @param {any} summary
 * @param {'day'|'month'|'model'|'project'} by
 * @returns {string}
 */
export function exportCsv(summary, by) {
  const rows = exportRows(summary, by);
  const header = [by, 'responses', 'value_usd'].concat(by === 'project' ? ['sessions'] : []);
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [csvCell(r.key), String(r.responses), usdDecimal(r.valueNano)];
    if (by === 'project') cells.push(String(r.sessions ?? 0));
    lines.push(cells.join(','));
  }
  lines.push(csvCell('# ' + methodNote(summary)));
  return lines.join('\r\n') + '\r\n';
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/**
 * Activity receipts (I14) plus the value table, with method footnotes.
 * @param {any} summary
 * @param {'day'|'month'|'model'|'project'} by
 * @returns {string}
 */
export function exportMarkdown(summary, by) {
  const r = summary.insights.i14.data;
  const i09 = summary.insights.i09.data;
  const out = [];
  out.push('# Auditrail activity receipts', '');
  out.push('Generated ' + summary.generatedAt + ' by auditrail ' + summary.tool.version + '.', '');
  out.push('| Receipt | Count |', '|---|---:|');
  const add = (k, v) => out.push('| ' + mdCell(k) + ' | ' + mdCell(v) + ' |');
  add('Active days (local days with at least one prompt)', fmtInt(r.activeDays));
  add('Active hours (' + summary.idleMinutes + '-minute idle cutoff)', typeof i09.activeHours === 'number' ? i09.activeHours.toFixed(1) : '0');
  add('Work blocks', fmtInt(r.workBlocks));
  add('Prompts', fmtInt(r.prompts));
  add('Interrupts', fmtInt(r.interrupts));
  add('Files created', fmtInt(r.filesCreated));
  add('Files edited', fmtInt(r.filesEdited));
  add('Lines written by agent tool calls (not lines that survived)', fmtInt(r.linesWritten));
  for (const c of r.commandIntents ?? []) add('Commands: ' + c.intent.replace(/_/g, ' ') + ' (failures)', fmtInt(c.count) + ' (' + fmtInt(c.failures) + ')');
  add('Value', 'at least ' + formatUsd(r.totalNano ?? summary.totals.valueNano) + ' (' + summary.pricing.label + ')');
  out.push('');
  if (Array.isArray(r.models) && r.models.length) out.push('Models used: ' + r.models.map(mdCell).join(', ') + '.', '');
  out.push('## Value by ' + by, '');
  const rows = exportRows(summary, by);
  out.push('| ' + by + ' | Responses | Value |' + (by === 'project' ? ' Sessions |' : ''), '|---|---:|---:|' + (by === 'project' ? '---:|' : ''));
  for (const x of rows) out.push('| ' + mdCell(x.key) + ' | ' + fmtInt(x.responses) + ' | ' + formatUsd(x.valueNano) + ' |' + (by === 'project' ? ' ' + fmtInt(x.sessions ?? 0) + ' |' : ''));
  out.push('', '## Method', '');
  out.push('- ' + methodNote(summary));
  out.push('- Active time sums only gaps of at most ' + summary.idleMinutes + ' minutes between events of a session; parallel agents are not counted twice.');
  out.push('- Days and hours are local to ' + summary.tz + '.');
  out.push('- Files are counted by hashed path; lines come from the agent tool call inputs.');
  if (summary.redacted) out.push('- Share-safe mode: project and file names are replaced with Project A, File A, and so on.');
  out.push('');
  return out.join('\n');
}

/** What replaces the I11 secret findings in an export file. */
export const EXPORT_SECRETS_NOTE =
  'Secret findings are not exported. They are shown only in the local HTML report, which carries ' +
  'its own warning, and located only by `auditrail secrets --locations`.';

/**
 * Strip the I11 secret findings out of a Summary copy for export.
 *
 * README promise: "Secret findings are shown as a type and a fingerprint, never as the value, and
 * they never appear in any export or on the card." An export file is the artifact people paste
 * into an issue, a gist or a spreadsheet, and a finding row announces that a live key of a named
 * type exists in a named project; the 12-hex fingerprint is a confirmation oracle against a
 * candidate value. exportCsv and exportMarkdown never carried them; this makes --json match.
 * @param {any} summary
 * @returns {any} a copy; the caller's Summary is untouched
 */
export function stripSecretsForExport(summary) {
  const out = JSON.parse(JSON.stringify(summary));
  const i11 = out && out.insights && out.insights.i11;
  if (i11 && typeof i11 === 'object') {
    // The stub is the same whether or not anything was found, so the export does not disclose
    // even the existence or the count of findings.
    i11.shown = false;
    i11.data = { findings: [], bySeverity: {}, withheld: true, note: EXPORT_SECRETS_NOTE };
    i11.evidence = { count: 0, unit: 'critical findings' };
    i11.action = EXPORT_SECRETS_NOTE;
  }
  return out;
}

/**
 * @param {any} summary
 * @returns {string}
 */
export function exportJson(summary) {
  return JSON.stringify(stripSecretsForExport(summary), null, 2) + '\n';
}

/* ------------------------------------------------------------------------------------------
 * secrets --locations (the only terminal output that names files, on explicit request)
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {{ secretType: string, fingerprint12: string, severity: string, fileIdx: number, lineNo: number }[]} hits
 * @param {{ relPath: string, rootIdx: number }[]} files
 * @param {string[]} roots
 * @returns {string[]}
 */
export function secretLocationLines(hits, files, roots) {
  const out = [
    'Secret finding locations. This list names files: do not screen-record or paste it.',
    'Values are never shown; the fingerprint is the first 12 hex of SHA-256(value).',
  ];
  /** @type {Map<string, { type: string, severity: string, where: Set<string> }>} */
  const groups = new Map();
  for (const h of hits) {
    const k = h.secretType + '|' + h.fingerprint12;
    let g = groups.get(k);
    if (!g) { g = { type: h.secretType, severity: h.severity, where: new Set() }; groups.set(k, g); }
    if (rank(h.severity) < rank(g.severity)) g.severity = h.severity;
    const f = files[h.fileIdx];
    if (f) g.where.add((roots.length > 1 ? '[root ' + (f.rootIdx + 1) + '] ' : '') + f.relPath + ':' + h.lineNo);
  }
  const sorted = [...groups.entries()].sort((a, b) => rank(a[1].severity) - rank(b[1].severity) || (a[0] < b[0] ? -1 : 1));
  if (!sorted.length) out.push('No secret findings.');
  for (const [k, g] of sorted) {
    out.push(g.severity + ' ' + g.type + ' ' + k.split('|')[1] + ' (' + g.where.size + ' locations)');
    for (const w of [...g.where].sort()) out.push('  ' + w);
  }
  if (roots.length) out.push('Paths are relative to: ' + roots.map((r, i) => (roots.length > 1 ? '[root ' + (i + 1) + '] ' : '') + r).join('; '));
  return out;
}

/**
 * @param {string} s
 * @returns {number}
 */
function rank(s) {
  return s === 'critical' ? 0 : s === 'likely_fixture' ? 1 : 2;
}
