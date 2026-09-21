import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, createJsonlStats, addJsonlStats } from '../../src/core/jsonl.js';
import { streamChunks } from '../../src/core/lines.js';

const enc = new TextEncoder();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

async function parseAll(chunks, opts = {}) {
  const stats = createJsonlStats();
  const records = [];
  for await (const r of readJsonl(chunks, { ...opts, stats })) records.push(r);
  return { stats, records };
}

test('parses objects per line and counts everything', async () => {
  const text = '{"a":1}\n\n   \n{"b":2}\n';
  const { stats, records } = await parseAll([enc.encode(text)]);
  assert.deepEqual(records.map((r) => r.value), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(records.map((r) => r.lineNo), [1, 4]);
  assert.equal(stats.lines, 4);
  assert.equal(stats.records, 2);
  assert.equal(stats.emptyLines, 2);
  assert.equal(stats.bytes, enc.encode(text).length);
});

test('a truncated trailing line is trailingPartial, never a parse error (F06, trap 3)', async () => {
  const { stats, records } = await parseAll([enc.encode('{"a":1}\n{"type":"assistant","message":{"id":"msg_99"')]);
  assert.equal(records.length, 1);
  assert.equal(stats.trailingPartial, 1);
  assert.equal(stats.parseErrors, 0);
});

test('an unterminated but complete last line is parsed and marked unterminated', async () => {
  const { stats, records } = await parseAll([enc.encode('{"a":1}\n{"b":2}')]);
  assert.equal(records.length, 2);
  assert.equal(records[1].terminated, false);
  assert.equal(stats.trailingPartial, 0);
});

test('a broken terminated line is a counted parse error and parsing continues', async () => {
  const { stats, records } = await parseAll([enc.encode('{"a":1}\n{broken\n{"b":2}\n')]);
  assert.equal(stats.parseErrors, 1);
  assert.deepEqual(records.map((r) => r.value), [{ a: 1 }, { b: 2 }]);
});

test('non-object JSON values are skipped and counted unless objectsOnly is false', async () => {
  const text = '1\n"s"\n[1]\nnull\n{"ok":true}\n';
  const a = await parseAll([enc.encode(text)]);
  assert.equal(a.records.length, 1);
  assert.equal(a.stats.nonObjectRecords, 4);
  const b = await parseAll([enc.encode(text)], { objectsOnly: false });
  assert.equal(b.records.length, 5);
});

test('raw U+2028 inside strings gives zero parse errors (F07)', async () => {
  const { stats, records } = await parseAll([enc.encode('{"t":"a\u2028b"}\n{"t":"c\u2029d"}\n')]);
  assert.equal(stats.parseErrors, 0);
  assert.equal(records.length, 2);
});

test('CRLF files parse (F09) and a leading BOM is tolerated', async () => {
  const { stats, records } = await parseAll([new Uint8Array([0xef, 0xbb, 0xbf]), enc.encode('{"a":1}\r\n{"b":2}\r\n')]);
  assert.equal(stats.parseErrors, 0);
  assert.deepEqual(records.map((r) => r.value), [{ a: 1 }, { b: 2 }]);
});

test('invalid UTF-8 is replaced, not fatal', async () => {
  const bytes = new Uint8Array([...enc.encode('{"t":"'), 0xff, 0xfe, ...enc.encode('"}\n')]);
  const { stats, records } = await parseAll([bytes]);
  assert.equal(stats.parseErrors, 0);
  assert.equal(records[0].value.t, '\uFFFD\uFFFD');
});

test('oversize lines are skipped and counted', async () => {
  const { stats, records } = await parseAll([enc.encode('{"a":1}\n{"big":"' + 'x'.repeat(100) + '"}\n{"b":2}\n')], { maxLineBytes: 50 });
  assert.equal(stats.oversizeLines, 1);
  assert.equal(records.length, 2);
  assert.equal(stats.maxLineBytesSeen, 110);
});

test('addJsonlStats sums counters and keeps the max line length', () => {
  const a = createJsonlStats();
  const b = createJsonlStats();
  a.lines = 2; a.maxLineBytesSeen = 10; b.lines = 3; b.maxLineBytesSeen = 7; b.parseErrors = 1;
  addJsonlStats(a, b);
  assert.equal(a.lines, 5);
  assert.equal(a.parseErrors, 1);
  assert.equal(a.maxLineBytesSeen, 10);
});

test('golden-core fixture: line, record and trailing-partial counts (DESIGN 9.2)', async () => {
  const dir = path.join(FIXTURES, 'golden-core', 'projects', '-fake-alpha');
  const main = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  const sub = path.join(dir, main.replace('.jsonl', ''), 'subagents', 'agent-a1.jsonl');
  const m = await parseAll(fs.createReadStream(path.join(dir, main), { highWaterMark: 7 }));
  const s = await parseAll(fs.createReadStream(sub, { highWaterMark: 1 << 20 }));
  assert.deepEqual([m.stats.lines, m.stats.records, m.stats.trailingPartial, m.stats.parseErrors], [11, 10, 1, 0]);
  assert.deepEqual([s.stats.lines, s.stats.records, s.stats.trailingPartial, s.stats.parseErrors], [7, 7, 0, 0]);
});

test('Node stream path and Blob path give identical records on every fixture file (DESIGN 9.8 parity)', async () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsonl/.test(e.name)) files.push(p);
    }
  })(FIXTURES);
  assert.ok(files.length >= 3);
  for (const f of files) {
    const size = fs.statSync(f).size;
    const viaNode = await parseAll(fs.createReadStream(f, { start: 0, end: Math.max(0, size - 1), highWaterMark: 4096 }));
    const blob = new Blob([fs.readFileSync(f)]);
    const viaBlob = await parseAll(streamChunks(blob.stream()));
    assert.deepEqual(viaBlob.records, viaNode.records, f);
    assert.deepEqual(viaBlob.stats, viaNode.stats, f);
  }
});
