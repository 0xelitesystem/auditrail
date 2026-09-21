// CLI (DESIGN 8.2, 8.8, 8.9): argument parsing, the launcher's sandbox plan, the truthful status
// line per Node version (trap 57), and end-to-end runs of the real program on the synthetic
// fixtures with --no-open. Every end-to-end run re-executes the scanner under --permission
// exactly as a user's run would, with HOME pointed at a temporary folder so nothing outside the
// fixtures and that folder is touched.
//
// Terminal rule under test: counts only. No fixture project name, no canary, no path from the
// logs may reach stdout or stderr, except the explicit `secrets --locations` list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { parseCli, childArgv, UsageError, HELP, CHILD_FLAG } from '../../src/node/args.js';
import {
  main, planLaunch, planOption, defaultOutPath, readToolVersion, parseProjectRules, safeMessage, sandboxedExists, userFiles,
} from '../../src/node/cli.js';
import { parseNodeVersion, runtimeCanDenyNetwork, STATUS_NET_DENIED, STATUS_FS_ONLY, STATUS_OFF, STATUS_NET_FLAG_GIVEN } from '../../src/node/sandbox.js';
import { getPlan, getPriceTable } from '../../src/core/prices/index.js';
import { DEFAULT_IDLE_MINUTES } from '../../src/core/constants.js';
import { REPO, FIXTURES, CLI, tempDir, writeFile, canaries } from './helpers.js';

const PERSONA = path.join(FIXTURES, 'personas', 'subagent-lead', 'projects');
const CANARY = path.join(FIXTURES, 'canary', 'projects');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const NODE = parseNodeVersion();
const STRONG = 'denied by the Node runtime';

/* ------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------- */

/**
 * Project names planted in a fixture: the encoded projects/ folder names and every path segment
 * of every cwd below the fake root.
 * @param {string} root a fixture projects/ folder
 * @returns {string[]}
 */
function fixtureProjectNames(root) {
  const names = new Set();
  for (const d of fs.readdirSync(root)) {
    names.add(d);
    names.add(d.replace(/^-fake-/, ''));
  }
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/"cwd":"([^"]+)"/g)) {
        for (const seg of m[1].split(/[\\/]+/)) if (seg) names.add(seg);
      }
    }
  })(root);
  return [...names];
}

const PROJECT_NAMES = [...new Set([...fixtureProjectNames(PERSONA), ...fixtureProjectNames(CANARY)])];

/**
 * @param {string} text
 * @param {string} word
 * @returns {boolean} true when word occurs as a whole token (case-sensitive)
 */
function hasToken(text, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9])' + esc + '($|[^A-Za-z0-9])').test(text);
}

/** A temporary HOME with nothing in it. */
function freshHome() {
  const home = tempDir();
  return home;
}

/**
 * Run the real CLI (launcher, which starts the sandboxed scanner).
 * @param {string[]} args
 * @param {{ home: string }} o
 */
