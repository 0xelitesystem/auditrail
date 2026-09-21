// The bundle's own minifier (scripts/build.mjs shortenNames, compactJs and constToLet): every snippet below
// runs before and after the transform in node:vm and must return the same result. The snippets
// are the shapes a rename or a dropped space can break: shorthand properties and patterns,
// defaults, shadowing, labels, ternaries inside object literals, class members, getters,
// template substitutions, regex literals next to keywords, ++ and -- next to + and -, a number
// before ".", and automatic semicolon insertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { shortenNames, compactJs, minifyJs, tokenizeJs, constToLet } from '../../scripts/build.mjs';

/**
 * @param {string} body  script text whose completion value is the result
 * @returns {string}
 */
function evalBody(body) {
  return JSON.stringify(vm.runInNewContext(body, {}, { timeout: 2000 }));
}

/** @param {string} src */
function transform(src) {
  return constToLet(compactJs(shortenNames(minifyJs(src)).code));
}

const SNIPPETS = {
  shorthand: `
    const alpha = 1, beta = 2;
    const o = { alpha, beta, gamma: alpha + beta };
    const { alpha: a2, beta: b2 = 9, missing = 5 } = o;
    JSON.stringify([o, a2, b2, missing]);`,
  shadowing: `
    const value = 1;
    function outer(value) { const inner = () => { const value = 3; return value; }; return [value, inner()]; }
    [value, outer(2)];`,
  patterns: `
    function f({ first, second: { third = 4 } = {} }, [x, , y = 7], ...rest) { return [first, third, x, y, rest.length]; }
    const out = [];
    for (const [key, { val }] of [['k', { val: 1 }], ['m', { val: 2 }]]) out.push(key + val);
    [f({ first: 1 }, [10, 20]), out];`,
  ternaryInObject: `
    const flag = true, left = 'L', right = 'R';
    const o = { pick: flag ? left : right, nested: { inner: flag ? { deep: left } : right } };
    o;`,
  labelsAndSwitch: `
    let count = 0;
    outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; count++; } }
    const kind = 'b';
    let res;
    switch (kind) { case 'a': res = 1; break; case 'b': { const inner = 2; res = inner; break; } default: res = 3; }
    [count, res];`,
  classAndGetters: `
    class Box extends Error { constructor(message) { super(message); this.name = 'Box'; } size() { return this.message.length; } }
    const holder = { get size() { return 5; }, set size(v) {}, method(arg) { return arg * 2; }, async later() {}, *gen() { yield 1; } };
    const b = new Box('abc');
    [b.size(), b.name, holder.size, holder.method(4), [...holder.gen()]];`,
  templates: `
    const who = 'w', n = 2;
    const t = \`a \${who} \${ { who }.who } \${\`inner \${n + 1}\`}\`;
    t;`,
  regexAndOperators: `
    const s = 'xay';
    const r1 = /a/ instanceof RegExp;
    const r2 = s.replace(/a/g, 'b');
    let k = 1;
    const m = k - -1, p = k + +1, q = k++ + ++k;
    const t = 1 .toString() + (2.5).toFixed(1);
    function g() { return /q/.test('q'); }
    [r1, r2, m, p, q, t, g()];`,
  asi: `
    function h() {
      return
      42
    }
    let a = 1
    let b = a
    ;[a, b] = [b, a + 1]
    const c = a
    + b
    const d = [h(), a, b, c]
    d`,
  optionalAndNullish: `
    const obj = { deep: { v: 0 } }, none = null;
    [obj?.deep?.v ?? 'x', none?.deep ?? 'y', true ? .5 : 1, obj.deep.v || 'z'];`,
  closuresAndHoisting: `
    const list = [];
    for (let i = 0; i < 3; i++) list.push(() => i);
    function later() { return early; }
    var early = 'hoisted';
    [list.map((fn) => fn()), later()];`,
  catchAndComputed: `
    const key = 'dyn';
    let caught;
    try { throw new Error('boom'); } catch (err) { caught = err.message; }
    const o = { [key]: 1, [key + '2']: 2 };
    [caught, o];`,
};

