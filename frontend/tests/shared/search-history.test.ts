// G-B3 — search history + saved searches store tests (node env).
//
// The store reads `window.localStorage` on construction and registers a
// `storage` listener at module import, so we stub a minimal `window` (with a
// memory-backed localStorage + no-op addEventListener) BEFORE importing the
// module — mirroring tests/shared/active-email.test.ts.

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
vi.stubGlobal('window', {
  localStorage: fakeLocalStorage,
  addEventListener: () => {}
})

const KEY_HISTORY = 'mailagent.palette.history'
const KEY_SAVED = 'mailagent.palette.saved'

const mod = await import('../../src/shared/state/search-history')
const { useSearchHistory } = mod

beforeEach(() => {
  for (const k of Object.keys(memory)) delete memory[k]
  useSearchHistory.setState({ history: [], saved: [] })
})

describe('pushHistory', () => {
  test('records a query', () => {
    useSearchHistory.getState().pushHistory('redis')
    expect(useSearchHistory.getState().history).toEqual(['redis'])
  })

  test('trims + skips empty / whitespace-only', () => {
    useSearchHistory.getState().pushHistory('   ')
    expect(useSearchHistory.getState().history).toEqual([])
    useSearchHistory.getState().pushHistory('  redis  ')
    expect(useSearchHistory.getState().history).toEqual(['redis'])
  })

  test('de-dupes and moves the repeat to the front (most-recent-first)', () => {
    const { pushHistory } = useSearchHistory.getState()
    pushHistory('a')
    pushHistory('b')
    pushHistory('a')
    expect(useSearchHistory.getState().history).toEqual(['a', 'b'])
  })

  test('caps at 8 most-recent entries', () => {
    const { pushHistory } = useSearchHistory.getState()
    for (let i = 1; i <= 10; i++) pushHistory(`q${i}`)
    const h = useSearchHistory.getState().history
    expect(h).toHaveLength(8)
    expect(h[0]).toBe('q10')
    expect(h).not.toContain('q1')
    expect(h).not.toContain('q2')
  })

  test('persists to localStorage', () => {
    useSearchHistory.getState().pushHistory('redis')
    expect(JSON.parse(memory[KEY_HISTORY])).toEqual(['redis'])
  })
})

describe('removeHistory / clearHistory', () => {
  test('removeHistory drops a single entry', () => {
    const { pushHistory, removeHistory } = useSearchHistory.getState()
    pushHistory('a')
    pushHistory('b')
    removeHistory('a')
    expect(useSearchHistory.getState().history).toEqual(['b'])
    expect(JSON.parse(memory[KEY_HISTORY])).toEqual(['b'])
  })

  test('clearHistory empties the list + persists', () => {
    const { pushHistory, clearHistory } = useSearchHistory.getState()
    pushHistory('a')
    clearHistory()
    expect(useSearchHistory.getState().history).toEqual([])
    expect(JSON.parse(memory[KEY_HISTORY])).toEqual([])
  })
})

describe('addSaved / removeSaved', () => {
  test('adds a saved search with id + name + query', () => {
    useSearchHistory.getState().addSaved('My filter', 'from:alice is:unread')
    const saved = useSearchHistory.getState().saved
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('My filter')
    expect(saved[0].query).toBe('from:alice is:unread')
    expect(typeof saved[0].id).toBe('string')
    expect(saved[0].id.length).toBeGreaterThan(0)
  })

  test('falls back to query as name when name is blank', () => {
    useSearchHistory.getState().addSaved('  ', 'redis')
    expect(useSearchHistory.getState().saved[0].name).toBe('redis')
  })

  test('skips empty query', () => {
    useSearchHistory.getState().addSaved('x', '   ')
    expect(useSearchHistory.getState().saved).toEqual([])
  })

  test('removeSaved drops by id', () => {
    const { addSaved } = useSearchHistory.getState()
    addSaved('a', 'qa')
    addSaved('b', 'qb')
    const first = useSearchHistory.getState().saved[0]
    useSearchHistory.getState().removeSaved(first.id)
    const remaining = useSearchHistory.getState().saved
    expect(remaining).toHaveLength(1)
    expect(remaining[0].query).toBe('qb')
  })

  test('persists saved list to localStorage', () => {
    useSearchHistory.getState().addSaved('a', 'qa')
    const stored = JSON.parse(memory[KEY_SAVED])
    expect(stored).toHaveLength(1)
    expect(stored[0].query).toBe('qa')
  })
})
