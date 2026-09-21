// PNG writer for the share card (DESIGN 8.7). Writes IHDR, IDAT and IEND with a pure-JS CRC32.
// The zlib stream comes from an injected deflateSync (node:zlib in src/node); the core stays
// isomorphic (no node:*, no DOM). The browser path does not use this file: it hands the same
// RGBA buffer to a canvas and calls toBlob.
//
// No metadata chunks are written (no text, time or software chunks): the file carries pixels
// only. An image whose every alpha is 255 is written as RGB (color type 2); anything else as
// RGBA (color type 6). Rows use the standard adaptive filter choice (minimum sum of absolute
// differences), which is deterministic.

/**
 * @typedef {import('./contract.js').RasterImage} RasterImage
 * @typedef {(bytes: Uint8Array) => Uint8Array} DeflateSync  zlib-wrapped deflate (RFC 1950)
 */

export const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = /** @type {Uint32Array|null} */ (null);

function table() {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  return crcTable;
}

/**
 * CRC-32 (ISO 3309, the PNG and zlib polynomial).
 * @param {Uint8Array} bytes
 * @param {number} [crc] running value from a previous call
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes, crc = 0) {
  const t = table();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type 4 ASCII letters
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Filtered scanlines (filter byte + row) for the given channel count.
 * @param {RasterImage} image
 * @param {number} channels 3 or 4
 * @returns {Uint8Array}
 */
export function filterScanlines(image, channels) {
  const { width, height, data } = image;
  const stride = width * channels;
  const out = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    // Extract the row in the output channel layout.
    const src = y * width * 4;
    if (channels === 4) cur.set(data.subarray(src, src + stride));
    else for (let x = 0, o = 0; x < width; x++, o += 3) { const i = src + x * 4; cur[o] = data[i]; cur[o + 1] = data[i + 1]; cur[o + 2] = data[i + 2]; }
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = prev[i];
        const cc = i >= channels ? prev[i - channels] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >>> 1;
        else if (f === 4) {
          const p = a + b - cc;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        }
        const v = (cur[i] - pred) & 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    const o = y * (stride + 1);
    out[o] = best;
    out.set(cand[best], o + 1);
    const t = prev; prev = cur; cur = t;
  }
  return out;
}

/**
 * Encode a RasterImage as a PNG file.
 * @param {RasterImage} image
 * @param {{ deflateSync: DeflateSync }} deps
 * @returns {Uint8Array}
 */
export function encodePng(image, deps) {
  if (!image || !(image.data instanceof Uint8ClampedArray)) throw new TypeError('image.data must be a Uint8ClampedArray');
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new RangeError('bad image size');
  if (data.length !== width * height * 4) throw new RangeError('image.data length must be width * height * 4');
  if (!deps || typeof deps.deflateSync !== 'function') throw new TypeError('encodePng needs deps.deflateSync (zlib format)');
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;                   // bit depth
  ihdr[9] = opaque ? 2 : 6;      // color type: RGB or RGBA
  ihdr[10] = 0;                  // deflate
  ihdr[11] = 0;                  // adaptive filtering
  ihdr[12] = 0;                  // no interlace
  const idat = deps.deflateSync(filterScanlines(image, channels));
  const zdata = idat instanceof Uint8Array ? idat : new Uint8Array(idat);
  const parts = [Uint8Array.from(PNG_SIGNATURE), pngChunk('IHDR', ihdr), pngChunk('IDAT', zdata), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
