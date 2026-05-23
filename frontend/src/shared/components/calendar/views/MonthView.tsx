// Phase 3 §3.2 — Month view: 6×7 grid (每周一行, 周一首列).
// 每格显示日期 + 最多 3 个 event chip, "+N 更多" 展开 popover.

import { useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'

import { EventChip } from '../EventChip'
import { EventDetailDrawer } from '../EventDetailDrawer'
import {
  useCalendarEventsInWindow,
  startOfMonth,
  startOfWeek,
  addDays
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { cn } from '@shared/lib/cn'

interface Props {
  date?: Date  // default 当前月
  calendarName?: string
}

const DAY_HEADERS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MAX_VISIBLE_PER_CELL = 3

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(d: Date): boolean {
  const t = new Date()
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear()
}

export function MonthView({ date, calendarName }: Props): React.ReactElement {
  const [active, setActive] = useState<CalendarEventOccurrence | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const monthStart = startOfMonth(date ?? new Date())
  // 月历需要从该月首日所在周的周一开始, 到 6 周后 (42 天 grid)
  const gridStart = startOfWeek(monthStart)
  const gridEnd = addDays(gridStart, 42)

  const { data, isLoading } = useCalendarEventsInWindow({
    fromIso: gridStart.toISOString(),
    toIso: gridEnd.toISOString(),
    calendarName
  })

  if (isLoading) return <div className="text-aux text-ink-fg-2">加载中…</div>

  const events = data ?? []
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title="本月无日程"
      />
    )
  }

  // Group by day
  const byDay = new Map<string, CalendarEventOccurrence[]>()
  for (const occ of events) {
    const d = new Date(occ.occurrence_start_iso)
    const key = ymd(d)
    const arr = byDay.get(key) ?? []
    arr.push(occ)
    byDay.set(key, arr)
  }

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const currentMonth = monthStart.getMonth()

  return (
    <>
      <div className="grid grid-cols-7 border-b border-ink-border-soft">
        {DAY_HEADERS.map((label) => (
          <div
            key={label}
            className="py-2 text-center text-meta text-ink-fg-2 font-medium"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const key = ymd(d)
          const dayEvents = byDay.get(key) ?? []
          const isOtherMonth = d.getMonth() !== currentMonth
          const isExpanded = expandedKey === key
          const visible = isExpanded ? dayEvents : dayEvents.slice(0, MAX_VISIBLE_PER_CELL)
          const hiddenCount = dayEvents.length - visible.length
          const today = isToday(d)

          return (
            <div
              key={i}
              className={cn(
                'border-r border-b border-ink-border-soft min-h-[110px] p-1.5',
                'flex flex-col gap-0.5 overflow-hidden',
                isOtherMonth && 'bg-ink-2/60',
                today && 'bg-coral/5'
              )}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span
                  className={cn(
                    'text-meta font-mono tabular-nums',
                    today ? 'text-coral font-medium' : isOtherMonth ? 'text-ink-fg-3' : 'text-ink-fg-1'
                  )}
                >
                  {d.getDate()}
                </span>
                {today && (
                  <span className="text-meta text-coral font-medium">今天</span>
                )}
              </div>
              {visible.map((occ) => (
                <EventChip
                  key={`${occ.id}-${occ.occurrence_start_iso}`}
                  event={occ}
                  onClick={() => setActive(occ)}
                  compact
                />
              ))}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExpandedKey(isExpanded ? null : key)}
                  className="text-meta text-ink-fg-2 hover:text-coral mt-0.5 self-start"
                >
                  +{hiddenCount} 更多
                </button>
              )}
            </div>
          )
        })}
      </div>

      <EventDetailDrawer occurrence={active} onClose={() => setActive(null)} />
    </>
  )
}
