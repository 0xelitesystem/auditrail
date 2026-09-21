// Cross-cutting constants shared by every team. Changing any value here is a contract change:
// update INTERFACES.md and the tests that pin it.
//
// Isomorphic: no node:* imports and no DOM.

/** Fixed value label (DESIGN 5.1, trap 34). Never "spent", "paid", "cost you" or "bill". */
export const VALUE_LABEL = 'API-equivalent value at list price';

/** Label used instead of VALUE_LABEL when a user price override file is active (DESIGN 5.2). */
export const CUSTOM_VALUE_LABEL = 'value at custom rates';

/**
 * Stand-in for the basename of a custom price file once names are redacted. The basename is a
 * name from the user's disk, so --redact (core/summary.js) and Share-safe mode
 * (web/share-safe.js) must both replace it, and must replace it with the same text.
 */
export const REDACTED_PRICE_FILE = 'custom rates';

/** The pricing label that goes with REDACTED_PRICE_FILE: no file name in the parenthesis. */
export const CUSTOM_VALUE_LABEL_NO_FILE = 'value at your custom rates';

/**
 * The pricing label when a custom price file is named.
 * @param {string} fileName
 * @returns {string}
 */
export function customValueLabel(fileName) {
  return fileName === REDACTED_PRICE_FILE ? CUSTOM_VALUE_LABEL_NO_FILE : CUSTOM_VALUE_LABEL_NO_FILE + ' (' + fileName + ')';
}

/** Short disclaimer that travels with every dollar figure on the card. */
export const NOT_PAID_NOTE = 'Not what I paid.';

/** Repository shown in the card footer and report footer (plain text, never fetched). */
export const REPO_DISPLAY = 'github.com/0xelitesystem/auditrail';

/** Default idle cutoff for active time, in minutes (rule A22). */
export const DEFAULT_IDLE_MINUTES = 15;

/** Default days of transcript retention in Claude Code when cleanupPeriodDays is unset (I12). */
export const CLAUDE_CODE_DEFAULT_RETENTION_DAYS = 30;

/** Price table staleness warning threshold, in days (DESIGN 5.1). */
export const PRICE_TABLE_STALE_DAYS = 180;

/**
 * Built-in tool allowlist (DESIGN 7.3). Only these names may appear by name on the card.
 * Order is the display order for ties.
 */
export const BUILTIN_TOOLS = Object.freeze([
  'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Workflow', 'TodoWrite', 'ToolSearch', 'StructuredOutput',
]);

const BUILTIN_SET = new Set(BUILTIN_TOOLS);

/** Display name for every tool whose name starts with mcp__ (rule A31). */
export const MCP_TOOLS_LABEL = 'MCP tools';

/** Display name for every tool that is neither built in nor MCP (rule A31). */
export const OTHER_TOOLS_LABEL = 'other tools';

/** Shell tools: an is_error result on these is a "non-zero exit", not a failure (rule A30). */
export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/** Tools whose ok calls count as file edits (I8, rule A32). */
export const EDIT_TOOLS = Object.freeze(['Edit', 'MultiEdit']);

/** Tools whose ok calls count as file writes (I8, I14, rule A32). */
export const WRITE_TOOLS = Object.freeze(['Write']);

/** Tools counted as reading or research for the Researcher archetype (DESIGN 7.4). */
export const RESEARCH_TOOLS = Object.freeze(['WebFetch', 'WebSearch', 'Read', 'Grep', 'Glob']);

/**
 * Tool name class (rule A31).
 * @param {string} name raw tool name from tool_use.name
 * @returns {'builtin'|'mcp'|'other'}
 */
export function toolNameClass(name) {
  if (typeof name !== 'string') return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return BUILTIN_SET.has(name) ? 'builtin' : 'other';
}

/**
 * The only name a tool may carry outside the local report (card, PublicSummary, terminal).
 * @param {string} name raw tool name
 * @returns {string} a BUILTIN_TOOLS entry, MCP_TOOLS_LABEL or OTHER_TOOLS_LABEL
 */
export function toolDisplayName(name) {
  const cls = toolNameClass(name);
  if (cls === 'builtin') return name;
  return cls === 'mcp' ? MCP_TOOLS_LABEL : OTHER_TOOLS_LABEL;
}

/** Every value toolDisplayName can return, in display order. */
export const TOOL_DISPLAY_NAMES = Object.freeze([...BUILTIN_TOOLS, MCP_TOOLS_LABEL, OTHER_TOOLS_LABEL]);

/** Model id that marks client-side placeholder lines (rule A15). */
export const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Normalize a model id before price lookup (rule A9): strip one trailing [...] suffix
 * (for example [1m]), then one trailing -YYYYMMDD. Exact match only afterwards; never prefix
 * or substring matching.
 * @param {string|null|undefined} raw
 * @returns {string} normalized id ('' for missing)
 */
export function normalizeModelId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** Local zone used when none can be resolved. */
export const FALLBACK_TIME_ZONE = 'UTC';
