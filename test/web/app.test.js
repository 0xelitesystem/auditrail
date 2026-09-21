// The report page and drop mode (src/web/app.js): markup from real Summaries, escaping of every
// local label, Share-safe mode against the canary corpus (DESIGN 9.7), the exact sharing copy
// (DESIGN 8.8) and the drop-mode helper text. The DOM controller is not run here; everything
// that builds markup is a pure export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reportHtml, dropHtml, progressText, detectOs, evidenceText, fillDays, isSummary, clearReason,
  SHARE_BANNER, SHARE_SAFE_BANNER, REDACTED_BANNER, DEMO_BANNER, DROPPED_BANNER, UPLOAD_NOTE, OS_HELP, HIDE_LABELS, FIX_IDS, PARTS,
} from '../../src/web/app.js';
import { scanDropped, wantedName } from '../../src/web/worker.js';
import { shareSafeSummary, SHARE_SAFE_CATEGORIES } from '../../src/web/share-safe.js';
import { CARD_HIDE_KEYS } from '../../src/core/public.js';
import { makeSummary } from '../helpers/sample-summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const BASE = { shareSafe: false, locked: false, demo: false, dropped: false, canSave: true };

/** @param {string} rel */
async function summaryOf(rel) {
  const dir = path.join(FIX, ...rel.split('/'), 'projects');
  const entries = [];
  (function walk(d, r) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const x = r ? r + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), x);
      else entries.push({ path: 'projects/' + x, file: wantedName(e.name) ? new File([fs.readFileSync(path.join(d, e.name))], e.name) : null });
    }
  })(dir, '');
  return (await scanDropped({ entries, tz: 'UTC', nowMs: NOW, takenAtMs: NOW, toolVersion: '0.1.0' })).summary;
}

/** Visible text of markup (tags removed, entities decoded), for "does this string leak" checks. */
function textOf(html) {
  return html.replace(/<\/?span\b[^>]*>/g, '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const PERSONAS = ['personas/solo-night-owl', 'personas/subagent-lead', 'personas/cache-miss-spender', 'golden-core'];

test('every persona renders every part, the fix list, the card controls and the receipts', async () => {
  for (const p of PERSONAS) {
    const s = await summaryOf(p);
    const html = reportHtml(s, BASE);
    for (const id of ['fix-list', ...PARTS.map((x) => x.id), 'card', 'receipts', 'f-i01', 'f-i02', 'f-i07', 'f-i09', 'f-i11', 'f-i12', 'f-i13', 'f-i14']) {
      assert.ok(html.includes('id="' + id + '"'), p + ': missing #' + id);
    }
    assert.ok(html.includes('ar-card-canvas') && html.includes('data-action="save-card"'), p + ': card');
    const text = textOf(html);
    assert.doesNotMatch(text, /\bundefined\b|\bNaN\b|\[object Object\]/, p + ': a value was not formatted');
    for (const k of Object.keys(CARD_HIDE_KEYS)) assert.ok(html.includes('data-value="' + k + '"'), p + ': hide toggle ' + k);
    // Shown insights with an action are on the fix list; the rest are listed as clear.
    for (const id of FIX_IDS) {
      const r = s.insights[id];
      if (r.shown && r.action) assert.ok(html.includes('href="#f-' + id + '"'), p + ': fix list item ' + id);
      if (!r.shown) assert.ok(text.includes(clearReason(s, id)), p + ': clear reason ' + id);
    }
  }
});

test('the sharing banner names every category the file can carry, with a button that turns on Share-safe mode', async () => {
  const s = await summaryOf('personas/subagent-lead');
  const html = reportHtml(s, BASE);
  // Pinning the sentence is not the point: the point is that the warning may never name FEWER
  // categories than shareSafeSummary() actually replaces, or a reader is told the file holds
  // less than it does (a gateway model id can carry a cloud account id).
  for (const noun of SHARE_SAFE_CATEGORIES) {
    const needle = noun.toLowerCase();
    for (const [name, banner] of [['SHARE_BANNER', SHARE_BANNER], ['SHARE_SAFE_BANNER', SHARE_SAFE_BANNER], ['REDACTED_BANNER', REDACTED_BANNER]]) {
      assert.ok(banner.toLowerCase().includes(needle), name + ' does not name the ' + noun + ' category');
    }
  }
  for (const banner of [SHARE_BANNER, SHARE_SAFE_BANNER, REDACTED_BANNER]) {
    assert.ok(banner.toLowerCase().includes('price file'), 'the banner must name the custom price file name too');
  }
  assert.ok(SHARE_BANNER.includes('Share-safe mode (or --redact)'));
  assert.ok(textOf(html).includes(SHARE_BANNER));
  assert.match(html, /data-action="share-safe" aria-pressed="false"/);
  const safe = reportHtml(shareSafeSummary(s), { ...BASE, shareSafe: true });
  assert.ok(textOf(safe).includes(SHARE_SAFE_BANNER));
  assert.ok(!textOf(safe).includes(SHARE_BANNER));
  assert.match(safe, /data-action="share-safe" aria-pressed="true"/);
  const locked = reportHtml({ ...shareSafeSummary(s) }, { ...BASE, shareSafe: true, locked: true });
  assert.ok(textOf(locked).includes(REDACTED_BANNER));
  assert.match(locked, /data-action="share-safe" aria-pressed="true" disabled/);
  assert.ok(textOf(reportHtml(s, { ...BASE, demo: true })).includes(DEMO_BANNER));
  assert.ok(textOf(reportHtml(s, { ...BASE, dropped: true })).includes(DROPPED_BANNER));
});

test('canary corpus: Share-safe mode shows no canary; without it only the allowed local labels appear', async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'canary', 'expected.json'), 'utf8'));
  const s = await summaryOf('canary');
  const normal = textOf(reportHtml(s, BASE));
  const safe = reportHtml(shareSafeSummary(s), { ...BASE, shareSafe: true });
  for (const [name, c] of Object.entries(expected.canaries)) {
    assert.ok(!safe.includes(c.value), 'share-safe report shows canary ' + name);
    if (c.mayAppearIn.length === 0) assert.ok(!normal.includes(c.value), 'report shows canary ' + name + ', which may appear nowhere');
  }
  // Positive control: the MCP canary is a local label (the tool table names the MCP tool), so
  // the normal report shows it and only Share-safe mode removes it.
  assert.ok(normal.includes(expected.canaries.mcp.value));
});

