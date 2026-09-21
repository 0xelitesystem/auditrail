// The share card, v2 (DESIGN 7.1 to 7.4, 8.7, 9.7): a receipt, not a report. One hero (archetype
// and the headline value drawn large), one signature visual (the 7 x 24 heatmap), four plain-
// English stats, no dead space; layout, raster, PNG encoding, both palettes at WCAG AA by math,
// the PublicSummary-only boundary and the footer branding.
//
// The checks that matter are done independently of the code under test: the PNG is parsed,
// CRC-checked with a bitwise CRC-32 written here, inflated with node:zlib and unfiltered here;
// contrast is recomputed here from the WCAG 2.x formula; text boxes are the glyph ink read from
// the atlas here. Everything is fictional; the showcase persona is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  CARD_SIZES, CARD_SCALE, CARD_GRID, CARD_THEMES, CARD_HEAT, HEAT_MIN_CONTRAST, HEAT_MIN_ADJACENT, TEXT_ROLES, MIN_CONTRAST, WORDMARK, contrastRatio,
} from '../../src/core/card/contract.js';
import {
  layoutCard, renderCard, statSpecs, textWidth, inkExtent, CARD_BRAND, CARD_FIXED_COPY, DEMO_MARK, HEAT_DAYS, HEAT_TICKS, STAT_FIELDS, HERO_SCALES,
} from '../../src/core/card/layout.js';
import { parseHex, createImage, blendPixel, fillRect, fillRoundRect, drawPill, drawText, drawTextScaled } from '../../src/core/card/raster.js';
import { encodePng, crc32, PNG_SIGNATURE } from '../../src/core/card/png.js';
import { getFace, glyphsFor, measureText, GlyphError } from '../../src/core/card/atlas.js';
import {
  toPublicSummary, buildManifest, PublicSummaryError, PUBLIC_FIELDS, ARCHETYPE_IDS, archetypeInfo, HEAT_LEVELS, HEATMAP_TITLE,
} from '../../src/core/public.js';
import { buildSummary } from '../../src/core/summary.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { createSecretScanner } from '../../src/core/secrets.js';
import { makeSummary, SAMPLE_TABLE_MODELS } from '../helpers/sample-summary.js';
import { runPipeline, FIXTURES } from '../accounting/_harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SIZES = ['landscape', 'portrait'];
const THEMES = ['dark', 'light'];
const PRICE_TABLE = { models: SAMPLE_TABLE_MODELS };
const REPO_URL_TEXT = 'github.com/0xelitesystem/auditrail';
const NOW = Date.UTC(2026, 8, 14);

/** A fictional weekday by hour prompt pattern: mornings, afternoons, late evenings, quiet weekends. */
const HEAT_COUNTS = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => Math.floor(((h >= 9 && h <= 12) ? 6 : (h >= 14 && h <= 18) ? 4 : h >= 21 ? 8 : 0) * (d >= 5 ? 0.5 : 1)) + ((d * 7 + h) % 5 === 0 ? 1 : 0)));

/** The sample Summary with the heatmap filled in (the helper's is all zero). */
function sampleSummary() {
  const s = makeSummary();
  s.insights.i09.data.heatmap = HEAT_COUNTS.map((r) => [...r]);
  return s;
}
const samplePs = (opts = {}) => toPublicSummary(sampleSummary(), { priceTable: PRICE_TABLE, ...opts });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textOps = (layout) => layout.ops.filter((o) => o.kind === 'text');
const EPS = 1e-6;

/** Hide sets every layout test runs over: full card, and each block missing in turn. */
const HIDE_SETS = [[], ['value'], ['heatmap'], ['archetype', 'badges'], ['heatmap', 'peak-hour'], ['active-hours', 'tools', 'streak', 'delegation'], ['value', 'output-tokens'], ['coverage', 'badges']];

/* ------------------------------------------------------------------------------------------
 * Independent helpers: bitwise CRC-32, PNG chunk parser and scanline unfilter, WCAG contrast,
 * glyph ink boxes read from the atlas
 * ---------------------------------------------------------------------------------------- */

function crcBitwise(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function parsePng(png) {
  const buf = Buffer.from(png);
  const chunks = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    const crc = buf.readUInt32BE(o + 8 + len);
    chunks.push({ type, data, crc, crcInput: buf.subarray(o + 4, o + 8 + len) });
    o += 12 + len;
  }
  assert.equal(o, buf.length, 'chunks end exactly at the end of the file');
  return { signature: [...buf.subarray(0, 8)], chunks };
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  assert.equal(raw.length, (stride + 1) * height, 'one filter byte per row');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = y > 0 ? out[o - stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[o - stride + i - bpp] : 0;
      let p;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error('filter type ' + f + ' is not a PNG filter');
      out[o + i] = (raw[src + i] + p) & 0xff;
    }
  }
  return out;
}

/** Decode a PNG written by encodePng and return its pixels as RGBA. */
function decodePng(png) {
  const { chunks } = parsePng(png);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bpp = ihdr[9] === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const px = unfilter(raw, width, height, bpp);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += bpp) {
    rgba[i] = px[j]; rgba[i + 1] = px[j + 1]; rgba[i + 2] = px[j + 2]; rgba[i + 3] = bpp === 4 ? px[j + 3] : 255;
  }
  return { width, height, rgba };
}

/** WCAG 2.x relative luminance and contrast, written out here (not the contract's helper). */
function luminance(hex) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Ink box of an op in logical px, from the atlas glyph bitmaps (the pixels that can be painted). */
function inkBox(op) {
  if (op.kind !== 'text') return { x0: op.x, x1: op.x + op.w, y0: op.y, y1: op.y + op.h, what: op.kind };
  let up = 0, down = 0;
  for (const g of glyphsFor(getFace(op.face), op.text)) { up = Math.max(up, -g.top); down = Math.max(down, g.top + g.h); }
  const s = op.scale / CARD_SCALE;
  return { x0: op.x, x1: op.x + op.width, y0: op.y - up * s, y1: op.y + down * s, what: op.text };
}
const overlaps = (a, b) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;

/** Largest horizontal band (logical px) between the top and bottom margins with nothing drawn in it. */
function largestEmptyBand(L) {
  const iv = L.ops.map(inkBox).map((b) => [b.y0, b.y1]).sort((a, b) => a[0] - b[0]);
  let end = CARD_GRID.margin;
  let gap = 0;
  for (const [a, b] of iv) { gap = Math.max(gap, a - end); end = Math.max(end, b); }
  return Math.max(gap, L.height - CARD_GRID.margin - end);
}

