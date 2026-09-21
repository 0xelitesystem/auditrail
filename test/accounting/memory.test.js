// Memory regression guard for the accounting accumulators.
//
// The product reads a whole history, so what the scan RETAINS per response decides whether a
// heavy user gets a report or a heap crash. Retained state is O(distinct responses) by design
// (rule A3 has to keep something per unique message id until the end); what must never come
// back is retaining the PARSED LINE behind it. One observation of one response used to pin its
// ResponseEvent, its NormalizedUsage and every string JSON.parse built for that line, twice
// over (the rule A3 winner and the keep-first line), which is most of a multi-kilobyte-per-
// response bill.
//
// Two guards, because either one alone can be satisfied the wrong way:
//   1. shape: a deduped response holds only flat compact fields, never an event or a usage;
//   2. budget: measured retained bytes per response and peak RSS over a dense synthetic run.
// The budgets sit well above what this code uses and well below what retaining events costs,
// so ordinary noise passes and a structural regression fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDedup, keptUsage, fileCount, visibleCharsOf } from '../../src/core/accounting/dedup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.resolve(HERE, '..', 'helpers', 'memory-child.mjs');

/** Every field a deduped response may hold. Adding one here is a deliberate memory decision. */
const ALLOWED_FIELDS = [
  'key',
  // rule A3 winner and its tie-break coordinates
  'fileIdx', 'lineNo', 'output', 'sessionId', 'rawModel', 'cwd', 'effort', 'isSidechain', 'final', 'attribution',
  // the winner's usage, flattened
  'inputUncached', 'cacheRead', 'cacheWrite', 'splitM5', 'splitH1', 'hasSplit', 'reasoning',
  'speed', 'inferenceGeo', 'serviceTier', 'webSearchRequests', 'iterations',
  // bucket state
  'observations', 'tsMin', 'tsMax', 'violated', 'sigInput', 'sigWrite', 'sigRead',
  'fileA', 'fileMore', 'charsNoUuid', 'c0u', 'c0n', 'c1u', 'c1n', 'c2u', 'c2n', 'charsMap',
  // keep-first line, value only
  'firstTs', 'firstFileIdx', 'firstLineNo', 'firstNano',
];

/** Fields that may hold an object, and what it may be. */
const ALLOWED_OBJECT_FIELDS = new Set(['attribution', 'iterations', 'fileMore', 'charsMap']);

const FILES = [
  { idx: 0, rootIdx: 0, relPath: 'p/main.jsonl', fileClass: 'main', depth: 0, size: 1 },
  { idx: 1, rootIdx: 0, relPath: 'p/s/subagents/agent-a.jsonl', fileClass: 'subagent', depth: 1, size: 1 },
];

/**
 * @param {Partial<Record<string, any>>} over
 * @returns {any} a ResponseEvent
 */
function ev(over = {}) {
  return {
    kind: 'response', fileIdx: 0, lineNo: 1, ts: 1_767_225_600_000, sessionId: 'sess-1', uuid: 'uuid-1',
    messageId: 'msg_1', requestId: 'req_1', isSidechain: false, rawModel: 'claude-opus-4-5-20251101',
    final: true,
    usage: {
      inputUncached: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWriteSplit: { m5: 10, h1: 30 },
      reasoning: 5, reasoningIncludedInOutput: true, speed: 'standard', inferenceGeo: 'us',
      serviceTier: 'standard', webSearchRequests: 2, iterations: null, costSource: 'computed',
    },
    cwd: '/work/repo', attribution: { agent: 'a', skill: null, mcpServer: null, plugin: null },
    effort: 'high', visibleChars: 100,
    ...over,
  };
}

/** @param {any[]} events @returns {any[]} the emitted records */
function dedupe(events, opts = {}) {
  const d = createDedup(FILES, { methods: true, ...opts });
  for (const e of events) d.add(e, 1000);
  const out = [];
  d.finish((r) => { out.push({ ...r }); });
  return out;
}

test('a deduped response holds only the allowed compact fields', () => {
  const d = createDedup(FILES, { methods: true });
  const a = ev();
  const b = ev({ lineNo: 2, uuid: 'uuid-2', usage: { ...a.usage, output: 900 } });
  d.add(a, 1000);
  d.add(b, 4000);
  /** @type {any} */
  let rec = null;
  d.finish((r) => { rec = r; });
  assert.ok(rec, 'one record');
  assert.deepEqual(Object.keys(rec).sort(), [...ALLOWED_FIELDS].sort());
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || typeof v !== 'object') continue;
    assert.ok(ALLOWED_OBJECT_FIELDS.has(k), 'field ' + k + ' must not hold an object');
  }
});

