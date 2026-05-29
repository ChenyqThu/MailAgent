// 视觉复刻 mockup-calendar.html §week (2026-05-23) —
// 3 段 flex column: wk-headrow + wk-alldayrow + wk-body (内 scroll, 默认到 8AM).
// HOUR_PX=48, 7 列 (Mon-Sun) × 24h. now-line + now-bubble 跟今天列漂浮.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EventBlock } from '../EventBlock'
import { isTodayLocal, pad, ymd } from '../lib/format'
import {
  useCalendarEventsInWindow,
  addDays,
  startOfWeek,
  layoutDay
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { cn } from '@shared/lib/cn'

interface Props {
  date?: Date
  calendarName?: string
  /** Phase 4·#1 — 多 calendar 多选 (client-side filter). 空 = 全部. */
  selectedCalendars?: string[]
  /** F5 — view 不再 own selected event state; CalendarLayout 持单一 active
   *  + mount 单一 Drawer, view 通过 callback 上提选中事件. */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F5 — selected event key (= ``${id}-${occurrence_start_iso}``) 由 Layout
   *  传, view 比对来高亮 selected event block. */
  selectedKey?: string | null
}

const HOUR_PX = 48
const DOW_EN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const GRID_COLS = '56px repeat(7, 1fr)'

// F32 — ymd/pad/isSameDay/isTodayLocal 抽到 ../lib/format

export function WeekView({
  date,
  calendarName,
  selectedCalendars,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [now, setNow] = useState(() => new Date())

  // refresh now-line each minute
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const weekStart = useMemo(() => startOfWeek(date ?? new Date()), [date])
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )

  const { data, isLoading } = useCalendarEventsInWindow(
    {
      fromIso: weekStart.toISOString(),
      toIso: weekEnd.toISOString(),
      calendarName
    },
    selectedCalendars
  )

  // 默认 scroll 到 8AM (events 渲染完 / 切日期重新加载完都 reset).
  useEffect(() => {
    if (!isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = 8 * HOUR_PX - 16
    }
  }, [isLoading, weekStart.getTime()])

  // 首次加载 (无 placeholderData 旧数据可借) 才显骨架; 切周时 isLoading=false,
  // 旧周事件经 keepPreviousData 留屏直到新周 ready, 不显骨架不闪白.
  if (isLoading) {
    return (
      <div className="cal-week" aria-busy="true">
        <Skeleton rows={8} className="p-6" />
      </div>
    )
  }

  const events = data ?? []
  if (events.length === 0) {
    return (
      <div className="cal-week">
        <EmptyState
          icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
          title={t('calendar.empty.week', '本周无日程')}
          hint="CalDAV worker 可能尚未启用 — 检查 CALENDAR_CALDAV_SYNC_ENABLED"
        />
      </div>
    )
  }

  // group timed events by day
  const byDay = new Map<string, CalendarEventOccurrence[]>()
  for (const occ of events) {
    if (occ.is_all_day) continue
    const d = new Date(occ.occurrence_start_iso)
    const key = ymd(d)
    const arr = byDay.get(key) ?? []
    arr.push(occ)
    byDay.set(key, arr)
  }
  const allDayEvents = events.filter((e) => e.is_all_day)
  const hasAllDay = allDayEvents.length > 0

  // now-line position
  const todayIdx = days.findIndex(isTodayLocal)
  const showNow = todayIdx >= 0
  const nowTopPx = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX

  return (
    <div className="cal-week">
      {/* head row */}
      <div className="wk-headrow" style={{ gridTemplateColumns: GRID_COLS }}>
        <div className="wk-corner" />
        {days.map((d, i) => (
          <div key={i} className={cn('wk-dayhead', isTodayLocal(d) && 'is-today')}>
            <div className="wk-dow">{DOW_EN[i]}</div>
            <div className="wk-dn">{d.getDate()}</div>
          </div>
        ))}
      </div>

      {/* all-day strip — 仅当本周有 all-day 事件时显示 */}
      {hasAllDay && (
        <div className="wk-alldayrow" style={{ gridTemplateColumns: GRID_COLS }}>
          <div className="allday-gutter">
            <span>{t('calendar.shared.allDay', '全天')}</span>
          </div>
          {days.map((d, i) => {
            const dayMs = d.getTime()
            const nextMs = dayMs + 86_400_000
            const evs = allDayEvents.filter((e) => {
              const s = Date.parse(e.occurrence_start_iso)
              const en = Date.parse(e.occurrence_end_iso)
              return s < nextMs && en > dayMs
            })
            return (
              <div key={i} className={cn('allday-cell', isTodayLocal(d) && 'is-today')}>
                {evs.map((occ) => (
                  <button
                    key={`${occ.id}-${occ.occurrence_start_iso}`}
                    type="button"
                    className="allday-evt"
                    data-resp={(occ.response_status || '').toUpperCase()}
                    data-status={(occ.status || '').toUpperCase()}
                    onClick={() => onSelect(occ)}
                    title={occ.summary || t('calendar.shared.untitled', '未命名事件')}
                  >
                    {occ.summary ? (
                      occ.summary
                    ) : (
                      <span className="empty-field">
                        {t('calendar.shared.untitled', '未命名事件')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* scrolling timeline body */}
      <div ref={scrollRef} className="wk-body scrollbar-thin">
        <div className="wk-grid" style={{ gridTemplateColumns: GRID_COLS }}>
          {/* hour gutter */}
          <div className="hour-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="hour-label">
                <span>{h === 0 ? '' : `${pad(h)}:00`}</span>
              </div>
            ))}
          </div>

          {/* 7 day columns */}
          {days.map((d, di) => {
            const dKey = ymd(d)
            const dayMs = d.getTime()
            const timed = byDay.get(dKey) ?? []
            const laid = layoutDay(timed)
            return (
              <div key={di} className={cn('day-col', isTodayLocal(d) && 'is-today')}>
                {/* 24 hour cells for visual grid */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="hour-cell" />
                ))}
                {/* events */}
                {laid.map(({ occ, col, totalCols }) => {
                  const startMs = Date.parse(occ.occurrence_start_iso)
                  const endMs = Date.parse(occ.occurrence_end_iso)
                  const topPx = ((startMs - dayMs) / 3_600_000) * HOUR_PX
                  const heightPx = ((endMs - startMs) / 3_600_000) * HOUR_PX
                  const selected = selectedKey === `${occ.id}-${occ.occurrence_start_iso}`
                  return (
                    <EventBlock
                      key={`${occ.id}-${occ.occurrence_start_iso}`}
                      event={occ}
                      topPx={topPx}
                      heightPx={heightPx}
                      col={col}
                      totalCols={totalCols}
                      selected={selected}
                      onClick={() => onSelect(occ)}
                    />
                  )
                })}
              </div>
            )
          })}

          {/* now line + bubble — 当本周包含今天才画 */}
          {showNow && (
            <>
              <div className="now-bubble" style={{ top: `${nowTopPx}px` }}>
                {pad(now.getHours())}:{pad(now.getMinutes())}
              </div>
              <div className="now-line" style={{ top: `${nowTopPx}px` }} aria-hidden />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
