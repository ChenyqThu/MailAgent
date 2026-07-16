// @vitest-environment happy-dom
//
// codex r2 [E] (task 07-15 harness-chat) — useApprovalDecideBusy: the approval-decide busy state is
// SESSION-scoped. The r1 panel-level boolean kept the composer of a freshly-switched-to session
// disabled until the ORIGINAL session's HTTP resume returned (a hung upstream = an indefinite lock
// on a session the server never fenced). Pins:
//   1. busy in session A + A active → disabled; switching to B → immediately enabled.
//   2. switching BACK to A while its decide is still in flight → disabled again (the lease truly
//      is held there); A settling → enabled.
//   3. interleaved decides: A settling never drops B's fence.

import { describe, expect, test } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'

import { useApprovalDecideBusy } from '@shared/assistant/useApprovalDecideBusy'

describe('useApprovalDecideBusy', () => {
  test('switching away unlocks immediately; switching back re-applies the fence; settle clears', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: number | null }) => useApprovalDecideBusy(active),
      { initialProps: { active: 1 as number | null } }
    )
    expect(result.current.sendDisabled).toBe(false)

    // decide starts in session 1 (the active one) → fenced
    act(() => result.current.onDecideBusyChange(true, 1))
    expect(result.current.sendDisabled).toBe(true)

    // switch to session 2 → the NEW session's composer is NOT locked (codex r2 [E])
    rerender({ active: 2 })
    expect(result.current.sendDisabled).toBe(false)

    // switch back to 1 mid-flight → the fence re-applies (the lease is still held there)
    rerender({ active: 1 })
    expect(result.current.sendDisabled).toBe(true)

    // the original request settles on its own → unlocked
    act(() => result.current.onDecideBusyChange(false, 1))
    expect(result.current.sendDisabled).toBe(false)
  })

  test("interleaved decides: A's settle never drops B's fence", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: number | null }) => useApprovalDecideBusy(active),
      { initialProps: { active: 1 as number | null } }
    )
    act(() => result.current.onDecideBusyChange(true, 1)) // decide in A
    rerender({ active: 2 })
    act(() => result.current.onDecideBusyChange(true, 2)) // decide in B while A resumes
    expect(result.current.sendDisabled).toBe(true) // B active + B busy

    act(() => result.current.onDecideBusyChange(false, 1)) // A settles
    expect(result.current.sendDisabled).toBe(true) // B's fence intact

    act(() => result.current.onDecideBusyChange(false, 2)) // B settles
    expect(result.current.sendDisabled).toBe(false)
  })

  test('null session ids are inert (a decide only exists for a persisted session)', () => {
    const { result } = renderHook(() => useApprovalDecideBusy(null))
    act(() => result.current.onDecideBusyChange(true, null))
    expect(result.current.sendDisabled).toBe(false)
  })
})
