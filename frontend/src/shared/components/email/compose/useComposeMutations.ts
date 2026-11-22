// Compose write mutations (draft save + replace anchor swap, send + background
// cleanup, optimistic draft delete, and single-flight saveDraftAsync).

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { retargetObjectTab } from '@shared/state/tab-workspace-bridge'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ComposeAttachmentRef,
  ComposeImportance,
  ComposeMode,
  ComposeWireMode
} from '@shared/api/types'

import { attachmentRefOf, type ComposeAttachmentChip } from './useComposeAttachments'

export type ComposeMutationPanelMode = ComposeMode | 'draft-edit' | 'new'
export type ComposeMutationCloseReason = 'sent' | 'deleted'

interface UseComposeMutationsOpts {
  internalId: number
  mode: ComposeMutationPanelMode
  wireMode: ComposeWireMode
  isDraftEdit: boolean
  draftRowId: number
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  importance: ComposeImportance
  getSanitizedHtml: () => string
  attachList: readonly ComposeAttachmentChip[]
  inlineRefs: ReadonlyArray<{ id: number; filename: string }>
  fwdAttachState: 'pending' | 'done' | 'error'
  setDirty: (dirty: boolean) => void
  setDraftRowId: (id: number) => void
  setLastSavedAt: (d: Date) => void
  setSendOpen: (open: boolean) => void
  remapMirrorAttachments: (idMap: Record<string, number>) => void
  schedulePostSaveSnapshot: (anchorAfterSave: number) => void
  onClose: (reason?: ComposeMutationCloseReason) => void
}

export interface ComposeMutationsController {
  savePending: boolean
  sendPending: boolean
  deletePending: boolean
  sendMutate: () => void
  deleteMutate: () => void
  saveDraftAsync: () => Promise<unknown>
  busy: boolean
}

