// Tool calls (rules A30 to A32).
//
// A30  tool_use deduped by id (forked copies), the kept copy chosen by the rule A3 file order;
//      results paired by tool_use_id across files in either arrival order. Status:
//      denied (result line has toolDenialKind) beats shell_exit (is_error on Bash or PowerShell,
//      labelled "non-zero exits", never "errors") beats failed (is_error elsewhere); no result is
//      unpaired; everything else is ok. A missing is_error means false.
// A31  names starting mcp__ are class mcp and display as "MCP tools"; names outside the built-in
//      allowlist are class other.
// A32  line counts come from tool_use.input and count only on ok calls (never toolUseResult).
//
// Isomorphic: no node:* imports and no DOM.

import { compareByFileOrder } from '../adapters/contract.js';
import { toolNameClass, toolDisplayName, SHELL_TOOLS } from '../constants.js';

const SHELL = new Set(SHELL_TOOLS);

/**
 * @param {import('../adapters/contract.js').FileRef[]} files
 * @param {{ inWindow?: (ts: number|null) => boolean }} [opts]
 */
export function createToolTracker(files, opts = {}) {
  const inWindow = opts.inWindow || (() => true);
  /** @type {Map<string, import('../adapters/contract.js').ToolUseEvent>} */
  const uses = new Map();
  /** @type {Map<string, import('../adapters/contract.js').ToolResultEvent>} */
  const results = new Map();
  let useOccurrences = 0;

  return {
    /** @param {import('../adapters/contract.js').ToolUseEvent} ev */
    addUse(ev) {
      if (!inWindow(ev.ts)) return;
      useOccurrences++;
      const cur = uses.get(ev.toolUseId);
      if (!cur || compareByFileOrder(ev, cur, files) < 0) uses.set(ev.toolUseId, ev);
    },
    /** @param {import('../adapters/contract.js').ToolResultEvent} ev */
    addResult(ev) {
      const cur = results.get(ev.toolUseId);
      if (!cur || compareByFileOrder(ev, cur, files) < 0) results.set(ev.toolUseId, ev);
    },

    /**
     * @returns {{ records: import('./contract.js').ToolCallRecord[], duplicateToolUseIds: number, orphanToolResults: number }}
     */
    finish() {
      /** @type {import('./contract.js').ToolCallRecord[]} */
      const records = [];
      for (const [id, u] of uses) {
        const r = results.get(id) || null;
        /** @type {import('./contract.js').ToolStatus} */
        let status;
        if (!r) status = 'unpaired';
        else if (r.denialKind !== null) status = 'denied';
        else if (r.isError) status = SHELL.has(u.name) ? 'shell_exit' : 'failed';
        else status = 'ok';
        const ok = status === 'ok';
        records.push({
          id,
          name: u.name,
          nameClass: toolNameClass(u.name),
          displayName: toolDisplayName(u.name),
          sessionId: u.sessionId,
          fileIdx: u.fileIdx,
          fileClass: files[u.fileIdx] ? files[u.fileIdx].fileClass : 'main',
          ts: u.ts,
          status,
          denialKind: r ? r.denialKind : null,
          errorCategory: r ? r.errorCategory : null,
          resultTs: r ? r.ts : null,
          filePathHash: u.filePathHash,
          fileLabel: u.fileLabel,
          editNewLines: ok ? u.editNewLines : null,
          writeLines: ok ? u.writeLines : null,
          commandIntents: u.commandIntents.slice(),
        });
      }
      records.sort((a, b) => {
        const ta = a.ts ?? -Infinity;
        const tb = b.ts ?? -Infinity;
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      let orphanToolResults = 0;
      for (const [id, r] of results) if (!uses.has(id) && inWindow(r.ts)) orphanToolResults++;
      return { records, duplicateToolUseIds: useOccurrences - uses.size, orphanToolResults };
    },
  };
}
