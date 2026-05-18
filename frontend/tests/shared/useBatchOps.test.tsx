// @vitest-environment happy-dom
//
// Sprint 5 §2.2 — batch op runner contract.
//
// Verifies:
//   - run() resolves with summary { total, done, failed, cancelled }
//   - per-unit successes / failures are tracked separately
//   - progress toast updates after each unit
//   - cancel() stops queuing new units (cancelled=true in summary)
//   - terminal toast variant depends on outcome (success / partial / cancelled)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import i18n from '@shared/i18n'
import { __resetToastStore, useToastStore } from '../../src/shared/state/toast'
import { useBatchOps } from '../../src/shared/hooks/useBatchOps'

// Sprint 5 ship-review: useBatchOps now resolves terminal toast strings
// through i18n. Pin the locale here so the snapshot assertion below is
// deterministic (en-US is the test default).
await i18n.changeLanguage('en-US')

beforeEach(() => {
  __resetToastStore()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBatchOps — run', () => {
  test('happy path: all units succeed, summary reflects total/done', async () => {
    const unit = vi.fn().mockResolvedValue('ok')
    const { result } = renderHook(() => useBatchOps())

    let summary!: Awaited<ReturnType<typeof result.current.run>>
    await act(async () => {
      summary = await result.current.run({
        ids: [1, 2, 3],
        opLabel: 'AI 批量分类',
        unit
      })
    })

    expect(summary.total).toBe(3)
    expect(summary.done).toBe(3)
    expect(summary.failed).toBe(0)
    expect(summary.cancelled).toBe(false)
    expect(unit).toHaveBeenCalledTimes(3)
    expect(unit).toHaveBeenNthCalledWith(1, 1)
    expect(unit).toHaveBeenNthCalledWith(2, 2)
    expect(unit).toHaveBeenNthCalledWith(3, 3)
  })

  test('partial failure: failed units accounted for, others continue', async () => {
    const unit = vi
      .fn()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok')
    const { result } = renderHook(() => useBatchOps())

    let summary!: Awaited<ReturnType<typeof result.current.run>>
    await act(async () => {
      summary = await result.current.run({
        ids: [10, 11, 12],
        opLabel: 'resync',
        unit
      })
    })

    expect(summary.done).toBe(2)
    expect(summary.failed).toBe(1)
    const failedOutcome = summary.outcomes.find((o) => !o.ok)
    expect(failedOutcome).toBeTruthy()
    if (failedOutcome && !failedOutcome.ok) {
      expect(failedOutcome.id).toBe(11)
      expect(failedOutcome.message).toBe('boom')
    }
  })

  test('cancel() stops queuing new units (sets cancelled=true)', async () => {
    // First unit gates on a manual resolver — we cancel before it resolves
    // so the second + third never run.
    let resolveFirst: (v: unknown) => void = () => {}
    const unit = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((res) => {
          resolveFirst = res
        })
      )
      .mockResolvedValue('ok')

    const { result } = renderHook(() => useBatchOps())

    let runPromise!: Promise<Awaited<ReturnType<typeof result.current.run>>>
    act(() => {
      runPromise = result.current.run({
        ids: [1, 2, 3],
        opLabel: 'translate',
        unit
      })
    })

    // Cancel BEFORE first unit resolves; let first resolve; loop should
    // exit before pulling id=2.
    await Promise.resolve()
    act(() => {
      result.current.cancel()
    })
    resolveFirst('ok')
    const summary = await runPromise

    expect(unit).toHaveBeenCalledTimes(1)
    expect(summary.cancelled).toBe(true)
    expect(summary.done).toBe(1)
  })

  test('progress toast updates after each unit + cleared on terminal', async () => {
    const unit = vi.fn().mockResolvedValue('ok')
    const { result } = renderHook(() => useBatchOps())

    // Run a small batch and check the FINAL toast state — the in-flight
    // sticky progress toast is dismissed when the loop ends, then a
    // terminal success/partial toast lands. We assert on the terminal.
    await act(async () => {
      await result.current.run({ ids: [1, 2], opLabel: 'translate', unit })
    })
    const items = useToastStore.getState().items
    // The progress toast is dismissed; the terminal "done" toast remains.
    expect(items.length).toBe(1)
    expect(items[0].variant).toBe('success')
    expect(items[0].title).toContain('translate')
    // en-US batchToast.ok = "{op}: {n} done"
    expect(items[0].title).toContain('2')
    expect(items[0].title).toContain('done')
  })

  test('zero ids → no-op summary, no toast', async () => {
    const unit = vi.fn()
    const { result } = renderHook(() => useBatchOps())
    let summary!: Awaited<ReturnType<typeof result.current.run>>
    await act(async () => {
      summary = await result.current.run({ ids: [], opLabel: 'noop', unit })
    })
    expect(summary).toEqual({ total: 0, done: 0, failed: 0, cancelled: false, outcomes: [] })
    expect(unit).not.toHaveBeenCalled()
    expect(useToastStore.getState().items).toEqual([])
  })

  test('cancel state machine: 0 → 1 → 2 (idempotent past 2)', () => {
    const { result } = renderHook(() => useBatchOps())
    expect(result.current.cancelStage).toBe(0)
    act(() => result.current.cancel())
    expect(result.current.cancelStage).toBe(1)
    act(() => result.current.cancel())
    expect(result.current.cancelStage).toBe(2)
    act(() => result.current.cancel())
    expect(result.current.cancelStage).toBe(2)
  })

  // Sprint 6 Day 1 (opus LOW carry-forward) — stage 2 cancel now races the
  // in-flight unit via Promise.race against a force-stop sentinel. The unit
  // promise stays pending forever; the race-loss is what breaks the loop.
  // Without the fix, stage 2 was dead semantic (loop only checked >=1, so
  // the in-flight unit had to settle before the loop noticed).
  test('cancel stage 2 force-stops the in-flight unit (Sprint 6 Day 1)', async () => {
    // Unit never resolves on its own — only force-stop unwedges it.
    const unit = vi.fn().mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useBatchOps())

    let runPromise!: Promise<Awaited<ReturnType<typeof result.current.run>>>
    act(() => {
      runPromise = result.current.run({
        ids: [42, 43, 44],
        opLabel: 'translate',
        unit
      })
    })

    // Let the loop enter iteration 0 and start awaiting unit(42).
    await Promise.resolve()
    await Promise.resolve()

    // First cancel: stage 1 (drain). The in-flight unit is still pending,
    // so the loop is still parked inside Promise.race.
    act(() => {
      result.current.cancel()
    })
    expect(result.current.cancelStage).toBe(1)

    // Second cancel: stage 2 (force). Resolves the race promise so the loop
    // exits without waiting for unit(42) to finish.
    act(() => {
      result.current.cancel()
    })

    const summary = await runPromise
    expect(summary.cancelled).toBe(true)
    expect(summary.done).toBe(0)
    expect(summary.failed).toBe(0)
    // unit(42) was started but only its race partner resolved; unit(43) /
    // unit(44) were never reached.
    expect(unit).toHaveBeenCalledTimes(1)
  })
})
