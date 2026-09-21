// The command line entry point (DESIGN 8.1, 8.2, 8.8, 8.9; traps 8, 57, 61, 66).
//
// One program, two roles:
// - The LAUNCHER (what the user runs): parses arguments, finds the log roots (it only checks
//   that they exist, it never lists or reads them), decides the output file, then re-executes
//   this same program as a sandboxed child and, for the default command, opens the finished
//   report in the browser afterwards.
// - The SCANNER (the child, marked by CHILD_FLAG): runs under the Node permission model with
//   read access to the program, the roots, the two settings files, stats-cache.json and the
//   price or project rules files only, and write access to exactly one output file (or the
//   ledger folder for `remember`). No --allow-net, no --allow-child-process, no --allow-worker.
//   It prints the sandbox status line from what the runtime actually enforces (sandbox.js), so
//   the strong "network: denied by the Node runtime" wording can only appear on Node 25 and later.
//
// Terminal rule (people screen-record terminals): COUNTS ONLY. Version, sandbox status line, scan
// timestamp, files, MB, seconds, responses, incomplete share and the output path this program
// chose. Never a project name, a path from the logs, a model id or free text from a log. The
// single exception is `secrets --locations`, which names files on explicit request.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseCli, childArgv, resolveTimeZone, dateRange, UsageError, HELP } from './args.js';
import { candidateRoots, resolveRoots, configFilesFor, readRetentionEvidence, walkRoots, wslHint } from './discover.js';
import { buildSandboxArgs, formatCommand, runSandboxed, sandboxStatus, parseNodeVersion } from './sandbox.js';
import { scanFiles } from './read.js';
import { renderReport, writeReport, defaultReportPath, localStamp, uniquePath, OUTPUT_FILE_MODE, OUTPUT_DIR_MODE } from './report.js';
import { openFile } from './open.js';
import { ledgerDir, createLedgerTap, remember, hookSnippet } from './ledger.js';
import { scanLines, responsesLine, peakRssMb, auditLines, exportCsv, exportJson, exportMarkdown, secretLocationLines, fmtInt } from './output.js';

import { claudeCodeAdapter } from '../core/adapters/claude-code/index.js';
import { createAccounting } from '../core/accounting/index.js';
import { parsePriceOverrides } from '../core/accounting/price.js';
import { getPriceTable, getPlan } from '../core/prices/index.js';
import { createSecretScanner } from '../core/secrets.js';
import { buildSummary } from '../core/summary.js';
import { toPublicSummary, buildManifest } from '../core/public.js';
import { VALUE_LABEL } from '../core/constants.js';
import { renderCard } from '../core/card/layout.js';
import { encodePng } from '../core/card/png.js';

/** Minimum supported Node major (package.json engines). */
export const MIN_NODE_MAJOR = 22;

/** Commands that write one output file. */
const FILE_COMMANDS = Object.freeze(['report', 'card', 'export']);

/**
 * @typedef {Object} CliIo
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 * @property {Record<string, string|undefined>} env
 * @property {string} home
 * @property {string} platform
 * @property {string} execPath
 * @property {string} entryFile          absolute path of this program (bundle or src/node/cli.js)
 * @property {string} nodeVersion        process.versions.node style
 * @property {{ has: (scope: string, reference?: string) => boolean }|null|undefined} permission
 *   the enforced permission API (process.permission); the status line is derived from it
 * @property {() => Date} now
 * @property {(execPath: string, args: string[]) => Promise<number>} run   runs the sandboxed child
 * @property {(file: string) => Promise<boolean>} open
 */

/** @returns {CliIo} */
export function defaultIo() {
  return {
    out: (line) => { process.stdout.write(line + '\n'); },
    err: (line) => { process.stderr.write(line + '\n'); },
    env: process.env,
    home: os.homedir(),
    platform: process.platform,
    execPath: process.execPath,
    entryFile: fileURLToPath(import.meta.url),
    nodeVersion: process.versions.node,
    permission: /** @type {any} */ (process).permission,
    now: () => new Date(),
    run: (execPath, args) => runSandboxed(execPath, args),
    open: (file) => openFile(file),
  };
}

