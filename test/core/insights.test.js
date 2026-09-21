// Insights i01 to i14 end to end on the synthetic fixtures (DESIGN 6, 9.2, 9.3, 9.5, 9.7).
//
// Every fixture goes through the real reader, the Claude Code adapter and accounting (the
// shared harness), then through runInsights(). Expected values come from three places, none of
// them src/ code:
//   golden-core     numbers typed in from DESIGN 9.2 and hand arithmetic shown in the comments
//                   (Opus 5 rates 5 / 6.25 / 10 / 0.50 / 25, Sonnet 5 rates 2 / 2.50 / 4 / 0.20
//                   / 10 USD per million tokens; tokens x milli-dollar rate = nanodollars);
//   golden-pricing  DESIGN 9.3 case values;
//   personas        ground-truth.json, written by the generator from each response's TRUE usage
//                   before it was split into lines, plus calendar facts (2026-03-02 is a Monday).
// Everything here is fictional: /fake paths, -fake- folders, aaaaaaaa- ids.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPipeline, discover, parseAll, FIXTURES } from '../accounting/_harness.js';
import { createAccounting } from '../../src/core/accounting/index.js';
import { claudeCodeAdapter } from '../../src/core/adapters/claude-code/index.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { createSecretScanner } from '../../src/core/secrets.js';
import { runInsights, insightOptions } from '../../src/core/insights/index.js';
import { INSIGHT_IDS, checkInsightResult } from '../../src/core/insights/contract.js';
import { REDACTED_LABEL_RE } from '../../src/core/insights/_util.js';
import { TOOL_ACTIONS } from '../../src/core/insights/i07-tools.js';
import { REPRICING_LABEL } from '../../src/core/insights/i05-repricing.js';
import { LINES_WRITTEN_LABEL } from '../../src/core/insights/i14-receipts.js';
import { VALUE_LABEL, CLAUDE_CODE_DEFAULT_RETENTION_DAYS } from '../../src/core/constants.js';

const NOW = Date.UTC(2026, 8, 14);
const PRICES = getPriceTable();
const PERSONAS = ['solo-night-owl', 'subagent-lead', 'cache-miss-spender'];
const root = (fixture) => path.join(FIXTURES, fixture, 'projects');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...p), 'utf8'));
const fp12 = (v) => createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 12);

/** Display shares are exact ratios floored to 12 decimals (money.ratio): compare to the fraction. */
function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-11, (msg ? msg + ': ' : '') + actual + ' vs ' + expected);
}

/** Run one fixture (or several roots) through the pipeline and every insight. */
async function insightsFor(roots, opts = {}) {
  const run = await runPipeline(roots, { tz: 'UTC', idleMinutes: 15, scanSecrets: createSecretScanner({ nowMs: NOW }), order: opts.order });
  const ins = runInsights({ acc: run.result, prices: PRICES, options: insightOptions({ tz: 'UTC', idleMinutes: 15, nowMs: NOW, ...(opts.options || {}) }) });
  return { acc: run.result, ins };
}

/**
 * The same pipeline with one change applied to the parsed events, so a single field of a
 * committed fixture can be varied without writing a second fixture to disk.
 */
async function insightsForVariant(fixture, mapEvent) {
  const roots = [root(fixture)];
  const { refs, skipped } = discover(roots);
  const parsed = await parseAll(roots, refs);
  const acc = createAccounting({
    prices: PRICES, tz: 'UTC', idleMinutes: 15, pathStyle: 'auto', overrides: null, projectRules: [], since: null, until: null, adapter: claudeCodeAdapter,
  });
  acc.addFiles(refs);
  for (const [reason, n] of Object.entries(skipped)) if (n) acc.addSkippedFile(reason, n);
  for (const p of parsed) acc.onEvents(p.events.map((ev) => mapEvent(ev, p.file)), p.file);
  for (const p of parsed) acc.onFileDone(p.file, p.stats);
  const result = acc.finish();
  return { acc: result, ins: runInsights({ acc: result, prices: PRICES, options: insightOptions({ tz: 'UTC', idleMinutes: 15, nowMs: NOW }) }) };
}

/** @type {Record<string, { acc: any, ins: any }>} */
const R = {};

before(async () => {
  for (const f of ['golden-core', 'golden-pricing', 'canary', ...PERSONAS.map((p) => 'personas/' + p)]) R[f] = await insightsFor(root(f));
});

/* ------------------------------------------------------------------------------------------
 * Contract, on every fixture
 * ---------------------------------------------------------------------------------------- */

test('every fixture: fourteen results in INSIGHT_IDS order, each valid and JSON-safe', () => {
  for (const [name, { ins }] of Object.entries(R)) {
    assert.deepEqual(Object.keys(ins), [...INSIGHT_IDS], name);
    for (const id of INSIGHT_IDS) {
      assert.deepEqual(checkInsightResult(ins[id], id), [], name + ' ' + id);
      assert.deepEqual(JSON.parse(JSON.stringify(ins[id])), ins[id], name + ' ' + id + ' survives a JSON round trip');
    }
  }
});

test('order independence (DESIGN 9.4): reversing file order gives byte-identical insights', async () => {
  for (const f of ['golden-core', 'personas/subagent-lead']) {
    const rev = await insightsFor(root(f), { order: (refs) => [...refs].reverse() });
    assert.equal(JSON.stringify(rev.ins), JSON.stringify(R[f].ins), f);
  }
});

/* ------------------------------------------------------------------------------------------
 * golden-core (DESIGN 9.2): R1 and R2 on Opus 5 in the main file, R3 and R4 on Sonnet 5 in the
 * subagent file, R4 incomplete, one synthetic 429 at 09:40, prompts at 09:00 and 09:41.
 * ---------------------------------------------------------------------------------------- */

