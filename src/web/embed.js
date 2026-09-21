// Embedding JSON in the report HTML (DESIGN 8.8, trap 51). Isomorphic.
//
// The Summary lives in ONE <script type="application/json" id="ar-data"> element. It is built
// with JSON.stringify and then "<", ">", "&", U+2028 and U+2029 are replaced by JSON \u escapes,
// so the data can never close the script element, start markup or change meaning. The same
// escaping is used by src/node/report.js (the CLI) and by this page when it saves a copy of
// itself (drop mode "Save report", Share-safe copy); test/web/embed.test.js checks both agree.
//
// Characters are built from char codes so this file contains no escape sequences that tools
// might rewrite.

const BS = String.fromCharCode(92);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const ESCAPES = Object.freeze({ '<': BS + 'u003c', '>': BS + 'u003e', '&': BS + 'u0026', [LS]: BS + 'u2028', [PS]: BS + 'u2029' });
const UNSAFE_RE = new RegExp('[<>&' + LS + PS + ']', 'g');

/**
 * JSON text that is safe inside a raw-text <script> element.
 * @param {unknown} value
 * @returns {string}
 */
export function embedJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value is not JSON-serializable');
  return json.replace(UNSAFE_RE, (c) => ESCAPES[/** @type {keyof typeof ESCAPES} */ (c)]);
}

/**
 * Replace the contents of one JSON data block (by element id) in a full HTML document.
 * The block must exist exactly once. Its old content never contains "<" (it was embedded with
 * embedJson), so the first "</script>" after the opening tag is its end.
 * @param {string} html
 * @param {string} id   'ar-data' or 'ar-demo'
 * @param {unknown} value
 * @returns {string}
 */
export function replaceDataBlock(html, id, value) {
  if (!/^[a-z-]+$/.test(id)) throw new TypeError('bad block id');
  const re = new RegExp('(<script type="application/json" id="' + id + '">)([' + BS + 's' + BS + 'S]*?)(</script>)');
  const matches = html.match(new RegExp('<script type="application/json" id="' + id + '">', 'g'));
  if (!matches || matches.length !== 1) throw new Error('expected exactly one ' + id + ' block');
  const data = embedJson(value);
  return html.replace(re, (_m, open, _old, close) => open + data + close);
}

/**
 * Parse a data block's text content (the browser gives the raw text).
 * @param {string|null|undefined} text
 * @returns {unknown} null when empty
 */
export function parseDataBlock(text) {
  const t = (text ?? '').trim();
  if (!t || t === 'null') return null;
  return JSON.parse(t);
}
