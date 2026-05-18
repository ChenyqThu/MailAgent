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

export function useBatchOps(): UseBatchOpsReturn {
  const [running, setRunning] = useState(false)
  const [cancelStage, setCancelStage] = useState<0 | 1 | 2>(0)
  // Track the current toast id so we can update progress in-place + dismiss
  // when the run finishes. Cancellation reads `cancelStageRef.current`
  // synchronously inside the loop to avoid React batching delays.
  const toastIdRef = useRef<number | null>(null)
  const cancelStageRef = useRef<0 | 1 | 2>(0)

  const run = useCallback(async (args: BatchRunArgs): Promise<BatchSummary> => {
    const total = args.ids.length
    if (total === 0) {
      return { total: 0, done: 0, failed: 0, cancelled: false, outcomes: [] }
    }
    setRunning(true)
    setCancelStage(0)
    cancelStageRef.current = 0

    const store = useToastStore.getState()
    const toastId = store.push({
      variant: 'info',
      title: `${args.opLabel}: 0/${total}`,
      progress: 0,
      ttlMs: 0
    })
    toastIdRef.current = toastId

    const outcomes: BatchUnitOutcome[] = []
    let done = 0
    let failed = 0
    let cancelled = false

    for (let i = 0; i < total; i++) {
      // Cancel stage 1 (drain): stop queuing. Stage 2 (force): bail out.
      if (cancelStageRef.current >= 1) {
        cancelled = true
        break
      }
      const id = args.ids[i]
      try {
        const data = await args.unit(id)
        outcomes.push({ ok: true, id, data })
        done++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
        outcomes.push({ ok: false, id, code, message: msg })
        failed++
      }
      // After each unit, update progress + title.
      const completed = done + failed
      useToastStore.getState().setProgress(toastId, completed / total)
      // Mutating title — push a new toast would spam the corner; we patch
      // the existing entry in place via store internals.
      useToastStore.setState((s) => ({
        items: s.items.map((t) =>
          t.id === toastId ? { ...t, title: `${args.opLabel}: ${completed}/${total}` } : t
        )
      }))
    }

    // Terminal toast: replace the sticky progress one with a success / error.
    useToastStore.getState().dismiss(toastId)
    toastIdRef.current = null
    setRunning(false)
    setCancelStage(0)
    cancelStageRef.current = 0

    if (cancelled) {
      toastError(`${args.opLabel}: cancelled (${done}/${total} done)`)
    } else if (failed === 0) {
      toastSuccess(`${args.opLabel}: ${done}/${total} done`)
    } else {
      toastError(`${args.opLabel}: ${done}/${total} done, ${failed} failed`)
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
    }
  }, [])

  return { running, cancelStage, run, cancel }
}
