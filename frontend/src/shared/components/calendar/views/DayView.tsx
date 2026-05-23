// Phase 3 §3.2 — Day view: 单日 timeline (0:00 - 24:00, 60min 网格).

import { useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'

import { EventBlock } from '../EventBlock'
import { EventChip } from '../EventChip'
import { EventDetailDrawer } from '../EventDetailDrawer'
import {
  useCalendarEventsInWindow,
  addDays,
  todayStartLocal
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'

interface Props {
  date?: Date  // default 本地今天
  calendarName?: string
}

const HOUR_PX = 48  // 每小时 48px → 全天 24*48 = 1152px
const TIMELINE_HOURS = 24

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

/**
 * 简单并发布局: 重叠事件横向分列 (同一时间段最多 N 列, 等宽).
 * 用贪心算法 — O(n²), 对单日 <50 个事件够用.
 */
function assignColumns(events: CalendarEventOccurrence[]): Array<{
  occ: CalendarEventOccurrence
  col: number
  totalCols: number
}> {
  // 按 start 升序
  const sorted = [...events].sort(
    (a, b) =>
      Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
  )
  const cols: Array<{ end: number; occ: CalendarEventOccurrence; col: number }> = []
  const result: Array<{ occ: CalendarEventOccurrence; col: number; totalCols: number }> = []

  for (const occ of sorted) {
    const start = Date.parse(occ.occurrence_start_iso)
    const end = Date.parse(occ.occurrence_end_iso)
    // 找第一个空列
    let chosenCol = -1
    for (let i = 0; i < cols.length; i++) {
      if (cols[i].end <= start) {
        chosenCol = i
        cols[i] = { end, occ, col: i }
        break
      }
    }
    if (chosenCol === -1) {
      chosenCol = cols.length
      cols.push({ end, occ, col: chosenCol })
    }
    result.push({ occ, col: chosenCol, totalCols: 0 })  // totalCols 后面 settle
  }

  // 第二次 pass 算每组重叠的 totalCols
  const totalCols = cols.length
  for (const r of result) {
    r.totalCols = totalCols
  }
  return result
}

export function DayView({ date, calendarName }: Props): React.ReactElement {
  const [active, setActive] = useState<CalendarEventOccurrence | null>(null)

  const day = date ?? todayStartLocal()
  const next = addDays(day, 1)

  const { data, isLoading } = useCalendarEventsInWindow({
    fromIso: day.toISOString(),
    toIso: next.toISOString(),
    calendarName
  })

  if (isLoading) {
    return <div className="text-aux text-ink-fg-2">加载中…</div>
  }

  const events = data ?? []
  const allDayEvents = events.filter((e) => e.is_all_day)
  const timed = events.filter((e) => !e.is_all_day)
  const columned = assignColumns(timed)

  if (events.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title="本日无日程"
      />
    )
  }

  const dayMs = day.getTime()

  return (
    <>
      {/* 全天事件 strip */}
      {allDayEvents.length > 0 && (
        <div className="mb-2 pb-2 border-b border-ink-border-soft space-y-1">
          <h4 className="text-meta text-ink-fg-2 mb-1">全天</h4>
          {allDayEvents.map((occ) => (
            <EventChip
              key={`${occ.id}-${occ.occurrence_start_iso}`}
              event={occ}
              onClick={() => setActive(occ)}
              compact
            />
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="relative" style={{ height: `${HOUR_PX * TIMELINE_HOURS}px` }}>
        {/* 小时网格 + label */}
        {Array.from({ length: TIMELINE_HOURS + 1 }, (_, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 border-t border-ink-border-soft text-meta text-ink-fg-3 font-mono"
            style={{ top: `${i * HOUR_PX}px` }}
          >
            <span className="ml-1">{hourLabel(i)}</span>
          </div>
        ))}

        {/* Events */}
        <div className="absolute left-14 right-0 top-0 bottom-0">
          {columned.map(({ occ, col, totalCols }) => {
            const startMs = Date.parse(occ.occurrence_start_iso)
            const endMs = Date.parse(occ.occurrence_end_iso)
            const topPx = ((startMs - dayMs) / (1000 * 60 * 60)) * HOUR_PX
            const heightPx = ((endMs - startMs) / (1000 * 60 * 60)) * HOUR_PX
            const colWidthPct = 100 / Math.max(totalCols, 1)
            return (
              <EventBlock
                key={`${occ.id}-${occ.occurrence_start_iso}`}
                event={occ}
                topPx={topPx}
                heightPx={heightPx}
                leftPx={col * (colWidthPct * 6)}  // rough offset; widthPct handles main sizing
                widthPct={colWidthPct}
                onClick={() => setActive(occ)}
              />
            )
          })}
        </div>
      </div>

      <EventDetailDrawer occurrence={active} onClose={() => setActive(null)} />
    </>
  )
}
