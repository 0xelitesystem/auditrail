// Adapter contract and the NORMALIZED EVENT shape (DESIGN 4.2, 4.3, Appendix C).
//
// An adapter turns one agent's on-disk log format into normalized events. Everything after
// the adapter (accounting, insights, summary, card) sees only these events, never raw lines.
// That makes the adapter the first privacy boundary: free text (prompts, assistant text,
// tool inputs and outputs, titles) is read inside parseLine only long enough to compute
// counts, line counts, intents, error categories and secret fingerprints, then dropped.
// No event field may hold free text. assertEvent() enforces key sets, types and string
// length caps so a text payload cannot ride along by accident.
//
// Isomorphic: no node:* imports and no DOM.

/* ------------------------------------------------------------------------------------------
 * File classes (DESIGN 4.1)
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {'main'|'subagent'|'workflow_agent'|'workflow_journal'} FileClass
 */

/*
 * Claude Code path shapes under <root> = <config>/projects (verified against real installs):
 *   main              <proj>/<sessionUuid>.jsonl
 *   subagent          <proj>/<sessionUuid>/subagents/agent-<id>.jsonl
 *   workflow_agent    <proj>/<sessionUuid>/subagents/workflows/<run>/agent-<id>.jsonl
 *   workflow_journal  <proj>/<sessionUuid>/subagents/workflows/<run>/journal.jsonl
 *                     (accept <run>/<run>.jsonl as well; the on-disk name is journal.jsonl)
 * Variants with the same class as their base shape: <name>.jsonl.superseded-<n> and
 * .orphaned-<name>.jsonl. Global dedup absorbs the overlap. *.jsonl.zst is counted and skipped
 * (FileDecision reason 'compressed'). Anything else is 'unknown-extension' or 'unknown-shape'.
 */

/** File classes in tie-break order: a smaller depth wins rule A3 ties. */
export const FILE_CLASSES = Object.freeze(['main', 'subagent', 'workflow_agent', 'workflow_journal']);

/** Tie-break depth per class (rule A3: main over subagent over workflow agent). */
export const FILE_CLASS_DEPTH = Object.freeze({ main: 0, subagent: 1, workflow_agent: 2, workflow_journal: 3 });

/** Classes whose responses count as delegation (isSidechain responses live here). */
export const SIDECHAIN_CLASSES = Object.freeze(['subagent', 'workflow_agent']);

/**
 * What discovery should do with one file found under a root.
 *
 * @typedef {{ action: 'read', fileClass: FileClass, depth: number }
 *         | { action: 'skip', reason: 'compressed'|'unknown-extension'|'unknown-shape' }} FileDecision
 */

/**
 * One file to scan. relPath is kept IN MEMORY ONLY (it encodes the user's project folder
 * names); it is used for the deterministic tie order and never reaches the Summary.
 *
 * @typedef {Object} FileRef
 * @property {number} idx        Index into the scan's file table. Assigned after sorting, but
 *                               nothing may depend on idx order for results (property test 9.4).
 * @property {number} rootIdx    Index of the discovery root, in discovery order.
 * @property {string} relPath    Path relative to its root, '/' separators, original case.
 * @property {FileClass} fileClass
 * @property {number} depth      FILE_CLASS_DEPTH[fileClass]
 * @property {number} size       Bytes as stat'ed before reading (rule A28: read up to this size only).
 */

/* ------------------------------------------------------------------------------------------
 * Normalized usage (Appendix C, specialised for V1 Claude Code)
 * ---------------------------------------------------------------------------------------- */

/**
 * Raw cache-write TTL split as the agent recorded it. Accounting resolves it with rule A7
 * (integer rescale when m5 + h1 != cacheWrite; all 5m and ttlEstimated when the split is null).
 *
 * @typedef {Object} CacheWriteSplit
 * @property {number} m5 ephemeral_5m_input_tokens
 * @property {number} h1 ephemeral_1h_input_tokens
 */

