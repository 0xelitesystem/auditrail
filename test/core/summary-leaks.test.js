// findSummaryLeaks under --redact (src/core/summary.js): a short project label that equals one of
// the Summary's own field names is not a leak (a project named "pricing" made --redact fail on
// the golden-pricing fixture), while a label in a string value, or a long label inside a key,
// still is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findSummaryLeaks } from '../../src/core/summary.js';
import { toolNameClass } from '../../src/core/constants.js';
import path from 'node:path';
import { buildSummary, FIXED_COPY } from '../../src/core/summary.js';
import { getPriceTable } from '../../src/core/prices/index.js';
import { ACTION_HISTORY } from '../../src/core/insights/i12-history.js';
import { ACTION_RECEIPTS } from '../../src/core/insights/i14-receipts.js';
import { ACTION_SECRETS } from '../../src/core/insights/i11-secrets.js';
import { ACTION_WORKFLOWS } from '../../src/core/insights/i10-workflows.js';
import { runPipeline, FIXTURES } from '../accounting/_harness.js';

const acc = (label) => ({ files: [], byProject: [{ label, projectKey: 'key-not-in-summary' }], bySession: [], responses: [], tools: [], secrets: [], unpriced: [] });

test('a short label equal to a schema field name is not a leak', () => {
  const summary = { redacted: true, pricing: { label: 'API-equivalent value' }, scan: {}, totals: {} };
  assert.deepEqual(findSummaryLeaks(summary, acc('pricing')), []);
  assert.deepEqual(findSummaryLeaks(summary, acc('scan')), []);
});

test('the same label as a string value is still a leak', () => {
  const summary = { redacted: true, pricing: {}, insights: { i01: { data: { byProject: [{ label: 'pricing' }] } } } };
  assert.deepEqual(findSummaryLeaks(summary, acc('pricing')), [{ category: 'project label', path: '$.insights.i01.data.byProject[0].label' }]);
});

test('a long label inside a key is still a leak', () => {
  const summary = { redacted: true, byName: { 'client-portal-v2': 1 } };
  assert.deepEqual(findSummaryLeaks(summary, acc('client-portal-v2')), [{ category: 'project label', path: '$.byName{key}' }]);
});

// The leak check looks each window of a string up in one needle map instead of testing every
// string against every needle. The reference below is the previous quadratic check, kept verbatim
// as an oracle: the fast check must report the same paths with the same categories on every input.

