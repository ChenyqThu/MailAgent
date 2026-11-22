// Compose panel — 撰写 / 回复 / 回复所有 / 转发 / 草稿编辑 composer。
// 布局参考 Outlook: 顶部动作工具栏 (发送/放弃/[保存草稿]/签名) + From(只读)/To/
// Cc·Bcc/Subject(右侧 重要性) 表头 + 格式工具栏 + 正文 + 原文引用块。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useEditor } from '@tiptap/react'
import { ChevronRight, Paperclip, RotateCcw } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError } from '@shared/state/toast'
import { useComposeStore } from '@shared/state/compose'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { sanitizeEmailHtml } from '@shared/lib/emailSanitize'
import { parseAddressList } from '@shared/lib/mail_parse'
import { assessDraftHtml } from '@shared/lib/draftHtmlGate'
import {
  serializeEmailComposerHtml,
  stripComposeLineHeightWrapper
} from '@shared/lib/emailComposerHtml'
import { useAppearance } from '@shared/state/appearance'
import { plaintextToHtml } from '@shared/lib/plaintext_html'
import { splitQuoteHtml } from '@shared/lib/quoteSplit'
import { LibraryFilePickerDialog } from '@shared/components/library/LibraryFilePickerDialog'
import { desktopMacEnabled } from '@shared/navigation/useNavGates'
import { clearObjectTabDraft } from '@shared/state/tab-workspace-bridge'
import type {
  ComposeImportance,
  ComposeMode,
  ComposeWireMode,
  ContactSuggestion,
  DraftPlanResult
} from '@shared/api/types'

import { EmailBodyFrame } from '../EmailBodyFrame'
import type { ComposeTabDraft } from './composeTabDraft'
import { ComposeEditor, ComposeFormatToolbar } from './ComposeEditor'
import { DeleteDraftDialog, SendConfirmDialog, UnsavedChangesDialog } from './ComposeDialogs'
import { useComposeGuard, type ComposeGuardHandle } from './useComposeGuard'
import { buildComposeExtensions } from './editor-extensions'
import { AttachmentTray } from './AttachmentTray'
import { useComposeAttachments } from './useComposeAttachments'
import { useComposeTabSnapshot } from './useComposeTabSnapshot'
import { useComposeMutations } from './useComposeMutations'
import {
  ComposeActionHeader,
  ComposeHeaderFields,
  ComposePlanErrorBanner
} from './ComposeHeaderFields'

/** Panel mode = UI ComposeMode + 草稿编辑态 + 写新邮件态。 */
export type PanelMode = ComposeMode | 'draft-edit' | 'new'

/** onClose 的可选关闭原因（dogfood 波3）—— 只有**对象消亡**的两种关闭带原因：
 *  draft-edit 删除草稿 / 发送成功（替换语义顺带删原稿）。EmailDetail 据此收掉
 *  对应标签；普通关闭（取消编辑 / 存后关闭）不带原因，标签保留。 */
export type ComposeCloseReason = 'sent' | 'deleted'

/** "name" <a@x>, b@y; c@z → ['a@x','b@y','c@z'] —— 草稿回填 to_addr/cc_addr 提纯。 */
function parseAddrList(raw?: string | null): string[] {
  return parseAddressList(raw).map((entry) => entry.email)
}

interface Props {
  internalId: number
  mode: PanelMode
  /** 关闭回调。带 reason 的两种（'sent' / 'deleted'）= 对象消亡，EmailDetail 据此
   *  收标签；不带 reason = 普通关闭。既有 `() => void` 调用方（closeCompose 等）
   *  按参数可省略原样兼容。 */
  onClose: (reason?: ComposeCloseReason) => void
  /** 'column' (默认) = 占满 detail 列 (reply/forward/draft-edit overlay);
   *  'modal' = 居中模态卡片内 (写新邮件，外壳 ComposeNewModal 提供遮罩/卡框)。 */
  variant?: 'column' | 'modal'
  /** T6 离开守卫句柄出口 —— 外部关闭方 (新邮件浮窗 scrim·× / 标签关闭守卫) 持有此
   *  ref, 经 handle.attemptClose 走同一守卫 (dirty → 弹确认)。 */
  guardRef?: React.MutableRefObject<ComposeGuardHandle | null>
  /** mode='new' 专用：预填收件人（通讯录「写邮件」入口）。 */
  initialTo?: readonly string[]
  /** mode='new' 专用：预填抄送（WP5「写邮件并抄送上级」）。 */
  initialCc?: readonly string[]
  /** 08-27 标签工作区 —— 每标签 compose 现场快照（overlay 三模式 + draft-edit）。 */
  snapshotRef?: React.MutableRefObject<(() => ComposeTabDraft | null) | null>
  initialTabDraft?: ComposeTabDraft | null
}