/**
 * One billed attempt from usage.iterations (rule A8). Accounting decides which entries are
 * billed (skip an entry iff output is 0 and it is not the last entry).
 *
 * @typedef {Object} IterationUsage
 * @property {string|null} model       entry.model as written (null means: use the top-level model)
 * @property {string|null} type        entry.type as written ('message', 'fallback_message', ...)
 * @property {number} inputUncached    input_tokens
 * @property {number} output           output_tokens
 * @property {number} cacheRead        cache_read_input_tokens
 * @property {number} cacheWrite       cache_creation_input_tokens
 * @property {CacheWriteSplit|null} cacheWriteSplit  the entry's own cache_creation sub-object
 */

/**
 * Usage exactly as one line reported it. Missing numeric fields are 0. Adapters never price.
 *
 * @typedef {Object} NormalizedUsage
 * @property {number} inputUncached         input_tokens (uncached input)
 * @property {number} output                output_tokens (running value on non-final lines)
 * @property {number} cacheRead             cache_read_input_tokens
 * @property {number} cacheWrite            cache_creation_input_tokens (authoritative total)
 * @property {CacheWriteSplit|null} cacheWriteSplit  usage.cache_creation, null when absent
 * @property {number|null} reasoning        output_tokens_details.thinking_tokens (INSIDE output, rule A14)
 * @property {boolean} reasoningIncludedInOutput  always true for Claude Code
 * @property {string|null} speed            usage.speed ('standard', 'fast'), null when absent
 * @property {string|null} inferenceGeo     usage.inference_geo as written
 * @property {string|null} serviceTier      usage.service_tier as written
 * @property {number} webSearchRequests     server_tool_use.web_search_requests (0 when absent)
 * @property {IterationUsage[]|null} iterations  usage.iterations, null when absent
 * @property {'computed'} costSource        V1: value is always computed from the price table
 */

/* ------------------------------------------------------------------------------------------
 * Normalized events
 * ---------------------------------------------------------------------------------------- */

/** Command intents detected by regex on Bash or PowerShell `command` (I14). */
export const COMMAND_INTENTS = Object.freeze(['git_commit', 'git_push', 'test', 'build', 'install']);

/** Error categories detected by regex on tool result text in memory (rule A30). */
export const ERROR_CATEGORIES = Object.freeze([
  'timeout', 'not_found', 'permission_or_hook', 'edit_string_not_found', 'file_not_read_first', 'user_rejected', 'other',
]);

/** Workflow journal event types (I10). Payloads are never read beyond the type. */
export const WORKFLOW_EVENTS = Object.freeze(['launched', 'started', 'result', 'failed']);

/** Secret finding severities (I11). */
export const SECRET_SEVERITIES = Object.freeze(['critical', 'likely_fixture', 'third_party_public']);

/** Where a secret candidate was found (I11 source tiers). */
export const SECRET_SOURCES = Object.freeze(['user_text', 'tool_input', 'tool_result_local', 'tool_result_web']);

/** Why a record produced no usable event (counted for audit). */
export const SKIP_REASONS = Object.freeze([
  'text_bearing',      // custom-title, ai-title, last-prompt, agent-name, queue-operation (rule A19)
  'no_usage_type',     // mode, permission-mode, bridge-session, file-history-*, atis-latch, ... (rule A19)
  'unknown_type',      // a record type this adapter does not know
  'malformed',         // an object missing the fields its type requires
]);

/**
 * Record types dropped at the adapter because they carry free text (rule A19, trap 46).
 * Nothing but a skipped event with reason 'text_bearing' may come out of them.
 */
export const TEXT_BEARING_RECORD_TYPES = Object.freeze(['custom-title', 'ai-title', 'last-prompt', 'agent-name', 'queue-operation']);

/**
 * Base fields on every event.
 * @typedef {Object} EventBase
 * @property {string} kind
 * @property {number} fileIdx   FileRef.idx of the file the line came from
 * @property {number} lineNo    1-based line number in that file
 */