/** Builds compose payloads and owns saveDraft / send / delete mutations. */
export function useComposeMutations({
  internalId,
  mode,
  wireMode,
  isDraftEdit,
  draftRowId,
  to,
  cc,
  bcc,
  subject,
  importance,
  getSanitizedHtml,
  attachList,
  inlineRefs,
  fwdAttachState,
  setDirty,
  setDraftRowId,
  setLastSavedAt,
  setSendOpen,
  remapMirrorAttachments,
  schedulePostSaveSnapshot,
  onClose
}: UseComposeMutationsOpts): ComposeMutationsController {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()

  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.emails.all() })
    void queryClient.invalidateQueries({ queryKey: qk.mailboxes() })
  }, [queryClient])

  const buildComposePayload = useCallback(() => {
    // codex F1 — forward 附件权威列表契约: 原邮件非 inline 附件在打开时已 hydrate 进
    // attachList (可移除 chips), 此处恒发显式 attachments (含空数组 []) —— 服务端收到
    // 显式列表即跳过 auto-collect, 用户移除任一/全部原附件的意图得以表达 (旧实现列表
    // 为空省略键 → 服务端 auto-collect 静默恢复全部原附件)。不发键 = 服务端缺省
    // auto-collect, 那是 CLI/ping-island 的语义; 其他模式 (reply/new/draft-edit)
    // 空列表仍省略键, 语义不变。未 hydrate 成功 → 硬阻断 (绝不静默丢原附件)。
    if (mode === 'forward' && fwdAttachState !== 'done') {
      throw Object.assign(new Error(t('compose.toast.forwardAttachLoadFail')), {
        code: 'E_FORWARD_ATTACH'
      })
    }
    // D1 refs: 三条腿见 attachmentRefOf。
    // draft-edit 追加 D2 隐藏保真集 (inline 部件, 不显示为 chip 但必须过线)。
    const refs: ComposeAttachmentRef[] = [
      ...attachList.filter((a) => a.status === 'done').map(attachmentRefOf),
      ...inlineRefs.map((a) => ({ attachment_id: a.id }))
    ]
    return {
      // draft-edit 用替换锚 (保存后旧行已删, 锚随 mirror_internal_id 换新行)。
      internalId: isDraftEdit ? draftRowId : internalId,
      mode: wireMode,
      to,
      cc,
      bcc,
      subject,
      // UI 里改主题是用户明确意图 — 跳过服务层 reply 改主题断线程守卫 (守卫防 agent/CLI 误用)
      forceSubject: true,
      bodyHtml: getSanitizedHtml(),
      importance,
      // D3 兜底闸 — draft-edit 恒发显式 attachments 键 (含空数组): 键省略时服务端
      // 无从区分「没有附件」与「客户端漏传」, 会静默产出无附件 EML (服务端另有
      // 拒绝守卫, 这里是权威列表的表达面, 同 forward 契约)。
      ...(mode === 'forward' || isDraftEdit || refs.length > 0 ? { attachments: refs } : {}),
      // D1 Bug A — draft-edit 保存/发送带草稿行自己的 id: 服务端读该行 draft_in_reply_to/
      // draft_references/thread_id 恢复回复线程, linkage 空回退零派生 (契约 sourceDraftId);
      // C-1 起服务端还按它执行替换删除 (旧行 → 墓碑 + 本地删 + EXPUNGE 后台)。
      ...(isDraftEdit ? { sourceDraftId: draftRowId } : {})
    }
  }, [
    internalId,
    draftRowId,
    wireMode,
    mode,
    isDraftEdit,
    to,
    cc,
    bcc,
    subject,
    getSanitizedHtml,
    importance,
    attachList,
    inlineRefs,
    fwdAttachState,
    t
  ])

  const saveMut = useMutation({
    mutationFn: async () => mailApi.email.draft(await buildComposePayload()),
    // 不在此处 onClose —— 关闭由调用方决定: 顶部「保存草稿」按钮 新建关闭 /
    // draft-edit 留在编辑态, 离开守卫「保存草稿」存后继续原动作 (mutateAsync
    // resolve → proceed)。存成功即 baseline 复位 (dirty=false)。
    onSuccess: (data) => {
      toastSuccess(t('compose.toast.draftOk'))
      setDirty(false)
      // 保存后的锚：draft-edit 有镜像时换新行，否则维持现锚。快照收敛（dirty 放平 /
      // lastSavedAt / 换锚）写到它上面。
      let anchorAfterSave = isDraftEdit ? draftRowId : internalId
      if (isDraftEdit) {
        setLastSavedAt(new Date())
        // C-1 replace — 服务端删旧行建镜像新行: 替换锚 + 附件引用一并换到新行
        // (旧行的 attachment_id 已随行删除, 不换则下次保存引用解析失败)。镜像
        // 失败时 mirror_internal_id 为 null → 保持旧锚 (降级: 下次保存回退新建)。
        const d = (data ?? {}) as {
          mirror_internal_id?: number | null
          mirror_attachment_ids?: Record<string, number> | null
        }
        if (typeof d.mirror_internal_id === 'number') {
          setDraftRowId(d.mirror_internal_id)
          anchorAfterSave = d.mirror_internal_id
          remapMirrorAttachments(d.mirror_attachment_ids ?? {})
          // dogfood 波3 — 标签跟着换锚（不换 = 标签指着已删行，重启后成死标签）。
          // 🔴 次序: 先 retarget 再 invalidate —— 反过来会打开「标签还指旧行、
          // 旧行详情已 404」的死窗口。
          retargetObjectTab('email', draftRowId, d.mirror_internal_id)
        }
      }
      // 期望锚交给收敛 effect（等渲染追上再落笔快照）。
      schedulePostSaveSnapshot(anchorAfterSave)
      invalidateLists()
    },
    onError: (err: unknown) => {
      const e = asWriteError(err)
      const key =
        e.code === 'E_AUTH'
          ? 'compose.toast.draftFailAuth'
          : e.code === 'E_INVALID_ARG'
            ? 'compose.toast.draftFailArg'
            : 'compose.toast.draftFailGeneric'
      toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
    }
  })

  const sendMut = useMutation({
    mutationFn: async () => mailApi.email.send(await buildComposePayload()),
    onSuccess: () => {
      toastSuccess(t('compose.toast.sendOk'))
      setSendOpen(false)
      setDirty(false)
      // draft-edit 发送成功后删掉原草稿 (替换语义: 发出的是 mode='new' 独立邮件, 原草稿仍在)。
      // task 08-20: 不再 await —— 删草稿 IMAP 慢链 (2.5-5.4s) 曾把发送反馈拖到
      // ~11.5s 转圈。后台执行, 失败仅 toast (邮件已发出, 残留草稿用户可手动删)。
      // 删除目标 = 替换锚 draftRowId (保存过一次后原 internalId 行已被 replace 删掉)。
      if (isDraftEdit) {
        void mailApi.email
          .deleteDraft(draftRowId)
          .catch(() => toastError(t('compose.toast.draftDeleteFail')))
          .finally(() => invalidateLists())
      }
      // draft-edit 发送 = 原草稿行随替换语义消亡 → 带 reason 让 EmailDetail 收标签。
      onClose(isDraftEdit ? 'sent' : undefined)
    },
    onError: (err: unknown) => {
      setSendOpen(false)
      const e = asWriteError(err)
      const key =
        e.code === 'E_AUTH'
          ? 'compose.toast.sendFailAuth'
          : e.code === 'E_INVALID_ARG'
            ? 'compose.toast.sendFailArg'
            : 'compose.toast.sendFailGeneric'
      toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
    }
  })

  // 草稿编辑「放弃」= 删除草稿 (IMAP \Deleted + 本地行清理)。
  // 乐观删除 (task 08-20): onMutate 即关面板 + 提示 —— IMAP 慢链 (实测 2.5-5.4s)
  // 全部后台化, 列表由 SSE + invalidateLists 最终一致。失败仅 toast: 服务端本地行
  // 先删且不因 IMAP 失败抛错, 真失败 (auth/网络) 时残留由 reconcile 自愈, 重删即可。
  const deleteMut = useMutation({
    // 目标 = 替换锚 draftRowId (draft-edit 保存过一次后原行已被 replace 删掉)。
    mutationFn: () => mailApi.email.deleteDraft(draftRowId),
    onMutate: () => {
      toastSuccess(t('compose.toast.draftDeleted'))
      // 对象消亡 → 带 reason 让 EmailDetail 收标签（deleteMut 只在 draft-edit 出现）。
      onClose('deleted')
    },
    onSuccess: () => {
      invalidateLists()
    },
    onError: (err: unknown) => {
      const e = asWriteError(err)
      toastError(
        t('compose.toast.draftDeleteFail'),
        e.code ? `${e.code} · ${e.message}` : e.message
      )
    }
  })

  // 单飞 (task 08-20 draft-save): 顶部「保存草稿」按钮与离开守卫两个入口共用 —
  // in-flight 复用同一 promise, 防双 APPEND (replace 语义下双 APPEND = 两行新草稿)。
  const saveInflightRef = useRef<Promise<unknown> | null>(null)
  const saveDraftAsync = useCallback(() => {
    if (!saveInflightRef.current) {
      saveInflightRef.current = saveMut.mutateAsync().finally(() => {
        saveInflightRef.current = null
      })
    }
    return saveInflightRef.current
  }, [saveMut])

  const busy = saveMut.isPending || sendMut.isPending || deleteMut.isPending

  return {
    savePending: saveMut.isPending,
    sendPending: sendMut.isPending,
    deletePending: deleteMut.isPending,
    sendMutate: () => sendMut.mutate(),
    deleteMutate: () => deleteMut.mutate(),
    saveDraftAsync,
    busy
  }
}
