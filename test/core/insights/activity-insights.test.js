// I6 to I10: rate limits, tool reliability, churn, working patterns, workflow outcomes.
// Hand-built AccountingResults; every expected figure is derived in the comments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInsightResult } from '../../../src/core/insights/contract.js';
import { insight as i06, episodeStarts } from '../../../src/core/insights/i06-rate-limits.js';
import { insight as i07, TOOL_ACTIONS } from '../../../src/core/insights/i07-tools.js';
import { insight as i08 } from '../../../src/core/insights/i08-churn.js';
import { insight as i09 } from '../../../src/core/insights/i09-patterns.js';
import { insight as i10 } from '../../../src/core/insights/i10-workflows.js';
import { makeAcc, resp, tool, hash, input, T0, MIN, HOUR, S1 } from './_acc.js';

test('i06: windows by type, 30-minute episodes, local-hour histogram, 5-hour lookback counted once', () => {
  const acc = makeAcc({
    responses: [
      resp({ key: 'before', ts: T0 + 30 * MIN, tokens: { output: 1 } }),                  // outside every lookback
      resp({ key: 'both', ts: T0 + 3 * HOUR, tokens: { output: 1000 } }),                 // in both lookbacks: counted once (25,000,000)
      resp({ key: 'second', ts: T0 + 6.5 * HOUR, model: 'claude-sonnet-5', tokens: { output: 1000 } }), // second only (10,000,000)
      resp({ key: 'unpriced', ts: T0 + 4 * HOUR, model: 'claude-imaginary-9', tokens: { output: 1000 } }),
    ],
    rateLimits: {
      quotaRejectWindows: [
        { resetsAt: 1, rateLimitType: 'five_hour', firstRejectTs: T0 + 6 * HOUR },
        { resetsAt: 2, rateLimitType: 'five_hour', firstRejectTs: T0 + 7 * HOUR },
        { resetsAt: 3, rateLimitType: 'Some Free Text!', firstRejectTs: null },
      ],
      synthetic429Ts: [T0, T0 + 30 * MIN, T0 + 60 * MIN + 1, T0 + 5 * HOUR],
    },
  });
  // America/New_York is UTC-5 on 2026-03-02: 09:00Z is 4 AM, 10:00Z is 5 AM, 14:00Z is 9 AM.
  const r = i06.compute(input(acc, { tz: 'America/New_York' }));
  assert.deepEqual(checkInsightResult(r, 'i06'), []);
  assert.equal(r.data.windows, 3);
  assert.deepEqual(r.data.byType, [{ rateLimitType: 'five_hour', windows: 2 }, { rateLimitType: 'unknown', windows: 1 }]);
  assert.equal(r.data.synthetic429Lines, 4);
  assert.equal(r.data.episodes, 3, 'a gap of exactly 30 minutes stays in the episode; one millisecond more starts a new one');
  const hours = r.data.episodeStartsByLocalHour;
  assert.equal(hours.length, 24);
  assert.deepEqual([hours[4], hours[5], hours[9]], [1, 1, 1]);
  assert.deepEqual(r.data.valueBeforeWindows, [{ model: 'claude-opus-5', valueNano: '25000000' }, { model: 'claude-sonnet-5', valueNano: '10000000' }]);
  assert.equal(r.shown, true);
  assert.ok(!JSON.stringify(r).includes('Free Text'), 'free text in rateLimitType never passes');
  assert.deepEqual(episodeStarts([5, 1, 1 + 30 * MIN]), [1], 'unsorted input is sorted first');
  assert.equal(i06.compute(input(makeAcc())).shown, false);
});

function toolAcc() {
  let n = 0;
  const at = () => T0 + (n++) * MIN;
  return makeAcc({
    tools: [
      // Interleaved in time: file 0 runs fail, fail, ok, fail (max 2); file 1 fails three times (max 3).
      tool({ id: 't1', fileIdx: 0, status: 'shell_exit', ts: at() }),
      tool({ id: 't5', fileIdx: 1, status: 'shell_exit', ts: at() }),
      tool({ id: 't2', fileIdx: 0, status: 'shell_exit', ts: at() }),
      tool({ id: 't6', fileIdx: 1, status: 'shell_exit', ts: at() }),
      tool({ id: 't3', fileIdx: 0, status: 'ok', ts: at() }),
      tool({ id: 't7', fileIdx: 1, status: 'shell_exit', ts: at() }),
      tool({ id: 't4', fileIdx: 0, status: 'shell_exit', ts: at() }),
      tool({ id: 'e1', name: 'Edit', status: 'failed', errorCategory: 'edit_string_not_found', ts: at() }),
      tool({ id: 'e2', name: 'Edit', status: 'ok', ts: at() }),
      tool({ id: 'e3', name: 'Edit', status: 'denied', denialKind: 'user-rejected', errorCategory: 'user_rejected', ts: at() }),
      tool({ id: 'r1', name: 'Read', status: 'unpaired', ts: at() }),
      tool({ id: 'm1', name: 'mcp__fake-notes__search', status: 'ok', ts: at() }),
      tool({ id: 'm2', name: 'mcp__fake-notes__search', status: 'failed', errorCategory: 'timeout', ts: at() }),
      tool({ id: 'o1', name: 'FictionalTool', status: 'ok', ts: at() }),
    ],
    time: { interrupts: 2 },
  });
}

