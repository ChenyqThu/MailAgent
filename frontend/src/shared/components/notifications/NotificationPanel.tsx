// 通知面板内容（task 08-20-notification-center 步骤 7；design §6.3，视觉基线 = owner
// 拍板的 mockup「MailAgent 通知中心」Main/Empty）。
//
// 壳（portal / theme-popover 几何 / 出入场动画）在 `NotificationBellBadge.tsx`，这里只画内容：
//   Header（kicker + 标题 + 未读 chip + 全部标为已读） → 列表（按本地时区分「今天/昨天/更早」）
//   → 空态。
// M1 **不渲染 tab 行**（design §6.3：5 tab 是 M2；mockup 画的是终局形态）。分日、相对时间、
// 图标/色调映射全是纯前端呈现逻辑 —— 后端 list 契约不变、不加分组参数。

import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  FileText,
  Info,
  ShieldAlert,
  SquarePen
} from 'lucide-react'

import type { NotificationCategory, NotificationItem } from '@shared/api/types/notifications'
import { cn } from '@shared/lib/cn'
import { ageLabel } from '@shared/lib/ageLabel'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotificationList } from './hooks'
import { resolveNotificationLink } from './navigation'
import { RELATIVE_WINDOW_MS, groupByDay } from './notificationModel'

type Tone = 'coral' | 'ai' | 'ok' | 'fail' | 'info'

/** 色调 → 三处 class（图标容器未读/已读、计次 chip）。静态字面量，Tailwind 扫得到。 */
const TONE_CLASS: Record<Tone, { icon: string; iconRead: string; chip: string }> = {
  coral: {
    icon: 'bg-coral/12 text-coral',
    iconRead: 'bg-coral/10 text-coral/75',
    chip: 'bg-coral/12 text-coral border-coral/40'
  },
  ai: {
    icon: 'bg-ai/12 text-ai',
    iconRead: 'bg-ai/10 text-ai/75',
    chip: 'bg-ai/12 text-ai border-ai/40'
  },
  ok: {
    icon: 'bg-ok/12 text-ok',
    iconRead: 'bg-ok/10 text-ok/75',
    chip: 'bg-ok/12 text-ok border-ok/40'
  },
  fail: {
    icon: 'bg-fail/12 text-fail',
    iconRead: 'bg-fail/10 text-fail/75',
    chip: 'bg-fail/12 text-fail border-fail/40'
  },
  info: {
    icon: 'bg-info/12 text-info',
    iconRead: 'bg-info/10 text-info/75',
    chip: 'bg-info/12 text-info border-info/40'
  }
}

const CATEGORY_META: Record<NotificationCategory, { Icon: typeof Bell; tone: Tone }> = {
  action_required: { Icon: ShieldAlert, tone: 'coral' },
  reviews: { Icon: SquarePen, tone: 'ai' },
  results: { Icon: FileText, tone: 'ok' },
  system: { Icon: AlertTriangle, tone: 'fail' }
}

/** 图标 + 色调按 category 走（mockup 的四种处理），唯一例外是 system + info：告警是红三角，
 *  可 system 类目里也有纯知会（更新就绪等 M2 信源），红三角会误报严重度 → 蓝 Info。 */
function metaOf(item: NotificationItem): { Icon: typeof Bell; tone: Tone } {
  if (item.category === 'system' && item.severity === 'info') return { Icon: Info, tone: 'info' }
  return CATEGORY_META[item.category]
}

function NotificationRow({
  item,
  nowMs,
  onActivate
}: {
  item: NotificationItem
  /** 由面板统一注入的「此刻」（见 NotificationPanel 里 nowMs 的取法）—— 逐行各读一次
   *  `Date.now()` 会让同一屏的相对时间基准不一致，也过不了 react-hooks/purity。 */
  nowMs: number
  onActivate(item: NotificationItem): void
}): React.ReactElement {
  const { t } = useTranslation()
  const { Icon, tone } = metaOf(item)
  const unread = item.readAt == null
  const toneClass = TONE_CLASS[tone]
  const age = nowMs - item.lastEventAt
  const time =
    age < RELATIVE_WINDOW_MS
      ? ageLabel(t, age)
      : new Date(item.lastEventAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit'
        })

  return (
    <button
      type="button"
      onClick={() => onActivate(item)}
      className={cn(
        'w-full flex gap-2.5 px-4 py-2.5 text-left border-b border-[var(--hairline)]',
        'last:border-b-0 transition-colors duration-fast hover:bg-ink-3'
      )}
    >
      <span
        className={cn(
          'relative w-[26px] h-[26px] mt-px shrink-0 rounded-lg flex items-center justify-center',
          unread ? toneClass.icon : toneClass.iconRead
        )}
      >
        <Icon size={14} strokeWidth={2} />
        {/* 未读角标：贴在图标容器右上角（不占独立 gutter 列），2px 面板底色 ring 把它从
            图标底衬里切出来 —— ring 色必须是面板实底 ink-2（.glass-pop 的 background）。 */}
        {unread && (
          <span
            className="absolute -top-[3px] -right-[3px] w-[7px] h-[7px] rounded-full bg-coral/100"
            style={{ boxShadow: '0 0 0 2px rgb(var(--ink-2))' }}
            title={t('notifications.unreadDot')}
            aria-label={t('notifications.unreadDot')}
          />
        )}
      </span>

      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'text-aux truncate',
              unread ? 'font-medium text-ink-fg' : 'text-ink-fg-1'
            )}
          >
            {item.title}
          </span>
          <span className="flex items-baseline gap-1.5 shrink-0">
            {item.recurrenceNo > 1 && (
              <span
                className={cn(
                  'px-[5px] rounded border text-micro font-mono tabular-nums',
                  toneClass.chip
                )}
                title={t('notifications.recurrenceTitle', { count: item.recurrenceNo })}
              >
                {t('notifications.recurrence', { count: item.recurrenceNo })}
              </span>
            )}
            <span className="text-micro font-mono text-ink-fg-3">{time}</span>
          </span>
        </span>
        {item.body && (
          <span
            className={cn(
              'text-meta mt-0.5 line-clamp-2',
              unread ? 'text-ink-fg-2' : 'text-ink-fg-2/75'
            )}
          >
            {item.body}
          </span>
        )}
      </span>
    </button>
  )
}

