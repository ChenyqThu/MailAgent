// Email detail write action handlers (archive / delete / resync / llm / read / flag),
// optimistic list+detail patching, prev/next navigation, and auto-mark-read.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useActiveEmail, pickNext, pickPrev } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { EmailDetail } from '@shared/api/types'

// Sprint 5 §2.2 — single pending bit per write op so toolbar buttons disable independently.
export type PendingMap = {
  resync: boolean
  llmRun: boolean
  read: boolean
  flag: boolean
  archive: boolean
  delete: boolean
}

const NO_PENDING: PendingMap = {
  resync: false,
  llmRun: false,
  read: false,
  flag: false,
  archive: false,
  delete: false
}

interface UseEmailDetailActionsOpts {
  internalId: number | null
  detailData: EmailDetail | null | undefined
}

export interface EmailDetailActionsController {
  pending: PendingMap
  setActive: ReturnType<typeof useActiveEmail.getState>['setActive']
  onPrev: (() => void) | undefined
  onNext: (() => void) | undefined
  handleArchive: () => Promise<void>
  handleDelete: () => Promise<void>
  handleResync: (opts: { dryRun: boolean }) => Promise<void>
  handleLlmRun: () => Promise<void>
  handleToggleRead: (currentIsRead: boolean) => Promise<void>
  handleToggleFlag: (currentIsFlagged: boolean) => Promise<void>
}

