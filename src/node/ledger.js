// The numbers-only ledger (DESIGN 8.9, I12, trap 9): `auditrail remember`, opt-in only.
//
// Claude Code deletes transcripts after 30 days by default. The ledger keeps the NUMBERS so a
// card made months later still covers the whole run:
// - Location: ~/.auditrail/ledger/v1/YYYY-MM.json, written only by `remember` (the sandbox
//   grants write access to that folder for that command only).
// - Unit: (local day, first 16 hex of SHA-256(sessionId)). Per unit: token rows per
//   (model, file class, fast, US geo, hashed project key) with responses, incomplete, input,
//   output, cw5m, cw1h, cacheRead and web search requests; prompts; active seconds; tool calls
//   by allowlisted display name; tool results by status.
// - Tokens, not dollars, so a newer price table re-prices history. The fast and US-geo flags
//   are kept per row because they change the rate.
// - Project keys are stored hashed; labels only with --remember-labels.
// - Model ids are stored verbatim ONLY when they are in the bundled price table, which is the
//   case the field exists for (re-pricing history with a newer table). Anything else, including
//   a gateway or Bedrock inference-profile id, is stored as 'other:<first 16 hex of SHA-256>':
//   an id like arn:aws:bedrock:us-east-1:<account id>:application-inference-profile/<name>
//   carries an AWS account id and a private profile name, and this file is designed to outlive
//   the transcript it was read from. See ledgerModelId().
// - Never stored: text, paths, prompts, titles, tool inputs, raw tool names outside the
//   allowlist, raw model ids outside the price table, secrets, raw session ids.
// - Merge: for each (local day, session hash) the source with more responses wins; on a tie the
//   new scan wins. Partial deletion of transcripts therefore never lowers a day.
//
// Workflow journal counts are not in the ledger: journal events carry neither a timestamp nor a
// session id, so they cannot be placed on a day.

import fs from 'node:fs';
import path from 'node:path';
import { sha256HexPrefix } from '../core/sha256.js';
import { OUTPUT_FILE_MODE, OUTPUT_DIR_MODE } from './report.js';

export const LEDGER_SCHEMA = 1;
export const LEDGER_KIND = 'auditrail.ledger';

/**
 * @param {string} home
 * @returns {string} ~/.auditrail/ledger/v1
 */
export function ledgerDir(home) {
  return path.join(home, '.auditrail', 'ledger', 'v1');
}

/* ------------------------------------------------------------------------------------------
 * Local dates
 * ---------------------------------------------------------------------------------------- */

/** @type {Map<string, Intl.DateTimeFormat>} */
const DAY_FMT = new Map();

/**
 * Local calendar date 'YYYY-MM-DD' of an epoch-ms timestamp in an IANA zone (rule A21).
 * @param {number} ms
 * @param {string} tz
 * @returns {string}
 */
export function localDate(ms, tz) {
  let f = DAY_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    DAY_FMT.set(tz, f);
  }
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of f.formatToParts(ms)) p[part.type] = part.value;
  return p.year + '-' + p.month + '-' + p.day;
}

/* ------------------------------------------------------------------------------------------
 * The tap: the only two things the ledger needs that the AccountingResult does not carry per
 * session and day (prompt timestamps and the per-session activity union).
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {{ since?: number|null, until?: number|null }} [range]
 */
export function createLedgerTap(range = {}) {
  const since = range.since ?? null;
  const until = range.until ?? null;
  const inRange = (ts) => (since === null || ts >= since) && (until === null || ts < until);
  /** @type {Map<string, number[]>} sessionId -> activity timestamps (ms) */
  const activity = new Map();
  /** @type {Map<string, { sessionId: string, ts: number }>} prompt uuid (or line key) -> prompt */
  const prompts = new Map();
  return {
    /** @param {import('../core/adapters/contract.js').NormalizedEvent[]} events */
    onEvents(events) {
      for (const ev of events) {
        if (ev.kind === 'activity') {
          if (!ev.sessionId || typeof ev.ts !== 'number' || !inRange(ev.ts)) continue;
          let a = activity.get(ev.sessionId);
          if (!a) { a = []; activity.set(ev.sessionId, a); }
          a.push(ev.ts);
        } else if (ev.kind === 'prompt') {
          if (!ev.sessionId || typeof ev.ts !== 'number' || !inRange(ev.ts)) continue;
          const key = ev.uuid ?? ev.sessionId + '|' + ev.ts;
          if (!prompts.has(key)) prompts.set(key, { sessionId: ev.sessionId, ts: ev.ts });
        }
      }
    },
    activity,
    prompts,
  };
}

