// ESM-safe replacements for the CJS globals (`__dirname` / `require`) in the main bundle.
//
// Why this exists: main is an ESM bundle (package.json type:module). electron-vite
// only injects its `__dirname`/`require` shim banner while the main bundle is a
// SINGLE file; the provider-registry epic's lazy `await import()` split the bundle
// into out/main/chunks/* and the banner disappeared — every bare `__dirname` /
// `require()` left in source became a runtime ReferenceError inside app.whenReady
// (startup-dead in both dev and packaged builds).
//
// 🔴 Invariant: this module must stay STATICALLY imported from the entry
// (main/index.ts). Rollup never duplicates modules, so a module statically
// reachable from the entry is emitted into out/main/index.js and dynamic chunks
// import it from there — at runtime `import.meta.url` here is therefore always
// the entry chunk, and `mainDirname` === out/main, byte-identical to the old
// shimmed `__dirname`. If this module ever landed in out/main/chunks/ instead,
// mainDirname would gain a spurious `/chunks` segment and every relative asset
// path (preload / renderer index.html / build icons) would break. The static
// import + the bare-globals ban are pinned by tests/main/esm_globals.test.ts.

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of the bundled main entry (out/main) — the old shimmed `__dirname`. */
export const mainDirname = dirname(fileURLToPath(import.meta.url))

/**
 * CJS require for lazy-loading CJS-only deps (electron-updater) after app-ready.
 * Bare-specifier resolution walks node_modules upward from out/main, so unlike
 * mainDirname it is chunk-placement-insensitive. Precedent: bin_resolver.ts requireFn.
 */
export const requireFromMain = createRequire(import.meta.url)
