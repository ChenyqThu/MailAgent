// roadmap §4.5.1-3 — DavMail backend health card for AdminPage.
//
// 直读 sync_state davmail.* keys via admin:davmailHealth IPC (better-sqlite3,
// ~1ms). Polls every 10s — matches existing AdminPage cadence; the
// 60s server-side watchdog tick is the real upper bound for staleness.
//
// Hidden entirely when watchdog hasn't ticked (enabled=false), so installs
// still on applescript backend don't see an empty card.

import { useQuery } from '@tanstack/react-query'
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
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'

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

function tokenAgeColor(age: number | null): string {
  if (age === null) return 'text-ink-fg-3'
  if (age >= 87) return 'text-fail'
  if (age >= 80) return 'text-warn'
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
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: ['admin', 'davmailHealth'],
    queryFn: () => mailApi.admin.davmailHealth(),
    staleTime: 5_000,
    refetchInterval: 10_000
  })

  if (q.isLoading || !q.data) return null
  const h = q.data
  // 未启用 davmail backend (watchdog 从没 tick) → 隐藏整张卡片
  if (!h.enabled) return null

  const lvl = levelStyles(h.level)
  const tokenColor = tokenAgeColor(h.token_age_days)
  const daysLeft = h.token_age_days !== null ? Math.max(0, 90 - h.token_age_days) : null

  return (
    <section className="space-y-3">
      <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
        <Cloud size={16} strokeWidth={1.75} className="text-cyan-400" />
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
        <div className="rounded-md border border-ink-border bg-[var(--tier-panel)] p-3">
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
        </div>

        {/* SMTP probe */}
        <div className="rounded-md border border-ink-border bg-[var(--tier-panel)] p-3">
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

        {/* OAuth token age */}
        <div className="rounded-md border border-ink-border bg-[var(--tier-panel)] p-3">
          <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1 flex items-center gap-1.5">
            <KeyRound size={11} strokeWidth={2} className={tokenColor} />
            OAuth Token
          </div>
          <div className={cn('text-lead tabular-nums', tokenColor)}>
            {h.token_age_days !== null ? `${h.token_age_days.toFixed(1)} 天` : '未知'}
          </div>
          <div className="text-meta text-ink-fg-3 mt-1">
            {daysLeft !== null ? `估剩余 ${daysLeft.toFixed(0)} / 90 天` : '—'}
          </div>
        </div>

        {/* EWS throttling + backfill state */}
        <div className="rounded-md border border-ink-border bg-[var(--tier-panel)] p-3">
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
              <div className="text-aux text-ink-fg-2 mt-2">
                可能 refresh_token 失效 — 重走 O365Manual OAuth flow 或回切
                <code className="font-mono text-ink-fg-1 mx-1">applescript</code>
                backend。
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
