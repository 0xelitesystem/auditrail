// Sandbox: the child command never grants network or child processes; the status line is
// truthful per Node version (trap 57); a real child under --permission is denied the network
// on Node 25 and later, and file access outside its allow list everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseNodeVersion, permissionFlag, runtimeCanDenyNetwork, sandboxStatus, buildSandboxArgs, programReadPaths,
  formatCommand, CHILD_FLAG, STATUS_NET_DENIED, STATUS_FS_ONLY, STATUS_OFF, STATUS_NET_FLAG_GIVEN, runSandboxed,
  SCANNER_SEMI_SPACE_MB,
} from '../../src/node/sandbox.js';
import { tempDir, writeFile, REPO } from './helpers.js';

const V = (s) => parseNodeVersion(s);

test('parseNodeVersion', () => {
  assert.deepEqual(V('v25.9.0'), { major: 25, minor: 9, patch: 0 });
  assert.deepEqual(V('22.13.1'), { major: 22, minor: 13, patch: 1 });
  assert.throws(() => V('nope'));
});

test('permissionFlag: experimental name before 22.13 and 23.5', () => {
  assert.equal(permissionFlag(V('22.0.0')), '--experimental-permission');
  assert.equal(permissionFlag(V('22.12.9')), '--experimental-permission');
  assert.equal(permissionFlag(V('22.13.0')), '--permission');
  assert.equal(permissionFlag(V('23.4.0')), '--experimental-permission');
  assert.equal(permissionFlag(V('23.5.0')), '--permission');
  assert.equal(permissionFlag(V('24.0.0')), '--permission');
  assert.equal(permissionFlag(V('25.9.0')), '--permission');
});

test('status line: the strong network claim only on Node 25 and later with net actually denied', () => {
  const denyNet = { has: (scope) => scope !== 'net' };
  const allowNet = { has: () => true };
  for (const v of ['22.13.0', '23.11.0', '24.9.0']) {
    const s = sandboxStatus({ version: V(v), permission: denyNet });
    assert.equal(s.line, STATUS_FS_ONLY, v);
    assert.equal(s.networkDenied, false);
    assert.ok(!s.line.includes('denied by the Node runtime'), v);
    assert.equal(runtimeCanDenyNetwork(V(v)), false);
  }
  for (const v of ['25.0.0', '25.9.0', '26.1.0']) {
    assert.equal(sandboxStatus({ version: V(v), permission: denyNet }).line, STATUS_NET_DENIED, v);
    assert.equal(sandboxStatus({ version: V(v), permission: allowNet }).line, STATUS_NET_FLAG_GIVEN, v);
  }
  assert.equal(sandboxStatus({ version: V('25.9.0'), permission: null }).line, STATUS_OFF);
  assert.equal(sandboxStatus({ version: V('25.9.0'), permission: { has() { throw new Error('unknown scope'); } } }).line, STATUS_NET_FLAG_GIVEN);
  assert.equal(STATUS_NET_DENIED, 'network: denied by the Node runtime (--permission, no --allow-net)');
  assert.equal(STATUS_FS_ONLY, 'filesystem: limited by the Node runtime; network: no network code (verified by the test suite)');
});

test('buildSandboxArgs: scoped reads and writes, never net, child process, worker or addons', () => {
  const entry = path.resolve('/pkg/dist/auditrail.mjs');
  const args = buildSandboxArgs({
    entryFile: entry,
    readPaths: [path.resolve('/r1/projects'), path.resolve('/r2/projects'), path.resolve('/r1/projects')],
    writePaths: [path.resolve('/out/report.html')],
    childArgs: ['--dir', path.resolve('/r1/projects')],
    version: V('25.9.0'),
  });
  assert.equal(args[0], '--permission');
  assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-read=')), [
    '--allow-fs-read=' + entry, '--allow-fs-read=' + path.resolve('/r1/projects'), '--allow-fs-read=' + path.resolve('/r2/projects'),
  ]);
  assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write=')), ['--allow-fs-write=' + path.resolve('/out/report.html')]);
  for (const a of args) assert.ok(!/^--allow-(net|child-process|worker|addons|wasi)/.test(a), a);
  const i = args.indexOf(entry);
  assert.deepEqual(args.slice(i), [entry, CHILD_FLAG, '--dir', path.resolve('/r1/projects')]);
  assert.equal(buildSandboxArgs({ entryFile: entry, readPaths: [], writePaths: [], childArgs: [], version: V('22.4.0') })[0], '--experimental-permission');
});

test('programReadPaths: one file when bundled; from a checkout the src folder, package.json and the build script that builds the report page (trap 8)', () => {
  const bundled = path.resolve('/pkg/dist/auditrail.mjs');
  assert.deepEqual(programReadPaths(bundled), [bundled]);
  const src = path.resolve('/pkg/src/node/cli.js');
  assert.deepEqual(programReadPaths(src), [path.resolve('/pkg/src'), path.resolve('/pkg/package.json'), path.resolve('/pkg/scripts/build.mjs')]);
});