test('i07: statuses, failure rates, per-file fail runs, flagged rows and the top tool', () => {
  const r = i07.compute(input(toolAcc()));
  assert.deepEqual(checkInsightResult(r, 'i07'), []);
  const d = r.data;
  assert.equal(d.toolCalls, 14);
  assert.equal(d.paired, 13);
  assert.deepEqual(d.statusCounts, { ok: 4, denied: 1, shell_exit: 6, failed: 2, unpaired: 1 });
  assert.equal(d.failureRate, 8 / 13);
  const bash = d.byTool.find((t) => t.name === 'Bash');
  assert.deepEqual([bash.calls, bash.paired, bash.ok, bash.shellExit, bash.longestFailRun], [7, 7, 1, 6, 3]);
  assert.equal(bash.failureRate, 6 / 7);
  const edit = d.byTool.find((t) => t.name === 'Edit');
  assert.deepEqual([edit.calls, edit.ok, edit.failed, edit.denied, edit.failureRate], [3, 1, 1, 1, 1 / 3], 'a denial is not a failure');
  assert.equal(d.byTool.find((t) => t.name === 'Read').failureRate, 0);
  assert.deepEqual(d.byTool.map((t) => t.name), ['Bash', 'Edit', 'mcp__fake-notes__search', 'FictionalTool', 'Read']);
  assert.deepEqual(d.callsByDisplayName, { Bash: 7, Read: 1, Edit: 3, 'MCP tools': 2, 'other tools': 1 });
  assert.deepEqual(d.okCallsByDisplayName, { Bash: 1, Edit: 1, 'MCP tools': 1, 'other tools': 1 });
  assert.deepEqual(d.topTool, { displayName: 'Bash', calls: 7, share: 0.5 });
  assert.deepEqual(d.flagged, ['Bash', 'Edit', 'mcp__fake-notes__search'], 'top 3 by failures, ties by name');
  assert.equal(d.errorCategories.edit_string_not_found, 1);
  assert.equal(d.errorCategories.timeout, 1);
  assert.equal(d.errorCategories.user_rejected, 1);
  assert.equal(d.interrupts, 2);
  assert.equal(r.action, TOOL_ACTIONS.shell_exit);
});

test('i07: order of the incoming array does not matter; --redact collapses non-builtin names', () => {
  const a = toolAcc();
  const b = toolAcc();
  b.tools.reverse();
  assert.deepEqual(i07.compute(input(b)), i07.compute(input(a)));
  const red = i07.compute(input(a, { redact: true }));
  assert.deepEqual(red.data.byTool.map((t) => t.name), ['Bash', 'Edit', 'MCP tool A', 'Other tool A', 'Read']);
  assert.deepEqual(red.data.flagged, ['Bash', 'Edit', 'MCP tool A']);
  assert.ok(!JSON.stringify(red).includes('fake-notes') && !JSON.stringify(red).includes('FictionalTool'));
});

test('i07: 50+ calls at 5% failure are flagged; top tool ties break by allowlist order', () => {
  const tools = [];
  for (let i = 0; i < 60; i++) tools.push(tool({ id: 'g' + String(i).padStart(2, '0'), name: 'Grep', status: i < 3 ? 'failed' : 'ok', ts: T0 + i }));
  const r = i07.compute(input(makeAcc({ tools })));
  assert.deepEqual(r.data.flagged, ['Grep']);
  const tie = i07.compute(input(makeAcc({ tools: [tool({ id: 'a', name: 'Read' }), tool({ id: 'b', name: 'Read' }), tool({ id: 'c', name: 'Bash' }), tool({ id: 'd', name: 'Bash' })] })));
  assert.equal(tie.data.topTool.displayName, 'Bash');
  const none = i07.compute(input(makeAcc()));
  assert.equal(none.data.topTool, null);
  assert.equal(none.action, TOOL_ACTIONS.none);
  const denials = i07.compute(input(makeAcc({ tools: [tool({ id: 'x', status: 'denied' }), tool({ id: 'y', status: 'denied' })] })));
  assert.equal(denials.action, TOOL_ACTIONS.denied);
});

