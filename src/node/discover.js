// Discovery (DESIGN 8.5, rules A27, A28, traps 1, 5, 9, 10).
//
// Two halves:
// - The LAUNCHER half (candidateRoots, resolveRoots, configFilesFor) runs in the parent process.
//   It only checks which directories exist; it never lists or reads them.
// - The SCANNER half (walkRoots, statFiles, readRetentionEvidence) runs inside the sandboxed
//   child. It lists the roots recursively in sorted order, classifies each file by path shape
//   through the adapter, and stats every file before any file is read (rule A28).
//
// Nothing outside `<config>/projects` is listed. Outside the roots exactly two things are read,
// and only one key or one date list is kept from each (rule A27): `cleanupPeriodDays` from
// `<config>/settings.json` and `<config>/settings.local.json`, and the daily activity dates in
// `<config>/stats-cache.json`. `history.jsonl` and every other file under `<config>` are never
// touched (trap 5).

import fs from 'node:fs';
import path from 'node:path';
import { FILE_CLASS_DEPTH } from '../core/adapters/contract.js';

/**
 * @typedef {Object} RootCandidate
 * @property {string} path     absolute path
 * @property {'dir'|'env'|'home'|'xdg'} source  where it came from (DESIGN 8.5 order)
 */

/**
 * Candidate roots in DESIGN 8.5 priority order. Pure: touches nothing.
 * `--dir` wins outright: when any `--dir` is given only those are scanned, so a run against a
 * fixture folder can never mix in the real logs.
 *
 * When the adapter's own `roots(env)` list is passed as `adapterRoots`, it is used for the
 * defaults (the adapter contract owns the order); otherwise the DESIGN 8.5 list below applies.
 *
 * @param {{ dirs?: string[], env?: Record<string, string|undefined>, home: string, platform?: string, adapterRoots?: string[]|null }} o
 * @returns {RootCandidate[]}
 */
export function candidateRoots(o) {
  const dirs = o.dirs ?? [];
  if (dirs.length) return dirs.map((d) => ({ path: path.resolve(d), source: /** @type {'dir'} */ ('dir') }));
  if (Array.isArray(o.adapterRoots) && o.adapterRoots.length) {
    return o.adapterRoots.map((p) => ({ path: path.resolve(p), source: /** @type {'home'} */ ('home') }));
  }
  const env = o.env ?? {};
  /** @type {RootCandidate[]} */
  const out = [];
  if (env.CLAUDE_CONFIG_DIR) out.push({ path: path.resolve(env.CLAUDE_CONFIG_DIR, 'projects'), source: 'env' });
  out.push({ path: path.join(o.home, '.claude', 'projects'), source: 'home' });
  const xdgBase = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(o.home, '.config');
  out.push({ path: path.join(xdgBase, 'claude', 'projects'), source: 'xdg' });
  return out;
}

/**
 * Keep the candidates that exist as directories, canonicalized (real path, native case) and
 * deduplicated. A missing `--dir` is an error the caller reports; a missing default is normal.
 *
 * @param {RootCandidate[]} candidates
 * @param {{ statSync?: typeof fs.statSync, realpathSync?: (p: string) => string, platform?: string }} [io]
 * @returns {{ roots: string[], missingDirs: string[], notDirectories: string[] }}
 */
export function resolveRoots(candidates, io = {}) {
  const statSync = io.statSync ?? fs.statSync;
  const realpath = io.realpathSync ?? ((p) => fs.realpathSync.native(p));
  const platform = io.platform ?? process.platform;
  const roots = [];
  const seen = new Set();
  const missingDirs = [];
  const notDirectories = [];
  for (const c of candidates) {
    let st;
    try { st = statSync(c.path); } catch { if (c.source === 'dir') missingDirs.push(c.path); continue; }
    if (!st.isDirectory()) { if (c.source === 'dir') notDirectories.push(c.path); continue; }
    let real = c.path;
    try { real = realpath(c.path); } catch { /* keep the resolved path */ }
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return { roots, missingDirs, notDirectories };
}

/**
 * The hint printed on Windows when nothing was found (DESIGN 8.5 step 5). No automatic probing.
 * @returns {string}
 */
export function wslHint() {
  return 'Using WSL? Pass the folder explicitly: --dir \\\\wsl.localhost\\<distro>\\home\\<user>\\.claude\\projects';
}

/**
 * The config folder of a root is its parent when the root is named `projects` (the Claude Code
 * layout `<config>/projects`). A `--dir` pointing anywhere else has no config folder, so no
 * settings or stats-cache file is read for it.
 * @param {string} root
 * @returns {string|null}
 */
export function configDirOf(root) {
  return path.basename(root).toLowerCase() === 'projects' ? path.dirname(root) : null;
}

/**
 * The exact extra files the scanner may read (rule A27), per root, existing files only.
 * Used by the launcher to build the sandbox allow list and by the scanner to read them.
 * @param {string[]} roots
 * @param {{ existsSync?: (p: string) => boolean }} [io]
 * @returns {{ settings: string[], statsCache: string[] }}
 */
export function configFilesFor(roots, io = {}) {
  const exists = io.existsSync ?? fs.existsSync;
  const settings = [];
  const statsCache = [];
  const seen = new Set();
  for (const root of roots) {
    const dir = configDirOf(root);
    if (!dir) continue;
    for (const name of ['settings.json', 'settings.local.json']) {
      const p = path.join(dir, name);
      if (!seen.has(p) && exists(p)) { seen.add(p); settings.push(p); }
    }
    const sc = path.join(dir, 'stats-cache.json');
    if (!seen.has(sc) && exists(sc)) { seen.add(sc); statsCache.push(sc); }
  }
  return { settings, statsCache };
}

/**
 * Read rule A27's two values and discard everything else immediately.
 * - cleanupPeriodDays: settings.local.json overrides settings.json (the later file in the list
 *   wins); null when unset or not a finite non-negative number.
 * - statsCacheDays: the sorted unique `dailyActivity[].date` values that look like YYYY-MM-DD;
 *   null when no stats-cache file exists or it has no such list.
 * Never throws: an unreadable or malformed file counts as absent.
 *
 * @param {{ settings: string[], statsCache: string[] }} files
 * @param {{ readFileSync?: (p: string, enc: 'utf8') => string }} [io]
 * @returns {{ cleanupPeriodDays: number|null, statsCacheDays: string[]|null }}
 */
export function readRetentionEvidence(files, io = {}) {
  const read = io.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
  let cleanupPeriodDays = null;
  for (const p of files.settings) {
    const v = pickKey(read, p, (j) => j.cleanupPeriodDays);
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleanupPeriodDays = v;
  }
  /** @type {Set<string>|null} */
  let days = null;
  for (const p of files.statsCache) {
    const list = pickKey(read, p, (j) => j.dailyActivity);
    if (!Array.isArray(list)) continue;
    days = days ?? new Set();
    for (const row of list) {
      const d = row && typeof row === 'object' ? row.date : null;
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) days.add(d);
    }
  }
  return { cleanupPeriodDays, statsCacheDays: days ? [...days].sort() : null };
}