/** Owns detail toolbar mutations, prev/next email stepping, and auto-mark-read. */
export function useEmailDetailActions({
  internalId,
  detailData
}: UseEmailDetailActionsOpts): EmailDetailActionsController {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()

  const [pending, setPending] = useState<PendingMap>(NO_PENDING)
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)

  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setPending(NO_PENDING)
  }

  // Toolbar prev/next — shares list order with J/K; replaces active tab target in-place.
  const orderedIds = useActiveEmail((s) => s.orderedIds)
  const setActive = useActiveEmail((s) => s.setActive)
  const prevId = pickPrev(orderedIds, internalId)
  const nextId = pickNext(orderedIds, internalId)
  const onPrev =
    prevId !== null && prevId !== internalId
      ? () => setActive(prevId, { mode: 'replace' })
      : undefined
  const onNext =
    nextId !== null && nextId !== internalId
      ? () => setActive(nextId, { mode: 'replace' })
      : undefined

  // Optimistic UI patch across detail cache + ['emails'] list caches.
  const optimisticDetail = useCallback(
    (patch: Record<string, unknown>) => {
      if (internalId === null) return
      queryClient.setQueryData(qk.email.detail(internalId), (old: unknown) =>
        old && typeof old === 'object' ? { ...(old as object), ...patch } : old
      )
      queryClient.setQueriesData({ queryKey: qk.emails.all() }, (old: unknown) => {
        if (!Array.isArray(old)) return old
        return old.map((e) =>
          e && typeof e === 'object' && (e as { internal_id?: number }).internal_id === internalId
            ? { ...(e as object), ...patch }
            : e
        )
      })
    },
    [internalId, queryClient]
  )

  const handleArchive = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    const archivingId = internalId
    setPending((p) => ({ ...p, archive: true }))
    try {
      await mailApi.email.archive(archivingId)
      toastSuccess(t('toolbarToast.archiveOk'))
      // 归档后自动续选 = 原位换目标（replace），不开新标签。
      if (nextId !== null && nextId !== archivingId) setActive(nextId, { mode: 'replace' })
      else if (prevId !== null && prevId !== archivingId) setActive(prevId, { mode: 'replace' })
      await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
      await queryClient.invalidateQueries({ queryKey: qk.email.detail(archivingId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.archiveFail'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, archive: false }))
    }
  }, [internalId, mailApi, queryClient, t, nextId, prevId, setActive])

  // 删除（收件箱语义 = flag→done 归档完成, 非物理删除; 草稿在 EmailDetail 已走 compose 编辑态不到这里）。
  const handleDelete = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    const deletingId = internalId
    setPending((p) => ({ ...p, delete: true }))
    try {
      await mailApi.email.flag(deletingId, { isFlagged: false, processingStatus: '已完成' })
      toastSuccess(t('toolbarToast.deleteOk', { defaultValue: '已删除（归档完成）' }))
      if (nextId !== null && nextId !== deletingId) setActive(nextId, { mode: 'replace' })
      else if (prevId !== null && prevId !== deletingId) setActive(prevId, { mode: 'replace' })
      await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
      await queryClient.invalidateQueries({ queryKey: qk.email.detail(deletingId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(
        t('toolbarToast.deleteFail', { defaultValue: '删除失败' }),
        e.code ? `${e.code} · ${e.message}` : e.message
      )
    } finally {
      setPending((p) => ({ ...p, delete: false }))
    }
  }, [internalId, mailApi, queryClient, t, nextId, prevId, setActive])

  const handleResync = useCallback(
    async ({ dryRun }: { dryRun: boolean }): Promise<void> => {
      if (internalId === null) return
      setPending((p) => ({ ...p, resync: true }))
      try {
        await mailApi.email.resync(internalId, { dryRun, replaceExisting: !dryRun })
        toastSuccess(t(dryRun ? 'toolbarToast.resyncOkDry' : 'toolbarToast.resyncOk'))
        if (!dryRun) {
          await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
          await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
        }
      } catch (err) {
        const e = asWriteError(err)
        const key =
          e.code === 'E_AUTH_FAILED'
            ? 'toolbarToast.resyncFailAuth'
            : e.code === 'E_PM2_RUNNING' || e.code === 'E_PM2_CONFLICT'
              ? 'toolbarToast.resyncFailPm2'
              : 'toolbarToast.resyncFailGeneric'
        toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
      } finally {
        setPending((p) => ({ ...p, resync: false }))
      }
    },
    [internalId, mailApi, queryClient, t]
  )

  const handleLlmRun = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    setPending((p) => ({ ...p, llmRun: true }))
    try {
      await mailApi.llm.run(internalId, { force: true })
      toastSuccess(t('toolbarToast.llmOk'))
      await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.llmFailGeneric'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, llmRun: false }))
    }
  }, [internalId, mailApi, queryClient, t])

  const handleToggleRead = useCallback(
    async (currentIsRead: boolean): Promise<void> => {
      if (internalId === null) return
      const target = !currentIsRead
      setPending((p) => ({ ...p, read: true }))
      optimisticDetail({ is_read: target })
      try {
        await mailApi.email.flag(internalId, { isRead: target })
        toastSuccess(t('toolbarToast.flagOk'))
      } catch (err) {
        // Rollback — refetch to 真实 SQLite state
        await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
        await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, read: false }))
      }
    },
    [internalId, mailApi, optimisticDetail, queryClient, t]
  )

  const handleToggleFlag = useCallback(
    async (currentIsFlagged: boolean): Promise<void> => {
      if (internalId === null) return
      const target = !currentIsFlagged
      setPending((p) => ({ ...p, flag: true }))
      optimisticDetail({ is_flagged: target })
      try {
        await mailApi.email.flag(internalId, { isFlagged: target })
        toastSuccess(t('toolbarToast.flagOk'))
      } catch (err) {
        await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
        await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, flag: false }))
      }
    },
    [internalId, mailApi, optimisticDetail, queryClient, t]
  )

  // Sprint 17 — 打开未读邮件自动标已读; useRef 记录已 marked 的 id 防止重复触发。
  const autoMarkedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (internalId === null) return
    if (!detailData || detailData.is_read) return
    if (autoMarkedRef.current.has(internalId)) return
    autoMarkedRef.current.add(internalId)
    optimisticDetail({ is_read: true })
    void mailApi.email.flag(internalId, { isRead: true }).catch(() => {
      // 静默 — auto-markRead 失败不打扰用户; 用户仍可在 toolbar 手动标
    })
  }, [internalId, detailData, mailApi, optimisticDetail])

  return {
    pending,
    setActive,
    onPrev,
    onNext,
    handleArchive,
    handleDelete,
    handleResync,
    handleLlmRun,
    handleToggleRead,
    handleToggleFlag
  }
}
