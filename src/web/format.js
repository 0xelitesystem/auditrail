// Display formatting for the local report (DESIGN 6, 8.8). Pure functions, no DOM, so they are
// tested in Node. Money always arrives as nanodollar digit strings and is formatted with the
// integer helpers in core/money.js; nothing here does money math in floats.
//
// Card text is NOT formatted here: the card and its manifest use the public.js formatters only.

import { formatUsd, toBigNano, nanoToUsdNumber } from '../core/money.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for HTML element content and quoted attribute values.
 * @param {unknown} s
 * @returns {string}
 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[/** @type {keyof typeof HTML_ESCAPES} */ (c)]);
}

/**
 * Nanodollars as dollars and cents (half up, DESIGN 4.14). Non-zero amounts under half a cent
 * read "<$0.01" instead of a misleading "$0.00".
 * @param {string|number|bigint|null|undefined} nano
 * @returns {string}
 */
export function usd(nano) {
  if (nano === null || nano === undefined || nano === '') return '$0.00';
  let n;
  try { n = toBigNano(/** @type {any} */ (nano)); } catch { return 'n/a'; }
  if (n > 0n && n < 5_000_000n) return '<$0.01';
  if (n < 0n && n > -5_000_000n) return '-<$0.01';
  return formatUsd(n, { decimals: 2 });
}

/**
 * Compact dollars for chart axes and tooltips: "$1.2K", "$38", "$0.42".
 * @param {number} dollars display-only number
 * @returns {string}
 */
export function usdShort(dollars) {
  const a = Math.abs(dollars);
  const sign = dollars < 0 ? '-' : '';
  if (a >= 1e6) return sign + '$' + trim1(a / 1e6) + 'M';
  if (a >= 1e3) return sign + '$' + trim1(a / 1e3) + 'K';
  if (a >= 10) return sign + '$' + Math.round(a);
  if (a >= 1) return sign + '$' + a.toFixed(1).replace(/\.0$/, '');
  if (a === 0) return '$0';
  return sign + '$' + a.toFixed(2);
}

/** @param {number} x */
function trim1(x) { return (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '')); }

/**
 * Nanodollars to a display-only number of dollars (chart geometry only).
 * @param {string|number|bigint|null|undefined} nano
 * @returns {number}
 */
export function dollars(nano) {
  if (nano === null || nano === undefined || nano === '') return 0;
  try { return nanoToUsdNumber(/** @type {any} */ (nano)); } catch { return 0; }
}

/**
 * Whole number with thousands separators.
 * @param {unknown} n
 * @returns {string}
 */
export function int(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return v.toLocaleString('en-US');
}

/**
 * Compact count for large token figures: 1,284 / 12.9K / 3.4M / 5.0B (floored, never overstated).
 * @param {unknown} n
 * @returns {string}
 */
export function compact(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
  const units = [[1e9, 'B'], [1e6, 'M'], [1e4, 'K']];
  for (const [div, suffix] of units) {
    if (v >= /** @type {number} */ (div)) {
      const q = v / /** @type {number} */ (div);
      return (q < 100 ? (Math.floor(q * 10) / 10).toFixed(1) : String(Math.floor(q))) + suffix;
    }
  }
  return int(v);
}

/**
 * A share (0 to 1) as a percentage, floored to `digits` decimals so a threshold is never
 * overstated. Non-zero shares below the smallest step read "<0.1%".
 * @param {unknown} share
 * @param {number} [digits]
 * @returns {string}
 */
export function pct(share, digits = 1) {
  const s = typeof share === 'number' && Number.isFinite(share) ? share : 0;
  const scale = Math.pow(10, digits);
  const step = 1 / (100 * scale);
  if (s > 0 && s < step) return '<' + (1 / scale).toFixed(digits) + '%';
  const v = Math.floor(s * 100 * scale + 1e-9) / scale;
  return v.toFixed(digits) + '%';
}

/**
 * Seconds as hours with one decimal: "132.3 h".
 * @param {unknown} seconds
 * @returns {string}
 */
export function hoursText(seconds) {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
  return (Math.round((s / 3600) * 10) / 10).toFixed(1) + ' h';
}

/**
 * Seconds as a short duration: "45 s", "7 min", "1 h 12 min".
 * @param {unknown} seconds
 * @returns {string}
 */
export function duration(seconds) {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (s < 60) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? h + ' h ' + r + ' min' : h + ' h';
}

/**
 * 'YYYY-MM-DD' as "Mar 2, 2026".
 * @param {unknown} d
 * @returns {string}
 */
export function dateText(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'n/a';
  const [y, m, day] = d.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + day + ', ' + y;
}

/**
 * 'YYYY-MM' as "Mar 2026".
 * @param {unknown} ym
 * @returns {string}
 */
export function monthText(ym) {
  if (typeof ym !== 'string' || !/^\d{4}-\d{2}$/.test(ym)) return String(ym ?? '');
  const [y, m] = ym.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + y;
}

/**
 * "Mar 2 to Mar 16, 2026" for two local dates.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {string}
 */
export function rangeText(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return 'n/a';
  if (from === to) return dateText(from);
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty] = to.split('-').map(Number);
  const head = MONTHS[fm - 1] + ' ' + fd + (fy === ty ? '' : ', ' + fy);
  return head + ' to ' + dateText(to);
}

/**
 * ISO UTC timestamp as "2026-03-16 09:00 UTC".
 * @param {unknown} iso
 * @returns {string}
 */
export function isoText(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return 'n/a';
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
}

/**
 * 0 to 23 as "8 PM".
 * @param {unknown} h
 * @returns {string}
 */
export function hourText(h) {
  if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23) return 'n/a';
  const x = h % 12 === 0 ? 12 : h % 12;
  return x + ' ' + (h < 12 ? 'AM' : 'PM');
}

/**
 * "1 response" / "3 responses".
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export function plural(n, one, many) {
  return int(n) + ' ' + (n === 1 ? one : (many ?? one + 's'));
}

/**
 * Bytes as "608 MB" / "1.2 GB" / "340 KB".
 * @param {unknown} b
 * @returns {string}
 */
export function bytesText(b) {
  const v = typeof b === 'number' && Number.isFinite(b) ? b : 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + ' MB';
  if (v >= 1e3) return Math.round(v / 1e3) + ' KB';
  return Math.round(v) + ' B';
}