/**
 * One OBSERVATION of an API response: one assistant line with usage whose model is not
 * '<synthetic>'. A response written as N lines yields N response events; accounting dedups
 * them globally (rules A1 to A4).
 *
 * @typedef {EventBase & {
 *   kind: 'response',
 *   ts: number|null,
 *   sessionId: string|null,
 *   uuid: string|null,
 *   messageId: string|null,
 *   requestId: string|null,
 *   isSidechain: boolean,
 *   rawModel: string|null,
 *   final: boolean,
 *   usage: NormalizedUsage,
 *   cwd: string|null,
 *   attribution: Attribution|null,
 *   effort: string|null,
 *   visibleChars: number,
 * }} ResponseEvent
 *
 * ts           epoch milliseconds from the line's ISO timestamp (UTC), null when absent
 * sessionId    camelCase sessionId only, never snake_case session_id (rule A20)
 * final        rule A5: message.stop_reason is non-null OR usage has a `speed` key
 * cwd          the line's cwd, used only for the project key (rule A29); sensitive, local only
 * visibleChars characters of text blocks plus JSON.stringify(tool_use.input) on THIS line,
 *              used only for the report-only incomplete-output band (rule A6)
 */

/**
 * @typedef {Object} Attribution
 * @property {string|null} agent      attributionAgent (local report only)
 * @property {string|null} skill      attributionSkill (local report only)
 * @property {string|null} mcpServer  attributionMcpServer (local report only)
 * @property {string|null} plugin     attributionPlugin (local report only)
 */

/**
 * A tool call (one tool_use content block). Duplicate ids (forked copies) are deduped by
 * accounting with the rule A3 tie order.
 *
 * @typedef {EventBase & {
 *   kind: 'tool_use',
 *   ts: number|null,
 *   sessionId: string|null,
 *   isSidechain: boolean,
 *   toolUseId: string,
 *   name: string,
 *   filePathHash: string|null,
 *   fileLabel: string|null,
 *   editNewLines: number|null,
 *   writeLines: number|null,
 *   commandIntents: string[],
 * }} ToolUseEvent
 *
 * name          raw tool name; display outside the local report goes through toolDisplayName()
 * filePathHash  64-hex SHA-256 of the normalized file_path (normalizeLogPath then sha256Hex), rule A32
 * fileLabel     "<parent folder>/<basename>" of file_path for the local report hot-spot table (I8);
 *               sensitive, local only; never a full path
 * editNewLines  Edit: lines(new_string); MultiEdit: sum over edits; else null. lines(s) = 0 if s is
 *               empty, else count of "\n" plus 1 (rule A32)
 * writeLines    Write: lines(content); else null
 * commandIntents subset of COMMAND_INTENTS for Bash and PowerShell calls, else []
 */

/**
 * A tool result (one tool_result content block on a user line).
 *
 * @typedef {EventBase & {
 *   kind: 'tool_result',
 *   ts: number|null,
 *   sessionId: string|null,
 *   toolUseId: string,
 *   isError: boolean,
 *   denialKind: string|null,
 *   errorCategory: string|null,
 * }} ToolResultEvent
 *
 * isError        is_error, missing means false (rule A30)
 * denialKind     the user line's toolDenialKind, as written (short enum-like token)
 * errorCategory  one of ERROR_CATEGORIES when isError or denialKind is set, else null
 */

/**
 * A human prompt on the main thread (rule A25). Timestamps only, never text.
 * @typedef {EventBase & { kind: 'prompt', ts: number, sessionId: string|null, uuid: string|null }} PromptEvent
 */

/**
 * A user line whose text starts with "[Request interrupted by user" (rule A25).
 * @typedef {EventBase & { kind: 'interrupt', ts: number, sessionId: string|null, uuid: string|null }} InterruptEvent
 */

/**
 * One timestamp for active time (rules A22 to A24): every user and assistant line with a
 * timestamp, synthetic lines included. uuid lets accounting count a forked line once.
 *
 * @typedef {EventBase & {
 *   kind: 'activity',
 *   ts: number,
 *   sessionId: string|null,
 *   uuid: string|null,
 *   isSidechain: boolean,
 *   recordType: 'user'|'assistant',
 *   cwd: string|null,
 *   agentVersion: string|null,
 * }} ActivityEvent
 *
 * cwd           used to find the session's launch folder (first main-thread cwd, rule A29)
 * agentVersion  the line's `version` (for example "2.1.200"), for audit only
 */

