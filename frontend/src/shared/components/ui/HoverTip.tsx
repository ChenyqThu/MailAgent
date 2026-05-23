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

import { useState } from 'react'

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
  children: React.ReactNode
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

export function HoverTip({
  text,
  side = 'top',
  className,
  children
}: HoverTipProps): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <span
      className={cn('relative inline-flex items-center', className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      {children}
      {hover && (
        <span
          role="tooltip"
          className={cn(
            'absolute z-50',
            SIDE_POSITION[side],
            // Sprint 13 user-feedback — width caps at 150px and wraps to
            // multiple lines for long verbs (e.g. zh-CN "归档 · 等待 Sprint
            // 14 接 CLI" → 2 lines). `whitespace-pre-line` already honours
            // explicit \n; `break-words` forces wrap mid-word when zh-CN
            // strings have no spaces. `w-max` lets short labels stay
            // single-line — only longs hit the 150px ceiling.
            'w-max max-w-[150px] whitespace-pre-line break-words text-center',
            // Sprint 13 round 8 user feedback — "再小 2 个号" from
            // text-micro (11px). 9px arbitrary value approaches the
            // macOS mini-control caption (Navi-style). Deliberately
            // NOT `font-mono` so CJK glyphs don't go mossy at this
            // size (DESIGN.md §14 #2 bans CJK at mono 11/12px). Sans
            // 9px stays legible enough for hover labels which are
            // glanceable, not body copy.
            'text-[9px] leading-none text-ink-fg-2 px-1.5 py-1 rounded',
            'glass-pop pointer-events-none select-none',
            'shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
          )}
        >
          {text}
        </span>
      )}
    </span>
  )
}
