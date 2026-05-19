// Sprint 11 V1.4 user-feedback — TitleBar Theme picker.
//
// Replaces the earlier cycle button so the user can explicitly pick
// "跟随系统 / Dark / Light" instead of cycling and missing the
// system-follow option. Same visual idiom as `AccentPickerPopover` —
// trigger button + small popover anchored under the chrome cluster.
// Persistence still goes through `useAppearance.setThemeMode`.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, Moon, Sun } from 'lucide-react'

import { cn } from '@shared/lib/cn'
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

function CurrentIcon({ mode }: { mode: ThemeMode }): React.ReactElement {
  if (mode === 'light') return <Sun size={11} strokeWidth={2} />
  if (mode === 'dark') return <Moon size={11} strokeWidth={2} />
  return <Monitor size={11} strokeWidth={2} />
}

export function ThemePickerPopover(): React.ReactElement {
  const { t } = useTranslation()
  const themeMode = useAppearance((s) => s.themeMode)
  const resolved = useAppearance((s) => s.resolvedTheme)
  const setThemeMode = useAppearance((s) => s.setThemeMode)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
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
  }, [open])

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
          'hover:bg-ink-3 hover:text-ink-fg-1 transition-colors duration-fast'
        )}
      >
        <CurrentIcon mode={themeMode} />
        <span>{t(`settings.theme.${themeMode}`)}</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('titleBar.themeCycle')}
          className="theme-popover glass-pop"
          style={
            {
              right: '88px',
              width: '180px',
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        >
          <div className="px-3 pt-2 pb-1.5 border-b border-ink-border-soft">
            <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">Theme</div>
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
        </div>
      )}
    </>
  )
}
