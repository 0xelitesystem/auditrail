// Drop-mode scanner (DESIGN 8.1, 8.6, 8.8). Runs the isomorphic core in a Web Worker.
//
// The page (app.js) starts this worker from the ar-worker script text through a blob: URL
// (the page CSP allows worker-src blob: and nothing else) and posts the dropped files:
//   in:  { type: 'scan', entries: [{ path, file }], tz, idleMinutes, nowMs }
//        path is relative to the dropped folder with '/' separators; file is a File or null
//        (the page only hands over File objects for names that can matter: *.jsonl variants and
//        the three config files).
//   out: { type: 'progress', bytesDone, totalBytes, filesDone, totalFiles }   (throttled)
//        { type: 'done', summary, receipt }
//        { type: 'error', message }
//
// Pipeline, the same as the CLI (src/node/read.js and cli.js), minus the file system:
//   planDrop(): the part of the drop that is the projects folder, classified by the adapter,
//   sorted by relPath (the discovery order), sizes fixed from File.size (the snapshot, rule A28)
//   -> File.stream() -> streamChunks -> readJsonl -> adapter.parseLine -> accounting
//   -> buildSummary. Nothing leaves the worker except the Summary (aggregates and local labels,
//   never text from a log) and counts.
//
// The helpers are exported so test/web/worker.test.js runs the same code in Node and checks
// parity with the CLI path. The worker glue at the bottom only runs inside a worker scope.

import { readJsonl, createJsonlStats, addJsonlStats } from '../core/jsonl.js';
import { streamChunks } from '../core/lines.js';
import { sha256Hex } from '../core/sha256.js';
import { FILE_CLASS_DEPTH } from '../core/adapters/contract.js';
import { claudeCodeAdapter } from '../core/adapters/claude-code/index.js';
import { createAccounting } from '../core/accounting/index.js';
import { getPriceTable } from '../core/prices/index.js';
import { createSecretScanner } from '../core/secrets.js';
import { buildSummary } from '../core/summary.js';
import { DEFAULT_IDLE_MINUTES, FALLBACK_TIME_ZONE } from '../core/constants.js';

/** Files next to the projects folder that rule A27 reads one value from. */
export const CONFIG_NAMES = Object.freeze(['settings.json', 'settings.local.json', 'stats-cache.json']);

/** The folder name that marks the projects root inside a dropped .claude folder. */
export const PROJECTS_DIR = 'projects';

/** Replaced by scripts/build.mjs with the package version (the worker text is not hashed). */
const BUILD_VERSION = '%%AR_VERSION%%';

/**
 * The version written into the Summary.
 * @param {unknown} [override]
 * @returns {string}
 */
export function workerVersion(override) {
  if (typeof override === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,20})?$/.test(override)) return override;
  return /^\d/.test(BUILD_VERSION) ? BUILD_VERSION : '0.0.0-dev';
}

/**
 * True when a dropped file name can matter to the scan, so the page hands its File over.
 * @param {string} name
 * @returns {boolean}
 */
export function wantedName(name) {
  return typeof name === 'string' && (name.includes('.jsonl') || CONFIG_NAMES.includes(name));
}

/**
 * @typedef {{ path: string, file: any }} DropEntry   file: a File (or any Blob with name, size, stream) or null
 * @typedef {Object} DropPlan
 * @property {import('../core/adapters/contract.js').FileRef[]} files   sorted by relPath, idx assigned
 * @property {any[]} blobs                                               blobs[i] belongs to files[i]
 * @property {{ compressed: number, 'unknown-extension': number, 'unknown-shape': number }} skippedFiles
 * @property {{ settings: any[], statsCache: any[] }} config            File objects, settings.local last
 * @property {number} ignored        dropped files outside the projects folder (never counted as skipped)
 * @property {number} missing        classified for reading but handed over without a File
 * @property {number} totalBytes
 * @property {string} root           'projects' when a projects folder was found, else 'folder'
 */

/**
 * Split a dropped path into clean segments.
 * @param {string} p
 * @returns {string[]}
 */
