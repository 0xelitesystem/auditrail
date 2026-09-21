// Persona engine (DESIGN 9.5): writes a fake Claude Code projects/ tree with every trap, and
// records ground truth from each response's TRUE usage at the moment it is created, before it
// is split into lines or copied. Ground truth never re-reads the written lines for money.
//
// Everything is fictional: sessions, projects (-fake-*), paths (/fake/...), and a phrase bank.

import { billedParts, priceNano, normModel, resolveTtl, RATES_MILLI, fnv1a } from './_lib.mjs';

/** Lines per response, a synthetic spread from 1 to 6 lines (most responses take 2 or 3 lines). */
const LINE_DIST = [[1, 20], [2, 40], [3, 25], [4, 8], [5, 4], [6, 3]];

const PHRASES = [
  'checking the fictional parser', 'renaming a made-up helper', 'reading the pretend config', 'running the imaginary tests',
  'drafting a fake changelog entry', 'tidying the invented module', 'looking at the synthetic fixture', 'wiring the toy widget',
];

const LS = String.fromCharCode(0x2028); // raw LINE SEPARATOR, legal inside JSON strings (trap 2)

/**
 * @typedef {{ rel: string, cls: string, records: any[], tail: string|null, crlf: boolean, original: boolean }} PFile
 */

export class Persona {
  /**
   * @param {string} name
   * @param {() => number} rng
   * @param {{ anchorMs: number, tz: string }} opts
   */
  constructor(name, rng, opts) {
    this.name = name;
    this.rng = rng;
    this.opts = opts;
    this.tag = name.replace(/[^a-z]/g, '').slice(0, 10);
    this.seq = 0;
    /** @type {Map<string, PFile>} */
    this.files = new Map();
    this.truth = {
      responses: /** @type {any[]} */ ([]),
      tools: /** @type {Map<string, any>} */ (new Map()),
      prompts: /** @type {number[]} */ ([]),
      interrupts: 0,
      activity: /** @type {{ sid: string, ts: number, rel: string, cls: string }[]} */ ([]),
      synthetic429: 0,
      quotaResets: new Set(),
      workflows: { launched: 0, started: 0, result: 0, failed: 0 },
      sessions: new Set(),
    };
  }

  // ---- randomness helpers -------------------------------------------------------------
  int(a, b) { return a + Math.floor(this.rng() * (b - a + 1)); }
  chance(p) { return this.rng() < p; }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  linesPerResponse() {
    let x = this.rng() * 100;
    for (const [n, w] of LINE_DIST) { if (x < w) return n; x -= w; }
    return 1;
  }
  nextId(prefix) { return `${prefix}_${this.tag}_${String(++this.seq).padStart(5, '0')}`; }
  uuid() {
    const n = ++this.seq;
    return (fnv1a(this.name) >>> 0).toString(16).padStart(8, '0') + '-' + String(n % 10000).padStart(4, '0') + '-4000-8000-' + String(n).padStart(12, '0');
  }
  sessionId(n) { return (fnv1a(this.name + ':session') >>> 0).toString(16).padStart(8, '0') + '-0000-4000-8000-' + String(n).padStart(12, '0'); }

  // ---- files ---------------------------------------------------------------------------
  /** @returns {PFile} */
  file(rel, cls, original = true) {
    let f = this.files.get(rel);
    if (!f) { f = { rel, cls, records: [], tail: null, crlf: false, original }; this.files.set(rel, f); }
    return f;
  }

  /**
   * Append one record. Original user and assistant lines with a timestamp are registered for
   * active-time ground truth.
   */
  put(f, rec, register = true) {
    f.records.push(rec);
    if (register && f.original && (rec.type === 'user' || rec.type === 'assistant') && rec.timestamp) {
      this.truth.activity.push({ sid: rec.sessionId, ts: Date.parse(rec.timestamp), rel: f.rel, cls: f.cls });
      this.truth.sessions.add(rec.sessionId);
    }
    return rec;
  }

