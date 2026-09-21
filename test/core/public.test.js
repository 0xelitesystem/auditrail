import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPublicSummary, assertPublicSummary, PUBLIC_FIELDS, PUBLIC_SUBFIELDS, PUBLIC_SOURCES, PublicSummaryError, selectArchetype,
  selectBadges, archetypeMetrics, ARCHETYPE_IDS, BADGE_IDS, buildManifest, altText, formatCount, formatPercent, formatHour,
  formatDateRange, formatActiveHours, footerText, scanText, archetypeInfo, OTHER_MODEL_LABEL, CARD_HIDE_KEYS, HEAT_LEVELS, HEATMAP_TITLE,
} from '../../src/core/public.js';
import { VALUE_LABEL, CUSTOM_VALUE_LABEL } from '../../src/core/constants.js';
import { makeSummary, SAMPLE_TABLE_MODELS } from '../helpers/sample-summary.js';

const PRICE_TABLE = { models: SAMPLE_TABLE_MODELS };

test('keys are exactly the allowlist, in order, nested too', () => {
  const ps = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE });
  assert.deepEqual(Object.keys(ps), [...PUBLIC_FIELDS]);
  assert.deepEqual(Object.keys(ps.coverage), [...PUBLIC_SUBFIELDS.coverage]);
  assert.deepEqual(Object.keys(ps.value), [...PUBLIC_SUBFIELDS.value]);
  assert.deepEqual(Object.keys(ps.topTool), [...PUBLIC_SUBFIELDS.topTool]);
  assert.deepEqual(Object.keys(PUBLIC_SOURCES).sort(), PUBLIC_FIELDS.filter((f) => f !== 'schema').sort(), 'every field documents its source');
  assert.ok(Object.isFrozen(ps));
});

test('values come from the documented Summary paths', () => {
  const ps = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE });
  assert.equal(ps.toolVersion, '0.1.0');
  assert.equal(ps.pricesAsOf, '2026-09-14');
  assert.equal(ps.filesScanned, 12);
  assert.deepEqual(ps.coverage, { fromLocalDate: '2026-03-01', toLocalDate: '2026-03-16', activeDays: 15 });
  assert.deepEqual(ps.value, { shown: true, atLeastUsd2sf: 12, label: VALUE_LABEL });
  assert.equal(ps.outputTokens, 90000);
  assert.equal(ps.activeHours, 12.5);
  assert.equal(ps.toolCalls, 1000);
  assert.deepEqual(ps.topTool, { name: 'Bash', share: 0.42 });
  assert.equal(ps.cacheHitRate, 0.9);
  assert.equal(ps.delegationShare, 0.3521);
  assert.equal(ps.longestStreakDays, 15);
  assert.equal(ps.peakHourLocal, 21);
  assert.equal(ps.maxEditsOneFile, 23);
  assert.equal(ps.topModel, 'Claude Opus 5');
  assert.equal(ps.archetype, 'conductor');
  assert.deepEqual(ps.badges, ['night-shift', 'streak', 'cache-pro']);
  assert.equal(ps.rateLimitWindows, null, 'rate limits are opt-in');
});

const CANARY = 'CANARY-7f3a';

