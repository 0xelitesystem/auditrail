#!/usr/bin/env node
// Glyph atlas generator for the share card (DESIGN 7.1, 8.7, trap 60). Dev only; never shipped.
//
// Reads the official Inter release zip, rasterizes printable ASCII (0x20 to 0x7E) at the card's
// pixel sizes with a pure-JS TrueType rasterizer (exact-area coverage, 8-bit alpha, no hinting),
// and writes:
//   src/core/card/glyphs.bin   the atlas, raw-deflate compressed (the canonical committed file)
//   src/core/card/glyphs.js    the same bytes as base64 in an ES module, so the isomorphic core
//                              can import it without node:fs (the dist bundle inlines it)
//
// The font never comes from the network at build or run time (DESIGN 8.4). Download the zip
// yourself from the official source, then point this script at it:
//   https://github.com/rsms/inter/releases/tag/v4.1  asset Inter-4.1.zip
//   node scripts/build-glyphs.mjs --zip path/to/Inter-4.1.zip          write both files
//   node scripts/build-glyphs.mjs --zip path/to/Inter-4.1.zip --check  regenerate in memory, diff
// The zip and every font file used are checked against the SHA-256 values pinned below.
//
// Why no browser: DESIGN 8.7 suggested rasterizing in Chromium. A browser applies platform
// font hinting and gamma, so the atlas would differ between Windows, macOS and Linux CI and
// could not be diffed. This rasterizer is plain IEEE-754 arithmetic: the same bytes everywhere.
//
// Font license: Inter is licensed under the SIL Open Font License 1.1. The atlas is a derived
// ("Modified Version") form of the font and stays under the OFL. The license text is copied
// verbatim from the zip's LICENSE.txt into NOTICE; --check fails if NOTICE does not contain it.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARCHETYPES, GENERALIST } from '../src/core/public.js';
import { WORDMARK } from '../src/core/card/contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_BIN = path.join(ROOT, 'src', 'core', 'card', 'glyphs.bin');
const OUT_JS = path.join(ROOT, 'src', 'core', 'card', 'glyphs.js');
const NOTICE = path.join(ROOT, 'NOTICE');

/** The pinned upstream release. */
export const FONT_SOURCE = Object.freeze({
  family: 'Inter',
  version: '4.1',
  release: 'https://github.com/rsms/inter/releases/tag/v4.1',
  asset: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
  zipSha256: '9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e',
  license: 'OFL-1.1',
  copyright: 'Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)',
});

/** Files read from the zip, with their pinned SHA-256. */
const ZIP_FILES = Object.freeze({
  license: { name: 'LICENSE.txt', sha256: '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a' },
  regular: { name: 'extras/ttf/Inter-Regular.ttf', sha256: '40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82' },
  semibold: { name: 'extras/ttf/Inter-SemiBold.ttf', sha256: '78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3' },
});

export const FIRST_CHAR = 0x20;
export const LAST_CHAR = 0x7e;

/** Printable ASCII, 0x20 to 0x7E. */
export const PRINTABLE_ASCII = String.fromCharCode(...Array.from({ length: LAST_CHAR - FIRST_CHAR + 1 }, (_, i) => FIRST_CHAR + i));

/**
 * Characters the stat-number face can be asked to draw: everything formatCount, formatPercent,
 * formatActiveHours, money.formatUsdTwoSignificant and plain integers can return.
 */
export const NUMBER_CHARS = ' $%,.0123456789<BKM';

/** Characters of every archetype name (the only text drawn at the 64 px size). */
export const DISPLAY_CHARS = uniqueSorted([...ARCHETYPES, GENERALIST].map((a) => a.name).join('') + ' ');

/** Characters of the wordmark (the only text drawn in the semibold 18 px face). */
export const WORDMARK_CHARS = uniqueSorted(WORDMARK + ' ');

/** @param {string} s */
function uniqueSorted(s) { return [...new Set(s)].sort().join(''); }