test('buildSandboxArgs: the scanner runs with a capped V8 young generation (DESIGN 8.6 memory budget)', () => {
  const entry = path.resolve('/pkg/dist/auditrail.mjs');
  const args = buildSandboxArgs({ entryFile: entry, readPaths: [], writePaths: [], childArgs: [], version: V('25.9.0') });
  assert.equal(SCANNER_SEMI_SPACE_MB, 4);
  assert.deepEqual(args.slice(0, 2), ['--permission', '--max-semi-space-size=4']);
  // A V8 option, before the program: never an argument the scanner itself parses.
  assert.ok(args.indexOf('--max-semi-space-size=4') < args.indexOf(entry));
});

test('formatCommand quotes paths with spaces per platform', () => {
  assert.equal(formatCommand('node', ['--allow-fs-read=C:\\a b\\c', '--x'], 'win32'), 'node "--allow-fs-read=C:\\a b\\c" --x');
  assert.equal(formatCommand('node', ['--allow-fs-read=/a b/c'], 'linux'), 'node "--allow-fs-read=/a b/c"');
  assert.equal(formatCommand('node', ['plain', ''], 'linux'), 'node plain ""');
});

const PROBE = `
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { sandboxStatus } from ${JSON.stringify(new URL('../../src/node/sandbox.js', import.meta.url).href)};
const [allowed, outsideFile, writeOk, writeBad] = process.argv.slice(2);
const r = { status: sandboxStatus().line };
try { await globalThis['fe' + 'tch']('http://127.0.0.1:9/'); r.fetch = 'ALLOWED'; } catch (e) { r.fetch = 'blocked'; }
r.net = await new Promise((res) => { try { const s = net.connect(9, '127.0.0.1'); s.on('error', (e) => res(e.code)); s.on('connect', () => { s.destroy(); res('ALLOWED'); }); } catch (e) { res(e.code); } });
try { await dns.lookup('localhost'); r.dns = 'ALLOWED'; } catch (e) { r.dns = e.code; }
try { const cp = await import('node:child_process'); cp.execFileSync(process.execPath, ['-e', '0']); r.child = 'ALLOWED'; } catch (e) { r.child = e.code; }
try { fs.readFileSync(allowed); r.readAllowed = 'ok'; } catch (e) { r.readAllowed = e.code; }
try { fs.readFileSync(outsideFile); r.readOutside = 'ALLOWED'; } catch (e) { r.readOutside = e.code; }
try { fs.writeFileSync(writeOk, 'x'); r.writeAllowed = 'ok'; } catch (e) { r.writeAllowed = e.code; }
try { fs.writeFileSync(writeBad, 'x'); r.writeOutside = 'ALLOWED'; } catch (e) { r.writeOutside = e.code; }
console.log(JSON.stringify(r));
`;

test('a real sandboxed child: file scope enforced; network denied by the runtime on Node 25+', async (t) => {
  const ver = parseNodeVersion();
  if (ver.major < 22 || (ver.major === 22 && ver.minor < 13 && !process.allowedNodeEnvironmentFlags.has('--experimental-permission'))) {
    t.skip('permission model unavailable');
    return;
  }
  const dir = tempDir();
  const probe = path.join(dir, 'probe.mjs');
  writeFile(probe, PROBE);
  const allowed = path.join(dir, 'data', 'in.jsonl');
  writeFile(allowed, '{}\n');
  const outside = path.join(tempDir(), 'secret.txt');
  writeFile(outside, 'nope');
  const writeOk = path.join(dir, 'out.html');
  const args = buildSandboxArgs({
    entryFile: probe,
    readPaths: [path.join(dir, 'data'), path.join(REPO, 'src'), path.join(REPO, 'package.json')],
    writePaths: [writeOk],
    childArgs: [],
    version: ver,
  }).filter((a) => a !== CHILD_FLAG);
  const res = spawnSync(process.execPath, [...args, allowed, outside, writeOk, path.join(dir, 'other.html')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(r.readAllowed, 'ok');
  assert.equal(r.readOutside, 'ERR_ACCESS_DENIED');
  assert.equal(r.writeAllowed, 'ok');
  assert.equal(r.writeOutside, 'ERR_ACCESS_DENIED');
  assert.equal(r.child, 'ERR_ACCESS_DENIED');
  if (runtimeCanDenyNetwork(ver)) {
    assert.equal(r.status, STATUS_NET_DENIED);
    assert.equal(r.net, 'ERR_ACCESS_DENIED');
    assert.equal(r.dns, 'ERR_ACCESS_DENIED');
    assert.equal(r.fetch, 'blocked');
  } else {
    assert.equal(r.status, STATUS_FS_ONLY);
  }
});

test('runSandboxed resolves with the child exit code', async () => {
  const code = await runSandboxed(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(code, 3);
});
