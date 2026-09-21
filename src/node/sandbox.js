// The scanner sandbox (DESIGN 8.8, traps 8, 57, 61).
//
// The launcher never parses a transcript. It re-executes this same program as a child:
//   node --permission --allow-fs-read=<program> --allow-fs-read=<each root>
//        --allow-fs-read=<settings.json> ... --allow-fs-write=<output file> <program> --ar-scan ...
// with NO --allow-net, NO --allow-child-process, NO --allow-worker, NO --allow-addons.
//
// The status line is printed by the CHILD from what the runtime actually enforces
// (process.permission), never from what the launcher hoped for:
// - Node 25 and later, permission model active, no net permission:
//   "network: denied by the Node runtime (--permission, no --allow-net)"
// - Node 22 to 24 (no network permission exists before v25.0.0):
//   "filesystem: limited by the Node runtime; network: no network code (verified by the test suite)"
// The strong network claim is therefore impossible on Node 22 to 24 (trap 57).

import { spawn } from 'node:child_process';
import path from 'node:path';

/** Internal flag that marks the sandboxed scanner process. */
export const CHILD_FLAG = '--ar-scan';

export const STATUS_NET_DENIED = 'network: denied by the Node runtime (--permission, no --allow-net)';
export const STATUS_FS_ONLY = 'filesystem: limited by the Node runtime; network: no network code (verified by the test suite)';
export const STATUS_NET_FLAG_GIVEN = 'filesystem: limited by the Node runtime; network: not denied (an --allow-net flag is active); no network code (verified by the test suite)';
export const STATUS_OFF = 'sandbox: off (not started with --permission); network: no network code (verified by the test suite)';

/**
 * @typedef {{ major: number, minor: number, patch: number }} NodeVersion
 */

/**
 * @param {string} [v] process.versions.node style ("25.9.0"), with or without a leading "v"
 * @returns {NodeVersion}
 */
