import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, streamChunks, DEFAULT_MAX_LINE_BYTES } from '../../src/core/lines.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Collect lines as decoded strings plus flags. */
async function collect(chunks, opts) {
  const out = [];
  for await (const l of splitLines(chunks, opts)) {
    out.push({ text: l.bytes === null ? null : dec.decode(l.bytes), lineNo: l.lineNo, byteLength: l.byteLength, terminated: l.terminated, oversize: l.oversize });
  }
  return out;
}

/** Split a byte array into chunks of size n. */
function chunked(bytes, n) {
  const out = [];
  for (let i = 0; i < bytes.length; i += n) out.push(bytes.slice(i, i + n));
  return out;
}

test('splits on 0x0A only and numbers lines from 1', async () => {
  const lines = await collect([enc.encode('a\nbb\nccc\n')]);
  assert.deepEqual(lines.map((l) => l.text), ['a', 'bb', 'ccc']);
  assert.deepEqual(lines.map((l) => l.lineNo), [1, 2, 3]);
  assert.ok(lines.every((l) => l.terminated && !l.oversize));
});

test('raw U+2028 and U+2029 inside JSON strings do not split a line (F07, trap 2)', async () => {
  const text = '{"t":"one\u2028two\u2029three"}\n{"t":"x"}\n';
  const lines = await collect([enc.encode(text)]);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0].text).t, 'one\u2028two\u2029three');
});

test('CRLF line endings are stripped of one trailing CR (F09)', async () => {
  const lines = await collect([enc.encode('{"a":1}\r\n{"b":2}\r\n')]);
  assert.deepEqual(lines.map((l) => l.text), ['{"a":1}', '{"b":2}']);
  assert.equal(lines[0].byteLength, 8, 'byteLength keeps the CR, excludes the LF');
});

test('a final segment without a newline is yielded unterminated (F06, trap 3)', async () => {
  const lines = await collect([enc.encode('{"a":1}\n{"trunc')]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].terminated, false);
  assert.equal(lines[1].text, '{"trunc');
});

test('a file ending in a newline produces no extra empty line; empty lines are kept', async () => {
  const lines = await collect([enc.encode('a\n\n\nb\n')]);
  assert.deepEqual(lines.map((l) => l.text), ['a', '', '', 'b']);
  assert.equal((await collect([enc.encode('')])).length, 0);
  assert.equal((await collect([])).length, 0);
});

test('identical output for every chunk size, including splits inside multibyte UTF-8', async () => {
  const text = 'first line\n{"emoji":"\u{1F600}","cjk":"漢字","sep":"\u2028"}\n\nlast é line without newline';
  const bytes = enc.encode(text);
  const expected = await collect([bytes]);
  for (let n = 1; n <= bytes.length; n++) {
    const got = await collect(chunked(bytes, n));
    assert.deepEqual(got, expected, 'chunk size ' + n);
  }
  assert.equal(expected[1].text, '{"emoji":"\u{1F600}","cjk":"漢字","sep":"\u2028"}');
});

test('oversize guard skips a long line without buffering it and resumes (trap 4)', async () => {
  const long = 'x'.repeat(25);
  for (const n of [1, 3, 7, 100]) {
    const lines = await collect(chunked(enc.encode('ok\n' + long + '\nnext\n'), n), { maxLineBytes: 10 });
    assert.deepEqual(lines.map((l) => [l.text, l.oversize, l.byteLength]), [['ok', false, 2], [null, true, 25], ['next', false, 4]], 'chunk ' + n);
  }
});

test('oversize guard on an unterminated tail', async () => {
  const lines = await collect(chunked(enc.encode('ok\n' + 'y'.repeat(30)), 4), { maxLineBytes: 10 });
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[1].oversize, lines[1].terminated, lines[1].byteLength], [true, false, 30]);
});

test('a line exactly at the limit is kept', async () => {
  const lines = await collect([enc.encode('0123456789\n')], { maxLineBytes: 10 });
  assert.equal(lines[0].oversize, false);
  assert.equal(lines[0].text, '0123456789');
});

test('default guard is 64 MiB and bad limits are rejected', async () => {
  assert.equal(DEFAULT_MAX_LINE_BYTES, 64 * 1024 * 1024);
  await assert.rejects(collect([enc.encode('a')], { maxLineBytes: 0 }), RangeError);
});

test('accepts ArrayBuffer and DataView chunks, rejects strings', async () => {
  const bytes = enc.encode('a\nb\n');
  const viaBuffer = await collect([bytes.buffer.slice(0)]);
  const viaView = await collect([new DataView(bytes.buffer, 0, 2), new DataView(bytes.buffer, 2, 2)]);
  assert.deepEqual(viaBuffer.map((l) => l.text), ['a', 'b']);
  assert.deepEqual(viaView.map((l) => l.text), ['a', 'b']);
  await assert.rejects(collect(['a\n']), TypeError);
});

test('a source that reuses its buffer cannot corrupt a pending partial line', async () => {
  const shared = new Uint8Array(4);
  async function* reusing() {
    for (const part of ['ab', 'cd', '\nxy', '\n']) {
      shared.fill(0);
      const b = enc.encode(part);
      shared.set(b);
      yield shared.subarray(0, b.length);
    }
  }
  const lines = [];
  for await (const l of splitLines(reusing())) lines.push(dec.decode(l.bytes)); // decode immediately, as documented
  assert.deepEqual(lines, ['abcd', 'xy']);
});

test('streamChunks adapts a WHATWG ReadableStream (Blob.stream) with the same result', async () => {
  const text = '{"a":1}\n{"b":"\u2028"}\ntail';
  const fromBlob = await collect(streamChunks(new Blob([text]).stream()));
  const direct = await collect([enc.encode(text)]);
  assert.deepEqual(fromBlob, direct);
});

test('streamChunks cancels the reader when the consumer stops early', async () => {
  let cancelled = false;
  const rs = new ReadableStream({
    pull(c) { c.enqueue(enc.encode('line\n')); },
    cancel() { cancelled = true; },
  });
  for await (const l of splitLines(streamChunks(rs))) { assert.equal(dec.decode(l.bytes), 'line'); break; }
  assert.equal(cancelled, true);
});

test('a 1.3 MB line passes through intact (F08)', async () => {
  const big = '{"content":"' + 'fictional words '.repeat(85000) + '"}';
  assert.ok(big.length > 1_300_000);
  const lines = await collect(chunked(enc.encode(big + '\n{"a":1}\n'), 65536));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].byteLength, big.length);
  assert.equal(JSON.parse(lines[0].text).content.length, big.length - 14);
});