test('every snippet computes the same value after shortening names, compacting and const to let', () => {
  for (const [name, src] of Object.entries(SNIPPETS)) {
    const out = transform(src);
    assert.equal(evalBody(out), evalBody(src), name + ' changed its result\n' + out);
  }
});

test('names are shortened, property names and globals are not', () => {
  const src = 'const longLocalName = { longPropertyName: 1 };\nconst viaShorthand = { longLocalName };\nJSON.stringify([longLocalName.longPropertyName, viaShorthand, Math.max(1, 2)]);';
  const { code, renamed } = shortenNames(src);
  assert.ok(renamed.has('longLocalName') && renamed.has('viaShorthand'));
  assert.ok(!renamed.has('longPropertyName') && !renamed.has('Math') && !renamed.has('JSON'));
  assert.ok(code.includes('longPropertyName') && /\{ ?longLocalName:/.test(code), code);
  assert.equal(evalBody(code), evalBody(src));
});

test('a name used without a declaration in its region (a global) is never renamed', () => {
  // someGlobal is declared in the first top-level region only; the second region reads the
  // global of the same name, so renaming it would change what that region sees.
  const src = 'const first = (() => { const someGlobal = 1; return someGlobal; })();\nconst second = (() => typeof someGlobal)();\n[first, second];';
  const { renamed, code } = shortenNames(src);
  assert.ok(!renamed.has('someGlobal'));
  assert.equal(evalBody(code), evalBody(src));
});

test('labels and keys of a brace that might be a block leave the name alone everywhere', () => {
  const { renamed } = shortenNames('const loopName = 1;\nloopName: for (;;) { break loopName; }\nloopName;');
  assert.ok(!renamed.has('loopName'));
});

test('compactJs keeps the spaces JavaScript needs', () => {
  assert.equal(compactJs('a + +b; c - -d; e++ + f; 1 .x; /re/ instanceof R; x ? .5 : 1'), 'a+ +b;c- -d;e++ +f;1 .x;/re/ instanceof R;x? .5:1');
  assert.equal(compactJs('return x\ny = 1'), 'return x\ny=1');
  assert.equal(compactJs('f(a,\n b);\n{\n c }'), 'f(a,b);{c}');
});

test('tokenizeJs keeps literals whole and marks template substitutions', () => {
  const toks = tokenizeJs("const s = `a${b}c`; const r = /x\\/y/g; x?.y; x?.5:1;");
  assert.ok(toks.some((t) => t.t === 'tpl' && t.open && !t.close));
  assert.ok(toks.some((t) => t.t === 'tpl' && t.close && !t.open));
  assert.ok(toks.some((t) => t.t === 'lit' && t.v === '/x\\/y/g'));
  assert.ok(toks.some((t) => t.t === 'p' && t.v === '?.'));
  assert.ok(toks.some((t) => t.t === 'num' && t.v === '.5'));
});

test('constToLet rewrites const declarations only, never a property, a key or literal text', () => {
  const src = [
    "const a = 1; const { b } = { b: 2 }; const [c] = [3];",
    "for (const d of [4]) globalThis.d = d;",
    "const o = { const: 5, get const() { return 6; } };",
    "const s = 'const x = 1', t = `const ${a}`, r = /const y/;",
    "[a, b, c, globalThis.d, o.const, s, t, r.source, o?.const];",
  ].join('\n');
  const out = constToLet(src);
  // Seven stay: the key and the getter name, the three literals, and the two property reads.
  assert.equal(out.match(/\bconst\b/g).length, 7, out);
  assert.ok(out.startsWith('let a = 1; let { b } = { b: 2 }; let [c] = [3];'), out);
  assert.ok(out.includes('for (let d of [4])'), out);
  assert.ok(out.includes("{ const: 5, get const() { return 6; } }") && out.includes("'const x = 1'") && out.includes('`const ${a}`') && out.includes('/const y/'), out);
  assert.ok(out.includes('o.const') && out.includes('o?.const'), out);
  assert.equal(evalBody(out), evalBody(src));
});

test('constToLet on compacted code: no space is needed or lost before a pattern', () => {
  assert.equal(constToLet('const{a}=o;const[b]=p;const c=1'), 'let{a}=o;let[b]=p;let c=1');
});
