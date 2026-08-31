// 快捷反馈弹窗（task 08-27-l4-tab-workspace P4a + 08-31 dogfood 修正）。全局单实例，
// 入口在设置域二级栏底部。
//
// 两步：
//   ① 填 —— 类型三选一 · 标题（必填）· 详细说明 · 复现频率（🔴 只在「问题」类出现）·
//            附件（图片：拖进来 / ⌘V 粘贴 / 点选，可多张；诊断包：默认跟随设置里那一行开关）·
//            邮箱（**预填当前账户邮箱**，可改）· 自动带上的运行环境（**只读但看得见**）
//   ② 确认要发什么 —— 那一行上下文 + 图片缩略图 + 诊断包里有什么。
//      🔴 这一步的每一项都能撤掉，**撤掉要真的改 payload**（state 里把它去掉 → submit 不传
//         那一项），不是只改个 class。
//
// 🔴 失败可见：submit 失败一律显示「没发出去」+ 「打开表单页手动提交」的降级入口。
//    /api/v3 是 Notion 的私有 API，失效会是静默的 —— 把错误吞成一句「已提交」是这批
//    最不能出的错。
//
// 🔴 诊断包不在第一步就组装（约 1 分钟）：勾上只是记下意图，进第二步才开始组装并显示进度。
//
// 08-31 dogfood 改了三件（owner 的原话是「都没做」，其实是「做了但看不见 / 一发就炸」）：
//   · 版本从末尾那行灰字提成独立的只读行；
//   · 邮箱预填 settings.userEmail（= 后端 .env 的 USER_EMAIL，激活账户那个）；
//   · 「截取当前屏幕」删掉 —— 它截到的恒是这个弹窗自己；图片改成拖 / 粘 / 点选。

