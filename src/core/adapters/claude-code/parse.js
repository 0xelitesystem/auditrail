// Claude Code line parser: one parsed JSONL object in, zero or more NormalizedEvents out
// (DESIGN 4.2 to 4.13, rule A19; INTERFACES 3.3, 3.4).
//
// This is the first privacy boundary. Free text (prompts, assistant text, tool inputs and
// outputs) is looked at here only to compute counts, line counts, command intents, error
// categories and secret fingerprints, and is then dropped. Record types that carry free text
// (custom-title, ai-title, last-prompt, agent-name, queue-operation) produce nothing but a
// skipped event and their payload is never touched. Workflow journal records are read for
// their `type` only.
//
// Never used, on purpose: snake_case session_id (rule A20), toolUseResult for anything
// (rules A16, A32), cost-state totals (rule A17, audit events only).
//
// Isomorphic: no node:* imports and no DOM.

import {
  KNOWN_RECORD_TYPES, TEXT_BEARING_RECORD_TYPES, WORKFLOW_EVENTS, COMMAND_INTENTS,
  normalizeLogPath, fileLabelOf, countLines,
} from '../contract.js';
import { SYNTHETIC_MODEL, SHELL_TOOLS } from '../../constants.js';
import { sha256Hex } from '../../sha256.js';

/** Record types with no usage and no text we need (rule A19). */
export const NO_USAGE_RECORD_TYPES = Object.freeze([
  'mode', 'permission-mode', 'bridge-session', 'file-history-snapshot', 'file-history-delta', 'atis-latch',
  'fork-context-ref', 'system', 'attachment', 'summary',
]);

const TEXT_BEARING = new Set(TEXT_BEARING_RECORD_TYPES);
const NO_USAGE = new Set(NO_USAGE_RECORD_TYPES);
const KNOWN = new Set(KNOWN_RECORD_TYPES);
const WORKFLOW = new Set(WORKFLOW_EVENTS);
const SHELL = new Set(SHELL_TOOLS);
const TOKEN_RE = /^[A-Za-z0-9_.:\-]+$/;
const INTERRUPT_PREFIX = '[Request interrupted by user';
/** Characters of a tool result looked at for its error category. */
const ERROR_TEXT_SCAN = 4000;