/**
 * A '<synthetic>' assistant line (rule A15). Never counted as a response. apiErrorStatus 429
 * feeds the rate-limit insight (I6).
 * @typedef {EventBase & { kind: 'synthetic', ts: number|null, sessionId: string|null, apiErrorStatus: number|null }} SyntheticEvent
 */

/**
 * A quotaLimits block seen on a line (I6). windows = distinct resetsAt with status 'rejected'.
 * @typedef {EventBase & {
 *   kind: 'quota',
 *   ts: number|null,
 *   sessionId: string|null,
 *   status: string,
 *   rateLimitType: string|null,
 *   resetsAt: number|null,
 * }} QuotaEvent
 *
 * resetsAt  quotaLimits.resetsAt as written (epoch seconds)
 */

/**
 * A workflow journal event (I10). Journal payloads (`result`) are never read.
 * @typedef {EventBase & { kind: 'workflow', ts: number|null, event: 'launched'|'started'|'result'|'failed' }} WorkflowEvent
 */

/**
 * A Claude Code cost-state snapshot (rule A17, A26). AUDIT ONLY: never summed, never shown
 * as a total. Grouped by (sessionId, startTime); the last snapshot per group is used.
 *
 * @typedef {EventBase & {
 *   kind: 'cost_state',
 *   ts: number|null,
 *   sessionId: string|null,
 *   startTime: number|null,
 *   reportedCostNano: number|null,
 *   models: CostStateModel[],
 * }} CostStateEvent
 *
 * ts               cost-state lines carry no timestamp: this is the timestamp of the nearest
 *                  preceding timestamped line in the same file, or null
 * startTime        startTime as written (epoch milliseconds)
 * reportedCostNano Math.round(totalCostUSD * 1e9); the agent's own float figure, audit only
 */

/**
 * @typedef {Object} CostStateModel
 * @property {string} model              model id as written in modelUsage
 * @property {number} inputUncached
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} webSearchRequests
 * @property {number|null} reportedCostNano
 */

/**
 * A secret candidate found while the line's text was in memory (I11). The value itself, and
 * any prefix or suffix of it, never leaves parseLine.
 *
 * @typedef {EventBase & {
 *   kind: 'secret',
 *   ts: number|null,
 *   sessionId: string|null,
 *   secretType: string,
 *   fingerprint12: string,
 *   severity: string,
 *   source: string,
 *   expired: boolean|null,
 * }} SecretEvent
 *
 * secretType     short lowercase token chosen by the secrets module (for example 'anthropic', 'aws')
 * fingerprint12  first 12 hex of SHA-256(value)
 * severity       one of SECRET_SEVERITIES
 * source         one of SECRET_SOURCES
 * expired        JWT only: true when a locally decoded exp is in the past; else null
 */

/**
 * A record that produced nothing else, counted for audit.
 * @typedef {EventBase & { kind: 'skipped', reason: string, recordType: string|null }} SkippedEvent
 *
 * recordType  the record's `type` when it is in KNOWN_RECORD_TYPES, else 'other' (never free text)
 */

/**
 * @typedef {ResponseEvent|ToolUseEvent|ToolResultEvent|PromptEvent|InterruptEvent|ActivityEvent
 *   |SyntheticEvent|QuotaEvent|WorkflowEvent|CostStateEvent|SecretEvent|SkippedEvent} NormalizedEvent
 */

/** Claude Code record types an adapter may name in a skipped event. */
export const KNOWN_RECORD_TYPES = Object.freeze([
  'user', 'assistant', 'attachment', 'system', 'summary', 'mode', 'permission-mode', 'bridge-session',
  'file-history-snapshot', 'file-history-delta', 'atis-latch', 'fork-context-ref', 'cost-state',
  'custom-title', 'ai-title', 'last-prompt', 'agent-name', 'queue-operation',
  'launched', 'started', 'result', 'failed', 'other',
]);

