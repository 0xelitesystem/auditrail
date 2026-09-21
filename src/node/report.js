// The self-contained HTML report (DESIGN 8.8, traps 51, 58).
//
// - The Summary is embedded in ONE <script type="application/json" id="ar-data"> element, built
//   with JSON.stringify and then `<`, `>`, `&`, U+2028 and U+2029 replaced by \u escapes, so the
//   data can never close the script element or start markup (trap 51).
// - A meta Content-Security-Policy is written into the page: no network (connect-src 'none'),
//   no remote anything (default-src 'none'), and scripts only by the SHA-256 of the exact inline
//   script text found in the template.
// - The page states that it contains project and file names, and links to the repo and
//   elitesystem.ai with plain anchors (user-click navigation only; nothing is fetched).
//
// Template source, first match wins:
// 1. EMBEDDED_TEMPLATE, filled in by the build (scripts/build.mjs replaces the marker below with
//    a function that unpacks the fully inlined template, so it is unpacked only when needed).
// 2. In a source checkout, the same page built on the fly from src/web (dev-template.js,
//    original names kept). The raw src/web/template.html is never served: its app script is
//    still a build placeholder, so the page would only show its "unbuilt template" notice. The
//    build replaces the dev-template import with a stub, so the bundle never carries the build
//    script.
// 3. The built-in static report below: no script at all (script-src 'none'), numbers only.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { formatUsd, ratio } from '../core/money.js';
import { REPO_DISPLAY } from '../core/constants.js';
import { INSIGHT_IDS, INSIGHT_META } from '../core/insights/contract.js';
import { devReportTemplate } from './dev-template.js';

/* The build replaces the next marker (comment plus null) with a function returning the page. */
const EMBEDDED_TEMPLATE = /* @ar-build:report-template */ null;

/** Exact banner copy (DESIGN 8.8). */
export const REPORT_BANNER = 'This report contains project and file names. Share the card, or use Share-safe mode (or --redact) before sending this file to anyone.';

/** Banner used when the Summary was built with --redact. */
export const REPORT_BANNER_REDACTED = 'Share-safe mode: project and file names in this report are replaced with Project A, Project B and so on.';

/** Footer anchors (the only URLs in the report; allowlisted by the static network scan). */
export const FOOTER_LINKS = Object.freeze([
  Object.freeze({ href: 'https://' + REPO_DISPLAY, text: REPO_DISPLAY }),
  Object.freeze({ href: 'https://elitesystem.ai', text: 'elitesystem.ai' }),
]);

/**
 * Make JSON text safe inside an HTML <script> element (trap 51).
 * @param {string} json output of JSON.stringify
 * @returns {string}
 */
