// Compose panel — 撰写 / 回复 / 回复所有 / 转发 / 草稿编辑 composer。
// 布局参考 Outlook: 顶部动作工具栏 (发送/放弃/[保存草稿]/签名) + From(只读)/To/
// Cc·Bcc/Subject(右侧 重要性) 表头 + 格式工具栏 + 正文 + 原文引用块。
//
// 三种数据源:
//   - reply / reply-all / forward → `email.draftPlan` (dry-run) 预填收件人 + TipTap
//     正文 (reply 建议 / forward 留空) + 折叠引用块。
//   - draft-edit (草稿点开即编辑) → `email.get` 取 to/cc/subject + `email.body(html)`
//     取正文灌进 TipTap; 顶部仅 发送/放弃(删除草稿); From 只读; 无引用块。wire mode='new'
//     (显式收件人/正文、零线程派生)。
//
// 写操作:
//   - 保存草稿 → email.draft (IMAP APPEND, re-entrant) — 仅 reply/forward。
//   - 发送 → SendConfirmDialog → email.send (SMTP, irreversible); draft-edit 发送成功后
//     删掉原草稿 (替换语义)。
//   - 放弃 → reply/forward: DiscardDialog (dirty 时) → close; draft-edit: deleteDraft → close。

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import DOMPurify from 'dompurify'
import {
  ChevronDown,
  ChevronRight,
  Flag,
  Loader2,
  PenLine,
  RotateCcw,
  Send,
  Trash2
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useComposeStore } from '@shared/state/compose'
import { sanitizeEmailHtml } from '@shared/lib/emailSanitize'
import type {
  ComposeImportance,
  ComposeMode,
  ComposeWireMode,
  DraftPlanResult
} from '@shared/api/types'

import { EmailBodyFrame } from '../EmailBodyFrame'
import { RecipientField } from './RecipientField'
import { ComposeEditor, ComposeFormatToolbar } from './ComposeEditor'
import { DiscardDialog, SendConfirmDialog } from './ComposeDialogs'

/** Panel mode = UI ComposeMode + 草稿编辑态。 */
export type PanelMode = ComposeMode | 'draft-edit'

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

/** "name" <a@x>, b@y; c@z → ['a@x','b@y','c@z'] —— 草稿回填 to_addr/cc_addr 提纯。 */
function parseAddrList(raw?: string | null): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[,;]/)) {
    const m = part.match(/<([^>]+)>/)
    const addr = (m ? m[1] : part).trim()
    if (!addr) continue
    const lower = addr.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(addr)
  }
  return out
}

const IMPORTANCE_OPTS: ReadonlyArray<{ value: ComposeImportance; key: string }> = [
  { value: 'high', key: 'compose.importanceHigh' },
  { value: 'normal', key: 'compose.importanceNormal' },
  { value: 'low', key: 'compose.importanceLow' }
]

