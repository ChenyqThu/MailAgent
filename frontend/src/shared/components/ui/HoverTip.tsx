// Sprint 11 user-feedback — lightweight hover tooltip.
//
// Native `title=` is unreliable in Electron `titleBarStyle: 'hiddenInset'`:
// some surfaces never fire the OS-level tooltip, others delay it past
// usefulness. This component owns its own hover state + an absolutely
// positioned chip so the tooltip appears the instant the cursor enters
// the wrapper. Cursor stays default (no question-mark) because we never
// set `cursor-help`.
//
// Multi-line `text` is rendered with `whitespace-pre-line` so callers can
// pass strings with `\n` for stacked detail (mockup §footer convention).

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@shared/lib/cn'

type HoverTipSide = 'top' | 'bottom' | 'left' | 'right'

interface HoverTipProps {
  text: string
  /** Defaults to `top`. `top/bottom` for footers/headers; `left/right` for
   *  list-row icon buttons where stacking above would overlap the row's
   *  primary content (e.g. ChatSidebar's delete-confirm pair). */
  side?: HoverTipSide
  /** Tailwind classes applied to the wrapper. */
  className?: string
  /** Opt-in: render the tooltip chip into `document.body` via `createPortal`
   *  with `position: fixed`, instead of as an inline absolutely-positioned
   *  child of the wrapper. Needed where an ancestor clips overflow or has a
   *  low z-context that would hide/clip the tip — e.g. the COLLAPSED left
   *  nav rail (Sidebar.tsx), whose narrow `<aside>` + `overflow-y-auto` body
   *  clips a `side="right"` chip and triggers a horizontal scrollbar. Default
   *  `false` keeps the legacy inline behaviour for all other call-sites. */
  portal?: boolean
  children: React.ReactNode
}

/** Pixel offset (matches the inline `mb/mt/mr/ml-1.5` = 6px) between the
 *  wrapper edge and the tooltip chip in portal mode. */
const PORTAL_GAP = 6

/** Compute a `position: fixed` placement from the wrapper's viewport rect for
 *  each side. `transform` re-centers / anchors the chip on the correct edge,
 *  mirroring the inline `SIDE_POSITION` centering semantics. */
function portalPlacement(
  side: HoverTipSide,
  rect: DOMRect
): { top: number; left: number; transform: string } {
  switch (side) {
    case 'right':
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + PORTAL_GAP,
        transform: 'translateY(-50%)'
      }
    case 'left':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - PORTAL_GAP,
        transform: 'translate(-100%, -50%)'
      }
    case 'top':
      return {
        top: rect.top - PORTAL_GAP,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)'
      }
    case 'bottom':
    default:
      return {
        top: rect.bottom + PORTAL_GAP,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)'
      }
  }
}

// 4-way positioning lookup. Centering axis swaps per side:
//   top/bottom: horizontally centered (left-1/2 -translate-x-1/2)
//   left/right: vertically centered (top-1/2 -translate-y-1/2)
// Margin offset stays at 1.5 (6px) for visual consistency.
const SIDE_POSITION: Record<HoverTipSide, string> = {
  top: 'left-1/2 -translate-x-1/2 bottom-full mb-1.5',
  bottom: 'left-1/2 -translate-x-1/2 top-full mt-1.5',
  left: 'top-1/2 -translate-y-1/2 right-full mr-1.5',
  right: 'top-1/2 -translate-y-1/2 left-full ml-1.5'
}

// Shared chip class string — identical look in both inline & portal modes;
// only the positioning differs (absolute+SIDE_POSITION vs fixed+computed).
const CHIP_CLASS = cn(
  // Sprint 13 user-feedback — width caps at 150px and wraps to multiple
  // lines for long verbs (e.g. zh-CN "归档 · 等待 Sprint 14 接 CLI" → 2
  // lines). `whitespace-pre-line` already honours explicit \n; `break-words`
  // forces wrap mid-word when zh-CN strings have no spaces. `w-max` lets
  // short labels stay single-line — only longs hit the 150px ceiling.
  'w-max max-w-[150px] whitespace-pre-line break-words text-center',
  // Size history: 9px (Sprint 13 r8) → 10px (task 06-08-chat r4) → text-micro
  // (11px, task 06-18 cleanup, user: "所有 hover 字号大一号"). 11px is the
  // text-micro CJK floor (DESIGN.md §14 #2). Deliberately NOT `font-mono` so
  // CJK glyphs stay legible at this size for glanceable hover labels.
  'text-micro leading-none text-ink-fg-2 px-1.5 py-1 rounded',
  // 投影走 `.glass-pop` 自带的 --pop-shadow：authored 的 `.glass-pop` 排在
  // `@tailwind utilities` 之后，同特异度源码序胜 —— 并挂 `shadow-[…]` 是死类（08-05 删）。
  'glass-pop pointer-events-none select-none'
)

export function HoverTip({
  text,
  side = 'top',
  className,
  portal = false,
  children
}: HoverTipProps): React.ReactElement {
  const [hover, setHover] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  // Portal mode measures the wrapper's viewport rect on enter and pins the
  // chip with `position: fixed`, so it escapes any clipping/scroll context.
  const [pos, setPos] = useState<{ top: number; left: number; transform: string } | null>(null)

  const show = (): void => {
    if (portal && wrapperRef.current) {
      setPos(portalPlacement(side, wrapperRef.current.getBoundingClientRect()))
    }
    setHover(true)
  }
  const hide = (): void => setHover(false)

  return (
    <span
      ref={wrapperRef}
      className={cn('relative inline-flex items-center', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {hover &&
        (portal && pos
          ? createPortal(
              <span
                role="tooltip"
                style={{
                  position: 'fixed',
                  top: pos.top,
                  left: pos.left,
                  transform: pos.transform,
                  zIndex: 100
                }}
                className={CHIP_CLASS}
              >
                {text}
              </span>,
              document.body
            )
          : !portal && (
              <span role="tooltip" className={cn('absolute z-50', SIDE_POSITION[side], CHIP_CLASS)}>
                {text}
              </span>
            ))}
    </span>
  )
}
