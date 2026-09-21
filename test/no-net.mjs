// No-network interceptor (DESIGN 8.10 layer b). Preload it with
//   node --import ./test/no-net.mjs <program> ...
// or NODE_OPTIONS=--import=<file URL of this file> (the sandboxed child inherits it).
//
// Every way Node code can reach the network is replaced by a recorder that writes one line to
// stderr and throws: net.Socket.prototype.connect, net.connect and net.createConnection,
// tls.connect, dns.lookup and every dns.resolve*, the dns.promises equivalents, http and https
// request and get, dgram.createSocket, globalThis.fetch and globalThis.WebSocket. The test
// asserts that no such line was written. The marker text is built from parts, so a grep for it
// in the program under test never matches this file's own source.

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

export const MARKER = 'AW-NO-NET' + ' attempt: ';

/**
 * @param {string} api
 * @returns {(...args: unknown[]) => never}
 */
function recorder(api) {
  return function blocked() {
    try { process.stderr.write(MARKER + api + '\n'); } catch { /* stderr closed */ }
    const err = new Error('network blocked by test/no-net.mjs: ' + api);
    /** @type {any} */ (err).code = 'AR_NO_NET';
    throw err;
  };
}

/**
 * @param {Record<string, any>} obj
 * @param {string} prefix
 * @param {string[]} names
 */
function block(obj, prefix, names) {
  for (const n of names) {
    if (typeof obj[n] === 'function') obj[n] = recorder(prefix + n);
  }
}

net.Socket.prototype.connect = recorder('net.Socket.prototype.connect');
block(net, 'net.', ['connect', 'createConnection']);
block(tls, 'tls.', ['connect']);
block(dns, 'dns.', Object.keys(dns).filter((k) => k === 'lookup' || k === 'lookupService' || k.startsWith('resolve') || k === 'reverse'));
if (dns.promises) block(dns.promises, 'dns.promises.', Object.keys(dns.promises).filter((k) => k === 'lookup' || k === 'lookupService' || k.startsWith('resolve') || k === 'reverse'));
if (dns.Resolver && dns.Resolver.prototype) block(dns.Resolver.prototype, 'dns.Resolver.prototype.', Object.getOwnPropertyNames(dns.Resolver.prototype).filter((k) => k.startsWith('resolve') || k === 'reverse'));
block(http, 'http.', ['request', 'get']);
block(https, 'https.', ['request', 'get']);
block(dgram, 'dgram.', ['createSocket']);
syncBuiltinESMExports();

globalThis.fetch = /** @type {any} */ (recorder('fetch'));
/** @type {any} */ (globalThis).WebSocket = recorder('WebSocket');
/** @type {any} */ (globalThis).EventSource = recorder('EventSource');

// With AR_NO_NET_ANNOUNCE=1 every process that loaded this file says so once, so a test can prove
// the interceptor was active in both the launcher and the sandboxed scanner it starts.
if (process.env.AR_NO_NET_ANNOUNCE === '1') {
  try { process.stderr.write('AW-NO-NET' + ' armed: ' + (process.permission ? 'sandboxed' : 'launcher') + '\n'); } catch { /* stderr closed */ }
}