/** 重要性下拉 — 主题行右侧 (Outlook 同位)。high 用 warn 色旗标, low 灰旗, normal 朴素。 */
function ImportanceSelect({
  value,
  onChange
}: {
  value: ComposeImportance
  onChange: (v: ComposeImportance) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const tone = value === 'high' ? 'text-warn' : value === 'low' ? 'text-ink-fg-3' : 'text-ink-fg-2'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('compose.importance')}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta font-mono',
          'hover:bg-ink-3/60 transition-colors duration-fast',
          tone
        )}
      >
        <Flag size={12} strokeWidth={2} fill={value === 'high' ? 'currentColor' : 'none'} />
        {t(IMPORTANCE_OPTS.find((o) => o.value === value)?.key ?? 'compose.importanceNormal')}
        <ChevronDown size={11} strokeWidth={2} />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-full mt-1 z-50 w-28 rounded-lg border border-ink-border bg-ink-2 shadow-md py-1"
        >
          {IMPORTANCE_OPTS.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 flex items-center gap-2 text-meta',
                  'transition-colors duration-fast hover:bg-ink-3',
                  o.value === value ? 'text-ink-fg' : 'text-ink-fg-2'
                )}
              >
                <Flag
                  size={12}
                  strokeWidth={2}
                  className={
                    o.value === 'high'
                      ? 'text-warn'
                      : o.value === 'low'
                        ? 'text-ink-fg-3'
                        : 'text-ink-fg-2'
                  }
                  fill={o.value === 'high' ? 'currentColor' : 'none'}
                />
                {t(o.key)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface Props {
  internalId: number
  mode: PanelMode
  onClose: () => void
}

/** Inner panel — keyed on (internalId, mode) by the caller so a mode switch
 *  remounts with a fresh editor + prefill instead of carrying stale state. */
export function ComposePanelInner({ internalId, mode, onClose }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const isDraftEdit = mode === 'draft-edit'
  // 草稿编辑保存/发送走 wire mode='new' (显式收件人/正文、零线程派生)。
  const wireMode: ComposeWireMode = isDraftEdit ? 'new' : mode

  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [importance, setImportance] = useState<ComposeImportance>('normal')
  const [ccVisible, setCcVisible] = useState(false)
  const [bccVisible, setBccVisible] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [planAttachments, setPlanAttachments] = useState(0)
  // 原文引用块 (reply/forward) — 与编辑器分离: 不灌进 TipTap (整条线程 HTML 几十~几百 KB 会卡 +
  // 被 ProseMirror 重排), 单独用阅读区同款安全 iframe 渲染, 发送/存草稿时拼回正文。默认收起。
  const [quoteHtml, setQuoteHtml] = useState('')
  const [quoteOpen, setQuoteOpen] = useState(false)

  const markDirty = useCallback(() => setDirty(true), [])

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content: '',
    immediatelyRender: false,
    onUpdate: markDirty
  })

  // Owner email (From, read-only) + 签名 — same query key as Sidebar / drawers.
  const settingsQ = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  const selfEmail = settingsQ.data?.userEmail ?? null
  const signature = settingsQ.data?.signature ?? null

  // 预填数据源 ① reply/forward: draftPlan (dry-run)。
  const planQ = useQuery<DraftPlanResult>({
    queryKey: ['compose', 'plan', internalId, mode],
    queryFn: () => mailApi.email.draftPlan({ internalId, mode: mode as ComposeMode }),
    enabled: internalId >= 0 && !isDraftEdit,
    staleTime: Infinity,
    retry: false
  })
  const planError = planQ.isError ? asWriteError(planQ.error) : null

  // 预填数据源 ② draft-edit: email.get (to/cc/subject/importance) + email.body html (正文)。
  const draftQ = useQuery({
    queryKey: ['compose', 'draft-edit', internalId],
    queryFn: async () => {
      const [detail, body] = await Promise.all([
        mailApi.email.get(internalId),
        mailApi.email.body(internalId, { format: 'html' })
      ])
      return { detail, html: body?.content ?? '' }
    },
    enabled: internalId >= 0 && isDraftEdit,
    staleTime: Infinity,
    retry: false
  })

  // 引用块展开时才拉原邮件 detail (reply/forward only)。
  const detailQ = useQuery({
    queryKey: ['email', internalId],
    queryFn: () => mailApi.email.get(internalId),
    enabled: internalId >= 0 && !isDraftEdit && quoteOpen,
    staleTime: 60_000
  })
  const quoteAttachments = detailQ.data?.attachments ?? []

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
      if (d.html) editor.commands.setContent(d.html)
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
    // 编辑器只载 AI 建议; forward 留空让用户写转发语。原文引用块单独折叠展示, 不进 TipTap。
    const editorHtml = mode === 'forward' ? '' : plan.reply_html || ''
    if (editorHtml) editor.commands.setContent(editorHtml)
    setQuoteHtml(plan.quote_html || plan.forward_intro_html || '')
    setPlanApplied(true)
  }, [planApplied, isDraftEdit, draftQ.data, planQ.data, editor, mode])

  // 发送/存草稿正文 = 编辑器内容 + 原文引用块 (拼回)。
  const getSanitizedHtml = useCallback((): string => {
    const body = DOMPurify.sanitize(editor?.getHTML() ?? '')
    const quote = quoteHtml ? sanitizeEmailHtml(quoteHtml) : ''
    return body + quote
  }, [editor, quoteHtml])

  // 签名插入 — 在光标处插入 settings.signature (HTML 原样, 纯文本换行转 <br>)。
  const insertSignature = useCallback(() => {
    if (!editor || !signature) return
    const html = /[<>]/.test(signature) ? signature : signature.replace(/\n/g, '<br>')
    editor.chain().focus().insertContent(html).run()
    markDirty()
  }, [editor, signature, markDirty])

  const queryClient = useQueryClient()
  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['emails'] })
    void queryClient.invalidateQueries({ queryKey: ['mailboxes'] })
  }, [queryClient])

  const composePayload = useCallback(
    () => ({
      internalId,
      mode: wireMode,
      to,
      cc,
      bcc,
      subject,
      bodyHtml: getSanitizedHtml(),
      importance
    }),
    [internalId, wireMode, to, cc, bcc, subject, getSanitizedHtml, importance]
  )

  const saveMut = useMutation({
    mutationFn: () => mailApi.email.draft(composePayload()),
    onSuccess: () => {
      toastSuccess(t('compose.toast.draftOk'))
      setDirty(false)
      invalidateLists()
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
    mutationFn: () => mailApi.email.send(composePayload()),
    onSuccess: async () => {
      toastSuccess(t('compose.toast.sendOk'))
      setSendOpen(false)
      setDirty(false)
      // draft-edit 发送成功后删掉原草稿 (替换语义: 发出的是 mode='new' 独立邮件, 原草稿仍在)。
      if (isDraftEdit) {
        try {
          await mailApi.email.deleteDraft(internalId)
        } catch {
          /* 草稿删除失败不阻断: 邮件已发出, 残留草稿用户可手动删 */
        }
        invalidateLists()
      }
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

  // 草稿编辑「放弃」= 删除草稿 (IMAP \\Deleted + 本地行清理)。
  const deleteMut = useMutation({
    mutationFn: () => mailApi.email.deleteDraft(internalId),
    onSuccess: () => {
      toastSuccess(t('compose.toast.draftDeleted'))
      invalidateLists()
      onClose()
    },
    onError: (err: unknown) => {
      const e = asWriteError(err)
      toastError(
        t('compose.toast.draftDeleteFail'),
        e.code ? `${e.code} · ${e.message}` : e.message
      )
    }
  })

  const busy = saveMut.isPending || sendMut.isPending || deleteMut.isPending

  // forward / draft-edit(new) 必须有收件人; reply/reply-all 可空 (后端推导)。
  const requiresRecipient = mode === 'forward' || isDraftEdit
  const sendDisabled = busy || (requiresRecipient && to.length === 0)

  const handleSendClick = useCallback(() => {
    if (requiresRecipient && to.length === 0) {
      toastError(t('compose.toast.toRequired'))
      return
    }
    setSendOpen(true)
  }, [requiresRecipient, to.length, t])

  const requestClose = useCallback(() => {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }, [dirty, onClose])

  // 顶部「放弃」: draft-edit → 删除草稿; reply/forward → 关闭 (dirty 时确认)。
  const handleDiscard = useCallback(() => {
    if (isDraftEdit) {
      deleteMut.mutate()
      return
    }
    requestClose()
  }, [isDraftEdit, deleteMut, requestClose])

  // ESC: draft-edit → 直接关闭 (回列表, 不删草稿); reply/forward → requestClose (dirty 确认)。
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (sendOpen || discardOpen) return
      e.preventDefault()
      if (isDraftEdit) {
        onClose()
      } else {
        requestClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sendOpen, discardOpen, isDraftEdit, onClose, requestClose])

  const headerHint = isDraftEdit
    ? subject || t('compose.untitled')
    : planQ.isLoading
      ? t('compose.loadingPlan')
      : planQ.isError
        ? t('compose.planError')
        : subject || t('compose.untitled')

  return (
    <main aria-label="compose-panel" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {/* 顶部动作工具栏 (Outlook 式) — 替代旧 mode 徽头 + 底部 send dock。 */}
      <header className="h-12 shrink-0 border-b border-ink-border/60 flex items-center gap-1.5 px-3">
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
        <button
          type="button"
          onClick={handleDiscard}
          disabled={busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
          title={isDraftEdit ? t('compose.deleteDraft') : `${t('compose.discard')} · Esc`}
        >
          {deleteMut.isPending ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Trash2 size={13} strokeWidth={2} />
          )}
          {isDraftEdit ? t('compose.deleteDraft') : t('compose.discard')}
        </button>
        {!isDraftEdit && (
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
        )}
        <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
        <button
          type="button"
          onClick={insertSignature}
          disabled={!signature || busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
          title={signature ? t('compose.signatureInsert') : t('compose.signatureEmpty')}
        >
          <PenLine size={13} strokeWidth={2} />
          {t('compose.signature')}
        </button>
        <div className="ml-auto flex items-center gap-2 min-w-0">
          <span className="text-meta text-ink-fg-2 truncate max-w-[220px]" title={headerHint}>
            {headerHint}
          </span>
        </div>
      </header>

      {/* draftPlan 失败 banner (reply/forward only) — 失败时收件人/正文都预填不上, 显式告知 + 重试。 */}
      {!isDraftEdit && planQ.isError && (
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

      {/* 收件人表头 — From(只读) / To / Cc·Bcc / Subject(右侧 重要性) */}
      <div className="border-b border-ink-border/60 shrink-0">
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
          <ImportanceSelect
            value={importance}
            onChange={(v) => {
              setImportance(v)
              markDirty()
            }}
          />
        </div>
      </div>

      {/* 格式工具栏 (主题与正文之间, Outlook 同位) */}
      {editor && <ComposeFormatToolbar editor={editor} />}

      {/* 正文 */}
      <ComposeEditor editor={editor} />

      {/* 原文引用块 (reply/forward only) — 阅读区同款安全 iframe, 发送时拼回。 */}
      {!isDraftEdit && quoteHtml && (
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

      {/* 附件提示 (reply/forward 原邮件附件不重传) */}
      {!isDraftEdit && planAttachments > 0 && (
        <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 shrink-0 text-meta font-mono text-ink-fg-2">
          {t('compose.attachmentsNote', { n: planAttachments })}
        </div>
      )}

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

/** Store-driven wrapper (reply / reply-all / forward overlay). 草稿编辑态由 EmailDetail
 *  直接渲染 ComposePanelInner (mode='draft-edit'), 不走此 store。 */
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