export function parseNodeVersion(v = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  if (!m) throw new TypeError('unrecognized Node version: ' + v);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * The permission flag name. It became stable as `--permission` in v23.5.0 and v22.13.0;
 * earlier 22.x and 23.x releases only accept `--experimental-permission`.
 * @param {NodeVersion} ver
 * @returns {'--permission'|'--experimental-permission'}
 */
export function permissionFlag(ver) {
  if (ver.major === 22 && ver.minor < 13) return '--experimental-permission';
  if (ver.major === 23 && ver.minor < 5) return '--experimental-permission';
  return '--permission';
}

/**
 * True when the runtime can deny network access under the permission model (`--allow-net`
 * was added in v25.0.0, nodejs.org/api/cli.html).
 * @param {NodeVersion} ver
 * @returns {boolean}
 */
export function runtimeCanDenyNetwork(ver) {
  return ver.major >= 25;
}

/**
 * @typedef {{ has: (scope: string, reference?: string) => boolean }} PermissionApi
 */

/**
 * The truthful status line for THIS process, from the enforced permission state.
 * @param {{ version?: NodeVersion, permission?: PermissionApi|null|undefined }} [o]
 * @returns {{ line: string, sandboxed: boolean, networkDenied: boolean }}
 */
export function sandboxStatus(o = {}) {
  const ver = o.version ?? parseNodeVersion();
  const perm = 'permission' in o ? o.permission : /** @type {any} */ (process).permission;
  if (!perm || typeof perm.has !== 'function') return { line: STATUS_OFF, sandboxed: false, networkDenied: false };
  if (!runtimeCanDenyNetwork(ver)) return { line: STATUS_FS_ONLY, sandboxed: true, networkDenied: false };
  let netAllowed = true;
  try { netAllowed = perm.has('net'); } catch { netAllowed = true; }
  if (netAllowed) return { line: STATUS_NET_FLAG_GIVEN, sandboxed: true, networkDenied: false };
  return { line: STATUS_NET_DENIED, sandboxed: true, networkDenied: true };
}

/**
 * What the child must be allowed to read to load the program itself. The published program is
 * one bundled file (trap 8: relative ESM imports fail under a scoped read on Windows). Running
 * from a source checkout (src/node/*.js) needs the whole src folder, the package.json that
 * declares "type": "module", and scripts/build.mjs, which builds the report page from src/web
 * on the fly (src/node/dev-template.js; the bundle carries the built page instead).
 * @param {string} entryFile absolute path of the running program
 * @returns {string[]}
 */
export function programReadPaths(entryFile) {
  const dir = path.dirname(entryFile);
  if (path.basename(dir) === 'node' && path.basename(path.dirname(dir)) === 'src') {
    const pkgRoot = path.dirname(path.dirname(dir));
    return [path.join(pkgRoot, 'src'), path.join(pkgRoot, 'package.json'), path.join(pkgRoot, 'scripts', 'build.mjs')];
  }
  return [entryFile];
}

/**
 * @typedef {Object} SandboxSpec
 * @property {string} entryFile        the program to re-execute
 * @property {string[]} readPaths      roots, settings files, stats-cache, price or rules files
 * @property {string[]} writePaths     the report, card or export file, or the ledger folder
 * @property {string[]} childArgs      arguments after CHILD_FLAG
 * @property {NodeVersion} [version]
 */

/**
 * V8 young generation cap for the scanner, in MB per semi-space (DESIGN 8.6 memory budget).
 * The scan keeps much of what it allocates, so V8 grows the young generation to its default
 * maximum on top of the retained data. A 4 MB cap lowers the peak with no measurable change in
 * wall time; smaller caps raise it again (objects are promoted to the old generation early).
 */
export const SCANNER_SEMI_SPACE_MB = 4;

/**
 * Node arguments for the sandboxed child. Deliberately never emits --allow-net,
 * --allow-child-process, --allow-worker, --allow-addons or --allow-wasi.
 * @param {SandboxSpec} spec
 * @returns {string[]}
 */
export function buildSandboxArgs(spec) {
  const ver = spec.version ?? parseNodeVersion();
  const args = [permissionFlag(ver), '--max-semi-space-size=' + SCANNER_SEMI_SPACE_MB];
  const reads = dedupePaths([...programReadPaths(spec.entryFile), ...spec.readPaths]);
  for (const p of reads) args.push('--allow-fs-read=' + p);
  for (const p of dedupePaths(spec.writePaths)) args.push('--allow-fs-write=' + p);
  args.push(spec.entryFile, CHILD_FLAG, ...spec.childArgs);
  return args;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function dedupePaths(list) {
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (typeof p !== 'string' || !p) continue;
    const abs = path.resolve(p);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/**
 * The exact child command as one printable line (for --print-sandbox). Arguments with spaces
 * or shell-special characters are double-quoted.
 * @param {string} execPath
 * @param {string[]} args
 * @param {string} [platform]
 * @returns {string}
 */
export function formatCommand(execPath, args, platform = process.platform) {
  return [execPath, ...args].map((a) => quoteArg(a, platform)).join(' ');
}

/**
 * @param {string} a
 * @param {string} platform
 * @returns {string}
 */
function quoteArg(a, platform) {
  if (a !== '' && /^[A-Za-z0-9_\-.,/:=@%+\\]+$/.test(a)) return a;
  // Windows: backslashes are path separators, only the quote needs doubling-free escaping.
  if (platform === 'win32') return '"' + a.replace(/"/g, '\\"') + '"';
  return '"' + a.replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * Run the sandboxed child with inherited stdio and resolve with its exit code.
 * @param {string} execPath
 * @param {string[]} args
 * @param {{ spawnImpl?: typeof spawn, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<number>}
 */
export function runSandboxed(execPath, args, o = {}) {
  const spawnImpl = o.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(execPath, args, { stdio: 'inherit', windowsHide: true, env: o.env ?? process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
