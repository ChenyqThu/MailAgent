// Phase 3 & Dogfood Redesign — macOS Menu Bar Popover 微面板（?tray=1 独立轻窗入口）。
// 回归 MailAgent 核心定位（邮件 · 日程 · 待办 · AI 速记）：
//   1. 顶部 AI 速记框（回车直接开 AI 会话并预填指令）+ 写新邮件 + 开主窗
//   2. 条件出现的「下一场日程」紧凑横条（无日程自动隐藏）
//   3. [ 待回复邮件 N | 未读通知 M ] 原生分段切换 + 去边框悬停高亮行
//   4. 极简同步状态底栏（刷新 / 通知设置 / 退出）

import '@shared/i18n'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Bell,
  Calendar,
  ExternalLink,
  Inbox,
  Power,
  RefreshCw,
  Settings,
  Sparkles,
  SquarePen
} from 'lucide-react'

import { ElectronApi } from '@shared/api/ElectronApi'
import { createNotificationsApi } from '@shared/api/notifications'
import type { DavMailHealthData, TodayData } from '@shared/api/types'
import type { NotificationItem, NotificationSeverity } from '@shared/api/types/notifications'
import { parseNotificationActions } from '@shared/components/notifications/navigation'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { cn } from '@shared/lib/cn'
import { bootAppearance } from '@shared/state/appearance'

type TrayAction =
  | { kind: 'openMain' }
  | { kind: 'newChat'; prompt?: string }
  | { kind: 'composeEmail' }
  | { kind: 'openToday' }
  | { kind: 'openCalendarToday' }
  | { kind: 'openSettings'; tab?: string }
  | { kind: 'openEmail'; emailId: number }
  | {
      kind: 'openNotification'
      id?: number
      payload: Record<string, unknown> | null
      action?: Record<string, unknown> | null
    }
  | { kind: 'quitApp' }

interface TraySnapshot {
  health: DavMailHealthData | null
  notifications: NotificationItem[]
  today: TodayData | null
}

function sendTrayAction(action: TrayAction): void {
  const ipc = (
    window as unknown as {
      electron?: { ipcRenderer?: { invoke(ch: string, arg: unknown): Promise<unknown> } }
    }
  ).electron?.ipcRenderer
  void ipc?.invoke('tray:action', action)
}

function healthDotClass(level: DavMailHealthData['level'] | undefined): string {
  switch (level) {
    case 'ok':
      return 'bg-ok'
    case 'warning':
      return 'bg-warn'
    case 'critical':
      return 'bg-fail'
    default:
      return 'bg-ink-fg-3'
  }
}

function notificationDotClass(severity: NotificationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'bg-fail'
    case 'warn':
      return 'bg-coral/100'
    default:
      return 'bg-info'
  }
}

