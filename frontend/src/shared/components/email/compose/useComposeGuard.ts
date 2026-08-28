// Compose leave-guard — Bug C / contract D3 (T6). Stops unsaved compose edits
// from being silently dropped when the composer closes (ESC / 丢弃 / 切邮件 /
// 新邮件浮窗 scrim·×). Dirty tracking lives in ComposePanelInner (baseline =
// after prefill completes, so pre-fill setContent never marks dirty — the
// 6-month regression this epic explicitly guards against); this hook owns the
// confirm-dialog state machine + the "run after the user decides" plumbing.
//
//   guardClose(proceed):   dirty → open UnsavedChangesDialog, stash `proceed`.
//                          clean → run `proceed` right away (no dialog).
//   onSaveDraft:           await saveDraft(); success → run proceed; failure →
//                          keep the composer + its content (the save mutation
//                          already surfaced the error toast), just drop dialog +
//                          notify `onAbort` (the close intent is off).
//   onDiscard:             run proceed (drop edits).
//   onCancel:              forget the pending proceed, stay in the composer,
//                          notify `onAbort`.
//
// `onAbort` (dogfood 波3): tab-close requests parked in the bridge must be
// cleared when the user backs out, or ⌘W goes permanently mute — the optional
// second argument of attemptClose is that notifier.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Imperative handle a parent uses to route an *external* close (新邮件浮窗的
 *  scrim/× · 标签关闭守卫) through the same guard the composer's own ESC /
 *  丢弃 paths use. Kept ref-stable so wiring it into a parent ref is cheap. */
export interface ComposeGuardHandle {
  isDirty: () => boolean
  attemptClose: (proceed: () => void, onAbort?: () => void) => void
}

interface UseComposeGuardArgs {
  dirty: boolean
  /** Persist the current form as a draft. Resolves on success, rejects on
   *  failure (caller's mutation owns the error toast). */
  saveDraft: () => Promise<unknown>
}

export interface ComposeGuard {
  /** Guarded close: prompt when dirty, else run `proceed` now. */
  guardClose: (proceed: () => void) => void
  /** Stable imperative handle for parent-initiated closes. */
  handle: ComposeGuardHandle
  /** UnsavedChangesDialog visibility. */
  unsavedOpen: boolean
  /** save-draft-then-proceed in flight. */
  saving: boolean
  onSaveDraft: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function useComposeGuard({ dirty, saveDraft }: UseComposeGuardArgs): ComposeGuard {
  const [unsavedOpen, setUnsavedOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const proceedRef = useRef<(() => void) | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  // Latest dirty / saveDraft in refs so guardClose + the imperative handle stay
  // reference-stable (parents capture the handle once) yet still read the current
  // values. Refs are written in an effect — writing them during render violates
  // react-hooks/refs; the effect runs on commit, before any close-event fires.
  const dirtyRef = useRef(dirty)
  const saveDraftRef = useRef(saveDraft)
  useEffect(() => {
    dirtyRef.current = dirty
    saveDraftRef.current = saveDraft
  })

  const attemptClose = useCallback((proceed: () => void, onAbort?: () => void): void => {
    if (!dirtyRef.current) {
      proceed()
      return
    }
    proceedRef.current = proceed
    abortRef.current = onAbort ?? null
    setUnsavedOpen(true)
  }, [])

  const guardClose = useCallback(
    (proceed: () => void): void => attemptClose(proceed),
    [attemptClose]
  )

  const runProceed = useCallback((): void => {
    const proceed = proceedRef.current
    proceedRef.current = null
    abortRef.current = null
    setUnsavedOpen(false)
    proceed?.()
  }, [])

  // 用户退出关闭意图（取消 / 保存失败留守）→ 通知发起方收回请求。
  const runAbort = useCallback((): void => {
    const abort = abortRef.current
    proceedRef.current = null
    abortRef.current = null
    setUnsavedOpen(false)
    abort?.()
  }, [])

  const onDiscard = useCallback((): void => {
    runProceed()
  }, [runProceed])

  const onSaveDraft = useCallback((): void => {
    setSaving(true)
    saveDraftRef
      .current()
      .then(() => {
        runProceed()
      })
      .catch(() => {
        // Save failed — mutation already toasted. Keep the composer + content
        // so the user can retry; drop the dialog + abort the close intent.
        runAbort()
      })
      .finally(() => {
        setSaving(false)
      })
  }, [runProceed, runAbort])

  const onCancel = useCallback((): void => {
    runAbort()
  }, [runAbort])

  const isDirty = useCallback((): boolean => dirtyRef.current, [])
  const handle = useMemo<ComposeGuardHandle>(
    () => ({ isDirty, attemptClose }),
    [isDirty, attemptClose]
  )

  return { guardClose, handle, unsavedOpen, saving, onSaveDraft, onDiscard, onCancel }
}
