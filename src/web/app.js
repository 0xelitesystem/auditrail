// The report page and the drop-mode app (DESIGN 6, 7, 8.1, 8.7, 8.8). One script, inlined into
// the report template by scripts/build.mjs and allowed by the page CSP through its SHA-256.
//
// Two modes, chosen by the embedded data:
// - REPORT: <script type="application/json" id="ar-data"> holds a Summary (written by the CLI, or
//   by this page when it saves a copy). It is rendered with the hand-written SVG charts and the
//   formatters in format.js; every label goes through esc().
// - DROP: no data embedded. The page asks for the Claude Code projects folder (drag and drop
//   first, then showDirectoryPicker where it exists, then <input webkitdirectory> with the
//   "upload" wording explained beside it), runs the same core in a Web Worker started from the
//   ar-worker source (worker.js), and renders the Summary it returns.
//
// Privacy rules kept here:
// - The share card is drawn from the PublicSummary only (core/public.js), never from labels, and
//   the manifest next to it lists every field it contains.
// - Share-safe mode swaps every local label (share-safe.js) before anything is drawn; a saved
//   share-safe copy embeds only the swapped Summary.
// - No network: the CSP blocks every connection, and this file never names a URL or loads
//   anything. The card PNG and saved copies are blob: downloads the user starts.
//
// Everything that builds markup is a pure function exported for test/web/app.test.js; the DOM
// controller at the bottom only runs in a browser document.

import {
  esc, usd, usdShort, dollars, int, compact, pct, hoursText, duration, dateText, monthText,
  rangeText, isoText, hourText, bytesText,
} from './format.js';
import { columnChart } from './charts/columns.js';
import { barRows } from './charts/bars.js';
import { heatmap } from './charts/heatmap.js';
import { stackedBar } from './charts/stacked.js';
import { shareSafeSummary } from './share-safe.js';
import { embedJson, parseDataBlock } from './embed.js';
import { toPublicSummary, buildManifest, altText, CARD_HIDE_KEYS } from '../core/public.js';
import { renderCard } from '../core/card/layout.js';
import { CARD_SIZES } from '../core/card/contract.js';
import { getPriceTable } from '../core/prices/index.js';
import { PRICE_TABLE_STALE_DAYS, CLAUDE_CODE_DEFAULT_RETENTION_DAYS } from '../core/constants.js';
import { INSIGHT_META } from '../core/insights/contract.js';
import { secretTypeInfo } from '../core/secrets.js';

/* ------------------------------------------------------------------------------------------
 * Fixed copy
 * ---------------------------------------------------------------------------------------- */

// The three banners below name every category shareSafeSummary() replaces
// (SHARE_SAFE_CATEGORIES in share-safe.js), including model ids that are not in the published
// price table: a Bedrock or gateway id such as an inference-profile ARN carries an account id,
// and a warning that named only projects and files would understate what the file holds.
// test/web/app.test.js fails if a category is missing from any of the three.

/** The sharing banner (DESIGN 8.8), shown before the file is sent anywhere. */
export const SHARE_BANNER = 'This report contains names from your machine: project, file, agent, skill, MCP server, MCP tool, other tool and unpriced model names, plus the name of a custom price file if you used one. Share the card, or use Share-safe mode (or --redact) before sending this file to anyone.';

/** Banner while Share-safe mode is on. */
export const SHARE_SAFE_BANNER = 'Share-safe mode is on: project, file, agent, skill, MCP server, MCP tool, other tool and unpriced model names are replaced with Project A, File B and so on, and a custom price file name becomes "custom rates". Save a share-safe copy to send this report to someone.';

/** Banner for a Summary that was already redacted (--redact, or a saved share-safe copy). */
export const REDACTED_BANNER = 'Share-safe copy: project, file, agent, skill, MCP server, MCP tool, other tool and unpriced model names were replaced with Project A, File B and so on, and a custom price file name became "custom rates", before this file was written.';

/** Banner for the live demo. */
export const DEMO_BANNER = 'Demo: every number on this page comes from synthetic sessions made for the demo, not from anyone\'s logs.';

/** Banner after a drop-mode scan. */
export const DROPPED_BANNER = 'Computed in this tab from the folder you chose. Nothing left this page. Save the report to keep it; closing the tab discards it.';

/** Copy beside the webkitdirectory button (DESIGN 8.8, trap 59). */
export const UPLOAD_NOTE = 'Your browser will say \'upload\'. This page has no network permission; check DevTools.';

/**
 * Per-OS steps to reach the hidden folder (DESIGN 8.8).
 * @type {Readonly<Record<'windows'|'mac'|'linux', { label: string, path: string, steps: string[] }>>}
 */
export const OS_HELP = Object.freeze({
  windows: Object.freeze({
    label: 'Windows',
    path: '%USERPROFILE%\\.claude',
    steps: ['Press Win+R to open Run.', 'Paste the path below and press Enter. Explorer opens the hidden .claude folder.', 'Drag the projects folder from that window onto this page.'],
  }),
  mac: Object.freeze({
    label: 'macOS',
    path: '~/.claude',
    steps: ['In Finder, press Cmd+Shift+G (Go to Folder).', 'Paste the path below and press Return.', 'Drag the projects folder onto this page. In a file picker, Cmd+Shift+. shows hidden folders.'],
  }),
  linux: Object.freeze({
    label: 'Linux',
    path: '~/.claude',
    steps: ['In your file manager, press Ctrl+L to type a location (Ctrl+H shows hidden folders).', 'Paste the path below and press Enter.', 'Drag the projects folder onto this page.'],
  }),
});

/** Labels for the card stat toggles, keyed like CARD_HIDE_KEYS (the CLI --card-hide names). */
export const HIDE_LABELS = Object.freeze({
  value: 'Value', 'output-tokens': 'Output tokens', 'active-hours': 'Active hours', tools: 'Tool calls',
  'top-tool': 'Top tool', 'cache-hit-rate': 'Cache hit rate', delegation: 'Delegation', streak: 'Longest streak',
  'peak-hour': 'Peak hour', 'max-edits': 'Most edited file', 'top-model': 'Top model', archetype: 'Archetype',
  badges: 'Badges', coverage: 'Coverage', heatmap: 'Activity heatmap',
});

/** Insights that form the fix list (or the checked-and-clear list), in DESIGN 6 order. */
export const FIX_IDS = Object.freeze(['i03', 'i04', 'i05', 'i06', 'i07', 'i08', 'i10', 'i11']);

/** Report parts in page order: id, heading, intro. */
export const PARTS = Object.freeze([
  { id: 'value', title: 'Value and models', intro: 'API-equivalent value: the same tokens priced at API list prices. It is not what you paid on a subscription.' },
  { id: 'money', title: 'Money map and delegation', intro: 'Most of the value in agent work is context being written to and read from the cache, not the text the model writes.' },
  { id: 'fixes', title: 'Limits, tools and files', intro: 'Arithmetic on your logs, no model calls: where the agent hit walls, failed or kept rewriting the same files.' },
  { id: 'patterns', title: 'How you work', intro: 'Time from event timestamps in your local time zone. Gaps longer than the idle cutoff are not counted.' },
  { id: 'safety', title: 'Secrets and history', intro: 'What sits on disk in plain text, and how much history the default retention has already removed.' },
]);

/* ------------------------------------------------------------------------------------------
 * Small pure helpers
 * ---------------------------------------------------------------------------------------- */

/** @param {unknown} x @returns {number} */
function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : 0; }
/** @param {unknown} x @returns {any[]} */
function arr(x) { return Array.isArray(x) ? x : []; }
/** @param {unknown} x @returns {Record<string, any>} */
function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? /** @type {any} */ (x) : {}; }

/**
 * @param {any} s Summary
 * @param {string} id
 * @returns {{ id: string, shown: boolean, data: Record<string, any>, evidence: { count: number, unit: string }|null, action: string|null }}
 */
function res(s, id) {
  const r = s && s.insights ? s.insights[id] : null;
  if (!r || typeof r !== 'object') return { id, shown: false, data: {}, evidence: null, action: null };
  return { id, shown: r.shown === true, data: obj(r.data), evidence: r.evidence && typeof r.evidence === 'object' ? r.evidence : null, action: typeof r.action === 'string' ? r.action : null };
}

/**
 * True for an object that looks like a Summary this page can render.
 * @param {unknown} x
 * @returns {boolean}
 */
export function isSummary(x) {
  const s = /** @type {any} */ (x);
  return !!s && typeof s === 'object' && s.kind === 'auditrail.summary' && s.schema === 1 && !!s.insights && typeof s.insights === 'object';
}

/**
 * "319 responses", "1 response", "1 workflow agent started".
 * @param {{ count: number, unit: string }|null} ev
 * @returns {string}
 */
export function evidenceText(ev) {
  if (!ev || !Number.isFinite(ev.count)) return '';
  const words = String(ev.unit || '').split(' ');
  if (ev.count === 1) {
    const i = words.findIndex((w) => w.length > 2 && w.endsWith('s'));
    if (i >= 0) words[i] = words[i].slice(0, -1);
  }
  return int(ev.count) + ' ' + words.join(' ');
}