/** Inner panel — keyed on (internalId, mode) by the caller so a mode switch
 *  remounts with a fresh editor + prefill instead of carrying stale state. */
export function ComposePanelInner({
  internalId,
  mode,
  onClose,
  variant = 'column',
  guardRef,
  initialTo,
  initialCc,
  snapshotRef,
  initialTabDraft
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const isDraftEdit = mode === 'draft-edit'
  const isNew = mode === 'new'
  const wireMode: ComposeWireMode = isDraftEdit || isNew ? 'new' : mode

  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  // C-1 replace 锚 (task 08-20 draft-save) — draft-edit 保存成功后服务端删旧行、
  // 建本地镜像新行, 本地锚随响应的 mirror_internal_id 换新。非 draft-edit 恒等于 internalId。
  const [draftRowId, setDraftRowId] = useState(internalId)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [importance, setImportance] = useState<ComposeImportance>('normal')
  const [ccVisible, setCcVisible] = useState(false)
  const [bccVisible, setBccVisible] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [planAttachments, setPlanAttachments] = useState(0)
  const [quoteHtml, setQuoteHtml] = useState('')
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [preserveOriginal, setPreserveOriginal] = useState(false)
  const [lineHeightChoice, setLineHeightChoice] = useState('')
  const [splitQuote, setSplitQuote] = useState(false)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  const libraryPickerAvailable = desktopMacEnabled()

  // T6 Bug C — dirty 跟踪: baseline = 预填完成 (planApplied) 之后的变更才算脏。
  const [dirty, setDirty] = useState(false)
  const baselineReadyRef = useRef(false)
  const markDirty = useCallback(() => {
    if (!baselineReadyRef.current) return
    setDirty((d) => (d ? d : true))
  }, [])
  const withDirty = useCallback(
    <T,>(setter: (value: T) => void) =>
      (value: T): void => {
        setter(value)
        markDirty()
      },
    [markDirty]
  )
  // 08-27 标签快照 —— 正文的最新 HTML 走 ref（editor 'update' 顺手记，不逼组件重渲）。
  const latestBodyHtmlRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  // @mention 选中联系人 → 不在任何收件人字段时自动加进 To (契约 D4)。
  const mentionPickRef = useRef<(contact: ContactSuggestion) => void>(() => {})
  useEffect(() => {
    mentionPickRef.current = (contact: ContactSuggestion): void => {
      const addr = contact.email.trim()
      if (!addr) return
      const lower = addr.toLowerCase()
      if ([...to, ...cc, ...bcc].some((v) => v.toLowerCase() === lower)) return
      setTo((prev) => (prev.some((v) => v.toLowerCase() === lower) ? prev : [...prev, addr]))
    }
  }, [to, cc, bcc])

  // eslint-disable-next-line react-hooks/refs -- onMentionPick 只在 suggestion 菜单选中事件触发 (纯事件时序), buildComposeExtensions 构造期不调用它; ref 间接层保证读到最新处理器。
  const [extensions] = useState(() =>
    buildComposeExtensions({ onMentionPick: (contact) => mentionPickRef.current(contact) })
  )
  const editor = useEditor({
    extensions,
    content: '',
    immediatelyRender: false
  })

  const composeLineHeightDefault = useAppearance((s) => s.composeLineHeight)
  const effectiveLineHeight = lineHeightChoice ? Number(lineHeightChoice) : composeLineHeightDefault

  const settingsQ = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  const selfEmail = settingsQ.data?.userEmail ?? null
  const signature = settingsQ.data?.signature ?? null

  const planQ = useQuery<DraftPlanResult>({
    queryKey: qk.compose.planMode(internalId, mode),
    queryFn: () => mailApi.email.draftPlan({ internalId, mode: mode as ComposeMode }),
    enabled: internalId >= 0 && !isDraftEdit,
    staleTime: Infinity,
    retry: false
  })
  const planError = planQ.isError ? asWriteError(planQ.error) : null

  const draftQ = useQuery({
    queryKey: qk.compose.draftEdit(internalId),
    queryFn: async () => {
      const [detail, body] = await Promise.all([
        mailApi.email.get(internalId),
        mailApi.email.body(internalId, { format: 'html' })
      ])
      const html = body?.content ?? ''
      let markdown = ''
      if (html.trim().length === 0) {
        const md = await mailApi.email.body(internalId, { format: 'markdown' }).catch(() => null)
        markdown = md?.content ?? ''
      }
      return { detail, html, markdown }
    },
    enabled: internalId >= 0 && isDraftEdit,
    staleTime: Infinity,
    retry: false
  })

  const detailQ = useQuery({
    queryKey: qk.email.detail(internalId),
    queryFn: () => mailApi.email.get(internalId),
    enabled: internalId >= 0 && !isDraftEdit && quoteOpen,
    staleTime: 60_000
  })
  const quoteAttachments =
    (isDraftEdit ? draftQ.data?.detail?.attachments : detailQ.data?.attachments) ?? []

  const attachments = useComposeAttachments({
    internalId,
    mode,
    initialTabDraft,
    busyRef,
    markDirty
  })
  const { hydrateDraftAttachments, restoreSnapshotAttachments, remapMirrorAttachments } =
    attachments

  // 一次性预填 (planApplied guard); editor.commands.setContent 是命令式副作用须留 effect。
  const [planApplied, setPlanApplied] = useState(false)
  useEffect(() => {
    if (planApplied || !editor) return
    if (isDraftEdit) {
      const d = draftQ.data
      if (!d) return
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 草稿数据落地时一次性回填表单 + editor.setContent 命令式副作用。React Compiler 迁移债。
      setTo(parseAddrList(d.detail?.to_addr))
      const ccArr = parseAddrList(d.detail?.cc_addr)
      setCc(ccArr)
      if (ccArr.length > 0) setCcVisible(true)
      setSubject(d.detail?.subject ?? '')
      setImportance(d.detail?.is_important ? 'high' : 'normal')
      const { reply, quote } = splitQuoteHtml(d.html)
      if (quote !== null) {
        setSplitQuote(true)
        const unwrapped = stripComposeLineHeightWrapper(reply)
        if (unwrapped.lineHeight !== null) setLineHeightChoice(String(unwrapped.lineHeight))
        const replyAssessment = assessDraftHtml(unwrapped.html)
        if (replyAssessment.compatibility === 'preserve-only') {
          setQuoteHtml(reply + quote)
          setPreserveOriginal(true)
        } else {
          setQuoteHtml(quote)
          if (replyAssessment.compatibility !== 'empty') {
            editor.commands.setContent(replyAssessment.html)
          }
        }
      } else {
        const unwrapped = stripComposeLineHeightWrapper(d.html)
        if (unwrapped.lineHeight !== null) setLineHeightChoice(String(unwrapped.lineHeight))
        const assessment = assessDraftHtml(unwrapped.html)
        if (
          assessment.compatibility === 'editable' ||
          assessment.compatibility === 'normalize-editable'
        ) {
          editor.commands.setContent(assessment.html)
        } else if (assessment.compatibility === 'preserve-only') {
          setQuoteHtml(d.html)
          setPreserveOriginal(true)
        } else if (d.markdown) {
          editor.commands.setContent(plaintextToHtml(d.markdown))
        }
      }
      if (d.detail?.attachments) {
        hydrateDraftAttachments(d.detail.attachments)
      }
      setPlanApplied(true)
      return
    }
    if (isNew) {
      if (initialTo && initialTo.length > 0) setTo([...initialTo])
      if (initialCc && initialCc.length > 0) {
        setCc([...initialCc])
        setCcVisible(true)
      }
      setPlanApplied(true)
      return
    }
    const plan = planQ.data
    if (!plan) return
    setTo(plan.to ?? [])
    setCc(plan.cc ?? [])
    setBcc(plan.bcc ?? [])
    setSubject(plan.subject ?? '')
    if ((plan.cc ?? []).length > 0) setCcVisible(true)
    if ((plan.bcc ?? []).length > 0) setBccVisible(true)
    setPlanAttachments(plan.attachments ?? 0)
    const editorHtml = mode === 'forward' ? '' : plan.reply_html || ''
    if (editorHtml) editor.commands.setContent(editorHtml)
    setQuoteHtml(plan.quote_html || plan.forward_intro_html || '')
    setPlanApplied(true)
  }, [
    planApplied,
    isDraftEdit,
    isNew,
    initialTo,
    initialCc,
    draftQ.data,
    planQ.data,
    editor,
    mode,
    hydrateDraftAttachments
  ])

  useEffect(() => {
    if (planApplied) baselineReadyRef.current = true
  }, [planApplied])

  useEffect(() => {
    if (!editor || !planApplied) return
    const onUpdate = (): void => {
      latestBodyHtmlRef.current = editor.getHTML()
      markDirty()
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, planApplied, markDirty])

  const handleRestoreTabDraft = useCallback(
    (snap: ComposeTabDraft) => {
      setTo([...snap.to])
      setCc([...snap.cc])
      setBcc([...snap.bcc])
      setSubject(snap.subject)
      setImportance(snap.importance)
      if (snap.cc.length > 0 || snap.ccVisible) setCcVisible(true)
      if (snap.bcc.length > 0 || snap.bccVisible) setBccVisible(true)
      if (snap.lineHeightChoice !== '') setLineHeightChoice(snap.lineHeightChoice)
      if (snap.attachments.length > 0 || isDraftEdit) {
        restoreSnapshotAttachments(snap.attachments)
      }
      if (isDraftEdit) {
        if (typeof snap.draftRowId === 'number') setDraftRowId(snap.draftRowId)
        if (typeof snap.lastSavedAtMs === 'number') setLastSavedAt(new Date(snap.lastSavedAtMs))
      }
      if (snap.dirty) setDirty(true)
    },
    [isDraftEdit, restoreSnapshotAttachments]
  )

  const { suppressUnmountSnapshot, schedulePostSaveSnapshot } = useComposeTabSnapshot({
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
    attachList: attachments.attachList,
    fwdAttachState: attachments.fwdAttachState,
    dirty,
    draftRowId,
    lastSavedAt,
    latestBodyHtmlRef,
    onRestore: handleRestoreTabDraft
  })

  const getSanitizedHtml = useCallback((): string => {
    const body = serializeEmailComposerHtml(editor?.getHTML() ?? '', {
      lineHeight: effectiveLineHeight
    })
    const quote = quoteHtml ? sanitizeEmailHtml(quoteHtml) : ''
    return body + quote
  }, [editor, quoteHtml, effectiveLineHeight])

  const insertSignature = useCallback(() => {
    if (!editor || !signature) return
    const html = /[<>]/.test(signature) ? signature : signature.replace(/\n/g, '<br>')
    editor.chain().focus().insertContent(html).run()
  }, [editor, signature])

  const {
    savePending,
    sendPending,
    deletePending,
    sendMutate,
    deleteMutate,
    saveDraftAsync,
    busy
  } = useComposeMutations({
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
    attachList: attachments.attachList,
    inlineRefs: attachments.inlineRefs,
    fwdAttachState: attachments.fwdAttachState,
    setDirty,
    setDraftRowId,
    setLastSavedAt,
    setSendOpen,
    remapMirrorAttachments,
    schedulePostSaveSnapshot,
    onClose
  })

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const {
    guardClose,
    handle: guardHandle,
    unsavedOpen: guardUnsavedOpen,
    saving: guardSaving,
    onSaveDraft: onGuardSave,
    onDiscard: onGuardDiscard,
    onCancel: onGuardCancel
  } = useComposeGuard({ dirty, saveDraft: saveDraftAsync })

  useEffect(() => {
    if (!guardRef) return
    guardRef.current = guardHandle
    return () => {
      if (guardRef) guardRef.current = null
    }
  }, [guardRef, guardHandle])

  const requiresRecipient = mode === 'forward' || isDraftEdit || isNew
  const sendDisabled =
    busy ||
    attachments.uploadsPending ||
    attachments.fwdAttachBlocked ||
    (requiresRecipient && to.length === 0)

  const handleSendClick = useCallback(() => {
    if (requiresRecipient && to.length === 0) {
      toastError(t('compose.toast.toRequired'))
      return
    }
    setSendOpen(true)
  }, [requiresRecipient, to.length, t])

  const handleDiscard = useCallback(() => {
    if (isDraftEdit) {
      setDeleteConfirmOpen(true)
      return
    }
    guardClose(onClose)
  }, [isDraftEdit, onClose, guardClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (sendOpen || deleteConfirmOpen || guardUnsavedOpen) return
      e.preventDefault()
      guardClose(onClose)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sendOpen, deleteConfirmOpen, guardUnsavedOpen, guardClose, onClose])

  const headerHint =
    isDraftEdit || isNew
      ? subject || t('compose.untitled')
      : planQ.isLoading
        ? t('compose.loadingPlan')
        : planQ.isError
          ? t('compose.planError')
          : subject || t('compose.untitled')

  return (
    <main
      aria-label="compose-panel"
      onDragEnter={attachments.handleDragEnter}
      onDragOver={attachments.handleDragOver}
      onDragLeave={attachments.handleDragLeave}
      onDrop={attachments.handleDrop}
      className={cn(
        'relative flex flex-col min-h-0 overflow-hidden',
        variant === 'modal' ? 'h-full' : 'flex-1 min-w-0 glass-3'
      )}
    >
      {attachments.isDragActive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[var(--r-card)] border-2 border-dashed border-coral/50 bg-coral/10"
        >
          <span className="inline-flex items-center gap-2 text-aux font-medium text-coral">
            <Paperclip size={16} strokeWidth={2} />
            {t('compose.dropHint')}
          </span>
        </div>
      )}

      <ComposeActionHeader
        isDraftEdit={isDraftEdit}
        busy={busy}
        sendDisabled={sendDisabled}
        sendPending={sendPending}
        deletePending={deletePending}
        savePending={savePending}
        uploadsPending={attachments.uploadsPending}
        fwdAttachBlocked={attachments.fwdAttachBlocked}
        lastSavedAt={lastSavedAt}
        signature={signature}
        libraryPickerAvailable={libraryPickerAvailable}
        headerHint={headerHint}
        fileInputRef={attachments.fileInputRef}
        onSendClick={handleSendClick}
        onDiscard={handleDiscard}
        onSaveDraftClick={() => {
          if (isDraftEdit) {
            saveDraftAsync().catch(() => {})
          } else {
            saveDraftAsync().then(
              () => onClose(),
              () => {}
            )
          }
        }}
        onInsertSignature={insertSignature}
        onOpenLibraryPicker={() => setLibraryPickerOpen(true)}
        onFilesSelected={attachments.handleFilesSelected}
      />

      {!isDraftEdit && planQ.isError && (
        <ComposePlanErrorBanner
          code={planError?.code ?? planError?.message ?? 'E_UNKNOWN'}
          onRetry={() => void planQ.refetch()}
        />
      )}

      <ComposeHeaderFields
        selfEmail={selfEmail}
        isNew={isNew}
        to={to}
        cc={cc}
        bcc={bcc}
        subject={subject}
        importance={importance}
        ccVisible={ccVisible}
        bccVisible={bccVisible}
        onToChange={withDirty(setTo)}
        onCcChange={withDirty(setCc)}
        onBccChange={withDirty(setBcc)}
        onSubjectChange={withDirty(setSubject)}
        onImportanceChange={withDirty(setImportance)}
        onShowCc={() => setCcVisible(true)}
        onShowBcc={() => setBccVisible(true)}
        onCollapseCc={() => {
          setCc([])
          setCcVisible(false)
          markDirty()
        }}
        onCollapseBcc={() => {
          setBcc([])
          setBccVisible(false)
          markDirty()
        }}
      />

      {editor && (
        <ComposeFormatToolbar
          editor={editor}
          lineHeight={lineHeightChoice}
          onLineHeightChange={withDirty(setLineHeightChoice)}
        />
      )}

      <div
        data-testid="compose-scroll-owner"
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col"
        style={{ scrollbarGutter: 'stable' }}
      >
        {mode === 'forward' && attachments.fwdAttachState === 'error' && (
          <div className="border-b border-ink-border/60 shrink-0 px-4 py-2.5 flex items-center gap-3 bg-fail/10">
            <div className="flex-1 text-aux text-fail">{t('compose.forwardAttachError')}</div>
            <button
              type="button"
              onClick={attachments.retryForwardAttachments}
              className="shrink-0 px-2.5 py-1.5 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1.5"
            >
              <RotateCcw size={11} strokeWidth={2} />
              {t('compose.planRetry')}
            </button>
          </div>
        )}

        {attachments.attachList.length > 0 && (
          <div className="border-b border-ink-border/60 bg-ink-2/40 shrink-0">
            <AttachmentTray
              items={attachments.attachList.map((a) => ({
                localId: a.localId,
                filename: a.filename,
                size: a.size,
                status: a.status,
                previewUrl: a.previewUrl
              }))}
              onAdd={() => attachments.fileInputRef.current?.click()}
              onRemove={attachments.removeAttachment}
            />
          </div>
        )}

        <ComposeEditor editor={editor} lineHeight={effectiveLineHeight} />

        {quoteHtml && (!isDraftEdit || preserveOriginal || splitQuote) && (
          <div className="border-t border-ink-border/60 bg-ink-2/40 shrink-0 min-h-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-1.5 pr-3">
              <button
                type="button"
                onClick={() => setQuoteOpen((v) => !v)}
                aria-expanded={quoteOpen}
                className="flex items-center gap-1.5 px-3 py-2 text-meta font-mono uppercase tracking-wider text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
              >
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className={`transition-transform duration-fast ${quoteOpen ? 'rotate-90' : ''}`}
                />
                {t(
                  isDraftEdit
                    ? preserveOriginal
                      ? 'compose.quote.original'
                      : 'compose.quote.reply'
                    : mode === 'forward'
                      ? 'compose.quote.forward'
                      : 'compose.quote.reply'
                )}
              </button>
              {isDraftEdit && preserveOriginal && (
                <span className="text-meta text-ink-fg-3 truncate">
                  {t('compose.richPreserveHint')}
                </span>
              )}
            </div>
            {quoteOpen && (
              <div className="px-3 pb-3">
                <div className="border border-ink-border-soft rounded-md bg-ink-2/40 px-4 py-3.5">
                  <EmailBodyFrame
                    internalId={internalId}
                    attachments={quoteAttachments}
                    htmlOverride={isDraftEdit ? quoteHtml : undefined}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {!isDraftEdit && mode !== 'forward' && planAttachments > 0 && (
          <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 shrink-0 text-meta font-mono text-ink-fg-2">
            {t('compose.attachmentsNote', { n: planAttachments })}
          </div>
        )}
      </div>

      <SendConfirmDialog
        open={sendOpen}
        to={to}
        cc={cc}
        bcc={bcc}
        attachments={
          (mode === 'forward' ? 0 : planAttachments) + attachments.readyAttachments.length
        }
        pending={sendPending}
        onConfirm={sendMutate}
        onCancel={() => setSendOpen(false)}
      />
      {libraryPickerAvailable && (
        <LibraryFilePickerDialog
          open={libraryPickerOpen}
          onOpenChange={setLibraryPickerOpen}
          onConfirm={attachments.addLibraryFiles}
        />
      )}
      <DeleteDraftDialog
        open={deleteConfirmOpen}
        pending={deletePending}
        onConfirm={deleteMutate}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
      <UnsavedChangesDialog
        open={guardUnsavedOpen}
        pending={guardSaving}
        onSave={onGuardSave}
        onDiscard={() => {
          if (isDraftEdit) {
            suppressUnmountSnapshot()
            clearObjectTabDraft('email', draftRowId)
          }
          onGuardDiscard()
        }}
        onCancel={onGuardCancel}
      />
    </main>
  )
}

/** Store-driven wrapper (reply / reply-all / forward overlay). 草稿编辑态由 EmailDetail
 *  直接渲染 ComposePanelInner (mode='draft-edit'), 不走此 store。 */
export function ComposePanel({
  snapshotRef,
  initialTabDraft,
  guardRef
}: {
  snapshotRef?: React.MutableRefObject<(() => ComposeTabDraft | null) | null>
  initialTabDraft?: ComposeTabDraft | null
  guardRef?: React.MutableRefObject<ComposeGuardHandle | null>
} = {}): React.ReactElement | null {
  const open = useComposeStore((s) => s.open)
  const internalId = useComposeStore((s) => s.internalId)
  const mode = useComposeStore((s) => s.mode)
  const closeCompose = useComposeStore((s) => s.closeCompose)

  if (!open || internalId === null) return null
  return (
    <ComposePanelInner
      key={`${internalId}-${mode}`}
      internalId={internalId}
      mode={mode}
      onClose={closeCompose}
      snapshotRef={snapshotRef}
      initialTabDraft={initialTabDraft}
      guardRef={guardRef}
    />
  )
}