export function NotificationPanel({ onClose }: { onClose(): void }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const list = useNotificationList(true)
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()

  const items = list.data?.items ?? []
  const unread = list.data?.unread ?? 0
  // 「此刻」的基准：优先取本次数据的落地时刻（React Query 的纯值，随每次 refetch 前进），
  // 首帧无数据时回落面板打开的时刻。🔴 不在 render 里直读 `Date.now()` —— 那是不纯调用
  // (react-hooks/purity)，而且逐处各读一次会让分日与相对时间用两个不同的 now。
  const [openedAt] = useState(() => Date.now())
  const nowMs = list.dataUpdatedAt || openedAt
  // 分组只随数据/基准变，不随每次 render 重算。
  const groups = useMemo(() => groupByDay(items, nowMs), [items, nowMs])

  const activate = (item: NotificationItem): void => {
    if (item.readAt == null) markRead.mutate(item.id)
    const link = resolveNotificationLink(item.payload)
    if (!link) return // 无 link / 未知型 → 只标已读，面板不动（design §6.4）
    onClose()
    if (link.type === 'session') {
      requestOpenAgentSession(link.sessionId)
      void navigate({ to: '/sessions' })
      return
    }
    switch (link.to) {
      case '/agents': {
        // `/agents` 的 validateSearch 要求 tab 是三档之一；非法值按路由自身口径归 agents。
        const tab = link.search?.tab
        const safeTab = tab === 'reports' || tab === 'chats' ? tab : 'agents'
        void navigate({ to: '/agents', search: { tab: safeTab } })
        return
      }
      case '/admin/kanban':
        void navigate({ to: '/admin/kanban' })
        return
    }
  }

  return (
    <>
      <div className="px-4 pt-3 pb-2.5 border-b border-ink-border-soft flex items-start justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
            {t('notifications.kicker')}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-aux text-ink-fg">{t('notifications.title')}</span>
            {unread > 0 && (
              <span className="px-1.5 rounded border border-coral/40 bg-coral/15 text-micro font-mono text-coral tabular-nums">
                {t('notifications.unreadChip', { count: unread })}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={unread === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate(undefined)}
          className={cn(
            'flex items-center gap-1.5 shrink-0 pt-[18px] text-meta text-ink-fg-2',
            'transition-colors duration-fast hover:text-ink-fg',
            'disabled:opacity-40 disabled:cursor-default disabled:hover:text-ink-fg-2'
          )}
        >
          <CheckCheck size={12} strokeWidth={2} />
          {t('notifications.markAllRead')}
        </button>
      </div>

      {list.isPending ? (
        <div className="px-4 py-8 text-center text-meta text-ink-fg-3">
          {t('notifications.loading')}
        </div>
      ) : list.isError ? (
        <div className="px-4 py-8 text-center text-meta text-ink-fg-3">
          {t('notifications.error')}
        </div>
      ) : items.length === 0 ? (
        <div className="min-h-[180px] flex flex-col items-center justify-center gap-2.5 p-6">
          <div className="w-11 h-11 rounded-full bg-ink-3 border border-[var(--hairline)] text-ink-fg-3 flex items-center justify-center">
            <Bell size={20} strokeWidth={1.75} />
          </div>
          <div className="flex flex-col items-center gap-[3px]">
            <div className="text-aux text-ink-fg-1">{t('notifications.empty.title')}</div>
            <div className="text-meta text-ink-fg-3">{t('notifications.empty.hint')}</div>
          </div>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {groups.map((group, i) => (
            <div
              key={`${group.bucket}-${i}`}
              className={cn(i > 0 && 'border-t border-[var(--hairline)]')}
            >
              <div
                className={cn(
                  'px-4 pb-0.5 text-micro font-mono uppercase tracking-wider text-ink-fg-3',
                  i === 0 ? 'pt-2' : 'pt-1.5'
                )}
              >
                {t(`notifications.group.${group.bucket}`)}
              </div>
              {group.items.map((item) => (
                <NotificationRow key={item.id} item={item} nowMs={nowMs} onActivate={activate} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
