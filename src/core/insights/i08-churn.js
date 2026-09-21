// I8. Churn hot spots (DESIGN 6 I8, rule A32).
//
// Per hashed file path, the number of ok Edit, MultiEdit and Write calls. A hot spot has at
// least 10. The local report shows "<parent>/<basename>" for the top 10 (never a full path;
// "File A", "File B" under --redact); the card gets only the single largest count.
//
// "Within one work block": the tool call timestamps of one session split wherever a gap exceeds
// the idle cutoff (rule A24 applied to the session's tool calls and responses, the only
// timestamps the AccountingResult keeps per session).
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { EDIT_TOOLS, WRITE_TOOLS } from '../constants.js';
import { makeLabeler, safeLabel, median } from './_util.js';

export const HOT_SPOT_EDITS = 10;
export const TOP_FILES = 10;

export const ACTION_CHURN = 'For the files edited most often, add a test, a CLAUDE.md note or a short doc so the agent gets that area right the first time.';

const CHURN_TOOLS = new Set([...EDIT_TOOLS, ...WRITE_TOOLS]);

/**
 * Work block index of every timestamp per session: sorted session timestamps, split where the
 * gap exceeds idleSeconds.
 * @param {import('../accounting/contract.js').AccountingResult} acc
 * @param {number} idleMs
 * @returns {(sessionId: string|null, ts: number|null) => string}
 */
function blockOf(acc, idleMs) {
  /** @type {Map<string, number[]>} */
  const bySession = new Map();
  const push = (/** @type {string|null} */ s, /** @type {number|null} */ t) => {
    if (s === null || t === null || !Number.isFinite(t)) return;
    let l = bySession.get(s);
    if (!l) { l = []; bySession.set(s, l); }
    l.push(t);
  };
  for (const t of acc.tools) push(t.sessionId, t.ts);
  for (const r of acc.responses) { push(r.sessionId, r.tsStart); push(r.sessionId, r.tsEnd); }
  /** @type {Map<string, number[]>} */
  const starts = new Map();
  for (const [s, l] of bySession) {
    l.sort((a, b) => a - b);
    const st = [l[0]];
    for (let i = 1; i < l.length; i++) if (l[i] - l[i - 1] > idleMs) st.push(l[i]);
    starts.set(s, st);
  }
  return (s, t) => {
    if (s === null || t === null) return 'none';
    const st = starts.get(s);
    if (!st) return s + ':0';
    let lo = 0;
    let hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return s + ':' + lo;
  };
}

export const insight = defineInsight({
  id: 'i08',
  title: 'Churn hot spots',
  compute({ acc, options }) {
    const redact = Boolean(options.redact);
    const idleMs = (acc.time && acc.time.idleSeconds ? acc.time.idleSeconds : (options.idleMinutes || 15) * 60) * 1000;
    const block = blockOf(acc, idleMs);
    /** @type {Map<string, { edits: number, label: string|null }>} */
    const files = new Map();
    /** @type {Map<string, number>} */
    const perBlock = new Map();
    /** @type {number[]} */
    const editLines = [];
    for (const t of acc.tools) {
      if (t.status !== 'ok' || !CHURN_TOOLS.has(t.name)) continue;
      if (EDIT_TOOLS.includes(t.name) && typeof t.editNewLines === 'number') editLines.push(t.editNewLines);
      if (!t.filePathHash) continue;
      let f = files.get(t.filePathHash);
      if (!f) { f = { edits: 0, label: null }; files.set(t.filePathHash, f); }
      f.edits++;
      if (!f.label && t.fileLabel) f.label = t.fileLabel;
      const bk = t.filePathHash + '|' + block(t.sessionId, t.ts);
      perBlock.set(bk, (perBlock.get(bk) || 0) + 1);
    }
    const ranked = [...files.entries()].sort((a, b) => (b[1].edits - a[1].edits) || (a[0] < b[0] ? -1 : 1));
    const label = makeLabeler('File');
    const top = ranked.slice(0, TOP_FILES).map(([hash, f]) => ({
      label: redact ? label(hash) : safeLabel(f.label, 'unnamed file'),
      edits: f.edits,
    }));
    const hot = ranked.filter(([, f]) => f.edits >= HOT_SPOT_EDITS).length;
    let maxBlock = 0;
    for (const n of perBlock.values()) if (n > maxBlock) maxBlock = n;
    const data = {
      distinctFiles: files.size,
      filesWithTenPlusEdits: hot,
      maxEditsOneFile: ranked.length ? ranked[0][1].edits : 0,
      maxEditsOneFileOneBlock: maxBlock,
      top,
      medianEditNewLines: median(editLines),
    };
    return { id: 'i08', shown: hot > 0, data, evidence: { count: hot, unit: 'files' }, action: ACTION_CHURN };
  },
});