test('i01 golden-core: $0.042080 total, 7,307 priced tokens, 25% incomplete, $0.02104 per prompt', () => {
  const { data, shown, evidence, action } = R['golden-core'].ins.i01;
  assert.equal(shown, true, 'always shown');
  assert.deepEqual(evidence, { count: 4, unit: 'responses' });
  assert.ok(typeof action === 'string' && action.length > 0);
  assert.equal(data.label, VALUE_LABEL);
  assert.equal(data.pricesAsOf, '2026-09-14');
  assert.equal(data.customRates, false);
  // 23,500,000 + 13,750,000 + 4,520,000 + 310,000 n$.
  assert.equal(data.totalNano, '42080000');
  assert.equal(data.responses, 4);
  assert.equal(data.incompleteResponses, 1);
  assert.equal(data.incompleteShare, 0.25);
  // input 180 + output 627 + 5m writes 1,000 + 1h writes 2,500 + reads 3,000.
  assert.equal(data.pricedTokens, 7307);
  assert.equal(data.allTokens, 7307);
  assert.equal(data.pricedTokenShare, 1);
  assert.deepEqual(data.unpriced, []);
  assert.equal(data.fastResponses, 0);
  assert.equal(data.prompts, 2);
  assert.equal(data.valuePerPromptNano, '21040000', '42,080,000 / 2 prompts');
  assert.deepEqual(data.byMonth, [{ month: '2026-03', valueNano: '42080000', responses: 4 }]);
  assert.deepEqual(data.byDay, [{ date: '2026-03-02', valueNano: '42080000', responses: 4 }]);
  assert.deepEqual(data.byModel, [
    { model: 'claude-opus-5', displayName: 'Claude Opus 5', valueNano: '37250000', responses: 2 },
    { model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', valueNano: '4830000', responses: 2 },
  ]);
  assert.deepEqual(data.byProject, [{ label: 'alpha', valueNano: '42080000', responses: 4, sessions: 1 }], 'basename of /fake/alpha');
  assert.deepEqual(data.byClassNano, { main: '37250000', subagent: '4830000', workflow_agent: '0' });
  assert.equal(data.plan, null);
  assert.equal(data.valueMultiple, null, 'no --plan, no multiple');
  // R4 is incomplete but holds only a tool_use block (0 visible characters) and no response
  // recorded thinking tokens, so rule A6 has nothing to fit: an empty band, outside every total.
  assert.deepEqual(data.incompleteBand, { lowTokens: 0, highTokens: 0, lowNano: '0', highNano: '0' });
});

test('i01 golden-core: --plan value multiple is value per month over the plan price', async () => {
  const { ins } = await insightsFor(root('golden-core'), { options: { plan: { name: 'Fictional plan', usdPerMonth: 0.02 } } });
  // $0.04208 floored to 4 cents, over 1 month, over $0.02 a month = 2.
  assert.equal(ins.i01.data.valueMultiple, 2);
  assert.deepEqual(ins.i01.data.plan, { name: 'Fictional plan', usdPerMonth: 0.02 });
});

test('i02 golden-core: five buckets, hit rate 3,000 / 6,680, net caching saving -$0.0022', () => {
  const { data, shown } = R['golden-core'].ins.i02;
  assert.equal(shown, true);
  // input 180 tokens: Opus 150 x 5,000 + Sonnet 30 x 2,000 = 810,000.
  // output: Opus 420 x 25,000 + Sonnet 207 x 10,000 = 12,570,000.
  // 5m writes: Sonnet 1,000 x 2,500 = 2,500,000. 1h writes: Opus 2,500 x 10,000 = 25,000,000.
  // reads: Opus 2,000 x 500 + Sonnet 1,000 x 200 = 1,200,000.
  assert.deepEqual(data.bucketsNano, { input: '810000', output: '12570000', cw5m: '2500000', cw1h: '25000000', cacheRead: '1200000' });
  const five = 42_080_000;
  close(data.bucketShares.input, 810_000 / five, 'input share');
  close(data.bucketShares.output, 12_570_000 / five, 'output share');
  close(data.bucketShares.cw5m, 2_500_000 / five, '5m share');
  close(data.bucketShares.cw1h, 25_000_000 / five, '1h share');
  close(data.bucketShares.cacheRead, 1_200_000 / five, 'read share');
  close(data.cacheHitRate, 3000 / 6680, 'DESIGN 9.2 hit rate 0.4491');
  // As uncached input: Opus (2,000 + 2,500) x 5,000 + Sonnet (1,000 + 1,000) x 2,000 = 26,500,000.
  // As cache: reads 1,200,000 + 5m 2,500,000 + 1h 25,000,000 = 28,700,000. Net: -2,200,000.
  assert.equal(data.netCachingSavingNano, '-2200000');
  // Three headline figures, never one total: output, fresh input (180 + 1,000 + 2,500), reads.
  assert.deepEqual(data.tokens, { output: 627, freshInput: 3680, cacheRead: 3000 });
});

test('i03 golden-core: each response in one bucket by in-file gap; nothing after an hour, so not shown', () => {
  const { data, shown, evidence } = R['golden-core'].ins.i03;
  // Main file: R1 (09:00:10) first, 2,000 1h writes x 10,000 = 20,000,000; R2 (09:05:05, the
  // earliest line of the key) is 4 min 55 s later on the same model: at most 5 minutes,
  // 500 x 10,000 = 5,000,000. Subagent file: R3 (09:06:05) first, 1,000 5m writes x 2,500 =
  // 2,500,000; R4 (09:20:00) is 13 min 55 s later: 5 to 60 minutes, no writes.
  assert.deepEqual(data.buckets, {
    first: { responses: 2, cacheWriteNano: '22500000' },
    modelSwitch: { responses: 0, cacheWriteNano: '0' },
    le5m: { responses: 1, cacheWriteNano: '5000000' },
    m5to60: { responses: 1, cacheWriteNano: '0' },
    gt60m: { responses: 0, cacheWriteNano: '0' },
  });
  assert.equal(data.gt60mShareOfTotal, 0);
  assert.equal(data.fullMisses, 0, 'no response writes more than 20,000 tokens');
  assert.equal(data.fullMissesAfterGap60, 0);
  assert.equal(shown, false, 'shown only at >= 5% of value after a gap over 60 minutes');
  assert.deepEqual(evidence, { count: 0, unit: 'responses' });
});

test('i04 golden-core: delegation 4,830,000 / 42,080,000 (11.48%) from one subagent run', () => {
  const { data, shown, evidence } = R['golden-core'].ins.i04;
  close(data.delegationShare, 4_830_000 / 42_080_000, 'DESIGN 9.2 delegation share');
  assert.equal(data.sidechainNano, '4830000', 'R3 4,520,000 + R4 310,000');
  assert.deepEqual(data.subagent, { responses: 2, valueNano: '4830000' });
  assert.deepEqual(data.workflowAgent, { responses: 0, valueNano: '0' });
  assert.equal(data.agentRuns, 1, 'one subagent file holds kept responses');
  assert.deepEqual(data.byAttribution, { agent: [], skill: [], mcpServer: [] });
  assert.equal(shown, true, '11.48% is at least 5%');
  assert.deepEqual(evidence, { count: 1, unit: 'agent runs' });
});

test('i05 golden-core: the sidechain runs on Sonnet 5 only, so nothing is eligible', () => {
  const { data, shown, evidence } = R['golden-core'].ins.i05;
  assert.deepEqual(data, {
    eligibleResponses: 0, eligibleNano: '0', atSonnet5Nano: '0', differenceNano: '0', eligibleShareOfTotal: 0, label: REPRICING_LABEL,
  });
  assert.equal(shown, false);
  assert.deepEqual(evidence, { count: 0, unit: 'responses' });
});

test('i05 golden-core variant: R3 on Opus 5 reprices back to its Sonnet 5 golden value', async () => {
  // One field changed: the subagent response msg_03 runs on Opus 5 instead of Sonnet 5.
  const { ins } = await insightsForVariant('golden-core', (ev) => (ev.kind === 'response' && ev.messageId === 'msg_03' ? { ...ev, rawModel: 'claude-opus-5' } : ev));
  // R3 tokens: input 10, 5m writes 1,000, output 200.
  // At Opus 5: 10 x 5,000 + 1,000 x 6,250 + 200 x 25,000 = 11,300,000.
  // At Sonnet 5: 10 x 2,000 + 1,000 x 2,500 + 200 x 10,000 = 4,520,000 (R3's DESIGN 9.2 value).
  // New total: 23,500,000 + 13,750,000 + 11,300,000 + 310,000 = 48,860,000.
  assert.equal(ins.i01.data.totalNano, '48860000');
  const d = ins.i05.data;
  assert.equal(d.eligibleResponses, 1, 'R4 stays on Sonnet 5; R1 and R2 are main thread');
  assert.equal(d.eligibleNano, '11300000');
  assert.equal(d.atSonnet5Nano, '4520000');
  assert.equal(d.differenceNano, '6780000');
  close(d.eligibleShareOfTotal, 11_300_000 / 48_860_000);
  assert.equal(d.label, REPRICING_LABEL);
  assert.equal(ins.i05.shown, true, '23.1% is at least 20%');
  // The same change turns R4 (Sonnet 5 after an Opus 5 response in its file) into a model switch.
  assert.deepEqual(ins.i03.data.buckets.modelSwitch, { responses: 1, cacheWriteNano: '0' });
  // First in file: R1 20,000,000 + R3's 1,000 5m writes now at the Opus 5 rate, 1,000 x 6,250.
  assert.deepEqual(ins.i03.data.buckets.first, { responses: 2, cacheWriteNano: '26250000' });
});

test('i06 golden-core: no quota window, one synthetic 429 at 09:40 is one episode', () => {
  const { data, shown, evidence } = R['golden-core'].ins.i06;
  const hours = new Array(24).fill(0);
  hours[9] = 1;
  assert.deepEqual(data, { windows: 0, byType: [], synthetic429Lines: 1, episodes: 1, episodeStartsByLocalHour: hours, valueBeforeWindows: [] });
  assert.equal(shown, true, 'shown when episodes >= 1');
  assert.deepEqual(evidence, { count: 0, unit: 'windows' });
});

test('i07 golden-core: 4 calls, 3 paired, one of each status, failure rate 1 / 3', () => {
  const { data, shown, action } = R['golden-core'].ins.i07;
  assert.equal(shown, true);
  assert.equal(data.toolCalls, 4, 'the duplicate Edit id counts once');
  assert.equal(data.paired, 3);
  assert.deepEqual(data.statusCounts, { ok: 1, denied: 1, shell_exit: 1, failed: 0, unpaired: 1 });
  assert.equal(data.failureRate, 1 / 3, 'shell_exit 1 over 3 paired; the denial is not a failure');
  const row = Object.fromEntries(data.byTool.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(row), ['Bash', 'Edit', 'Read', 'Write'], 'calls desc, then name');
  assert.deepEqual([row.Bash.shellExit, row.Bash.failureRate, row.Bash.longestFailRun], [1, 1, 1]);
  assert.deepEqual([row.Edit.ok, row.Edit.failureRate], [1, 0]);
  assert.deepEqual([row.Read.unpaired, row.Read.paired], [1, 0]);
  assert.deepEqual([row.Write.denied, row.Write.failureRate], [1, 0]);
  assert.deepEqual(data.callsByDisplayName, { Bash: 1, Read: 1, Write: 1, Edit: 1 });
  assert.deepEqual(data.okCallsByDisplayName, { Edit: 1 });
  // Four tools at one call each: the tie goes to the first display name in allowlist order.
  assert.deepEqual(data.topTool, { displayName: 'Bash', calls: 1, share: 0.25 });
  assert.equal(data.errorCategories.permission_or_hook, 1, 'the Write denied by a permission rule');
  assert.equal(data.errorCategories.other, 1, 'the Bash non-zero exit');
  assert.equal(data.interrupts, 0);
  assert.deepEqual(data.flagged, ['Bash'], 'the only tool with a failure');
  assert.equal(action, TOOL_ACTIONS.denied, 'denials, shell exits and hook blocks tie at 1: the first candidate wins');
});

test('i08 golden-core: one ok Edit of one file adding 1 line; no hot spot', () => {
  const { data, shown } = R['golden-core'].ins.i08;
  assert.deepEqual(data, {
    distinctFiles: 1, filesWithTenPlusEdits: 0, maxEditsOneFile: 1, maxEditsOneFileOneBlock: 1,
    top: [{ label: 'fake/a.txt', edits: 1 }], medianEditNewLines: 1,
  }, 'the Write was denied, so only the Edit of /fake/a.txt ("b": 1 line) counts');
  assert.equal(shown, false, 'shown from 10 edits of one file');
});

test('i09 golden-core: 21 active minutes, 27 agent minutes, blocks of 20 and 1 minutes', () => {
  const { data, shown } = R['golden-core'].ins.i09;
  assert.equal(shown, true);
  assert.equal(data.activeSeconds, 1260);
  assert.equal(data.activeHours, 0.4, '0.35 h rounded to one decimal');
  assert.equal(data.agentSeconds, 1620, 'main 780 + subagent 840');
  assert.equal(data.agentHours, 0.5, '0.45 h rounded to one decimal');
  assert.equal(data.workBlocks, 2);
  assert.equal(data.longestBlockSeconds, 1200);
  assert.equal(data.medianBlockSeconds, 630, 'mean of 60 and 1,200');
  assert.equal(data.p90BlockSeconds, 1200, 'nearest rank: ceil(0.9 x 2) = 2nd of 2');
  assert.equal(data.prompts, 2);
  assert.equal(data.interrupts, 0);
  assert.equal(data.activeDays, 1);
  assert.equal(data.longestStreakDays, 1);
  assert.equal(data.peakHourLocal, 9);
  const heat = new Array(7).fill(0).map(() => new Array(24).fill(0));
  heat[0][9] = 2; // 2026-03-02 is a Monday; both prompts are in the 09:00 hour.
  assert.deepEqual(data.heatmap, heat);
  assert.equal(data.nightPromptShare, 0);
  assert.equal(data.weekendDayShare, 0);
  assert.equal(data.firstActiveLocalDate, '2026-03-02');
  assert.equal(data.lastActiveLocalDate, '2026-03-02');
});

test('i10 golden-core: no workflow journals, so all zero and not shown', () => {
  const { data, shown } = R['golden-core'].ins.i10;
  assert.deepEqual(data, { launched: 0, started: 0, result: 0, failed: 0, failureRate: 0 });
  assert.equal(shown, false);
});

test('i11 golden-core: no secret in the fixture, nothing to show', () => {
  const { data, shown, evidence } = R['golden-core'].ins.i11;
  assert.deepEqual(data, { findings: [], bySeverity: { critical: 0, likely_fixture: 0, third_party_public: 0 } });
  assert.equal(shown, false);
  assert.deepEqual(evidence, { count: 0, unit: 'critical findings' });
});

test('i12 golden-core: one day covered, retention unset so the 30-day default applies', () => {
  const { data, shown } = R['golden-core'].ins.i12;
  assert.equal(shown, true, 'always shown');
  assert.deepEqual(data, {
    earliestMainLocalDate: '2026-03-02', earliestAnyLocalDate: '2026-03-02', latestLocalDate: '2026-03-02', coverageDays: 1,
    cleanupPeriodDays: null, retentionIsDefault: true, effectiveRetentionDays: CLAUDE_CODE_DEFAULT_RETENTION_DAYS,
    deletedHistoryDays: null, orphanDays: 0, topOfReport: true,
  });
  assert.equal(CLAUDE_CODE_DEFAULT_RETENTION_DAYS, 30);
});

test('i12 golden-core: settings and stats-cache days count history already deleted', async () => {
  const { ins } = await insightsFor(root('golden-core'), {
    options: { cleanupPeriodDays: 3650, statsCacheDays: ['2026-02-27', '2026-03-01', '2026-03-02', 'not-a-date'] },
  });
  const d = ins.i12.data;
  assert.equal(d.cleanupPeriodDays, 3650);
  assert.equal(d.retentionIsDefault, false);
  assert.equal(d.effectiveRetentionDays, 3650);
  assert.equal(d.deletedHistoryDays, 2, 'Feb 27 and Mar 1 predate the first main-thread event; junk is ignored');
  assert.ok(!/cleanupPeriodDays"?: ?0\b/.test(ins.i12.action), 'never recommends 0');
  assert.match(ins.i12.action, /"cleanupPeriodDays": 3650/);
});

test('i12 golden-core variant: subagent activity on a day with no main-thread event is an orphan day', async () => {
  const DAY = 86_400_000;
  // One change: every event in the subagent file happens one day later (2026-03-03).
  const { ins } = await insightsForVariant('golden-core', (ev, file) => (file.fileClass === 'subagent' && typeof ev.ts === 'number' ? { ...ev, ts: ev.ts + DAY } : ev));
  const d = ins.i12.data;
  assert.equal(d.orphanDays, 1, 'R3 and R4 on Mar 3, no main-thread response or prompt that day');
  assert.equal(d.earliestAnyLocalDate, '2026-03-02');
  assert.equal(d.latestLocalDate, '2026-03-03');
  assert.equal(d.coverageDays, 2);
});

test('i13 golden-core: Opus 5 is 88.5% of value; no thinking breakdown recorded; effort unset', () => {
  const { data, shown } = R['golden-core'].ins.i13;
  assert.equal(shown, true);
  assert.equal(data.byModel.length, 2);
  assert.deepEqual(data.byModel.map((m) => [m.model, m.displayName, m.responses, m.valueNano]), [
    ['claude-opus-5', 'Claude Opus 5', 2, '37250000'],
    ['claude-sonnet-5', 'Claude Sonnet 5', 2, '4830000'],
  ]);
  close(data.byModel[0].share, 37_250_000 / 42_080_000);
  close(data.byModel[1].share, 4_830_000 / 42_080_000);
  assert.deepEqual(data.topModel, { model: 'claude-opus-5', displayName: 'Claude Opus 5' });
  assert.equal(data.thinkingShare, null, 'no line carries output_tokens_details');
  assert.deepEqual(data.effort, { unset: 4 });
});

test('i14 golden-core: 1 file edited, 0 created (the Write was denied), 1 line written', () => {
  const { data, shown } = R['golden-core'].ins.i14;
  assert.equal(shown, true);
  assert.deepEqual(data, {
    activeDays: 1, workBlocks: 2, prompts: 2, interrupts: 0, filesCreated: 0, filesEdited: 1, linesWritten: 1,
    linesWrittenLabel: LINES_WRITTEN_LABEL,
    commandIntents: [
      { intent: 'git_commit', count: 0, failures: 0 }, { intent: 'git_push', count: 0, failures: 0 },
      { intent: 'test', count: 0, failures: 0 }, { intent: 'build', count: 0, failures: 0 }, { intent: 'install', count: 0, failures: 0 },
    ],
    models: ['Claude Opus 5', 'Claude Sonnet 5'],
    totalNano: '42080000',
  });
  assert.equal(LINES_WRITTEN_LABEL, 'lines written by agent tool calls, not lines that survived');
});

/* ------------------------------------------------------------------------------------------
 * golden-pricing (DESIGN 9.3)
 * ---------------------------------------------------------------------------------------- */

test('i01 and i13 golden-pricing: $0.1739125 over priced cases, one unpriced model listed', () => {
  const { i01, i13, i14 } = R['golden-pricing'].ins;
  assert.equal(i01.data.totalNano, '173912500');
  assert.equal(i01.data.responses, 9, 'R5, R5b, R6, R7, R8, R9, R10, R12, R13');
  assert.deepEqual(i01.data.unpriced, [{ model: 'claude-imaginary-9', responses: 1, tokens: 1000 }], 'R10: in 500, out 500');
  // Priced tokens: R5 2,250 + R5b 900 (the declined attempt is not billed) + R6 100,110 +
  // R7 2,000 + R8 2,000 + R9 2,000 + R12 1,010 + R13 1,010 = 111,280; all tokens add R10's 1,000.
  assert.equal(i01.data.pricedTokens, 111_280);
  assert.equal(i01.data.allTokens, 112_280);
  close(i01.data.pricedTokenShare, 111_280 / 112_280);
  assert.equal(i01.data.fastResponses, 1, 'R7');
  assert.equal(i01.data.prompts, 0);
  assert.equal(i01.data.valuePerPromptNano, null, 'no prompts, no per-prompt value');
  // By billed model: Opus 5 = R7 60,000,000 + R8 33,000,000 + R12 9,312,500 + R13 6,500,000;
  // Fable 5.1 = R6; Opus 4.8 = R5 second part (1,000 x 5,000 + 200 x 25,000) + R5b billed part
  // (800 x 5,000 + 100 x 25,000); Fable 5 = R5 first part (1,000 x 10,000 + 50 x 50,000); Haiku = R9.
  const want = [
    ['claude-opus-5', 4, '108812500'], ['claude-fable-5-1', 1, '30100000'], ['claude-opus-4-8', 2, '16500000'],
    ['claude-fable-5', 1, '12500000'], ['claude-haiku-4-5', 1, '6000000'], ['claude-imaginary-9', 1, '0'],
  ];
  assert.deepEqual(i13.data.byModel.map((m) => [m.model, m.responses, m.valueNano]), want);
  assert.equal(i13.data.byModel.at(-1).displayName, null, 'an unknown model has no display name');
  assert.deepEqual(i13.data.topModel, { model: 'claude-opus-5', displayName: 'Claude Opus 5' });
  assert.deepEqual(i14.data.models, ['Claude Opus 5', 'Claude Fable 5.1', 'Claude Opus 4.8', 'Claude Fable 5', 'Claude Haiku 4.5', 'claude-imaginary-9']);
});

test('i01 golden-pricing --redact: the unpriced model id is replaced everywhere', async () => {
  const { ins } = await insightsFor(root('golden-pricing'), { options: { redact: true } });
  assert.deepEqual(ins.i01.data.unpriced, [{ model: 'Unpriced model A', responses: 1, tokens: 1000 }]);
  assert.ok(!JSON.stringify(ins).includes('claude-imaginary-9'));
});

/* ------------------------------------------------------------------------------------------
 * Personas (DESIGN 9.5) against their ground truth
 * ---------------------------------------------------------------------------------------- */

test('personas: i01, i02, i04 and i13 money equals the ground truth to the nanodollar', () => {
  for (const p of PERSONAS) {
    const gt = readJson('personas', p, 'ground-truth.json');
    const { i01, i02, i04, i13 } = R['personas/' + p].ins;
    assert.equal(i01.data.totalNano, gt.valueNano, p + ' total');
    assert.equal(i01.data.responses, gt.responses, p);
    assert.equal(i01.data.incompleteResponses, gt.incompleteResponses, p);
    assert.equal(i01.data.pricedTokens, gt.pricedTokens, p);
    assert.equal(i01.data.allTokens, gt.allTokens, p);
    assert.deepEqual(i01.data.unpriced, gt.unpriced, p);
    assert.deepEqual(i01.data.byClassNano, gt.byClassNano, p);
    assert.equal(i01.data.fastResponses, gt.modifiers.fast, p);
    assert.equal(i01.data.prompts, gt.prompts, p);
    const { input, output, cw5m, cw1h, cacheRead } = gt.bucketsNano;
    assert.deepEqual(i02.data.bucketsNano, { input, output, cw5m, cw1h, cacheRead }, p + ' buckets');
    close(i02.data.cacheHitRate, gt.cacheHitRate.num / gt.cacheHitRate.den, p + ' hit rate');
    assert.deepEqual(i02.data.tokens, { output: gt.tokens.output, freshInput: gt.tokens.input + gt.tokens.cw5m + gt.tokens.cw1h, cacheRead: gt.tokens.cacheRead }, p);
    assert.equal(i04.data.sidechainNano, gt.sidechainNano, p + ' sidechain');
    close(i04.data.delegationShare, Number(gt.delegationShare.numNano) / Number(gt.delegationShare.denNano), p + ' delegation');
    const priced = Object.fromEntries(i13.data.byModel.filter((m) => m.displayName !== null).map((m) => [m.model, m.valueNano]));
    assert.deepEqual(priced, gt.byModelNano, p + ' by model');
    const top = Object.entries(gt.byModelNano).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1))[0][0];
    assert.equal(i13.data.topModel.model, top, p + ' top model by value');
  }
});