/**
 * Faces in the atlas: one per (weight, pixel size). Pixel sizes are the logical sizes of
 * CARD_FONT_SIZES times CARD_SCALE (2); layout.js names them by id. Text sizes carry all of
 * printable ASCII. The two display sizes carry only the characters the card can draw there,
 * and so does the wordmark face, which keeps the atlas small enough for the single-file bundle (DESIGN 8.3); drawing any
 * other character at those sizes throws, and the layout tests draw every archetype name and
 * every number shape.
 */
export const FACES = Object.freeze([
  { id: 'display', weight: 'semibold', px: 128, chars: DISPLAY_CHARS }, // archetype name, 64 logical
  { id: 'number', weight: 'semibold', px: 112, chars: NUMBER_CHARS },   // stat numbers, 56 logical
  { id: 'line', weight: 'regular', px: 52, chars: PRINTABLE_ASCII },    // archetype line, 26 logical
  { id: 'label', weight: 'regular', px: 36, chars: PRINTABLE_ASCII },   // labels, strip, coverage, pills, 18 logical
  { id: 'strong', weight: 'semibold', px: 36, chars: WORDMARK_CHARS },  // wordmark, 18 logical
  { id: 'footer', weight: 'regular', px: 32, chars: PRINTABLE_ASCII },  // footer, 16 logical
]);

/* ------------------------------------------------------------------------------------------
 * Zip reading (stored and deflate entries only; that is all the release uses)
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {Buffer} zip
 * @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(zip, name) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const out = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!out) throw new Error('unsupported zip method ' + method + ' for ' + name);
    if (out.length !== size) throw new Error('size mismatch for ' + name);
    return out;
  }
  throw new Error('entry not found in zip: ' + name);
}

/* ------------------------------------------------------------------------------------------
 * TrueType parsing (glyf outlines, cmap format 4, hmtx; no hinting, no kerning)
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {Buffer} buf
 */
