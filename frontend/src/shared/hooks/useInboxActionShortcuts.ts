// S / U / E inbox action shortcuts (DESIGN.md §9.5). Act on the *currently
// active* email — the same target J/K navigation moves through — so the
// keyboard mirrors what clicking the row's flag / archive button does.
//
//   S → flag 三态 cycle (none → flagged → done → none), identical to
//       EmailRow.handleFlagClick.
//   U → toggle read / unread.
//   E → archive (= flagged→done 终态), identical to EmailRow.handleDeleteClick.
//
// Wired to the same `mailApi.email.flag(...)` SSoT-inversion path + the same
// optimistic-patch-then-rollback-on-error semantics as EmailRow, so click and
// keyboard stay behavior-identical. Listens at the document level (works
// whether or not the list has focus), mirroring useEmailKeyboardNav.
//
// Skip rules (same as useEmailKeyboardNav): typing in an <input>/<textarea>/
// contenteditable, or any modifier key held (preserves ⌘S etc. + lets the user
// type 's'/'u'/'e' into search) → don't hijack.

import { useEffect } from 'react'

import { useQueryClient } from '@tanstack/react-query'

import type { EmailFlagOpts, EnrichedEmailMeta } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'

import { useActiveEmail } from '../state/active-email'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export function useInboxActionShortcuts(): void {
  const queryClient = useQueryClient()
  const mailApi = useMailApi()

  useEffect(() => {
    function findActive(): EnrichedEmailMeta | null {
      const id = useActiveEmail.getState().activeInternalId
      if (id == null) return null
      // ['emails', mailbox, view, …] — find the row across every cached list.
      const entries = queryClient.getQueriesData<EnrichedEmailMeta[]>({ queryKey: qk.emails.all() })
      for (const [, data] of entries) {
        if (!Array.isArray(data)) continue
        const hit = data.find((e) => e.internal_id === id)
        if (hit) return hit
      }
      return null
    }

    function patchCache(id: number, patch: Partial<EnrichedEmailMeta>): void {
      queryClient.setQueriesData<EnrichedEmailMeta[]>({ queryKey: qk.emails.all() }, (old) =>
        Array.isArray(old) ? old.map((e) => (e.internal_id === id ? { ...e, ...patch } : e)) : old
      )
    }

    async function run(
      id: number,
      patch: Partial<EnrichedEmailMeta>,
      opts: EmailFlagOpts,
      failMsg: string
    ): Promise<void> {
      patchCache(id, patch) // optimistic — UI 瞬时翻
      try {
        await mailApi.email.flag(id, opts)
        // 成功: CLI 已写 SQLite, EmailList 的 poll 会拉一致 state. 不主动 invalidate
        // 避免双重渲染; 失败时才回放真值 (与 EmailRow 一致)。
      } catch (err) {
        await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
        toastError(failMsg, errorMessage(err))
      }
    }

    function onKeyDown(evt: KeyboardEvent): void {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return
      if (isEditableTarget(evt.target)) return
      const key = evt.key.toLowerCase()
      if (key !== 's' && key !== 'u' && key !== 'e') return

      const email = findActive()
      if (!email) return
      evt.preventDefault()
      const id = email.internal_id

      if (key === 'u') {
        const next = !email.is_read
        void run(id, { is_read: next }, { isRead: next }, 'Toggle read failed')
        return
      }

      if (key === 'e') {
        void run(
          id,
          { is_flagged: false, processing_status: '已完成' },
          { isFlagged: false, processingStatus: '已完成' },
          'Archive failed'
        )
        return
      }

      // key === 's' — flag 三态 cycle, identical derivation to EmailRow.
      const isDone = email.processing_status === '已完成'
      const isFlagged = email.is_flagged && !isDone
      const flagState: '0' | '1' | '2' = isDone ? '2' : isFlagged ? '1' : '0'
      let patch: Partial<EnrichedEmailMeta>
      let opts: EmailFlagOpts
      if (flagState === '0') {
        patch = { is_flagged: true }
        opts = { isFlagged: true }
      } else if (flagState === '1') {
        patch = { is_flagged: false, processing_status: '已完成' }
        opts = { isFlagged: false, processingStatus: '已完成' }
      } else {
        patch = { is_flagged: false, processing_status: '已同步' }
        opts = { isFlagged: false, processingStatus: '已同步' }
      }
      void run(id, patch, opts, 'Flag toggle failed')
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [queryClient, mailApi])
}
