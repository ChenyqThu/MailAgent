// Sprint 18 §PR D — three-segment row primitive (label / helper / control).
//
// Maps to mockup-settings.html lines 794-815:
//   div.flex.items-center.gap-3.px-4.py-3.5
//     div.flex-1.min-w-0           ← label + helper
//       div.text-aux.font-medium   ← label (14px CN-safe)
//       div.text-meta.text-ink-fg-2.mt-0.5  ← helper (12px mono OK)
//     <control>                    ← right-aligned, shrink-0
//
// Padding reads `--settings-tile-px` / `--settings-tile-py` via `var(--name,
// 1rem)` — same CSS variable SSoT pattern as Sprint 17 EmailRow geometry.
// :root declares the value once (index.css), this file binds. The `compact`
// variant trims py to a tighter 0.75rem for radio-group rows where the
// control is short and the row otherwise reads top-heavy.

import * as React from 'react'

import { cn } from '@shared/lib/cn'

interface RowProps {
  /** Concise label, 1-2 words ideally; rendered text-aux font-medium. */
  label: React.ReactNode
  /** Optional one-line helper under the label (mockup style: `mt-0.5
   *  text-meta text-ink-fg-2`). Multi-line wraps; keep it short. */
  helper?: React.ReactNode
  /** Optional trailing badge/meta to the LEFT of the control — useful for
   *  "需重启" pills or status dots. */
  trailing?: React.ReactNode
  /** The actual control: <Switch> / <Input> / <Select> / button cluster.
   *  Passed as children so call sites stay readable. */
  children: React.ReactNode
  /** `for=` linkage when the control is a form field. ARIA wiring lives on
   *  the call site; the row doesn't render a <label> wrapper because Radix
   *  primitives provide their own a11y. */
  htmlFor?: string
  className?: string
  /** Reduce vertical padding to py-3 — used for compact row variants
   *  (radio groups, table-style readonly lists). */
  compact?: boolean
}

export function Row({
  label,
  helper,
  trailing,
  children,
  htmlFor,
  className,
  compact = false
}: RowProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-3',
        'px-[var(--settings-tile-px,1rem)]',
        compact ? 'py-3' : 'py-[var(--settings-tile-py,0.875rem)]',
        // 仅给关联到表单控件 (htmlFor) 的可交互行一个极轻 hover wash，提示
        // 「这行可操作」；纯展示/readonly 行不加，避免误导。0.025 alpha 不盖
        // divide-y 分隔线。reduced-motion 下 transition 由全局 @media 短路，
        // hover 终态色保留无碍。
        htmlFor && 'transition-colors duration-fast hover:bg-ink-fg/[0.025]',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-aux font-medium text-ink-fg cursor-pointer">
            {label}
          </label>
        ) : (
          <div className="text-aux font-medium text-ink-fg">{label}</div>
        )}
        {helper ? <div className="text-meta text-ink-fg-2 mt-0.5">{helper}</div> : null}
      </div>
      {trailing ? <div className="shrink-0 text-meta text-ink-fg-2">{trailing}</div> : null}
      <div className="shrink-0">{children}</div>
    </div>
  )
}
