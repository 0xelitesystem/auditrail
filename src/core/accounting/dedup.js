// Global response dedup (rules A1 to A4). THE most important rule in the product.
//
// One API response is written as several JSONL lines, one content block per line, and every
// line repeats the usage block; output_tokens is a running value that only the last line holds
// in full. Summing lines inflates value about 2.7x; keeping the first line undercounts output.
//
// A1  key = message.id, else requestId, else uuid; applied GLOBALLY across every file of every
//     class (main, subagent, workflow agent), never per file: forked copies of a main-thread
//     response inside a subagent file are the same response.
// A2  one message.id with two different non-empty requestIds (gateways that reuse ids) splits
//     into 'id|requestId' records. A line with an empty requestId attaches to the single record;
//     with several, to the smallest requestId (counted as ambiguousAttach, INTERFACES 13.3).
// A3  keep the WHOLE line with the largest output_tokens; ties go to the shallower file (main,
//     then subagent, then workflow agent), then the smaller relative path, then the smaller root,
//     then the later line. The choice is a total order, so walk order never matters.
// A4  input and both cache fields must be equal on every line of a key; violations are counted.
//
// Buckets merge associatively, so the result is identical for any file or line order.
//
// MEMORY. Retained state is O(distinct responses), not O(bytes), and the product's whole pitch
// is that it reads your entire history, so what is retained per response decides whether a
// heavy user gets a report or a heap crash. Nothing here holds a parsed line. Each observation
// is folded into a flat CompactResponse of numbers, booleans and INTERNED strings and the
// ResponseEvent (and with it the objects and strings JSON.parse produced for that line) is
// collectable the moment add() returns. The rules that make that possible:
//   - the rule A3 winner is stored field by field, never as a reference to its event;
//   - the keep-first line, the per-file winner and the main-file winner are needed only for
//     their value (DESIGN 4.3 wrong-method diagnostics), so only their nanodollars and their
//     tie-break coordinates are kept, never the events;
//   - strings that repeat across responses (session id, model id, cwd, effort, service tier,
//     speed, inference geo, and the attribution quadruple) are interned, so a million
//     responses in one session hold one copy of that session id, not a million;
//   - a Set of file indexes and a map of per-line character counts are allocated only when a
//     response is actually seen in more than one file or on more than one line.
// The per-response figure is measured, not assumed: test/accounting/memory.test.js pins both
// the retained shape and a byte budget on a dense synthetic run.
//
// Isomorphic: no node:* imports and no DOM.

import { defaultDedupKey, compareObservations } from '../adapters/contract.js';
import { createStringPool, MAX_INTERNED } from './intern.js';

/**
 * Ceiling on distinct live responses in one scan. Past the V8 heap limit the process aborts
 * with a fatal error and a native stack trace and the user gets no report and no explanation;
 * this turns that into a plain, named, catchable error. At the measured compact size this is
 * well under the default heap limit on a 64-bit build (about 4 GB) with room for the rest of
 * the pipeline. Raise it only together with a measurement.
 */
export const MAX_LIVE_RESPONSES = 600_000;

/**
 * Per-line character counts (rule A6) for the first this many distinct line uuids of a response
 * sit in fields of the record itself; past that they spill into a Map. Most responses are
 * written as two or three lines, so the spill is the exception, not the rule.
 */
const CHARS_INLINE = 3;

/** Thrown when a scan holds more live responses than MAX_LIVE_RESPONSES. */
export class TooManyResponsesError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TooManyResponsesError';
  }
}

