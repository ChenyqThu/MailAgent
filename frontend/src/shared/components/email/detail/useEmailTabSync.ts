// 08-27 Tab workspace synchronization for EmailDetail:
// compose overlay snapshot save/auto-reopen, tab close guard receiver,
// 404 eviction, tab title backfill, scroll save/restore, and reply plan prefetch.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { isDraftsMailbox } from '@shared/lib/mailboxSemantics'
import { qk } from '@shared/lib/queryKeys'
import { useActiveEmail } from '@shared/state/active-email'
import { closeCompose, useComposeStore } from '@shared/state/compose'
import { selectActiveTab, tabId, useTabWorkspace } from '@shared/state/tab-workspace'
import {
  clearObjectTabDraft,
  clearTabCloseRequest,
  closeObjectTab,
  getObjectTabScroll,
  saveObjectTabDraft,
  saveObjectTabScroll,
  setObjectTabTitle,
  tabsInert,
  useTabCloseGuard,
  type PendingTabClose
} from '@shared/state/tab-workspace-bridge'
import { toastInfo } from '@shared/state/toast'
import type { ComposeMode, EmailDetail } from '@shared/api/types'

import type { ComposeCloseReason } from '../compose/ComposePanel'
import {
  readComposeTabDraft,
  toDraftSnapshot,
  type ComposeTabDraft
} from '../compose/composeTabDraft'
import type { ComposeGuardHandle } from '../compose/useComposeGuard'

interface UseEmailTabSyncOpts {
  internalId: number | null
  detailData: EmailDetail | null | undefined
  detailIsSuccess: boolean
  detailIsPlaceholderData: boolean
  bodyScopeRef: React.RefObject<HTMLDivElement | null>
}

export interface EmailTabSyncController {
  composeOpenHere: boolean
  composeTabDraft: ComposeTabDraft | null
  composeSnapshotRef: React.MutableRefObject<(() => ComposeTabDraft | null) | null>
  draftEditGuardRef: React.MutableRefObject<ComposeGuardHandle | null>
  overlayGuardRef: React.MutableRefObject<ComposeGuardHandle | null>
  handleOpenCompose: (mode: ComposeMode) => void
  handleDraftEditClose: (reason?: ComposeCloseReason) => void
  handleBodyScroll: (scrollTop: number) => void
}

