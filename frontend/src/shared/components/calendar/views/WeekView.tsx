// Phase 3 §3.2 — Week view: 7 列 (Mon-Sun) × 24h timeline.

import { useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'

import { EventBlock } from '../EventBlock'
import { EventChip } from '../EventChip'
import { EventDetailDrawer } from '../EventDetailDrawer'
import {
  useCalendarEventsInWindow,
  addDays,
  startOfWeek
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { cn } from '@shared/lib/cn'

interface Props {
  date?: Date  // default 本地今天所在周
  calendarName?: string
}

const HOUR_PX = 40  // 周视图缩到 40px/h, 总高 960px
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(d: Date): boolean {
  const t = new Date()
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear()
}

export function WeekView({ date, calendarName }: Props): React.ReactElement {
  const [active, setActive] = useState<CalendarEventOccurrence | null>(null)

  const weekStart = startOfWeek(date ?? new Date())
  const weekEnd = addDays(weekStart, 7)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const { data, isLoading } = useCalendarEventsInWindow({
    fromIso: weekStart.toISOString(),
    toIso: weekEnd.toISOString(),
    calendarName
  })

  if (isLoading) return <div className="text-aux text-ink-fg-2">加载中…</div>

  const events = data ?? []
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title="本周无日程"
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

  return (
    <>
      {/* 表头: 7 列 */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-ink-border-soft sticky top-0 bg-ink-2 z-10">
        <div></div>
        {days.map((d, i) => (
          <div
            key={i}
            className={cn(
              'text-center py-2 text-aux',
              isToday(d) ? 'text-coral font-medium' : 'text-ink-fg-1'
            )}
          >
            <div className="text-meta text-ink-fg-2">{DAY_NAMES[i]}</div>
            <div className="tabular-nums">{d.getMonth() + 1}/{d.getDate()}</div>
          </div>
        ))}
      </div>

      {/* 全天事件 strip — 跨7天 */}
      {events.some((e) => e.is_all_day) && (
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-ink-border-soft py-1">
          <div className="text-meta text-ink-fg-2 px-1">全天</div>
          {days.map((d, i) => {
            const dayKey = ymd(d)
            const allDay = (byDay.get(dayKey) ?? []).filter((e) => e.is_all_day)
            return (
              <div key={i} className="px-0.5 space-y-0.5">
                {allDay.map((occ) => (
                  <EventChip
                    key={`${occ.id}-${occ.occurrence_start_iso}`}
                    event={occ}
                    onClick={() => setActive(occ)}
                    compact
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Timeline grid */}
      <div
        className="relative grid grid-cols-[60px_repeat(7,1fr)]"
        style={{ height: `${HOUR_PX * 24}px` }}
      >
        {/* 小时 label 列 */}
        <div className="relative">
          {Array.from({ length: 24 }, (_, i) => (
            <div
              key={i}
              className="absolute left-0 right-0 text-meta text-ink-fg-3 font-mono pl-1 border-t border-ink-border-soft"
              style={{ top: `${i * HOUR_PX}px` }}
            >
              {String(i).padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {/* 7 day columns */}
        {days.map((d, i) => {
          const dayKey = ymd(d)
          const timed = (byDay.get(dayKey) ?? []).filter((e) => !e.is_all_day)
          const dayMs = d.getTime()
          return (
            <div
              key={i}
              className={cn(
                'relative border-l border-ink-border-soft',
                isToday(d) && 'bg-coral/5'
              )}
            >
              {/* 小时网格线 */}
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-ink-border-soft/40"
                  style={{ top: `${h * HOUR_PX}px` }}
                />
              ))}
              {/* events */}
              {timed.map((occ) => {
                const startMs = Date.parse(occ.occurrence_start_iso)
                const endMs = Date.parse(occ.occurrence_end_iso)
                const topPx = Math.max(0, ((startMs - dayMs) / (1000 * 60 * 60)) * HOUR_PX)
                const heightPx = ((endMs - startMs) / (1000 * 60 * 60)) * HOUR_PX
                return (
                  <EventBlock
                    key={`${occ.id}-${occ.occurrence_start_iso}`}
                    event={occ}
                    topPx={topPx}
                    heightPx={heightPx}
                    onClick={() => setActive(occ)}
                  />
                )
              })}
            </div>
          )
        })}
      </div>

      <EventDetailDrawer occurrence={active} onClose={() => setActive(null)} />
    </>
  )
}
