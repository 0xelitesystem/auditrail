// I4. Delegation (DESIGN 6 I4, section 4.11).
//
// Delegation share = value of isSidechain responses / total value. Split by the kept file's
// class (subagent vs workflow agent). Agent runs = subagent plus workflow agent files that hold
// at least one kept response. Value by attribution (agent, skill, MCP server) is LOCAL: names
// are replaced with "Agent A", "Skill A", "MCP server A" under --redact and never reach the card.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { share, makeLabeler, safeLabel } from './_util.js';
import { shareAtLeast } from '../money.js';

export const ACTION_DELEGATION = 'Check whether delegation pays for itself, and pin an explicit, cheaper model for subagents and workflows where quality allows (see the repricing what-if).';

/** Shown when delegation share is at least this percent of value. */
export const SHOW_AT_PERCENT = 5;
/** At most this many rows per attribution list (the local report is a summary, not a dump). */
export const MAX_ATTRIBUTION_ROWS = 25;

/**
 * @param {import('../accounting/contract.js').ResponseRecord[]} responses
 * @param {'agent'|'skill'|'mcpServer'} field
 * @param {boolean} redact
 * @param {string} noun
 */
function byAttribution(responses, field, redact, noun) {
  /** @type {Map<string, { responses: number, nano: bigint }>} */
  const m = new Map();
  for (const r of responses) {
    const a = r.attribution;
    const name = a && typeof a[field] === 'string' && a[field] ? a[field] : null;
    if (!name) continue;
    let x = m.get(name);
    if (!x) { x = { responses: 0, nano: 0n }; m.set(name, x); }
    x.responses++;
    x.nano += BigInt(r.valueNano);
  }
  const rows = [...m.entries()].sort((a, b) => (a[1].nano !== b[1].nano ? (a[1].nano > b[1].nano ? -1 : 1) : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const label = makeLabeler(noun);
  return rows.slice(0, MAX_ATTRIBUTION_ROWS).map(([name, x]) => ({
    name: redact ? label(name) : safeLabel(name, noun.toLowerCase()), responses: x.responses, valueNano: x.nano.toString(),
  }));
}

export const insight = defineInsight({
  id: 'i04',
  title: 'Delegation',
  compute({ acc, options }) {
    const redact = Boolean(options.redact);
    let side = 0n;
    /** @type {Set<number>} */
    const runs = new Set();
    for (const r of acc.responses) {
      if (r.isSidechain) side += BigInt(r.valueNano);
      if (r.fileClass === 'subagent' || r.fileClass === 'workflow_agent') runs.add(r.fileIdx);
    }
    const total = acc.totals.valueNano;
    const data = {
      delegationShare: share(side, total),
      sidechainNano: side.toString(),
      subagent: { responses: acc.byClass.subagent.responses, valueNano: acc.byClass.subagent.valueNano.toString() },
      workflowAgent: { responses: acc.byClass.workflow_agent.responses, valueNano: acc.byClass.workflow_agent.valueNano.toString() },
      agentRuns: runs.size,
      byAttribution: {
        agent: byAttribution(acc.responses, 'agent', redact, 'Agent'),
        skill: byAttribution(acc.responses, 'skill', redact, 'Skill'),
        mcpServer: byAttribution(acc.responses, 'mcpServer', redact, 'MCP server'),
      },
    };
    const shown = total > 0n && shareAtLeast(side, total, SHOW_AT_PERCENT, 100);
    return { id: 'i04', shown, data, evidence: { count: runs.size, unit: 'agent runs' }, action: ACTION_DELEGATION };
  },
});