/* ------------------------------------------------------------------------------------------
 * Small pure helpers (exported for tests)
 * ---------------------------------------------------------------------------------------- */

/**
 * The package.json next to the program: `<pkg>/package.json` for both the bundle
 * (`<pkg>/dist/auditrail.mjs`) and a source checkout (`<pkg>/src/node/cli.js`).
 * @param {string} entryFile
 * @param {(p: string) => string} [readText]
 * @returns {{ version: string, packageJson: string|null }}
 */
export function readToolVersion(entryFile, readText = (p) => fs.readFileSync(p, 'utf8')) {
  const dir = path.dirname(entryFile);
  for (const p of [path.join(dir, '..', 'package.json'), path.join(dir, '..', '..', 'package.json')]) {
    try {
      const j = JSON.parse(readText(p));
      if (j && j.name === 'auditrail' && typeof j.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(j.version)) {
        return { version: j.version, packageJson: path.resolve(p) };
      }
    } catch { /* not this one */ }
  }
  return { version: '0.0.0-unknown', packageJson: null };
}

/**
 * The user's optional files under ~/.auditrail (DESIGN 5.2, rule A29).
 * @param {string} home
 * @returns {{ prices: string, projects: string }}
 */
export function userFiles(home) {
  const dir = path.join(home, '.auditrail');
  return { prices: path.join(dir, 'prices.json'), projects: path.join(dir, 'projects.json') };
}

/**
 * Default output file for a command, under ~/.auditrail/reports (DESIGN 8.2).
 * @param {import('./args.js').CliOptions} o
 * @param {string} home
 * @param {Date} now
 * @returns {string|null}
 */
export function defaultOutPath(o, home, now) {
  const dir = path.join(home, '.auditrail', 'reports');
  const stamp = localStamp(now);
  if (o.command === 'report') return defaultReportPath(home, now);
  if (o.command === 'card') return path.join(dir, 'auditrail-card-' + stamp + '-' + o.size + '-' + o.theme + '.png');
  if (o.command === 'export') {
    if (o.format === 'json') return path.join(dir, 'auditrail-summary-' + stamp + '.json');
    return path.join(dir, 'auditrail-by-' + o.by + '-' + stamp + '.' + (o.format ?? 'csv'));
  }
  return null;
}

/**
 * The plan used for the optional value multiple (DESIGN 5.4). Never inferred.
 * @param {import('./args.js').CliOptions} o
 * @returns {{ name: string|null, usdPerMonth: number }|null}
 */
export function planOption(o) {
  if (o.planPrice !== null) return { name: null, usdPerMonth: o.planPrice };
  if (o.plan) {
    const p = getPlan(o.plan);
    if (!p) throw new UsageError('--plan ' + o.plan + ' is not in the bundled plan table');
    return { name: p.displayName, usdPerMonth: p.usdPerMonth };
  }
  return null;
}

/**
 * Validate a project rules file (rule A29): an ordered list of { prefix, label }.
 * @param {unknown} j
 * @returns {{ prefix: string, label: string }[]}
 */
export function parseProjectRules(j) {
  const list = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray(/** @type {any} */ (j).rules) ? /** @type {any} */ (j).rules : null;
  if (!list) throw new UsageError('projects.json must be a list of { "prefix": "...", "label": "..." } entries');
  return list.map((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.prefix !== 'string' || !r.prefix || typeof r.label !== 'string') {
      throw new UsageError('projects.json entry ' + (i + 1) + ' needs a string "prefix" and a string "label"');
    }
    return { prefix: r.prefix, label: r.label };
  });
}

/**
 * existsSync for the sandboxed child. Under the permission model fs.existsSync THROWS
 * ERR_ACCESS_DENIED for a path outside the allow list (Node 25) instead of returning false.
 * A path the launcher did not grant is, for the scanner, a path that does not exist.
 * @param {string} p
 * @returns {boolean}
 */
