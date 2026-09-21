// Pure-JS rasterizer for the share card (DESIGN 8.7). Draws into an RGBA Uint8ClampedArray:
// filled rectangles, filled and outlined rounded rectangles and pills, and text blitted from
// the pre-rasterized glyph atlas with coverage alpha (per-size advance widths, no kerning).
//
// Determinism: only integer blending and IEEE-754 +, -, *, / and sqrt, which every JS engine
// computes identically, so Node and every browser produce the same pixels (golden test 9.7).
// Isomorphic: no node:*, no DOM.
//
// Coordinates are image pixels. Text is positioned by its pen origin on the baseline.

import { glyphsFor } from './atlas.js';

/**
 * @typedef {import('./contract.js').RasterImage} RasterImage
 * @typedef {import('./atlas.js').Face} Face
 * @typedef {[number, number, number]} Rgb
 */

/**
 * '#rrggbb' to [r, g, b].
 * @param {string} hex
 * @returns {Rgb}
 */
export function parseHex(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new TypeError('expected #rrggbb, got ' + hex);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/**
 * A new opaque image filled with one color.
 * @param {number} width
 * @param {number} height
 * @param {Rgb} rgb
 * @returns {RasterImage}
 */
export function createImage(width, height, rgb) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new RangeError('image size must be positive integers');
  const data = new Uint8ClampedArray(width * height * 4);
  const row = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) { row[x * 4] = rgb[0]; row[x * 4 + 1] = rgb[1]; row[x * 4 + 2] = rgb[2]; row[x * 4 + 3] = 255; }
  for (let y = 0; y < height; y++) data.set(row, y * width * 4);
  return { width, height, data };
}

/**
 * Composite one color over a pixel with coverage alpha (0 to 255). Straight alpha; the
 * destination alpha becomes a + d * (255 - a) / 255, so an opaque image stays opaque.
 * @param {RasterImage} img
 * @param {number} x integer
 * @param {number} y integer
 * @param {Rgb} rgb
 * @param {number} a integer 0 to 255
 */
export function blendPixel(img, x, y, rgb, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  if (a >= 255) {
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
    return;
  }
  const ia = 255 - a;
  d[i] = ((rgb[0] * a + d[i] * ia + 127) / 255) | 0;
  d[i + 1] = ((rgb[1] * a + d[i + 1] * ia + 127) / 255) | 0;
  d[i + 2] = ((rgb[2] * a + d[i + 2] * ia + 127) / 255) | 0;
  d[i + 3] = ((255 * a + d[i + 3] * ia + 127) / 255) | 0;
}

/**
 * Fill an axis-aligned rectangle. Edges are snapped to whole pixels.
 * @param {RasterImage} img
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {Rgb} rgb
 */
export function fillRect(img, x, y, w, h, rgb) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) blendPixel(img, px, py, rgb, 255);
}

/** Sub-samples per axis for rounded corners (4 x 4 = 16 coverage levels plus exact edges). */
const SS = 4;

/**
 * Coverage (0 to 1) of pixel (px, py) by a rounded rectangle, 4 x 4 supersampled. The
 * rectangle edges are snapped to whole pixels by the callers, so only corners are partial.
 * @param {number} px
 * @param {number} py
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} r
 * @returns {number}
 */
function roundRectCoverage(px, py, x0, y0, x1, y1, r) {
  let inside = 0;
  for (let sy = 0; sy < SS; sy++) {
    const y = py + (sy + 0.5) / SS;
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) inside++;
    }
  }
  return inside / (SS * SS);
}

/**
 * Fill a rounded rectangle. Position and size are snapped to whole pixels.
 * @param {RasterImage} img
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r corner radius in px (clamped to half the shorter side)
 * @param {Rgb} rgb
 */
export function fillRoundRect(img, x, y, w, h, r, rgb) {
  strokeOrFill(img, x, y, w, h, r, 0, rgb);
}

/**
 * Outline a rounded rectangle with a stroke drawn inside its edge.
 * @param {RasterImage} img
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @param {number} lineWidth px
 * @param {Rgb} rgb
 */
export function strokeRoundRect(img, x, y, w, h, r, lineWidth, rgb) {
  if (!(lineWidth > 0)) throw new RangeError('lineWidth must be positive');
  strokeOrFill(img, x, y, w, h, r, lineWidth, rgb);
}

/**
 * Pill (fully rounded ends), filled or outlined.
 * @param {RasterImage} img
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {Rgb} rgb
 * @param {number} [lineWidth] outline width; omitted or 0 fills
 */
export function drawPill(img, x, y, w, h, rgb, lineWidth = 0) {
  strokeOrFill(img, x, y, w, h, Math.round(h) / 2, lineWidth, rgb);
}

/**
 * @param {RasterImage} img
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @param {number} lw 0 fills
 * @param {Rgb} rgb
 */
