// task 08-24-l4-nav-shell Step B — 方案 B 的域二级栏（232px，随域换内容）。
//
// 画板基准 = 提案画布方案 B 板（ProposalB.dc.html）：41px 头（域名 + 域级动作位）+
// 域内容。邮件域 = 写邮件 CTA + MAILBOXES 五视图行 + FOLDERS 文件夹树（原单栏
// Sidebar 的 MAILBOXES 段整体迁入，badge / `?view=` 同步 / 自定义文件夹互斥选中随迁）；
// matters / calendar / contacts / ops / settings 域首版 = 最小面板（registry 的
// panel 投影行）；agents 域另有「报告 / Chats」两条轻量 tab 直达行（与文件夹树同类，
// 不占 NavEntry）。
//
// 折叠 = 整个面板经 `.app-nav[data-collapsed]` 的 authored CSS 隐藏（width 0 +
// visibility hidden），rail 常驻 —— 本组件不再有「收起态行形态」这回事（老单栏的
// 56px icon-only 行、HoverTip、收起角标机制全部退役，那些职责归 IconRail）。
//
// 数据与写路径留在 Sidebar（组装层）：本组件只拿 badge 数值与点击 handler，自己读
// 只读的路由/过滤 store 来定选中态。

import { cloneElement, isValidElement, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronsLeft } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import {
  AnimatedIconActiveProvider,
  FileChartLineIcon,
  MessageSquareIcon,
  SquarePenIcon
} from '@shared/components/icons'
import {
  isNavEntryActive,
  navDomainLabel,
  navDomainPanelEntries,
  navigateToAgentsTab,
  navigateToSettingsTab,
  navLabel,
  navShortcutDisplay,
  type AgentsSubTab,
  type NavBadgeKind,
  type NavDomain,
  type NavEntry
} from '@shared/navigation/registry'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { openNewCompose } from '@shared/state/compose-new'
import { useUpdaterStore } from '@shared/state/updater'
import { clampSettingsTab, SETTINGS_TABS, type SettingsTab } from '@shared/lib/settingsTabs'
import { useMattersEnabled } from '@shared/components/matters/hooks'
import type { DerivedAccount } from '@shared/lib/account'

import { SETTINGS_TAB_ICON, settingsTabLabelKey } from '../settings/settingsTabMeta'

import { AccountSwitcherPopover } from './AccountSwitcherPopover'
import { SidebarFolderTree } from './SidebarFolderTree'

interface NavRowProps {
  icon: React.ReactNode
  label: string
  selected?: boolean
  onClick?: () => void
  right?: React.ReactNode
  /** hover/focus 意图预载 (task 08-20-perf-shell-prefetch-sidebar §①): 全仓没有
   *  TanStack <Link>, router 的 defaultPreload:'intent' 对 button+navigate 入口
   *  实际不触发 —— 大 chunk 的入口 (事项/通讯录) 用这个槽补 hover 预载。幂等
   *  (preloadRoute 自去重), 失败由调用方静默。 */
  onHover?: () => void
}

/** Inject `shrink-0` on the icon svg so it doesn't compress in flex layouts,
 *  while leaving the caller's existing className alone. The svg stays a
 *  DIRECT child of <button> — SidebarFolderTree 的结构契约同款（多包一层
 *  span 会破坏行内既有的 `button > svg` 选择器约定）。 */
function renderIcon(icon: React.ReactNode): React.ReactNode {
  if (!isValidElement<{ className?: string }>(icon)) return icon
  return cloneElement(icon, {
    className: cn('shrink-0', icon.props.className)
  })
}

export function NavRow({
  icon,
  label,
  selected,
  onClick,
  right,
  onHover
}: NavRowProps): React.ReactElement {
  // 整行 hover/focus 经 AnimatedIconActiveProvider（zero-DOM Context）驱动行内
  // AnimatedIcon 播放/复位 —— 不靠脆弱的 motion variant 传播（根因见
  // components/icons/AnimatedIcon.tsx 顶部复盘）。reduce 降级统一在 IconShell 内处理。
  const [iconActive, setIconActive] = useState(false)
  return (
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
        // 画板 navrow: 30px 高 / 0 8px 内距 / 8px gap / 8px 圆角 (= --r-ctl)。
        'row relative w-full flex items-center gap-2 h-[30px] px-2 rounded-[var(--r-ctl)]',
        'text-body text-left transition-colors duration-fast',
        // 主题 v2 — 选中行 .acc-select accent wash (左光条由 .row-selected::before 提供)。
        selected
          ? 'row-selected acc-select text-ink-fg font-medium'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
      )}
    >
      <AnimatedIconActiveProvider active={iconActive}>
        {renderIcon(icon)}
      </AnimatedIconActiveProvider>
      <span className="flex-1 truncate">{label}</span>
      {right && <span className="shrink-0">{right}</span>}
    </button>
  )
}

