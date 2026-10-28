// roadmap §4.5.1-3 — DavMail backend health card for AdminPage.
//
// 直读 sync_state davmail.* keys via admin:davmailHealth IPC (better-sqlite3,
// ~1ms). Polls every 10s — matches existing AdminPage cadence; the
// 60s server-side watchdog tick is the real upper bound for staleness.
//
// Hidden entirely when watchdog hasn't ticked (enabled=false), so installs
// still on applescript backend don't see an empty card.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { qk } from '@shared/lib/queryKeys'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  KeyRound,
  Pause,
  ShieldAlert
} from 'lucide-react'

import type { DavMailHealthData } from '@shared/api/types'
import { authExpiryLabel } from '@shared/components/davmail/reauthUi'
import { Button } from '@shared/components/ui/button'
import { cn } from '@shared/lib/cn'
import { authExpiryLevel } from '@shared/lib/davmailThresholds'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useDavMailReauthStore } from '@shared/state/davmail-reauth'

function levelStyles(level: DavMailHealthData['level']): {
  pill: string
  icon: React.ReactNode
  label: string
} {
  switch (level) {
    case 'critical':
      return {
        pill: 'bg-fail/15 text-fail border-fail/30',
        icon: <ShieldAlert size={13} strokeWidth={2} />,
        label: '严重'
      }
    case 'warning':
      return {
        pill: 'bg-warn/15 text-warn border-warn/30',
        icon: <AlertTriangle size={13} strokeWidth={2} />,
        label: '警告'
      }
    case 'unknown':
      return {
        pill: 'bg-ink-fg/10 text-ink-fg-2 border-ink-border',
        icon: <AlertCircle size={13} strokeWidth={2} />,
        label: '未启动'
      }
    default:
      return {
        pill: 'bg-ok/15 text-ok border-ok/30',
        icon: <CheckCircle2 size={13} strokeWidth={2} />,
        label: '正常'
      }
  }
}

function authExpiryColor(daysLeft: number | null): string {
  if (daysLeft === null) return 'text-ink-fg-3'
  const level = authExpiryLevel(daysLeft)
  if (level === 'critical') return 'text-fail'
  if (level === 'warning') return 'text-warn'
  return 'text-ok'
}

