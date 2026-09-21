// The accounting pipeline: NormalizedEvents in, one AccountingResult out (DESIGN 4 and 5,
// rules A1 to A33; INTERFACES 4).
//
// Usage (the object doubles as the sink of src/node/read.js scanFiles):
//   const acc = createAccounting({ prices, tz, idleMinutes, pathStyle, overrides, projectRules, since, until });
//   acc.addFiles(fileRefs);                 // FileRef table from discovery (tie orders need it)
//   acc.onEvents(events, file);             // every adapter event, any order
//   acc.onFileDone(file, jsonlStats);       // scan receipts per file class
//   acc.addSkippedFile('compressed');       // discovery skips
//   const result = acc.finish();            // AccountingResult
//   const methods = acc.methods();          // MethodsDiagnostics for audit --methods (after finish)
//
// Order independence is a contract: shuffling file order or interleaving lines yields the same
// result. Every choice between duplicates uses the rule A3 order, never arrival order.
//
// Isomorphic: no node:* imports and no DOM.

import {
  ACCOUNTING_SCHEMA, emptyAggregate, addResponse, tokenTotal,
} from './contract.js';
import { FILE_CLASSES } from '../adapters/contract.js';
import { DEFAULT_IDLE_MINUTES, FALLBACK_TIME_ZONE, normalizeModelId } from '../constants.js';
import { createPricer } from './price.js';
import { priceResponse, addPart } from './money.js';
import { createDedup, keptUsage, fileCount, visibleCharsOf } from './dedup.js';
import { createTimeTracker, createLocalClock } from './time.js';
import { createToolTracker } from './tools.js';
import { createProjectResolver } from './projects.js';

const SEVERITY_RANK = { critical: 0, likely_fixture: 1, third_party_public: 2 };

/**
 * @typedef {Object} AccountingInput
 * @property {import('./contract.js').PriceTable} prices                required
 * @property {string} [tz]                                               IANA zone or +HH:MM (default UTC)
 * @property {number} [idleMinutes]                                      default 15
 * @property {'win32'|'posix'|'auto'} [pathStyle]                        default 'auto'
 * @property {import('./contract.js').PriceOverrides|null} [overrides]
 * @property {{ prefix: string, label: string }[]} [projectRules]
 * @property {number|null} [since]                                       epoch ms, inclusive
 * @property {number|null} [until]                                       epoch ms, exclusive
 * @property {boolean} [methods]                                         collect MethodsDiagnostics (default true)
 * @property {Pick<import('../adapters/contract.js').Adapter, 'dedupKey'|'merge'>} [adapter]  rule A1 key and A3 merge
 */

/** @returns {import('./contract.js').ClassScanStats} */
function emptyScan() {
  return { files: 0, bytes: 0, lines: 0, records: 0, parseErrors: 0, trailingPartial: 0, oversizeLines: 0 };
}

/**
 * Create an accounting accumulator.
 * @param {AccountingInput} options
 */