export function escapeJsonForHtml(json) {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @param {unknown} summary
 * @returns {string}
 */
export function serializeForHtml(summary) {
  return escapeJsonForHtml(JSON.stringify(summary));
}

/**
 * HTML text escape for the static fallback report.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * The CSP (DESIGN 8.8). With no inline script the policy is script-src 'none'.
 * @param {string[]} scriptHashes base64 SHA-256 digests of the inline scripts
 * @returns {string}
 */
export function buildCsp(scriptHashes) {
  const scriptSrc = scriptHashes.length ? scriptHashes.map((h) => "'sha256-" + h + "'").join(' ') : "'none'";
  return [
    "default-src 'none'",
    'script-src ' + scriptSrc,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'worker-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Base64 SHA-256 of every EXECUTABLE inline script (no type, or a JavaScript or module type).
 * Data blocks (application/json) and worker source blocks with another type are not executed
 * by the page, so they need no hash.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const t = type ? type[1].toLowerCase() : '';
    if (t && t !== 'module' && t !== 'text/javascript' && t !== 'application/javascript') continue;
    out.push(createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return [...new Set(out)];
}

const DATA_RE = /(<script\b[^>]*\bid\s*=\s*["']ar-data["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;

/**
 * Put the Summary and the CSP into a template.
 * @param {string} template
 * @param {unknown} summary
 * @returns {string}
 */
export function injectReport(template, summary) {
  const data = serializeForHtml(summary);
  let html;
  if (DATA_RE.test(template)) {
    html = template.replace(DATA_RE, (_m, open, _old, close) => open + data + close);
  } else {
    const block = '<script type="application/json" id="ar-data">' + data + '</script>';
    html = /<\/body>/i.test(template) ? template.replace(/<\/body>/i, () => block + '\n</body>') : template + block;
  }
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + escapeHtml(buildCsp(inlineScriptHashes(html))) + '">';
  if (CSP_META_RE.test(html)) return html.replace(CSP_META_RE, () => meta);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (h) => h + '\n' + meta);
  return meta + html;
}

/**
 * The template to use, or null for the built-in static report.
 * @param {{ devTemplate?: () => string|null }} [io] devTemplate replaces dev-template.js (tests)
 * @returns {string|null}
 */
export function loadTemplate(io = {}) {
  const packed = /** @type {null|(() => string)} */ (EMBEDDED_TEMPLATE);
  const embedded = typeof packed === 'function' ? packed() : null;
  if (typeof embedded === 'string' && embedded.length) return embedded;
  const t = (io.devTemplate ?? devReportTemplate)();
  // A page that still carries a build placeholder would not run its app: never serve one.
  return typeof t === 'string' && t.length > 0 && !t.includes('%%AR_') ? t : null;
}

/**
 * Full report HTML for a Summary.
 * @param {any} summary
 * @param {{ template?: string|null }} [o]
 * @returns {string}
 */
export function renderReport(summary, o = {}) {
  const template = o.template === undefined ? loadTemplate() : o.template;
  return injectReport(template ?? staticReportTemplate(summary), summary);
}

/**
 * Default report file (DESIGN 8.2): ~/.auditrail/reports/auditrail-YYYY-MM-DD-HHMM.html
 * in local time.
 * @param {string} home
 * @param {Date} [now]
 * @returns {string}
 */
export function defaultReportPath(home, now = new Date()) {
  return path.join(home, '.auditrail', 'reports', 'auditrail-' + localStamp(now) + '.html');
}

/**
 * 'YYYY-MM-DD-HHMM' in the process's local time.
 * @param {Date} d
 * @returns {string}
 */
export function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/**
 * A path that does not exist yet: "name.ext", then "name-2.ext", "name-3.ext", ...
 * @param {string} p
 * @param {(p: string) => boolean} [exists]
 * @returns {string}
 */
export function uniquePath(p, exists = fs.existsSync) {
  if (!exists(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    const c = base + '-' + i + ext;
    if (!exists(c)) return c;
  }
  throw new Error('no free file name next to the requested output');
}

/**
 * Mode for every file this tool writes. The report carries project and file names, the exports
 * carry project labels, and the ledger carries the numbers: none of it belongs to other accounts
 * on a shared host. Owner read/write only. A no-op on Windows, where mode is ignored.
 */
export const OUTPUT_FILE_MODE = 0o600;

/** Mode for the folders this tool creates for its own data (~/.auditrail and below). */
export const OUTPUT_DIR_MODE = 0o700;

/**
 * Write the report (the sandbox grants write access to exactly this file).
 * @param {string} file
 * @param {string} html
 */
export function writeReport(file, html) {
  fs.writeFileSync(file, html, { encoding: 'utf8', mode: OUTPUT_FILE_MODE });
}

/* ------------------------------------------------------------------------------------------
 * Built-in static report: no script, numbers and local labels only, every value escaped.
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {any} s Summary
 * @returns {string}
 */
export function staticReportTemplate(s) {
  const e = escapeHtml;
  const t = s.totals ?? {};
  const tok = t.tokens ?? { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
  const n = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '0');
  const pct = (a, b) => (b ? (Math.round(ratio(a, b) * 1000) / 10).toFixed(1) + '%' : '0%');
  const pricing = s.pricing ?? {};
  const scan = s.scan ?? {};
  const i01 = s.insights && s.insights.i01 ? s.insights.i01.data : {};
  const valueLine = 'At least ' + formatUsd(t.valueNano ?? '0') + ' ' + (pricing.label ?? '') +
    (pricing.custom ? '' : ' (list prices as of ' + (pricing.asOf ?? '') + ')') + '. Not what you paid.';

  const rows = [];
  for (const id of INSIGHT_IDS) {
    const r = s.insights && s.insights[id];
    if (!r) continue;
    const ev = r.evidence ? n(r.evidence.count) + ' ' + r.evidence.unit : '';
    rows.push('<tr><td>' + e(INSIGHT_META[id].title) + '</td><td>' + (r.shown ? 'yes' : 'no') + '</td><td>' + e(ev) + '</td><td>' + e(r.action ?? '') + '</td></tr>');
  }
  const projects = Array.isArray(i01.byProject) ? i01.byProject.slice(0, 25) : [];
  const projectRows = projects.map((p) => '<tr><td>' + e(p.label) + '</td><td class="num">' + e(formatUsd(p.valueNano ?? '0')) + '</td><td class="num">' + n(p.responses) + '</td><td class="num">' + n(p.sessions) + '</td></tr>');
  const models = Array.isArray(i01.byModel) ? i01.byModel : [];
  const modelRows = models.map((m) => '<tr><td>' + e(m.displayName ?? m.model) + '</td><td class="num">' + e(formatUsd(m.valueNano ?? '0')) + '</td><td class="num">' + n(m.responses) + '</td></tr>');
  const banner = s.redacted ? REPORT_BANNER_REDACTED : REPORT_BANNER;
  const links = FOOTER_LINKS.map((l) => '<a href="' + e(l.href) + '" rel="noreferrer">' + e(l.text) + '</a>').join(' | ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Auditrail report</title>
<style>
:root { --bg: #0a0a0a; --text: #f2f2f2; --accent: #d4ff3a; --secondary: #a3a3a3; --line: #2a2a2a; }
@media (prefers-color-scheme: light) { :root { --bg: #e8ebef; --text: #0a0a0a; --accent: #2d6b00; --secondary: #4a5260; --line: #c3c9d1; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { color: var(--accent); letter-spacing: 0.08em; font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; }
.banner { border: 1px solid var(--accent); padding: 10px 12px; margin: 16px 0; }
.muted { color: var(--secondary); }
.big { font-size: 22px; font-weight: 600; margin: 8px 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
a { color: var(--accent); }
footer { margin-top: 40px; font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>AUDITRAIL</h1>
<p class="muted">Generated ${e(s.generatedAt ?? '')} (time zone ${e(s.tz ?? '')}). Scanned ${e(scan.takenAt ?? '')}, ${n(scan.filesRead)} files.</p>
<p class="banner">${e(banner)}</p>
<p class="big">${e(valueLine)}</p>
<p class="muted">${n(t.responses)} responses in ${n(t.sessions)} sessions. ${e(pct(t.incompleteResponses ?? 0, t.responses ?? 0))} of responses never recorded final output counts, so the value is a lower bound.</p>
<h2>Tokens</h2>
<div class="scroll"><table>
<tr><th>Figure</th><th class="num">Tokens</th></tr>
<tr><td>Output</td><td class="num">${n(tok.output)}</td></tr>
<tr><td>Fresh input (uncached input plus cache writes)</td><td class="num">${n(tok.input + tok.cw5m + tok.cw1h)}</td></tr>
<tr><td>Cache reads</td><td class="num">${n(tok.cacheRead)}</td></tr>
</table></div>
<h2>Value by model</h2>
<div class="scroll"><table>
<tr><th>Model</th><th class="num">Value</th><th class="num">Responses</th></tr>
${modelRows.join('\n')}
</table></div>
<h2>Value by project</h2>
<div class="scroll"><table>
<tr><th>Project</th><th class="num">Value</th><th class="num">Responses</th><th class="num">Sessions</th></tr>
${projectRows.join('\n')}
</table></div>
<h2>Insights</h2>
<div class="scroll"><table>
<tr><th>Insight</th><th>Shown</th><th>Evidence</th><th>Action</th></tr>
${rows.join('\n')}
</table></div>
<footer class="muted">
<p>API-equivalent value at list price. If you are on Pro or Max, this is not what you paid. Nothing in this page is fetched from the network.</p>
<p>${links}</p>
</footer>
</main>
</body>
</html>
`;
}
