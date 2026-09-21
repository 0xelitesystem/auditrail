// secrets.js (DESIGN 6 I11, traps 52 to 56). Every fake key below is assembled at run time from
// split literals and a seeded generator, so no key-shaped string exists in this file (the
// fixture guard would refuse it, and so should anyone reading the repo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  scanText, createSecretScanner, groupSecretEvents, shannonEntropy, jwtExpired, sourceOf, PREFILTER_RE, SECRET_TYPES,
  SECRET_TYPE_IDS, MIN_CRITICAL_ENTROPY, secretTypeInfo,
} from '../../src/core/secrets.js';
import { assertEvent } from '../../src/core/adapters/contract.js';
import { readJsonl } from '../../src/core/jsonl.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.UTC(2026, 8, 14);

/** Seeded mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_DIGIT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64 = ALNUM + '+/';
function body(seed, n, alphabet = ALNUM) {
  const r = rng(seed);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fp = (v) => createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 12);

function jwt(payload, seed = 7) {
  return b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload)) + '.' + body(seed, 43, ALNUM + '-_');
}

const pemBody = [body(31, 64, B64), body(32, 64, B64), body(33, 40, B64)];
const PEM_HEAD = '-----BEGIN ' + 'PRIVATE KEY-----';
const PEM_TAIL = '-----END ' + 'PRIVATE KEY-----';

/** One fake per type: [type id, the exact value that must be fingerprinted, the text to scan]. */
function samples() {
  const v = {
    anthropic: ['sk', 'ant', 'api03'].join('-') + '-' + body(1, 93, ALNUM + '-_') + 'AA',
    openai: ['sk', 'proj'].join('-') + '-' + body(2, 48),
    aws: 'AK' + 'IA' + body(3, 16, UPPER_DIGIT),
    github: 'gh' + 'p_' + body(4, 36),
    gitlab: 'gl' + 'pat-' + body(5, 20),
    slack_webhook: 'hooks.slack.com/services/T' + body(6, 9, UPPER_DIGIT) + '/B' + body(7, 9, UPPER_DIGIT) + '/' + body(8, 24),
    slack: 'xo' + 'xb-' + body(9, 12, '0123456789') + '-' + body(10, 24),
    stripe: 'sk' + '_live_' + body(11, 24),
    google: 'AI' + 'za' + body(12, 35, ALNUM + '-_'),
    google_oauth: 'GOC' + 'SPX-' + body(13, 28),
    sendgrid: 'SG' + '.' + body(14, 22) + '.' + body(15, 43),
    huggingface: 'hf' + '_' + body(16, 34),
    npm: 'np' + 'm_' + body(17, 36),
    jwt: jwt({ sub: 'fictional', exp: Math.floor(NOW / 1000) + 86400 }),
    db_url: 'postgres' + '://svc:' + body(18, 20) + '@db.fake.internal:5432',
  };
  const out = Object.entries(v).map(([id, value]) => [id, value, 'config for the fictional service: ' + value + ' end']);
  out.push(['private_key', pemBody.join(''), PEM_HEAD + '\n' + pemBody.join('\n') + '\n' + PEM_TAIL]);
  return out;
}

/** Every 10-character window of a string. */
const windows = (s, n = 10) => Array.from({ length: Math.max(0, s.length - n + 1) }, (_, i) => s.slice(i, i + n));

test('every secret type is detected, typed and fingerprinted as the first 12 hex of SHA-256(value)', () => {
  const seen = new Set();
  for (const [id, value, text] of samples()) {
    assert.ok(PREFILTER_RE.test(text), id + ' passes the pre-filter');
    const f = scanText(text, 'user_text', null, { nowMs: NOW });
    assert.equal(f.length, 1, id + ': ' + JSON.stringify(f));
    assert.deepEqual(Object.keys(f[0]).sort(), ['expired', 'fingerprint12', 'secretType', 'severity', 'source']);
    assert.equal(f[0].secretType, id);
    assert.equal(f[0].fingerprint12, fp(value), id);
    assert.equal(f[0].severity, 'critical', id);
    assert.equal(f[0].source, 'user_text');
    seen.add(id);
  }
  assert.deepEqual([...seen].sort(), [...SECRET_TYPE_IDS].sort(), 'the samples cover every type');
});