export function createAccounting(options) {
  if (!options || !options.prices) throw new TypeError('createAccounting: options.prices (a PriceTable) is required');
  const pricer = createPricer(options.prices, options.overrides || null);
  const clock = createLocalClock(options.tz || FALLBACK_TIME_ZONE);
  const idleMinutes = Number.isFinite(options.idleMinutes) && /** @type {number} */ (options.idleMinutes) > 0 ? /** @type {number} */ (options.idleMinutes) : DEFAULT_IDLE_MINUTES;
  const idleSeconds = Math.round(idleMinutes * 60);
  const since = typeof options.since === 'number' ? options.since : null;
  const until = typeof options.until === 'number' ? options.until : null;
  /** @param {number|null} ts */
  const inWindow = (ts) => ts === null || ((since === null || ts >= since) && (until === null || ts < until));
  const collectMethods = options.methods !== false;

  /** @type {import('../adapters/contract.js').FileRef[]} */
  const files = [];
  /** @type {Record<string, import('./contract.js').ClassScanStats>} */
  const scanByClass = Object.fromEntries(FILE_CLASSES.map((c) => [c, emptyScan()]));
  const skippedFiles = { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 };
  /** @type {Record<string, number>} */
  const skippedRecords = {};

  const dedup = createDedup(files, {
    dedupKey: options.adapter && options.adapter.dedupKey,
    merge: options.adapter && options.adapter.merge,
    methods: collectMethods,
  });
  const time = createTimeTracker(files, { clock, idleSeconds, inWindow });
  const tools = createToolTracker(files, { inWindow });
  const projects = createProjectResolver({ pathStyle: options.pathStyle || 'auto', rules: options.projectRules || [] });

  let syntheticLines = 0;
  /** @type {number[]} */
  const synthetic429Ts = [];
  /** @type {Set<string>} */
  const synthetic429Seen = new Set();
  /** @type {Map<number, { resetsAt: number, rateLimitType: string|null, firstRejectTs: number|null }>} */
  const quotaWindows = new Map();
  const workflows = { launched: 0, started: 0, result: 0, failed: 0 };
  /** @type {Map<string, any>} */
  const secrets = new Map();
  /** @type {Map<string, import('../adapters/contract.js').CostStateEvent>} */
  const costStates = new Map();
  /** @type {Set<string>} */
  const agentVersions = new Set();
  let sumEveryLine = 0n;
  /** @type {import('./contract.js').MethodsDiagnostics|null} */
  let methodsOut = null;
  let finished = false;

  /** @param {import('../adapters/contract.js').NormalizedEvent} ev */
  function addEvent(ev) {
    if (finished) throw new Error('accounting already finished');
    switch (ev.kind) {
      case 'response': {
        // The value of this single line: the "sum every line" wrong method (DESIGN 4.3), and the
        // only thing dedup needs from a line it does not keep, so no observation is retained.
        const obsNano = collectMethods ? priceResponse(pricer, ev.rawModel, ev.usage).valueNano : 0;
        dedup.add(ev, obsNano);
        if (collectMethods) sumEveryLine += BigInt(obsNano);
        return;
      }
      case 'activity':
        time.addActivity(ev);
        projects.observe(ev, files);
        if (ev.agentVersion) agentVersions.add(ev.agentVersion);
        return;
      case 'prompt':
      case 'interrupt':
        time.addPrompt(ev);
        return;
      case 'tool_use':
        tools.addUse(ev);
        return;
      case 'tool_result':
        tools.addResult(ev);
        return;
      case 'synthetic':
        syntheticLines++;
        // A superseded, orphaned or forked copy repeats the same 429 line: count it once
        // (DESIGN 9.4, a duplicate copy of any file changes nothing). Synthetic events carry no
        // uuid, so the identity is (sessionId, timestamp); a set keeps it order independent.
        if (ev.apiErrorStatus === 429 && ev.ts !== null && inWindow(ev.ts)) {
          const k = (ev.sessionId || '') + ' ' + ev.ts;
          if (!synthetic429Seen.has(k)) {
            synthetic429Seen.add(k);
            synthetic429Ts.push(ev.ts);
          }
        }
        return;
      case 'quota': {
        if (ev.status !== 'rejected' || ev.resetsAt === null || !inWindow(ev.ts)) return;
        const cur = quotaWindows.get(ev.resetsAt);
        if (!cur) quotaWindows.set(ev.resetsAt, { resetsAt: ev.resetsAt, rateLimitType: ev.rateLimitType, firstRejectTs: ev.ts });
        else if (ev.ts !== null && (cur.firstRejectTs === null || ev.ts < cur.firstRejectTs
          || (ev.ts === cur.firstRejectTs && (ev.rateLimitType || '') < (cur.rateLimitType || '')))) {
          cur.firstRejectTs = ev.ts;
          cur.rateLimitType = ev.rateLimitType;
        }
        return;
      }
      case 'workflow':
        workflows[ev.event]++;
        return;
      case 'cost_state': {
        const k = (ev.sessionId || '') + ' ' + (ev.startTime ?? '');
        const cur = costStates.get(k);
        if (!cur || laterSnapshot(ev, cur)) costStates.set(k, ev);
        return;
      }
      case 'secret': {
        if (!inWindow(ev.ts)) return;
        const k = ev.secretType + ' ' + ev.fingerprint12;
        let s = secrets.get(k);
        if (!s) {
          s = { secretType: ev.secretType, fingerprint12: ev.fingerprint12, best: ev, copies: 0, files: new Set(), newestTs: null, expired: [], sessions: new Set() };
          secrets.set(k, s);
        }
        s.copies++;
        s.files.add(ev.fileIdx);
        if (ev.ts !== null && (s.newestTs === null || ev.ts > s.newestTs)) s.newestTs = ev.ts;
        s.expired.push(ev.expired);
        if (ev.sessionId) s.sessions.add(ev.sessionId);
        const rb = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (s.best.severity)] ?? 9;
        const re = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (ev.severity)] ?? 9;
        if (re < rb || (re === rb && fileOrder(ev, s.best) < 0)) s.best = ev;
        return;
      }
      case 'skipped':
        skippedRecords[ev.reason] = (skippedRecords[ev.reason] || 0) + 1;
        return;
      default:
        return;
    }
  }

  /** @param {{ fileIdx: number, lineNo: number }} a @param {{ fileIdx: number, lineNo: number }} b */
  function fileOrder(a, b) {
    const fa = files[a.fileIdx];
    const fb = files[b.fileIdx];
    if (!fa || !fb) return 0;
    if (fa.depth !== fb.depth) return fa.depth - fb.depth;
    if (fa.relPath !== fb.relPath) return fa.relPath < fb.relPath ? -1 : 1;
    if (fa.rootIdx !== fb.rootIdx) return fa.rootIdx - fb.rootIdx;
    return a.lineNo - b.lineNo;
  }

  /**
   * The last snapshot of a (sessionId, startTime) group: latest ts, then the later line of the
   * later file in path order.
   * @param {import('../adapters/contract.js').CostStateEvent} a
   * @param {import('../adapters/contract.js').CostStateEvent} b
   */
  function laterSnapshot(a, b) {
    const ta = a.ts ?? -Infinity;
    const tb = b.ts ?? -Infinity;
    if (ta !== tb) return ta > tb;
    return fileOrder(a, b) > 0;
  }

  /**
   * Build the AccountingResult.
   * @returns {import('./contract.js').AccountingResult}
   */
  function finish() {
    if (finished) throw new Error('accounting already finished');
    finished = true;
    const t = time.finish();
    const tl = tools.finish();

    // Distinct model ids and project keys are a handful even in a huge scan, so one string is
    // stored per distinct value instead of one per response.
    /** @type {Map<string|null, string>} */
    const modelIds = new Map();
    /** @param {string|null} raw */
    const modelIdOf = (raw) => {
      let m = modelIds.get(raw);
      if (m === undefined) { m = normalizeModelId(raw); modelIds.set(raw, m); }
      return m;
    };
    /** @type {Map<string, { key: string, label: string }>} */
    const projectOf = new Map();
    /** @param {string|null} cwd @param {string|null} sessionId */
    const projectFor = (cwd, sessionId) => {
      const k = (cwd || '') + '\u0000' + (sessionId || '');
      let p = projectOf.get(k);
      if (p === undefined) { p = projects.keyFor(cwd, sessionId); projectOf.set(k, p); }
      return p;
    };

    // One pass over the deduped responses. Each CompactResponse is priced and turned into a
    // ResponseRecord here and released immediately, so the dedup buckets and the records are
    // never both fully live.
    /** @type {import('./contract.js').ResponseRecord[]} */
    const responses = [];
    // The project label of each record, held beside the records rather than on them. A property
    // added to a ResponseRecord and deleted again would put every record into V8's dictionary
    // mode, which costs about 1.5 KB of property table per response and would make the record
    // the largest thing the scan retains.
    /** @type {Map<import('./contract.js').ResponseRecord, string>} */
    const labelOf = new Map();
    let correct = 0n;
    let allWritesAt5m = 0n;
    const d = dedup.finish((rec) => {
      const usage = keptUsage(rec);
      const p = priceResponse(pricer, rec.rawModel, usage);
      if (collectMethods) {
        // Windowless, over every key (DESIGN 4.3, 9.4).
        correct += BigInt(p.valueNano);
        allWritesAt5m += BigInt(priceResponse(pricer, rec.rawModel, usage, { allWritesAt5m: true }).valueNano);
      }
      if (!inWindow(rec.tsMin)) return;
      const file = files[rec.fileIdx];
      const proj = projectFor(rec.cwd, rec.sessionId);
      /** @type {import('./contract.js').ResponseRecord} */
      const r = {
        key: rec.key,
        sessionId: rec.sessionId,
        fileIdx: rec.fileIdx,
        fileClass: file ? file.fileClass : 'main',
        isSidechain: rec.isSidechain,
        rawModel: rec.rawModel,
        model: modelIdOf(rec.rawModel),
        priced: p.priced,
        tsStart: rec.tsMin,
        tsEnd: rec.tsMax,
        complete: rec.final,
        fast: p.fast,
        geoUs: p.geoUs,
        serviceTier: rec.serviceTier,
        ttlEstimated: p.ttlEstimated,
        tokens: p.tokens,
        valueNano: p.valueNano,
        bucketsNano: p.bucketsNano,
        parts: p.parts,
        webSearchRequests: rec.webSearchRequests,
        thinkingTokens: rec.reasoning,
        visibleChars: visibleCharsOf(rec),
        effort: rec.effort,
        projectKey: proj.key || null,
        attribution: rec.attribution,
        observations: rec.observations,
        files: fileCount(rec),
      };
      labelOf.set(r, proj.label);
      responses.push(r);
    });
    responses.sort((a, b) => {
      const ta = a.tsStart ?? -Infinity;
      const tb = b.tsStart ?? -Infinity;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const totals = emptyAggregate();
    /** @type {Record<'main'|'subagent'|'workflow_agent', import('./contract.js').Aggregate>} */
    const byClass = { main: emptyAggregate(), subagent: emptyAggregate(), workflow_agent: emptyAggregate() };
    /** @type {Map<string, import('./contract.js').ModelAggregate>} */
    const byModel = new Map();
    /** @type {Map<string, import('./contract.js').Aggregate>} */
    const bySessionAgg = new Map();
    /** @type {Map<string, { agg: import('./contract.js').Aggregate, label: string, sessions: Set<string> }>} */
    const byProject = new Map();
    /** @type {Map<string, import('./contract.js').Aggregate>} */
    const byDay = new Map();
    /** @type {Map<string, import('./contract.js').Aggregate>} */
    const byMonth = new Map();
    /** @type {Map<string, { model: string, responses: number, tokens: number }>} */
    const unpriced = new Map();
    const modifiers = { fast: 0, geoUs: 0, nonStandardTier: 0, ttlEstimated: 0, webSearchRequests: 0 };
    let pricedTokens = 0;
    let allTokens = 0;

    for (const r of responses) {
      addResponse(totals, r);
      const cls = /** @type {'main'|'subagent'|'workflow_agent'} */ (r.fileClass);
      if (byClass[cls]) addResponse(byClass[cls], r);
      const seenModels = new Set();
      let countedUnpriced = false;
      for (const part of r.parts) {
        const n = tokenTotal(part.tokens);
        allTokens += n;
        if (part.priced) pricedTokens += n;
        else {
          let u = unpriced.get(part.model);
          if (!u) { u = { model: part.model, responses: 0, tokens: 0 }; unpriced.set(part.model, u); }
          u.tokens += n;
          if (!countedUnpriced) { u.responses++; countedUnpriced = true; }
        }
        let m = byModel.get(part.model);
        if (!m) {
          m = { ...emptyAggregate(), model: part.model, displayName: pricer.displayName(part.model), priced: pricer.has(part.model) };
          byModel.set(part.model, m);
        }
        addPart(m, part, r.complete, !seenModels.has(part.model));
        seenModels.add(part.model);
      }
      if (r.sessionId) {
        let s = bySessionAgg.get(r.sessionId);
        if (!s) { s = emptyAggregate(); bySessionAgg.set(r.sessionId, s); }
        addResponse(s, r);
      }
      const pk = r.projectKey || '';
      let pa = byProject.get(pk);
      if (!pa) { pa = { agg: emptyAggregate(), label: /** @type {string} */ (labelOf.get(r)), sessions: new Set() }; byProject.set(pk, pa); }
      addResponse(pa.agg, r);
      if (r.sessionId) pa.sessions.add(r.sessionId);
      if (r.tsStart !== null) {
        const lp = clock.parts(r.tsStart);
        let da = byDay.get(lp.date);
        if (!da) { da = emptyAggregate(); byDay.set(lp.date, da); }
        addResponse(da, r);
        let ma = byMonth.get(lp.month);
        if (!ma) { ma = emptyAggregate(); byMonth.set(lp.month, ma); }
        addResponse(ma, r);
      }
      if (r.fast) modifiers.fast++;
      if (r.geoUs) modifiers.geoUs++;
      if (r.serviceTier !== null && r.serviceTier !== 'standard') modifiers.nonStandardTier++;
      if (r.ttlEstimated) modifiers.ttlEstimated++;
      modifiers.webSearchRequests += r.webSearchRequests;
    }
    labelOf.clear();

    // Sessions: every session with activity or responses.
    /** @type {import('./contract.js').SessionAggregate[]} */
    const bySession = [];
    const sessionIds = new Set([...bySessionAgg.keys(), ...[...t.sessions.keys()].filter((k) => k !== null)]);
    for (const sid of /** @type {Set<string>} */ (sessionIds)) {
      const st = t.sessions.get(sid);
      bySession.push({
        ...(bySessionAgg.get(sid) || emptyAggregate()),
        sessionId: sid,
        launchFolder: projects.launchFolder(sid),
        firstTs: st ? st.firstTs : null,
        lastTs: st ? st.lastTs : null,
        activeSeconds: st ? st.activeSeconds : 0,
        workBlocks: st ? st.workBlocks : 0,
      });
    }
    bySession.sort((a, b) => {
      const fa = a.firstTs ?? Infinity;
      const fb = b.firstTs ?? Infinity;
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });

    /** @type {import('./contract.js').ProjectAggregate[]} */
    const projectList = [...byProject.entries()].map(([projectKey, p]) => ({ ...p.agg, projectKey, label: p.label, sessions: p.sessions.size }));
    projectList.sort((a, b) => (a.valueNano !== b.valueNano ? (a.valueNano > b.valueNano ? -1 : 1) : a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0));
    const modelList = [...byModel.values()].sort((a, b) => (a.valueNano !== b.valueNano ? (a.valueNano > b.valueNano ? -1 : 1) : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));

    // Secrets grouped by fingerprint (I11).
    const secretList = [...secrets.values()].map((s) => {
      const exp = s.expired;
      const expired = exp.some((/** @type {boolean|null} */ x) => x === false) ? false : exp.length && exp.every((/** @type {boolean|null} */ x) => x === true) ? true : null;
      const projectKeys = [...new Set([...s.sessions].map((sid) => projects.launchFolder(sid)).filter(Boolean))].sort();
      return {
        secretType: s.secretType, fingerprint12: s.fingerprint12, severity: s.best.severity, source: s.best.source,
        copies: s.copies, files: s.files.size, newestTs: s.newestTs, expired, projectKeys,
      };
    }).sort((a, b) => {
      const ra = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (a.severity)] ?? 9;
      const rb = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (b.severity)] ?? 9;
      if (ra !== rb) return ra - rb;
      const na = a.newestTs ?? -Infinity;
      const nb = b.newestTs ?? -Infinity;
      if (na !== nb) return na > nb ? -1 : 1;
      return a.fingerprint12 < b.fingerprint12 ? -1 : a.fingerprint12 > b.fingerprint12 ? 1 : 0;
    });

    const costStateWindows = [...costStates.values()].map((c) => ({
      sessionId: c.sessionId || '', startTime: c.startTime, lastTs: c.ts, reportedCostNano: c.reportedCostNano,
      models: c.models.map((m) => ({ ...m })).sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
    })).sort((a, b) => (a.sessionId !== b.sessionId ? (a.sessionId < b.sessionId ? -1 : 1) : (a.startTime ?? -1) - (b.startTime ?? -1)));

    // Wrong-method diagnostics (DESIGN 4.3, 9.4; audit --methods). Windowless, over every key.
    // `correct` and `allWritesAt5m` were summed as each response was priced above; the other
    // three are summed by dedup as it folds observations in, so no line is kept to re-price.
    if (collectMethods) {
      methodsOut = {
        correct,
        sumEveryLine,
        keepFirstLine: d.keepFirstLineNano,
        dedupPerFile: d.dedupPerFileNano,
        allWritesAt5m,
        mainFilesOnly: d.mainFilesOnlyNano,
      };
    }

    const sortedRecord = (/** @type {Map<string, import('./contract.js').Aggregate>} */ m) => {
      /** @type {Record<string, import('./contract.js').Aggregate>} */
      const o = {};
      for (const k of [...m.keys()].sort()) o[k] = /** @type {import('./contract.js').Aggregate} */ (m.get(k));
      return o;
    };

    return {
      schema: ACCOUNTING_SCHEMA,
      files: files.filter(Boolean),
      scanByClass: /** @type {any} */ (scanByClass),
      skippedFiles,
      skippedRecords: Object.fromEntries(Object.keys(skippedRecords).sort().map((k) => [k, skippedRecords[k]])),
      dedup: {
        observations: d.stats.observations,
        keys: d.stats.keys,
        gatewayConflicts: d.stats.gatewayConflicts,
        ambiguousAttach: d.stats.ambiguousAttach,
        invariantViolations: d.stats.invariantViolations,
        forkedKeys: d.stats.forkedKeys,
        syntheticLines,
        duplicateToolUseIds: tl.duplicateToolUseIds,
        orphanToolResults: tl.orphanToolResults,
      },
      responses,
      totals,
      pricedTokens,
      allTokens,
      unpriced: [...unpriced.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
      byClass,
      byModel: modelList,
      bySession,
      byProject: projectList,
      byLocalDay: sortedRecord(byDay),
      byLocalMonth: sortedRecord(byMonth),
      modifiers,
      tools: tl.records,
      time: t.time,
      rateLimits: {
        quotaRejectWindows: [...quotaWindows.values()].sort((a, b) => a.resetsAt - b.resetsAt),
        synthetic429Ts: synthetic429Ts.sort((a, b) => a - b),
      },
      workflows,
      secrets: secretList,
      costStateWindows,
      agentVersions: [...agentVersions].sort(),
    };
  }

  return {
    pricer,
    clock,
    /** @param {import('../adapters/contract.js').FileRef} f */
    addFile(f) {
      if (!f || !Number.isInteger(f.idx)) throw new TypeError('addFile: FileRef with an integer idx required');
      files[f.idx] = f;
    },
    /** @param {import('../adapters/contract.js').FileRef[]} fs */
    addFiles(fs) {
      for (const f of fs) this.addFile(f);
    },
    addEvent,
    /**
     * Sink interface of src/node/read.js: events of one file, in line order.
     * @param {import('../adapters/contract.js').NormalizedEvent[]} evs
     * @param {import('../adapters/contract.js').FileRef} [file]
     */
    onEvents(evs, file) {
      if (file && !files[file.idx]) files[file.idx] = file;
      for (const ev of evs) addEvent(ev);
    },
    /**
     * Scan receipts for one file (rule A28, trap 1).
     * @param {import('../adapters/contract.js').FileRef} file
     * @param {import('../jsonl.js').JsonlStats} stats
     */
    onFileDone(file, stats) {
      if (!files[file.idx]) files[file.idx] = file;
      const c = scanByClass[file.fileClass];
      if (!c) return;
      c.files++;
      c.bytes += stats.bytes;
      c.lines += stats.lines;
      c.records += stats.records;
      c.parseErrors += stats.parseErrors;
      c.trailingPartial += stats.trailingPartial;
      c.oversizeLines += stats.oversizeLines;
    },
    /**
     * @param {'compressed'|'unknown-extension'|'unknown-shape'} reason
     * @param {number} [n]
     */
    addSkippedFile(reason, n = 1) {
      if (Object.prototype.hasOwnProperty.call(skippedFiles, reason)) skippedFiles[reason] += n;
    },
    finish,
    /**
     * Wrong-method diagnostics (DESIGN 4.3, 9.4), available after finish().
     * @returns {import('./contract.js').MethodsDiagnostics}
     */
    methods() {
      if (!finished) throw new Error('call finish() first');
      if (!methodsOut) throw new Error('methods were not collected (options.methods === false)');
      return methodsOut;
    },
  };
}

