// 顶栏右簇的亮暗切换钮（08-27 dogfood 修正批：popover 三态选择器退役，改单 icon 直切）。
//
// 语义：点击**从当前 resolvedTheme 出发翻转**并落成显式值 —— themeMode='system' 时
// 点一下就离开 system，落到与当前实际亮暗相反的那一档（所以「看到的是暗的，点一下就变亮」
// 无论此刻是不是跟随系统）。system 仍是合法态，但只能在设置 → 通用 → 外观里选回。
//
// icon 跟 resolvedTheme（不是 themeMode）：显示的是「现在什么样」，与点击语义同一个锚点。
// 双图标走 index.css 的 `.icon-swap` 原语（120ms cross-fade）。

import { useTranslation } from 'react-i18next'
import { Moon, Sun } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useAppearance } from '@shared/state/appearance'

export function ThemeToggleButton(): React.ReactElement {
  const { t } = useTranslation()
  const themeMode = useAppearance((s) => s.themeMode)
  const resolved = useAppearance((s) => s.resolvedTheme)
  const setThemeMode = useAppearance((s) => s.setThemeMode)

  // hover 文案报的是**当前选择**：跟随系统时把实际解析出的亮暗一并写出来，
  // 否则「跟随系统」四个字看不出现在到底是亮还是暗。
  const label =
    themeMode === 'system'
      ? `${t('settings.theme.system')} → ${t(`settings.theme.${resolved}`)}`
      : t(`settings.theme.${themeMode}`)
  const title = `${t('titleBar.themeCycle')} · ${label}`

  return (
    <button
      type="button"
      onClick={() => setThemeMode(resolved === 'dark' ? 'light' : 'dark')}
      title={title}
      aria-label={title}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={cn(
        'flex items-center justify-center p-1.5 rounded transition-colors duration-fast',
        'text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4'
      )}
    >
      <span className="icon-swap">
        <span className="icon-swap-item" data-active={resolved === 'light' ? 'true' : 'false'}>
          <Sun size={13} strokeWidth={2} />
        </span>
        <span className="icon-swap-item" data-active={resolved === 'dark' ? 'true' : 'false'}>
          <Moon size={13} strokeWidth={2} />
        </span>
      </span>
    </button>
  )
}
