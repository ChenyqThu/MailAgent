// 通知面板内容（task 08-20-notification-center 步骤 7 + M2 批 B5；design §6.3，视觉基线 =
// owner 拍板的 mockup「MailAgent 通知中心」Main/Empty）。
//
// 壳（portal / theme-popover 几何 / 出入场动画）在 `NotificationBellBadge.tsx`，这里只画内容：
//   Header（kicker + 标题 + 未读 chip + 全部标为已读） → tab 行（全部 + 四个 category）
//   → 列表（按本地时区分「今天/昨天/更早」）→ 空态。
// 分日、相对时间、图标/色调映射全是纯前端呈现逻辑 —— 后端 list 契约不变、不加分组参数。
//
// M2 补上的三件：① 5 个 tab + per-tab 未读数（`byCategory`，与徽标同一条查询）；
// ② 每条 hover 出 `⋯` → Snooze / 标记已处理；③ deep-link 从两型扩到六型（解析仍在
// `navigation.ts` 单源，这里只负责「解析结果 → 落地动作」的那一跳）。

import { useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CheckCheck,
  FileText,
  History,
  Info,
  MoreHorizontal,
  ShieldAlert,
  SquarePen
} from 'lucide-react'

import type { NotificationCategory, NotificationItem } from '@shared/api/types/notifications'
import { cn } from '@shared/lib/cn'
import { ageLabel } from '@shared/lib/ageLabel'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useMailApi } from '@shared/hooks/useMailApi'
import { navigateToReport } from '@shared/navigation/registry'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { useMatterNavigation } from '@shared/components/matters/navigation'

import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationHistoryList,
  useNotificationList,
  useNotificationUnreadCount,
  useResolveNotification,
  useSnoozeNotification
} from './hooks'
import { navigateNotificationRoute, resolveNotificationLink } from './navigation'
import { NotificationListSkeleton } from './NotificationSkeleton'
import {
  NOTIFICATION_TAB_IDS,
  RELATIVE_WINDOW_MS,
  SNOOZE_PRESETS,
  filterByTab,
  groupByDay,
  historyTimeOf,
  snoozeUntilMs,
  sortByHistoryTime,
  tabCategory,
  tabUnread,
  type NotificationTabId,
  type SnoozePreset
} from './notificationModel'

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

/** Snooze 档位 → i18n key（档位值域单源在 notificationModel，这里只映射文案）。 */
const SNOOZE_LABEL_KEY: Record<SnoozePreset, string> = {
  hour: 'notifications.menu.snoozeHour',
  tomorrow: 'notifications.menu.snoozeTomorrow',
  threeDays: 'notifications.menu.snoozeThreeDays'
}

