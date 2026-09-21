// Ranked horizontal bars as an HTML grid (models, tools, hot files, idle buckets). Labels and
// values are text, the bar is a proportional fill; ranked lists stay readable on narrow
// screens and in the accessibility tree without an SVG text layout.

import { esc } from './scale.js';

/**
 * @typedef {Object} BarRow
 * @property {string} label
 * @property {number} value      display units, non-negative
 * @property {string} valueText
 */

/**
 * @param {{ rows: BarRow[], ariaLabel: string, max?: number }} o
 * @returns {string}
 */
export function barRows(o) {
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const max = o.max ?? Math.max(0, ...rows.map((r) => (r.value > 0 ? r.value : 0)));
  const parts = ['<div class="barrows" role="list" aria-label="' + esc(o.ariaLabel) + '">'];
  for (const r of rows) {
    const w = max > 0 && r.value > 0 ? Math.max(0.5, (r.value / max) * 100) : 0;
    parts.push(
      '<div class="lbl" role="listitem">' + esc(r.label) + '</div>' +
      '<div class="track" aria-hidden="true"><div class="fill" style="width:' + (Math.round(w * 10) / 10) + '%"></div></div>' +
      '<div class="val">' + esc(r.valueText) + '</div>',
    );
  }
  parts.push('</div>');
  return parts.join('');
}