function strokeOrFill(img, x, y, w, h, r, lw, rgb) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const ix0 = x0 + lw, iy0 = y0 + lw, ix1 = x1 - lw, iy1 = y1 - lw;
  const ir = Math.max(0, rr - lw);
  const hasInner = lw > 0 && ix1 > ix0 && iy1 > iy0;
  const cornerBand = Math.ceil(rr) + 1;
  for (let py = Math.max(0, y0); py < Math.min(img.height, y1); py++) {
    const nearY = py < y0 + cornerBand || py >= y1 - cornerBand;
    for (let px = Math.max(0, x0); px < Math.min(img.width, x1); px++) {
      const nearX = px < x0 + cornerBand || px >= x1 - cornerBand;
      let cov;
      if (nearX && nearY) {
        cov = roundRectCoverage(px, py, x0, y0, x1, y1, rr);
        if (hasInner) cov -= roundRectCoverage(px, py, ix0, iy0, ix1, iy1, ir);
      } else if (lw > 0) {
        // Straight edges: the band between the outer and inner rectangle, exact per pixel.
        const insideInner = hasInner && px + 1 > ix0 && px < ix1 && py + 1 > iy0 && py < iy1;
        if (!insideInner) cov = 1;
        else {
          const ox = Math.min(px + 1, ix1) - Math.max(px, ix0);
          const oy = Math.min(py + 1, iy1) - Math.max(py, iy0);
          cov = 1 - Math.max(0, ox) * Math.max(0, oy);
        }
      } else {
        cov = 1;
      }
      if (cov > 0) blendPixel(img, px, py, rgb, Math.round(cov * 255));
    }
  }
}

/**
 * Draw a string from a glyph atlas face. The pen starts at x (px, may be fractional, kept in
 * 1/64 px) on baseline y (whole px). Each glyph lands at the pen position rounded to a whole
 * pixel. Throws GlyphError for a character the face does not carry (fail closed).
 * @param {RasterImage} img
 * @param {Face} face
 * @param {string} text
 * @param {number} x
 * @param {number} y baseline
 * @param {Rgb} rgb
 * @param {number} [tracking64] extra advance between characters, 1/64 px
 * @returns {number} the pen position after the string, px
 */
export function drawText(img, face, text, x, y, rgb, tracking64 = 0) {
  const glyphs = glyphsFor(face, text);
  let pen64 = Math.round(x * 64);
  const base = Math.round(y);
  for (let k = 0; k < glyphs.length; k++) {
    const g = glyphs[k];
    const gx = Math.round(pen64 / 64) + g.left;
    const gy = base + g.top;
    for (let row = 0; row < g.h; row++) {
      const py = gy + row;
      if (py < 0 || py >= img.height) continue;
      const src = row * g.w;
      for (let col = 0; col < g.w; col++) {
        const a = g.data[src + col];
        if (a) blendPixel(img, gx + col, py, rgb, a);
      }
    }
    pen64 += g.advance64 + (k < glyphs.length - 1 ? tracking64 : 0);
  }
  return pen64 / 64;
}

/** Tent-filtered (1 2 1 by 1 2 1) glyph coverage, padded by one pixel, times 16. Cached per glyph. */
const TENT = new WeakMap();

/** @param {import('./atlas.js').Glyph} g @returns {Uint16Array} */
function tent(g) {
  let t = TENT.get(g);
  if (t) return t;
  const W = g.w + 2;
  t = new Uint16Array(W * (g.h + 2));
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const v = g.data[r * g.w + c];
      if (v) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) t[(r + j) * W + c + i] += v * (i === 1 ? 2 : 1) * (j === 1 ? 2 : 1);
    }
  }
  TENT.set(g, t);
  return t;
}

/**
 * Draw a string from a glyph atlas face scaled up by `scale` (hero sizes without a bigger atlas).
 * The coverage is tent-filtered, sampled bilinearly per output pixel and the edge ramp steepened
 * again, which reads the coverage as a smooth edge field: curves stay round instead of taking
 * the pixel staircase, straight edges stay put, edges stay within about 2.5 px. Same arithmetic
 * rules as drawText (integer blending, IEEE-754 + - * / only), so every runtime agrees.
 * @param {RasterImage} img
 * @param {Face} face
 * @param {string} text
 * @param {number} x pen start, px (fractional allowed)
 * @param {number} y baseline, px
 * @param {Rgb} rgb
 * @param {number} scale >= 1
 * @param {number} [tracking64] extra advance between characters, 1/64 px (not scaled)
 * @returns {number} the pen position after the string, px
 */
export function drawTextScaled(img, face, text, x, y, rgb, scale, tracking64 = 0) {
  if (scale === 1) return drawText(img, face, text, x, y, rgb, tracking64);
  if (!(scale > 1)) throw new RangeError('scale must be at least 1');
  const glyphs = glyphsFor(face, text);
  const base = Math.round(y);
  const k = Math.max(2, 0.8 * scale) / 16;
  let pen64 = x * 64;
  for (let n = 0; n < glyphs.length; n++) {
    const g = glyphs[n];
    const t = tent(g);
    const W = g.w + 2;
    const H = g.h + 2;
    const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 0 : t[r * W + c]);
    const ox = pen64 / 64 + (g.left - 1) * scale;
    const oy = base + (g.top - 1) * scale;
    for (let py = Math.max(0, Math.floor(oy)); py < Math.min(img.height, Math.ceil(oy + H * scale)); py++) {
      const v = (py + 0.5 - oy) / scale - 0.5;
      const r0 = Math.floor(v);
      const fy = v - r0;
      for (let px = Math.floor(ox); px < Math.ceil(ox + W * scale); px++) {
        const u = (px + 0.5 - ox) / scale - 0.5;
        const c0 = Math.floor(u);
        const fx = u - c0;
        const top = at(c0, r0) + (at(c0 + 1, r0) - at(c0, r0)) * fx;
        const bot = at(c0, r0 + 1) + (at(c0 + 1, r0 + 1) - at(c0, r0 + 1)) * fx;
        const a = Math.round((top + (bot - top) * fy - 2040) * k + 127.5);
        if (a > 0) blendPixel(img, px, py, rgb, a > 255 ? 255 : a);
      }
    }
    pen64 += g.advance64 * scale + (n < glyphs.length - 1 ? tracking64 : 0);
  }
  return pen64 / 64;
}