/* ------------------------------------------------------------------------------------------
 * Small sanitizers: every value that leaves this file matches EVENT_SCHEMAS.
 * ---------------------------------------------------------------------------------------- */

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Non-negative safe integer, else 0. @param {unknown} v @returns {number} */
function count(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** Non-negative safe integer, else null. @param {unknown} v @returns {number|null} */
function countOrNull(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Non-empty string of at most `max` characters, else null.
 * @param {unknown} v
 * @param {number} max
 * @returns {string|null}
 */
function str(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Short enum-like token, else null. @param {unknown} v @returns {string|null} */
function token(v) {
  return typeof v === 'string' && v.length <= 64 && TOKEN_RE.test(v) ? v : null;
}

/**
 * ISO timestamp to epoch milliseconds (UTC), null when absent or unparseable.
 * @param {unknown} v
 * @returns {number|null}
 */
export function parseTimestamp(v) {
  if (typeof v !== 'string' || v.length < 10 || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Round a float USD figure to integer nanodollars (audit display only), null when unusable.
 * @param {unknown} v
 * @returns {number|null}
 */
function usdToNano(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const n = Math.round(v * 1e9);
  return Number.isSafeInteger(n) ? n : null;
}

/* ------------------------------------------------------------------------------------------
 * Usage (raw values only: adapters never price, never resolve TTL, never pick iterations)
 * ---------------------------------------------------------------------------------------- */

/** @param {unknown} cc @returns {{ m5: number, h1: number }|null} */
function split(cc) {
  if (!isObj(cc)) return null;
  return { m5: count(cc.ephemeral_5m_input_tokens), h1: count(cc.ephemeral_1h_input_tokens) };
}

/**
 * Claude Code usage block to NormalizedUsage.
 * @param {Record<string, any>} u
 * @returns {import('../contract.js').NormalizedUsage}
 */
export function normalizeUsage(u) {
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : null;
  const stu = isObj(u.server_tool_use) ? u.server_tool_use : null;
  /** @type {import('../contract.js').IterationUsage[]|null} */
  let iterations = null;
  if (Array.isArray(u.iterations)) {
    iterations = [];
    for (const it of u.iterations) {
      if (!isObj(it)) continue;
      iterations.push({
        model: typeof it.model === 'string' && it.model ? it.model.slice(0, 128) : null,
        type: token(it.type),
        inputUncached: count(it.input_tokens),
        output: count(it.output_tokens),
        cacheRead: count(it.cache_read_input_tokens),
        cacheWrite: count(it.cache_creation_input_tokens),
        cacheWriteSplit: split(it.cache_creation),
      });
    }
  }
  return {
    inputUncached: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    cacheWriteSplit: split(u.cache_creation),
    reasoning: details ? countOrNull(details.thinking_tokens) : null,
    reasoningIncludedInOutput: true,
    speed: token(u.speed),
    inferenceGeo: token(u.inference_geo),
    serviceTier: token(u.service_tier),
    webSearchRequests: stu ? count(stu.web_search_requests) : 0,
    iterations,
    costSource: 'computed',
  };
}

/* ------------------------------------------------------------------------------------------
 * Tool calls: intents, line counts, error categories (rules A30 to A32)
 * ---------------------------------------------------------------------------------------- */

// A git sub-command may follow global options such as `-C <dir>` or `--no-pager`.
const GIT_PREFIX = String.raw`\bgit\b(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ](?!-)\S+)?)*\s+`;

/** @type {[string, RegExp][]} */
const INTENT_RES = [
  ['git_commit', new RegExp(GIT_PREFIX + 'commit\\b', 'i')],
  ['git_push', new RegExp(GIT_PREFIX + 'push\\b', 'i')],
  ['test', /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bpython[0-9.]*\s+-m\s+(?:pytest|unittest)\b|\b(?:go|cargo|dotnet|mvn|gradle)\s+test\b|\b(?:jest|vitest|mocha)\b|\bInvoke-Pester\b/i],
  ['build', /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\b(?:cargo|go|dotnet)\s+build\b|\bmsbuild\b|\btsc\b|\bmake\b|\bgradle\s+build\b|\bmvn\s+(?:package|install)\b/i],
  ['install', /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b|\bpip[0-9.]*\s+install\b|\b(?:cargo|go|winget|brew|choco|scoop)\s+install\b|\bapt(?:-get)?\s+install\b|\bInstall-Module\b/i],
];

/**
 * Command intents found in a shell command (I14). Only enum members, in COMMAND_INTENTS order.
 * @param {unknown} command
 * @returns {string[]}
 */
export function commandIntentsOf(command) {
  if (typeof command !== 'string' || command === '') return [];
  const c = command.length > 20000 ? command.slice(0, 20000) : command;
  const found = new Set();
  for (const [intent, re] of INTENT_RES) if (re.test(c)) found.add(intent);
  return COMMAND_INTENTS.filter((x) => found.has(x));
}

/**
 * Error category of a tool result (rule A30), from the denial kind and the result text in memory.
 * @param {string|null} denialKind
 * @param {string} text
 * @returns {string} one of ERROR_CATEGORIES
 */
export function errorCategoryOf(denialKind, text) {
  if (denialKind === 'user-rejected') return 'user_rejected';
  if (denialKind) return 'permission_or_hook';
  const t = text.length > ERROR_TEXT_SCAN ? text.slice(0, ERROR_TEXT_SCAN) : text;
  if (/string to replace not found|old_string (?:was )?not found|no match(?:es)? found for old_string/i.test(t)) return 'edit_string_not_found';
  if (/has not been read yet|read (?:it|the file) first|must (?:first )?read .{0,40}before/i.test(t)) return 'file_not_read_first';
  if (/user (?:doesn't|does not) want|rejected by (?:the )?user|user rejected|user denied/i.test(t)) return 'user_rejected';
  if (/permission|not permitted|not allowed|access (?:is )?denied|\bdenied\b|\bhook\b|\bblocked\b/i.test(t)) return 'permission_or_hook';
  if (/timed? ?out|\btimeout\b/i.test(t)) return 'timeout';
  if (/not found|no such file|does not exist|ENOENT|cannot find|could not find|not recognized/i.test(t)) return 'not_found';
  return 'other';
}

/**
 * Text of a tool_result content (a string, or an array of text blocks), capped.
 * @param {unknown} c
 * @param {number} cap
 * @returns {string}
 */
function resultText(c, cap) {
  if (typeof c === 'string') return c.length > cap ? c.slice(0, cap) : c;
  if (!Array.isArray(c)) return '';
  let s = '';
  for (const b of c) {
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') {
      s += (s ? '\n' : '') + b.text;
      if (s.length > cap) return s.slice(0, cap);
    }
  }
  return s;
}

/**
 * Every string value inside a tool input (for the secret scanner), depth-limited.
 * @param {unknown} v
 * @param {string[]} out
 * @param {number} [depth]
 */
function collectStrings(v, out, depth = 0) {
  if (depth > 6) return;
  if (typeof v === 'string') { if (v) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); return; }
  if (isObj(v)) for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
}

/* ------------------------------------------------------------------------------------------
 * The parser
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {import('../contract.js').LineContext} ctx
 * @param {string} reason
 * @param {unknown} type
 * @returns {import('../contract.js').SkippedEvent}
 */
function skipped(ctx, reason, type) {
  const recordType = typeof type === 'string' && KNOWN.has(type) ? type : 'other';
  return { kind: 'skipped', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, reason, recordType };
}

/**
 * Parse one record. Never throws: odd input becomes a skipped event with reason 'malformed'.
 * Does not retain the record.
 * @param {Record<string, unknown>} record
 * @param {import('../contract.js').LineContext} ctx
 * @returns {import('../contract.js').NormalizedEvent[]}
 */
export function parseClaudeLine(record, ctx) {
  try {
    return parseRecord(/** @type {Record<string, any>} */ (record), ctx);
  } catch {
    return [skipped(ctx, 'malformed', isObj(record) ? record.type : null)];
  }
}

/**
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @returns {import('../contract.js').NormalizedEvent[]}
 */
function parseRecord(e, ctx) {
  if (!isObj(e)) return [skipped(ctx, 'malformed', null)];
  const type = e.type;
  if (ctx.file.fileClass === 'workflow_journal') {
    // Journal payloads (result text, labels) are never read beyond the type (rule A19, trap 6).
    if (typeof type === 'string' && WORKFLOW.has(type)) {
      return [{ kind: 'workflow', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts: null, event: /** @type {any} */ (type) }];
    }
    return [skipped(ctx, 'unknown_type', type)];
  }
  if (typeof type === 'string' && TEXT_BEARING.has(type)) return [skipped(ctx, 'text_bearing', type)];
  if (type === 'assistant') return parseAssistant(e, ctx);
  if (type === 'user') return parseUser(e, ctx);
  if (type === 'cost-state') return [costState(e, ctx)];
  noteTimestamp(e, ctx);
  if (typeof type === 'string' && NO_USAGE.has(type)) return [skipped(ctx, 'no_usage_type', type)];
  return [skipped(ctx, 'unknown_type', type)];
}

/**
 * Parse the record's timestamp and remember it as the file's latest one (cost-state records
 * carry none; INTERFACES 13.8).
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @returns {number|null}
 */
function noteTimestamp(e, ctx) {
  const ts = parseTimestamp(e.timestamp);
  if (ts !== null && ctx.fileState) ctx.fileState.lastTs = ts;
  return ts;
}

/**
 * Identity fields shared by user and assistant lines. camelCase sessionId only (rule A20).
 * @param {Record<string, any>} e
 * @returns {{ sessionId: string|null, uuid: string|null, isSidechain: boolean }}
 */
function ident(e) {
  return { sessionId: str(e.sessionId, 256), uuid: str(e.uuid, 256), isSidechain: e.isSidechain === true };
}

/**
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @param {number|null} ts
 * @param {'user'|'assistant'} recordType
 * @param {{ sessionId: string|null, uuid: string|null, isSidechain: boolean }} id
 * @param {import('../contract.js').NormalizedEvent[]} out
 */
function pushActivityAndQuota(e, ctx, ts, recordType, id, out) {
  if (ts !== null) {
    out.push({
      kind: 'activity', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, uuid: id.uuid,
      isSidechain: id.isSidechain, recordType, cwd: str(e.cwd, 4096), agentVersion: token(e.version),
    });
  }
  const q = e.quotaLimits;
  const status = isObj(q) ? token(q.status) : null;
  if (isObj(q) && status) {
    out.push({
      kind: 'quota', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, status,
      rateLimitType: token(q.rateLimitType), resetsAt: typeof q.resetsAt === 'number' && Number.isFinite(q.resetsAt) ? q.resetsAt : null,
    });
  }
}

/**
 * Hand one text to the injected secret scanner (I11). The value never leaves this function:
 * only the scanner's type, fingerprint, severity and source are emitted.
 * @param {import('../contract.js').LineContext} ctx
 * @param {string} text
 * @param {'user_text'|'tool_input'|'tool_result'} where
 * @param {string|null} toolName
 * @param {number|null} ts
 * @param {string|null} sessionId
 * @param {import('../contract.js').NormalizedEvent[]} out
 */
function scan(ctx, text, where, toolName, ts, sessionId, out) {
  if (!ctx.scanSecrets || !text) return;
  const found = ctx.scanSecrets(text, where, toolName);
  if (!Array.isArray(found)) return;
  for (const f of found) {
    out.push({
      kind: 'secret', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId, secretType: f.secretType, fingerprint12: f.fingerprint12,
      severity: f.severity, source: f.source, expired: f.expired === true || f.expired === false ? f.expired : null,
    });
  }
}

/**
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @returns {import('../contract.js').NormalizedEvent[]}
 */
function parseAssistant(e, ctx) {
  const ts = noteTimestamp(e, ctx);
  const id = ident(e);
  /** @type {import('../contract.js').NormalizedEvent[]} */
  const out = [];
  pushActivityAndQuota(e, ctx, ts, 'assistant', id, out);
  const m = isObj(e.message) ? e.message : null;
  if (m && m.model === SYNTHETIC_MODEL) {
    // Client-side placeholder (rule A15): never a response and never tokens; 429s feed I6.
    out.push({ kind: 'synthetic', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, apiErrorStatus: countOrNull(e.apiErrorStatus) });
    return out;
  }
  let visibleChars = 0;
  const content = m && Array.isArray(m.content) ? m.content : [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text') {
      if (typeof b.text === 'string') visibleChars += b.text.length;
    } else if (b.type === 'tool_use') {
      const serialized = b.input === undefined ? undefined : JSON.stringify(b.input);
      if (typeof serialized === 'string') visibleChars += serialized.length;
      const ev = toolUse(b, ctx, ts, id);
      if (ev) {
        out.push(ev);
        if (ctx.scanSecrets) {
          /** @type {string[]} */
          const strings = [];
          collectStrings(b.input, strings);
          for (const s of strings) scan(ctx, s, 'tool_input', ev.name, ts, id.sessionId, out);
          rememberToolName(ctx, ev.toolUseId, ev.name);
        }
      }
    }
  }
  if (m && isObj(m.usage)) {
    const u = m.usage;
    out.push({
      kind: 'response', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, uuid: id.uuid,
      messageId: str(m.id, 256), requestId: str(e.requestId, 256), isSidechain: id.isSidechain,
      rawModel: typeof m.model === 'string' && m.model ? m.model.slice(0, 128) : null,
      // Rule A5: a final line has a non-null stop_reason or a `speed` key in its usage.
      final: (m.stop_reason !== undefined && m.stop_reason !== null) || Object.prototype.hasOwnProperty.call(u, 'speed'),
      usage: normalizeUsage(u),
      cwd: str(e.cwd, 4096),
      attribution: attribution(e),
      effort: token(e.effort),
      visibleChars,
    });
  }
  if (out.length === 0) out.push(skipped(ctx, 'malformed', 'assistant'));
  return out;
}

/**
 * attribution* fields (local report only, rule 4.11). null when none is present.
 * @param {Record<string, any>} e
 * @returns {import('../contract.js').Attribution|null}
 */
function attribution(e) {
  const agent = str(e.attributionAgent, 256);
  const skill = str(e.attributionSkill, 256);
  const mcpServer = str(e.attributionMcpServer, 256);
  const plugin = str(e.attributionPlugin, 256);
  if (agent === null && skill === null && mcpServer === null && plugin === null) return null;
  return { agent, skill, mcpServer, plugin };
}

/**
 * Per-file tool id to name map, kept only while secrets are scanned (source tiers need the tool
 * that produced a result).
 * @param {import('../contract.js').LineContext} ctx
 * @param {string} toolUseId
 * @param {string} name
 */
function rememberToolName(ctx, toolUseId, name) {
  if (!ctx.fileState) return;
  let map = /** @type {Map<string, string>|undefined} */ (ctx.fileState.toolNames);
  if (!map) { map = new Map(); ctx.fileState.toolNames = map; }
  if (map.size < 200000) map.set(toolUseId, name);
}

/**
 * @param {Record<string, any>} b tool_use block
 * @param {import('../contract.js').LineContext} ctx
 * @param {number|null} ts
 * @param {{ sessionId: string|null, isSidechain: boolean }} id
 * @returns {import('../contract.js').ToolUseEvent|null}
 */
function toolUse(b, ctx, ts, id) {
  const toolUseId = str(b.id, 256);
  if (!toolUseId) return null;
  const name = typeof b.name === 'string' ? b.name.slice(0, 256) : '';
  const input = isObj(b.input) ? b.input : {};
  let filePathHash = null;
  let fileLabel = null;
  const fp = typeof input.file_path === 'string' && input.file_path ? input.file_path
    : typeof input.notebook_path === 'string' && input.notebook_path ? input.notebook_path : null;
  if (fp !== null && fp.length <= 4096) {
    const normalized = normalizeLogPath(fp, ctx.pathStyle || 'auto');
    filePathHash = typeof ctx.hashPath === 'function' ? ctx.hashPath(normalized) : sha256Hex(normalized);
    const label = fileLabelOf(fp);
    fileLabel = label ? label.slice(0, 512) : null;
  }
  let editNewLines = null;
  let writeLines = null;
  if (name === 'Edit') editNewLines = countLines(input.new_string);
  else if (name === 'MultiEdit') {
    editNewLines = 0;
    if (Array.isArray(input.edits)) for (const x of input.edits) if (isObj(x)) editNewLines += countLines(x.new_string);
  } else if (name === 'Write') writeLines = countLines(input.content);
  return {
    kind: 'tool_use', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, isSidechain: id.isSidechain,
    toolUseId, name, filePathHash, fileLabel, editNewLines, writeLines,
    commandIntents: SHELL.has(name) ? commandIntentsOf(input.command) : [],
  };
}

/**
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @returns {import('../contract.js').NormalizedEvent[]}
 */
function parseUser(e, ctx) {
  const ts = noteTimestamp(e, ctx);
  const id = ident(e);
  /** @type {import('../contract.js').NormalizedEvent[]} */
  const out = [];
  pushActivityAndQuota(e, ctx, ts, 'user', id, out);
  const m = isObj(e.message) ? e.message : null;
  const content = m ? m.content : undefined;
  const hasDenialKey = Object.prototype.hasOwnProperty.call(e, 'toolDenialKind') && e.toolDenialKind !== null && e.toolDenialKind !== undefined;
  const denialKind = hasDenialKey ? (token(e.toolDenialKind) || 'other') : null;
  let hasResult = false;
  /** @type {string|null} */
  let firstText = null;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') {
        hasResult = true;
        const toolUseId = str(b.tool_use_id, 256);
        if (!toolUseId) continue;
        const isError = b.is_error === true; // missing means false (rule A30)
        const flagged = isError || denialKind !== null;
        const text = flagged ? resultText(b.content, ERROR_TEXT_SCAN) : '';
        out.push({
          kind: 'tool_result', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, toolUseId, isError, denialKind,
          errorCategory: flagged ? errorCategoryOf(denialKind, text) : null,
        });
        if (ctx.scanSecrets) {
          const names = /** @type {Map<string, string>|undefined} */ (ctx.fileState && ctx.fileState.toolNames);
          scan(ctx, resultText(b.content, Infinity), 'tool_result', (names && names.get(toolUseId)) || null, ts, id.sessionId, out);
        }
      } else if (b.type === 'text') {
        const t = typeof b.text === 'string' ? b.text : '';
        if (firstText === null) firstText = t;
        if (ctx.scanSecrets) scan(ctx, t, 'user_text', null, ts, id.sessionId, out);
      }
    }
  } else if (typeof content === 'string') {
    firstText = content;
    if (ctx.scanSecrets) scan(ctx, content, 'user_text', null, ts, id.sessionId, out);
  }
  // Rule A25: a prompt is main-thread human input: not meta, not a compact summary, not a
  // system-sourced prompt; a string, or a text block with no tool_result block.
  if (!e.isSidechain && !e.isMeta && !e.isCompactSummary && e.promptSource !== 'system' && ts !== null && firstText !== null && !hasResult) {
    const kind = firstText.startsWith(INTERRUPT_PREFIX) ? 'interrupt' : 'prompt';
    out.push({ kind, fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts, sessionId: id.sessionId, uuid: id.uuid });
  }
  if (out.length === 0) out.push(skipped(ctx, 'malformed', 'user'));
  return out;
}

/**
 * Cost-state snapshot, AUDIT ONLY (rules A17, A26): never summed, never shown as a total.
 * @param {Record<string, any>} e
 * @param {import('../contract.js').LineContext} ctx
 * @returns {import('../contract.js').CostStateEvent}
 */
function costState(e, ctx) {
  const models = [];
  if (isObj(e.modelUsage)) {
    for (const [model, v] of Object.entries(e.modelUsage)) {
      if (!isObj(v) || !model) continue;
      models.push({
        model: model.slice(0, 128),
        inputUncached: count(v.inputTokens),
        output: count(v.outputTokens),
        cacheRead: count(v.cacheReadInputTokens),
        cacheWrite: count(v.cacheCreationInputTokens),
        webSearchRequests: count(v.webSearchRequests),
        reportedCostNano: usdToNano(v.costUSD),
      });
    }
  }
  const last = ctx.fileState && typeof ctx.fileState.lastTs === 'number' ? ctx.fileState.lastTs : null;
  return {
    kind: 'cost_state', fileIdx: ctx.file.idx, lineNo: ctx.lineNo, ts: last, sessionId: str(e.sessionId, 256),
    startTime: typeof e.startTime === 'number' && Number.isFinite(e.startTime) ? e.startTime : null,
    reportedCostNano: usdToNano(e.totalCostUSD),
    models,
  };
}
