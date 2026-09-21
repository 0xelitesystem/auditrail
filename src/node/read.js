// Streaming reader: files -> bytes -> lines -> JSON -> adapter events (DESIGN 8.6, traps 2, 3, 4).
//
// - Per file: the size fixed by the stat pass (rule A28), then
//   fs.createReadStream(path, { start: 0, end: size - 1, highWaterMark: 1 MiB }).
//   A live session appending during the scan is read only up to the stat'ed size, so the scan
//   is a consistent snapshot; a half-written last line counts as trailingPartial (trap 3).
// - Bytes go to src/core/jsonl.js, which splits on 0x0A only. node:readline is never used: it
//   splits on raw U+2028 and U+2029, which are legal inside JSON strings (trap 2).
// - Files are read sequentially in sorted order. One file failing to open is counted, never fatal.
// - Every parsed object goes to adapter.parseLine with a fresh per-file state object; the
//   record is not retained. Events are handed to the caller's sink and not kept here.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readJsonl, createJsonlStats, addJsonlStats } from '../core/jsonl.js';
import { FILE_CLASSES } from '../core/adapters/contract.js';
import { absolutePathOf } from './discover.js';

/** Read chunk size (DESIGN 8.6). */
export const HIGH_WATER_MARK = 1024 * 1024;

/**
 * The byte chunks of one file, read up to `size` bytes only.
 * @param {string} absPath
 * @param {number} size bytes as stat'ed before reading
 * @returns {AsyncIterable<Uint8Array>}
 */
export function fileChunks(absPath, size) {
  if (!(size > 0)) return (async function* empty() {})();
  return fs.createReadStream(absPath, { start: 0, end: size - 1, highWaterMark: HIGH_WATER_MARK });
}

/**
 * SHA-256 hex of an already normalized path, memoized (the same few thousand paths repeat on
 * every edit). Same digest as src/core/sha256.js sha256Hex (both are FIPS 180-4 over UTF-8).
 * @returns {(normalizedPath: string) => string}
 */
export function createPathHasher() {
  /** @type {Map<string, string>} */
  const memo = new Map();
  return (p) => {
    let h = memo.get(p);
    if (h === undefined) {
      h = createHash('sha256').update(p, 'utf8').digest('hex');
      if (memo.size < 200_000) memo.set(p, h);
    }
    return h;
  };
}

/**
 * Per-class scan receipts (ClassScanStats in accounting/contract.js).
 * @returns {Record<import('../core/adapters/contract.js').FileClass, import('../core/accounting/contract.js').ClassScanStats>}
 */
export function emptyScanByClass() {
  /** @type {any} */
  const out = {};
  for (const c of FILE_CLASSES) out[c] = { files: 0, bytes: 0, lines: 0, records: 0, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 };
  return out;
}

/**
 * @typedef {Object} ScanSink
 * @property {(events: import('../core/adapters/contract.js').NormalizedEvent[], file: import('../core/adapters/contract.js').FileRef) => void} onEvents
 *   called once per parsed line that produced at least one event
 * @property {(file: import('../core/adapters/contract.js').FileRef, stats: import('../core/jsonl.js').JsonlStats) => void} [onFileDone]
 */

/**
 * @typedef {Object} ScanOptions
 * @property {string[]} roots
 * @property {import('../core/adapters/contract.js').FileRef[]} files   from walkRoots, sorted
 * @property {Pick<import('../core/adapters/contract.js').Adapter, 'parseLine'>} adapter
 * @property {ScanSink} sink
 * @property {'win32'|'posix'|'auto'} [pathStyle]
 * @property {import('../core/adapters/contract.js').SecretScanner|null} [scanSecrets]
 * @property {(absPath: string, size: number) => AsyncIterable<Uint8Array>} [chunks]  test seam
 * @property {(done: number, total: number, bytes: number) => void} [onProgress]
 */

/**
 * @typedef {Object} ScanReceipt
 * @property {Record<import('../core/adapters/contract.js').FileClass, import('../core/accounting/contract.js').ClassScanStats>} byClass
 * @property {import('../core/jsonl.js').JsonlStats} totals
 * @property {number} filesRead
 * @property {number} unreadableFiles   files that vanished or could not be opened after the stat pass
 * @property {number} adapterErrors     lines where parseLine threw (a contract violation; counted, never fatal)
 * @property {number} events
 * @property {number} seconds
 */

/**
 * Read every file sequentially and feed the adapter's events to the sink.
 * @param {ScanOptions} o
 * @returns {Promise<ScanReceipt>}
 */
export async function scanFiles(o) {
  const t0 = performance.now();
  const chunks = o.chunks ?? fileChunks;
  const hashPath = createPathHasher();
  const pathStyle = o.pathStyle ?? 'auto';
  const scanSecrets = o.scanSecrets ?? null;
  const byClass = emptyScanByClass();
  const totals = createJsonlStats();
  let filesRead = 0;
  let unreadableFiles = 0;
  let adapterErrors = 0;
  let events = 0;
  let bytesDone = 0;

  for (let i = 0; i < o.files.length; i++) {
    const file = o.files[i];
    const stats = createJsonlStats();
    /** @type {Record<string, unknown>} */
    const fileState = {};
    const ctx = { file, lineNo: 0, fileState, pathStyle, hashPath, scanSecrets };
    try {
      for await (const rec of readJsonl(chunks(absolutePathOf(o.roots, file), file.size), { stats })) {
        ctx.lineNo = rec.lineNo;
        let evs;
        try {
          evs = o.adapter.parseLine(/** @type {Record<string, unknown>} */ (rec.value), ctx);
        } catch {
          adapterErrors++;
          continue;
        }
        if (evs && evs.length) {
          events += evs.length;
          o.sink.onEvents(evs, file);
        }
      }
    } catch (err) {
      // ENOENT (deleted after the stat pass), EACCES, EISDIR: count and move on.
      if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') { unreadableFiles++; continue; }
      throw err;
    }
    filesRead++;
    const c = byClass[file.fileClass];
    c.files++;
    c.bytes += stats.bytes;
    c.lines += stats.lines;
    c.records += stats.records;
    c.parseErrors += stats.parseErrors;
    c.trailingPartial += stats.trailingPartial;
    c.oversizeLines += stats.oversizeLines;
    addJsonlStats(totals, stats);
    bytesDone += stats.bytes;
    if (o.sink.onFileDone) o.sink.onFileDone(file, stats);
    if (o.onProgress) o.onProgress(i + 1, o.files.length, bytesDone);
  }

  return { byClass, totals, filesRead, unreadableFiles, adapterErrors, events, seconds: (performance.now() - t0) / 1000 };
}