function formatWaitAgeAscii(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function formatCountdownAscii(deltaMs: number): string | null {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null
  const mins = Math.ceil(deltaMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
}

export default function TrayPopoverApp(): React.ReactElement {
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(true)
  const [promptText, setPromptText] = React.useState('')
  const [feed, setFeed] = React.useState<'replies' | 'notifications'>('replies')
  const userPickedFeedRef = React.useRef(false)
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  const [snapshot, setSnapshot] = React.useState<TraySnapshot>({
    health: null,
    notifications: [],
    today: null
  })

  const mailApi = React.useMemo(() => new ElectronApi(), [])
  const notificationsApi = React.useMemo(() => createNotificationsApi(resolveApiBaseUrl()), [])

  React.useEffect((): void => {
    bootAppearance()
  }, [])

  const loadSnapshot = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [healthRes, notifRes, todayRes] = await Promise.allSettled([
        mailApi.admin.davmailHealth(),
        notificationsApi.list({ state: 'open', unreadOnly: true, limit: 8 }),
        mailApi.today.get({ replyLimit: 8 })
      ])
      const nextNotifs = notifRes.status === 'fulfilled' ? notifRes.value.items : []
      const nextToday = todayRes.status === 'fulfilled' ? todayRes.value : null
      setSnapshot({
        health: healthRes.status === 'fulfilled' ? healthRes.value : null,
        notifications: nextNotifs,
        today: nextToday
      })
      setNowMs(Date.now())
      if (!userPickedFeedRef.current) {
        const replyLen = nextToday?.reply.length ?? 0
        setFeed(replyLen === 0 && nextNotifs.length > 0 ? 'notifications' : 'replies')
      }
    } finally {
      setLoading(false)
    }
  }, [mailApi, notificationsApi])

  React.useEffect((): (() => void) => {
    void loadSnapshot()
    const ipc = (
      window as unknown as {
        electron?: {
          ipcRenderer?: {
            on(ch: string, fn: (...args: unknown[]) => void): (() => void) | void
            removeListener?(ch: string, fn: (...args: unknown[]) => void): void
          }
        }
      }
    ).electron?.ipcRenderer
    const handler = (): void => {
      userPickedFeedRef.current = false
      void loadSnapshot()
    }
    const off = ipc?.on('tray:opened', handler)
    return (): void => {
      if (typeof off === 'function') off()
      else ipc?.removeListener?.('tray:opened', handler)
    }
  }, [loadSnapshot])

  const healthLabel =
    snapshot.health == null
      ? t('tray.health.unknown', { defaultValue: '状态读取中' })
      : !snapshot.health.enabled
        ? t('tray.health.local', { defaultValue: '本地 Mail.app 模式' })
        : snapshot.health.level === 'ok'
          ? t('tray.health.ok', { defaultValue: 'DavMail 连接正常' })
          : snapshot.health.level === 'warning'
            ? t('tray.health.warning', { defaultValue: '连接波动' })
            : snapshot.health.level === 'critical'
              ? t('tray.health.critical', { defaultValue: '需重新授权或检查' })
              : t('tray.health.unknown', { defaultValue: '状态未知' })

  const nextMeeting = snapshot.today?.nextHardPoint ?? null
  const nextMeetingStartMs = nextMeeting ? Date.parse(nextMeeting.startIso) : Number.NaN
  const nextMeetingTimeLabel =
    nextMeeting && Number.isFinite(nextMeetingStartMs)
      ? nextMeeting.allDay
        ? t('today.meet.allDay', { defaultValue: '全天' })
        : new Date(nextMeetingStartMs).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit'
          })
      : null
  const nextCountdown = Number.isFinite(nextMeetingStartMs)
    ? formatCountdownAscii(nextMeetingStartMs - nowMs)
    : null

  const replies = snapshot.today?.reply ?? []
  const notifications = snapshot.notifications

  const handleQuickPromptSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = promptText.trim()
    setPromptText('')
    sendTrayAction({ kind: 'newChat', prompt: trimmed || undefined })
  }

  const pickFeed = (next: 'replies' | 'notifications'): void => {
    userPickedFeedRef.current = true
    setFeed(next)
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-ink-1/75 text-ink-fg select-none">
      {/* 1. 顶部速记栏：AI 指令输入框 + 写新邮件 + 打开主窗口 */}
      <header className="flex shrink-0 items-center gap-1.5 border-b border-ink-border-soft/80 px-3 pb-2.5 pt-3">
        <form
          onSubmit={handleQuickPromptSubmit}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2/75 px-2.5 transition-colors focus-within:border-ink-border focus-within:bg-ink-2"
        >
          <Sparkles className="size-3.5 shrink-0 text-coral" aria-hidden="true" />
          <input
            type="text"
            value={promptText}
            onChange={(e): void => setPromptText(e.target.value)}
            placeholder={t('tray.quickPromptPlaceholder', {
              defaultValue: '让 AI 查信、总结或交办…'
            })}
            aria-label={t('tray.newChat', { defaultValue: '新建对话' })}
            className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg placeholder:text-ink-fg-3 focus:outline-none"
          />
        </form>
        <button
          type="button"
          onClick={(): void => sendTrayAction({ kind: 'composeEmail' })}
          title={t('tray.composeEmail', { defaultValue: '写新邮件' })}
          aria-label={t('tray.composeEmail', { defaultValue: '写新邮件' })}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-border-soft bg-ink-2/75 text-ink-fg-1 transition-colors hover:bg-ink-3 hover:text-ink-fg"
        >
          <SquarePen className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(): void => sendTrayAction({ kind: 'openMain' })}
          title={t('tray.openApp', { defaultValue: '打开窗口' })}
          aria-label={t('tray.openApp', { defaultValue: '打开窗口' })}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-border-soft bg-ink-2/75 text-ink-fg-1 transition-colors hover:bg-ink-3 hover:text-ink-fg"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      {/* 2. 条件显示的「下一场日程」横条（无日程自动隐藏，不占空间） */}
      {nextMeeting && nextMeetingTimeLabel && (
        <button
          type="button"
          onClick={(): void => sendTrayAction({ kind: 'openCalendarToday' })}
          className="mx-3 mt-2.5 flex shrink-0 items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-left transition-colors hover:bg-coral/15"
        >
          <Calendar className="size-3.5 shrink-0 text-coral" aria-hidden="true" />
          <span className="shrink-0 font-mono text-meta font-semibold tabular-nums text-coral">
            {nextMeetingTimeLabel}
          </span>
          <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">
            {nextMeeting.title || t('today.meet.untitled', { defaultValue: '日程事件' })}
          </span>
          {nextCountdown ? (
            <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-2">
              {nextCountdown}
            </span>
          ) : (
            <span className="shrink-0 text-aux text-ink-fg-2">
              {t('tray.nextUpStarted', { defaultValue: '进行中' })}
            </span>
          )}
        </button>
      )}

      {/* 3. 原生分段切换 [ 待回复邮件 N | 未读通知 M ] */}
      <div
        role="tablist"
        aria-label={t('tray.openToday', { defaultValue: '今日待办' })}
        className="mx-3 mt-2.5 grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-ink-2/80 p-0.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={feed === 'replies'}
          onClick={(): void => pickFeed('replies')}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-aux transition-colors',
            feed === 'replies'
              ? 'bg-ink-4 font-medium text-ink-fg shadow-sm'
              : 'text-ink-fg-2 hover:text-ink-fg'
          )}
        >
          <span>{t('tray.section.pendingReplies', { defaultValue: '待回复邮件' })}</span>
          {replies.length > 0 && (
            <span className="font-mono text-meta tabular-nums text-ink-fg-2">
              {replies.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feed === 'notifications'}
          onClick={(): void => pickFeed('notifications')}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-aux transition-colors',
            feed === 'notifications'
              ? 'bg-ink-4 font-medium text-ink-fg shadow-sm'
              : 'text-ink-fg-2 hover:text-ink-fg'
          )}
        >
          <span>{t('tray.section.notifications', { defaultValue: '未读通知' })}</span>
          {notifications.length > 0 && (
            <span className="font-mono text-meta tabular-nums text-ink-fg-2">
              {notifications.length}
            </span>
          )}
        </button>
      </div>

      {/* 去边框悬浮高亮列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-thin">
        {feed === 'replies' ? (
          replies.length === 0 ? (
            <div className="flex h-full min-h-[150px] flex-col items-center justify-center gap-1.5 px-4 text-center text-ink-fg-3">
              <Inbox className="size-5 opacity-60" aria-hidden="true" />
              <span className="text-aux">
                {notifications.length === 0
                  ? t('tray.emptyAll', { defaultValue: '今日收件与提醒已清空' })
                  : t('tray.emptyReplies', { defaultValue: '今日收件已清空' })}
              </span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {replies.map((item) => {
                const age = formatWaitAgeAscii(item.waitedMs)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={(): void =>
                      sendTrayAction({ kind: 'openEmail', emailId: item.link.internalId })
                    }
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-ink-3/70"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-coral/100"
                          aria-hidden="true"
                        />
                        <span className="truncate text-aux font-medium text-ink-fg">
                          {item.meta || item.title}
                        </span>
                      </span>
                      {age && (
                        <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
                          {age}
                        </span>
                      )}
                    </div>
                    <span className="truncate pl-3.5 text-aux text-ink-fg-1">{item.title}</span>
                    {item.why && (
                      <span className="truncate pl-3.5 text-aux text-ink-fg-3">{item.why}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        ) : notifications.length === 0 ? (
          <div className="flex h-full min-h-[150px] flex-col items-center justify-center gap-1.5 px-4 text-center text-ink-fg-3">
            <Bell className="size-5 opacity-60" aria-hidden="true" />
            <span className="text-aux">
              {t('tray.emptyNotifications', { defaultValue: '暂无未读提醒' })}
            </span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {notifications.map((item) => {
              const actions = parseNotificationActions(item.payload)
              return (
                <div
                  key={item.id}
                  className="rounded-lg px-2.5 py-2 transition-colors hover:bg-ink-3/70"
                >
                  <button
                    type="button"
                    onClick={(): void =>
                      sendTrayAction({
                        kind: 'openNotification',
                        id: item.id,
                        payload: item.payload
                      })
                    }
                    className="flex w-full flex-col gap-0.5 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          notificationDotClass(item.severity)
                        )}
                      />
                      <span className="truncate text-aux font-medium text-ink-fg">{item.title}</span>
                    </div>
                    {item.body && (
                      <span className="truncate pl-3.5 text-aux text-ink-fg-2">{item.body}</span>
                    )}
                  </button>
                  {actions.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-3.5">
                      {actions.map((act, idx) => (
                        <button
                          key={`${act.id}-${idx}`}
                          type="button"
                          onClick={(): void => {
                            if (act.id === 'snooze_1h') {
                              void notificationsApi
                                .snooze(item.id, Date.now() + 3_600_000)
                                .then(() => void loadSnapshot())
                                .catch(() => {})
                              return
                            }
                            sendTrayAction({
                              kind: 'openNotification',
                              id: item.id,
                              payload: item.payload,
                              action: act as unknown as Record<string, unknown>
                            })
                          }}
                          className={cn(
                            'inline-flex items-center rounded-[var(--r-ctl)] border px-2 py-0.5 text-aux font-medium transition-colors',
                            idx === 0
                              ? 'border-coral/35 bg-coral/12 text-coral hover:bg-coral/18'
                              : 'border-ink-border bg-ink-2 text-ink-fg-1 hover:bg-ink-3'
                          )}
                        >
                          {act.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 轻量化今日入口条 */}
      <div className="flex shrink-0 items-center justify-end px-3 pb-1.5">
        <button
          type="button"
          onClick={(): void => sendTrayAction({ kind: 'openToday' })}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-aux text-ink-fg-2 transition-colors hover:text-ink-fg"
        >
          <span>{t('tray.viewAllToday', { defaultValue: '查看今日全部待办' })}</span>
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* 4. 极简底栏：同步健康点 + 刷新 / 通知设置 / 退出 */}
      <footer className="flex h-9 shrink-0 items-center justify-between border-t border-ink-border-soft/80 bg-ink-1/60 px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('size-2 shrink-0 rounded-full', healthDotClass(snapshot.health?.level))}
          />
          <span className="truncate text-aux text-ink-fg-2">{healthLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(): void => {
              void loadSnapshot()
            }}
            title={t('tray.refresh', { defaultValue: '刷新' })}
            aria-label={t('tray.refresh', { defaultValue: '刷新' })}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-fg-2 transition-colors hover:bg-ink-3 hover:text-ink-fg"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(): void => sendTrayAction({ kind: 'openSettings', tab: 'notifications' })}
            title={t('tray.settings', { defaultValue: '通知与常驻设置' })}
            aria-label={t('tray.settings', { defaultValue: '通知与常驻设置' })}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-fg-2 transition-colors hover:bg-ink-3 hover:text-ink-fg"
          >
            <Settings className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(): void => sendTrayAction({ kind: 'quitApp' })}
            title={t('tray.quit', { defaultValue: '退出 MailAgent' })}
            aria-label={t('tray.quit', { defaultValue: '退出 MailAgent' })}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-fg-2 transition-colors hover:bg-fail/15 hover:text-fail"
          >
            <Power className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  )
}
