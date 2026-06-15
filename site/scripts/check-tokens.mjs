#!/usr/bin/env node
/**
 * check-tokens — best-effort drift detector between the site token SSoT
 * (src/styles/tokens.css) and the PRODUCT source
 * (../frontend/src/electron/renderer/index.css).
 *
 * It compares the dark `:root` surface/foreground triples and the dark accent
 * presets (--c-accent / -hi / -dim per data-accent). It is a STRING diff, not
 * a CSS parser — it warns, it does not gate the build. Run on product accent
 * changes (oklch re-export) to know when to re-sync tokens.css.
 *
 *   pnpm check:tokens   → exits 0 always (warnings to stderr); exit 2 if a
 *                         source file is missing.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SITE_TOKENS = resolve(__dirname, '../src/styles/tokens.css')
const PRODUCT_CSS = resolve(__dirname, '../../frontend/src/electron/renderer/index.css')

// Tokens we care about for drift (channels-only triplets).
const SURFACE = [
  '--ink-0', '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--ink-5',
  '--ink-border', '--ink-border-soft',
  '--ink-fg', '--ink-fg-1', '--ink-fg-2', '--ink-fg-3',
]
const ACCENT = ['--c-accent', '--c-accent-hi', '--c-accent-dim']

/** Grab the first `--name: <value>;` after the first `:root {` (dark block). */
function firstRootValue(css, name) {
  const rootIdx = css.indexOf(':root')
  const scope = rootIdx === -1 ? css : css.slice(rootIdx)
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`)
  const m = scope.match(re)
  return m ? m[1].trim() : null
}

function fail(msg) {
  console.error(`[check-tokens] ${msg}`)
}

if (!existsSync(SITE_TOKENS)) {
  fail(`site tokens not found: ${SITE_TOKENS}`)
  process.exit(2)
}
if (!existsSync(PRODUCT_CSS)) {
  fail(`product index.css not found: ${PRODUCT_CSS} (skipping — run inside the monorepo)`)
  process.exit(0)
}

const site = readFileSync(SITE_TOKENS, 'utf8')
const product = readFileSync(PRODUCT_CSS, 'utf8')

let drift = 0
for (const name of [...SURFACE, ...ACCENT]) {
  const a = firstRootValue(site, name)
  const b = firstRootValue(product, name)
  if (a == null || b == null) {
    console.warn(`[check-tokens] missing ${name} (site=${a ?? '∅'} product=${b ?? '∅'})`)
    continue
  }
  if (a !== b) {
    console.warn(`[check-tokens] DRIFT ${name}: site="${a}" vs product="${b}"`)
    drift++
  }
}

if (drift === 0) {
  console.log('[check-tokens] ✓ dark surface + accent triples match product index.css')
} else {
  console.warn(`[check-tokens] ${drift} token(s) drifted — re-sync src/styles/tokens.css from the product.`)
}
process.exit(0)