/** Plant a canary in every Summary field that can legitimately hold a label or free text. */
function poisonedSummary() {
  const s = makeSummary();
  s.redacted = false;
  s.pricing.label = 'value at your custom rates (' + CANARY + '.json)';
  s.pricing.source = 'https://example.invalid/' + CANARY;
  s.pricing.tableModels.push({ id: 'claude-' + CANARY.toLowerCase(), displayName: 'Claude ' + CANARY });
  s.audit.agentVersions = [CANARY];
  s.insights.i01.data.unpriced = [{ model: CANARY, responses: 1, tokens: 1 }];
  s.insights.i01.data.byProject = [{ label: CANARY, valueNano: '1', responses: 1, sessions: 1 }];
  s.insights.i01.data.byModel = [{ model: CANARY, displayName: CANARY, valueNano: '1', responses: 1 }];
  s.insights.i01.data.label = CANARY;
  s.insights.i04.data.byAttribution = { agent: [{ name: CANARY, responses: 1, valueNano: '1' }], skill: [{ name: CANARY, responses: 1, valueNano: '1' }], mcpServer: [{ name: CANARY, responses: 1, valueNano: '1' }] };
  s.insights.i07.data.byTool = [{ name: 'mcp__' + CANARY + '__x', displayName: 'MCP tools', nameClass: 'mcp', calls: 1, paired: 1, ok: 1, denied: 0, shellExit: 0, failed: 0, unpaired: 0, failureRate: 0, longestFailRun: 0 }];
  s.insights.i07.data.flagged = ['mcp__' + CANARY + '__x'];
  s.insights.i07.data.callsByDisplayName[CANARY] = 999999;
  s.insights.i07.data.topTool = { displayName: 'mcp__' + CANARY + '__lookup', calls: 420, share: 0.42 };
  s.insights.i08.data.top = [{ label: CANARY + '/secret.txt', edits: 23 }];
  s.insights.i11.data.findings = [{ secretType: 'anthropic', fingerprint12: '0123456789ab', copies: 2, files: 2, newestLocalDate: '2026-03-02', severity: 'critical', source: 'user_text', expired: null, projectLabels: [CANARY] }];
  s.insights.i13.data.topModel = { model: 'claude-' + CANARY.toLowerCase(), displayName: CANARY };
  s.insights.i14.data.models = [CANARY];
  s.insights.i03.action = CANARY;
  s.insights.i03.data.note = CANARY;
  s.extraTopLevel = CANARY;
  return s;
}

test('canaries planted in every label-bearing Summary field never reach the PublicSummary, manifest or alt text (DESIGN 9.7)', () => {
  const s = poisonedSummary();
  for (const opts of [{ priceTable: PRICE_TABLE }, { priceTable: PRICE_TABLE, include: ['rate-limits'] }, { priceTable: PRICE_TABLE, hide: ['value'] }]) {
    const ps = toPublicSummary(s, opts);
    const everything = JSON.stringify(ps) + JSON.stringify(buildManifest(ps)) + altText(ps);
    assert.ok(!everything.includes(CANARY), 'canary leaked: ' + everything);
    assert.ok(!everything.toLowerCase().includes(CANARY.toLowerCase()));
    assert.equal(ps.topTool.name, 'MCP tools');
    assert.equal(ps.topModel, OTHER_MODEL_LABEL, 'model not in the bundled table');
  }
  // Without the bundled table the spoofed tableModels row is the only source, and its display
  // name fails the pattern: the card fails closed instead of drawing it.
  assert.throws(() => toPublicSummary(s), PublicSummaryError);
});

test('without the bundled table, a spoofed Summary tableModels entry is still refused by the display-name pattern', () => {
  const s = makeSummary();
  s.pricing.tableModels.push({ id: 'claude-x', displayName: 'Project Falcon Secret' });
  s.insights.i13.data.topModel = { model: 'claude-x', displayName: 'Project Falcon Secret' };
  assert.throws(() => toPublicSummary(s), PublicSummaryError);
});

test('tool names collapse to the allowlist', () => {
  for (const [raw, want] of [['Bash', 'Bash'], ['MCP tools', 'MCP tools'], ['other tools', 'other tools'], ['mcp__fake__x', 'MCP tools'], ['FictionalTool', 'other tools']]) {
    const s = makeSummary();
    s.insights.i07.data.topTool = { displayName: raw, calls: 1, share: 0.5 };
    assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE }).topTool.name, want, raw);
  }
});

test('free-text in a pattern-checked field fails closed', () => {
  const bad = [
    (s) => { s.tool.version = '0.1.0 ' + CANARY; },
    (s) => { s.pricing.asOf = CANARY; },
    (s) => { s.scan.takenAt = CANARY; },
    (s) => { s.insights.i12.data.latestLocalDate = CANARY; },
    (s) => { s.insights.i01.data.totalNano = CANARY; },
    (s) => { s.insights.i09.data.peakHourLocal = 24; },
    (s) => { s.insights.i02.data.cacheHitRate = 1.5; },
    (s) => { s.insights.i07.data.toolCalls = -1; },
    (s) => { delete s.insights.i09; },
  ];
  for (const f of bad) {
    const s = makeSummary();
    f(s);
    assert.throws(() => toPublicSummary(s, { priceTable: PRICE_TABLE }), PublicSummaryError, f.toString());
  }
});

