// I14. Activity receipts (DESIGN 6 I14, rule A32, use case U8).
//
// Defensible counts with method notes: active days, work blocks, prompts, interrupts, files
// created (an ok Write whose path hash had no earlier ok Write, Edit or MultiEdit), files edited
// (distinct path hashes with an ok Edit or MultiEdit), lines written by agent tool calls (NOT
// lines that survived), command intents with failure counts, models used and value.
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { COMMAND_INTENTS } from '../adapters/contract.js';
import { EDIT_TOOLS, WRITE_TOOLS } from '../constants.js';
import { displayNameFor, makeLabeler, sortTools } from './_util.js';

export const LINES_WRITTEN_LABEL = 'lines written by agent tool calls, not lines that survived';

export const ACTION_RECEIPTS = 'Export these with auditrail export --md or --json; the method notes travel with the numbers.';

export const insight = defineInsight({
  id: 'i14',
  title: 'Activity receipts',
  compute({ acc, prices, options }) {
    const redact = Boolean(options.redact);
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const edited = new Set();
    let filesCreated = 0;
    let linesWritten = 0;
    /** @type {Record<string, { count: number, failures: number }>} */
    const intents = {};
    for (const i of COMMAND_INTENTS) intents[i] = { count: 0, failures: 0 };

    // Tools in (ts, id) order: "earlier" is well defined and order independent.
    for (const t of sortTools(acc.tools)) {
      const isEdit = EDIT_TOOLS.includes(t.name);
      const isWrite = WRITE_TOOLS.includes(t.name);
      if (t.status === 'ok' && (isEdit || isWrite)) {
        if (isWrite && typeof t.writeLines === 'number') linesWritten += t.writeLines;
        if (isEdit && typeof t.editNewLines === 'number') linesWritten += t.editNewLines;
        if (t.filePathHash) {
          if (isWrite && !seen.has(t.filePathHash)) filesCreated++;
          if (isEdit) edited.add(t.filePathHash);
          seen.add(t.filePathHash);
        }
      }
      for (const i of Array.isArray(t.commandIntents) ? t.commandIntents : []) {
        if (!intents[i]) continue;
        intents[i].count++;
        if (t.status === 'shell_exit' || t.status === 'failed') intents[i].failures++;
      }
    }

    const unpricedLabel = makeLabeler('Unpriced model');
    const models = [];
    for (const m of acc.byModel) {
      const dn = displayNameFor(prices, m.model);
      models.push(dn || (redact ? unpricedLabel(m.model) : m.model));
    }
    const t = acc.time;
    const data = {
      activeDays: Array.isArray(t.activeDays) ? t.activeDays.length : 0,
      workBlocks: Array.isArray(t.workBlockSeconds) ? t.workBlockSeconds.length : 0,
      prompts: t.prompts,
      interrupts: t.interrupts,
      filesCreated,
      filesEdited: edited.size,
      linesWritten,
      linesWrittenLabel: LINES_WRITTEN_LABEL,
      commandIntents: COMMAND_INTENTS.map((intent) => ({ intent, count: intents[intent].count, failures: intents[intent].failures })),
      models: [...new Set(models)],
      totalNano: acc.totals.valueNano.toString(),
    };
    return { id: 'i14', shown: true, data, evidence: { count: t.prompts, unit: 'prompts' }, action: ACTION_RECEIPTS };
  },
});