test('every local label is escaped: nothing from a log can become markup', () => {
  const s = makeSummary();
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const ins = s.insights;
  ins.i01.data.byProject = [{ label: evil, valueNano: '1000000000', responses: 1, sessions: 1 }];
  ins.i01.data.unpriced = [{ model: evil, responses: 1, tokens: 10 }];
  ins.i04.shown = true;
  ins.i04.data.byAttribution = { agent: [{ name: evil, responses: 1, valueNano: '1' }], skill: [{ name: evil, responses: 1, valueNano: '1' }], mcpServer: [{ name: evil, responses: 1, valueNano: '1' }] };
  ins.i07.data.byTool = [{ name: evil, displayName: 'other tools', nameClass: 'other', calls: 60, paired: 60, ok: 50, denied: 0, shellExit: 0, failed: 10, unpaired: 0, failureRate: 0.16, longestFailRun: 3 }];
  ins.i07.data.flagged = [evil];
  ins.i08.shown = true;
  ins.i08.data.top = [{ label: evil, edits: 12 }];
  ins.i11.shown = true;
  ins.i11.data.findings = [{ secretType: 'anthropic', fingerprint12: 'abcdefabcdef', copies: 2, files: 1, newestLocalDate: '2026-03-01', severity: 'critical', source: 'user_text', expired: null, projectLabels: [evil] }];
  ins.i11.data.bySeverity = { critical: 1, likely_fixture: 0, third_party_public: 0 };
  const html = reportHtml(s, BASE);
  assert.ok(!html.includes('<img'), 'raw markup from a label reached the page');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
  assert.ok(!/\son[a-z]+=/i.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'no event handler attribute anywhere (the CSP blocks them anyway)');
});

test('the report never shows a secret value, only its type and fingerprint', async () => {
  const s = await summaryOf('canary');
  const html = reportHtml(s, BASE);
  assert.ok(!html.includes('sk-ant-api03-CANARY'), 'secret value in the report');
});