const pixel = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
const heroValueOp = (L) => textOps(L).find((o) => o.face === 'number' && (o.field === 'value' || o.field === 'outputTokens'));

/* ------------------------------------------------------------------------------------------
 * Palettes at WCAG AA, by math
 * ---------------------------------------------------------------------------------------- */

test('palettes: every text role reaches 4.5:1 on the background, and the pill lettering on the accent, both themes', () => {
  for (const theme of THEMES) {
    const p = CARD_THEMES[theme];
    for (const role of TEXT_ROLES) {
      const r = contrast(p[role], p.background);
      assert.ok(r >= MIN_CONTRAST, `${theme}.${role} ${p[role]} on ${p.background} = ${r.toFixed(3)}`);
      assert.ok(Math.abs(r - contrastRatio(p[role], p.background)) < 1e-12, 'the contract helper agrees with the formula');
    }
    // Badge pills are filled with the accent and lettered in the background color.
    assert.ok(contrast(p.background, p.accent) >= MIN_CONTRAST, theme + ' pill lettering');
  }
  assert.equal(MIN_CONTRAST, 4.5, 'WCAG 2.x AA for normal text');
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.deepEqual(CARD_THEMES.dark, { background: '#0a0a0a', text: '#f2f2f2', accent: '#d4ff3a', secondary: '#a3a3a3' });
  assert.deepEqual(CARD_THEMES.light, { background: '#e8ebef', text: '#0a0a0a', accent: '#2d6b00', secondary: '#4a5260' });
});

test('palettes: empty vs the lowest data level and every data level vs the ground reach 3:1 (WCAG 1.4.11)', () => {
  assert.equal(HEAT_MIN_CONTRAST, 3);
  assert.equal(HEAT_MIN_ADJACENT, 1.4);
  for (const theme of THEMES) {
    const p = CARD_THEMES[theme];
    const levels = CARD_HEAT[theme];
    assert.equal(levels.length, HEAT_LEVELS + 1, theme + ': one color per level, 0 included');
    // 1. The boundary that carries meaning on a flat PNG: no activity vs some activity.
    const emptyVsLowest = contrast(levels[0], levels[1]);
    assert.ok(emptyVsLowest >= HEAT_MIN_CONTRAST, `${theme}: empty ${levels[0]} vs lowest data ${levels[1]} = ${emptyVsLowest.toFixed(2)}`);
    // 2. Every data level stands off the card background, and the levels are strictly ordered.
    const ratios = levels.map((c) => contrast(c, p.background));
    for (let lv = 1; lv <= HEAT_LEVELS; lv++) {
      assert.ok(ratios[lv] >= HEAT_MIN_CONTRAST, `${theme}: level ${lv} ${levels[lv]} vs background = ${ratios[lv].toFixed(2)}`);
    }
    for (let i = 1; i < ratios.length; i++) assert.ok(ratios[i] > ratios[i - 1] + 0.2, `${theme}: level ${i} (${ratios[i].toFixed(2)}) stands out more than level ${i - 1}`);
    // 3. Adjacent data levels are separated, at the best a five-level ramp can do (see CARD_HEAT).
    for (let lv = 2; lv <= HEAT_LEVELS; lv++) {
      const adj = contrast(levels[lv - 1], levels[lv]);
      assert.ok(adj >= HEAT_MIN_ADJACENT, `${theme}: level ${lv - 1} vs ${lv} = ${adj.toFixed(2)}`);
    }
    assert.ok(contrast(levels[0], p.background) > 1.1, theme + ': the empty track is visible against the ground');
  }
  // The dark ramp tops out at the accent; the light ramp runs past it, so the busiest light cell
  // is darker than the light accent rather than equal to it.
  assert.equal(CARD_HEAT.dark[HEAT_LEVELS], CARD_THEMES.dark.accent);
  assert.ok(contrast(CARD_HEAT.light[HEAT_LEVELS], CARD_THEMES.light.background) > contrast(CARD_THEMES.light.accent, CARD_THEMES.light.background));
  // Hand-checked anchors (WCAG formula).
  assert.equal(Math.round(contrast('#d4ff3a', '#0a0a0a') * 100) / 100, 17.12);
  assert.equal(Math.round(contrast('#5f711e', '#1e1e1e') * 100) / 100, 3.07);
  assert.equal(Math.round(contrast('#699326', '#f7f8fa') * 100) / 100, 3.41);
});

test('palettes: the rendered card uses exactly the theme colors, heat cells included', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const img = renderCard({ ps, size, theme });
      const p = CARD_THEMES[theme];
      assert.deepEqual(pixel(img, 0, 0), [...parseHex(p.background), 255], theme + ' corner is the background');
      assert.deepEqual(pixel(img, img.width - 1, img.height - 1), [...parseHex(p.background), 255], theme + ' far corner');
      const count = (hex) => { const [r, g, b] = parseHex(hex); let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) n++; return n; };
      assert.ok(count(p.accent) > 20000, `${size} ${theme}: accent pixels (hero, pills, busiest cells)`);
      assert.ok(count(p.text) > 2000, `${size} ${theme}: text pixels`);
      assert.ok(count(p.secondary) > 1000, `${size} ${theme}: secondary pixels`);
      // The center pixel of every cell is the color of its level.
      const cells = layoutCard(ps, size).ops.filter((o) => o.kind === 'cell');
      for (const c of cells) {
        const px = pixel(img, Math.floor((c.x + c.w / 2) * CARD_SCALE), Math.floor((c.y + c.h / 2) * CARD_SCALE));
        assert.deepEqual(px, [...parseHex(CARD_HEAT[theme][c.level]), 255], `${size} ${theme}: cell level ${c.level}`);
      }
    }
  }
});

/* ------------------------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------------------------- */