  // ---- sessions ------------------------------------------------------------------------
  /**
   * @param {{ n: number, project: string, cwd: string, startMs: number, version?: string }} o
   */
  session(o) {
    const sid = this.sessionId(o.n);
    const mainRel = `projects/-fake-${o.project}/${sid}.jsonl`;
    return { p: this, sid, project: o.project, cwd: o.cwd, t: o.startMs, mainRel, main: this.file(mainRel, 'main'), ctx: 0, lastModel: null, version: o.version || '2.1.200' };
  }

  base(s, side, extra = {}) {
    return { parentUuid: null, isSidechain: side, userType: 'external', cwd: s.cwd, sessionId: s.sid, version: s.version, gitBranch: 'main', ...extra };
  }

  tick(s, minSec, maxSec) { s.t += this.int(minSec, maxSec) * 1000; return s.t; }
  ts(s) { return new Date(s.t).toISOString(); }

  /** A human prompt on the main thread. kind: 'text' | 'block' | 'interrupt' | 'meta' | 'system' | 'compact' */
  prompt(s, kind = 'text') {
    const text = kind === 'interrupt' ? '[Request interrupted by user]' : 'please keep ' + this.pick(PHRASES);
    const rec = { ...this.base(s, false), type: 'user', timestamp: this.ts(s), uuid: this.uuid(), message: { role: 'user', content: kind === 'block' ? [{ type: 'text', text }] : text } };
    if (kind === 'meta') rec.isMeta = true;
    if (kind === 'system') rec.promptSource = 'system';
    if (kind === 'compact') rec.isCompactSummary = true;
    if (kind === 'text' || kind === 'block') rec.promptSource = 'typed';
    this.put(s.main, rec);
    if (kind === 'text' || kind === 'block') this.truth.prompts.push(s.t);
    if (kind === 'interrupt') this.truth.interrupts++;
    return rec;
  }

  /**
   * One API response written as N lines.
   * @param {any} s session
   * @param {PFile} f
   * @param {{ model: string, side?: boolean, agentId?: string, tool?: { name: string, input: any }, complete?: boolean,
   *   u: { input: number, cw5m: number, cw1h: number, read: number, output: number },
   *   speed?: string, geo?: string, iterations?: any[], noSplit?: boolean, splitOverride?: any, webSearch?: number,
   *   dropRequestIdOnLine?: number, quota?: any, attribution?: any, lines?: number }} o
   */
  respond(s, f, o) {
    const side = !!o.side;
    const complete = o.complete !== false;
    const mid = this.nextId('msg');
    const rid = this.nextId('req');
    const n = Math.max(o.lines || this.linesPerResponse(), o.tool ? 1 : 1);
    const toolId = o.tool ? this.nextId('toolu') : null;
    const blocks = [];
    for (let i = 0; i < n - (o.tool ? 1 : 0); i++) {
      if (i === 0 && this.chance(0.5)) blocks.push({ type: 'thinking', thinking: '', signature: 'fictional-signature' });
      else blocks.push({ type: 'text', text: this.pick(PHRASES) + (this.chance(0.05) ? LS + 'second part' : '') });
    }
    if (o.tool) blocks.push({ type: 'tool_use', id: toolId, name: o.tool.name, input: o.tool.input });
    const u = o.u;
    const finalOut = Math.max(u.output, n + 10);
    const usageFor = (i, last) => {
      // Complete: a running value that ends at the true output. Incomplete: the streaming
      // placeholder (single digits) that is all Claude Code ever wrote (rule A5).
      const out = complete ? (last ? finalOut : Math.max(1, Math.floor((finalOut * (i + 1)) / (n + 1)))) : i + 2;
      const cc = o.noSplit ? undefined : o.splitOverride || { ephemeral_5m_input_tokens: u.cw5m, ephemeral_1h_input_tokens: u.cw1h };
      const us = { input_tokens: u.input, cache_creation_input_tokens: u.cw5m + u.cw1h, cache_read_input_tokens: u.read, output_tokens: out };
      if (cc) us.cache_creation = cc;
      us.service_tier = 'standard';
      us.inference_geo = o.geo || 'not_available';
      if (complete && last) {
        us.server_tool_use = { web_search_requests: o.webSearch || 0, web_fetch_requests: 0 };
        us.output_tokens_details = { thinking_tokens: Math.floor(finalOut * 0.4) };
        us.iterations = o.iterations || [{ type: 'message', model: o.model, input_tokens: u.input, output_tokens: finalOut, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.cw5m + u.cw1h, cache_creation: cc || null }];
        us.speed = o.speed || 'standard';
      }
      return us;
    };
    let kept = null;
    for (let i = 0; i < blocks.length; i++) {
      const last = i === blocks.length - 1;
      if (i > 0) this.tick(s, 0, 2);
      const us = usageFor(i, last);
      const rec = {
        ...this.base(s, side, o.agentId ? { agentId: o.agentId } : {}),
        type: 'assistant', timestamp: this.ts(s), uuid: this.uuid(), requestId: rid,
        message: { id: mid, model: o.model, role: 'assistant', type: 'message', stop_reason: complete && last ? (o.tool ? 'tool_use' : 'end_turn') : null, content: [blocks[i]], usage: us },
        effort: 'high',
      };
      if (o.noRequestId || o.dropRequestIdOnLine === i) delete rec.requestId;
      if (o.quota && last) rec.quotaLimits = o.quota;
      if (o.attribution) Object.assign(rec, o.attribution);
      this.put(f, rec);
      kept = us;
    }
    this.truth.responses.push({ key: mid, cls: f.cls, side, model: o.model, usage: kept, complete });
    if (o.tool) this.truth.tools.set(toolId, { name: o.tool.name, input: o.tool.input, status: 'unpaired' });
    s.lastModel = o.model;
    return { mid, toolId };
  }