/* ------------------------------------------------------------------------------------------
 * The adapter interface
 * ---------------------------------------------------------------------------------------- */

/**
 * Per-line context handed to parseLine.
 *
 * @typedef {Object} LineContext
 * @property {FileRef} file
 * @property {number} lineNo                 1-based line number
 * @property {Record<string, unknown>} fileState  scratch object, one per file, reset per file;
 *                                           adapters may keep per-file state here (for example the
 *                                           last seen timestamp for cost_state.ts)
 * @property {'win32'|'posix'|'auto'} pathStyle   how to normalize paths found in logs (normalizeLogPath)
 * @property {(normalizedPath: string) => string} hashPath  SHA-256 hex of an already normalized path
 * @property {SecretScanner|null} scanSecrets injected by the secrets module; null when secrets are off
 */

/**
 * The secrets module implements this; the adapter calls it on each text it is allowed to scan
 * (user text, tool_use.input string values, tool_result content) and emits one SecretEvent per
 * finding. toolName lets the scanner assign the source tier (WebFetch and WebSearch output is
 * third_party_public).
 *
 * @callback SecretScanner
 * @param {string} text
 * @param {'user_text'|'tool_input'|'tool_result'} where
 * @param {string|null} toolName
 * @returns {{ secretType: string, fingerprint12: string, severity: string, source: string, expired: boolean|null }[]}
 */

/**
 * Discovery environment for roots(). Node fills it; the browser never calls roots().
 *
 * @typedef {Object} RootsEnv
 * @property {string} home                         os.homedir()
 * @property {string} platform                     process.platform
 * @property {Record<string, string|undefined>} env  process.env (read: CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME)
 */

/**
 * @typedef {Object} Adapter
 * @property {string} id              stable id, e.g. 'claude-code'
 * @property {string} displayName     e.g. 'Claude Code'
 * @property {(env: RootsEnv) => string[]} roots
 *   Candidate root directories in priority order (DESIGN 8.5). Pure: returns paths, touches nothing.
 * @property {(relPath: string) => FileDecision} classify
 *   Decide from the path shape alone ('/' separators, relative to a root).
 * @property {(record: Record<string, unknown>, ctx: LineContext) => NormalizedEvent[]} parseLine
 *   One parsed JSONL object in, zero or more events out. Must not throw on odd input: emit a
 *   skipped event with reason 'malformed' instead. Must not retain the record.
 * @property {(ev: ResponseEvent) => string} dedupKey
 *   Primary response key (rule A1). Accounting applies the requestId conflict split (rule A2) itself.
 * @property {(a: ResponseEvent, b: ResponseEvent, files: FileRef[]) => ResponseEvent} merge
 *   Pick the observation to keep for one key (rule A3). Must be a total, order-independent choice.
 */

/**
 * Rule A1 reference key: message.id, else requestId, else uuid, else a per-line key so a line
 * with no identity at all is still counted exactly once.
 * @param {ResponseEvent} ev
 * @returns {string}
 */
export function defaultDedupKey(ev) {
  if (ev.messageId) return ev.messageId;
  if (ev.requestId) return ev.requestId;
  if (ev.uuid) return ev.uuid;
  return 'line:' + ev.fileIdx + ':' + ev.lineNo;
}

/**
 * Rule A3 order for observations of the same key. Returns a negative number when `a` should be
 * KEPT over `b`, positive when `b` wins, 0 only for the same line.
 *   1. larger usage.output
 *   2. shallower file (FILE_CLASS_DEPTH: main, subagent, workflow agent)
 *   3. lexicographically smaller relPath (then smaller rootIdx)
 *   4. later line in that file
 * @param {{ fileIdx: number, lineNo: number, usage?: { output: number } }} a
 * @param {{ fileIdx: number, lineNo: number, usage?: { output: number } }} b
 * @param {FileRef[]} files
 * @returns {number}
 */
