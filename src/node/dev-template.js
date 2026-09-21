// Source checkout only: the report page, built on the fly from src/web by the project's own
// build script (scripts/build.mjs), with its original names so it stays readable while
// developing (comments are still stripped: the page must pass the same no-network scan).
//
// The published bundle never contains this module: scripts/build.mjs replaces the import of it
// in report.js with a stub, because the bundle carries the finished page itself (report.js,
// EMBEDDED_TEMPLATE). From a checkout the sandboxed scanner may read scripts/build.mjs
// (sandbox.js, programReadPaths). If the build script cannot be loaded at all (a copy of src
// without scripts/), reports fall back to the built-in static page; a page that fails to BUILD
// throws, so a broken src/web shows up in the first report instead of hiding behind a fallback.

/** @type {any} */
let build = null;
try {
  build = await import(new URL('../../scripts/build.mjs', import.meta.url).href);
} catch {
  build = null;
}

/** @type {string|null} */
let cached = null;

/**
 * The page a CLI report is written into (the built template without the drop-mode worker, as
 * the bundle embeds it, but with the original names), or null when the build script is not
 * available.
 * Built once per process.
 * @returns {string|null}
 */
export function devReportTemplate() {
  if (!build) return null;
  if (cached === null) {
    const page = /** @type {string} */ (build.cliTemplate(build.buildTemplate({ mangle: false }).html));
    // The same gates the build applies to the page it embeds.
    const violations = build.scanForNetwork(page);
    if (violations.length) throw new Error('the report page built from src/web fails the no-network scan: ' + violations.join('; '));
    build.checkAnchors(page);
    cached = page;
  }
  return cached;
}
