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
//   - 放弃/删除 → reply/forward「丢弃」: 临时内容未持久化 → 直接关闭, 不确认;
//     draft-edit「删除」: 改 DB 不可逆 → DeleteDraftDialog 二次确认 → deleteDraft。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEditor } from '@tiptap/react'
import {
  ChevronDown,
  ChevronRight,
  Flag,
  Loader2,
  Paperclip,
  PenLine,
  RotateCcw,
  Send,
  Trash2,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useComposeStore } from '@shared/state/compose'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { sanitizeEmailHtml } from '@shared/lib/emailSanitize'
import { assessDraftHtml } from '@shared/lib/draftHtmlGate'
import { serializeEmailComposerHtml } from '@shared/lib/emailComposerHtml'
import { plaintextToHtml } from '@shared/lib/plaintext_html'
import { splitQuoteHtml } from '@shared/lib/quoteSplit'
import type {
  ComposeAttachmentRef,
  ComposeImportance,
  ComposeMode,
  ComposeWireMode,
  ContactSuggestion,
  DraftPlanResult
} from '@shared/api/types'

import { EmailBodyFrame } from '../EmailBodyFrame'
import { RecipientField } from './RecipientField'
import { ComposeEditor, ComposeFormatToolbar } from './ComposeEditor'
import { DeleteDraftDialog, SendConfirmDialog, UnsavedChangesDialog } from './ComposeDialogs'
import { useComposeGuard, type ComposeGuardHandle } from './useComposeGuard'
import { buildComposeExtensions } from './editor-extensions'
import { AttachmentTray, kindFromName } from './AttachmentTray'

/** Panel mode = UI ComposeMode + 草稿编辑态 + 写新邮件态。 */
export type PanelMode = ComposeMode | 'draft-edit' | 'new'

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

/** 单附件上限 — mirror 服务端 _MAX_FORWARD_ATTACH_BYTES (20MB, mail_write.py:157)。
 *  前端先拦是 UX; 服务端 staging 端点是权威复核。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** compose 附件 chip 本地态。二选一来源:
 *  - staged: 用户新上传 → staging 端点回执 stageId → payload {stage_id}
 *  - existing: draft-edit 回填的库内已有附件 → payload {attachment_id}
 *    (draft-edit 发送是 mode='new' 新邮件, 不引用原草稿附件就会丢) */
interface ComposeAttachmentChip {
  localId: number
  filename: string
  size: number | null
  status: 'uploading' | 'done' | 'error'
  stageId?: string
  attachmentId?: number
  /** staged 图片的本地缩略预览 (URL.createObjectURL); 移除/卸载时 revoke。 */
  previewUrl?: string
}

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
          'inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-meta font-mono',
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
          className="absolute right-0 top-full mt-1 z-50 w-28 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 shadow-md py-1"
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
  /** 'column' (默认) = 占满 detail 列 (reply/forward/draft-edit overlay);
   *  'modal' = 居中模态卡片内 (写新邮件，外壳 ComposeNewModal 提供遮罩/卡框)。 */
  variant?: 'column' | 'modal'
  /** T6 离开守卫句柄出口 —— 外部关闭方 (新邮件浮窗 scrim·× / EmailDetail 切邮件) 持有此
   *  ref, 经 handle.attemptClose 走同一守卫 (dirty → 弹确认)。内部 ESC/丢弃直接用
   *  guard.guardClose, 不经此 ref。 */
  guardRef?: React.MutableRefObject<ComposeGuardHandle | null>
  /** T6 —— 把 dirty 态上报给父级 (overlay: EmailDetail 切邮件时据此在渲染期同步决定
   *  是否钉住 overlay + 弹守卫; 不用 guardRef.isDirty 是因为 render 期不能读 ref)。 */
  onDirtyChange?: (dirty: boolean) => void
}

/** Inner panel — keyed on (internalId, mode) by the caller so a mode switch
 *  remounts with a fresh editor + prefill instead of carrying stale state. */