export function compareObservations(a, b, files) {
  const ao = a.usage ? a.usage.output : 0;
  const bo = b.usage ? b.usage.output : 0;
  if (ao !== bo) return bo - ao;
  return compareByFileOrder(a, b, files);
}

/**
 * The file part of the rule A3 order, for records without an output count (tool uses, tool
 * results, activity lines, prompts): shallower file, then smaller relPath, then smaller
 * rootIdx, then later line.
 * @param {{ fileIdx: number, lineNo: number }} a
 * @param {{ fileIdx: number, lineNo: number }} b
 * @param {FileRef[]} files
 * @returns {number}
 */
export function compareByFileOrder(a, b, files) {
  const fa = files[a.fileIdx];
  const fb = files[b.fileIdx];
  if (!fa || !fb) throw new RangeError('compareByFileOrder: unknown fileIdx');
  if (fa.depth !== fb.depth) return fa.depth - fb.depth;
  if (fa.relPath !== fb.relPath) return fa.relPath < fb.relPath ? -1 : 1;
  if (fa.rootIdx !== fb.rootIdx) return fa.rootIdx - fb.rootIdx;
  return b.lineNo - a.lineNo;
}

/**
 * Reference merge (rule A3): keep the preferred observation.
 * @param {ResponseEvent} a
 * @param {ResponseEvent} b
 * @param {FileRef[]} files
 * @returns {ResponseEvent}
 */
export function defaultMerge(a, b, files) {
  return compareObservations(a, b, files) <= 0 ? a : b;
}

/* ------------------------------------------------------------------------------------------
 * Paths found inside logs
 * ---------------------------------------------------------------------------------------- */

/**
 * Normalize a path found in a log (cwd, tool_use.input.file_path) for hashing and comparison
 * (rules A29, A32): backslashes to '/', repeated slashes collapsed (a leading '//' UNC prefix
 * is kept), trailing '/' removed except for a root, and lowercased when the style is win32.
 * 'auto' treats a drive letter ("C:") or a leading backslash pair as win32.
 * @param {string} p
 * @param {'win32'|'posix'|'auto'} [style]
 * @returns {string}
 */
export function normalizeLogPath(p, style = 'auto') {
  if (typeof p !== 'string') return '';
  const win = style === 'win32' || (style === 'auto' && (/^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\')));
  let s = p.replace(/\\/g, '/');
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s;
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s) && !(unc && s === '//')) s = s.slice(0, -1);
  return win ? s.toLowerCase() : s;
}

/**
 * True when `child` equals `parent` or lies below it. Both must already be normalized with the
 * same style.
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isPathInside(child, parent) {
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(base);
}

/**
 * "<parent folder>/<basename>" of a path, the most the local report may show for a file (I8).
 * @param {string} p
 * @returns {string}
 */
export function fileLabelOf(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts[parts.length - 2] + '/' + parts[parts.length - 1];
}

/**
 * Line count used for lines written by agent tool calls (rule A32).
 * lines(s) = 0 if s is empty, else count("\n") + 1.
 * @param {unknown} s
 * @returns {number}
 */
