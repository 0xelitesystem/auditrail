// DESIGN 8.10 layer (d) and 9.8: Playwright on Microsoft Edge (channel "msedge"; never Chrome or
// Brave). Run with: npm run test:browser (Playwright is the one dev dependency; set
// AR_PLAYWRIGHT to a playwright package folder to use a copy installed elsewhere).
//
// Every request the browser makes is checked: any URL that is not file:, data: or blob: fails
// the test (the one exception is the demo page itself when it is served from http://localhost).
// CSP violations and page errors fail it too. Covered:
// - a report the built CLI wrote, opened over file://: it renders, Save card downloads a PNG,
//   Save copy downloads a page that reopens and renders;
// - drop mode of dist/auditrail.html over file://: synthetic logs fed by setInputFiles to the
//   webkitdirectory input are scanned in the Web Worker, and the value matches the CLI's;
// - a simulated drop onto the drop zone;
// - the live demo shape (the page with a synthetic Summary in ar-demo) served over
//   http://localhost: the demo renders and Save card works.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { build } from '../../scripts/build.mjs';
import { REPO, FIXTURES, tempDir } from '../node/helpers.js';

/** @returns {Promise<any|null>} */
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed in this checkout */ }
  if (process.env.AR_PLAYWRIGHT) {
    try { return await import(pathToFileURL(path.join(process.env.AR_PLAYWRIGHT, 'index.mjs')).href); } catch { /* bad path */ }
  }
  return null;
}

const pw = await loadPlaywright();
const skip = pw ? false : 'Playwright is not installed (npm install, or set AR_PLAYWRIGHT)';

const PERSONA = path.join(FIXTURES, 'personas', 'subagent-lead', 'projects');
const WORK = tempDir();
let BUNDLE = '';
let PAGE = '';
let REPORT = '';
let CLI_SUMMARY = /** @type {any} */ (null);
let browser = /** @type {any} */ (null);
let server = /** @type {http.Server|null} */ (null);

/** @param {string} json */
const embed = (json) => json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

before(async () => {
  if (skip) return;
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(WORK, 'package.json'));
  const res = build({ out: path.join(WORK, 'dist', 'auditrail.mjs'), htmlOut: path.join(WORK, 'dist', 'auditrail.html') });
  BUNDLE = /** @type {string} */ (res.out);
  PAGE = /** @type {string} */ (res.htmlOut);
  REPORT = path.join(WORK, 'report.html');
  const env = { ...process.env, HOME: WORK, USERPROFILE: WORK };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [BUNDLE, '--no-open', '--tz', 'UTC', '--dir', PERSONA, '--out', REPORT], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  CLI_SUMMARY = JSON.parse(/<script type="application\/json" id="ar-data">([^<]*)<\/script>/.exec(fs.readFileSync(REPORT, 'utf8'))[1]);
  browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(() => r(undefined)));
});

/**
 * A page whose every request is checked.
 * @param {string[]} [allowExact] URLs allowed besides file:, data: and blob:
 */
async function guardedPage(allowExact = []) {
  const context = await browser.newContext({ acceptDownloads: true });
  const bad = [];
  const problems = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file|data|blob):/i.test(url) || allowExact.includes(url)) return route.continue();
    bad.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('request', (req) => { const u = req.url(); if (!/^(file|data|blob):/i.test(u) && !allowExact.includes(u) && !bad.includes(u)) bad.push(u); });
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => { console.error('Content Security Policy violation: ' + e.violatedDirective + ' ' + e.blockedURI); });
  });
  return { context, page, bad, problems };
}

/** @param {any} dl @returns {Promise<Buffer>} */
async function downloaded(dl) {
  const p = await dl.path();
  return fs.readFileSync(p);
}

test('the guard itself catches a remote request and a CSP-blocked fetch (so a silent run is not vacuous)', { skip }, async () => {
  const plain = path.join(WORK, 'plain.html');
  fs.writeFileSync(plain, '<!doctype html><title>t</title><img src="http://127.0.0.1:9/pixel.png">');
  const a = await guardedPage();
  await a.page.goto(pathToFileURL(plain).href);
  await a.page.waitForTimeout(300);
  assert.deepEqual([...new Set(a.bad)], ['http://127.0.0.1:9/pixel.png']);
  await a.context.close();
  const b = await guardedPage();
  await b.page.goto(pathToFileURL(REPORT).href);
  await b.page.waitForSelector('#ar-root:not([hidden])');
  await b.page.evaluate(() => fetch('http://127.0.0.1:9/x').catch(() => null));
  await b.page.waitForTimeout(300);
  assert.ok(b.problems.some((p) => /Content Security Policy|Refused to connect/.test(p)), 'the CSP refusal was seen: ' + JSON.stringify(b.problems));
  await b.context.close();
});

