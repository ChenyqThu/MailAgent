// task 08-24-l4-nav-shell Step B — 方案 B nav shell 的组装层。
//
// 老单栏（240↔56 双宽态，三段 11-13 行）退役，拆为：
//   · IconRail（56px 常驻图标导轨，切域）
//   · DomainPanel（336px 域二级栏，随域换内容，可折叠 = 显隐；08-27 批定宽）
// 本文件负责**数据与写路径**：mailbox 计数 / 事项关注 / agent 未读 → badgeValue，
// 邮件视图切换（setView + `?view=` 同步 + useMailbox 联动）、同步状态点、域推导
// （navActiveDomain）。渲染细节在两个子组件。
//
// 🔴 AppShell 红线：Sidebar 仍是中行的**单个** flex item（外层 aside 自身是
// flex row 容器，rail + panel 是它的内部列）——AssistantChatDock 兄弟位挤压语义
// 不变，AppShell 零改动。`[data-app-nav]` 唯一根 / `.row-selected ≤ 1` 契约保留
// （闸：tests/components/sidebar-contract.test.tsx）。
//
// 条目单源仍是 `@shared/navigation/registry`（Step R）：rail 格与 panel 行都是
// registry 投影，路由 path 字面量不出现在本文件。

import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { EventsConnectionState } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { isInboxMailbox, mailboxForView } from '@shared/lib/mailboxSemantics'
import { navigateToDomain } from '@shared/navigation/domain-location'
import {
  navActiveDomain,
  navDomainSecond,
  navigateToNavEntry,
  preloadNavEntry,
  type NavBadgeKind,
  type NavEntry
} from '@shared/navigation/registry'
import { useVisibleNavEntries } from '@shared/navigation/useNavGates'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { deriveAccount } from '@shared/lib/account'
import { useAgentUnreadCount, useSessionProvenanceEnabled } from '@shared/components/agents/hooks'
import { useGlobalAttention, useMattersEnabled } from '@shared/components/matters/hooks'

import { DomainPanel } from './DomainPanel'
import { IconRail } from './IconRail'

// MattersP5Renderer 等既有消费方从本文件拿它 —— 定义随行原语一起搬去了 DomainPanel。
export { MatterAttentionBadge } from './DomainPanel'

/** 同步状态点（08-27 批：StatusBar 退役，sync 段迁 rail 底部）。语义沿用原
 *  StatusBar buildSyncView：SSE 连接状态 + fallback polling 周期 → 点色 + 完整
 *  tooltip（label · 状态 · 详情）。 */
function buildSyncDot(
  t: (k: string, opts?: Record<string, unknown>) => string,
  sseState: EventsConnectionState,
  fallbackMs: number | false
): { dotClass: string; title: string } {
  const fallbackSec =
    typeof fallbackMs === 'number' && fallbackMs > 0 ? Math.round(fallbackMs / 1000) : null
  const tooltipFallback =
    fallbackSec !== null
      ? t('statusbar.sync.tooltipFallback', { seconds: fallbackSec })
      : t('statusbar.sync.tooltipFallbackOff')
  let dotClass: string
  let label: string
  let tooltip: string
  switch (sseState) {
    case 'connected':
      dotClass = 'bg-ok'
      label = t('statusbar.sync.live')
      tooltip = t('statusbar.sync.tooltipConnected')
      break
    case 'connecting':
    case 'reconnecting':
      dotClass = 'bg-coral/100 animate-pulse motion-reduce:animate-none'
      label = t(
        sseState === 'connecting' ? 'statusbar.sync.connecting' : 'statusbar.sync.reconnecting'
      )
      tooltip = sseState === 'connecting' ? t('statusbar.sync.tooltipConnected') : tooltipFallback
      break
    case 'disconnected':
      dotClass = 'bg-fail'
      label =
        fallbackSec !== null
          ? t('statusbar.sync.fallbackTpl', { seconds: fallbackSec })
          : t('statusbar.sync.fallbackOff')
      tooltip = tooltipFallback
      break
    case 'disabled':
      dotClass = 'bg-ink-fg-3'
      label = t('statusbar.sync.disabled')
      tooltip = t('statusbar.sync.tooltipDisabled')
      break
    case 'idle':
    default:
      dotClass = 'bg-ink-fg-3'
      label = t('statusbar.sync.idle')
      tooltip = t('statusbar.sync.tooltipDisabled')
      break
  }
  return { dotClass, title: `${t('statusbar.sync.label')} · ${label} · ${tooltip}` }
}