function segments(p) {
  return String(p ?? '').replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * Decide what the drop contains (the browser version of src/node/discover.js walkRoots).
 * - A path with a "projects" segment: the first such segment is the root, as when the user
 *   drops the .claude folder or the projects folder itself. Files outside it are ignored, except
 *   the three config files right next to it (rule A27).
 * - No "projects" segment anywhere: the user dropped one project folder, several of them, or a
 *   renamed copy of the projects folder. Both readings (the dropped folder is a project, or it
 *   holds projects) are classified and the one that reads more files wins.
 * @param {DropEntry[]} entries
 * @returns {DropPlan}
 */
export function planDrop(entries) {
  const list = (Array.isArray(entries) ? entries : []).map((e) => ({ parts: segments(e && e.path), file: e ? e.file ?? null : null }));
  let prefix = null;
  for (const x of list) {
    const k = x.parts.indexOf(PROJECTS_DIR);
    if (k >= 0 && k < x.parts.length - 1 && (prefix === null || k < prefix.length)) prefix = x.parts.slice(0, k);
  }

  /** @type {{ rel: string, file: any }[]} */
  let candidates = [];
  const config = { settings: /** @type {any[]} */ ([]), statsCache: /** @type {any[]} */ ([]) };
  let ignored = 0;
  if (prefix !== null) {
    const pre = prefix;
    const under = (/** @type {string[]} */ parts) => parts.length > pre.length + 1 && pre.every((s, i) => parts[i] === s) && parts[pre.length] === PROJECTS_DIR;
    const beside = (/** @type {string[]} */ parts) => parts.length === pre.length + 1 && pre.every((s, i) => parts[i] === s);
    /** @type {Record<string, any>} */
    const cfg = {};
    for (const x of list) {
      if (under(x.parts)) candidates.push({ rel: x.parts.slice(pre.length + 1).join('/'), file: x.file });
      else if (beside(x.parts) && CONFIG_NAMES.includes(x.parts[pre.length]) && x.file) cfg[x.parts[pre.length]] = x.file;
      else ignored++;
    }
    if (cfg['settings.json']) config.settings.push(cfg['settings.json']);
    if (cfg['settings.local.json']) config.settings.push(cfg['settings.local.json']);
    if (cfg['stats-cache.json']) config.statsCache.push(cfg['stats-cache.json']);
  } else {
    const asIs = list.map((x) => ({ rel: x.parts.join('/'), file: x.file }));
    const stripped = list.map((x) => ({ rel: x.parts.slice(1).join('/'), file: x.file }));
    const reads = (/** @type {{ rel: string }[]} */ c) => c.filter((y) => y.rel && decide(y.rel).action === 'read').length;
    candidates = reads(stripped) > reads(asIs) ? stripped : asIs;
  }

  const skippedFiles = { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 };
  /** @type {{ relPath: string, fileClass: import('../core/adapters/contract.js').FileClass, file: any }[]} */
  const found = [];
  const seen = new Set();
  let missing = 0;
  for (const c of candidates) {
    if (!c.rel || seen.has(c.rel)) continue;
    seen.add(c.rel);
    const dcs = decide(c.rel);
    if (dcs.action === 'read') {
      if (!c.file) { missing++; continue; }
      found.push({ relPath: c.rel, fileClass: dcs.fileClass, file: c.file });
    } else if (dcs.action === 'skip' && Object.prototype.hasOwnProperty.call(skippedFiles, dcs.reason)) {
      skippedFiles[/** @type {'compressed'} */ (dcs.reason)]++;
    } else {
      skippedFiles['unknown-shape']++;
    }
  }
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  /** @type {import('../core/adapters/contract.js').FileRef[]} */
  const files = [];
  const blobs = [];
  let totalBytes = 0;
  for (const f of found) {
    const size = Number.isFinite(f.file.size) && f.file.size >= 0 ? f.file.size : 0;
    files.push({ idx: files.length, rootIdx: 0, relPath: f.relPath, fileClass: f.fileClass, depth: FILE_CLASS_DEPTH[f.fileClass], size });
    blobs.push(f.file);
    totalBytes += size;
  }
  return { files, blobs, skippedFiles, config, ignored, missing, totalBytes, root: prefix !== null ? 'projects' : 'folder' };
}

/**
 * @param {string} rel
 * @returns {import('../core/adapters/contract.js').FileDecision}
 */
function decide(rel) {
  const d = claudeCodeAdapter.classify(rel);
  return d && typeof d === 'object' ? d : { action: 'skip', reason: 'unknown-shape' };
}

/**
 * Rule A27 from the config files next to the projects folder: cleanupPeriodDays (the later
 * settings file wins) and the stats-cache daily activity dates. Everything else in those files
 * is dropped as soon as it is parsed. Never throws.
 * @param {{ settings: any[], statsCache: any[] }} config
 * @returns {Promise<{ cleanupPeriodDays: number|null, statsCacheDays: string[]|null, seen: boolean }>}
 */
export async function readRetention(config) {
  let cleanupPeriodDays = null;
  let seen = false;
  for (const f of config.settings) {
    const v = await pick(f, (j) => j.cleanupPeriodDays);
    if (v !== undefined) seen = true;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleanupPeriodDays = v;
  }
  /** @type {Set<string>|null} */
  let days = null;
  for (const f of config.statsCache) {
    const list = await pick(f, (j) => j.dailyActivity);
    if (!Array.isArray(list)) continue;
    days = days ?? new Set();
    for (const row of list) {
      const x = row && typeof row === 'object' ? row.date : null;
      if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) days.add(x);
    }
  }
  return { cleanupPeriodDays, statsCacheDays: days ? [...days].sort() : null, seen: seen || config.settings.length > 0 };
}

