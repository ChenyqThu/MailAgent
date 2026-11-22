// 08-27 标签工作区 — compose 现场快照生命周期 (overlay 三模式 + draft-edit):
// 恢复快照、提交捕获、卸载兜底、live dirty 同步、保存后收敛写、草稿标签标题跟手。

import { useCallback, useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'

import type { ComposeImportance } from '@shared/api/types'
import { useComposeStore } from '@shared/state/compose'
import {
  getObjectTab,
  saveObjectTabDraft,
  setObjectTabTitle
} from '@shared/state/tab-workspace-bridge'

import {
  toDraftSnapshot,
  type ComposeTabDraft,
  type ComposeTabDraftAttachment,
  type ComposeTabDraftMode
} from './composeTabDraft'
import type { ComposeAttachmentChip } from './useComposeAttachments'

interface UseComposeTabSnapshotOpts {
  internalId: number
  mode: string
  isDraftEdit: boolean
  editor: Editor | null
  planApplied: boolean
  initialTabDraft?: ComposeTabDraft | null
  snapshotRef?: React.MutableRefObject<(() => ComposeTabDraft | null) | null>
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  importance: ComposeImportance
  ccVisible: boolean
  bccVisible: boolean
  lineHeightChoice: string
  attachList: readonly ComposeAttachmentChip[]
  fwdAttachState: 'pending' | 'done' | 'error'
  dirty: boolean
  draftRowId: number
  lastSavedAt: Date | null
  latestBodyHtmlRef: React.MutableRefObject<string | null>
  onRestore: (snap: ComposeTabDraft) => void
}

export interface ComposeTabSnapshotController {
  suppressUnmountSnapshot: () => void
  schedulePostSaveSnapshot: (anchorAfterSave: number) => void
}

/** Manages compose tab-workspace draft snapshot capture, restore, and post-save convergence. */
export function useComposeTabSnapshot({
  internalId,
  mode,
  isDraftEdit,
  editor,
  planApplied,
  initialTabDraft,
  snapshotRef,
  to,
  cc,
  bcc,
  subject,
  importance,
  ccVisible,
  bccVisible,
  lineHeightChoice,
  attachList,
  fwdAttachState,
  dirty,
  draftRowId,
  lastSavedAt,
  latestBodyHtmlRef,
  onRestore
}: UseComposeTabSnapshotOpts): ComposeTabSnapshotController {
  const isOverlayMode = mode === 'reply' || mode === 'reply-all' || mode === 'forward'
  const snapshotEligible = isOverlayMode || isDraftEdit

  // 1. 快照恢复：正常预填完成后覆写用户可编辑的字段（overlay 的 quote/splitQuote 从 plan
  // 重建；draft-edit 的 quote/splitQuote/preserveOriginal/inlineRefs 从 draftQ 行数据重建，
  // 见 composeTabDraft.ts 头注释）。恒只跑一次；mode 不匹配（快照是 reply、这次开的是
  // forward）时整份放弃。
  const tabDraftAppliedRef = useRef(false)
  useEffect(() => {
    if (!planApplied || tabDraftAppliedRef.current || !editor) return
    tabDraftAppliedRef.current = true
    const snap = initialTabDraft
    if (!snapshotEligible || snap == null || snap.mode !== mode) return
    onRestore(snap)
    if (snap.bodyHtml !== null) {
      editor.commands.setContent(snap.bodyHtml)
      latestBodyHtmlRef.current = snap.bodyHtml
    }
  }, [planApplied, editor, initialTabDraft, snapshotEligible, mode, onRestore, latestBodyHtmlRef])

  // 2. 现场捕获：正文以外的字段每次提交后打进 ref（对象拼装廉价）；正文在快照落笔时从
  // latestBodyHtmlRef 补上 —— 编辑器打字不触发 React 重渲，捕获时直接读 ref 才是最新值。
  const tabDraftBaseRef = useRef<Omit<ComposeTabDraft, 'bodyHtml'> | null>(null)
  useEffect(() => {
    if (!snapshotEligible) return
    tabDraftBaseRef.current = {
      kind: 'compose',
      mode: mode as ComposeTabDraftMode,
      to,
      cc,
      bcc,
      subject,
      importance,
      ccVisible,
      bccVisible,
      lineHeightChoice,
      attachments: attachList
        .filter((a) => a.status === 'done')
        .map(
          (a): ComposeTabDraftAttachment => ({
            filename: a.filename,
            size: a.size,
            ...(a.stageId !== undefined ? { stageId: a.stageId } : {}),
            ...(a.attachmentId !== undefined ? { attachmentId: a.attachmentId } : {}),
            ...(a.libraryFileId !== undefined ? { libraryFileId: a.libraryFileId } : {})
          })
        ),
      fwdHydrated: mode !== 'forward' || fwdAttachState === 'done',
      dirty,
      // draft-edit 的 replace 锚随现场走（保存后 = 镜像新行 = 标签 retarget 后的 targetId）。
      ...(isDraftEdit ? { draftRowId } : {}),
      ...(isDraftEdit && lastSavedAt !== null ? { lastSavedAtMs: lastSavedAt.getTime() } : {})
    }
  })

  // 3. getter 出口（EmailDetail 切邮件路径：面板还活着时取现场）。只读 ref，引用恒定。
  useEffect(() => {
    if (snapshotRef === undefined) return
    snapshotRef.current = () => {
      const base = tabDraftBaseRef.current
      if (base === null) return null
      return { ...base, bodyHtml: latestBodyHtmlRef.current }
    }
    // 🔴 卸载时**不清** getter：域切换时 EmailDetail 的收尾要在面板卸载后仍能读到冻结
    // 的现场（全 ref，安全）；下一个面板实例挂载时会覆写。
  }, [snapshotRef, latestBodyHtmlRef])

  // 4. 卸载兜底（overlay）：store 仍指向本邮件且 open（= 不是用户显式关闭，而是切域 / 详情
  // 早退把树整个卸了）→ 把现场快照写进标签。显式关闭（丢弃 / 发送成功）先 closeCompose
  // 再卸载，这里天然跳过；StrictMode 的 setup→cleanup→setup 重放只会多写一次等价快照。
  useEffect(() => {
    if (!isOverlayMode) return
    return () => {
      const base = tabDraftBaseRef.current
      if (base === null) return
      const cs = useComposeStore.getState()
      if (!cs.open || cs.internalId !== internalId) return
      saveObjectTabDraft(
        'email',
        internalId,
        toDraftSnapshot({ ...base, bodyHtml: latestBodyHtmlRef.current })
      )
    }
  }, [isOverlayMode, internalId, latestBodyHtmlRef])

  // 5. 卸载兜底（draft-edit，dogfood 波3）：切标签 / 切域 / 取消编辑都会把树卸掉，把现场
  // 写进标签快照。写入条件 = 有未保存修改，或本次会话保存过（lastSavedAtMs 在 ——
  // 恢复时「已保存 HH:MM」不丢）；从没动过的干看不写（否则每个点开过的草稿都带上
  // draft 快照被锁死，永不进 LRU）。显式丢弃经 suppress 位压住；删除 / 发送时标签已
  // 先被 EmailDetail 关掉，saveObjectTabDraft 找不到标签自然跳过。
  // 🔴 写入目标是 base.draftRowId（replace 锚）不是挂载时的 internalId —— 保存过一次后
  // 标签已 retarget 到镜像新行，旧 id 上已无标签。
  const snapshotSuppressedRef = useRef(false)
  useEffect(() => {
    if (!isDraftEdit) return
    return () => {
      if (snapshotSuppressedRef.current) return
      const base = tabDraftBaseRef.current
      if (base === null) return
      if (base.dirty !== true && base.lastSavedAtMs === undefined) return
      saveObjectTabDraft(
        'email',
        base.draftRowId ?? internalId,
        toDraftSnapshot({ ...base, bodyHtml: latestBodyHtmlRef.current })
      )
    }
  }, [isDraftEdit, internalId, latestBodyHtmlRef])

  // 6. dirty 翻 true 当场把现场写进标签快照（不等切走）：标签条立即出改动点 + 上锁，
  // 关闭守卫（⌘W / ×）也才有 dirty 位可判。翻回 false 的收敛由保存链（下方
  // snapshotRefreshRef）与显式丢弃处理，这里只管「变脏即报」。
  useEffect(() => {
    if (!snapshotEligible || !dirty) return
    const base = tabDraftBaseRef.current
    if (base === null) return
    saveObjectTabDraft(
      'email',
      base.draftRowId ?? internalId,
      toDraftSnapshot({ ...base, bodyHtml: latestBodyHtmlRef.current })
    )
  }, [snapshotEligible, dirty, internalId, latestBodyHtmlRef])

  // 7. 保存成功后的快照收敛（onSuccess 里 tabDraftBaseRef 还是旧值 —— 附件引用 swap、
  // dirty→false、lastSavedAt 都要等捕获 effect 拿到新一轮渲染，故这里存「期望的锚」、
  // 等渲染追上再落笔。🔴 不能用布尔标记当场消费：TanStack 回调与 React 提交的批次
  // 边界不可靠，实测有「标记已置、该次提交渲染的还是旧 draftRowId」的中间提交，当场
  // 消费会把快照写到已 retarget 掉的旧标签上（no-op，等于丢了收敛）。
  // draft-edit 恒重写（换锚后的标签要新快照，「已保存 HH:MM」靠它跨 remount 存活）；
  // overlay 只在已有快照时刷新（把 dirty 位放平，没有快照不凭空造一个）。
  const snapshotRefreshRef = useRef<number | null>(null)
  useEffect(() => {
    const expected = snapshotRefreshRef.current
    if (expected === null || !snapshotEligible) return
    const base = tabDraftBaseRef.current
    if (base === null) return
    // 渲染还没追上保存结果（dirty 未放平 / 锚未换新）→ 等下一个提交。保存后立即又被
    // 编辑标脏的罕见交错里，live dirty 写会接管现场，这份收敛过期作废即可。
    if (base.dirty === true) return
    if (isDraftEdit && (base.draftRowId ?? internalId) !== expected) return
    snapshotRefreshRef.current = null
    if (!isDraftEdit && getObjectTab('email', expected)?.draft === undefined) return
    saveObjectTabDraft(
      'email',
      expected,
      toDraftSnapshot({ ...base, bodyHtml: latestBodyHtmlRef.current })
    )
  })

  // 8. 草稿标签标题跟手（bridge 同值不写）。回填也会经过这里：回填值 = 行数据主题 =
  // 点行时的标题快照，同值早退，无噪音；保存成功后标题即已存主题。
  useEffect(() => {
    if (!isDraftEdit) return
    setObjectTabTitle('email', draftRowId, subject)
  }, [isDraftEdit, draftRowId, subject])

  const suppressUnmountSnapshot = useCallback(() => {
    snapshotSuppressedRef.current = true
  }, [])

  const schedulePostSaveSnapshot = useCallback((anchorAfterSave: number) => {
    snapshotRefreshRef.current = anchorAfterSave
  }, [])

  return { suppressUnmountSnapshot, schedulePostSaveSnapshot }
}
