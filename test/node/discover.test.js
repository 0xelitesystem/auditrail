// Discovery: root order (DESIGN 8.5), recursive sorted walk (trap 1), stat-first snapshot
// (rule A28), only projects/ is listed and only two keys are read outside it (trap 5, A27).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  candidateRoots, resolveRoots, configDirOf, configFilesFor, readRetentionEvidence, walkRoots, wslHint, absolutePathOf,
} from '../../src/node/discover.js';
import { tempDir, writeFile, FIXTURES, classifyStub as classifyClaudePath } from './helpers.js';

const HOME = path.resolve('/fake-home');

test('candidateRoots: --dir wins outright, so a fixture run never mixes in the real logs', () => {
  const c = candidateRoots({ dirs: ['a', 'b'], env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: HOME });
  assert.deepEqual(c.map((x) => x.source), ['dir', 'dir']);
  assert.deepEqual(c.map((x) => x.path), [path.resolve('a'), path.resolve('b')]);
});

test('candidateRoots: CLAUDE_CONFIG_DIR, then ~/.claude, then XDG (DESIGN 8.5 order)', () => {
  const c = candidateRoots({ env: { CLAUDE_CONFIG_DIR: path.resolve('/cfg'), XDG_CONFIG_HOME: path.resolve('/xdg') }, home: HOME });
  assert.deepEqual(c.map((x) => x.path), [
    path.join(path.resolve('/cfg'), 'projects'),
    path.join(HOME, '.claude', 'projects'),
    path.join(path.resolve('/xdg'), 'claude', 'projects'),
  ]);
  const d = candidateRoots({ env: {}, home: HOME });
  assert.deepEqual(d.map((x) => x.path), [path.join(HOME, '.claude', 'projects'), path.join(HOME, '.config', 'claude', 'projects')]);
});

test('candidateRoots: the adapter roots list is used for the defaults when given', () => {
  const c = candidateRoots({ env: {}, home: HOME, adapterRoots: [path.resolve('/x/projects')] });
  assert.deepEqual(c.map((x) => x.path), [path.resolve('/x/projects')]);
});

test('resolveRoots: missing --dir is reported, missing defaults are silent, duplicates collapse', () => {
  const dir = tempDir();
  const real = path.join(dir, 'projects');
  fs.mkdirSync(real);
  writeFile(path.join(dir, 'file.txt'), 'x');
  const r = resolveRoots([
    { path: real, source: 'dir' },
    { path: path.join(dir, 'nope'), source: 'dir' },
    { path: path.join(dir, 'file.txt'), source: 'dir' },
    { path: real, source: 'home' },
    { path: path.join(dir, 'absent-default'), source: 'xdg' },
  ]);
  assert.equal(r.roots.length, 1);
  assert.equal(fs.realpathSync.native(real), r.roots[0]);
  assert.deepEqual(r.missingDirs, [path.join(dir, 'nope')]);
  assert.deepEqual(r.notDirectories, [path.join(dir, 'file.txt')]);
});

test('wslHint names the explicit --dir form and probes nothing', () => {
  assert.match(wslHint(), /--dir .*wsl\.localhost/);
});

test('configFilesFor: settings and stats-cache next to a projects root only; history.jsonl never listed', () => {
  const dir = tempDir();
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  writeFile(path.join(cfg, 'settings.json'), '{}');
  writeFile(path.join(cfg, 'settings.local.json'), '{}');
  writeFile(path.join(cfg, 'stats-cache.json'), '{}');
  writeFile(path.join(cfg, 'history.jsonl'), '{}\n');
  const other = path.join(dir, 'elsewhere');
  fs.mkdirSync(other);
  assert.equal(configDirOf(path.join(cfg, 'projects')), cfg);
  assert.equal(configDirOf(other), null);
  const f = configFilesFor([path.join(cfg, 'projects'), other]);
  assert.deepEqual(f.settings, [path.join(cfg, 'settings.json'), path.join(cfg, 'settings.local.json')]);
  assert.deepEqual(f.statsCache, [path.join(cfg, 'stats-cache.json')]);
  assert.ok(![...f.settings, ...f.statsCache].some((p) => p.endsWith('history.jsonl')));
});