function formatRelativeShort(iso: string | null): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export function DavMailHealthCard(): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const openReauth = useDavMailReauthStore((s) => s.openDialog)
  const q = useQuery({
    queryKey: qk.admin.davmailHealth(),
    queryFn: () => mailApi.admin.davmailHealth(),
    staleTime: 5_000,
    refetchInterval: 10_000
  })

  if (q.isLoading || !q.data) return null
  const h = q.data
  // 未启用 davmail backend (watchdog 从没 tick) → 隐藏整张卡片
  if (!h.enabled) return null

  const lvl = levelStyles(h.level)
  // 老后端不发 auth_days_left（undefined）→ 与「未记录」同样处理。
  const authDaysLeft = h.auth_days_left ?? null
  const authColor = authExpiryColor(authDaysLeft)
  // 认证类异常才把按钮提成主色：即将 / 已经过期、LOGIN 失败、或 critical 且有 OAuth 错误。
  // IMAP/SMTP 端口不通这类 critical 不算 —— 重新认证救不了进程挂掉。
  const authProblem =
    authExpiryLevel(authDaysLeft) !== null ||
    h.imap_login_ok === false ||
    (h.level === 'critical' && !!h.last_oauth_error)

  return (
    <section className="space-y-3">
      <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
        <Cloud size={16} strokeWidth={1.75} className="text-info" />
        DavMail Backend
        <span
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-meta font-mono border',
            lvl.pill
          )}
        >
          {lvl.icon}
          {lvl.label}
        </span>
        <span className="text-meta font-mono text-ink-fg-3">
          ({formatRelativeShort(h.last_probe_at)})
        </span>
      </h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* IMAP probe */}
        <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
          <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1 flex items-center gap-1.5">
            {h.imap_reachable ? (
              <Cloud size={11} strokeWidth={2} className="text-ok" />
            ) : (
              <CloudOff size={11} strokeWidth={2} className="text-fail" />
            )}
            IMAP :1143
          </div>
          <div className={cn('text-lead tabular-nums', h.imap_reachable ? 'text-ok' : 'text-fail')}>
            {h.imap_reachable ? '✓ reachable' : '✗ down'}
          </div>
          {h.consecutive_imap_failures > 0 && (
            <div className="text-aux text-ink-fg-3 mt-1">
              连续失败 {h.consecutive_imap_failures} 次
            </div>
          )}
          {/* L2a: TCP 可达但 LOGIN 失败 = token 劣化 (能发不能收) */}
          {h.imap_login_ok === false && (
            <div className="text-aux text-fail mt-1">
              LOGIN 失败
              {(h.consecutive_login_failures ?? 0) > 0 &&
                // "×2/3" tells the user how close this is to tripping critical; a bare "×2"
                // left them guessing. Both producers send the threshold now (issue #68), but an
                // older backend still won't — fall back to the bare count rather than printing
                // an assumed 3 (see DavMailHealthData).
                (h.login_fail_threshold != null
                  ? ` ×${h.consecutive_login_failures}/${h.login_fail_threshold}`
                  : ` ×${h.consecutive_login_failures}`)}
            </div>
          )}
        </div>

        {/* SMTP probe */}
        <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
          <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1 flex items-center gap-1.5">
            {h.smtp_reachable ? (
              <Cloud size={11} strokeWidth={2} className="text-ok" />
            ) : (
              <CloudOff size={11} strokeWidth={2} className="text-fail" />
            )}
            SMTP :1025
          </div>
          <div className={cn('text-lead tabular-nums', h.smtp_reachable ? 'text-ok' : 'text-fail')}>
            {h.smtp_reachable ? '✓ reachable' : '✗ down'}
          </div>
          {h.consecutive_smtp_failures > 0 && (
            <div className="text-aux text-ink-fg-3 mt-1">
              连续失败 {h.consecutive_smtp_failures} 次
            </div>
          )}
        </div>

        {/* 登录到期（最近一次交互认证 + 租户登录有效期）。token.dat 每小时随 refresh 重写，
            它的修改时间只作信息展示，不参与分级。 */}
        <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
          <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1 flex items-center gap-1.5">
            <KeyRound size={11} strokeWidth={2} className={authColor} />
            {t('davmailReauth.card.authTitle')}
          </div>
          <div
            className={cn('text-aux font-medium', authColor)}
            title={h.auth_expires_at ?? undefined}
            data-testid="davmail-auth-expiry"
          >
            {authExpiryLabel(t, authDaysLeft)}
          </div>
          <div className="text-meta text-ink-fg-3 mt-1">
            {t('davmailReauth.card.lastRefresh', {
              time: formatRelativeShort(h.token_mtime_iso)
            })}
          </div>
          <Button
            variant={authProblem ? 'default' : 'ghost'}
            size="sm"
            className="mt-2 -ml-1"
            data-emphasis={authProblem ? 'primary' : undefined}
            onClick={openReauth}
          >
            {t('davmailReauth.entry.button')}
          </Button>
        </div>

        {/* EWS throttling + backfill state */}
        <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
          <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1 flex items-center gap-1.5">
            {h.throttle_events_5min >= 3 ? (
              <AlertTriangle size={11} strokeWidth={2} className="text-warn" />
            ) : h.throttle_events_5min > 0 ? (
              <AlertTriangle size={11} strokeWidth={2} className="text-ink-fg-2" />
            ) : (
              <CheckCircle2 size={11} strokeWidth={2} className="text-ok" />
            )}
            EWS Throttle (5min)
          </div>
          <div
            className={cn(
              'text-lead tabular-nums',
              h.throttle_events_5min >= 3
                ? 'text-warn'
                : h.throttle_events_5min > 0
                  ? 'text-ink-fg'
                  : 'text-ok'
            )}
          >
            {h.throttle_events_5min} 次
          </div>
          {h.uid_backfill_paused && (
            <div className="text-aux text-warn mt-1 flex items-center gap-1">
              <Pause size={10} strokeWidth={2} />
              uid-mapper 已暂停
            </div>
          )}
        </div>
      </div>

      {/* OAuth error banner */}
      {h.last_oauth_error && (
        <div className="rounded-md border border-fail/40 bg-fail/10 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert size={14} strokeWidth={2} className="text-fail shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-aux font-medium text-fail mb-1">
                OAuth 错误
                <span className="text-meta font-mono text-ink-fg-3 ml-2">
                  {formatRelativeShort(h.last_oauth_error_at)}
                </span>
              </div>
              <pre
                className="text-meta font-mono text-ink-fg-1 whitespace-pre-wrap break-all"
                title={h.last_oauth_error}
              >
                {h.last_oauth_error}
              </pre>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-aux text-ink-fg-2">
                <span>{t('davmailReauth.card.oauthErrorHint')}</span>
                {/* 次要样式：此时登录到期格里的按钮已是主色，一屏不放两个主色按钮。 */}
                <Button variant="secondary" size="sm" onClick={openReauth}>
                  {t('davmailReauth.entry.button')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Token mtime footer (small print) */}
      {h.token_mtime_iso && (
        <div className="text-meta font-mono text-ink-fg-3">
          token.dat last refresh: <span className="text-ink-fg-2">{h.token_mtime_iso}</span>
        </div>
      )}
    </section>
  )
}