function runCli(args, o) {
  const env = { ...process.env, HOME: o.home, USERPROFILE: o.home };
  for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'AUDITRAIL_DEBUG']) delete env[k];
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Terminal text with the temporary folders this test chose removed (those paths are the
 * program's own output locations, legitimately printed).
 * @param {string} text
 * @param {string[]} dirs
 */
function withoutOwnPaths(text, dirs) {
  let t = text;
  for (const d of dirs) t = t.split(d).join('<tmp>');
  return t;
}

/**
 * Assert the counts-only rule on terminal text.
 * @param {string} text
 * @param {string} label
 */
function assertNoLogNames(text, label) {
  for (const name of PROJECT_NAMES) assert.ok(!hasToken(text, name), label + ': a fixture project name reached the terminal');
  for (const [k, v] of Object.entries(canaries())) assert.ok(!text.includes(v), label + ': canary ' + k + ' reached the terminal');
  assert.ok(!text.includes('fake'), label + ': a fixture path reached the terminal');
  assert.ok(!text.includes(FIXTURES), label + ': a scanned root reached the terminal');
}

/**
 * The status line the child must print on this runtime (trap 57).
 * @param {string} stdout
 */
function assertTruthfulStatus(stdout) {
  if (runtimeCanDenyNetwork(NODE)) {
    assert.ok(stdout.split(/\r?\n/).includes(STATUS_NET_DENIED), 'Node ' + NODE.major + ' should print the runtime network denial');
  } else {
    assert.ok(stdout.split(/\r?\n/).includes(STATUS_FS_ONLY), 'Node ' + NODE.major + ' should print the filesystem-only line');
    assert.ok(!stdout.includes(STRONG), 'the strong network claim must never print before Node 25');
  }
}

/** A CliIo that captures output and never spawns or opens anything. */
function captureIo(over = {}) {
  const out = [];
  const err = [];
  const io = {
    out: (l) => { out.push(l); },
    err: (l) => { err.push(l); },
    env: {},
    home: freshHome(),
    platform: process.platform,
    execPath: process.execPath,
    entryFile: CLI,
    nodeVersion: process.versions.node,
    permission: null,
    now: () => new Date(Date.UTC(2026, 8, 15, 12, 0, 0)),
    run: async () => { throw new Error('the unit tests must not start a child'); },
    open: async () => { throw new Error('the unit tests must not open a browser'); },
    ...over,
  };
  return { io, out, err };
}

/* ------------------------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------------------------- */

test('parseCli: no arguments is the default scan, report and open flow', () => {
  const o = parseCli([]);
  assert.equal(o.command, 'report');
  assert.equal(o.child, false);
  assert.deepEqual(o.dirs, []);
  assert.equal(o.idleMinutes, DEFAULT_IDLE_MINUTES);
  assert.equal(o.noOpen, false);
  assert.equal(o.redact, false);
  assert.equal(o.out, null);
  assert.equal(o.size, 'landscape');
  assert.equal(o.theme, 'dark');
  assert.equal(o.format, null);
  assert.equal(o.by, 'day');
  assert.equal(o.plan, null);
  assert.equal(o.planPrice, null);
  assert.deepEqual(o.cardHide, []);
  assert.deepEqual(o.cardInclude, []);
});

test('parseCli: every subcommand and flag in DESIGN 8.2', () => {
  const card = parseCli(['card', '--size', 'portrait', '--theme', 'light', '--out', 'c.png', '--card-hide', 'value', '--card-hide', 'streak', '--card-include', 'rate-limits']);
  assert.equal(card.command, 'card');
  assert.equal(card.size, 'portrait');
  assert.equal(card.theme, 'light');
  assert.equal(card.out, 'c.png');
  assert.deepEqual(card.cardHide, ['value', 'streak']);
  assert.deepEqual(card.cardInclude, ['rate-limits']);

  const audit = parseCli(['audit', '--methods']);
  assert.equal(audit.command, 'audit');
  assert.equal(audit.methods, true);

  for (const [fmt, by] of [['csv', 'day'], ['json', 'month'], ['md', 'model'], ['csv', 'project']]) {
    const e = parseCli(['export', '--' + fmt, '--by', by]);
    assert.equal(e.command, 'export');
    assert.equal(e.format, fmt);
    assert.equal(e.by, by);
  }

  const rem = parseCli(['remember', '--remember-labels']);
  assert.equal(rem.command, 'remember');
  assert.equal(rem.rememberLabels, true);

  const sec = parseCli(['secrets', '--locations']);
  assert.equal(sec.command, 'secrets');
  assert.equal(sec.locations, true);

  const flags = parseCli(['--dir', 'a', '--dir', 'b', '--since', '2026-01-01', '--until', '2026-06-30T12:00:00Z', '--tz', 'UTC',
    '--idle-minutes', '30', '--redact', '--prices', 'p.json', '--plan', 'max5x', '--no-open', '--out', 'r.html', '--print-sandbox']);
  assert.deepEqual(flags.dirs, ['a', 'b']);
  assert.equal(flags.since, '2026-01-01');
  assert.equal(flags.until, '2026-06-30T12:00:00Z');
  assert.equal(flags.tz, 'UTC');
  assert.equal(flags.idleMinutes, 30);
  assert.equal(flags.redact, true);
  assert.equal(flags.prices, 'p.json');
  assert.equal(flags.plan, 'max5x');
  assert.equal(flags.noOpen, true);
  assert.equal(flags.out, 'r.html');
  assert.equal(flags.printSandbox, true);
  assert.equal(parseCli(['--plan-price', '100']).planPrice, 100);
  assert.equal(parseCli(['--help']).command, 'help');
  assert.equal(parseCli(['-v']).command, 'version');
});

test('parseCli: bad input is a UsageError, never a crash', () => {
  const bad = [
    ['frobnicate'],
    ['card', 'audit'],
    ['export'],
    ['export', '--csv', '--json'],
    ['export', '--csv', '--by', 'week'],
    ['secrets'],
    ['--plan', 'pro', '--plan-price', '20'],
    ['--plan', 'enterprise'],
    ['--plan-price', '-5'],
    ['card', '--size', 'square'],
    ['card', '--theme', 'blue'],
    ['--idle-minutes', '0'],
    ['--idle-minutes', 'soon'],
    ['--since', '2026-02-30'],
    ['--until', 'yesterday'],
    ['--card-hide', 'everything'],
    ['--card-include', 'secrets'],
    ['--no-such-flag'],
  ];
  for (const argv of bad) assert.throws(() => parseCli(argv), UsageError, argv.join(' '));
});

test('childArgv: the scanner re-parses to the same command and flags', () => {
  const o = parseCli(['export', '--md', '--by', 'project', '--since', '2026-01-01', '--idle-minutes', '20', '--redact', '--plan', 'pro', '--card-hide', 'value']);
  const argv = childArgv(o, { roots: [path.resolve('/r1/projects'), path.resolve('/r2/projects')], out: path.resolve('/out/e.md'), prices: null, tz: 'UTC' });
  const c = parseCli([CHILD_FLAG, ...argv]);
  assert.equal(c.child, true);
  assert.equal(c.command, 'export');
  assert.equal(c.format, 'md');
  assert.equal(c.by, 'project');
  assert.deepEqual(c.dirs, [path.resolve('/r1/projects'), path.resolve('/r2/projects')]);
  assert.equal(c.out, path.resolve('/out/e.md'));
  assert.equal(c.tz, 'UTC');
  assert.equal(c.since, '2026-01-01');
  assert.equal(c.idleMinutes, 20);
  assert.equal(c.redact, true);
  assert.equal(c.plan, 'pro');
  assert.deepEqual(c.cardHide, ['value']);
  assert.ok(!HELP.includes(CHILD_FLAG), 'the internal child flag stays out of user help');
});

test('main: usage errors exit 2 on stderr; --version and --help print and exit 0', async () => {
  let c = captureIo();
  assert.equal(await main(['frobnicate'], c.io), 2);
  assert.equal(c.out.length, 0);
  assert.match(c.err.join('\n'), /unknown command/);

  c = captureIo();
  assert.equal(await main(['--version'], c.io), 0);
  assert.deepEqual(c.out, ['auditrail ' + PKG_VERSION]);

  c = captureIo();
  assert.equal(await main(['--help'], c.io), 0);
  assert.ok(c.out.some((l) => l.includes('secrets --locations')));
});

/* ------------------------------------------------------------------------------------------
 * Launcher plan (sandbox scope)
 * ---------------------------------------------------------------------------------------- */

test('planLaunch: scoped reads, one write, never network, child processes or workers', () => {
  const { io } = captureIo();
  const out = path.join(tempDir(), 'r.html');
  const plan = planLaunch(parseCli(['--dir', PERSONA, '--out', out, '--tz', 'UTC']), io, { packageJson: path.join(REPO, 'package.json') });
  assert.equal(plan.roots.length, 1);
  assert.equal(plan.out, out);
  assert.deepEqual(plan.writePaths, [out]);
  assert.ok(plan.readPaths.includes(plan.roots[0]));
  const flag = NODE.major === 22 && NODE.minor < 13 ? '--experimental-permission' : NODE.major === 23 && NODE.minor < 5 ? '--experimental-permission' : '--permission';
  assert.equal(plan.args[0], flag);
  for (const a of plan.args) assert.ok(!/^--allow-(net|child-process|worker|addons|wasi)/.test(a), a);
  assert.deepEqual(plan.args.filter((a) => a.startsWith('--allow-fs-write=')), ['--allow-fs-write=' + out]);
  assert.ok(plan.args.includes(CHILD_FLAG));
  assert.equal(plan.tz, 'UTC');
});

test('planLaunch: remember writes only the ledger folder; audit and secrets write nothing', () => {
  const { io } = captureIo();
  const rem = planLaunch(parseCli(['remember', '--dir', PERSONA]), io);
  const ledger = path.join(io.home, '.auditrail', 'ledger', 'v1');
  assert.equal(rem.ledger, ledger);
  assert.deepEqual(rem.writePaths, [ledger]);
  assert.ok(rem.readPaths.includes(ledger));
  for (const cmd of [['audit', '--methods'], ['secrets', '--locations']]) {
    const p = planLaunch(parseCli([...cmd, '--dir', PERSONA]), io);
    assert.equal(p.out, null);
    assert.deepEqual(p.writePaths, [], cmd[0]);
    assert.ok(!p.args.some((a) => a.startsWith('--allow-fs-write=')), cmd[0]);
  }
  assert.throws(() => planLaunch(parseCli(['audit', '--out', 'x.txt', '--dir', PERSONA]), io), UsageError);
});

test('planLaunch: a missing --dir is reported by position, never by path', () => {
  const { io } = captureIo();
  const missing = path.join(tempDir(), 'secret-client-project');
  assert.throws(() => planLaunch(parseCli(['--dir', PERSONA, '--dir', missing]), io), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /#2/);
    assert.ok(!e.message.includes('secret-client-project'));
    return true;
  });
  assert.throws(() => planLaunch(parseCli(['--dir', PERSONA, '--prices', path.join(tempDir(), 'none.json')]), io), UsageError);
});

