// DESIGN.md §3.3 — sidebar/right-panel section labels stay English UPPERCASE
// mono 11px on purpose. CJK at this size is the banned "韩式糊字号" look, and
// the english label evokes Mimestream/Linear/VS Code tool typography. Lint
// rule no-cjk-in-mono-size (DESIGN.md §16.6, Sprint 1.7) enforces this at CI.

import { cn } from '@shared/lib/cn'

interface Props {
  /** English UPPERCASE label. Use the `<count>` slot for numeric tail (e.g. "8 / 11"). */
  label: string
  count?: string | number
  className?: string
}

export function SectionHeader({ label, count, className }: Props): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between px-3 pt-4 pb-1.5',
        'text-micro font-mono uppercase tracking-widest text-ink-fg-2 select-none',
        className
      )}
    >
      <span>{label}</span>
      {count !== undefined && <span className="font-mono tabular-nums text-ink-fg-3">{count}</span>}
    </div>
  )
}
