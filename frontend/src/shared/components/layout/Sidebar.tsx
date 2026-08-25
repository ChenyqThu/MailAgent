// task 08-24-l4-nav-shell Step B — 方案 B nav shell 的组装层。
//
// 老单栏（240↔56 双宽态，三段 11-13 行）退役，拆为：
//   · IconRail（56px 常驻图标导轨，切域）
//   · DomainPanel（232px 域二级栏，随域换内容，可折叠 = 显隐）
// 本文件负责**数据与写路径**：mailbox 计数 / 事项关注 / agent 未读 → badgeValue，
// 邮件视图切换（setView + `?view=` 同步 + StatusBar mailbox 联动）、账户 popover
// 状态、域推导（navActiveDomain）。渲染细节在两个子组件。
//
// 🔴 AppShell 红线：Sidebar 仍是中行的**单个** flex item（外层 aside 自身是
// flex row 容器，rail + panel 是它的内部列）——AssistantChatDock 兄弟位挤压语义
// 不变，AppShell 零改动。`[data-app-nav]` 唯一根 / `.row-selected ≤ 1` 契约保留
// （闸：tests/components/sidebar-contract.test.tsx）。
//
// 条目单源仍是 `@shared/navigation/registry`（Step R）：rail 格与 panel 行都是
// registry 投影，路由 path 字面量不出现在本文件。

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { isDraftsMailbox, isInboxMailbox, mailboxForView } from '@shared/lib/mailboxSemantics'
import {
  navActiveDomain,
  navigateToNavEntry,
  preloadNavEntry,
  type NavBadgeKind,
  type NavEntry
} from '@shared/navigation/registry'
import { useVisibleNavEntries } from '@shared/navigation/useNavGates'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { deriveAccount } from '@shared/lib/account'
import { useAgentUnreadCount, useSessionProvenanceEnabled } from '@shared/components/agents/hooks'
import { useGlobalAttention, useMattersEnabled } from '@shared/components/matters/hooks'

import { DomainPanel } from './DomainPanel'
import { IconRail } from './IconRail'

// MattersP5Renderer 等既有消费方从本文件拿它 —— 定义随行原语一起搬去了 DomainPanel。
export { MatterAttentionBadge } from './DomainPanel'

