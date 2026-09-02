// task 08-24-l4-nav-shell Step B — 方案 B 的 56px 图标导轨（常驻）。
//
// 画板基准 = 提案画布方案 B 板（ProposalB.dc.html）：
//   · 顶部 41px 头（26px 头像 monogram，hairline 底边与相邻列头共线，下留 8px）
//   · 域格 = 40×40 按钮（icon 19px）+ 9px `.raillabel` 标签，格间 2px
//   · 选中格 = accent wash 圆角 10px pill + accent 字色；数字角标骑 icon 右上角
//   · 底部沉「运维」「设置」（icon 18px，格间 6px，距底 10px）
// 全部几何/明度在 authored CSS（index.css 的 nav shell 段），这里只出结构。
//
// 格 = registry 里带 rail 落位的 entry；格的脸（标签/图标）= NAV_DOMAINS 的域元
// 数据（邮件格画信封，面板里的收件箱行才画收件托盘）。点击语义由 Sidebar 注入：
// 恒为「导航到该域上次的落点」。
//
// task 09-01-sidebar-fluid-optimization：
//   · 底部开合按钮（RailToggle）复活 —— 折叠是按域记忆的（state/nav-shell），这颗钮翻
//     的是**当前域**；三条恢复入口（它 / 二级栏头钮 / `]`）之一。
//   · 格的 pointer / focus 进出经 onCellEnter / onCellLeave 报给 Sidebar，折叠态下用来
//     定时开关 peek（导轨自己不知道 peek 这回事）。
//   · 角标两种形状：数字（`badge.shape` 缺省）/ 6px 点（`shape:'dot'` 或次级 `entry.dot`）。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AnimatedIconActiveProvider,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon
} from '@shared/components/icons'
import {
  NAV_DOMAINS,
  NAV_OBJECT_DOMAINS,
  navDomainLabel,
  navRailEntries,
  type NavBadgeKind,
  type NavDomain,
  type NavEntry
} from '@shared/navigation/registry'

/** 底部沉的两个域（方案 B 板：运维 + 设置贴底）。 */
const BOTTOM_DOMAINS: readonly NavDomain[] = ['ops', 'settings']

/** 格角标：主角标计数 >0 → 数字（或 dot 形状）；否则次级点 >0 → dot；都没有 → 无。 */
function railBadge(
  entry: NavEntry,
  badgeValue: Record<NavBadgeKind, number>
): React.ReactElement | null {
  const primary = entry.badge
  if (primary?.rail === true) {
    const value = badgeValue[primary.kind]
    if (value > 0) {
      if (primary.shape === 'dot') {
        return <span className="railbadge" data-shape="dot" aria-hidden="true" />
      }
      return (
        <span className="railbadge" aria-hidden="true">
          {value > 99 ? '99+' : value}
        </span>
      )
    }
  }
  if (entry.dot !== undefined && badgeValue[entry.dot.kind] > 0) {
    return <span className="railbadge" data-shape="dot" aria-hidden="true" />
  }
  return null
}

function RailCell({
  entry,
  label,
  selected,
  badge,
  onClick,
  onHover,
  onEnter,
  onLeave
}: {
  entry: NavEntry
  label: string
  selected: boolean
  badge: React.ReactElement | null
  onClick(): void
  onHover?: () => void
  onEnter(): void
  onLeave(): void
}): React.ReactElement {
  // hover/focus 播放动画、selected 常态静止（prd v2 R3 的触发档）—— 与 NavRow 同款
  // AnimatedIconActiveProvider 机制；reduce 降级统一在 IconShell 内处理。
  const [iconActive, setIconActive] = useState(false)
  const meta = NAV_DOMAINS[entry.domain]
  const enter = (): void => {
    setIconActive(true)
    onHover?.()
    onEnter()
  }
  const leave = (): void => {
    setIconActive(false)
    onLeave()
  }
  return (
    <button
      type="button"
      className="nav-rail-cell"
      data-selected={selected ? 'true' : undefined}
      data-domain={entry.domain}
      onClick={onClick}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onFocus={enter}
      onBlur={leave}
      // 9px 标签之外的文字提示（OS tooltip）；peek 是折叠态的替代辨识路径，这条是兜底。
      title={label}
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="railbtn">
        {/* D6：icon 工厂只回裸组件；尺寸由 `.railbtn > svg` 的 authored CSS 定
            (19px，底部格 18px)，active 经 Context 下发 —— 这里都不传。 */}
        <AnimatedIconActiveProvider active={iconActive}>{meta.icon()}</AnimatedIconActiveProvider>
        {badge}
      </span>
      <span className="raillabel">{label}</span>
    </button>
  )
}

