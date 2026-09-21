// Share-safe mode (DESIGN 8.8 banner, rule A29, traps 47, 48). Pure, isomorphic.
//
// Turns a report Summary into the same shape with every local-only label replaced, the way
// --redact does it in the CLI: "Project A", "File B", "Agent C", "Skill A", "MCP server A",
// "MCP tool A", "Other tool A", "Unpriced model A". Labels are assigned in the order the
// Summary already lists them (value or count descending), so they are stable.
//
// Two passes, so a label field added to the Summary later cannot slip through:
// 1. the known label fields (the list core/summary.js checkRedacted() verifies);
// 2. an allowlist sweep over every string under insights.*.data: a string survives only when
//    it is a number, date, month, timestamp, nanodollar amount, a closed enum member, a
//    built-in tool name, a price-table id or display name, or fixed copy the Summary builder
//    writes. Anything else becomes "Redacted".

import { BUILTIN_TOOLS, TOOL_DISPLAY_NAMES, VALUE_LABEL, CUSTOM_VALUE_LABEL, REDACTED_PRICE_FILE, CUSTOM_VALUE_LABEL_NO_FILE } from '../core/constants.js';

/**
 * Spreadsheet letters: 0 -> A, 25 -> Z, 26 -> AA.
 * @param {number} i
 * @returns {string}
 */
export function letters(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Every label this module writes matches this (the same set core/insights/_util.js uses). */
export const SHARE_SAFE_LABEL_RE = /^(Project|File|Agent|Skill|MCP server|MCP tool|Other tool|Unpriced model) [A-Z]{1,4}$/;

/** Replacement for a string the sweep does not recognize. */
export const REDACTED_TEXT = 'Redacted';

/**
 * Every noun shareSafeSummary() hands to labeler(), in the order the labelers are created. The
 * banners in src/web/app.js and the --redact help line in src/node/args.js must name all of
 * them, so a reader is never told less was replaced than actually was; test/web/app.test.js
 * checks the three banners against this list.
 */
export const SHARE_SAFE_CATEGORIES = Object.freeze([
  'Project', 'File', 'Agent', 'Skill', 'MCP server', 'MCP tool', 'Other tool', 'Unpriced model',
]);

/**
 * @param {string} noun
 * @returns {(key: string) => string}
 */
function labeler(noun) {
  if (!SHARE_SAFE_CATEGORIES.includes(noun)) throw new Error('share-safe: ' + noun + ' is not in SHARE_SAFE_CATEGORIES');
  /** @type {Map<string, string>} */
  const m = new Map();
  return (key) => {
    if (SHARE_SAFE_LABEL_RE.test(key)) return key;
    let v = m.get(key);
    if (!v) { v = noun + ' ' + letters(m.size); m.set(key, v); }
    return v;
  };
}

const ENUM_WORDS = new Set([
  // file classes, statuses, severities, sources, intents, error categories, effort, rate limits
  'main', 'subagent', 'workflow_agent', 'workflow_journal', 'ok', 'denied', 'shell_exit', 'failed', 'unpaired',
  'builtin', 'mcp', 'other', 'critical', 'likely_fixture', 'third_party_public', 'user_text', 'tool_input',
  'tool_result_local', 'tool_result_web', 'git_commit', 'git_push', 'test', 'build', 'install', 'timeout',
  'not_found', 'permission_or_hook', 'edit_string_not_found', 'file_not_read_first', 'user_rejected',
  'low', 'medium', 'high', 'max', 'xhigh', 'unknown', 'none', 'five_hour', 'seven_day', 'seven_day_opus',
  'seven_day_sonnet', 'overage', 'standard', 'fast', 'launched', 'started', 'result', 'responses', 'calls',
  'files', 'edits', 'lines', 'prompts', 'windows', 'episodes', 'days', 'secrets', 'runs', 'tokens', 'findings',
  'copies', 'sessions', 'models', 'hours', 'blocks', 'events', 'unattributed', 'project', 'file',
  'anthropic', 'openai', 'aws', 'github', 'gitlab', 'slack', 'stripe', 'google', 'pem', 'jwt', 'sendgrid',
  'huggingface', 'npm', 'database_url',
]);

const SAFE_PATTERNS = [
  /^-?\d+(\.\d+)?$/,                                   // numbers and nanodollar strings
  /^\d{4}-\d{2}(-\d{2})?$/,                            // local dates and months
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, // ISO timestamps
  /^[0-9a-f]{12}$/,                                    // secret fingerprints (12 hex, never values)
  /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/,                // snake or kebab enum ids (secret types, ...)
];

/**
 * @typedef {{ fixed: Set<string>, replaced: Set<string> }} SweepContext
 *   fixed: strings that are safe for this Summary (table ids and names, fixed copy);
 *   replaced: every original label pass 1 replaced (never allowed back in)
 */

/**
 * @param {string} s
 * @param {SweepContext} ctx
 * @returns {boolean}
 */
export function isSafeString(s, ctx) {
  if (ctx.fixed.has(s) || ENUM_WORDS.has(s) || SHARE_SAFE_LABEL_RE.test(s) || s === REDACTED_TEXT) return true;
  if (ctx.replaced.has(s)) return false;
  // Short lowercase ids are enum-shaped (secret types, effort levels, rate-limit types).
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(s) && s.length <= 32) return true;
  return SAFE_PATTERNS.some((re) => re.test(s));
}

