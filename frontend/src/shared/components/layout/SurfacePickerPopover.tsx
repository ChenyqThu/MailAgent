// Sprint 18 #4 — Surface (材质) picker.
//
// 跟 AccentPicker / ThemePicker 平行的第三个外观维度: 控制 .glass-1/2/3
// 的视觉风格. 三档 frosted / solid / liquid 由 :root[data-surface='...']
// attribute 驱动 (见 index.css 末段). 持久化走 localStorage, 跨 session
// 复用; index.html inline bootstrap 在 paint 前读 storage 设 attribute
// 避免 FOUC.
//
// 视觉模式参考 ThemePicker 的 list 模式而非 AccentPicker 的 swatch grid —
// 3 个选项时 list 更直观, 每个 option 左侧带一块 mini preview swatch 让
// 用户看到差异.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Droplet, Sparkles, Square } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useAppearance, type SurfaceStyle } from '@shared/state/appearance'

interface SurfaceOption {
  id: SurfaceStyle
  icon: React.ReactNode
}

const SURFACE_OPTIONS: ReadonlyArray<SurfaceOption> = [
  { id: 'frosted', icon: <Droplet size={13} strokeWidth={2} /> },
  { id: 'solid', icon: <Square size={13} strokeWidth={2} /> },
  { id: 'liquid', icon: <Sparkles size={13} strokeWidth={2} /> }
]

function CurrentIcon({ surface }: { surface: SurfaceStyle }): React.ReactElement {
  if (surface === 'solid') return <Square size={11} strokeWidth={2} />
  if (surface === 'liquid') return <Sparkles size={11} strokeWidth={2} />
  return <Droplet size={11} strokeWidth={2} />
}

export function SurfacePickerPopover(): React.ReactElement {
  const { t } = useTranslation()
  const surface = useAppearance((s) => s.surface)
  const setSurface = useAppearance((s) => s.setSurface)
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
        title={t('titleBar.surface.tooltip')}
        aria-label={t('titleBar.surface.aria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'flex items-center gap-1.5 px-1.5 py-0.5 rounded',
          'hover:bg-ink-3 hover:text-ink-fg-1 transition-colors duration-fast'
        )}
      >
        <CurrentIcon surface={surface} />
        <span>{t(`surface.${surface}`)}</span>
      </button>

      {/* Portal-to-body 同 AccentPicker / ThemePicker, 避免 TitleBar 的
          backdrop-filter stacking context 把 popover 盖住. */}
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={t('titleBar.surface.aria')}
            className="theme-popover glass-pop"
            style={
              {
                right: '52px',
                width: '220px',
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            <div className="px-3 pt-2 pb-1.5 border-b border-ink-border-soft">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
                Surface
              </div>
              <div className="text-aux text-ink-fg mt-0.5">{t('titleBar.surface.title')}</div>
            </div>
            <div className="py-1">
              {SURFACE_OPTIONS.map((opt) => {
                const active = surface === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSurface(opt.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-1.5 text-aux text-left',
                      'transition-colors duration-fast',
                      active
                        ? 'row-selected bg-ink-4 text-ink-fg font-medium'
                        : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                    )}
                  >
                    {/* Mini preview swatch — visually shows the material */}
                    <span
                      aria-hidden
                      className={cn('surface-swatch', `surface-swatch-${opt.id}`)}
                    />
                    <span className="shrink-0 grid place-items-center w-[14px] h-[14px] text-ink-fg-2">
                      {opt.icon}
                    </span>
                    <span className="flex-1">{t(`surface.${opt.id}`)}</span>
                  </button>
                )
              })}
            </div>
            <div className="px-3 py-2 border-t border-ink-border-soft">
              <div className="text-meta text-ink-fg-3 leading-snug">
                {t('titleBar.surface.note')}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
