#!/usr/bin/env node
// Zero-dependency inliner (DESIGN 8.3, 8.4, 8.8, 8.10a, trap 8).
//
// Produces ONE file, dist/auditrail.mjs, that contains:
//   - the Node CLI (src/node/cli.js) and every module it imports (core and node code),
//   - the HTML report template, with the browser app (src/web/app.js), its CSS and the Web
//     Worker source (src/web/worker.js) inlined, and the meta CSP carrying the SHA-256 of the
//     inlined app script,
//   - JSON (price tables) and binary (glyph atlas) imports, inlined.
// A single file is mandatory: a relative ESM import failed with ERR_ACCESS_DENIED under a
// scoped --allow-fs-read on Windows, while the single-file bundle ran.
//
// How the bundler works (no parser dependency):
// 1. segmentJs() splits a module into code, string, template, regex and comment segments,
//    tracking template substitutions and the usual "is this slash a regex" rule.
// 2. parseModule() finds top-level import and export statements in the code segments only
//    (brace depth 0) and rewrites them: imports become const bindings from the dependency's
//    namespace object, export keywords are dropped and every export becomes a getter on the
//    module's namespace object (live reads, frozen object).
// 3. Modules are emitted in dependency order, each in its own function scope. Node builtins
//    (node:*) stay real ESM imports at the top of the Node bundle; browser bundles must not
//    reach them. Cycles, bare package imports, dynamic import() and import.meta in browser code
//    are build errors.
// 4. minifyJs() drops comments, indentation and blank lines (never touching strings,
//    templates or regex literals), so the bundle stays small without a minifier dependency.
// 5. shortenNames() gives local bindings short names (a one-to-one rename of bindings only;
//    property names, globals and anything it cannot classify are left alone), compactJs()
//    removes the spaces and newlines JavaScript does not need, constToLet() writes every const
//    declaration as let, and namespace objects of internal modules become plain objects with
//    short keys. mangle: false turns these off for comparison runs.
// 6. The report page the CLI embeds (the built template without the drop-mode worker) is
//    stored Brotli-compressed inside report.js and checked by SHA-256 when it is unpacked; the
//    full page, worker included, is written readable to dist/auditrail.html.
// 7. The package version replaces the version fallback of src/node/cli.js, so a copy of the
//    bundle without its package.json still knows its version.
//
// Usage:
//   node scripts/build.mjs                  build dist/auditrail.mjs (and dist/auditrail.html)
//   node scripts/build.mjs --out <file>     choose the bundle path
//   node scripts/build.mjs --html-only      build only the standalone report/app HTML
//
// The build never touches the network and never reads outside the repository.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** Size budget for dist/auditrail.mjs (DESIGN 8.3). */
export const MAX_BUNDLE_BYTES = 400 * 1024;

/** The exact meta CSP (DESIGN 8.8) with the app script hash filled in. */
export function cspFor(appScriptHashB64) {
  return "default-src 'none'; script-src 'sha256-" + appScriptHashB64 + "'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
}

/** SHA-256 of a script's exact text, base64, as CSP hash sources expect. */
export function cspHash(scriptText) {
  return crypto.createHash('sha256').update(scriptText, 'utf8').digest('base64');
}

/* ------------------------------------------------------------------------------------------
 * 1. Segmenting JavaScript
 * ---------------------------------------------------------------------------------------- */

const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
// Identifier characters: ASCII letters, digits, _ and $, plus anything outside ASCII.
const NON_ASCII = String.fromCharCode(0x80) + '-' + String.fromCharCode(0xffff);
const ID_START = new RegExp('[A-Za-z_$' + NON_ASCII + ']');
const ID_PART = new RegExp('[A-Za-z0-9_$' + NON_ASCII + ']');

export class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}

/**
 * Split JavaScript source into segments. Concatenating every segment's text gives the
 * source back exactly.
 * @param {string} src
 * @param {string} [file] for error messages
 * @returns {{ type: 'code'|'string'|'template'|'regex'|'comment', text: string, start: number }[]}
 */
