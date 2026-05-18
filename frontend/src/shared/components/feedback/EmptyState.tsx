// Sprint 7 D4 — shared Empty-state component.
//
// Used in: search zero-results, admin dead-letter empty, calendar empty,
// inbox empty (Sprint 8 wire), command palette no-match. All i18n keys
// passed in by the caller so each surface chooses its own copy.
//
// DESIGN.md §5 — empty states sit on the surface tier they appear on
// (no extra background); ink-fg-2 secondary text + optional ink-fg-1
// inline action. Mascot illustration is intentionally not in V1
// (PROJECT-PLAN.md §7 — Sprint 7 "Empty state (mascot illustration?)" with
// the question mark; the mockup never spec'd one).

import type { ReactNode } from 'react'

import { cn } from '@shared/lib/cn'

interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
  /** Mounted in a flex container? Set true to take the full slot. */
  fill?: boolean
  /** Extra class hook for layout (e.g. `min-h-[280px]`). */
  className?: string
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  fill,
  className
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center gap-2',
        fill ? 'flex-1 min-h-full py-10 px-6' : 'py-8 px-6',
        className
      )}
    >
      {icon && <span className="text-ink-fg-3 mb-1">{icon}</span>}
      <div className="text-aux text-ink-fg-1 font-medium">{title}</div>
      {hint && <div className="text-meta text-ink-fg-3 max-w-[320px] leading-relaxed">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