export function Sidebar(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const routerInstance = useRouter()
  // 门控过滤后的一级入口（registry 单源）。rail / panel 投影在子组件里做。
  const navEntries = useVisibleNavEntries()
  const collapsed = useNavCollapsed((s) => s.collapsed)
  const toggleCollapsed = useNavCollapsed((s) => s.toggle)
  const setCollapsed = useNavCollapsed((s) => s.setCollapsed)
  const sessionProvenanceEnabled = useSessionProvenanceEnabled()
  const mattersEnabled = useMattersEnabled()
  const matterAttention = useGlobalAttention(mattersEnabled)
  const matterAttentionCount = matterAttention.data?.items.length ?? 0
  const agentUnreadTotal = useAgentUnreadCount(sessionProvenanceEnabled).total
  const setView = useEmailFilter((s) => s.setView)
  const focusUnread = useEmailFilter((s) => s.focusUnread)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // 当前域（导轨选中格 + 面板内容）。无命中回落邮件域 —— registry 覆盖全部路由，
  // 理论上只在测试路由树缺路由时走到。
  const activeDomain = navActiveDomain(navEntries, pathname) ?? 'mail'

  // Mailbox counts — SSE driven (useEventBridge invalidate ['mailboxes']);
  // polling 作 SSE 断线 fallback.
  const pollingInterval = usePollingFallback()
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

  // Aggregate counts for virtual rows (flagged / all-mail).
  // 🔴 徽标与列表必须同径 —— listMailboxes 按 mailbox **原值** GROUP BY, 变体行
  // (INBOX/Drafts…) 自成一组; 而列表查询已按判定集 IN(...) 认全变体 (issue #42
  // 后续)。这里若还 find(=== canonical), 就成了「列表显 6 值、徽标算 1 值」——
  // 正是本轮要消的那种不一致, 只是方向反了。故按判定集求和。
  const inboxUnread = mailboxes
    .filter((m) => isInboxMailbox(m.mailbox))
    .reduce((sum, mb) => sum + mb.unread, 0)
  // 草稿箱 = davmail Drafts 对账同步进 email_metadata 的行 (mailbox='草稿箱')。
  // 数量语义是"草稿总数"而非未读 (草稿是自己写的)。
  const draftsTotal = mailboxes
    .filter((m) => isDraftsMailbox(m.mailbox))
    .reduce((sum, mb) => sum + mb.total, 0)
  // 「所有邮件」/「已标旗」badge 排除草稿 — 列表查询 (buildListWhere 未指定
  // mailbox 时排草稿) 与 badge 计数必须同径, 否则数字与列表行数对不上。
  const nonDraft = mailboxes.filter((m) => !isDraftsMailbox(m.mailbox))
  const allTotal = nonDraft.reduce((sum, mb) => sum + mb.total, 0)
  const flaggedTotal = nonDraft.reduce((sum, mb) => sum + (mb.flagged ?? 0), 0)

  // 徽标数值按 registry 的 badge.kind 索引 —— rail 格与 panel 行只问「这一格挂
  // 哪个计数」，不逐处手接变量。
  const badgeValue: Record<NavBadgeKind, number> = {
    inboxUnread,
    draftsTotal,
    flaggedTotal,
    allTotal,
    matterAttention: matterAttentionCount,
    agentUnread: agentUnreadTotal
  }

  // Account popover — anchored under the DomainPanel header. Outside-click /
  // Escape dismiss + add-account ghost row live in AccountSwitcherPopover.
  const [accountOpen, setAccountOpen] = useState(false)

  /** 未读徽标点击 —— 切进该 view 并只看未读。收的是「徽标常亮 N 但列表里翻不到那几封」
   *  的可发现性缺口（实测一封 2026-05 的老未读因 davmail folderSizeLimit 窗口外、
   *  入向已读回收够不着，徽标永久挂 1）。 */
  const handleUnreadBadgeClick = (entry: NavEntry, next: EmailView): void => {
    focusUnread(next)
    const nextMailbox = mailboxForView(next)
    if (nextMailbox) setActiveMailbox(nextMailbox)
    navigateToNavEntry(navigate, entry)
  }

  const handleViewClick = (entry: NavEntry, next: EmailView): void => {
    setView(next)
    // Keep useMailbox.active in lockstep for the StatusBar mailbox segment.
    // inbox/outbox map cleanly to concrete Mail.app mailboxes; the virtual
    // flagged/all views use a descriptive label so StatusBar reads sensibly.
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

  /** 导轨格点击：切域 = 导航到该格的 entry；点当前域的格 = 折叠/展开面板
   *  （面板收起后它是唯一的展开入口）。 */
  const handleRailCellClick = (entry: NavEntry): void => {
    if (entry.domain === activeDomain) {
      toggleCollapsed()
      return
    }
    handleEntryClick(entry)
  }

  const handleEntryHover = (entry: NavEntry): void => {
    preloadNavEntry(routerInstance, entry)
  }

  /** 导轨头像点击：面板收起时先展开（popover 需要面板在场才有锚定处），再开
   *  账户菜单 —— 老收起态的同款 idiom（延一拍让宽度过渡先起步）。 */
  const handleAvatarClick = (): void => {
    if (collapsed) {
      setCollapsed(false)
      window.setTimeout(() => setAccountOpen(true), 60)
    } else {
      setAccountOpen(true)
    }
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
        activeDomain={activeDomain}
        badgeValue={badgeValue}
        monogram={account.monogram}
        accountTitle={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
        onAvatarClick={handleAvatarClick}
        onCellClick={handleRailCellClick}
        onCellHover={handleEntryHover}
      />
      <DomainPanel
        domain={activeDomain}
        entries={navEntries}
        badgeValue={badgeValue}
        onEntryClick={handleEntryClick}
        onEntryHover={handleEntryHover}
        onUnreadBadgeClick={handleUnreadBadgeClick}
        onCollapse={toggleCollapsed}
        account={account}
        accountEmail={accountEmail}
        accountOpen={accountOpen}
        onAccountOpenChange={setAccountOpen}
        onAddAccount={() => {
          setAccountOpen(false)
          // Sprint 18 PR C — `/settings` requires `tab` search param. Land
          // the user on Accounts since that's where they came to set up
          // a new account.（有意保留的路径字面量：非 entry 默认落点，Step R 定案⑤）
          void navigate({ to: '/settings', search: { tab: 'accounts' } })
        }}
      />
    </aside>
  )
}
