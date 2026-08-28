// task 08-27 P3 —— 月视图重做 (design §七 / r2 calmon)。
//
// 形态: 每周一行 (不是一整块 42 格 grid —— 跨天色带要在行内绝对定位横跨若干列)。
// 数据: 三源聚合 GET /api/calendar/agenda (邮箱 / 事项 / Agent), 布局纯函数在
// lib/monthGrid.ts。日期数字在格子右下角, 今天 accent 实心圆; 单日事件是淡 wash
// 胶囊, 跨天是横跨列的整条色带; 每格容量 4 − 该周色带条数, 超出「还有 N 项」
// (溢出弹层沿用旧 .more-pop 交互)。
//
// 点击路由随源分流: mail → EventDetailDrawer (occurrence 从同窗口 events 缓存
// 解析, 未命中兜底合成); matter → 事项详情 (useMatterNavigation + registry);
// agent → 团队域 (registry 导航函数, 不写路径字面量)。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CalendarQueryError } from '../CalendarQueryError'
import { agendaSrc } from '../lib/agendaLayout'
import { isTodayLocal, shortTime, ymd } from '../lib/format'
import { DOW_EN } from '../lib/weekdays'
import {
  isAgendaEntrySelected,
  layoutMonthWeeks,
  MONTH_WEEK_COUNT,
  type MonthWeekLayout
} from '../lib/monthGrid'
import {
  useCalendarEventsInWindow,
  startOfMonth,
  startOfWeek,
  addDays
} from '../hooks/useCalendarEvents'
import { useAgendaEntryClick } from '../hooks/useAgendaEntryClick'
import { useCalendarAgenda } from '../hooks/useCalendarAgenda'
import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useCalendarView } from '@shared/state/calendar-view'

interface Props {
  date?: Date
  calendarName?: string
  /** F5 — view 上提选中事件给 CalendarLayout (仅 mail 源)。 */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F4/Q13 — selected event key (= ``${id}-${occurrence_start_iso}``)。 */
  selectedKey?: string | null
}

interface PopState {
  top?: number
  bottom?: number
  left: number
  maxHeight: number
  flip: boolean
  items: AgendaEntry[]
  dayLabel: string
}

/** more-pop 高度估算 (flip 判定用): padding 20 + head ~24 + 每行 24. */
function estimatePopHeight(itemCount: number): number {
  return 44 + itemCount * 24
}

/** 单日条目胶囊 (r2: 高 19 圆角 5, 左圆点取源色 + 标题 + 灰时间同行)。 */
function AgendaChip({
  entry,
  selected,
  allDayLabel,
  onClick
}: {
  entry: AgendaEntry
  selected: boolean
  allDayLabel: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      className={cn('m-evt', selected && 'is-selected')}
      data-src={agendaSrc(entry)}
      onClick={onClick}
      title={entry.title}
    >
      <span className="m-evt-dot" aria-hidden />
      <span className="m-evt-title">{entry.title}</span>
      <span className="m-evt-time">{entry.allDay ? allDayLabel : shortTime(entry.startIso)}</span>
    </button>
  )
}