export function sandboxedExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/**
 * First line of an error message, with every scanned root replaced, so an unexpected failure
 * cannot print a path from the logs.
 * @param {unknown} err
 * @param {string[]} [mask]
 * @returns {string}
 */
export function safeMessage(err, mask = []) {
  let m = err instanceof Error ? err.message : String(err);
  const needles = [];
  for (const s of mask) if (typeof s === 'string' && s.length > 1) needles.push(s, s.split(path.sep).join('/'));
  needles.sort((a, b) => b.length - a.length);
  for (const s of needles) m = m.split(s).join('<scanned folder>');
  return m.split(/\r?\n/)[0].slice(0, 300);
}

/**
 * @typedef {Object} LaunchPlan
 * @property {string} tz
 * @property {string[]} roots
 * @property {string|null} out         the one file the child may write (report, card, export)
 * @property {string|null} ledger      the ledger folder the child may write (remember)
 * @property {string[]} readPaths
 * @property {string[]} writePaths
 * @property {string[]} childArgs      arguments after CHILD_FLAG
 * @property {string[]} args           the full node argument list for the child
 */

/**
 * Everything the launcher decides before starting the child. Checks existence only; never
 * lists or reads a root.
 * @param {import('./args.js').CliOptions} o
 * @param {CliIo} io
 * @param {{ exists?: (p: string) => boolean, packageJson?: string|null }} [x]
 * @returns {LaunchPlan}
 */
export function planLaunch(o, io, x = {}) {
  const exists = x.exists ?? fs.existsSync;
  const tz = resolveTimeZone(o.tz);
  dateRange(o.since, o.until, tz); // validates the bounds before anything runs

  if (o.out && !FILE_COMMANDS.includes(o.command)) throw new UsageError('--out applies to the report, card and export commands');

  const candidates = candidateRoots({
    dirs: o.dirs,
    env: io.env,
    home: io.home,
    platform: io.platform,
    adapterRoots: claudeCodeAdapter.roots({ home: io.home, platform: io.platform, env: io.env }),
  });
  const found = resolveRoots(candidates, { platform: io.platform });
  const badDirs = [...found.missingDirs, ...found.notDirectories];
  if (badDirs.length) {
    // Positions, not paths: a typed path can itself carry a project name.
    const positions = badDirs.map((d) => o.dirs.findIndex((x2) => path.resolve(x2) === d) + 1).filter((n) => n > 0);
    throw new UsageError('--dir ' + (positions.length ? '#' + positions.join(', #') + ' ' : '') + 'is not an existing folder');
  }
  const roots = found.roots;

  const uf = userFiles(io.home);
  let prices = null;
  if (o.prices) {
    prices = path.resolve(o.prices);
    if (!exists(prices)) throw new UsageError('--prices file not found');
  } else if (exists(uf.prices)) {
    prices = uf.prices;
  }
  const projectsFile = exists(uf.projects) ? uf.projects : null;

  let out = null;
  if (FILE_COMMANDS.includes(o.command)) {
    const def = /** @type {string} */ (defaultOutPath(o, io.home, io.now()));
    out = o.out ? path.resolve(o.out) : uniquePath(def, exists);
  }
  const ledger = o.command === 'remember' ? ledgerDir(io.home) : null;

  const cfg = configFilesFor(roots, { existsSync: exists });
  const readPaths = [...roots, ...cfg.settings, ...cfg.statsCache];
  if (prices) readPaths.push(prices);
  if (projectsFile) readPaths.push(projectsFile);
  if (x.packageJson) readPaths.push(x.packageJson);
  if (ledger) readPaths.push(ledger);
  const writePaths = [];
  if (out) writePaths.push(out);
  if (ledger) writePaths.push(ledger);

  const childArgs = childArgv(o, { roots, out, prices, tz });
  const args = buildSandboxArgs({ entryFile: io.entryFile, readPaths, writePaths, childArgs, version: parseNodeVersion(io.nodeVersion) });
  return { tz, roots, out, ledger, readPaths, writePaths, childArgs, args };
}