export function Sidebar(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const routerInstance = useRouter()
  // 门控过滤后的一级入口（registry 单源）。rail / panel 投影在子组件里做。
  const navEntries = useVisibleNavEntries()
  const collapsed = useNavCollapsed((s) => s.collapsed)
  const forcedCollapsed = useNavCollapsed((s) => s.forced)
  const toggleCollapsed = useNavCollapsed((s) => s.toggle)
  const sessionProvenanceEnabled = useSessionProvenanceEnabled()
  const mattersEnabled = useMattersEnabled()
  const matterAttention = useGlobalAttention(mattersEnabled)
  const matterAttentionCount = matterAttention.data?.items.length ?? 0
  const agentUnreadTotal = useAgentUnreadCount(sessionProvenanceEnabled).total
  const setView = useEmailFilter((s) => s.setView)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // `?tab=` —— 过渡期 `/agents` 被 team 与 reports 两个域共用，域推导按 tab 细分
  // （navActiveDomain 的 searchTab 参数，P3 报告拿到独立路由后删）。
  const searchTab = useRouterState({
    select: (s) => (s.location.search as { tab?: string }).tab
  })

  // 路由归属域。🔴 null 是**真值**不是缺省：'/search'（「新标签页」搜索标签的承载路由）
  // 有意不进 registry，不属于任何域。导轨高亮与「点当前域的格 = 折叠」这条短路都必须
  // 按它判 —— 回落成 'mail' 会让 /search 上点邮件格变成折叠切换、走不掉（实测过）。
  const routeDomain = navActiveDomain(navEntries, pathname, searchTab)
  // 二级栏形态要一个具体域才能算，这里才回落邮件域（/search 自带 336 左列，
  // 回落到 mail 的 'page' 档 ⇒ 不渲染 DomainPanel，正是要的形态）。
  const panelDomain = routeDomain ?? 'mail'
  // 域二级栏形态（08-27 批起恒有二级栏）：'nav' = DomainPanel；'page' = 页面列表列
  // 充当二级栏（收起走同一个 useNavCollapsed，本组件只管开合按钮的显隐）。
  const second = navDomainSecond(panelDomain)
  const hasPanel = second === 'nav'

  // Mailbox counts — SSE driven (useEventBridge invalidate ['mailboxes']);
  // polling 作 SSE 断线 fallback.
  const pollingInterval = usePollingFallback()

  // rail 底部同步状态点（StatusBar 退役后 sync 段的常驻落位）。
  const sseState = useEventsStatusStore((s) => s.status.state)
  const syncDot = buildSyncDot(t, sseState, pollingInterval)
  const { data } = useQuery({
    queryKey: qk.mailboxes(),
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false
  })
  const mailboxes = data ?? []

  // Settings — drives the account header (notionAgentName) + Notion Agent
  // online dot (presence of notionAgentPageId).
  const { data: settings } = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  // Sprint 11 user-feedback — owner email comes from .env USER_EMAIL via
  // settings.userEmail (loaded by main/handlers/settings.ts on every read).
  // Falls back to notionAgentName if .env doesn't have USER_EMAIL.
  const accountEmail = settings?.userEmail ?? settings?.notionAgentName ?? null
  const account = deriveAccount(accountEmail)

  // 收件箱未读（rail 的邮件格角标）。08-27 批：草稿箱 / 已标旗 / 所有邮件三个总数
  // 随内建视图行搬进列表头下拉一并退役（下拉不显计数），聚合与 badge kind 都已删。
  // 🔴 徽标与列表必须同径 —— listMailboxes 按 mailbox **原值** GROUP BY, 变体行
  // (INBOX/Drafts…) 自成一组; 而列表查询已按判定集 IN(...) 认全变体 (issue #42
  // 后续)。这里若还 find(=== canonical), 就成了「列表显 6 值、徽标算 1 值」——
  // 正是那一轮要消的那种不一致, 只是方向反了。故按判定集求和。
  const inboxUnread = mailboxes
    .filter((m) => isInboxMailbox(m.mailbox))
    .reduce((sum, mb) => sum + mb.unread, 0)

  // 徽标数值按 registry 的 badge.kind 索引 —— rail 格只问「这一格挂哪个计数」，
  // 不逐处手接变量。
  const badgeValue: Record<NavBadgeKind, number> = {
    inboxUnread,
    matterAttention: matterAttentionCount,
    agentUnread: agentUnreadTotal
  }

  const handleViewClick = (entry: NavEntry, next: EmailView): void => {
    setView(next)
    // Keep useMailbox.active in lockstep（搜索范围等读态的既有联动；此前还服务
    // StatusBar mailbox 段，08-27 批 StatusBar 退役后联动本身保留）。
    const nextMailbox = mailboxForView(next)
    if (nextMailbox) setActiveMailbox(nextMailbox)
    // flagged + all leave activeMailbox alone — they are cross-mailbox views.
    navigateToNavEntry(navigate, entry)
  }

  /** 条目点击的统一入口（panel 行与 rail 格共用）：邮件视图行走 setView 联动，
   *  其余直接 navigateToNavEntry。 */
  const handleEntryClick = (entry: NavEntry): void => {
    if (entry.view !== undefined) handleViewClick(entry, entry.view)
    else navigateToNavEntry(navigate, entry)
  }

  /** 导轨格点击：切域 = 回该域上次的落点；点当前域的格 = 折叠/展开二级栏
   *  （快捷路径；显式入口是 rail 底部的 RailToggle，0825 dogfood 补）。
   *  08-27 批起所有域都有二级栏，点当前格恒为开合。 */
  const handleRailCellClick = (entry: NavEntry): void => {
    // routeDomain 为 null（'/search'）时没有「当前域」⇒ 每一格都是切域，正常导航。
    if (entry.domain === routeDomain) {
      toggleCollapsed()
      return
    }
    // 🔴 切域走 navigateToDomain（有落点回放 / 无落点才是这一格的缺省 entry），与
    // ⌃⇥ / 标签条切域同径 —— 导轨是「回邮件域」最常走的路径，恒落缺省会把
    // 「已加星标」重置成收件箱。不走 handleEntryClick：那条路会 setView(格的缺省视图)，
    // 正好把回放的视图覆盖掉；回放后的 view→store 同步由 InboxLayout 的 URL→store
    // effect 负责（它本就是深链那条腿）。
    navigateToDomain(navigate, entry.domain)
  }

  const handleEntryHover = (entry: NavEntry): void => {
    preloadNavEntry(routerInstance, entry)
  }

  /** 导轨头像点击 —— 直接去账户设置。08-27 批：账户 popover 随 DomainPanel 的
   *  mail 分支退役（mail 转 'page' 域），popover 里唯一动作的落点就是这里。 */
  const handleAvatarClick = (): void => {
    void navigate({ to: '/settings', search: { tab: 'accounts' } })
  }

  return (
    <aside
      data-app-nav
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="primary"
      className="app-nav"
    >
      <IconRail
        entries={navEntries}
        activeDomain={routeDomain}
        badgeValue={badgeValue}
        monogram={account.monogram}
        accountTitle={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
        syncDotClass={syncDot.dotClass}
        syncTitle={syncDot.title}
        panelCollapsed={collapsed}
        showPanelToggle={!forcedCollapsed}
        onPanelToggle={toggleCollapsed}
        onAvatarClick={handleAvatarClick}
        onCellClick={handleRailCellClick}
        onCellHover={handleEntryHover}
      />
      {hasPanel && (
        <DomainPanel
          domain={panelDomain}
          entries={navEntries}
          onEntryClick={handleEntryClick}
          onEntryHover={handleEntryHover}
          onCollapse={toggleCollapsed}
        />
      )}
    </aside>
  )
}
