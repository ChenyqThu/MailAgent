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
  return (
    <details
      open={defaultOpen}
      className={cn('group rounded-lg border border-ink-border-soft', className)}
    >
      <summary
        className={cn(
          'flex items-center gap-2 cursor-pointer select-none list-none',
          'px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]',
          'rounded-lg transition-colors duration-fast ease-standard',
          'hover:bg-ink-3/40',
          // Hide the default disclosure marker — we render our own chevron.
          '[&::-webkit-details-marker]:hidden'
        )}
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-ink-fg-2',
            'transition-transform duration-fast ease-standard',
            '-rotate-90 group-open:rotate-0'
          )}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="text-aux font-medium text-ink-fg">{label}</div>
          {helper ? <div className="text-meta text-ink-fg-2 mt-0.5">{helper}</div> : null}
        </div>
      </summary>
      <div className="divide-y divide-ink-border-soft border-t border-ink-border-soft">
        {children}
      </div>
    </details>
  )
}
