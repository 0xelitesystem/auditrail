// Card input contract (DESIGN 7.1, 8.7, 9.7).
//
// The card is rendered from a PublicSummary ONLY (public.js). The renderer receives a
// CardInput, calls assertPublicSummary(input.ps) before drawing, and draws only:
//   - fixed copy (wordmark, labels, footer template),
//   - text produced by the formatters exported from public.js (formatCount, formatPercent,
//     formatHour, formatDateRange, archetypeInfo, badgeText, footerText, scanText,
//     money.formatUsdTwoSignificant).
// Every string drawn goes through RasterHooks.onText so the canary test (9.7) can record it.
//
// Isomorphic: no node:* imports and no DOM. PNG deflate is injected by src/node (node:zlib
// deflateSync) or replaced by canvas.toBlob in the browser.

/** Logical sizes; pixels are SCALE times larger (DESIGN 7.1). */
export const CARD_SIZES = Object.freeze({
  landscape: Object.freeze({ width: 1200, height: 675 }),
  portrait: Object.freeze({ width: 1080, height: 1350 }),
});

/** Pixel density of the PNG. */
export const CARD_SCALE = 2;

/** Landscape grid (DESIGN 7.1). */
export const CARD_GRID = Object.freeze({ margin: 56, columns: 12, gutter: 24 });

/** Font sizes in logical px (DESIGN 7.1). The glyph atlas is built for exactly these. */
export const CARD_FONT_SIZES = Object.freeze({ archetype: 64, statNumber: 56, archetypeLine: 26, statLabel: 18, footer: 16 });

/**
 * Palettes (DESIGN 7.1). Every text color must reach 4.5:1 on its background (WCAG AA,
 * normal text); test/core/card-contract.test.js recomputes the ratios by math.
 */
export const CARD_THEMES = Object.freeze({
  dark: Object.freeze({ background: '#0a0a0a', text: '#f2f2f2', accent: '#d4ff3a', secondary: '#a3a3a3' }),
  light: Object.freeze({ background: '#e8ebef', text: '#0a0a0a', accent: '#2d6b00', secondary: '#4a5260' }),
});

/**
 * Heatmap cell colors by level (0 = no prompts, 4 = the busiest cell). Level 0 is a quiet track;
 * levels 1 to 4 are the data.
 *
 * The card is a flat PNG: no tooltip, no title, no alt text inside the image, so on the card the
 * color IS the reading. Two properties are therefore held by math, and test/web/palette.test.js
 * recomputes both from these arrays:
 *   1. empty against the lowest data level reaches HEAT_MIN_CONTRAST (WCAG 1.4.11 for a
 *      graphical object). This is the boundary that carries meaning: no activity vs some.
 *   2. every data level reaches HEAT_MIN_CONTRAST against the card background, and the levels
 *      are strictly ordered by relative luminance.
 * Adjacent DATA levels are separated by at least HEAT_MIN_ADJACENT, not by 3:1: five levels
 * spanning 3:1 at every step would need a 81:1 range and the maximum available is 21:1, so
 * asking for it would be asking for something no five-step ramp can have. The busiest hour is
 * printed as text on the card as well, so no reading depends on ranking two data levels by eye.
 *
 * The light ramp runs past the light accent (#2d6b00) into darker greens: the light background
 * is bright, so the range between "just visible" and "full" has to be taken downward.
 */
export const CARD_HEAT = Object.freeze({
  dark: Object.freeze(['#1e1e1e', '#5f711e', '#7f9826', '#a6c72f', '#d4ff3a']),
  light: Object.freeze(['#f7f8fa', '#699326', '#4d731a', '#345610', '#1a3805']),
});

/**
 * Minimum contrast for a heatmap data level against the background, and for the empty level
 * against the lowest data level (WCAG 1.4.11, graphical objects).
 */
export const HEAT_MIN_CONTRAST = 3;

/** Minimum contrast between two adjacent DATA levels of a heat ramp. See CARD_HEAT. */
export const HEAT_MIN_ADJACENT = 1.4;

/** Text roles that are drawn on the background, checked for contrast. */
export const TEXT_ROLES = Object.freeze(['text', 'accent', 'secondary']);

/** Minimum contrast for any text role (WCAG 2.x AA, normal text). */
export const MIN_CONTRAST = 4.5;

/** Wordmark, drawn in the accent color. */
export const WORDMARK = 'AUDITRAIL';

/**
 * @typedef {'landscape'|'portrait'} CardSize
 * @typedef {'dark'|'light'} CardTheme
 */

/**
 * Everything the renderer needs. Hiding stats is done BEFORE this point, in
 * toPublicSummary(summary, { hide }), so hidden stats are null on ps and cannot be drawn.
 *
 * @typedef {Object} CardInput
 * @property {Readonly<import('../public.js').PublicSummary>} ps
 * @property {CardSize} size
 * @property {CardTheme} theme
 */

/**
 * RGBA pixels, row-major, 4 bytes per pixel, straight alpha.
 * @typedef {Object} RasterImage
 * @property {number} width   pixels (logical width * CARD_SCALE)
 * @property {number} height  pixels
 * @property {Uint8ClampedArray} data  length width * height * 4
 */

/**
 * @typedef {Object} RasterHooks
 * @property {(text: string, info: { x: number, y: number, sizePx: number, role: string }) => void} [onText]
 *   called once for every string drawn, before drawing it
 */

/**
 * The renderer (src/core/card/layout.js plus raster.js) implements:
 *   renderCard(input: CardInput, hooks?: RasterHooks): RasterImage
 * The PNG writer (src/core/card/png.js) implements:
 *   encodePng(image: RasterImage, deps: { deflateSync: (bytes: Uint8Array) => Uint8Array }): Uint8Array
 *
 * @typedef {(input: CardInput, hooks?: RasterHooks) => RasterImage} RenderCard
 * @typedef {(image: RasterImage, deps: { deflateSync: (bytes: Uint8Array) => Uint8Array }) => Uint8Array} EncodePng
 */

/**
 * Validate a CardInput's options (the PublicSummary itself is checked by assertPublicSummary).
 * @param {unknown} input
 * @returns {string[]} problems; empty means valid
 */
export function checkCardOptions(input) {
  const p = [];
  const x = /** @type {any} */ (input);
  if (!x || typeof x !== 'object') return ['card input must be an object'];
  const allowed = new Set(['ps', 'size', 'theme', 'demo']);
  for (const k of Object.keys(x)) if (!allowed.has(k)) p.push('unexpected key ' + k);
  if (!Object.prototype.hasOwnProperty.call(CARD_SIZES, x.size)) p.push('size must be landscape or portrait');
  if (!Object.prototype.hasOwnProperty.call(CARD_THEMES, x.theme)) p.push('theme must be dark or light');
  if (!x.ps || typeof x.ps !== 'object') p.push('ps must be a PublicSummary');
  if (x.demo !== undefined && typeof x.demo !== 'boolean') p.push('demo must be a boolean');
  return p;
}

/**
 * WCAG 2.x relative luminance of a #rrggbb color.
 * @param {string} hex
 * @returns {number}
 */
export function relativeLuminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new TypeError('expected #rrggbb, got ' + hex);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two #rrggbb colors (1 to 21).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
