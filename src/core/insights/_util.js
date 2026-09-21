// Shared helpers for the insight modules (DESIGN 6). Pure functions, no state beyond small
// per-zone formatter caches.
//
// Every helper here works on the AccountingResult contract (accounting/contract.js) and never
// sees free text. Labels that can identify a user's machine (project labels, hot-file labels,
// attribution names, non-builtin tool names, unpriced model ids) go through the labelers below,
// which replace them with "Project A", "File B", ... when the report is redacted.
//
// Isomorphic: no node:* imports and no DOM.

import { rateToMilli, geoUsMilli, ratio } from '../money.js';

/* ------------------------------------------------------------------------------------------
 * Local time (rule A21)
 * ---------------------------------------------------------------------------------------- */

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();

/**
 * @param {string} tz
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(tz) {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/**
 * Local calendar date and hour of an epoch-ms timestamp in an IANA zone.
 * @param {number} ms
 * @param {string} tz
 * @returns {{ date: string, hour: number }}
 */
export function localParts(ms, tz) {
  const parts = formatterFor(tz || 'UTC').formatToParts(new Date(ms));
  let y = '', m = '', d = '', h = '0';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
    else if (p.type === 'hour') h = p.value;
  }
  const hour = Number(h) % 24;
  return { date: y + '-' + m + '-' + d, hour };
}

/**
 * @param {number|null|undefined} ms
 * @param {string} tz
 * @returns {string|null} 'YYYY-MM-DD' or null
 */
export function localDate(ms, tz) {
  return typeof ms === 'number' && Number.isFinite(ms) ? localParts(ms, tz).date : null;
}

/**
 * Weekday of a calendar date, 0 = Monday ... 6 = Sunday (the TimeResult heatmap convention).
 * The date is already local, so this is plain calendar arithmetic.
 * @param {string} date 'YYYY-MM-DD'
 * @returns {number}
 */
export function weekdayMon0(date) {
  const [y, m, d] = date.split('-').map(Number);
  const sun0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (sun0 + 6) % 7;
}

/**
 * Whole calendar days from `a` to `b` ('YYYY-MM-DD'), b minus a.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000);
}

/* ------------------------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------------------------- */

/**
 * Share of two exact amounts (BigInt, digit string or safe integer) as a display number in
 * [0, 1] for non-negative inputs. 0 when the denominator is 0.
 * @param {bigint|number|string} num
 * @param {bigint|number|string} den
 * @returns {number}
 */
export function share(num, den) {
  const a = typeof num === 'bigint' ? num : typeof num === 'string' ? BigInt(num) : BigInt(num);
  const b = typeof den === 'bigint' ? den : typeof den === 'string' ? BigInt(den) : BigInt(den);
  if (b <= 0n || a <= 0n) return 0;
  const r = ratio(a, b);
  return r > 1 ? 1 : r;
}

/**
 * @param {number} x
 * @param {number} digits
 * @returns {number}
 */