export function parseTtf(buf) {
  if (buf.readUInt32BE(0) !== 0x00010000) throw new Error('expected a TrueType (glyf) font');
  const numTables = buf.readUInt16BE(4);
  /** @type {Record<string, { offset: number, length: number }>} */
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const r = 12 + 16 * i;
    tables[buf.toString('latin1', r, r + 4)] = { offset: buf.readUInt32BE(r + 8), length: buf.readUInt32BE(r + 12) };
  }
  for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf', 'OS/2']) if (!tables[t]) throw new Error('missing table ' + t);
  const head = tables.head.offset;
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const indexToLocFormat = buf.readInt16BE(head + 50);
  const hhea = tables.hhea.offset;
  const ascender = buf.readInt16BE(hhea + 4);
  const descender = buf.readInt16BE(hhea + 6);
  const lineGap = buf.readInt16BE(hhea + 8);
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4);
  const os2 = tables['OS/2'].offset;
  const os2Version = buf.readUInt16BE(os2);
  const xHeight = os2Version >= 2 ? buf.readInt16BE(os2 + 86) : 0;
  const capHeight = os2Version >= 2 ? buf.readInt16BE(os2 + 88) : 0;

  const advance = (gid) => buf.readUInt16BE(tables.hmtx.offset + 4 * Math.min(gid, numberOfHMetrics - 1));
  const loca = (gid) => indexToLocFormat === 0
    ? buf.readUInt16BE(tables.loca.offset + 2 * gid) * 2
    : buf.readUInt32BE(tables.loca.offset + 4 * gid);

  // cmap: Windows Unicode BMP (3, 1), format 4.
  const cmap = tables.cmap.offset;
  let sub = -1;
  for (let i = 0, n = buf.readUInt16BE(cmap + 2); i < n; i++) {
    const r = cmap + 4 + 8 * i;
    if (buf.readUInt16BE(r) === 3 && buf.readUInt16BE(r + 2) === 1) sub = cmap + buf.readUInt32BE(r + 4);
  }
  if (sub < 0 || buf.readUInt16BE(sub) !== 4) throw new Error('no (3,1) format 4 cmap');
  const segX2 = buf.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  /** @param {number} code */
  const glyphIndex = (code) => {
    for (let s = 0; s < segX2; s += 2) {
      const end = buf.readUInt16BE(ends + s);
      if (code > end) continue;
      const start = buf.readUInt16BE(starts + s);
      if (code < start) return 0;
      const delta = buf.readInt16BE(deltas + s);
      const ro = buf.readUInt16BE(ranges + s);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = buf.readUInt16BE(ranges + s + ro + 2 * (code - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  /**
   * Outline of a glyph as contours of { x, y, on } points in font units.
   * @param {number} gid
   * @param {number} depth
   * @returns {{ x: number, y: number, on: boolean }[][]}
   */
  const outline = (gid, depth = 0) => {
    if (depth > 8) throw new Error('composite glyph nesting too deep');
    const start = loca(gid);
    const end = loca(gid + 1);
    if (end === start) return [];
    const g = tables.glyf.offset + start;
    const nc = buf.readInt16BE(g);
    if (nc >= 0) {
      const endPts = [];
      for (let i = 0; i < nc; i++) endPts.push(buf.readUInt16BE(g + 10 + 2 * i));
      const nPts = nc ? endPts[nc - 1] + 1 : 0;
      let p = g + 10 + 2 * nc;
      p += 2 + buf.readUInt16BE(p); // skip instructions
      const flags = [];
      while (flags.length < nPts) {
        const f = buf[p++];
        flags.push(f);
        if (f & 8) { let rep = buf[p++]; while (rep-- > 0) flags.push(f); }
      }
      const xs = new Array(nPts);
      const ys = new Array(nPts);
      let v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 2) { const d = buf[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += buf.readInt16BE(p); p += 2; }
        xs[i] = v;
      }
      v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 4) { const d = buf[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += buf.readInt16BE(p); p += 2; }
        ys[i] = v;
      }
      const contours = [];
      let s = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        contours.push(c);
        s = e + 1;
      }
      return contours;
    }
    // Composite glyph.
    const out = [];
    let p = g + 10;
    let more = true;
    while (more) {
      const flags = buf.readUInt16BE(p);
      const comp = buf.readUInt16BE(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); p += 4; } else { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); p += 2; }
      if (!(flags & 2)) throw new Error('composite glyph with point-matched offsets is not supported');
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o) => buf.readInt16BE(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of outline(comp, depth + 1)) {
        out.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
      }
      more = (flags & 0x20) !== 0;
    }
    return out;
  };

  return { unitsPerEm, ascender, descender, lineGap, capHeight, xHeight, numGlyphs, glyphIndex, advance, outline };
}

/* ------------------------------------------------------------------------------------------
 * Rasterizer: exact signed-area accumulation (the font-rs method), non-zero fill clamped to 1
 * ---------------------------------------------------------------------------------------- */

class Accumulator {
  /** @param {number} w @param {number} h */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.a = new Float64Array(w * h + 4);
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
  line(x0, y0, x1, y1) {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) { dir = -1; [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) x -= y0 * dxdy;
    const yStart = Math.max(0, Math.floor(y0));
    const yEnd = Math.min(this.h, Math.ceil(y1));
    const a = this.a;
    for (let y = yStart; y < yEnd; y++) {
      const row = y * this.w;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = x < xnext ? x : xnext;
      const xb = x < xnext ? xnext : x;
      const xaFloor = Math.floor(xa);
      const xai = xaFloor;
      const xbi = Math.ceil(xb);
      if (xbi <= xai + 1) {
        const xmf = 0.5 * (x + xnext) - xaFloor;
        a[row + xai] += d - d * xmf;
        a[row + xai + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const xaf = xa - xaFloor;
        const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
        const xbf = xb - xbi + 1;
        const am = 0.5 * s * xbf * xbf;
        a[row + xai] += d * a0;
        if (xbi === xai + 2) {
          a[row + xai + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - xaf);
          a[row + xai + 1] += d * (a1 - a0);
          for (let xi = xai + 2; xi < xbi - 1; xi++) a[row + xi] += d * s;
          const a2 = a1 + (xbi - xai - 3) * s;
          a[row + xbi - 1] += d * (1 - a2 - am);
        }
        a[row + xbi] += d * am;
      }
      x = xnext;
    }
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
  quad(x0, y0, x1, y1, x2, y2) {
    const devx = x0 - 2 * x1 + x2;
    const devy = y0 - 2 * y1 + y2;
    const devsq = devx * devx + devy * devy;
    if (devsq < 0.333) { this.line(x0, y0, x2, y2); return; }
    const n = 1 + Math.floor(Math.sqrt(Math.sqrt(3 * devsq)));
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const mt = 1 - t;
      const qx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
      const qy = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
      this.line(px, py, qx, qy);
      px = qx; py = qy;
    }
  }

  /** @returns {Uint8Array} */
  coverage() {
    const out = new Uint8Array(this.w * this.h);
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      // The accumulator runs along each row; the sum returns to zero at the end of a row
      // for a closed outline, so it can run across rows. Reset per row anyway for safety.
      if (i % this.w === 0) acc = 0;
      acc += this.a[i];
      const c = Math.min(1, Math.abs(acc));
      out[i] = Math.round(c * 255);
    }
    return out;
  }
}