/**
 * Active seconds per (session, local day): the session's union of timestamps, gaps of at most
 * the idle cutoff summed (rule A22), each gap credited to the day of its later timestamp. The
 * sum over days equals the session's rule A22 active time.
 * @param {number[]} tsList epoch ms, any order, duplicates allowed
 * @param {number} idleSeconds
 * @param {string} tz
 * @returns {Map<string, number>} day -> milliseconds
 */
export function activeMsByDay(tsList, idleSeconds, tz) {
  const ts = [...new Set(tsList)].sort((a, b) => a - b);
  const out = new Map();
  const cutoff = idleSeconds * 1000;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap > cutoff) continue;
    const d = localDate(ts[i], tz);
    out.set(d, (out.get(d) ?? 0) + gap);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Building units from a scan
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} LedgerRow
 * @property {string} model        price-table model id, or 'other:<16 hex>' (ledgerModelId)
 * @property {'main'|'subagent'|'workflow_agent'} fileClass
 * @property {boolean} fast
 * @property {boolean} geoUs
 * @property {string|null} project first 16 hex of SHA-256(projectKey), null when unknown
 * @property {number} responses
 * @property {number} incomplete
 * @property {number} input
 * @property {number} output
 * @property {number} cw5m
 * @property {number} cw1h
 * @property {number} cacheRead
 * @property {number} webSearchRequests
 */

/**
 * @typedef {Object} LedgerUnit
 * @property {number} responses     sum of row responses (a two-model fallback counts once per model)
 * @property {number} prompts
 * @property {number} activeSeconds
 * @property {LedgerRow[]} rows      sorted by row key
 * @property {Record<string, number>} toolCalls   display name -> calls
 * @property {Record<string, number>} toolStatus  status -> results
 */

/**
 * @typedef {Object} LedgerMonth
 * @property {1} schema
 * @property {'auditrail.ledger'} kind
 * @property {string} month
 * @property {string} tz
 * @property {number} idleMinutes
 * @property {string} updatedAt
 * @property {string} toolVersion
 * @property {Record<string, Record<string, LedgerUnit>>} days   day -> session hash -> unit
 * @property {Record<string, string>} projectLabels   project hash -> label (only with --remember-labels)
 */

/** @returns {LedgerUnit} */
function emptyUnit() {
  return { responses: 0, prompts: 0, activeSeconds: 0, rows: [], toolCalls: {}, toolStatus: {} };
}

/**
 * @param {LedgerRow} r
 * @returns {string}
 */
function rowKey(r) {
  return [r.model, r.fileClass, r.fast ? 1 : 0, r.geoUs ? 1 : 0, r.project ?? ''].join('|');
}

/**
 * @param {string} s
 * @returns {string}
 */
export function hash16(s) {
  return sha256HexPrefix(s, 16);
}

/** Prefix of a model id that was not in the price table and so was hashed. */
export const LEDGER_MODEL_OTHER = 'other:';

/**
 * The model id as the ledger stores it. A price-table id is kept verbatim so a newer table can
 * re-price the history; anything else is hashed, because a gateway id is free text from the log
 * (a Bedrock inference-profile id carries an AWS account id) and is unpriceable anyway.
 * @param {string} model
 * @param {Set<string>|null|undefined} tableIds  ids of the bundled price table
 * @returns {string}
 */
export function ledgerModelId(model, tableIds) {
  const m = String(model || '');
  if (!m) return '';
  if (tableIds && tableIds.has(m)) return m;
  return LEDGER_MODEL_OTHER + hash16(m);
}

/**
 * Turn one scan into ledger units grouped by month.
 * @param {{
 *   acc: import('../core/accounting/contract.js').AccountingResult,
 *   tap: ReturnType<typeof createLedgerTap>,
 *   tz: string,
 *   idleMinutes: number,
 *   labels?: boolean,
 *   priceTableModelIds?: Set<string>|string[],
 * }} o
 * @returns {{ months: Map<string, { days: Record<string, Record<string, LedgerUnit>>, projectLabels: Record<string, string> }>, undated: number, unattributed: number }}
 */