test('personas: i01 and i04 hand facts (sessions, delegation threshold, agent runs)', () => {
  // solo-night-owl: 362,776,000 / 11,833,554,500 = 3.07% delegation, under 5%: not shown.
  assert.equal(R['personas/solo-night-owl'].ins.i04.shown, false);
  assert.equal(R['personas/solo-night-owl'].ins.i04.data.agentRuns, 4, 'four subagent files');
  // subagent-lead: 5,455,005,850 / 13,718,309,350 = 39.8%, shown; subagent 3,198,744,700 plus
  // workflow agents 2,256,261,150 is exactly the sidechain value.
  const lead = R['personas/subagent-lead'].ins.i04;
  assert.equal(lead.shown, true);
  assert.equal(BigInt(lead.data.subagent.valueNano) + BigInt(lead.data.workflowAgent.valueNano), 5_455_005_850n);
  // 31 subagent + 30 workflow agent files, two of which are copies of one agent (the orphaned
  // duplicate): every response of that pair is kept from one copy, so 60 runs.
  assert.equal(lead.data.agentRuns, 31 + 30 - 1);
  assert.deepEqual(lead.data.byAttribution.agent.map((a) => [a.name, a.responses]), [['fictional-reviewer', 40]]);
  assert.deepEqual(lead.data.byAttribution.skill.map((a) => [a.name, a.responses]), [['fictional-skill', 40]]);
  // cache-miss-spender: 196,489,600 / 14,408,592,700 = 1.36%: not shown.
  assert.equal(R['personas/cache-miss-spender'].ins.i04.shown, false);
});

