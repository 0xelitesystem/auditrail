// Palette contrast, recomputed BY MATH from the source of truth, not eyeballed from a render.
//
// Two files claim this test exists and does exactly this:
//   src/web/template.html   "Every text token reaches 4.5:1 on every surface in both themes;
//                            test/web/palette.test.js recomputes the ratios by math from this block."
//   src/web/charts/stacked.js  "(--s1 to --s5, both themes checked by test/web/palette.test.js)"
// So the tokens are parsed out of src/web/template.html itself. If someone edits a hex there,
// this test recomputes it; nothing here is a copy of a number from the CSS.
//
// What is checked:
//   1. Text tokens reach 4.5:1 (WCAG 2.x AA, normal text) on --bg, --panel and --panel-2, in the
//      dark theme and in both light theme blocks.
//   2. --on-accent reaches 4.5:1 on --accent (button text).
//   3. The series colors --s1 to --s5 reach 3:1 on --bg and --panel (WCAG 1.4.11, non-text).
//   4. The report heat ramp --hm1 to --hm4: the empty cell (--panel-2) reaches 3:1 against the
//      lowest data level, every data level reaches 3:1 against --panel, levels are strictly
//      ordered, and adjacent data levels are separated by at least HEAT_MIN_ADJACENT.
//   5. The card heat ramp CARD_HEAT, the same way, against the card background.
//   6. The @media (prefers-color-scheme: light) block and the [data-theme="light"] block define
//      exactly the same tokens with the same values, so the toggle and the system setting agree.
//   7. A positive control: the same checker run over a deliberately broken palette FAILS. A
//      contrast test that cannot fail proves nothing.
//
// Why 4 levels cannot each be 3:1 from the next: five levels separated by 3:1 at every step span
// 3^4 = 81:1, and the largest ratio that exists is 21:1 (black on white). See CARD_HEAT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_HEAT, CARD_THEMES, HEAT_MIN_CONTRAST, HEAT_MIN_ADJACENT, MIN_CONTRAST, contrastRatio } from '../../src/core/card/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'template.html'), 'utf8');

/** Text tokens: every one of these is used as text somewhere in the report. */
const TEXT_TOKENS = ['--ink', '--ink-2', '--accent', '--warn', '--err', '--ok'];
/** Surfaces text is drawn on. */
const SURFACES = ['--bg', '--panel', '--panel-2'];
/** Categorical series colors (charts): non-text graphics. */
const SERIES_TOKENS = ['--s1', '--s2', '--s3', '--s4', '--s5'];
/** Report heat ramp data levels, lowest first. Level 0 is --panel-2. */
const HEAT_TOKENS = ['--hm1', '--hm2', '--hm3', '--hm4'];

/**
 * Pull `--token: #hex;` pairs out of one CSS block of the template.
 * @param {RegExp} re  must capture the block body in group 1
 * @param {string} what
 * @returns {Record<string, string>}
 */
function tokenBlock(re, what) {
  const m = re.exec(TEMPLATE);
  assert.ok(m, 'src/web/template.html: could not find the ' + what + ' block');
  /** @type {Record<string, string>} */
  const out = {};
  for (const x of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[x[1]] = x[2].toLowerCase();
  assert.ok(Object.keys(out).length >= 15, what + ': expected the full token set, got ' + Object.keys(out).length);
  return out;
}

const DARK = tokenBlock(/:root \{([\s\S]*?)\n\}/, 'dark :root');
const LIGHT_MEDIA = tokenBlock(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n {2}\}/, 'prefers-color-scheme light');
const LIGHT_ATTR = tokenBlock(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/, '[data-theme="light"]');

const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * Every contrast rule the palette must satisfy, as a list of problems. Empty means clean.
 * @param {Record<string, string>} t
 * @param {string} theme
 * @returns {string[]}
 */
function paletteProblems(t, theme) {
  const bad = [];
  const need = (/** @type {string} */ a, /** @type {string} */ b, /** @type {number} */ min, /** @type {string} */ why) => {
    const fg = t[a];
    const bg = t[b];
    if (!fg || !bg) { bad.push(theme + ': missing ' + (fg ? b : a)); return; }
    const got = contrastRatio(fg, bg);
    if (got < min) bad.push(theme + ': ' + a + ' ' + fg + ' on ' + b + ' ' + bg + ' = ' + r2(got) + ', needs ' + min + ' (' + why + ')');
  };

  for (const tok of TEXT_TOKENS) for (const s of SURFACES) need(tok, s, MIN_CONTRAST, 'AA normal text');
  need('--on-accent', '--accent', MIN_CONTRAST, 'AA text on the accent button');
  for (const tok of SERIES_TOKENS) for (const s of ['--bg', '--panel']) need(tok, s, HEAT_MIN_CONTRAST, 'WCAG 1.4.11 non-text');

  // Heat ramp. The empty cell is --panel-2; the data levels are --hm1 to --hm4.
  need('--hm1', '--panel-2', HEAT_MIN_CONTRAST, 'an empty hour must not read as a quiet one');
  for (const tok of HEAT_TOKENS) need(tok, '--panel', HEAT_MIN_CONTRAST, 'WCAG 1.4.11 non-text');
  const ramp = HEAT_TOKENS.map((k) => t[k]);
  for (let i = 1; i < ramp.length; i++) {
    const adj = contrastRatio(ramp[i - 1], ramp[i]);
    if (adj < HEAT_MIN_ADJACENT) bad.push(theme + ': heat levels ' + i + ' and ' + (i + 1) + ' = ' + r2(adj) + ', needs ' + HEAT_MIN_ADJACENT);
    const prev = contrastRatio(ramp[i - 1], t['--panel']);
    const cur = contrastRatio(ramp[i], t['--panel']);
    if (!(cur > prev)) bad.push(theme + ': heat level ' + (i + 1) + ' does not stand out more than level ' + i);
  }
  return bad;
}

