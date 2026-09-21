// Secrets in transcripts (DESIGN 6 I11, traps 52 to 56).
//
// The adapter hands every text it is allowed to scan (user text, tool_use.input string values,
// tool_result content) to a SecretScanner created here, while the line is in memory. The
// scanner returns findings that carry ONLY:
//   secretType     a short lowercase token ('anthropic', 'aws', ...)
//   fingerprint12  the first 12 hex characters of SHA-256(value)
//   severity       critical | likely_fixture | third_party_public
//   source         user_text | tool_input | tool_result_local | tool_result_web
//   expired        JWTs only: true when a locally decoded exp is in the past, else null
// The value itself, and any prefix, suffix or slice of it, never leaves scanText(). Nothing in
// this module does network I/O: no liveness checks, ever (trap 54). Nothing rewrites a
// transcript (trap 55).
//
// Detection: one combined pre-filter regex on cheap literal prefixes rejects almost every text
// in a single pass; only texts that hit it run the per-type patterns. Severity (DESIGN I11):
//   critical            vendor format, Shannon entropy of the secret body at least 3.2 bits per
//                       character, no fixture context word within 150 characters, and the text
//                       is user text or local tool output (Read, Bash, PowerShell, Grep, or a
//                       result whose tool could not be named). An expired JWT is never critical.
//   third_party_public  found in WebFetch or WebSearch output: information only.
//   likely_fixture      everything else (collapsed by default in the report).
//
// Isomorphic: no node:* imports and no DOM.

import { sha256HexPrefix } from './sha256.js';
import { SECRET_SEVERITIES, SECRET_SOURCES } from './adapters/contract.js';

/** Minimum Shannon entropy (bits per character) of the secret body for a critical finding. */
export const MIN_CRITICAL_ENTROPY = 3.2;

/** Characters on each side of a match that are searched for fixture context words. */
export const CONTEXT_WINDOW = 150;

/**
 * Fixture context words (DESIGN I11). Matched case-insensitively. "test" needs a non-letter in
 * front of it so "latest" and "contest" do not count, while "test_key", "TestKey", "pytest"
 * and "unittest" do.
 */
export const CONTEXT_WORD_RE = /(?:^|[^a-z])test|pytest|unittest|fixture|example|mock|regex|pattern|redact|sample|placeholder/;

/** Global, case-insensitive scan form of CONTEXT_WORD_RE; the length of its longest word. */
const CONTEXT_WORD_SCAN = new RegExp(CONTEXT_WORD_RE.source, 'gi');
const CONTEXT_WORD_MAX = 'placeholder'.length;

/**
 * True when a fixture context word lies within the window [lo, hi) of `text`. A word counts
 * when any character of it is inside the window, so a word that starts 149 characters after a
 * match counts even though it ends past 150. The slice is widened by the longest word on each
 * side, which also keeps a word cut by the slice edge (the "test" in "latest") out of reach.
 * @param {string} text
 * @param {number} lo
 * @param {number} hi
 * @returns {boolean}
 */
export function hasContextWord(text, lo, hi) {
  const from = Math.max(0, lo - CONTEXT_WORD_MAX);
  const s = text.slice(from, Math.min(text.length, hi + CONTEXT_WORD_MAX));
  for (const m of s.matchAll(CONTEXT_WORD_SCAN)) {
    const wordStart = from + /** @type {number} */ (m.index) + (/[a-z]/i.test(m[0][0]) ? 0 : 1);
    const wordEnd = from + /** @type {number} */ (m.index) + m[0].length;
    if (wordStart < hi && wordEnd > lo) return true;
  }
  return false;
}

/** Tool outputs that come from the public web: information only. */
export const WEB_TOOLS = Object.freeze(['WebFetch', 'WebSearch']);

/** Local tool outputs that can make a finding critical. */
export const CRITICAL_RESULT_TOOLS = Object.freeze(['Read', 'Bash', 'PowerShell', 'Grep']);

/** At most this many findings per scanned text (bounds memory on pathological inputs). */
export const MAX_FINDINGS_PER_TEXT = 500;

/**
 * The secret types, most specific first (an overlapping later match is dropped). `hint` holds
 * literal substrings, one of which must occur in the text before the pattern runs. `body` is the
 * random part of the match (vendor prefix removed), so entropy is measured on it only.
 *
 * @typedef {Object} SecretType
 * @property {string} id
 * @property {string|string[]} hint
 * @property {string} label         what the report prints
 * @property {string} rotate        where to rotate it, as plain words (no URL: nothing is fetched)
 * @property {RegExp} re            global
 * @property {(m: RegExpMatchArray) => string} value     what gets fingerprinted
 * @property {(m: RegExpMatchArray) => string} body      what entropy is measured on
 */

const B = '(?<![A-Za-z0-9_-])';

