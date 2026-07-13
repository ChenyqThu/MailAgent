// P5 dogfood startup-dead regression pin — no bare CJS globals in ESM electron source.
//
// main is an ESM bundle (package.json type:module). electron-vite injects its
// __dirname/require shim banner ONLY while the main bundle is a single file; the
// provider-registry epic's lazy `await import()` split the bundle into
// out/main/chunks/* and the banner disappeared → every bare __dirname/require()
// became a runtime ReferenceError inside app.whenReady (dev AND packaged builds
// both startup-dead; unit tests could not catch it — the bug lives at bundle level).
// Verification method mirrors provider_lazy_import.test.ts: STATIC SOURCE
// ASSERTIONS over frontend/src/{electron,ai-gateway,shared}/** — bare `__dirname` /
// `__filename` / `require(` are banned; the ESM-safe single source is lib/esm-paths.ts
// (mainDirname / requireFromMain, or a local createRequire per bin_resolver.ts).
// Scan roots (provider-registry epic 终审 L-6 扩根): src/electron was the original P5
// pin; src/ai-gateway + src/shared land in the SAME ESM main bundle (shared is also
// pulled by the renderer — equally ESM), so bare CJS globals there are equally fatal.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url))
const SCAN_DIRS = ['electron', 'ai-gateway', 'shared'] as const

function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Lines that legitimately mention the banned tokens. */
function isAllowedLine(line: string): boolean {
  const trimmed = line.trim()
  // Comments (incl. block-comment bodies) may discuss __dirname/require freely.
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true
  // createRequire(import.meta.url) is the sanctioned ESM↔CJS bridge (bin_resolver.ts,
  // lib/esm-paths.ts). The call sites use requireFn(...)/requireFromMain(...), which
  // the bare-`require(` regex below does not match anyway.
  if (line.includes('createRequire')) return true
  return false
}

const BARE_GLOBALS: Array<[name: string, pattern: RegExp]> = [
  ['__dirname', /\b__dirname\b/],
  ['__filename', /\b__filename\b/],
  // Bare call only: not preceded by word char / `.` / `$`, so requireFn(...),
  // requireFromMain(...), module.require(...) stay out of scope.
  ['require(', /(?<![\w.$])require\s*\(/]
]

describe('no bare CJS globals in ESM electron source (P5 startup regression pin)', () => {
  const files = SCAN_DIRS.flatMap((dir) => walkSources(join(SRC_ROOT, dir)))

  it('collects a sane source set (canary against the walker going stale)', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('electron/main/index.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('handlers/onboarding.ts'))).toBe(true)
    // L-6 扩根 canary: the two extra roots really are walked.
    expect(files.some((f) => f.endsWith('ai-gateway/server.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('shared/api/chat_api.ts'))).toBe(true)
  })

  it.each(BARE_GLOBALS)(
    'no bare %s anywhere under src/{electron,ai-gateway,shared}/**',
    (name, pattern) => {
      const offenders: string[] = []
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (pattern.test(line) && !isAllowedLine(line)) {
            offenders.push(`${relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`)
          }
        })
      }
      expect(
        offenders,
        `bare ${name} found (use lib/esm-paths.ts instead):\n${offenders.join('\n')}`
      ).toEqual([])
    }
  )

  it('main/index.ts pins esm-paths into the entry chunk via a static import', () => {
    // mainDirname is only correct while esm-paths is emitted into out/main/index.js
    // (entry chunk). Rollup guarantees that iff the entry statically imports it —
    // if this import ever becomes dynamic or disappears, mainDirname could land in
    // out/main/chunks/ and gain a spurious /chunks path segment.
    const source = readFileSync(join(SRC_ROOT, 'electron/main/index.ts'), 'utf8')
    expect(source).toMatch(/^import\s+\{[^}]*mainDirname[^}]*\}\s+from\s+'\.\/lib\/esm-paths'/m)
  })
})
