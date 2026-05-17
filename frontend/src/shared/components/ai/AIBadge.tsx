// DESIGN.md §5.2 — priority chip. 5 variants matching the §2.3 enum, all
// reading their tokens from tailwind.config.ts (`crit / urg / impt / norm /
// low`). The mockup uses cva for the variant slot; we keep that pattern so
// renaming a tier later is a single-source edit.
//
// `withDot` adds the 1.5px round dot prefix EmailRow uses; the AIFieldsBlock
// 3×8 grid renders the chip without the dot (the priority cell IS the dot
// visually).

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@shared/lib/cn'
import type { AIPriority } from '@shared/api/types'

const aiBadge = cva(
  'inline-flex items-center gap-1.5 text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border',
  {
    variants: {
      priority: {
        critical: 'text-crit bg-crit/15 border-crit/30',
        urgent: 'text-urg  bg-urg/15  border-urg/30',
        important: 'text-impt bg-impt/15 border-impt/30',
        normal: 'text-norm bg-norm/15 border-norm/30',
        low: 'text-low  bg-low/15  border-low/30'
      }
    },
    defaultVariants: { priority: 'normal' }
  }
)

const DOT_BY_PRIORITY: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}

interface Props extends VariantProps<typeof aiBadge> {
  /** Renders the leading 1.5px dot (EmailRow style). Off by default for AIFieldsBlock. */
  withDot?: boolean
  className?: string
  /** Label is English UPPERCASE by design (DESIGN.md §3.3) — keep CN out of `text-micro`. */
  children: React.ReactNode
}

export function AIBadge({
  priority,
  withDot = false,
  className,
  children
}: Props): React.ReactElement {
  return (
    <span className={cn(aiBadge({ priority }), className)}>
      {withDot && priority && (
        <span className={cn('w-1.5 h-1.5 rounded-full', DOT_BY_PRIORITY[priority])} aria-hidden />
      )}
      {children}
    </span>
  )
}
