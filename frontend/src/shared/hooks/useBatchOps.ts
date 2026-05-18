// Sprint 5 §2.2 — Batch operation runner.
//
// Sequential loop over selectedIds invoking a per-id IPC. Surfaces progress
// into a sticky toast (BatchActionBar reads it from the same store). The
// CLI's own long-task contract owns checkpoint resume + max-failures; this
// hook is the renderer-side queue + cancel + UI sink.
//
// Cancellation policy mirrors backend RFC §5.2:
//   - First cancel  → stop queuing new units. The in-flight CLI keeps
//                     running to completion; the user sees the toast freeze
//                     at the current done count.
//   - Second cancel → tell the IPC adapter to drop the reply (renderer-side
//                     abort; the CLI subprocess still completes server-side
//                     but the result no longer mutates UI state).
//
// We deliberately do NOT abort the CLI subprocess from the renderer — the
// CLI has its own checkpoint+resume contract and a kill could half-write.
// Sprint 6 SettingsPage may expose a "kill all CLI workers" admin button.

import { useCallback, useRef, useState } from 'react'

import i18n from '@shared/i18n'
import { toastError, toastSuccess, useToastStore } from '@shared/state/toast'

export type BatchUnitOutcome =
  | { ok: true; id: number; data: unknown }
  | { ok: false; id: number; code?: string; message: string }

export interface BatchSummary {
  total: number
  done: number
  failed: number
  cancelled: boolean
  outcomes: BatchUnitOutcome[]
}

export interface BatchRunArgs {
  ids: ReadonlyArray<number>
  /** Human label rendered in the toast progress line — "AI 批量分类" etc. */
  opLabel: string
  /** Per-unit executor. Resolve = success, reject = unit failure. */
  unit: (id: number) => Promise<unknown>
}

export interface UseBatchOpsReturn {
  running: boolean
  /** First cancel sets to true (drains the queue); second cancel sets force. */
  cancelStage: 0 | 1 | 2
  run(args: BatchRunArgs): Promise<BatchSummary>
  cancel(): void
}

// Sprint 6 Day 1 (opus LOW carry-forward) — force-stop sentinel. Stage 2
// cancel resolves the in-flight unit's race promise with this constant so
// the loop knows to break without awaiting the still-running unit. We do
// NOT kill the CLI subprocess from the renderer (the CLI owns its own
// checkpoint+resume contract); we just stop letting it mutate UI state.
const FORCE_STOP = Symbol('force-stop')

