// 视觉复刻 mockup-calendar.html §day-view (2026-05-23) —
// 左 250px rail (mini-month + dr-summary + dr-list) + 右 day-main (timeline).
// Timeline 跟 Week 结构相同 (cal-week / wk-* / .evt / now-line), 单列.
//
// DayView 接 onDateChange (rail mini-month 点击改 selected day) — 新 API,
// CalendarLayout 已配套传 setCurrentDate.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'

import { EventBlock } from '../EventBlock'
import {
  addDays,
  layoutDay,
  startOfMonth,
  startOfWeek,
  todayStartLocal,
  useCalendarEventsInWindow
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { cn } from '@shared/lib/cn'

interface Props {
  date?: Date
  onDateChange?: (d: Date) => void
  calendarName?: string
  /** F5 — Layout 持单一 active + Drawer, view 上提选中事件. */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F5 — selected event key (= ``${id}-${occurrence_start_iso}``) 用于
   *  EventBlock selected 高亮. */
  selectedKey?: string | null
}

const HOUR_PX = 48
const GRID_COLS_ONE = '56px 1fr'
const DOW_EN_FULL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MM_DOW = ['一', '二', '三', '四', '五', '六', '日']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function shortTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function isSameDay(a: Date, b: Date): boolean {
  return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
}
function isTodayLocal(d: Date): boolean {
  return isSameDay(d, new Date())
}

interface MiniMonthProps {
  displayMonth: Date
  selDate: Date
  eventDays: Set<string>
  /** Day picked — rename 避开外层 DayView 新加的 onSelect (event occ callback). */
  onPick: (d: Date) => void
  onPrev: () => void
  onNext: () => void
}

function MiniMonth({
  displayMonth,
  selDate,
  eventDays,
  onPick,
  onPrev,
  onNext
}: MiniMonthProps): React.ReactElement {
  const monthStart = startOfMonth(displayMonth)
  const gridStart = startOfWeek(monthStart)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const currentMonth = monthStart.getMonth()
  const todayKey = ymd(todayStartLocal())
  const selKey = ymd(selDate)

  return (
    <>
      <div className="mm-head">
        <span className="mm-title">
          {monthStart.getFullYear()} 年 {monthStart.getMonth() + 1} 月
        </span>
        <div className="mm-nav">
          <button type="button" onClick={onPrev} title="上月" aria-label="上月">
            <ChevronLeft size={12} strokeWidth={2.2} />
          </button>
          <button type="button" onClick={onNext} title="下月" aria-label="下月">
            <ChevronRight size={12} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      <div className="mm-grid">
        {MM_DOW.map((d) => (
          <div key={d} className="mm-dow">
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          const isOther = c.getMonth() !== currentMonth
          const key = ymd(c)
          const isToday = key === todayKey
          const isSel = key === selKey && !isToday
          const hasEvt = eventDays.has(key)
          const interactive = !isOther
          return (
            <button
              key={i}
              type="button"
              className={cn(
                'mm-cell',
                isOther && 'is-other',
                interactive && 'in-week',
                isToday && 'today',
                isSel && 'sel'
              )}
              onClick={interactive ? () => onPick(c) : undefined}
              disabled={isOther}
              aria-label={key}
            >
              {c.getDate()}
              {hasEvt && <span className="mm-dot" aria-hidden />}
            </button>
          )
        })}
      </div>
    </>
  )
}

export function DayView({
  date,
  onDateChange,
  calendarName,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [now, setNow] = useState(() => new Date())

  const selectedDate = useMemo(() => date ?? todayStartLocal(), [date])
  const [miniMonth, setMiniMonth] = useState<Date>(() => startOfMonth(selectedDate))

  // sync mini-month displayed month when selectedDate jumps to another month
  useEffect(() => {
    const ms = startOfMonth(selectedDate)
    if (ms.getTime() !== miniMonth.getTime()) {
      setMiniMonth(ms)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate.getTime()])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const dayStart = useMemo(() => {
    const d = new Date(selectedDate)
    d.setHours(0, 0, 0, 0)
    return d
  }, [selectedDate])
  const dayEnd = useMemo(() => addDays(dayStart, 1), [dayStart])

  const { data: dayEventsRaw, isLoading } = useCalendarEventsInWindow({
    fromIso: dayStart.toISOString(),
    toIso: dayEnd.toISOString(),
    calendarName
  })

  // mini-month 6 周窗口的 events (标记每天是否有事件)
  const miniGridStart = useMemo(() => startOfWeek(startOfMonth(miniMonth)), [miniMonth])
  const miniGridEnd = useMemo(() => addDays(miniGridStart, 42), [miniGridStart])
  const { data: monthEvents } = useCalendarEventsInWindow({
    fromIso: miniGridStart.toISOString(),
    toIso: miniGridEnd.toISOString(),
    calendarName
  })
  const eventDays = useMemo(() => {
    const s = new Set<string>()
    for (const occ of monthEvents ?? []) {
      s.add(ymd(new Date(occ.occurrence_start_iso)))
    }
    return s
  }, [monthEvents])

  // scroll to 8AM after load / day change
  useEffect(() => {
    if (!isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = 8 * HOUR_PX - 16
    }
  }, [isLoading, dayStart.getTime()])

  const dayEvents = dayEventsRaw ?? []
  const allDay = dayEvents.filter((e) => e.is_all_day)
  const timed = dayEvents.filter((e) => !e.is_all_day)
  const laid = layoutDay(timed)
  const total = dayEvents.length

  const dayMs = dayStart.getTime()
  const isToday = isTodayLocal(selectedDate)
  const nowTopPx = isToday ? ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX : 0

  const dayLabel = `${DOW_EN_FULL[selectedDate.getDay()]} · ${selectedDate.getMonth() + 1}/${selectedDate.getDate()}`

  function navMonth(delta: 1 | -1): void {
    const next = new Date(miniMonth.getFullYear(), miniMonth.getMonth() + delta, 1)
    setMiniMonth(next)
  }

  function pickDay(d: Date): void {
    if (onDateChange) onDateChange(d)
  }

  const sortedTimed = [...timed].sort(
    (a, b) =>
      Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
  )

  return (
    <div className="day-view">
      <aside className="day-rail scrollbar-thin">
        <MiniMonth
          displayMonth={miniMonth}
          selDate={selectedDate}
          eventDays={eventDays}
          onPick={pickDay}
          onPrev={() => navMonth(-1)}
          onNext={() => navMonth(1)}
        />
        <div className="dr-summary">{dayLabel}</div>
        <div className="dr-count">
          {isLoading ? '加载中…' : total > 0 ? `${total} 个日程` : '本日无日程'}
        </div>
        <div>
          {allDay.map((occ) => (
            <button
              key={`ad-${occ.id}-${occ.occurrence_start_iso}`}
              type="button"
              className="dr-row"
              data-resp={(occ.response_status || '').toUpperCase()}
              onClick={() => onSelect(occ)}
              title={occ.summary || '未命名事件'}
            >
              <span className="dr-bar" />
              <div className="min-w-0 flex-1">
                <div className="dr-time">全天</div>
                <div className={cn('dr-title truncate', !occ.summary && 'empty-field')}>
                  {occ.summary || '未命名事件'}
                </div>
              </div>
            </button>
          ))}
          {sortedTimed.map((occ) => (
            <button
              key={`t-${occ.id}-${occ.occurrence_start_iso}`}
              type="button"
              className="dr-row"
              data-resp={(occ.response_status || '').toUpperCase()}
              onClick={() => onSelect(occ)}
              title={occ.summary || '未命名事件'}
            >
              <span className="dr-bar" />
              <div className="min-w-0 flex-1">
                <div className="dr-time">
                  {shortTime(occ.occurrence_start_iso)} –{' '}
                  {shortTime(occ.occurrence_end_iso)}
                </div>
                <div className={cn('dr-title truncate', !occ.summary && 'empty-field')}>
                  {occ.summary || '未命名事件'}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="day-main">
        {isLoading ? (
          <div className="text-aux text-ink-fg-2 p-6">加载中…</div>
        ) : total === 0 ? (
          <EmptyState
            icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
            title="本日无日程"
          />
        ) : (
          <div className="cal-week">
            <div className="wk-headrow" style={{ gridTemplateColumns: GRID_COLS_ONE }}>
              <div className="wk-corner" />
              <div className={cn('wk-dayhead', isToday && 'is-today')}>
                <div className="wk-dow">{DOW_EN_FULL[selectedDate.getDay()]}</div>
                <div className="wk-dn">{selectedDate.getDate()}</div>
              </div>
            </div>
            {allDay.length > 0 && (
              <div className="wk-alldayrow" style={{ gridTemplateColumns: GRID_COLS_ONE }}>
                <div className="allday-gutter">
                  <span>全天</span>
                </div>
                <div className={cn('allday-cell', isToday && 'is-today')}>
                  {allDay.map((occ) => (
                    <button
                      key={`adstrip-${occ.id}-${occ.occurrence_start_iso}`}
                      type="button"
                      className="allday-evt"
                      data-resp={(occ.response_status || '').toUpperCase()}
                      data-status={(occ.status || '').toUpperCase()}
                      onClick={() => onSelect(occ)}
                      title={occ.summary || '未命名事件'}
                    >
                      {occ.summary ? (
                        occ.summary
                      ) : (
                        <span className="empty-field">未命名事件</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div ref={scrollRef} className="wk-body scrollbar-thin">
              <div className="wk-grid" style={{ gridTemplateColumns: GRID_COLS_ONE }}>
                <div className="hour-gutter">
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="hour-label">
                      <span>{h === 0 ? '' : `${pad(h)}:00`}</span>
                    </div>
                  ))}
                </div>
                <div className={cn('day-col', isToday && 'is-today')}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="hour-cell" />
                  ))}
                  {laid.map(({ occ, col, totalCols }) => {
                    const startMs = Date.parse(occ.occurrence_start_iso)
                    const endMs = Date.parse(occ.occurrence_end_iso)
                    const topPx = ((startMs - dayMs) / 3_600_000) * HOUR_PX
                    const heightPx = ((endMs - startMs) / 3_600_000) * HOUR_PX
                    const sel =
                      selectedKey === `${occ.id}-${occ.occurrence_start_iso}`
                    return (
                      <EventBlock
                        key={`b-${occ.id}-${occ.occurrence_start_iso}`}
                        event={occ}
                        topPx={topPx}
                        heightPx={heightPx}
                        col={col}
                        totalCols={totalCols}
                        selected={sel}
                        onClick={() => onSelect(occ)}
                      />
                    )
                  })}
                </div>
                {isToday && (
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
        )}
      </div>
    </div>
  )
}