test('no finding carries the value or any slice of it (trap 56)', () => {
  for (const [id, value, text] of samples()) {
    for (const where of ['user_text', 'tool_input', 'tool_result']) {
      const json = JSON.stringify(scanText(text, where, 'Bash', { nowMs: NOW }));
      assert.ok(!json.includes(value), id);
      for (const w of windows(value)) assert.ok(!json.includes(w), id + ' leaked a slice');
    }
  }
});

test('findings are valid adapter secret events', () => {
  for (const [, , text] of samples()) {
    for (const f of scanText(text, 'tool_result', 'Read', { nowMs: NOW })) {
      assertEvent({ kind: 'secret', fileIdx: 0, lineNo: 1, ts: NOW, sessionId: 's', ...f });
    }
  }
});

test('severity: context words, entropy, source tiers (DESIGN I11)', () => {
  const key = 'gh' + 'p_' + body(40, 36);
  const sev = (text, where, tool = null) => scanText(text, where, tool, { nowMs: NOW }).map((f) => f.severity);
  assert.deepEqual(sev('token ' + key, 'user_text'), ['critical']);
  assert.deepEqual(sev('here is an example token ' + key, 'user_text'), ['likely_fixture']);
  assert.deepEqual(sev(key + ' '.repeat(149) + 'fixture', 'user_text'), ['likely_fixture'], 'within 150 characters after');
  assert.deepEqual(sev(key + ' '.repeat(151) + 'fixture', 'user_text'), ['critical'], 'beyond 150 characters');
  assert.deepEqual(sev('fixture' + ' '.repeat(145) + key, 'user_text'), ['likely_fixture'], 'a word that ends within 150 characters before counts');
  assert.deepEqual(sev('fixture' + ' '.repeat(151) + key, 'user_text'), ['critical'], 'beyond 150 characters before');
  assert.deepEqual(sev('use the latest token ' + key, 'user_text'), ['critical'], '"latest" is not a context word');
  assert.deepEqual(sev('la' + 'test' + ' '.repeat(146) + key, 'user_text'), ['critical'], '"latest" cut by the window edge is still not a context word');
  assert.deepEqual(sev('unit_test token ' + key, 'user_text'), ['likely_fixture']);
  assert.deepEqual(sev('token ' + key, 'tool_result', 'Read'), ['critical']);
  assert.deepEqual(sev('token ' + key, 'tool_result', 'Bash'), ['critical']);
  assert.deepEqual(sev('token ' + key, 'tool_result', null), ['critical'], 'an unnamed tool result is treated as local');
  assert.deepEqual(sev('token ' + key, 'tool_result', 'mcp__fake__fetch'), ['likely_fixture']);
  assert.deepEqual(sev('token ' + key, 'tool_input', 'Write'), ['likely_fixture'], 'the agent writing a key is a copy, not the source');
  assert.deepEqual(sev('token ' + key, 'tool_result', 'WebFetch'), ['third_party_public']);
  assert.deepEqual(sev('token ' + key, 'tool_result', 'WebSearch'), ['third_party_public']);
  const lowEntropy = 'gh' + 'p_' + 'ab'.repeat(18);
  assert.ok(shannonEntropy(lowEntropy.slice(4)) < MIN_CRITICAL_ENTROPY);
  assert.deepEqual(sev('token ' + lowEntropy, 'user_text'), ['likely_fixture']);
  assert.equal(sourceOf('tool_result', 'WebFetch'), 'tool_result_web');
  assert.equal(sourceOf('tool_result', 'Grep'), 'tool_result_local');
});

