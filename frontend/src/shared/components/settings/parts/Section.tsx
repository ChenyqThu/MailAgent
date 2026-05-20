// Sprint 18 §PR D — Settings "section" tile container.
//
// Mirrors mockup-settings.html `.tile rounded-lg border border-ink-border-soft
// divide-y divide-ink-border-soft` (line 794+ in mockup). One Section per
// logical grouping inside a Tab; rows live as direct children, the
// `divide-y` Tailwind class draws the 1px separator between them.
//
// Block rhythm reads `--settings-block-gap` via Tailwind arbitrary value
// `var(--name, 1.75rem)` — the same CSS variable SSoT pattern Sprint 17 used
// for EmailRow geometry (`--avatar-size`, `--chevron-col-w`). The literal
// inside `var()` is the CSS-spec default value declaration; :root sets the
// canonical value (declared once in index.css), this file binds to it.

import * as React from 'react'

import { cn } from '@shared/lib/cn'

interface SectionProps {
  /** Required, rendered above the tile as `text-lead font-medium`. */
  title: React.ReactNode
  /** Optional meta (right-aligned `text-meta font-mono text-ink-fg-2`),
   *  used for keyboard shortcut hints, counts, or "Advanced" pills. */
  meta?: React.ReactNode
  /** Helper paragraph rendered between the title row and the tile. Use
   *  `text-aux text-ink-fg-1` rules at the call site if you need block-level
   *  formatting (Section keeps it short — long descriptions belong in the
   *  per-Row helper). */
  helper?: React.ReactNode
  className?: string
  children: React.ReactNode
}

export function Section({
  title,
  meta,
  helper,
  className,
  children
}: SectionProps): React.ReactElement {
  return (
    <div className={cn('mb-[var(--settings-block-gap,1.75rem)]', className)}>
      <div className="flex items-end justify-between mb-2.5">
        <div className="text-lead font-medium text-ink-fg">{title}</div>
        {meta ? <div className="text-meta font-mono text-ink-fg-2">{meta}</div> : null}
      </div>
      {helper ? <div className="text-aux text-ink-fg-1 mb-2.5">{helper}</div> : null}
      <div
        className={cn(
          'tile rounded-lg border border-ink-border-soft',
          'divide-y divide-ink-border-soft'
        )}
      >
        {children}
      </div>
    </div>
  )
}