  /**
   * Tool result line. status: 'ok' | 'error' | 'denied'. Missing is_error on most ok results.
   */
  result(s, f, toolId, status, o = {}) {
    if (!toolId) return;
    this.tick(s, 1, o.slow ? 40 : 12);
    const side = f.cls !== 'main';
    const block = { type: 'tool_result', tool_use_id: toolId, content: o.content || (status === 'ok' ? 'done' : status === 'denied' ? 'Permission denied by rule' : 'Exit code 1') };
    if (status !== 'ok') block.is_error = true;
    else if (this.chance(0.3)) block.is_error = false;
    const rec = { ...this.base(s, side, o.agentId ? { agentId: o.agentId } : {}), type: 'user', timestamp: this.ts(s), uuid: this.uuid(), message: { role: 'user', content: [block] } };
    if (status === 'denied') rec.toolDenialKind = o.denialKind || 'automode-blocked';
    if (o.toolUseResult) rec.toolUseResult = o.toolUseResult;
    this.put(f, rec);
    const t = this.truth.tools.get(toolId);
    if (t) {
      const shell = t.name === 'Bash' || t.name === 'PowerShell';
      t.status = status === 'denied' ? 'denied' : status === 'error' ? (shell ? 'shell_exit' : 'failed') : 'ok';
    }
  }