export function MonthView({
  date,
  calendarName: _calendarName,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const sources = useCalendarView((s) => s.sources)
  const excluded = useCalendarView((s) => s.excluded)
  const [pop, setPop] = useState<PopState | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  // Q11 — 退场动画期间 pop 已置 null, lastPop 保留最后内容渲染到播完。
  const [lastPop, setLastPop] = useState<PopState | null>(null)
  const renderPop = pop ?? lastPop

  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(pop !== null, {
    backdrop: false,
    from: {
      autoAlpha: 0,
      y: renderPop?.flip ? 6 : -6,
      scale: 0.97,
      transformOrigin: renderPop?.flip ? 'bottom left' : 'top left'
    },
    enterDuration: DUR.fast
  })
  const { dialogRef, handleTab } = useFocusTrap({ open: pop !== null })

  const monthStart = useMemo(() => startOfMonth(date ?? new Date()), [date])
  const gridStart = useMemo(() => startOfWeek(monthStart), [monthStart])
  const gridEnd = useMemo(() => addDays(gridStart, MONTH_WEEK_COUNT * 7), [gridStart])
  const currentMonth = monthStart.getMonth()

  const { data, isLoading, isError, refetch } = useCalendarAgenda(
    { fromIso: gridStart.toISOString(), toIso: gridEnd.toISOString() },
    sources,
    true,
    excluded
  )
  // mail 条目点击解析用的同窗口 occurrences — 与 Layout j/k 巡航同 queryKey,
  // react-query 缓存命中, 零额外 IPC。
  const { data: windowEvents } = useCalendarEventsInWindow({
    fromIso: gridStart.toISOString(),
    toIso: gridEnd.toISOString()
  })

  const handleEntryClick = useAgendaEntryClick(onSelect, windowEvents)

  // F11 — popover click-outside / Esc to close (capture phase mousedown)。
  useEffect(() => {
    if (!pop) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null)
    }
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as (Node & { closest?: (s: string) => Element | null }) | null
      if (!target) return
      if (popRef.current && popRef.current.contains(target)) return
      if (typeof target.closest === 'function') {
        const inDrawer = target.closest('[data-ui-drawer]')
        if (inDrawer) return
      }
      setPop(null)
    }
    window.addEventListener('keydown', esc)
    document.addEventListener('mousedown', handleMouseDown, true)
    return () => {
      window.removeEventListener('keydown', esc)
      document.removeEventListener('mousedown', handleMouseDown, true)
    }
  }, [pop])

  const allDayLabel = t('calendar.shared.allDay', '全天')

  // 首次加载 (无 keepPreviousData 旧数据) 才显网格骨架; 切月时旧月格留屏不闪。
  if (isLoading) {
    return (
      <div className="cal-month" aria-busy="true">
        <div className="m-dow">
          {DOW_EN.map((label) => (
            <div key={label}>{label}</div>
          ))}
        </div>
        <div className="m-weeks">
          {Array.from({ length: MONTH_WEEK_COUNT }, (_, w) => (
            <div key={`skel-week-${w}`} className="m-week">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={`skel-cell-${w}-${i}`} className="m-cell">
                  <span className="m-daynum h-3.5 w-5 rounded bg-ink-3 animate-pulse motion-reduce:animate-none" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const entries = data ?? []
  // F21 — query reject 不伪装成空态; serve-api 不可达 (dev 未起) 时明说。
  if (isError && entries.length === 0) {
    return (
      <div className="cal-month">
        <CalendarQueryError onRetry={refetch} />
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className="cal-month">
        <EmptyState
          icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
          title={t('calendar.empty.month', '本月无日程')}
          hint={t('calendar.empty.syncHint')}
        />
      </div>
    )
  }

  const weeks: MonthWeekLayout[] = layoutMonthWeeks(entries, gridStart)

  return (
    <div className="cal-month">
      <div className="m-dow">
        {DOW_EN.map((label) => (
          <div key={label}>{label}</div>
        ))}
      </div>
      <div className="m-weeks">
        {weeks.map((week) => (
          <div key={ymd(week.start)} className="m-week">
            {/* 跨天色带 — 行内绝对定位横跨若干列, top 按 lane 序号叠 */}
            {week.bands.map((band) => (
              <button
                key={`band-${band.entry.id}-${band.startCol}`}
                type="button"
                className="m-band"
                data-src={agendaSrc(band.entry)}
                style={{
                  left: `calc(${(band.startCol * 100) / 7}% + 4px)`,
                  width: `calc(${(band.span * 100) / 7}% - 8px)`,
                  top: 4 + band.lane * 20
                }}
                onClick={() => handleEntryClick(band.entry)}
                title={band.entry.title}
              >
                {band.entry.title}
              </button>
            ))}
            {week.days.map((cell) => {
              const isOther = cell.date.getMonth() !== currentMonth
              const today = isTodayLocal(cell.date)
              const monthN = cell.date.getMonth() + 1
              return (
                <div
                  key={cell.key}
                  className={cn('m-cell', isOther && 'is-other', today && 'is-today')}
                  style={{ paddingTop: 4 + week.laneCount * 20 }}
                >
                  {cell.visible.map((entry) => (
                    <AgendaChip
                      key={entry.id}
                      entry={entry}
                      selected={isAgendaEntrySelected(entry, selectedKey)}
                      allDayLabel={allDayLabel}
                      onClick={() => handleEntryClick(entry)}
                    />
                  ))}
                  {cell.moreCount > 0 && (
                    <button
                      type="button"
                      className="more-btn"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                        const spaceBelow = window.innerHeight - rect.bottom - 6
                        const spaceAbove = rect.top - 6
                        const flip =
                          estimatePopHeight(cell.items.length) > spaceBelow &&
                          spaceAbove > spaceBelow
                        const next: PopState = {
                          left: Math.min(rect.left, window.innerWidth - 240),
                          maxHeight: Math.max(
                            120,
                            Math.floor((flip ? spaceAbove : spaceBelow) - 8)
                          ),
                          flip,
                          items: cell.items,
                          dayLabel: t('calendar.view.month.popDayLabel', '{m} 月 {d} 日', {
                            m: monthN,
                            d: cell.date.getDate()
                          }),
                          ...(flip
                            ? { bottom: window.innerHeight - rect.top + 6 }
                            : { top: rect.bottom + 6 })
                        }
                        setLastPop(next)
                        setPop(next)
                      }}
                    >
                      {t('calendar.view.month.moreItems', '还有 {n} 项', { n: cell.moreCount })}
                    </button>
                  )}
                  <span className="m-daynum">{cell.date.getDate()}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {shouldRender && renderPop && (
        <div
          ref={(el) => {
            popRef.current = el
            scopeRef.current = el
            dialogRef.current = el
          }}
          role="dialog"
          aria-label={renderPop.dayLabel}
          className="more-pop glass-pop scrollbar-thin"
          style={{
            top: renderPop.top,
            bottom: renderPop.bottom,
            left: renderPop.left,
            maxHeight: renderPop.maxHeight
          }}
          onKeyDown={(e) => {
            handleTab(e)
          }}
        >
          <div className="mp-head">
            <span>{renderPop.dayLabel}</span>
            <span className="mp-date">
              {t('calendar.view.month.popEventCount', '{n} 个事件', { n: renderPop.items.length })}
            </span>
          </div>
          <div className="space-y-1">
            {renderPop.items.map((entry) => (
              <AgendaChip
                key={`pop-${entry.id}`}
                entry={entry}
                selected={isAgendaEntrySelected(entry, selectedKey)}
                allDayLabel={allDayLabel}
                onClick={() => {
                  handleEntryClick(entry)
                  setPop(null)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