test('i01 solo-night-owl: the rule A6 band is priced at the Sonnet 5 output rate and stays out of the total', () => {
  const { acc, ins } = R['personas/solo-night-owl'];
  // All 4 incomplete responses are Sonnet 5 subagent responses (ground truth: incomplete 4).
  const inc = acc.responses.filter((r) => !r.complete);
  assert.equal(inc.length, 4);
  assert.ok(inc.every((r) => r.model === 'claude-sonnet-5'));
  const b = ins.i01.data.incompleteBand;
  assert.ok(b.lowTokens > 0 && b.highTokens >= b.lowTokens);
  assert.equal(b.lowNano, String(b.lowTokens * 10_000), 'Sonnet 5 output: 10,000 milli per token');
  assert.equal(b.highNano, String(b.highTokens * 10_000));
  assert.equal(ins.i01.data.totalNano, readJson('personas', 'solo-night-owl', 'ground-truth.json').valueNano, 'the band never enters the total');
});

test('i03 cache-miss-spender: the idle-resume tax fires; buckets conserve every response and every write', () => {
  const gt = readJson('personas', 'cache-miss-spender', 'ground-truth.json');
  const { data, shown } = R['personas/cache-miss-spender'].ins.i03;
  const keys = ['first', 'modelSwitch', 'le5m', 'm5to60', 'gt60m'];
  assert.equal(keys.reduce((a, k) => a + data.buckets[k].responses, 0), gt.responses, 'each response in exactly one bucket');
  const writes = keys.reduce((a, k) => a + BigInt(data.buckets[k].cacheWriteNano), 0n);
  assert.equal(writes, BigInt(gt.bucketsNano.cw5m) + BigInt(gt.bucketsNano.cw1h), 'bucket write value = 5m + 1h write value');
  assert.ok(data.buckets.gt60m.responses > 0);
  assert.ok(BigInt(data.buckets.gt60m.cacheWriteNano) * 100n >= 5n * BigInt(gt.valueNano), 'over-an-hour writes are at least 5% of value');
  assert.equal(shown, true);
  assert.ok(data.fullMissesAfterGap60 > 0 && data.fullMissesAfterGap60 <= data.fullMisses);
  // The other two personas never pause for more than an hour inside one file.
  for (const p of ['solo-night-owl', 'subagent-lead']) {
    const x = R['personas/' + p].ins.i03;
    assert.equal(x.data.buckets.gt60m.responses, 0, p);
    assert.equal(x.shown, false, p);
  }
});