test('drop mode: the three inputs, the upload note and the per-OS hidden-folder helper (DESIGN 8.8)', () => {
  assert.equal(UPLOAD_NOTE, "Your browser will say 'upload'. This page has no network permission; check DevTools.");
  const withPicker = dropHtml({ os: 'windows', canPick: true, hasDemo: true });
  assert.ok(withPicker.includes('id="ar-dropzone"'));
  assert.ok(withPicker.includes('data-action="pick-dir"'));
  assert.ok(withPicker.includes('webkitdirectory'));
  assert.ok(withPicker.includes('data-action="demo"'));
  assert.ok(textOf(withPicker).includes(UPLOAD_NOTE));
  // Order of the inputs: the drop zone heading, then showDirectoryPicker, then webkitdirectory.
  assert.ok(withPicker.indexOf('Drop the projects folder here') < withPicker.indexOf('pick-dir'));
  assert.ok(withPicker.indexOf('pick-dir') < withPicker.indexOf('pick-input'));
  const noPicker = dropHtml({ os: 'mac', canPick: false, hasDemo: false });
  assert.ok(!noPicker.includes('data-action="pick-dir"'));
  assert.ok(!noPicker.includes('data-action="demo"'));
  assert.equal(OS_HELP.windows.path, '%USERPROFILE%' + String.fromCharCode(92) + '.claude');
  assert.equal(OS_HELP.mac.path, '~/.claude');
  assert.equal(OS_HELP.linux.path, '~/.claude');
  assert.ok(OS_HELP.windows.steps.join(' ').includes('Win+R'));
  assert.ok(OS_HELP.mac.steps.join(' ').includes('Cmd+Shift+G'));
  assert.ok(OS_HELP.linux.steps.join(' ').includes('Ctrl+L'));
  for (const os of ['windows', 'mac', 'linux']) {
    const html = dropHtml({ os, canPick: false, hasDemo: false });
    assert.ok(textOf(html).includes(OS_HELP[os].path), os + ' path shown');
    assert.match(html, new RegExp('data-value="' + os + '" aria-pressed="true"'));
  }
  const err = dropHtml({ os: 'linux', canPick: false, hasDemo: false, error: 'No logs <here>' });
  assert.ok(err.includes('No logs &lt;here&gt;'));
});

test('small helpers', () => {
  assert.equal(detectOs('Win32'), 'windows');
  assert.equal(detectOs('Windows'), 'windows');
  assert.equal(detectOs('MacIntel'), 'mac');
  assert.equal(detectOs('macOS'), 'mac');
  assert.equal(detectOs('Linux x86_64'), 'linux');
  assert.equal(detectOs(''), 'linux');
  assert.equal(evidenceText({ count: 1, unit: 'responses' }), '1 response');
  assert.equal(evidenceText({ count: 1, unit: 'workflow agents started' }), '1 workflow agent started');
  assert.equal(evidenceText({ count: 1, unit: 'days covered' }), '1 day covered');
  assert.equal(evidenceText({ count: 1234, unit: 'tool calls' }), '1,234 tool calls');
  assert.equal(evidenceText(null), '');
  assert.deepEqual(fillDays([{ date: '2026-03-01', valueNano: '5', responses: 1 }, { date: '2026-03-03', valueNano: '7', responses: 2 }]).map((d) => [d.date, d.valueNano]),
    [['2026-03-01', '5'], ['2026-03-02', '0'], ['2026-03-03', '7']]);
  assert.equal(progressText({ bytesDone: 1_500_000, totalBytes: 12_000_000, filesDone: 3, totalFiles: 40 }), 'Read 1.5 MB of 12.0 MB (3 of 40 files).');
  assert.equal(isSummary(makeSummary()), true);
  assert.equal(isSummary({ kind: 'auditrail.summary', schema: 2, insights: {} }), false);
  assert.equal(isSummary(null), false);
  assert.deepEqual(Object.keys(HIDE_LABELS).sort(), Object.keys(CARD_HIDE_KEYS).sort());
});

test('app.js holds no placeholder, URL or network API (its text is hashed into the page CSP)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'web', 'app.js'), 'utf8');
  assert.ok(!src.includes('%%AR_'), 'a build placeholder inside app.js would break the CSP hash');
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /https?:\/\//, /\beval\s*\(/, /new Function\s*\(/, /\bon[a-z]+="/]) {
    assert.doesNotMatch(src, bad);
  }
});