test('layout: every element inside the 56 px margins, no two ink boxes overlap, for every hide set', () => {
  for (const hide of HIDE_SETS) {
    const ps = samplePs({ hide });
    for (const size of SIZES) {
      const L = layoutCard(ps, size);
      const { width: W, height: H } = CARD_SIZES[size];
      const M = CARD_GRID.margin;
      assert.deepEqual([L.size, L.width, L.height], [size, W, H]);
      const boxes = L.ops.map(inkBox);
      for (const b of boxes) {
        assert.ok(b.x0 >= M - EPS && b.x1 <= W - M + EPS, `${size} ${hide}: "${b.what}" inside the side margins`);
        assert.ok(b.y0 >= M - EPS && b.y1 <= H - M + EPS, `${size} ${hide}: "${b.what}" inside the top and bottom margins`);
      }
      // Pills contain their own lettering; everything else is disjoint.
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = L.ops[i], b = L.ops[j];
          const pillText = (a.kind === 'pill' && b.kind === 'text' && b.field === 'badges') || (b.kind === 'pill' && a.kind === 'text' && a.field === 'badges');
          if (pillText) continue;
          assert.ok(!overlaps(boxes[i], boxes[j]), `${size} ${JSON.stringify(hide)}: "${boxes[i].what}" overlaps "${boxes[j].what}"`);
        }
      }
      for (const op of L.ops.filter((o) => o.kind === 'text' && o.field === 'badges')) {
        const pill = L.ops.find((p) => p.kind === 'pill' && op.x > p.x && op.x < p.x + p.w && op.y > p.y && op.y < p.y + p.h);
        assert.ok(pill && op.x + op.width <= pill.x + pill.w - 8, size + ': badge text sits inside its pill');
      }
    }
  }
});

test('layout: fills the canvas, no empty band taller than 7 percent of the card (12 with blocks hidden)', () => {
  for (const hide of HIDE_SETS) {
    const ps = samplePs({ hide });
    for (const size of SIZES) {
      const L = layoutCard(ps, size);
      const band = largestEmptyBand(L);
      const limit = hide.length === 0 ? 0.07 * L.height : 0.12 * L.height;
      assert.ok(band <= limit, `${size} ${JSON.stringify(hide)}: an empty band of ${band.toFixed(1)} px (limit ${limit.toFixed(1)})`);
    }
  }
});

test('layout: one giant hero; the archetype name and the headline value outsize everything else', () => {
  for (const size of SIZES) {
    const L = layoutCard(samplePs(), size);
    const t = textOps(L);
    const name = t.find((o) => o.field === 'archetype' && o.face === 'display');
    const value = heroValueOp(L);
    const lim = HERO_SCALES[size];
    assert.ok(name.scale > 1 && name.scale <= lim.name + EPS, size + ': the name is scaled up');
    assert.ok(value.scale >= lim.valueMin - EPS && value.scale <= lim.valueMax + EPS, size + ': value scale within its limits');
    assert.ok(value.scale >= 2, size + ': the headline is at least twice the stat number size');
    assert.equal(value.role, 'accent');
    assert.equal(name.role, 'accent');
    const em = (o) => getFace(o.face).px * o.scale;
    const others = t.filter((o) => o !== name && o !== value);
    assert.ok(Math.min(em(name), em(value)) > Math.max(...others.map(em)), size + ': nothing else is drawn as large');
    // The value's ink is the tallest thing on the card.
    const h = (o) => { const b = inkBox(o); return b.y1 - b.y0; };
    assert.ok(h(value) >= Math.max(...others.map(h), h(name)), size + ': the value is the tallest ink');
    assert.ok(h(value) >= (size === 'portrait' ? 0.14 : 0.16) * L.height, size + ': the value ink is ' + h(value).toFixed(1) + ' px');
  }
});

test('layout: every archetype name and line fits its column at a scale of at least 1', () => {
  const base = samplePs();
  for (const id of ARCHETYPE_IDS) {
    const ps = Object.freeze({ ...base, archetype: id });
    for (const size of SIZES) {
      const L = layoutCard(ps, size);
      const name = textOps(L).find((o) => o.face === 'display');
      assert.equal(name.text, archetypeInfo(id).name);
      assert.ok(name.scale >= 1, `${size} ${id}: scale ${name.scale}`);
      const colRight = size === 'landscape' ? CARD_GRID.margin + 616 : CARD_SIZES[size].width - CARD_GRID.margin;
      for (const o of textOps(L).filter((x) => x.field === 'archetype')) assert.ok(o.x + o.width <= colRight + EPS, `${size} ${id}: "${o.text}" within its column`);
    }
  }
});

test('layout: every headline shape fits (a few dollars to billions, and the output-token fallback)', () => {
  for (const usd of [1, 13, 999, 1500, 24000, 340000, 5600000, 99000000000]) {
    const s = sampleSummary();
    const nano = BigInt(Math.round(usd * 1e9)).toString();
    s.insights.i01.data.totalNano = nano;
    const ps = toPublicSummary(s, { priceTable: PRICE_TABLE });
    assert.equal(ps.value.shown, true);
    for (const size of SIZES) {
      const L = layoutCard(ps, size);
      const v = heroValueOp(L);
      for (const b of L.ops.map(inkBox)) assert.ok(b.x1 <= CARD_SIZES[size].width - CARD_GRID.margin + EPS, `${size} $${usd}: "${b.what}" within the right margin`);
      assert.ok(v.scale >= HERO_SCALES[size].valueMin - EPS, `${size} $${usd}: scale ${v.scale}`);
    }
  }
  const t = textOps(layoutCard(samplePs({ hide: ['value'] }), 'portrait'));
  assert.ok(t.some((o) => o.field === 'outputTokens' && o.text === '90K' && o.scale > 2), 'output tokens take the hero when the value is hidden');
});

