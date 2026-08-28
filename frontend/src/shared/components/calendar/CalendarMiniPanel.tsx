// 「日历」域的二级栏 —— 小月历（task 08-27-l4-tab-workspace P1）。
//
// 形态抄原型 Main.dc.html 的日历二级栏段（.minical）：月标题 + 前后月切换 +
// 「今天」回跳 + 7×6 月网格（有事件的格底部圆点）。样式复用 DayView rail 的
// `.mm-*` authored CSS（index.css，未作用域限定）。
//
// 与主视图的联动是**单向**的：点日期 / 「今天」经既有 useCalendarFocus store 写
// pending target（uid 空串 = 只跳日期不选中事件），CalendarLayout 的 consume 效应
// setCurrentDate。反向（主视图翻月 → 小月历跟随）没有干净的联动点 ——
// CalendarLayout 的 currentDate 是组件内 useState；P3 日历月视图重做把它提升为
// store 后再接双向。三组日历源开关同属 P3（要后端三源聚合）。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useCalendarFocus } from '@shared/state/calendar-focus'

import {
  addDays,
  startOfMonth,
  startOfWeek,
  todayStartLocal,
  useCalendarEventsInWindow
} from './hooks/useCalendarEvents'
import { ymd } from './lib/format'
import { weekdayMin } from './lib/weekdays'

export function CalendarMiniPanel(): React.ReactElement {
  const { t } = useTranslation()
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))

  const gridStart = startOfWeek(month)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const gridEnd = addDays(gridStart, 42)

  // 事件圆点 —— 与主视图共享同一窗口缓存族（CALENDAR_EVENTS_KEY）。展开 RRULE，
  // 否则周期会议只在首次那天有点。
  const { data: occurrences } = useCalendarEventsInWindow({
    fromIso: gridStart.toISOString(),
    toIso: gridEnd.toISOString(),
    expandRecurrences: true
  })
  const eventDays = new Set(
    (occurrences ?? []).map((occ) => ymd(new Date(occ.occurrence_start_iso)))
  )

  const todayKey = ymd(todayStartLocal())
  const currentMonth = month.getMonth()

  /** 点日期 → 主视图跳到那一天。uid 空串在 CalendarLayout 的 matchFocusTarget 永不
   *  命中 —— 效果就是只 setCurrentDate、不选中任何事件。 */
  const pickDate = (d: Date): void => {
    useCalendarFocus.getState().request({
      dateIso: d.toISOString(),
      icalUid: '',
      recurrenceId: null
    })
  }

  const goToday = (): void => {
    const today = todayStartLocal()
    setMonth(startOfMonth(today))
    pickDate(today)
  }

  const prevLabel = t('calendar.view.day.prevMonthAria', '上月')
  const nextLabel = t('calendar.view.day.nextMonthAria', '下月')

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pt-2.5 pb-2" data-calendar-mini>
      <div className="mm-head">
        <span className="mm-title">
          {t('calendar.shared.yearMonth', '{y} 年 {m} 月', {
            y: month.getFullYear(),
            m: month.getMonth() + 1
          })}
        </span>
        <div className="mm-nav">
          <button
            type="button"
            onClick={goToday}
            title={t('calendar.toolbar.today', '今天')}
            aria-label={t('calendar.toolbar.today', '今天')}
            className="!w-auto px-1.5 text-[11px] font-medium"
          >
            {t('calendar.toolbar.today', '今天')}
          </button>
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            title={prevLabel}
            aria-label={prevLabel}
          >
            <ChevronLeft size={12} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            title={nextLabel}
            aria-label={nextLabel}
          >
            <ChevronRight size={12} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      <div className="mm-grid">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="mm-dow">
            {weekdayMin(t, i)}
          </div>
        ))}
        {cells.map((c, i) => {
          const key = ymd(c)
          const isOther = c.getMonth() !== currentMonth
          const isToday = key === todayKey
          return (
            <button
              key={i}
              type="button"
              className={cn(
                'mm-cell',
                isOther && 'is-other',
                !isOther && 'in-week',
                isToday && 'today'
              )}
              onClick={isOther ? undefined : () => pickDate(c)}
              disabled={isOther}
              aria-label={key}
            >
              {c.getDate()}
              {eventDays.has(key) && <span className="mm-dot" aria-hidden />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