function referenceLeaks(summary, acc) {
  const out = [];
  const add = (category, v, min = 6) => { if (typeof v === 'string' && v.length >= min) out.push({ category, value: v, exact: false }); };
  const exact = (category, v) => { if (typeof v === 'string' && v.length > 0) out.push({ category, value: v, exact: true }); };
  for (const f of acc.files || []) {
    add('log path', f.relPath, 8);
    add('encoded project folder', typeof f.relPath === 'string' ? f.relPath.split('/')[0] : '', 8);
  }
  for (const p of acc.byProject || []) add('project key', p.projectKey, 6);
  for (const s of acc.bySession || []) { add('session id', s.sessionId, 8); add('launch folder', s.launchFolder, 6); }
  for (const r of acc.responses || []) { add('session id', r.sessionId, 8); add('project key', r.projectKey, 6); }
  for (const t of acc.tools || []) { add('file path hash', t.filePathHash, 16); add('tool call id', t.id, 12); }
  for (const s of acc.secrets || []) for (const k of s.projectKeys || []) add('project key', k, 6);
  if (summary && summary.redacted) {
    for (const p of acc.byProject || []) { exact('project label', p.label); add('project label', p.label, 8); }
    for (const t of acc.tools || []) {
      exact('file label', t.fileLabel); add('file label', t.fileLabel, 8);
      if (toolNameClass(t.name) !== 'builtin') { exact('tool name', t.name); add('tool name', t.name, 8); }
    }
    for (const r of acc.responses || []) {
      const a = r.attribution;
      if (a) for (const k of ['agent', 'skill', 'mcpServer', 'plugin']) { exact('attribution name', a[k]); add('attribution name', a[k], 8); }
    }
    for (const u of acc.unpriced || []) { exact('unpriced model id', u.model); add('unpriced model id', u.model, 8); }
  }
  if (!out.length) return [];
  const lowerSubs = out.filter((n) => !n.exact).map((n) => ({ category: n.category, value: n.value.toLowerCase() }));
  const exacts = new Map();
  for (const n of out) if (n.exact) exacts.set(n.value, n.category);
  const hits = [];
  const seen = new Set();
  const check = (str, path, isKey = false) => {
    const cat = isKey ? undefined : exacts.get(str);
    if (cat && !seen.has(path)) { seen.add(path); hits.push({ category: cat, path }); return; }
    const low = str.toLowerCase();
    for (const n of lowerSubs) {
      if (low.includes(n.value)) { if (!seen.has(path)) { seen.add(path); hits.push({ category: n.category, path }); } return; }
    }
  };
  (function walk(v, path) {
    if (typeof v === 'string') { check(v, path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { check(k, path + '{key}', true); walk(x, path + '.' + k); }
  })(summary, '$');
  return hits;
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic AccountingResult with every needle category, lengths straddling each minimum. */
function syntheticAcc(rand, n) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const word = (min, max) => {
    const len = min + Math.floor(rand() * (max - min + 1));
    let s = '';
    for (let i = 0; i < len; i++) s += pick('abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789-_./');
    return s;
  };
  const acc = { files: [], byProject: [], bySession: [], responses: [], tools: [], secrets: [], unpriced: [] };
  for (let i = 0; i < n; i++) {
    acc.files.push({ relPath: '-fake-p' + word(2, 9) + '/' + word(4, 12) + '.jsonl' });
    acc.byProject.push({ projectKey: word(3, 10), label: word(4, 10) });
    acc.bySession.push({ sessionId: word(6, 12), launchFolder: word(4, 9) });
    acc.responses.push({ sessionId: word(6, 12), projectKey: word(4, 9), attribution: rand() < 0.5 ? { agent: word(4, 10), skill: null, mcpServer: word(6, 11), plugin: undefined } : null });
    acc.tools.push({ id: 'toolu_' + word(4, 10), filePathHash: word(14, 18), fileLabel: word(5, 10), name: rand() < 0.5 ? 'Read' : 'mcp__' + word(2, 6) });
    acc.secrets.push({ projectKeys: [word(4, 8)] });
    acc.unpriced.push({ model: word(5, 10) });
  }
  return acc;
}

/** Every needle-bearing string of an acc, so summaries can plant them. */
function allStrings(acc) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v) out.push(v); };
  for (const f of acc.files) { push(f.relPath); push(f.relPath.split('/')[0]); }
  for (const p of acc.byProject) { push(p.projectKey); push(p.label); }
  for (const s of acc.bySession) { push(s.sessionId); push(s.launchFolder); }
  for (const r of acc.responses) { push(r.sessionId); push(r.projectKey); if (r.attribution) { push(r.attribution.agent); push(r.attribution.mcpServer); } }
  for (const t of acc.tools) { push(t.id); push(t.filePathHash); push(t.fileLabel); push(t.name); }
  for (const s of acc.secrets) for (const k of s.projectKeys) push(k);
  for (const u of acc.unpriced) push(u.model);
  return out;
}

function plantedSummary(rand, acc, redacted) {
  const strings = allStrings(acc);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const recase = (s) => [...s].map((c) => (rand() < 0.3 ? c.toUpperCase() : rand() < 0.3 ? c.toLowerCase() : c)).join('');
  const filler = () => pick(['', 'x', 'value ', 'Project A', 'at list price ', '1234567890', 'see ']);
  const value = () => {
    const r = rand();
    if (r < 0.25) return pick(strings);                                      // exact text
    if (r < 0.5) return filler() + recase(pick(strings)) + filler();         // inside, other case
    if (r < 0.6) return pick(strings).slice(1);                              // a near miss
    if (r < 0.7) return filler() + pick(strings) + pick(strings) + filler(); // two needles, one string
    return filler() + filler();
  };
  const summary = { redacted, pricing: { label: 'API-equivalent value' }, insights: {} };
  for (let i = 0; i < 40; i++) {
    const obj = {};
    for (let j = 0; j < 6; j++) obj[rand() < 0.15 ? value() : 'field' + j] = rand() < 0.3 ? [value(), { label: value() }, 7] : value();
    summary.insights['i' + i] = { data: obj, action: value() };
  }
  return summary;
}