test('layout: the heatmap is 7 x 24 equal square cells, Monday first, carrying the PublicSummary levels exactly', () => {
  const ps = samplePs();
  assert.equal(ps.heatmap.length, 7);
  for (const size of SIZES) {
    const L = layoutCard(ps, size);
    const cells = L.ops.filter((o) => o.kind === 'cell');
    assert.equal(cells.length, 168, size);
    assert.equal(new Set(cells.map((c) => c.w.toFixed(6) + 'x' + c.h.toFixed(6))).size, 1, size + ': one cell size');
    assert.ok(Math.abs(cells[0].w - cells[0].h) < EPS && cells[0].w >= 16, size + ': square cells at least 16 px');
    const xs = [...new Set(cells.map((c) => c.x.toFixed(6)))];
    const ys = [...new Set(cells.map((c) => c.y.toFixed(6)))];
    assert.deepEqual([xs.length, ys.length], [24, 7], size + ': 24 columns, 7 rows');
    cells.forEach((c, i) => assert.equal(c.level, ps.heatmap[Math.floor(i / 24)][i % 24], `${size}: cell ${i}`));
    const t = textOps(L);
    const days = t.filter((o) => HEAT_DAYS.includes(o.text));
    assert.deepEqual(days.map((d) => d.text), [...HEAT_DAYS]);
    days.forEach((d, r) => {
      const row = cells.filter((c) => Math.abs(c.y - Number(ys.sort((a, b) => a - b)[r])) < EPS);
      assert.ok(d.y > row[0].y && d.y < row[0].y + row[0].h + 1, size + ': ' + d.text + ' labels its row');
      assert.ok(d.x + d.width < row[0].x, size + ': day label left of the grid');
    });
    const ticks = t.filter((o) => HEAT_TICKS.some(([, label]) => label === o.text));
    assert.deepEqual(ticks.map((o) => o.text), HEAT_TICKS.map(([, l]) => l));
    for (const [h, label] of HEAT_TICKS) assert.ok(Math.abs(ticks.find((o) => o.text === label).x - cells[h].x) < EPS, size + ': tick ' + label);
    assert.ok(t.some((o) => o.field === 'heatmap' && o.text === HEATMAP_TITLE), size + ': title');
    const peak = t.find((o) => o.field === 'peakHourLocal');
    assert.equal(peak.text, 'busiest hour 9 PM');
    assert.ok(Math.abs(peak.x + peak.width - (cells[23].x + cells[23].w)) < EPS, size + ': busiest hour ends where the grid ends');
  }
  for (const size of SIZES) {
    const L = layoutCard(samplePs({ hide: ['heatmap'] }), size);
    assert.equal(L.ops.filter((o) => o.kind === 'cell').length, 0, size + ': hidden heatmap draws no cells');
    assert.ok(!textOps(L).some((o) => o.field === 'heatmap' || HEAT_DAYS.includes(o.text)), size + ': nor its labels');
    assert.ok(textOps(L).some((o) => o.field === 'peakHourLocal'), size + ': the busiest hour stays');
  }
});

test('layout: at most four plain-English stats, 2 x 2 in landscape and four across in portrait', () => {
  const ps = samplePs();
  const specs = statSpecs(ps);
  assert.deepEqual(specs.map((s) => s.field), [...STAT_FIELDS]);
  assert.deepEqual(specs.map((s) => s.number + ' | ' + s.label), [
    '12 | hours with your agent', '1.0K | actions by your agent', '15 | days in a row', '35% | of the work done by subagents',
  ]);
  for (const size of SIZES) {
    const t = textOps(layoutCard(ps, size));
    const nums = t.filter((o) => STAT_FIELDS.includes(o.field) && o.face === 'number');
    assert.deepEqual(nums.map((o) => o.field), [...STAT_FIELDS], size);
    assert.ok(nums.every((o) => o.scale === 1 && o.role === 'text'), size + ': stat numbers at the stat size in the text color');
    const cols = new Set(nums.map((o) => o.x.toFixed(6))).size;
    const rows = new Set(nums.map((o) => o.y.toFixed(6))).size;
    assert.deepEqual([cols, rows], size === 'landscape' ? [2, 2] : [4, 1], size);
    for (const n of nums) {
      const labels = t.filter((o) => o.field === n.field && o.face === 'label');
      assert.ok(labels.length >= 1 && labels.every((l) => Math.abs(l.x - n.x) < EPS && l.y > n.y), size + ': label under ' + n.text);
    }
  }
  // Fewer stats reflow: two left, both on one row in portrait.
  const two = textOps(layoutCard(samplePs({ hide: ['tools', 'delegation'] }), 'portrait')).filter((o) => o.face === 'number' && STAT_FIELDS.includes(o.field));
  assert.deepEqual(two.map((o) => o.field), ['activeHours', 'longestStreakDays']);
});

test('layout: no jargon on the card (tool names, cache hit rate, edit counts, rate-limit windows)', () => {
  for (const include of [[], ['rate-limits']]) {
    const ps = samplePs({ include });
    for (const size of SIZES) {
      const all = textOps(layoutCard(ps, size)).map((o) => o.text).join('\n');
      for (const banned of ['tool calls', 'cache hit rate', 'was edited', 'rate-limit', 'top model', 'Bash ', 'Read ', 'idle cutoff', 'peak hour', 'of value delegated']) {
        assert.ok(!all.includes(banned), `${size}: "${banned}" is not on the card`);
      }
    }
  }
});

test('layout: the wordmark is top left in the accent, the footer is the last block at the bottom margin', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    const L = layoutCard(ps, size);
    const t = textOps(L);
    const wm = t.find((o) => o.text === WORDMARK);
    assert.deepEqual([wm.x, wm.role, wm.field], [CARD_GRID.margin, 'accent', null], size);
    const bar = t.filter((o) => o === wm || o.field === 'coverage');
    const barBottom = Math.max(...bar.map((o) => inkBox(o).y1));
    assert.ok(L.ops.every((o) => bar.includes(o) || inkBox(o).y0 > barBottom), size + ': everything else sits below the top bar');
    const footer = t.filter((o) => o.field === 'footer' || o.text === CARD_BRAND);
    const lowest = Math.max(...t.map((o) => o.y));
    assert.equal(Math.max(...footer.map((o) => o.y)), lowest, size + ': the footer is the bottom row');
    const nonFooterBottom = Math.max(...L.ops.filter((o) => !footer.includes(o)).map((o) => inkBox(o).y1));
    assert.ok(Math.min(...footer.map((o) => inkBox(o).y0)) > nonFooterBottom, size + ': nothing sits between or below the footer rows');
    const lastInk = Math.max(...footer.filter((o) => o.y === lowest).map((o) => inkBox(o).y1));
    assert.ok(Math.abs(lastInk - (L.height - CARD_GRID.margin)) < EPS, size + ': the last footer line ends on the bottom margin');
  }
});

test('layout: every drawn string is fixed copy or a piece of its own manifest entry, and every manifest field is drawn', () => {
  for (const opts of [{}, { hide: ['value', 'badges', 'top-model'] }, { include: ['rate-limits'] }, { hide: ['heatmap'] }]) {
    const ps = samplePs(opts);
    const manifest = new Map(buildManifest(ps).map((e) => [e.field, e.text]));
    for (const size of SIZES) {
      const t = textOps(layoutCard(ps, size));
      for (const o of t) {
        if (o.field === null) assert.ok(CARD_FIXED_COPY.includes(o.text), `${size}: "${o.text}" is fixed copy`);
        else assert.ok(manifest.get(o.field).includes(o.text), `${size}: "${o.text}" is part of the ${o.field} manifest entry`);
      }
      const drawn = new Set(t.map((o) => o.field).filter((f) => f !== null));
      assert.deepEqual([...drawn].sort(), [...manifest.keys()].sort(), size + ' ' + JSON.stringify(opts) + ': the manifest is exactly what is drawn');
      for (const [field, text] of manifest) {
        const pieces = t.filter((o) => o.field === field).map((o) => o.text).join(' ');
        for (const w of text.split(' ')) {
          const word = w.replace(/[,:]$/, '');
          if (word && word !== '|') assert.ok(pieces.includes(word), `${size}: "${word}" of ${field} is on the card`);
        }
      }
    }
  }
  assert.deepEqual([...CARD_FIXED_COPY], [WORDMARK, CARD_BRAND, DEMO_MARK, ...HEAT_DAYS, ...HEAT_TICKS.map(([, l]) => l)]);
});