/**
 * @param {any} file
 * @param {(j: any) => unknown} fn
 * @returns {Promise<unknown>}
 */
async function pick(file, fn) {
  try {
    const text = typeof file.text === 'function' ? await file.text() : '';
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? fn(j) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SHA-256 of a normalized path, memoized (the same few thousand paths repeat on every edit).
 * The same digest as the CLI's node:crypto hasher.
 * @returns {(p: string) => string}
 */
export function createPathHasher() {
  /** @type {Map<string, string>} */
  const memo = new Map();
  return (p) => {
    let h = memo.get(p);
    if (h === undefined) {
      h = sha256Hex(p);
      if (memo.size < 200_000) memo.set(p, h);
    }
    return h;
  };
}

/**
 * Errors that mean "this one file could not be read" (it changed or vanished after it was
 * chosen, or the browser refused it). Counted, never fatal, like ENOENT in the CLI.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isFileReadError(err) {
  const name = err && typeof err === 'object' && 'name' in err ? String(/** @type {any} */ (err).name) : '';
  return ['NotReadableError', 'NotFoundError', 'SecurityError', 'AbortError', 'InvalidStateError'].includes(name) ||
    (err && typeof err === 'object' && 'code' in err && typeof /** @type {any} */ (err).code === 'string');
}

/**
 * @typedef {Object} DropProgress
 * @property {number} bytesDone
 * @property {number} totalBytes
 * @property {number} filesDone
 * @property {number} totalFiles
 * @property {boolean} final
 */

/**
 * @typedef {Object} DropScanOptions
 * @property {DropEntry[]} entries
 * @property {string} [tz]              IANA zone of the viewer (rule A21)
 * @property {number} [idleMinutes]
 * @property {number} [nowMs]           scan clock (injected by tests)
 * @property {number} [takenAtMs]       snapshot time (defaults to nowMs)
 * @property {string} [toolVersion]
 * @property {(p: DropProgress) => void} [onProgress]
 */

/**
 * Scan dropped files and build the Summary. Same accounting, insights and leak checks as the CLI.
 * @param {DropScanOptions} o
 * @returns {Promise<{ summary: any, receipt: { filesRead: number, bytes: number, lines: number, parseErrors: number, unreadableFiles: number, adapterErrors: number, ignored: number, skippedFiles: Record<string, number>, retentionSeen: boolean, root: string, seconds: number } }>}
 */