/** 面板开合按钮（底部沉，域格之上）。翻的是当前域的折叠态；抽屉态由 Sidebar 隐藏。 */
function RailToggle({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [iconActive, setIconActive] = useState(false)
  const label = collapsed ? t('nav.expand') : t('nav.collapse')
  return (
    <button
      type="button"
      className="nav-rail-toggle"
      data-nav-toggle
      onClick={onToggle}
      onPointerEnter={() => setIconActive(true)}
      onPointerLeave={() => setIconActive(false)}
      onFocus={() => setIconActive(true)}
      onBlur={() => setIconActive(false)}
      title={`${label} · [`}
      aria-label={label}
      aria-expanded={!collapsed}
    >
      <AnimatedIconActiveProvider active={iconActive}>
        {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </AnimatedIconActiveProvider>
    </button>
  )
}

export interface IconRailProps {
  /** 门控过滤后的入口全集（本组件自己按 rail 投影）。 */
  entries: readonly NavEntry[]
  /** 当前路由归属的域；`null` = 路由不属于任何域（'/search' 有意不进 registry）
   *  ⇒ **没有格高亮**。别在这里回落成某个域：那会让那一格亮着，误导「当前在那个域」。 */
  activeDomain: NavDomain | null
  badgeValue: Record<NavBadgeKind, number>
  monogram: string
  accountTitle: string
  /** 底部同步状态点（StatusBar 退役后 sync 段唯一的常驻落位，原型 railfoot `.sync`）。
   *  dotClass = Tailwind bg-* 色类；title = 完整状态描述（OS tooltip）。 */
  syncDotClass: string
  syncTitle: string
  /** 当前域第二列折叠态（RailToggle 的图标方向 + aria）。 */
  panelCollapsed: boolean
  /** 抽屉态没有折叠这回事，按钮不出。 */
  showPanelToggle: boolean
  onPanelToggle(): void
  onAvatarClick(): void
  onCellClick(entry: NavEntry): void
  onCellHover(entry: NavEntry): void
  /** pointer / focus 进出格（折叠态 peek 的定时器由 Sidebar 管）。 */
  onCellEnter(entry: NavEntry): void
  onCellLeave(entry: NavEntry): void
}

export function IconRail({
  entries,
  activeDomain,
  badgeValue,
  monogram,
  accountTitle,
  syncDotClass,
  syncTitle,
  panelCollapsed,
  showPanelToggle,
  onPanelToggle,
  onAvatarClick,
  onCellClick,
  onCellHover,
  onCellEnter,
  onCellLeave
}: IconRailProps): React.ReactElement {
  const { t } = useTranslation()
  const cells = navRailEntries(entries)
  const top = cells.filter((e) => !BOTTOM_DOMAINS.includes(e.domain))
  // 对象域（邮件 / 事项 / AI Chat）与页面域之间隔一条分隔线（原型 railsep）—— 前者点开
  // 对象标签，后者轮流占用主标签，rail 上把这两种语义分开。
  // 🔴 分组先于 rail.order：AI Chat 的 order 是 4，升对象域后它排在分隔线**上方**的
  // 事项后面，而不是页面域里的今日(2) 后面。手写期望的闸见 sidebar-contract 的 ALL_RAIL。
  const objectCells = top.filter((e) => NAV_OBJECT_DOMAINS.includes(e.domain))
  const pageCells = top.filter((e) => !NAV_OBJECT_DOMAINS.includes(e.domain))
  const bottom = cells.filter((e) => BOTTOM_DOMAINS.includes(e.domain))

  const renderCell = (entry: NavEntry): React.ReactElement => (
    <RailCell
      key={entry.id}
      entry={entry}
      label={navDomainLabel(entry.domain, t)}
      selected={entry.domain === activeDomain}
      badge={railBadge(entry, badgeValue)}
      onClick={() => onCellClick(entry)}
      onHover={entry.preloadOnHover === true ? () => onCellHover(entry) : undefined}
      onEnter={() => onCellEnter(entry)}
      onLeave={() => onCellLeave(entry)}
    />
  )

  return (
    <div className="nav-rail" data-nav-rail>
      <div className="nav-rail-header">
        <button
          type="button"
          className="nav-rail-avatar"
          onClick={onAvatarClick}
          title={accountTitle}
          aria-label={accountTitle}
        >
          {monogram}
        </button>
      </div>
      <div className="nav-rail-cells">
        {objectCells.map(renderCell)}
        {objectCells.length > 0 && pageCells.length > 0 && (
          <div className="nav-rail-sep" aria-hidden />
        )}
        {pageCells.map(renderCell)}
      </div>
      <div className="nav-rail-bottom">
        <span
          className={`nav-rail-sync ${syncDotClass}`}
          title={syncTitle}
          role="status"
          aria-label={syncTitle}
        />
        {showPanelToggle && <RailToggle collapsed={panelCollapsed} onToggle={onPanelToggle} />}
        {bottom.map(renderCell)}
      </div>
    </div>
  )
}