/* ------------------------------------------------------------------------------------------
 * Entry
 * ---------------------------------------------------------------------------------------- */

/**
 * Run the CLI. Resolves with the process exit code (0 ok, 1 failure, 2 usage error).
 * @param {string[]} [argv]
 * @param {Partial<CliIo>} [ioOverrides]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), ioOverrides = {}) {
  const io = { ...defaultIo(), ...ioOverrides };
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err('auditrail: ' + e.message);
      io.err('Run auditrail --help for usage.');
      return 2;
    }
    throw e;
  }
  const { version, packageJson } = readToolVersion(io.entryFile);
  if (o.command === 'help') {
    for (const line of HELP.replace(/\n$/, '').split('\n')) io.out(line);
    return 0;
  }
  if (o.command === 'version') {
    io.out('auditrail ' + version);
    return 0;
  }
  return o.child ? runScanner(o, io, version) : runLauncher(o, io, version, packageJson);
}

/**
 * @param {import('./args.js').CliOptions} o
 * @param {CliIo} io
 * @param {string} version
 * @param {string|null} packageJson
 * @returns {Promise<number>}
 */
async function runLauncher(o, io, version, packageJson) {
  const ver = parseNodeVersion(io.nodeVersion);
  if (ver.major < MIN_NODE_MAJOR) {
    io.err('auditrail needs Node ' + MIN_NODE_MAJOR + ' or later (this is Node ' + ver.major + ').');
    return 1;
  }
  /** @type {LaunchPlan} */
  let plan;
  try {
    plan = planLaunch(o, io, { packageJson });
  } catch (e) {
    if (e instanceof UsageError) {
      io.err('auditrail: ' + e.message);
      return 2;
    }
    throw e;
  }

  if (o.printSandbox) {
    io.out(formatCommand(io.execPath, plan.args, io.platform));
    return 0;
  }

  io.out('auditrail ' + version);
  if (!plan.roots.length) {
    io.out('No Claude Code logs found. Pass the projects folder with --dir <path>.');
    if (io.platform === 'win32') io.out(wslHint());
    return 1;
  }

  // Folders this tool creates under ~/.auditrail hold the report, the exports and the ledger,
  // so they are owner-only. A folder the user named with --out is theirs: it is created with the
  // platform default, and only the file written into it is owner-only.
  const ownDir = path.join(io.home, '.auditrail');
  const isOwnDir = (/** @type {string} */ d) => d === ownDir || d.startsWith(ownDir + path.sep);
  if (plan.out) {
    const d = path.dirname(plan.out);
    fs.mkdirSync(d, isOwnDir(d) ? { recursive: true, mode: OUTPUT_DIR_MODE } : { recursive: true });
  }
  if (plan.ledger) fs.mkdirSync(plan.ledger, { recursive: true, mode: OUTPUT_DIR_MODE });

  const code = await io.run(io.execPath, plan.args);
  if (code !== 0) {
    io.err('auditrail: the scanner exited with code ' + code + '.');
    return code;
  }
  if (o.command === 'report' && plan.out) {
    if (o.noOpen) return 0;
    const opened = await io.open(plan.out);
    io.out(opened ? 'opened in your default browser' : 'could not start a browser; open the report file above by hand');
  }
  return 0;
}

/**
 * The sandboxed scanner. Everything below runs under --permission.
 * @param {import('./args.js').CliOptions} o
 * @param {CliIo} io
 * @param {string} version
 * @returns {Promise<number>}
 */
