// P2e — soul drift guard + prompt cache layering.
//
// soul.md (human SSoT) and SOUL_MARKDOWN (build-safe embed) must stay byte-
// identical; and the stable (cacheable) system prefix must still lead with the
// soul, then overlay the Notion TTL userContext — proving P2e didn't break the
// stable/dynamic cache split.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SOUL_MARKDOWN } from '../../../src/shared/chat/prompts/soul'
import { PRODUCT_SAFETY_FLOOR } from '../../../src/shared/chat/prompts/safety_floor'
import { __testing } from '../../../src/shared/chat/backends/custom_api'
import type { ChatModelConfig } from '../../../src/shared/chat/platform'

function cfg(over: Partial<ChatModelConfig> = {}): ChatModelConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    kosConsumerEnabled: false,
    kosConfigured: false,
    kosL1HotBlockEnabled: false,
    userContext: null,
    memorySummary: null,
    skillFragments: null,
    // PR4 — null = Standing Context flag OFF → legacy SOUL_MARKDOWN header path.
    standingContext: null,
    ...over
  }
}

describe('soul — SSoT ↔ embed parity', () => {
  test('SOUL_MARKDOWN is byte-identical to custom_ai/soul.md', () => {
    // vitest cwd = frontend package root.
    const mdPath = join(process.cwd(), 'src/shared/chat/prompts/custom_ai/soul.md')
    const md = readFileSync(mdPath, 'utf8').replace(/\n$/, '') // tolerate one trailing newline
    expect(SOUL_MARKDOWN).toBe(md)
  })

  test('soul leads the stable prefix; behaviour-identical static header', () => {
    const stable = __testing.buildStableSystemPrompt(null, cfg(), () => null)
    expect(stable).toBe(SOUL_MARKDOWN) // no userContext / KOS → exactly the soul (zero regression)
    expect(stable.startsWith('You are the AI assistant inside MailAgent')).toBe(true)
  })
})

describe('soul — cache layering (userContext overlay preserved)', () => {
  test('Notion userContext is appended after the soul, not before', () => {
    const stable = __testing.buildStableSystemPrompt(
      null,
      cfg({ userContext: 'USER_PROFILE_XYZ' }),
      () => null
    )
    expect(stable.startsWith(SOUL_MARKDOWN)).toBe(true)
    expect(stable).toContain('USER_PROFILE_XYZ')
    expect(stable.indexOf(SOUL_MARKDOWN)).toBeLessThan(stable.indexOf('USER_PROFILE_XYZ'))
  })
})

// P3 — Skill prompt fragments are injected ONLY when the runtime supplied a
// non-empty skillFragments (= the enabled+available skills' fragments). A disabled
// skill contributes nothing → its fragment must be absent. This is the "prompt
// assembly" half of acceptance ③ (the tool-filter half is covered by
// skill_enablement.test.ts).
describe('soul — Skill prompt fragment injection (P3)', () => {
  test('null / empty skillFragments → nothing injected (zero regression)', () => {
    const none = __testing.buildStableSystemPrompt(null, cfg({ skillFragments: null }), () => null)
    expect(none).toBe(SOUL_MARKDOWN)
    const empty = __testing.buildStableSystemPrompt(null, cfg({ skillFragments: '' }), () => null)
    expect(empty).toBe(SOUL_MARKDOWN)
  })

  test('enabled skill fragments are appended after the soul, after memory', () => {
    const stable = __testing.buildStableSystemPrompt(
      null,
      cfg({ memorySummary: 'MEM_OVERLAY', skillFragments: 'REPORT_SKILL_FRAGMENT' }),
      () => null
    )
    expect(stable.startsWith(SOUL_MARKDOWN)).toBe(true)
    expect(stable).toContain('REPORT_SKILL_FRAGMENT')
    // Ordering: soul → memory → skills (all in the cacheable stable prefix).
    expect(stable.indexOf('MEM_OVERLAY')).toBeLessThan(stable.indexOf('REPORT_SKILL_FRAGMENT'))
  })

  test('a DISABLED skill fragment is absent — runtime passes only enabled ones', () => {
    // The runtime derives skillFragments via computeSkillEnablement (only
    // advertised skills contribute). Here we model the post-toggle result: the
    // report fragment is enabled, the (disabled) calendar fragment never reaches
    // the prompt because the runtime excluded it from skillFragments.
    const stable = __testing.buildStableSystemPrompt(
      null,
      cfg({ skillFragments: 'REPORT_SKILL_FRAGMENT' }),
      () => null
    )
    expect(stable).toContain('REPORT_SKILL_FRAGMENT')
    expect(stable).not.toContain('CALENDAR_SKILL_FRAGMENT')
  })
})

// PR4 (task 06-22) — Standing Context layered assembly. When the backend supplies a
// non-empty standingContext (flag MAILAGENT_STANDING_CONTEXT_ENABLED on, default), the
// header becomes PRODUCT_SAFETY_FLOOR + standingContext instead of the legacy
// SOUL_MARKDOWN. null/"" → legacy path (the existing tests above already cover that
// the legacy header is byte-identical SOUL_MARKDOWN).
describe('safety floor + standing context (PR4)', () => {
  test('floor is byte-identical to soul.md safety section (drift guard)', () => {
    // PRODUCT_SAFETY_FLOOR must remain a verbatim slice of the legacy soul so the
    // hard safety behaviour is preserved when the layered assembly is on.
    expect(SOUL_MARKDOWN.includes(PRODUCT_SAFETY_FLOOR)).toBe(true)
  })

  test('standingContext present → floor leads, then user docs (not SOUL_MARKDOWN)', () => {
    const standing = '# SOUL\nIdentity here\n\n# RULES\nNever send silently'
    const stable = __testing.buildStableSystemPrompt(
      null,
      cfg({ standingContext: standing }),
      () => null
    )
    expect(stable.startsWith(PRODUCT_SAFETY_FLOOR)).toBe(true)
    expect(stable).toContain('Identity here')
    expect(stable).toContain('Never send silently')
    // floor is prepended BEFORE the user-editable docs (cannot be weakened)
    expect(stable.indexOf(PRODUCT_SAFETY_FLOOR)).toBeLessThan(stable.indexOf('Identity here'))
    // the legacy combined SOUL_MARKDOWN is NOT used as the header in the on-path
    expect(stable.startsWith(SOUL_MARKDOWN)).toBe(false)
  })

  test('standingContext keeps memory/skills ordering after the header', () => {
    const stable = __testing.buildStableSystemPrompt(
      null,
      cfg({
        standingContext: '# SOUL\nx',
        memorySummary: 'MEM_OVERLAY',
        skillFragments: 'SKILL_FRAG'
      }),
      () => null
    )
    // floor → standing → memory → skills (all in the cacheable stable prefix).
    expect(stable.indexOf(PRODUCT_SAFETY_FLOOR)).toBeLessThan(stable.indexOf('# SOUL'))
    expect(stable.indexOf('# SOUL')).toBeLessThan(stable.indexOf('MEM_OVERLAY'))
    expect(stable.indexOf('MEM_OVERLAY')).toBeLessThan(stable.indexOf('SKILL_FRAG'))
  })

  test('empty standingContext → legacy SOUL_MARKDOWN header (flag-off fallback)', () => {
    const stable = __testing.buildStableSystemPrompt(null, cfg({ standingContext: '' }), () => null)
    expect(stable).toBe(SOUL_MARKDOWN)
  })
})