test('i06 subagent-lead: 2 five-hour windows, 5 synthetic 429s in 2 episodes, 1 response in the lookbacks', () => {
  const gt = readJson('personas', 'subagent-lead', 'ground-truth.json');
  const { data, shown, evidence } = R['personas/subagent-lead'].ins.i06;
  // Rejected quota lines: Mar 5 14:35:12 and Mar 10 09:11:06, two distinct resetsAt values
  // (an allowed_warning on Mar 4 is not a window). Synthetic 429s: 14:35:30, 14:35:37,
  // 14:36:00 (one episode) and 09:11:23, 09:11:37 (one episode).
  assert.equal(data.windows, gt.rateLimits.quotaRejectWindows);
  assert.equal(data.windows, 2);
  assert.deepEqual(data.byType, [{ rateLimitType: 'five_hour', windows: 2 }]);
  assert.equal(data.synthetic429Lines, gt.rateLimits.synthetic429Lines);
  assert.equal(data.episodes, 2);
  const hours = new Array(24).fill(0);
  hours[9] = 1;
  hours[14] = 1;
  assert.deepEqual(data.episodeStartsByLocalHour, hours);
  // The only response starting in the 5 hours before a first rejection is msg_subagentle_01504
  // (Opus 4.8, Mar 10 09:11:05); its true value from the ground truth is 275,975,000.
  assert.equal(gt.responseValueNano.msg_subagentle_01504, '275975000');
  assert.deepEqual(data.valueBeforeWindows, [{ model: 'claude-opus-4-8', valueNano: '275975000' }]);
  assert.equal(shown, true);
  assert.deepEqual(evidence, { count: 2, unit: 'windows' });
  for (const p of ['solo-night-owl', 'cache-miss-spender']) assert.equal(R['personas/' + p].ins.i06.shown, false, p + ' has no wall');
});

