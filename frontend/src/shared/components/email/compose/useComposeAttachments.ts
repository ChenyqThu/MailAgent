// Compose attachment state, staging upload, library picker insertion, forward
// attachment hydration, and drag-and-drop handlers extracted from ComposePanel.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import type { ComposeAttachmentRef, EmailDetail } from '@shared/api/types'
import type { LibraryFile } from '@shared/api/types/library'

import { kindFromName } from './AttachmentTray'
import type { ComposeTabDraft, ComposeTabDraftAttachment } from './composeTabDraft'
import { COMPOSE_INLINE_IMAGE_DROP_FLAG } from './editor-extensions'

/** 单附件上限 — mirror 服务端 _MAX_FORWARD_ATTACH_BYTES (20MB, mail_write.py:157)。
 *  前端先拦是 UX; 服务端 staging 端点是权威复核。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** compose 附件 chip 本地态。三选一来源 (发送时各落成一种 ref, 见 attachmentRefOf):
 *  - staged: 用户新上传 → staging 端点回执 stageId → payload {stage_id}
 *  - existing: draft-edit 回填 / forward hydrate 的库内已有邮件附件 → payload {attachment_id}
 *    (draft-edit 发送是 mode='new' 新邮件, 不引用原草稿附件就会丢)
 *  - library: 资料库选择器挑来的库内文件 → payload {library_file_id}; 字节已在资料库里,
 *    没有上传步骤, 落地即 'done' (服务端按 id 过路径 jail 后自己读原件) */
export interface ComposeAttachmentChip {
  localId: number
  filename: string
  size: number | null
  status: 'uploading' | 'done' | 'error'
  stageId?: string
  attachmentId?: number
  libraryFileId?: number
  /** staged 图片的本地缩略预览 (URL.createObjectURL); 移除/卸载时 revoke。 */
  previewUrl?: string
}

/** chip → wire ref (snake_case 契约字面)。三条腿互斥, 服务端 `_normalize_attachment_refs`
 *  强制"恰好一个键"。 */
export function attachmentRefOf(a: ComposeAttachmentChip): ComposeAttachmentRef {
  if (a.stageId != null) return { stage_id: a.stageId }
  if (a.libraryFileId != null) return { library_file_id: a.libraryFileId }
  return { attachment_id: a.attachmentId as number }
}

interface UseComposeAttachmentsOpts {
  internalId: number
  mode: string
  initialTabDraft?: ComposeTabDraft | null
  busyRef: React.RefObject<boolean>
  markDirty: () => void
}

export interface ComposeAttachmentsController {
  attachList: ComposeAttachmentChip[]
  inlineRefs: Array<{ id: number; filename: string }>
  fwdAttachState: 'pending' | 'done' | 'error'
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>
  isDragActive: boolean
  uploadsPending: boolean
  readyAttachments: ComposeAttachmentChip[]
  fwdAttachBlocked: boolean
  handleFilesSelected: (files: FileList | null) => void
  addLibraryFiles: (files: readonly LibraryFile[]) => void
  removeAttachment: (localId: number) => void
  handleDragEnter: (e: React.DragEvent) => void
  handleDragOver: (e: React.DragEvent) => void
  handleDragLeave: () => void
  handleDrop: (e: React.DragEvent) => void
  hydrateDraftAttachments: (attachments: NonNullable<EmailDetail['attachments']>) => void
  restoreSnapshotAttachments: (attachments: readonly ComposeTabDraftAttachment[]) => void
  remapMirrorAttachments: (idMap: Record<string, number>) => void
  retryForwardAttachments: () => void
}

