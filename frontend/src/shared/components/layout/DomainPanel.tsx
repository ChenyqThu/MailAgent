// task 08-24-l4-nav-shell Step B — 方案 B 的域二级栏（随域换内容）。
// task 08-27-l4-tab-workspace P1 — 定宽 336（左列总宽 392 = 导轨 56 + 336）：
//   · mail / chats 转 'page' 域（列表列由页面自己出），本组件不再渲染邮件
//     MAILBOXES / 文件夹树 / compose CTA / 账户 popover / agents tab 行；
//   · today 域 = 当天五节跳转（TodayNavPanel）；calendar 域 = 小月历
//     （CalendarMiniPanel）；agents（团队）域 = 简版智能体清单（TeamNavPanel，
//     P1 过渡档，见 NAV_DOMAINS.agents 注释）；reports / ops / settings 仍是
//     registry 投影行。
//
// 08-27 dogfood 修正批：折叠能力整体移除 —— 面板恒在、恒 336，域头只剩域名。
//
// 数据与写路径留在 Sidebar（组装层）：本组件只拿点击 handler，自己读只读的
// 路由 store 来定选中态。

import { cloneElement, isValidElement, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { AnimatedIconActiveProvider } from '@shared/components/icons'
import {
  isNavEntryActive,
  navDomainLabel,
  navDomainPanelEntries,
  navigateToSettingsTab,
  navLabel,
  navShortcutDisplay,
  type NavDomain,
  type NavEntry
} from '@shared/navigation/registry'
import { useUpdaterStore } from '@shared/state/updater'
import { clampSettingsTab, SETTINGS_TABS, type SettingsTab } from '@shared/lib/settingsTabs'
import { useMattersEnabled } from '@shared/components/matters/hooks'
import { TeamNavPanel } from '@shared/components/agents/TeamNavPanel'
import { CalendarMiniPanel } from '@shared/components/calendar/CalendarMiniPanel'
import { TodayNavPanel } from '@shared/components/today/TodayNavPanel'

import { SETTINGS_TAB_ICON, settingsTabLabelKey } from '../settings/settingsTabMeta'

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
 *  DIRECT child of <button> — 多包一层 span 会破坏行内既有的 `button > svg`
 *  选择器约定。 */
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
  /** 条目点击 —— 与 IconRail 的格点击共用 Sidebar 里的同一个 handler。 */
  onEntryClick(entry: NavEntry): void
  onEntryHover(entry: NavEntry): void
}

export function DomainPanel({
  domain,
  entries,
  onEntryClick,
  onEntryHover
}: DomainPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // `?tab=` 搜索参 —— settings 域的 12 个 tab 直达行按 tab 细分选中。
  const searchTab = useRouterState({
    select: (s) => (s.location.search as { tab?: string }).tab
  })
  const mattersEnabled = useMattersEnabled()
  const appVersion = useUpdaterStore((s) => s.status.currentVersion)

  const rows = navDomainPanelEntries(entries, domain)

  /** registry 条目 → 一行。选中态与行尾（只剩 kbd 位）在这里定 —— 带徽标的条目
   *  （邮件五视图 / 事项 / 团队）都已随各自域转 'page'，本面板不再渲染计数。 */
  const renderEntry = (entry: NavEntry): React.ReactElement => (
    <NavRow
      key={entry.id}
      icon={entry.icon()}
      label={navLabel(entry, t)}
      selected={isNavEntryActive(entry, pathname)}
      onClick={() => onEntryClick(entry)}
      onHover={entry.preloadOnHover === true ? () => onEntryHover(entry) : undefined}
      right={entry.panel?.kbd === true ? <kbd>{navShortcutDisplay(entry)}</kbd> : undefined}
    />
  )

  /** 设置域的 tab 直达行 —— 设置节导航的**唯一**入口（0825 轮 3 从 SettingsShell 内嵌
   *  rail 迁入域面板，SettingsShell 那侧的水平 tab 条已随二级栏恒在一并退役）。
   *  词表单源 `SETTINGS_TABS`；matters tab 跟随模块开关。 */
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
        {/* ── 41px 域头 · 域名 ───────────────────────────────────────────
            与 rail 头 / 右侧内容区顶栏 (height 41) 的分割线共线（画布修正版基线）。 */}
        <div className="nav-panel-header">
          <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink-fg truncate">
            {navDomainLabel(domain, t)}
          </span>
        </div>

        {/* ── 域内容 ─────────────────────────────────────────────────── */}
        {domain === 'today' ? (
          <TodayNavPanel />
        ) : domain === 'calendar' ? (
          <CalendarMiniPanel />
        ) : domain === 'agents' ? (
          <TeamNavPanel />
        ) : (
          <nav className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 pt-1.5 space-y-px">
            {domain === 'settings'
              ? SETTINGS_TABS.filter((tab) => tab !== 'matters' || mattersEnabled).map(
                  renderSettingsTabRow
                )
              : rows.map(renderEntry)}
          </nav>
        )}

        {/* 设置域 footer（版本 + repo）—— 随节导航从设置页内嵌 rail 迁入。 */}
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
    </div>
  )
}
