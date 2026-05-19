// @vitest-environment happy-dom
//
// Sprint 11 V1.4 — useNavCollapsed store test.
//
// Covers: toggle round-trip, setCollapsed direct write, cross-window
// storage-event reactivity (the listener that keeps pop-out windows in
// sync with the main inbox window).

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { useNavCollapsed } from '../../src/shared/state/nav-shell'

const KEY = 'mailagent.nav.collapsed'

// happy-dom's Storage shape varies across versions (some builds drop
// getItem/removeItem). We only need to verify store mutation semantics
// here — the localStorage path inside nav-shell.ts is wrapped in try-catch
// and exercised at runtime in the Electron renderer.
function resetState(): void {
  useNavCollapsed.setState({ collapsed: false })
}

describe('useNavCollapsed', () => {
  beforeEach(resetState)
  afterEach(resetState)

  test('toggle flips state', () => {
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    useNavCollapsed.getState().toggle()
    expect(useNavCollapsed.getState().collapsed).toBe(true)
    useNavCollapsed.getState().toggle()
    expect(useNavCollapsed.getState().collapsed).toBe(false)
  })

  test('setCollapsed writes directly', () => {
    useNavCollapsed.getState().setCollapsed(true)
    expect(useNavCollapsed.getState().collapsed).toBe(true)
    useNavCollapsed.getState().setCollapsed(false)
    expect(useNavCollapsed.getState().collapsed).toBe(false)
  })

  test('storage event from another window updates the store', () => {
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    // Simulate the event that fires when a DIFFERENT renderer window
    // writes the same key — same `key` + `newValue` shape that the real
    // browser ships when a sibling window mutates localStorage.
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue: 'true' })
    )
    expect(useNavCollapsed.getState().collapsed).toBe(true)
  })

  test('storage event for a different key is ignored', () => {
    useNavCollapsed.getState().setCollapsed(true)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mailagent.unrelated',
        newValue: 'false'
      })
    )
    expect(useNavCollapsed.getState().collapsed).toBe(true)
  })

  test('storage event with the same value is a no-op (idempotent)', () => {
    useNavCollapsed.getState().setCollapsed(true)
    const before = useNavCollapsed.getState().collapsed
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue: 'true' })
    )
    expect(useNavCollapsed.getState().collapsed).toBe(before)
  })
})
