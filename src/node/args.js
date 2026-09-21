// Command line parsing and validation (DESIGN 8.2). Pure: no file system, no process state.

import { parseArgs } from 'node:util';
import { CARD_HIDE_KEYS, CARD_INCLUDE_KEYS } from '../core/public.js';
import { DEFAULT_IDLE_MINUTES } from '../core/constants.js';
import { CHILD_FLAG } from './sandbox.js';

export const COMMANDS = Object.freeze(['report', 'card', 'audit', 'export', 'remember', 'secrets']);

/** Plan tiers accepted by --plan (DESIGN 5.4). Prices live in the bundled plans table. */
export const PLAN_TIERS = Object.freeze(['pro', 'pro-annual', 'max5x', 'max20x', 'team', 'team-premium']);

export const EXPORT_BY = Object.freeze(['day', 'month', 'model', 'project']);

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const OPTIONS = /** @type {const} */ ({
  dir: { type: 'string', multiple: true },
  since: { type: 'string' },
  until: { type: 'string' },
  tz: { type: 'string' },
  'idle-minutes': { type: 'string' },
  redact: { type: 'boolean' },
  prices: { type: 'string' },
  plan: { type: 'string' },
  'plan-price': { type: 'string' },
  'no-open': { type: 'boolean' },
  'demo-mark': { type: 'boolean' },
  out: { type: 'string' },
  'card-hide': { type: 'string', multiple: true },
  'card-include': { type: 'string', multiple: true },
  'print-sandbox': { type: 'boolean' },
  size: { type: 'string' },
  theme: { type: 'string' },
  methods: { type: 'boolean' },
  csv: { type: 'boolean' },
  json: { type: 'boolean' },
  md: { type: 'boolean' },
  by: { type: 'string' },
  locations: { type: 'boolean' },
  'remember-labels': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'ar-scan': { type: 'boolean' },
});

/**
 * @typedef {Object} CliOptions
 * @property {'report'|'card'|'audit'|'export'|'remember'|'secrets'|'help'|'version'} command
 * @property {boolean} child          true inside the sandboxed scanner (CHILD_FLAG)
 * @property {string[]} dirs
 * @property {string|null} since      as typed (YYYY-MM-DD or ISO)
 * @property {string|null} until
 * @property {string|null} tz         as typed; resolved later with resolveTimeZone
 * @property {number} idleMinutes
 * @property {boolean} redact
 * @property {boolean} demoMark   draw the showcase 'demo data' marker on the card
 * @property {string|null} prices
 * @property {string|null} plan
 * @property {number|null} planPrice
 * @property {boolean} noOpen
 * @property {string|null} out
 * @property {string[]} cardHide
 * @property {string[]} cardInclude
 * @property {boolean} printSandbox
 * @property {'landscape'|'portrait'} size
 * @property {'dark'|'light'} theme
 * @property {boolean} methods
 * @property {'csv'|'json'|'md'|null} format
 * @property {'day'|'month'|'model'|'project'} by
 * @property {boolean} locations
 * @property {boolean} rememberLabels
 */