export function ComposePanelInner({
  internalId,
  mode,
  onClose,
  variant = 'column',
  guardRef,
  onDirtyChange
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const isDraftEdit = mode === 'draft-edit'
  // 写新邮件 (无源邮件): 空表单 + 显式收件人/正文。internalId 传哨兵 -1 → 下方所有
  // query 的 `internalId >= 0` 守卫天然 false → planQ/draftQ/detailQ 全跳过、不预填。
  const isNew = mode === 'new'
  // 草稿编辑 / 写新邮件 保存/发送都走 wire mode='new' (显式收件人/正文、零线程派生)。
  const wireMode: ComposeWireMode = isDraftEdit || isNew ? 'new' : mode

  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [importance, setImportance] = useState<ComposeImportance>('normal')
  const [ccVisible, setCcVisible] = useState(false)
  const [bccVisible, setBccVisible] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [planAttachments, setPlanAttachments] = useState(0)
  // 原文引用块 (reply/forward) — 与编辑器分离: 不灌进 TipTap (整条线程 HTML 几十~几百 KB 会卡 +
  // 被 ProseMirror 重排), 单独用阅读区同款安全 iframe 渲染, 发送/存草稿时拼回正文。默认收起。
  const [quoteHtml, setQuoteHtml] = useState('')
  const [quoteOpen, setQuoteOpen] = useState(false)
  // D5 — draft-edit 不可编辑富文本 (布局表/CID/VML/Outlook 汤) 保真模式: 原文整块进上面的
  // quoteHtml iframe (不灌 TipTap 防剥离), 编辑器只写顶部新增, 发送时拼回。
  const [preserveOriginal, setPreserveOriginal] = useState(false)
  // D2 Bug B — draft-edit 按 data-ma-quote marker 拆分成功: 回复段在编辑器里,
  // 引用段在下方折叠引用区 (quoteHtml), 发送时原样拼回 (marker 保留)。
  const [splitQuote, setSplitQuote] = useState(false)
  // D6 — 附件 chips (staged 上传 + draft-edit 回填 + forward hydrate 的库内已有附件)。
  const [attachList, setAttachList] = useState<ComposeAttachmentChip[]>([])
  // codex F1 — forward 原附件 hydration 状态机: 打开即补拉原邮件非 inline 附件成
  // 可移除 {attachment_id} chips (显式权威列表契约); pending/error 期间发送硬阻断,
  // error 给错误条 + 重试 (置回 'pending' 重跑 effect)。非 forward 恒 'done' 不参与。
  const [fwdAttachState, setFwdAttachState] = useState<'pending' | 'done' | 'error'>(() =>
    mode === 'forward' ? 'pending' : 'done'
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

  // T6 Bug C — dirty 跟踪: baseline = 预填完成 (planApplied) 之后的变更才算脏。
  // 预填的 setContent / setTo 等一律不标脏 —— 彻底规避 6 月「预填误标 dirty」旧坑:
  // editor 'update' 监听在 planApplied 之后才挂 (预填 setContent 发生在此之前),
  // 字段 setter 经 markDirty 且被 baselineReadyRef 二次闸住。保存/发送成功后复位。
  const [dirty, setDirty] = useState(false)
  const baselineReadyRef = useRef(false)
  const markDirty = useCallback(() => {
    if (!baselineReadyRef.current) return
    setDirty((d) => (d ? d : true))
  }, [])

  // @mention 选中联系人 → 不在任何收件人字段时自动加进 To (契约 D4)。extensions 在
  // useEditor 初始化时装配一次; 选中回调是纯事件时序 (suggestion 菜单点击/回车),
  // 经 ref 间接调用最新处理器, 闭包不过期 (react-hooks/refs: effect 里同步, 不在
  // render 期读写)。
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

  // T2 装配工厂 (editor-extensions.ts): StarterKit + TextStyle 族 + Image + Highlight
  // + Mention(@联系人) + slash 块菜单。切换后工具栏高亮走真 Highlight mark
  // (ComposeFormatToolbar 的 hasHighlight 兼容闸自动生效)。
  // eslint-disable-next-line react-hooks/refs -- onMentionPick 只在 suggestion 菜单选中事件触发 (纯事件时序), buildComposeExtensions 构造期不调用它; ref 间接层保证读到最新处理器。
  const [extensions] = useState(() =>
    buildComposeExtensions({ onMentionPick: (contact) => mentionPickRef.current(contact) })
  )
  const editor = useEditor({
    extensions,
    content: '',
    immediatelyRender: false
  })

  // Owner email (From, read-only) + 签名 — same query key as Sidebar / drawers.
  const settingsQ = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  const selfEmail = settingsQ.data?.userEmail ?? null
  const signature = settingsQ.data?.signature ?? null

  // 预填数据源 ① reply/forward: draftPlan (dry-run)。
  const planQ = useQuery<DraftPlanResult>({
    queryKey: qk.compose.planMode(internalId, mode),
    queryFn: () => mailApi.email.draftPlan({ internalId, mode: mode as ComposeMode }),
    enabled: internalId >= 0 && !isDraftEdit,
    staleTime: Infinity,
    retry: false
  })
  const planError = planQ.isError ? asWriteError(planQ.error) : null

  // 预填数据源 ② draft-edit: email.get (to/cc/subject/importance) + email.body html (正文)。
  // html 为空时再取 markdown (D5 回落: AppleScript 存量行 / dual-write 关闭期的行)。
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

  // 引用块展开时才拉原邮件 detail (reply/forward only)。draft-edit 保真模式直接用
  // draftQ 已取的 detail (同一封邮件, 不再多拉一次)。
  const detailQ = useQuery({
    queryKey: qk.email.detail(internalId),
    queryFn: () => mailApi.email.get(internalId),
    enabled: internalId >= 0 && !isDraftEdit && quoteOpen,
    staleTime: 60_000
  })
  const quoteAttachments =
    (isDraftEdit ? draftQ.data?.detail?.attachments : detailQ.data?.attachments) ?? []

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
      // D5 富文本混合门: 标准 HTML/table → 直灌编辑器; 布局表/CID/VML 等
      // preserve-only 内容 → 原文整块进折叠 iframe 保真 + 编辑器留空写新增,
      // 发送时 getSanitizedHtml 拼回 (原文只进 quoteHtml 一处, 防双份);
      // empty → markdown 回落 (plaintext 降级灌入, 不在前端造 md 渲染器)。
      // D2 Bug B — 先按 data-ma-quote marker 拆分: 回复段进编辑器 (仍过富文本混合门),
      // 引用段进折叠引用区 (发送时 getSanitizedHtml 原样拼回, marker 保留)。无 marker
      // (存量草稿 / 外部客户端草稿) → 回退现状全量分流。
      const { reply, quote } = splitQuoteHtml(d.html)
      if (quote !== null) {
        setSplitQuote(true)
        const replyAssessment = assessDraftHtml(reply)
        if (replyAssessment.compatibility === 'preserve-only') {
          // 回复段编辑器表达不了 (布局表/CID/VML 等) → 与引用段一起整块保真,
          // 编辑器留空写新增 — 零丢字节优先于可行内编辑。
          setQuoteHtml(reply + quote)
          setPreserveOriginal(true)
        } else {
          setQuoteHtml(quote)
          if (replyAssessment.compatibility !== 'empty') {
            editor.commands.setContent(replyAssessment.html)
          }
        }
      } else {
        const assessment = assessDraftHtml(d.html)
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
      // 草稿已有附件 (OWA 建的带附件草稿) → attachment_id 引用 chips: draft-edit
      // 发送是 mode='new' 新邮件, 不引用原草稿附件发出去就丢了。inline/derived 行
      // 不算 (正文内联图 / office 预转产物, 同 AttachmentList 的 visible 过滤)。
      const existing = (d.detail?.attachments ?? []).filter(
        (a) => !a.is_inline && a.derived_from == null
      )
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
      setPlanApplied(true)
      return
    }
    if (isNew) {
      // 写新邮件: 空表单, 无预填数据源 — 标记完成避免 effect 每次空跑。
      // (放在 isDraftEdit 之后: 规则只报 effect 内首个 setState, 由上面的 disable
      //  覆盖; 这里 setPlanApplied 是后续调用, 不触发规则、无需额外 disable。)
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
  }, [planApplied, isDraftEdit, isNew, draftQ.data, planQ.data, editor, mode])

  // 预填完成 → 开放 dirty 判定 (字段 setter 的 baseline 闸)。
  useEffect(() => {
    if (planApplied) baselineReadyRef.current = true
  }, [planApplied])
  // editor 内容变更 → 标脏。监听在 planApplied 之后才注册: 预填 setContent 发生在
  // planApplied 翻 true 之前, 那一刻监听尚未挂上, 故预填不会误标脏 (旧坑根因)。
  useEffect(() => {
    if (!editor || !planApplied) return
    const onUpdate = (): void => markDirty()
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, planApplied, markDirty])

  // 发送/存草稿正文 = 编辑器内容 + 原文引用块 (拼回)。
  const getSanitizedHtml = useCallback((): string => {
    const body = serializeEmailComposerHtml(editor?.getHTML() ?? '')
    const quote = quoteHtml ? sanitizeEmailHtml(quoteHtml) : ''
    return body + quote
  }, [editor, quoteHtml])

  // 签名插入 — 在光标处插入 settings.signature (HTML 原样, 纯文本换行转 <br>)。
  const insertSignature = useCallback(() => {
    if (!editor || !signature) return
    const html = /[<>]/.test(signature) ? signature : signature.replace(/\n/g, '<br>')
    editor.chain().focus().insertContent(html).run()
  }, [editor, signature])

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

  const uploadsPending = attachList.some((a) => a.status === 'uploading')
  const readyAttachments = attachList.filter((a) => a.status === 'done')

  const queryClient = useQueryClient()
  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.emails.all() })
    void queryClient.invalidateQueries({ queryKey: qk.mailboxes() })
  }, [queryClient])

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
    // D1 refs: staged → {stage_id}, 库内已有 → {attachment_id} (snake_case 契约字面)。
    const refs: ComposeAttachmentRef[] = attachList
      .filter((a) => a.status === 'done')
      .map((a) =>
        a.stageId != null ? { stage_id: a.stageId } : { attachment_id: a.attachmentId as number }
      )
    return {
      internalId,
      mode: wireMode,
      to,
      cc,
      bcc,
      subject,
      // UI 里改主题是用户明确意图 — 跳过服务层 reply 改主题断线程守卫 (守卫防 agent/CLI 误用)
      forceSubject: true,
      bodyHtml: getSanitizedHtml(),
      importance,
      ...(mode === 'forward' || refs.length > 0 ? { attachments: refs } : {}),
      // D1 Bug A — draft-edit 保存/发送带草稿行自己的 id: 服务端读该行 draft_in_reply_to/
      // draft_references/thread_id 恢复回复线程, linkage 空回退零派生 (契约 sourceDraftId)。
      ...(isDraftEdit ? { sourceDraftId: internalId } : {})
    }
  }, [
    internalId,
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
    fwdAttachState,
    t
  ])

  const saveMut = useMutation({
    mutationFn: async () => mailApi.email.draft(await buildComposePayload()),
    // 不在此处 onClose —— 关闭由调用方决定: 顶部「保存草稿」按钮存后关闭 (per-call
    // onSuccess), 离开守卫「保存草稿」存后继续原动作 (mutateAsync resolve → proceed)。
    // 存成功即 baseline 复位 (dirty=false), 守卫 mutateAsync 才能干净地续跑。
    onSuccess: () => {
      toastSuccess(t('compose.toast.draftOk'))
      invalidateLists()
      setDirty(false)
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

  // T6 Bug C — 离开守卫。saveDraft=mutateAsync (resolve=成功续跑, reject=留守)。
  // 解构出稳定成员 (guardClose/handle/回调 稳定引用, unsavedOpen/saving 是值) 供 hook 依赖。
  const saveDraftAsync = useCallback(() => saveMut.mutateAsync(), [saveMut])
  const {
    guardClose,
    handle: guardHandle,
    unsavedOpen: guardUnsavedOpen,
    saving: guardSaving,
    onSaveDraft: onGuardSave,
    onDiscard: onGuardDiscard,
    onCancel: onGuardCancel
  } = useComposeGuard({ dirty, saveDraft: saveDraftAsync })
  // 把守卫句柄挂到外部关闭方传入的 ref (新邮件浮窗 scrim·× / EmailDetail 切邮件),
  // 让它们经同一守卫走; 内部 ESC/丢弃直接调 guardClose。handle 引用稳定, 只挂一次。
  useEffect(() => {
    if (!guardRef) return
    guardRef.current = guardHandle
    return () => {
      if (guardRef) guardRef.current = null
    }
  }, [guardRef, guardHandle])
  // 上报 dirty 给父级 (overlay 场景 EmailDetail 用它做切邮件的渲染期拦截决定)。
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const busy = saveMut.isPending || sendMut.isPending || deleteMut.isPending

  // L0 — 拖拽附件事件面: 只认真实文件拖入 (types 含 'Files'); 文本/HTML 拖拽不激活、
  // 不 preventDefault → 落回 TipTap 原生行为。drop 复用 handleFilesSelected 管线
  // (20MB 校验 → staging 上传 → chip), 零逻辑复制。busy 时不收 (对齐附件按钮 disabled)。
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (busy || !e.dataTransfer.types.includes('Files')) return
      dragDepth.current += 1
      setIsDragActive(true)
    },
    [busy]
  )
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (busy || !e.dataTransfer.types.includes('Files')) return
      // preventDefault = 声明本区域可 drop (Chromium 默认 = 拒收/导航)。
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [busy]
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
      if (busy || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      handleFilesSelected(e.dataTransfer.files)
    },
    [busy, handleFilesSelected]
  )

  // forward / draft-edit / 写新邮件 必须有收件人; reply/reply-all 可空 (后端推导)。
  // 附件上传中也不许发/存 (stage_id 未回执, 发出去就丢附件)。
  const requiresRecipient = mode === 'forward' || isDraftEdit || isNew
  // codex F1 — forward 原附件未 hydrate 成功 (pending/error) 期间发/存硬阻断,
  // 权威列表不完整就发会静默丢原附件。
  const fwdAttachBlocked = mode === 'forward' && fwdAttachState !== 'done'
  const sendDisabled =
    busy || uploadsPending || fwdAttachBlocked || (requiresRecipient && to.length === 0)

  const handleSendClick = useCallback(() => {
    if (requiresRecipient && to.length === 0) {
      toastError(t('compose.toast.toRequired'))
      return
    }
    setSendOpen(true)
  }, [requiresRecipient, to.length, t])

  // 顶部「放弃/删除」: reply/forward 的「丢弃」经离开守卫 —— 有未保存更改 (dirty) 才
  // 弹 UnsavedChangesDialog, 否则直接关闭 (预填不标脏 → 刚打开即丢弃不会误弹)。draft-edit
  // 的「删除」= 改 DB (IMAP \\Deleted + 本地行清理), 不可逆 → 仍走 DeleteDraftDialog 二次确认。
  const handleDiscard = useCallback(() => {
    if (isDraftEdit) {
      setDeleteConfirmOpen(true)
      return
    }
    guardClose(onClose)
  }, [isDraftEdit, onClose, guardClose])

  // ESC: 经离开守卫关闭 (dirty 弹确认, 否则直接关)。守卫弹窗已开时 ESC 交给 Radix
  // (onOpenChange → onCancel), 此处 bail 防重复触发。
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
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        // L0 — relative: 拖拽 drop 提示层 (absolute inset-0) 的定位上下文。
        'relative flex flex-col min-h-0 overflow-hidden',
        // column: 占满 detail 列 (glass-3 半透明作列背景)。
        // modal: 撑满 ComposeNewModal 卡片 (背景/圆角/阴影由外壳给, 这里只布局)。
        variant === 'modal' ? 'h-full' : 'flex-1 min-w-0 glass-3'
      )}
    >
      {/* L0 — 文件拖入提示层。pointer-events-none 让 drag/drop 事件全部落在
          <main> 本体 (提示层不吞事件、不扰动 dragDepth 计数); accent 低透明浮层
          配方 (bg/描边走 --c-accent token), 圆角走 --r-card 档。 */}
      {isDragActive && (
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
            onClick={() => saveMut.mutate(undefined, { onSuccess: () => onClose() })}
            disabled={busy || uploadsPending || fwdAttachBlocked}
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
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
          title={t('compose.attach')}
        >
          <Paperclip size={13} strokeWidth={2} />
          {t('compose.attach')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label={t('compose.attach')}
          onChange={(e) => {
            handleFilesSelected(e.currentTarget.files)
            // 清空 value 让同一文件可重复选择 (删了再加回)。
            e.currentTarget.value = ''
          }}
        />
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
            excludeEmails={[...cc, ...bcc]}
            autoFocus={isNew}
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
          <div className="relative">
            <RecipientField
              label={t('compose.cc')}
              values={cc}
              placeholder={t('compose.ccPlaceholder')}
              onChange={(next) => {
                setCc(next)
                markDirty()
              }}
              selfEmail={selfEmail}
              excludeEmails={[...to, ...bcc]}
            />
            {/* × 收起并清空 (design/app.jsx ComposeFields cmp-fieldx)。 */}
            <button
              type="button"
              aria-label={t('compose.ccCollapse')}
              title={t('compose.ccCollapse')}
              onClick={() => {
                setCc([])
                setCcVisible(false)
                markDirty()
              }}
              className="absolute right-3 top-2.5 p-1 rounded-[var(--r-ctl)] text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        )}
        {bccVisible && (
          <div className="relative">
            <RecipientField
              label={t('compose.bcc')}
              values={bcc}
              placeholder={t('compose.bccPlaceholder')}
              onChange={(next) => {
                setBcc(next)
                markDirty()
              }}
              selfEmail={selfEmail}
              excludeEmails={[...to, ...cc]}
            />
            <button
              type="button"
              aria-label={t('compose.bccCollapse')}
              title={t('compose.bccCollapse')}
              onClick={() => {
                setBcc([])
                setBccVisible(false)
                markDirty()
              }}
              className="absolute right-3 top-2.5 p-1 rounded-[var(--r-ctl)] text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
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

      {/* 单一纵向滚动所有者：附件、正文与引用共同受 composer 视口约束。 */}
      <div
        data-testid="compose-scroll-owner"
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col"
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* 原附件权威列表加载失败时优先露出重试入口，避免被长正文推到滚动区底部。 */}
        {mode === 'forward' && fwdAttachState === 'error' && (
          <div className="border-b border-ink-border/60 shrink-0 px-4 py-2.5 flex items-center gap-3 bg-fail/10">
            <div className="flex-1 text-aux text-fail">{t('compose.forwardAttachError')}</div>
            <button
              type="button"
              onClick={() => setFwdAttachState('pending')}
              className="shrink-0 px-2.5 py-1.5 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1.5"
            >
              <RotateCcw size={11} strokeWidth={2} />
              {t('compose.planRetry')}
            </button>
          </div>
        )}

        {/* D6/T3 — 附件架置于主题/格式栏下方、正文上方。默认只展示两行，展开后
            仍由本滚动区承接，不再以 shrink-0 行数把 composer 撑穿外层。 */}
        {attachList.length > 0 && (
          <div className="border-b border-ink-border/60 bg-ink-2/40 shrink-0">
            <AttachmentTray
              items={attachList.map((a) => ({
                localId: a.localId,
                filename: a.filename,
                size: a.size,
                status: a.status,
                previewUrl: a.previewUrl
              }))}
              onAdd={() => fileInputRef.current?.click()}
              onRemove={removeAttachment}
            />
          </div>
        )}

        {/* 正文 */}
        <ComposeEditor editor={editor} />

        {/* 原文引用块 — reply/forward 的引用原文, 或 draft-edit 保真模式的原草稿富文本。 */}
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
                  {/* draft-edit: 引用区只展示 quoteHtml 段 (htmlOverride), 不按 id 重拉全文 —
                    marker 拆分后编辑器已有回复段, 全文渲染会视觉重复。reply/forward 维持
                    现状按原邮件 id 取正文。 */}
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

        {/* 附件提示 (reply 原邮件附件不重传)。 */}
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
        // forward 原附件已 hydrate 进 readyAttachments (F1), 再加 planAttachments
        // 会双重计数; reply 维持现状 (planAttachments 是"不重传"提示对应的原附件数)。
        attachments={(mode === 'forward' ? 0 : planAttachments) + readyAttachments.length}
        pending={sendMut.isPending}
        onConfirm={() => sendMut.mutate()}
        onCancel={() => setSendOpen(false)}
      />
      <DeleteDraftDialog
        open={deleteConfirmOpen}
        pending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
      <UnsavedChangesDialog
        open={guardUnsavedOpen}
        pending={guardSaving}
        onSave={onGuardSave}
        onDiscard={onGuardDiscard}
        onCancel={onGuardCancel}
      />
    </main>
  )
}

/** Store-driven wrapper (reply / reply-all / forward overlay). 草稿编辑态由 EmailDetail
 *  直接渲染 ComposePanelInner (mode='draft-edit'), 不走此 store。guardRef 由 EmailDetail
 *  传入, 让切邮件时能经离开守卫拦截 (T6)。 */
export function ComposePanel({
  guardRef,
  onDirtyChange
}: {
  guardRef?: React.MutableRefObject<ComposeGuardHandle | null>
  onDirtyChange?: (dirty: boolean) => void
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
      guardRef={guardRef}
      onDirtyChange={onDirtyChange}
    />
  )
}
