// Sprint 2 D1 — active-email state pure-logic tests. The zustand store
// instance itself touches localStorage on construction, which we stub at
// module level so the test stays in the node-environment pool (no jsdom).
// `pickNext` / `pickPrev` are pure — straightforward table tests.

import { describe, expect, test, vi, beforeEach } from 'vitest'

// Stub localStorage BEFORE importing the store so the module-level read()
// doesn't blow up under the node pool. globalThis.localStorage is undefined
// under Node, which makes `localStorage.getItem` throw a ReferenceError —
// the production code already catches it, but tying the test to that
// behaviour would be brittle.
const memoryStore: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
  setItem: (k: string, v: string) => {
    memoryStore[k] = v
  },
  removeItem: (k: string) => {
    delete memoryStore[k]
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  }
})

const mod = await import('../../src/shared/state/active-email')
const { pickNext, pickPrev, useActiveEmail } = mod

beforeEach(() => {
  // Clear the stub localStorage + reset the in-memory zustand state.
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  useActiveEmail.setState({ activeInternalId: null })
})

describe('pickNext', () => {
  test('empty list → null', () => {
    expect(pickNext([], null)).toBeNull()
    expect(pickNext([], 42)).toBeNull()
  })

  test('null current → first id (treat as "no prior selection")', () => {
    expect(pickNext([101, 102, 103], null)).toBe(101)
  })

  test('current not in list → first id (stale-id recovery)', () => {
    // Happens after a mailbox switch: the old activeInternalId no longer
    // exists in the freshly-loaded id list.
    expect(pickNext([201, 202], 999)).toBe(201)
  })

  test('walks forward', () => {
    expect(pickNext([101, 102, 103], 101)).toBe(102)
    expect(pickNext([101, 102, 103], 102)).toBe(103)
  })

  test('tail stops at tail (DESIGN.md §9.5 — no wrap)', () => {
    expect(pickNext([101, 102, 103], 103)).toBe(103)
  })
})

describe('pickPrev', () => {
  test('empty list → null', () => {
    expect(pickPrev([], null)).toBeNull()
    expect(pickPrev([], 42)).toBeNull()
  })

  test('null current → first id', () => {
    expect(pickPrev([101, 102, 103], null)).toBe(101)
  })

  test('stale id → first id', () => {
    expect(pickPrev([201, 202], 999)).toBe(201)
  })

  test('walks backward', () => {
    expect(pickPrev([101, 102, 103], 103)).toBe(102)
    expect(pickPrev([101, 102, 103], 102)).toBe(101)
  })

  test('head stops at head (no wrap)', () => {
    expect(pickPrev([101, 102, 103], 101)).toBe(101)
  })
})

describe('useActiveEmail store', () => {
  test('setActive(n) updates state and persists to localStorage', () => {
    useActiveEmail.getState().setActive(53675)
    expect(useActiveEmail.getState().activeInternalId).toBe(53675)
    expect(memoryStore['mailagent.activeEmail']).toBe('53675')
  })

  test('setActive(null) clears state and removes from localStorage', () => {
    useActiveEmail.getState().setActive(53675)
    useActiveEmail.getState().setActive(null)
    expect(useActiveEmail.getState().activeInternalId).toBeNull()
    expect('mailagent.activeEmail' in memoryStore).toBe(false)
  })

  test('rejects bogus persisted values on construction (corruption recovery)', async () => {
    // Simulate a stored value that's not a non-negative int (could be the
    // result of a 0.x → 1.0 migration that wrote a different shape). The
    // next module import should hand back null, not a thrown TypeError.
    memoryStore['mailagent.activeEmail'] = 'NaN'
    vi.resetModules()
    const fresh = await import('../../src/shared/state/active-email')
    expect(fresh.useActiveEmail.getState().activeInternalId).toBeNull()
  })
})
