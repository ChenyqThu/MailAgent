// Sprint 5 §2.2 — toast store contract.
//
// The store is a zustand singleton; tests must reset between cases so the
// monotonic id counter + items queue don't carry over. `__resetToastStore`
// exists for exactly that and is NOT a production API.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_VISIBLE,
  __resetToastStore,
  toastError,
  toastInfo,
  toastSuccess,
  useToastStore
} from '../../src/shared/state/toast'

beforeEach(() => {
  __resetToastStore()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toast store — push', () => {
  test('push() returns a monotonic id', () => {
    const a = toastSuccess('a')
    const b = toastError('b')
    const c = toastInfo('c')
    expect(b).toBe(a + 1)
    expect(c).toBe(b + 1)
  })

  test('default ttl auto-dismisses after 3s', () => {
    toastSuccess('hi')
    expect(useToastStore.getState().items.length).toBe(1)
    vi.advanceTimersByTime(2999)
    expect(useToastStore.getState().items.length).toBe(1)
    vi.advanceTimersByTime(2)
    expect(useToastStore.getState().items.length).toBe(0)
  })

  test('toastError has 5s ttl (errors deserve more reading time)', () => {
    toastError('boom')
    vi.advanceTimersByTime(3000)
    expect(useToastStore.getState().items.length).toBe(1)
    vi.advanceTimersByTime(2001)
    expect(useToastStore.getState().items.length).toBe(0)
  })

  test('explicit ttlMs:0 makes toast sticky (no auto-dismiss)', () => {
    useToastStore.getState().push({ title: 'sticky', ttlMs: 0 })
    vi.advanceTimersByTime(60_000)
    expect(useToastStore.getState().items.length).toBe(1)
  })

  test('progress field makes toast sticky regardless of ttlMs', () => {
    const id = useToastStore.getState().push({ title: 'uploading', progress: 0 })
    vi.advanceTimersByTime(10_000)
    expect(useToastStore.getState().items.find((t) => t.id === id)).toBeTruthy()
  })

  test('beyond MAX_VISIBLE oldest gets demoted (drop from queue)', () => {
    for (let i = 0; i < MAX_VISIBLE + 3; i++) toastInfo(`t${i}`)
    expect(useToastStore.getState().items.length).toBe(MAX_VISIBLE)
    // Oldest dropped, newest at the tail.
    expect(useToastStore.getState().items[MAX_VISIBLE - 1].title).toBe(`t${MAX_VISIBLE + 2}`)
  })

  test('over-cap demotion exempts a sticky progress toast (drops oldest regular instead)', () => {
    const store = useToastStore.getState()
    // An in-flight long-task progress toast (sticky), then a burst of regular
    // toasts that pushes the queue past MAX_VISIBLE.
    const progressId = store.push({ title: 'resync', progress: 0, ttlMs: 0 })
    for (let i = 0; i < MAX_VISIBLE; i++) store.push({ title: `n${i}` })
    const items = useToastStore.getState().items
    expect(items.length).toBe(MAX_VISIBLE)
    // The progress toast survived; the oldest REGULAR toast (n0) was dropped.
    expect(items.some((t) => t.id === progressId)).toBe(true)
    expect(items.some((t) => t.title === 'n0')).toBe(false)
    expect(items.some((t) => t.title === 'n1')).toBe(true)
  })

  test('over-cap with all-progress toasts falls back to dropping the oldest', () => {
    const store = useToastStore.getState()
    const ids = Array.from({ length: MAX_VISIBLE + 1 }, (_, i) =>
      store.push({ title: `p${i}`, progress: 0, ttlMs: 0 })
    )
    const items = useToastStore.getState().items
    expect(items.length).toBe(MAX_VISIBLE)
    // No non-progress toast to drop → oldest progress (ids[0]) is dropped.
    expect(items.some((t) => t.id === ids[0])).toBe(false)
    expect(items.some((t) => t.id === ids[MAX_VISIBLE])).toBe(true)
  })
})

describe('toast store — setProgress / dismiss / clear', () => {
  test('setProgress clamps to [0,1]', () => {
    const id = useToastStore.getState().push({ title: 'x', progress: 0 })
    useToastStore.getState().setProgress(id, 0.42)
    expect(useToastStore.getState().items[0].progress).toBeCloseTo(0.42, 6)
    useToastStore.getState().setProgress(id, -1)
    expect(useToastStore.getState().items[0].progress).toBe(0)
    useToastStore.getState().setProgress(id, 2)
    expect(useToastStore.getState().items[0].progress).toBe(1)
    useToastStore.getState().setProgress(id, NaN)
    expect(useToastStore.getState().items[0].progress).toBe(0)
  })

  test('dismiss removes the targeted id and leaves siblings alone', () => {
    const a = toastSuccess('a')
    const b = toastError('b')
    useToastStore.getState().dismiss(a)
    expect(useToastStore.getState().items.map((t) => t.id)).toEqual([b])
  })

  test('clear empties the queue', () => {
    toastSuccess('a')
    toastError('b')
    useToastStore.getState().clear()
    expect(useToastStore.getState().items).toEqual([])
  })

  // Sprint 6 Day 1 (opus LOW carry-forward) — dismiss() now clears the
  // auto-dismiss timer alongside removing the item, so a stale timer
  // closure can't re-fire dismiss on a recycled id.
  test('dismiss() cancels the pending auto-dismiss timer', () => {
    const a = toastSuccess('a')
    // Manually dismiss before the 3s TTL would fire.
    useToastStore.getState().dismiss(a)
    expect(useToastStore.getState().items.length).toBe(0)
    // Advance past the original TTL — the closure should be cleared, so
    // re-pushing a fresh toast (which would get the same id only if the
    // counter resets) MUST NOT be silently dismissed by a leftover timer.
    vi.advanceTimersByTime(5000)
    // No state change after the timer would have fired.
    expect(useToastStore.getState().items.length).toBe(0)
    const b = toastSuccess('b')
    vi.advanceTimersByTime(100)
    // The fresh toast is still visible — it's only 100ms in, well under
    // its own 3s TTL.
    expect(useToastStore.getState().items.find((t) => t.id === b)).toBeTruthy()
  })

  test('clear() cancels all pending timers (no stale dismiss after re-push)', () => {
    toastSuccess('a')
    toastSuccess('b')
    useToastStore.getState().clear()
    expect(useToastStore.getState().items.length).toBe(0)
    // Push a fresh toast — advance past where the OLD timers would have
    // fired; the new toast must still be on screen.
    const c = toastSuccess('c')
    vi.advanceTimersByTime(2999)
    expect(useToastStore.getState().items.find((t) => t.id === c)).toBeTruthy()
  })
})

describe('toast store — variants', () => {
  test('toastSuccess defaults variant=success', () => {
    toastSuccess('ok')
    expect(useToastStore.getState().items[0].variant).toBe('success')
  })

  test('toastError defaults variant=error', () => {
    toastError('boom')
    expect(useToastStore.getState().items[0].variant).toBe('error')
  })

  test('toastInfo defaults variant=info', () => {
    toastInfo('fyi')
    expect(useToastStore.getState().items[0].variant).toBe('info')
  })

  test('detail line passes through verbatim', () => {
    toastError('Failed', 'E_AUTH · please configure key')
    expect(useToastStore.getState().items[0].detail).toBe('E_AUTH · please configure key')
  })
})