test('report palette: every text token reaches AA on every surface, in both themes', () => {
  assert.deepEqual(paletteProblems(DARK, 'dark'), []);
  assert.deepEqual(paletteProblems(LIGHT_MEDIA, 'light (prefers-color-scheme)'), []);
  assert.deepEqual(paletteProblems(LIGHT_ATTR, 'light (data-theme)'), []);
});

test('report palette: the two light blocks define the same tokens with the same values', () => {
  assert.deepEqual(LIGHT_ATTR, LIGHT_MEDIA, 'the toggle and the system setting must agree');
  assert.deepEqual(Object.keys(DARK).sort(), Object.keys(LIGHT_ATTR).sort(), 'both themes must define the same token set');
});

test('report palette: the worst text pair is recorded, so a regression shows up as a number', () => {
  /** @type {{ theme: string, token: string, surface: string, ratio: number }|null} */
  let worst = null;
  for (const [theme, t] of [['dark', DARK], ['light', LIGHT_ATTR]]) {
    for (const tok of TEXT_TOKENS) {
      for (const s of SURFACES) {
        const got = contrastRatio(t[tok], t[s]);
        if (!worst || got < worst.ratio) worst = { theme, token: tok, surface: s, ratio: got };
      }
    }
  }
  assert.ok(worst);
  // Measured today: light --accent #2d6b00 on --panel-2 #dce1e7.
  assert.equal(worst.theme, 'light');
  assert.equal(worst.token, '--accent');
  assert.equal(worst.surface, '--panel-2');
  assert.equal(r2(worst.ratio), 4.97);
});

test('card palette: the heat ramp separates empty from the lowest level and every level from the ground', () => {
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    const levels = CARD_HEAT[theme];
    const ground = CARD_THEMES[theme].background;
    const emptyVsLowest = contrastRatio(levels[0], levels[1]);
    assert.ok(emptyVsLowest >= HEAT_MIN_CONTRAST, theme + ': empty vs lowest data = ' + r2(emptyVsLowest));
    for (let lv = 1; lv < levels.length; lv++) {
      const vsGround = contrastRatio(levels[lv], ground);
      assert.ok(vsGround >= HEAT_MIN_CONTRAST, theme + ': level ' + lv + ' vs ground = ' + r2(vsGround));
      if (lv > 1) {
        const adj = contrastRatio(levels[lv - 1], levels[lv]);
        assert.ok(adj >= HEAT_MIN_ADJACENT, theme + ': levels ' + (lv - 1) + ' and ' + lv + ' = ' + r2(adj));
      }
    }
  }
  // Anchors, computed by hand from the WCAG relative-luminance formula.
  assert.equal(r2(contrastRatio('#1e1e1e', '#5f711e')), 3.07);
  assert.equal(r2(contrastRatio('#f7f8fa', '#699326')), 3.41);
});

test('positive control: the checker fails a palette that is deliberately broken', () => {
  const broken = { ...DARK, '--ink-2': '#3a3a3a', '--hm1': '#232323', '--s1': '#151515' };
  const problems = paletteProblems(broken, 'broken');
  assert.ok(problems.length >= 3, 'a broken palette must produce problems, got: ' + JSON.stringify(problems));
  assert.ok(problems.some((p) => p.includes('--ink-2')), 'low-contrast text must be caught');
  assert.ok(problems.some((p) => p.includes('--hm1')), 'an invisible lowest heat level must be caught');
  assert.ok(problems.some((p) => p.includes('--s1')), 'an invisible series color must be caught');
  // And the real palette is not accidentally passing because the checker is a no-op.
  assert.deepEqual(paletteProblems(DARK, 'dark'), []);
});

test('the contrast function itself is right (known values)', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(r2(contrastRatio('#ffffff', '#ffffff')), 1);
  assert.equal(r2(contrastRatio('#d4ff3a', '#0a0a0a')), 17.12);
});