export function countLines(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/* ------------------------------------------------------------------------------------------
 * Validation (tests and AR_STRICT_EVENTS runs; not on the hot path)
 * ---------------------------------------------------------------------------------------- */

// Field specs: t = type, n = nullable, max = string length cap, enum = allowed values,
// re = required pattern. Every key not listed is rejected.
const INT = { t: 'int' };
const INT_N = { t: 'int', n: true };
const TS_N = { t: 'num', n: true };
const TS = { t: 'num' };
const BOOL = { t: 'bool' };
const BOOL_N = { t: 'bool', n: true };
const ID_N = { t: 'str', n: true, max: 256 };
const ID = { t: 'str', max: 256 };
const PATH_N = { t: 'str', n: true, max: 4096 };
const TOKEN_N = { t: 'str', n: true, max: 64, re: /^[A-Za-z0-9_.:\-]+$/ };
const MODEL_N = { t: 'str', n: true, max: 128 };

const SPLIT = { t: 'obj', n: true, keys: { m5: INT, h1: INT } };
const ITERATION = {
  t: 'obj',
  keys: {
    model: MODEL_N, type: TOKEN_N, inputUncached: INT, output: INT, cacheRead: INT, cacheWrite: INT, cacheWriteSplit: SPLIT,
  },
};
const USAGE = {
  t: 'obj',
  keys: {
    inputUncached: INT, output: INT, cacheRead: INT, cacheWrite: INT, cacheWriteSplit: SPLIT,
    reasoning: INT_N, reasoningIncludedInOutput: BOOL, speed: TOKEN_N, inferenceGeo: TOKEN_N, serviceTier: TOKEN_N,
    webSearchRequests: INT, iterations: { t: 'arr', n: true, of: ITERATION }, costSource: { t: 'str', enum: ['computed'] },
  },
};
const ATTRIBUTION = { t: 'obj', n: true, keys: { agent: ID_N, skill: ID_N, mcpServer: ID_N, plugin: ID_N } };
const COST_MODEL = {
  t: 'obj',
  keys: {
    model: { t: 'str', max: 128 }, inputUncached: INT, output: INT, cacheRead: INT, cacheWrite: INT, webSearchRequests: INT, reportedCostNano: INT_N,
  },
};

const BASE = { kind: { t: 'str' }, fileIdx: INT, lineNo: INT };

/** Allowed keys and types per event kind. Exported so docs and tests can enumerate them. */
export const EVENT_SCHEMAS = Object.freeze({
  response: {
    ...BASE, ts: TS_N, sessionId: ID_N, uuid: ID_N, messageId: ID_N, requestId: ID_N, isSidechain: BOOL,
    rawModel: MODEL_N, final: BOOL, usage: USAGE, cwd: PATH_N, attribution: ATTRIBUTION, effort: TOKEN_N, visibleChars: INT,
  },
  tool_use: {
    ...BASE, ts: TS_N, sessionId: ID_N, isSidechain: BOOL, toolUseId: ID, name: { t: 'str', max: 256 },
    filePathHash: { t: 'str', n: true, re: /^[0-9a-f]{64}$/ }, fileLabel: { t: 'str', n: true, max: 512 },
    editNewLines: INT_N, writeLines: INT_N, commandIntents: { t: 'arr', of: { t: 'str', enum: COMMAND_INTENTS } },
  },
  tool_result: {
    ...BASE, ts: TS_N, sessionId: ID_N, toolUseId: ID, isError: BOOL, denialKind: TOKEN_N,
    errorCategory: { t: 'str', n: true, enum: ERROR_CATEGORIES },
  },
  prompt: { ...BASE, ts: TS, sessionId: ID_N, uuid: ID_N },
  interrupt: { ...BASE, ts: TS, sessionId: ID_N, uuid: ID_N },
  activity: {
    ...BASE, ts: TS, sessionId: ID_N, uuid: ID_N, isSidechain: BOOL, recordType: { t: 'str', enum: ['user', 'assistant'] },
    cwd: PATH_N, agentVersion: TOKEN_N,
  },
  synthetic: { ...BASE, ts: TS_N, sessionId: ID_N, apiErrorStatus: INT_N },
  quota: { ...BASE, ts: TS_N, sessionId: ID_N, status: { t: 'str', max: 64, re: /^[A-Za-z0-9_.:\-]+$/ }, rateLimitType: TOKEN_N, resetsAt: TS_N },
  workflow: { ...BASE, ts: TS_N, event: { t: 'str', enum: WORKFLOW_EVENTS } },
  cost_state: { ...BASE, ts: TS_N, sessionId: ID_N, startTime: TS_N, reportedCostNano: INT_N, models: { t: 'arr', of: COST_MODEL } },
  secret: {
    ...BASE, ts: TS_N, sessionId: ID_N, secretType: { t: 'str', max: 40, re: /^[a-z0-9_]+$/ },
    fingerprint12: { t: 'str', re: /^[0-9a-f]{12}$/ }, severity: { t: 'str', enum: SECRET_SEVERITIES },
    source: { t: 'str', enum: SECRET_SOURCES }, expired: BOOL_N,
  },
  skipped: { ...BASE, reason: { t: 'str', enum: SKIP_REASONS }, recordType: { t: 'str', n: true, enum: KNOWN_RECORD_TYPES } },
});

/** Every event kind. */
export const EVENT_KINDS = Object.freeze(Object.keys(EVENT_SCHEMAS));

/**
 * Throw a TypeError describing the first problem when `ev` is not a valid NormalizedEvent:
 * unknown kind, missing key, extra key, wrong type, over-long string or a value outside its enum.
 * Adapter tests MUST run every emitted event through this.
 * @param {unknown} ev
 * @returns {asserts ev is NormalizedEvent}
 */
export function assertEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) throw new TypeError('event must be an object');
  const kind = /** @type {Record<string, unknown>} */ (ev).kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, kind)) {
    throw new TypeError('unknown event kind: ' + String(kind));
  }
  checkObject(/** @type {Record<string, unknown>} */ (ev), EVENT_SCHEMAS[/** @type {keyof typeof EVENT_SCHEMAS} */ (kind)], kind);
  const e = /** @type {Record<string, unknown>} */ (ev);
  if (/** @type {number} */ (e.lineNo) < 1) throw new TypeError(kind + '.lineNo must be >= 1');
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Record<string, any>} keys
 * @param {string} where
 */