/**
 * One deduped response, flattened. Holds every field later phases read off the rule A3 winner
 * and nothing else: no ResponseEvent, no parsed line, no free text.
 *
 * @typedef {Object} CompactResponse
 * @property {string} key             dedup key; 'id|requestId' after a rule A2 split (set at emit)
 *
 * Rule A3 winner, and its tie-break coordinates.
 * @property {number} fileIdx
 * @property {number} lineNo
 * @property {number} output          usage.output_tokens of the winner
 * @property {string|null} sessionId  interned
 * @property {string|null} rawModel   interned
 * @property {string|null} cwd        interned
 * @property {string|null} effort     interned
 * @property {boolean} isSidechain
 * @property {boolean} final          rule A5
 * @property {import('../adapters/contract.js').Attribution|null} attribution  interned, shared, read only
 *
 * The winner's usage, flattened (cacheWriteSplit as two numbers plus a present flag).
 * @property {number} inputUncached
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} splitM5
 * @property {number} splitH1
 * @property {boolean} hasSplit
 * @property {number|null} reasoning
 * @property {string|null} speed          interned
 * @property {string|null} inferenceGeo   interned
 * @property {string|null} serviceTier    interned
 * @property {number} webSearchRequests
 * @property {import('../adapters/contract.js').IterationUsage[]|null} iterations  rare; kept as parsed
 *
 * Bucket state over every observation of the key.
 * @property {number} observations
 * @property {number|null} tsMin
 * @property {number|null} tsMax
 * @property {boolean} violated       rule A4
 * @property {number} sigInput        rule A4 signature of the first line added
 * @property {number} sigWrite
 * @property {number} sigRead
 * @property {number} fileA           first fileIdx seen
 * @property {Set<number>|null} fileMore  allocated only when a second distinct file appears
 * @property {number} charsNoUuid
 * @property {string|null} c0u   up to CHARS_INLINE (line uuid, characters) pairs, inline
 * @property {number} c0n
 * @property {string|null} c1u
 * @property {number} c1n
 * @property {string|null} c2u
 * @property {number} c2n
 * @property {Map<string, number>|null} charsMap  every pair, once a fourth uuid shows up
 *
 * Keep-first line (DESIGN 4.3), value only.
 * @property {number|null} firstTs
 * @property {number} firstFileIdx
 * @property {number} firstLineNo
 * @property {number} firstNano
 */

/**
 * @typedef {Object} DedupStats
 * @property {number} observations
 * @property {number} keys
 * @property {number} gatewayConflicts
 * @property {number} ambiguousAttach
 * @property {number} invariantViolations
 * @property {number} forkedKeys
 */

/**
 * @typedef {Object} DedupOutcome
 * @property {DedupStats} stats
 * @property {number} keepFirstLineNano   sum over emitted records of the keep-first value
 * @property {number} dedupPerFileNano    sum over (file, primary key) of the per-file winner
 * @property {number} mainFilesOnlyNano   sum over primary keys seen in a main-class file
 */

/**
 * The winner's usage as the NormalizedUsage shape pricing expects. A fresh short-lived object:
 * nothing downstream retains it (money.js copies every number it reads).
 * @param {CompactResponse} r
 * @returns {import('../adapters/contract.js').NormalizedUsage}
 */
export function keptUsage(r) {
  return {
    inputUncached: r.inputUncached,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    cacheWriteSplit: r.hasSplit ? { m5: r.splitM5, h1: r.splitH1 } : null,
    reasoning: r.reasoning,
    reasoningIncludedInOutput: true,
    speed: r.speed,
    inferenceGeo: r.inferenceGeo,
    serviceTier: r.serviceTier,
    webSearchRequests: r.webSearchRequests,
    iterations: r.iterations,
    costSource: 'computed',
  };
}

/** Distinct files a key was seen in. @param {CompactResponse} r @returns {number} */
export function fileCount(r) {
  return r.fileMore ? r.fileMore.size : 1;
}

/** Characters of visible output over distinct line uuids (rule A6 band). @param {CompactResponse} r */
export function visibleCharsOf(r) {
  let n = r.charsNoUuid;
  if (r.charsMap) { for (const c of r.charsMap.values()) n += c; return n; }
  return n + r.c0n + r.c1n + r.c2n;
}

/**
 * @param {import('../adapters/contract.js').FileRef[]} files  indexed by FileRef.idx
 * @param {{ dedupKey?: (ev: import('../adapters/contract.js').ResponseEvent) => string, merge?: (a: any, b: any, files: any) => any, methods?: boolean, maxLiveResponses?: number }} [opts]
 */