/**
 * Parse and validate argv (without the node executable and script).
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message.replace(/\s+To specify.*$/s, '') : 'bad arguments');
  }
  const v = parsed.values;
  const pos = parsed.positionals;
  if (pos.length > 1) throw new UsageError('expected at most one command, got ' + pos.length);
  let command = pos[0] ?? 'report';
  if (v.help || command === 'help') command = 'help';
  else if (v.version || command === 'version') command = 'version';
  else if (!COMMANDS.includes(command)) throw new UsageError('unknown command "' + command + '"');

  const idleMinutes = v['idle-minutes'] === undefined ? DEFAULT_IDLE_MINUTES : Number(v['idle-minutes']);
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0 || idleMinutes > 24 * 60) throw new UsageError('--idle-minutes must be a number of minutes between 0 and 1440');

  if (v.plan !== undefined && v['plan-price'] !== undefined) throw new UsageError('use --plan or --plan-price, not both');
  if (v.plan !== undefined && !PLAN_TIERS.includes(v.plan)) throw new UsageError('--plan must be one of ' + PLAN_TIERS.join(', '));
  let planPrice = null;
  if (v['plan-price'] !== undefined) {
    planPrice = Number(v['plan-price']);
    if (!Number.isFinite(planPrice) || planPrice <= 0 || planPrice > 100000) throw new UsageError('--plan-price must be a positive number of US dollars per month');
  }

  const size = v.size ?? 'landscape';
  if (size !== 'landscape' && size !== 'portrait') throw new UsageError('--size must be landscape or portrait');
  const theme = v.theme ?? 'dark';
  if (theme !== 'dark' && theme !== 'light') throw new UsageError('--theme must be dark or light');

  const cardHide = v['card-hide'] ?? [];
  for (const h of cardHide) {
    if (!Object.prototype.hasOwnProperty.call(CARD_HIDE_KEYS, h)) throw new UsageError('--card-hide must be one of ' + Object.keys(CARD_HIDE_KEYS).join(', '));
  }
  const cardInclude = v['card-include'] ?? [];
  for (const h of cardInclude) {
    if (!Object.prototype.hasOwnProperty.call(CARD_INCLUDE_KEYS, h)) throw new UsageError('--card-include must be ' + Object.keys(CARD_INCLUDE_KEYS).join(', '));
  }

  const formats = /** @type {const} */ (['csv', 'json', 'md']).filter((f) => v[f]);
  if (formats.length > 1) throw new UsageError('choose one of --csv, --json, --md');
  const format = formats.length ? formats[0] : null;
  if (command === 'export' && !format) throw new UsageError('export needs --csv, --json or --md');
  const by = v.by ?? 'day';
  if (!EXPORT_BY.includes(by)) throw new UsageError('--by must be one of ' + EXPORT_BY.join(', '));
  if (command === 'secrets' && !v.locations) throw new UsageError('secrets needs --locations (the list prints file locations to this terminal only)');

  for (const [flag, val] of [['--since', v.since], ['--until', v.until]]) {
    if (val !== undefined && !isDateBound(val)) throw new UsageError(flag + ' must be YYYY-MM-DD or an ISO timestamp');
  }
  if (v.dir) for (const d of v.dir) if (!d) throw new UsageError('--dir needs a path');
  if (v.out !== undefined && !v.out) throw new UsageError('--out needs a path');

  return {
    command: /** @type {CliOptions['command']} */ (command),
    child: Boolean(v['ar-scan']),
    dirs: v.dir ?? [],
    since: v.since ?? null,
    until: v.until ?? null,
    tz: v.tz ?? null,
    idleMinutes,
    redact: Boolean(v.redact),
    prices: v.prices ?? null,
    plan: v.plan ?? null,
    planPrice,
    noOpen: Boolean(v['no-open']),
    out: v.out ?? null,
    cardHide,
    cardInclude,
    printSandbox: Boolean(v['print-sandbox']),
    size,
    theme,
    methods: Boolean(v.methods),
    format,
    by: /** @type {CliOptions['by']} */ (by),
    locations: Boolean(v.locations),
    rememberLabels: Boolean(v['remember-labels']),
    demoMark: Boolean(v['demo-mark']),
  };
}

/**
 * The argv for the sandboxed child: the same command and flags, with every path resolved by
 * the launcher (roots, output, price file). The child re-parses it with parseCli.
 * @param {CliOptions} o
 * @param {{ roots: string[], out: string|null, prices: string|null, tz: string }} resolved
 * @returns {string[]}
 */
export function childArgv(o, resolved) {
  const a = [];
  if (o.command !== 'report') a.push(o.command);
  for (const r of resolved.roots) a.push('--dir', r);
  if (resolved.out) a.push('--out', resolved.out);
  if (resolved.prices) a.push('--prices', resolved.prices);
  a.push('--tz', resolved.tz);
  if (o.since) a.push('--since', o.since);
  if (o.until) a.push('--until', o.until);
  if (o.idleMinutes !== DEFAULT_IDLE_MINUTES) a.push('--idle-minutes', String(o.idleMinutes));
  if (o.redact) a.push('--redact');
  if (o.plan) a.push('--plan', o.plan);
  if (o.planPrice !== null) a.push('--plan-price', String(o.planPrice));
  for (const h of o.cardHide) a.push('--card-hide', h);
  for (const h of o.cardInclude) a.push('--card-include', h);
  if (o.command === 'card') a.push('--size', o.size, '--theme', o.theme);
  if (o.methods) a.push('--methods');
  if (o.format) a.push('--' + o.format);
  if (o.command === 'export') a.push('--by', o.by);
  if (o.locations) a.push('--locations');
  if (o.rememberLabels) a.push('--remember-labels');
  if (o.demoMark) a.push('--demo-mark');
  return a;
}

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isDateBound(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDate(s);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
}

