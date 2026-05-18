// Sprint 7 D4 — loading skeleton primitives.
//
// Replaces inline "加载中…" / "Loading…" strings sprinkled across admin /
// llm / calendar / settings. The visual is a single low-key ink-3 block
// with a subtle pulse — same animation respects prefers-reduced-motion.
//
// We deliberately stay minimal (no shimmer keyframes, no per-line widths).
// The skeleton is meant to indicate "data on the way" without faking the
// final layout pixel-for-pixel — that level of fidelity belongs in V1.5.

import { cn } from '@shared/lib/cn'

interface SkeletonProps {
  /** Number of bars to render vertically (each h-3, gap-2). Default 3. */
  rows?: number
  /** Extra container class (e.g. `px-3 py-4`). */
  className?: string
  /** Width of each bar — `full`, `2/3`, `1/2`. Default `full`. */
  width?: 'full' | '2/3' | '1/2'
}

const WIDTH_CLASS: Record<NonNullable<SkeletonProps['width']>, string> = {
  full: 'w-full',
  '2/3': 'w-2/3',
  '1/2': 'w-1/2'
}

export function Skeleton({
  rows = 3,
  className,
  width = 'full'
}: SkeletonProps): React.ReactElement {
  // Sprint 9 D4.2 (Sprint 7 review Nit-2) — string-prefixed key so the
  // lint scanner (and human reviewers) can see it's intentionally
  // index-based for a fixed-length, non-reordered placeholder render.
  return (
    <div className={cn('animate-pulse motion-reduce:animate-none space-y-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={`skeleton-bar-${i}`} className={cn('h-3 rounded bg-ink-3', WIDTH_CLASS[width])} />
      ))}
    </div>
  )
}

/** A card-sized skeleton (4 rows, ~64px tall). Drop into a card grid as a
 *  placeholder while the data arrives. */
export function SkeletonCard({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-md border border-ink-border bg-ink-2 p-3 space-y-2',
        'animate-pulse motion-reduce:animate-none',
        className
      )}
    >
      <div className="h-3 w-1/3 rounded bg-ink-3" />
      <div className="h-5 w-2/3 rounded bg-ink-3" />
      <div className="h-3 w-1/2 rounded bg-ink-3" />
    </div>
  )
}

/** A row-sized skeleton for tables (single row, columns laid out roughly). */
export function SkeletonRow(): React.ReactElement {
  return (
    <div className="animate-pulse motion-reduce:animate-none flex items-center gap-3 px-3 py-2 border-b border-ink-border-soft">
      <div className="h-3 w-12 rounded bg-ink-3" />
      <div className="h-3 flex-1 rounded bg-ink-3" />
      <div className="h-3 w-16 rounded bg-ink-3" />
      <div className="h-3 w-20 rounded bg-ink-3" />
    </div>
  )
}