test('JWT expiry is decoded locally; an expired token is never critical', () => {
  const past = jwt({ exp: Math.floor(NOW / 1000) - 60 });
  const future = jwt({ exp: Math.floor(NOW / 1000) + 60 });
  const noExp = jwt({ sub: 'fictional' });
  assert.equal(jwtExpired(past, NOW), true);
  assert.equal(jwtExpired(future, NOW), null);
  assert.equal(jwtExpired(noExp, NOW), null);
  const [p] = scanText('Authorization: Bearer ' + past, 'tool_result', 'Bash', { nowMs: NOW });
  assert.deepEqual([p.secretType, p.expired, p.severity], ['jwt', true, 'likely_fixture']);
  const [f] = scanText('Authorization: Bearer ' + future, 'tool_result', 'Bash', { nowMs: NOW });
  assert.deepEqual([f.expired, f.severity], [null, 'critical']);
  // The scan clock is injected: the same token is expired later.
  const later = createSecretScanner({ nowMs: NOW + 120_000 });
  assert.equal(later('Bearer ' + future, 'user_text', null)[0].expired, true);
});

test('PEM: header-only hits are not findings; real and JSON-escaped newlines fingerprint the same body', () => {
  assert.deepEqual(scanText(PEM_HEAD + '\n' + PEM_TAIL, 'user_text', null), []);
  assert.deepEqual(scanText('match the ' + PEM_HEAD + ' header', 'user_text', null), []);
  const real = scanText(PEM_HEAD + '\n' + pemBody.join('\n') + '\n' + PEM_TAIL, 'tool_result', 'Read', { nowMs: NOW });
  const escaped = scanText(PEM_HEAD + '\\n' + pemBody.join('\\n') + '\\n' + PEM_TAIL, 'tool_result', 'Read', { nowMs: NOW });
  const crlf = scanText(PEM_HEAD + '\r\n' + pemBody.join('\r\n') + '\r\n' + PEM_TAIL, 'tool_result', 'Read', { nowMs: NOW });
  assert.equal(real.length, 1);
  assert.equal(real[0].fingerprint12, fp(pemBody.join('')));
  assert.equal(escaped[0].fingerprint12, real[0].fingerprint12);
  assert.equal(crlf[0].fingerprint12, real[0].fingerprint12);
});

test('database URLs: template passwords are not findings', () => {
  for (const pw of ['${DB_PASSWORD}', '<password>', '****', '%s', '{{secret}}', 'xxxx']) {
    assert.deepEqual(scanText('postgres' + '://app:' + pw + '@db.fake.internal/app', 'user_text', null), [], pw);
  }
  const [f] = scanText('mongodb+srv' + '://app:' + body(50, 24) + '@cluster0.fake.internal', 'user_text', null, { nowMs: NOW });
  assert.equal(f.secretType, 'db_url');
});

test('texts without any hint are rejected by the pre-filter; copies in one text are all counted', () => {
  assert.deepEqual(scanText('an ordinary sentence about a fictional project', 'user_text', null), []);
  assert.equal(PREFILTER_RE.test('an ordinary sentence'), false);
  assert.deepEqual(scanText('', 'user_text', null), []);
  assert.deepEqual(scanText(/** @type {any} */ (null), 'user_text', null), []);
  const k = 'hf' + '_' + body(60, 34);
  const two = scanText(k + ' and again ' + k, 'user_text', null, { nowMs: NOW });
  assert.equal(two.length, 2);
  assert.equal(two[0].fingerprint12, two[1].fingerprint12);
  // Vendor prefixes glued to other identifiers are not matches.
  assert.deepEqual(scanText('xAK' + 'IA' + body(61, 16, UPPER_DIGIT), 'user_text', null), []);
});

test('adversarial inputs finish quickly (no catastrophic backtracking)', () => {
  const inputs = [
    PEM_HEAD + '\n' + 'A'.repeat(300_000),
    'postgres' + '://' + 'a:'.repeat(100_000),
    'eyJ'.repeat(100_000),
    'AK' + 'IA'.repeat(100_000),
    ['sk', 'ant', 'api03'].join('-') + '-' + '-'.repeat(200_000),
    ('SG' + '.').repeat(50_000),
    'hooks.slack.com/services/T'.repeat(20_000),
  ];
  const t0 = Date.now();
  for (const s of inputs) scanText(s, 'tool_result', 'Bash', { nowMs: NOW });
  assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
});