test('value shown only at >= 99% priced tokens and >= $1, floored to 2 significant figures', () => {
  const s = makeSummary();
  s.insights.i01.data.totalNano = '7318420000000';
  assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE }).value.atLeastUsd2sf, 7300);
  s.insights.i01.data.pricedTokens = 989;
  s.insights.i01.data.allTokens = 1000;
  let ps = toPublicSummary(s, { priceTable: PRICE_TABLE });
  assert.deepEqual([ps.value.shown, ps.value.atLeastUsd2sf], [false, null]);
  assert.ok(buildManifest(ps).some((e) => e.field === 'outputTokens'), 'output tokens replace the value tile');
  s.insights.i01.data.pricedTokens = 990;
  assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE }).value.shown, true);
  s.insights.i01.data.totalNano = '999999999';
  assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE }).value.shown, false, 'under $1');
  const c = makeSummary();
  c.pricing.custom = { fileName: 'prices.json', multiplier: 0.85 };
  ps = toPublicSummary(c, { priceTable: PRICE_TABLE });
  assert.equal(ps.value.label, CUSTOM_VALUE_LABEL);
  assert.ok(!JSON.stringify(ps).includes('prices.json'));
  assert.ok(footerText(ps).startsWith('Value at custom rates'));
});

test('hidden stats are null (or empty) before they reach the card; unknown names are rejected', () => {
  const ps = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE, hide: Object.keys(CARD_HIDE_KEYS) });
  assert.equal(ps.value.shown, false);
  for (const k of ['coverage', 'outputTokens', 'activeHours', 'toolCalls', 'topTool', 'cacheHitRate', 'delegationShare', 'longestStreakDays', 'peakHourLocal', 'maxEditsOneFile', 'topModel', 'archetype', 'heatmap']) {
    assert.equal(ps[k], null, k);
  }
  assert.deepEqual(ps.badges, []);
  assert.deepEqual(buildManifest(ps).map((e) => e.field), ['footer']);
  assert.equal(toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE, hide: ['peakHourLocal'] }).peakHourLocal, null);
  assert.throws(() => toPublicSummary(makeSummary(), { hide: ['projects'] }), PublicSummaryError);
  assert.throws(() => toPublicSummary(makeSummary(), { include: ['secrets'] }), PublicSummaryError);
});

test('rate limits and Wall Hitter only when opted in', () => {
  const on = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE, include: ['rate-limits'] });
  assert.equal(on.rateLimitWindows, 6);
  assert.ok(on.badges.includes('wall-hitter'));
  assert.ok(!toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE }).badges.includes('wall-hitter'));
});

test('assertPublicSummary rejects extra, missing or mistyped fields', () => {
  const ps = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE });
  const clone = () => JSON.parse(JSON.stringify(ps));
  const cases = [
    (x) => { x.projectName = 'fake'; },
    (x) => { delete x.badges; },
    (x) => { x.coverage.extra = 1; },
    (x) => { x.topTool.name = 'FictionalTool'; },
    (x) => { x.archetype = 'the-hacker'; },
    (x) => { x.badges = ['streak', 'night-shift']; },
    (x) => { x.badges = ['streak', 'streak']; },
    (x) => { x.value.label = 'what you paid'; },
    (x) => { x.topModel = 'fake-project-name'; },
    (x) => { x.value.shown = false; },
  ];
  for (const f of cases) {
    const x = clone();
    f(x);
    assert.throws(() => assertPublicSummary(x), PublicSummaryError, f.toString());
  }
  assertPublicSummary(clone());
});

