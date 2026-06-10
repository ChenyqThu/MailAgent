// Compose panel — reply / reply-all / forward composer overlaying the detail
// column. Visuals follow mockup-compose.html + mockup-draft-composer.html
// (glass-3 surface, .folder-field-row recipients, TipTap body, format toolbar,
// send dock with the one coral CTA = 发送). No right AI rail this iteration.
//
// Lifecycle:
//   - opened via useComposeStore (toolbar split-button / future keymap)
//   - on open, `email.draftPlan` (dry-run) pre-fills to/cc/bcc/subject + the
//     TipTap body (reply: LLM reply_suggestion HTML; forward: quoted-original
//     HTML). The plan is the single pre-fill source-of-truth.
//   - 保存草稿 → email.draft (IMAP APPEND, re-entrant)
//   - 发送 → SendConfirmDialog → email.send (SMTP, irreversible)
//   - 丢弃 / ESC → DiscardDialog (only if dirty) → close

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import DOMPurify from 'dompurify'
import { ChevronRight, Loader2, RotateCcw, Send, Trash2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useComposeStore } from '@shared/state/compose'
import { sanitizeEmailHtml } from '@shared/lib/emailSanitize'
import type { ComposeMode, DraftPlanResult } from '@shared/api/types'

import { EmailBodyFrame } from '../EmailBodyFrame'
import { RecipientField } from './RecipientField'
import { ComposeEditor, ComposeFormatToolbar } from './ComposeEditor'
import { DiscardDialog, SendConfirmDialog } from './ComposeDialogs'

interface WriteErrorShape {
  code?: string
  message: string
}

function asWriteError(err: unknown): WriteErrorShape {
  if (err instanceof Error) {
    return { code: (err as Error & { code?: string }).code, message: err.message }
  }
  return { message: String(err) }
}

function modeLabelKey(mode: ComposeMode): string {
  return mode === 'reply'
    ? 'compose.modeReply'
    : mode === 'reply-all'
      ? 'compose.modeReplyAll'
      : 'compose.modeForward'
}

interface Props {
  internalId: number
  mode: ComposeMode
  onClose: () => void
}

/** Inner panel — keyed on (internalId, mode) by the wrapper so a mode switch
 *  remounts with a fresh editor + plan fetch instead of carrying stale state. */