function checkObject(obj, keys, where) {
  for (const k of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(keys, k)) throw new TypeError(where + ': unexpected key "' + k + '"');
  }
  for (const [k, spec] of Object.entries(keys)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) throw new TypeError(where + ': missing key "' + k + '"');
    checkValue(obj[k], spec, where + '.' + k);
  }
}

/**
 * @param {unknown} v
 * @param {any} spec
 * @param {string} where
 */
function checkValue(v, spec, where) {
  if (v === null) {
    if (spec.n) return;
    throw new TypeError(where + ' must not be null');
  }
  switch (spec.t) {
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TypeError(where + ' must be a non-negative integer');
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(where + ' must be a finite number');
      return;
    case 'bool':
      if (typeof v !== 'boolean') throw new TypeError(where + ' must be a boolean');
      return;
    case 'str':
      if (typeof v !== 'string') throw new TypeError(where + ' must be a string');
      if (spec.max !== undefined && v.length > spec.max) throw new TypeError(where + ' is longer than ' + spec.max + ' characters');
      if (spec.enum && !spec.enum.includes(v)) throw new TypeError(where + ' has a value outside its enum');
      if (spec.re && !spec.re.test(v)) throw new TypeError(where + ' does not match its pattern');
      return;
    case 'arr':
      if (!Array.isArray(v)) throw new TypeError(where + ' must be an array');
      v.forEach((x, i) => checkValue(x, spec.of, where + '[' + i + ']'));
      return;
    case 'obj':
      if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError(where + ' must be an object');
      checkObject(/** @type {Record<string, unknown>} */ (v), spec.keys, where);
      return;
    default:
      throw new TypeError(where + ': bad spec');
  }
}

/**
 * Validate an adapter object's shape (not its behavior).
 * @param {unknown} a
 * @returns {Adapter}
 */
export function defineAdapter(a) {
  if (a === null || typeof a !== 'object') throw new TypeError('adapter must be an object');
  const ad = /** @type {Record<string, unknown>} */ (a);
  for (const k of ['id', 'displayName']) {
    if (typeof ad[k] !== 'string' || !ad[k]) throw new TypeError('adapter.' + k + ' must be a non-empty string');
  }
  for (const k of ['roots', 'classify', 'parseLine', 'dedupKey', 'merge']) {
    if (typeof ad[k] !== 'function') throw new TypeError('adapter.' + k + ' must be a function');
  }
  return /** @type {Adapter} */ (Object.freeze({ ...ad }));
}