export function segmentJs(src, file = '<input>') {
  const segs = [];
  const n = src.length;
  let i = 0;
  let codeStart = 0;
  let last = '';            // last significant token in code: '' | 'id:<word>' | 'num' | 'str' | 're' | punct
  let depth = 0;            // brace depth in code
  const tplStack = [];      // brace depth at which each open template substitution resumes its template
  const fail = (msg) => { throw new BuildError(file + ': ' + msg + ' at offset ' + i); };
  const flush = (end) => { if (end > codeStart) segs.push({ type: 'code', text: src.slice(codeStart, end), start: codeStart }); };
  const push = (type, start, end) => { segs.push({ type, text: src.slice(start, end), start }); codeStart = end; };

  // Read template text starting at `start` (a backtick or the "}" closing a substitution).
  // Returns the index after the chunk and whether the template ended.
  const readTemplate = (start) => {
    let j = start + 1;
    for (;;) {
      if (j >= n) fail('unterminated template literal');
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return { end: j + 1, closed: true };
      if (c === '$' && src[j + 1] === '{') return { end: j + 2, closed: false };
      j++;
    }
  };

  if (src.startsWith('#!')) {
    const j = src.indexOf('\n');
    push('comment', 0, j < 0 ? n : j);
    i = j < 0 ? n : j;
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      flush(i);
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      flush(i);
      const j = src.indexOf('*/', i + 2);
      if (j < 0) fail('unterminated block comment');
      push('comment', i, j + 2);
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      flush(i);
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') fail('unterminated string');
        j++;
      }
      if (j >= n) fail('unterminated string');
      push('string', i, j + 1);
      i = j + 1;
      last = 'str';
      continue;
    }
    if (c === '`') {
      flush(i);
      const r = readTemplate(i);
      push('template', i, r.end);
      i = r.end;
      if (!r.closed) tplStack.push(depth);
      else last = 'str';
      continue;
    }
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === depth) {
      flush(i);
      tplStack.pop();
      const r = readTemplate(i);
      push('template', i, r.end);
      i = r.end;
      if (!r.closed) tplStack.push(depth);
      else last = 'str';
      continue;
    }
    if (c === '/') {
      if (regexAllowed(last)) {
        flush(i);
        let j = i + 1;
        let inClass = false;
        for (;;) {
          if (j >= n || src[j] === '\n') fail('unterminated regular expression');
          const x = src[j];
          if (x === '\\') { j += 2; continue; }
          if (x === '[') inClass = true;
          else if (x === ']') inClass = false;
          else if (x === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        push('regex', i, j);
        i = j;
        last = 're';
        continue;
      }
      last = '/';
      i++;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      last = 'id:' + src.slice(i, j);
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      last = 'num';
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    last = c;
    i++;
  }
  if (tplStack.length) fail('unterminated template substitution');
  flush(n);
  return segs;
}

/**
 * @param {string} last
 * @returns {boolean}
 */
function regexAllowed(last) {
  if (last === '') return true;
  if (last === 'num' || last === 'str' || last === 're') return false;
  if (last.startsWith('id:')) return KW_BEFORE_REGEX.has(last.slice(3));
  return !(last === ')' || last === ']' || last === '}');
}

/**
 * Remove comments, indentation, trailing spaces and blank lines outside strings, templates
 * and regex literals. Newlines are kept so automatic semicolon insertion is unchanged.
 * @param {string} src
 * @param {string} [file]
 * @returns {string}
 */
export function minifyJs(src, file) {
  const segs = segmentJs(src, file);
  let out = '';
  for (const s of segs) {
    if (s.type === 'comment') {
      if (s.text.includes('\n')) out += '\n';
      else if (!s.text.startsWith('//') && !s.text.startsWith('#!')) out += ' ';
      continue;
    }
    if (s.type === 'code') {
      let t = s.text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n');
      if (t.startsWith('\n') || t === '') out = out.replace(/[ \t]+$/, '');
      if (out === '' || out.endsWith('\n')) t = t.replace(/^\n+/, '');
      out += t;
      continue;
    }
    out += s.text;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * 1b. Short names and tight spacing (still no parser dependency)
 *
 * shortenNames() gives local bindings short names. The rename is ONE-TO-ONE and applied to
 * every binding and reference of a name across the whole bundle, so scoping and shadowing are
 * unchanged by construction: two names never merge, and a new name is never an identifier that
 * already occurs in the code, a keyword or a known global. Property names are never renamed.
 * A token scan that tracks brackets gives every identifier occurrence a role:
 *   prop     after "." or "?." or "#", an object literal key or method name, a class member
 *   ref      a binding or a reference
 *   short    a shorthand property ({ a } or { a = 1 }), written back as { a: newName }
 *   unknown  anything the scan cannot classify with certainty (labels, class fields, keys in a
 *            brace that might be a block): that name is then left alone everywhere.
 * A name is renamed only when the bundle declares it (const, let, var, function, class,
 * parameters, catch, destructuring) in every top-level region that references it, so a free
 * global is never renamed, even one missing from KNOWN_GLOBALS.
 * ---------------------------------------------------------------------------------------- */

const RESERVED_WORDS = new Set((
  'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
  'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
  'yield let static implements interface package private protected public await async get set of from as target ' +
  'meta constructor prototype arguments eval undefined NaN Infinity globalThis __proto__ accessor using'
).split(' '));

/** Globals of Node and of browser pages and workers. Never renamed, never used as a new name. */
const KNOWN_GLOBALS = new Set((
  'Object Function Array Number parseFloat parseInt Boolean String Symbol Date Promise RegExp Error AggregateError ' +
  'EvalError RangeError ReferenceError SyntaxError TypeError URIError JSON Math Intl ArrayBuffer SharedArrayBuffer ' +
  'Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float16Array Float32Array Float64Array ' +
  'Uint8ClampedArray BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap WeakSet Proxy Reflect ' +
  'FinalizationRegistry WeakRef Iterator decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape ' +
  'isFinite isNaN console WebAssembly process Buffer global require module exports __filename __dirname ' +
  'setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask structuredClone ' +
  'atob btoa URL URLSearchParams TextEncoder TextDecoder TextEncoderStream TextDecoderStream AbortController ' +
  'AbortSignal EventTarget Event CustomEvent ErrorEvent MessageChannel MessagePort MessageEvent BroadcastChannel Blob ' +
  'File FileReader FileList performance Performance PerformanceObserver fetch Request Response Headers FormData ' +
  'WebSocket EventSource XMLHttpRequest crypto Crypto CryptoKey SubtleCrypto navigator Navigator DOMException ' +
  'ReadableStream WritableStream TransformStream CompressionStream DecompressionStream ByteLengthQueuingStrategy ' +
  'CountQueuingStrategy localStorage sessionStorage Storage indexedDB caches window self document location history ' +
  'screen frames parent top opener name status closed length origin event external customElements alert confirm ' +
  'prompt print open close stop focus blur find postMessage onmessage onerror onmessageerror importScripts ' +
  'requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia ' +
  'getSelection scroll scrollTo scrollBy showDirectoryPicker showOpenFilePicker showSaveFilePicker ' +
  'createImageBitmap reportError devicePixelRatio innerWidth innerHeight outerWidth outerHeight scrollX scrollY ' +
  'visualViewport isSecureContext crossOriginIsolated trustedTypes Worker SharedWorker Image ImageData ImageBitmap ' +
  'OffscreenCanvas CanvasRenderingContext2D Path2D DOMParser XMLSerializer MutationObserver ResizeObserver ' +
  'IntersectionObserver Element HTMLElement HTMLCanvasElement HTMLInputElement HTMLButtonElement ' +
  'HTMLAnchorElement HTMLImageElement HTMLTemplateElement SVGElement Node NodeList Document DocumentFragment ' +
  'FileSystemHandle FileSystemDirectoryHandle FileSystemFileHandle DataTransfer DataTransferItem KeyboardEvent ' +
  'MouseEvent PointerEvent DragEvent FocusEvent InputEvent Clipboard ClipboardItem Option Audio CSS Notification ' +
  'WorkerGlobalScope DedicatedWorkerGlobalScope Deno Bun'
).split(' '));

const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=',
  '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const BLOCK_BEFORE_BRACE = new Set(['else', 'try', 'finally', 'do', 'catch']);
const EXPR_BEFORE_BRACE = new Set(['return', 'throw', 'case', 'typeof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'instanceof', 'const', 'let', 'var']);
const CONTROL_BEFORE_PAREN = new Set(['if', 'for', 'while', 'switch', 'with', 'return', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'of', 'new', 'throw', 'case', 'else', 'do', 'instanceof']);
const MEMBER_MODIFIERS = new Set(['get', 'set', 'async', 'static']);

/**
 * @typedef {{ t: 'id'|'num'|'p'|'lit'|'tpl', v: string, s: number, e: number, open?: boolean, close?: boolean }} JsToken
 */

/**
 * Tokens of the code parts of a script: identifiers (keywords included), numbers and
 * punctuators; each string or regex literal is one token; each template chunk is one token
 * that may close ("}" first) and open ("${" last) a substitution.
 * @param {string} src
 * @param {string} [file]
 * @returns {JsToken[]}
 */
export function tokenizeJs(src, file) {
  /** @type {JsToken[]} */
  const toks = [];
  for (const s of segmentJs(src, file)) {
    if (s.type === 'comment') continue;
    if (s.type === 'string' || s.type === 'regex') { toks.push({ t: 'lit', v: s.text, s: s.start, e: s.start + s.text.length }); continue; }
    if (s.type === 'template') {
      toks.push({ t: 'tpl', v: s.text, s: s.start, e: s.start + s.text.length, close: s.text[0] === '}', open: s.text.endsWith('${') });
      continue;
    }
    const text = s.text;
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      const at = s.start + i;
      if (ID_START.test(c) || c === '\\') {
        let j = i + 1;
        while (j < n && (ID_PART.test(text[j]) || text[j] === '\\')) j++;
        toks.push({ t: 'id', v: text.slice(i, j), s: at, e: s.start + j });
        i = j;
        continue;
      }
      if ((c >= '0' && c <= '9') || (c === '.' && text[i + 1] >= '0' && text[i + 1] <= '9')) {
        let j = i + 1;
        while (j < n && /[0-9a-zA-Z_.]/.test(text[j])) j++;
        toks.push({ t: 'num', v: text.slice(i, j), s: at, e: s.start + j });
        i = j;
        continue;
      }
      let p = PUNCTUATORS.find((x) => text.startsWith(x, i)) ?? c;
      if (p === '?.' && text[i + 2] >= '0' && text[i + 2] <= '9') p = '?';
      toks.push({ t: 'p', v: p, s: at, e: at + p.length });
      i += p.length;
    }
  }
  return toks;
}

/**
 * Rename local bindings to short names (see the section comment above).
 * @param {string} src     a script body (no import or export statements)
 * @param {{ file?: string, reserved?: Iterable<string> }} [opts]
 * @returns {{ code: string, renamed: Map<string, string> }}
 */
export function shortenNames(src, opts = {}) {
  const file = opts.file ?? '<input>';
  const toks = tokenizeJs(src, file);
  const N = toks.length;
  const reserved = new Set(opts.reserved ?? []);
  const isP = (k, v) => k >= 0 && k < N && toks[k].t === 'p' && toks[k].v === v;
  const afterDot = (k) => k > 0 && toks[k - 1].t === 'p' && (toks[k - 1].v === '.' || toks[k - 1].v === '?.');
  const isKw = (k, set) => k >= 0 && k < N && toks[k].t === 'id' && set.has(toks[k].v) && !afterDot(k);
  const kw = (k, v) => k >= 0 && k < N && toks[k].t === 'id' && toks[k].v === v && !afterDot(k);

  // Pass 1: bracket frames, colon kinds, top-level regions.
  const match = new Int32Array(N).fill(-1);
  /** @type {any[]} */
  const frameOf = new Array(N);
  /** @type {(string|undefined)[]} */
  const colon = new Array(N);
  const region = new Int32Array(N);
  const top = new Uint8Array(N);
  let cur = { kind: 'block', q: 0, cq: 0, cls: false, open: -1 };
  const stack = [];
  let reg = 0;
  const closerOf = (k) => (k === 'paren' ? ')' : k === 'bracket' ? ']' : '}');
  const braceKind = (i) => {
    if (cur.cls) return 'class';
    const p = i > 0 ? toks[i - 1] : null;
    if (!p) return 'block';
    if (p.t === 'p') {
      if (p.v === ')' || p.v === '=>' || p.v === ';' || p.v === '}' || p.v === '{') return 'block';
      if (p.v === ':') return colon[i - 1] === 'case' || colon[i - 1] === 'label' ? 'block' : 'obj';
      if (p.v === ']') return 'unknown';
      return 'obj';
    }
    if (p.t === 'id' && !afterDot(i - 1)) {
      if (BLOCK_BEFORE_BRACE.has(p.v)) return 'block';
      if (EXPR_BEFORE_BRACE.has(p.v)) return 'obj';
    }
    if (p.t === 'tpl' && p.open) return 'obj';
    return 'unknown';
  };
  for (let i = 0; i < N; i++) {
    const tk = toks[i];
    if (!stack.length && tk.t === 'id' && /^(const|let|var|function|class)$/.test(tk.v) && !afterDot(i)) reg++;
    region[i] = reg;
    top[i] = stack.length ? 0 : 1;
    frameOf[i] = cur;
    if (tk.t === 'p') {
      const v = tk.v;
      if (v === '{' || v === '(' || v === '[') {
        const kind = v === '(' ? 'paren' : v === '[' ? 'bracket' : braceKind(i);
        if (v === '{') cur.cls = false;
        stack.push(cur);
        cur = { kind, q: 0, cq: 0, cls: false, open: i };
      } else if (v === '}' || v === ')' || v === ']') {
        if (!stack.length || closerOf(cur.kind) !== v) throw new BuildError(file + ': unbalanced "' + v + '" at offset ' + tk.s);
        match[cur.open] = i;
        match[i] = cur.open;
        cur = stack.pop();
      } else if (v === '?') cur.q++;
      else if (v === ':') {
        if (cur.q > 0) { cur.q--; colon[i] = 'ternary'; }
        else if (cur.kind === 'obj' || cur.kind === 'class') colon[i] = 'key';
        else if (cur.cq > 0) { cur.cq--; colon[i] = 'case'; }
        else colon[i] = 'label';
      }
    } else if (tk.t === 'tpl') {
      if (tk.close) {
        if (cur.kind !== 'tpl') throw new BuildError(file + ': unbalanced template substitution at offset ' + tk.s);
        match[cur.open] = i;
        match[i] = cur.open;
        cur = stack.pop();
      }
      if (tk.open) { stack.push(cur); cur = { kind: 'tpl', q: 0, cq: 0, cls: false, open: i }; }
    } else if (tk.t === 'id' && !afterDot(i)) {
      if (tk.v === 'case' && cur.kind !== 'obj' && cur.kind !== 'class') cur.cq++;
      else if (tk.v === 'class' && !isP(i + 1, ':')) cur.cls = true;
    }
  }
  if (stack.length) throw new BuildError(file + ': unbalanced brackets at the end of the input');

  // Pass 2: binding frames (parameter lists and destructuring patterns).
  const bind = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const tk = toks[i];
    if (tk.t !== 'p') continue;
    if (tk.v === '(') {
      const j = match[i];
      if (isP(j + 1, '=>')) bind[i] = 1;
      else if (isP(j + 1, '{') && i > 0 && toks[i - 1].t === 'id' && !isKw(i - 1, CONTROL_BEFORE_PAREN)) bind[i] = 1;
    } else if (tk.v === '{' || tk.v === '[') {
      const F = frameOf[i];
      if (isKw(i - 1, new Set(['const', 'let', 'var']))) bind[i] = 1;
      else if (F.open >= 0 && bind[F.open] && i > 0 && toks[i - 1].t === 'p' &&
        (['(', '[', ',', '...', '{'].includes(toks[i - 1].v) || (toks[i - 1].v === ':' && colon[i - 1] === 'key'))) bind[i] = 1;
    }
  }

  // Pass 3: roles and declarations.
  /** @type {(string|null)[]} */
  const role = new Array(N).fill(null);
  const unsafe = new Set();
  const declaredIn = new Map();   // name -> Set of regions
  const declaredTop = new Set();
  const keyPos = (k, F) => k >= 0 && toks[k].t === 'p' && ((toks[k].v === '{' && k === F.open) || toks[k].v === ',');
  for (let i = 0; i < N; i++) {
    const tk = toks[i];
    if (tk.t !== 'id' || RESERVED_WORDS.has(tk.v)) continue;
    const F = frameOf[i];
    const prev = i > 0 ? toks[i - 1] : null;
    let r;
    if (prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.' || prev.v === '#')) r = 'prop';
    else if (F.kind === 'obj') {
      if (keyPos(i - 1, F)) {
        if (isP(i + 1, ':') || isP(i + 1, '(')) r = 'prop';
        else if (isP(i + 1, ',') || isP(i + 1, '=') || (isP(i + 1, '}') && match[i + 1] === F.open)) r = 'short';
        else r = 'unknown';
      } else if ((isKw(i - 1, MEMBER_MODIFIERS) && keyPos(i - 2, F)) ||
        (isP(i - 1, '*') && (keyPos(i - 2, F) || (kw(i - 2, 'async') && keyPos(i - 3, F))))) {
        r = isP(i + 1, '(') ? 'prop' : 'unknown';
      } else r = 'ref';
    } else if (F.kind === 'class') {
      const p = i > 0 ? toks[i - 1] : null;
      const memberStart = p && ((p.t === 'p' && ['{', '}', ';', '*'].includes(p.v)) || isKw(i - 1, MEMBER_MODIFIERS));
      r = memberStart && isP(i + 1, '(') ? 'prop' : 'unknown';
    } else if (F.kind === 'unknown' && keyPos(i - 1, F)) r = 'unknown';
    else if (isP(i + 1, ':') && colon[i + 1] === 'label') r = 'unknown';
    else if (kw(i - 1, 'break') || kw(i - 1, 'continue')) r = 'unknown';
    else r = 'ref';
    role[i] = r;
    if (r === 'unknown') { unsafe.add(tk.v); continue; }
    if (r === 'prop') continue;
    // Declarations.
    let declared = false;
    if (kw(i - 1, 'const') || kw(i - 1, 'let') || kw(i - 1, 'var') || kw(i - 1, 'function') || kw(i - 1, 'class')) declared = true;
    else if (isP(i - 1, '*') && kw(i - 2, 'function')) declared = true;
    else if (isP(i + 1, '=>')) declared = true;
    else if (F.open >= 0 && bind[F.open] && prev && prev.t === 'p' &&
      (['(', '[', ',', '...', '{'].includes(prev.v) || (prev.v === ':' && colon[i - 1] === 'key')) &&
      i + 1 < N && toks[i + 1].t === 'p' && [',', ')', ']', '}', '='].includes(toks[i + 1].v)) declared = true;
    if (declared) {
      if (top[i] || (i > 0 && top[i - 1] && F.open < 0)) declaredTop.add(tk.v);
      let set = declaredIn.get(tk.v);
      if (!set) declaredIn.set(tk.v, (set = new Set()));
      set.add(region[i]);
    }
  }

  // Which names may be renamed: declared, never unclassifiable, and declared in every region
  // that references them (or at the top level of the bundle).
  const count = new Map();
  const regionsOf = new Map();
  const used = new Set(reserved);
  for (let i = 0; i < N; i++) {
    const tk = toks[i];
    if (tk.t !== 'id') continue;
    used.add(tk.v);
    if (role[i] === 'ref' || role[i] === 'short') {
      count.set(tk.v, (count.get(tk.v) ?? 0) + 1);
      let set = regionsOf.get(tk.v);
      if (!set) regionsOf.set(tk.v, (set = new Set()));
      set.add(region[i]);
    }
  }
  const candidates = [];
  for (const [name, c] of count) {
    if (unsafe.has(name) || reserved.has(name) || KNOWN_GLOBALS.has(name) || RESERVED_WORDS.has(name)) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
    const decl = declaredIn.get(name);
    if (!decl) continue;
    if (!declaredTop.has(name) && ![...regionsOf.get(name)].every((g) => decl.has(g))) continue;
    candidates.push([name, c]);
  }
  candidates.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const renamed = new Map();
  const gen = shortNameGenerator((x) => !used.has(x) && !RESERVED_WORDS.has(x) && !KNOWN_GLOBALS.has(x) && !JS_ALL_KEYWORDS.has(x));
  for (const [name] of candidates) {
    const nn = gen.next().value;
    if (nn.length >= name.length) continue;
    renamed.set(name, nn);
  }

  let out = '';
  let pos = 0;
  for (let i = 0; i < N; i++) {
    const tk = toks[i];
    if (tk.t !== 'id' || (role[i] !== 'ref' && role[i] !== 'short')) continue;
    const nn = renamed.get(tk.v);
    if (!nn) continue;
    out += src.slice(pos, tk.s) + (role[i] === 'short' ? tk.v + ':' + nn : nn);
    pos = tk.e;
  }
  out += src.slice(pos);
  return { code: out, renamed };
}

/** Every reserved word of JavaScript, including the strict-mode and contextual ones. */
const JS_ALL_KEYWORDS = new Set([...RESERVED_WORDS, 'do', 'if', 'in', 'of', 'as', 'is']);

/**
 * Short identifiers in length order: a..z A..Z _ $, then two characters, and so on.
 * @param {(name: string) => boolean} ok
 */
function* shortNameGenerator(ok) {
  const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
  const rest = first + '0123456789';
  for (let len = 1; ; len++) {
    const idx = new Array(len).fill(0);
    for (;;) {
      let name = first[idx[0]];
      for (let k = 1; k < len; k++) name += rest[idx[k]];
      if (ok(name)) yield name;
      let k = len - 1;
      while (k >= 0) {
        idx[k]++;
        if (idx[k] < (k === 0 ? first.length : rest.length)) break;
        idx[k] = 0;
        k--;
      }
      if (k < 0) break;
    }
  }
}

/**
 * Remove the spaces and newlines that JavaScript does not need, outside strings, templates and
 * regex literals. A space stays where two tokens would merge (identifier or number characters
 * on both sides, "+ +", "- -", a number before "."), and where it would create "<!--", "-->",
 * "?." or a comment. A newline is dropped only after "{", "(", "[", "," or ";" or before "}",
 * ")" or "]", where automatic semicolon insertion cannot depend on it.
 * @param {string} src
 * @param {string} [file]
 * @returns {string}
 */
export function compactJs(src, file) {
  const segs = segmentJs(src, file).filter((s) => s.type !== 'comment');
  const idc = (ch) => ch !== undefined && (ID_PART.test(ch) || ch === '\\');
  let out = '';
  let regexEnd = -1;   // out.length right after the last regex literal (its flags must not grow)
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    if (s.type !== 'code') { out += s.text; if (s.type === 'regex') regexEnd = out.length; continue; }
    const t = s.text.replace(/\r/g, '');
    const nextFirst = si + 1 < segs.length ? segs[si + 1].text[0] : undefined;
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c !== ' ' && c !== '\t' && c !== '\n') { out += c; i++; continue; }
      let j = i;
      let nl = false;
      while (j < t.length && (t[j] === ' ' || t[j] === '\t' || t[j] === '\n')) { if (t[j] === '\n') nl = true; j++; }
      const a = out[out.length - 1];
      const b = j < t.length ? t[j] : nextFirst;
      i = j;
      if (a === undefined || b === undefined) { if (nl && a !== undefined) out += '\n'; continue; }
      if (nl) {
        if ('{([,;'.includes(a) || '})]'.includes(b)) continue;
        out += '\n';
        continue;
      }
      const keep = (idc(a) && idc(b)) || (out.length === regexEnd && idc(b)) || (a === '+' && b === '+') || (a === '-' && b === '-') ||
        (/[0-9]/.test(a) && b === '.') || (a === '<' && b === '!') || (a === '-' && b === '>') ||
        (a === '?' && b === '.') || (a === '/' && (b === '/' || b === '*'));
      if (keep) out += ' ';
    }
  }
  return out;
}

/**
 * Turn every `const` declaration into `let`, two bytes each. The sources run and are tested
 * with const, and the two keywords differ only for code that assigns to a const binding, which
 * would already throw in the source tree. Only a `const` that starts a declaration changes
 * (followed by a name, "{" or "[", and not after ".", "?." or "#"); a property or key named
 * const, and text inside strings, templates and regex literals, never change.
 * @param {string} src
 * @param {string} [file]
 * @returns {string}
 */
export function constToLet(src, file) {
  const toks = tokenizeJs(src, file);
  let out = '';
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== 'id' || tk.v !== 'const') continue;
    const prev = i > 0 ? toks[i - 1] : null;
    const next = i + 1 < toks.length ? toks[i + 1] : null;
    if (prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.' || prev.v === '#')) continue;
    if (!next || !(next.t === 'id' || (next.t === 'p' && (next.v === '{' || next.v === '[')))) continue;
    out += src.slice(pos, tk.s) + 'let';
    pos = tk.e;
  }
  return out + src.slice(pos);
}

