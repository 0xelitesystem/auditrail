// I7. Tool reliability (DESIGN 6 I7, rules A30, A31, trap 43).
//
// Per tool: calls, paired results, and the four outcome statuses. Failure rate =
// (shell_exit + failed) / paired: denials are not failures and shell exits are labelled
// "non-zero exits", not errors. Longest fail run = the longest run of consecutive failing
// results of that tool within one file (a denied or ok result ends the run; unpaired calls
// have no result and are skipped). The table shows tools with at least 50 calls and a failure
// rate of at least 5%, plus the top 3 by failure count.
//
// Names: built-in names are public; MCP and other tool names are LOCAL and become "MCP tool A",
// "Other tool A" under --redact. The PUBLIC-SOURCE maps are keyed by TOOL_DISPLAY_NAMES only.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { TOOL_DISPLAY_NAMES, toolDisplayName, toolNameClass } from '../constants.js';
import { ERROR_CATEGORIES } from '../adapters/contract.js';
import { makeLabeler, safeLabel, sortTools } from './_util.js';

export const FLAG_MIN_CALLS = 50;
export const FLAG_MIN_FAILURE_RATE = 0.05;
export const FLAG_TOP_BY_FAILURES = 3;

/** Fixed action copy per dominant problem. */
export const TOOL_ACTIONS = Object.freeze({
  denied: 'Many calls were denied: adjust your permission rules so the agent stops asking for, or trying, what you always refuse.',
  timeout: 'Timeouts dominate: raise the tool timeout or fix the slow command.',
  edit_string_not_found: 'Edits keep missing their target: have the agent read the file before editing it.',
  file_not_read_first: 'Edits were refused because the file was not read first: read before editing.',
  shell_exit: 'Repeated non-zero exits: fix the script or command that keeps failing, or add a note on how to run it.',
  permission_or_hook: 'A permission rule or hook keeps blocking calls: review the rule or the hook.',
  none: 'Tool calls look healthy. Keep an eye on the rows flagged here as usage grows.',
});

/**
 * Pick the one action line: the largest of denials, shell exits and the error categories.
 * @param {{ denied: number, shell_exit: number }} status
 * @param {Record<string, number>} cats
 * @returns {string}
 */
export function toolAction(status, cats) {
  const candidates = [
    ['denied', status.denied],
    ['shell_exit', status.shell_exit],
    ['timeout', cats.timeout || 0],
    ['edit_string_not_found', cats.edit_string_not_found || 0],
    ['file_not_read_first', cats.file_not_read_first || 0],
    ['permission_or_hook', cats.permission_or_hook || 0],
  ];
  let best = null;
  for (const [k, n] of candidates) if (/** @type {number} */ (n) > 0 && (best === null || /** @type {number} */ (n) > best[1])) best = [k, n];
  return best ? TOOL_ACTIONS[/** @type {keyof typeof TOOL_ACTIONS} */ (best[0])] : TOOL_ACTIONS.none;
}