test('layout: hidden stats are not drawn; the headline falls back to output tokens', () => {
  const ps = samplePs({ hide: ['value', 'tools', 'badges', 'streak', 'heatmap'] });
  assert.equal(ps.value.shown, false);
  for (const size of SIZES) {
    const L = layoutCard(ps, size);
    const fields = new Set(textOps(L).map((o) => o.field));
    for (const f of ['value', 'toolCalls', 'badges', 'longestStreakDays', 'heatmap']) assert.ok(!fields.has(f), size + ': ' + f + ' hidden');
    assert.ok(!L.ops.some((o) => o.kind === 'pill' || o.kind === 'cell'), size + ': no pills, no cells');
    assert.ok(textOps(L).some((o) => o.field === 'outputTokens' && o.text === '90K'), '90,000 floored to "90K"');
  }
});

test('layout: text widths come from the atlas advance widths, scaled text scales them exactly', () => {
  for (const [face, text] of [['footer', CARD_BRAND], ['label', 'days in a row'], ['number', '1.0K']]) {
    assert.equal(textWidth(face, text), measureText(getFace(face), text) / CARD_SCALE, face);
    assert.ok(Math.abs(textWidth(face, text, 0, 3) - 3 * measureText(getFace(face), text) / CARD_SCALE) < 1e-9, face + ' x3');
  }
  assert.ok(Math.abs(textWidth('number', '$9', -1, 2) - (2 * measureText(getFace('number'), '$9') / CARD_SCALE - 1)) < 1e-9, 'tracking is not scaled');
  assert.ok(textWidth('footer', 'ii') < textWidth('footer', 'WW'), 'proportional font');
  // inkExtent reads the same glyph boxes as the independent helper here.
  const [up, down] = inkExtent('number', '$4.0K');
  const b = inkBox({ kind: 'text', face: 'number', text: '$4.0K', scale: 1, x: 0, y: 0, width: 0 });
  assert.deepEqual([up, down], [-b.y0, b.y1]);
  assert.ok(up > getFace('number').capHeight / CARD_SCALE, 'the dollar sign rises above the cap height');
});

/* ------------------------------------------------------------------------------------------
 * Raster
 * ---------------------------------------------------------------------------------------- */

test('raster: image size is logical size x 2, opaque, and identical on every run', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const a = renderCard({ ps, size, theme });
      assert.deepEqual([a.width, a.height], [CARD_SIZES[size].width * 2, CARD_SIZES[size].height * 2]);
      assert.equal(a.data.length, a.width * a.height * 4);
      assert.ok(a.data instanceof Uint8ClampedArray);
      for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== 255) assert.fail('pixel ' + (i >> 2) + ' is not opaque');
      const b = renderCard({ ps, size, theme });
      assert.equal(sha(a.data), sha(b.data), size + ' ' + theme + ' is deterministic');
    }
  }
  assert.notEqual(sha(renderCard({ ps, size: 'landscape', theme: 'dark' }).data), sha(renderCard({ ps, size: 'landscape', theme: 'light' }).data));
});

test('demo marker: drawn only when asked for, and it changes nothing else on the card', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const plain = [];
      const marked = [];
      const plainImg = renderCard({ ps, size, theme }, { onText: (text, info) => plain.push({ text, ...info }) });
      const markedImg = renderCard({ ps, size, theme, demo: true }, { onText: (text, info) => marked.push({ text, ...info }) });
      // The default card is exactly what it was: no marker, no pixel moved.
      assert.ok(!plain.some((t) => t.text === DEMO_MARK), size + '/' + theme + ': a normal card must not carry the marker');
      assert.ok(marked.some((t) => t.text === DEMO_MARK), size + '/' + theme + ': --demo-mark must draw the marker');
      // Every other string is drawn at exactly the same place, so the marker cannot push the
      // figures around or collide with the coverage line.
      const withoutMark = marked.filter((t) => t.text !== DEMO_MARK);
      assert.deepEqual(withoutMark.map((t) => [t.text, t.x, t.y]), plain.map((t) => [t.text, t.x, t.y]), size + '/' + theme);
      assert.notEqual(sha(markedImg.data), sha(plainImg.data), size + '/' + theme + ': the marker must be visible in the pixels');
    }
  }
  // It is fixed copy, so layoutCard's provenance check accepts it and it can never be data.
  assert.ok(CARD_FIXED_COPY.includes(DEMO_MARK));
  assert.match(DEMO_MARK, /DEMO DATA/);
});

test('raster: onText sees every string once, in draw order, at image-px positions and drawn sizes', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    const seen = [];
    renderCard({ ps, size, theme: 'dark' }, { onText: (text, info) => seen.push({ text, ...info }) });
    const ops = textOps(layoutCard(ps, size));
    assert.deepEqual(seen.map((s) => s.text), ops.map((o) => o.text), size);
    seen.forEach((s, i) => {
      assert.equal(s.x, ops[i].x * CARD_SCALE);
      assert.equal(s.y, Math.round(ops[i].y * CARD_SCALE));
      assert.equal(s.sizePx, getFace(ops[i].face).px * ops[i].scale);
      assert.equal(s.role, ops[i].role);
    });
    assert.ok(seen.some((s) => s.sizePx >= 224), size + ': hero text is drawn at 2x the atlas size or more');
  }
});

