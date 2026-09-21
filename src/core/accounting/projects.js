// Project keys (rule A29).
//
// The launch folder is the session's main-thread first cwd (the projects/ folder name is a lossy
// encoding of it and cannot be decoded). For a response, take its line's cwd: inside the launch
// folder, the key is the launch folder plus the first path segment below it (so a user who always
// launches from one root still gets per-repo breakdowns); otherwise the key is the launch folder.
// On win32 paths compare case-insensitively with forward slashes (normalizeLogPath). A user rules
// file (ordered { prefix, label } list) overrides this. Directories are never read: resolving git
// roots would leave the log roots (sandbox scope) and the paths may no longer exist.
//
// Isomorphic: no node:* imports and no DOM.

import { normalizeLogPath, isPathInside } from '../adapters/contract.js';

/** Label used when neither a cwd nor a launch folder is known. */
export const UNKNOWN_PROJECT_LABEL = 'unknown folder';

/**
 * Basename of a normalized key (the local report label, DESIGN 4.12).
 * @param {string} key
 * @returns {string}
 */
export function projectLabelOf(key) {
  if (!key) return UNKNOWN_PROJECT_LABEL;
  const parts = key.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : key;
}

/**
 * @param {{ pathStyle?: 'win32'|'posix'|'auto', rules?: { prefix: string, label: string }[] }} [opts]
 */
export function createProjectResolver(opts = {}) {
  const style = opts.pathStyle || 'auto';
  const rules = (opts.rules || [])
    .filter((r) => r && typeof r.prefix === 'string' && r.prefix)
    .map((r) => ({ prefix: normalizeLogPath(r.prefix, style), label: String(r.label ?? '').slice(0, 120) }));

  /** Earliest main-thread cwd per session, and earliest cwd of any line as a fallback. */
  /** @type {Map<string, { ts: number, fileIdx: number, lineNo: number, cwd: string, main: boolean }>} */
  const launch = new Map();

  return {
    normalize: (/** @type {string} */ p) => normalizeLogPath(p, style),

    /**
     * Observe one activity line for the launch folder of its session.
     * @param {import('../adapters/contract.js').ActivityEvent} ev
     * @param {import('../adapters/contract.js').FileRef[]} files
     */
    observe(ev, files) {
      if (!ev.sessionId || !ev.cwd) return;
      const file = files[ev.fileIdx];
      const main = !!file && file.fileClass === 'main' && !ev.isSidechain;
      const cur = launch.get(ev.sessionId);
      const rec = { ts: ev.ts, fileIdx: ev.fileIdx, lineNo: ev.lineNo, cwd: ev.cwd, main };
      if (!cur) { launch.set(ev.sessionId, rec); return; }
      if (cur.main !== main) { if (main) launch.set(ev.sessionId, rec); return; }
      if (rec.ts < cur.ts) { launch.set(ev.sessionId, rec); return; }
      if (rec.ts > cur.ts) return;
      // Same timestamp: the rule A3 file order (shallower, smaller path, smaller root; then the EARLIER line).
      const fa = files[rec.fileIdx];
      const fb = files[cur.fileIdx];
      if (!fa || !fb) return;
      const c = fa.depth !== fb.depth ? fa.depth - fb.depth
        : fa.relPath !== fb.relPath ? (fa.relPath < fb.relPath ? -1 : 1)
          : fa.rootIdx !== fb.rootIdx ? fa.rootIdx - fb.rootIdx : rec.lineNo - cur.lineNo;
      if (c < 0) launch.set(ev.sessionId, rec);
    },

    /**
     * Normalized launch folder of a session (null when the session has no cwd at all).
     * @param {string|null} sessionId
     * @returns {string|null}
     */
    launchFolder(sessionId) {
      const r = sessionId ? launch.get(sessionId) : undefined;
      return r ? normalizeLogPath(r.cwd, style) : null;
    },

    /**
     * Project key and label for a line's cwd within a session.
     * @param {string|null} cwd       the kept observation's cwd, as written
     * @param {string|null} sessionId
     * @returns {{ key: string, label: string }}
     */
    keyFor(cwd, sessionId) {
      const c = cwd ? normalizeLogPath(cwd, style) : null;
      const home = this.launchFolder(sessionId);
      const probe = c ?? home;
      if (probe) {
        for (const r of rules) if (isPathInside(probe, r.prefix)) return { key: r.prefix, label: r.label || projectLabelOf(r.prefix) };
      }
      if (home === null) return c ? { key: c, label: projectLabelOf(c) } : { key: '', label: UNKNOWN_PROJECT_LABEL };
      if (c && c !== home && isPathInside(c, home)) {
        const rest = c.slice(home.endsWith('/') ? home.length : home.length + 1);
        const seg = rest.split('/')[0];
        const key = home.endsWith('/') ? home + seg : home + '/' + seg;
        return { key, label: projectLabelOf(key) };
      }
      return { key: home, label: projectLabelOf(home) };
    },
  };
}
