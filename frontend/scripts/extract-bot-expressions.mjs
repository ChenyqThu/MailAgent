// One-shot extraction of the GrokBot eye-contour data from the reference prototype HTML
// ("Atelier GrokBot — prototype", a throwaway single-page lab; NOT committed to the repo).
//
// Usage:  node scripts/extract-bot-expressions.mjs <path-to-prototype-index.html>
// Output: src/shared/bot-avatar/expressions.json  (25 expressions × 2 eye rings × 48 [x,y] points,
//         viewBox "-15 -15 259 259" coordinate space, head center 114.2705 / sphere radius 105)
//
// Provenance note: the contours are traced from the Grok (x.ai) bot. Internal dogfood use was
// owner-approved 2026-08-13 (see .trellis/tasks/08-12-living-bot-avatar/prd.md §9); a public
// release would need a redrawn expression set — the engine is decoupled from this data on purpose.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/extract-bot-expressions.mjs <path-to-prototype-index.html>')
  process.exit(2)
}

const html = readFileSync(src, 'utf8')
const startMarker = 'const EXPRESSIONS ='
const start = html.indexOf(startMarker)
const groupsAt = html.indexOf('const GROUPS = {')
if (start < 0 || groupsAt < 0 || groupsAt <= start) {
  console.error('EXPRESSIONS block not found in', src)
  process.exit(1)
}
const literal = html.slice(start + startMarker.length, html.lastIndexOf(']', groupsAt) + 1)

// The literal is a plain nested numeric array (JS allows trailing commas, JSON does not) —
// evaluate instead of JSON.parse. Dev-only one-shot script, input is the local prototype file.
const data = new Function('return (' + literal + ')')()

if (!Array.isArray(data) || data.length === 0) throw new Error('extraction produced no expressions')
for (const [i, expr] of data.entries()) {
  if (!Array.isArray(expr) || expr.length !== 2) throw new Error(`expression ${i}: expected exactly 2 eye rings`)
  for (const [j, ring] of expr.entries()) {
    if (!Array.isArray(ring) || ring.length !== 48) {
      throw new Error(`expression ${i} ring ${j}: expected 48 points, got ${ring?.length}`)
    }
    for (const p of ring) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
        throw new Error(`expression ${i} ring ${j}: malformed point ${JSON.stringify(p)}`)
      }
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../src/shared/bot-avatar/expressions.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(data) + '\n')
console.log(`wrote ${out}: ${data.length} expressions x 2 rings x 48 points`)
console.log('first point:', JSON.stringify(data[0][0][0]), 'last point:', JSON.stringify(data.at(-1).at(-1).at(-1)))
