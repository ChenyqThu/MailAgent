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
