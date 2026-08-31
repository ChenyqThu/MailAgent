// 快捷反馈弹窗（task 08-27-l4-tab-workspace P4a）。全局单实例，入口在设置域二级栏底部。
//
// 两步：
//   ① 填 —— 类型三选一 · 标题（必填）· 详细说明 · 复现频率（🔴 只在「问题」类出现）·
//            邮箱（选填）· 附上截图（默认勾）· 附上诊断包（默认跟随设置里那一行开关）
//   ② 确认要发什么 —— 自动带上的一行上下文 + 截图缩略图 + 诊断包里有什么。
//      🔴 这一步的两项都能撤掉，**撤掉要真的改 payload**（state 里把它置空 → submit 不传
//         那个字段），不是只改个 class。
//
// 🔴 失败可见：submit 失败一律显示「没发出去」+ 「打开表单页手动提交」的降级入口。
//    /api/v3 是 Notion 的私有 API，失效会是静默的 —— 把错误吞成一句「已提交」是这批
//    最不能出的错。
//
// 🔴 诊断包不在第一步就组装（约 1 分钟）：勾上只是记下意图，进第二步才开始组装并显示进度。

import * as React from 'react'
import { AlertTriangle, ExternalLink, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRouterState } from '@tanstack/react-router'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
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
import type { FeedbackDiagnostics, FeedbackScreenshot } from '@shared/api/types'

type Step = 'form' | 'confirm' | 'done'

function formatBytes(n: number): string {
  if (n <= 0) return '—'
  const mb = n / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export function FeedbackDialog(): React.ReactElement | null {
  const api = useMailApi()
  const open = useFeedbackStore((s) => s.open)
  const closeDialog = useFeedbackStore((s) => s.closeDialog)
  // 远程 web 没有这个面（截图 / 诊断包 / 绕 CSP 提交都要主进程），整块不挂。
  if (!api.feedback) return null
  return (
    <Dialog open={open} onOpenChange={(v) => !v && closeDialog()}>
      {/* 表单状态住在 DialogContent 里面：关掉时 radix 卸载它，下次打开天然是全新一份
          —— 不需要一个「每次 open 都 reset 十个 setState」的 effect（那是级联渲染）。 */}
      <FeedbackDialogBody onClose={closeDialog} />
    </Dialog>
  )
}

function FeedbackDialogBody({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const attachDefault = useFeedbackStore((s) => s.attachDiagnosticsDefault)
  const route = useRouterState({ select: (s) => s.location.pathname })

  const [step, setStep] = React.useState<Step>('form')
  const [kind, setKind] = React.useState<FeedbackKind>('问题')
  const [title, setTitle] = React.useState('')
  const [detail, setDetail] = React.useState('')
  const [freq, setFreq] = React.useState<FeedbackFrequency>('偶发')
  const [email, setEmail] = React.useState('')
  const [wantScreenshot, setWantScreenshot] = React.useState(true)
  const [wantDiagnostics, setWantDiagnostics] = React.useState(attachDefault)

  const [contextLine, setContextLine] = React.useState('')
  const [screenshot, setScreenshot] = React.useState<FeedbackScreenshot | null>(null)
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
        /* 取不到就留空，第二步显示 '—'；不阻断提交（提交侧自己会再算一次） */
      })
    return () => {
      cancelled = true
    }
  }, [feedback, route])

  // 组件只在 <Dialog open> 时挂载，父组件已确认 feedback 面存在；这里是类型收窄。
  if (!feedback) return <></>

  const isProblem = kind === '问题'
  const canNext = title.trim().length > 0

  /** 进第二步：这时才真去截图 / 组装诊断包（诊断包约 1 分钟，要有进度）。 */
  const goConfirm = async (): Promise<void> => {
    setError(null)
    setStep('confirm')
    if (wantScreenshot && !screenshot) {
      const shot = await feedback.capture().catch(() => null)
      setScreenshot(shot)
    }
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
        // 🔴 撤掉 = 不传字段。screenshot 为 null（用户在第二步撤掉了 / 截图失败）时
        //    这里整个键都不出现，payload 里也就没有它。
        screenshotBase64: screenshot?.dataBase64,
        diagnosticsPath: diagnostics?.path
      })
      setReceipt(res.submissionBlockId)
      setStep('done')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent className="max-w-xl">
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
          <div className="max-h-[52vh] space-y-3 overflow-y-auto scrollbar-thin pr-1">
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
                rows={5}
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

            <Field label={t('feedback.dialog.email')}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('feedback.dialog.emailPlaceholder')}
                aria-label={t('feedback.dialog.email')}
                className="w-full rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
              />
            </Field>

            <label className="flex items-center gap-2 text-aux text-ink-fg-1">
              <Checkbox checked={wantScreenshot} onCheckedChange={setWantScreenshot} />
              {t('feedback.dialog.attachScreenshot')}
            </label>
            <label className="flex items-center gap-2 text-aux text-ink-fg-1">
              <Checkbox checked={wantDiagnostics} onCheckedChange={setWantDiagnostics} />
              {t('feedback.dialog.attachDiagnostics')}
            </label>
            <p className="text-meta text-ink-fg-3">
              {t('feedback.dialog.autoContext', { context: contextLine || '…' })}
            </p>
          </div>
        ) : step === 'confirm' ? (
          <div className="max-h-[52vh] space-y-3 overflow-y-auto scrollbar-thin pr-1">
            <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3">
              <div className="text-meta font-medium text-ink-fg-2">
                {t('feedback.dialog.autoContextTitle')}
              </div>
              <div className="mt-1 font-mono text-meta text-ink-fg">{contextLine || '—'}</div>
            </div>

            <ConfirmAttachment
              title={t('feedback.dialog.screenshotTitle')}
              present={screenshot !== null}
              emptyText={
                wantScreenshot
                  ? t('feedback.dialog.screenshotFailed')
                  : t('feedback.dialog.screenshotSkipped')
              }
              onRemove={() => setScreenshot(null)}
              removeLabel={t('feedback.dialog.remove')}
            >
              {screenshot ? (
                <img
                  src={`data:${screenshot.type};base64,${screenshot.dataBase64}`}
                  alt={t('feedback.dialog.screenshotTitle')}
                  className="mt-1.5 max-h-32 rounded-md border border-ink-border-soft"
                />
              ) : null}
            </ConfirmAttachment>

            <ConfirmAttachment
              title={t('feedback.dialog.diagTitle')}
              present={diagnostics !== null}
              emptyText={
                diagBusy ? t('feedback.dialog.diagBusy') : t('feedback.dialog.diagSkipped')
              }
              onRemove={() => setDiagnostics(null)}
              removeLabel={t('feedback.dialog.remove')}
            >
              {diagnostics ? (
                <ul className="mt-1.5 space-y-0.5 text-meta text-ink-fg-2">
                  <li>{t('feedback.dialog.diagLogs')}</li>
                  <li>{t('feedback.dialog.diagRedacted')}</li>
                  <li>{t('feedback.dialog.diagExcluded')}</li>
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

/** 一项「要发出去的东西」+ 撤掉它的按钮。撤掉调用方会把对应 state 置空 → payload 真的少一项。 */
function ConfirmAttachment({
  title,
  present,
  emptyText,
  onRemove,
  removeLabel,
  children
}: {
  title: string
  present: boolean
  emptyText: string
  onRemove: () => void
  removeLabel: string
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-meta font-medium text-ink-fg-2">{title}</div>
        {present ? (
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
      {present ? children : <div className="mt-1 text-meta text-ink-fg-3">{emptyText}</div>}
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