/** Coordinates EmailDetail lifecycle with tab-workspace snapshots, close guards, and scroll memory. */
export function useEmailTabSync({
  internalId,
  detailData,
  detailIsSuccess,
  detailIsPlaceholderData,
  bodyScopeRef
}: UseEmailTabSyncOpts): EmailTabSyncController {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const setActive = useActiveEmail((s) => s.setActive)

  const composeSnapshotRef = useRef<(() => ComposeTabDraft | null) | null>(null)
  const draftEditGuardRef = useRef<ComposeGuardHandle | null>(null)
  const overlayGuardRef = useRef<ComposeGuardHandle | null>(null)

  const openCompose = useComposeStore((s) => s.openCompose)
  const composeOpen = useComposeStore((s) => s.open)
  const composeFor = useComposeStore((s) => s.internalId)
  const handleOpenCompose = useCallback(
    (mode: ComposeMode): void => {
      if (internalId === null) return
      openCompose(internalId, mode)
    },
    [internalId, openCompose]
  )

  // overlay 只在 store.internalId === 当前详情时渲染 (scope 校验)。
  const composeOpenHere = composeOpen && composeFor === internalId

  const activeTabDraft = useTabWorkspace((s) =>
    internalId === null
      ? null
      : (s.tabs.find((tab) => tab.id === tabId('email', internalId))?.draft ?? null)
  )
  const composeTabDraft = useMemo(() => readComposeTabDraft(activeTabDraft), [activeTabDraft])

  // 切邮件：遗留的上一封 overlay composer → 经 snapshotRef 取现场快照写进它的标签，再关；
  // 随后：本标签挂着 compose 快照且 store 空闲 → 自动重开（「切回来 compose 仍开」）。
  const autoReopenIdRef = useRef<number | null>(null)
  useEffect(() => {
    const cs = useComposeStore.getState()
    if (cs.open && cs.internalId !== null && cs.internalId !== internalId) {
      const snap = composeSnapshotRef.current?.()
      if (snap !== null && snap !== undefined) {
        saveObjectTabDraft('email', cs.internalId, toDraftSnapshot(snap))
      }
      closeCompose()
    }
    const arrived = autoReopenIdRef.current !== internalId
    autoReopenIdRef.current = internalId
    if (
      arrived &&
      internalId !== null &&
      composeTabDraft !== null &&
      composeTabDraft.mode !== 'draft-edit' &&
      !useComposeStore.getState().open
    ) {
      useComposeStore.getState().openCompose(internalId, composeTabDraft.mode)
    }
  }, [internalId, composeTabDraft])

  // 真实关闭（发送成功 / 显式丢弃 —— open 在本邮件上翻 false）→ 清掉标签上的快照。
  const prevComposeRef = useRef<{ open: boolean; internalId: number | null }>({
    open: composeOpen,
    internalId: composeFor
  })
  useEffect(() => {
    const prev = prevComposeRef.current
    prevComposeRef.current = { open: composeOpen, internalId: composeFor }
    if (prev.open && !composeOpen && prev.internalId !== null && prev.internalId === internalId) {
      clearObjectTabDraft('email', prev.internalId)
    }
  }, [composeOpen, composeFor, internalId])

  // draft-edit 面板关闭。只有对象消亡（'sent' / 'deleted'）才收标签。
  const handleDraftEditClose = useCallback(
    (reason?: ComposeCloseReason): void => {
      const activeTab = selectActiveTab(useTabWorkspace.getState())
      setActive(null)
      if (reason === 'sent' || reason === 'deleted') {
        const target =
          activeTab !== null && activeTab.kind === 'email' ? activeTab.targetId : internalId
        if (target !== null) closeObjectTab('email', target)
      }
    },
    [setActive, internalId]
  )

  // 关闭守卫承接端（dogfood 波3）
  const closeRequest = useTabCloseGuard((s) => s.pending)
  const consumedCloseRef = useRef<PendingTabClose | null>(null)
  useEffect(() => {
    if (closeRequest === null || internalId === null) return
    if (closeRequest.kind !== 'email' || closeRequest.targetId !== internalId) return
    if (consumedCloseRef.current === closeRequest) return
    const finish = (): void => {
      const pend = useTabCloseGuard.getState().pending
      clearTabCloseRequest()
      if (pend !== null) useTabWorkspace.getState().closeTab(pend.tabId)
    }
    const guard = draftEditGuardRef.current ?? overlayGuardRef.current
    if (guard !== null) {
      const rawDirty = (activeTabDraft as { dirty?: unknown } | null)?.dirty === true
      if (rawDirty && composeTabDraft !== null && !guard.isDirty()) return
      consumedCloseRef.current = closeRequest
      guard.attemptClose(finish, clearTabCloseRequest)
      return
    }
    const cs = useComposeStore.getState()
    if (cs.open && cs.internalId === internalId) return
    if (!detailIsSuccess || detailIsPlaceholderData) return
    if (detailData !== null && detailData !== undefined && isDraftsMailbox(detailData.mailbox))
      return
    consumedCloseRef.current = closeRequest
    finish()
  }, [
    closeRequest,
    internalId,
    activeTabDraft,
    composeTabDraft,
    composeOpenHere,
    detailIsSuccess,
    detailIsPlaceholderData,
    detailData
  ])

  // 404 轻量核销（dogfood 波3）
  useEffect(() => {
    if (internalId === null) return
    if (!detailIsSuccess || detailIsPlaceholderData || detailData !== null) return
    if (tabsInert()) return
    const tab = useTabWorkspace.getState().tabs.find((t) => t.id === tabId('email', internalId))
    if (tab === undefined) return
    if ((tab.draft as { dirty?: unknown } | undefined)?.dirty === true) return
    toastInfo(t('tabs.toast.targetGone'))
    closeObjectTab('email', internalId)
  }, [internalId, detailIsSuccess, detailIsPlaceholderData, detailData, t])

  // 标签标题回填
  useEffect(() => {
    if (internalId === null) return
    if (detailData?.internal_id !== internalId) return
    if (detailData.subject) setObjectTabTitle('email', internalId, detailData.subject)
  }, [internalId, detailData])

  // 每标签滚动位置：onScroll 只写 ref，切走落快照；切回在详情就绪后恢复一次。
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    if (internalId === null) return
    const id = internalId
    return () => {
      saveObjectTabScroll('email', id, lastScrollTopRef.current)
    }
  }, [internalId])

  const scrollRestoredForRef = useRef<number | null>(null)
  useEffect(() => {
    if (internalId === null) return
    if (detailData?.internal_id !== internalId) return
    if (scrollRestoredForRef.current === internalId) return
    scrollRestoredForRef.current = internalId
    const stored = getObjectTabScroll('email', internalId)
    lastScrollTopRef.current = 0
    const el = bodyScopeRef.current
    if (el && stored > 0) {
      el.scrollTop = stored
      lastScrollTopRef.current = el.scrollTop
    }
  }, [internalId, detailData, bodyScopeRef])

  const handleBodyScroll = useCallback((scrollTop: number) => {
    lastScrollTopRef.current = scrollTop
  }, [])

  // Warm reply / reply-all compose plans after 600ms settle.
  useEffect(() => {
    if (internalId === null || internalId < 0) return
    const id = internalId
    const timer = setTimeout(() => {
      for (const mode of ['reply', 'reply-all'] as const) {
        void queryClient.prefetchQuery({
          queryKey: qk.compose.planMode(id, mode),
          queryFn: () => mailApi.email.draftPlan({ internalId: id, mode }),
          staleTime: Infinity,
          retry: false
        })
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [internalId, queryClient, mailApi])

  return {
    composeOpenHere,
    composeTabDraft,
    composeSnapshotRef,
    draftEditGuardRef,
    overlayGuardRef,
    handleOpenCompose,
    handleDraftEditClose,
    handleBodyScroll
  }
}