export const insight = defineInsight({
  id: 'i07',
  title: 'Tool reliability',
  compute({ acc, options }) {
    const redact = Boolean(options.redact);
    const tools = sortTools(acc.tools);
    const statusCounts = { ok: 0, denied: 0, shell_exit: 0, failed: 0, unpaired: 0 };
    /** @type {Record<string, number>} */
    const errorCategories = {};
    for (const c of ERROR_CATEGORIES) errorCategories[c] = 0;
    /** @type {Record<string, number>} */
    const callsByDisplayName = {};
    /** @type {Record<string, number>} */
    const okCallsByDisplayName = {};
    /** @type {Map<string, any>} */
    const rows = new Map();
    /** @type {Map<string, { file: number, name: string, run: number }>} */
    const runState = new Map();

    // Fail runs need per-file order: tools are in (ts, id) order.
    for (const t of tools) {
      const status = /** @type {keyof typeof statusCounts} */ (t.status in statusCounts ? t.status : 'ok');
      statusCounts[status]++;
      if (t.errorCategory) {
        const cat = ERROR_CATEGORIES.includes(t.errorCategory) ? t.errorCategory : 'other';
        errorCategories[cat]++;
      }
      const display = toolDisplayName(t.name);
      callsByDisplayName[display] = (callsByDisplayName[display] || 0) + 1;
      if (status === 'ok') okCallsByDisplayName[display] = (okCallsByDisplayName[display] || 0) + 1;

      let row = rows.get(t.name);
      if (!row) {
        row = { name: t.name, displayName: display, nameClass: toolNameClass(t.name), calls: 0, paired: 0, ok: 0, denied: 0, shellExit: 0, failed: 0, unpaired: 0, failureRate: 0, longestFailRun: 0 };
        rows.set(t.name, row);
      }
      row.calls++;
      if (status !== 'unpaired') row.paired++;
      if (status === 'ok') row.ok++;
      else if (status === 'denied') row.denied++;
      else if (status === 'shell_exit') row.shellExit++;
      else if (status === 'failed') row.failed++;
      else row.unpaired++;

      if (status !== 'unpaired') {
        const key = t.fileIdx + '|' + t.name;
        let st = runState.get(key);
        if (!st) { st = { file: t.fileIdx, name: t.name, run: 0 }; runState.set(key, st); }
        if (status === 'shell_exit' || status === 'failed') {
          st.run++;
          if (st.run > row.longestFailRun) row.longestFailRun = st.run;
        } else st.run = 0;
      }
    }

    const list = [...rows.values()];
    for (const r of list) r.failureRate = r.paired ? (r.shellExit + r.failed) / r.paired : 0;
    list.sort((a, b) => (a.calls !== b.calls ? b.calls - a.calls : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const flaggedSet = new Set();
    for (const r of list) if (r.calls >= FLAG_MIN_CALLS && r.failureRate >= FLAG_MIN_FAILURE_RATE) flaggedSet.add(r.name);
    const byFailures = list.filter((r) => r.shellExit + r.failed > 0)
      .sort((a, b) => (b.shellExit + b.failed) - (a.shellExit + a.failed) || (a.name < b.name ? -1 : 1));
    for (const r of byFailures.slice(0, FLAG_TOP_BY_FAILURES)) flaggedSet.add(r.name);

    // Local names: built-ins stay; MCP and other tools are collapsed under --redact.
    const mcpLabel = makeLabeler('MCP tool');
    const otherLabel = makeLabeler('Other tool');
    const localName = (/** @type {string} */ name) => {
      const cls = toolNameClass(name);
      if (cls === 'builtin') return name;
      if (redact) return cls === 'mcp' ? mcpLabel(name) : otherLabel(name);
      return safeLabel(name, 'tool').slice(0, 120);
    };
    const byTool = list.map((r) => ({ ...r, name: localName(r.name), failureRate: r.failureRate }));
    const flagged = list.filter((r) => flaggedSet.has(r.name)).map((r) => localName(r.name));

    const toolCalls = tools.length;
    // Top tool over display names; ties by TOOL_DISPLAY_NAMES order.
    let topTool = null;
    for (const dn of TOOL_DISPLAY_NAMES) {
      const n = callsByDisplayName[dn] || 0;
      if (n > 0 && (topTool === null || n > topTool.calls)) topTool = { displayName: dn, calls: n, share: n / toolCalls };
    }
    const paired = toolCalls - statusCounts.unpaired;
    const data = {
      toolCalls,
      paired,
      statusCounts,
      failureRate: paired ? (statusCounts.shell_exit + statusCounts.failed) / paired : 0,
      byTool,
      callsByDisplayName: ordered(callsByDisplayName),
      okCallsByDisplayName: ordered(okCallsByDisplayName),
      topTool,
      errorCategories,
      interrupts: acc.time.interrupts,
      flagged,
    };
    return { id: 'i07', shown: true, data, evidence: { count: toolCalls, unit: 'tool calls' }, action: toolAction(statusCounts, errorCategories) };
  },
});

/**
 * Keys in TOOL_DISPLAY_NAMES order, only those present.
 * @param {Record<string, number>} m
 * @returns {Record<string, number>}
 */
function ordered(m) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of TOOL_DISPLAY_NAMES) if (m[k]) out[k] = m[k];
  return out;
}