export function buildLedgerUnits(o) {
  const tableIds = o.priceTableModelIds instanceof Set ? o.priceTableModelIds
    : new Set(Array.isArray(o.priceTableModelIds) ? o.priceTableModelIds : []);
  /** @type {Map<string, Map<string, LedgerRow>>} 'day|session hash' -> row key -> row */
  const rowsByUnit = new Map();
  /** @type {Map<string, Map<string, LedgerUnit>>} */
  const units = new Map();
  let undated = 0;
  let unattributed = 0;
  const sessionHashes = new Map();
  const sh = (id) => {
    let h = sessionHashes.get(id);
    if (!h) { h = hash16(id); sessionHashes.set(id, h); }
    return h;
  };
  const unitOf = (day, sess) => {
    let d = units.get(day);
    if (!d) { d = new Map(); units.set(day, d); }
    let u = d.get(sess);
    if (!u) { u = emptyUnit(); d.set(sess, u); }
    return u;
  };

  /** @type {Record<string, string>} */
  const projectLabels = {};
  const labelByKey = new Map();
  for (const p of o.acc.byProject ?? []) labelByKey.set(p.projectKey, p.label);

  for (const r of o.acc.responses) {
    if (!r.sessionId) { unattributed++; continue; }
    if (typeof r.tsStart !== 'number') { undated++; continue; }
    const day = localDate(r.tsStart, o.tz);
    const sess = sh(r.sessionId);
    const project = r.projectKey ? hash16(r.projectKey) : null;
    if (o.labels && project && labelByKey.has(r.projectKey)) projectLabels[project] = String(labelByKey.get(r.projectKey));
    unitOf(day, sess);
    const unitKey = day + '|' + sess;
    let byKey = rowsByUnit.get(unitKey);
    if (!byKey) { byKey = new Map(); rowsByUnit.set(unitKey, byKey); }
    const rowsOfUnit = byKey;
    const fileClass = /** @type {'main'|'subagent'|'workflow_agent'} */ (r.fileClass === 'workflow_journal' ? 'workflow_agent' : r.fileClass);
    const parts = Array.isArray(r.parts) && r.parts.length ? r.parts : [{ model: r.model, tokens: r.tokens }];
    parts.forEach((part, i) => {
      /** @type {LedgerRow} */
      const probe = {
        model: ledgerModelId(part.model || r.model || '', tableIds), fileClass, fast: !!r.fast, geoUs: !!r.geoUs, project,
        responses: 0, incomplete: 0, input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, webSearchRequests: 0,
      };
      const k = rowKey(probe);
      const row = rowsOfUnit.get(k) ?? probe;
      row.responses++;
      if (!r.complete) row.incomplete++;
      row.input += part.tokens.input;
      row.output += part.tokens.output;
      row.cw5m += part.tokens.cw5m;
      row.cw1h += part.tokens.cw1h;
      row.cacheRead += part.tokens.cacheRead;
      if (i === 0) row.webSearchRequests += r.webSearchRequests || 0;
      rowsOfUnit.set(k, row);
    });
  }

  for (const t of o.acc.tools ?? []) {
    if (!t.sessionId) { unattributed++; continue; }
    if (typeof t.ts !== 'number') { undated++; continue; }
    const u = unitOf(localDate(t.ts, o.tz), sh(t.sessionId));
    u.toolCalls[t.displayName] = (u.toolCalls[t.displayName] ?? 0) + 1;
    u.toolStatus[t.status] = (u.toolStatus[t.status] ?? 0) + 1;
  }

  for (const p of o.tap.prompts.values()) {
    const u = unitOf(localDate(p.ts, o.tz), sh(p.sessionId));
    u.prompts++;
  }

  const idleSeconds = o.idleMinutes * 60;
  for (const [sessionId, tsList] of o.tap.activity) {
    for (const [day, ms] of activeMsByDay(tsList, idleSeconds, o.tz)) {
      const u = unitOf(day, sh(sessionId));
      u.activeSeconds += ms / 1000;
    }
  }

  // Finalize: rows sorted, responses summed, seconds rounded, grouped by month.
  /** @type {Map<string, { days: Record<string, Record<string, LedgerUnit>>, projectLabels: Record<string, string> }>} */
  const months = new Map();
  for (const day of [...units.keys()].sort()) {
    const month = day.slice(0, 7);
    let m = months.get(month);
    if (!m) { m = { days: {}, projectLabels: {} }; months.set(month, m); }
    const sessMap = /** @type {Map<string, LedgerUnit>} */ (units.get(day));
    /** @type {Record<string, LedgerUnit>} */
    const dayObj = {};
    for (const sess of [...sessMap.keys()].sort()) {
      const u = /** @type {LedgerUnit} */ (sessMap.get(sess));
      const byKey = rowsByUnit.get(day + '|' + sess);
      const rows = byKey ? [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]) : [];
      for (const r of rows) if (r.project && projectLabels[r.project]) m.projectLabels[r.project] = projectLabels[r.project];
      dayObj[sess] = normalizeUnit({ ...u, rows, responses: rows.reduce((s, r) => s + r.responses, 0), activeSeconds: Math.round(u.activeSeconds) });
    }
    m.days[day] = dayObj;
  }
  return { months, undated, unattributed };
}

