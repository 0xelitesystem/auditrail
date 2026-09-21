// Shared helpers for the node team's tests. Temporary folders live under os.tmpdir() and are
// removed when the test process exits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(REPO, 'test', 'fixtures');
export const CLI = path.join(REPO, 'src', 'node', 'cli.js');

const made = [];
process.on('exit', () => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** @returns {string} a fresh empty folder */
export function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-node-'));
  made.push(d);
  return fs.realpathSync.native(d);
}

/**
 * @param {string} p
 * @param {string|Uint8Array} content
 */
export function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * Every string value planted by the canary fixture.
 * @returns {Record<string, string>}
 */
export function canaries() {
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canary', 'expected.json'), 'utf8'));
  return Object.fromEntries(Object.entries(e.canaries).map(([k, v]) => [k, /** @type {any} */ (v).value]));
}

/**
 * Minimal Claude Code path-shape classifier for the node team's unit tests (the real one lives
 * in src/core/adapters/claude-code/shapes.js and is exercised by the end-to-end tests).
 * @param {string} rel
 * @returns {import('../../src/core/adapters/contract.js').FileDecision}
 */
export function classifyStub(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (/\.jsonl(\.superseded-[^/]+)?\.zst$/.test(name)) return { action: 'skip', reason: 'compressed' };
  if (!/\.jsonl$/.test(name) && !/\.jsonl\.superseded-[^/]+$/.test(name)) return { action: 'skip', reason: 'unknown-extension' };
  if (parts.length === 2) return { action: 'read', fileClass: 'main', depth: 0 };
  if (parts.length === 4 && parts[2] === 'subagents') return { action: 'read', fileClass: 'subagent', depth: 1 };
  if (parts.length === 6 && parts[2] === 'subagents' && parts[3] === 'workflows') {
    if (name.startsWith('agent-')) return { action: 'read', fileClass: 'workflow_agent', depth: 2 };
    return { action: 'read', fileClass: 'workflow_journal', depth: 3 };
  }
  return { action: 'skip', reason: 'unknown-shape' };
}
