// Sprint 11 V1.4 — DESIGN.md §2.11 — 36px title bar.
//
// macOS hiddenInset draws real traffic lights in the leftmost 72px; we
// reserve that space with an empty div + `-webkit-app-region: drag` so
// the chrome stays draggable. The center hosts a ⌘K search/jump button
// (now opens the CommandPalette overlay, not /search route). The right
// cluster (V1.4) carries Accent picker · Theme cycle · Locale picker.
//
// Removed in this revision: brand "MailAgent" label, Island indicator,
// Sync segment. Island + Sync moved to StatusBar (§D in plan / §2.11
// spec). Theme cycle KEPT as 3-state (system / dark / light) per user
// scope decision (mockup is 2-state Dark/Light, prod prefers tri-state).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { AnimatedIconActiveProvider, SearchIcon } from '@shared/components/icons'
import { useCommandPalette } from '@shared/state/command-palette'

import { AccentPickerPopover } from './AccentPickerPopover'
import { LocalePicker } from './LocalePicker'
import { SurfacePickerPopover } from './SurfacePickerPopover'
import { SystemAlertBadge } from './SystemAlertBadge'
import { ThemePickerPopover } from './ThemePickerPopover'
import { UpdateIndicator } from './UpdateIndicator'

export function TitleBar(): React.ReactElement {
  const { t } = useTranslation()
  const togglePalette = useCommandPalette((s) => s.toggle)
  // 整个搜索按钮 hover/focus 经 AnimatedIconActiveProvider 驱动 search 图标动画。
  const [searchActive, setSearchActive] = useState(false)

  return (
    <header
      className={cn(
        // 主题 v2 — 标题栏走 .glass-bar tier + .specular 上沿 1px 镜面高光
        'h-titlebar shrink-0 glass-bar specular border-b border-ink-border/60',
        'flex items-center px-3 select-none'
      )}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 72px reservation for real macOS traffic lights (hiddenInset). */}
      <div className="w-[72px] shrink-0" aria-hidden />

      {/* Brand — the product name lives in the TitleBar (user-requested
          carry-over from Sprint 10; V1.4 mockup drops the brand label but
          the developer-owner-of-the-SQLite-SSoT wants the chrome to read
          "MailAgent"). */}
      {/* LAYOUT-CHROME-01 — <sm 隐藏 brand label 给窄屏右簇 picker 让空间, 防折行。 */}
      <div className="text-aux text-ink-fg-1 font-medium tracking-tight pr-3 shrink-0 hidden sm:block">
        MailAgent
      </div>

      {/* Center · ⌘K search/jump opens the CommandPalette overlay.
          Wrapper itself stays drag-region (inherits from <header>) so the
          empty space around the button still drags the window; only the
          <button> itself opts out of drag via WebkitAppRegion: 'no-drag'. */}
      <div className="flex-1 min-w-0 flex justify-center">
        <button
          type="button"
          onClick={togglePalette}
          onPointerEnter={() => setSearchActive(true)}
          onPointerLeave={() => setSearchActive(false)}
          onFocus={() => setSearchActive(true)}
          onBlur={() => setSearchActive(false)}
          title={t('search.title')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={cn(
            'group flex items-center gap-2 px-3 py-1 rounded-md text-aux text-ink-fg-2',
            'hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast'
          )}
        >
          <AnimatedIconActiveProvider active={searchActive}>
            <SearchIcon size={13} strokeWidth={2} />
          </AnimatedIconActiveProvider>
          {/* <md 退化为纯图标按钮 (省空间防 chrome 折行); 文字 + kbd 桌面才出。 */}
          <span className="hidden md:inline">{t('search.title')}</span>
          <kbd className="hidden md:inline-block group-hover:bg-ink-4">⌘K</kbd>
        </button>
      </div>

      {/* Right cluster · System alerts · Accent · Theme · Locale. Same idea:
          keep the wrapper draggable, only the individual buttons mark
          themselves as `no-drag`. AccentPicker / ThemeCycle / LocalePicker
          / SystemAlertBadge each set WebkitAppRegion: 'no-drag' on their
          <button> element. SystemAlertBadge renders null when no alerts. */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-meta font-mono text-ink-fg-2">
        <SystemAlertBadge />
        {/* 07-04 — 检测到新版本时出更新 icon (强调色配置左侧); 无更新时 null。 */}
        <UpdateIndicator />
        <AccentPickerPopover />
        <span className="hidden md:inline text-ink-fg-3">·</span>
        <SurfacePickerPopover />
        <span className="hidden md:inline text-ink-fg-3">·</span>
        <ThemePickerPopover />
        <span className="hidden md:inline text-ink-fg-3">·</span>
        <LocalePicker />
      </div>
    </header>
  )
}