test('nothing in a deduped response is the event, its usage or its attribution object', () => {
  const d = createDedup(FILES, { methods: true });
  const a = ev();
  d.add(a, 1000);
  /** @type {any} */
  let rec = null;
  d.finish((r) => { rec = r; });
  const held = new Set(Object.values(rec).filter((v) => v !== null && typeof v === 'object'));
  assert.ok(!held.has(a), 'the event itself');
  assert.ok(!held.has(a.usage), 'the parsed usage');
  assert.ok(!held.has(a.usage.cacheWriteSplit), 'the parsed cache split');
  assert.ok(!held.has(a.attribution), 'the parsed attribution');
  assert.notEqual(rec.attribution, a.attribution);
  assert.deepEqual(rec.attribution, a.attribution, 'same values, a shared copy');
});

test('the compact record still answers everything the pipeline reads off the kept line', () => {
  const a = ev();
  const [rec] = dedupe([a]);
  assert.deepEqual(keptUsage(rec), a.usage);
  assert.equal(rec.rawModel, a.rawModel);
  assert.equal(rec.sessionId, a.sessionId);
  assert.equal(rec.cwd, a.cwd);
  assert.equal(rec.effort, a.effort);
  assert.equal(rec.final, a.final);
  assert.equal(rec.isSidechain, a.isSidechain);
  assert.equal(fileCount(rec), 1);
  assert.equal(visibleCharsOf(rec), 100);
});

test('per-line character counts are exact past the inline slots, and a forked line counts once', () => {
  // Six lines of one response, the fourth and later spilling out of the inline slots, plus a
  // forked copy of the first line in another file with a different count.
  const base = [];
  for (let i = 0; i < 6; i++) base.push(ev({ lineNo: i + 1, uuid: 'u' + i, visibleChars: 10 * (i + 1) }));
  const forked = ev({ fileIdx: 1, lineNo: 99, uuid: 'u0', visibleChars: 7 });
  const noUuid = ev({ lineNo: 50, uuid: null, visibleChars: 3 });
  const [rec] = dedupe([...base, forked, noUuid]);
  // max per uuid: 10, 20, 30, 40, 50, 60 (the forked copy of u0 is smaller), plus the uuid-less 3.
  assert.equal(visibleCharsOf(rec), 10 + 20 + 30 + 40 + 50 + 60 + 3);
  assert.equal(fileCount(rec), 2);
  assert.equal(rec.observations, 8);
});

test('retained bytes per response and peak RSS stay inside the budget on a dense run', () => {
  // 50,000 responses of 3 lines each, straight into the accumulator. Budgets are roughly 1.6x
  // what this code measures and well under what retaining parsed lines costs (which was above
  // 2,300 bytes per response during the scan and above 4,500 after finish).
  const RESPONSES = 50_000;
  const SCAN_BUDGET = 1400;
  const FINISH_BUDGET = 1600;
  const RSS_BUDGET_MB = 240;

  const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=4', CHILD, String(RESPONSES), '3'], {
    encoding: 'utf8', maxBuffer: 1 << 20,
  });
  assert.equal(r.status, 0, 'memory child exited ' + r.status + ': ' + (r.stderr || '').slice(0, 800));
  const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');

  assert.equal(out.responses, RESPONSES);
  assert.equal(out.observations, RESPONSES * 3);
  assert.ok(out.eventCollected, 'the ResponseEvent must be collectable once its observation is folded in');
  assert.ok(out.usageCollected, 'the parsed usage must be collectable once its observation is folded in');
  assert.ok(out.retainedPerResponseScan < SCAN_BUDGET,
    'retained during the scan: ' + out.retainedPerResponseScan + ' bytes per response, budget ' + SCAN_BUDGET);
  assert.ok(out.retainedPerResponseFinish < FINISH_BUDGET,
    'retained after finish: ' + out.retainedPerResponseFinish + ' bytes per response, budget ' + FINISH_BUDGET);
  assert.ok(out.peakRssMb < RSS_BUDGET_MB,
    'peak RSS ' + out.peakRssMb + ' MB over ' + RESPONSES.toLocaleString('en-US') + ' responses, budget ' + RSS_BUDGET_MB + ' MB');
});
