// Test harness (dev only): walk a fixture projects/ tree, classify with the Claude Code adapter,
// read with the core JSONL reader, parse, validate every event against the contract and feed the
// accounting pipeline. Also projects an AccountingResult onto the shared expected-file keys
// (INTERFACES 11) so tests can compare against expected.json and ground-truth.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, createJsonlStats } from '../../src/core/jsonl.js';
import { assertEvent } from '../../src/core/adapters/contract.js';
import { claudeCodeAdapter } from '../../src/core/adapters/claude-code/index.js';
import { createAccounting } from '../../src/core/accounting/index.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { sha256Hex } from '../../src/core/sha256.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Sorted recursive file list (relative, '/' separators).
 * @param {string} root
 * @returns {string[]}
 */
export function walk(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) rec(path.join(dir, e.name), r);
      else out.push(r);
    }
  })(root, '');
  return out.sort();
}

/**
 * Discover and classify every file under the roots (the node team's discover.js does this for real).
 * @param {string[]} roots
 * @param {{ order?: (refs: any[]) => any[] }} [opts]
 */
export function discover(roots, opts = {}) {
  /** @type {import('../../src/core/adapters/contract.js').FileRef[]} */
  let refs = [];
  const skipped = { compressed: 0, 'unknown-extension': 0, 'unknown-shape': 0 };
  roots.forEach((root, rootIdx) => {
    for (const rel of walk(root)) {
      const d = claudeCodeAdapter.classify(rel);
      if (d.action === 'skip') { skipped[d.reason]++; continue; }
      refs.push({ idx: -1, rootIdx, relPath: rel, fileClass: d.fileClass, depth: d.depth, size: fs.statSync(path.join(root, rel)).size });
    }
  });
  refs.sort((a, b) => (a.rootIdx - b.rootIdx) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  if (opts.order) refs = opts.order(refs);
  refs.forEach((r, i) => { r.idx = i; });
  return { refs, skipped };
}

/**
 * Parse every line of every file into events.
 * @param {string[]} roots
 * @param {import('../../src/core/adapters/contract.js').FileRef[]} refs
 * @param {{ strict?: boolean, scanSecrets?: any }} [opts]
 */
export async function parseAll(roots, refs, opts = {}) {
  const perFile = [];
  for (const file of refs) {
    const bytes = fs.readFileSync(path.join(roots[file.rootIdx], file.relPath)).subarray(0, file.size);
    const stats = createJsonlStats();
    const fileState = {};
    const ctx = { file, lineNo: 0, fileState, pathStyle: 'auto', hashPath: sha256Hex, scanSecrets: opts.scanSecrets || null };
    const events = [];
    for await (const rec of readJsonl([bytes], { stats })) {
      ctx.lineNo = rec.lineNo;
      const evs = claudeCodeAdapter.parseLine(rec.value, ctx);
      for (const ev of evs) {
        if (opts.strict !== false) assertEvent(ev);
        events.push(ev);
      }
    }
    perFile.push({ file, stats, events });
  }
  return perFile;
}

/**
 * Full pipeline over one or more roots.
 * @param {string|string[]} rootOrRoots
 * @param {{ tz?: string, idleMinutes?: number, order?: (refs: any[]) => any[], interleave?: (lists: any[][]) => any[], strict?: boolean, prices?: any, overrides?: any, projectRules?: any, scanSecrets?: any, since?: number|null, until?: number|null }} [opts]
 */
export async function runPipeline(rootOrRoots, opts = {}) {
  const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
  const { refs, skipped } = discover(roots, { order: opts.order });
  const parsed = await parseAll(roots, refs, { strict: opts.strict, scanSecrets: opts.scanSecrets });
  const acc = createAccounting({
    prices: opts.prices || getPriceTable(), tz: opts.tz || 'UTC', idleMinutes: opts.idleMinutes || 15, pathStyle: 'auto',
    overrides: opts.overrides || null, projectRules: opts.projectRules || [], since: opts.since ?? null, until: opts.until ?? null,
    adapter: claudeCodeAdapter,
  });
  acc.addFiles(refs);
  for (const [reason, n] of Object.entries(skipped)) if (n) acc.addSkippedFile(/** @type {any} */ (reason), n);
  if (opts.interleave) {
    for (const ev of opts.interleave(parsed.map((p) => p.events))) acc.addEvent(ev);
  } else {
    for (const p of parsed) acc.onEvents(p.events, p.file);
  }
  for (const p of parsed) acc.onFileDone(p.file, p.stats);
  const result = acc.finish();
  return { result, methods: acc.methods(), refs, parsed, pricer: acc.pricer };
}

/**
 * Project an AccountingResult onto the expected-file keys (INTERFACES 11).
 * @param {import('../../src/core/accounting/contract.js').AccountingResult} r
 * @param {import('../../src/core/accounting/contract.js').MethodsDiagnostics} [m]
 */
export function toExpectedShape(r, m) {
  const classes = ['main', 'subagent', 'workflow_agent', 'workflow_journal'];
  const sidechain = r.responses.filter((x) => x.isSidechain).reduce((a, x) => a + BigInt(x.valueNano), 0n);
  const tok = r.totals.tokens;
  const callsByName = {};
  const status = { ok: 0, denied: 0, shell_exit: 0, failed: 0, unpaired: 0 };
  const byId = {};
  let okEditNewLines = 0;
  let okWriteLines = 0;
  for (const t of r.tools) {
    callsByName[t.name] = (callsByName[t.name] || 0) + 1;
    status[t.status]++;
    byId[t.id] = t.status;
    if (t.status === 'ok') { okEditNewLines += t.editNewLines || 0; okWriteLines += t.writeLines || 0; }
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const byModelNano = {};
  for (const x of r.byModel) if (x.priced) byModelNano[x.model] = x.valueNano.toString();
  const b = r.totals.bucketsNano;
  let episodes = 0;
  let last = null;
  for (const ts of r.rateLimits.synthetic429Ts) { if (last === null || ts - last > 30 * 60 * 1000) episodes++; last = ts; }
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  return {
    scan: {
      files: Object.fromEntries(classes.map((c) => [c, r.scanByClass[c].files])),
      linesByClass: Object.fromEntries(classes.map((c) => [c, r.scanByClass[c].lines])),
      recordsByClass: Object.fromEntries(classes.map((c) => [c, r.scanByClass[c].records])),
      parseErrors: classes.reduce((a, c) => a + r.scanByClass[c].parseErrors, 0),
      trailingPartial: classes.reduce((a, c) => a + r.scanByClass[c].trailingPartial, 0),
      oversizeLines: classes.reduce((a, c) => a + r.scanByClass[c].oversizeLines, 0),
    },
    dedup: { ...r.dedup },
    responses: r.totals.responses,
    incompleteResponses: r.totals.incomplete,
    sessions: r.time && r.bySession.filter((s) => s.firstTs !== null).length,
    tokens: { ...tok },
    valueNano: r.totals.valueNano.toString(),
    responseValueNano: sortObj(Object.fromEntries(r.responses.map((x) => [x.key, x.priced ? String(x.valueNano) : null]))),
    responseClass: Object.fromEntries(r.responses.map((x) => [x.key, x.fileClass])),
    responseComplete: Object.fromEntries(r.responses.map((x) => [x.key, x.complete])),
    bucketsNano: { input: b.input.toString(), output: b.output.toString(), cw5m: b.cw5m.toString(), cw1h: b.cw1h.toString(), cacheRead: b.cacheRead.toString() },
    webSearchNano: b.webSearch.toString(),
    byClassNano: { main: r.byClass.main.valueNano.toString(), subagent: r.byClass.subagent.valueNano.toString(), workflow_agent: r.byClass.workflow_agent.valueNano.toString() },
    byModelNano: sortObj(byModelNano),
    sidechainNano: sidechain.toString(),
    delegationShare: { numNano: sidechain.toString(), denNano: r.totals.valueNano.toString() },
    cacheHitRate: { num: tok.cacheRead, den: tok.cacheRead + tok.cw5m + tok.cw1h + tok.input },
    pricedTokens: r.pricedTokens,
    allTokens: r.allTokens,
    unpriced: r.unpriced,
    modifiers: { ...r.modifiers },
    tools: { calls: r.tools.length, paired: r.tools.filter((t) => t.status !== 'unpaired').length, status, byId: sortObj(byId), callsByName: sortObj(callsByName), okEditNewLines, okWriteLines },
    time: { activeSeconds: r.time.activeSeconds, workBlockSeconds: r.time.workBlockSeconds, agentSeconds: r.time.agentSeconds, agentSecondsByClass: r.time.agentSecondsByClass },
    prompts: r.time.prompts,
    interrupts: r.time.interrupts,
    activeDays: r.time.activeDays,
    longestStreakDays: r.time.longestStreakDays,
    peakHourLocal: r.time.peakHourLocal,
    rateLimits: { quotaRejectWindows: r.rateLimits.quotaRejectWindows.length, synthetic429Lines: r.rateLimits.synthetic429Ts.length, episodes },
    workflows: { ...r.workflows },
    coverage: { earliestMainTs: iso(r.time.earliestMainTs), earliestAnyTs: iso(r.time.earliestAnyTs), latestTs: iso(r.time.latestTs) },
    methods: m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()])) : undefined,
  };
}

/**
 * Keys of `want` that differ in `got` (deep, only keys `want` has), skipping `skip` at the top.
 * @returns {string[]}
 */
export function diffExpected(want, got, skip = new Set(), at = '$', out = []) {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    for (const k of Object.keys(want)) {
      if (at === '$' && skip.has(k)) continue;
      if (got === null || got === undefined || typeof got !== 'object' || !(k in got)) { out.push(at + '.' + k + ': missing'); continue; }
      diffExpected(want[k], got[k], skip, at + '.' + k, out);
    }
    return out;
  }
  if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${at}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  return out;
}
