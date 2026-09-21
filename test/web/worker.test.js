// Drop-mode scanner (src/web/worker.js): what a drop contains, and parity with the CLI path.
// The browser reads dropped files with File.stream(); Node has the same File and web streams,
// so the exact worker code runs here against the synthetic fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planDrop, scanDropped, readRetention, wantedName, workerVersion, isFileReadError, createPathHasher } from '../../src/web/worker.js';
import { claudeCodeAdapter } from '../../src/core/adapters/claude-code/index.js';
import { createAccounting } from '../../src/core/accounting/index.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { createSecretScanner } from '../../src/core/secrets.js';
import { buildSummary } from '../../src/core/summary.js';
import { sha256Hex } from '../../src/core/sha256.js';
import { walkRoots, configFilesFor, readRetentionEvidence } from '../../src/node/discover.js';
import { scanFiles, createPathHasher as nodePathHasher } from '../../src/node/read.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

/** A File-like blob with a name (Node's File has stream(), text(), size). */
const file = (name, text = '{}\n') => new File([text], name);

/**
 * Every file under dir as a drop entry, paths prefixed like a dropped folder.
 * @param {string} dir
 * @param {string} prefix
 */
function dropEntries(dir, prefix) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push({ path: prefix + r, file: wantedName(e.name) ? new File([fs.readFileSync(path.join(d, e.name))], e.name) : null });
    }
  })(dir, '');
  return out;
}

/** The CLI pipeline (src/node/cli.js runScanner) on one projects root, reproducibly. */
async function cliSummary(root) {
  const table = getPriceTable();
  const walk = await walkRoots([root], (rel) => claudeCodeAdapter.classify(rel), { now: () => NOW });
  const acc = createAccounting({ prices: table, tz: 'UTC', idleMinutes: 15, pathStyle: 'auto', overrides: null, projectRules: [], since: null, until: null, methods: false, adapter: claudeCodeAdapter });
  acc.addFiles(walk.files);
  for (const [reason, n] of Object.entries(walk.skippedFiles)) if (n) acc.addSkippedFile(reason, n);
  await scanFiles({ roots: [root], files: walk.files, adapter: claudeCodeAdapter, sink: acc, pathStyle: 'auto', scanSecrets: createSecretScanner({ nowMs: NOW }) });
  const retention = readRetentionEvidence(configFilesFor([root]));
  return buildSummary({
    acc: acc.finish(), prices: table, toolVersion: '0.1.0', scanTakenAt: walk.takenAt, scanSeconds: null,
    options: { tz: 'UTC', idleMinutes: 15, plan: null, redact: false, cleanupPeriodDays: retention.cleanupPeriodDays, statsCacheDays: retention.statsCacheDays, nowMs: NOW, custom: null },
  });
}

const FIXTURE_ROOTS = [
  'golden-core', 'golden-pricing', 'canary', 'personas/solo-night-owl', 'personas/subagent-lead', 'personas/cache-miss-spender',
].map((f) => [f, path.join(FIX, ...f.split('/'), 'projects')]).filter(([, p]) => fs.existsSync(p));

test('parity: the in-page scanner builds the same Summary as the CLI on every synthetic fixture', async () => {
  assert.ok(FIXTURE_ROOTS.length >= 4, 'fixtures missing: run npm run fixtures');
  for (const [name, root] of FIXTURE_ROOTS) {
    const expected = await cliSummary(root);
    const got = await scanDropped({ entries: dropEntries(root, 'projects/'), tz: 'UTC', idleMinutes: 15, nowMs: NOW, takenAtMs: NOW, toolVersion: '0.1.0' });
    got.summary.scan.seconds = null;
    assert.deepEqual(got.summary, expected, name);
    assert.equal(got.receipt.filesRead, expected.scan.filesRead, name + ' files read');
  }
});

test('parity holds when the .claude folder is dropped, and for a renamed copy of the projects folder', async () => {
  const root = path.join(FIX, 'personas', 'subagent-lead', 'projects');
  const expected = await cliSummary(root);
  const asClaude = await scanDropped({ entries: dropEntries(root, '.claude/projects/'), tz: 'UTC', nowMs: NOW, takenAtMs: NOW, toolVersion: '0.1.0' });
  const renamed = await scanDropped({ entries: dropEntries(root, 'backup-copy/'), tz: 'UTC', nowMs: NOW, takenAtMs: NOW, toolVersion: '0.1.0' });
  for (const r of [asClaude, renamed]) {
    r.summary.scan.seconds = null;
    assert.deepEqual(r.summary, expected);
  }
  assert.equal(asClaude.receipt.root, 'projects');
  assert.equal(renamed.receipt.root, 'folder');
});

