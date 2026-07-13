// Sprint 11 V1.4 — DESIGN.md §2.7 / §2.11 — TitleBar Accent picker.
//
// Trigger button: small coral dot + current accent label. Click opens a
// 264px popover with a 3×3 grid of 36px swatches (coral / cobalt / teal /
// rose / slate / olive / amber / emerald / violet). Selecting a swatch fires
// `useAppearance.setAccent`
// — appearance.ts immediately flips `:root[data-accent]` and broadcasts
// over IPC to the Island, so the live preview is automatic.
//
// CSS lives in index.css under `.theme-popover` / `.swatch` (authored,
// not Tailwind utilities). Component renders DOM that targets those
// classes by name.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useAppearance, type AccentId } from '@shared/state/appearance'

const ACCENT_LABEL: Record<AccentId, string> = {
  coral: 'Coral',
  cobalt: 'Cobalt',
  teal: 'Teal',
  rose: 'Rose',
  slate: 'Slate',
  olive: 'Olive',
  amber: 'Amber',
  emerald: 'Emerald',
  violet: 'Violet'
}
const ACCENT_ORDER: ReadonlyArray<AccentId> = [
  'coral',
  'cobalt',
  'teal',
  'rose',
  'slate',
  'olive',
  'amber',
  'emerald',
  'violet'
]

export function AccentPickerPopover(): React.ReactElement {
  const { t } = useTranslation()
  const accent = useAppearance((s) => s.accent)
  const setAccent = useAppearance((s) => s.setAccent)
  const [open, setOpen] = useState(false)
  // popover 相对 trigger 右对齐（替代 .theme-popover 写死的 right:12px —— 那个值与本按钮
  // 实际位置不符导致弹层偏右；开弹时按按钮右缘算 right，跟随按钮）。
  const [anchorRight, setAnchorRight] = useState<number | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
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
        title={t('titleBar.accent.tooltip')}
        aria-label={t('titleBar.accent.aria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'group flex items-center gap-1.5 px-1.5 py-0.5 rounded',
          'hover:bg-ink-3 hover:text-ink-fg-1 active:bg-ink-4 transition-colors duration-fast'
        )}
      >
        <span
          aria-hidden
          className="inline-block w-2.5 h-2.5 rounded-full shadow-[0_0_0_1px_rgb(var(--ink-0)/0.6)]"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
        <span className="group-hover:text-ink-fg">{ACCENT_LABEL[accent]}</span>
      </button>

      {/* Sprint 14 round 19 — popover renders via Portal to <body> so it
          escapes TitleBar's stacking context.  TitleBar uses `.glass`
          (backdrop-filter) which creates a stacking context; later DOM
          siblings (EmailDetail's sticky strip, also backdrop-blur)
          form their own stacking contexts and end up painting over the
          popover even though our z-index is 60.  Portal moves the
          popover to the document root, restoring z-index ordering. */}
      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('titleBar.accent.aria')}
            className="theme-popover glass-pop"
            style={
              {
                WebkitAppRegion: 'no-drag',
                ...(anchorRight != null ? { right: `${anchorRight}px` } : {})
              } as React.CSSProperties
            }
          >
            <div className="px-4 pt-3 pb-2 border-b border-ink-border-soft">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
                View → Appearance
              </div>
              <div className="text-aux text-ink-fg mt-0.5">{t('titleBar.accent.title')}</div>
            </div>
            <div className="px-4 py-3 grid grid-cols-3 gap-3">
              {ACCENT_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setAccent(id)
                    setOpen(false)
                  }}
                  aria-checked={accent === id}
                  role="radio"
                  aria-label={ACCENT_LABEL[id]}
                  title={ACCENT_LABEL[id]}
                  className={cn('swatch', `swatch-${id}`)}
                />
              ))}
            </div>
            <div className="px-4 py-2 border-t border-ink-border-soft">
              <div className="text-meta text-ink-fg-3 leading-snug">
                {t('titleBar.accent.note')}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