/**
 * Parse one JSON file and return one extracted value; the parsed object goes out of scope here.
 * @param {(p: string, enc: 'utf8') => string} read
 * @param {string} p
 * @param {(j: any) => unknown} pick
 * @returns {unknown}
 */
function pickKey(read, p, pick) {
  try {
    const j = JSON.parse(read(p, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? pick(j) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {Object} WalkResult
 * @property {import('../core/adapters/contract.js').FileRef[]} files  sorted by (rootIdx, relPath), idx assigned, size stat'ed
 * @property {{ compressed: number, 'unknown-extension': number, 'unknown-shape': number }} skippedFiles
 * @property {number} symlinksIgnored   symbolic links are never followed (they could leave the sandbox scope)
 * @property {number} unreadableEntries directories or files that could not be listed or stat'ed
 * @property {string} takenAt           ISO UTC time of the stat pass (rule A28)
 */

/**
 * Recursive, sorted walk of every root, classification by path shape, then ONE stat pass over
 * every file to read before any file is read (rule A28). Scanner side (sandboxed child).
 *
 * @param {string[]} roots  absolute paths, in discovery order (rootIdx = position)
 * @param {(relPath: string) => import('../core/adapters/contract.js').FileDecision} classify
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<WalkResult>}
 */
export async function walkRoots(roots, classify, opts = {}) {
  const now = opts.now ?? Date.now;
  const skippedFiles = { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 };
  let symlinksIgnored = 0;
  let unreadableEntries = 0;
  /** @type {{ rootIdx: number, relPath: string, fileClass: import('../core/adapters/contract.js').FileClass }[]} */
  const found = [];

  for (let rootIdx = 0; rootIdx < roots.length; rootIdx++) {
    const root = roots[rootIdx];
    /** @type {string[]} */
    const stack = [''];
    while (stack.length) {
      const rel = /** @type {string} */ (stack.pop());
      let entries;
      try {
        entries = await fs.promises.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
      } catch {
        unreadableEntries++;
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs = [];
      for (const e of entries) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isSymbolicLink()) { symlinksIgnored++; continue; }
        if (e.isDirectory()) { subdirs.push(r); continue; }
        if (!e.isFile()) continue;
        const d = classify(r);
        if (d && d.action === 'read') found.push({ rootIdx, relPath: r, fileClass: d.fileClass });
        else if (d && d.action === 'skip' && Object.prototype.hasOwnProperty.call(skippedFiles, d.reason)) skippedFiles[d.reason]++;
        else skippedFiles['unknown-shape']++;
      }
      // Push in reverse so the smallest name is walked first (depth first, sorted).
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
    }
  }

  found.sort((a, b) => (a.rootIdx - b.rootIdx) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // The stat pass: every size is fixed here, before the first byte of any file is read.
  const takenAt = new Date(now()).toISOString();
  /** @type {import('../core/adapters/contract.js').FileRef[]} */
  const files = [];
  for (const f of found) {
    let size;
    try {
      const st = await fs.promises.stat(path.join(roots[f.rootIdx], ...f.relPath.split('/')));
      size = st.size;
    } catch {
      unreadableEntries++;
      continue;
    }
    files.push({ idx: files.length, rootIdx: f.rootIdx, relPath: f.relPath, fileClass: f.fileClass, depth: FILE_CLASS_DEPTH[f.fileClass], size });
  }
  return { files, skippedFiles, symlinksIgnored, unreadableEntries, takenAt };
}

/**
 * Absolute path of a FileRef (scanner side only; never printed by the default commands).
 * @param {string[]} roots
 * @param {{ rootIdx: number, relPath: string }} f
 * @returns {string}
 */
export function absolutePathOf(roots, f) {
  return path.join(roots[f.rootIdx], ...f.relPath.split('/'));
}
