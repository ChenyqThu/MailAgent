// 视觉复刻 mockup-calendar.html §.chip (2026-05-23) —
// 月视图单格 + agenda all-day strip 的紧凑 event chip.
// 用 .chip + data-resp / data-status 走 CSS 渲染 4 种 response + cancelled.

import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

interface EventChipProps {
  event: CalendarEventOccurrence
  /** compact = 不显示时间, 只 dot + title (week all-day strip 用). */
  compact?: boolean
  onClick?: () => void
}

function localTimeShort(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function EventChip({ event, compact = false, onClick }: EventChipProps): React.ReactElement {
  const startTxt = event.is_all_day ? '全天' : localTimeShort(event.occurrence_start_iso)
  return (
    <button
      type="button"
      className="chip"
      data-resp={(event.response_status || '').toUpperCase()}
      data-status={(event.status || '').toUpperCase()}
      onClick={onClick}
      title={event.summary || '未命名事件'}
    >
      <span className="c-dot" aria-hidden />
      {!compact && !event.is_all_day && <span className="c-time">{startTxt}</span>}
      {compact && event.is_all_day && <span className="c-time">全天</span>}
      <span className={cn('c-title', !event.summary && 'empty-field')}>
        {event.summary || '未命名事件'}
      </span>
    </button>
  )
}
