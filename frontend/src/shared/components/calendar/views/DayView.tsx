// 视觉复刻 mockup-calendar.html §day-view (2026-05-23) —
// 左 250px rail (mini-month + dr-summary + dr-list) + 右 day-main (timeline).
// Timeline 跟 Week 结构相同 (cal-week / wk-* / .evt / now-line), 单列.
//
// DayView 接 onDateChange (rail mini-month 点击改 selected day) — 新 API,
// CalendarLayout 已配套传 setCurrentDate.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CalendarQueryError } from '../CalendarQueryError'
import { EventBlock } from '../EventBlock'
import { isTodayLocal, pad, shortTime, ymd } from '../lib/format'
import {
  addDays,
  layoutDay,
  startOfMonth,
  startOfWeek,
  todayStartLocal,
  useCalendarEventsInWindow
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

import { CalendarViewEmpty } from './CalendarViewEmpty'
import { TimelineSkeleton } from './TimelineSkeleton'

interface Props {
  date?: Date
  onDateChange?: (d: Date) => void
  calendarName?: string
  /** Phase 4·#1 — 多 calendar 多选 (client-side filter). 空 = 全部. */
  selectedCalendars?: string[]
  /** F5 — Layout 持单一 active + Drawer, view 上提选中事件. */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F5 — selected event key (= ``${id}-${occurrence_start_iso}``) 用于
   *  EventBlock selected 高亮 + F4/Q13 rail 行锚点. */
  selectedKey?: string | null
}

const HOUR_PX = 48
const GRID_COLS_ONE = '56px 1fr'
const DOW_EN_FULL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MM_DOW = ['一', '二', '三', '四', '五', '六', '日']

// F32 — pad/ymd/shortTime/isSameDay/isTodayLocal 抽到 ../lib/format

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
  const { t } = useTranslation()
  const monthStart = startOfMonth(displayMonth)
  const gridStart = startOfWeek(monthStart)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const currentMonth = monthStart.getMonth()
  const todayKey = ymd(todayStartLocal())
  const selKey = ymd(selDate)
  const prevMonthLabel = t('calendar.view.day.prevMonthAria', '上月')
  const nextMonthLabel = t('calendar.view.day.nextMonthAria', '下月')

  return (
    <>
      <div className="mm-head">
        <span className="mm-title">
          {monthStart.getFullYear()} 年 {monthStart.getMonth() + 1} 月
        </span>
        <div className="mm-nav">
          <button type="button" onClick={onPrev} title={prevMonthLabel} aria-label={prevMonthLabel}>
            <ChevronLeft size={12} strokeWidth={2.2} />
          </button>
          <button type="button" onClick={onNext} title={nextMonthLabel} aria-label={nextMonthLabel}>
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
  selectedCalendars,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [now, setNow] = useState(() => new Date())

  const selectedDate = useMemo(() => date ?? todayStartLocal(), [date])
  const [miniMonth, setMiniMonth] = useState<Date>(() => startOfMonth(selectedDate))

  // F12 — selectedDate 跳到别的月时把 mini-month 同步过去。React 官方 "adjusting
  // state during render"：render 期间条件 setState（getTime 不等守卫防循环），比 effect
  // 少一次 commit+paint，无 set-state-in-effect 级联告警。原 effect 版 deps=[selectedDate,
  // miniMonth] 修过 stale-closure（翻 miniMonth 到 6 月又把 selectedDate 设回 5 月同 ms 时
  // effect 不跑卡月）——render 期间判定天然无此问题（每帧都比对当前值）。
  const targetMonth = startOfMonth(selectedDate)
  if (targetMonth.getTime() !== miniMonth.getTime()) {
    setMiniMonth(targetMonth)
  }

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

  const {
    data: dayEventsRaw,
    isLoading,
    isError,
    refetch
  } = useCalendarEventsInWindow(
    {
      fromIso: dayStart.toISOString(),
      toIso: dayEnd.toISOString(),
      calendarName
    },
    selectedCalendars
  )

  // mini-month 6 周窗口的 events (标记每天是否有事件)
  const miniGridStart = useMemo(() => startOfWeek(startOfMonth(miniMonth)), [miniMonth])
  const miniGridEnd = useMemo(() => addDays(miniGridStart, 42), [miniGridStart])
  const { data: monthEvents } = useCalendarEventsInWindow(
    {
      fromIso: miniGridStart.toISOString(),
      toIso: miniGridEnd.toISOString(),
      calendarName
    },
    selectedCalendars
  )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: Date 对象引用不稳定, 用 getTime() 数值比较才能避免每渲染重滚; React Compiler 迁移时再提取变量。
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
    (a, b) => Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
  )

  // 1.13 尾巴 — 主区已换错误屏时 rail 计数不再谎报「本日无日程」.
  const railCountTxt = isLoading
    ? t('calendar.shared.loading', '加载中…')
    : isError && total === 0
      ? t('calendar.error.loadShort', '加载失败')
      : total > 0
        ? t('calendar.view.day.count', '{n} 个日程', { n: total })
        : t('calendar.empty.day', '本日无日程')

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
        <div className="dr-count">{railCountTxt}</div>
        <div>
          {allDay.map((occ) => (
            <button
              key={`ad-${occ.id}-${occ.occurrence_start_iso}`}
              type="button"
              className={cn(
                'dr-row',
                selectedKey === `${occ.id}-${occ.occurrence_start_iso}` && 'is-selected'
              )}
              data-resp={(occ.response_status || '').toUpperCase()}
              onClick={() => onSelect(occ)}
              title={occ.summary || t('calendar.shared.untitled', '未命名事件')}
            >
              <span className="dr-bar" />
              <div className="min-w-0 flex-1">
                <div className="dr-time">{t('calendar.shared.allDay', '全天')}</div>
                <div className={cn('dr-title truncate', !occ.summary && 'empty-field')}>
                  {occ.summary || t('calendar.shared.untitled', '未命名事件')}
                </div>
              </div>
            </button>
          ))}
          {sortedTimed.map((occ) => (
            <button
              key={`t-${occ.id}-${occ.occurrence_start_iso}`}
              type="button"
              className={cn(
                'dr-row',
                selectedKey === `${occ.id}-${occ.occurrence_start_iso}` && 'is-selected'
              )}
              data-resp={(occ.response_status || '').toUpperCase()}
              onClick={() => onSelect(occ)}
              title={occ.summary || t('calendar.shared.untitled', '未命名事件')}
            >
              <span className="dr-bar" />
              <div className="min-w-0 flex-1">
                <div className="dr-time">
                  {shortTime(occ.occurrence_start_iso)} – {shortTime(occ.occurrence_end_iso)}
                </div>
                <div className={cn('dr-title truncate', !occ.summary && 'empty-field')}>
                  {occ.summary || t('calendar.shared.untitled', '未命名事件')}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="day-main">
        {/* 首次加载 (无 keepPreviousData 旧数据) 才显骨架; 切日时旧日 timeline
            经 keepPreviousData 留屏直到新日 ready, isLoading=false 不显骨架.
            F23 — 结构化 timeline 骨架替代通用灰条. */}
        {isLoading ? (
          <TimelineSkeleton cols={1} />
        ) : isError && total === 0 ? (
          // F21 — query reject 不再伪装成空态; 仅在无可显示数据时换错误屏.
          <CalendarQueryError onRetry={refetch} />
        ) : total === 0 ? (
          // S7 — 空态三语义 (无事件/从未同步/同步失败) 由 CalendarViewEmpty 判定.
          <CalendarViewEmpty emptyTitle={t('calendar.empty.day', '本日无日程')} />
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
                  <span>{t('calendar.shared.allDay', '全天')}</span>
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
                    const sel = selectedKey === `${occ.id}-${occ.occurrence_start_iso}`
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
