// I10. Workflow agent outcomes (DESIGN 6 I10, trap 6).
//
// Counts of workflow journal events by type only (payloads are never read). Failure rate =
// failed / started. Shown when at least 10 workflow agents started.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';

export const SHOW_MIN_STARTED = 10;

export const ACTION_WORKFLOWS = 'Prune or fix the workflows that fail often.';

export const insight = defineInsight({
  id: 'i10',
  title: 'Workflow agent outcomes',
  compute({ acc }) {
    const w = acc.workflows;
    const data = {
      launched: w.launched,
      started: w.started,
      result: w.result,
      failed: w.failed,
      failureRate: w.started > 0 ? Math.min(1, w.failed / w.started) : 0,
    };
    return { id: 'i10', shown: w.started >= SHOW_MIN_STARTED, data, evidence: { count: w.started, unit: 'workflow agents started' }, action: ACTION_WORKFLOWS };
  },
});