test('planDrop: the projects root inside a dropped .claude folder; config files beside it; the rest ignored', () => {
  const plan = planDrop([
    { path: '.claude/projects/-fake-a/aaaaaaaa-0000-4000-8000-000000000001.jsonl', file: file('aaaaaaaa-0000-4000-8000-000000000001.jsonl') },
    { path: '.claude/projects/-fake-a/aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-x1.jsonl', file: file('agent-x1.jsonl') },
    { path: '.claude/projects/-fake-a/aaaaaaaa-0000-4000-8000-000000000002.jsonl.zst', file: file('x.jsonl.zst') },
    { path: '.claude/projects/-fake-a/notes.txt', file: null },
    { path: '.claude/settings.json', file: file('settings.json', '{"cleanupPeriodDays": 90}') },
    { path: '.claude/todos/list.json', file: null },
    { path: '.claude/projects/-fake-a/aaaaaaaa-0000-4000-8000-000000000003.jsonl', file: null },
  ]);
  assert.deepEqual(plan.files.map((f) => [f.idx, f.relPath, f.fileClass, f.depth, f.rootIdx]), [
    [0, '-fake-a/aaaaaaaa-0000-4000-8000-000000000001.jsonl', 'main', 0, 0],
    [1, '-fake-a/aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-x1.jsonl', 'subagent', 1, 0],
  ]);
  assert.deepEqual(plan.skippedFiles, { compressed: 1, 'unknown-extension': 1, 'unknown-shape': 0 });
  assert.equal(plan.config.settings.length, 1);
  assert.equal(plan.ignored, 1);
  assert.equal(plan.missing, 1, 'a readable log handed over without its File is counted, never guessed');
  assert.equal(plan.root, 'projects');
  assert.equal(plan.totalBytes, plan.files.reduce((a, f) => a + f.size, 0));
});

test('planDrop: one project folder dropped on its own is read as a project', () => {
  const plan = planDrop([
    { path: '-fake-b/aaaaaaaa-0000-4000-8000-000000000001.jsonl', file: file('a.jsonl') },
    { path: '-fake-b/aaaaaaaa-0000-4000-8000-000000000001/subagents/workflows/run-1/journal.jsonl', file: file('journal.jsonl') },
  ]);
  assert.deepEqual(plan.files.map((f) => f.fileClass), ['main', 'workflow_journal']);
  assert.equal(plan.root, 'folder');
});

test('planDrop: backslash paths, duplicates and empty input', () => {
  const plan = planDrop([
    { path: 'projects\\-fake-c\\aaaaaaaa-0000-4000-8000-000000000001.jsonl', file: file('a.jsonl') },
    { path: 'projects/-fake-c/aaaaaaaa-0000-4000-8000-000000000001.jsonl', file: file('a.jsonl') },
  ]);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].relPath, '-fake-c/aaaaaaaa-0000-4000-8000-000000000001.jsonl');
  assert.equal(planDrop([]).files.length, 0);
  assert.equal(planDrop(null).files.length, 0);
});

test('readRetention: settings.local.json wins, stats-cache dates are kept, junk is ignored', async () => {
  const r = await readRetention({
    settings: [file('settings.json', '{"cleanupPeriodDays": 30, "other": "x"}'), file('settings.local.json', '{"cleanupPeriodDays": 3650}')],
    statsCache: [file('stats-cache.json', '{"dailyActivity":[{"date":"2026-03-02"},{"date":"bad"},{"date":"2026-03-01"}]}')],
  });
  assert.deepEqual(r, { cleanupPeriodDays: 3650, statsCacheDays: ['2026-03-01', '2026-03-02'], seen: true });
  const none = await readRetention({ settings: [file('settings.json', 'not json')], statsCache: [] });
  assert.equal(none.cleanupPeriodDays, null);
  assert.equal(none.statsCacheDays, null);
  const empty = await readRetention({ settings: [], statsCache: [] });
  assert.equal(empty.seen, false);
});

test('an unreadable file is counted and the scan goes on; progress ends at the total', async () => {
  const broken = {
    name: 'aaaaaaaa-0000-4000-8000-00000000000f.jsonl',
    size: 10,
    stream() {
      return new ReadableStream({ pull(c) { const e = new Error('gone'); e.name = 'NotReadableError'; c.error(e); } });
    },
  };
  const entries = [...dropEntries(path.join(FIX, 'golden-core', 'projects'), 'projects/'), { path: 'projects/-fake-z/aaaaaaaa-0000-4000-8000-00000000000f.jsonl', file: broken }];
  const seen = [];
  const r = await scanDropped({ entries, tz: 'UTC', nowMs: NOW, onProgress: (p) => seen.push(p) });
  assert.equal(r.receipt.unreadableFiles, 1);
  assert.ok(r.receipt.filesRead > 0);
  const last = seen[seen.length - 1];
  assert.equal(last.final, true);
  assert.equal(last.bytesDone, last.totalBytes);
  assert.ok(seen.every((p, i) => i === 0 || p.bytesDone >= seen[i - 1].bytesDone), 'progress never goes backwards');
});

test('helpers: wanted names, version fallback, read errors, path hashes match the CLI', () => {
  assert.equal(wantedName('agent-1.jsonl'), true);
  assert.equal(wantedName('x.jsonl.superseded-2'), true);
  assert.equal(wantedName('stats-cache.json'), true);
  assert.equal(wantedName('notes.md'), false);
  assert.equal(workerVersion('1.2.3'), '1.2.3');
  assert.match(workerVersion(), /^\d+\.\d+\.\d+/);
  const e = new Error('x');
  e.name = 'NotFoundError';
  assert.equal(isFileReadError(e), true);
  assert.equal(isFileReadError(new TypeError('bug')), false);
  const h = createPathHasher();
  assert.equal(h('c:/fake/repo/a.js'), nodePathHasher()('c:/fake/repo/a.js'));
  assert.equal(h('c:/fake/repo/a.js'), sha256Hex('c:/fake/repo/a.js'));
});

test('the worker source has no network API and no DOM access', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'web', 'worker.js'), 'utf8');
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /importScripts\s*\(/, /https?:\/\//, /\bdocument\.getElementById/]) {
    assert.doesNotMatch(src, bad);
  }
});