/**
 * Canonical key order for a unit (stable files, stable diffs).
 * @param {LedgerUnit} u
 * @returns {LedgerUnit}
 */
function normalizeUnit(u) {
  return {
    responses: u.responses,
    prompts: u.prompts,
    activeSeconds: u.activeSeconds,
    rows: u.rows.map((r) => ({
      model: r.model, fileClass: r.fileClass, fast: r.fast, geoUs: r.geoUs, project: r.project,
      responses: r.responses, incomplete: r.incomplete, input: r.input, output: r.output, cw5m: r.cw5m, cw1h: r.cw1h,
      cacheRead: r.cacheRead, webSearchRequests: r.webSearchRequests,
    })),
    toolCalls: sortObject(u.toolCalls),
    toolStatus: sortObject(u.toolStatus),
  };
}

/**
 * @template T
 * @param {Record<string, T>} o
 * @returns {Record<string, T>}
 */
function sortObject(o) {
  /** @type {Record<string, T>} */
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Merge, read, write
 * ---------------------------------------------------------------------------------------- */

/**
 * Merge one month of new units into an existing month (rule: more responses wins, new wins ties).
 * @param {LedgerMonth|null} existing
 * @param {{ days: Record<string, Record<string, LedgerUnit>>, projectLabels: Record<string, string> }} incoming
 * @param {{ month: string, tz: string, idleMinutes: number, toolVersion: string, now: Date }} meta
 * @returns {{ month: LedgerMonth, added: number, replaced: number, keptOld: number }}
 */
export function mergeMonth(existing, incoming, meta) {
  let added = 0;
  let replaced = 0;
  let keptOld = 0;
  /** @type {Record<string, Record<string, LedgerUnit>>} */
  const days = {};
  const allDays = new Set([...Object.keys(existing ? existing.days : {}), ...Object.keys(incoming.days)]);
  for (const day of [...allDays].sort()) {
    const oldDay = existing && existing.days[day] ? existing.days[day] : {};
    const newDay = incoming.days[day] ?? {};
    /** @type {Record<string, LedgerUnit>} */
    const out = {};
    for (const sess of [...new Set([...Object.keys(oldDay), ...Object.keys(newDay)])].sort()) {
      const a = oldDay[sess];
      const b = newDay[sess];
      if (a && !b) { out[sess] = a; continue; }
      if (!a && b) { out[sess] = b; added++; continue; }
      if (a && b) {
        if (b.responses >= a.responses) { out[sess] = b; replaced++; } else { out[sess] = a; keptOld++; }
      }
    }
    days[day] = out;
  }
  const projectLabels = sortObject({ ...(existing ? existing.projectLabels : {}), ...incoming.projectLabels });
  return {
    month: {
      schema: LEDGER_SCHEMA,
      kind: LEDGER_KIND,
      month: meta.month,
      tz: meta.tz,
      idleMinutes: meta.idleMinutes,
      updatedAt: meta.now.toISOString(),
      toolVersion: meta.toolVersion,
      days,
      projectLabels,
    },
    added,
    replaced,
    keptOld,
  };
}

/**
 * Structural check of a ledger month file. Returns problems; empty means valid.
 * @param {unknown} m
 * @returns {string[]}
 */
export function checkLedgerMonth(m) {
  const x = /** @type {any} */ (m);
  if (!x || typeof x !== 'object' || Array.isArray(x)) return ['ledger month must be an object'];
  const p = [];
  if (x.schema !== LEDGER_SCHEMA) p.push('schema');
  if (x.kind !== LEDGER_KIND) p.push('kind');
  if (typeof x.month !== 'string' || !/^\d{4}-\d{2}$/.test(x.month)) p.push('month');
  if (!x.days || typeof x.days !== 'object') { p.push('days'); return p; }
  for (const [day, sessions] of Object.entries(x.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.slice(0, 7) !== x.month) p.push('day ' + day);
    if (!sessions || typeof sessions !== 'object') { p.push('sessions of ' + day); continue; }
    for (const [sess, u] of Object.entries(/** @type {Record<string, any>} */ (sessions))) {
      if (!/^[0-9a-f]{16}$/.test(sess)) p.push('session key');
      if (!u || !Number.isSafeInteger(u.responses) || !Array.isArray(u.rows)) p.push('unit ' + day);
    }
  }
  if (x.projectLabels && typeof x.projectLabels !== 'object') p.push('projectLabels');
  return p;
}

/**
 * @param {string} dir
 * @param {string} month
 * @returns {string}
 */
export function monthFile(dir, month) {
  return path.join(dir, month + '.json');
}

/**
 * Read one month. Missing file: null. Unreadable or invalid file: { invalid: true } so the
 * caller never overwrites data it could not parse.
 * @param {string} dir
 * @param {string} month
 * @returns {LedgerMonth|null|{ invalid: true }}
 */
export function readMonth(dir, month) {
  let text;
  try { text = fs.readFileSync(monthFile(dir, month), 'utf8'); } catch (e) {
    if (e && /** @type {any} */ (e).code === 'ENOENT') return null;
    return { invalid: true };
  }
  try {
    const m = JSON.parse(text);
    return checkLedgerMonth(m).length ? { invalid: true } : m;
  } catch {
    return { invalid: true };
  }
}

/**
 * Write one month atomically (temp file in the same folder, then rename).
 * @param {string} dir
 * @param {LedgerMonth} m
 */
export function writeMonth(dir, m) {
  fs.mkdirSync(dir, { recursive: true, mode: OUTPUT_DIR_MODE });
  const file = monthFile(dir, m.month);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { encoding: 'utf8', mode: OUTPUT_FILE_MODE });
  fs.renameSync(tmp, file);
}

