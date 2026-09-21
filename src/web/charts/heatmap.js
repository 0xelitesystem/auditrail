// Prompt heatmap by local weekday and hour (DESIGN I9). Sequential encoding: one hue, faint to
// full, in five buckets of the maximum. Empty cells use the panel-2 surface.
//
// The levels are explicit theme tokens (--hm1 to --hm4 in src/web/template.html), not an opacity
// ramp over the panel. Opacity over the panel cannot work in the light theme: the empty cell
// (--panel-2) is DARKER than the panel there, so a ramp that starts light and ends dark has to
// pass through the empty cell's own luminance, and the lowest data bucket landed at 1.05:1
// against it, which is invisible. The tokens are chosen so the empty cell clears 3:1 against the
// lowest data bucket in both themes (WCAG 1.4.11); test/web/palette.test.js recomputes it.
//
// Every cell also carries a <title> with the exact count and the svg carries an aria-label, so
// the numbers stay reachable by hover and by assistive technology whatever the colors do.

import { esc, r2 } from './scale.js';

export const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

/** Number of data levels above zero. Level n is painted with the --hm<n> token. */
export const HEAT_LEVELS = 4;

/**
 * @param {number} v
 * @param {number} max
 * @returns {number} data level 1 to HEAT_LEVELS, or 0 for empty
 */
export function heatStep(v, max) {
  if (!(v > 0) || !(max > 0)) return 0;
  const idx = Math.min(HEAT_LEVELS - 1, Math.floor((v / max) * HEAT_LEVELS - 1e-9));
  return Math.max(0, idx) + 1;
}

/**
 * @param {{ grid: number[][], ariaLabel: string, unit?: string, width?: number }} o
 *   grid: 7 rows (Monday first) x 24 hours
 * @returns {string}
 */
export function heatmap(o) {
  const grid = Array.isArray(o.grid) ? o.grid : [];
  const unit = o.unit ?? 'prompts';
  const W = o.width ?? 720;
  const left = 40;
  const top = 4;
  const gap = 2;
  const cell = (W - left - gap * 23) / 24;
  const H = top + 7 * (cell + gap) + 22;
  let max = 0;
  for (const row of grid) for (const v of Array.isArray(row) ? row : []) if (v > max) max = v;
  const parts = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + r2(H) + '" role="img" aria-label="' + esc(o.ariaLabel) + '">'];
  for (let d = 0; d < 7; d++) {
    const y = top + d * (cell + gap);
    parts.push('<text x="' + (left - 8) + '" y="' + r2(y + cell * 0.7) + '" text-anchor="end">' + WEEKDAYS[d] + '</text>');
    const row = Array.isArray(grid[d]) ? grid[d] : [];
    for (let h = 0; h < 24; h++) {
      const v = Number.isFinite(row[h]) ? row[h] : 0;
      const x = left + h * (cell + gap);
      const step = heatStep(v, max);
      const title = WEEKDAYS[d] + ' ' + String(h).padStart(2, '0') + ':00, ' + v + ' ' + unit;
      if (step === 0) parts.push('<rect class="empty" x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(cell) + '" height="' + r2(cell) + '" rx="3"><title>' + esc(title) + '</title></rect>');
      else parts.push('<rect class="cell l' + step + '" x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(cell) + '" height="' + r2(cell) + '" rx="3"><title>' + esc(title) + '</title></rect>');
    }
  }
  for (const h of [0, 6, 12, 18, 23]) {
    const x = left + h * (cell + gap) + cell / 2;
    parts.push('<text x="' + r2(x) + '" y="' + r2(H - 6) + '" text-anchor="middle">' + (h === 0 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? h + ' AM' : (h - 12) + ' PM') + '</text>');
  }
  parts.push('</svg>');
  const swatches = ['<i></i>'];
  for (let lv = 1; lv <= HEAT_LEVELS; lv++) swatches.push('<i class="l' + lv + '"></i>');
  parts.push('<div class="heat-legend" aria-hidden="true"><span>Fewer</span>' + swatches.join('') + '<span>More</span></div>');
  return parts.join('');
}