/**
 * Rasterize one glyph at a pixel size. Pen origin at (0, 0) on the baseline, y down.
 * @param {ReturnType<typeof parseTtf>} font
 * @param {number} code
 * @param {number} px
 */
export function rasterizeGlyph(font, code, px) {
  const gid = font.glyphIndex(code);
  if (gid === 0) throw new Error('font has no glyph for U+' + code.toString(16));
  const scale = px / font.unitsPerEm;
  const advance64 = Math.round(font.advance(gid) * scale * 64);
  const contours = font.outline(gid);
  if (!contours.length) return { code, advance64, left: 0, top: 0, w: 0, h: 0, data: new Uint8Array(0) };
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const c of contours) for (const p of c) {
    const x = p.x * scale, y = -p.y * scale;
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const left = Math.floor(xMin);
  const top = Math.floor(yMin);
  const w = Math.ceil(xMax) - left + 1;
  const h = Math.ceil(yMax) - top + 1;
  const acc = new Accumulator(w, h);
  const tx = (x) => x * scale - left;
  const ty = (y) => -y * scale - top;
  for (const c of contours) {
    const n = c.length;
    if (n < 2) continue;
    // Start at an on-curve point, or at the midpoint of the first two off-curve points.
    let startIdx = c.findIndex((p) => p.on);
    let sx, sy;
    if (startIdx >= 0) { sx = tx(c[startIdx].x); sy = ty(c[startIdx].y); } else {
      startIdx = 0;
      sx = (tx(c[0].x) + tx(c[1].x)) / 2;
      sy = (ty(c[0].y) + ty(c[1].y)) / 2;
    }
    let cx = sx, cy = sy;
    let ctrl = null;
    for (let k = 1; k <= n; k++) {
      const p = c[(startIdx + k) % n];
      const px2 = tx(p.x), py2 = ty(p.y);
      if (p.on) {
        if (ctrl) acc.quad(cx, cy, ctrl[0], ctrl[1], px2, py2); else acc.line(cx, cy, px2, py2);
        cx = px2; cy = py2; ctrl = null;
      } else if (ctrl) {
        const mx = (ctrl[0] + px2) / 2, my = (ctrl[1] + py2) / 2;
        acc.quad(cx, cy, ctrl[0], ctrl[1], mx, my);
        cx = mx; cy = my; ctrl = [px2, py2];
      } else {
        ctrl = [px2, py2];
      }
    }
    if (ctrl) acc.quad(cx, cy, ctrl[0], ctrl[1], sx, sy); else if (cx !== sx || cy !== sy) acc.line(cx, cy, sx, sy);
  }
  const data = acc.coverage();
  // Trim empty rows and columns so the atlas stays small.
  let r0 = 0, r1 = h - 1, c0 = 0, c1 = w - 1;
  const rowEmpty = (r) => { for (let i = 0; i < w; i++) if (data[r * w + i]) return false; return true; };
  const colEmpty = (col) => { for (let r = r0; r <= r1; r++) if (data[r * w + col]) return false; return true; };
  while (r0 <= r1 && rowEmpty(r0)) r0++;
  while (r1 >= r0 && rowEmpty(r1)) r1--;
  if (r0 > r1) return { code, advance64, left: 0, top: 0, w: 0, h: 0, data: new Uint8Array(0) };
  while (c0 <= c1 && colEmpty(c0)) c0++;
  while (c1 >= c0 && colEmpty(c1)) c1--;
  const tw = c1 - c0 + 1, th = r1 - r0 + 1;
  const trimmed = new Uint8Array(tw * th);
  for (let r = 0; r < th; r++) trimmed.set(data.subarray((r + r0) * w + c0, (r + r0) * w + c0 + tw), r * tw);
  return { code, advance64, left: left + c0, top: top + r0, w: tw, h: th, data: trimmed };
}