/**
 * List the month files present (sorted 'YYYY-MM').
 * @param {string} dir
 * @returns {string[]}
 */
export function listMonths(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 7)).sort();
  } catch {
    return [];
  }
}

/**
 * The whole `remember` step: build units from the scan, merge month by month, write.
 * @param {{
 *   dir: string,
 *   acc: import('../core/accounting/contract.js').AccountingResult,
 *   tap: ReturnType<typeof createLedgerTap>,
 *   tz: string,
 *   idleMinutes: number,
 *   labels?: boolean,
 *   priceTableModelIds?: Set<string>|string[],
 *   toolVersion: string,
 *   now?: Date,
 * }} o
 * @returns {{ months: number, days: number, units: number, added: number, replaced: number, keptOld: number, skippedInvalidMonths: number, undated: number, unattributed: number }}
 */
export function remember(o) {
  const now = o.now ?? new Date();
  const built = buildLedgerUnits(o);
  let added = 0;
  let replaced = 0;
  let keptOld = 0;
  let skippedInvalidMonths = 0;
  let days = 0;
  let units = 0;
  let months = 0;
  for (const [month, incoming] of built.months) {
    const existing = readMonth(o.dir, month);
    if (existing && 'invalid' in existing) { skippedInvalidMonths++; continue; }
    const r = mergeMonth(/** @type {LedgerMonth|null} */ (existing), incoming, { month, tz: o.tz, idleMinutes: o.idleMinutes, toolVersion: o.toolVersion, now });
    writeMonth(o.dir, r.month);
    months++;
    added += r.added;
    replaced += r.replaced;
    keptOld += r.keptOld;
    days += Object.keys(r.month.days).length;
    for (const d of Object.values(r.month.days)) units += Object.keys(d).length;
  }
  return { months, days, units, added, replaced, keptOld, skippedInvalidMonths, undated: built.undated, unattributed: built.unattributed };
}

/**
 * Totals across every ledger month, for the report's history panel and tests. Tokens only.
 * @param {string} dir
 * @returns {{ months: string[], days: number, units: number, responses: number, prompts: number, activeSeconds: number, tokens: { input: number, output: number, cw5m: number, cw1h: number, cacheRead: number } }}
 */
export function ledgerTotals(dir) {
  const out = { months: /** @type {string[]} */ ([]), days: 0, units: 0, responses: 0, prompts: 0, activeSeconds: 0, tokens: { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 } };
  for (const month of listMonths(dir)) {
    const m = readMonth(dir, month);
    if (!m || 'invalid' in m) continue;
    out.months.push(month);
    for (const d of Object.values(m.days)) {
      out.days++;
      for (const u of Object.values(d)) {
        out.units++;
        out.responses += u.responses;
        out.prompts += u.prompts;
        out.activeSeconds += u.activeSeconds;
        for (const r of u.rows) {
          out.tokens.input += r.input; out.tokens.output += r.output; out.tokens.cw5m += r.cw5m;
          out.tokens.cw1h += r.cw1h; out.tokens.cacheRead += r.cacheRead;
        }
      }
    }
  }
  return out;
}

/**
 * The Claude Code SessionEnd hook the user may paste into ~/.claude/settings.json. Printed,
 * never installed (DESIGN 8.9, 12).
 * @returns {string}
 */
export function hookSnippet() {
  return JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx auditrail remember' }] }] } }, null, 2);
}