test('personas: i07 calls, statuses and per-tool counts equal the ground truth', () => {
  for (const p of PERSONAS) {
    const gt = readJson('personas', p, 'ground-truth.json');
    const { data } = R['personas/' + p].ins.i07;
    assert.equal(data.toolCalls, gt.tools.calls, p);
    assert.equal(data.paired, gt.tools.paired, p);
    assert.deepEqual(data.statusCounts, gt.tools.status, p);
    assert.equal(data.failureRate, (gt.tools.status.shell_exit + gt.tools.status.failed) / gt.tools.paired, p);
    assert.deepEqual(Object.fromEntries(data.byTool.map((r) => [r.name, r.calls])), gt.tools.callsByName, p);
    const top = Object.entries(data.callsByDisplayName).sort((a, b) => b[1] - a[1])[0];
    assert.equal(data.topTool.calls, top[1], p + ' top tool');
    close(data.topTool.share, top[1] / gt.tools.calls, p + ' top tool share');
  }
  // solo-night-owl: Edit 30 calls, 2 failed of 30 paired; Bash 23 calls, 3 non-zero exits.
  const solo = Object.fromEntries(R['personas/solo-night-owl'].ins.i07.data.byTool.map((r) => [r.name, r]));
  assert.equal(solo.Edit.failureRate, 2 / 30);
  assert.equal(solo.Bash.failureRate, 3 / 23);
  assert.deepEqual(R['personas/solo-night-owl'].ins.i07.data.topTool, { displayName: 'Edit', calls: 30, share: 30 / 140 });
  // subagent-lead: the one MCP tool is counted under "MCP tools" in the public map.
  assert.equal(R['personas/subagent-lead'].ins.i07.data.callsByDisplayName['MCP tools'], 34);
});