  /** A '<synthetic>' 429 placeholder line (rule A15). */
  synthetic429(s) {
    this.tick(s, 5, 30);
    const rec = {
      ...this.base(s, false), type: 'assistant', timestamp: this.ts(s), uuid: this.uuid(), isApiErrorMessage: true, apiErrorStatus: 429,
      message: { id: this.nextId('msg'), model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: rate limited (fictional)' }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    };
    this.put(s.main, rec);
    this.truth.synthetic429++;
  }

  /** Records that carry no usage or free text: must be skipped or dropped by the adapter. */
  noise(s) {
    const t = this.ts(s);
    this.put(s.main, { type: 'custom-title', sessionId: s.sid, customTitle: 'fictional title ' + this.pick(PHRASES) });
    this.put(s.main, { type: 'ai-title', sessionId: s.sid, aiTitle: 'fictional ai title' });
    this.put(s.main, { type: 'agent-name', sessionId: s.sid, agentName: 'fictional agent' });
    this.put(s.main, { type: 'last-prompt', sessionId: s.sid, lastPrompt: 'fictional last prompt' });
    this.put(s.main, { type: 'queue-operation', sessionId: s.sid, operation: 'enqueue', timestamp: t, content: 'fictional queued text' });
    this.put(s.main, { type: 'mode', sessionId: s.sid, mode: 'default' });
    this.put(s.main, { type: 'permission-mode', sessionId: s.sid, permissionMode: 'default' });
    this.put(s.main, { type: 'file-history-snapshot', messageId: this.uuid(), snapshot: { trackedFileBackups: {}, timestamp: t }, isSnapshotUpdate: false });
    this.put(s.main, { type: 'system', subtype: 'turn_duration', durationMs: 12000, timestamp: t, uuid: this.uuid(), sessionId: s.sid, isMeta: false, cwd: s.cwd });
    this.put(s.main, { type: 'attachment', sessionId: s.sid, timestamp: t, attachment: { type: 'date', content: 'fictional date note' } });
  }

  /** Two identical cost-state snapshots (rule A17: never summed). */
  costState(s) {
    const rec = {
      type: 'cost-state', sessionId: s.sid, totalCostUSD: 1.2345, totalAPIDuration: 1000, totalAPIDurationWithoutRetries: 1000, totalToolDuration: 10,
      totalLinesAdded: 3, totalLinesRemoved: 1, totalDuration: 2000, startTime: s.t,
      modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, webSearchRequests: 0, costUSD: 1.2345 } },
      hasUnknownModelCost: false,
    };
    this.put(s.main, rec);
    this.put(s.main, { ...rec });
  }

