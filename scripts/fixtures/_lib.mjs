// Shared helpers for fixture builders (dev only). Every byte of every fixture comes from code.
// All content is fictional: sessions like aaaaaaaa-0000-4000-8000-000000000001, projects like
// -fake-alpha, paths under /fake/.

/**
 * Seeded PRNG (mulberry32). Returns floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit FNV-1a of a string, to derive per-builder seeds.
 * @param {string} s
 * @returns {number}
 */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Serialize records as JSONL: one JSON.stringify per line, "\n" after every line.
 * @param {unknown[]} records
 * @returns {string}
 */
export function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/**
 * ISO timestamp with milliseconds and Z, from epoch ms.
 * @param {number} ms
 * @returns {string}
 */
export function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Epoch ms for a UTC wall time.
 * @param {number} y @param {number} mo 1-12 @param {number} d @param {number} h @param {number} mi @param {number} s
 * @returns {number}
 */
export function utc(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * Claude Code usage block (the raw on-disk shape).
 * @param {number} input
 * @param {number} cw5m
 * @param {number} cw1h
 * @param {number} read
 * @param {number} output
 * @returns {Record<string, unknown>}
 */
export function usage(input, cw5m, cw1h, read, output) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cw5m + cw1h,
    cache_read_input_tokens: read,
    output_tokens: output,
    cache_creation: { ephemeral_5m_input_tokens: cw5m, ephemeral_1h_input_tokens: cw1h },
  };
}

/**
 * Deterministic fake session id: aaaaaaaa-0000-4000-8000-<12 digits>.
 * @param {number} n
 * @param {string} [prefix] 8 lowercase hex characters
 * @returns {string}
 */