import * as React from 'react'
import { AlertTriangle, ExternalLink, ImagePlus, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'

import { cn } from '@shared/lib/cn'
import { errorMessage, readableIpcError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useFeedbackStore } from '@shared/state/feedback'
import {
  FEEDBACK_FREQ_LABEL_KEYS,
  FEEDBACK_FREQUENCIES,
  FEEDBACK_KIND_LABEL_KEYS,
  FEEDBACK_KINDS,
  type FeedbackFrequency,
  type FeedbackKind
} from '@shared/feedback/contract'
import type { FeedbackDiagnostics, FeedbackImage } from '@shared/api/types'

type Step = 'form' | 'confirm' | 'done'

function formatBytes(n: number): string {
  if (n <= 0) return '—'
  const mb = n / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

/** File → 提交用的 base64。分块拼是因为 `String.fromCharCode(...buf)` 在几百 KB 上会爆栈。 */
async function fileToImage(file: File): Promise<FeedbackImage> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return {
    // 粘贴来的截图常常没有文件名，给一个带扩展名的（Notion 按扩展名放行，见 contract.ts）。
    name: file.name && file.name.includes('.') ? file.name : `image-${Date.now()}.png`,
    type: file.type || 'image/png',
    dataBase64: btoa(binary),
    bytes: buf.byteLength
  }
}

export function FeedbackDialog(): React.ReactElement | null {
  const api = useMailApi()
  const open = useFeedbackStore((s) => s.open)
  const openSeq = useFeedbackStore((s) => s.openSeq)
  const closeDialog = useFeedbackStore((s) => s.closeDialog)
  // 远程 web 没有这个面（诊断包 / 绕 CSP 提交都要主进程），整块不挂。
  if (!api.feedback) return null
  return (
    <Dialog open={open} onOpenChange={(v) => !v && closeDialog()}>
      {/* 🔴 `key={openSeq}` 是「下次打开是全新一份」的**唯一**依据：radix 关闭时只卸载
          portal 子树，返回 DialogContent 的这个组件一直挂着，state 会原样留下来（发完
          一条再点「发送反馈」会停在上一条的回执页，那一页只有「关闭」按钮）。
          用换 key 而不是「每次 open 都 reset 十个 setState」的 effect —— 那是级联渲染；
          也不用 `{open ? … : null}` —— 那会把关闭动画一起吃掉。 */}
      <FeedbackDialogBody key={openSeq} onClose={closeDialog} />
    </Dialog>
  )
}

function FeedbackDialogBody({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const attachDefault = useFeedbackStore((s) => s.attachDiagnosticsDefault)
  const route = useRouterState({ select: (s) => s.location.pathname })

  // 当前账户邮箱 —— settings.get() 每次读都会从 .env 的 USER_EMAIL 带上（Sidebar 的账户头
  // 用的是同一份缓存，这里不新增端点也不另存一份）。
  const { data: settings } = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => api.settings.get(),
    staleTime: 60_000
  })

  const [step, setStep] = React.useState<Step>('form')
  const [kind, setKind] = React.useState<FeedbackKind>('问题')
  const [title, setTitle] = React.useState('')
  const [detail, setDetail] = React.useState('')
  const [freq, setFreq] = React.useState<FeedbackFrequency>('偶发')
  // null = 用户还没动过它 → 显示账户邮箱。用派生值而不是 effect 回填，省掉一次级联渲染
  // （settings 是异步到的，effect 版本会在到达时把用户刚敲的字覆盖掉）。
  const [emailEdit, setEmailEdit] = React.useState<string | null>(null)
  const email = emailEdit ?? settings?.userEmail ?? ''
  const [images, setImages] = React.useState<FeedbackImage[]>([])
  const [wantDiagnostics, setWantDiagnostics] = React.useState(attachDefault)
  const [dragOver, setDragOver] = React.useState(false)

  const [contextLine, setContextLine] = React.useState('')
  const [diagnostics, setDiagnostics] = React.useState<FeedbackDiagnostics | null>(null)
  const [diagBusy, setDiagBusy] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [receipt, setReceipt] = React.useState('')

  const feedback = api.feedback

  // 「自动带上」那一行由主进程算（与真正写进 payload 的是同一个函数）—— 异步取一次。
  React.useEffect(() => {
    if (!feedback) return
    let cancelled = false
    void feedback
      .context(route)
      .then((line) => {
        if (!cancelled) setContextLine(line)
      })
      .catch(() => {
        /* 取不到就留空，界面显示 '—'；不阻断提交（提交侧自己会再算一次） */
      })
    return () => {
      cancelled = true
    }
  }, [feedback, route])

  // 组件只在 <Dialog open> 时挂载，父组件已确认 feedback 面存在；这里是类型收窄。
  if (!feedback) return <></>

  const isProblem = kind === '问题'
  const canNext = title.trim().length > 0

  const addFiles = async (files: FileList | File[] | null): Promise<void> => {
    const picked = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
    if (picked.length === 0) return
    const added = await Promise.all(picked.map(fileToImage))
    setImages((prev) => [...prev, ...added])
  }

  /** 进第二步：这时才真去组装诊断包（约 1 分钟，要有进度）。 */
  const goConfirm = async (): Promise<void> => {
    setError(null)
    setStep('confirm')
    if (wantDiagnostics && !diagnostics) {
      setDiagBusy(true)
      try {
        setDiagnostics(await feedback.diagnostics())
      } catch (e) {
        // 诊断包组装失败不阻断提交：撤掉这一项照样能发（并明说为什么没带上）。
        setError(t('feedback.dialog.diagFailed', { error: errorMessage(e) }))
        setWantDiagnostics(false)
      } finally {
        setDiagBusy(false)
      }
    }
  }

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await feedback.submit({
        kind,
        title: title.trim(),
        detail: detail.trim() || undefined,
        // 🔴 只有「问题」类才带复现频率 —— 与 contract 的判据同向（那边是最后一道）。
        freq: isProblem ? freq : undefined,
        email: email.trim() || undefined,
        route,
        // 🔴 撤掉 = 那一项真的不在 payload 里。图片全撤掉后整个键都不出现。
        images:
          images.length > 0
            ? images.map((img) => ({
                name: img.name,
                type: img.type,
                dataBase64: img.dataBase64
              }))
            : undefined,
        diagnosticsPath: diagnostics?.path
      })
      setReceipt(res.submissionBlockId)
      setStep('done')
    } catch (e) {
      setError(readableIpcError(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent
      className="max-w-2xl"
      // 粘贴挂在整个弹窗上：用户刚截完图，光标多半还在标题或说明框里。
      onPaste={(e) => void addFiles(e.clipboardData?.files ?? null)}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addFiles(e.dataTransfer?.files ?? null)
      }}
    >
      <>
        <DialogHeader>
          <DialogTitle>{t('feedback.dialog.title')}</DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? t('feedback.dialog.step1Hint')
              : step === 'confirm'
                ? t('feedback.dialog.step2Hint')
                : t('feedback.dialog.doneHint')}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="max-h-[68vh] space-y-3 overflow-y-auto scrollbar-thin pr-1">
            <Field label={t('feedback.dialog.kind')}>
              <div className="flex gap-1.5">
                {FEEDBACK_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded-[var(--r-ctl)] border px-2.5 py-1 text-aux transition-colors duration-fast',
                      kind === k
                        ? 'border-coral/40 bg-coral/15 text-coral'
                        : 'border-ink-border-soft bg-ink-2 text-ink-fg-2 hover:bg-ink-3'
                    )}
                  >
                    {t(FEEDBACK_KIND_LABEL_KEYS[k])}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t('feedback.dialog.titleField')} required>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('feedback.dialog.titlePlaceholder')}
                aria-label={t('feedback.dialog.titleField')}
                className="w-full rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
              />
            </Field>

            <Field label={t('feedback.dialog.detail')}>
              <textarea
                value={detail}
                rows={3}
                onChange={(e) => setDetail(e.target.value)}
                placeholder={t('feedback.dialog.detailPlaceholder')}
                aria-label={t('feedback.dialog.detail')}
                className="scrollbar-thin w-full resize-y rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
              />
            </Field>

            {/* 🔴 复现频率整段只在「问题」类出现：建议和咨询没有「复现」这回事。 */}
            {isProblem ? (
              <Field label={t('feedback.dialog.freq')}>
                <div className="flex gap-1.5">
                  {FEEDBACK_FREQUENCIES.map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={freq === f}
                      onClick={() => setFreq(f)}
                      className={cn(
                        'rounded-[var(--r-ctl)] border px-2.5 py-1 text-aux transition-colors duration-fast',
                        freq === f
                          ? 'border-coral/40 bg-coral/15 text-coral'
                          : 'border-ink-border-soft bg-ink-2 text-ink-fg-2 hover:bg-ink-3'
                      )}
                    >
                      {t(FEEDBACK_FREQ_LABEL_KEYS[f])}
                    </button>
                  ))}
                </div>
              </Field>
            ) : null}

            {/* 🔴 附件排在邮箱 / 运行环境**前面**是有意的：窗口最矮 600px 时下面会被裁掉，
                而这一段是 owner「以为没做」的那一段，它必须在首屏里。邮箱与运行环境被裁掉
                无所谓 —— 它们都是自动填好的，滚不滚到都不影响提交。 */}
            <Field label={t('feedback.dialog.attachments')}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-[var(--r-ctl)] border border-dashed px-3 py-2.5 text-aux transition-colors duration-fast',
                  dragOver
                    ? 'border-coral/60 bg-coral/10 text-coral'
                    : 'border-ink-border-soft bg-ink-2 text-ink-fg-2 hover:bg-ink-3'
                )}
              >
                <ImagePlus size={14} strokeWidth={2} className="shrink-0" />
                <span>{t('feedback.dialog.imagesHint')}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  aria-label={t('feedback.dialog.imagesLabel')}
                  onChange={(e) => {
                    void addFiles(e.target.files)
                    // 同一个文件连选两次也要触发 change。
                    e.target.value = ''
                  }}
                />
              </label>
              {images.length > 0 ? (
                <ImageStrip
                  images={images}
                  onRemove={(i) => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                  removeLabel={t('feedback.dialog.remove')}
                />
              ) : null}

              {/* 诊断包。🔴 它在第一步就要**看得见**（一屏之内），勾了才在第二步组装。 */}
              <div className="mt-2 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-2.5">
                <label className="flex items-start gap-2 text-aux text-ink-fg-1">
                  <Checkbox
                    className="mt-0.5"
                    checked={wantDiagnostics}
                    onCheckedChange={setWantDiagnostics}
                  />
                  <span>
                    {t('feedback.dialog.attachDiagnostics')}
                    <span className="mt-0.5 block text-meta leading-relaxed text-ink-fg-3">
                      {t('feedback.dialog.diagHelper')}
                    </span>
                  </span>
                </label>
              </div>
            </Field>

            <Field label={t('feedback.dialog.email')}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmailEdit(e.target.value)}
                placeholder={t('feedback.dialog.emailPlaceholder')}
                aria-label={t('feedback.dialog.email')}
                className="w-full rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
              />
            </Field>

            {/* 自动带上的运行环境。🔴 它是**看得见的只读行**，不是末尾一句灰字提示 ——
                owner dogfood 时正是因为看不见才以为版本号没带上。 */}
            <Field label={t('feedback.dialog.autoContextTitle')}>
              <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1 px-2.5 py-1.5 font-mono text-meta text-ink-fg-2">
                {contextLine || '—'}
              </div>
            </Field>
          </div>
        ) : step === 'confirm' ? (
          <div className="max-h-[68vh] space-y-3 overflow-y-auto scrollbar-thin pr-1">
            <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3">
              <div className="text-meta font-medium text-ink-fg-2">
                {t('feedback.dialog.autoContextTitle')}
              </div>
              <div className="mt-1 font-mono text-meta text-ink-fg">{contextLine || '—'}</div>
              <div className="mt-1 font-mono text-meta text-ink-fg">
                {email.trim() || t('feedback.dialog.emailNone')}
              </div>
            </div>

            <ConfirmAttachment
              title={t('feedback.dialog.imagesTitle', { count: images.length })}
              present={images.length > 0}
              emptyText={t('feedback.dialog.imagesSkipped')}
            >
              <ImageStrip
                images={images}
                onRemove={(i) => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                removeLabel={t('feedback.dialog.remove')}
              />
            </ConfirmAttachment>

            <ConfirmAttachment
              title={t('feedback.dialog.diagTitle')}
              present={diagnostics !== null}
              emptyText={
                diagBusy ? t('feedback.dialog.diagBusy') : t('feedback.dialog.diagSkipped')
              }
              busy={diagBusy}
              onRemove={() => setDiagnostics(null)}
              removeLabel={t('feedback.dialog.remove')}
            >
              {diagnostics ? (
                <ul className="mt-1.5 space-y-0.5 text-meta text-ink-fg-2">
                  <li>{t('feedback.dialog.diagLogs')}</li>
                  <li>{t('feedback.dialog.diagRedacted')}</li>
                  <li>{t('feedback.dialog.diagExcluded')}</li>
                  <li>{t('feedback.dialog.diagRenamed')}</li>
                  <li className="font-mono">{formatBytes(diagnostics.bytes)}</li>
                </ul>
              ) : null}
            </ConfirmAttachment>

            {error ? (
              <FailureBanner text={error} onOpenForm={() => void feedback.openForm()} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2 text-aux text-ink-fg">
            <div>{t('feedback.dialog.receipt', { id: receipt })}</div>
            {email.trim() ? (
              <div className="text-meta text-ink-fg-2">{t('feedback.dialog.receiptEmail')}</div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t('feedback.dialog.cancel')}
              </Button>
              <Button size="sm" disabled={!canNext} onClick={() => void goConfirm()}>
                {t('feedback.dialog.next')}
              </Button>
            </>
          ) : step === 'confirm' ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setStep('form')}>
                {t('feedback.dialog.back')}
              </Button>
              <Button size="sm" disabled={submitting || diagBusy} onClick={() => void submit()}>
                {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('feedback.dialog.send')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={onClose}>
              {t('feedback.dialog.close')}
            </Button>
          )}
        </DialogFooter>
      </>
    </DialogContent>
  )
}

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-meta font-medium text-ink-fg-2">
        {label}
        {required ? <span className="ml-0.5 text-coral">*</span> : null}
      </div>
      {children}
    </div>
  )
}