/**
 * The OS to show first in the hidden-folder helper.
 * @param {string} [platformText] navigator.userAgentData.platform, navigator.platform or the UA
 * @returns {'windows'|'mac'|'linux'}
 */
export function detectOs(platformText) {
  const p = String(platformText || '');
  if (/win/i.test(p)) return 'windows';
  if (/mac|iphone|ipad|darwin/i.test(p)) return 'mac';
  return 'linux';
}

/**
 * Every calendar day from the first to the last listed day, zero where nothing was recorded, so
 * the daily chart shows quiet days as gaps. Capped at 1,000 days.
 * @param {{ date: string, valueNano: string, responses: number }[]} byDay
 * @returns {{ date: string, valueNano: string, responses: number }[]}
 */
export function fillDays(byDay) {
  const rows = arr(byDay).filter((r) => r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if (rows.length < 2) return rows;
  const map = new Map(rows.map((r) => [r.date, r]));
  const first = Date.parse(rows[0].date + 'T00:00:00Z');
  const last = Date.parse(rows[rows.length - 1].date + 'T00:00:00Z');
  if (!(last >= first) || (last - first) / 86_400_000 > 1000) return rows;
  const out = [];
  for (let t = first; t <= last; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(map.get(date) ?? { date, valueNano: '0', responses: 0 });
  }
  return out;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {string} one dotted receipt row
 */
function receiptRow(label, value) {
  return '<li><span class="k">' + esc(label) + '</span><span class="dots" aria-hidden="true"></span><span class="v">' + esc(value) + '</span></li>';
}

/**
 * @param {[string, string][]} rows
 * @param {string} [aria]
 * @returns {string}
 */
function receipt(rows, aria) {
  return '<ul class="receipt"' + (aria ? ' aria-label="' + esc(aria) + '"' : '') + '>' + rows.map(([k, v]) => receiptRow(k, v)).join('') + '</ul>';
}

/**
 * @param {[string, string][]} items value, label
 * @returns {string}
 */
function stats(items) {
  return '<div class="stats">' + items.map(([v, k]) => '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>').join('') + '</div>';
}

/**
 * A table. Cells are pre-escaped HTML; numeric columns align right.
 * @param {{ label: string, num?: boolean }[]} cols
 * @param {string[][]} rows
 * @param {string} caption
 * @returns {string}
 */
function table(cols, rows, caption) {
  const head = '<tr>' + cols.map((c) => '<th scope="col"' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>').join('') + '</tr>';
  const body = rows.map((r) => '<tr>' + r.map((cell, i) => '<td' + (cols[i] && cols[i].num ? ' class="num"' : '') + '>' + cell + '</td>').join('') + '</tr>').join('');
  return '<div class="table-wrap"><table><caption class="visually-hidden">' + esc(caption) + '</caption><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

/**
 * @param {string} summaryText
 * @param {string} inner
 * @param {boolean} [open]
 * @returns {string}
 */
function details(summaryText, inner, open = false) {
  return '<details' + (open ? ' open' : '') + '><summary>' + esc(summaryText) + '</summary>' + inner + '</details>';
}

/** Axis label for count charts: whole numbers only (fractional grid lines stay unlabeled). */
function countTick(/** @type {number} */ v) { return Number.isInteger(v) ? int(v) : ''; }

/** @param {string} text @returns {string} */
function note(text) { return '<p class="note">' + esc(text) + '</p>'; }

/** @param {string|null} action @returns {string} */
function todo(action) {
  return action ? '<div class="todo"><b>Do</b><p>' + esc(action) + '</p></div>' : '';
}

/**
 * One finding block.
 * @param {any} s
 * @param {string} id
 * @param {string} headline plain text
 * @param {string} body HTML
 * @returns {string}
 */
function finding(s, id, headline, body) {
  const r = res(s, id);
  const meta = /** @type {any} */ (INSIGHT_META)[id];
  const ev = evidenceText(r.evidence);
  return '<section class="finding" id="f-' + id + '" aria-labelledby="h-' + id + '">' +
    '<header><h3 id="h-' + id + '">' + esc(meta ? meta.title : id) + '</h3>' + (ev ? '<p>' + esc(ev) + '</p>' : '') + '</header>' +
    '<div class="body"><p class="headline">' + esc(headline) + '</p>' + body + todo(r.action) + '</div></section>';
}

/* ------------------------------------------------------------------------------------------
 * Insight bodies
 * ---------------------------------------------------------------------------------------- */

/** @param {any} s @returns {string} */
function valueHeadline(s) {
  const x = res(s, 'i01').data;
  const pricing = obj(s.pricing);
  if (pricing.custom) return 'At least ' + usd(x.totalNano) + ' of value at your custom rates. Not what you paid.';
  return 'At least ' + usd(x.totalNano) + ' API-equivalent value (list prices as of ' + String(x.pricesAsOf || pricing.asOf || 'n/a') + '). Not what you paid.';
}

/** @param {any} s @returns {string} */
function i01(s) {
  const x = res(s, 'i01').data;
  const out = [];
  const months = arr(x.byMonth);
  if (months.length > 1) {
    out.push('<h4 class="soft">By month</h4>' + columnChart({
      items: months.map((m) => ({ label: monthText(m.month).slice(0, 3), value: dollars(m.valueNano), title: monthText(m.month) + ': ' + usd(m.valueNano) })),
      ariaLabel: 'Value by month', format: usdShort,
    }));
  }
  const days = fillDays(x.byDay);
  if (days.length) {
    out.push('<h4 class="soft">By day</h4>' + columnChart({
      items: days.map((d) => ({ label: dateText(d.date).replace(/, \d{4}$/, ''), value: dollars(d.valueNano), title: dateText(d.date) + ': ' + usd(d.valueNano) + ', ' + int(d.responses) + ' responses' })),
      ariaLabel: 'Value by local day', format: usdShort,
    }));
  }
  const rowsM = months.map((m) => [esc(monthText(m.month)), esc(usd(m.valueNano)), esc(int(m.responses))]);
  const rowsD = arr(x.byDay).map((d) => [esc(dateText(d.date)), esc(usd(d.valueNano)), esc(int(d.responses))]);
  if (rowsM.length || rowsD.length) {
    out.push(details('Table view by month and day',
      (rowsM.length ? table([{ label: 'Month' }, { label: 'Value', num: true }, { label: 'Responses', num: true }], rowsM, 'Value by month') : '') +
      (rowsD.length ? table([{ label: 'Day' }, { label: 'Value', num: true }, { label: 'Responses', num: true }], rowsD, 'Value by day') : '')));
  }
  const models = arr(x.byModel);
  if (models.length) {
    out.push('<h4 class="soft">By model</h4>' + barRows({
      rows: models.map((m) => ({ label: m.displayName || m.model || 'unknown', value: dollars(m.valueNano), valueText: usd(m.valueNano) + ', ' + int(m.responses) + ' responses' })),
      ariaLabel: 'Value by model',
    }));
  }
  const projects = arr(x.byProject);
  if (projects.length) {
    const rows = projects.map((p) => [esc(p.label), esc(usd(p.valueNano)), esc(int(p.responses)), esc(int(p.sessions))]);
    const cols = [{ label: 'Project' }, { label: 'Value', num: true }, { label: 'Responses', num: true }, { label: 'Sessions', num: true }];
    out.push('<h4 class="soft">By project</h4>' + table(cols, rows.slice(0, 15), 'Value by project') +
      (rows.length > 15 ? details('All ' + int(rows.length) + ' projects', table(cols, rows.slice(15), 'More projects')) : ''));
  }
  const lines = [
    ['Responses priced', int(x.responses)],
    ['Priced token share', pct(x.pricedTokenShare)],
    ['Responses without final output counts', int(x.incompleteResponses) + ' (' + pct(x.incompleteShare) + ')'],
    ['Prompts', int(x.prompts)],
  ];
  if (x.valuePerPromptNano) lines.push(['Value per prompt', usd(x.valuePerPromptNano)]);
  if (num(x.fastResponses) > 0) lines.push(['Fast-mode responses (possibly billed as usage credits)', int(x.fastResponses)]);
  if (x.plan && typeof x.valueMultiple === 'number') {
    lines.push(['Value multiple against ' + (x.plan.name || 'your plan price') + ' (' + usdShort(num(x.plan.usdPerMonth)) + ' per month)', (Math.floor(x.valueMultiple * 10) / 10).toFixed(1) + 'x']);
  }
  out.push(receipt(/** @type {[string, string][]} */ (lines), 'Value receipt'));
  if (x.incompleteBand && typeof x.incompleteBand === 'object') {
    out.push(note('Responses that never recorded final output counts are counted at what they did record, so the total is a lower bound. Had they finished, they would add between ' +
      usd(x.incompleteBand.lowNano) + ' and ' + usd(x.incompleteBand.highNano) + ' (not included in any total).'));
  }
  const unpriced = arr(x.unpriced);
  if (unpriced.length) {
    out.push('<h4 class="soft">Models not in the price table (counted at $0)</h4>' + table(
      [{ label: 'Model' }, { label: 'Responses', num: true }, { label: 'Tokens', num: true }],
      unpriced.map((u) => [esc(u.model), esc(int(u.responses)), esc(compact(u.tokens))]), 'Unpriced models'));
  }
  return out.join('');
}

/** @param {any} s @returns {string} */
function i13(s) {
  const x = res(s, 'i13').data;
  const out = [];
  const models = arr(x.byModel);
  if (models.length) {
    out.push(table([{ label: 'Model' }, { label: 'Responses', num: true }, { label: 'Value', num: true }, { label: 'Share of value', num: true }],
      models.map((m) => [esc(m.displayName || m.model), esc(int(m.responses)), esc(usd(m.valueNano)), esc(pct(m.share))]), 'Model mix'));
  }
  if (typeof x.thinkingShare === 'number') out.push(note('Thinking tokens are part of output tokens, not extra: ' + pct(x.thinkingShare) + ' of output tokens where the log has the breakdown.'));
  const effort = Object.entries(obj(x.effort)).filter(([, v]) => num(v) > 0);
  if (effort.length) {
    out.push('<h4 class="soft">Effort setting per response</h4>' + barRows({ rows: effort.map(([k, v]) => ({ label: k, value: num(v), valueText: int(v) })), ariaLabel: 'Responses by effort setting' }));
  }
  return out.join('');
}

const BUCKETS = Object.freeze([
  ['cacheRead', 'Cache reads'], ['cw1h', 'Cache writes, 1 hour'], ['cw5m', 'Cache writes, 5 minutes'], ['output', 'Output'], ['input', 'Uncached input'],
]);

/** @param {any} s @returns {string} */
function i02(s) {
  const x = res(s, 'i02').data;
  const b = obj(x.bucketsNano);
  const sh = obj(x.bucketShares);
  const t = obj(x.tokens);
  const out = [stackedBar({
    segments: BUCKETS.map(([k, label]) => ({ key: k, label, value: dollars(b[k]), valueText: usd(b[k]), shareText: pct(sh[k]) })),
    ariaLabel: 'Value by token type',
  })];
  const saving = String(x.netCachingSavingNano ?? '0');
  out.push(stats([
    [pct(x.cacheHitRate), 'cache hit rate'],
    [saving.startsWith('-') ? usd(saving.slice(1)) : usd(saving), saving.startsWith('-') ? 'more than paying full input price' : 'saved by caching versus full input price'],
    [compact(t.output), 'output tokens'],
    [compact(t.freshInput), 'fresh input tokens (uncached input plus cache writes)'],
    [compact(t.cacheRead), 'cache read tokens'],
  ]));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i03(s) {
  const x = res(s, 'i03').data;
  const bk = obj(x.buckets);
  const rows = [['first', 'First response in a file'], ['modelSwitch', 'After a model switch'], ['le5m', 'After a gap of 5 minutes or less'], ['m5to60', 'After a gap of 5 to 60 minutes'], ['gt60m', 'After a break of over an hour']]
    .map(([k, label]) => [esc(label), esc(int(obj(bk[k]).responses)), esc(usd(obj(bk[k]).cacheWriteNano))]);
  return table([{ label: 'When the cache was written' }, { label: 'Responses', num: true }, { label: 'Cache write value', num: true }], rows, 'Cache writes by the gap before them') +
    note(int(x.fullMisses) + ' full cache misses (no cache read and more than 20,000 tokens written), ' + int(x.fullMissesAfterGap60) + ' of them after a break of over an hour.');
}

/** @param {any} s @returns {string} */
function i03Headline(s) {
  const x = res(s, 'i03').data;
  const g = obj(obj(x.buckets).gt60m);
  return int(g.responses) + ' comebacks after a break of over an hour re-wrote your context: ' + usd(g.cacheWriteNano) + ' of cache writes, ' + pct(x.gt60mShareOfTotal) + ' of your total.';
}

/** @param {any} s @returns {string} */
function i04(s) {
  const x = res(s, 'i04').data;
  const sub = obj(x.subagent);
  const wf = obj(x.workflowAgent);
  const out = [stats([
    [pct(x.delegationShare), 'of value delegated'],
    [usd(sub.valueNano), 'subagents, ' + int(sub.responses) + ' responses'],
    [usd(wf.valueNano), 'workflow agents, ' + int(wf.responses) + ' responses'],
    [int(x.agentRuns), 'agent runs'],
  ])];
  const attr = obj(x.byAttribution);
  const groups = [['agent', 'Agent'], ['skill', 'Skill'], ['mcpServer', 'MCP server']].filter(([k]) => arr(attr[k]).length);
  if (groups.length) {
    out.push(details('Value by agent, skill and MCP server (local report only)', groups.map(([k, label]) => table(
      [{ label }, { label: 'Responses', num: true }, { label: 'Value', num: true }],
      arr(attr[k]).map((a) => [esc(a.name), esc(int(a.responses)), esc(usd(a.valueNano))]), 'Value by ' + label)).join('')));
  }
  return out.join('');
}

/** @param {any} s @returns {string} */
function i05(s) {
  const x = res(s, 'i05').data;
  return stats([
    [usd(x.eligibleNano), 'Opus and Fable subagent value, ' + int(x.eligibleResponses) + ' responses'],
    [usd(x.atSonnet5Nano), 'the same tokens at Sonnet 5 list prices'],
    [usd(x.differenceNano), 'difference'],
  ]) + (x.label ? note(String(x.label)) : '');
}

/** @param {any} s @returns {string} */
function i06(s) {
  const x = res(s, 'i06').data;
  const out = [];
  const types = arr(x.byType);
  if (types.length) out.push(table([{ label: 'Limit' }, { label: 'Windows', num: true }], types.map((t) => [esc(String(t.rateLimitType).replace(/_/g, ' ')), esc(int(t.windows))]), 'Rate-limit windows by type'));
  const hours = arr(x.episodeStartsByLocalHour);
  if (hours.length === 24 && hours.some((h) => num(h) > 0)) {
    out.push('<h4 class="soft">Episode starts by local hour</h4>' + columnChart({
      items: hours.map((h, i) => ({ label: hourText(i), value: num(h), title: hourText(i) + ': ' + int(h) + ' episodes' })),
      ariaLabel: 'Rate-limit episodes by local hour', labelEvery: 3, format: countTick,
    }));
  }
  const before = arr(x.valueBeforeWindows);
  if (before.length) {
    out.push('<h4 class="soft">Value in the 5 hours before each window</h4>' + barRows({ rows: before.map((b) => ({ label: b.model, value: dollars(b.valueNano), valueText: usd(b.valueNano) })), ariaLabel: 'Value before rate-limit windows by model' }));
  }
  out.push(note(int(x.synthetic429Lines) + ' rate-limit error lines (HTTP 429) written by the client, grouped into ' + int(x.episodes) + ' episodes with a 30-minute gap.'));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i07(s) {
  const x = res(s, 'i07').data;
  const sc = obj(x.statusCounts);
  const flagged = new Set(arr(x.flagged));
  const out = [stats([
    [int(x.toolCalls), 'tool calls'],
    [pct(x.failureRate), 'failed or exited non-zero'],
    [int(sc.shell_exit), 'non-zero exits (shell)'],
    [int(sc.failed), 'failed'],
    [int(sc.denied), 'denied'],
    [int(sc.unpaired), 'no result (interrupted)'],
  ])];
  const rows = arr(x.byTool).map((t) => [
    esc(t.name) + (t.displayName && t.displayName !== t.name ? ' <span class="soft">' + esc(t.displayName) + '</span>' : '') + (flagged.has(t.name) ? ' <span class="tag warn">flagged</span>' : ''),
    esc(int(t.calls)), esc(int(t.shellExit)), esc(int(t.failed)), esc(int(t.denied)), esc(int(t.unpaired)), esc(pct(t.failureRate)), esc(int(t.longestFailRun)),
  ]);
  if (rows.length) {
    const cols = [{ label: 'Tool' }, { label: 'Calls', num: true }, { label: 'Non-zero exits', num: true }, { label: 'Failed', num: true }, { label: 'Denied', num: true }, { label: 'No result', num: true }, { label: 'Failure rate', num: true }, { label: 'Longest failing run', num: true }];
    out.push(table(cols, rows.slice(0, 12), 'Tool reliability'));
    if (rows.length > 12) out.push(details('All ' + int(rows.length) + ' tools', table(cols, rows.slice(12), 'More tools')));
  }
  const cats = Object.entries(obj(x.errorCategories)).filter(([, v]) => num(v) > 0);
  if (cats.length) {
    out.push('<h4 class="soft">Why results failed</h4>' + barRows({ rows: cats.map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: num(v), valueText: int(v) })), ariaLabel: 'Failed results by category' }));
  }
  out.push(note('Non-zero exits include benign cases such as a search that finds nothing. You interrupted the agent ' + (num(x.interrupts) === 1 ? 'once' : int(x.interrupts) + ' times') + '.'));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i08(s) {
  const x = res(s, 'i08').data;
  const out = [stats([
    [int(x.maxEditsOneFile), 'edits to the most edited file'],
    [int(x.filesWithTenPlusEdits), 'files with 10 or more edits'],
    [int(x.distinctFiles), 'files written or edited'],
    [int(x.maxEditsOneFileOneBlock), 'most edits to one file in one work block'],
  ])];
  const top = arr(x.top);
  if (top.length) out.push(barRows({ rows: top.map((f) => ({ label: f.label, value: num(f.edits), valueText: int(f.edits) + ' edits' })), ariaLabel: 'Most edited files (folder and file name only)' }));
  out.push(note('Only the parent folder and file name are shown, never the full path.'));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i09(s) {
  const x = res(s, 'i09').data;
  const idle = num(s.idleMinutes) || 15;
  const out = [];
  const grid = arr(x.heatmap);
  if (grid.length === 7) out.push('<h4 class="soft">Prompts by weekday and local hour</h4>' + heatmap({ grid, ariaLabel: 'Prompts by weekday and hour', unit: 'prompts' }));
  out.push(stats([
    [hoursText(x.activeSeconds), 'active hours (' + idle + '-minute idle cutoff)'],
    [hoursText(x.agentSeconds), 'agent-hours (parallel agents counted separately)'],
    [int(x.workBlocks), 'work blocks'],
    [duration(x.longestBlockSeconds), 'longest work block'],
    [duration(x.medianBlockSeconds), 'median work block'],
    [int(x.prompts), 'prompts'],
    [int(x.activeDays), 'active days'],
    [int(x.longestStreakDays), 'longest streak (days)'],
    [typeof x.peakHourLocal === 'number' ? hourText(x.peakHourLocal) : 'n/a', 'peak hour'],
    [pct(x.nightPromptShare), 'prompts from 8 PM to 5 AM'],
    [pct(x.weekendDayShare), 'active days on weekends'],
  ]));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i10(s) {
  const x = res(s, 'i10').data;
  return receipt([['Launched', int(x.launched)], ['Started', int(x.started)], ['Finished with a result', int(x.result)], ['Failed', int(x.failed)], ['Failure rate', pct(x.failureRate)]], 'Workflow agent outcomes');
}

const SOURCE_TEXT = Object.freeze({ user_text: 'your message', tool_input: 'a tool input', tool_result_local: 'local tool output', tool_result_web: 'web page content' });
const SEVERITY_TEXT = Object.freeze({ critical: 'critical', likely_fixture: 'likely a test value', third_party_public: 'third-party, public' });

/** @param {any} s @returns {string} */
function i11(s) {
  const x = res(s, 'i11').data;
  const bs = obj(x.bySeverity);
  const all = arr(x.findings);
  const cols = [{ label: 'Type' }, { label: 'Fingerprint' }, { label: 'Copies', num: true }, { label: 'Files', num: true }, { label: 'Newest' }, { label: 'Found in' }, { label: 'Projects' }, { label: 'Rotate' }];
  const row = (/** @type {any} */ f) => {
    const info = secretTypeInfo(f.secretType);
    const sev = /** @type {any} */ (SEVERITY_TEXT)[f.severity] || String(f.severity);
    return [
      esc(info.label) + ' <span class="tag' + (f.severity === 'critical' ? ' crit' : '') + '">' + esc(sev) + '</span>' + (f.expired === true ? ' <span class="tag">expired</span>' : ''),
      '<span class="mono">' + esc(f.fingerprint12) + '</span>', esc(int(f.copies)), esc(int(f.files)), esc(f.newestLocalDate ? dateText(f.newestLocalDate) : 'n/a'),
      esc(/** @type {any} */ (SOURCE_TEXT)[f.source] || String(f.source)), esc(arr(f.projectLabels).join(', ')), esc(info.rotate),
    ];
  };
  const out = [stats([[int(bs.critical), 'critical'], [int(bs.likely_fixture), 'likely test values'], [int(bs.third_party_public), 'third-party, public']])];
  const crit = all.filter((f) => f.severity === 'critical');
  const rest = all.filter((f) => f.severity !== 'critical');
  if (crit.length) out.push(table(cols, crit.map(row), 'Critical secrets'));
  if (rest.length) out.push(details('Likely test values and public third-party keys (' + int(rest.length) + ')', table(cols, rest.map(row), 'Other secret findings')));
  out.push(note('Values are never shown, stored or exported. The fingerprint is the first 12 hex characters of the SHA-256 of the value, so you can match copies without seeing it. auditrail secrets --locations lists the session files, in the terminal only.'));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i11Headline(s) {
  const x = res(s, 'i11').data;
  const n = num(obj(x.bySeverity).critical);
  return n === 1 ? '1 secret that looks real sits in your transcripts in plain text.' : int(n) + ' secrets that look real sit in your transcripts in plain text.';
}

/** @param {any} s @param {{ retentionSeen?: boolean|null }} ctx @returns {string} */
function i12(s, ctx) {
  const x = res(s, 'i12').data;
  const out = [receipt([
    ['Earliest main-session event', x.earliestMainLocalDate ? dateText(x.earliestMainLocalDate) : 'n/a'],
    ['Earliest event in any file', x.earliestAnyLocalDate ? dateText(x.earliestAnyLocalDate) : 'n/a'],
    ['Latest event', x.latestLocalDate ? dateText(x.latestLocalDate) : 'n/a'],
    ['Days covered', int(x.coverageDays)],
    ['cleanupPeriodDays', typeof x.cleanupPeriodDays === 'number' ? int(x.cleanupPeriodDays) : 'unset, so the default of ' + CLAUDE_CODE_DEFAULT_RETENTION_DAYS + ' days applies'],
  ], 'History coverage')];
  if (typeof x.deletedHistoryDays === 'number' && x.deletedHistoryDays > 0) out.push(note(int(x.deletedHistoryDays) + ' days with activity in stats-cache.json are older than your oldest transcript: that history is already deleted.'));
  if (num(x.orphanDays) > 0) out.push(note(int(x.orphanDays) + ' days have subagent transcripts but no main-session transcript left.'));
  if (ctx.retentionSeen === false) out.push(note('This scan saw only the projects folder, not settings.json next to it, so your retention setting is unknown here. Drop the whole .claude folder to include it.'));
  return out.join('');
}

/** @param {any} s @returns {string} */
function i12Headline(s) {
  const x = res(s, 'i12').data;
  const range = x.earliestAnyLocalDate && x.latestLocalDate ? rangeText(x.earliestAnyLocalDate, x.latestLocalDate) : 'no dated events';
  return 'Your logs cover ' + range + ' (' + int(x.coverageDays) + ' days). ' +
    (typeof x.cleanupPeriodDays === 'number' ? 'cleanupPeriodDays is ' + int(x.cleanupPeriodDays) + '.' : 'Claude Code deletes transcripts after ' + CLAUDE_CODE_DEFAULT_RETENTION_DAYS + ' days by default.');
}

/** @param {any} s @returns {string} */
function i14(s) {
  const x = res(s, 'i14').data;
  const rows = /** @type {[string, string][]} */ ([
    ['Active days', int(x.activeDays)], ['Work blocks', int(x.workBlocks)], ['Prompts', int(x.prompts)], ['Interrupts', int(x.interrupts)],
    ['Files created', int(x.filesCreated)], ['Files edited', int(x.filesEdited)],
    [String(x.linesWrittenLabel || 'lines written by agent tool calls, not lines that survived'), int(x.linesWritten)],
  ]);
  for (const c of arr(x.commandIntents)) rows.push([String(c.intent).replace(/_/g, ' ') + ' commands', int(c.count) + (num(c.failures) ? ' (' + int(c.failures) + ' failed)' : '')]);
  const models = arr(x.models);
  if (models.length) rows.push(['Models', models.join(', ')]);
  rows.push(['API-equivalent value', usd(x.totalNano)]);
  return receipt(rows, 'Activity receipts') + note('auditrail export --md or --json writes these with their method notes.');
}

/** @param {any} s @returns {string} */
function audit(s) {
  const sc = obj(s.scan);
  const au = obj(s.audit);
  const dd = obj(au.dedup);
  const pricing = obj(s.pricing);
  const byClass = obj(sc.byClass);
  const out = [receipt([
    ['Scanned', isoText(sc.takenAt)],
    ['Files read', int(sc.filesRead)],
    ['Bytes read', bytesText(sc.bytes)],
    ['Lines', int(sc.lines)],
    ['Lines that did not parse', int(sc.parseErrors)],
    ['Unfinished last lines (live sessions)', int(sc.trailingPartial)],
    ['Log lines seen for responses', int(dd.observations)],
    ['Responses after dedup', int(dd.keys)],
    ['Client-side placeholder lines excluded', int(dd.syntheticLines)],
    ['Price table', 'as of ' + String(pricing.asOf || 'n/a') + (num(pricing.staleDays) ? ', ' + int(pricing.staleDays) + ' days old' : '')],
    ['Time zone', String(s.tz || 'UTC')],
  ], 'Scan receipt')];
  const classes = [['main', 'Main sessions'], ['subagent', 'Subagents'], ['workflow_agent', 'Workflow agents'], ['workflow_journal', 'Workflow journals']];
  out.push(table([{ label: 'File class' }, { label: 'Files', num: true }, { label: 'Lines', num: true }, { label: 'Bytes', num: true }],
    classes.map(([k, label]) => [esc(label), esc(int(obj(byClass[k]).files)), esc(int(obj(byClass[k]).lines)), esc(bytesText(obj(byClass[k]).bytes))]), 'Files by class'));
  if (pricing.source) out.push(note('Prices: ' + String(pricing.source)));
  out.push(note('One response is counted once however many log lines repeat it (by message id, then request id), keeping its most complete line. Value is tokens times list price per model in integer nanodollars. Active hours sum only the gaps of at most ' + (num(s.idleMinutes) || 15) + ' minutes between events.'));
  return out.join('');
}

/* ------------------------------------------------------------------------------------------
 * Whole-page markup
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} ReportContext
 * @property {boolean} shareSafe       the view Summary is the share-safe copy
 * @property {boolean} locked          the Summary itself is redacted; Share-safe cannot be turned off
 * @property {boolean} demo
 * @property {boolean} dropped         computed in this tab
 * @property {boolean|null} [retentionSeen]  drop mode: whether settings.json was part of the drop
 * @property {boolean} [canSave]       Blob downloads exist (false in tests)
 */

/**
 * Why each fix-list insight is not listed, when its "shown" rule is false.
 * @param {any} s
 * @param {string} id
 * @returns {string}
 */
export function clearReason(s, id) {
  const x = res(s, id).data;
  switch (id) {
    case 'i03': return 'Cache rewrites after breaks of over an hour are ' + pct(x.gt60mShareOfTotal) + ' of value (listed from 5%).';
    case 'i04': return 'Delegated work is ' + pct(x.delegationShare) + ' of value (listed from 5%).';
    case 'i05': return 'Opus and Fable subagent work is ' + pct(x.eligibleShareOfTotal) + ' of value (listed from 20%).';
    case 'i06': return 'No rate-limit windows and no 429 episodes.';
    case 'i08': return 'No file was edited 10 or more times (most: ' + int(x.maxEditsOneFile) + ').';
    case 'i10': return int(x.started) + ' workflow agents started (listed from 10).';
    case 'i11': return 'No secret that looks real. ' + int(obj(x.bySeverity).likely_fixture) + ' likely test values, ' + int(obj(x.bySeverity).third_party_public) + ' public third-party keys.';
    default: return 'Nothing to act on.';
  }
}

/**
 * The fix list (shown insights with an action) and the checked-and-clear list.
 * @param {any} s
 * @returns {string}
 */
function fixList(s) {
  const items = [];
  const clear = [];
  for (const id of FIX_IDS) {
    const r = res(s, id);
    const title = /** @type {any} */ (INSIGHT_META)[id].title;
    if (r.shown && r.action) items.push('<div class="todo"><b>' + (items.length + 1) + '</b><p><a href="#f-' + id + '">' + esc(title) + '</a>' + (r.evidence ? ' <span class="soft">(' + esc(evidenceText(r.evidence)) + ')</span>' : '') + '. ' + esc(r.action) + '</p></div>');
    else if (!r.shown) clear.push('<li><b>' + esc(title) + '</b><span>' + esc(clearReason(s, id)) + '</span></li>');
  }
  return '<section class="part" id="fix-list" aria-labelledby="h-fix-list"><h2 id="h-fix-list">Your fix list</h2>' +
    '<p class="intro">Each item carries its evidence and one change to make. Computed by arithmetic on your logs; no tokens spent.</p>' +
    (items.length ? '<div class="stack">' + items.join('') + '</div>' : '<p>Nothing on the fix list for this period.</p>') +
    (clear.length ? '<h3 class="soft">Checked and clear</h3><ul class="clear-list">' + clear.join('') + '</ul>' : '') + '</section>';
}

/**
 * The hero block: value, three token figures, coverage and scan receipt.
 * @param {any} s
 * @returns {string}
 */
function hero(s) {
  const x = res(s, 'i01').data;
  const t = obj(res(s, 'i02').data.tokens);
  const h = res(s, 'i12').data;
  const p = res(s, 'i09').data;
  const sc = obj(s.scan);
  const pricing = obj(s.pricing);
  const kicker = pricing.custom ? 'Value at your custom rates' : 'API-equivalent value at list prices as of ' + String(x.pricesAsOf || pricing.asOf || 'n/a');
  const coverage = (h.earliestAnyLocalDate && h.latestLocalDate ? rangeText(h.earliestAnyLocalDate, h.latestLocalDate) : 'No dated events') +
    ' | ' + int(p.activeDays) + ' active days | scanned ' + isoText(sc.takenAt) + ', ' + int(sc.filesRead) + (sc.filesRead === 1 ? ' file, ' : ' files, ') + bytesText(sc.bytes);
  return '<section class="hero" id="top" aria-label="Summary">' +
    '<div><p class="kicker">' + esc(kicker) + '</p><p class="value"><span class="visually-hidden">At least </span>' + esc(usd(x.totalNano)) + '</p>' +
    '<p class="label">' + esc(valueHeadline(s)) + ' <strong>' + esc(pct(x.pricedTokenShare)) + '</strong> of tokens priced; ' + esc(int(x.responses)) + ' responses.</p>' +
    '<p class="coverage">' + esc(coverage) + '</p></div>' +
    '<dl class="tokens3"><div><dt>Output tokens</dt><dd>' + esc(compact(t.output)) + '</dd></div><div><dt>Fresh input</dt><dd>' + esc(compact(t.freshInput)) + '</dd></div><div><dt>Cache reads</dt><dd>' + esc(compact(t.cacheRead)) + '</dd></div></dl>' +
    '</section>';
}

/**
 * Banners at the top of the report.
 * @param {any} s
 * @param {ReportContext} ctx
 * @returns {string}
 */
function banners(s, ctx) {
  const out = [];
  if (ctx.demo) out.push('<div class="banner demo" role="note"><p>' + esc(DEMO_BANNER) + '</p></div>');
  if (ctx.locked) {
    out.push('<div class="banner" role="note"><p>' + esc(REDACTED_BANNER) + '</p></div>');
  } else if (ctx.shareSafe) {
    out.push('<div class="banner" role="note"><p>' + esc(SHARE_SAFE_BANNER) + '</p>' + (ctx.canSave !== false ? '<button type="button" data-action="save-copy">Save share-safe copy</button>' : '') + '<button type="button" data-action="share-safe">Show names again</button></div>');
  } else {
    out.push('<div class="banner" role="note" id="ar-share-banner"><p><strong>Before you share this file.</strong> ' + esc(SHARE_BANNER).replace('(or --redact)', '<span class="nowrap">(or --redact)</span>') + '</p><button type="button" data-action="share-safe">Turn on Share-safe mode</button></div>');
  }
  if (ctx.dropped) out.push('<div class="banner" role="note"><p>' + esc(DROPPED_BANNER) + '</p>' + (ctx.canSave !== false ? '<button type="button" data-action="save-copy">' + (ctx.shareSafe ? 'Save share-safe copy' : 'Save report') + '</button>' : '') + '</div>');
  const h = res(s, 'i12');
  if (h.data.topOfReport === true || (num(h.data.coverageDays) > 0 && num(h.data.coverageDays) < 60)) {
    out.push('<div class="banner risk" role="note"><p><strong>History at risk.</strong> ' + esc(i12Headline(s)) + ' <a href="#f-i12">What to do</a></p></div>');
  }
  const stale = num(obj(s.pricing).staleDays);
  if (stale > PRICE_TABLE_STALE_DAYS) out.push('<div class="banner risk" role="note"><p>The bundled price table is ' + esc(int(stale)) + ' days old. List prices may have changed; update auditrail for a newer table.</p></div>');
  return '<div class="wrap">' + out.join('') + '</div>';
}

/**
 * The share card section: canvas, controls, manifest and alt text. Filled by the controller.
 * @param {{ hide: Set<string>, include: Set<string>, size: string, theme: string }} card
 * @returns {string}
 */
function cardSection(card) {
  const seg = (/** @type {string} */ key, /** @type {[string, string][]} */ opts, /** @type {string} */ cur) => '<div class="seg" role="group">' +
    opts.map(([v, label]) => '<button type="button" data-action="card-' + key + '" data-value="' + esc(v) + '" aria-pressed="' + (v === cur ? 'true' : 'false') + '">' + esc(label) + '</button>').join('') + '</div>';
  const checks = Object.keys(CARD_HIDE_KEYS).map((k) => '<label><input type="checkbox" data-action="card-hide" data-value="' + esc(k) + '"' + (card.hide.has(k) ? '' : ' checked') + '> ' + esc(/** @type {any} */ (HIDE_LABELS)[k] || k) + '</label>').join('');
  const L = CARD_SIZES.landscape;
  const P = CARD_SIZES.portrait;
  return '<section class="part" id="card" aria-labelledby="h-card"><h2 id="h-card">Share card</h2>' +
    '<p class="intro">Drawn on this page from an allowlist of numbers only: no project, file, path, prompt, tool or server name can reach it. The manifest lists every field it contains.</p>' +
    '<div class="card-grid"><div class="card-stage"><canvas id="ar-card-canvas" width="' + L.width + '" height="' + L.height + '" role="img" aria-label="Share card preview"></canvas>' +
    '<p class="soft" id="ar-card-status" role="status" aria-live="polite"></p></div>' +
    '<div class="card-controls">' +
    '<fieldset><legend>Size</legend>' + seg('size', [['landscape', 'Landscape ' + L.width + ' x ' + L.height], ['portrait', 'Portrait ' + P.width + ' x ' + P.height]], card.size) + '</fieldset>' +
    '<fieldset><legend>Theme</legend>' + seg('theme', [['dark', 'Dark'], ['light', 'Light']], card.theme) + '</fieldset>' +
    '<fieldset><legend>Stats on the card</legend><div class="checks">' + checks + '</div>' +
    '<p class="checks"><label><input type="checkbox" data-action="card-include" data-value="rate-limits"' + (card.include.has('rate-limits') ? ' checked' : '') + '> Rate-limit windows (off by default)</label></p></fieldset>' +
    '<p><button type="button" class="primary" data-action="save-card" id="ar-save-card">Save card as PNG</button></p>' +
    '<div class="manifest"><h3>Manifest: everything on the card</h3><div class="table-wrap"><table id="ar-manifest"><tbody></tbody></table></div></div>' +
    '<div><label for="ar-alt" class="soft">Alt text for the post</label><textarea id="ar-alt" rows="5" readonly></textarea>' +
    '<p><button type="button" data-action="copy-alt">Copy alt text</button></p></div>' +
    '</div></div></section>';
}

/**
 * The full report markup for #ar-root.
 * @param {any} s  the Summary to show (already share-safe when ctx.shareSafe)
 * @param {ReportContext} ctx
 * @param {{ hide: Set<string>, include: Set<string>, size: string, theme: string }} [card]
 * @returns {string}
 */
export function reportHtml(s, ctx, card = { hide: new Set(), include: new Set(), size: 'landscape', theme: 'dark' }) {
  const shown = (/** @type {string} */ id) => res(s, id).shown;
  const top = '<header class="topbar"><div class="wrap"><span class="wordmark">AUDITRAIL</span>' +
    '<nav class="topnav" aria-label="Sections">' +
    [['#fix-list', 'Fix list'], ['#value', 'Value'], ['#money', 'Money map'], ['#fixes', 'Tools'], ['#patterns', 'Patterns'], ['#safety', 'Secrets'], ['#card', 'Card'], ['#receipts', 'Receipts']]
      .map(([h, l]) => '<a href="' + h + '">' + esc(l) + '</a>').join('') + '</nav>' +
    '<div class="tools">' +
    '<button type="button" data-action="share-safe" aria-pressed="' + (ctx.shareSafe ? 'true' : 'false') + '"' + (ctx.locked ? ' disabled' : '') + '>Share-safe mode</button>' +
    (ctx.canSave !== false ? '<button type="button" data-action="save-copy">' + (ctx.shareSafe ? 'Save share-safe copy' : 'Save a copy') + '</button>' : '') +
    (ctx.dropped ? '<button type="button" data-action="rescan">Scan another folder</button>' : '') +
    '</div></div></header>';

  /** @type {Record<string, string[]>} */
  const partBodies = { value: [], money: [], fixes: [], patterns: [], safety: [] };
  partBodies.value.push(finding(s, 'i01', valueHeadline(s), i01(s)));
  const i13d = res(s, 'i13').data;
  partBodies.value.push(finding(s, 'i13', i13d.topModel ? 'Most of the value ran on ' + (i13d.topModel.displayName || i13d.topModel.model) + '.' : 'No priced model yet.', i13(s)));
  const b = res(s, 'i02').data;
  partBodies.money.push(finding(s, 'i02', 'Cache reads are ' + pct(obj(b.bucketShares).cacheRead) + ' of the value and output is ' + pct(obj(b.bucketShares).output) + '. Cache hit rate ' + pct(b.cacheHitRate) + '.', i02(s)));
  if (shown('i03')) partBodies.money.push(finding(s, 'i03', i03Headline(s), i03(s)));
  if (shown('i04')) {
    const x = res(s, 'i04').data;
    partBodies.money.push(finding(s, 'i04', pct(x.delegationShare) + ' of the value was delegated to subagents and workflow agents, over ' + int(x.agentRuns) + ' agent runs.', i04(s)));
  }
  if (shown('i05')) {
    const x = res(s, 'i05').data;
    partBodies.money.push(finding(s, 'i05', 'The same subagent tokens would be worth ' + usd(x.atSonnet5Nano) + ' at Sonnet 5 list prices instead of ' + usd(x.eligibleNano) + '.', i05(s)));
  }
  if (shown('i06')) {
    const x = res(s, 'i06').data;
    partBodies.fixes.push(finding(s, 'i06', int(x.windows) + ' rate-limit windows hit, ' + int(x.episodes) + ' episodes of rate-limit errors.', i06(s)));
  }
  const t7 = res(s, 'i07').data;
  partBodies.fixes.push(finding(s, 'i07', int(t7.toolCalls) + ' tool calls; ' + pct(t7.failureRate) + ' of paired results failed or exited non-zero.', i07(s)));
  if (shown('i08')) {
    const x = res(s, 'i08').data;
    partBodies.fixes.push(finding(s, 'i08', 'One file was edited ' + int(x.maxEditsOneFile) + ' times; ' + int(x.filesWithTenPlusEdits) + ' files had 10 or more edits.', i08(s)));
  }
  if (shown('i10')) {
    const x = res(s, 'i10').data;
    partBodies.fixes.push(finding(s, 'i10', int(x.failed) + ' of ' + int(x.started) + ' workflow agents failed (' + pct(x.failureRate) + ').', i10(s)));
  }
  const p9 = res(s, 'i09').data;
  partBodies.patterns.push(finding(s, 'i09', hoursText(p9.activeSeconds) + ' active over ' + int(p9.activeDays) + ' active days; longest streak ' + int(p9.longestStreakDays) + ' days' + (typeof p9.peakHourLocal === 'number' ? ', busiest at ' + hourText(p9.peakHourLocal) : '') + '.', i09(s)));
  partBodies.patterns.push(finding(s, 'i14', 'Receipts you can cite, each with its method.', i14(s)));
  partBodies.safety.push(finding(s, 'i11', shown('i11') ? i11Headline(s) : 'No secret that looks real was found in the scanned transcripts.', i11(s)));
  partBodies.safety.push(finding(s, 'i12', i12Headline(s), i12(s, ctx)));

  const parts = PARTS.map((p) => '<section class="part" id="' + p.id + '" aria-labelledby="h-' + p.id + '"><h2 id="h-' + p.id + '">' + esc(p.title) + '</h2><p class="intro">' + esc(p.intro) + '</p>' + partBodies[p.id].join('') + '</section>').join('');
  const receipts = '<section class="part" id="receipts" aria-labelledby="h-receipts"><h2 id="h-receipts">Scan receipts</h2><p class="intro">What was read and how the numbers were counted, so every figure above can be reproduced.</p>' + audit(s) + '</section>';

  return top + banners(s, ctx) + '<main class="wrap" id="ar-main-content">' + hero(s) + fixList(s) + parts + cardSection(card) + receipts + '</main>';
}

/**
 * The drop-mode markup for #ar-root.
 * @param {{ os: 'windows'|'mac'|'linux', canPick: boolean, hasDemo: boolean, error?: string|null }} o
 * @returns {string}
 */
export function dropHtml(o) {
  const tabs = /** @type {('windows'|'mac'|'linux')[]} */ (['windows', 'mac', 'linux']);
  const help = OS_HELP[o.os];
  return '<header class="topbar"><div class="wrap"><span class="wordmark">AUDITRAIL</span></div></header>' +
    '<main class="wrap" id="ar-main-content">' +
    '<section class="drop-hero"><h1>Your coding agent\'s year, computed on this page.</h1>' +
    '<p>Drop your Claude Code projects folder. Everything runs in this tab: the page has no network permission (its Content Security Policy blocks every connection), so nothing is uploaded anywhere.</p></section>' +
    '<section class="dropzone" id="ar-dropzone" aria-labelledby="h-drop"><h2 id="h-drop">Drop the projects folder here</h2>' +
    '<p class="soft">Or drop the whole .claude folder: then your retention setting is included too.</p>' +
    '<div class="actions">' +
    (o.canPick ? '<button type="button" class="primary" data-action="pick-dir">Choose the projects folder</button>' : '') +
    '<button type="button"' + (o.canPick ? '' : ' class="primary"') + ' data-action="pick-input">Select the folder with the file picker</button>' +
    '<input type="file" id="ar-dir-input" webkitdirectory multiple hidden>' +
    (o.hasDemo ? '<button type="button" data-action="demo">See the demo (synthetic data)</button>' : '') +
    '</div><p class="fine">' + esc(UPLOAD_NOTE) + '</p></section>' +
    '<div class="progress" id="ar-progress" hidden><div class="track" aria-hidden="true"><div class="fill" id="ar-progress-fill"></div></div><p id="ar-progress-text" role="status" aria-live="polite"></p></div>' +
    '<div id="ar-drop-error" role="alert"' + (o.error ? '' : ' hidden') + '>' + (o.error ? '<p class="error-box">' + esc(o.error) + '</p>' : '') + '</div>' +
    '<section class="oshelp" aria-labelledby="h-oshelp"><h2 id="h-oshelp">Where is the folder? It is hidden.</h2>' +
    '<div class="seg" role="group" aria-label="Operating system">' + tabs.map((t) => '<button type="button" data-action="os" data-value="' + t + '" aria-pressed="' + (t === o.os ? 'true' : 'false') + '">' + esc(OS_HELP[t].label) + '</button>').join('') + '</div>' +
    '<div class="pane panel"><ol>' + help.steps.map((st) => '<li>' + esc(st) + '</li>').join('') + '</ol>' +
    '<p>Path: <code id="ar-os-path">' + esc(help.path) + '</code> <button type="button" data-action="copy-path">Copy path</button></p>' +
    '<p class="note">The logs live in the projects folder inside .claude. If you set CLAUDE_CONFIG_DIR, use the projects folder inside that folder instead. Only .jsonl files under projects are read.</p></div></section>' +
    '</main>';
}

/**
 * Progress text: bytes read over total bytes.
 * @param {{ bytesDone: number, totalBytes: number, filesDone: number, totalFiles: number }} p
 * @returns {string}
 */
export function progressText(p) {
  return 'Read ' + bytesText(p.bytesDone) + ' of ' + bytesText(p.totalBytes) + ' (' + int(p.filesDone) + ' of ' + int(p.totalFiles) + ' files).';
}

/* ------------------------------------------------------------------------------------------
 * Browser controller
 * ---------------------------------------------------------------------------------------- */

/** @param {string} id @returns {any} */
function $(id) { return document.getElementById(id); }

/** @type {any} */
const state = {
  mode: 'boot',            // 'drop' | 'scanning' | 'report' | 'error'
  original: null,          // the Summary as embedded or computed
  view: null,              // what is rendered (share-safe copy when shareSafe)
  shareSafe: false,
  locked: false,
  demo: false,
  dropped: false,
  retentionSeen: null,
  demoSummary: null,
  os: 'linux',
  worker: null,
  card: { size: 'landscape', theme: 'dark', hide: new Set(), include: new Set() },
  raster: null,
  cardTimer: 0,
};

/** Start the page. */
function boot() {
  const root = $('ar-root');
  if (!root) return;
  let data;
  let demo = null;
  try { data = parseDataBlock($('ar-data') ? $('ar-data').textContent : 'null'); } catch { data = undefined; }
  try { demo = parseDataBlock($('ar-demo') ? $('ar-demo').textContent : 'null'); } catch { demo = null; }
  const nav = /** @type {any} */ (navigator);
  state.os = detectOs((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent);
  state.demoSummary = isSummary(demo) ? demo : null;

  // A file dropped outside the drop zone must never navigate away from the page.
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => { e.preventDefault(); });
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);

  if (isSummary(data)) {
    showReport(data, { demo: demo !== null && demo !== false && !isSummary(demo), dropped: false });
  } else if (data === null) {
    showDrop(null);
  } else {
    showFatal(data && typeof data === 'object' && typeof data.schema === 'number' && data.schema > 1
      ? 'This report was written by a newer version of auditrail. Open it with that version.'
      : 'The data embedded in this page could not be read. Run auditrail again to write a fresh report.');
  }
}

/** @param {string} message */
function showFatal(message) {
  state.mode = 'error';
  mount('<main class="wrap"><p class="error-box" role="alert">' + esc(message) + '</p></main>');
}

/** @param {string} html */
function mount(html) {
  const root = $('ar-root');
  root.innerHTML = html;
  root.hidden = false;
  const bootEl = $('ar-boot');
  if (bootEl) bootEl.hidden = true;
}

/**
 * @param {any} summary
 * @param {{ demo: boolean, dropped: boolean, retentionSeen?: boolean|null }} o
 */
function showReport(summary, o) {
  state.mode = 'report';
  state.original = summary;
  state.locked = summary.redacted === true;
  state.shareSafe = state.locked;
  state.demo = o.demo;
  state.dropped = o.dropped;
  state.retentionSeen = o.retentionSeen ?? null;
  state.view = summary;
  renderReportView();
  window.scrollTo(0, 0);
}

function renderReportView() {
  const ctx = { shareSafe: state.shareSafe, locked: state.locked, demo: state.demo, dropped: state.dropped, retentionSeen: state.retentionSeen, canSave: true };
  mount(reportHtml(state.view, ctx, state.card));
  scheduleCard();
}

function toggleShareSafe() {
  if (state.locked || !state.original) return;
  const y = window.scrollY;
  state.shareSafe = !state.shareSafe;
  state.view = state.shareSafe ? shareSafeSummary(state.original) : state.original;
  renderReportView();
  window.scrollTo(0, y);
  const btn = document.querySelector('.topbar [data-action="share-safe"]');
  if (btn) /** @type {HTMLElement} */ (btn).focus();
}

/** @param {string|null} error */
function showDrop(error) {
  state.mode = 'drop';
  state.original = null;
  state.view = null;
  const canPick = typeof (/** @type {any} */ (window)).showDirectoryPicker === 'function';
  mount(dropHtml({ os: state.os, canPick, hasDemo: !!state.demoSummary, error }));
  const zone = $('ar-dropzone');
  zone.addEventListener('dragenter', (/** @type {DragEvent} */ e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragover', (/** @type {DragEvent} */ e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; zone.classList.add('over'); });
  zone.addEventListener('dragleave', (/** @type {DragEvent} */ e) => { if (!zone.contains(/** @type {Node} */ (e.relatedTarget))) zone.classList.remove('over'); });
  zone.addEventListener('drop', onDrop);
}

/** @param {DragEvent} e */
async function onDrop(e) {
  e.preventDefault();
  const zone = $('ar-dropzone');
  if (zone) zone.classList.remove('over');
  if (state.mode !== 'drop' || !e.dataTransfer) return;
  const entries = [];
  for (const item of Array.from(e.dataTransfer.items || [])) {
    const entry = item.kind === 'file' && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  if (!entries.length) { dropError('Drop a folder, not a file. The projects folder is inside the hidden .claude folder.'); return; }
  setBusy('Listing the folder...');
  try {
    const out = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    startScan(out);
  } catch {
    dropError('The browser could not list that folder. Try the button instead.');
  }
}

/**
 * Walk a dropped FileSystemEntry (webkitGetAsEntry).
 * @param {any} entry
 * @param {string} prefix
 * @param {{ path: string, file: File|null }[]} out
 */
async function walkEntry(entry, prefix, out) {
  const p = prefix + entry.name;
  if (entry.isFile) {
    const file = wanted(entry.name) ? await new Promise((resolve, reject) => entry.file(resolve, reject)) : null;
    out.push({ path: p, file: /** @type {File|null} */ (file) });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch || !batch.length) break;
    for (const child of batch) await walkEntry(child, p + '/', out);
  }
}

/**
 * Walk a FileSystemDirectoryHandle (showDirectoryPicker).
 * @param {any} dir
 * @param {string} prefix
 * @param {{ path: string, file: File|null }[]} out
 */
async function walkHandle(dir, prefix, out) {
  for await (const [name, child] of dir.entries()) {
    if (child.kind === 'file') out.push({ path: prefix + name, file: wanted(name) ? await child.getFile() : null });
    else if (child.kind === 'directory') await walkHandle(child, prefix + name + '/', out);
  }
}

/** Same rule as worker.js wantedName: only names that can matter get their File handed over. */
function wanted(/** @type {string} */ name) {
  return name.includes('.jsonl') || name === 'settings.json' || name === 'settings.local.json' || name === 'stats-cache.json';
}

async function pickDirectory() {
  const w = /** @type {any} */ (window);
  let dir;
  try {
    dir = await w.showDirectoryPicker({ id: 'auditrail-projects', mode: 'read' });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    pickInput();
    return;
  }
  setBusy('Listing the folder...');
  try {
    const out = [];
    await walkHandle(dir, dir.name + '/', out);
    startScan(out);
  } catch {
    dropError('The browser could not list that folder. Try dragging it onto the page instead.');
  }
}

function pickInput() {
  const input = $('ar-dir-input');
  if (input) input.click();
}

/** @param {Event} e */
function onChange(e) {
  const t = /** @type {any} */ (e.target);
  if (!t) return;
  if (t.id === 'ar-dir-input') {
    const files = Array.from(/** @type {FileList} */ (t.files || []));
    if (!files.length) return;
    startScan(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: wanted(f.name) ? f : null })));
    t.value = '';
    return;
  }
  const action = t.getAttribute('data-action');
  if (action === 'card-hide') {
    const k = t.getAttribute('data-value');
    if (t.checked) state.card.hide.delete(k); else state.card.hide.add(k);
    scheduleCard();
  } else if (action === 'card-include') {
    const k = t.getAttribute('data-value');
    if (t.checked) state.card.include.add(k); else state.card.include.delete(k);
    scheduleCard();
  }
}

/** @param {string} text */
function setBusy(text) {
  for (const b of document.querySelectorAll('#ar-dropzone button')) /** @type {HTMLButtonElement} */ (b).disabled = true;
  const pr = $('ar-progress');
  if (pr) pr.hidden = false;
  const pt = $('ar-progress-text');
  if (pt) pt.textContent = text;
  const err = $('ar-drop-error');
  if (err) err.hidden = true;
}

/** @param {string} message */
function dropError(message) {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.mode = 'drop';
  for (const b of document.querySelectorAll('#ar-dropzone button')) /** @type {HTMLButtonElement} */ (b).disabled = false;
  const pr = $('ar-progress');
  if (pr) pr.hidden = true;
  const err = $('ar-drop-error');
  if (err) { err.innerHTML = '<p class="error-box">' + esc(message) + '</p>'; err.hidden = false; }
}

/** @param {{ path: string, file: File|null }[]} entries */
function startScan(entries) {
  const src = $('ar-worker') ? String($('ar-worker').textContent || '') : '';
  if (!src.trim() || src.trim().startsWith('/*')) { dropError('This copy of the page has no scanner built in. Run npm run build, or use the auditrail command.'); return; }
  if (!entries.some((x) => x.file)) { dropError('No Claude Code logs (.jsonl files) in that folder. Choose the projects folder inside .claude.'); return; }
  state.mode = 'scanning';
  setBusy('Starting the scanner...');
  let url = '';
  let worker;
  try {
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
  } catch {
    if (url) URL.revokeObjectURL(url);
    dropError('This browser would not start the in-page scanner. Use the auditrail command instead: npx auditrail');
    return;
  }
  state.worker = worker;
  const cleanup = () => { worker.terminate(); if (state.worker === worker) state.worker = null; URL.revokeObjectURL(url); };
  worker.onmessage = (/** @type {MessageEvent} */ ev) => {
    const m = ev.data || {};
    if (m.type === 'progress') {
      const fill = $('ar-progress-fill');
      if (fill) fill.style.width = (m.totalBytes > 0 ? Math.min(100, (m.bytesDone / m.totalBytes) * 100) : 0).toFixed(1) + '%';
      const pt = $('ar-progress-text');
      if (pt) pt.textContent = progressText(m);
    } else if (m.type === 'done') {
      cleanup();
      if (!isSummary(m.summary)) { dropError('The scanner returned no report.'); return; }
      showReport(m.summary, { demo: false, dropped: true, retentionSeen: m.receipt ? m.receipt.retentionSeen === true : null });
      const h = document.querySelector('#ar-main-content .hero');
      if (h) { /** @type {HTMLElement} */ (h).setAttribute('tabindex', '-1'); /** @type {HTMLElement} */ (h).focus(); }
    } else if (m.type === 'error') {
      cleanup();
      dropError('The scan stopped: ' + String(m.message || 'unknown error'));
    }
  };
  worker.onerror = (/** @type {ErrorEvent} */ ev) => {
    ev.preventDefault();
    cleanup();
    dropError('The in-page scanner failed to start or crashed. Use the auditrail command instead: npx auditrail');
  };
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  worker.postMessage({ type: 'scan', entries, tz, idleMinutes: 15, nowMs: Date.now() });
}

/** @param {MouseEvent} e */
function onClick(e) {
  const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'));
  if (!el || el.tagName === 'INPUT') return;
  const action = el.getAttribute('data-action');
  const value = el.getAttribute('data-value') || '';
  switch (action) {
    case 'share-safe': toggleShareSafe(); break;
    case 'save-copy': saveCopy(); break;
    case 'save-card': saveCard(); break;
    case 'copy-alt': copyText(/** @type {HTMLTextAreaElement} */ ($('ar-alt')).value, el); break;
    case 'copy-path': copyText(OS_HELP[/** @type {'windows'} */ (state.os)].path, el); break;
    case 'rescan': showDrop(null); window.scrollTo(0, 0); break;
    case 'demo': if (state.demoSummary) showReport(state.demoSummary, { demo: true, dropped: false }); break;
    case 'pick-dir': pickDirectory(); break;
    case 'pick-input': pickInput(); break;
    case 'os':
      if (value === 'windows' || value === 'mac' || value === 'linux') {
        state.os = value;
        const err = $('ar-drop-error');
        showDrop(err && !err.hidden ? err.textContent : null);
        const b = document.querySelector('[data-action="os"][data-value="' + value + '"]');
        if (b) /** @type {HTMLElement} */ (b).focus();
      }
      break;
    case 'card-size':
      if (value === 'landscape' || value === 'portrait') { state.card.size = value; pressOne('card-size', value); scheduleCard(); }
      break;
    case 'card-theme':
      if (value === 'dark' || value === 'light') { state.card.theme = value; pressOne('card-theme', value); scheduleCard(); }
      break;
    default: break;
  }
}

/** @param {string} action @param {string} value */
function pressOne(action, value) {
  for (const b of document.querySelectorAll('[data-action="' + action + '"]')) b.setAttribute('aria-pressed', b.getAttribute('data-value') === value ? 'true' : 'false');
}

/**
 * @param {string} text
 * @param {HTMLElement} btn
 */
function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1500); };
  const clip = /** @type {any} */ (navigator).clipboard;
  if (clip && typeof clip.writeText === 'function') {
    clip.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

/** @param {string} text @param {() => void} done */
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'visually-hidden';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) done();
}

/* ---- the share card ---------------------------------------------------------------------- */

function scheduleCard() {
  clearTimeout(state.cardTimer);
  const status = $('ar-card-status');
  if (status) status.textContent = 'Drawing the card...';
  state.cardTimer = setTimeout(drawCard, 30);
}

function drawCard() {
  const canvas = /** @type {HTMLCanvasElement|null} */ ($('ar-card-canvas'));
  const status = $('ar-card-status');
  const save = /** @type {HTMLButtonElement|null} */ ($('ar-save-card'));
  if (!canvas || !state.view) return;
  try {
    const ps = toPublicSummary(state.view, { hide: [...state.card.hide], include: [...state.card.include], priceTable: getPriceTable() });
    const img = renderCard({ ps, size: state.card.size, theme: state.card.theme });
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas');
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    state.raster = img;
    const alt = altText(ps);
    canvas.setAttribute('aria-label', alt);
    const tbody = document.querySelector('#ar-manifest tbody');
    if (tbody) tbody.innerHTML = buildManifest(ps).map((m) => '<tr><td>' + esc(m.label) + '</td><td>' + esc(m.text) + '</td></tr>').join('');
    const ta = /** @type {HTMLTextAreaElement|null} */ ($('ar-alt'));
    if (ta) ta.value = alt;
    if (status) status.textContent = img.width + ' x ' + img.height + ' px PNG. Nothing on it comes from a label, a path or a prompt.';
    if (save) save.disabled = false;
  } catch (e) {
    state.raster = null;
    if (save) save.disabled = true;
    if (status) status.textContent = 'The card could not be drawn here (' + (e instanceof Error ? e.name : 'error') + '). The auditrail card command draws the same card.';
  }
}

function saveCard() {
  const canvas = /** @type {HTMLCanvasElement|null} */ ($('ar-card-canvas'));
  if (!canvas || !state.raster) return;
  const name = 'auditrail-card-' + state.card.size + '-' + state.card.theme + '.png';
  canvas.toBlob((blob) => { if (blob) download(blob, name); }, 'image/png');
}

/* ---- saving a copy of the page ----------------------------------------------------------- */

/**
 * This page as HTML with another Summary embedded. The scripts are copied byte for byte, so the
 * CSP hash in the copy still matches; the rendered report is removed so only the data travels.
 * @param {any} summary
 * @returns {string}
 */
function pageWith(summary) {
  const root = /** @type {HTMLElement} */ (document.documentElement.cloneNode(true));
  root.removeAttribute('data-theme');
  const r = root.querySelector('#ar-root');
  if (r) { r.textContent = ''; r.setAttribute('hidden', ''); }
  const b = root.querySelector('#ar-boot');
  if (b) b.removeAttribute('hidden');
  const data = root.querySelector('#ar-data');
  if (data) data.textContent = embedJson(summary);
  if (!state.demo) { const demo = root.querySelector('#ar-demo'); if (demo) demo.textContent = 'null'; }
  for (const extra of root.querySelectorAll('body > textarea, body > a[download]')) extra.remove();
  return '<!doctype html>\n' + root.outerHTML;
}

function saveCopy() {
  if (!state.original) return;
  const safe = state.shareSafe || state.locked;
  const summary = safe ? (state.locked ? state.original : shareSafeSummary(state.original)) : state.original;
  const stamp = String(summary.generatedAt || '').slice(0, 10) || 'report';
  download(new Blob([pageWith(summary)], { type: 'text/html' }), 'auditrail-' + stamp + (safe ? '-share-safe' : '') + '.html');
}

/**
 * Start a download of a blob the page made (user click only; nothing is sent anywhere).
 * @param {Blob} blob
 * @param {string} name
 */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