/**
 * Convenience for tests and the browser worker: account a complete list of events.
 * @param {AccountingInput} options
 * @param {import('../adapters/contract.js').FileRef[]} files
 * @param {Iterable<import('../adapters/contract.js').NormalizedEvent>} events
 * @returns {{ result: import('./contract.js').AccountingResult, methods: import('./contract.js').MethodsDiagnostics|null }}
 */
export function accountEvents(options, files, events) {
  const acc = createAccounting(options);
  acc.addFiles(files);
  for (const ev of events) acc.addEvent(ev);
  const result = acc.finish();
  return { result, methods: options.methods === false ? null : acc.methods() };
}

/**
 * MethodsDiagnostics as JSON (money as digit strings) with ratios to the correct value, for
 * `audit --methods` and the README table.
 * @param {import('./contract.js').MethodsDiagnostics} m
 * @returns {Record<string, { valueNano: string, ratio: number }>}
 */
export function methodsToJson(m) {
  /** @type {Record<string, { valueNano: string, ratio: number }>} */
  const out = {};
  for (const k of /** @type {(keyof import('./contract.js').MethodsDiagnostics)[]} */ (['correct', 'sumEveryLine', 'keepFirstLine', 'dedupPerFile', 'allWritesAt5m', 'mainFilesOnly'])) {
    const v = m[k];
    out[k] = { valueNano: v.toString(), ratio: m.correct === 0n ? 0 : Number((v * 1_000_000n) / m.correct) / 1_000_000 };
  }
  return out;
}

export { createPricer } from './price.js';
export { priceResponse } from './money.js';