test('i08: hot spots, largest count, per-work-block maximum, labels and median edit size', () => {
  const tools = [];
  // hash 1: six ok edits a minute apart, a 20-minute gap (over the 15-minute cutoff), five more.
  for (let i = 0; i < 6; i++) tools.push(tool({ id: 'a' + i, name: 'Edit', hash: hash(1), fileLabel: 'fake/app.js', editNewLines: 2, ts: T0 + i * MIN }));
  for (let i = 0; i < 5; i++) tools.push(tool({ id: 'b' + i, name: 'Edit', hash: hash(1), fileLabel: 'fake/app.js', editNewLines: 2, ts: T0 + (25 + i) * MIN }));
  // Failed edits never count.
  for (let i = 0; i < 3; i++) tools.push(tool({ id: 'c' + i, name: 'Edit', status: 'failed', hash: hash(1), ts: T0 + (40 + i) * MIN }));
  tools.push(tool({ id: 'd0', name: 'Write', hash: hash(2), fileLabel: 'fake/new.md', writeLines: 4, ts: T0 + 50 * MIN }));
  tools.push(tool({ id: 'd1', name: 'Write', hash: hash(2), fileLabel: 'fake/new.md', writeLines: 4, ts: T0 + 51 * MIN }));
  tools.push(tool({ id: 'e0', name: 'MultiEdit', hash: hash(3), fileLabel: 'fake/util.js', editNewLines: 30, ts: T0 + 52 * MIN }));
  tools.push(tool({ id: 'f0', name: 'Edit', editNewLines: 5, ts: T0 + 53 * MIN })); // no path hash: median only
  tools.push(tool({ id: 'g0', name: 'Read', hash: hash(4), ts: T0 + 54 * MIN }));   // reads are not churn
  const acc = makeAcc({ tools });
  const r = i08.compute(input(acc));
  assert.deepEqual(checkInsightResult(r, 'i08'), []);
  assert.equal(r.data.distinctFiles, 3);
  assert.equal(r.data.filesWithTenPlusEdits, 1);
  assert.equal(r.data.maxEditsOneFile, 11);
  assert.equal(r.data.maxEditsOneFileOneBlock, 6);
  assert.deepEqual(r.data.top, [{ label: 'fake/app.js', edits: 11 }, { label: 'fake/new.md', edits: 2 }, { label: 'fake/util.js', edits: 1 }]);
  assert.equal(r.data.medianEditNewLines, 2, 'eleven 2s, one 5, one 30');
  assert.equal(r.shown, true);
  const red = i08.compute(input(acc, { redact: true }));
  assert.deepEqual(red.data.top.map((t) => t.label), ['File A', 'File B', 'File C']);
  assert.ok(!JSON.stringify(red).includes('fake/'));
});

test('i08: a label is never a full path, and nothing is shown under 10 edits', () => {
  const acc = makeAcc({ tools: [tool({ id: 'a', name: 'Write', hash: hash(9), fileLabel: 'fake/deep/tree/of/dirs/file.txt' })] });
  const r = i08.compute(input(acc));
  assert.equal(r.data.top[0].label, 'dirs/file.txt');
  assert.equal(r.shown, false);
});

test('i09: hours, blocks, night and weekend shares straight from the TimeResult', () => {
  const byHour = new Array(24).fill(0);
  byHour[21] = 3; byHour[2] = 1; byHour[9] = 6;
  const acc = makeAcc({
    time: {
      activeSeconds: 5400, agentSeconds: 9000, workBlockSeconds: [0, 60, 600, 1200, 3000], prompts: 10, interrupts: 1,
      promptsByLocalHour: byHour, activeDays: ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'], longestStreakDays: 4, peakHourLocal: 9,
    },
  });
  const r = i09.compute(input(acc));
  assert.deepEqual(checkInsightResult(r, 'i09'), []);
  const d = r.data;
  assert.deepEqual([d.activeHours, d.agentHours], [1.5, 2.5]);
  assert.deepEqual([d.workBlocks, d.longestBlockSeconds, d.medianBlockSeconds, d.p90BlockSeconds], [5, 3000, 600, 3000]);
  assert.equal(d.nightPromptShare, 0.4, 'hours 21 and 2 are night, 9 is not');
  assert.equal(d.weekendDayShare, 0.5, '2026-03-07 and 2026-03-08 are Saturday and Sunday');
  assert.deepEqual([d.activeDays, d.longestStreakDays, d.peakHourLocal], [4, 4, 9]);
  assert.deepEqual([d.firstActiveLocalDate, d.lastActiveLocalDate], ['2026-03-06', '2026-03-09']);
  assert.equal(d.heatmap.length, 7);
  const empty = i09.compute(input(makeAcc())).data;
  assert.deepEqual([empty.nightPromptShare, empty.weekendDayShare, empty.peakHourLocal, empty.firstActiveLocalDate], [0, 0, null, null]);
});

test('i10: failure rate over started; shown from 10 started', () => {
  const r = i10.compute(input(makeAcc({ workflows: { launched: 2, started: 12, result: 9, failed: 3 } })));
  assert.deepEqual(checkInsightResult(r, 'i10'), []);
  assert.equal(r.data.failureRate, 0.25);
  assert.equal(r.shown, true);
  assert.equal(i10.compute(input(makeAcc({ workflows: { launched: 1, started: 9, result: 9, failed: 0 } }))).shown, false);
  assert.equal(i10.compute(input(makeAcc())).data.failureRate, 0);
  assert.equal(S1.length, 36);
});
