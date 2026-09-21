// Every fixture byte comes from code (DESIGN 9.5): regenerating from the seed must reproduce the
// committed files exactly, and the expected values must match the design's hand-computed tables.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuilders, runBuilder } from '../scripts/gen-synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

test('every builder is deterministic and matches the committed fixtures byte for byte', async () => {
  const builders = await loadBuilders();
  assert.ok(builders.length >= 4, 'golden-core, golden-pricing, canary, personas');
  for (const b of builders) {
    const a = runBuilder(b, 42);
    const again = runBuilder(b, 42);
    assert.deepEqual(a.map((f) => f.rel), again.map((f) => f.rel), b.name);
    for (let i = 0; i < a.length; i++) assert.ok(a[i].bytes.equals(again[i].bytes), b.name + '/' + a[i].rel + ' is not deterministic');
    const dir = path.join(FIXTURES, b.name);
    assert.ok(fs.existsSync(dir), `test/fixtures/${b.name} missing: run node scripts/gen-synthetic.mjs`);
    assert.deepEqual(listFiles(dir), a.map((f) => f.rel), b.name + ': file list differs from the generator');
    for (const f of a) {
      assert.ok(fs.readFileSync(path.join(dir, f.rel)).equals(f.bytes), `${b.name}/${f.rel} differs: run node scripts/gen-synthetic.mjs`);
    }
  }
});

test('a different seed changes the personas (the seed really drives them)', async () => {
  const b = (await loadBuilders()).find((x) => x.name === 'personas');
  const a = runBuilder(b, 42);
  const c = runBuilder(b, 7);
  assert.ok(a.some((f, i) => !c[i] || !f.bytes.equals(c[i].bytes)));
});

test('golden-core expected values are the DESIGN 9.2 and 9.4 hand-computed numbers', () => {
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-core', 'expected.json'), 'utf8'));
  assert.equal(e.responses, 4);
  assert.equal(e.incompleteResponses, 1);
  assert.equal(e.sessions, 1);
  assert.equal(e.scan.trailingPartial, 1);
  assert.equal(e.scan.parseErrors, 0);
  assert.deepEqual(e.tokens, { input: 180, output: 627, cw5m: 1000, cw1h: 2500, cacheRead: 3000 });
  assert.deepEqual(e.responseValueNano, { msg_01: '23500000', msg_02: '13750000', msg_03: '4520000', msg_04: '310000' });
  assert.equal(e.valueNano, '42080000');
  assert.equal(e.valueUsd, '$0.042080');
  assert.deepEqual(e.bucketsNano, { input: '810000', output: '12570000', cw5m: '2500000', cw1h: '25000000', cacheRead: '1200000' });
  assert.deepEqual(e.byClassNano, { main: '37250000', subagent: '4830000', workflow_agent: '0' });
  assert.equal(e.delegationShare.rounded4, 0.1148);
  assert.deepEqual([e.cacheHitRate.num, e.cacheHitRate.den, e.cacheHitRate.rounded4], [3000, 6680, 0.4491]);
  assert.deepEqual([e.tools.calls, e.tools.paired, e.tools.status.shell_exit, e.tools.status.denied, e.tools.status.unpaired, e.tools.status.failed], [4, 3, 1, 1, 1, 0]);
  assert.equal(e.time.activeSeconds, 1260);
  assert.deepEqual(e.time.workBlockSeconds, [60, 1200]);
  assert.equal(e.time.agentSeconds, 1620);
  assert.deepEqual(e.time.agentSecondsByClass, { main: 780, subagent: 840, workflow_agent: 0 });
  const m = Object.fromEntries(Object.entries(e.methods).map(([k, v]) => [k, [v.valueNano, v.ratio]]));
  assert.deepEqual(m, {
    correct: ['42080000', 1], sumEveryLine: ['113495000', 2.697], keepFirstLine: ['29975000', 0.712],
    dedupPerFile: ['55830000', 1.327], allWritesAt5m: ['32705000', 0.777], mainFilesOnly: ['37250000', 0.885],
  });
});

