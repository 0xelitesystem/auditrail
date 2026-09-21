// Cross-implementation check (DESIGN 9.6): the stdlib Python oracle must reproduce every
// expected value of every generated fixture, to the token and the nanodollar. The same
// expected files are the acceptance test for the JavaScript accounting.
//
// Python is found via AR_PYTHON, then python3, then python. Without Python the test is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = path.join(HERE, 'ar_oracle.py');
const FIXTURES = path.resolve(HERE, '..', 'fixtures');

function findPython() {
  for (const cand of [process.env.AR_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 311) return cand;
  }
  return null;
}
const PYTHON = findPython();

/** Fixtures that carry an expected file the oracle can check: [label, projects dir, expected file]. */
function cases() {
  const out = [];
  for (const name of ['golden-core', 'golden-pricing']) {
    out.push([name, path.join(FIXTURES, name, 'projects'), path.join(FIXTURES, name, 'expected.json')]);
  }
  const personas = path.join(FIXTURES, 'personas');
  if (fs.existsSync(personas)) {
    for (const p of fs.readdirSync(personas).sort()) {
      out.push(['personas/' + p, path.join(personas, p, 'projects'), path.join(personas, p, 'ground-truth.json')]);
    }
  }
  return out;
}

/** Values the oracle does not compute, or that use a different shape on purpose. */
const NOT_COMPARED = new Set(['fixture', 'description', 'tz', 'idleMinutes', 'valueUsd', 'incompleteShare', 'cacheWriteTotal', 'responseClass',
  'responseComplete', 'delegationShare', 'cacheHitRate', 'coverage', 'recordsByClass', 'counterfactualNano', 'methods', 'okEditNewLines']);

/**
 * Compare every key of `want` that the oracle also reports.
 * @returns {string[]} mismatches
 */
function compare(want, got, at = '$', out = []) {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    for (const k of Object.keys(want)) {
      if (NOT_COMPARED.has(k) && at === '$') continue;
      if (got === null || typeof got !== 'object' || !(k in got)) continue;
      compare(want[k], got[k], at + '.' + k, out);
    }
    return out;
  }
  if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${at}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  return out;
}

for (const [label, projects, expectedFile] of cases()) {
  test('oracle reproduces ' + label, { skip: PYTHON ? false : 'no Python 3.11+ found (set AR_PYTHON)' }, () => {
    const r = spawnSync(PYTHON, [ORACLE, projects, '--tz', 'UTC', '--idle-minutes', '15'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    const want = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    const mismatches = compare(want, got);
    assert.deepEqual(mismatches, []);
    // Money is checked as a whole too, independent of which sub-keys exist.
    assert.equal(got.valueNano, want.valueNano);
    assert.equal(got.responses, want.responses);
    if (want.methods) {
      for (const [k, v] of Object.entries(want.methods)) assert.equal(got.methods[k], v.valueNano, 'method ' + k);
    }
    if (want.delegationShare && want.delegationShare.numNano) assert.equal(got.sidechainNano, want.delegationShare.numNano);
    if (want.tools && want.tools.okEditNewLines !== undefined) assert.equal(got.tools.okEditNewLines, want.tools.okEditNewLines);
  });
}