/**
 * @param {string} ymd
 * @returns {boolean}
 */
function isRealDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * The IANA zone for local bucketing (rule A21): --tz, else the system zone, else UTC.
 * @param {string|null} requested
 * @returns {string}
 */
export function resolveTimeZone(requested) {
  if (requested) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: requested }).resolvedOptions().timeZone;
    } catch {
      throw new UsageError('--tz must be an IANA time zone such as America/New_York or UTC');
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Offset of a zone from UTC at an instant, in milliseconds (local minus UTC).
 * @param {number} ms
 * @param {string} tz
 * @returns {number}
 */
export function zoneOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of f.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Epoch ms of local midnight at the start of a calendar date in a zone.
 * @param {string} ymd
 * @param {string} tz
 * @returns {number}
 */
export function localMidnightMs(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffsetMs(guess, tz);
  const again = guess - zoneOffsetMs(t, tz);
  if (again !== t) t = again;
  return t;
}

/**
 * --since and --until as epoch ms. A date means local midnight in tz; --until DATE includes that
 * whole day (the bound is the next local midnight, exclusive).
 * @param {string|null} since
 * @param {string|null} until
 * @param {string} tz
 * @returns {{ since: number|null, until: number|null }}
 */
export function dateRange(since, until, tz) {
  const s = since === null ? null : /^\d{4}-\d{2}-\d{2}$/.test(since) ? localMidnightMs(since, tz) : Date.parse(since);
  let u = null;
  if (until !== null) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      const [y, m, d] = until.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      u = localMidnightMs(next, tz);
    } else {
      u = Date.parse(until);
    }
  }
  if (s !== null && u !== null && u <= s) throw new UsageError('--until must be later than --since');
  return { since: s, until: u };
}

export const HELP = `auditrail: the audit trail your coding agents already wrote, priced, ranked and scanned. Runs 100% locally.

Usage
  auditrail                      scan, write the HTML report, open it
  auditrail card                 write the share card PNG (--size landscape|portrait, --theme dark|light)
  auditrail audit [--methods]    receipts: files, lines, responses, dedup effect, prices, cross-checks
  auditrail export --csv|--json|--md [--by day|month|model|project]
  auditrail remember             update the numbers-only ledger (opt-in history rescue)
  auditrail secrets --locations  terminal-only list of where secret findings are stored

Options
  --dir <path>          scan this projects folder instead of the default (repeatable)
  --since <date>        first local day to include (YYYY-MM-DD or ISO timestamp)
  --until <date>        last local day to include
  --tz <zone>           IANA time zone for days and hours (default: this machine's zone)
  --idle-minutes <n>    idle cutoff for active time (default 15)
  --redact              replace project, file, agent, skill, MCP, tool, unpriced model and
                        custom price file names with Project A, File A, ...
  --prices <file>       custom price file (Claude Code modelPricing format)
  --plan <tier>         pro, pro-annual, max5x, max20x, team, team-premium (value multiple only)
  --plan-price <usd>    your monthly plan price instead of --plan
  --out <file>          where to write the report, card or export
  --no-open             do not open the report in the browser
  --card-hide <stat>    hide one card stat (repeatable)
  --card-include rate-limits   add the rate-limit stat to the card (opt-in)
  --demo-mark           write "DEMO DATA, NOT REAL USAGE" on the card (used for this
                        project's own showcase images, so they cannot be read as real figures)
  --remember-labels     store project labels in the ledger (default: hashed keys only)
  --print-sandbox       print the exact sandboxed scanner command
  -v, --version         print the version
  -h, --help            print this help

Every dollar figure is API-equivalent value at list price. If you are on Pro or Max, it is not what you paid.
`;

/** Re-exported so tests can check the child flag stays out of user help. */
export { CHILD_FLAG };