async function runScanner(o, io, version) {
  const status = sandboxStatus({ version: parseNodeVersion(io.nodeVersion), permission: io.permission });
  io.out(status.line);
  /** @type {string[]} */
  let roots = [];
  try {
    const tz = resolveTimeZone(o.tz);
    const range = dateRange(o.since, o.until, tz);
    const found = resolveRoots(candidateRoots({ dirs: o.dirs, env: io.env, home: io.home, platform: io.platform, adapterRoots: claudeCodeAdapter.roots({ home: io.home, platform: io.platform, env: io.env }) }), { platform: io.platform });
    roots = found.roots;
    const nowMs = io.now().getTime();

    const table = getPriceTable();
    let overrides = null;
    if (o.prices) overrides = parsePriceOverrides(JSON.parse(fs.readFileSync(o.prices, 'utf8')), path.basename(o.prices));
    const uf = userFiles(io.home);
    let projectRules = [];
    if (sandboxedExists(uf.projects)) projectRules = parseProjectRules(JSON.parse(fs.readFileSync(uf.projects, 'utf8')));
    const retention = readRetentionEvidence(configFilesFor(roots, { existsSync: sandboxedExists }));

    const walk = await walkRoots(roots, (rel) => claudeCodeAdapter.classify(rel));
    const methods = o.command === 'audit' && o.methods;
    const acc = createAccounting({
      prices: table, tz, idleMinutes: o.idleMinutes, pathStyle: 'auto', overrides, projectRules,
      since: range.since, until: range.until, methods, adapter: claudeCodeAdapter,
    });
    acc.addFiles(walk.files);
    for (const [reason, n] of Object.entries(walk.skippedFiles)) if (n) acc.addSkippedFile(/** @type {any} */ (reason), n);

    const tap = o.command === 'remember' ? createLedgerTap(range) : null;
    /** @type {{ secretType: string, fingerprint12: string, severity: string, fileIdx: number, lineNo: number }[]} */
    const secretHits = [];
    const inRange = (ts) => ts === null || ((range.since === null || ts >= range.since) && (range.until === null || ts < range.until));
    const sink = {
      /** @param {any[]} events @param {any} file */
      onEvents(events, file) {
        acc.onEvents(events, file);
        if (tap) tap.onEvents(events);
        if (o.command === 'secrets') {
          for (const ev of events) {
            if (ev.kind === 'secret' && inRange(ev.ts)) secretHits.push({ secretType: ev.secretType, fingerprint12: ev.fingerprint12, severity: ev.severity, fileIdx: ev.fileIdx, lineNo: ev.lineNo });
          }
        }
      },
      /** @param {any} file @param {any} stats */
      onFileDone(file, stats) { acc.onFileDone(file, stats); },
    };

    const receipt = await scanFiles({
      roots, files: walk.files, adapter: claudeCodeAdapter, sink, pathStyle: 'auto',
      scanSecrets: createSecretScanner({ nowMs }),
    });
    const result = acc.finish();

    for (const line of scanLines({
      takenAt: walk.takenAt,
      filesRead: receipt.filesRead,
      bytes: receipt.totals.bytes,
      seconds: receipt.seconds,
      peakMb: peakRssMb(),
      skippedFiles: walk.skippedFiles,
      parseErrors: receipt.totals.parseErrors,
      trailingPartial: receipt.totals.trailingPartial,
      oversizeLines: receipt.totals.oversizeLines,
      unreadableFiles: receipt.unreadableFiles + walk.unreadableEntries,
    })) io.out(line);
    io.out(responsesLine({ responses: result.totals.responses, incomplete: result.totals.incomplete }));

    if (o.command === 'audit') {
      for (const line of auditLines({
        acc: result, prices: table, nowMs, methods: methods ? acc.methods() : null,
        valueLabel: overrides ? 'value at your custom rates (' + overrides.fileName + ')' : VALUE_LABEL,
      })) io.out(line);
      return 0;
    }
    if (o.command === 'secrets') {
      for (const line of secretLocationLines(secretHits, walk.files, roots)) io.out(line);
      return 0;
    }
    if (o.command === 'remember') {
      const dir = ledgerDir(io.home);
      const r = remember({ dir, acc: result, tap: /** @type {any} */ (tap), tz, idleMinutes: o.idleMinutes, labels: o.rememberLabels, priceTableModelIds: new Set(table.models.map((m) => m.id)), toolVersion: version, now: new Date(nowMs) });
      io.out('ledger updated: ' + fmtInt(r.months) + ' months, ' + fmtInt(r.days) + ' days, ' + fmtInt(r.units) + ' session-days (' +
        fmtInt(r.added) + ' added, ' + fmtInt(r.replaced) + ' refreshed, ' + fmtInt(r.keptOld) + ' kept from the ledger)');
      if (r.skippedInvalidMonths) io.out(fmtInt(r.skippedInvalidMonths) + ' ledger month files could not be read and were left untouched');
      io.out('ledger folder ' + dir + ' (counts and token totals, plus price-table model ids' +
        (o.rememberLabels ? ' and the project labels you asked for' : '') +
        ': no paths, prompts, titles, secrets or raw session ids)');
      io.out('To keep it current, add this SessionEnd hook to your Claude Code settings.json yourself (auditrail never installs it):');
      for (const line of hookSnippet().split('\n')) io.out(line);
      return 0;
    }

    const summary = buildSummary({
      acc: result,
      prices: table,
      toolVersion: version,
      scanTakenAt: walk.takenAt,
      scanSeconds: receipt.seconds,
      options: {
        tz,
        idleMinutes: o.idleMinutes,
        plan: planOption(o),
        redact: o.redact,
        cleanupPeriodDays: retention.cleanupPeriodDays,
        statsCacheDays: retention.statsCacheDays,
        nowMs,
        custom: overrides ? { fileName: overrides.fileName, multiplier: overrides.multiplier } : null,
      },
    });
    const out = /** @type {string} */ (o.out);
    if (!out) throw new Error('no output file was given to the scanner');

    if (o.command === 'report') {
      writeReport(out, renderReport(summary));
      io.out('report ' + out);
      return 0;
    }
    if (o.command === 'card') {
      const ps = toPublicSummary(summary, { hide: o.cardHide, include: o.cardInclude, priceTable: table });
      const manifest = buildManifest(ps);
      const img = renderCard({ ps, size: o.size, theme: o.theme, demo: o.demoMark });
      fs.writeFileSync(out, encodePng(img, { deflateSync }), { mode: OUTPUT_FILE_MODE });
      io.out('card ' + out + ' (' + img.width + ' x ' + img.height + ' px, ' + o.size + ', ' + o.theme + ')');
      // The manifest, printed next to the card, as the README says it is. It is the exact list
      // of fields the image contains, built from the PublicSummary the renderer was handed, so
      // a reader auditing the PNG does not have to open the HTML report to see it. Terminal
      // rule holds: every line here is card copy, which is allowlisted and public by
      // construction (core/public.js), never a project name, a path or free text from a log.
      io.out('manifest: the ' + fmtInt(manifest.length) + ' fields this image contains, and nothing else');
      for (const e of manifest) io.out('  ' + e.label + ': ' + e.text);
      return 0;
    }
    // export
    const text = o.format === 'json' ? exportJson(summary) : o.format === 'md' ? exportMarkdown(summary, o.by) : exportCsv(summary, o.by);
    fs.writeFileSync(out, text, { encoding: 'utf8', mode: OUTPUT_FILE_MODE });
    io.out('export ' + out + ' (' + (o.format ?? 'csv') + (o.format === 'json' ? '' : ', by ' + o.by) + ')');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err('auditrail: ' + e.message);
      return 2;
    }
    const code = e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? ' [' + e.code + ']' : '';
    io.err('auditrail: scan failed' + code + ': ' + safeMessage(e, roots));
    if (io.env.AUDITRAIL_DEBUG === '1' && e instanceof Error && e.stack) {
      for (const line of e.stack.split(/\r?\n/).slice(1, 12)) io.err(safeMessage(line, roots));
    }
    return 1;
  }
}

/**
 * True when this module is the program being run (not imported by a test).
 * @returns {boolean}
 */
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(path.resolve(argv1), self)) return true;
  try { return same(fs.realpathSync(argv1), fs.realpathSync(self)); } catch { return false; }
}

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write('auditrail: unexpected error: ' + safeMessage(e) + '\n');
      process.exitCode = 1;
    },
  );
}
