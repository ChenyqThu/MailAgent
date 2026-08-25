// Sprint 11 V1.4 — DESIGN.md §2.11 single-shell nav contract.
//
// 240/56 dual width state. Account header on top (badge + local-part +
// caret + collapse chevron). Avatar monogram visible only in collapsed
// mode. Three section groups, EXACTLY: MAILBOXES, AI AGENTS, VIEW
// (DESIGN.md §2.11 lint rule #2: three and only three section headers).
// Bottom strip: 设置. Since task 08-20-perf-shell-prefetch-sidebar §② the
// shell is a RootLayout singleton (AppShell) — mounted ONCE per window,
// surviving route changes; collapsed state still persists in localStorage +
// storage event (state/nav-shell) for cross-window sync.
//
// Visual class names (`app-nav`, `app-nav-account`, `app-nav-avatar-row`,
// `app-nav-section-header`, `app-nav-section-spacer`, `app-nav-keep`,
// `app-nav-bottom`, `app-nav-chevron-*`, `row-selected`) are load-bearing
// hooks from §2.11 — they live in authored CSS (index.css) and survive
// Tailwind purge. Do NOT replace with Tailwind utilities.
//
// task 08-24-l4-nav-shell Step R — 行不再逐个手写：条目（id / 目标 / 图标 / 门控 /
// 徽标源 / 分段与序）来自 `@shared/navigation/registry`，这里只负责**怎么渲染**
// （徽标形状、选中态、折叠态 tooltip）。本文件不再出现任何路由 path 字面量：跳转一律
// 走 `navigateToNavEntry`。加/删一级入口 = 改 registry 一处，五通道同时跟上。