function NotificationRow({
  item,
  nowMs,
  history = false,
  menuOpen,
  onMenuOpenChange,
  onActivate,
  onSnooze,
  onResolve
}: {
  item: NotificationItem
  /** 由面板统一注入的「此刻」（见 NotificationPanel 里 nowMs 的取法）—— 逐行各读一次
   *  `Date.now()` 会让同一屏的相对时间基准不一致，也过不了 react-hooks/purity。 */
  nowMs: number
  /** 历史（已处理）视图：行是终态，既没有可做的动作也没有未读态，时间读处理时刻。 */
  history?: boolean
  menuOpen: boolean
  onMenuOpenChange(id: number | null): void
  onActivate(item: NotificationItem): void
  onSnooze(item: NotificationItem, preset: SnoozePreset): void
  onResolve(item: NotificationItem): void
}): React.ReactElement {
  const { t } = useTranslation()
  const moreRef = useRef<HTMLButtonElement>(null)
  const { Icon, tone } = metaOf(item)
  // 历史行一律按已读画：那条 `readAt` 对已处理的行没有消费点（未读数只统计活跃行），
  // 在这里亮一颗未读点只会让人以为还有事要做。
  const unread = !history && item.readAt == null
  const toneClass = TONE_CLASS[tone]
  const timeMs = history ? historyTimeOf(item) : item.lastEventAt
  const age = nowMs - timeMs
  const time =
    age < RELATIVE_WINDOW_MS
      ? ageLabel(t, age)
      : new Date(timeMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit'
        })

  // 行菜单不带图标：ContactRow 的行菜单（本仓唯一同形先例）也是纯文字，Popmenu 的前置
  // 16px 槽留空即可（几何契约要求槽恒在，不要求填东西）。
  const menuItems: PopmenuItem[] = [
    {
      kind: 'submenu',
      id: 'snooze',
      label: t('notifications.menu.snooze'),
      items: SNOOZE_PRESETS.map((preset) => ({
        kind: 'action' as const,
        id: preset,
        label: t(SNOOZE_LABEL_KEY[preset]),
        onSelect: () => onSnooze(item, preset)
      }))
    },
    {
      kind: 'action',
      id: 'resolve',
      label: t('notifications.menu.resolve'),
      onSelect: () => onResolve(item)
    }
  ]

  return (
    <div
      className={cn(
        'group relative flex items-start gap-2.5 px-4 py-2.5',
        'border-b border-[var(--hairline)] last:border-b-0',
        'transition-colors duration-fast',
        menuOpen ? 'bg-ink-3' : 'hover:bg-ink-3'
      )}
    >
      <button
        type="button"
        onClick={() => onActivate(item)}
        className="flex min-w-0 flex-1 gap-2.5 text-left"
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

      {/* hover 唯一动作钮：更多。占位恒在、只淡入淡出（绝对定位浮在行上会盖住时间戳）。
          🔴 历史视图整块不渲染（而不是藏起来）—— 已处理是终态，Snooze / 标记已处理都无从
          谈起，留一个看不见但可聚焦的按钮等于给键盘用户挂一条死路。 */}
      {!history && (
        <span className="-mr-1 shrink-0">
          <button
            ref={moreRef}
            type="button"
            aria-label={t('notifications.menu.trigger')}
            title={t('notifications.menu.trigger')}
            onClick={(event) => {
              event.stopPropagation()
              onMenuOpenChange(menuOpen ? null : item.id)
            }}
            className={cn(
              'mt-px grid size-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 opacity-0',
              'transition-opacity duration-fast ease-standard',
              'hover:bg-ink-fg/[0.08] hover:text-ink-fg focus-visible:opacity-100 group-hover:opacity-100',
              menuOpen && 'opacity-100'
            )}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
      )}

      {/* 🔴 portal 档不是可选项：列表是 `overflow-y-auto` 容器，行内 absolute 的菜单会被
          容器整块裁掉（贴底那几行等于点不出菜单）。portal 档另有一处配套 —— 铃铛的
          outside-click / Esc 判定要放行 `[data-popmenu-portal]`，见 NotificationBellBadge。 */}
      {menuOpen ? (
        <Popmenu
          open
          onClose={() => onMenuOpenChange(null)}
          ariaLabel={t('notifications.menu.trigger')}
          items={menuItems}
          triggerRef={moreRef}
          portal
          align="end"
          width={208}
        />
      ) : null}
    </div>
  )
}

