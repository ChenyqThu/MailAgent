// 视觉复刻 mockup-calendar.html (2026-05-23) —
// 结构: toolbar (外置) + cal-card (glass-2, 撑满剩余高度, 内部自己 scroll).
// PageFrame 已经提供 TitleBar + Sidebar + StatusBar 三段; main override
// 成 flex-col overflow-hidden, 让 cal-card 自己 own scroll, 避免 main 出双滚动条.
//
// 路由 search 参数 ?view= 控制活跃视图:
//   - today    → DayView (mini-month rail + 单日 timeline)
//   - week     → WeekView (7 列 × 24h, default)
//   - month    → MonthView (6×7 grid)
//   - agenda   → AgendaView (列表 grouped by day)
//   - recurring → 老 CalendarPage (Sprint 6 表格运维工具)

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'

import { CalendarPage } from '../calendar/CalendarPage'
import { CalendarToolbar, type CalendarView } from '../calendar/CalendarToolbar'
import { AgendaView } from '../calendar/views/AgendaView'
import { DayView } from '../calendar/views/DayView'
import { MonthView } from '../calendar/views/MonthView'
import { WeekView } from '../calendar/views/WeekView'

import { PageFrame } from './PageFrame'

export function CalendarLayout(): React.ReactElement {
  const search = useSearch({ from: '/admin/calendar' }) as { view?: CalendarView }
  const navigate = useNavigate({ from: '/admin/calendar' })
  const view: CalendarView = search.view ?? 'week'

  // 日期不进 URL — 视图切换时杂乱。切回 today 默认回当天。
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date())

  const setView = (v: CalendarView): void => {
    void navigate({ search: { view: v } })
  }

  return (
    <PageFrame ariaLabel="calendar" mainClassName="flex-1 min-w-0 flex flex-col overflow-hidden">
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        currentDate={currentDate}
        onDateChange={setCurrentDate}
      />
      <div className="flex-1 min-h-0 px-5 pb-4">
        <div className="h-full glass-2 border border-ink-border/60 rounded-[10px] overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            {view === 'today' && <DayView date={currentDate} onDateChange={setCurrentDate} />}
            {view === 'week' && <WeekView date={currentDate} />}
            {view === 'month' && <MonthView date={currentDate} />}
            {view === 'agenda' && <AgendaView />}
            {view === 'recurring' && <CalendarPage />}
          </div>
        </div>
      </div>
    </PageFrame>
  )
}
