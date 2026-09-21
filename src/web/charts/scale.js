// Shared chart helpers: clean axis ticks and SVG-safe text. Pure, no DOM.
//
// Charts are strings of SVG inserted with innerHTML in the page. They carry no namespace URL
// (inline SVG in HTML needs none), no script, no event handler attributes and no external
// references, so the page CSP (default-src 'none') is never involved. Every piece of text goes
// through esc().

import { esc } from '../format.js';

export { esc };

/**
 * Round numbers for a y axis from 0 to at least `max`: [0, step, 2*step, ...].
 * @param {number} max
 * @param {number} [target] roughly how many intervals
 * @returns {number[]}
 */
export function niceTicks(max, target = 4) {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v < max + step * 0.5; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1] < max) out.push(Number((out[out.length - 1] + step).toPrecision(12)));
  return out;
}

/**
 * Round a coordinate to 2 decimals for compact, stable SVG output.
 * @param {number} x
 * @returns {string}
 */
export function r2(x) {
  return String(Math.round(x * 100) / 100);
}

/**
 * A column with a 4 px rounded data end and a square base (DESIGN via the dataviz mark spec).
 * @param {number} x
 * @param {number} y     top
 * @param {number} w
 * @param {number} h
 * @param {number} [radius]
 * @returns {string} an SVG path "d" attribute
 */
export function columnPath(x, y, w, h, radius = 4) {
  const rr = Math.max(0, Math.min(radius, w / 2, h));
  if (h <= 0) return '';
  return 'M' + r2(x) + ' ' + r2(y + h) +
    'V' + r2(y + rr) +
    'Q' + r2(x) + ' ' + r2(y) + ' ' + r2(x + rr) + ' ' + r2(y) +
    'H' + r2(x + w - rr) +
    'Q' + r2(x + w) + ' ' + r2(y) + ' ' + r2(x + w) + ' ' + r2(y + rr) +
    'V' + r2(y + h) + 'Z';
}