/** @type {readonly SecretType[]} */
export const SECRET_TYPES = Object.freeze([
  {
    id: 'private_key', hint: '-----BEGIN', label: 'Private key (PEM block with a body)', rotate: 'replace the key pair and revoke the old public key wherever it is trusted',
    // Header, then a separator (real newline, whitespace or a JSON-escaped \n), then a base64
    // body line of at least 40 characters. Header-only hits are not findings (trap 52).
    re: /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----(?:\s|\\[rn])+([A-Za-z0-9+/=]{40,}(?:(?:\s|\\[rn])+[A-Za-z0-9+/=]{4,}){0,400})/g,
    value: (m) => m[2].replace(/\\[rn]|\s/g, ''),
    body: (m) => m[2].replace(/\\[rn]|\s/g, ''),
  },
  {
    id: 'anthropic', hint: 'sk-ant-', label: 'Anthropic API key', rotate: 'revoke it in the Anthropic Console API keys page and create a new one',
    re: new RegExp(B + 'sk-ant-(?:api|admin|oat|ort)\\d\\d-[A-Za-z0-9_-]{20,}', 'g'),
    value: (m) => m[0],
    body: (m) => m[0].replace(/^sk-ant-[a-z]+\d\d-/, ''),
  },
  {
    id: 'openai', hint: 'sk-', label: 'OpenAI API key', rotate: 'revoke it in the OpenAI platform API keys page',
    re: new RegExp(B + 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}', 'g'),
    value: (m) => m[0],
    body: (m) => m[0].replace(/^sk-[a-z]+-/, ''),
  },
  {
    id: 'aws', hint: ['AKIA', 'ASIA'], label: 'AWS access key id', rotate: 'deactivate and delete the access key in AWS IAM, then check CloudTrail for its use',
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(4),
  },
  {
    id: 'github', hint: ['gh', 'github_pat_'], label: 'GitHub token', rotate: 'revoke it in GitHub developer settings (personal access tokens)',
    re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{30,})/g,
    value: (m) => m[0],
    body: (m) => m[0].replace(/^(gh[pousr]_|github_pat_)/, ''),
  },
  {
    id: 'gitlab', hint: 'glpat-', label: 'GitLab personal access token', rotate: 'revoke it in GitLab user settings (access tokens)',
    re: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(6),
  },
  {
    id: 'slack_webhook', hint: 'hooks.slack.com', label: 'Slack incoming webhook URL', rotate: 'regenerate the webhook in the Slack app configuration',
    re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]{6,}\/B[A-Za-z0-9]{6,}\/[A-Za-z0-9]{16,}/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(m[0].lastIndexOf('/') + 1),
  },
  {
    id: 'slack', hint: 'xox', label: 'Slack token', rotate: 'revoke it in the Slack app configuration',
    re: /(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(5),
  },
  {
    id: 'stripe', hint: '_live_', label: 'Stripe live key', rotate: 'roll the key in the Stripe dashboard (developers, API keys)',
    re: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{20,}/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(8),
  },
  {
    id: 'google', hint: 'AIza', label: 'Google API key', rotate: 'delete or regenerate it in the Google Cloud console (APIs and services, credentials)',
    re: new RegExp(B + 'AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])', 'g'),
    value: (m) => m[0],
    body: (m) => m[0].slice(4),
  },
  {
    id: 'google_oauth', hint: 'GOCSPX-', label: 'Google OAuth client secret', rotate: 'reset the client secret in the Google Cloud console (credentials)',
    re: new RegExp(B + 'GOCSPX-[A-Za-z0-9_-]{20,}', 'g'),
    value: (m) => m[0],
    body: (m) => m[0].slice(7),
  },
  {
    id: 'sendgrid', hint: 'SG.', label: 'SendGrid API key', rotate: 'delete it in SendGrid settings (API keys)',
    re: new RegExp(B + 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}', 'g'),
    value: (m) => m[0],
    body: (m) => m[0].slice(3),
  },
  {
    id: 'huggingface', hint: 'hf_', label: 'Hugging Face token', rotate: 'invalidate it in Hugging Face settings (access tokens)',
    re: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(3),
  },
  {
    id: 'npm', hint: 'npm_', label: 'npm access token', rotate: 'revoke it in npm account settings (access tokens)',
    re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    value: (m) => m[0],
    body: (m) => m[0].slice(4),
  },
  {
    id: 'jwt', hint: 'eyJ', label: 'JSON Web Token', rotate: 'revoke the session or rotate the signing key that issued it',
    re: new RegExp(B + 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{16,}', 'g'),
    value: (m) => m[0],
    body: (m) => m[0],
  },
  {
    id: 'db_url', hint: '://', label: 'Database URL with an inline password', rotate: 'change the database password and update every place that uses it',
    re: /(?<![A-Za-z0-9+.-])(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/([^\s:@/'"`<>]{0,64}):([^\s@/'"`<>]{3,128})@[^\s/'"`<>?#]{1,255}/g,
    value: (m) => m[0],
    body: (m) => m[2],
  },
]);

/** Every secretType id, in detection order. */
export const SECRET_TYPE_IDS = Object.freeze(SECRET_TYPES.map((t) => t.id));

/**
 * One combined pre-filter on cheap literal prefixes. A text that fails it cannot hold any of
 * the types above, so the per-type patterns never run on it.
 */
export const PREFILTER_RE = /-----BEGIN|sk-ant-|sk-proj-|sk-svcacct-|sk-admin-|AKIA|ASIA|gh[pousr]_|github_pat_|glpat-|hooks\.slack\.com|xox[abposr]-|_live_|AIza|GOCSPX-|SG\.|hf_|npm_|eyJ|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\//;

/** A DB password that is obviously a template, not a secret. */
const DB_PLACEHOLDER_RE = /^(?:\$|\{\{|<|%|\*+$|x+$|\.\.\.)/i;

/**
 * Shannon entropy in bits per character.
 * @param {string} s
 * @returns {number}
 */
export function shannonEntropy(s) {
  if (!s) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let n = 0;
  for (const c of counts.values()) n += c;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Decode a base64url segment to a string, or null. Local only.
 * @param {string} seg
 * @returns {string|null}
 */
function base64UrlDecode(seg) {
  try {
    let b = seg.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * JWT expiry from the locally decoded payload: true when exp is in the past, else null.
 * @param {string} token
 * @param {number} nowMs
 * @returns {boolean|null}
 */
export function jwtExpired(token, nowMs) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const payload = JSON.parse(json);
    const exp = payload && typeof payload === 'object' ? payload.exp : undefined;
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000 < nowMs ? true : null;
  } catch {
    // not JSON: no expiry information
  }
  return null;
}

/**
 * Map the adapter's `where` and tool name to a SECRET_SOURCES entry.
 * @param {string} where
 * @param {string|null} toolName
 * @returns {'user_text'|'tool_input'|'tool_result_local'|'tool_result_web'}
 */
export function sourceOf(where, toolName) {
  if (where === 'user_text') return 'user_text';
  if (where === 'tool_input') return 'tool_input';
  return toolName !== null && WEB_TOOLS.includes(toolName) ? 'tool_result_web' : 'tool_result_local';
}

/**
 * @typedef {Object} SecretFinding
 * @property {string} secretType
 * @property {string} fingerprint12
 * @property {'critical'|'likely_fixture'|'third_party_public'} severity
 * @property {'user_text'|'tool_input'|'tool_result_local'|'tool_result_web'} source
 * @property {boolean|null} expired
 */

/**
 * Scan one text. Returns findings with no value, prefix or suffix of any secret in them.
 * @param {string} text
 * @param {'user_text'|'tool_input'|'tool_result'} where
 * @param {string|null} toolName
 * @param {{ nowMs?: number }} [opts]
 * @returns {SecretFinding[]}
 */
export function scanText(text, where, toolName = null, opts = {}) {
  if (typeof text !== 'string' || text.length < 8 || !PREFILTER_RE.test(text)) return [];
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const source = sourceOf(where, toolName ?? null);
  const criticalSource = source === 'user_text'
    || (source === 'tool_result_local' && (toolName === null || toolName === undefined || CRITICAL_RESULT_TOOLS.includes(toolName)));
  /** @type {SecretFinding[]} */
  const out = [];
  /** @type {[number, number][]} */
  const taken = [];
  for (const type of SECRET_TYPES) {
    const hints = typeof type.hint === 'string' ? [type.hint] : type.hint;
    if (!hints.some((h) => text.includes(h))) continue;
    for (const m of text.matchAll(type.re)) {
      if (out.length >= MAX_FINDINGS_PER_TEXT) return out;
      const start = /** @type {number} */ (m.index);
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (type.id === 'db_url' && DB_PLACEHOLDER_RE.test(m[2])) continue;
      taken.push([start, end]);
      const value = type.value(m);
      const body = type.body(m);
      const fixtureContext = hasContextWord(text, Math.max(0, start - CONTEXT_WINDOW), Math.min(text.length, end + CONTEXT_WINDOW));
      const expired = type.id === 'jwt' ? jwtExpired(value, nowMs) : null;
      /** @type {SecretFinding['severity']} */
      let severity;
      if (source === 'tool_result_web') severity = 'third_party_public';
      else if (criticalSource && !fixtureContext && expired !== true && shannonEntropy(body) >= MIN_CRITICAL_ENTROPY) severity = 'critical';
      else severity = 'likely_fixture';
      out.push({ secretType: type.id, fingerprint12: sha256HexPrefix(value, 12), severity, source, expired });
    }
  }
  return out;
}

/**
 * Build the SecretScanner the adapter calls (adapters/contract.js LineContext.scanSecrets).
 * @param {{ nowMs?: number }} [opts] nowMs is the scan clock for JWT expiry (injected in tests)
 * @returns {(text: string, where: 'user_text'|'tool_input'|'tool_result', toolName: string|null) => SecretFinding[]}
 */
export function createSecretScanner(opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  return (text, where, toolName) => scanText(text, where, toolName ?? null, { nowMs });
}

/** Severity rank: lower is more severe. */
const SEVERITY_RANK = Object.freeze({ critical: 0, likely_fixture: 1, third_party_public: 2 });

/**
 * @typedef {Object} GroupedSecret
 * @property {string} secretType
 * @property {string} fingerprint12
 * @property {string} severity        the most severe copy
 * @property {string} source          the source of the most severe copy (SECRET_SOURCES order on ties)
 * @property {number} copies          occurrences across every scanned text
 * @property {number} files           distinct files holding a copy
 * @property {number|null} newestTs   latest timestamp of a copy (epoch ms)
 * @property {boolean|null} expired
 * @property {string[]} projectKeys   sorted, distinct; LOCAL (labels are applied by the insight)
 */

/**
 * Group secret events (kind 'secret') by type and fingerprint, across files (trap 53). This is
 * the shape AccountingResult.secrets carries; accounting may call it directly.
 * @param {Iterable<{ fileIdx: number, ts: number|null, sessionId?: string|null, secretType: string, fingerprint12: string, severity: string, source: string, expired: boolean|null }>} events
 * @param {{ projectKeyOf?: (ev: any) => string|null }} [opts]
 * @returns {GroupedSecret[]} most severe first, then newest first, then by fingerprint
 */
export function groupSecretEvents(events, opts = {}) {
  /** @type {Map<string, { g: GroupedSecret, files: Set<number>, projects: Set<string> }>} */
  const m = new Map();
  for (const ev of events) {
    if (!ev || !SECRET_SEVERITIES.includes(ev.severity) || !SECRET_SOURCES.includes(ev.source)) continue;
    if (typeof ev.fingerprint12 !== 'string' || !/^[0-9a-f]{12}$/.test(ev.fingerprint12)) continue;
    const key = ev.secretType + ':' + ev.fingerprint12;
    let x = m.get(key);
    if (!x) {
      x = {
        g: { secretType: ev.secretType, fingerprint12: ev.fingerprint12, severity: ev.severity, source: ev.source, copies: 0, files: 0, newestTs: null, expired: null, projectKeys: [] },
        files: new Set(), projects: new Set(),
      };
      m.set(key, x);
    }
    const g = x.g;
    g.copies++;
    x.files.add(ev.fileIdx);
    const r = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (ev.severity)];
    const cur = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (g.severity)];
    if (r < cur || (r === cur && SECRET_SOURCES.indexOf(ev.source) < SECRET_SOURCES.indexOf(g.source))) {
      g.severity = ev.severity;
      g.source = ev.source;
    }
    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts) && (g.newestTs === null || ev.ts > g.newestTs)) g.newestTs = ev.ts;
    if (ev.expired === true) g.expired = true;
    const pk = opts.projectKeyOf ? opts.projectKeyOf(ev) : null;
    if (typeof pk === 'string' && pk) x.projects.add(pk);
  }
  const out = [];
  for (const { g, files, projects } of m.values()) {
    g.files = files.size;
    g.projectKeys = [...projects].sort();
    out.push(g);
  }
  return out.sort(compareGrouped);
}

/**
 * @param {{ severity: string, newestTs: number|null, fingerprint12: string, secretType: string }} a
 * @param {{ severity: string, newestTs: number|null, fingerprint12: string, secretType: string }} b
 * @returns {number}
 */
export function compareGrouped(a, b) {
  const ra = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (a.severity)] ?? 9;
  const rb = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (b.severity)] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = a.newestTs ?? -Infinity;
  const tb = b.newestTs ?? -Infinity;
  if (ta !== tb) return tb > ta ? 1 : -1;
  if (a.fingerprint12 !== b.fingerprint12) return a.fingerprint12 < b.fingerprint12 ? -1 : 1;
  return a.secretType < b.secretType ? -1 : a.secretType > b.secretType ? 1 : 0;
}

/**
 * Report copy for one type: label and where to rotate it (plain words, no URL).
 * @param {string} id
 * @returns {{ label: string, rotate: string }}
 */
export function secretTypeInfo(id) {
  const t = SECRET_TYPES.find((x) => x.id === id);
  return t ? { label: t.label, rotate: t.rotate } : { label: 'Secret', rotate: 'rotate it at the provider' };
}