test('raster primitives: fill, blend, snapping, rounded corners and pills by hand', () => {
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const img = createImage(4, 3, [10, 20, 30]);
  assert.deepEqual(pixel(img, 3, 2), [10, 20, 30, 255]);
  // Half-covered white over black: (255 x 128 + 0 x 127 + 127) / 255 = 128.49, truncated to 128.
  const b = createImage(1, 1, black);
  blendPixel(b, 0, 0, white, 128);
  assert.deepEqual(pixel(b, 0, 0), [128, 128, 128, 255], 'the alpha of an opaque image stays 255');
  blendPixel(b, 5, 5, white, 255); // off the image: ignored, no throw
  blendPixel(b, 0, 0, black, 0);   // zero coverage: no change
  assert.deepEqual(pixel(b, 0, 0), [128, 128, 128, 255]);
  // fillRect snaps edges: x 0.4 to 2.4 -> columns 0 and 1; y 0.6 to 1.6 -> row 1 only.
  const r = createImage(4, 3, black);
  fillRect(r, 0.4, 0.6, 2, 1, white);
  const lit = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) if (pixel(r, x, y)[0] === 255) lit.push([x, y]);
  assert.deepEqual(lit, [[0, 1], [1, 1]]);
  // A 20 x 20 rounded rect with radius 10 is a disc: the corner pixel stays empty, the center is full.
  const c = createImage(20, 20, black);
  fillRoundRect(c, 0, 0, 20, 20, 10, white);
  assert.deepEqual(pixel(c, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(c, 10, 10), [255, 255, 255, 255]);
  const edge = pixel(c, 10, 0)[0];
  assert.ok(edge > 0 && edge <= 255, 'the top edge of the disc is covered');
  // An outlined pill keeps its middle; a filled one does not.
  const p = createImage(40, 12, black);
  drawPill(p, 0, 0, 40, 12, white, 2);
  assert.deepEqual(pixel(p, 20, 6), [0, 0, 0, 255], 'inside the outline');
  assert.deepEqual(pixel(p, 20, 0), [255, 255, 255, 255], 'the straight top edge');
  assert.ok(pixel(p, 0, 6)[0] > 0, 'the rounded left end');
  const f = createImage(40, 12, black);
  drawPill(f, 0, 0, 40, 12, white);
  assert.deepEqual(pixel(f, 20, 6), [255, 255, 255, 255], 'a filled pill');
  assert.deepEqual(pixel(f, 0, 0), [0, 0, 0, 255], 'with round ends');
});

test('raster: drawText advances by the atlas widths and fails closed on characters outside the atlas', () => {
  const face = getFace('label');
  const img = createImage(300, 60, [0, 0, 0]);
  const end = drawText(img, face, 'days in a row', 10, 40, [255, 255, 255]);
  assert.equal(end, 10 + measureText(face, 'days in a row'));
  let lit = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i]) lit++;
  assert.ok(lit > 100, 'glyph coverage was drawn');
  for (const bad of ['caf' + String.fromCharCode(0xe9), 'tab' + String.fromCharCode(9), String.fromCodePoint(0x1f600)]) {
    assert.throws(() => drawText(img, face, bad, 0, 40, [255, 255, 255]), GlyphError);
    assert.throws(() => drawTextScaled(img, face, bad, 0, 40, [255, 255, 255], 2), GlyphError);
  }
  // The display faces carry only what the card draws there.
  assert.throws(() => drawTextScaled(img, getFace('number'), 'PM', 0, 40, [255, 255, 255], 2), GlyphError);
});

test('raster: scaled text keeps the glyph shape, the advance and crisp edges', () => {
  const face = getFace('number');
  const white = [255, 255, 255];
  const stats = (img) => {
    let full = 0, partial = 0, ink = 0;
    for (let i = 0; i < img.data.length; i += 4) { const v = img.data[i]; if (v === 255) full++; else if (v) partial++; ink += v / 255; }
    return { full, partial, ink };
  };
  const one = createImage(200, 200, [0, 0, 0]);
  drawText(one, face, '8', 20, 150, white);
  const three = createImage(600, 600, [0, 0, 0]);
  const end = drawTextScaled(three, face, '8', 60, 450, white, 3);
  assert.equal(end, 60 + 3 * measureText(face, '8'), 'the pen advances by scale x the atlas advance');
  const a = stats(one), b = stats(three);
  const ratio = b.ink / a.ink / 9;
  assert.ok(ratio > 0.99 && ratio < 1.01, 'ink area grows by the scale squared: ' + ratio.toFixed(4));
  // Edge band width in output pixels, relative to the atlas edge (partial share x scale / atlas partial share).
  const band = (b.partial / (b.full + b.partial)) * 3 / (a.partial / (a.full + a.partial));
  assert.ok(band < 2.6, 'edges stay within about two and a half pixels at 3x, not 3x blurred: ' + band.toFixed(2));
  // Scale 1 is exactly drawText; scale below 1 is refused; same input, same pixels.
  const s1 = createImage(200, 200, [0, 0, 0]);
  drawTextScaled(s1, face, '8', 20, 150, white, 1);
  assert.equal(sha(s1.data), sha(one.data));
  assert.throws(() => drawTextScaled(s1, face, '8', 0, 100, white, 0.5), RangeError);
  const again = createImage(600, 600, [0, 0, 0]);
  drawTextScaled(again, face, '8', 60, 450, white, 3);
  assert.equal(sha(again.data), sha(three.data));
});

/* ------------------------------------------------------------------------------------------
 * PNG encoding
 * ---------------------------------------------------------------------------------------- */

test('png: CRC-32 check values (the standard "123456789" vector and the IEND chunk)', () => {
  const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  assert.equal(crcBitwise(ascii('123456789')), 0xcbf43926);
  assert.equal(crc32(ascii('IEND')), 0xae426082, 'every PNG ends in AE 42 60 82');
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(ascii('6789'), crc32(ascii('12345'))), 0xcbf43926);
});

test('png: a valid file (signature, IHDR, IDAT, IEND only, every CRC right) that decodes to the exact pixels', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const img = renderCard({ ps, size, theme });
      const png = encodePng(img, { deflateSync });
      assert.ok(png instanceof Uint8Array);
      const { signature, chunks } = parsePng(png);
      assert.deepEqual(signature, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
      assert.deepEqual([...PNG_SIGNATURE], signature);
      assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'], 'no text, time or software chunks');
      for (const c of chunks) assert.equal(c.crc, crcBitwise(c.crcInput), size + ' ' + theme + ' ' + c.type + ' CRC');
      const ihdr = chunks[0].data;
      assert.equal(ihdr.length, 13);
      assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)], [img.width, img.height]);
      assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], 'bit depth 8, RGB (opaque), deflate, adaptive filter, no interlace');
      assert.equal(chunks[2].data.length, 0);
      assert.equal(chunks[2].crc, 0xae426082);
      const dec = decodePng(png);
      assert.deepEqual([dec.width, dec.height], [img.width, img.height]);
      assert.equal(sha(dec.rgba), sha(img.data), size + ' ' + theme + ': the PNG round-trips to the rendered pixels');
    }
  }
});

