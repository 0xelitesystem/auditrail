// DESIGN 8.10 layer (b): the no-network interceptor. test/no-net.mjs replaces every Node network
// entry point with a recorder that writes one line to stderr and throws. These tests:
// 1. prove the interceptor catches every API it claims to, in a plain process and in a process
//    under the permission model (so a silent run below is not a vacuous pass);
// 2. run the real CLI, from source and as the built single file, with the interceptor preloaded
//    in the launcher AND in the sandboxed scanner it re-executes, on every command, and assert:
//    both processes armed it, zero network attempts, exit 0 and correct results.
// The sandboxed child inherits NODE_OPTIONS, and may read the preload because a copy sits inside
// one of the scanned roots (the child can read nothing else outside its grants).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { build } from '../../scripts/build.mjs';
import { REPO, FIXTURES, CLI, tempDir } from './helpers.js';
import { parseNodeVersion, runtimeCanDenyNetwork, permissionFlag, STATUS_NET_DENIED } from '../../src/node/sandbox.js';

const PRELOAD = path.join(REPO, 'test', 'no-net.mjs');
const ATTEMPT = 'AW-NO-NET' + ' attempt: ';
const ARMED = 'AW-NO-NET' + ' armed: ';
const NODE = parseNodeVersion();

// The built single file, in the installed layout.
const PKG = tempDir();
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(PKG, 'package.json'));
const BUNDLE = /** @type {string} */ (build({ out: path.join(PKG, 'dist', 'auditrail.mjs'), htmlOut: null }).out);

// A root that holds only a copy of the preload: scanning it finds no logs, and it lets the
// sandboxed child read the preload.
const PRELOAD_ROOT = tempDir();
const PRELOAD_COPY = path.join(PRELOAD_ROOT, 'no-net.mjs');
fs.copyFileSync(PRELOAD, PRELOAD_COPY);

/**
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 */
function node(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'AUDITRAIL_DEBUG']) delete env[k];
  if (!('NODE_OPTIONS' in extraEnv)) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const PROBE = `
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import http from 'node:http';
import https from 'node:https'; import dgram from 'node:dgram'; import { lookup } from 'node:dns';
const tries = {
  fetch: () => fetch('http://127.0.0.1:9/'),
  'net.connect': () => net.connect(9, '127.0.0.1'),
  'net.Socket.prototype.connect': () => new net.Socket().connect(9, '127.0.0.1'),
  'tls.connect': () => tls.connect(9, '127.0.0.1'),
  'dns.lookup': () => dns.lookup('localhost', () => {}),
  'dns.lookup (named import)': () => lookup('localhost', () => {}),
  'dns.resolve4': () => dns.resolve4('localhost', () => {}),
  'dns.promises.resolve': () => dns.promises.resolve('localhost'),
  'http.get': () => http.get('http://127.0.0.1:9/'),
  'https.request': () => https.request('https://127.0.0.1:9/'),
  'dgram.createSocket': () => dgram.createSocket('udp4'),
  WebSocket: () => new WebSocket('ws://127.0.0.1:9/'),
};
const blocked = [];
for (const [name, fn] of Object.entries(tries)) { try { fn(); } catch (e) { if (e.code === 'AR_NO_NET') blocked.push(name); } }
console.log(JSON.stringify(blocked));
`;

test('the interceptor blocks and records every network API, with and without the permission model', () => {
  const dir = tempDir();
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, PROBE);
  const runs = [node(['--import', pathToFileURL(PRELOAD).href, probe])];
  runs.push(node([permissionFlag(NODE), '--allow-fs-read=' + probe, '--allow-fs-read=' + PRELOAD, probe], { NODE_OPTIONS: '--import=' + pathToFileURL(PRELOAD).href }));
  for (const r of runs) {
    assert.equal(r.status, 0, r.stderr);
    const blocked = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(blocked.length, 12, 'blocked: ' + blocked.join(', '));
    assert.equal(r.stderr.split('\n').filter((l) => l.startsWith(ATTEMPT)).length, 12);
  }
});

const COMMANDS = [
  ['report', (out) => ['--out', out + '.html']],
  ['card', (out) => ['card', '--out', out + '.png']],
  ['audit', () => ['audit', '--methods']],
  ['export', (out) => ['export', '--json', '--out', out + '.json']],
  ['secrets', () => ['secrets', '--locations']],
  ['remember', () => ['remember']],
];

for (const [label, program] of [['source', CLI], ['built single file', BUNDLE]]) {
  test('layer (b), ' + label + ': launcher and sandboxed scanner make zero network attempts on every command', () => {
    const root = path.join(FIXTURES, 'golden-core', 'projects');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-core', 'expected.json'), 'utf8'));
    for (const [name, argsFor] of COMMANDS) {
      const dir = tempDir();
      const out = path.join(dir, 'out');
      const r = node([program, ...argsFor(out), '--dir', root, '--dir', PRELOAD_ROOT, '--tz', 'UTC', '--no-open'], {
        HOME: dir, USERPROFILE: dir, NODE_OPTIONS: '--import=' + pathToFileURL(PRELOAD_COPY).href, AR_NO_NET_ANNOUNCE: '1',
      });
      assert.equal(r.status, 0, name + ': ' + r.stderr);
      const lines = r.stderr.split(/\r?\n/);
      assert.deepEqual(lines.filter((l) => l.startsWith(ATTEMPT)), [], name + ': network attempts');
      assert.deepEqual(lines.filter((l) => l.startsWith(ARMED)).sort(), [ARMED + 'launcher', ARMED + 'sandboxed'], name + ': the interceptor was not active in both processes');
      if (runtimeCanDenyNetwork(NODE)) assert.ok(r.stdout.includes(STATUS_NET_DENIED), name + ': status line');
      if (name === 'report') {
        const html = fs.readFileSync(out + '.html', 'utf8');
        const data = JSON.parse(/<script type="application\/json" id="ar-data">([^<]*)<\/script>/.exec(html)[1]);
        assert.equal(String(data.totals.valueNano), String(expected.valueNano));
        assert.equal(data.totals.responses, expected.responses);
      }
      if (name === 'card') assert.deepEqual([...fs.readFileSync(out + '.png').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      if (name === 'export') assert.equal(String(JSON.parse(fs.readFileSync(out + '.json', 'utf8')).totals.valueNano), String(expected.valueNano));
    }
  });
}