/* ------------------------------------------------------------------------------------------
 * 2. Module analysis and rewriting
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {{ imported: string, local: string }} ImportBinding   imported '*' means namespace
 * @typedef {{ spec: string, bindings: ImportBinding[] }} ImportDecl
 * @typedef {{ kind: 'local', local: string } | { kind: 'from', spec: string, name: string } | { kind: 'ns', spec: string }} ExportTarget
 * @typedef {Object} ParsedModule
 * @property {string} body              module code with import/export statements rewritten away
 * @property {ImportDecl[]} imports      in source order (side-effect imports have no bindings)
 * @property {Map<string, ExportTarget>} exports
 * @property {string[]} starFrom         specifiers of `export * from`
 * @property {boolean} usesImportMeta
 * @property {boolean} topLevelAwait
 */

/**
 * Build a same-length mask where only code is visible: literals keep their delimiters and
 * newlines, comments become spaces.
 * @param {ReturnType<typeof segmentJs>} segs
 * @returns {string}
 */
function maskOf(segs) {
  let m = '';
  for (const s of segs) {
    if (s.type === 'code') m += s.text;
    else if (s.type === 'comment') m += s.text.replace(/[^\n]/g, ' ');
    else if (s.type === 'string') m += s.text[0] + s.text.slice(1, -1).replace(/[^\n]/g, '_') + s.text[s.text.length - 1];
    else m += s.text.replace(/[^\n]/g, '_');
  }
  return m;
}