test('archetype selection follows DESIGN 7.4 (scores, secondary conditions, tie order, fallback)', () => {
  const base = { conductor: 0, surgeon: 0, builder: 0, researcher: 0, operator: 0, medianEditNewLines: null, filesCreated: 0 };
  // Several eligible archetypes: the highest score wins (conductor 0.40 / 0.25 = 1.6 beats operator 0.50 / 0.45 = 1.11).
  assert.equal(selectArchetype({ ...base, conductor: 0.4, operator: 0.5, researcher: 0.3, builder: 0.5, surgeon: 0.5 }).id, 'conductor');
  assert.equal(selectArchetype({ ...base, surgeon: 0.9, medianEditNewLines: 12 }).id, 'generalist', 'median above 10');
  assert.equal(selectArchetype({ ...base, surgeon: 0.9, medianEditNewLines: 10 }).id, 'surgeon');
  assert.equal(selectArchetype({ ...base, builder: 0.9, filesCreated: 49 }).id, 'generalist');
  assert.equal(selectArchetype({ ...base, builder: 0.9, filesCreated: 50 }).id, 'builder');
  assert.equal(selectArchetype({ ...base, conductor: 0.25, operator: 0.45 }).id, 'conductor', 'exact tie at score 1 breaks to Conductor');
  assert.equal(selectArchetype({ ...base, researcher: 0.4, operator: 0.45 }).id, 'researcher', 'tie breaks by order');
  assert.equal(selectArchetype(base).id, 'generalist');
  assert.equal(ARCHETYPE_IDS.length, 6);
  assert.equal(archetypeInfo('conductor').line, "You don't type code. You run a crew.");
});

test('archetype metrics come from fixed insight fields', () => {
  const m = archetypeMetrics(makeSummary());
  assert.equal(m.conductor, 0.3521);
  assert.equal(m.operator, 0.42);
  assert.equal(m.researcher, (10 + 5 + 200 + 40 + 20) / 1000);
  assert.equal(m.surgeon, 170 / 225);
  assert.equal(m.builder, 55 / 225);
  assert.equal(m.filesCreated, 12);
});

test('badges at their exact thresholds', () => {
  const b = (o) => selectBadges({ nightPromptShare: 0, weekendDayShare: 0, longestStreakDays: 0, cacheHitRate: 0, rateLimitWindows: null, ...o });
  assert.deepEqual(b({ nightPromptShare: 0.35 }), ['night-shift']);
  assert.deepEqual(b({ nightPromptShare: 0.3499 }), []);
  assert.deepEqual(b({ weekendDayShare: 0.3 }), ['weekend-builder']);
  assert.deepEqual(b({ longestStreakDays: 14 }), ['streak']);
  assert.deepEqual(b({ cacheHitRate: 0.9 }), ['cache-pro']);
  assert.deepEqual(b({ rateLimitWindows: 5 }), ['wall-hitter']);
  assert.deepEqual(b({ rateLimitWindows: null }), []);
  assert.deepEqual(BADGE_IDS, ['night-shift', 'weekend-builder', 'streak', 'cache-pro', 'wall-hitter']);
});

test('formatters never overstate and use fixed English copy', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1999), '1.9K');
  assert.equal(formatCount(58210), '58K');
  assert.equal(formatCount(3_456_789), '3.4M');
  assert.equal(formatPercent(0.944), '94%');
  assert.equal(formatPercent(0.999), '99%');
  assert.equal(formatPercent(0.004), '<1%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0.29), '29%');
  assert.equal(formatHour(0), '12 AM');
  assert.equal(formatHour(12), '12 PM');
  assert.equal(formatHour(20), '8 PM');
  assert.equal(formatDateRange('2026-04-03', '2026-08-21'), 'Apr 3 to Aug 21, 2026');
  assert.equal(formatDateRange('2025-12-01', '2026-01-05'), 'Dec 1, 2025 to Jan 5, 2026');
  assert.equal(formatActiveHours(57.8), '57');
  assert.equal(formatActiveHours(9.96), '9.9');
});

