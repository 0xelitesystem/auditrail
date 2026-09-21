// Column chart (value by month, value by day, rate-limit episodes by hour). One series, so no
// legend box: the section heading names what is plotted. Each column carries a <title> for the
// hover tooltip, and the caller always renders a table view of the same numbers.

import { esc, niceTicks, r2, columnPath } from './scale.js';

/**
 * @typedef {Object} ColumnItem
 * @property {string} label   x label (short)
 * @property {number} value   non-negative, display units
 * @property {string} title   tooltip text (label and formatted value)
 */

/**
 * @param {{ items: ColumnItem[], ariaLabel: string, format?: (v: number) => string, height?: number, width?: number, labelEvery?: number }} o
 * @returns {string} SVG markup
 */
export function columnChart(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const W = o.width ?? 720;
  const H = o.height ?? 220;
  const fmt = o.format ?? ((v) => String(v));
  const left = 52;
  const right = 8;
  const top = 10;
  const bottom = 28;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = Math.max(0, ...items.map((i) => (Number.isFinite(i.value) ? i.value : 0)));
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || 1;
  const n = Math.max(1, items.length);
  const band = plotW / n;
  const colW = Math.max(1, Math.min(24, band - 2));
  const every = o.labelEvery ?? Math.max(1, Math.ceil(n / 12));
  const parts = [];
  parts.push('<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.ariaLabel) + '">');
  for (const t of ticks) {
    const y = top + plotH - (t / yMax) * plotH;
    parts.push('<line class="grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + r2(y) + '" y2="' + r2(y) + '"/>');
    parts.push('<text x="' + (left - 8) + '" y="' + r2(y + 4) + '" text-anchor="end">' + esc(fmt(t)) + '</text>');
  }
  items.forEach((it, i) => {
    const v = Number.isFinite(it.value) && it.value > 0 ? it.value : 0;
    const h = (v / yMax) * plotH;
    const x = left + i * band + (band - colW) / 2;
    const y = top + plotH - h;
    if (h > 0) parts.push('<path class="mark" d="' + columnPath(x, y, colW, Math.max(h, 1)) + '"><title>' + esc(it.title) + '</title></path>');
    // Invisible hit target the full band tall, bigger than the mark.
    parts.push('<rect x="' + r2(left + i * band) + '" y="' + top + '" width="' + r2(band) + '" height="' + plotH + '" fill="transparent"><title>' + esc(it.title) + '</title></rect>');
    if (i % every === 0) {
      parts.push('<text x="' + r2(left + i * band + band / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(it.label) + '</text>');
    }
  });
  parts.push('<line class="axis" x1="' + left + '" x2="' + (W - right) + '" y1="' + (top + plotH) + '" y2="' + (top + plotH) + '"/>');
  parts.push('</svg>');
  return parts.join('');
}
