// task 08-27-l4-tab-workspace P2 — 44px 顶栏 = 左段（与左列共宽）+ 标签条。
//
// 左段（.topbar-left，authored CSS）：macOS hiddenInset 红绿灯占位 72px + 行尾控件簇。
// dogfood 轮4：右簇整体迁入左段，顺序 = 更新（有新版本才出现）· 搜索 ⌘K · 通知铃铛 ·
// 亮暗切换 · 快捷键帮助；顶栏右侧**完全腾空**给标签条（TabStrip 不再收 trailing，
// 断开的 hairline 一直延伸到行末，右侧零常驻控件）。宽度跟随 --app-nav-w（nav-shell
// store 写），右缘竖 hairline 与左列边界共线。Windows 无红绿灯：占位无条件渲染（对平台
// 无分支，与旧版一致——win 上只是 72px 留白，不是回归）。
//
// 08-27 dogfood 修正批：品牌字「MailAgent」删除；主题色 / 磨砂 / 中英文三枚 picker
// 从右簇删除（保底能力在设置 → 通用 → 外观，那里四项齐全；语言的 ⌥G 快捷键保留）；
// 亮暗从三态 popover 改成单 icon 直切（ThemeToggleButton），system 态只能在设置里选回。
// 铃铛的浮层经 useAnchoredPopover 钉在触发器上并对视口收口，迁到左段照常工作。
//
// task 09-01-sidebar-fluid-optimization：左列可按域折叠到 56（design.md §2.4）—— 56px
// 装不下五件簇，**折叠态把簇渲染到标签条右端**（header 的第三个子节点，no-drag）；展开态
// 原样在左段，「右侧零常驻控件」在展开态维持。远程 web <768 抽屉态：左段 44 = 汉堡钮。
// 🔴 折叠态左段的**盒宽**不跟到 56：下面那 72px 红绿灯占位随内层一起 visibility:hidden，
// 而红绿灯是 OS 画在上层的（x 7–59），左段真收到 56 就等于让标签条从 x=56 起画、被灯簇压住
// （0902 dogfood 轮 1）。保底 80 在 index.css 的 `.topbar-left:not([data-nav-mode='drawer'])`，
// 与这里的 72 占位是同一口径（72 + 8 间隙）；改这里的占位数要连那条一起改。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu } from 'lucide-react'

import { AnimatedIconActiveProvider, CircleHelpIcon, SearchIcon } from '@shared/components/icons'
import { TabStrip } from '@shared/components/tabs/TabStrip'
import { cn } from '@shared/lib/cn'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { useNavSecondCollapsed, useNavShell } from '@shared/state/nav-shell'

import { NotificationBellBadge } from '../notifications/NotificationBellBadge'
import { ThemeToggleButton } from './ThemeToggleButton'
import { UpdateIndicator } from './UpdateIndicator'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** 控件簇（dogfood 轮4 拍板顺序）：更新 icon 是瞬态指示放簇首；后四件常驻。各件自行 no-drag。 */
function ChromeCluster(): React.ReactElement {
  const { t } = useTranslation()
  const togglePalette = useCommandPalette((s) => s.toggle)
  // 搜索按钮 hover/focus 经 AnimatedIconActiveProvider 驱动 search 图标动画。
  const [searchActive, setSearchActive] = useState(false)
  return (
    <>
      <UpdateIndicator />
      <button
        type="button"
        onClick={togglePalette}
        onPointerEnter={() => setSearchActive(true)}
        onPointerLeave={() => setSearchActive(false)}
        onFocus={() => setSearchActive(true)}
        onBlur={() => setSearchActive(false)}
        title={t('search.title')}
        aria-label={t('search.title')}
        style={NO_DRAG}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-ctl)]',
          'text-aux text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3',
          'transition-colors duration-fast'
        )}
      >
        <AnimatedIconActiveProvider active={searchActive}>
          <SearchIcon size={13} strokeWidth={2} />
        </AnimatedIconActiveProvider>
        <kbd className="group-hover:bg-ink-4">⌘K</kbd>
      </button>
      {/* 08-20 — 统一通知中心铃铛，chrome 上唯一的告警/待办入口（M3 批 C5 收编了
          SystemAlertBadge 与 TitleBarAgentPendingBadge）。 */}
      <NotificationBellBadge />
      <ThemeToggleButton />
      <button
        type="button"
        onClick={openKeyboardHelp}
        title={t('nav.shortcuts')}
        aria-label={t('nav.shortcuts')}
        style={NO_DRAG}
        className={cn(
          'flex items-center justify-center p-1.5 rounded',
          'text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4',
          'transition-colors duration-fast'
        )}
      >
        <CircleHelpIcon size={13} strokeWidth={2} />
      </button>
    </>
  )
}

export function TitleBar(): React.ReactElement {
  const { t } = useTranslation()
  const collapsed = useNavSecondCollapsed()
  const mode = useNavShell((s) => s.mode)
  const drawerOpen = useNavShell((s) => s.drawerOpen)
  const drawer = mode === 'drawer'
  const leftCollapsed = !drawer && collapsed
  // 簇的落位：展开态在左段行尾；折叠态 / 抽屉态左段装不下，迁标签条右端。
  const clusterTrailing = drawer || leftCollapsed

  return (
    <header
      className="h-titlebar shrink-0 flex items-stretch select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 左段 —— 材质 tier-side（透明），与下方 rail/panel 连成一列。 */}
      <div
        className="topbar-left"
        data-collapsed={leftCollapsed ? 'true' : 'false'}
        data-nav-mode={mode}
      >
        <div className="topbar-left-inner">
          {drawer ? (
            <button
              type="button"
              onClick={() => useNavShell.getState().setDrawerOpen(!drawerOpen)}
              title={t('nav.drawer')}
              aria-label={t('nav.drawer')}
              aria-expanded={drawerOpen}
              data-nav-drawer-toggle
              style={NO_DRAG}
              className="flex items-center justify-center p-1.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
            >
              <Menu size={16} strokeWidth={2} />
            </button>
          ) : (
            <>
              {/* 72px reservation for real macOS traffic lights (hiddenInset). */}
              <div className="w-[72px] shrink-0" aria-hidden />
              <div className="flex-1 min-w-0" />
              {!clusterTrailing && (
                <div className="topbar-cluster mr-2.5">
                  <ChromeCluster />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 右段 · 标签条独占（主标签 + 对象标签 + morphing 滑动面 + 断开的 hairline，
          见 components/tabs/TabStrip.tsx）。整行保持可拖拽，交互件各自 no-drag。 */}
      <TabStrip />

      {/* 折叠态 / 抽屉态：簇迁右端（展开态右侧仍零常驻控件）。 */}
      {clusterTrailing && (
        <div className="topbar-cluster topbar-cluster--trailing" data-topbar-cluster-trailing>
          <ChromeCluster />
        </div>
      )}
    </header>
  )
}
