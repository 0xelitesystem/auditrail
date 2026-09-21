// Per-line JSON parsing over a byte stream, built on the 0x0A splitter in lines.js.
//
// Isomorphic: no node:* imports and no DOM.
//
// Rules (DESIGN 8.6, traps 2, 3, 4):
// - Split on byte 0x0A only, then decode each line as UTF-8 (invalid bytes become U+FFFD).
// - Empty and whitespace-only lines are skipped and counted, never errors.
// - A trailing segment without a newline is attempted. If it fails to parse it counts as
//   trailingPartial (a live session caught mid-write), not as a parse error.
// - A line over the 64 MiB guard is skipped and counted as oversize.
// - Parse failures are counted, never fatal.

import { splitLines, DEFAULT_MAX_LINE_BYTES } from './lines.js';

export { DEFAULT_MAX_LINE_BYTES };

/**
 * Counters for one stream. Callers usually keep one per file and sum per file class.
 *
 * @typedef {Object} JsonlStats
 * @property {number} lines             Lines seen, including empty, oversize and failed lines.
 * @property {number} bytes             Bytes consumed, including terminators.
 * @property {number} records           Lines that parsed to a JSON object and were yielded.
 * @property {number} emptyLines        Empty or whitespace-only lines (skipped).
 * @property {number} parseErrors       Terminated lines that failed JSON.parse.
 * @property {number} trailingPartial   Unterminated final segment that failed JSON.parse.
 * @property {number} oversizeLines     Lines over maxLineBytes (skipped, never buffered).
 * @property {number} nonObjectRecords  Lines that parsed but are not a JSON object (skipped when objectsOnly).
 * @property {number} maxLineBytesSeen  Largest line length seen, in bytes.
 */

/** @returns {JsonlStats} */
export function createJsonlStats() {
  return {
    lines: 0,
    bytes: 0,
    records: 0,
    emptyLines: 0,
    parseErrors: 0,
    trailingPartial: 0,
    oversizeLines: 0,
    nonObjectRecords: 0,
    maxLineBytesSeen: 0,
  };
}

/**
 * Add every counter of `from` into `into` (for per-class and grand totals).
 * @param {JsonlStats} into
 * @param {JsonlStats} from
 * @returns {JsonlStats} into
 */
export function addJsonlStats(into, from) {
  for (const k of /** @type {(keyof JsonlStats)[]} */ (Object.keys(into))) {
    if (k === 'maxLineBytesSeen') into[k] = Math.max(into[k], from[k]);
    else into[k] += from[k];
  }
  return into;
}

/**
 * One parsed line.
 *
 * @typedef {Object} JsonlRecord
 * @property {Record<string, unknown>|unknown} value  The parsed value (a plain object when objectsOnly).
 * @property {number} lineNo      1-based line number in the file.
 * @property {number} byteLength  Raw byte length of the line (excluding the 0x0A).
 * @property {boolean} terminated false when this was an unterminated final segment that parsed.
 */

/**
 * @typedef {Object} JsonlOptions
 * @property {JsonlStats} [stats]        Counter object to update in place (created if absent).
 * @property {number} [maxLineBytes]     Oversize guard, default 64 MiB.
 * @property {boolean} [objectsOnly]     Yield only plain JSON objects (default true). Other
 *                                       values are counted in nonObjectRecords.
 */

/**
 * Parse a JSONL byte stream line by line.
 *
 * Usage:
 *   const stats = createJsonlStats();
 *   for await (const { value, lineNo } of readJsonl(chunks, { stats })) { ... }
 *
 * @param {AsyncIterable<Uint8Array|ArrayBuffer|ArrayBufferView>|Iterable<Uint8Array|ArrayBuffer|ArrayBufferView>} source
 * @param {JsonlOptions} [options]
 * @returns {AsyncGenerator<JsonlRecord, void, void>}
 */
export async function* readJsonl(source, options = {}) {
  const stats = options.stats ?? createJsonlStats();
  const objectsOnly = options.objectsOnly ?? true;
  const decoder = new TextDecoder('utf-8');

  for await (const line of splitLines(source, { maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES })) {
    stats.lines++;
    stats.bytes += line.byteLength + (line.terminated ? 1 : 0);
    if (line.byteLength > stats.maxLineBytesSeen) stats.maxLineBytesSeen = line.byteLength;

    if (line.oversize || line.bytes === null) { stats.oversizeLines++; continue; }
    const bytes = line.bytes;
    if (bytes.length === 0) { stats.emptyLines++; continue; }

    const text = decoder.decode(bytes);
    if (isBlank(text)) { stats.emptyLines++; continue; }

    let value;
    try {
      value = JSON.parse(text);
    } catch {
      if (line.terminated) stats.parseErrors++;
      else stats.trailingPartial++;
      continue;
    }

    if (objectsOnly && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      stats.nonObjectRecords++;
      continue;
    }
    stats.records++;
    yield { value, lineNo: line.lineNo, byteLength: line.byteLength, terminated: line.terminated };
  }
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // JSON whitespace plus a stray BOM.
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a && c !== 0xfeff) return false;
  }
  return true;
}