test('report mode over file://: renders, saves the card and a copy, and requests nothing remote', { skip }, async () => {
  const { context, page, bad, problems } = await guardedPage();
  await page.goto(pathToFileURL(REPORT).href);
  await page.waitForSelector('#ar-root:not([hidden])');
  const text = await page.textContent('#ar-root');
  assert.match(text, /At least \$/);
  const [cardDl] = await Promise.all([page.waitForEvent('download'), page.click('#ar-save-card')]);
  const png = await downloaded(cardDl);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.match(cardDl.url(), /^blob:/);
  // Share-safe mode, then save the share-safe copy and reopen it.
  await page.click('[data-action="share-safe"]');
  const [copyDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-copy"]')]);
  const copyPath = path.join(WORK, 'copy.html');
  fs.writeFileSync(copyPath, await downloaded(copyDl));
  const copy = await context.newPage();
  copy.on('pageerror', (e) => problems.push('copy page error: ' + e.message));
  await copy.goto(pathToFileURL(copyPath).href);
  await copy.waitForSelector('#ar-root:not([hidden])');
  assert.match(await copy.textContent('#ar-root'), /At least \$/);
  for (const p of ['gamma-web', 'beta-service']) assert.ok(!fs.readFileSync(copyPath, 'utf8').includes(p), 'project name in the share-safe copy');
  assert.deepEqual(bad, [], 'non-local requests');
  assert.deepEqual(problems, []);
  await context.close();
});

test('drop mode over file://: the in-page worker scans synthetic logs to the CLI\'s value, requesting nothing remote', { skip }, async () => {
  const { context, page, bad, problems } = await guardedPage();
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForSelector('#ar-dropzone');
  await page.setInputFiles('#ar-dir-input', PERSONA);
  await page.waitForSelector('#ar-save-card', { timeout: 60_000 });
  // Every dollar figure on the dropped page equals the one on the page the CLI wrote.
  const amounts = (t) => (t.match(/\$[0-9][0-9,]*(\.[0-9]+)?/g) || []);
  const dropped = amounts(await page.textContent('#ar-root'));
  const cliPage = await context.newPage();
  await cliPage.goto(pathToFileURL(REPORT).href);
  await cliPage.waitForSelector('#ar-save-card');
  const fromCli = amounts(await cliPage.textContent('#ar-root'));
  assert.ok(dropped.length >= 10, 'dollar figures on the dropped page: ' + dropped.length);
  assert.deepEqual(dropped, fromCli);
  const [cardDl] = await Promise.all([page.waitForEvent('download'), page.click('#ar-save-card')]);
  assert.deepEqual([...(await downloaded(cardDl)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(bad, [], 'non-local requests');
  assert.deepEqual(problems, []);
  await context.close();
});

test('a simulated drop onto the drop zone requests nothing remote', { skip }, async () => {
  const { context, page, bad, problems } = await guardedPage();
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForSelector('#ar-dropzone');
  const sample = fs.readFileSync(path.join(FIXTURES, 'golden-core', 'projects', '-fake-alpha', 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), 'utf8');
  await page.evaluate((content) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], 'aaaaaaaa-0000-4000-8000-000000000001.jsonl', { type: 'application/json' }));
    const zone = document.getElementById('ar-dropzone');
    for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, sample);
  // A synthetic drag carries no FileSystemEntry, so the page explains what to drop instead.
  await page.waitForSelector('#ar-drop-error:not([hidden])');
  assert.match(await page.textContent('#ar-drop-error'), /Drop a folder|could not list/);
  assert.deepEqual(bad, [], 'non-local requests');
  assert.deepEqual(problems, []);
  await context.close();
});

test('the live demo served from http://localhost renders and saves a card, requesting nothing else', { skip }, async () => {
  const demo = fs.readFileSync(PAGE, 'utf8').replace('<script type="application/json" id="ar-demo">null</script>', () => '<script type="application/json" id="ar-demo">' + embed(JSON.stringify(CLI_SUMMARY)) + '</script>');
  assert.notEqual(demo, fs.readFileSync(PAGE, 'utf8'), 'the ar-demo block was filled');
  server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(demo); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const url = 'http://127.0.0.1:' + /** @type {any} */ (server.address()).port + '/';
  const { context, page, bad, problems } = await guardedPage([url]);
  await page.goto(url);
  await page.click('[data-action="demo"]');
  await page.waitForSelector('#ar-save-card');
  assert.match(await page.textContent('#ar-root'), /synthetic sessions made for the demo/);
  const [cardDl] = await Promise.all([page.waitForEvent('download'), page.click('#ar-save-card')]);
  assert.deepEqual([...(await downloaded(cardDl)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(bad, [], 'requests other than the demo page itself');
  assert.deepEqual(problems, []);
  await context.close();
});
