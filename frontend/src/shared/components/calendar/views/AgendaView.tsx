// Phase 3 §3.2 — Agenda view: 按日期 group 的纯列表 (最简单 + 高密度).

import { useState } from 'react'
import { Calendar as CalendarIcon, RefreshCw } from 'lucide-react'

import { EventChip } from '../EventChip'
import { EventDetailDrawer } from '../EventDetailDrawer'
import {
  useCalendarEventsInWindow,
  groupOccurrencesByLocalDay,
  todayStartLocal,
  addDays
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import { cn } from '@shared/lib/cn'

interface Props {
  rangeDays?: number  // default 14 天
  calendarName?: string
}

function dayLabel(key: string): string {
  // key = YYYY-MM-DD (本地)
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = todayStartLocal()
  const tomorrow = addDays(today, 1)
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  if (key === todayKey) return `今天 (${m}/${d})`
  if (key === tomorrowKey) return `明天 (${m}/${d})`
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${m}/${d} ${weekDays[date.getDay()]}`
}

export function AgendaView({ rangeDays = 14, calendarName }: Props): React.ReactElement {
  const [active, setActive] = useState<CalendarEventOccurrence | null>(null)

  const start = todayStartLocal()
  const end = addDays(start, rangeDays)
  const { data, isLoading, refetch } = useCalendarEventsInWindow({
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
    calendarName
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title="未来 2 周无日程"
        hint="CalDAV worker 可能尚未启用 — 检查 CALENDAR_CALDAV_SYNC_ENABLED"
      />
    )
  }

  const grouped = groupOccurrencesByLocalDay(data)
  const sortedKeys = Array.from(grouped.keys()).sort()

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <p className="text-aux text-ink-fg-2">
          {data.length} 个日程, 未来 {rangeDays} 天
        </p>
        <button
          type="button"
          onClick={refetch}
          className="inline-flex items-center gap-1 px-2 py-1 text-meta text-ink-fg-2 hover:text-ink-fg"
          aria-label="刷新"
        >
          <RefreshCw size={12} strokeWidth={2} />
          刷新
        </button>
      </div>

      <div className="space-y-4">
        {sortedKeys.map((key) => (
          <section key={key}>
            <h3
              className={cn(
                'text-aux text-ink-fg-1 font-medium mb-1.5 pb-1',
                'border-b border-ink-border-soft'
              )}
            >
              {dayLabel(key)}
              <span className="ml-2 text-meta text-ink-fg-2 tabular-nums">
                {(grouped.get(key) ?? []).length} 项
              </span>
            </h3>
            <div className="space-y-1">
              {(grouped.get(key) ?? []).map((occ) => (
                <EventChip
                  key={`${occ.id}-${occ.occurrence_start_iso}`}
                  event={occ}
                  onClick={() => setActive(occ)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <EventDetailDrawer occurrence={active} onClose={() => setActive(null)} />
    </>
  )
}
