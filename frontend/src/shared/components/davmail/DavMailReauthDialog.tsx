// DavMail 重新认证弹窗（task 10-28-davmail-self-reauth，design §3）。全局单实例，挂在
// RootLayout；入口（设置 → 账户、看板卡片、认证类通知）只调 `useDavMailReauthStore.openDialog()`。
//
// 流程：点「在浏览器中打开登录页」才调 start（拿会话 + 授权链接）并打开系统浏览器 → 用户登录后
// 把回调地址贴回 → complete。start 放在点击时而不是弹窗打开时：会话只有 10 分钟，用户打开弹窗
// 先读说明再动手很常见，提前建的会话多半白白过期；关掉弹窗也不会留下没用过的会话。
//
// 🔴 回调解析只以后端为准（stage=parse），前端只做 `looksLikeCallback` 粗判。
// 🔴 code / token 不进任何前端日志或 toast；失败文案用后端翻好的 message 原样展示。

import * as React from 'react'
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Info, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import type { DavMailReauthResult } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { openExternal } from '@shared/components/connectors/consoleShared'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { readableIpcError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useDavMailReauthStore } from '@shared/state/davmail-reauth'

import { formatRemaining, looksLikeCallback } from './reauthUi'

/** 授权码过期 —— 换个码也得重新走一遍登录，等同于要重新获取链接。 */
const CODE_EXPIRED = 'AADSTS70008'

interface ReauthSession {
  id: string
  url: string
  expiresAtMs: number
}

export function DavMailReauthDialog(): React.ReactElement {
  const open = useDavMailReauthStore((s) => s.open)
  const openSeq = useDavMailReauthStore((s) => s.openSeq)
  const closeDialog = useDavMailReauthStore((s) => s.closeDialog)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && closeDialog()}>
      {/* `key={openSeq}`：每次打开都是全新的会话与输入框（理由见 state/feedback.ts 同名字段）。 */}
      <DavMailReauthBody key={openSeq} onClose={closeDialog} />
    </Dialog>
  )
}

