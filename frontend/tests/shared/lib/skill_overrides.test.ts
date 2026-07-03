// S3 — the localStorage skill-override store (moved from shared/chat/skill_enablement.ts
// when the legacy engine was deleted; only the transitional read/write survives — the
// backend agent_config.db is the toggle SSoT and CustomAiSection migrates+clears this).
// Stubs a minimal in-memory localStorage via vi.stubGlobal so it's env-independent.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { readSkillOverrides, writeSkillOverrides } from '../../../src/shared/lib/skill_overrides'

const SKILL_OVERRIDES_KEY = 'mailagent.skills.enabled'

describe('readSkillOverrides / writeSkillOverrides — localStorage transitional store', () => {
  beforeEach(() => {
    let store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string): string | null => (k in store ? store[k] : null),
      setItem: (k: string, v: string): void => {
        store[k] = v
      },
      removeItem: (k: string): void => {
        delete store[k]
      },
      clear: (): void => {
        store = {}
      }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('empty / absent → {}', () => {
    expect(readSkillOverrides()).toEqual({})
  })

  test('writeSkillOverrides persists + readSkillOverrides round-trips', () => {
    writeSkillOverrides({ report: false })
    expect(readSkillOverrides()).toEqual({ report: false })
    writeSkillOverrides({ report: false, notion_agent: true })
    expect(readSkillOverrides()).toEqual({ report: false, notion_agent: true })
    writeSkillOverrides({})
    expect(readSkillOverrides()).toEqual({})
  })

  test('malformed JSON → {} (graceful)', () => {
    localStorage.setItem(SKILL_OVERRIDES_KEY, '{not json')
    expect(readSkillOverrides()).toEqual({})
  })

  test('non-boolean values are dropped', () => {
    localStorage.setItem(SKILL_OVERRIDES_KEY, JSON.stringify({ a: true, b: 'yes', c: 1 }))
    expect(readSkillOverrides()).toEqual({ a: true })
  })

  test('no localStorage global → read {} / write no-throw (node lane)', () => {
    vi.unstubAllGlobals()
    expect(readSkillOverrides()).toEqual({})
    expect(() => writeSkillOverrides({ a: true })).not.toThrow()
  })
})