/** 缩略图行。撤掉某张 = 调用方把它从数组里去掉 → payload 真的少一张。 */
function ImageStrip({
  images,
  onRemove,
  removeLabel
}: {
  images: FeedbackImage[]
  onRemove: (index: number) => void
  removeLabel: string
}): React.ReactElement {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((img, i) => (
        <div key={`${img.name}-${i}`} className="relative">
          <img
            src={`data:${img.type};base64,${img.dataBase64}`}
            alt={img.name}
            className="h-20 rounded-md border border-ink-border-soft"
          />
          <button
            type="button"
            aria-label={`${removeLabel} ${img.name}`}
            onClick={() => onRemove(i)}
            className="absolute -right-1.5 -top-1.5 rounded-full border border-ink-border-soft bg-ink-1 p-0.5 text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** 一项「要发出去的东西」+ 撤掉它的按钮。撤掉调用方会把对应 state 置空 → payload 真的少一项。 */
function ConfirmAttachment({
  title,
  present,
  emptyText,
  busy,
  onRemove,
  removeLabel,
  children
}: {
  title: string
  present: boolean
  emptyText: string
  busy?: boolean
  onRemove?: () => void
  removeLabel?: string
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-meta font-medium text-ink-fg-2">{title}</div>
        {present && onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 rounded-md text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
          >
            <X size={11} strokeWidth={2.5} />
            {removeLabel}
          </button>
        ) : null}
      </div>
      {present ? (
        children
      ) : (
        <div className="mt-1 flex items-center gap-1.5 text-meta text-ink-fg-3">
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {emptyText}
        </div>
      )}
    </div>
  )
}

/** 🔴 失败必须明说「没发出去」，并给一个「打开表单页手动提交」的出口。 */
function FailureBanner({
  text,
  onOpenForm
}: {
  text: string
  onOpenForm: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="rounded-[var(--r-card)] border border-fail/30 bg-fail/10 p-3">
      <div className="flex items-start gap-1.5 text-aux text-fail">
        <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
        <span>{t('feedback.dialog.notSent', { error: text })}</span>
      </div>
      <button
        type="button"
        onClick={onOpenForm}
        className="mt-2 inline-flex items-center gap-1 rounded-md text-meta text-coral transition-opacity duration-fast hover:opacity-80"
      >
        {t('feedback.dialog.openForm')}
        <ExternalLink size={11} strokeWidth={2} />
      </button>
    </div>
  )
}