function DavMailReauthBody({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const queryClient = useQueryClient()

  const [session, setSession] = React.useState<ReauthSession | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const [callback, setCallback] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<DavMailReauthResult | null>(null)
  const [requestError, setRequestError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  // 倒计时的「此刻」：由 start 与下面的 interval 推进，render 里不直读 Date.now()。
  const [now, setNow] = React.useState(0)

  const done = result?.ok === true

  React.useEffect(() => {
    if (!session || done) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [session, done])

  const remainingMs = session ? session.expiresAtMs - now : 0
  const expired = session !== null && remainingMs <= 0
  const sessionGone = expired || result?.stage === 'session'
  const needsNewLink = sessionGone || result?.code === CODE_EXPIRED
  const canSubmit =
    session !== null && !sessionGone && !submitting && !done && looksLikeCallback(callback)

  const start = async (): Promise<void> => {
    setStarting(true)
    setStartError(null)
    setResult(null)
    setRequestError(null)
    // 旧链接换来的授权码对新会话没有意义，留着只会让人误交。
    setCallback('')
    try {
      const s = await api.davmail.startReauth()
      setSession({ id: s.session_id, url: s.authorize_url, expiresAtMs: s.expires_at * 1000 })
      setNow(Date.now())
      openExternal(s.authorize_url)
    } catch (e) {
      setStartError(readableIpcError(e))
    } finally {
      setStarting(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!session) return
    setSubmitting(true)
    setRequestError(null)
    try {
      const r = await api.davmail.completeReauth(session.id, callback)
      setResult(r)
      if (r.ok) {
        // 系统告警由同一份 davmail 健康数据派生，一起刷新，免得看板上还挂着过期提醒。
        void queryClient.invalidateQueries({ queryKey: qk.admin.davmailHealth() })
        void queryClient.invalidateQueries({ queryKey: qk.admin.systemAlerts() })
      }
    } catch (e) {
      setRequestError(readableIpcError(e))
    } finally {
      setSubmitting(false)
    }
  }

  const copyLink = (): void => {
    if (!session) return
    void navigator.clipboard.writeText(session.url).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {
        /* 剪贴板被拒 —— 不致命，用户还能点「再次打开登录页」 */
      }
    )
  }

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('davmailReauth.dialog.title')}</DialogTitle>
        <DialogDescription>{t('davmailReauth.dialog.description')}</DialogDescription>
      </DialogHeader>

      {done ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-[var(--r-card)] border border-ok/30 bg-ok/10 p-3 text-aux text-ok"
        >
          <CheckCircle2 size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{t('davmailReauth.dialog.success')}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {session === null ? (
            <Button size="sm" disabled={starting} onClick={() => void start()}>
              {starting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ExternalLink size={13} strokeWidth={2} />
              )}
              {t('davmailReauth.dialog.openLogin')}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* 同步调 openExternal：web 端 start 之后的 window.open 可能被弹窗拦截，这里补一个
                  用户手势内的入口。 */}
              <Button variant="secondary" size="sm" onClick={() => openExternal(session.url)}>
                <ExternalLink size={13} strokeWidth={2} />
                {t('davmailReauth.dialog.reopenLogin')}
              </Button>
              <Button variant="ghost" size="sm" onClick={copyLink}>
                <Copy size={13} strokeWidth={2} />
                {copied ? t('davmailReauth.dialog.copied') : t('davmailReauth.dialog.copyLink')}
              </Button>
              <span
                className={cn(
                  'ml-auto font-mono text-meta tabular-nums',
                  expired ? 'text-warn' : 'text-ink-fg-3'
                )}
              >
                {expired
                  ? t('davmailReauth.dialog.expired')
                  : t('davmailReauth.dialog.remaining', { time: formatRemaining(remainingMs) })}
              </span>
            </div>
          )}

          {startError ? (
            <ErrorBanner text={t('davmailReauth.dialog.startFailed', { error: startError })} />
          ) : null}

          <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3">
            <div className="flex items-start gap-2 text-meta leading-relaxed text-ink-fg-2">
              <Info size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              <ul className="space-y-1">
                <li>{t('davmailReauth.dialog.hintBlank')}</li>
                <li>{t('davmailReauth.dialog.hintNoCode')}</li>
                <li>{t('davmailReauth.dialog.hintTimeout')}</li>
              </ul>
            </div>
          </div>

          <div>
            <label
              htmlFor="davmail-reauth-callback"
              className="mb-1 block text-meta font-medium text-ink-fg-2"
            >
              {t('davmailReauth.dialog.callbackLabel')}
            </label>
            <textarea
              id="davmail-reauth-callback"
              value={callback}
              rows={3}
              spellCheck={false}
              onChange={(e) => setCallback(e.target.value)}
              placeholder={t('davmailReauth.dialog.callbackPlaceholder')}
              className="scrollbar-thin w-full resize-y break-all rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-2 font-mono text-meta leading-relaxed text-ink-fg outline-none placeholder:font-sans placeholder:text-ink-fg-3 focus:border-coral/50"
            />
          </div>

          {result && !result.ok ? <ErrorBanner text={result.message} /> : null}
          {requestError ? (
            <ErrorBanner text={t('davmailReauth.dialog.requestFailed', { error: requestError })} />
          ) : null}
        </div>
      )}

      <DialogFooter>
        {done ? (
          <Button size="sm" onClick={onClose}>
            {t('davmailReauth.dialog.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('davmailReauth.dialog.cancel')}
            </Button>
            {session !== null ? (
              <Button
                variant={needsNewLink ? 'default' : 'ghost'}
                size="sm"
                disabled={starting}
                data-emphasis={needsNewLink ? 'primary' : undefined}
                onClick={() => void start()}
              >
                {starting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('davmailReauth.dialog.refreshLink')}
              </Button>
            ) : null}
            <Button
              variant={needsNewLink ? 'secondary' : 'default'}
              size="sm"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('davmailReauth.dialog.submit')}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

function ErrorBanner({ text }: { text: string }): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex items-start gap-1.5 rounded-[var(--r-card)] border border-fail/30 bg-fail/10 p-3 text-aux text-fail"
    >
      <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  )
}
