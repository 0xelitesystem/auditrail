// Integer money (rule A33). Every team uses these helpers; nobody does money math in floats.
//
// Units
// - A rate is USD per million tokens with at most 3 decimals (the price table).
// - rateMilli = rate * 1000, an integer. Every Anthropic rate is a multiple of 10 milli, so the
//   1.1x US-inference multiplier stays exact as rateMilli * 11 / 10.
// - tokens * rateMilli = value in NANODOLLARS (1 nano = 1e-9 USD). Proof: tokens * rate / 1e6 USD
//   = tokens * rate * 1000 * 1e-9 USD.
// - Per response: a safe-integer Number (asserted). Totals: BigInt.
// - In JSON (Summary, fixtures, exports): a base-10 digit string, field names ending in "Nano".
//   BigInt cannot go through JSON.stringify, and a Number above 2^53 would silently round.
//
// Isomorphic: no node:* imports and no DOM.

/** Nanodollars per US dollar. */
export const NANO_PER_USD = 1_000_000_000n;

/** Nanodollars per US cent. */
export const NANO_PER_CENT = 10_000_000n;

/** Value of one web search request (rule A13: $10 per 1,000). */
export const WEB_SEARCH_NANO_PER_REQUEST = 10_000_000;

/**
 * Convert a $/MTok rate to integer milli-dollars per MTok. Throws when the rate has more than
 * 3 decimals (the price table schema forbids it) so a typo cannot silently round.
 * @param {number} rate USD per million tokens
 * @returns {number} integer
 */
export function rateToMilli(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new RangeError('rate must be a finite non-negative number, got ' + String(rate));
  }
  const milli = Math.round(rate * 1000);
  if (Math.abs(milli - rate * 1000) > 1e-6) throw new RangeError('rate has more than 3 decimals: ' + rate);
  return milli;
}

/**
 * Apply the US inference multiplier (rule A11) to one rate, exactly.
 * @param {number} rateMilli integer
 * @returns {number} integer rateMilli * 11 / 10
 */
export function geoUsMilli(rateMilli) {
  assertSafeInt(rateMilli, 'rateMilli');
  const scaled = rateMilli * 11;
  if (scaled % 10 !== 0) throw new RangeError('rate is not a multiple of 10 milli; 1.1x would not be exact: ' + rateMilli);
  return scaled / 10;
}

/**
 * Apply a user price-override multiplier (DESIGN 5.2) to one nanodollar amount, rounded half up
 * to a whole nanodollar. multiplierMilli = rateToMilli(multiplier), so 0.85 becomes 850.
 * @param {number} nano           non-negative safe integer
 * @param {number} multiplierMilli non-negative safe integer
 * @returns {number}
 */
export function applyMultiplierMilli(nano, multiplierMilli) {
  assertSafeInt(nano, 'nano');
  assertSafeInt(multiplierMilli, 'multiplierMilli');
  const v = (BigInt(nano) * BigInt(multiplierMilli) + 500n) / 1000n;
  const out = Number(v);
  if (!Number.isSafeInteger(out)) throw new RangeError('per-response value exceeds 2^53 nanodollars');
  return out;
}

/**
 * Value of `tokens` at `rateMilli`, in nanodollars (safe integer).
 * @param {number} tokens    non-negative integer
 * @param {number} rateMilli non-negative integer
 * @returns {number}
 */
export function tokensToNano(tokens, rateMilli) {
  assertSafeInt(tokens, 'tokens');
  assertSafeInt(rateMilli, 'rateMilli');
  const v = tokens * rateMilli;
  if (!Number.isSafeInteger(v)) throw new RangeError('per-response value exceeds 2^53 nanodollars; accumulate in BigInt');
  return v;
}

/**
 * Sum nanodollar amounts exactly.
 * @param {Iterable<number|bigint>} values
 * @returns {bigint}
 */
export function sumNano(values) {
  let total = 0n;
  for (const v of values) total += toBigNano(v);
  return total;
}

/**
 * @param {number|bigint|string} v a safe-integer Number, a BigInt or a JSON digit string
 * @returns {bigint}
 */
export function toBigNano(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') { assertSafeInt(v, 'nano', true); return BigInt(v); }
  if (typeof v === 'string') return nanoFromJson(v);
  throw new TypeError('nanodollar amount must be a number, bigint or digit string');
}

/**
 * Serialize nanodollars for JSON: a base-10 digit string, optional leading minus.
 * @param {number|bigint} v
 * @returns {string}
 */
export function nanoToJson(v) {
  return toBigNano(v).toString();
}

/**
 * Parse a nanodollar JSON string.
 * @param {string} s
 * @returns {bigint}
 */
export function nanoFromJson(s) {
  if (typeof s !== 'string' || !/^-?\d{1,30}$/.test(s)) throw new TypeError('invalid nanodollar string: ' + String(s));
  return BigInt(s);
}

/**
 * True when `s` is a valid nanodollar JSON string (for validators).
 * @param {unknown} s
 * @returns {boolean}
 */
export function isNanoString(s) {
  return typeof s === 'string' && /^-?\d{1,30}$/.test(s);
}

/**
 * Round nanodollars to whole cents, half away from zero ("half up" for the non-negative
 * amounts that tables show; symmetric for deltas).
 * @param {number|bigint|string} v
 * @returns {bigint} cents
 */
export function nanoToCents(v) {
  const n = toBigNano(v);
  const half = NANO_PER_CENT / 2n;
  return n >= 0n ? (n + half) / NANO_PER_CENT : -((-n + half) / NANO_PER_CENT);
}

