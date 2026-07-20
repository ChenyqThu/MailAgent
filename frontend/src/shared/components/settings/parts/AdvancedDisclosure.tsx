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

import { cn } from '@shared/lib/cn'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'

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
  // 受控 disclosure（替代原生 <details>）。折叠机制走 @shared/components/ui/collapsible
  // 的统一原语（2026-07-20 抽单源前这里是手抄的一份 grid-rows；迁过去顺带拿到
  // `inert` —— 原实现只挂 aria-hidden，折叠态的表单控件仍在 tab 序里）。
  const [open, setOpen] = React.useState(defaultOpen)
  const bodyId = React.useId()
  // role="region" 必须有名字，否则无名 region 只是 AT 里的噪音（codex NIT-2）。
  const labelId = React.useId()

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
        <CollapseChevron expanded={open} size={16} className="text-ink-fg-2" />
        <div className="flex-1 min-w-0">
          <div id={labelId} className="text-aux font-medium text-ink-fg">
            {label}
          </div>
          {helper ? <div className="text-meta text-ink-fg-2 mt-0.5">{helper}</div> : null}
        </div>
      </button>
      <CollapsibleRegion expanded={open} id={bodyId} role="region" aria-labelledby={labelId}>
        <div className="divide-y divide-ink-border-soft border-t border-ink-border-soft">
          {children}
        </div>
      </CollapsibleRegion>
    </div>
  )
}