test('png: translucent pixels switch to RGBA; bad input is refused', () => {
  const img = createImage(3, 2, [200, 100, 50]);
  img.data[3] = 128;
  img.data[4 * 5] = 7;
  const png = encodePng(img, { deflateSync });
  const ihdr = parsePng(png).chunks[0].data;
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]], [3, 2, 8, 6], 'RGBA');
  assert.deepEqual([...decodePng(png).rgba], [...img.data]);
  assert.throws(() => encodePng(img, {}), TypeError, 'deflate must be injected');
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8ClampedArray(3) }, { deflateSync }), RangeError);
  assert.throws(() => encodePng({ width: 0, height: 2, data: new Uint8ClampedArray(0) }, { deflateSync }), RangeError);
  assert.throws(() => encodePng({ width: 1, height: 1, data: new Uint8Array(4) }, { deflateSync }), TypeError, 'Uint8ClampedArray only');
});

test('png: the same pixels always encode to the same bytes', () => {
  const img = renderCard({ ps: samplePs(), size: 'portrait', theme: 'light' });
  assert.equal(sha(encodePng(img, { deflateSync })), sha(encodePng(img, { deflateSync })));
});

/* ------------------------------------------------------------------------------------------
 * The card renders ONLY PublicSummary fields
 * ---------------------------------------------------------------------------------------- */

test('boundary: the renderer refuses anything but { ps, size, theme } with an exact PublicSummary', () => {
  const ps = samplePs();
  assert.throws(() => renderCard({ ps, size: 'landscape', theme: 'dark', project: 'fake-alpha' }), TypeError);
  assert.throws(() => renderCard({ ps, size: 'square', theme: 'dark' }), TypeError);
  assert.throws(() => renderCard({ ps, size: 'landscape', theme: 'neon' }), TypeError);
  assert.throws(() => renderCard({ ps: { ...ps, projectLabel: 'fake-alpha' }, size: 'landscape', theme: 'dark' }), PublicSummaryError, 'an extra key');
  const { maxEditsOneFile, ...missing } = ps;
  assert.throws(() => renderCard({ ps: missing, size: 'landscape', theme: 'dark' }), PublicSummaryError, 'a missing key');
  assert.throws(() => renderCard({ ps: { ...ps, topModel: 'fake model' }, size: 'landscape', theme: 'dark' }), PublicSummaryError, 'a label outside the price table');
  assert.throws(() => renderCard({ ps: { ...ps, topTool: { name: 'mcp__fake__tool', share: 0.5 } }, size: 'landscape', theme: 'dark' }), PublicSummaryError);
  const badHeat = [
    ps.heatmap.slice(0, 6),
    ps.heatmap.map((r, i) => (i ? r : [...r.slice(0, 23), HEAT_LEVELS + 1])),
    ps.heatmap.map((r, i) => (i ? r : [...r.slice(0, 23), 0.5])),
    ps.heatmap.map((r, i) => (i ? r : r.slice(1))),
    'fake-alpha',
  ];
  for (const heatmap of badHeat) assert.throws(() => renderCard({ ps: { ...ps, heatmap }, size: 'landscape', theme: 'dark' }), PublicSummaryError, 'a malformed heatmap');
  assert.throws(() => layoutCard({ ...ps, extra: 1 }, 'landscape'), PublicSummaryError);
  assert.deepEqual(Object.keys(ps), [...PUBLIC_FIELDS]);
});

test('boundary: changing private Summary fields never changes a pixel; changing a public field does', () => {
  const base = sha(renderCard({ ps: samplePs(), size: 'landscape', theme: 'dark' }).data);
  const s = sampleSummary();
  s.insights.i01.data.byProject = [{ label: 'fake-private-project', valueNano: '1', responses: 1, sessions: 1 }];
  s.insights.i01.data.unpriced = [{ model: 'fake-private-model', responses: 1, tokens: 1 }];
  s.insights.i04.data.byAttribution.agent = [{ name: 'fake-private-agent', responses: 1, valueNano: '1' }];
  s.insights.i07.data.byTool = [{ name: 'mcp__fake__private', displayName: 'MCP tools', nameClass: 'mcp', calls: 1, paired: 1, ok: 1, denied: 0, shellExit: 0, failed: 0, unpaired: 0, failureRate: 0, longestFailRun: 0 }];
  s.insights.i08.data.top = [{ label: 'fake/private.js', edits: 23 }];
  s.insights.i11.data.findings = [{ secretType: 'github', fingerprint12: '0123456789ab', copies: 3, files: 2, newestLocalDate: '2026-03-16', severity: 'critical', source: 'user_text', expired: null, projectLabels: ['fake-private-project'] }];
  s.insights.i14.data.linesWritten = 999999;
  s.audit.agentVersions = ['9.9.9'];
  s.scan.bytes = 1;
  const same = sha(renderCard({ ps: toPublicSummary(s, { priceTable: PRICE_TABLE }), size: 'landscape', theme: 'dark' }).data);
  assert.equal(same, base, 'the card is a function of the PublicSummary only');
  const s2 = sampleSummary();
  s2.insights.i07.data.toolCalls = 2000;
  assert.notEqual(sha(renderCard({ ps: toPublicSummary(s2, { priceTable: PRICE_TABLE }), size: 'landscape', theme: 'dark' }).data), base, 'toolCalls is drawn');
  const s3 = sampleSummary();
  s3.insights.i09.data.heatmap[6][3] = 8;
  assert.notEqual(sha(renderCard({ ps: toPublicSummary(s3, { priceTable: PRICE_TABLE }), size: 'landscape', theme: 'dark' }).data), base, 'the heatmap is drawn');
  // Counts that keep every level leave the pixels alone: only levels reach the card.
  const s4 = sampleSummary();
  s4.insights.i09.data.heatmap = HEAT_COUNTS.map((r) => r.map((v) => v * 1000));
  assert.equal(sha(renderCard({ ps: toPublicSummary(s4, { priceTable: PRICE_TABLE }), size: 'landscape', theme: 'dark' }).data), base, 'scaled counts, same levels, same card');
});

