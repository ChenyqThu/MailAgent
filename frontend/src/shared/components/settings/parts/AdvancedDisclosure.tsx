// Sprint 18 §PR F — collapsed "Advanced" disclosure.
//
// `<details>` + custom chevron, styled to match the Section tile rhythm.
// Lives at the bottom of RealtimeStorageTab and holds Tier 2 fields —
// internal tuning knobs that 95% of users never touch (LOG_LEVEL / Outbox
// 4 项 / SYNC_MODE / STATS_REPORT_INTERVAL / readonly SSE host+port /
// dbPath + attachmentDir folder pickers).
//
// 默认 collapsed. 不走 :root --settings-block-gap 变量 (跟 Section 同款),
// 而是在 Section 之内, so the outer `mb-7` already separates Advanced
// from the next section.

import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@shared/lib/cn'

interface AdvancedDisclosureProps {
  /** Summary label, e.g. "Advanced" / "高级选项". */
  label: React.ReactNode
  /** Optional muted subtitle next to the label. */
  helper?: React.ReactNode
  /** Rendered as the disclosure body — typically a Section / Row stack. */
  children: React.ReactNode
  /** Defaults to false. Set true if a particular caller wants the panel
   *  open on mount (e.g. when a deep-link query param requests it). */
  defaultOpen?: boolean
  className?: string
}

export function AdvancedDisclosure({
  label,
  helper,
  children,
  defaultOpen = false,
  className
}: AdvancedDisclosureProps): React.ReactElement {
  // 受控 disclosure（替代原生 <details>），用 CSS grid-template-rows 0fr→1fr 做
  // 纯 CSS 高度展开（§4.1 优先级：能 grid-rows 解决不上 GSAP）。reduced-motion 时
  // motion-reduce:transition-none 去掉过渡 —— 纯 CSS 走 @media 即可, 无需 JS hook。
  const [open, setOpen] = React.useState(defaultOpen)
  const bodyId = React.useId()

  return (
    <div className={cn('group rounded-lg border border-ink-border-soft', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          'flex items-center gap-2 w-full text-left cursor-pointer select-none',
          'px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]',
          'rounded-lg transition-colors duration-fast ease-standard',
          'hover:bg-ink-3/40'
        )}
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-ink-fg-2',
            'transition-transform duration-fast ease-standard motion-reduce:transition-none',
            open ? 'rotate-0' : '-rotate-90'
          )}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="text-aux font-medium text-ink-fg">{label}</div>
          {helper ? <div className="text-meta text-ink-fg-2 mt-0.5">{helper}</div> : null}
        </div>
      </button>
      <div
        id={bodyId}
        role="region"
        aria-hidden={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-base ease-standard',
          'motion-reduce:transition-none'
        )}
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="divide-y divide-ink-border-soft border-t border-ink-border-soft">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
