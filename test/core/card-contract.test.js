import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_THEMES, TEXT_ROLES, MIN_CONTRAST, contrastRatio, relativeLuminance, checkCardOptions, CARD_SIZES, CARD_SCALE } from '../../src/core/card/contract.js';

test('every text color reaches WCAG AA 4.5:1 on its background in both themes, by math', () => {
  for (const [name, theme] of Object.entries(CARD_THEMES)) {
    for (const role of TEXT_ROLES) {
      const r = contrastRatio(theme[role], theme.background);
      assert.ok(r >= MIN_CONTRAST, `${name}.${role} ${theme[role]} on ${theme.background} = ${r.toFixed(2)}`);
    }
  }
});

test('ratios match the published palette table (DESIGN 7.1)', () => {
  const r2 = (a, b) => Math.round(contrastRatio(a, b) * 100) / 100;
  assert.equal(r2('#f2f2f2', '#0a0a0a'), 17.68);
  assert.equal(r2('#d4ff3a', '#0a0a0a'), 17.12);
  assert.equal(r2('#a3a3a3', '#0a0a0a'), 7.85);
  assert.equal(r2('#0a0a0a', '#e8ebef'), 16.56);
  assert.equal(r2('#2d6b00', '#e8ebef'), 5.46);
  assert.equal(r2('#4a5260', '#e8ebef'), 6.58);
});

test('luminance endpoints and input validation', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.throws(() => relativeLuminance('red'), TypeError);
});

test('card options', () => {
  assert.deepEqual(checkCardOptions({ ps: {}, size: 'landscape', theme: 'dark' }), []);
  assert.equal(checkCardOptions({ ps: {}, size: 'square', theme: 'neon', project: 'x' }).length, 3);
  assert.deepEqual(CARD_SIZES.landscape, { width: 1200, height: 675 });
  assert.deepEqual(CARD_SIZES.portrait, { width: 1080, height: 1350 });
  assert.equal(CARD_SCALE, 2);
});