/**
 * Format nanodollars as USD with a fixed number of decimals (default 2, cents rounded half up).
 * decimals may be 0 to 9; 9 is exact. Thousands are comma-grouped.
 * Examples: 42080000 -> "$0.04" (2), "$0.042080" (6); 7318420000000n -> "$7,318.42".
 * @param {number|bigint|string} v
 * @param {{ decimals?: number }} [opts]
 * @returns {string}
 */
export function formatUsd(v, opts = {}) {
  const decimals = opts.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new RangeError('decimals must be 0 to 9');
  const n = toBigNano(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const unit = 10n ** BigInt(9 - decimals);
  const q = (abs + unit / 2n) / unit; // amount in units of 10^-decimals USD, half up
  const scale = 10n ** BigInt(decimals);
  const whole = q / scale;
  const frac = q % scale;
  const wholeStr = groupThousands(whole.toString());
  const body = decimals > 0 ? wholeStr + '.' + frac.toString().padStart(decimals, '0') : wholeStr;
  return (neg ? '-$' : '$') + body;
}

/**
 * Floor a non-negative amount to two significant figures (card rule, DESIGN 4.14 and 7.2).
 * 7318420000000n ($7,318.42) -> 7300000000000n ($7,300); 42080000n ($0.04208) -> 42000000n.
 * @param {number|bigint|string} v
 * @returns {bigint}
 */
export function floorTwoSignificant(v) {
  const n = toBigNano(v);
  if (n < 0n) throw new RangeError('floorTwoSignificant expects a non-negative amount');
  const digits = n.toString().length;
  if (digits <= 2) return n;
  const factor = 10n ** BigInt(digits - 2);
  return (n / factor) * factor;
}

/**
 * Convert nanodollars to a JS number of dollars. DISPLAY ONLY (the card's atLeastUsd2sf and
 * chart axes). Never feed the result back into money math.
 * @param {number|bigint|string} v
 * @returns {number}
 */
export function nanoToUsdNumber(v) {
  const n = toBigNano(v);
  const whole = n / NANO_PER_USD;
  const frac = n % NANO_PER_USD;
  return Number(whole) + Number(frac) / 1e9;
}

/**
 * Compact two-significant-figure dollar text for the card, from an amount that was already
 * floored with floorTwoSignificant. Examples: $7,300 -> "$7.3K", $6,000 -> "$6.0K", $12,000 -> "$12K",
 * $120,000 -> "$120K", $1,200,000 -> "$1.2M", $4.2 -> "$4.2", $42 -> "$42", $420 -> "$420",
 * $0.042 -> "$0.042".
 * @param {number|bigint|string} floored2sfNano
 * @returns {string}
 */
export function formatUsdTwoSignificant(floored2sfNano) {
  const n = floorTwoSignificant(floored2sfNano);
  if (n === 0n) return '$0';
  const units = [
    { div: 1_000_000_000n * 1_000_000_000n, suffix: 'B' },
    { div: 1_000_000_000n * 1_000_000n, suffix: 'M' },
    { div: 1_000_000_000n * 1_000n, suffix: 'K' },
    { div: 1_000_000_000n, suffix: '' },
  ];
  for (const { div, suffix } of units) {
    if (n >= div) return '$' + twoSigDecimal(n, div) + suffix;
  }
  // Under one dollar: plain decimal with exactly two significant digits.
  return '$' + twoSigDecimal(n, NANO_PER_USD);
}

/**
 * Render n / div with two significant digits, keeping a trailing zero ("6.0").
 * @param {bigint} n
 * @param {bigint} div
 * @returns {string}
 */
function twoSigDecimal(n, div) {
  const intPart = n / div;
  const intDigits = intPart === 0n ? 0 : intPart.toString().length;
  if (intDigits >= 2) return intPart.toString();
  // Need 2 - intDigits decimals, or for values under 1 enough decimals to show 2 significant digits.
  let decimals = intDigits === 1 ? 1 : 0;
  if (intDigits === 0) {
    const s = n.toString();
    const divDigits = div.toString().length - 1;
    decimals = divDigits - s.length + 2;
  }
  const scale = 10n ** BigInt(decimals);
  const scaled = (n * scale) / div;
  const str = scaled.toString().padStart(decimals + 1, '0');
  return str.slice(0, str.length - decimals) + (decimals > 0 ? '.' + str.slice(str.length - decimals) : '');
}

/**
 * Exact share check without floats: num / den >= pNum / pDen.
 * @param {number|bigint} num
 * @param {number|bigint} den
 * @param {number} pNum
 * @param {number} pDen
 * @returns {boolean} false when den is 0
 */
export function shareAtLeast(num, den, pNum, pDen) {
  const a = BigInt(num);
  const b = BigInt(den);
  if (b === 0n) return false;
  return a * BigInt(pDen) >= BigInt(pNum) * b;
}

/**
 * A ratio of two exact amounts as a JS number for display (shares, rates). Returns 0 when den is 0.
 * @param {number|bigint|string} num
 * @param {number|bigint|string} den
 * @returns {number}
 */
export function ratio(num, den) {
  const a = typeof num === 'string' ? nanoFromJson(num) : BigInt(num);
  const b = typeof den === 'string' ? nanoFromJson(den) : BigInt(den);
  if (b === 0n) return 0;
  // Scale to 12 decimal places in integers, then divide once in floating point.
  const scaled = (a * 1_000_000_000_000n) / b;
  return Number(scaled) / 1e12;
}

/**
 * @param {string} digits
 * @returns {string}
 */
function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {unknown} v
 * @param {string} name
 * @param {boolean} [allowNegative]
 */
function assertSafeInt(v, name, allowNegative = false) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || (!allowNegative && v < 0)) {
    throw new RangeError(name + ' must be a ' + (allowNegative ? '' : 'non-negative ') + 'safe integer, got ' + String(v));
  }
}
