// task 08-24-l4-nav-shell Step B — 方案 B nav shell 的组装层。
//
// 老单栏（240↔56 双宽态，三段 11-13 行）退役，拆为：
//   · IconRail（56px 常驻图标导轨，切域）
//   · DomainPanel（域二级栏，随域换内容；宽读 --app-second-w）
// 本文件负责**数据与写路径**：mailbox 计数 / 事项关注 / agent 未读 → badgeValue，
// 邮件视图切换（setView + `?view=` 同步 + useMailbox 联动）、同步状态点、域推导
// （navActiveDomain）。渲染细节在两个子组件。
//
// task 09-01-sidebar-fluid-optimization（owner 拍板 A′+C 混合）—— 本文件接 nav-shell store：
//   · 路由归属域 → `setDomain`（切域回放该域的 `{collapsed, width}`，store 写两个 CSS 变量，
//     过渡在 :root 上，顶栏左段 / 二级栏 / 清单列同帧跟随）；
//   · 折叠态 hover / 聚焦导轨格 150ms 开 peek、离开导轨与浮层 300ms 关（定时器在这里，
//     导轨与浮层都不知道对方）；
//   · 拖宽手柄（NavResizeHandle）、rail 底部开合钮 + 面板头钮（三条恢复入口的两条，
//     第三条 `]` 在 GlobalShortcuts）；
//   · 远程 web <768 抽屉：`isWebBuild() && belowMd` ⇒ mode='drawer'，左列 off-canvas。
//
// 🔴 AppShell 红线：Sidebar 仍是中行的**单个** flex item（外层 aside 自身是
// flex row 容器，rail + panel 是它的内部列）——AssistantChatDock 兄弟位挤压语义
// 不变，AppShell 零改动。抽屉遮罩是 position:fixed 的兄弟，不占 flex 位。
// `[data-app-nav]` 唯一根 / `.row-selected ≤ 1` 契约保留（闸：tests/components/sidebar-contract.test.tsx）。
//
// 条目单源仍是 `@shared/navigation/registry`（Step R）：rail 格与 panel 行都是
// registry 投影，路由 path 字面量不出现在本文件。

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { EventsConnectionState } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useIsBelowMd } from '@shared/hooks/useMediaQuery'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { isWebBuild } from '@shared/lib/buildTarget'
import { isSessionUnread } from '@shared/lib/chatUnread'
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
import { domainPref, RAIL_W, useNavShell } from '@shared/state/nav-shell'
import { deriveAccount } from '@shared/lib/account'
import { useAgentUnreadCount, useSessionProvenanceEnabled } from '@shared/components/agents/hooks'
import {
  useGlobalAttention,
  useLiveItemDispatches,
  useMattersEnabled
} from '@shared/components/matters/hooks'

import { DomainPanel } from './DomainPanel'
import { IconRail } from './IconRail'
import { NavPeek } from './NavPeek'
import { NavResizeHandle } from './NavResizeHandle'

// MattersP5Renderer 等既有消费方从本文件拿它 —— 定义随行原语一起搬去了 DomainPanel。
export { MatterAttentionBadge } from './DomainPanel'