/* ------------------------------------------------------------------------------------------
 * Atlas serialization (format documented in src/core/card/atlas.js)
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {{ regular: ReturnType<typeof parseTtf>, semibold: ReturnType<typeof parseTtf> }} fonts
 * @returns {Buffer} uncompressed atlas bytes
 */
export function buildAtlas(fonts) {
  const parts = [];
  const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v); parts.push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
  parts.push(Buffer.from('AWG1', 'latin1'));
  u16(FACES.length);
  for (const face of FACES) {
    const font = fonts[face.weight];
    const scale = face.px / font.unitsPerEm;
    u8(face.id.length);
    parts.push(Buffer.from(face.id, 'latin1'));
    u16(face.px);
    i32(Math.round(font.ascender * scale * 64));
    i32(Math.round(font.descender * scale * 64));
    i32(Math.round(font.capHeight * scale * 64));
    i32(Math.round(font.xHeight * scale * 64));
    const codes = [...new Set(face.chars)].map((ch) => ch.charCodeAt(0)).sort((a, b) => a - b);
    for (const code of codes) if (code < FIRST_CHAR || code > LAST_CHAR) throw new Error('atlas characters must be printable ASCII');
    u16(codes.length);
    for (const code of codes) {
      const g = rasterizeGlyph(font, code, face.px);
      u8(code);
      i32(g.advance64);
      i16(g.left);
      i16(g.top);
      u16(g.w);
      u16(g.h);
      parts.push(Buffer.from(g.data));
    }
  }
  return Buffer.concat(parts);
}

/**
 * @param {Buffer} compressed
 * @param {number} rawBytes
 * @returns {string}
 */
function glyphsModule(compressed, rawBytes) {
  const b64 = compressed.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 100) lines.push("  '" + b64.slice(i, i + 100) + "'");
  return [
    '// GENERATED by scripts/build-glyphs.mjs. Do not edit by hand; regenerate and commit.',
    '//',
    '// Glyph atlas for the share card, pre-rasterized from the Inter typeface: printable ASCII at',
    '// the text sizes, and only the characters the card draws at the display sizes (FACES).',
    '// ' + FONT_SOURCE.copyright,
    '// Inter is licensed under the SIL Open Font License, Version 1.1. This atlas is a derived',
    '// form of the font and is distributed under the same license; the full license text is',
    '// in the NOTICE file. Source: ' + FONT_SOURCE.release,
    '//',
    '// Format: raw deflate of the layout documented in atlas.js. glyphs.bin holds the same bytes.',
    '',
    'export const FONT_INFO = Object.freeze({',
    "  family: '" + FONT_SOURCE.family + "',",
    "  version: '" + FONT_SOURCE.version + "',",
    "  license: '" + FONT_SOURCE.license + "',",
    "  copyright: '" + FONT_SOURCE.copyright + "',",
    "  source: '" + FONT_SOURCE.release + "',",
    '});',
    '',
    '/** SHA-256 of the compressed atlas bytes (glyphs.bin). */',
    "export const GLYPH_ATLAS_SHA256 = '" + crypto.createHash('sha256').update(compressed).digest('hex') + "';",
    '',
    '/** Size of the atlas after inflating. */',
    'export const GLYPH_ATLAS_RAW_BYTES = ' + rawBytes + ';',
    '',
    '/** Raw-deflate compressed atlas, base64. */',
    'export const GLYPH_ATLAS_BASE64 = (',
    lines.join(' +\n'),
    ');',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------- */

/** @param {Buffer|Uint8Array} b */
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * @param {string} zipPath
 * @returns {{ bin: Buffer, js: string, license: string, raw: Buffer }}
 */
export function generate(zipPath) {
  const zip = fs.readFileSync(zipPath);
  const zipHash = sha256(zip);
  if (zipHash !== FONT_SOURCE.zipSha256) {
    throw new Error('Inter zip SHA-256 mismatch: got ' + zipHash + ', pinned ' + FONT_SOURCE.zipSha256 + '. Download ' + FONT_SOURCE.asset);
  }
  const files = {};
  for (const [key, spec] of Object.entries(ZIP_FILES)) {
    const data = readZipEntry(zip, spec.name);
    if (sha256(data) !== spec.sha256) throw new Error('SHA-256 mismatch for ' + spec.name);
    files[key] = data;
  }
  const fonts = { regular: parseTtf(files.regular), semibold: parseTtf(files.semibold) };
  const raw = buildAtlas(fonts);
  const bin = zlib.deflateRawSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY });
  return { bin, js: glyphsModule(bin, raw.length), license: files.license.toString('utf8'), raw };
}

