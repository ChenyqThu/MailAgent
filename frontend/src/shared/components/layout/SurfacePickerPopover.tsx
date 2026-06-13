// Sprint 18 #4 — Surface (材质) picker.
//
// 跟 AccentPicker / ThemePicker 平行的第三个外观维度: 控制 .glass-* 的
// 视觉风格. 主题 v2 起两档 frosted / solid 由 :root[data-surface='...']
// attribute 驱动 (见 index.css 材质结构段). 持久化走 localStorage, 跨
// session 复用; index.html inline bootstrap 在 paint 前读 storage 设
// attribute 避免 FOUC.
//
// 视觉模式参考 ThemePicker 的 list 模式而非 AccentPicker 的 swatch grid —
// 3 个选项时 list 更直观, 每个 option 左侧带一块 mini preview swatch 让
// 用户看到差异.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useAppearance, type SurfaceStyle } from '@shared/state/appearance'

interface SurfaceOption {
  id: SurfaceStyle
}

// 主题 v2 — 三选一 → 二选一 (液态档删除)。玻璃气质与高级调节只在
// 设置 → 通用 → 外观 出现, 快捷入口保持极简。
const SURFACE_OPTIONS: ReadonlyArray<SurfaceOption> = [{ id: 'frosted' }, { id: 'solid' }]

// 材质回显/选项一律用 mini preview swatch —— swatch 本身已直观表达磨砂/实色差异,
// droplet/square 图标冗余 (用户反馈), 故移除; 默认回显 (trigger) 也统一用 swatch。
function SurfaceSwatch({ surface }: { surface: SurfaceStyle }): React.ReactElement {
  return <span aria-hidden className={cn('surface-swatch', `surface-swatch-${surface}`)} />
}

export function SurfacePickerPopover(): React.ReactElement {
  const { t } = useTranslation()
  const surface = useAppearance((s) => s.surface)
  const setSurface = useAppearance((s) => s.setSurface)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // popover 相对 trigger 右对齐（替代旧硬编码 right:52px —— 那个值与本按钮实际位置不符
  // 会偏位，codex review LOW）。开弹时按按钮右缘算 right，对齐 AccentPicker 手法。
  const [anchorRight, setAnchorRight] = useState<number | null>(null)
  // popover 出入场：无 backdrop，从右上微展开；scopeRef 兼作 outside-click 容器。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })

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
        onClick={() => {
          if (!open && triggerRef.current) {
            const r = triggerRef.current.getBoundingClientRect()
            setAnchorRight(Math.max(8, Math.round(window.innerWidth - r.right)))
          }
          setOpen((o) => !o)
        }}
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
        <SurfaceSwatch surface={surface} />
        <span>{t(`surface.${surface}`)}</span>
      </button>

      {/* Portal-to-body 同 AccentPicker / ThemePicker, 避免 TitleBar 的
          backdrop-filter stacking context 把 popover 盖住. */}
      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('titleBar.surface.aria')}
            className="theme-popover glass-pop"
            style={
              {
                ...(anchorRight != null ? { right: `${anchorRight}px` } : { right: '52px' }),
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
