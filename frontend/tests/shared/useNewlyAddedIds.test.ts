// @vitest-environment happy-dom
//
// issue #33 — the inbox "new email" badge regressions:
//   Bug B: a single shared fade timer was cancelled every time the effect
//          re-ran (the polled `current` array changes reference constantly),
//          so once flagged an id never faded → badges stuck forever.
//   Bug A: no per-view baseline, so switching inbox → outbox → inbox diffed
//          the previous view's ids against the new view's first page and
//          flashed the WHOLE screen as "new".
//
// These tests pin the fixed behavior: per-id timers survive re-renders, and a
// `viewKey` change re-baselines without emitting "new" markers.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useNewlyAddedIds } from '../../src/shared/hooks/useNewlyAddedIds'

const FADE = 2000

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function render(initial: number[], viewKey = 'inbox') {
  return renderHook(
    ({ current, viewKey }: { current: number[]; viewKey: string }) =>
      useNewlyAddedIds(current, viewKey, FADE),
    { initialProps: { current: initial, viewKey } }
  )
}

describe('useNewlyAddedIds', () => {
  test('first load marks nothing new', () => {
    const { result } = render([1, 2, 3])
    expect([...result.current]).toEqual([])
  })

  test('a newly added id is flagged, then fades after fadeMs', () => {
    const { result, rerender } = render([1, 2, 3])
    rerender({ current: [4, 1, 2, 3], viewKey: 'inbox' })
    expect(result.current.has(4)).toBe(true)
    act(() => vi.advanceTimersByTime(FADE))
    expect(result.current.has(4)).toBe(false)
  })

  // Bug B regression: the fade must survive `current` churning its reference
  // (background poll / SSE) before the timer elapses.
  test('fade still fires when current re-renders before the timer elapses', () => {
    const { result, rerender } = render([1, 2])
    rerender({ current: [3, 1, 2], viewKey: 'inbox' })
    expect(result.current.has(3)).toBe(true)

    act(() => vi.advanceTimersByTime(FADE / 2))
    // Same ids, brand-new array references — this is what killed the fade
    // before the fix (each re-run's cleanup cancelled the pending timer).
    rerender({ current: [3, 1, 2], viewKey: 'inbox' })
    rerender({ current: [3, 1, 2], viewKey: 'inbox' })
    expect(result.current.has(3)).toBe(true)

    act(() => vi.advanceTimersByTime(FADE / 2 + 1))
    expect(result.current.has(3)).toBe(false)
  })

  // Bug A regression: switching view re-baselines; the new view's first page
  // is NOT flagged, but a genuine later arrival within the view still is.
  test('a view switch does not flash the new view as newly added', () => {
    const { result, rerender } = render([1, 2, 3], 'inbox')
    rerender({ current: [90, 91, 92], viewKey: 'outbox' })
    expect([...result.current]).toEqual([])

    rerender({ current: [93, 90, 91, 92], viewKey: 'outbox' })
    expect(result.current.has(93)).toBe(true)
  })

  // codex MED — an active badge from view A must NOT leak into view B when the
  // same id is visible there; the view switch clears active badges + pending
  // timers rather than letting them linger until the old timer fires.
  test('a view switch clears active badges from the previous view', () => {
    const { result, rerender } = render([1, 2], 'inbox')
    // id 3 arrives in inbox → active badge + pending fade timer.
    rerender({ current: [3, 1, 2], viewKey: 'inbox' })
    expect(result.current.has(3)).toBe(true)
    // switch to a view where id 3 is also visible: badge must be cleared now,
    // not carried over as a cross-view NEW marker.
    rerender({ current: [3, 4, 5], viewKey: 'flagged' })
    expect([...result.current]).toEqual([])
    // the previous view's timer firing later must not resurrect anything.
    act(() => vi.advanceTimersByTime(FADE))
    expect([...result.current]).toEqual([])
  })

  // Per-id timers are independent: staggered arrivals fade on their own clocks.
  test('staggered ids fade independently', () => {
    const { result, rerender } = render([1], 'inbox')
    rerender({ current: [2, 1], viewKey: 'inbox' })
    act(() => vi.advanceTimersByTime(FADE / 2))
    rerender({ current: [3, 2, 1], viewKey: 'inbox' })
    expect(result.current.has(2)).toBe(true)
    expect(result.current.has(3)).toBe(true)

    act(() => vi.advanceTimersByTime(FADE / 2 + 1)) // id 2 reaches fadeMs
    expect(result.current.has(2)).toBe(false)
    expect(result.current.has(3)).toBe(true)

    act(() => vi.advanceTimersByTime(FADE / 2)) // id 3 reaches fadeMs
    expect(result.current.has(3)).toBe(false)
  })
})
