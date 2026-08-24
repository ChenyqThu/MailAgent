// Sprint 11 V1.4 user-feedback — TitleBar Theme picker.
//
// Replaces the earlier cycle button so the user can explicitly pick
// "跟随系统 / Dark / Light" instead of cycling and missing the
// system-follow option. Same visual idiom as `AccentPickerPopover` —
// trigger button + small popover anchored under the chrome cluster.
// Persistence still goes through `useAppearance.setThemeMode`.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Monitor, Moon, Sun } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useAnchoredPopover } from '@shared/hooks/useAnchoredPopover'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useAppearance, type ThemeMode } from '@shared/state/appearance'

interface ThemeOption {
  id: ThemeMode
  icon: React.ReactNode
}

const THEME_OPTIONS: ReadonlyArray<ThemeOption> = [
  { id: 'system', icon: <Monitor size={13} strokeWidth={2} /> },
  { id: 'light', icon: <Sun size={13} strokeWidth={2} /> },
  { id: 'dark', icon: <Moon size={13} strokeWidth={2} /> }
]

export function ThemePickerPopover(): React.ReactElement {
  const { t } = useTranslation()
  const themeMode = useAppearance((s) => s.themeMode)
  const resolved = useAppearance((s) => s.resolvedTheme)
  const setThemeMode = useAppearance((s) => s.setThemeMode)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // popover 出入场：无 backdrop，从右上微展开（autoAlpha + y:-6 + scale），
  // 退场反向。scopeRef 兼作 outside-click 命中判定的容器 ref。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })
  // 右对齐本按钮（替代旧硬编码 right:88px —— 魔数一旦右簇改构成就错位）。
  const placement = useAnchoredPopover(triggerRef, scopeRef, shouldRender)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, scopeRef])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${t('titleBar.themeCycle')} (${t(`settings.theme.${themeMode}`)}${
          themeMode === 'system' ? ` → ${t(`settings.theme.${resolved}`)}` : ''
        })`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'flex items-center gap-1.5 px-1.5 py-0.5 rounded',
          'hover:bg-ink-3 hover:text-ink-fg-1 active:bg-ink-4 transition-colors duration-fast'
        )}
      >
        <span className="icon-swap">
          <span className="icon-swap-item" data-active={themeMode === 'light' ? 'true' : 'false'}>
            <Sun size={11} strokeWidth={2} />
          </span>
          <span className="icon-swap-item" data-active={themeMode === 'dark' ? 'true' : 'false'}>
            <Moon size={11} strokeWidth={2} />
          </span>
          <span className="icon-swap-item" data-active={themeMode === 'system' ? 'true' : 'false'}>
            <Monitor size={11} strokeWidth={2} />
          </span>
        </span>
        <span>{t(`settings.theme.${themeMode}`)}</span>
      </button>

      {/* Sprint 14 round 19 — Portal to body so popover paints above any
          later-DOM stacking context (e.g. EmailDetail's sticky strip).
          See AccentPickerPopover for the same fix. */}
      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('titleBar.themeCycle')}
            className="theme-popover glass-pop"
            style={
              {
                ...(placement ? { right: placement.right } : {}),
                width: '180px',
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            <div className="px-3 pt-2 pb-1.5 border-b border-ink-border-soft">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
                Theme
              </div>
            </div>
            <div className="py-1">
              {THEME_OPTIONS.map((opt) => {
                const active = themeMode === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setThemeMode(opt.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-aux text-left',
                      'transition-colors duration-fast',
                      active
                        ? 'row-selected bg-ink-4 text-ink-fg font-medium'
                        : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                    )}
                  >
                    <span className="shrink-0 grid place-items-center w-[14px] h-[14px] text-ink-fg-2">
                      {opt.icon}
                    </span>
                    <span className="flex-1">{t(`settings.theme.${opt.id}`)}</span>
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
