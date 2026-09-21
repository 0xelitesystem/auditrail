import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, sha256Hex, sha256HexPrefix, createSha256, toHex } from '../../src/core/sha256.js';

// NIST FIPS 180-2 / SHAVS example vectors.
const NIST = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

test('NIST example vectors', () => {
  for (const [msg, hex] of NIST) assert.equal(sha256Hex(msg), hex, JSON.stringify(msg));
});

test('NIST one million "a" (one-shot and incremental)', () => {
  const want = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
  assert.equal(sha256Hex('a'.repeat(1_000_000)), want);
  const h = createSha256();
  const chunk = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) h.update(chunk);
  assert.equal(h.digestHex(), want);
});

test('matches node:crypto for every length 0 to 300 and every padding boundary', () => {
  let x = 0x12345678;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 0xff; };
  for (let n = 0; n <= 300; n++) {
    const b = new Uint8Array(n).map(() => rnd());
    assert.equal(sha256Hex(b), crypto.createHash('sha256').update(b).digest('hex'), 'length ' + n);
  }
});

test('incremental updates at every split point equal one-shot', () => {
  const b = new Uint8Array(200).map((_, i) => (i * 7 + 3) & 0xff);
  const want = sha256Hex(b);
  for (let s = 0; s <= b.length; s++) {
    for (const t of [s, Math.min(b.length, s + 1), Math.min(b.length, s + 64)]) {
      const h = createSha256();
      h.update(b.subarray(0, s)).update(b.subarray(s, t)).update(b.subarray(t));
      assert.equal(h.digestHex(), want, `split ${s}/${t}`);
    }
  }
});

test('strings hash as UTF-8 like node:crypto', () => {
  for (const s of ['café', '漢字', '\u{1F600} emoji', 'line\u2028sep', '/fake/Alpha/File.TXT']) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('accepts ArrayBuffer and views; returns 32 bytes', () => {
  const u8 = new TextEncoder().encode('abc');
  assert.equal(toHex(sha256(u8.buffer)), NIST[1][1]);
  assert.equal(toHex(sha256(new DataView(u8.buffer))), NIST[1][1]);
  assert.equal(sha256('abc').length, 32);
  assert.throws(() => sha256(/** @type {any} */ (123)), TypeError);
});

test('prefix helper and misuse errors', () => {
  assert.equal(sha256HexPrefix('abc', 12), NIST[1][1].slice(0, 12));
  assert.throws(() => sha256HexPrefix('abc', 0), RangeError);
  assert.throws(() => sha256HexPrefix('abc', 65), RangeError);
  const h = createSha256();
  h.digest();
  assert.throws(() => h.update('x'));
  assert.throws(() => h.digest());
});