/** peek 时序（design.md §3）：hover 格 150ms 后开，离开 300ms 后关。 */
export const PEEK_OPEN_MS = 150
export const PEEK_CLOSE_MS = 300

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
  const sessionProvenanceEnabled = useSessionProvenanceEnabled()
  const mattersEnabled = useMattersEnabled()
  const matterAttention = useGlobalAttention(mattersEnabled)
  const matterAttentionCount = matterAttention.data?.items.length ?? 0
  const agentUnreadTotal = useAgentUnreadCount(sessionProvenanceEnabled).total
  const setView = useEmailFilter((s) => s.setView)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // 路由归属域。🔴 null 是**真值**不是缺省：'/search'（「新标签页」搜索标签的承载路由）
  // 有意不进 registry，不属于任何域 ⇒ 导轨没有高亮格。回落成 'mail' 会让邮件格亮着，
  // 误导「当前在邮件域」。
  const routeDomain = navActiveDomain(navEntries, pathname)
  // 二级栏形态要一个具体域才能算，这里才回落邮件域（/search 自带 336 左列，
  // 回落到 mail 的 'page' 档 ⇒ 不渲染 DomainPanel，正是要的形态）。
  const panelDomain = routeDomain ?? 'mail'
  // 域二级栏形态：'nav' = DomainPanel；'page' = 页面列表列自己充当二级栏。
  const second = navDomainSecond(panelDomain)
  const hasPanel = second === 'nav'

  // ── nav-shell store 接线（09-01 侧栏批）─────────────────────────────────────
  // 形态：远程 web <768 走抽屉；Electron 恒 fixed（主窗 minWidth 940，永不 <768）。
  const belowMd = useIsBelowMd()
  const drawerMode = isWebBuild() && belowMd
  useLayoutEffect(() => {
    useNavShell.getState().setMode(drawerMode ? 'drawer' : 'fixed')
  }, [drawerMode])
  // 切域回放：store 按域写 --app-nav-w / --app-second-w（唯一写入点在 store）。
  // useLayoutEffect：在首帧 paint 前写入，避免闪一帧上个域的宽。
  useLayoutEffect(() => {
    useNavShell.getState().setDomain(panelDomain)
  }, [panelDomain])
  const mode = useNavShell((s) => s.mode)
  const collapsed = useNavShell((s) => domainPref(s.prefs, panelDomain).collapsed)
  const width = useNavShell((s) => domainPref(s.prefs, panelDomain).width)
  const drawerOpen = useNavShell((s) => s.drawerOpen)
  const peekDomain = useNavShell((s) => s.peekDomain)
  const peekWidth = useNavShell((s) =>
    s.peekDomain === null ? 0 : domainPref(s.prefs, s.peekDomain).width
  )
  const fixed = mode === 'fixed'
  const effectiveCollapsed = fixed && collapsed

  // peek 定时器：导轨格 enter 150ms 后开、leave 300ms 后关；浮层自身 enter 取消关闭、
  // leave 再排关闭。只在折叠态生效（展开态 hover 不 peek，与常驻栏冲突）。
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const clearTimers = useCallback((): void => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }, [])
  useEffect(() => clearTimers, [clearTimers])
  const closePeekNow = useCallback((): void => {
    clearTimers()
    useNavShell.getState().closePeek()
  }, [clearTimers])
  const scheduleClose = useCallback((): void => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => useNavShell.getState().closePeek(), PEEK_CLOSE_MS)
  }, [])
  const cancelClose = useCallback((): void => {
    window.clearTimeout(closeTimer.current)
  }, [])
  const handleCellEnter = (entry: NavEntry): void => {
    if (!effectiveCollapsed) return
    window.clearTimeout(closeTimer.current)
    if (useNavShell.getState().peekDomain === entry.domain) return
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(
      () => useNavShell.getState().openPeek(entry.domain),
      PEEK_OPEN_MS
    )
  }
  const handleCellLeave = (): void => {
    if (!effectiveCollapsed) return
    scheduleClose()
  }
  // 展开 / 切形态时若还挂着 peek，收掉。
  useEffect(() => {
    if (!effectiveCollapsed) closePeekNow()
  }, [effectiveCollapsed, closePeekNow])

  // 抽屉：Esc 关。
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useNavShell.getState().setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

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

  // 09-01 侧栏批的两个无数字状态点：
  //   · 事项「进行中」= 有活的行动项派发（与今日面板 / 事项工作台同一份查询，共享缓存）；
  //   · 群聊「有新消息」= 群聊会话（origin='group'）有未读。30s 一拉，SSE 不推它；
  //     没配群聊时 mock / 旧 serve-api 返回空数组或报错都只是「无点」。09-02 对话域拆分
  //     前这颗点挂在对话格上（口径一直是群聊），拆域后随 registry 的 badge 落到群聊格。
  const liveDispatches = useLiveItemDispatches(mattersEnabled)
  const matterRunning = liveDispatches.data?.items.length ?? 0
  const groupSessions = useQuery({
    queryKey: qk.chat.groupOriginSessions(),
    queryFn: () => mailApi.chat.listAllSessions({ origin: 'group' }),
    staleTime: 30_000
  })
  const groupUnread = (groupSessions.data ?? []).filter((s) => isSessionUnread(s)).length

  // 徽标数值按 registry 的 badge.kind 索引 —— rail 格只问「这一格挂哪个计数」，
  // 不逐处手接变量。
  const badgeValue: Record<NavBadgeKind, number> = {
    inboxUnread,
    matterAttention: matterAttentionCount,
    agentUnread: agentUnreadTotal,
    matterRunning,
    groupUnread
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

  /** 导轨格点击：恒为「回该域上次的落点」。 */
  const handleRailCellClick = (entry: NavEntry): void => {
    // 🔴 切域走 navigateToDomain（有落点回放 / 无落点才是这一格的缺省 entry），与
    // ⌃⇥ / 标签条切域同径 —— 导轨是「回邮件域」最常走的路径，恒落缺省会把
    // 「已加星标」重置成收件箱。不走 handleEntryClick：那条路会 setView(格的缺省视图)，
    // 正好把回放的视图覆盖掉；回放后的 view→store 同步由 InboxLayout 的 URL→store
    // effect 负责（它本就是深链那条腿）。
    closePeekNow()
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

  // 抽屉宽：rail + （有 DomainPanel 才带）该域记忆宽；上限 100vw − 48 在 CSS 里 min。
  const drawerWidth = RAIL_W + (hasPanel ? width : 0)

  return (
    <>
      <aside
        data-app-nav
        aria-label="primary"
        className="app-nav"
        data-collapsed={effectiveCollapsed ? 'true' : 'false'}
        data-nav-mode={mode}
        data-drawer-open={mode === 'drawer' && drawerOpen ? 'true' : 'false'}
        style={
          mode === 'drawer'
            ? ({ '--app-drawer-w': `${drawerWidth}px` } as React.CSSProperties)
            : undefined
        }
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
          showPanelToggle={fixed}
          onPanelToggle={() => useNavShell.getState().toggleCollapsed(panelDomain)}
          onAvatarClick={handleAvatarClick}
          onCellClick={handleRailCellClick}
          onCellHover={handleEntryHover}
          onCellEnter={handleCellEnter}
          onCellLeave={handleCellLeave}
        />
        {hasPanel && (
          <DomainPanel
            domain={panelDomain}
            entries={navEntries}
            onEntryClick={handleEntryClick}
            onEntryHover={handleEntryHover}
            onCollapse={
              fixed ? () => useNavShell.getState().setCollapsed(panelDomain, true) : undefined
            }
            innerWidth={width}
          />
        )}
        {fixed && !collapsed && <NavResizeHandle domain={panelDomain} />}
        {fixed && peekDomain !== null && (
          <NavPeek
            domain={peekDomain}
            width={peekWidth}
            entries={navEntries}
            onEntryClick={handleEntryClick}
            onEntryHover={handleEntryHover}
            onClose={closePeekNow}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          />
        )}
      </aside>
      {mode === 'drawer' && (
        <div
          className="nav-scrim"
          data-nav-scrim
          data-open={drawerOpen ? 'true' : 'false'}
          aria-hidden="true"
          onClick={() => useNavShell.getState().setDrawerOpen(false)}
        />
      )}
    </>
  )
}