test('boundary (DESIGN 9.7): from the canary logs to the card, no canary is ever handed to the rasterizer', async () => {
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canary', 'expected.json'), 'utf8'));
  const { result } = await runPipeline([path.join(FIXTURES, 'canary', 'projects'), path.join(FIXTURES, 'personas', 'subagent-lead', 'projects')], {
    tz: 'UTC', idleMinutes: 15, scanSecrets: createSecretScanner({ nowMs: NOW }),
  });
  const table = getPriceTable();
  const summary = buildSummary({
    acc: result, prices: table, toolVersion: '0.1.0', scanTakenAt: '2026-09-14T00:00:00.000Z', scanSeconds: null,
    options: { tz: 'UTC', idleMinutes: 15, nowMs: NOW },
  });
  for (const include of [[], ['rate-limits']]) {
    const ps = toPublicSummary(summary, { priceTable: table, include });
    assert.ok(ps.heatmap !== null, 'the canary run has prompts, so a heatmap');
    const manifest = new Map(buildManifest(ps).map((m) => [m.field, m.text]));
    for (const size of SIZES) {
      for (const theme of THEMES) {
        const drawn = [];
        renderCard({ ps, size, theme }, { onText: (text, info) => drawn.push({ text, field: info.field }) });
        const all = drawn.map((d) => d.text).join('\n');
        for (const [k, c] of Object.entries(e.canaries)) assert.ok(!all.includes(c.value), `canary ${k} drawn on the ${size} ${theme} card`);
        for (const d of drawn) {
          assert.ok(d.field === null ? CARD_FIXED_COPY.includes(d.text) : manifest.get(d.field).includes(d.text), `"${d.text}" has a public source`);
        }
        assert.ok(drawn.some((d) => d.field === 'toolCalls'), 'the card is not empty');
      }
    }
  }
});

/* ------------------------------------------------------------------------------------------
 * Footer branding and trust lines
 * ---------------------------------------------------------------------------------------- */

test('footer: carries the repo URL and elitesystem.ai on every size and theme, brand right-aligned', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.repository.url.includes(REPO_URL_TEXT), 'the footer URL is the package repository');
  assert.equal(CARD_BRAND, 'elitesystem.ai');
  const ps = samplePs();
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const drawn = [];
      const img = renderCard({ ps, size, theme }, { onText: (text, info) => drawn.push({ text, ...info }) });
      const url = drawn.filter((d) => d.text.includes(REPO_URL_TEXT));
      assert.equal(url.length, 1, `${size} ${theme}: the repo URL is drawn once, whole`);
      assert.equal(url[0].field, 'footer');
      const brand = drawn.filter((d) => d.text === CARD_BRAND);
      assert.equal(brand.length, 1, `${size} ${theme}: elitesystem.ai is drawn once`);
      assert.equal(brand[0].role, 'text');
      const W = CARD_SIZES[size].width;
      const right = brand[0].x / CARD_SCALE + textWidth('footer', CARD_BRAND);
      assert.ok(Math.abs(right - (W - CARD_GRID.margin)) < EPS, `${size}: brand ends at the right margin`);
      assert.equal(brand[0].y, url[0].y, size + ': brand and URL share the last footer line');
      assert.equal(Math.max(...drawn.map((d) => d.y)), brand[0].y);
      const [r, g, b] = parseHex(CARD_THEMES[theme].text);
      const face = getFace('footer');
      const x0 = Math.floor(brand[0].x), x1 = Math.ceil(brand[0].x + measureText(face, CARD_BRAND));
      let hits = 0;
      for (let y = brand[0].y - Math.ceil(face.capHeight); y <= brand[0].y; y++) {
        for (let x = x0; x < x1; x++) { const p = pixel(img, x, y); if (p[0] === r && p[1] === g && p[2] === b) hits++; }
      }
      assert.ok(hits > 20, `${size} ${theme}: brand pixels painted (${hits})`);
    }
  }
});

test('footer: the not-paid note and the scan receipt (rule A28) are on the card too', () => {
  const ps = samplePs();
  for (const size of SIZES) {
    const footer = textOps(layoutCard(ps, size)).filter((o) => o.field === 'footer').map((o) => o.text).join(' ');
    assert.match(footer, /API-equivalent value at list prices as of 2026-09-14\./);
    assert.match(footer, /Not what I paid\./);
    assert.match(footer, /Generated locally by auditrail \| github\.com\/0xelitesystem\/auditrail/);
    assert.match(footer, /Scanned 2026-03-16 09:00 UTC, 12 files/);
  }
});

/* ------------------------------------------------------------------------------------------
 * The synthetic showcase persona (scripts/fixtures/showcase.mjs)
 * ---------------------------------------------------------------------------------------- */

test('showcase: the synthetic power user adds up to its ground truth and renders a full Conductor card', async () => {
  const dir = path.join(FIXTURES, 'showcase', 'power-user');
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'ground-truth.json'), 'utf8'));
  assert.match(truth.description, /^Synthetic showcase persona/);
  const { result } = await runPipeline(path.join(dir, 'projects'), { tz: 'UTC', idleMinutes: 15 });
  const table = getPriceTable();
  const summary = buildSummary({
    acc: result, prices: table, toolVersion: '0.1.0', scanTakenAt: '2026-09-14T09:00:00.000Z', scanSeconds: null,
    options: { tz: 'UTC', idleMinutes: 15, nowMs: NOW },
  });
  assert.equal(summary.insights.i01.data.totalNano, truth.valueNano, 'value matches the generator ground truth to the nanodollar');
  assert.equal(summary.totals.responses, truth.responses);
  assert.equal(summary.insights.i09.data.longestStreakDays, truth.longestStreakDays);
  assert.equal(summary.insights.i09.data.peakHourLocal, truth.peakHourLocal);
  const ps = toPublicSummary(summary, { priceTable: table });
  assert.equal(ps.archetype, 'conductor');
  assert.ok(ps.value.shown && ps.value.atLeastUsd2sf >= 1000, 'a heavy user headline');
  assert.ok(ps.heatmap.flat().filter((v) => v > 0).length >= 60, 'a well-filled heatmap');
  for (const size of SIZES) {
    const L = layoutCard(ps, size);
    assert.ok(largestEmptyBand(L) <= 0.07 * L.height, size + ': fills the canvas');
    assert.equal(L.ops.filter((o) => o.kind === 'cell').length, 168);
    assert.equal(textOps(L).filter((o) => STAT_FIELDS.includes(o.field) && o.face === 'number').length, 4);
  }
});