function ComposePanelInner({ internalId, mode, onClose }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [ccVisible, setCcVisible] = useState(false)
  const [bccVisible, setBccVisible] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [planAttachments, setPlanAttachments] = useState(0)
  // 原文引用块 —— 与编辑器分离: 不灌进 TipTap (整条线程 HTML 几十~几百 KB 会卡 + 被
  // ProseMirror 重排), 单独用阅读区同款安全 iframe 渲染, 发送/存草稿时拼回正文。默认收起
  // (懒加载: detailQ 的 enabled: internalId >= 0 && quoteOpen 在收起时不触发请求, compose
  // 秒开; 发送/存草稿拼回正文用 quoteHtml state, 不依赖 quoteOpen, 收起不影响发送内容)。
  const [quoteHtml, setQuoteHtml] = useState('')
  const [quoteOpen, setQuoteOpen] = useState(false)

  const markDirty = useCallback(() => setDirty(true), [])

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content: '',
    // Electron renderer is pure CSR; disable immediatelyRender to avoid the
    // TipTap v3 SSR/StrictMode double-mount warning (same as DraftEditor).
    immediatelyRender: false,
    onUpdate: markDirty
  })

  // Owner email (From, read-only) — same query key as Sidebar / drawers.
  const settingsQ = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  const selfEmail = settingsQ.data?.userEmail ?? null

  // Pre-fill plan (email draft --dry-run). Runs once per (internalId, mode).
  const planQ = useQuery<DraftPlanResult>({
    queryKey: ['compose', 'plan', internalId, mode],
    queryFn: () => mailApi.email.draftPlan({ internalId, mode }),
    enabled: internalId >= 0,
    staleTime: Infinity,
    retry: false
  })
  // draftPlan 失败时把错误码提出来渲染成可见 banner + 重试 (而非静默空面板) —— 失败时
  // 收件人/正文都预填不上, 用户只看到空白无从判断, 必须显式告知。
  const planError = planQ.isError ? asWriteError(planQ.error) : null

  // 引用块展开时才拉原邮件 detail (拿 attachments 让 EmailBodyFrame 正确解析内联图)。
  // 与 EmailDetail 同 queryKey → 多数情况命中缓存不重复请求; 收起时不拉 = compose 秒开。
  const detailQ = useQuery({
    queryKey: ['email', internalId],
    queryFn: () => mailApi.email.get(internalId),
    enabled: internalId >= 0 && quoteOpen,
    staleTime: 60_000
  })
  const quoteAttachments = detailQ.data?.attachments ?? []

  // Apply the plan once when it lands. Setting editor content + recipients is
  // a render-driven side effect (IPC → editor command), so it lives in an
  // effect, guarded so user edits afterward aren't clobbered by a refetch.
  const [planApplied, setPlanApplied] = useState(false)
  useEffect(() => {
    if (planApplied) return
    const plan = planQ.data
    if (!plan || !editor) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- plan 落地时一次性填表单（planApplied guard）+ editor.commands.setContent 命令式副作用。后者本须留 effect（IPC→editor 命令非 render 安全）。React Compiler 迁移债。
    setTo(plan.to ?? [])
    setCc(plan.cc ?? [])
    setBcc(plan.bcc ?? [])
    setSubject(plan.subject ?? '')
    if ((plan.cc ?? []).length > 0) setCcVisible(true)
    if ((plan.bcc ?? []).length > 0) setBccVisible(true)
    setPlanAttachments(plan.attachments ?? 0)
    // 编辑器只载 AI 建议; forward 留空让用户写转发语 (reply 建议是对发件人的回复, 转发场景
    // 无意义)。原文引用块单独折叠展示, 不进 TipTap —— 修复大邮件加载慢 + 引用格式被重排。
    const editorHtml = mode === 'forward' ? '' : plan.reply_html || ''
    if (editorHtml) editor.commands.setContent(editorHtml)
    setQuoteHtml(plan.quote_html || plan.forward_intro_html || '')
    setPlanApplied(true)
  }, [planApplied, planQ.data, editor, mode])

  // 发送/存草稿正文 = 编辑器内容 + 原文引用块 (拼回)。后端收到 --body-html-file 走
  // explicit_body, 不再重建引用块 (避免重复)。引用块是原邮件 HTML, 单独 sanitize。
  const getSanitizedHtml = useCallback((): string => {
    // editor 输出来自 TipTap (schema 受限), 默认 sanitize 足够; 引用块是不可信原邮件 HTML,
    // 用与阅读区同一套硬化配置 (sanitizeEmailHtml) → 保证「折叠预览所见 = 实际发送」。
    const body = DOMPurify.sanitize(editor?.getHTML() ?? '')
    const quote = quoteHtml ? sanitizeEmailHtml(quoteHtml) : ''
    return body + quote
  }, [editor, quoteHtml])

  const saveMut = useMutation({
    mutationFn: () =>
      mailApi.email.draft({
        internalId,
        mode,
        to,
        cc,
        bcc,
        subject,
        bodyHtml: getSanitizedHtml()
      }),
    onSuccess: () => {
      toastSuccess(t('compose.toast.draftOk'))
      setDirty(false)
      onClose()
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
    mutationFn: () =>
      mailApi.email.send({
        internalId,
        mode,
        to,
        cc,
        bcc,
        subject,
        bodyHtml: getSanitizedHtml()
      }),
    onSuccess: () => {
      toastSuccess(t('compose.toast.sendOk'))
      setSendOpen(false)
      setDirty(false)
      onClose()
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

  const busy = saveMut.isPending || sendMut.isPending

  // forward requires at least one recipient (CLI E_INVALID_ARG otherwise);
  // reply/reply-all derive theirs, so an empty To is allowed there.
  const sendDisabled = busy || (mode === 'forward' && to.length === 0)

  const handleSendClick = useCallback(() => {
    if (mode === 'forward' && to.length === 0) {
      toastError(t('compose.toast.toRequired'))
      return
    }
    setSendOpen(true)
  }, [mode, to.length, t])

  const requestClose = useCallback(() => {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }, [dirty, onClose])

  // ESC closes (or asks to discard) unless a dialog is already up.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (sendOpen || discardOpen) return
      e.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sendOpen, discardOpen, requestClose])

  const subjectChars = useMemo(() => subject.length, [subject])

  return (
    <main aria-label="compose-panel" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {/* mode 徽头 */}
      <header className="h-12 shrink-0 border-b border-ink-border/60 flex items-center gap-2.5 px-4">
        <span className="text-micro font-mono uppercase tracking-wider px-2 py-1 rounded text-coral bg-coral/[0.12] border border-coral/30">
          {t(modeLabelKey(mode))}
        </span>
        <span className="text-meta text-ink-fg-2 truncate">
          {planQ.isLoading
            ? t('compose.loadingPlan')
            : planQ.isError
              ? t('compose.planError')
              : subject || t('compose.untitled')}
        </span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={requestClose}
            aria-label={t('compose.close')}
            title={`${t('compose.close')} · Esc`}
            className="w-7 h-7 rounded grid place-items-center text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      {/* draftPlan 失败 banner — 失败时收件人/正文都预填不上, 必须显式告知错误码 +
          给重试, 否则用户只看到空面板无从判断 (静默 isError 缺陷修复)。 */}
      {planQ.isError && (
        <div className="border-b border-ink-border/60 shrink-0 px-4 py-3 flex items-start gap-3 bg-fail/10">
          <div className="flex-1 text-aux text-fail">
            <div className="font-medium">{t('compose.planError')}</div>
            <div className="text-meta font-mono text-ink-fg-2 mt-0.5">
              {t('compose.planErrorHint', {
                code: planError?.code ?? planError?.message ?? 'E_UNKNOWN'
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void planQ.refetch()}
            className="shrink-0 px-2.5 py-1.5 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1.5"
          >
            <RotateCcw size={11} strokeWidth={2} />
            {t('compose.planRetry')}
          </button>
        </div>
      )}

      {/* recipients block */}
      <div className="border-b border-ink-border/60 shrink-0">
        {/* From — read-only owner account */}
        <div className="folder-field-row">
          <span className="field-label">{t('compose.from')}</span>
          <div className="flex items-center gap-2 min-w-0">
            <span className="recipient-chip">
              <span className="rc-av">
                {(selfEmail?.split('@')[0]?.slice(0, 2) ?? 'ME').toUpperCase()}
              </span>
              <span className="break-all">{selfEmail ?? t('compose.fromUnknown')}</span>
            </span>
          </div>
          <span />
        </div>

        <div className="relative">
          <RecipientField
            label={t('compose.to')}
            values={to}
            placeholder={t('compose.toPlaceholder')}
            onChange={(next) => {
              setTo(next)
              markDirty()
            }}
            selfEmail={selfEmail}
          />
          {/* Cc / Bcc reveal buttons (mockup right-aligned toggles) */}
          {(!ccVisible || !bccVisible) && (
            <div className="absolute right-3 top-2 flex items-center gap-1 text-meta font-mono text-ink-fg-2">
              {!ccVisible && (
                <button
                  type="button"
                  onClick={() => setCcVisible(true)}
                  className="px-1.5 py-0.5 rounded hover:bg-ink-3/60 hover:text-ink-fg transition-colors duration-fast"
                >
                  Cc
                </button>
              )}
              {!ccVisible && !bccVisible && <span className="text-ink-fg-3">·</span>}
              {!bccVisible && (
                <button
                  type="button"
                  onClick={() => setBccVisible(true)}
                  className="px-1.5 py-0.5 rounded hover:bg-ink-3/60 hover:text-ink-fg transition-colors duration-fast"
                >
                  Bcc
                </button>
              )}
            </div>
          )}
        </div>

        {ccVisible && (
          <RecipientField
            label={t('compose.cc')}
            values={cc}
            placeholder={t('compose.ccPlaceholder')}
            onChange={(next) => {
              setCc(next)
              markDirty()
            }}
            selfEmail={selfEmail}
          />
        )}
        {bccVisible && (
          <RecipientField
            label={t('compose.bcc')}
            values={bcc}
            placeholder={t('compose.bccPlaceholder')}
            onChange={(next) => {
              setBcc(next)
              markDirty()
            }}
            selfEmail={selfEmail}
          />
        )}

        <div className="folder-field-row">
          <span className="field-label">{t('compose.subject')}</span>
          <input
            className="text-aux font-medium"
            value={subject}
            placeholder={t('compose.subjectPlaceholder')}
            onChange={(e) => {
              setSubject(e.target.value)
              markDirty()
            }}
            aria-label={t('compose.subject')}
          />
          <span className="text-meta font-mono text-ink-fg-2">
            {t('compose.chars', { n: subjectChars })}
          </span>
        </div>
      </div>

      {/* editor body */}
      <ComposeEditor editor={editor} />

      {/* format toolbar */}
      {editor && <ComposeFormatToolbar editor={editor} />}

      {/* 原文引用块 — 与编辑器分离, 阅读区同款安全 iframe 渲染 (格式零重排), 发送时拼回。
          toggle 条复用格式工具栏同款 (border-t + bg-ink-2/40 + px-3 py-2); 展开内容套既有
          inset 卡片 (border-ink-border-soft rounded-md bg-ink-2/40, 同 ThreadSidebar) +
          内边距, 文本不再贴边。 */}
      {quoteHtml && (
        <div className="border-t border-ink-border/60 bg-ink-2/40 shrink-0 min-h-0 flex flex-col">
          <button
            type="button"
            onClick={() => setQuoteOpen((v) => !v)}
            aria-expanded={quoteOpen}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-meta font-mono uppercase tracking-wider text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
          >
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`transition-transform duration-fast ${quoteOpen ? 'rotate-90' : ''}`}
            />
            {t(mode === 'forward' ? 'compose.quote.forward' : 'compose.quote.reply')}
          </button>
          {quoteOpen && (
            <div className="min-h-0 max-h-[36vh] overflow-y-auto px-3 pb-3">
              <div className="border border-ink-border-soft rounded-md bg-ink-2/40 px-4 py-3.5">
                <EmailBodyFrame internalId={internalId} attachments={quoteAttachments} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* send dock — 发送 (coral CTA) + 保存草稿 + 丢弃 */}
      <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2.5 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleSendClick}
          disabled={sendDisabled}
          className="gbtn gbtn-primary"
          style={{ height: '34px' }}
        >
          {sendMut.isPending ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Send size={13} strokeWidth={2} />
          )}
          {t('compose.send')}
        </button>
        <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
        <button
          type="button"
          onClick={() => saveMut.mutate()}
          disabled={busy}
          className="gbtn"
          style={{ height: '34px' }}
        >
          {saveMut.isPending ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : null}
          {t('compose.saveDraft')}
        </button>
        <button
          type="button"
          onClick={requestClose}
          disabled={busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
        >
          <Trash2 size={13} strokeWidth={2} />
          {t('compose.discard')}
        </button>
        {planAttachments > 0 && (
          <span className="ml-auto text-meta font-mono text-ink-fg-2">
            {t('compose.attachmentsNote', { n: planAttachments })}
          </span>
        )}
      </div>

      <SendConfirmDialog
        open={sendOpen}
        to={to}
        cc={cc}
        bcc={bcc}
        attachments={planAttachments}
        pending={sendMut.isPending}
        onConfirm={() => sendMut.mutate()}
        onCancel={() => setSendOpen(false)}
      />
      <DiscardDialog
        open={discardOpen}
        onConfirm={() => {
          setDiscardOpen(false)
          onClose()
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </main>
  )
}

/** Store-driven wrapper. Renders null when closed; remounts the inner panel
 *  on (internalId, mode) change so a mode switch resets editor + plan. */
export function ComposePanel(): React.ReactElement | null {
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
    />
  )
}