test('golden-pricing expected values are the DESIGN 9.3 numbers', () => {
  const c = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-pricing', 'cases.json'), 'utf8')).cases;
  const by = Object.fromEntries(c.map((x) => [x.id, x.expectedNano]));
  assert.deepEqual(by, {
    R5: '22500000', 'R5-top-level-only': '10000000', R5b: '6500000', R6: '30100000', 'R6-as-fable-5': '105100000',
    R7: '60000000', R8: '33000000', R9: '6000000', R12: '9312500', R13: '6500000', R10: null,
  });
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-pricing', 'expected.json'), 'utf8'));
  assert.equal(e.valueNano, '173912500');
  assert.equal(e.valueUsd, '$0.1739125');
  assert.deepEqual(e.unpriced, [{ model: 'claude-imaginary-9', responses: 1, tokens: 1000 }]);
  assert.deepEqual(e.modifiers, { fast: 1, geoUs: 1, nonStandardTier: 0, ttlEstimated: 1, webSearchRequests: 0 });
  assert.deepEqual(c.find((x) => x.id === 'R12').billedParts[0].tokens, { input: 0, output: 10, cw5m: 250, cw1h: 750, cacheRead: 0 });
});

test('every canary is planted in the canary fixture', () => {
  const e = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canary', 'expected.json'), 'utf8'));
  const text = listFiles(path.join(FIXTURES, 'canary', 'projects')).map((r) => r + '\n' + fs.readFileSync(path.join(FIXTURES, 'canary', 'projects', r), 'utf8')).join('\n');
  for (const [k, c] of Object.entries(e.canaries)) assert.ok(text.includes(c.value), 'canary not planted: ' + k);
});

test('personas carry the traps DESIGN 9.5 asks for', () => {
  const gt = (p) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'personas', p, 'ground-truth.json'), 'utf8'));
  const owl = gt('solo-night-owl');
  const lead = gt('subagent-lead');
  const spend = gt('cache-miss-spender');
  assert.equal(owl.scan.trailingPartial, 1);
  assert.ok(owl.longestStreakDays >= 14 && owl.interrupts >= 1);
  assert.ok(lead.scan.files.workflow_agent > 0 && lead.scan.files.workflow_journal > 0);
  assert.ok(lead.incompleteResponses > 0 && lead.dedup.forkedKeys > 0 && lead.tools.status.unpaired > 0 && lead.tools.status.denied > 0);
  assert.ok(lead.rateLimits.quotaRejectWindows === 2 && lead.rateLimits.synthetic429Lines > 0 && lead.dedup.syntheticLines > 0);
  assert.ok(lead.workflows.failed > 0 && lead.workflows.started > 0);
  assert.deepEqual([spend.modifiers.fast, spend.modifiers.geoUs, spend.modifiers.ttlEstimated, spend.modifiers.webSearchRequests], [1, 1, 1, 2]);
  assert.equal(spend.unpriced.length, 1);
  assert.ok(spend.dedup.forkedKeys > 0, 'superseded copy');
  const files = listFiles(path.join(FIXTURES, 'personas'));
  assert.ok(files.some((f) => /\.jsonl\.superseded-1$/.test(f)));
  assert.ok(files.some((f) => /\/\.orphaned-agent-[^/]+\.jsonl$/.test(f)));
  assert.ok(files.some((f) => /\/workflows\/wf_[^/]+\/journal\.jsonl$/.test(f)));
  const big = files.map((f) => fs.statSync(path.join(FIXTURES, 'personas', f)).size);
  assert.ok(Math.max(...big) > 1_300_000, 'a file with a line over 1.3 MB');
  const crlf = files.filter((f) => f.endsWith('.jsonl')).some((f) => fs.readFileSync(path.join(FIXTURES, 'personas', f)).includes(Buffer.from('}\r\n')));
  assert.ok(crlf, 'a CRLF file');
  const ls = Buffer.from(String.fromCharCode(0x2028), 'utf8');
  assert.ok(files.filter((f) => f.endsWith('.jsonl')).some((f) => fs.readFileSync(path.join(FIXTURES, 'personas', f)).includes(ls)), 'raw U+2028 inside a JSON string');
});
