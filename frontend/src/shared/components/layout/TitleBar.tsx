// task 08-27-l4-tab-workspace P2 — 44px 顶栏 = 左段（与左列共宽）+ 标签条。
//
// 左段（.topbar-left，authored CSS）：macOS hiddenInset 红绿灯占位 72px + 品牌字
// + 行尾紧凑 ⌘K 搜索钮。原居中大搜索钮退役 —— 搜索可发现性 = 这枚紧凑钮 + ⌘K
// 快捷键（togglePalette 复用）。宽度跟随 --app-nav-w（nav-shell 收起 392→56 时
// 随左列走），右缘竖 hairline 与左列边界共线。Windows 无红绿灯：占位无条件渲染
// （对平台无分支，与旧版一致——win 上只是 72px 留白，不是回归）。
//
// 右段：TabStrip（主标签 + 对象标签 + morphing 滑动面 + 断开的 hairline，见
// components/tabs/TabStrip.tsx）。右簇（更新 · 铃铛 · 帮助 · Accent · Surface ·
// Theme · Locale）作为 trailing 传入 —— 落位在标签条内是为了让 hairline 一直
// 延伸到行末。整行保持可拖拽，交互件各自 no-drag。
//
// Theme cycle KEPT as 3-state (system / dark / light) per user scope decision。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AnimatedIconActiveProvider, CircleHelpIcon, SearchIcon } from '@shared/components/icons'
import { TabStrip } from '@shared/components/tabs/TabStrip'
import { cn } from '@shared/lib/cn'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { useNavCollapsed } from '@shared/state/nav-shell'

import { AccentPickerPopover } from './AccentPickerPopover'
import { LocalePicker } from './LocalePicker'
import { SurfacePickerPopover } from './SurfacePickerPopover'
import { NotificationBellBadge } from '../notifications/NotificationBellBadge'
import { ThemePickerPopover } from './ThemePickerPopover'
import { UpdateIndicator } from './UpdateIndicator'

export function TitleBar(): React.ReactElement {
  const { t } = useTranslation()
  const togglePalette = useCommandPalette((s) => s.toggle)
  const collapsed = useNavCollapsed((s) => s.collapsed)
  // 搜索按钮 hover/focus 经 AnimatedIconActiveProvider 驱动 search 图标动画。
  const [searchActive, setSearchActive] = useState(false)

  return (
    <header
      className="h-titlebar shrink-0 flex items-stretch select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 左段 —— 材质 tier-side（透明），与下方 rail/panel 连成一列。 */}
      <div className="topbar-left" data-collapsed={collapsed}>
        <div className="topbar-left-inner">
          {/* 72px reservation for real macOS traffic lights (hiddenInset). */}
          <div className="w-[72px] shrink-0" aria-hidden />
          <div className="text-aux text-ink-fg-1 font-medium tracking-tight shrink-0">
            MailAgent
          </div>
          <div className="flex-1 min-w-0" />
          <button
            type="button"
            onClick={togglePalette}
            onPointerEnter={() => setSearchActive(true)}
            onPointerLeave={() => setSearchActive(false)}
            onFocus={() => setSearchActive(true)}
            onBlur={() => setSearchActive(false)}
            title={t('search.title')}
            aria-label={t('search.title')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className={cn(
              'group flex items-center gap-1.5 mr-2.5 px-2 py-1 rounded-[var(--r-ctl)]',
              'text-aux text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3',
              'transition-colors duration-fast'
            )}
          >
            <AnimatedIconActiveProvider active={searchActive}>
              <SearchIcon size={13} strokeWidth={2} />
            </AnimatedIconActiveProvider>
            <kbd className="group-hover:bg-ink-4">⌘K</kbd>
          </button>
        </div>
      </div>

      {/* 右段 · 标签条 + 行尾右簇。簇内各件自行 no-drag（AccentPicker / ThemeCycle /
          LocalePicker / NotificationBellBadge 都在各自 <button> 上设了）。 */}
      <TabStrip
        trailing={
          <div className="flex items-center gap-2 sm:gap-3 shrink-0 self-center text-meta font-mono text-ink-fg-2">
            {/* 07-04 — 检测到新版本时出更新 icon (强调色配置左侧); 无更新时 null。 */}
            <UpdateIndicator />
            {/* 08-20 — 统一通知中心铃铛，右簇唯一的告警/待办入口（M3 批 C5 收编了
                SystemAlertBadge 与 TitleBarAgentPendingBadge）。 */}
            <NotificationBellBadge />
            <button
              type="button"
              onClick={openKeyboardHelp}
              title={t('nav.shortcuts')}
              aria-label={t('nav.shortcuts')}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              className={cn(
                'group flex items-center justify-center p-1.5 rounded transition-colors duration-fast',
                'text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4'
              )}
            >
              <CircleHelpIcon size={13} strokeWidth={2} />
            </button>
            <AccentPickerPopover />
            <span className="hidden md:inline text-ink-fg-3">·</span>
            <SurfacePickerPopover />
            <span className="hidden md:inline text-ink-fg-3">·</span>
            <ThemePickerPopover />
            <span className="hidden md:inline text-ink-fg-3">·</span>
            <LocalePicker />
          </div>
        }
      />
    </header>
  )
}
