// Glyph atlas loader (DESIGN 7.1, 8.7, trap 60). Isomorphic: no node:*, no DOM, no fonts.
//
// The atlas is generated once by scripts/build-glyphs.mjs from the Inter release (SIL OFL 1.1,
// license text in NOTICE) and committed as src/core/card/glyphs.bin plus glyphs.js (the same
// bytes, base64, importable without a file system). Nothing is fetched at run time, so every
// OS and browser draws the same pixels.
//
// Atlas layout after inflating (little-endian):
//   'AWG1'                       magic
//   u16 faceCount
//   per face:
//     u8 idLength, id (ASCII)    'display', 'number', 'line', 'label', 'strong', 'footer'
//     u16 px                     pixel size of the em
//     i32 ascent64, descent64, capHeight64, xHeight64    font metrics in 1/64 px
//     u16 glyphCount
//     per glyph:
//       u8 code                  printable ASCII
//       i32 advance64            advance width in 1/64 px
//       i16 left, i16 top        bitmap offset from the pen position on the baseline, y down
//       u16 w, u16 h             bitmap size
//       w*h bytes                coverage, 0 to 255, row-major

import { GLYPH_ATLAS_BASE64, GLYPH_ATLAS_RAW_BYTES, GLYPH_ATLAS_SHA256 } from './glyphs.js';
import { inflateRaw } from './inflate.js';
import { sha256Hex } from '../sha256.js';

/**
 * @typedef {Object} Glyph
 * @property {number} code
 * @property {number} advance64
 * @property {number} left
 * @property {number} top
 * @property {number} w
 * @property {number} h
 * @property {Uint8Array} data  coverage, w*h bytes
 */

/**
 * @typedef {Object} Face
 * @property {string} id
 * @property {number} px
 * @property {number} ascent     px, positive up
 * @property {number} descent    px, positive down
 * @property {number} capHeight  px
 * @property {number} xHeight    px
 * @property {(Glyph|null)[]} glyphs  indexed by char code (0 to 127)
 * @property {string} chars      every character the face can draw
 */

export class GlyphError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GlyphError';
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Strict base64 decoder (no atob, so it behaves the same in every runtime).
 * @param {string} s
 * @returns {Uint8Array}
 */
export function decodeBase64(s) {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[B64.charCodeAt(i)] = i;
  let len = s.length;
  if (len % 4 !== 0) throw new GlyphError('base64 length must be a multiple of 4');
  let pad = 0;
  if (len && s[len - 1] === '=') pad++;
  if (len > 1 && s[len - 2] === '=') pad++;
  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const c = s.charCodeAt(i + k);
      if (c === 61 && i + k >= len - pad) return 0;
      const x = c < 128 ? lookup[c] : -1;
      if (x < 0) throw new GlyphError('invalid base64 character');
      return x;
    });
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * Parse an inflated atlas.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Face>}
 */
export function parseAtlas(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const need = (n) => { if (p + n > bytes.length) throw new GlyphError('atlas truncated'); };
  need(6);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'AWG1') throw new GlyphError('atlas magic mismatch');
  p = 4;
  const faceCount = dv.getUint16(p, true); p += 2;
  /** @type {Map<string, Face>} */
  const faces = new Map();
  for (let f = 0; f < faceCount; f++) {
    need(1);
    const idLen = bytes[p++];
    need(idLen + 20);
    const id = String.fromCharCode(...bytes.subarray(p, p + idLen)); p += idLen;
    const px = dv.getUint16(p, true); p += 2;
    const ascent = dv.getInt32(p, true) / 64; p += 4;
    const descent = -dv.getInt32(p, true) / 64; p += 4;
    const capHeight = dv.getInt32(p, true) / 64; p += 4;
    const xHeight = dv.getInt32(p, true) / 64; p += 4;
    const count = dv.getUint16(p, true); p += 2;
    /** @type {(Glyph|null)[]} */
    const glyphs = new Array(128).fill(null);
    let chars = '';
    for (let g = 0; g < count; g++) {
      need(15);
      const code = bytes[p++];
      const advance64 = dv.getInt32(p, true); p += 4;
      const left = dv.getInt16(p, true); p += 2;
      const top = dv.getInt16(p, true); p += 2;
      const w = dv.getUint16(p, true); p += 2;
      const h = dv.getUint16(p, true); p += 2;
      need(w * h);
      if (code >= 128) throw new GlyphError('atlas glyph code out of range');
      glyphs[code] = { code, advance64, left, top, w, h, data: bytes.subarray(p, p + w * h) };
      chars += String.fromCharCode(code);
      p += w * h;
    }
    faces.set(id, { id, px, ascent, descent, capHeight, xHeight, glyphs, chars });
  }
  if (p !== bytes.length) throw new GlyphError('trailing bytes after atlas');
  return faces;
}

/** @type {Map<string, Face>|null} */
let cached = null;

/**
 * The bundled atlas, decoded once and cached. Checks the SHA-256 of the compressed bytes.
 * @returns {Map<string, Face>}
 */
export function loadAtlas() {
  if (cached) return cached;
  const compressed = decodeBase64(GLYPH_ATLAS_BASE64);
  if (sha256Hex(compressed) !== GLYPH_ATLAS_SHA256) throw new GlyphError('glyph atlas checksum mismatch');
  cached = parseAtlas(inflateRaw(compressed, GLYPH_ATLAS_RAW_BYTES));
  return cached;
}

/**
 * @param {string} id
 * @returns {Face}
 */
export function getFace(id) {
  const face = loadAtlas().get(id);
  if (!face) throw new GlyphError('no face ' + id + ' in the glyph atlas');
  return face;
}

/**
 * @param {Face} face
 * @param {string} text
 * @returns {Glyph[]}
 */
export function glyphsFor(face, text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const g = c < 128 ? face.glyphs[c] : null;
    if (!g) throw new GlyphError('face ' + face.id + ' has no glyph for character code ' + c);
    out.push(g);
  }
  return out;
}

/**
 * Advance width of a string in 1/64 px, with optional extra tracking per character gap.
 * @param {Face} face
 * @param {string} text
 * @param {number} [tracking64]
 * @returns {number}
 */
export function measure64(face, text, tracking64 = 0) {
  let w = 0;
  const gs = glyphsFor(face, text);
  for (const g of gs) w += g.advance64;
  return w + (gs.length > 1 ? tracking64 * (gs.length - 1) : 0);
}

/**
 * Advance width in px.
 * @param {Face} face
 * @param {string} text
 * @param {number} [tracking64]
 * @returns {number}
 */
export function measureText(face, text, tracking64 = 0) {
  return measure64(face, text, tracking64) / 64;
}

/**
 * True when the face can draw every character of text.
 * @param {Face} face
 * @param {string} text
 */
export function canDraw(face, text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || !face.glyphs[c]) return false;
  }
  return true;
}
