// Raw DEFLATE decoder (RFC 1951), synchronous and isomorphic. Used only to unpack the
// committed glyph atlas (glyphs.js); the core may not import node:zlib, and the browser's
// DecompressionStream is asynchronous. Canonical-Huffman decoding in the style of zlib's
// puff.c: small and easy to audit; speed is irrelevant for one 370 KB atlas.
//
// Tested against node:zlib deflateRawSync output in test/core/card-inflate.test.js.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InflateError';
  }
}

/**
 * @typedef {{ counts: Uint16Array, symbols: Uint16Array }} Huffman
 */

/**
 * Canonical Huffman table from code lengths.
 * @param {ArrayLike<number>} lengths
 * @returns {Huffman}
 */
function buildHuffman(lengths) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new InflateError('over-subscribed Huffman code');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

let fixedLit = /** @type {Huffman|null} */ (null);
let fixedDist = /** @type {Huffman|null} */ (null);

function fixedTables() {
  if (!fixedLit) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    fixedLit = buildHuffman(l);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5));
  }
  return { lit: /** @type {Huffman} */ (fixedLit), dist: /** @type {Huffman} */ (fixedDist) };
}

/**
 * Decompress a raw DEFLATE stream (no zlib or gzip header).
 * @param {Uint8Array} src
 * @param {number} [expectedSize]  exact output size when known (preallocates and is checked)
 * @returns {Uint8Array}
 */
export function inflateRaw(src, expectedSize) {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(expectedSize ?? Math.max(1024, src.length * 4));
  let outLen = 0;

  /** @param {number} n */
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new InflateError('unexpected end of input');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };

  /** @param {number} extra */
  const ensure = (extra) => {
    if (outLen + extra <= out.length) return;
    if (expectedSize !== undefined) throw new InflateError('output larger than expected');
    let cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, outLen));
    out = grown;
  };

  /** @param {Huffman} h */
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('invalid Huffman code');
  };

  /** @param {Huffman} lit @param {Huffman} dist */
  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError('invalid length symbol');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw new InflateError('invalid distance symbol');
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > outLen) throw new InflateError('distance too far back');
        ensure(len);
        for (let i = 0; i < len; i++, outLen++) out[outLen] = out[outLen - d];
      }
    }
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored block: drop the partial byte (fewer than 8 bits are ever buffered).
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new InflateError('unexpected end of input');
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if (len !== (~nlen & 0xffff)) throw new InflateError('stored block length check failed');
      if (pos + len > src.length) throw new InflateError('unexpected end of input');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1) {
      const t = fixedTables();
      codes(t.lit, t.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new InflateError('bad dynamic block counts');
      const clLengths = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) clLengths[CL_ORDER[i]] = bits(3);
      const cl = buildHuffman(clLengths);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(cl);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let rep = 0;
        let val = 0;
        if (sym === 16) {
          if (i === 0) throw new InflateError('repeat with no previous length');
          val = lengths[i - 1];
          rep = 3 + bits(2);
        } else if (sym === 17) {
          rep = 3 + bits(3);
        } else {
          rep = 11 + bits(7);
        }
        if (i + rep > nlen + ndist) throw new InflateError('too many code lengths');
        while (rep--) lengths[i++] = val;
      }
      if (lengths[256] === 0) throw new InflateError('no end-of-block code');
      codes(buildHuffman(lengths.subarray(0, nlen)), buildHuffman(lengths.subarray(nlen)));
    } else {
      throw new InflateError('invalid block type');
    }
  }
  if (expectedSize !== undefined && outLen !== expectedSize) throw new InflateError('output size ' + outLen + ', expected ' + expectedSize);
  return outLen === out.length ? out : out.slice(0, outLen);
}