test('personas: i08 medians and maxima; no persona has a hot spot', () => {
  for (const p of PERSONAS) {
    const { data, shown } = R['personas/' + p].ins.i08;
    assert.equal(data.filesWithTenPlusEdits, 0, p);
    assert.equal(shown, false, p);
    assert.ok(data.maxEditsOneFileOneBlock <= data.maxEditsOneFile, p);
    assert.ok(data.top.length <= 10, p);
    for (const t of data.top) assert.ok(t.label.split('/').length <= 2, p + ': never more than parent/basename');
  }
  assert.equal(R['personas/solo-night-owl'].ins.i08.data.maxEditsOneFile, 6);
});

test('personas: i09 time figures equal the ground truth; weekend share from the calendar', () => {
  // Weekend days: solo-night-owl Mar 2 to 17 holds Mar 7, 8, 14, 15 (4 of 16); subagent-lead
  // holds only Mar 7 (1 of 10, Mar 8 is missing); cache-miss-spender Mar 9 to 16 holds 14, 15.
  const weekend = { 'solo-night-owl': 4 / 16, 'subagent-lead': 1 / 10, 'cache-miss-spender': 2 / 8 };
  for (const p of PERSONAS) {
    const gt = readJson('personas', p, 'ground-truth.json');
    const { data } = R['personas/' + p].ins.i09;
    assert.equal(data.activeSeconds, gt.time.activeSeconds, p);
    assert.equal(data.activeHours, Math.round(gt.time.activeSeconds / 360) / 10, p);
    assert.equal(data.agentSeconds, gt.time.agentSeconds, p);
    assert.equal(data.workBlocks, gt.time.workBlockSeconds.length, p);
    assert.equal(data.longestBlockSeconds, Math.max(...gt.time.workBlockSeconds), p);
    assert.equal(data.prompts, gt.prompts, p);
    assert.equal(data.interrupts, gt.interrupts, p);
    assert.equal(data.activeDays, gt.activeDays.length, p);
    assert.equal(data.longestStreakDays, gt.longestStreakDays, p);
    assert.equal(data.peakHourLocal, gt.peakHourLocal, p);
    assert.equal(data.firstActiveLocalDate, gt.activeDays[0], p);
    assert.equal(data.lastActiveLocalDate, gt.activeDays.at(-1), p);
    assert.equal(data.heatmap.flat().reduce((a, x) => a + x, 0), gt.prompts, p + ': every prompt in the heatmap once');
    assert.equal(data.weekendDayShare, weekend[p], p);
  }
  // The night owl peaks at 21:00 and most of its prompts are at night.
  assert.ok(R['personas/solo-night-owl'].ins.i09.data.nightPromptShare > 0.5);
});