/** Right-side count for a sidebar row. Sprint 12.6 user-feedback:
 *  - count = 0 → nothing (the row reads as "no signal").
 *  - count > 0 + not selected → bare mono number (low-attention default).
 *  - count > 0 + selected → coral pill (high-attention highlight,
 *    matches the selected row chrome). */
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

export interface DomainPanelProps {
  domain: NavDomain
  /** 门控过滤后的入口全集（本组件自己按 domain 投影）。 */
  entries: readonly NavEntry[]
  badgeValue: Record<NavBadgeKind, number>
  /** 条目点击（邮件视图行 = setView + navigate，其余 = navigateToNavEntry）—— 与
   *  IconRail 的格点击共用 Sidebar 里的同一个 handler。 */
  onEntryClick(entry: NavEntry): void
  onEntryHover(entry: NavEntry): void
  /** 收件箱未读徽标点击（切 view 并只看未读）。 */
  onUnreadBadgeClick(entry: NavEntry, view: EmailView): void
  /** 面板头右侧的收起按钮。 */
  onCollapse(): void
  account: DerivedAccount
  accountEmail: string | null
  accountOpen: boolean
  onAccountOpenChange(next: boolean): void
  onAddAccount(): void
}

export function DomainPanel({
  domain,
  entries,
  badgeValue,
  onEntryClick,
  onEntryHover,
  onUnreadBadgeClick,
  onCollapse,
  account,
  accountEmail,
  accountOpen,
  onAccountOpenChange,
  onAddAccount
}: DomainPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // 账户按钮作 popover 的 anchor —— 点击它不触发 popover 的 outside-click 关闭
  // （否则 mousedown 关、click 又开，按钮永远关不上；AccountSwitcherPopover 头注）。
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // `?tab=` 搜索参 —— agents 域（Custom Agent / 报告 / Chats 行按 tab 细分选中）与
  // settings 域（12 个 tab 直达行）共用；不细分会让 /agents、/settings 下多行同时高亮。
  const searchTab = useRouterState({
    select: (s) => (s.location.search as { tab?: string }).tab
  })
  const mattersEnabled = useMattersEnabled()
  const appVersion = useUpdaterStore((s) => s.status.currentVersion)
  const view = useEmailFilter((s) => s.view)
  // 多文件夹同步 (P3) — 自定义文件夹激活时内建 MAILBOXES 行全不高亮 (互斥)。
  const customMailbox = useEmailFilter((s) => s.customMailbox)

  const rows = navDomainPanelEntries(entries, domain)

  /** registry 条目 → 一行。选中态、徽标形状在这里定 —— MAILBOXES 行还要叠
   *  「列表状态」这一层：自定义文件夹激活 (customMailbox 非空) 时内建 view 行全
   *  不选中（选中态由 SidebarFolderTree 那侧表达）。 */
  const renderEntry = (entry: NavEntry): React.ReactElement => {
    const label = navLabel(entry, t)
    const mailView = entry.view
    const onRoute = isNavEntryActive(entry, pathname)
    let selected: boolean
    if (mailView !== undefined) {
      selected = onRoute && !customMailbox && view === mailView
    } else if (entry.id === 'agents') {
      selected = onRoute && (searchTab ?? 'agents') === 'agents'
    } else {
      selected = onRoute
    }
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
              onClick={() => onUnreadBadgeClick(entry, mailView)}
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
        selected={selected}
        onClick={() => onEntryClick(entry)}
        onHover={entry.preloadOnHover === true ? () => onEntryHover(entry) : undefined}
        right={right}
      />
    )
  }

  /** agents 域的轻量 tab 直达行（报告 / Chats）—— 与文件夹树同类：不是一级入口，
   *  不占 NavEntry，落点经 registry 的 `navigateToAgentsTab`（path 字面量不出 registry）。 */
  const renderAgentsTabRow = (
    tab: AgentsSubTab,
    labelKey: string,
    icon: React.ReactElement
  ): React.ReactElement => (
    <NavRow
      key={`agents-tab-${tab}`}
      icon={icon}
      label={t(labelKey)}
      selected={pathname === '/agents' && searchTab === tab}
      onClick={() => navigateToAgentsTab(navigate, tab)}
    />
  )

  /** 设置域的 tab 直达行（0825 轮 3：设置节导航从 SettingsShell 内嵌 rail 迁入域面板，
   *  ≥lg 由这里承载；<lg 面板强制收起，SettingsShell 的顶部水平 tab 条兜底）。
   *  词表单源 `SETTINGS_TABS`；matters tab 跟随模块开关（同 SettingsRail 既有语义）。 */
  const activeSettingsTab = clampSettingsTab(searchTab)
  const renderSettingsTabRow = (tab: SettingsTab): React.ReactElement => {
    const Icon = SETTINGS_TAB_ICON[tab]
    return (
      <NavRow
        key={`settings-tab-${tab}`}
        icon={<Icon />}
        label={t(settingsTabLabelKey(tab), { defaultValue: tab })}
        selected={pathname === '/settings' && activeSettingsTab === tab}
        onClick={() => navigateToSettingsTab(navigate, tab)}
      />
    )
  }

  return (
    <div className="nav-panel" data-nav-panel>
      <div className="nav-panel-inner">
        {/* ── 41px 域头 · 域名 + 域级动作位 ──────────────────────────────
            与 rail 头 / 右侧内容区顶栏 (height 41) 的分割线共线（画布修正版基线）。 */}
        <div className="nav-panel-header gap-1.5">
          <span className="text-[13px] font-semibold text-ink-fg truncate">
            {navDomainLabel(domain, t)}
          </span>
          <div className="flex-1 min-w-0 flex items-center justify-end gap-1">
            {domain === 'mail' && (
              <button
                ref={accountButtonRef}
                type="button"
                onClick={() => onAccountOpenChange(!accountOpen)}
                className="min-w-0 truncate text-micro text-ink-fg-3 hover:text-ink-fg transition-colors duration-fast"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                title={t('nav.account.tooltip', { email: accountEmail ?? account.localPart })}
              >
                {accountEmail ?? account.localPart}
              </button>
            )}
            <button
              type="button"
              onClick={onCollapse}
              className="shrink-0 p-1 rounded hover:bg-ink-3 active:bg-ink-4 text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
              title={t('nav.toggleTitle')}
              aria-label={t('nav.toggleAria')}
            >
              <ChevronsLeft size={13} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* ── 写邮件 · accent 填充主 CTA（画板: 32px 高 / 居中 / 8px 圆角）─── */}
        {domain === 'mail' && (
          <div className="px-2.5 pt-2.5 pb-0.5 shrink-0">
            <button
              type="button"
              onClick={() => openNewCompose()}
              className="app-nav-compose-btn w-full h-8 flex items-center justify-center gap-[7px] rounded-[var(--r-ctl)] text-[13px] font-semibold transition-[filter] duration-fast"
              aria-label={t('nav.composeNew')}
            >
              <SquarePenIcon size={14} strokeWidth={2} className="shrink-0" />
              <span>{t('nav.composeNew')}</span>
            </button>
          </div>
        )}

        {/* ── 域内容 ─────────────────────────────────────────────────── */}
        <nav
          className={cn(
            'flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 space-y-px',
            domain !== 'mail' && 'pt-1.5'
          )}
        >
          {domain === 'mail' ? (
            <>
              <h2 className="nav-panel-sechdr text-micro font-mono uppercase">
                {t('nav.section.mailboxes')}
              </h2>
              {/* 五行内建邮箱由 registry 投影。发件箱无右侧计数 (自己发的没有未读
                  语义)；「所有邮件」的角标语义见 registry badge 声明。 */}
              {rows.map(renderEntry)}
              {/* 自定义文件夹树 (P3) — 方案 B 板把它从 MAILBOXES 段内分出独立的
                  FOLDERS 段（段头在树组件内，whitelist 空时整段消失）。 */}
              <SidebarFolderTree />
            </>
          ) : domain === 'agents' ? (
            <>
              {rows.map(renderEntry)}
              {renderAgentsTabRow('reports', 'agents.tabReports', <FileChartLineIcon />)}
              {renderAgentsTabRow('chats', 'agents.tabChats', <MessageSquareIcon />)}
            </>
          ) : domain === 'settings' ? (
            SETTINGS_TABS.filter((tab) => tab !== 'matters' || mattersEnabled).map(
              renderSettingsTabRow
            )
          ) : (
            rows.map(renderEntry)
          )}
        </nav>

        {/* 设置域 footer（版本 + repo）—— 随节导航从 SettingsRail 迁入（那侧 ≥lg 已隐）。 */}
        {domain === 'settings' && (
          <div className="shrink-0 border-t border-ink-border-soft px-3 py-3 text-micro font-mono text-ink-fg-2">
            <div className="flex items-center justify-between">
              <span>version</span>
              <span>v{appVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>repo</span>
              <a
                href="https://github.com/chenyqthu/MailAgent"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-coral transition-colors duration-fast"
              >
                GitHub
              </a>
            </div>
          </div>
        )}
      </div>

      {/* ── Account dropdown popover（域头下方锚定；收起态面板整体 visibility
          hidden，popover 一并不可见）─────────────────────────────── */}
      <AccountSwitcherPopover
        open={accountOpen}
        account={account}
        anchorRef={accountButtonRef}
        onClose={() => onAccountOpenChange(false)}
        onAddAccount={onAddAccount}
      />
    </div>
  )
}
