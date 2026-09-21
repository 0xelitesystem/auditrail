// Stacked 100% bar (the money map, DESIGN I2): five buckets of value, each a categorical color
// from the validated palette (--s1 to --s5, both themes checked by test/web/palette.test.js),
// separated by a 2 px surface gap. The legend is always present and carries the value and the
// share as text, so identity never depends on color alone.

import { esc, r2 } from './scale.js';

/**
 * @typedef {Object} Segment
 * @property {string} key
 * @property {string} label
 * @property {number} value     display units (non-negative)
 * @property {string} valueText formatted value for the legend and tooltip
 * @property {string} shareText formatted share
 */

/** Categorical slots in fixed order (never cycled; five buckets, five slots). */
export const SERIES_VARS = Object.freeze(['--s1', '--s2', '--s3', '--s4', '--s5']);

/**
 * @param {{ segments: Segment[], ariaLabel: string, width?: number, height?: number }} o
 * @returns {string} SVG plus legend markup
 */
export function stackedBar(o) {
  const segs = (Array.isArray(o.segments) ? o.segments : []).slice(0, SERIES_VARS.length);
  const W = o.width ?? 720;
  const H = o.height ?? 36;
  const total = segs.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0);
  const gap = 2;
  const parts = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.ariaLabel) + '">'];
  if (total <= 0) {
    parts.push('<rect class="empty" x="0" y="0" width="' + W + '" height="' + H + '" rx="6"/>');
  } else {
    const visible = segs.filter((s) => s.value > 0);
    const usable = W - gap * Math.max(0, visible.length - 1);
    let x = 0;
    visible.forEach((s, i) => {
      const w = Math.max(1, (s.value / total) * usable);
      const slot = SERIES_VARS[segs.indexOf(s)];
      const first = i === 0;
      const last = i === visible.length - 1;
      const rx = 6;
      // Rounded outer ends only: draw a rounded rect, then square the inner side with a rect.
      parts.push('<g><title>' + esc(s.label + ': ' + s.valueText + ' (' + s.shareText + ')') + '</title>');
      if (first || last) {
        parts.push('<rect x="' + r2(x) + '" y="0" width="' + r2(w) + '" height="' + H + '" rx="' + rx + '" style="fill:var(' + slot + ')"/>');
        if (!(first && last)) {
          const sqX = first ? x + Math.max(0, w - rx) : x;
          parts.push('<rect x="' + r2(sqX) + '" y="0" width="' + r2(Math.min(rx, w)) + '" height="' + H + '" style="fill:var(' + slot + ')"/>');
        }
      } else {
        parts.push('<rect x="' + r2(x) + '" y="0" width="' + r2(w) + '" height="' + H + '" style="fill:var(' + slot + ')"/>');
      }
      parts.push('</g>');
      x += w + gap;
    });
  }
  parts.push('</svg>');
  parts.push('<ul class="legend">');
  segs.forEach((s, i) => {
    parts.push('<li><span class="sw" style="background:var(' + SERIES_VARS[i] + ')"></span><span>' + esc(s.label) + '</span><span class="v">' + esc(s.valueText) + ', ' + esc(s.shareText) + '</span></li>');
  });
  parts.push('</ul>');
  return parts.join('');
}