/** Owns compose attachment chips, upload staging, forward hydration, and DnD state. */
export function useComposeAttachments({
  internalId,
  mode,
  initialTabDraft,
  busyRef,
  markDirty
}: UseComposeAttachmentsOpts): ComposeAttachmentsController {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()

  // D6 — 附件 chips (staged 上传 + draft-edit 回填 + forward hydrate 的库内已有附件 +
  // 资料库选择器挑来的库内文件)。
  const [attachList, setAttachList] = useState<ComposeAttachmentChip[]>([])
  // D2 隐藏保真集 (task 08-20 draft-save) — 草稿正文引用的 inline 部件 (cid:) 不进
  // AttachmentTray 显示, 但随 refs 带走: 服务端把对应 MIME part 重新编入出站 EML
  // (否则替换保存后的草稿有 cid 引用无 part, 内联图确定性丢)。filename 用于保存后
  // 按 mirror_attachment_ids 换到新行引用。
  const [inlineRefs, setInlineRefs] = useState<Array<{ id: number; filename: string }>>([])
  // codex F1 — forward 原附件 hydration 状态机: 打开即补拉原邮件非 inline 附件成
  // 可移除 {attachment_id} chips (显式权威列表契约); pending/error 期间发送硬阻断,
  // error 给错误条 + 重试 (置回 'pending' 重跑 effect)。非 forward 恒 'done' 不参与。
  const [fwdAttachState, setFwdAttachState] = useState<'pending' | 'done' | 'error'>(() =>
    // 标签快照恢复且快照记录过 hydrate 已完成 → 不再重跑（chips 从快照回填；重跑会把
    // 用户已显式移除的原附件加回来）。
    mode === 'forward' && initialTabDraft?.fwdHydrated !== true ? 'pending' : 'done'
  )
  const attachSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // staged 图片缩略预览的 objectURL 台账 — 单删时逐个 revoke, 卸载时兜底全量 revoke。
  const previewUrlsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const urls = previewUrlsRef.current
    return () => {
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [])
  // L0 — 拖拽附件: 拖文件到 composer 卡片任意位置即可添加。dragDepth 计数法消除
  // 子元素 dragenter/dragleave 抖动 (提示层 pointer-events-none 不参与计数)。
  const [isDragActive, setIsDragActive] = useState(false)
  const dragDepth = useRef(0)

  const hydrateDraftAttachments = useCallback(
    (attachments: NonNullable<EmailDetail['attachments']>) => {
      // 草稿已有附件 (OWA 建的带附件草稿) → attachment_id 引用 chips: draft-edit
      // 发送是 mode='new' 新邮件, 不引用原草稿附件发出去就丢了。inline/derived 行
      // 不算 (正文内联图 / office 预转产物, 同 AttachmentList 的 visible 过滤)。
      const existing = attachments.filter((a) => !a.is_inline && a.derived_from == null)
      if (existing.length > 0) {
        setAttachList(
          existing.map((a) => ({
            localId: ++attachSeq.current,
            filename: a.filename,
            size: a.size_bytes ?? null,
            status: 'done' as const,
            attachmentId: a.id
          }))
        )
      }
      // D2 — inline 部件进隐藏保真集 (不显示为 chip, 但随 payload refs 带走)。
      const inlineParts = attachments.filter((a) => a.is_inline && a.derived_from == null)
      if (inlineParts.length > 0) {
        setInlineRefs(inlineParts.map((a) => ({ id: a.id, filename: a.filename })))
      }
    },
    []
  )

  const restoreSnapshotAttachments = useCallback(
    (attachments: readonly ComposeTabDraftAttachment[]) => {
      setAttachList(
        attachments.map((a) => ({
          localId: ++attachSeq.current,
          filename: a.filename,
          size: a.size,
          status: 'done' as const,
          ...(a.stageId !== undefined ? { stageId: a.stageId } : {}),
          ...(a.attachmentId !== undefined ? { attachmentId: a.attachmentId } : {}),
          ...(a.libraryFileId !== undefined ? { libraryFileId: a.libraryFileId } : {})
        }))
      )
    },
    []
  )

  const remapMirrorAttachments = useCallback((idMap: Record<string, number>) => {
    setAttachList((prev) =>
      prev.map((c) => {
        const nid = idMap[c.filename]
        return typeof nid === 'number' ? { ...c, attachmentId: nid, stageId: undefined } : c
      })
    )
    setInlineRefs((prev) =>
      prev.map((r) => {
        const nid = idMap[r.filename]
        return typeof nid === 'number' ? { ...r, id: nid } : r
      })
    )
  }, [])

  const retryForwardAttachments = useCallback(() => {
    setFwdAttachState('pending')
  }, [])

  // D6 — 附件上传: File → ArrayBuffer → staging 端点 (PUT raw bytes), 回执 stage_id
  // 落进 chip。失败 chip 标红 (可删掉重传), 不阻断其余文件。
  const uploadAttachment = useCallback(
    async (file: File) => {
      const localId = ++attachSeq.current
      // 图片附件生成本地缩略预览 (AttachmentTray 卡片); objectURL 在移除/卸载时 revoke。
      let previewUrl: string | undefined
      if (file.type.startsWith('image/') || kindFromName(file.name) === 'image') {
        previewUrl = URL.createObjectURL(file)
        previewUrlsRef.current.add(previewUrl)
      }
      setAttachList((prev) => [
        ...prev,
        { localId, filename: file.name, size: file.size, status: 'uploading', previewUrl }
      ])
      try {
        const bytes = await file.arrayBuffer()
        const staged = await mailApi.email.uploadComposeAttachment({
          filename: file.name,
          bytes,
          mime: file.type || undefined
        })
        setAttachList((prev) =>
          prev.map((a) =>
            a.localId === localId ? { ...a, status: 'done', stageId: staged.stage_id } : a
          )
        )
      } catch (err) {
        const e = asWriteError(err)
        setAttachList((prev) =>
          prev.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a))
        )
        toastError(
          t('compose.toast.attachmentUploadFail', { name: file.name }),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      }
    },
    [mailApi, t]
  )

  const handleFilesSelected = useCallback(
    (files: FileList | null) => {
      if (!files) return
      for (const file of Array.from(files)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toastError(t('compose.toast.attachmentTooLarge', { name: file.name, max: 20 }))
          continue
        }
        markDirty()
        void uploadAttachment(file)
      }
    },
    [uploadAttachment, t, markDirty]
  )

  // 资料库选择器的回执 —— 库内文件不经 staging (字节已在库里), 落地即 'done';
  // 服务端按 library_file_id 过路径 jail 后自己读原件。
  const addLibraryFiles = useCallback(
    (files: readonly LibraryFile[]) => {
      // 已在列表里的不重复添加。投影行 (邮件附件) 走 attachmentId, 与 forward hydrate
      // 出来的原附件 chip 是同一个身份空间, 一条判据同时覆盖两种重复。
      const already = (file: LibraryFile): boolean =>
        file.id != null
          ? attachList.some((a) => a.libraryFileId === file.id)
          : attachList.some((a) => a.attachmentId === file.attachment_id)
      const added: ComposeAttachmentChip[] = []
      for (const file of files) {
        if (already(file)) continue
        // 与本机文件那条路同口径 (服务端 20MB 复核是权威, 前端先拦是 UX)。
        if (file.size_bytes != null && file.size_bytes > MAX_ATTACHMENT_BYTES) {
          toastError(t('compose.toast.attachmentTooLarge', { name: file.filename, max: 20 }))
          continue
        }
        added.push({
          localId: ++attachSeq.current,
          filename: file.filename,
          size: file.size_bytes,
          status: 'done',
          // 投影行没有 library id (id: null), 只能走已有的 {attachment_id} 腿。
          ...(file.id != null
            ? { libraryFileId: file.id }
            : { attachmentId: file.attachment_id as number })
        })
      }
      if (added.length === 0) return
      setAttachList((prev) => [...prev, ...added])
      markDirty()
    },
    [attachList, markDirty, t]
  )

  const removeAttachment = useCallback(
    (localId: number) => {
      // 只移除本地引用; staging 残留由服务端 TTL/send 后清理, 无需删端点。
      const hit = attachList.find((a) => a.localId === localId)
      if (hit?.previewUrl) {
        URL.revokeObjectURL(hit.previewUrl)
        previewUrlsRef.current.delete(hit.previewUrl)
      }
      setAttachList((prev) => prev.filter((a) => a.localId !== localId))
      markDirty()
    },
    [attachList, markDirty]
  )

  // codex F1 — forward 打开即 hydrate: 原邮件非 inline 附件进 attachList 成可移除
  // tray 卡片。口径对齐服务端 _collect_forward_attachments (只滤 is_inline, 不滤
  // derived); detail 走 ensureQueryData (引用块已拉过时命中缓存)。hydrate 不标
  // dirty (等同预填)。失败 → 'error' (错误条 + 重试), 发送前未成功一律硬阻断,
  // 绝不静默丢原附件 (契约 D4 附件铁律)。
  useEffect(() => {
    if (mode !== 'forward' || fwdAttachState !== 'pending') return
    let cancelled = false
    void (async () => {
      try {
        const detail = await queryClient.ensureQueryData({
          queryKey: qk.email.detail(internalId),
          queryFn: () => mailApi.email.get(internalId)
        })
        if (cancelled) return
        const chips: ComposeAttachmentChip[] = (detail?.attachments ?? [])
          .filter((a) => !a.is_inline)
          .map((a) => ({
            localId: ++attachSeq.current,
            filename: a.filename,
            size: a.size_bytes ?? null,
            status: 'done' as const,
            attachmentId: a.id
          }))
        // 原附件前置 (hydrate 落地前用户已 staged 的文件保持在后)。
        setAttachList((prev) => [...chips, ...prev])
        setFwdAttachState('done')
      } catch {
        if (!cancelled) setFwdAttachState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, fwdAttachState, internalId, queryClient, mailApi])

  // L0 — 拖拽附件事件面: 只认真实文件拖入 (types 含 'Files'); 文本/HTML 拖拽不激活、
  // 不 preventDefault → 落回 TipTap 原生行为。drop 复用 handleFilesSelected 管线
  // (20MB 校验 → staging 上传 → chip), 零逻辑复制。busy 时不收 (对齐附件按钮 disabled)。
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (busyRef.current || !e.dataTransfer.types.includes('Files')) return
      dragDepth.current += 1
      setIsDragActive(true)
    },
    [busyRef]
  )
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (busyRef.current || !e.dataTransfer.types.includes('Files')) return
      // preventDefault = 声明本区域可 drop (Chromium 默认 = 拒收/导航)。
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [busyRef]
  )
  const handleDragLeave = useCallback(() => {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current === 0) setIsDragActive(false)
  }, [])
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      dragDepth.current = 0
      setIsDragActive(false)
      // 图片拖进正文时 composeInlineImage 插件已内联插入并在原生事件上打了标记
      // (同一事件对象冒泡到这里) → 只收尾提示层, 不再把文件当附件重复添加。
      if ((e.nativeEvent as unknown as Record<string, unknown>)[COMPOSE_INLINE_IMAGE_DROP_FLAG])
        return
      if (busyRef.current || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      handleFilesSelected(e.dataTransfer.files)
    },
    [busyRef, handleFilesSelected]
  )

  const uploadsPending = attachList.some((a) => a.status === 'uploading')
  const readyAttachments = attachList.filter((a) => a.status === 'done')
  // codex F1 — forward 原附件未 hydrate 成功 (pending/error) 期间发/存硬阻断,
  // 权威列表不完整就发会静默丢原附件。
  const fwdAttachBlocked = mode === 'forward' && fwdAttachState !== 'done'

  return {
    attachList,
    inlineRefs,
    fwdAttachState,
    fileInputRef,
    isDragActive,
    uploadsPending,
    readyAttachments,
    fwdAttachBlocked,
    handleFilesSelected,
    addLibraryFiles,
    removeAttachment,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    hydrateDraftAttachments,
    restoreSnapshotAttachments,
    remapMirrorAttachments,
    retryForwardAttachments
  }
}