export async function scanDropped(o) {
  const clock = () => (typeof performance === 'object' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
  const t0 = clock();
  const nowMs = Number.isFinite(o.nowMs) ? /** @type {number} */ (o.nowMs) : Date.now();
  const tz = typeof o.tz === 'string' && o.tz ? o.tz : FALLBACK_TIME_ZONE;
  const idleMinutes = Number.isFinite(o.idleMinutes) && /** @type {number} */ (o.idleMinutes) > 0 ? /** @type {number} */ (o.idleMinutes) : DEFAULT_IDLE_MINUTES;
  const plan = planDrop(o.entries);
  const takenAt = new Date(Number.isFinite(o.takenAtMs) ? /** @type {number} */ (o.takenAtMs) : nowMs).toISOString();
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

  const table = getPriceTable();
  const acc = createAccounting({
    prices: table, tz, idleMinutes, pathStyle: 'auto', overrides: null, projectRules: [],
    since: null, until: null, methods: false, adapter: claudeCodeAdapter,
  });
  acc.addFiles(plan.files);
  for (const [reason, n] of Object.entries(plan.skippedFiles)) if (n) acc.addSkippedFile(/** @type {any} */ (reason), n);

  const hashPath = createPathHasher();
  const scanSecrets = createSecretScanner({ nowMs });
  const totals = createJsonlStats();
  let filesRead = 0;
  let unreadableFiles = plan.missing;
  let adapterErrors = 0;
  let bytesDone = 0;
  const totalFiles = plan.files.length;
  onProgress({ bytesDone: 0, totalBytes: plan.totalBytes, filesDone: 0, totalFiles, final: false });

  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i];
    const blob = plan.blobs[i];
    const stats = createJsonlStats();
    /** @type {Record<string, unknown>} */
    const fileState = {};
    const ctx = { file, lineNo: 0, fileState, pathStyle: /** @type {'auto'} */ ('auto'), hashPath, scanSecrets };
    const base = bytesDone;
    let inFile = 0;
    try {
      const source = counted(file.size > 0 ? streamChunks(blob.stream()) : [], (n) => {
        inFile += n;
        onProgress({ bytesDone: base + Math.min(inFile, file.size), totalBytes: plan.totalBytes, filesDone: i, totalFiles, final: false });
      });
      for await (const rec of readJsonl(source, { stats })) {
        ctx.lineNo = rec.lineNo;
        let evs;
        try {
          evs = claudeCodeAdapter.parseLine(/** @type {Record<string, unknown>} */ (rec.value), ctx);
        } catch {
          adapterErrors++;
          continue;
        }
        if (evs && evs.length) acc.onEvents(evs, file);
      }
    } catch (err) {
      if (isFileReadError(err)) { unreadableFiles++; bytesDone += file.size; continue; }
      throw err;
    }
    filesRead++;
    addJsonlStats(totals, stats);
    acc.onFileDone(file, stats);
    bytesDone = base + file.size;
    onProgress({ bytesDone, totalBytes: plan.totalBytes, filesDone: i + 1, totalFiles, final: false });
  }

  const retention = await readRetention(plan.config);
  const result = acc.finish();
  const seconds = (clock() - t0) / 1000;
  const summary = buildSummary({
    acc: result,
    prices: table,
    toolVersion: workerVersion(o.toolVersion),
    scanTakenAt: takenAt,
    scanSeconds: seconds,
    options: {
      tz,
      idleMinutes,
      plan: null,
      redact: false,
      cleanupPeriodDays: retention.cleanupPeriodDays,
      statsCacheDays: retention.statsCacheDays,
      nowMs,
      custom: null,
    },
  });
  onProgress({ bytesDone: plan.totalBytes, totalBytes: plan.totalBytes, filesDone: totalFiles, totalFiles, final: true });
  return {
    summary,
    receipt: {
      filesRead, bytes: totals.bytes, lines: totals.lines, parseErrors: totals.parseErrors, unreadableFiles, adapterErrors,
      ignored: plan.ignored, skippedFiles: { ...plan.skippedFiles }, retentionSeen: retention.seen, root: plan.root, seconds,
    },
  };
}

/**
 * Pass chunks through, reporting each chunk's size.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} source
 * @param {(n: number) => void} onBytes
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* counted(source, onBytes) {
  for await (const chunk of source) {
    onBytes(chunk.byteLength);
    yield chunk;
  }
}

/**
 * First line of an error message, capped. Core errors name categories and JSON paths only.
 * @param {unknown} e
 * @returns {string}
 */
export function workerErrorText(e) {
  const name = e && typeof e === 'object' && 'name' in e ? String(/** @type {any} */ (e).name) : 'Error';
  const msg = e instanceof Error ? e.message : String(e);
  return (name + ': ' + msg).split(/\r?\n/)[0].slice(0, 300);
}

/* ------------------------------------------------------------------------------------------
 * Worker glue (only inside a dedicated worker; importing this module elsewhere does nothing)
 * ---------------------------------------------------------------------------------------- */

/** @param {any} scope */
function startWorker(scope) {
  let busy = false;
  scope.onmessage = async (/** @type {MessageEvent} */ ev) => {
    const m = ev.data;
    if (!m || m.type !== 'scan' || busy) return;
    busy = true;
    let last = 0;
    try {
      const res = await scanDropped({
        entries: m.entries,
        tz: m.tz,
        idleMinutes: m.idleMinutes,
        nowMs: m.nowMs,
        onProgress: (p) => {
          const t = Date.now();
          if (!p.final && t - last < 100) return;
          last = t;
          scope.postMessage({ type: 'progress', bytesDone: p.bytesDone, totalBytes: p.totalBytes, filesDone: p.filesDone, totalFiles: p.totalFiles });
        },
      });
      scope.postMessage({ type: 'done', summary: res.summary, receipt: res.receipt });
    } catch (e) {
      scope.postMessage({ type: 'error', message: workerErrorText(e) });
    } finally {
      busy = false;
    }
  };
}

const scope = typeof self === 'object' && self !== null ? /** @type {any} */ (self) : null;
if (scope && typeof document === 'undefined' && typeof scope.postMessage === 'function' && typeof scope.importScripts === 'function') startWorker(scope);