export function createDedup(files, opts = {}) {
  const keyOf = opts.dedupKey || defaultDedupKey;
  const maxLive = typeof opts.maxLiveResponses === 'number' && opts.maxLiveResponses > 0 ? opts.maxLiveResponses : MAX_LIVE_RESPONSES;
  const methods = opts.methods !== false;
  let live = 0;

  /** @param {import('../adapters/contract.js').ResponseEvent} ev */
  const countLive = (ev) => {
    live++;
    if (live > maxLive) {
      const f = files[ev.fileIdx];
      throw new TooManyResponsesError(
        'this scan holds more than ' + maxLive.toLocaleString('en-US') + ' distinct responses, which is more than ' +
        'auditrail keeps in memory. The limit was reached while reading ' + (f && f.relPath ? f.relPath : 'a log file') +
        '. Scan a smaller folder with --dir, or split the folder and run it twice.');
    }
  };

  // One stored copy of every repeated string. Interning is what keeps a compact record compact:
  // model ids, session ids, cwds, efforts, tiers, speeds and geos repeat across every response.
  // Request ids do NOT: they are unique per response, so pooling them would only add an entry.
  const intern = createStringPool();
  /**
   * Attribution quadruples repeat per agent, skill, MCP server and plugin, so one frozen object
   * is shared by every response that carries the same four values. Read only downstream.
   * @type {Map<string, import('../adapters/contract.js').Attribution>}
   */
  const attrPool = new Map();
  /** @param {import('../adapters/contract.js').Attribution|null} a */
  function internAttribution(a) {
    if (!a) return null;
    const k = (a.agent || '') + '\u0000' + (a.skill || '') + '\u0000' + (a.mcpServer || '') + '\u0000' + (a.plugin || '');
    const hit = attrPool.get(k);
    if (hit !== undefined) return hit;
    const frozen = Object.freeze({ agent: a.agent, skill: a.skill, mcpServer: a.mcpServer, plugin: a.plugin });
    if (attrPool.size < MAX_INTERNED) attrPool.set(k, frozen);
    return frozen;
  }

  // Rule A3 choice. The stored winner is compared through a reusable stand-in carrying exactly
  // the fields the order is defined over (INTERFACES: usage.output, then file order, then line),
  // so no observation has to be retained to be compared against later ones.
  /** @type {{ fileIdx: number, lineNo: number, usage: { output: number } }} */
  const standIn = { fileIdx: 0, lineNo: 0, usage: { output: 0 } };
  /** @type {{ fileIdx: number, lineNo: number, usage: { output: number } }} */
  const standIn2 = { fileIdx: 0, lineNo: 0, usage: { output: 0 } };
  /** @param {any} a @param {any} b @returns {boolean} true when `a` is kept */
  const aWins = opts.merge
    ? (a, b) => opts.merge(a, b, files) === a
    : (a, b) => compareObservations(a, b, files) <= 0;
  /** @param {{ fileIdx: number, lineNo: number, usage: { output: number } }} s @param {{ fileIdx: number, output: number, lineNo: number }} r */
  const loadStandIn = (s, r) => { s.fileIdx = r.fileIdx; s.lineNo = r.lineNo; s.usage.output = r.output; return s; };

  /**
   * Keep-first order: earliest timestamp (null as 0), then the shallower file, smaller path,
   * smaller root, EARLIER line. Takes loose numbers so no object has to be built to compare.
   * @param {number|null} aTs @param {number} aFile @param {number} aLine
   * @param {number|null} bTs @param {number} bFile @param {number} bLine
   * @returns {boolean} true when the first of the two is the earlier
   */
  function aIsEarlier(aTs, aFile, aLine, bTs, bFile, bLine) {
    const ta = aTs ?? 0;
    const tb = bTs ?? 0;
    if (ta !== tb) return ta < tb;
    const fa = files[aFile];
    const fb = files[bFile];
    if (fa.depth !== fb.depth) return fa.depth < fb.depth;
    if (fa.relPath !== fb.relPath) return fa.relPath < fb.relPath;
    if (fa.rootIdx !== fb.rootIdx) return fa.rootIdx < fb.rootIdx;
    return aLine <= bLine;
  }

  /**
   * Copy the rule A3 winner's fields out of an event. Called on the first observation of a
   * bucket and every time a later observation wins; the event itself is never stored.
   * @param {CompactResponse} r
   * @param {import('../adapters/contract.js').ResponseEvent} ev
   */
  function takeWinner(r, ev) {
    const u = ev.usage;
    r.fileIdx = ev.fileIdx;
    r.lineNo = ev.lineNo;
    r.output = u.output;
    r.sessionId = intern(ev.sessionId);
    r.rawModel = intern(ev.rawModel);
    r.cwd = intern(ev.cwd);
    r.effort = intern(ev.effort);
    r.isSidechain = ev.isSidechain;
    r.final = ev.final;
    r.attribution = internAttribution(ev.attribution);
    r.inputUncached = u.inputUncached;
    r.cacheRead = u.cacheRead;
    r.cacheWrite = u.cacheWrite;
    const s = u.cacheWriteSplit;
    r.hasSplit = s !== null && s !== undefined;
    r.splitM5 = s ? s.m5 : 0;
    r.splitH1 = s ? s.h1 : 0;
    r.reasoning = u.reasoning;
    r.speed = intern(u.speed);
    r.inferenceGeo = intern(u.inferenceGeo);
    r.serviceTier = intern(u.serviceTier);
    r.webSearchRequests = u.webSearchRequests;
    r.iterations = u.iterations;
  }

  /**
   * @param {import('../adapters/contract.js').ResponseEvent} ev
   * @param {number} obsNano  value of THIS observation (methods runs only)
   * @returns {CompactResponse}
   */
  function newRecord(ev, obsNano) {
    const u = ev.usage;
    /** @type {CompactResponse} */
    const r = {
      key: '',
      fileIdx: 0, lineNo: 0, output: 0,
      sessionId: null, rawModel: null, cwd: null, effort: null,
      isSidechain: false, final: false, attribution: null,
      inputUncached: 0, cacheRead: 0, cacheWrite: 0, splitM5: 0, splitH1: 0, hasSplit: false,
      reasoning: null, speed: null, inferenceGeo: null, serviceTier: null, webSearchRequests: 0, iterations: null,
      observations: 0, tsMin: null, tsMax: null, violated: false,
      sigInput: u.inputUncached, sigWrite: u.cacheWrite, sigRead: u.cacheRead,
      fileA: ev.fileIdx, fileMore: null,
      charsNoUuid: 0, c0u: null, c0n: 0, c1u: null, c1n: 0, c2u: null, c2n: 0, charsMap: null,
      firstTs: ev.ts, firstFileIdx: ev.fileIdx, firstLineNo: ev.lineNo, firstNano: obsNano,
    };
    takeWinner(r, ev);
    return r;
  }

  /**
   * Characters of visible output for one line uuid, keeping the largest per uuid (a forked copy
   * of a line must count once, rule A6). CHARS_INLINE pairs live in the record itself, which is
   * what most responses need; a fourth distinct uuid moves the whole set into a Map.
   * @param {CompactResponse} r
   * @param {string} uuid
   * @param {number} n
   */
  function charsAdd(r, uuid, n) {
    if (r.charsMap) {
      const prev = r.charsMap.get(uuid);
      if (prev === undefined || n > prev) r.charsMap.set(uuid, n);
      return;
    }
    if (r.c0u === null || r.c0u === uuid) { r.c0u = uuid; if (n > r.c0n) r.c0n = n; return; }
    if (r.c1u === null || r.c1u === uuid) { r.c1u = uuid; if (n > r.c1n) r.c1n = n; return; }
    if (r.c2u === null || r.c2u === uuid) { r.c2u = uuid; if (n > r.c2n) r.c2n = n; return; }
    /** @type {Map<string, number>} */
    const m = new Map();
    m.set(r.c0u, r.c0n);
    m.set(r.c1u, r.c1n);
    m.set(r.c2u, r.c2n);
    m.set(uuid, n);
    r.charsMap = m;
    r.c0u = null; r.c0n = 0; r.c1u = null; r.c1n = 0; r.c2u = null; r.c2n = 0;
  }

  /** Fold every (uuid, characters) pair of `b` into `a`. @param {CompactResponse} a @param {CompactResponse} b */
  function charsMergeInto(a, b) {
    if (b.charsMap) { for (const [u, c] of b.charsMap) charsAdd(a, u, c); return; }
    if (b.c0u !== null) charsAdd(a, b.c0u, b.c0n);
    if (b.c1u !== null) charsAdd(a, b.c1u, b.c1n);
    if (b.c2u !== null) charsAdd(a, b.c2u, b.c2n);
  }

  /** @param {CompactResponse} r @param {number} fileIdx */
  function fileAdd(r, fileIdx) {
    if (r.fileMore) { r.fileMore.add(fileIdx); return; }
    if (fileIdx === r.fileA) return;
    r.fileMore = new Set([r.fileA, fileIdx]);
  }

  /**
   * Fold one observation into a bucket.
   * @param {CompactResponse} r
   * @param {import('../adapters/contract.js').ResponseEvent} ev
   * @param {number} obsNano
   */
  function addTo(r, ev, obsNano) {
    if (r.observations > 0) {
      if (!aWins(loadStandIn(standIn, r), ev)) takeWinner(r, ev);
      if (methods && !aIsEarlier(r.firstTs, r.firstFileIdx, r.firstLineNo, ev.ts, ev.fileIdx, ev.lineNo)) {
        r.firstTs = ev.ts; r.firstFileIdx = ev.fileIdx; r.firstLineNo = ev.lineNo; r.firstNano = obsNano;
      }
      const u = ev.usage;
      if (u.inputUncached !== r.sigInput || u.cacheWrite !== r.sigWrite || u.cacheRead !== r.sigRead) r.violated = true;
    }
    r.observations++;
    if (ev.ts !== null) {
      if (r.tsMin === null || ev.ts < r.tsMin) r.tsMin = ev.ts;
      if (r.tsMax === null || ev.ts > r.tsMax) r.tsMax = ev.ts;
    }
    fileAdd(r, ev.fileIdx);
    if (ev.uuid) charsAdd(r, ev.uuid, ev.visibleChars);
    else r.charsNoUuid += ev.visibleChars;
  }

  /**
   * Merge bucket `b` into `a` (associative and commutative).
   * @param {CompactResponse} a
   * @param {CompactResponse} b
   * @returns {CompactResponse}
   */
  function mergeInto(a, b) {
    if (!aWins(loadStandIn(standIn, a), loadStandIn(standIn2, b))) {
      // b's winner wins: move its winner fields across.
      a.fileIdx = b.fileIdx; a.lineNo = b.lineNo; a.output = b.output;
      a.sessionId = b.sessionId; a.rawModel = b.rawModel; a.cwd = b.cwd; a.effort = b.effort;
      a.isSidechain = b.isSidechain; a.final = b.final; a.attribution = b.attribution;
      a.inputUncached = b.inputUncached; a.cacheRead = b.cacheRead; a.cacheWrite = b.cacheWrite;
      a.splitM5 = b.splitM5; a.splitH1 = b.splitH1; a.hasSplit = b.hasSplit;
      a.reasoning = b.reasoning; a.speed = b.speed; a.inferenceGeo = b.inferenceGeo;
      a.serviceTier = b.serviceTier; a.webSearchRequests = b.webSearchRequests; a.iterations = b.iterations;
    }
    if (!aIsEarlier(a.firstTs, a.firstFileIdx, a.firstLineNo, b.firstTs, b.firstFileIdx, b.firstLineNo)) {
      a.firstTs = b.firstTs; a.firstFileIdx = b.firstFileIdx; a.firstLineNo = b.firstLineNo; a.firstNano = b.firstNano;
    }
    if (b.violated || b.sigInput !== a.sigInput || b.sigWrite !== a.sigWrite || b.sigRead !== a.sigRead) a.violated = true;
    a.observations += b.observations;
    if (b.tsMin !== null && (a.tsMin === null || b.tsMin < a.tsMin)) a.tsMin = b.tsMin;
    if (b.tsMax !== null && (a.tsMax === null || b.tsMax > a.tsMax)) a.tsMax = b.tsMax;
    if (b.fileMore) { for (const f of b.fileMore) fileAdd(a, f); } else fileAdd(a, b.fileA);
    charsMergeInto(a, b);
    a.charsNoUuid += b.charsNoUuid;
    return a;
  }

  /**
   * One primary key (rule A1) before the rule A2 split. The first requestId and its bucket sit
   * inline: a second distinct requestId on one message id is a gateway anomaly, not the norm,
   * so the Map is allocated only when one shows up.
   * @typedef {Object} Group
   * @property {boolean} fromId
   * @property {string} rid0
   * @property {CompactResponse|null} rec0
   * @property {Map<string, CompactResponse>|null} ridMore
   * @property {CompactResponse|null} empty
   * @property {GroupMethods|null} m  wrong-method state; null unless `audit --methods` asked for it
   */

  /**
   * Per-key state the DESIGN 4.3 wrong methods need, and nothing else needs. The default report
   * never asks for it, so it is not part of the group a normal scan allocates.
   * @typedef {Object} GroupMethods
   * @property {number} bmOut     best main-file observation: output, file, line, value
   * @property {number} bmFile
   * @property {number} bmLine
   * @property {number} bmNano
   * @property {boolean} bmSet
   * @property {number} pfFile    per-file winner of the first file this key appeared in
   * @property {number} pfOut
   * @property {number} pfLine
   * @property {number} pfNano
   * @property {Map<number, { out: number, line: number, nano: number }>|null} pfMore
   */

  /** @type {Map<string, Group>} */
  const groups = new Map();
  let observations = 0;

  return {
    /**
     * Add one response observation. The event is read here and never retained.
     * @param {import('../adapters/contract.js').ResponseEvent} ev
     * @param {number} [obsNano]  value of this single observation; used by the wrong-method
     *   diagnostics only, so it may be 0 when options.methods is false
     */
    add(ev, obsNano = 0) {
      observations++;
      const pk = keyOf(ev);
      let g = groups.get(pk);
      if (!g) {
        g = {
          fromId: false, rid0: '', rec0: null, ridMore: null, empty: null,
          m: methods ? { bmOut: 0, bmFile: 0, bmLine: 0, bmNano: 0, bmSet: false, pfFile: -1, pfOut: 0, pfLine: 0, pfNano: 0, pfMore: null } : null,
        };
        groups.set(pk, g);
      }
      if (ev.messageId && ev.messageId === pk) g.fromId = true;
      const rid = ev.requestId || '';
      /** @type {CompactResponse} */
      let r;
      if (rid) {
        if (g.rec0 === null || g.rid0 === rid) {
          if (g.rec0 === null) { countLive(ev); g.rid0 = rid; g.rec0 = newRecord(ev, obsNano); }
          r = g.rec0;
        } else {
          if (!g.ridMore) g.ridMore = new Map();
          let x = g.ridMore.get(rid);
          if (!x) { countLive(ev); x = newRecord(ev, obsNano); g.ridMore.set(rid, x); }
          r = x;
        }
      } else {
        if (!g.empty) { countLive(ev); g.empty = newRecord(ev, obsNano); }
        r = g.empty;
      }
      addTo(r, ev, obsNano);
      const m = g.m;
      if (m) {
        const f = files[ev.fileIdx];
        const out = ev.usage.output;
        if (f && f.fileClass === 'main') {
          if (!m.bmSet) { m.bmOut = out; m.bmFile = ev.fileIdx; m.bmLine = ev.lineNo; m.bmNano = obsNano; m.bmSet = true; }
          else {
            standIn.fileIdx = m.bmFile; standIn.lineNo = m.bmLine; standIn.usage.output = m.bmOut;
            if (!aWins(standIn, ev)) { m.bmOut = out; m.bmFile = ev.fileIdx; m.bmLine = ev.lineNo; m.bmNano = obsNano; }
          }
        }
        // Per-file wrong method: within one file keep the max-output line, ties to the later line.
        if (m.pfFile === -1 || m.pfFile === ev.fileIdx) {
          if (m.pfFile === -1) { m.pfFile = ev.fileIdx; m.pfOut = out; m.pfLine = ev.lineNo; m.pfNano = obsNano; }
          else if (out > m.pfOut || (out === m.pfOut && ev.lineNo > m.pfLine)) { m.pfOut = out; m.pfLine = ev.lineNo; m.pfNano = obsNano; }
        } else {
          if (!m.pfMore) m.pfMore = new Map();
          const cur = m.pfMore.get(ev.fileIdx);
          if (!cur) m.pfMore.set(ev.fileIdx, { out, line: ev.lineNo, nano: obsNano });
          else if (out > cur.out || (out === cur.out && ev.lineNo > cur.line)) { cur.out = out; cur.line = ev.lineNo; cur.nano = obsNano; }
        }
      }
    },

    /**
     * Walk every deduped response exactly once, in no particular order (callers sort), handing
     * each CompactResponse to `onRecord`. The record is released as soon as the callback
     * returns, so the caller's ResponseRecords and these buckets are never both fully live.
     * The callback must not retain the record.
     * @param {(rec: CompactResponse) => void} onRecord
     * @returns {DedupOutcome}
     */
    finish(onRecord) {
      const stats = { observations, keys: 0, gatewayConflicts: 0, ambiguousAttach: 0, invariantViolations: 0, forkedKeys: 0 };
      let keepFirstLineNano = 0n;
      let dedupPerFileNano = 0n;
      let mainFilesOnlyNano = 0n;
      /** @param {string} key @param {CompactResponse} r */
      const emit = (key, r) => {
        r.key = key;
        stats.keys++;
        if (r.violated) stats.invariantViolations++;
        if (r.fileMore && r.fileMore.size > 1) stats.forkedKeys++;
        keepFirstLineNano += BigInt(r.firstNano);
        onRecord(r);
      };
      for (const [pk, g] of groups) {
        const m = g.m;
        if (m) {
          if (m.bmSet) mainFilesOnlyNano += BigInt(m.bmNano);
          if (m.pfFile !== -1) dedupPerFileNano += BigInt(m.pfNano);
          if (m.pfMore) for (const v of m.pfMore.values()) dedupPerFileNano += BigInt(v.nano);
        }
        /** @type {string[]} */
        const rids = g.rec0 === null ? [] : g.ridMore ? [g.rid0, ...g.ridMore.keys()].sort() : [g.rid0];
        if (g.fromId && rids.length > 1) {
          // Rule A2: one message id, several requestIds: distinct responses.
          stats.gatewayConflicts++;
          /** @param {string} rid */
          const recOf = (rid) => /** @type {CompactResponse} */ (rid === g.rid0 ? g.rec0 : /** @type {Map<string, CompactResponse>} */ (g.ridMore).get(rid));
          if (g.empty) {
            mergeInto(recOf(rids[0]), g.empty);
            stats.ambiguousAttach += g.empty.observations;
            g.empty = null;
          }
          for (const rid of rids) emit(pk + '|' + rid, recOf(rid));
        } else {
          /** @type {CompactResponse|null} */
          let b = null;
          for (const rid of rids) {
            const x = /** @type {CompactResponse} */ (rid === g.rid0 ? g.rec0 : /** @type {Map<string, CompactResponse>} */ (g.ridMore).get(rid));
            b = b ? mergeInto(b, x) : x;
          }
          if (g.empty) b = b ? mergeInto(b, g.empty) : g.empty;
          if (b) emit(pk, b);
        }
        // Release this key's buckets now: the caller has already copied what it needs.
        g.rec0 = null;
        g.ridMore = null;
        g.empty = null;
        g.m = null;
        groups.delete(pk);
      }
      groups.clear();
      intern.clear();
      attrPool.clear();
      return {
        stats,
        keepFirstLineNano: /** @type {any} */ (keepFirstLineNano),
        dedupPerFileNano: /** @type {any} */ (dedupPerFileNano),
        mainFilesOnlyNano: /** @type {any} */ (mainFilesOnlyNano),
      };
    },
  };
}