/**
 * The share-safe copy of a Summary. The input is not modified.
 * @param {any} summary
 * @returns {any}
 */
export function shareSafeSummary(summary) {
  const s = JSON.parse(JSON.stringify(summary));
  const ins = s.insights || {};
  const d = (/** @type {string} */ id) => (ins[id] && ins[id].data && typeof ins[id].data === 'object' ? ins[id].data : {});
  const tableModels = (s.pricing && Array.isArray(s.pricing.tableModels) ? s.pricing.tableModels : []);
  const tableIds = new Set(tableModels.map((m) => m && m.id));
  const tableNames = new Set(tableModels.map((m) => m && m.displayName));
  /** @type {Set<string>} */
  const replaced = new Set();
  const swap = (/** @type {(k: string) => string} */ lab, /** @type {unknown} */ v) => {
    if (typeof v !== 'string') return v;
    const out = lab(v);
    if (out !== v) replaced.add(v);
    return out;
  };

  const project = labeler('Project');
  const file = labeler('File');
  const agent = labeler('Agent');
  const skill = labeler('Skill');
  const mcpServer = labeler('MCP server');
  const mcpTool = labeler('MCP tool');
  const otherTool = labeler('Other tool');
  const unpriced = labeler('Unpriced model');
  const toolLabel = (/** @type {string} */ name) => {
    if (BUILTIN_TOOLS.includes(name)) return name;
    return name.startsWith('mcp__') ? mcpTool(name) : otherTool(name);
  };
  const modelLabel = (/** @type {string} */ id) => (tableIds.has(id) ? id : unpriced(id));

  for (const p of d('i01').byProject || []) p.label = swap(project, p.label);
  for (const u of d('i01').unpriced || []) u.model = swap(modelLabel, u.model);
  for (const m of d('i01').byModel || []) { m.model = swap(modelLabel, m.model); if (!tableNames.has(m.displayName)) m.displayName = null; }
  const attr = d('i04').byAttribution || {};
  for (const a of attr.agent || []) a.name = swap(agent, a.name);
  for (const a of attr.skill || []) a.name = swap(skill, a.name);
  for (const a of attr.mcpServer || []) a.name = swap(mcpServer, a.name);
  for (const t of d('i07').byTool || []) {
    if (typeof t.name === 'string') t.name = swap(toolLabel, t.name);
    if (typeof t.displayName === 'string' && !TOOL_DISPLAY_NAMES.includes(t.displayName)) t.displayName = swap(toolLabel, t.displayName);
  }
  if (Array.isArray(d('i07').flagged)) d('i07').flagged = d('i07').flagged.map((n) => (typeof n === 'string' ? swap(toolLabel, n) : n));
  for (const f of d('i08').top || []) f.label = swap(file, f.label);
  for (const f of d('i11').findings || []) if (Array.isArray(f.projectLabels)) f.projectLabels = f.projectLabels.map((p) => swap(project, p));
  for (const m of d('i13').byModel || []) { m.model = swap(modelLabel, m.model); if (!tableNames.has(m.displayName)) m.displayName = null; }
  if (d('i13').topModel && !tableIds.has(d('i13').topModel.model)) d('i13').topModel = { model: swap(modelLabel, d('i13').topModel.model), displayName: null };
  if (Array.isArray(d('i14').models)) d('i14').models = d('i14').models.map((m) => (typeof m === 'string' && !tableNames.has(m) ? swap(unpriced, m) : m));

  if (s.pricing) {
    if (s.pricing.custom) s.pricing.custom = { fileName: REDACTED_PRICE_FILE, multiplier: s.pricing.custom.multiplier ?? null };
    if (typeof s.pricing.label === 'string' && s.pricing.label !== VALUE_LABEL) s.pricing.label = CUSTOM_VALUE_LABEL_NO_FILE;
  }

  // Pass 2: allowlist sweep of every string under insights.*.data.
  /** @type {SweepContext} */
  const ctx = {
    fixed: new Set([...tableIds, ...tableNames, ...TOOL_DISPLAY_NAMES, VALUE_LABEL, CUSTOM_VALUE_LABEL, CUSTOM_VALUE_LABEL_NO_FILE, REDACTED_PRICE_FILE]),
    replaced,
  };
  for (const id of Object.keys(ins)) {
    const r = ins[id];
    if (!r || typeof r !== 'object' || !r.data) continue;
    // Fixed copy written by the insight modules themselves (verbatim caveats and labels).
    for (const k of ['label', 'caveat', 'pricesAsOf']) if (typeof r.data[k] === 'string' && !replaced.has(r.data[k])) ctx.fixed.add(r.data[k]);
  }
  for (const id of Object.keys(ins)) {
    const r = ins[id];
    if (!r || typeof r !== 'object' || !r.data) continue;
    r.data = sweep(r.data, ctx);
  }
  s.redacted = true;
  return s;
}

/**
 * @param {unknown} v
 * @param {SweepContext} ctx
 * @returns {unknown}
 */
function sweep(v, ctx) {
  if (typeof v === 'string') return isSafeString(v, ctx) ? v : REDACTED_TEXT;
  if (Array.isArray(v)) return v.map((x) => sweep(x, ctx));
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      const keep = isSafeString(k, ctx) || (/^[A-Za-z][A-Za-z0-9_]*$/.test(k) && !ctx.replaced.has(k));
      out[keep ? k : REDACTED_TEXT + ' ' + letters(n++)] = sweep(x, ctx);
    }
    return out;
  }
  return v;
}
