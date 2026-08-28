// task 08-24-l4-nav-shell Step B — 方案 B 的 56px 图标导轨（常驻，永不折叠）。
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
// 非当前域 → 导航到该 entry；当前域 → 折叠/展开面板。0825 dogfood 起底部另有
// 显式开合按钮（RailToggle）——「点当前域格」这条隐蔽入口保留作快捷路径。

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

function RailCell({
  entry,
  label,
  selected,
  count,
  onClick,
  onHover
}: {
  entry: NavEntry
  label: string
  selected: boolean
  count: number
  onClick(): void
  onHover?: () => void
}): React.ReactElement {
  // hover/focus 播放动画、selected 常态静止（prd v2 R3 的触发档）—— 与 NavRow 同款
  // AnimatedIconActiveProvider 机制；reduce 降级统一在 IconShell 内处理。
  const [iconActive, setIconActive] = useState(false)
  const meta = NAV_DOMAINS[entry.domain]
  return (
    <button
      type="button"
      className="nav-rail-cell"
      data-selected={selected ? 'true' : undefined}
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
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="railbtn">
        {/* D6：icon 工厂只回裸组件；尺寸由 `.railbtn > svg` 的 authored CSS 定
            (19px，底部格 18px)，active 经 Context 下发 —— 这里都不传。 */}
        <AnimatedIconActiveProvider active={iconActive}>{meta.icon()}</AnimatedIconActiveProvider>
        {count > 0 && (
          <span className="railbadge" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span className="raillabel">{label}</span>
    </button>
  )
}

/** 面板开合按钮（底部沉，域格之上）。<lg 强制收起时由 Sidebar 隐藏。 */
function RailToggle({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [iconActive, setIconActive] = useState(false)
  return (
    <button
      type="button"
      className="nav-rail-toggle"
      onClick={onToggle}
      onPointerEnter={() => setIconActive(true)}
      onPointerLeave={() => setIconActive(false)}
      onFocus={() => setIconActive(true)}
      onBlur={() => setIconActive(false)}
      title={t('nav.toggleTitle')}
      aria-label={collapsed ? t('nav.expandAria') : t('nav.toggleAria')}
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
  activeDomain: NavDomain
  badgeValue: Record<NavBadgeKind, number>
  monogram: string
  accountTitle: string
  /** 底部同步状态点（StatusBar 退役后 sync 段唯一的常驻落位，原型 railfoot `.sync`）。
   *  dotClass = Tailwind bg-* 色类；title = 完整状态描述（OS tooltip）。 */
  syncDotClass: string
  syncTitle: string
  /** 面板收起态（RailToggle 的图标方向 + aria）。 */
  panelCollapsed: boolean
  /** <lg 视口强制收起时为 false —— 那里的收起不可解除，按钮只会空翻偏好。 */
  showPanelToggle: boolean
  onPanelToggle(): void
  onAvatarClick(): void
  onCellClick(entry: NavEntry): void
  onCellHover(entry: NavEntry): void
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
  onCellHover
}: IconRailProps): React.ReactElement {
  const { t } = useTranslation()
  const cells = navRailEntries(entries)
  const top = cells.filter((e) => !BOTTOM_DOMAINS.includes(e.domain))
  // 对象域（邮件 / 事项）与页面域之间隔一条分隔线（原型 railsep）—— 前者点开
  // 对象标签，后者轮流占用主标签，rail 上把这两种语义分开。
  const objectCells = top.filter((e) => NAV_OBJECT_DOMAINS.includes(e.domain))
  const pageCells = top.filter((e) => !NAV_OBJECT_DOMAINS.includes(e.domain))
  const bottom = cells.filter((e) => BOTTOM_DOMAINS.includes(e.domain))

  const renderCell = (entry: NavEntry): React.ReactElement => (
    <RailCell
      key={entry.id}
      entry={entry}
      label={navDomainLabel(entry.domain, t)}
      selected={entry.domain === activeDomain}
      count={entry.badge?.rail === true ? badgeValue[entry.badge.kind] : 0}
      onClick={() => onCellClick(entry)}
      onHover={entry.preloadOnHover === true ? () => onCellHover(entry) : undefined}
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