test('readRetentionEvidence: one key and one date list, local settings override, junk ignored', () => {
  const files = {
    '/s.json': JSON.stringify({ cleanupPeriodDays: 30, other: 'CANARY-SETTINGS' }),
    '/sl.json': JSON.stringify({ cleanupPeriodDays: 3650 }),
    '/bad.json': '{not json',
    '/stats.json': JSON.stringify({ dailyActivity: [{ date: '2026-05-02', messageCount: 3 }, { date: '2026-05-01' }, { date: 'junk' }, null, { date: '2026-05-02' }], modelUsage: { x: 1 } }),
  };
  const read = (p) => { if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files[p]; };
  const r = readRetentionEvidence({ settings: ['/s.json', '/bad.json', '/sl.json'], statsCache: ['/stats.json', '/missing.json'] }, { readFileSync: read });
  assert.deepEqual(r, { cleanupPeriodDays: 3650, statsCacheDays: ['2026-05-01', '2026-05-02'] });
  assert.deepEqual(Object.keys(r), ['cleanupPeriodDays', 'statsCacheDays']);
  const none = readRetentionEvidence({ settings: ['/bad.json'], statsCache: [] }, { readFileSync: read });
  assert.deepEqual(none, { cleanupPeriodDays: null, statsCacheDays: null });
  const neg = readRetentionEvidence({ settings: ['/n.json'], statsCache: [] }, { readFileSync: () => '{"cleanupPeriodDays":-1}' });
  assert.equal(neg.cleanupPeriodDays, null);
});

test('walkRoots: recursive walk finds every class of the subagent-lead persona (trap 1)', async () => {
  const root = path.join(FIXTURES, 'personas', 'subagent-lead', 'projects');
  const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'personas', 'subagent-lead', 'ground-truth.json'), 'utf8'));
  const w = await walkRoots([root], classifyClaudePath);
  const byClass = { main: 0, subagent: 0, workflow_agent: 0, workflow_journal: 0 };
  for (const f of w.files) byClass[f.fileClass]++;
  assert.deepEqual(byClass, truth.scan.files);
  // Only a minority of files sit at the top level: a non-recursive glob would miss the rest.
  assert.ok(byClass.main < w.files.length / 2);
  for (const f of w.files) assert.equal(f.size, fs.statSync(absolutePathOf([root], f)).size);
  assert.match(w.takenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('walkRoots: deterministic order and idx, unknown files counted and never read', async () => {
  const dir = tempDir();
  const root = path.join(dir, 'projects');
  writeFile(path.join(root, '-p2', 'b.jsonl'), '{}\n');
  writeFile(path.join(root, '-p1', 'z.jsonl'), '{}\n');
  writeFile(path.join(root, '-p1', 'a.jsonl'), '{}\n');
  writeFile(path.join(root, '-p1', 'a', 'subagents', 'agent-x.jsonl'), '{}\n');
  writeFile(path.join(root, '-p1', 'old.jsonl.zst'), 'zz');
  writeFile(path.join(root, '-p1', 'notes.txt'), 'x');
  writeFile(path.join(root, '-p1', 'deep', 'x', 'y', 'z.jsonl'), '{}\n');
  const w = await walkRoots([root], classifyClaudePath, { now: () => Date.UTC(2026, 2, 16, 9) });
  assert.deepEqual(w.files.map((f) => f.relPath), ['-p1/a.jsonl', '-p1/a/subagents/agent-x.jsonl', '-p1/z.jsonl', '-p2/b.jsonl']);
  assert.deepEqual(w.files.map((f) => f.idx), [0, 1, 2, 3]);
  assert.deepEqual(w.files.map((f) => f.fileClass), ['main', 'subagent', 'main', 'main']);
  assert.deepEqual(w.skippedFiles, { compressed: 1, 'unknown-extension': 1, 'unknown-shape': 1 });
  assert.equal(w.takenAt, '2026-03-16T09:00:00.000Z');
});

test('walkRoots: several roots keep rootIdx; the stat size is the snapshot (rule A28)', async () => {
  const a = path.join(tempDir(), 'projects');
  const b = path.join(tempDir(), 'projects');
  writeFile(path.join(a, '-p', 's.jsonl'), '{"a":1}\n');
  writeFile(path.join(b, '-p', 's.jsonl'), '{"b":22}\n');
  const w = await walkRoots([a, b], classifyClaudePath);
  assert.deepEqual(w.files.map((f) => [f.rootIdx, f.relPath, f.size]), [[0, '-p/s.jsonl', 8], [1, '-p/s.jsonl', 9]]);
});

test('walkRoots: symbolic links are never followed', async (t) => {
  const dir = tempDir();
  const root = path.join(dir, 'projects');
  const outside = path.join(dir, 'outside');
  writeFile(path.join(outside, 'x.jsonl'), '{}\n');
  fs.mkdirSync(path.join(root, '-p'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, '-p', 'linked'), 'junction');
  } catch {
    t.skip('this machine cannot create links');
    return;
  }
  const w = await walkRoots([root], classifyClaudePath);
  assert.equal(w.files.length, 0);
  assert.equal(w.symlinksIgnored, 1);
});