test('personas: i10 workflow outcomes; subagent-lead 3 failed of 30 started is shown', () => {
  for (const p of PERSONAS) {
    const gt = readJson('personas', p, 'ground-truth.json');
    const { data } = R['personas/' + p].ins.i10;
    assert.deepEqual({ launched: data.launched, started: data.started, result: data.result, failed: data.failed }, gt.workflows, p);
  }
  const lead = R['personas/subagent-lead'].ins.i10;
  assert.equal(lead.data.failureRate, 0.1, '3 / 30');
  assert.equal(lead.shown, true, 'shown from 10 started');
  assert.deepEqual(lead.evidence, { count: 30, unit: 'workflow agents started' });
  assert.equal(R['personas/solo-night-owl'].ins.i10.shown, false);
});

test('personas: i12 coverage windows from event timestamps', () => {
  const want = {
    'solo-night-owl': ['2026-03-02', '2026-03-17', 16],
    'subagent-lead': ['2026-03-02', '2026-03-12', 11],
    'cache-miss-spender': ['2026-03-09', '2026-03-16', 8],
  };
  for (const p of PERSONAS) {
    const d = R['personas/' + p].ins.i12.data;
    assert.deepEqual([d.earliestAnyLocalDate, d.latestLocalDate, d.coverageDays], want[p], p);
    assert.equal(d.earliestMainLocalDate, want[p][0], p);
    assert.equal(d.topOfReport, true, p + ': under 60 days of coverage');
  }
});

test('personas: i14 lines written = ok Edit and MultiEdit new lines + ok Write lines (ground truth)', () => {
  for (const p of PERSONAS) {
    const gt = readJson('personas', p, 'ground-truth.json');
    const { data } = R['personas/' + p].ins.i14;
    assert.equal(data.linesWritten, gt.tools.okEditNewLines + gt.tools.okWriteLines, p);
    assert.equal(data.prompts, gt.prompts, p);
    assert.equal(data.activeDays, gt.activeDays.length, p);
    assert.equal(data.workBlocks, gt.time.workBlockSeconds.length, p);
    assert.equal(data.totalNano, gt.valueNano, p);
    assert.ok(data.filesCreated <= gt.tools.callsByName.Write, p + ': at most one creation per Write');
    for (const c of data.commandIntents) assert.ok(c.failures <= c.count, p + ' ' + c.intent);
  }
  assert.equal(R['personas/solo-night-owl'].ins.i14.data.linesWritten, 257 + 278);
});

/* ------------------------------------------------------------------------------------------
 * Canary (DESIGN 9.7): secrets and labels
 * ---------------------------------------------------------------------------------------- */

test('i11 canary: the planted key is one critical finding, fingerprinted, from local Bash output', () => {
  const secret = readJson('canary', 'expected.json').canaries.secret.value;
  const { data, shown, evidence, action } = R.canary.ins.i11;
  assert.deepEqual(data.findings, [{
    secretType: 'anthropic', fingerprint12: fp12(secret), copies: 1, files: 1, newestLocalDate: '2026-03-04',
    severity: 'critical', source: 'tool_result_local', expired: null, projectLabels: ['app'],
  }]);
  assert.deepEqual(data.bySeverity, { critical: 1, likely_fixture: 0, third_party_public: 0 });
  assert.equal(shown, true);
  assert.deepEqual(evidence, { count: 1, unit: 'critical findings' });
  assert.match(action, /Critical copies on disk: 1\.$/);
});

test('canary: the secret never reaches any insight, not even a 10-character slice', () => {
  const secret = readJson('canary', 'expected.json').canaries.secret.value;
  const json = JSON.stringify(R.canary.ins);
  for (let i = 0; i + 10 <= secret.length; i++) assert.ok(!json.includes(secret.slice(i, i + 10)), 'slice at ' + i);
});

test('canary: text-only canaries (prompt, title, agent name, branch, assistant text, tool input) are in no insight', () => {
  const e = readJson('canary', 'expected.json');
  const json = JSON.stringify(R.canary.ins);
  for (const k of ['prompt', 'title', 'agentName', 'secret', 'branch', 'assistantText', 'toolInput']) {
    assert.ok(!json.includes(e.canaries[k].value), 'canary ' + k);
  }
});

test('canary --redact: every local label is a letter label and no canary survives', async () => {
  const e = readJson('canary', 'expected.json');
  const { ins } = await insightsFor([root('canary'), root('personas/subagent-lead')], { options: { redact: true } });
  const json = JSON.stringify(ins);
  for (const [k, c] of Object.entries(e.canaries)) assert.ok(!json.includes(c.value), 'canary ' + k);
  const labels = [
    ...ins.i01.data.byProject.map((p) => p.label),
    ...['agent', 'skill', 'mcpServer'].flatMap((k) => ins.i04.data.byAttribution[k].map((a) => a.name)),
    ...ins.i07.data.byTool.filter((t) => t.nameClass !== 'builtin').map((t) => t.name),
    ...ins.i08.data.top.map((t) => t.label),
    ...ins.i11.data.findings.flatMap((f) => f.projectLabels),
  ];
  assert.ok(labels.length >= 10);
  for (const l of labels) assert.match(l, REDACTED_LABEL_RE);
  assert.deepEqual(ins.i04.data.byAttribution.mcpServer.map((a) => a.name), ['MCP server A']);
});

// DESIGN I8 shows "<parent>/<basename>" for hot files and DESIGN 9.7 bars the full-path canary
// from the report. The canary fixture plants the path canary as a folder ABOVE the parent
// (/fake/CANARY-PATH-91c2/docs/notes.md), so both rules hold: I8 shows "docs/notes.md" and the
// canary, which only the full path carries, appears nowhere.
test('canary: the full-path canary stays out of the local report even with --redact off', () => {
  const pathCanary = readJson('canary', 'expected.json').canaries.path.value;
  assert.ok(!JSON.stringify(R.canary.ins).includes(pathCanary));
  const labels = R.canary.ins.i08.data.top.map((t) => t.label).sort();
  assert.deepEqual(labels, ['docs/new.txt', 'docs/notes.md'], 'I8 keeps its parent/basename form');
});
