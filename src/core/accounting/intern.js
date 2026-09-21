// String interning for the accounting accumulators.
//
// A scan parses one string object per occurrence: JSON.parse hands back a fresh string for every
// session id, model id and cwd on every line. Anything the accumulators keep for the length of
// the scan is kept per response or per line, so without interning a million responses in one
// session hold a million copies of that one session id. Interning stores the first copy and
// hands it back for every later occurrence, which is also what makes the later Map lookups on
// those values cheap.
//
// The cap is a safety valve, not a correctness knob: past it a string is stored exactly as it
// arrived, which costs memory but changes nothing a caller can observe.
//
// Isomorphic: no node:* imports and no DOM.

/** Distinct strings one pool holds. Real logs hold a few thousand across every interned field. */
export const MAX_INTERNED = 200_000;

/**
 * @param {number} [max]
 * @returns {{ (s: string|null|undefined): string|null, clear: () => void, size: () => number }}
 */
export function createStringPool(max = MAX_INTERNED) {
  /** @type {Map<string, string>} */
  const pool = new Map();
  /** @param {string|null|undefined} s */
  const intern = (s) => {
    if (s === null || s === undefined) return null;
    const hit = pool.get(s);
    if (hit !== undefined) return hit;
    if (pool.size < max) pool.set(s, s);
    return s;
  };
  intern.clear = () => pool.clear();
  intern.size = () => pool.size;
  return intern;
}
