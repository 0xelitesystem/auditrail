// Pure-JS SHA-256 (FIPS 180-4), synchronous, isomorphic (no node:crypto, no WebCrypto).
//
// Used for counting without keeping text: file path hashes (rule A32), secret fingerprints
// (I11), hashed session ids in the ledger (8.9). Tested against the NIST example vectors
// and cross-checked against node:crypto in test/core/sha256.test.js.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

let sharedEncoder = null;

/**
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {Uint8Array}
 */
function toBytes(data) {
  if (typeof data === 'string') {
    if (sharedEncoder === null) sharedEncoder = new TextEncoder();
    return sharedEncoder.encode(data);
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('sha256 expects a string (hashed as UTF-8) or bytes');
}

/**
 * Incremental hasher.
 *
 * @typedef {Object} Sha256
 * @property {(data: string|Uint8Array|ArrayBuffer|ArrayBufferView) => Sha256} update  Strings are hashed as UTF-8.
 * @property {() => Uint8Array} digest     32-byte digest. The hasher cannot be updated afterwards.
 * @property {() => string} digestHex      64 lowercase hex characters.
 */

/** @returns {Sha256} */
export function createSha256() {
  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);
  const block = new Uint8Array(64);
  let blockLen = 0;
  let totalLen = 0; // bytes; exact up to 2^53
  let done = false;

  /** @param {Uint8Array} b @param {number} off */
  function compress(b, off) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  /** @type {Sha256} */
  const api = {
    update(data) {
      if (done) throw new Error('sha256: update after digest');
      const bytes = toBytes(data);
      let i = 0;
      totalLen += bytes.length;
      if (blockLen > 0) {
        const take = Math.min(64 - blockLen, bytes.length);
        block.set(bytes.subarray(0, take), blockLen);
        blockLen += take;
        i = take;
        if (blockLen === 64) { compress(block, 0); blockLen = 0; }
      }
      for (; i + 64 <= bytes.length; i += 64) compress(bytes, i);
      if (i < bytes.length) {
        block.set(bytes.subarray(i), 0);
        blockLen = bytes.length - i;
      }
      return api;
    },
    digest() {
      if (done) throw new Error('sha256: digest called twice');
      done = true;
      const bitsHi = Math.floor(totalLen / 0x20000000); // totalLen * 8 / 2^32
      const bitsLo = (totalLen * 8) >>> 0;
      block[blockLen++] = 0x80;
      if (blockLen > 56) {
        block.fill(0, blockLen);
        compress(block, 0);
        blockLen = 0;
      }
      block.fill(0, blockLen, 56);
      block[56] = bitsHi >>> 24; block[57] = bitsHi >>> 16; block[58] = bitsHi >>> 8; block[59] = bitsHi;
      block[60] = bitsLo >>> 24; block[61] = bitsLo >>> 16; block[62] = bitsLo >>> 8; block[63] = bitsLo;
      compress(block, 0);
      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i++) {
        out[i * 4] = h[i] >>> 24; out[i * 4 + 1] = h[i] >>> 16; out[i * 4 + 2] = h[i] >>> 8; out[i * 4 + 3] = h[i];
      }
      return out;
    },
    digestHex() {
      return toHex(api.digest());
    },
  };
  return api;
}

/**
 * One-shot SHA-256.
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} data  Strings are hashed as UTF-8.
 * @returns {Uint8Array} 32 bytes
 */
export function sha256(data) {
  return createSha256().update(data).digest();
}

/**
 * One-shot SHA-256 as 64 lowercase hex characters.
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} data  Strings are hashed as UTF-8.
 * @returns {string}
 */
export function sha256Hex(data) {
  return toHex(sha256(data));
}

/**
 * First `n` hex characters of SHA-256 (e.g. 12 for secret fingerprints, 16 for ledger keys).
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @param {number} n  1 to 64
 * @returns {string}
 */
export function sha256HexPrefix(data, n) {
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new RangeError('prefix length must be 1 to 64');
  return sha256Hex(data).slice(0, n);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}