test('planLaunch: default outputs go under ~/.auditrail/reports and never overwrite', () => {
  const { io } = captureIo();
  const now = io.now();
  const first = defaultOutPath(parseCli([]), io.home, now);
  assert.ok(first.startsWith(path.join(io.home, '.auditrail', 'reports') + path.sep));
  assert.match(path.basename(first), /^auditrail-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  writeFile(first, 'taken');
  const plan = planLaunch(parseCli(['--dir', PERSONA]), io);
  assert.notEqual(plan.out, first);
  assert.match(path.basename(plan.out), /-2\.html$/);
  assert.match(path.basename(defaultOutPath(parseCli(['card', '--size', 'portrait']), io.home, now)), /^auditrail-card-.*-portrait-dark\.png$/);
  assert.match(path.basename(defaultOutPath(parseCli(['export', '--csv', '--by', 'month']), io.home, now)), /^auditrail-by-month-.*\.csv$/);
  assert.match(path.basename(defaultOutPath(parseCli(['export', '--json']), io.home, now)), /^auditrail-summary-.*\.json$/);
  assert.equal(defaultOutPath(parseCli(['audit']), io.home, now), null);
});

test('planLaunch: ~/.auditrail/prices.json and projects.json are granted when present', () => {
  const { io } = captureIo();
  const uf = userFiles(io.home);
  writeFile(uf.prices, '{"multiplier":0.5}');
  writeFile(uf.projects, '[]');
  const plan = planLaunch(parseCli(['audit', '--dir', PERSONA]), io);
  assert.ok(plan.readPaths.includes(uf.prices));
  assert.ok(plan.readPaths.includes(uf.projects));
  assert.equal(plan.childArgs[plan.childArgs.indexOf('--prices') + 1], uf.prices);
});

test('small helpers: version, plan, project rules, error masking, sandboxed exists', () => {
  assert.deepEqual(readToolVersion(CLI), { version: PKG_VERSION, packageJson: path.join(REPO, 'package.json') });
  assert.equal(readToolVersion(path.join(tempDir(), 'x', 'cli.js')).version, '0.0.0-unknown');

  assert.equal(planOption(parseCli([])), null);
  assert.deepEqual(planOption(parseCli(['--plan-price', '42'])), { name: null, usdPerMonth: 42 });
  const pro = getPlan('pro');
  assert.deepEqual(planOption(parseCli(['--plan', 'pro'])), { name: pro.displayName, usdPerMonth: pro.usdPerMonth });

  assert.deepEqual(parseProjectRules([{ prefix: '/fake/a', label: 'A' }]), [{ prefix: '/fake/a', label: 'A' }]);
  assert.deepEqual(parseProjectRules({ rules: [{ prefix: '/fake/b', label: 'B' }] }), [{ prefix: '/fake/b', label: 'B' }]);
  assert.throws(() => parseProjectRules({ prefix: 'x' }), UsageError);
  assert.throws(() => parseProjectRules([{ prefix: '', label: 'x' }]), UsageError);

  const root = path.join(tempDir(), 'projects');
  const msg = safeMessage(new Error('ENOENT: open ' + path.join(root, '-fake-client', 'a.jsonl') + '\nmore'), [root]);
  assert.ok(!msg.includes(root));
  assert.ok(!msg.includes('more'));
  assert.match(msg, /<scanned folder>/);

  assert.equal(sandboxedExists(path.join(tempDir(), 'nothing-here')), false);
  assert.equal(sandboxedExists(CLI), true);
});

/* ------------------------------------------------------------------------------------------
 * The truthful status line (trap 57), through the scanner itself
 * ---------------------------------------------------------------------------------------- */

test('scanner status line: the strong network wording only on Node 25 and later', async () => {
  const denyNet = { has: (scope) => scope !== 'net' };
  const runAudit = async (nodeVersion, permission) => {
    const c = captureIo({ nodeVersion, permission });
    const code = await main([CHILD_FLAG, 'audit', '--dir', CANARY, '--tz', 'UTC'], c.io);
    assert.equal(code, 0, c.err.join('\n'));
    return c.out;
  };
  for (const v of ['22.13.0', '23.11.0', '24.9.0']) {
    const out = await runAudit(v, denyNet);
    assert.equal(out[0], STATUS_FS_ONLY, v);
    assert.ok(!out.join('\n').includes(STRONG), v);
  }
  for (const v of ['25.0.0', '25.9.0', '26.1.0']) {
    assert.equal((await runAudit(v, denyNet))[0], STATUS_NET_DENIED, v);
    assert.equal((await runAudit(v, { has: () => true }))[0], STATUS_NET_FLAG_GIVEN, v);
  }
  assert.equal((await runAudit('25.9.0', null))[0], STATUS_OFF);
});

/* ------------------------------------------------------------------------------------------
 * End to end: the real program, the real sandbox, the synthetic fixtures
 * ---------------------------------------------------------------------------------------- */

test('end to end: default flow with --no-open writes a report; terminal output is counts only', () => {
  const home = freshHome();
  const outDir = tempDir();
  const out = path.join(outDir, 'report.html');
  const r = runCli(['--dir', PERSONA, '--dir', CANARY, '--no-open', '--out', out, '--tz', 'UTC'], { home });
  assert.equal(r.status, 0, r.stderr);

  // A report file was produced, with the data block and a CSP.
  assert.ok(fs.existsSync(out), 'report file');
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.length > 1000);
  assert.match(html, /id="ar-data"/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  const data = JSON.parse(/<script type="application\/json" id="ar-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.tool.version, PKG_VERSION);
  assert.equal(data.scan.filesRead, 92);
  assert.equal(data.redacted, false);

  // Canaries that may never appear anywhere are absent from the local report too.
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canary', 'expected.json'), 'utf8'));
  for (const [k, c] of Object.entries(e.canaries)) {
    if (!c.mayAppearIn.length) assert.ok(!html.includes(c.value), 'canary ' + k + ' in the report');
  }

  // Terminal: version, status line, counts, the report path. Nothing from the logs.
  const text = withoutOwnPaths(r.stdout + r.stderr, [outDir, home]);
  assertNoLogNames(text, 'default flow');
  assertTruthfulStatus(r.stdout);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[0], 'auditrail ' + PKG_VERSION);
  assert.ok(lines.includes('report ' + out));
  assert.ok(lines.some((l) => /^scanned 92 files \(/.test(l)));
  assert.ok(lines.some((l) => /^responses 323, of which /.test(l)));
  const allowed = [
    /^auditrail \d/, /^network: /, /^filesystem: /, /^sandbox: /, /^scan taken \d{4}-\d{2}-\d{2}T/,
    /^scanned \d[\d,]* files \(/, /parse errors/, /^responses \d/, /^report /,
  ];
  for (const l of lines) assert.ok(allowed.some((re) => re.test(l)), 'unexpected terminal line: ' + withoutOwnPaths(l, [outDir, home]));
  assert.ok(!lines.some((l) => /browser/.test(l)), '--no-open must not open anything');
  // The default HOME got nothing but its own (empty) state: no report was written there.
  assert.ok(!fs.existsSync(path.join(home, '.auditrail', 'reports')));
});

test('end to end: --redact report carries no project name and no canary at all', () => {
  const home = freshHome();
  const out = path.join(tempDir(), 'redacted.html');
  const r = runCli(['--dir', PERSONA, '--dir', CANARY, '--no-open', '--redact', '--out', out, '--tz', 'UTC'], { home });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  for (const [k, v] of Object.entries(canaries())) assert.ok(!html.includes(v), 'canary ' + k);
  for (const name of ['beta-service', 'gamma-web']) assert.ok(!html.includes(name), 'project label in a redacted report');
});

test('end to end: card, audit --methods, export, remember and secrets --locations', () => {
  const home = freshHome();
  const outDir = tempDir();
  const own = [outDir, home];
  const base = ['--dir', PERSONA, '--dir', CANARY, '--tz', 'UTC'];

  // card
  const png = path.join(outDir, 'card.png');
  let r = runCli(['card', ...base, '--size', 'portrait', '--theme', 'light', '--out', png], { home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...fs.readFileSync(png).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assertNoLogNames(withoutOwnPaths(r.stdout + r.stderr, own), 'card');
  assertTruthfulStatus(r.stdout);

  // audit --methods
  r = runCli(['audit', '--methods', ...base], { home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /files by class/);
  assert.match(r.stdout, /value under each counting method/);
  assert.match(r.stdout, /sum every line/);
  assertNoLogNames(withoutOwnPaths(r.stdout + r.stderr, own), 'audit');

  // export (default location under the temporary HOME)
  r = runCli(['export', '--csv', '--by', 'project', ...base], { home });
  assert.equal(r.status, 0, r.stderr);
  const reports = path.join(home, '.auditrail', 'reports');
  const csv = fs.readdirSync(reports).filter((n) => n.endsWith('.csv'));
  assert.equal(csv.length, 1);
  assert.match(fs.readFileSync(path.join(reports, csv[0]), 'utf8'), /^project,responses,value_usd,sessions\r\n/);
  assertNoLogNames(withoutOwnPaths(r.stdout + r.stderr, own), 'export');

  // remember, twice: the second run refreshes, never duplicates
  r = runCli(['remember', ...base], { home });
  assert.equal(r.status, 0, r.stderr);
  const ledger = path.join(home, '.auditrail', 'ledger', 'v1');
  const months = fs.readdirSync(ledger).filter((n) => /^\d{4}-\d{2}\.json$/.test(n));
  assert.ok(months.length >= 1);
  const ledgerText = months.map((m) => fs.readFileSync(path.join(ledger, m), 'utf8')).join('\n');
  for (const name of PROJECT_NAMES) assert.ok(!hasToken(ledgerText, name), 'a project name in the ledger');
  for (const [k, v] of Object.entries(canaries())) assert.ok(!ledgerText.includes(v), 'canary ' + k + ' in the ledger');
  // Every model id in the ledger is either a published price-table id or a hash. A raw gateway
  // id is free text from a log: a Bedrock inference-profile id carries a cloud account number,
  // and the ledger is the one file designed to outlive the transcript it came from.
  const tableIds = new Set(getPriceTable().models.map((m) => m.id));
  const ledgerModels = [...new Set([...ledgerText.matchAll(/"model": "([^"]*)"/g)].map((m) => m[1]))];
  assert.ok(ledgerModels.length > 0, 'the ledger should have rows to check');
  for (const id of ledgerModels) {
    assert.ok(id === '' || tableIds.has(id) || /^other:[0-9a-f]{16}$/.test(id), 'raw model id in the ledger: ' + id);
  }
  assert.match(r.stdout, /SessionEnd/);
  assertNoLogNames(withoutOwnPaths(r.stdout + r.stderr, own), 'remember');
  const again = runCli(['remember', ...base], { home });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\(0 added, \d+ refreshed, 0 kept from the ledger\)/);

  // secrets --locations: the one listing that names files, and never the value
  r = runCli(['secrets', '--locations', ...base], { home });
  assert.equal(r.status, 0, r.stderr);
  const secret = canaries().secret;
  assert.ok(!r.stdout.includes(secret), 'secret value printed');
  const fp = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
  assert.ok(r.stdout.includes(fp), 'fingerprint listed');
  assert.match(r.stdout, /do not screen-record or paste it/);
  assert.match(r.stdout, /\.jsonl:\d+/);
});

test('end to end: secret findings reach the report and no export, in any format, redacted or not', () => {
  // README: "Secret findings are shown as a type and a fingerprint, never as the value, and they
  // never appear in any export or on the card." The canary fixture plants a key, so the local
  // report must carry a finding, and every export format must carry none: an export file is the
  // artifact people paste into an issue or a spreadsheet, and a finding row there announces that
  // a key of a named type exists in a named project, with a fingerprint that confirms a guess.
  const home = tempDir();
  const outDir = tempDir();
  const base = ['--dir', CANARY, '--tz', 'UTC'];

  const report = path.join(outDir, 'report.html');
  let r = runCli([...base, '--no-open', '--out', report], { home });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(report, 'utf8');
  const fingerprints = [...html.matchAll(/"fingerprint12":"([0-9a-f]{12})"/g)].map((m) => m[1]);
  assert.ok(fingerprints.length > 0, 'the local report must still carry the findings; that is the point of the scan');
  assert.ok(!html.includes('sk-ant-api03-CANARY'), 'the report must never carry the value');

  for (const fmt of ['json', 'csv', 'md']) {
    for (const redact of [[], ['--redact']]) {
      const out = path.join(outDir, 'export-' + fmt + redact.length + '.' + fmt);
      const e = runCli(['export', '--' + fmt, ...redact, ...base, '--out', out], { home });
      assert.equal(e.status, 0, e.stderr);
      const text = fs.readFileSync(out, 'utf8');
      const what = fmt + (redact.length ? ' --redact' : '');
      for (const fp of fingerprints) assert.ok(!text.includes(fp), what + ' export carries a secret fingerprint');
      assert.ok(!/fingerprint12/.test(text), what + ' export carries a fingerprint field');
      assert.ok(!/secretType/.test(text), what + ' export carries a secret finding');
      assert.ok(!text.includes('sk-ant-api03-CANARY'), what + ' export carries the value');
      assert.ok(!/likely_fixture|third_party_public/.test(text), what + ' export carries a finding severity');
    }
  }
  // The stub says the data was withheld and where to find it, so a reader is not misled into
  // thinking a clean export means a clean machine.
  const json = JSON.parse(fs.readFileSync(path.join(outDir, 'export-json0.json'), 'utf8'));
  assert.deepEqual(json.insights.i11.data.findings, []);
  assert.equal(json.insights.i11.data.withheld, true);
  assert.match(json.insights.i11.data.note, /not exported/);
});

test('end to end: --redact leaves no custom price file name in the report', () => {
  // The basename of a price file is a name from the user's disk. A redacted report says file
  // names were replaced, so this one has to be replaced too, and with the same stand-in the
  // browser's Share-safe mode uses.
  const home = tempDir();
  const outDir = tempDir();
  const prices = path.join(outDir, 'prices-acme-merger-q4.json');
  writeFile(prices, JSON.stringify({ modelPricing: { 'claude-opus-5': { inputTokens: 0.000015, outputTokens: 0.000075, promptCacheWriteTokens: 0.00001875, promptCacheReadTokens: 0.0000015 } } }));
  const out = path.join(outDir, 'redacted.json');
  const r = runCli(['export', '--json', '--redact', '--dir', PERSONA, '--tz', 'UTC', '--prices', prices, '--out', out], { home });
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!text.includes('acme-merger'), 'the price file name survived --redact');
  const json = JSON.parse(text);
  assert.equal(json.redacted, true);
  assert.equal(json.pricing.custom.fileName, 'custom rates');
  assert.equal(json.pricing.label, 'value at your custom rates');
});

test('end to end: --print-sandbox prints the child command and scans nothing', () => {
  const home = freshHome();
  const r = runCli(['--print-sandbox', '--dir', PERSONA, '--no-open'], { home });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--(experimental-)?permission/);
  assert.match(lines[0], /--allow-fs-read=/);
  assert.match(lines[0], /--allow-fs-write=/);
  assert.ok(lines[0].includes(CHILD_FLAG));
  assert.ok(!/--allow-(net|child-process|worker|addons|wasi)/.test(lines[0]));
  assert.ok(!fs.existsSync(path.join(home, '.auditrail', 'reports')) || fs.readdirSync(path.join(home, '.auditrail', 'reports')).length === 0);
});

test('end to end: no logs found prints a hint and exits 1 without starting a scan', () => {
  const home = freshHome();
  const r = runCli(['--no-open'], { home });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No Claude Code logs found/);
  assert.ok(!r.stdout.includes('scan taken'));
});