test('the fast leak check reports exactly what the reference check reports (300 random planted summaries)', () => {
  const rand = rng(0x5eed);
  let leaksSeen = 0;
  for (let round = 0; round < 300; round++) {
    const acc = syntheticAcc(rand, 1 + Math.floor(rand() * 25));
    const summary = plantedSummary(rand, acc, round % 2 === 0);
    const want = referenceLeaks(summary, acc);
    assert.deepEqual(findSummaryLeaks(summary, acc), want, 'round ' + round);
    leaksSeen += want.length;
  }
  assert.ok(leaksSeen > 1000, 'the planted summaries must actually carry leaks (' + leaksSeen + ')');
});

test('a single planted tool-call id among 60,000 is caught, in any case, inside a long string or a key', () => {
  const acc = { files: [], byProject: [], bySession: [], responses: [], tools: [], secrets: [], unpriced: [] };
  for (let i = 0; i < 60_000; i++) acc.tools.push({ id: 'toolu_' + String(i).padStart(8, '0') + 'AbCdEfGh', name: 'Read', filePathHash: null, fileLabel: null });
  const needle = acc.tools[41_234].id;
  const long = 'x'.repeat(5_000) + needle.toUpperCase() + 'y'.repeat(5_000);
  const clean = { redacted: false, insights: { i07: { data: { byTool: [{ name: 'Read', note: 'x'.repeat(10_000) }] } } } };
  assert.deepEqual(findSummaryLeaks(clean, acc), []);
  const planted = { redacted: false, insights: { i07: { data: { byTool: [{ name: 'Read', note: long }] } } } };
  assert.deepEqual(findSummaryLeaks(planted, acc), [{ category: 'tool call id', path: '$.insights.i07.data.byTool[0].note' }]);
  const inKey = { redacted: false, insights: { i07: { data: { ['k-' + needle.toLowerCase()]: 1 } } } };
  assert.deepEqual(findSummaryLeaks(inKey, acc), [{ category: 'tool call id', path: '$.insights.i07.data{key}' }]);
  // One character short of the id is not the id.
  assert.deepEqual(findSummaryLeaks({ redacted: false, note: needle.slice(0, -1) }, acc), []);
});

test('when a string holds two needles the category is the one collected first, as before', () => {
  const acc = { files: [], byProject: [], bySession: [{ sessionId: 'sess-00000001', launchFolder: null }], responses: [], tools: [{ id: 'toolu_0000000001', name: 'Read', filePathHash: null, fileLabel: null }], secrets: [], unpriced: [] };
  const summary = { redacted: false, note: 'toolu_0000000001 then sess-00000001' };
  assert.deepEqual(findSummaryLeaks(summary, acc), [{ category: 'session id', path: '$.note' }]);
  assert.deepEqual(findSummaryLeaks(summary, acc), referenceLeaks(summary, acc));
});

// Program text in the Summary (FIXED_COPY): a private string found only inside the program's own
// words is not a leak. The case that exposed it, under --redact: a hot file labelled
// ".claude/settings.json" (any user whose agent edits its own settings) matched the retention
// advice of I12 and aborted the report.

const redactedAcc = ({ labels = [], fileLabels = [] } = {}) => ({
  files: [], bySession: [], responses: [], secrets: [], unpriced: [],
  byProject: labels.map((label, i) => ({ label, projectKey: 'key-' + i + '-not-in-summary' })),
  tools: fileLabels.map((fileLabel, i) => ({ id: 'toolu_fixedcopy_' + i, name: 'Edit', filePathHash: null, fileLabel })),
});

test('a file label inside the I12 retention advice is program text; the same label as a hot file is a leak', () => {
  const acc = redactedAcc({ fileLabels: ['.claude/settings.json'] });
  assert.ok(ACTION_HISTORY.includes('.claude/settings.json'), 'the advice names the settings file');
  const clean = { redacted: true, insights: { i12: { action: ACTION_HISTORY }, i08: { data: { top: [{ label: 'File A' }] } } } };
  assert.deepEqual(findSummaryLeaks(clean, acc), []);
  const leaked = { redacted: true, insights: { i12: { action: ACTION_HISTORY }, i08: { data: { top: [{ label: '.claude/settings.json' }] } } } };
  assert.deepEqual(findSummaryLeaks(leaked, acc), [{ category: 'file label', path: '$.insights.i08.data.top[0].label' }]);
  // A second copy of the label next to the advice, outside it, is still found.
  const twice = { redacted: true, note: ACTION_HISTORY + ' see .claude/settings.json' };
  assert.deepEqual(findSummaryLeaks(twice, acc), [{ category: 'file label', path: '$.note' }]);
});