function main(argv) {
  let zipPath = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zip') zipPath = argv[++i];
    else if (argv[i] === '--check') check = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: node scripts/build-glyphs.mjs --zip <Inter-4.1.zip> [--check]\n');
      return 0;
    } else throw new Error('unknown argument: ' + argv[i]);
  }
  if (!zipPath) throw new Error('--zip <path to Inter-4.1.zip> is required (download: ' + FONT_SOURCE.asset + ')');
  const { bin, js, license, raw } = generate(zipPath);
  const notice = fs.existsSync(NOTICE) ? fs.readFileSync(NOTICE, 'utf8') : '';
  const noticeOk = notice.includes(license.trimEnd());
  if (check) {
    const problems = [];
    // Compare the INFLATED atlas: the pixels must match exactly, while the compressed bytes may
    // legitimately differ between zlib builds. glyphs.js must carry exactly glyphs.bin.
    const committed = fs.existsSync(OUT_BIN) ? fs.readFileSync(OUT_BIN) : null;
    if (!committed) problems.push('src/core/card/glyphs.bin is missing');
    else if (!zlib.inflateRawSync(committed).equals(raw)) problems.push('src/core/card/glyphs.bin does not match a fresh rasterization');
    if (committed && (!fs.existsSync(OUT_JS) || fs.readFileSync(OUT_JS, 'utf8') !== glyphsModule(committed, raw.length))) {
      problems.push('src/core/card/glyphs.js does not match glyphs.bin');
    }
    if (committed && !committed.equals(bin)) process.stdout.write('build-glyphs: note: compressed bytes differ from this zlib build (pixels compared, not bytes)\n');
    if (!noticeOk) problems.push('NOTICE does not contain the Inter LICENSE.txt text verbatim');
    for (const p of problems) process.stderr.write('build-glyphs: ' + p + '\n');
    process.stdout.write('build-glyphs --check: ' + (problems.length ? 'FAIL' : 'ok') + ' (' + raw.length + ' bytes raw, ' + bin.length + ' compressed)\n');
    return problems.length ? 1 : 0;
  }
  fs.writeFileSync(OUT_BIN, bin);
  fs.writeFileSync(OUT_JS, js);
  process.stdout.write('build-glyphs: wrote glyphs.bin (' + bin.length + ' bytes, ' + raw.length + ' raw) and glyphs.js\n');
  if (!noticeOk) process.stdout.write('build-glyphs: WARNING NOTICE does not yet contain the Inter license text verbatim\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('build-glyphs: ' + /** @type {Error} */ (err).message + '\n');
    process.exitCode = 1;
  }
}
