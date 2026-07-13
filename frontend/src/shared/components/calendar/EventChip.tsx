// 视觉复刻 mockup-calendar.html §.chip (2026-05-23) —
// 月视图单格 + agenda all-day strip 的紧凑 event chip.
// 用 .cal-chip + data-resp / data-status 走 CSS 渲染 4 种 response + cancelled.

import { useTranslation } from 'react-i18next'

import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

interface EventChipProps {
  event: CalendarEventOccurrence
  /** compact = 不显示时间, 只 dot + title (week all-day strip 用). */
  compact?: boolean
  /** F4/Q13 — drawer 打开的 occurrence 锚点高亮 (.is-selected). */
  selected?: boolean
  onClick?: () => void
}

function localTimeShort(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function EventChip({
  event,
  compact = false,
  selected = false,
  onClick
}: EventChipProps): React.ReactElement {
  const { t } = useTranslation()
  const allDayLabel = t('calendar.shared.allDay', '全天')
  const untitled = t('calendar.shared.untitled', '未命名事件')
  const startTxt = event.is_all_day ? allDayLabel : localTimeShort(event.occurrence_start_iso)
  return (
    <button
      type="button"
      className={cn('cal-chip', selected && 'is-selected')}
      data-resp={(event.response_status || '').toUpperCase()}
      data-status={(event.status || '').toUpperCase()}
      onClick={onClick}
      title={event.summary || untitled}
    >
      <span className="c-dot" aria-hidden />
      {!compact && !event.is_all_day && <span className="c-time">{startTxt}</span>}
      {compact && event.is_all_day && <span className="c-time">{allDayLabel}</span>}
      <span className={cn('c-title', !event.summary && 'empty-field')}>
        {event.summary || untitled}
      </span>
    </button>
  )
}