export function fakeSessionId(n, prefix = 'aaaaaaaa') {
  return prefix + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

/** Integer rate table (milli-dollars per MTok) for the models fixtures use. Mirrors DESIGN 5.3. */
export const RATES_MILLI = Object.freeze({
  'claude-fable-5-1': { input: 10000, output: 50000, cw5m: 12500, cw1h: 20000, cacheRead: 250, geo: true },
  'claude-fable-5': { input: 10000, output: 50000, cw5m: 12500, cw1h: 20000, cacheRead: 1000, geo: true },
  'claude-opus-5': { input: 5000, output: 25000, cw5m: 6250, cw1h: 10000, cacheRead: 500, geo: true, fast: { input: 10000, output: 50000, cw5m: 12500, cw1h: 20000, cacheRead: 1000 } },
  'claude-opus-4-8': { input: 5000, output: 25000, cw5m: 6250, cw1h: 10000, cacheRead: 500, geo: true, fast: { input: 10000, output: 50000, cw5m: 12500, cw1h: 20000, cacheRead: 1000 } },
  'claude-sonnet-5': { input: 2000, output: 10000, cw5m: 2500, cw1h: 4000, cacheRead: 200, geo: true },
  'claude-haiku-4-5': { input: 1000, output: 5000, cw5m: 1250, cw1h: 2000, cacheRead: 100, geo: false },
});

/**
 * Rule A9 normalization.
 * @param {string} raw
 * @returns {string}
 */
export function normModel(raw) {
  return String(raw).replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * Integer value of one billed part (rules A7, A10, A11, A13, A33), in nanodollars, or null
 * when the model is not in RATES_MILLI. tokens use resolved cw5m / cw1h.
 * @param {string} rawModel
 * @param {{ input: number, output: number, cw5m: number, cw1h: number, cacheRead: number }} t
 * @param {{ speed?: string|null, geo?: string|null, webSearch?: number }} [mods]
 * @returns {{ total: number, buckets: { input: number, output: number, cw5m: number, cw1h: number, cacheRead: number, webSearch: number } }|null}
 */
export function priceNano(rawModel, t, mods = {}) {
  const row = RATES_MILLI[normModel(rawModel)];
  if (!row) return null;
  let r = row;
  if (mods.speed === 'fast' && row.fast) r = { ...row.fast };
  const geo = mods.geo === 'us' && row.geo;
  const m = (x) => (geo ? (x * 11) / 10 : x);
  const buckets = {
    input: t.input * m(r.input),
    output: t.output * m(r.output),
    cw5m: t.cw5m * m(r.cw5m),
    cw1h: t.cw1h * m(r.cw1h),
    cacheRead: t.cacheRead * m(r.cacheRead),
    webSearch: (mods.webSearch || 0) * 10_000_000,
  };
  const total = buckets.input + buckets.output + buckets.cw5m + buckets.cw1h + buckets.cacheRead + buckets.webSearch;
  return { total, buckets };
}

/**
 * Rule A7 TTL resolution from a raw usage-like object.
 * @param {Record<string, any>} u
 * @returns {{ cw5m: number, cw1h: number, ttlEstimated: boolean }}
 */
export function resolveTtl(u) {
  const total = u.cache_creation_input_tokens || 0;
  if (total === 0) return { cw5m: 0, cw1h: 0, ttlEstimated: false }; // nothing written, nothing estimated
  const cc = u.cache_creation;
  if (!cc || typeof cc !== 'object') return { cw5m: total, cw1h: 0, ttlEstimated: true };
  const s5 = cc.ephemeral_5m_input_tokens || 0;
  const s1 = cc.ephemeral_1h_input_tokens || 0;
  if (s5 + s1 === total) return { cw5m: s5, cw1h: s1, ttlEstimated: false };
  // Split present but all zero while the total is not: no TTL information, same as absent.
  if (s5 + s1 === 0) return { cw5m: total, cw1h: 0, ttlEstimated: true };
  const w5 = Math.floor((total * s5) / (s5 + s1));
  return { cw5m: w5, cw1h: total - w5, ttlEstimated: false };
}

/**
 * Billed parts of a raw usage block (rule A8) with the top-level model as default.
 * @param {string} topModel
 * @param {Record<string, any>} u
 * @returns {{ model: string, tokens: { input: number, output: number, cw5m: number, cw1h: number, cacheRead: number }, ttlEstimated: boolean }[]}
 */
export function billedParts(topModel, u) {
  const its = Array.isArray(u.iterations) ? u.iterations : null;
  const one = (model, x) => {
    const ttl = resolveTtl(x);
    return {
      model,
      tokens: { input: x.input_tokens || 0, output: x.output_tokens || 0, cw5m: ttl.cw5m, cw1h: ttl.cw1h, cacheRead: x.cache_read_input_tokens || 0 },
      ttlEstimated: ttl.ttlEstimated,
    };
  };
  if (!its || its.length <= 1) return [one(topModel, u)];
  const out = [];
  its.forEach((e, i) => {
    if ((e.output_tokens || 0) === 0 && i !== its.length - 1) return;
    out.push(one(e.model || topModel, e));
  });
  return out;
}

/**
 * Format nanodollars as "$0.042080" style text with 6 or 7 decimals (fixture readability only).
 * @param {number|bigint} nano
 * @param {number} [decimals]
 * @returns {string}
 */
export function usd(nano, decimals = 6) {
  const n = BigInt(nano);
  const unit = 10n ** BigInt(9 - decimals);
  const q = (n + unit / 2n) / unit;
  const s = q.toString().padStart(decimals + 1, '0');
  return '$' + s.slice(0, s.length - decimals) + '.' + s.slice(s.length - decimals);
}

/**
 * Round a ratio to 4 decimals for human-readable expected values (tests compare num/den exactly).
 * @param {number|bigint} num
 * @param {number|bigint} den
 * @returns {number}
 */
export function round4(num, den) {
  return Math.round((Number(num) / Number(den)) * 10000) / 10000;
}

/**
 * Pretty JSON with a trailing newline, stable key order as inserted.
 * @param {unknown} v
 * @returns {string}
 */
export function prettyJson(v) {
  return JSON.stringify(v, null, 2) + '\n';
}