  // ---- ground truth --------------------------------------------------------------------
  /**
   * @param {{ idleMinutes: number }} o
   */
  groundTruth(o) {
    const T = this.truth;
    const tokens = { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 };
    const buckets = { input: 0n, output: 0n, cw5m: 0n, cw1h: 0n, cacheRead: 0n };
    const byClass = { main: 0n, subagent: 0n, workflow_agent: 0n };
    const byModel = {};
    const unpriced = {};
    const perResponse = {};
    let total = 0n; let side = 0n; let pricedTokens = 0; let allTokens = 0;
    let fast = 0; let geoUs = 0; let ttlEstimated = 0; let webSearchRequests = 0; let webSearchNano = 0n;
    for (const r of T.responses) {
      const parts = billedParts(r.model, r.usage);
      let value = 0n; let priced = true;
      for (const p of parts) {
        const n = p.tokens.input + p.tokens.output + p.tokens.cw5m + p.tokens.cw1h + p.tokens.cacheRead;
        allTokens += n;
        for (const k of Object.keys(tokens)) tokens[k] += p.tokens[k];
        const v = priceNano(p.model, p.tokens, { speed: r.usage.speed, geo: r.usage.inference_geo });
        if (!v) {
          priced = false;
          const m = normModel(p.model);
          unpriced[m] = unpriced[m] || { model: m, responses: 0, tokens: 0 };
          unpriced[m].tokens += n;
          continue;
        }
        pricedTokens += n;
        value += BigInt(v.total);
        for (const k of Object.keys(buckets)) buckets[k] += BigInt(v.buckets[k]);
        const m = normModel(p.model);
        byModel[m] = (byModel[m] || 0n) + BigInt(v.total);
      }
      if (!priced) unpriced[normModel(parts.find((p) => !priceNano(p.model, p.tokens))?.model || r.model)].responses++;
      const ws = (r.usage.server_tool_use && r.usage.server_tool_use.web_search_requests) || 0;
      webSearchRequests += ws;
      webSearchNano += BigInt(ws) * 10_000_000n;
      value += BigInt(ws) * 10_000_000n;
      total += value;
      byClass[r.cls] += value;
      if (r.side) side += value;
      perResponse[r.key] = priced ? value.toString() : null;
      const top = normModel(r.model);
      if (r.usage.speed === 'fast' && RATES_MILLI[top] && RATES_MILLI[top].fast) fast++;
      if (r.usage.inference_geo === 'us' && RATES_MILLI[top] && RATES_MILLI[top].geo) geoUs++;
      if (parts.some((p) => p.ttlEstimated)) ttlEstimated++;
    }

    // Tools
    const status = { ok: 0, denied: 0, shell_exit: 0, failed: 0, unpaired: 0 };
    const callsByName = {};
    let okEditNewLines = 0; let okWriteLines = 0;
    const lines = (x) => (typeof x !== 'string' || x === '' ? 0 : x.split('\n').length);
    for (const t of T.tools.values()) {
      status[t.status]++;
      callsByName[t.name] = (callsByName[t.name] || 0) + 1;
      if (t.status === 'ok' && t.name === 'Edit') okEditNewLines += lines(t.input.new_string);
      if (t.status === 'ok' && t.name === 'MultiEdit') okEditNewLines += t.input.edits.reduce((a, e) => a + lines(e.new_string), 0);
      if (t.status === 'ok' && t.name === 'Write') okWriteLines += lines(t.input.content);
    }

    // Time (rules A22 to A24) from ORIGINAL lines only.
    const idle = o.idleMinutes * 60 * 1000;
    const bySession = new Map(); const byFile = new Map();
    for (const a of T.activity) {
      if (!bySession.has(a.sid)) bySession.set(a.sid, []);
      bySession.get(a.sid).push(a.ts);
      if (!byFile.has(a.rel)) byFile.set(a.rel, { cls: a.cls, ts: [] });
      byFile.get(a.rel).ts.push(a.ts);
    }
    const walk = (tl) => {
      tl = [...tl].sort((x, y) => x - y);
      let act = 0; const blocks = []; let start = tl[0];
      for (let i = 1; i < tl.length; i++) {
        const g = tl[i] - tl[i - 1];
        if (g <= idle) act += g; else { blocks.push(tl[i - 1] - start); start = tl[i]; }
      }
      blocks.push(tl[tl.length - 1] - start);
      return { act, blocks };
    };
    let activeMs = 0; let blockMs = [];
    for (const tl of bySession.values()) { const w = walk(tl); activeMs += w.act; blockMs = blockMs.concat(w.blocks); }
    let agentMs = 0; const agentByClass = { main: 0, subagent: 0, workflow_agent: 0 };
    for (const { cls, ts } of byFile.values()) { const w = walk(ts); agentMs += w.act; agentByClass[cls] += w.act; }
    const sec = (ms) => (ms % 1000 === 0 ? ms / 1000 : ms / 1000);

    // Prompts, days, streak, peak hour (UTC).
    const days = new Map(); const hours = new Array(24).fill(0);
    for (const t of T.prompts) {
      const d = new Date(t).toISOString().slice(0, 10);
      days.set(d, (days.get(d) || 0) + 1);
      hours[new Date(t).getUTCHours()]++;
    }
    const activeDays = [...days.keys()].sort();
    let best = 0; let run = 0; let prev = null;
    for (const d of activeDays) {
      const cur = Date.parse(d + 'T00:00:00Z');
      run = prev !== null && cur - prev === 86400000 ? run + 1 : 1;
      best = Math.max(best, run); prev = cur;
    }
    let peak = null;
    if (T.prompts.length) { peak = 0; for (let h = 1; h < 24; h++) if (hours[h] > hours[peak]) peak = h; }

    // Structural counts from the written files (lines, observations, forks, duplicates).
    const files = { main: 0, subagent: 0, workflow_agent: 0, workflow_journal: 0 };
    const linesByClass = { main: 0, subagent: 0, workflow_agent: 0, workflow_journal: 0 };
    let observations = 0; let syntheticLines = 0; let trailingPartial = 0;
    const idFiles = new Map(); let toolUseBlocks = 0; const toolIds = new Set();
    for (const f of this.files.values()) {
      files[f.cls]++;
      linesByClass[f.cls] += f.records.length + (f.tail ? 1 : 0);
      if (f.tail) trailingPartial++;
      for (const r of f.records) {
        if (r.type !== 'assistant' || !r.message) continue;
        if (r.message.model === '<synthetic>') { syntheticLines++; continue; }
        for (const b of r.message.content || []) if (b.type === 'tool_use') { toolUseBlocks++; toolIds.add(b.id); }
        if (!r.message.usage) continue;
        observations++;
        if (!idFiles.has(r.message.id)) idFiles.set(r.message.id, new Set());
        idFiles.get(r.message.id).add(f.rel);
      }
    }
    const forkedKeys = [...idFiles.values()].filter((s) => s.size > 1).length;
    const hitDen = tokens.cacheRead + tokens.cw5m + tokens.cw1h + tokens.input;

    return {
      fixture: 'personas/' + this.name,
      description: 'DESIGN 9.5 persona ' + this.name + '. Ground truth computed from each response\'s true usage before it was split into lines.',
      tz: this.opts.tz,
      idleMinutes: o.idleMinutes,
      scan: { files, linesByClass, parseErrors: 0, trailingPartial, oversizeLines: 0 },
      dedup: { observations, keys: T.responses.length, gatewayConflicts: 0, invariantViolations: 0, forkedKeys, syntheticLines, duplicateToolUseIds: toolUseBlocks - toolIds.size, orphanToolResults: 0 },
      responses: T.responses.length,
      incompleteResponses: T.responses.filter((r) => !r.complete).length,
      sessions: T.sessions.size,
      tokens,
      valueNano: total.toString(),
      responseValueNano: Object.fromEntries(Object.entries(perResponse).sort(([a], [b]) => (a < b ? -1 : 1))),
      bucketsNano: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
      webSearchNano: webSearchNano.toString(),
      byClassNano: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.toString()])),
      byModelNano: Object.fromEntries(Object.entries(byModel).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()])),
      sidechainNano: side.toString(),
      pricedTokens,
      allTokens,
      unpriced: Object.values(unpriced).sort((a, b) => (a.model < b.model ? -1 : 1)),
      modifiers: { fast, geoUs, ttlEstimated, webSearchRequests },
      delegationShare: { numNano: side.toString(), denNano: total.toString() },
      cacheHitRate: { num: tokens.cacheRead, den: hitDen },
      tools: {
        calls: T.tools.size,
        paired: T.tools.size - status.unpaired,
        status,
        callsByName: Object.fromEntries(Object.entries(callsByName).sort(([a], [b]) => (a < b ? -1 : 1))),
        okEditNewLines,
        okWriteLines,
      },
      time: {
        activeSeconds: sec(activeMs),
        workBlockSeconds: blockMs.map(sec).sort((a, b) => a - b),
        agentSeconds: sec(agentMs),
        agentSecondsByClass: Object.fromEntries(Object.entries(agentByClass).map(([k, v]) => [k, sec(v)])),
      },
      prompts: T.prompts.length,
      interrupts: T.interrupts,
      activeDays,
      longestStreakDays: best,
      peakHourLocal: peak,
      rateLimits: { quotaRejectWindows: T.quotaResets.size, synthetic429Lines: T.synthetic429 },
      workflows: T.workflows,
    };
  }

  /** Serialize every file. */
  render() {
    const out = [];
    for (const f of [...this.files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      const eol = f.crlf ? '\r\n' : '\n';
      let text = f.records.map((r) => JSON.stringify(r)).join(eol) + (f.records.length ? eol : '');
      if (f.tail) text += f.tail;
      out.push({ path: f.rel, content: text });
    }
    return out;
  }
}

export { resolveTtl };