export function NotificationPanel({ onClose }: { onClose(): void }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const api = useMailApi()
  const [tab, setTab] = useState<NotificationTabId>('all')
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  // 历史（已处理）视图。「标记为已处理」之后条目从活跃列表消失，行还在库里（resolve 只改
  // state 不删行）—— 这个开关就是它唯一的入口。
  const [history, setHistory] = useState(false)
  const category = tabCategory(tab)
  // 一条查询喂五个 tab：拉的是全类目那一份，切 tab 只在下面本地过滤 —— 面板打开即有内容
  // （启动预热已把这份缓存放好），切 tab 不再各自冷加载各自白屏。
  const activeList = useNotificationList(true)
  // 历史那份是独立 key、只在历史态才拉；活跃那份**不关掉** —— 来回切视图不该把已经在手
  // 的活跃缓存冲掉再冷取一遍。
  const historyList = useNotificationHistoryList(history)
  const list = history ? historyList : activeList
  // 与铃铛徽标**同一条查询**（同 queryKey，react-query 去重不多发请求）：tab 上的未读数、
  // 头部 chip、「全部已读」的可用性全读它，三处口径因此不会各说各话。
  const counts = useNotificationUnreadCount()
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const snooze = useSnoozeNotification()
  const resolve = useResolveNotification()
  const openContactQueue = useContactNavigation((state) => state.openQueue)
  const openMatter = useMatterNavigation((state) => state.open)

  const allItems = list.data?.items
  // tab 过滤在前端做；未读计数不走这里（读服务端 `byCategory`，见下面的 tabOptions）——
  // 两条口径分家是有意的：过滤的是「这一屏能看到的」，计数报的是「服务端一共有多少」。
  const items = useMemo(() => {
    const filtered = filterByTab(allItems ?? [], tab)
    // 历史视图显示的是处理时刻，排序跟着换（否则组头与行上的时间会打架，见 model 头注）。
    return history ? sortByHistoryTime(filtered) : filtered
  }, [allItems, tab, history])
  const unread = tabUnread(tab, counts.data)
  // 「此刻」的基准：优先取本次数据的落地时刻（React Query 的纯值，随每次 refetch 前进），
  // 首帧无数据时回落面板打开的时刻。🔴 不在 render 里直读 `Date.now()` —— 那是不纯调用
  // (react-hooks/purity)，而且逐处各读一次会让分日与相对时间用两个不同的 now。
  const [openedAt] = useState(() => Date.now())
  const nowMs = list.dataUpdatedAt || openedAt
  // 分组只随数据/基准变，不随每次 render 重算。
  const groups = useMemo(
    () => groupByDay(items, nowMs, history ? historyTimeOf : undefined),
    [items, nowMs, history]
  )

  const activate = (item: NotificationItem): void => {
    // 历史视图是只读的：不回写 readAt（已处理行不进任何徽标口径，标它没有消费点），
    // 但点击照常按 link 跳转 —— 「找回那条通知」的下一步多半就是去看它指向的东西。
    if (!history && item.readAt == null) markRead.mutate(item.id)
    const link = resolveNotificationLink(item.payload)
    if (!link) return // 无 link / 未知型 → 只标已读，面板不动（design §6.4）
    onClose()
    switch (link.type) {
      case 'session':
        requestOpenAgentSession(link.sessionId)
        void navigate({ to: '/sessions' })
        return
      case 'report':
        // 08-27 P3：报告有了自己的路由，深链直接落 `/reports/$reportId` —— 原来那条
        // store-intent（reportNavigation）随之退役。目标报告不在列表里（已删 / 分页
        // 没翻到）时 ReportsPage 的派生选中回落第一份，不弹空详情。
        navigateToReport(navigate, link.reportId)
        return
      case 'contact_queue':
        openContactQueue()
        void navigate({ to: '/contacts' })
        return
      case 'matter':
        openMatter(link.publicId)
        void navigate({ to: '/matters' })
        return
      case 'updater_restart':
        // 现成守卫：`updater.ts` 在 state !== 'downloaded' 时直接 no-op，不会误退出。
        void api.updater.quitAndInstall()
        return
      case 'route':
        // 落地 switch 单源在 ./navigation（与系统通知点击共用；含 `/settings` case 与
        // `default: never` 穷尽闸）。
        navigateNotificationRoute(navigate, link)
        return
    }
  }

  const tabOptions = NOTIFICATION_TAB_IDS.map((id) => {
    const label = t(`notifications.tab.${id}`)
    // 🔴 历史态不挂计数：这条计数是**活跃未读**口径（服务端 unread-count 只统计活跃行），
    // 挂在一屏已处理条目上方会读成「这个 tab 里有 3 条」而其实一条都不在眼前。
    const count = history ? 0 : tabUnread(id, counts.data)
    return {
      value: id,
      ariaLabel: label,
      label: (
        <span className="flex items-center gap-1">
          <span>{label}</span>
          {count > 0 && (
            <span className="font-mono text-micro tabular-nums text-ink-fg-3">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
      )
    }
  })

  return (
    <>
      <div className="px-4 pt-3 pb-2.5 border-b border-ink-border-soft flex items-start justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
            {t('notifications.kicker')}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-aux text-ink-fg">
              {history ? t('notifications.history.title') : t('notifications.title')}
            </span>
            {!history && unread > 0 && (
              <span className="px-1.5 rounded border border-coral/40 bg-coral/15 text-micro font-mono text-coral tabular-nums">
                {t('notifications.unreadChip', { count: unread })}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-[18px]">
          {/* 「全部标为已读」只在活跃态出：它清的是未读徽标，而历史里的行早就不进任何
              徽标口径了 —— 摆在那儿只会是一颗按了没反应的按钮。 */}
          {!history && (
            <button
              type="button"
              disabled={unread === 0 || markAllRead.isPending}
              // 标的是**当前 tab**（All tab 才是全部）：按钮就在 tab 行上方，标掉用户看不见的
              // 另外四个类目会让「未读数没清零」变成一件说不清的事。
              onClick={() => markAllRead.mutate(category ?? undefined)}
              className={cn(
                'flex items-center gap-1.5 text-meta text-ink-fg-2',
                'transition-colors duration-fast hover:text-ink-fg',
                'disabled:opacity-40 disabled:cursor-default disabled:hover:text-ink-fg-2'
              )}
            >
              <CheckCheck size={12} strokeWidth={2} />
              {t('notifications.markAllRead')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setHistory((on) => !on)
              setMenuOpenId(null)
            }}
            className={cn(
              'flex items-center gap-1.5 text-meta text-ink-fg-2',
              'transition-colors duration-fast hover:text-ink-fg'
            )}
          >
            {history ? (
              <ArrowLeft size={12} strokeWidth={2} />
            ) : (
              <History size={12} strokeWidth={2} />
            )}
            {history ? t('notifications.history.back') : t('notifications.history.open')}
          </button>
        </div>
      </div>

      {/* tab 行。段宽自适应文本（**不 fluid**）：380px 面板里 5 段等分只有 ~70px，英文
          locale 的 "Reviews"+计数放不下会挤成两行；横向溢出时容器自己滚（无滚动条）。 */}
      <div className="px-3 pt-2 pb-2 border-b border-ink-border-soft overflow-x-auto scrollbar-none">
        <SegmentedControl<NotificationTabId>
          value={tab}
          onChange={(next) => {
            setTab(next)
            setMenuOpenId(null)
          }}
          options={tabOptions}
          ariaLabel={t('notifications.tabsAria')}
        />
      </div>

      {list.isPending ? (
        <NotificationListSkeleton />
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
            <div className="text-aux text-ink-fg-1">
              {t(history ? 'notifications.history.empty.title' : 'notifications.empty.title')}
            </div>
            <div className="text-meta text-ink-fg-3">
              {t(history ? 'notifications.history.empty.hint' : 'notifications.empty.hint')}
            </div>
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
                <NotificationRow
                  key={item.id}
                  item={item}
                  nowMs={nowMs}
                  history={history}
                  menuOpen={menuOpenId === item.id}
                  onMenuOpenChange={setMenuOpenId}
                  onActivate={activate}
                  onSnooze={(target, preset) => {
                    setMenuOpenId(null)
                    snooze.mutate({ id: target.id, untilMs: snoozeUntilMs(preset, Date.now()) })
                  }}
                  onResolve={(target) => {
                    setMenuOpenId(null)
                    resolve.mutate(target.id)
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