test('a project named after the product: kind, tool name and copy are program text, its label is not', () => {
  const acc = redactedAcc({ labels: ['auditrail'] });
  const clean = { redacted: true, kind: 'auditrail.summary', tool: { name: 'auditrail' }, insights: { i14: { action: ACTION_RECEIPTS }, i11: { action: ACTION_SECRETS + ' Critical copies on disk: 2.' } } };
  assert.deepEqual(findSummaryLeaks(clean, acc), []);
  const leaked = { ...clean, insights: { ...clean.insights, i01: { data: { byProject: [{ label: 'auditrail' }] } } } };
  assert.deepEqual(findSummaryLeaks(leaked, acc), [{ category: 'project label', path: '$.insights.i01.data.byProject[0].label' }]);
});

test('an occurrence that reaches past a fixed phrase is still a leak', () => {
  // The needle starts inside the I10 action and ends in text that follows it.
  const acc = redactedAcc({ labels: ['fail often.x-client'] });
  const summary = { redacted: true, note: ACTION_WORKFLOWS + 'x-client' };
  assert.ok(ACTION_WORKFLOWS.endsWith('fail often.'));
  assert.deepEqual(findSummaryLeaks(summary, acc), [{ category: 'project label', path: '$.note' }]);
  // Program text only where the whole phrase is present: a fragment of it is not exempt.
  const fragment = redactedAcc({ labels: ['workflows'] });
  assert.deepEqual(findSummaryLeaks({ redacted: true, action: ACTION_WORKFLOWS }, fragment), []);
  assert.deepEqual(findSummaryLeaks({ redacted: true, note: 'the workflows of the week' }, fragment), [{ category: 'project label', path: '$.note' }]);
});

test('a project named like a built-in tool: the tool row is program text, the project row is a leak', () => {
  const acc = redactedAcc({ labels: ['Read'] });
  const summary = { redacted: true, insights: { i07: { data: { byTool: [{ name: 'Read', displayName: 'Read' }], flagged: ['Read'] } } } };
  assert.deepEqual(findSummaryLeaks(summary, acc), []);
  summary.insights.i01 = { data: { byProject: [{ label: 'Read' }] } };
  assert.deepEqual(findSummaryLeaks(summary, acc), [{ category: 'project label', path: '$.insights.i01.data.byProject[0].label' }]);
});

test('FIXED_COPY covers every action and evidence unit the insights write on every fixture', async () => {
  const roots = ['golden-core', 'golden-pricing', 'canary', 'personas/cache-miss-spender', 'personas/solo-night-owl', 'personas/subagent-lead'];
  const fixed = new Set(FIXED_COPY);
  let seen = 0;
  for (const r of roots) {
    const { result } = await runPipeline(path.join(FIXTURES, ...r.split('/'), 'projects'));
    for (const redact of [false, true]) {
      const s = buildSummary({ acc: result, prices: getPriceTable(), toolVersion: '0.0.0-test', scanTakenAt: '2026-01-01T00:00:00.000Z', options: { tz: 'UTC', redact, nowMs: Date.parse('2026-09-15T00:00:00Z') } });
      for (const [id, ins] of Object.entries(s.insights)) {
        const action = /** @type {any} */ (ins).action;
        if (typeof action === 'string' && action) {
          const base = action.replace(/ Critical copies on disk: \d+\.$/, '');
          assert.ok(fixed.has(base), r + ' ' + id + ' action is not in FIXED_COPY');
          seen++;
        }
        const ev = /** @type {any} */ (ins).evidence;
        if (ev) { assert.ok(fixed.has(ev.unit), r + ' ' + id + ' evidence unit is not in FIXED_COPY: ' + ev.unit); seen++; }
      }
    }
  }
  assert.ok(seen > 100, 'actions and units checked: ' + seen);
});
