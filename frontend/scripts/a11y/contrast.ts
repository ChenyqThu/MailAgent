// Sprint 3 §2.4 — WCAG AA contrast auditor.
//
// Iterates the 6 accent × 2 mode = 12 visual paths (REVIEW-LOG H-01) and
// runs axe-core's WCAG AA color-contrast checks against a hand-crafted
// fixture page that surfaces the design tokens in their realistic JSX
// contexts (priority chips, EmailRow, toolbar buttons, sidebar items,
// translation banner, search filter chips, thread sidebar).
//
// Why a static fixture rather than the live renderer:
//   - The Electron preload bridge isn't there under a Chromium-only
//     Playwright launch, so the React app crashes trying to invoke IPC.
//     We could stub `window.electron`, but the fixture stays stable across
//     Sprint-level refactors and validates *just* the design tokens.
//   - axe-core only sees what's on the page; the fixture surfaces every
//     token combination the live UI actually composes.
//
// Bash usage:  `pnpm a11y:contrast`              (report baseline, exit 0)
//              `pnpm a11y:contrast --strict`     (exit 1 if any violation)
//              `pnpm a11y:contrast --json`       (machine-readable, exit 0)
//
// Sprint 3 baseline: 335 violations across 12 combinations — see
// `frontend/NOTES.md` 2026-05-17 entry. The script is intentionally
// non-blocking by default; `--strict` will be flipped on the npm script
// once token tuning (Sprint 4 carry-forward) brings the count to zero.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import AxeBuilder from '@axe-core/playwright'
import { chromium, type Page } from 'playwright'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(ROOT, '../..')
const FIXTURE = join(ROOT, 'fixture.html')
const TAILWIND_INPUT = join(FRONTEND, 'src/electron/renderer/index.css')

const ACCENTS = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive'] as const
const MODES = ['dark', 'light'] as const
type Accent = (typeof ACCENTS)[number]
type Mode = (typeof MODES)[number]

interface Combo {
  accent: Accent
  mode: Mode
}

interface ViolationLine {
  combo: Combo
  ruleId: string
  impact: string
  description: string
  helpUrl: string
  targets: string[]
}

const JSON_FLAG = process.argv.includes('--json')
const STRICT_FLAG = process.argv.includes('--strict')

function log(msg: string): void {
  if (!JSON_FLAG) process.stderr.write(`${msg}\n`)
}

function buildTailwindCss(): string {
  // Compile a one-shot CSS bundle with all of the project's class usage so
  // the fixture renders with the exact tokens the renderer uses. The
  // existing `tailwindcss` devDep is invoked via pnpm exec so we don't
  // need a node binding.
  const out = join(mkdtempSync(join(tmpdir(), 'a11y-')), 'styles.css')
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'tailwindcss',
      '-i',
      TAILWIND_INPUT,
      '-o',
      out,
      '--content',
      'src/**/*.{tsx,ts,html}',
      '--content',
      'scripts/a11y/fixture.html',
      '--minify'
    ],
    { cwd: FRONTEND, stdio: 'pipe', encoding: 'utf8' }
  )
  if (result.status !== 0) {
    log(result.stderr ?? 'tailwindcss failed')
    process.exit(2)
  }
  if (!existsSync(out)) {
    log(`tailwind output missing at ${out}`)
    process.exit(2)
  }
  return readFileSync(out, 'utf8')
}

async function applyCombo(page: Page, combo: Combo): Promise<void> {
  await page.evaluate(
    ({ accent, mode }: { accent: string; mode: string }) => {
      const root = document.documentElement
      root.setAttribute('data-theme', mode)
      if (accent === 'coral') {
        root.removeAttribute('data-accent')
      } else {
        root.setAttribute('data-accent', accent)
      }
      root.classList.toggle('dark', mode === 'dark')
    },
    combo as unknown as { accent: string; mode: string }
  )
}

async function auditCombo(page: Page, combo: Combo): Promise<ViolationLine[]> {
  await applyCombo(page, combo)
  // axe-core needs a beat to settle CSS variable cascades.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2aa'])
    // Restrict to colour-contrast — Sprint 3's mandate. Other a11y axes
    // (labels, ARIA) come online in Sprint 4 visual polish.
    .withRules(['color-contrast'])
    .analyze()
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => ({
      combo,
      ruleId: v.id,
      impact: v.impact ?? 'unknown',
      description: v.description,
      helpUrl: v.help,
      targets: n.target.map((t) => (Array.isArray(t) ? t.join(' ') : String(t)))
    }))
  )
}

function formatPlain(lines: ViolationLine[]): string {
  if (lines.length === 0) return '✓ a11y:contrast — 12 combinations clean (WCAG AA, color-contrast)\n'

  // Group by combo for a compact summary; full details on --json only.
  const byCombo = new Map<string, number>()
  for (const v of lines) {
    const k = `${v.combo.mode}·${v.combo.accent}`
    byCombo.set(k, (byCombo.get(k) ?? 0) + 1)
  }
  const out: string[] = [
    `${STRICT_FLAG ? '✗' : '◇'} a11y:contrast — ${lines.length} violation(s) across 12 combinations`,
    ''
  ]
  for (const [combo, n] of [...byCombo.entries()].sort()) {
    out.push(`  ${combo.padEnd(14)} ${n} violation(s)`)
  }
  out.push('')
  out.push('  Run with --json for full per-element detail.')
  if (!STRICT_FLAG) {
    out.push('  (informational; --strict to gate on any violation)')
  }
  return out.join('\n') + '\n'
}

async function main(): Promise<void> {
  log('a11y:contrast — building tailwind css ...')
  const css = buildTailwindCss()
  if (!existsSync(FIXTURE)) {
    log(`fixture missing: ${FIXTURE}`)
    process.exit(2)
  }
  const html = readFileSync(FIXTURE, 'utf8')

  log('a11y:contrast — launching chromium ...')
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: css })

  const all: ViolationLine[] = []
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const combo: Combo = { accent, mode }
      log(`a11y:contrast — auditing ${mode}·${accent} ...`)
      const lines = await auditCombo(page, combo)
      all.push(...lines)
    }
  }
  await browser.close()

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify({ total: all.length, violations: all }, null, 2) + '\n')
  } else {
    process.stdout.write(formatPlain(all))
  }
  // Sprint 3 ships the harness + captures the baseline; Sprint 4 carry-forward
  // owns the token tuning that drives this to zero. `--strict` is the gating
  // mode for CI once that work lands.
  if (STRICT_FLAG && all.length > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  log(`a11y:contrast crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(2)
})