/**
 * Parse and rewrite one ES module.
 * @param {string} src
 * @param {string} file
 * @returns {ParsedModule}
 */
export function parseModule(src, file = '<input>') {
  const segs = segmentJs(src, file);
  const mask = maskOf(segs);
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  /** @type {ImportDecl[]} */
  const imports = [];
  /** @type {Map<string, ExportTarget>} */
  const exports = new Map();
  const starFrom = [];
  let usesImportMeta = false;
  let topLevelAwait = false;
  let defaultCounter = 0;

  // Depth (braces, parens, brackets) at every offset of the mask.
  const depthAt = new Int32Array(mask.length + 1);
  let dd = 0;
  for (let k = 0; k < mask.length; k++) {
    depthAt[k] = dd;
    const ch = mask[k];
    if (ch === '{' || ch === '(' || ch === '[') dd++;
    else if (ch === '}' || ch === ')' || ch === ']') dd--;
  }
  depthAt[mask.length] = dd;

  const fail = (msg, at) => {
    const line = mask.slice(0, at).split('\n').length;
    throw new BuildError(file + ':' + line + ': ' + msg);
  };

  // Tiny token reader over the mask, starting at `pos`.
  const reader = (pos) => {
    let p = pos;
    const skipWs = () => { while (p < mask.length && /\s/.test(mask[p])) p++; };
    return {
      get pos() { return p; },
      peek() { skipWs(); return mask[p]; },
      word() {
        skipWs();
        if (!ID_START.test(mask[p] || '')) return null;
        const s = p;
        while (p < mask.length && ID_PART.test(mask[p])) p++;
        return mask.slice(s, p);
      },
      punct(ch) { skipWs(); if (mask[p] === ch) { p++; return true; } return false; },
      string() {
        skipWs();
        const q = mask[p];
        if (q !== '"' && q !== "'") return null;
        const s = p;
        p++;
        while (p < mask.length && mask[p] !== q) p++;
        p++;
        return JSON.parse('"' + src.slice(s + 1, p - 1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
      },
      // optional import attributes: with { type: 'json' } / assert { ... }
      attributes() {
        const save = p;
        const w = this.word();
        if (w === 'with' || w === 'assert') {
          if (!this.punct('{')) fail('bad import attributes', p);
          while (p < mask.length && mask[p] !== '}') p++;
          p++;
          return true;
        }
        p = save;
        return false;
      },
      semi() { const save = p; skipWs(); if (mask[p] === ';') { p++; return; } p = save; },
    };
  };

  const specList = (r, isExport) => {
    const out = [];
    if (!r.punct('{')) fail('expected {', r.pos);
    for (;;) {
      if (r.punct('}')) break;
      let name = r.word();
      if (name === null) {
        const s = r.string();
        if (s === null) fail('bad specifier list', r.pos);
        name = s;
      }
      let alias = name;
      const save = r.pos;
      if (r.word() === 'as') {
        alias = r.word();
        if (alias === null) { const s = r.string(); if (s === null) fail('bad alias', r.pos); alias = s; }
      } else {
        // not "as": rewind
        // eslint-free manual rewind: re-create reader at save
        r = reader(save);
      }
      out.push(isExport ? { local: name, exported: alias } : { imported: name, local: alias });
      if (r.punct(',')) continue;
      if (!r.punct('}')) fail('expected , or }', r.pos);
      break;
    }
    return { list: out, r };
  };

  const re = /\b(import|export|await)\b/g;
  let m;
  while ((m = re.exec(mask)) !== null) {
    const at = m.index;
    const kw = m[1];
    // Property access (x.import) and object keys are never statements.
    let b = at - 1;
    while (b >= 0 && /\s/.test(mask[b])) b--;
    if (b >= 0 && mask[b] === '.') continue;
    if (kw === 'await') {
      if (depthAt[at] === 0) topLevelAwait = true;
      continue;
    }
    const after = mask.slice(at + kw.length, at + kw.length + 40);
    if (kw === 'import') {
      if (/^\s*\./.test(after)) {
        if (/^\s*\.\s*meta\b/.test(after)) usesImportMeta = true;
        continue;
      }
      if (/^\s*\(/.test(after)) fail('dynamic import() is not allowed (DESIGN 8.10a)', at);
      if (depthAt[at] !== 0) continue;
      let r = reader(at + 6);
      /** @type {ImportBinding[]} */
      const bindings = [];
      let spec = r.string();
      if (spec === null) {
        const first = r.peek();
        if (first !== '{' && first !== '*') {
          const def = r.word();
          if (!def) fail('bad import', at);
          bindings.push({ imported: 'default', local: def });
          r.punct(',');
        }
        if (r.peek() === '*') {
          r.punct('*');
          if (r.word() !== 'as') fail('expected as', r.pos);
          const ns = r.word();
          if (!ns) fail('expected namespace name', r.pos);
          bindings.push({ imported: '*', local: ns });
        } else if (r.peek() === '{') {
          const res = specList(r, false);
          r = res.r;
          for (const x of res.list) bindings.push(x);
        }
        if (r.word() !== 'from') fail('expected from', r.pos);
        spec = r.string();
        if (spec === null) fail('expected module specifier', r.pos);
      }
      r.attributes();
      r.semi();
      imports.push({ spec, bindings });
      edits.push({ start: at, end: r.pos, text: '' });
      continue;
    }
    // export
    if (depthAt[at] !== 0) continue;
    let r = reader(at + 6);
    const next = r.peek();
    if (next === '{') {
      const res = specList(r, true);
      r = res.r;
      const save = r.pos;
      let from = null;
      if (r.word() === 'from') {
        from = r.string();
        if (from === null) fail('expected module specifier', r.pos);
        r.attributes();
      } else r = reader(save);
      r.semi();
      if (from !== null) imports.push({ spec: from, bindings: [] });
      for (const x of res.list) {
        exports.set(x.exported, from === null ? { kind: 'local', local: x.local } : { kind: 'from', spec: from, name: x.local });
      }
      edits.push({ start: at, end: r.pos, text: '' });
      continue;
    }
    if (next === '*') {
      r.punct('*');
      const save = r.pos;
      let nsName = null;
      if (r.word() === 'as') nsName = r.word();
      else r = reader(save);
      if (r.word() !== 'from') fail('expected from', r.pos);
      const from = r.string();
      if (from === null) fail('expected module specifier', r.pos);
      r.attributes();
      r.semi();
      imports.push({ spec: from, bindings: [] });
      if (nsName) exports.set(nsName, { kind: 'ns', spec: from });
      else starFrom.push(from);
      edits.push({ start: at, end: r.pos, text: '' });
      continue;
    }
    const w = r.word();
    if (w === 'default') {
      const afterDefault = r.pos;
      const r2 = reader(afterDefault);
      let w2 = r2.word();
      let name = null;
      if (w2 === 'async') w2 = r2.word();
      if (w2 === 'function' || w2 === 'class') {
        r2.punct('*');
        const nm = r2.word();
        if (nm && nm !== 'extends') name = nm;
      }
      if (name) {
        exports.set('default', { kind: 'local', local: name });
        edits.push({ start: at, end: afterDefault, text: '' });
      } else {
        const local = '__ar_default' + (defaultCounter++ || '');
        exports.set('default', { kind: 'local', local });
        edits.push({ start: at, end: afterDefault, text: 'const ' + local + ' =' });
      }
      continue;
    }
    if (w === 'const' || w === 'let' || w === 'var') {
      const nm = r.word();
      if (!nm) fail('destructuring exports are not supported by the bundler', at);
      exports.set(nm, { kind: 'local', local: nm });
      edits.push({ start: at, end: at + 6, text: '' });
      continue;
    }
    if (w === 'function' || w === 'class' || w === 'async') {
      let w2 = w;
      if (w === 'async') w2 = r.word();
      if (w2 !== 'function' && w2 !== 'class') fail('unsupported export form', at);
      r.punct('*');
      const nm = r.word();
      if (!nm) fail('exported declaration needs a name', at);
      exports.set(nm, { kind: 'local', local: nm });
      edits.push({ start: at, end: at + 6, text: '' });
      continue;
    }
    fail('unsupported export form', at);
  }

  let body = '';
  let cur = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    body += src.slice(cur, e.start) + e.text;
    cur = e.end;
  }
  body += src.slice(cur);
  if (body.startsWith('#!')) body = body.replace(/^#![^\n]*/, '');
  return { body, imports, exports, starFrom, usesImportMeta, topLevelAwait };
}

/* ------------------------------------------------------------------------------------------
 * 3. Linking
 * ---------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} BundleOptions
 * @property {string} entry                     absolute path of the entry module
 * @property {'node'|'browser'} target
 * @property {Map<string, string>} [overrides]  absolute path -> replacement module source
 * @property {boolean} [minify]                 default true
 * @property {boolean} [mangle]                 short local names and tight spacing (default: minify)
 * @property {string} [root]                    paths in comments are shown relative to this
 */

/**
 * Bundle an ES module graph into one script.
 * - target 'node': an ES module (node builtins stay as top-level imports; top-level await ok).
 * - target 'browser': a classic script wrapped in a strict IIFE; no node builtins, no
 *   import.meta, no top-level await.
 * @param {BundleOptions} opts
 * @returns {{ code: string, modules: string[], builtins: string[] }}
 */
export function bundle(opts) {
  const root = opts.root ?? REPO_ROOT;
  const overrides = opts.overrides ?? new Map();
  const minify = opts.minify !== false;
  /** @type {Map<string, { id: number, file: string, parsed: ParsedModule|null, kind: 'js'|'json'|'bin', resolved: Map<string, string> }>} */
  const mods = new Map();
  const order = [];
  const builtins = new Set();
  const visiting = new Set();
  let nextId = 0;
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');

  const resolveSpec = (spec, from) => {
    if (spec.startsWith('node:')) {
      if (opts.target === 'browser') throw new BuildError(rel(from) + ': browser bundle must not import ' + spec);
      builtins.add(spec);
      return spec;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      throw new BuildError(rel(from) + ': bare import "' + spec + '" is not allowed (zero runtime dependencies; use node: builtins or relative paths)');
    }
    return path.resolve(path.dirname(from), spec);
  };

  const visit = (file, chain) => {
    if (mods.has(file)) return;
    if (visiting.has(file)) throw new BuildError('import cycle: ' + [...chain, file].map(rel).join(' -> '));
    visiting.add(file);
    const ext = path.extname(file).toLowerCase();
    const rec = { id: nextId++, file, parsed: null, kind: 'js', resolved: new Map() };
    if (ext === '.json' || ext === '.bin') {
      if (!overrides.has(file) && !fs.existsSync(file)) throw new BuildError('missing module ' + rel(file) + (chain.length ? ' (imported by ' + rel(chain[chain.length - 1]) + ')' : ''));
      rec.kind = ext === '.json' ? 'json' : 'bin';
    } else {
      let src;
      if (overrides.has(file)) src = /** @type {string} */ (overrides.get(file));
      else {
        if (!fs.existsSync(file)) throw new BuildError('missing module ' + rel(file) + (chain.length ? ' (imported by ' + rel(chain[chain.length - 1]) + ')' : ''));
        src = fs.readFileSync(file, 'utf8');
      }
      const parsed = parseModule(src, rel(file));
      if (opts.target === 'browser' && parsed.usesImportMeta) throw new BuildError(rel(file) + ': import.meta is not available in the browser bundle');
      if (opts.target === 'browser' && parsed.topLevelAwait) throw new BuildError(rel(file) + ': top-level await is not available in the browser bundle');
      rec.parsed = parsed;
      for (const imp of parsed.imports) {
        const target = resolveSpec(imp.spec, file);
        rec.resolved.set(imp.spec, target);
        if (!target.startsWith('node:')) visit(target, [...chain, file]);
      }
    }
    visiting.delete(file);
    mods.set(file, rec);
    order.push(file);
  };
  visit(path.resolve(opts.entry), []);

  const varOf = (target) => (target.startsWith('node:') ? '__arn_' + target.slice(5).replace(/[^A-Za-z0-9_]/g, '_') : '__ar' + /** @type {any} */ (mods.get(target)).id);

  // Export names per module (for export * and namespace getters).
  const exportNames = new Map();
  const namesOf = (file, seen = new Set()) => {
    if (exportNames.has(file)) return exportNames.get(file);
    if (seen.has(file)) return [];
    seen.add(file);
    const rec = mods.get(file);
    if (!rec) return [];
    let names;
    if (rec.kind === 'json' || rec.kind === 'bin') names = ['default'];
    else {
      const p = /** @type {ParsedModule} */ (rec.parsed);
      const set = new Set(p.exports.keys());
      for (const spec of p.starFrom) {
        const t = rec.resolved.get(spec);
        if (t && !t.startsWith('node:')) for (const x of namesOf(t, seen)) if (x !== 'default') set.add(x);
      }
      names = [...set];
    }
    exportNames.set(file, names);
    return names;
  };

  const key = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

  // Short export keys (mangle only). A module's namespace object is read only by the imports
  // this bundler writes, so its keys can be short and its values plain (named imports are
  // destructured once when the importer starts, after the exporter has finished, so a getter
  // would return the same value), and a plain object: nothing else ever sees it, so it is not
  // frozen and keeps its prototype (a short key is never a name Object.prototype defines).
  // Full names, live getters and a frozen null-prototype object stay for the entry (its exports
  // are the bundle's interface), modules imported as a namespace, and re-export targets of
  // `export *` and `export * as ns`.
  const mangle = minify && opts.mangle !== false;
  const fullKeys = new Set([path.resolve(opts.entry)]);
  for (const r of mods.values()) {
    if (!r.parsed) continue;
    for (const imp of r.parsed.imports) for (const b of imp.bindings) if (b.imported === '*') fullKeys.add(r.resolved.get(imp.spec));
    for (const [, tgt] of r.parsed.exports) if (tgt.kind === 'ns') fullKeys.add(r.resolved.get(tgt.spec));
    for (const spec of r.parsed.starFrom) fullKeys.add(r.resolved.get(spec));
  }
  const shortKeyMaps = new Map();
  const keyOf = (file, name) => {
    if (!mangle || name === 'default' || file.startsWith('node:') || fullKeys.has(file)) return name;
    let m = shortKeyMaps.get(file);
    if (!m) {
      m = new Map();
      const gen = shortNameGenerator((x) => !JS_ALL_KEYWORDS.has(x));
      for (const n of namesOf(file)) if (n !== 'default') m.set(n, gen.next().value);
      shortKeyMaps.set(file, m);
    }
    return m.get(name) ?? name;
  };

  const parts = [];
  for (const file of order) {
    const rec = /** @type {any} */ (mods.get(file));
    const v = varOf(file);
    if (rec.kind === 'json') {
      const raw = overrides.has(file) ? overrides.get(file) : fs.readFileSync(file, 'utf8');
      const value = JSON.parse(raw);
      parts.push('// ' + rel(file) + '\nconst ' + v + ' = Object.freeze({ default: ' + JSON.stringify(value) + ' });');
      continue;
    }
    if (rec.kind === 'bin') {
      const bytes = overrides.has(file) ? Buffer.from(/** @type {string} */ (overrides.get(file)), 'base64') : fs.readFileSync(file);
      parts.push('// ' + rel(file) + '\nconst ' + v + ' = Object.freeze({ default: __arB64(' + JSON.stringify(bytes.toString('base64')) + ') });');
      continue;
    }
    const p = /** @type {ParsedModule} */ (rec.parsed);
    const head = [];
    for (const imp of p.imports) {
      const t = rec.resolved.get(imp.spec);
      const dv = varOf(t);
      const named = [];
      for (const bnd of imp.bindings) {
        if (bnd.imported === '*') head.push('const ' + bnd.local + ' = ' + dv + ';');
        else if (bnd.imported === 'default') head.push('const ' + bnd.local + ' = ' + dv + '.default;');
        else {
          const k = t.startsWith('node:') ? bnd.imported : keyOf(t, bnd.imported);
          named.push(k === bnd.local ? key(k) : key(k) + ': ' + bnd.local);
        }
      }
      if (named.length) head.push('const { ' + named.join(', ') + ' } = ' + dv + ';');
      if (t && !t.startsWith('node:')) {
        for (const bnd of imp.bindings) {
          if (bnd.imported !== '*' && !namesOf(t).includes(bnd.imported)) {
            throw new BuildError(rel(file) + ': "' + bnd.imported + '" is not exported by ' + rel(t));
          }
        }
      }
    }
    const getters = [];
    const plain = mangle && !fullKeys.has(file);
    const member = (name, expr) => getters.push(plain ? key(keyOf(file, name)) + ': ' + expr : 'get ' + key(name) + '() { return ' + expr + '; }');
    const from = (t, name) => varOf(t) + '[' + JSON.stringify(t.startsWith('node:') ? name : keyOf(t, name)) + ']';
    for (const [name, tgt] of p.exports) {
      if (tgt.kind === 'local') member(name, tgt.local);
      else if (tgt.kind === 'ns') member(name, varOf(rec.resolved.get(tgt.spec)));
      else {
        const t = rec.resolved.get(tgt.spec);
        if (!t.startsWith('node:') && !namesOf(t).includes(tgt.name)) throw new BuildError(rel(file) + ': "' + tgt.name + '" is not exported by ' + rel(t));
        member(name, from(t, tgt.name));
      }
    }
    for (const spec of p.starFrom) {
      const t = rec.resolved.get(spec);
      for (const name of namesOf(t)) {
        if (name === 'default' || p.exports.has(name)) continue;
        member(name, from(t, name));
      }
    }
    const asyncWrap = p.topLevelAwait;
    parts.push(
      '// ' + rel(file) + '\n' +
      'const ' + v + ' = ' + (asyncWrap ? 'await (async () => {\n' : '(() => {\n') +
      head.join('\n') + (head.length ? '\n' : '') +
      p.body + '\n' +
      (plain ? 'return { ' + getters.join(', ') + ' };\n' : 'return Object.freeze({ __proto__: null, ' + getters.join(', ') + ' });\n') +
      '})();',
    );
  }

  const needsB64 = [...mods.values()].some((r) => r.kind === 'bin');
  const prelude = needsB64
    ? 'const __arB64 = (s) => { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };\n'
    : '';
  let body = prelude + parts.join('\n');
  if (minify) body = minifyJs(body, 'bundle');
  if (minify && opts.mangle !== false) {
    // The builtin namespaces are bound by the import lines outside the body; the entry module's
    // namespace variable (__ar0) keeps its name, as the one handle on the bundle's exports.
    const reserved = [...[...builtins].map((b) => varOf(b)), varOf(path.resolve(opts.entry))];
    body = constToLet(compactJs(shortenNames(body, { file: 'bundle', reserved }).code, 'bundle'), 'bundle');
  }

  let code;
  if (opts.target === 'node') {
    const heads = [...builtins].sort().map((b) => 'import * as ' + varOf(b) + " from '" + b + "';");
    code = heads.join('\n') + (heads.length ? '\n' : '') + body + '\n';
  } else {
    code = '(function () {\n"use strict";\n' + body + '\n})();\n';
  }
  return { code, modules: order.map(rel), builtins: [...builtins].sort() };
}

/* ------------------------------------------------------------------------------------------
 * 4. The HTML template and the Node bundle
 * ---------------------------------------------------------------------------------------- */

/** Placeholders in src/web/template.html. */
export const TEMPLATE_SLOTS = Object.freeze({
  csp: '%%AR_CSP%%',
  app: '/*%%AR_APP%%*/',
  worker: '/*%%AR_WORKER%%*/',
  glyphs: '%%AR_GLYPHS%%',
  version: '%%AR_VERSION%%',
});

/** The glyph atlas module; browser bundles get a stand-in that reads the ar-glyphs block. */
export const GLYPHS_MODULE = path.join('src', 'core', 'card', 'glyphs.js');

/**
 * The glyph atlas as the page carries it: base64 of src/core/card/glyphs.bin, checked against the
 * SHA-256, size and base64 text that src/core/card/glyphs.js declares (the two must agree, or the
 * card would fail its checksum in the browser).
 * @param {string} [root]
 * @returns {{ base64: string, sha256: string, rawBytes: number }}
 */
export function readGlyphAtlas(root = REPO_ROOT) {
  const src = fs.readFileSync(path.join(root, GLYPHS_MODULE), 'utf8');
  const bin = fs.readFileSync(path.join(root, 'src', 'core', 'card', 'glyphs.bin'));
  const sha = /GLYPH_ATLAS_SHA256 = '([0-9a-f]{64})'/.exec(src);
  const raw = /GLYPH_ATLAS_RAW_BYTES = (\d+)/.exec(src);
  const b64 = /GLYPH_ATLAS_BASE64 = \(([\s\S]*?)\);/.exec(src);
  if (!sha || !raw || !b64) throw new BuildError(GLYPHS_MODULE + ': expected GLYPH_ATLAS_SHA256, GLYPH_ATLAS_RAW_BYTES and GLYPH_ATLAS_BASE64');
  const base64 = bin.toString('base64');
  if (crypto.createHash('sha256').update(bin).digest('hex') !== sha[1]) throw new BuildError('glyphs.bin does not match the SHA-256 in glyphs.js (run scripts/build-glyphs.mjs)');
  const declared = [...b64[1].matchAll(/'([A-Za-z0-9+/=]*)'/g)].map((x) => x[1]).join('');
  if (declared !== base64) throw new BuildError('glyphs.js GLYPH_ATLAS_BASE64 is not the base64 of glyphs.bin (run scripts/build-glyphs.mjs)');
  return { base64, sha256: sha[1], rawBytes: Number(raw[1]) };
}

/**
 * Stand-in for src/core/card/glyphs.js inside the browser bundles: the atlas is read once from
 * the page's <script type="text/plain" id="ar-glyphs"> block, so the page and the Node bundle
 * each carry it once instead of twice. core/card/atlas.js still checks its SHA-256.
 * @param {{ sha256: string, rawBytes: number }} atlas
 * @returns {string}
 */
export function domGlyphsModuleSource(atlas) {
  return '// Generated by scripts/build.mjs: the glyph atlas comes from the ar-glyphs block of the page.\n' +
    "const el = typeof document === 'object' && document ? document.getElementById('ar-glyphs') : null;\n" +
    "export const GLYPH_ATLAS_BASE64 = el ? String(el.textContent || '').trim() : '';\n" +
    'export const GLYPH_ATLAS_SHA256 = ' + JSON.stringify(atlas.sha256) + ';\n' +
    'export const GLYPH_ATLAS_RAW_BYTES = ' + atlas.rawBytes + ';\n';
}

/**
 * Escape a script body for a raw-text <script> element, so neither "</" nor the "<!--" plus
 * "<script" sequence of the HTML tokenizer's double-escaped state can occur. The escapes
 * (\/, !, s) mean the same inside JS strings, templates and regex literals (u flag
 * included); every escaped script is compiled with node:vm afterwards to prove it still parses.
 * @param {string} js
 * @returns {string}
 */
export function escapeScriptText(js) {
  return js
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\x21--')
    .replace(/<(script)/gi, (m, w) => '<\\x' + w.charCodeAt(0).toString(16) + w.slice(1));
}

/**
 * Build the complete report/app HTML template: app script, worker source, glyph atlas and CSP
 * inlined. The data slots (ar-data, ar-demo) stay "null"; src/node/report.js fills ar-data.
 * @param {{ root?: string, version?: string, minify?: boolean, mangle?: boolean, overrides?: Map<string, string> }} [opts]
 * @returns {{ html: string, appScript: string, workerScript: string, csp: string, glyphs: string }}
 */
export function buildTemplate(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const version = opts.version ?? readVersion(root);
  const tplPath = path.join(root, 'src', 'web', 'template.html');
  let html = fs.readFileSync(tplPath, 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['csp', 'app', 'worker', 'glyphs']) {
    const slot = TEMPLATE_SLOTS[name];
    const count = html.split(slot).length - 1;
    if (count !== 1) throw new BuildError('template.html must contain ' + slot + ' exactly once (found ' + count + ')');
  }
  const atlas = readGlyphAtlas(root);
  const overrides = new Map(opts.overrides ?? []);
  overrides.set(path.join(root, GLYPHS_MODULE), domGlyphsModuleSource(atlas));
  const app = bundle({ entry: path.join(root, 'src', 'web', 'app.js'), target: 'browser', root, minify: opts.minify, mangle: opts.mangle, overrides });
  const worker = bundle({ entry: path.join(root, 'src', 'web', 'worker.js'), target: 'browser', root, minify: opts.minify, mangle: opts.mangle, overrides });
  const appScript = '\n' + escapeScriptText(app.code);
  const workerScript = '\n' + escapeScriptText(worker.code);
  // The app script is hashed into the CSP before the version is filled in, so it must not
  // contain any placeholder; and both scripts must still parse after escaping.
  if (appScript.includes('%%AR_')) throw new BuildError('src/web/app.js must not contain a %%AR_ placeholder (it would change the CSP-hashed script)');
  for (const [name, code] of [['app', appScript], ['worker', workerScript]]) {
    try { new vm.Script(code, { filename: name + '.js' }); } catch (e) { throw new BuildError('the escaped ' + name + ' script does not parse: ' + (e instanceof Error ? e.message : String(e))); }
  }
  const csp = cspFor(cspHash(appScript));
  html = html
    .replace(TEMPLATE_SLOTS.csp, () => csp)
    .replace(TEMPLATE_SLOTS.glyphs, () => atlas.base64)
    .replace(TEMPLATE_SLOTS.app, () => appScript)
    .replace(TEMPLATE_SLOTS.worker, () => workerScript)
    .split(TEMPLATE_SLOTS.version).join(version);
  return { html, appScript, workerScript, csp, glyphs: atlas.base64 };
}

/**
 * @param {string} root
 * @returns {string}
 */
export function readVersion(root = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** Module that receives the built template in the Node bundle (its EMBEDDED_TEMPLATE marker). */
export const TEMPLATE_SOURCE_MODULE = path.join('src', 'node', 'report.js');

/** The marker in src/node/report.js that the build replaces with the template. */
export const REPORT_TEMPLATE_MARKER = '/* @ar-build:report-template */ null';

const WORKER_BLOCK_RE = /(<script type="text\/plain" id="ar-worker">)([\s\S]*?)(<\/script>)/;

/**
 * The page the CLI writes its reports into: the built template with the ar-worker block left
 * empty. A CLI report always embeds its Summary, so it never enters drop mode and never starts
 * the worker (app.js offers "Scan another folder" only on a dropped report); drop mode lives in
 * the standalone dist/auditrail.html, which keeps the worker. The executable app script,
 * and so the CSP hash, is identical in both pages.
 * @param {string} html  the built template (buildTemplate().html)
 * @returns {string}
 */
export function cliTemplate(html) {
  const m = html.match(new RegExp(WORKER_BLOCK_RE.source, 'g'));
  if (!m || m.length !== 1) throw new BuildError('the template must carry the ar-worker block exactly once');
  return html.replace(WORKER_BLOCK_RE, (_all, open, _body, close) => open + close);
}

/**
 * The import of the source-checkout page builder in src/node/report.js. The Node bundle gets a
 * stub in its place (the bundle carries the built page), so the build script never enters dist.
 */
export const DEV_TEMPLATE_IMPORT = "import { devReportTemplate } from './dev-template.js';";

/**
 * Brotli settings for the packed report page: text mode, best quality. Brotli packs the page
 * smaller than raw deflate at level 9 did, and node:zlib decodes both. Like zlib, the output
 * depends on the library Node ships, so release hashes are built on one pinned Node.
 * @param {number} size input bytes
 */
export function brotliOptions(size) {
  const c = zlib.constants;
  return { params: { [c.BROTLI_PARAM_MODE]: c.BROTLI_MODE_TEXT, [c.BROTLI_PARAM_QUALITY]: c.BROTLI_MAX_QUALITY, [c.BROTLI_PARAM_LGWIN]: c.BROTLI_MAX_WINDOW_BITS, [c.BROTLI_PARAM_SIZE_HINT]: size } };
}

/**
 * Source of src/node/report.js for the Node bundle: the EMBEDDED_TEMPLATE marker becomes a
 * function that returns the built template, and the dev-template import becomes a stub. The
 * template is stored Brotli-compressed and base64 encoded (it is page data, not code the Node
 * process runs, and the same page ships readable as dist/auditrail.html), decompressed with
 * node:zlib only when a report is rendered (the launcher and the other commands never unpack
 * it), and checked against its SHA-256 before use. The glyph atlas is not repeated: the
 * template is split around the ar-glyphs block and joined with the atlas string the bundle
 * already carries for the CLI card (src/core/card/glyphs.js), so the report page gets the same
 * bytes the build checked.
 * @param {string} reportSrc  the source of src/node/report.js
 * @param {string} html       the template to embed
 * @param {string} glyphs     the atlas base64 inside html
 * @returns {string}
 */
export function templateModuleSource(reportSrc, html, glyphs) {
  const rel = TEMPLATE_SOURCE_MODULE.split(path.sep).join('/');
  const n = reportSrc.split(REPORT_TEMPLATE_MARKER).length - 1;
  if (n !== 1) throw new BuildError(rel + ' must contain the marker ' + REPORT_TEMPLATE_MARKER + ' exactly once (found ' + n + ')');
  const d = reportSrc.split(DEV_TEMPLATE_IMPORT).length - 1;
  if (d !== 1) throw new BuildError(rel + ' must contain the line ' + DEV_TEMPLATE_IMPORT + ' exactly once (found ' + d + ')');
  const at = html.indexOf('id="ar-glyphs">' + glyphs + '</script>');
  const cut = at + 'id="ar-glyphs">'.length;
  if (at < 0 || html.indexOf(glyphs, cut + glyphs.length) >= 0 || html.indexOf(glyphs) !== cut) throw new BuildError('the template must carry the glyph atlas exactly once, in the ar-glyphs block');
  const SEP = String.fromCharCode(0);
  if (html.includes(SEP)) throw new BuildError('the template must not contain a NUL character');
  const raw = Buffer.from(html.slice(0, cut) + SEP + html.slice(cut + glyphs.length), 'utf8');
  const packed = zlib.brotliCompressSync(raw, brotliOptions(raw.length)).toString('base64');
  const sha = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
  const expr = '() => __arUnpackTemplate(' + JSON.stringify(packed) + ', ' + JSON.stringify(sha) + ')';
  return "import { GLYPH_ATLAS_BASE64 as __arGlyphAtlas } from '../core/card/glyphs.js';\n" +
    "import { brotliDecompressSync as __arBrotliDecompressSync } from 'node:zlib';\n" +
    "import { createHash as __arCreateHash } from 'node:crypto';\n" +
    reportSrc
      .replace(DEV_TEMPLATE_IMPORT, () => 'const devReportTemplate = () => null;')
      .replace(REPORT_TEMPLATE_MARKER, () => expr) + '\n' +
    '/* Added by scripts/build.mjs: the report page, stored compressed; see dist/auditrail.html. */\n' +
    'function __arUnpackTemplate(packed, sha) {\n' +
    "  const t = __arBrotliDecompressSync(Buffer.from(packed, 'base64')).toString('utf8').split(String.fromCharCode(0)).join(__arGlyphAtlas);\n" +
    "  if (__arCreateHash('sha256').update(t, 'utf8').digest('hex') !== sha) throw new Error('the report page inside this program is damaged; reinstall auditrail');\n" +
    '  return t;\n' +
    '}\n';
}

/** The version fallback in src/node/cli.js (readToolVersion); the bundle carries the real one. */
export const VERSION_FALLBACK = "'0.0.0-unknown'";

/** Module whose version fallback the build replaces. */
export const VERSION_SOURCE_MODULE = path.join('src', 'node', 'cli.js');

/**
 * Source of src/node/cli.js for the Node bundle: the version fallback becomes the package
 * version, so a copy of the bundle without its package.json still reports what it is.
 * @param {string} cliSrc
 * @param {string} version
 * @returns {string}
 */
export function versionModuleSource(cliSrc, version) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new BuildError('package.json "version" must be a plain version string (found ' + JSON.stringify(version) + ')');
  const n = cliSrc.split(VERSION_FALLBACK).length - 1;
  if (n !== 1) throw new BuildError(VERSION_SOURCE_MODULE.split(path.sep).join('/') + ' must contain the version fallback ' + VERSION_FALLBACK + ' exactly once (found ' + n + ')');
  return cliSrc.replace(VERSION_FALLBACK, () => "'" + version + "'");
}

/* ------------------------------------------------------------------------------------------
 * 5. The no-network static scan of dist (DESIGN 8.10a)
 * ---------------------------------------------------------------------------------------- */

/**
 * URLs that may appear as text in dist. Footer links (plain anchors, user click only) and the
 * documentation pages cited in price tables and copy. Nothing is ever fetched from them.
 */
export const URL_ALLOWLIST = Object.freeze([
  'https://github.com/0xelitesystem/auditrail',
  'https://elitesystem.ai',
  'https://platform.claude.com/docs/',
  'https://code.claude.com/docs/',
  'https://support.claude.com/',
  'https://claude.com/pricing',
  // Attribution text for the bundled Inter glyph atlas (SIL OFL 1.1, src/core/card/glyphs.js).
  'https://github.com/rsms/inter',
]);

/** Anchors the report HTML may carry (the footer). */
export const ANCHOR_ALLOWLIST = Object.freeze(['https://github.com/0xelitesystem/auditrail', 'https://elitesystem.ai/']);

const FORBIDDEN = Object.freeze([
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['sendBeacon', /sendBeacon/],
  ['dynamic import(', /\bimport\s*\(/],
  ['node:http', /node:http\b/],
  ['node:https', /node:https\b/],
  ['node:net', /node:net\b/],
  ['node:tls', /node:tls\b/],
  ['node:dns', /node:dns\b/],
  ['node:dgram', /node:dgram\b/],
  ['@import', /@import/],
  ['url(http', /url\(\s*['"]?https?:/i],
  ['<link', /<link\b/i],
  ['<script src', /<script[^>]*\bsrc\s*=/i],
]);

/**
 * Scan built text for network APIs and URLs outside the allowlist.
 * @param {string} text
 * @returns {string[]} violations; empty means clean
 */
export function scanForNetwork(text) {
  const out = [];
  for (const [label, re] of FORBIDDEN) if (re.test(text)) out.push('forbidden: ' + label);
  const urlRe = /https?:\/\/[^\s"'`<>)\\]+/g;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const u = m[0];
    if (!URL_ALLOWLIST.some((a) => u === a || u.startsWith(a.endsWith('/') ? a : a + '/') || u === a + '/')) out.push('url outside allowlist: ' + u);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * 6. The build
 * ---------------------------------------------------------------------------------------- */

/**
 * Build dist/auditrail.mjs and dist/auditrail.html.
 * @param {{ root?: string, out?: string, htmlOut?: string|null, htmlOnly?: boolean, entry?: string, minify?: boolean, mangle?: boolean }} [opts]
 * @returns {{ out: string|null, bytes: number, sha256: string|null, htmlOut: string|null, htmlBytes: number, htmlSha256: string, modules: string[], cliTemplateSha256?: string }}
 */
export function build(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const version = readVersion(root);
  const tpl = buildTemplate({ root, version, minify: opts.minify });
  const htmlViolations = scanForNetwork(tpl.html);
  if (htmlViolations.length) throw new BuildError('report template fails the no-network scan:\n  ' + htmlViolations.join('\n  '));
  checkAnchors(tpl.html);
  checkNotices(tpl.html, tpl.glyphs, 'dist/auditrail.html');

  const htmlOut = opts.htmlOut === null ? null : (opts.htmlOut ?? path.join(root, 'dist', 'auditrail.html'));
  const htmlSha256 = crypto.createHash('sha256').update(tpl.html, 'utf8').digest('hex');
  if (htmlOut) {
    fs.mkdirSync(path.dirname(htmlOut), { recursive: true });
    fs.writeFileSync(htmlOut, tpl.html);
  }
  if (opts.htmlOnly) {
    return { out: null, bytes: 0, sha256: null, htmlOut, htmlBytes: Buffer.byteLength(tpl.html), htmlSha256, modules: [] };
  }

  const entry = opts.entry ?? path.join(root, 'src', 'node', 'cli.js');
  if (!fs.existsSync(entry)) throw new BuildError('missing Node entry ' + path.relative(root, entry) + ' (owned by the node team)');
  const reportPath = path.join(root, TEMPLATE_SOURCE_MODULE);
  // The page the CLI embeds is stored deflated, so the scan of dist below cannot see into it:
  // scan it here, before it is packed (the full page was scanned above and is written to dist).
  const cliHtml = cliTemplate(tpl.html);
  const cliViolations = scanForNetwork(cliHtml);
  if (cliViolations.length) throw new BuildError('the CLI report page fails the no-network scan:\n  ' + cliViolations.join('\n  '));
  checkAnchors(cliHtml);
  checkNotices(cliHtml, tpl.glyphs, 'the CLI report page');
  const cliTemplateSha256 =crypto.createHash('sha256').update(cliHtml, 'utf8').digest('hex');
  const overrides = new Map([[reportPath, templateModuleSource(fs.readFileSync(reportPath, 'utf8'), cliHtml, tpl.glyphs)]]);
  const versionPath = path.join(root, VERSION_SOURCE_MODULE);
  if (fs.existsSync(versionPath)) overrides.set(versionPath, versionModuleSource(fs.readFileSync(versionPath, 'utf8'), version));
  const res = bundle({ entry, target: 'node', root, overrides, minify: opts.minify, mangle: opts.mangle });
  const banner = '#!/usr/bin/env node\n' +
    '// auditrail ' + version + '. Copyright (c) 2026 0xelitesystem. MIT License.\n' +
    '// Single-file build: zero runtime dependencies, no network code. Source: https://github.com/0xelitesystem/auditrail\n' +
    '// Bundled: a glyph atlas pre-rasterized from the Inter typeface.\n' +
    '// Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)\n' +
    '// The atlas is used under the SIL Open Font License, Version 1.1, not under the MIT License.\n' +
    '// Full text: the NOTICE file shipped beside this one.\n' +
    '// Auditrail is an independent project.\n' +
    '// It is not affiliated with, endorsed by or sponsored by Anthropic or by any other company\n' +
    '// whose products it reads or whose names appear in it. All product names and trademarks are\n' +
    '// the property of their respective owners.\n';
  const code = banner + res.code;
  // The page inside this bundle is brotli-packed, so it was checked as cliHtml above; this is the
  // bundle's own banner. '' for the atlas: the packed bytes are not greppable here.
  checkNotices(code, '', 'dist/auditrail.mjs');
  const violations = scanForNetwork(code);
  if (violations.length) throw new BuildError('dist fails the no-network scan:\n  ' + violations.join('\n  '));
  const bytes = Buffer.byteLength(code);
  if (bytes > MAX_BUNDLE_BYTES) throw new BuildError('dist/auditrail.mjs is ' + bytes + ' bytes, over the ' + MAX_BUNDLE_BYTES + ' byte budget');
  const out = opts.out ?? path.join(root, 'dist', 'auditrail.mjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code, { mode: 0o755 });
  return {
    out, bytes, sha256: crypto.createHash('sha256').update(code, 'utf8').digest('hex'),
    htmlOut, htmlBytes: Buffer.byteLength(tpl.html), htmlSha256, modules: res.modules, cliTemplateSha256,
  };
}

/**
 * The notices every distributable HTML artifact must carry in its own bytes. The glyph atlas is
 * a derived form of the Inter typeface: OFL 1.1 clause 2 lets it be bundled and redistributed
 * only while each copy carries the copyright notice and the license, and its TERMINATION clause
 * voids the license if that condition is not met. dist/auditrail.mjs carries these in its
 * banner and in src/core/card/glyphs.js; the HTML pages carry them from src/web/template.html.
 * Mirrors the NOTICE check scripts/build-glyphs.mjs makes at rasterization time.
 */
export const REQUIRED_HTML_NOTICES = Object.freeze([
  ['Inter copyright', 'Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)'],
  ['SIL OFL reference', 'SIL Open Font License, Version 1.1'],
  ['MIT copyright', 'Copyright (c) 2026 0xelitesystem. MIT License.'],
  ['independence statement', 'not affiliated with, endorsed by or sponsored by'],
]);

/**
 * Fail the build if a page that embeds the glyph atlas does not also carry the notices the atlas
 * is redistributed under, plus this project's own license and independence lines.
 * @param {string} html
 * @param {string} atlasBase64
 * @param {string} what  name used in the error
 */
export function checkNotices(html, atlasBase64, what) {
  const carriesAtlas = atlasBase64.length > 0 && html.includes(atlasBase64.slice(0, 256));
  const missing = REQUIRED_HTML_NOTICES.filter(([, needle]) => !html.includes(needle)).map(([label]) => label);
  if (carriesAtlas && missing.length) {
    throw new BuildError(what + ' embeds the Inter glyph atlas but is missing: ' + missing.join(', ') +
      ' (see src/web/template.html and NOTICE)');
  }
  if (missing.length) throw new BuildError(what + ' is missing: ' + missing.join(', '));
  return true;
}

/**
 * Every <a href> in the template must be a footer allowlist entry.
 * @param {string} html
 */
export function checkAnchors(html) {
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)].map((x) => x[1]);
  const bad = hrefs.filter((h) => /^https?:/i.test(h) && !ANCHOR_ALLOWLIST.includes(h));
  if (bad.length) throw new BuildError('anchors outside the footer allowlist: ' + bad.join(', '));
  return hrefs;
}

/* ------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------- */

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  try {
    const res = build({ out: outIdx >= 0 ? path.resolve(args[outIdx + 1]) : undefined, htmlOnly: args.includes('--html-only') });
    if (res.out) console.log('built ' + path.relative(process.cwd(), res.out) + ' (' + res.bytes + ' bytes, sha256 ' + res.sha256 + ', ' + res.modules.length + ' modules, embedded report page sha256 ' + res.cliTemplateSha256 + ')');
    if (res.htmlOut) console.log('built ' + path.relative(process.cwd(), res.htmlOut) + ' (' + res.htmlBytes + ' bytes, sha256 ' + res.htmlSha256 + ')');
  } catch (e) {
    console.error(e instanceof BuildError ? 'build failed: ' + e.message : e);
    process.exitCode = 1;
  }
}
