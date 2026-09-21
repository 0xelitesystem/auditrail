// Byte-level line splitter over AsyncIterable<Uint8Array>.
//
// Isomorphic: no node:* imports and no DOM. Node feeds fs.createReadStream chunks,
// the browser feeds File.stream() chunks (see streamChunks below).
//
// Why bytes and not node:readline: readline splits on raw U+2028 and U+2029, which are
// legal inside JSON strings, so it produces false parse errors on real transcripts.
// This splitter looks for byte 0x0A only. 0x0A never occurs inside a multibyte UTF-8
// sequence, so splitting before decoding is always safe.

/** Default guard: a single line longer than this is skipped and counted, never buffered. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

/**
 * One line produced by splitLines.
 *
 * @typedef {Object} RawLine
 * @property {Uint8Array|null} bytes
 *   Line content without the 0x0A terminator and without one trailing 0x0D (CRLF files).
 *   null when the line is oversize. The array may be a view into the source chunk:
 *   decode it before asking the iterator for the next line.
 * @property {number} lineNo      1-based line number in the source.
 * @property {number} byteLength  Raw length in bytes excluding the 0x0A terminator
 *                                (a trailing 0x0D is included). For oversize lines this is
 *                                the full length that was skipped.
 * @property {boolean} terminated false only for a final segment that has no trailing 0x0A
 *                                (a live file caught mid-write).
 * @property {boolean} oversize   true when byteLength exceeded maxLineBytes; bytes is null.
 */

/**
 * @typedef {Object} SplitOptions
 * @property {number} [maxLineBytes] Oversize guard, default DEFAULT_MAX_LINE_BYTES.
 */

/**
 * Split a byte stream into lines on 0x0A only.
 *
 * - Empty lines are yielded (bytes.length === 0) so line numbers stay exact; consumers skip them.
 * - A final segment without a newline is yielded with terminated === false.
 * - A file that ends with 0x0A does not produce an extra empty line.
 * - Lines longer than maxLineBytes are never fully buffered: the splitter switches to skip
 *   mode, discards bytes until the next 0x0A, and yields one { oversize: true } entry.
 *
 * @param {AsyncIterable<Uint8Array|ArrayBuffer|ArrayBufferView>|Iterable<Uint8Array|ArrayBuffer|ArrayBufferView>} source
 * @param {SplitOptions} [options]
 * @returns {AsyncGenerator<RawLine, void, void>}
 */
export async function* splitLines(source, options = {}) {
  const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isInteger(max) || max < 1) throw new RangeError('maxLineBytes must be a positive integer');

  /** @type {Uint8Array[]} */
  let pending = [];
  let pendingLen = 0;
  let skipping = false;
  let skippedLen = 0;
  let lineNo = 0;

  for await (const chunk of source) {
    const u8 = toUint8Array(chunk);
    let start = 0;
    while (start < u8.length) {
      const nl = u8.indexOf(LF, start);
      if (nl === -1) {
        // No terminator in the rest of this chunk: stash it (copied, so a source that
        // reuses its buffers cannot corrupt us) or keep skipping an oversize line.
        const restLen = u8.length - start;
        if (skipping) {
          skippedLen += restLen;
        } else if (pendingLen + restLen > max) {
          skipping = true;
          skippedLen = pendingLen + restLen;
          pending = [];
          pendingLen = 0;
        } else {
          pending.push(u8.slice(start));
          pendingLen += restLen;
        }
        break;
      }

      const pieceLen = nl - start;
      lineNo++;
      if (skipping) {
        yield { bytes: null, lineNo, byteLength: skippedLen + pieceLen, terminated: true, oversize: true };
        skipping = false;
        skippedLen = 0;
      } else if (pendingLen + pieceLen > max) {
        yield { bytes: null, lineNo, byteLength: pendingLen + pieceLen, terminated: true, oversize: true };
        pending = [];
        pendingLen = 0;
      } else {
        let line;
        if (pendingLen === 0) {
          line = u8.subarray(start, nl);
        } else {
          line = concat(pending, pendingLen, u8.subarray(start, nl));
          pending = [];
          pendingLen = 0;
        }
        yield { bytes: stripTrailingCR(line), lineNo, byteLength: line.length, terminated: true, oversize: false };
      }
      start = nl + 1;
    }
  }

  if (skipping) {
    lineNo++;
    yield { bytes: null, lineNo, byteLength: skippedLen, terminated: false, oversize: true };
  } else if (pendingLen > 0) {
    lineNo++;
    const line = concat(pending, pendingLen, null);
    yield { bytes: stripTrailingCR(line), lineNo, byteLength: line.length, terminated: false, oversize: false };
  }
}

/**
 * Wrap a WHATWG ReadableStream<Uint8Array> (browser File.stream(), Blob.stream()) as an
 * async iterable of chunks. Node streams are already async iterable and need no wrapper.
 *
 * @param {{ getReader: () => { read: () => Promise<{done: boolean, value?: Uint8Array}>, releaseLock?: () => void, cancel?: (reason?: unknown) => Promise<void> } }} readable
 * @returns {AsyncGenerator<Uint8Array, void, void>}
 */
export async function* streamChunks(readable) {
  const reader = readable.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      if (value && value.length) yield value;
    }
  } finally {
    // Stopping early (break in the consumer) cancels the underlying read.
    if (!finished && typeof reader.cancel === 'function') {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (typeof reader.releaseLock === 'function') {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  }
}

/**
 * @param {unknown} chunk
 * @returns {Uint8Array}
 */
function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('splitLines expects byte chunks (Uint8Array, ArrayBuffer or an ArrayBuffer view), got ' + typeof chunk);
}

/**
 * @param {Uint8Array[]} parts
 * @param {number} partsLen
 * @param {Uint8Array|null} tail
 * @returns {Uint8Array}
 */
function concat(parts, partsLen, tail) {
  const out = new Uint8Array(partsLen + (tail ? tail.length : 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  if (tail) out.set(tail, off);
  return out;
}

/**
 * @param {Uint8Array} line
 * @returns {Uint8Array}
 */
function stripTrailingCR(line) {
  return line.length > 0 && line[line.length - 1] === CR ? line.subarray(0, line.length - 1) : line;
}
