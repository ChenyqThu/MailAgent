// Phase 10b — auto-title renderer preferences (localStorage-backed). Node env: stub a memory-backed
// localStorage before importing the module (mirrors tests/shared/search-history.test.ts). Default is
// off (= first-message preview); a garbage stored mode falls back to off (only 'llm' enables).

import { describe, expect, test, vi, beforeEach } from 'vitest'

const memory: Record<string, string> = {}
const fakeLocalStorage = {
  getItem: (k: string) => (k in memory ? memory[k] : null),
  setItem: (k: string, v: string) => {
    memory[k] = v
  },
  removeItem: (k: string) => {
    delete memory[k]
  },
  clear: () => {
    for (const k of Object.keys(memory)) delete memory[k]
  }
}
vi.stubGlobal('localStorage', fakeLocalStorage)

const { readAutoTitleSettings, writeAutoTitleMode, writeAutoTitleModel, DEFAULT_AUTO_TITLE_MODEL } =
  await import('../../src/shared/lib/autoTitle')

beforeEach(() => {
  for (const k of Object.keys(memory)) delete memory[k]
})

describe('autoTitle settings', () => {
  test('defaults to off + the default model when storage is empty', () => {
    expect(readAutoTitleSettings()).toEqual({ mode: 'off', model: DEFAULT_AUTO_TITLE_MODEL })
  })

  test('mode write/read round-trips', () => {
    writeAutoTitleMode('llm')
    expect(readAutoTitleSettings().mode).toBe('llm')
    writeAutoTitleMode('off')
    expect(readAutoTitleSettings().mode).toBe('off')
  })

  test('model write/read round-trips', () => {
    writeAutoTitleModel('claude-sonnet-4-6')
    expect(readAutoTitleSettings().model).toBe('claude-sonnet-4-6')
  })

  test('an unknown stored mode falls back to off (only "llm" enables)', () => {
    localStorage.setItem('mailagent.chat.autoTitle.mode', 'garbage')
    expect(readAutoTitleSettings().mode).toBe('off')
  })
})
