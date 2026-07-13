// MEDIUM-6 (batch1 review) — lazy-rollback pin for the provider SDK split.
//
// providers.ts top-level imports SIX provider SDK packages; the emergency rollback contract is
// "MAILAGENT_LLM_PROVIDER_REGISTRY off ⇒ none of the new SDKs are in the module graph" (a broken
// provider package must not be able to take down the flag-off gateway). Verification method:
// STATIC SOURCE ASSERTIONS — the always-loaded modules (chatRun / thinking / config / the Electron
// lifecycle) must never carry a top-level VALUE import of providers.ts or of the SDK packages;
// the lifecycle's flag-on branch is the single dynamic-import entry. (A runtime module-graph spy
// can't prove a negative under vitest's mock loader, so we pin the import statements themselves.)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

/** Every import statement in `source` referencing a module whose specifier matches `spec` —
 *  returned verbatim so the assertion message shows the offending statement. */
function importStatements(source: string, spec: RegExp): string[] {
  const statements = source.match(/^import[\s\S]*?from\s+'[^']+'/gm) ?? []
  return statements.filter((stmt) => {
    const from = stmt.match(/from\s+'([^']+)'/)
    return from != null && spec.test(from[1])
  })
}

const ALWAYS_LOADED = [
  'ai-gateway/chatRun.ts',
  'ai-gateway/thinking.ts',
  'ai-gateway/config.ts',
  'electron/main/ai_gateway_lifecycle.ts'
]

const SDK_PACKAGES =
  /^(@ai-sdk\/(openai|openai-compatible|deepseek|google)|@openrouter\/ai-sdk-provider)$/

describe('provider SDK lazy-import split (MEDIUM-6)', () => {
  it.each(ALWAYS_LOADED)('%s has no top-level VALUE import of providers.ts', (rel) => {
    const source = read(rel)
    for (const stmt of importStatements(source, /\/providers$/)) {
      expect(stmt, `non-type import of providers.ts in ${rel}: ${stmt}`).toMatch(/^import\s+type\s/)
    }
  })

  it.each(ALWAYS_LOADED)('%s has no top-level import of the five new SDK packages', (rel) => {
    const source = read(rel)
    expect(importStatements(source, SDK_PACKAGES)).toEqual([])
  })

  it('the lifecycle reaches providers.ts ONLY via the flag-on dynamic import', () => {
    const source = read('electron/main/ai_gateway_lifecycle.ts')
    expect(source).toContain("await import('../../ai-gateway/providers')")
  })

  it('providerRef.ts stays SDK-free (type-only imports exclusively)', () => {
    const source = read('ai-gateway/providerRef.ts')
    for (const stmt of source.match(/^import[\s\S]*?from\s+'[^']+'/gm) ?? []) {
      expect(stmt, `runtime import in providerRef.ts: ${stmt}`).toMatch(/^import\s+type\s/)
    }
  })
})