export function useBatchOps(): UseBatchOpsReturn {
  const [running, setRunning] = useState(false)
  const [cancelStage, setCancelStage] = useState<0 | 1 | 2>(0)
  // Track the current toast id so we can update progress in-place + dismiss
  // when the run finishes. Cancellation reads `cancelStageRef.current`
  // synchronously inside the loop to avoid React batching delays.
  const toastIdRef = useRef<number | null>(null)
  const cancelStageRef = useRef<0 | 1 | 2>(0)
  // Sprint 6 Day 1 — populated for each iteration of the run loop; cancel()
  // calls this to make the in-flight unit lose Promise.race. Cleared after
  // each unit settles so a stale resolver from the prior iteration can't
  // accidentally fire on the next one.
  const forceStopResolverRef = useRef<(() => void) | null>(null)

  const run = useCallback(async (args: BatchRunArgs): Promise<BatchSummary> => {
    const total = args.ids.length
    if (total === 0) {
      return { total: 0, done: 0, failed: 0, cancelled: false, outcomes: [] }
    }
    setRunning(true)
    setCancelStage(0)
    cancelStageRef.current = 0

    const store = useToastStore.getState()
    // Sprint 7 review (opus MEDIUM) — route initial title through i18n so the
    // separator ("批量分类: 3/10" vs "AI Classify: 3/10" vs Arabic RTL) lives
    // in the locale files. Same i18n key the per-unit progress patch uses
    // below so the format stays consistent across the toast's lifetime.
    const toastId = store.push({
      variant: 'info',
      title: i18n.t('batchToast.running', { op: args.opLabel, done: 0, total }),
      progress: 0,
      ttlMs: 0
    })
    toastIdRef.current = toastId

    const outcomes: BatchUnitOutcome[] = []
    let done = 0
    let failed = 0
    let cancelled = false

    type UnitResult = { ok: true; data: unknown } | { ok: false; err: unknown }

    for (let i = 0; i < total; i++) {
      // Cancel stage 1 (drain): stop queuing. Stage 2 also breaks here on
      // the iteration AFTER force-stop landed (the in-flight unit already
      // race-lost below).
      if (cancelStageRef.current >= 1) {
        cancelled = true
        break
      }
      const id = args.ids[i]

      // Sprint 6 Day 1 — wire stage 2 force-stop via Promise.race. The
      // forceStopPromise resolves only when cancel() is called from stage 1
      // (i.e. the second cancel press). Race-losing leaves the CLI
      // subprocess running server-side, but the renderer stops waiting.
      const forceStopPromise = new Promise<typeof FORCE_STOP>((res) => {
        forceStopResolverRef.current = (): void => res(FORCE_STOP)
      })
      // Sprint 7 Day 1 (Sprint 6 review opus MEDIUM #3 carry-forward) — the
      // .catch on `unitPromise` is INTENTIONAL: it short-circuits a unit
      // rejection into a typed `{ ok: false, err }` so the Promise.race below
      // never observes an unhandled rejection. When force-stop wins the race,
      // `unitPromise` keeps running in the background and its catch handler
      // produces a `UnitResult` we then drop on the floor. That's by contract
      // — the CLI subprocess server-side keeps its own checkpoint/resume
      // ledger; the renderer's only job is to stop blocking the loop. The
      // dropped object is GC'd once the catch resolves, no leak.
      const unitPromise: Promise<UnitResult> = args
        .unit(id)
        .then((data): UnitResult => ({ ok: true, data }))
        .catch((err): UnitResult => ({ ok: false, err }))

      const winner = await Promise.race([unitPromise, forceStopPromise])
      // Clear so a later cancel() press doesn't fire a stale resolver into
      // the next iteration's freshly-installed one.
      forceStopResolverRef.current = null

      if (winner === FORCE_STOP) {
        cancelled = true
        // void-mark the stranded promise so eslint / future readers know
        // we deliberately dropped it (the .catch above keeps node from
        // logging an unhandledRejection).
        void unitPromise
        break
      }
      if (winner.ok) {
        outcomes.push({ ok: true, id, data: winner.data })
        done++
      } else {
        const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
        const code =
          winner.err instanceof Error ? (winner.err as Error & { code?: string }).code : undefined
        outcomes.push({ ok: false, id, code, message: msg })
        failed++
      }
      // After each unit, update progress + title.
      const completed = done + failed
      useToastStore.getState().setProgress(toastId, completed / total)
      // Mutating title — push a new toast would spam the corner; we patch
      // the existing entry in place via store internals. i18n via the same
      // `batchToast.running` key as the initial push for separator parity.
      const nextTitle = i18n.t('batchToast.running', {
        op: args.opLabel,
        done: completed,
        total
      })
      useToastStore.setState((s) => ({
        items: s.items.map((t) => (t.id === toastId ? { ...t, title: nextTitle } : t))
      }))
    }

    // Terminal toast: replace the sticky progress one with a success / error.
    useToastStore.getState().dismiss(toastId)
    toastIdRef.current = null
    forceStopResolverRef.current = null
    setRunning(false)
    setCancelStage(0)
    cancelStageRef.current = 0

    // Sprint 5 ship-review (opus LOW): route terminal strings through i18n
    // so zh-CN locale doesn't end up with "AI 批量分类: 3/3 done" mixed.
    // The hook can't call `useTranslation()` (it's an event-time emit), so
    // we go through the module-level i18n.t.
    if (cancelled) {
      toastError(i18n.t('batchToast.cancelled', { op: args.opLabel, done, total }))
    } else if (failed === 0) {
      toastSuccess(i18n.t('batchToast.ok', { op: args.opLabel, n: done }))
    } else {
      toastError(i18n.t('batchToast.partial', { op: args.opLabel, done, total, failed }))
    }

    return { total, done, failed, cancelled, outcomes }
  }, [])

  const cancel = useCallback(() => {
    // Stage transitions: 0 → 1 → 2. Idempotent past 2.
    if (cancelStageRef.current === 0) {
      cancelStageRef.current = 1
      setCancelStage(1)
    } else if (cancelStageRef.current === 1) {
      cancelStageRef.current = 2
      setCancelStage(2)
      // Sprint 6 Day 1 — wake the in-flight unit's race. The CLI subprocess
      // keeps running server-side; the renderer just drops the result.
      forceStopResolverRef.current?.()
    }
  }, [])

  return { running, cancelStage, run, cancel }
}
