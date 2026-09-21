// Memory probe for test/accounting/memory.test.js. Runs in its own process because it needs
// --expose-gc: heap figures are only meaningful after a forced collection, and the WeakRef check
// needs a real collection to have happened.
//
//   node --expose-gc --max-semi-space-size=4 memory-child.mjs <responses> <linesPerResponse>
//
// Feeds synthetic response observations straight into the accounting accumulator (no files, no
// parser) and prints one JSON line of aggregates.

import { createAccounting } from '../../src/core/accounting/index.js';
import { getPriceTable } from '../../src/core/prices/index.js';

const RESPONSES = Number(process.argv[2] || 50000);
const LINES = Number(process.argv[3] || 3);
const MODELS = ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
const SESSION = 'ddddddd0-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/** Every string is built fresh, the way JSON.parse hands one back for every line. */
const fresh = (s) => (s + ' ').slice(0, s.length);

/**
 * @param {number} i response index
 * @param {number} k line index within the response
 */
function observation(i, k) {
  const id = 'msg_' + String(i).padStart(9, '0') + 'abcdef';
  return {
    kind: 'response',
    fileIdx: 0,
    lineNo: i * LINES + k + 1,
    ts: T0 + i * 20000 + k,
    sessionId: fresh(SESSION),
    uuid: id + '-' + k,
    messageId: id,
    requestId: 'req_' + String(i).padStart(9, '0') + 'abcdef',
    isSidechain: false,
    rawModel: fresh(MODELS[i % MODELS.length]),
    final: k === LINES - 1,
    usage: {
      inputUncached: 40 + (i % 11),
      output: 20 + (i % 97) + k * 300,
      cacheRead: 20000 + (i % 1021),
      cacheWrite: 1000 + (i % 257),
      cacheWriteSplit: { m5: 700 + (i % 257), h1: 300 },
      reasoning: null,
      reasoningIncludedInOutput: true,
      speed: null,
      inferenceGeo: null,
      serviceTier: k === LINES - 1 ? fresh('standard') : null,
      webSearchRequests: 0,
      iterations: null,
      costSource: 'computed',
    },
    cwd: fresh('/dense/project-' + (i % 8)),
    attribution: null,
    effort: null,
    visibleChars: 120 + k,
  };
}

const gc = () => { for (let i = 0; i < 4; i++) /** @type {any} */ (globalThis).gc(); };
const heap = () => process.memoryUsage().heapUsed;
const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

const acc = createAccounting({
  prices: getPriceTable(), tz: 'UTC', idleMinutes: 15, pathStyle: 'auto', methods: true,
});
acc.addFile({ idx: 0, rootIdx: 0, relPath: 'p/s.jsonl', fileClass: 'main', depth: 0, size: 1 });
gc();
const base = heap();

// One observation is handed in and the only reference to it is dropped: after a collection
// nothing parsed from that line may still be reachable. A WeakRef target stays alive for the
// rest of the job that touched it, so the turn has to end before the collection is asked for.
let probe = observation(0, 0);
const evRef = new WeakRef(probe);
const usageRef = new WeakRef(probe.usage);
acc.addEvent(probe);
probe = null;
await new Promise((r) => setTimeout(r, 0));
gc();
const eventCollected = evRef.deref() === undefined;
const usageCollected = usageRef.deref() === undefined;

for (let k = 1; k < LINES; k++) acc.addEvent(observation(0, k));
for (let i = 1; i < RESPONSES; i++) for (let k = 0; k < LINES; k++) acc.addEvent(observation(i, k));
gc();
const afterScan = heap();
const result = acc.finish();
gc();
const afterFinish = heap();

process.stdout.write(JSON.stringify({
  responses: result.dedup.keys,
  observations: result.dedup.observations,
  eventCollected,
  usageCollected,
  retainedPerResponseScan: Math.round((afterScan - base) / RESPONSES),
  retainedPerResponseFinish: Math.round((afterFinish - base) / RESPONSES),
  peakRssMb: peakMb(),
  valueNano: result.totals.valueNano.toString(),
}) + '\n');