import { cloneElement, isValidElement, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { AnimatedIconActiveProvider, SquarePenIcon } from '@shared/components/icons'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { isDraftsMailbox, isInboxMailbox, mailboxForView } from '@shared/lib/mailboxSemantics'
import {
  isNavEntryActive,
  navigateToNavEntry,
  navLabel,
  navPanelSection,
  navShortcutDisplay,
  preloadNavEntry,
  type NavBadgeKind,
  type NavEntry
} from '@shared/navigation/registry'
import { useVisibleNavEntries } from '@shared/navigation/useNavGates'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { openNewCompose } from '@shared/state/compose-new'
import { deriveAccount } from '@shared/lib/account'
import { useAgentUnreadCount, useSessionProvenanceEnabled } from '@shared/components/agents/hooks'
import { useGlobalAttention, useMattersEnabled } from '@shared/components/matters/hooks'

import { AccountSwitcherPopover } from './AccountSwitcherPopover'
import { SidebarFolderTree } from './SidebarFolderTree'

interface NavRowProps {
  icon: React.ReactNode
  label: string
  selected?: boolean
  onClick?: () => void
  right?: React.ReactNode
  /** Disabled coming-soon row — DESIGN.md §9.4. */
  disabled?: boolean
  /** Tooltip surfaced on hover (esp. for disabled rows). */
  title?: string
  /** 收起态 icon 右上角数字角标（展开态由 right 槽承担数字展示，互斥）。
   *  样式/显隐由 authored CSS `.nav-collapsed-badge` 按 data-collapsed 切换；
   *  `app-nav-keep` 豁免 §2.11 收起态 span 隐藏规则。0/undefined 不渲染。 */
  collapsedBadge?: number
  /** hover/focus 意图预载 (task 08-20-perf-shell-prefetch-sidebar §①): 全仓没有
   *  TanStack <Link>, router 的 defaultPreload:'intent' 对 button+navigate 入口
   *  实际不触发 —— 大 chunk 的入口 (事项/通讯录) 用这个槽补 hover 预载。幂等
   *  (preloadRoute 自去重), 失败由调用方静默。 */
  onHover?: () => void
}

/** Inject `shrink-0` on the Lucide svg so it doesn't compress in flex
 *  layouts, while leaving the caller's existing className alone. The
 *  svg is rendered as a DIRECT child of <a>/<button> so the §2.11
 *  collapsed-mode CSS rule `a > svg / button > svg` can swap the size
 *  15→19 — and so the collapsed hide rule `> span:not(.app-nav-keep)`
 *  never accidentally hides the icon. */
function renderIcon(icon: React.ReactNode): React.ReactNode {
  if (!isValidElement<{ className?: string }>(icon)) return icon
  return cloneElement(icon, {
    className: cn('shrink-0', icon.props.className)
  })
}

/** Wrap a nav row in HoverTip when a tooltip `title` is set. Callers pass
 *  `title={collapsed ? label : undefined}` so the tooltip ONLY appears in
 *  collapsed (icon-only) mode where the label text is hidden. Native `title=`
 *  is unreliable in Electron (HoverTip.tsx header) — so when wrapping we drop
 *  the native attr to avoid a double tooltip. `side="right"` because the nav
 *  is the leftmost rail; the chip pops toward the content area. Expanded mode
 *  (title undefined) renders the row bare — no tooltip, as before.
 *
 *  `portal` lifts the chip to `document.body` (fixed) so it isn't clipped by
 *  the collapsed `<aside>` (~56px wide) nor by the body's `overflow-y-auto`,
 *  which previously hid the `side="right"` chip + forced a horizontal
 *  scrollbar (user: "tooltip 应该在更高独立层级出现"). */
function maybeWrapTip(title: string | undefined, child: React.ReactElement): React.ReactElement {
  if (!title) return child
  return (
    <HoverTip text={title} side="right" portal className="w-full">
      {child}
    </HoverTip>
  )
}

/** 收起态角标渲染 — 99+ 截断（56px rail 上位置有限，控制宽度）。 */
function collapsedBadgeNode(count: number | undefined): React.ReactNode {
  if (typeof count !== 'number' || count <= 0) return null
  return (
    <span className="app-nav-keep nav-collapsed-badge" aria-hidden="true">
      {count > 99 ? '99+' : count}
    </span>
  )
}

function NavRow({
  icon,
  label,
  selected,
  onClick,
  right,
  disabled,
  title,
  collapsedBadge,
  onHover
}: NavRowProps): React.ReactElement {
  // 整行 hover/focus 经 AnimatedIconActiveProvider（zero-DOM Context）驱动行内
  // AnimatedIcon 播放/复位 —— 不靠脆弱的 motion variant 传播（根因见
  // components/icons/AnimatedIcon.tsx 顶部复盘）。reduce 降级统一在 IconShell 内处理。
  const [iconActive, setIconActive] = useState(false)
  // Disabled rows render as a non-interactive <div> per DESIGN.md §9.4 —
  // opacity-50 + cursor-not-allowed, no hover bg, no keyboard focus, no
  // `.row-selected` capability. Screenreaders announce aria-disabled.
  if (disabled) {
    return maybeWrapTip(
      title,
      <div
        role="link"
        aria-disabled="true"
        tabIndex={-1}
        data-disabled="true"
        className={cn(
          'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-[var(--r-ctl)]',
          'text-body text-left text-ink-fg-1 opacity-50 cursor-not-allowed'
        )}
      >
        {renderIcon(icon)}
        <span className="flex-1 truncate">{label}</span>
        {right && <span className="shrink-0">{right}</span>}
      </div>
    )
  }
  return maybeWrapTip(
    title,
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={() => {
        setIconActive(true)
        onHover?.()
      }}
      onPointerLeave={() => setIconActive(false)}
      onFocus={() => {
        setIconActive(true)
        onHover?.()
      }}
      onBlur={() => setIconActive(false)}
      className={cn(
        'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-[var(--r-ctl)]',
        'text-body text-left transition-colors duration-fast',
        // 主题 v2 — 选中行从 ink-4 平涂换 .acc-select accent wash
        // (左光条由 .row-selected::before 提供)。
        selected
          ? 'row-selected acc-select text-ink-fg font-medium'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
      )}
    >
      <AnimatedIconActiveProvider active={iconActive}>
        {renderIcon(icon)}
      </AnimatedIconActiveProvider>
      {collapsedBadgeNode(collapsedBadge)}
      <span className="flex-1 truncate">{label}</span>
      {right && <span className="shrink-0">{right}</span>}
    </button>
  )
}

/** Right-side count for a sidebar row. Sprint 12.6 user-feedback:
 *  - count = 0 → nothing (the row reads as "no signal").
 *  - count > 0 + not selected → bare mono number (low-attention default).
 *  - count > 0 + selected → coral pill (high-attention highlight,
 *    matches the selected row chrome).
 *  Both inbox/flagged virtual entries use this; total-only entries
 *  (`all mail`) fall through to plain `TotalCount` since they are not
 *  unread-tracking. */
function CountRight({
  count,
  selected,
  onClick,
  clickHint
}: {
  count: number
  selected: boolean
  /** 传了才可点 —— 只有「未读」语义的徽标接（收件箱）。草稿总数 / 旗标数不接：
   *  它们不是未读计数，点了筛未读只会给出一个语义不符的空列表。
   *  🔴 有意不加 tabIndex：NavRow 整行已是 <button>，往里塞一个进 tab 序的焦点点
   *  会让键盘用户每行多按一次 Tab。键盘等价路径 = 列表头筛选菜单里既有的「未读」轴。 */
  onClick?: () => void
  clickHint?: string
}): React.ReactElement | null {
  if (count <= 0) return null
  const interactive = onClick
    ? {
        role: 'button' as const,
        title: clickHint,
        // stopPropagation：不让点击冒泡到 NavRow 的 onClick —— 那个会 setView()
        // 把 unread 轴清掉（见 email-filter.ts focusUnread 的注释）。
        onClick: (e: React.MouseEvent): void => {
          e.stopPropagation()
          onClick()
        }
      }
    : {}
  const clickable = onClick ? 'cursor-pointer' : undefined
  if (selected) {
    return (
      <span
        {...interactive}
        className={cn(
          // 收紧选中态 count pill — 旧 px-1.5 py-0.5 text-micro rounded 视觉偏大
          // (用户反馈)。压到 text-[10px] + px-1 py-px + rounded-[3px], 更贴合
          // 数字、与 .ext-pill / ai-strip 等紧凑 badge 一档。
          // 主题 v2 — 配色走 .acc-pill 配方 (accent/.16 底 + accent/.32 描边
          // + 内顶 1px 白光, 亮色字转 accent-dim), 几何仍由上行 utility 控制。
          'text-[10px] leading-none font-mono tabular-nums px-1 py-px rounded-[3px]',
          'acc-pill',
          clickable
        )}
      >
        {count}
      </span>
    )
  }
  return (
    <span
      {...interactive}
      className={cn(
        'text-meta font-mono text-ink-fg-2 tabular-nums transition-colors duration-fast',
        clickable,
        onClick && 'hover:text-ink-fg'
      )}
    >
      {count.toLocaleString('en-US')}
    </span>
  )
}

function TotalCount({ count }: { count: number }): React.ReactElement | null {
  if (count <= 0) return null
  return (
    <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
      {count.toLocaleString('en-US')}
    </span>
  )
}

export function MatterAttentionBadge({ count }: { count: number }): React.ReactElement | null {
  if (count <= 0) return null
  return (
    <span className="min-w-[18px] rounded-full bg-fail px-1.5 py-0.5 text-center text-[10px] font-semibold font-mono tabular-nums text-white">
      {count}
    </span>
  )
}

export function Sidebar(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const routerInstance = useRouter()
  // 门控过滤后的一级入口（registry 单源）。分段/排序在下面按 panel.section 投影。
  const navEntries = useVisibleNavEntries()
  const collapsed = useNavCollapsed((s) => s.collapsed)
  const toggleCollapsed = useNavCollapsed((s) => s.toggle)
  const sessionProvenanceEnabled = useSessionProvenanceEnabled()
  const mattersEnabled = useMattersEnabled()
  const matterAttention = useGlobalAttention(mattersEnabled)
  const matterAttentionCount = matterAttention.data?.items.length ?? 0
  const agentUnreadTotal = useAgentUnreadCount(sessionProvenanceEnabled).total
  const view = useEmailFilter((s) => s.view)
  const setView = useEmailFilter((s) => s.setView)
  const focusUnread = useEmailFilter((s) => s.focusUnread)
  // 多文件夹同步 (P3) — 自定义文件夹激活时内建 MAILBOXES 行全不高亮 (互斥)。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

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

  // 徽标数值按 registry 的 badge.kind 索引 —— 行渲染只问「这一行挂哪个计数」，
  // 不再逐行手接一个变量。
  const badgeValue: Record<NavBadgeKind, number> = {
    inboxUnread,
    draftsTotal,
    flaggedTotal,
    allTotal,
    matterAttention: matterAttentionCount,
    agentUnread: agentUnreadTotal
  }

  // Account popover — anchored under the header row. Outside-click /
  // Escape dismiss + add-account ghost row live in AccountSwitcherPopover.
  // The trigger button (`accountButtonRef`) is passed as the anchorRef so
  // clicks on it don't dismiss the popover (the trigger toggles open).
  // Route-change dismissal is delegated to the popover's outside-click
  // listener — clicks on sidebar nav rows fall outside the popover bounds
  // and outside the anchor, so the popover's own handler closes it.
  const [accountOpen, setAccountOpen] = useState(false)
  const accountButtonRef = useRef<HTMLButtonElement>(null)

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

  /** registry 条目 → 一行。选中态、徽标形状、折叠态 tooltip 都在这里定 ——
   *  MAILBOXES 行还要叠「列表状态」这一层：自定义文件夹激活 (customMailbox 非空)
   *  时内建 view 行全不选中（选中态由 SidebarFolderTree 那侧表达）。 */
  const renderEntry = (entry: NavEntry): React.ReactElement => {
    const label = navLabel(entry, t)
    const mailView = entry.view
    const onRoute = isNavEntryActive(entry, pathname)
    const selected =
      mailView !== undefined ? onRoute && !customMailbox && view === mailView : onRoute
    const badge = entry.badge
    const count = badge ? badgeValue[badge.kind] : 0
    let right: React.ReactNode
    switch (badge?.kind) {
      case 'inboxUnread':
        right =
          count > 0 && mailView !== undefined ? (
            <CountRight
              count={count}
              selected={selected}
              onClick={() => handleUnreadBadgeClick(entry, mailView)}
              clickHint={t('nav.showUnreadOnly')}
            />
          ) : undefined
        break
      // 草稿总数 / 旗标数不是未读计数 —— 不接点击（点了筛未读只会给出空列表）。
      case 'draftsTotal':
      case 'flaggedTotal':
        right = count > 0 ? <CountRight count={count} selected={selected} /> : undefined
        break
      case 'allTotal':
        right = count > 0 ? <TotalCount count={count} /> : undefined
        break
      case 'matterAttention':
        right = <MatterAttentionBadge count={count} />
        break
      case 'agentUnread':
        right =
          count > 0 ? (
            <span
              className="h-2 w-2 rounded-full bg-[rgb(var(--c-accent))]"
              aria-label={t('agents.unread')}
            />
          ) : undefined
        break
      default:
        right = entry.panel?.kbd === true ? <kbd>{navShortcutDisplay(entry)}</kbd> : undefined
    }
    return (
      <NavRow
        key={entry.id}
        icon={entry.icon()}
        label={label}
        title={collapsed ? label : undefined}
        selected={selected}
        onClick={
          mailView !== undefined
            ? () => handleViewClick(entry, mailView)
            : () => navigateToNavEntry(navigate, entry)
        }
        onHover={
          entry.preloadOnHover === true ? () => preloadNavEntry(routerInstance, entry) : undefined
        }
        right={right}
        collapsedBadge={badge?.collapsed === true ? count : undefined}
      />
    )
  }

  const handleAvatarClick = (): void => {
    if (collapsed) {
      // Expand the shell first so the popover has room to render, then
      // open the dropdown — same idiom as DESIGN.md §2.11 spec.
      toggleCollapsed()
      // Defer popover open one tick so the width transition starts first.
      window.setTimeout(() => setAccountOpen(true), 60)
    } else {
      setAccountOpen((o) => !o)
    }
  }

  return (
    <aside
      data-app-nav
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="primary"
      className={cn('app-nav glass border-r border-ink-border/60 flex flex-col relative')}
    >
      {/* ── Header row · account selector + collapse chevron ─────────────
          高度 (41px) 与分割线 (hairline) 由 authored CSS .app-nav-header
          钉死 — 与右侧内容区顶栏共线, 收起态不塌高。 */}
      <div className="app-nav-header flex items-center gap-1 px-2 shrink-0">
        <button
          ref={accountButtonRef}
          type="button"
          onClick={() => setAccountOpen((o) => !o)}
          className={cn(
            'app-nav-account flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-md',
            'hover:bg-ink-3 active:bg-ink-4 transition-colors duration-fast group'
          )}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
          title={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
        >
          {account.badge && (
            <span className="text-micro font-mono px-1 py-[1px] rounded bg-ink-3 border border-ink-border-soft text-ink-fg-1 shrink-0">
              {account.badge}
            </span>
          )}
          <span className="text-body text-ink-fg truncate">{account.localPart}</span>
          <ChevronDown
            size={11}
            strokeWidth={2}
            className={cn(
              'shrink-0 text-ink-fg-2 transition-transform duration-fast',
              accountOpen && 'rotate-180'
            )}
          />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="shrink-0 p-1.5 rounded hover:bg-ink-3 active:bg-ink-4 text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
          title={t('nav.toggleTitle')}
          aria-label={t('nav.toggleAria')}
        >
          <ChevronLeft className="app-nav-chevron-collapse" size={13} strokeWidth={2} />
          <ChevronRight className="app-nav-chevron-expand" size={13} strokeWidth={2} />
        </button>
      </div>

      {/* ── Avatar monogram row (visible only when collapsed) ─────────── */}
      <div
        className="app-nav-avatar-row items-center justify-center py-2 border-b border-ink-border-soft shrink-0"
        style={{ display: 'none' }}
      >
        <button
          type="button"
          onClick={handleAvatarClick}
          className="w-9 h-9 rounded-full flex items-center justify-center text-aux font-medium shadow-sm"
          style={{
            background: 'rgb(var(--c-accent))',
            color: 'rgb(var(--c-accent-fg))'
          }}
          title={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
          aria-label={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
        >
          {account.monogram}
        </button>
      </div>

      {/* ── Account dropdown popover (expanded only — V1 single account) ─ */}
      {!collapsed && (
        <AccountSwitcherPopover
          open={accountOpen}
          account={account}
          anchorRef={accountButtonRef}
          onClose={() => setAccountOpen(false)}
          onAddAccount={() => {
            setAccountOpen(false)
            // Sprint 18 PR C — `/settings` requires `tab` search param. Land
            // the user on Accounts since that's where they came to set up
            // a new account.
            void navigate({ to: '/settings', search: { tab: 'accounts' } })
          }}
        />
      )}

      {/* ── 写邮件 · accent 填充主 CTA ──────────────────────────────────
          账户头与 MAILBOXES 之间的独立按钮 (非 section header, 不破 §2.11
          三段铁律)。展开: 全宽带文本; 收起: 由 authored CSS .app-nav-compose-btn
          收成居中纯 icon 方钮 (文本 span 由 §2.11 收起通杀自动隐藏; icon 放大 /
          居中本容器自管, §2.11 的 nav/bottom svg 规则不覆盖这里)。 */}
      <div className="app-nav-compose px-2 pt-2.5 pb-0.5 shrink-0">
        <button
          type="button"
          onClick={() => openNewCompose()}
          className="app-nav-compose-btn w-full flex items-center gap-2 rounded-lg px-3 py-2 text-body font-medium transition-[filter] duration-fast"
          title={collapsed ? t('nav.composeNew') : undefined}
          aria-label={t('nav.composeNew')}
        >
          <SquarePenIcon size={16} strokeWidth={2} className="shrink-0" />
          <span className="flex-1 text-left">{t('nav.composeNew')}</span>
        </button>
      </div>

      {/* ── Body · 3 groups (MAILBOXES / AI AGENTS / VIEW) ─────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin py-2.5">
        {/* MAILBOXES */}
        <div className="app-nav-section-header px-3 pb-1">
          <h2
            className="text-micro font-mono uppercase text-ink-fg-2 px-2 py-1"
            style={{ letterSpacing: '0.08em' }}
          >
            {t('nav.section.mailboxes')}
          </h2>
        </div>
        {/* 五行内建邮箱由 registry 投影。发件箱无右侧计数 (§2.11 mockup: 自己发的
            没有未读语义)；所有邮件有意不显收起态角标（几千级大数字在 56px rail 上
            没有信号价值）—— 两条都写在 registry 的 badge 声明里。 */}
        <nav className="px-2 space-y-px">
          {navPanelSection(navEntries, 'mailboxes').map(renderEntry)}
          {/* 多文件夹同步 (P3) — 已勾选自定义文件夹树。挂在 MAILBOXES 段内 (三段
              铁律: 不新增 header)。whitelist 空 → 渲染 null, 不破坏现有行。 */}
          <SidebarFolderTree />
        </nav>

        <div className="app-nav-section-spacer my-3 mx-4 border-t [border-top-color:var(--hairline)]" />

        {/* AI AGENTS */}
        <div className="app-nav-section-header px-3 pb-1">
          <h2
            className="text-micro font-mono uppercase text-ink-fg-2 px-2 py-1"
            style={{ letterSpacing: '0.08em' }}
          >
            {t('nav.section.aiAgents')}
          </h2>
        </div>
        {/* 事项（dogfood 反馈：主动工作面而非只读看板，归段首） → MailAgent 通用
            agent 视图 → Custom AI hub。顺序 = registry 的 panel.order。 */}
        <nav className="px-2 space-y-px">
          {navPanelSection(navEntries, 'agents').map(renderEntry)}
        </nav>

        <div className="app-nav-section-spacer my-3 mx-4 border-t [border-top-color:var(--hairline)]" />

        {/* VIEW (LLM Dashboard / 看板 Admin / 日历) — pathname-driven selection */}
        <div className="app-nav-section-header px-3 pb-1">
          <h2
            className="text-micro font-mono uppercase text-ink-fg-2 px-2 py-1"
            style={{ letterSpacing: '0.08em' }}
          >
            {t('nav.section.view')}
          </h2>
        </div>
        {/* LLM Dashboard / 看板 Admin / 日历 / 通讯录 —— 门控（日历的 Windows
            出范围、通讯录）在 registry 声明，这里只渲染过滤后的结果。 */}
        <nav className="px-2 space-y-px">
          {navPanelSection(navEntries, 'view').map(renderEntry)}
        </nav>
      </div>

      {/* ── Bottom strip · 设置 ──────────────────────────────────────── */}
      <div className="app-nav-bottom border-t [border-top-color:var(--hairline)] p-2 space-y-px">
        {navPanelSection(navEntries, 'bottom').map(renderEntry)}
      </div>
    </aside>
  )
}