export function roundTo(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Median of a list of numbers (mean of the two middle values for an even count). null when empty.
 * @param {number[]} xs
 * @returns {number|null}
 */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Nearest-rank percentile (p in (0, 100]) of a list. null when empty.
 * @param {number[]} xs
 * @param {number} p
 * @returns {number|null}
 */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

/**
 * Sum of a list of nanodollar amounts as BigInt.
 * @param {Iterable<number|bigint>} xs
 * @returns {bigint}
 */
export function sumBig(xs) {
  let t = 0n;
  for (const x of xs) t += typeof x === 'bigint' ? x : BigInt(x);
  return t;
}

/**
 * @param {unknown} v
 * @returns {bigint}
 */
export function big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/* ------------------------------------------------------------------------------------------
 * Prices (rates in milli-dollars per MTok, exact)
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {{ input: number, output: number, cw5m: number, cw1h: number, cacheRead: number }} RatesMilli
 */

/**
 * Integer milli rates for one model under the response's modifiers (rules A10, A11), or null
 * when the model is not in the table.
 * @param {import('../accounting/contract.js').PriceTable} prices
 * @param {string} model normalized id
 * @param {{ fast?: boolean, geoUs?: boolean }} [mods]
 * @returns {RatesMilli|null}
 */
export function ratesFor(prices, model, mods = {}) {
  const rows = prices && Array.isArray(prices.models) ? prices.models : [];
  const row = rows.find((r) => r && r.id === model);
  if (!row) return null;
  const set = mods.fast && row.fast ? row.fast : row;
  const geo = Boolean(mods.geoUs && row.geoUsMultiplier);
  const conv = (/** @type {number} */ rate) => {
    const m = rateToMilli(rate);
    return geo ? geoUsMilli(m) : m;
  };
  return {
    input: conv(set.input), output: conv(set.output), cw5m: conv(set.cacheWrite5m),
    cw1h: conv(set.cacheWrite1h), cacheRead: conv(set.cacheRead),
  };
}

/**
 * Display name of a price-table model id, or null when the id is not in the table.
 * @param {import('../accounting/contract.js').PriceTable} prices
 * @param {string} model
 * @returns {string|null}
 */
export function displayNameFor(prices, model) {
  const rows = prices && Array.isArray(prices.models) ? prices.models : [];
  const row = rows.find((r) => r && r.id === model);
  return row && typeof row.displayName === 'string' ? row.displayName : null;
}

/* ------------------------------------------------------------------------------------------
 * Redaction labels
 * ---------------------------------------------------------------------------------------- */

/**
 * Spreadsheet-style letters: 0 -> A, 25 -> Z, 26 -> AA.
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

/** Every redacted label matches this: a fixed noun and letters. */
export const REDACTED_LABEL_RE = /^(Project|File|Agent|Skill|MCP server|MCP tool|Other tool|Unpriced model) [A-Z]{1,4}$/;

/**
 * A stable labeler: the first distinct key seen gets letter A. Callers feed keys in a
 * deterministic order (value desc, then key) so the letters never depend on walk order.
 * @param {string} noun
 * @returns {(key: string) => string}
 */
export function makeLabeler(noun) {
  /** @type {Map<string, string>} */
  const m = new Map();
  return (key) => {
    let v = m.get(key);
    if (!v) { v = noun + ' ' + letters(m.size); m.set(key, v); }
    return v;
  };
}

/**
 * Project labels (rule A29): basename-derived labels from ProjectAggregate.label, or
 * "Project A", "Project B", ... in byProject order (value desc, then key) when redacted.
 * @param {import('../accounting/contract.js').AccountingResult} acc
 * @param {boolean} redact
 * @returns {(projectKey: string|null) => string}
 */
export function projectLabeler(acc, redact) {
  const list = Array.isArray(acc.byProject) ? acc.byProject : [];
  /** @type {Map<string, string>} */
  const known = new Map();
  const next = makeLabeler('Project');
  for (const p of list) {
    if (!p || typeof p.projectKey !== 'string') continue;
    known.set(p.projectKey, redact ? next(p.projectKey) : safeLabel(p.label, 'project'));
  }
  return (key) => {
    if (key === null || key === undefined) return redact ? next('|none') : 'unattributed';
    const hit = known.get(key);
    if (hit) return hit;
    const v = redact ? next(key) : safeLabel(basename(key), 'project');
    known.set(key, v);
    return v;
  };
}

/**
 * Basename of a normalized path ('/' separators).
 * @param {string} p
 * @returns {string}
 */
export function basename(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * A local-only label: never a full path. Keeps at most the last two '/' segments and caps the
 * length, so a label can never carry a whole directory tree into the Summary.
 * @param {unknown} v
 * @param {string} fallback
 * @returns {string}
 */
export function safeLabel(v, fallback) {
  if (typeof v !== 'string' || !v) return fallback;
  const segs = v.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = segs.slice(-2).join('/');
  const out = tail.length > 80 ? tail.slice(tail.length - 80) : tail;
  return out || fallback;
}

/**
 * A copy of the tool call records in contract order (ts, then id; a missing ts sorts first),
 * so results never depend on the order the array arrived in.
 * @param {import('../accounting/contract.js').ToolCallRecord[]} tools
 * @returns {import('../accounting/contract.js').ToolCallRecord[]}
 */
export function sortTools(tools) {
  return [...(Array.isArray(tools) ? tools : [])].sort((a, b) => {
    const ta = a.ts ?? -Infinity;
    const tb = b.ts ?? -Infinity;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