test('manifest lists exactly what the card shows, footer included', () => {
  const ps = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE });
  const m = buildManifest(ps);
  const byField = Object.fromEntries(m.map((e) => [e.field, e.text]));
  assert.equal(byField.archetype, "The Conductor: You don't type code. You run a crew.");
  assert.equal(byField.value, 'at least $12 ' + VALUE_LABEL);
  // Card v2 copy: plain English, no tool names, no method jargon.
  assert.equal(byField.activeHours, '12 hours with your agent');
  assert.equal(byField.toolCalls, '1.0K actions by your agent');
  assert.equal(byField.longestStreakDays, '15 days in a row');
  assert.equal(byField.delegationShare, '35% of the work done by subagents');
  assert.equal(byField.peakHourLocal, 'busiest hour 9 PM');
  assert.equal(m.find((e) => e.field === 'activeHours').label, 'Active hours (15-minute idle cutoff)', 'the method note stays in the manifest label');
  // Not on the v2 card, so not in the manifest: top tool, cache hit rate, top model, most edited
  // file, rate-limit windows (the Cache Pro and Wall Hitter badges carry two of them).
  for (const f of ['topTool', 'cacheHitRate', 'topModel', 'maxEditsOneFile', 'rateLimitWindows']) assert.ok(!(f in byField), f);
  assert.ok(!('rateLimitWindows' in Object.fromEntries(buildManifest(toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE, include: ['rate-limits'] })).map((e) => [e.field, e.text]))));
  // The sample heatmap is all zero: no prompts by hour, no heatmap entry.
  assert.equal(ps.heatmap, null);
  assert.ok(!('heatmap' in byField));
  assert.ok(byField.footer.includes('as of 2026-09-14. Not what I paid.'));
  assert.equal(scanText(ps), 'Scanned 2026-03-16 09:00 UTC, 12 files');
  assert.ok(altText(ps).startsWith('Auditrail card. '));
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  for (const e of m) assert.ok(!DASHES.test(e.text), 'no en or em dashes in card copy');
});

test('heatmap: prompt counts become levels 0 to HEAT_LEVELS by square root of the busiest cell; nothing else leaves', () => {
  const s = makeSummary();
  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  counts[0][9] = 100;   // the busiest cell
  counts[0][10] = 25;   // sqrt(0.25) = 0.5 -> 2
  counts[1][22] = 1;    // anything above zero shows: 1
  counts[6][0] = 56;    // sqrt(0.56) = 0.748 -> ceil(2.99) = 3
  counts[3][3] = 57;    // sqrt(0.57) = 0.755 -> ceil(3.02) = 4
  s.insights.i09.data.heatmap = counts;
  const ps = toPublicSummary(s, { priceTable: PRICE_TABLE });
  assert.equal(HEAT_LEVELS, 4);
  assert.deepEqual([ps.heatmap[0][9], ps.heatmap[0][10], ps.heatmap[1][22], ps.heatmap[6][0], ps.heatmap[3][3], ps.heatmap[5][5]], [4, 2, 1, 3, 4, 0]);
  assert.ok(Object.isFrozen(ps.heatmap) && ps.heatmap.every((r) => Object.isFrozen(r)));
  assert.equal(ps.heatmap.flat().filter((v) => v > 0).length, 5, 'zero stays zero');
  // Only levels: scaling every count by 1000 gives the same PublicSummary heatmap.
  s.insights.i09.data.heatmap = counts.map((r) => r.map((v) => v * 1000));
  assert.deepEqual(toPublicSummary(s, { priceTable: PRICE_TABLE }).heatmap, ps.heatmap);
  assert.equal(buildManifest(ps).find((e) => e.field === 'heatmap').text, HEATMAP_TITLE);
  assert.equal(HEATMAP_TITLE, 'when you and your agent work');
  // Hidden, absent or all-zero: null. Malformed: fail closed.
  assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE, hide: ['heatmap'] }).heatmap, null);
  delete s.insights.i09.data.heatmap;
  assert.equal(toPublicSummary(s, { priceTable: PRICE_TABLE }).heatmap, null);
  for (const bad of [counts.slice(1), counts.map((r) => r.slice(1)), counts.map((r, i) => (i ? r : [-1, ...r.slice(1)])), counts.map((r, i) => (i ? r : [0.5, ...r.slice(1)])), 'fake-alpha']) {
    s.insights.i09.data.heatmap = bad;
    assert.throws(() => toPublicSummary(s, { priceTable: PRICE_TABLE }), PublicSummaryError);
  }
  const ok = toPublicSummary(makeSummary(), { priceTable: PRICE_TABLE });
  assert.throws(() => assertPublicSummary({ ...ok, heatmap: counts }), PublicSummaryError, 'raw counts are not levels');
  assert.throws(() => assertPublicSummary({ ...ok, heatmap: [[1]] }), PublicSummaryError);
});