test('groupSecretEvents: copies across files, newest copy, most severe copy, projects, order', () => {
  const ev = (o) => ({ fileIdx: 0, lineNo: 1, ts: NOW, sessionId: 's', secretType: 'github', fingerprint12: '0123456789ab', severity: 'likely_fixture', source: 'tool_input', expired: null, ...o });
  const events = [
    ev({ fileIdx: 0, ts: NOW - 1000 }),
    ev({ fileIdx: 1, ts: NOW, severity: 'critical', source: 'tool_result_local', project: '/fake/alpha' }),
    ev({ fileIdx: 1, ts: NOW - 5, severity: 'critical', source: 'user_text', project: '/fake/beta' }),
    ev({ fingerprint12: 'ffffffffffff', secretType: 'jwt', severity: 'third_party_public', source: 'tool_result_web', expired: true, ts: NOW + 5 }),
    ev({ fingerprint12: 'NOT-HEX', severity: 'critical' }),
    ev({ severity: 'catastrophic' }),
  ];
  const g = groupSecretEvents(events, { projectKeyOf: (e) => e.project ?? null });
  assert.equal(g.length, 2);
  assert.deepEqual(g[0], {
    secretType: 'github', fingerprint12: '0123456789ab', severity: 'critical', source: 'user_text', copies: 3, files: 2,
    newestTs: NOW, expired: null, projectKeys: ['/fake/alpha', '/fake/beta'],
  });
  assert.deepEqual([g[1].secretType, g[1].severity, g[1].expired, g[1].copies], ['jwt', 'third_party_public', true, 1]);
  assert.deepEqual(groupSecretEvents([...events].reverse(), { projectKeyOf: (e) => e.project ?? null }), g, 'order independent');
});

test('report copy for every type has a label and plain-words rotation advice, no URL', () => {
  for (const t of SECRET_TYPES) {
    const info = secretTypeInfo(t.id);
    assert.ok(info.label && info.rotate, t.id);
    assert.ok(!/https?:\/\//.test(info.rotate + info.label), t.id + ': no URL in report copy');
  }
  assert.equal(secretTypeInfo('unknown').label, 'Secret');
});

test('canary fixture: the planted key is found in the Bash output, critical, and nothing else fires', async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/canary/expected.json'), 'utf8'));
  const dir = path.join(ROOT, 'test/fixtures/canary/projects');
  const file = fs.readdirSync(dir, { recursive: true }).map(String).find((p) => p.endsWith('.jsonl'));
  const scan = createSecretScanner({ nowMs: NOW });
  const names = new Map();
  const findings = [];
  for await (const { value: rec } of readJsonl([fs.readFileSync(path.join(dir, file))])) {
    const content = rec.message && rec.message.content;
    if (rec.type === 'user' && typeof content === 'string') findings.push(...scan(content, 'user_text', null));
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && rec.type === 'user') findings.push(...scan(b.text, 'user_text', null));
      if (b.type === 'tool_use') {
        names.set(b.id, b.name);
        for (const v of Object.values(b.input || {})) if (typeof v === 'string') findings.push(...scan(v, 'tool_input', b.name));
      }
      if (b.type === 'tool_result') findings.push(...scan(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 'tool_result', names.get(b.tool_use_id) ?? null));
    }
  }
  const secret = expected.canaries.secret.value;
  assert.deepEqual(findings, [{ secretType: 'anthropic', fingerprint12: fp(secret), severity: 'critical', source: 'tool_result_local', expired: null }]);
  const json = JSON.stringify(findings);
  for (const c of Object.values(expected.canaries)) assert.ok(!json.includes(c.value), 'canary in findings');
});
