// Matters MVP P3 (lane ③) — the write-receipt undo runner (D9).
//
// 🔴 The undo is a renderer-direct REST call: no LLM in the loop, no new chat message. The model
// proposed the write and the user approved it once; asking the model to "undo it" would re-enter
// the same fallible loop, and the reverse operation is already fully described by the descriptor
// the write returned. So the receipt button executes it verbatim (fresh idempotency key,
// source='desktop_ui', reason=撤销, carrying expected_version + reverses_event_id from the
// descriptor so the reversal is optimistic-concurrency safe AND lands on the timeline).
//
// A stale `expected_version` (someone changed the matter after the write) surfaces as
// E_VERSION_CONFLICT and is reported as such rather than retried — "there were later changes" is
// exactly when a blind undo is the wrong thing to do.

import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { MatterUndoDescriptor } from '@shared/api/matters'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useMatterChatApi } from './hooks'
import type { MatterUndoState } from './matterChatContext'

/** D9 — the audit `reason` recorded on the reversing mutation. Frozen wording, never rendered. */
export const MATTER_UNDO_REASON = '撤销'

export interface MatterUndoRunner {
  undoStates: Readonly<Record<string, MatterUndoState>>
  runUndo(toolCallId: string, descriptor: MatterUndoDescriptor): void
  /** Drop every card's undo state (a fresh conversation must not inherit the previous one's). */
  resetUndoStates(): void
}

export function useMatterUndoRunner(publicId: string): MatterUndoRunner {
  const { t } = useTranslation()
  const chatApi = useMatterChatApi()
  const queryClient = useQueryClient()
  const [undoStates, setUndoStates] = useState<Record<string, MatterUndoState>>({})

  const runUndo = useCallback(
    (toolCallId: string, descriptor: MatterUndoDescriptor): void => {
      let started = false
      setUndoStates((current) => {
        const state = current[toolCallId] ?? 'idle'
        if (state !== 'idle') return current
        started = true
        return { ...current, [toolCallId]: 'busy' }
      })
      // A double click while the first call is in flight must not fire a second reversal (each
      // carries its own idempotency key, so the server would happily apply it twice).
      if (!started) return
      void chatApi
        .applyUndo(descriptor, { reason: MATTER_UNDO_REASON })
        .then(async () => {
          setUndoStates((current) => ({ ...current, [toolCallId]: 'done' }))
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: qk.matters.list() }),
            queryClient.invalidateQueries({ queryKey: qk.matters.detail(publicId) })
          ])
        })
        .catch((error: unknown) => {
          setUndoStates((current) => ({ ...current, [toolCallId]: 'idle' }))
          if ((error as { code?: string } | null)?.code === 'E_VERSION_CONFLICT') {
            toastError(t('matters.chat.undo.conflict'))
            return
          }
          toastError(t('matters.chat.undo.failed'), errorMessage(error))
        })
    },
    [chatApi, publicId, queryClient, t]
  )

  const resetUndoStates = useCallback(() => setUndoStates({}), [])

  return { undoStates, runUndo, resetUndoStates }
}
