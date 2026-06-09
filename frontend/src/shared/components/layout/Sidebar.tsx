// Sprint 11 V1.4 — DESIGN.md §2.11 single-shell nav contract.
//
// 240/56 dual width state. Account header on top (badge + local-part +
// caret + collapse chevron). Avatar monogram visible only in collapsed
// mode. Three section groups, EXACTLY: MAILBOXES, AI AGENTS, VIEW
// (DESIGN.md §2.11 lint rule #2: three and only three section headers).
// Bottom strip: 设置 + 快捷键. The whole shell mounts on every page that
// uses it (InboxLayout / SearchLayout / PageFrame); cross-page state
// (collapsed) survives in localStorage + storage event (state/nav-shell).
//
// Visual class names (`app-nav`, `app-nav-account`, `app-nav-avatar-row`,
// `app-nav-section-header`, `app-nav-section-spacer`, `app-nav-keep`,
// `app-nav-bottom`, `app-nav-chevron-*`, `row-selected`) are load-bearing
// hooks from §2.11 — they live in authored CSS (index.css) and survive
// Tailwind purge. Do NOT replace with Tailwind utilities.

import { cloneElement, isValidElement, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  History,
  Inbox,
  Mail,
  Send,
  Settings,
  Sparkles,
  Star,
  Sliders
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { deriveAccount } from '@shared/lib/account'

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

function NavRow({
  icon,
  label,
  selected,
  onClick,
  right,
  disabled,
  title
}: NavRowProps): React.ReactElement {
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
          'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-md',
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
      className={cn(
        'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-md',
        'text-body text-left transition-colors duration-fast',
        selected
          ? 'row-selected bg-ink-4 text-ink-fg font-medium'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
      )}
    >
      {renderIcon(icon)}
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
  selected
}: {
  count: number
  selected: boolean
}): React.ReactElement | null {
  if (count <= 0) return null
  if (selected) {
    return (
      <span
        className={cn(
          // 收紧选中态 count pill — 旧 px-1.5 py-0.5 text-micro rounded 视觉偏大
          // (用户反馈)。压到 text-[10px] + px-1 py-px + rounded-[3px], 更贴合
          // 数字、与 .ext-pill / ai-strip 等紧凑 badge 一档。
          'text-[10px] leading-none font-mono tabular-nums px-1 py-px rounded-[3px]',
          'border border-coral/30 bg-coral/15 text-ink-fg'
        )}
      >
        {count}
      </span>
    )
  }
  return (
    <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
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

/** Notion Agent online indicator. The `.app-nav-keep` class keeps the dot
 *  visible in collapsed mode (the one color anchor in the icon-only rail). */
function OnlineDot({ online }: { online: boolean }): React.ReactElement {
  return (
    <span
      className={cn('app-nav-keep w-1.5 h-1.5 rounded-full', online ? 'bg-ok' : 'bg-ink-fg-3')}
    />
  )
}

const MAILBOX_ICON: Record<EmailView, React.ReactNode> = {
  inbox: <Inbox size={15} strokeWidth={1.75} />,
  outbox: <Send size={15} strokeWidth={1.75} />,
  flagged: <Star size={15} strokeWidth={1.75} />,
  all: <Mail size={15} strokeWidth={1.75} />
}

export function Sidebar(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const collapsed = useNavCollapsed((s) => s.collapsed)
  const toggleCollapsed = useNavCollapsed((s) => s.toggle)
  const view = useEmailFilter((s) => s.view)
  const setView = useEmailFilter((s) => s.setView)
  // 多文件夹同步 (P3) — 自定义文件夹激活时内建 MAILBOXES 行全不高亮 (互斥)。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const onAgents = pathname === '/agents'

  // Mailbox counts — SSE driven (useEventBridge invalidate ['mailboxes']);
  // polling 作 SSE 断线 fallback.
  const pollingInterval = usePollingFallback()
  const { data } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false
  })
  const mailboxes = data ?? []

  // Settings — drives the account header (notionAgentName) + Notion Agent
  // online dot (presence of notionAgentPageId).
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    staleTime: 60_000
  })
  // Sprint 11 user-feedback — owner email comes from .env USER_EMAIL via
  // settings.userEmail (loaded by main/handlers/settings.ts on every read).
  // Falls back to notionAgentName if .env doesn't have USER_EMAIL.
  const accountEmail = settings?.userEmail ?? settings?.notionAgentName ?? null
  const account = deriveAccount(accountEmail)
  const notionAgentOnline = (settings?.notionAgentPageId ?? null) !== null

  // Aggregate counts for virtual rows (flagged / all-mail).
  const inboxRow = mailboxes.find((m) => m.mailbox === '收件箱')
  const inboxUnread = inboxRow?.unread ?? 0
  const allTotal = mailboxes.reduce((sum, mb) => sum + mb.total, 0)
  const flaggedTotal = mailboxes.reduce((sum, mb) => sum + (mb.flagged ?? 0), 0)

  // MAILBOXES selection: only when we're on the inbox route. Other routes
  // (settings, admin, etc.) leave all MAILBOXES rows unselected. Plus the
  // VIEW rows derive selection from pathname so §2.11 lint rule #4
  // (`row-selected` count ≤ 1) holds for free.
  const onInbox = pathname === '/'
  // 自定义文件夹激活 (customMailbox 非空) 时内建 view 行全不选中 (列表已切到该
  // 文件夹, 选中态由 SidebarFolderTree 那侧的 row-selected 表达)。
  const selectedView = onInbox && !customMailbox ? view : null

  // Account popover — anchored under the header row. Outside-click /
  // Escape dismiss + add-account ghost row live in AccountSwitcherPopover.
  // The trigger button (`accountButtonRef`) is passed as the anchorRef so
  // clicks on it don't dismiss the popover (the trigger toggles open).
  // Route-change dismissal is delegated to the popover's outside-click
  // listener — clicks on sidebar nav rows fall outside the popover bounds
  // and outside the anchor, so the popover's own handler closes it.
  const [accountOpen, setAccountOpen] = useState(false)
  const accountButtonRef = useRef<HTMLButtonElement>(null)

  const handleViewClick = (next: EmailView): void => {
    setView(next)
    // Keep useMailbox.active in lockstep for the StatusBar mailbox segment.
    // inbox/outbox map cleanly to concrete Mail.app mailboxes; the virtual
    // flagged/all views use a descriptive label so StatusBar reads sensibly.
    if (next === 'inbox') setActiveMailbox('收件箱')
    else if (next === 'outbox') setActiveMailbox('发件箱')
    // flagged + all leave activeMailbox alone — they are cross-mailbox views.
    void navigate({ to: '/', search: { view: next } })
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
      {/* ── Header row · account selector + collapse chevron ───────────── */}
      <div className="app-nav-header flex items-center gap-1 px-2 py-1.5 border-b border-ink-border-soft shrink-0">
        <button
          ref={accountButtonRef}
          type="button"
          onClick={() => setAccountOpen((o) => !o)}
          className={cn(
            'app-nav-account flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-md',
            'hover:bg-ink-3 transition-colors duration-fast group'
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
          className="shrink-0 p-1 rounded hover:bg-ink-3 text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
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
      {accountOpen && !collapsed && (
        <AccountSwitcherPopover
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
        <nav className="px-2 space-y-px">
          <NavRow
            icon={MAILBOX_ICON.inbox}
            label={t('nav.inbox')}
            title={collapsed ? t('nav.inbox') : undefined}
            selected={selectedView === 'inbox'}
            onClick={() => handleViewClick('inbox')}
            right={
              inboxUnread > 0 ? (
                <CountRight count={inboxUnread} selected={selectedView === 'inbox'} />
              ) : undefined
            }
          />
          {/* Mockup §2.11: outbox row has no right-side count (developers
              don't typically have unread sent mail). Drop the right slot
              entirely so the row reads "发件箱" alone. */}
          <NavRow
            icon={MAILBOX_ICON.outbox}
            label={t('nav.outbox')}
            title={collapsed ? t('nav.outbox') : undefined}
            selected={selectedView === 'outbox'}
            onClick={() => handleViewClick('outbox')}
          />
          <NavRow
            icon={MAILBOX_ICON.flagged}
            label={t('nav.flagged')}
            title={collapsed ? t('nav.flagged') : undefined}
            selected={selectedView === 'flagged'}
            onClick={() => handleViewClick('flagged')}
            right={
              flaggedTotal > 0 ? (
                <CountRight count={flaggedTotal} selected={selectedView === 'flagged'} />
              ) : undefined
            }
          />
          <NavRow
            icon={MAILBOX_ICON.all}
            label={t('nav.allMail')}
            title={collapsed ? t('nav.allMail') : undefined}
            selected={selectedView === 'all'}
            onClick={() => handleViewClick('all')}
            right={allTotal > 0 ? <TotalCount count={allTotal} /> : undefined}
          />
          {/* 多文件夹同步 (P3) — 已勾选自定义文件夹树。挂在 MAILBOXES 段内 (三段
              铁律: 不新增 header)。whitelist 空 → 渲染 null, 不破坏现有行。 */}
          <SidebarFolderTree />
        </nav>

        <div className="app-nav-section-spacer my-3 mx-4 border-t border-ink-border-soft" />

        {/* AI AGENTS */}
        <div className="app-nav-section-header px-3 pb-1">
          <h2
            className="text-micro font-mono uppercase text-ink-fg-2 px-2 py-1"
            style={{ letterSpacing: '0.08em' }}
          >
            {t('nav.section.aiAgents')}
          </h2>
        </div>
        <nav className="px-2 space-y-px">
          {/* Notion Agent — Sprint 20 起进 /notion-agent（仅 chats，notion-agent
              scoped 的会话历史）。未来加 Notion Agent 的 agents/报告时升级成多 tab。 */}
          <NavRow
            icon={<Sparkles size={15} strokeWidth={1.75} />}
            label={t('chat.backend.notionAgent')}
            title={collapsed ? t('chat.backend.notionAgent') : undefined}
            selected={pathname === '/notion-agent'}
            onClick={() => navigate({ to: '/notion-agent' })}
            right={<OnlineDot online={notionAgentOnline} />}
          />
          {/* Custom AI — /agents hub（Agents / 报告 / Chats=custom-api scoped）。
              整个 /agents 都属 Custom AI。（邮件上下文「问 AI」仍开 AIChatPanel。） */}
          <NavRow
            icon={<Sliders size={15} strokeWidth={1.75} />}
            label={t('chat.backend.customApi')}
            title={collapsed ? t('chat.backend.customApi') : undefined}
            selected={onAgents}
            onClick={() => navigate({ to: '/agents', search: { tab: 'agents' } })}
          />
          {/* AI 会话历史 — /sessions 全局视图（全部 backend + 搜索 + 筛选分类）。 */}
          <NavRow
            icon={<History size={15} strokeWidth={1.75} />}
            label={t('nav.aiSessions')}
            title={collapsed ? t('nav.aiSessions') : undefined}
            selected={pathname === '/sessions'}
            onClick={() => navigate({ to: '/sessions' })}
          />
        </nav>

        <div className="app-nav-section-spacer my-3 mx-4 border-t border-ink-border-soft" />

        {/* VIEW (LLM Dashboard / 看板 Admin / 日历) — pathname-driven selection */}
        <div className="app-nav-section-header px-3 pb-1">
          <h2
            className="text-micro font-mono uppercase text-ink-fg-2 px-2 py-1"
            style={{ letterSpacing: '0.08em' }}
          >
            {t('nav.section.view')}
          </h2>
        </div>
        <nav className="px-2 space-y-px">
          <NavRow
            icon={<Activity size={15} strokeWidth={1.75} />}
            label="LLM Dashboard"
            title={collapsed ? 'LLM Dashboard' : undefined}
            selected={pathname.startsWith('/admin/llm') || pathname === '/llm'}
            onClick={() => navigate({ to: '/admin/llm' })}
          />
          <NavRow
            icon={<BarChart3 size={15} strokeWidth={1.75} />}
            label={t('nav.adminKanban')}
            title={collapsed ? t('nav.adminKanban') : undefined}
            selected={pathname === '/admin/kanban' || pathname === '/admin'}
            onClick={() => navigate({ to: '/admin/kanban' })}
          />
          <NavRow
            icon={<CalendarDays size={15} strokeWidth={1.75} />}
            label={t('nav.calendar')}
            title={collapsed ? t('nav.calendar') : undefined}
            selected={pathname.startsWith('/admin/calendar') || pathname === '/calendar'}
            onClick={() => navigate({ to: '/admin/calendar', search: { view: 'week' } })}
          />
        </nav>
      </div>

      {/* ── Bottom strip · 设置 + 快捷键 ──────────────────────────────── */}
      <div className="app-nav-bottom border-t border-ink-border-soft p-2 space-y-px">
        <NavRow
          icon={<Settings size={15} strokeWidth={1.75} />}
          label={t('nav.settings')}
          title={collapsed ? t('nav.settings') : undefined}
          selected={pathname === '/settings'}
          onClick={() => navigate({ to: '/settings', search: { tab: 'general' } })}
          right={<kbd>⌘,</kbd>}
        />
        <NavRow
          icon={<HelpCircle size={15} strokeWidth={1.75} />}
          label={t('nav.shortcuts')}
          title={collapsed ? t('nav.shortcuts') : undefined}
          onClick={openKeyboardHelp}
          right={<kbd>?</kbd>}
        />
      </div>
    </aside>
  )
}
