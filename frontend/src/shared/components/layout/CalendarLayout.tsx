// Sprint 6 — /admin/calendar route shell.
// Phase 3 §3.3 (frontend-view-silly-knuth.md) — V2 toolbar + 多视图调度.
// 路由 search 参数 ?view= 控制活跃视图:
//   - today    → DayView (单日 24h timeline)
//   - week     → WeekView (7 列 × 24h, default)
//   - month    → MonthView (6×7 grid)
//   - agenda   → AgendaView (列表 grouped by day)
//   - recurring → 老 RecurringInvitesPage (Sprint 6 表格运维工具)
//
// 默认 view=week. ?view=recurring 是 V1 老视图入口 (灰度共存, 不下线).

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
  // search params 从 router 拿 (validateSearch 已确保 view 是 CalendarView)
  const search = useSearch({ from: '/admin/calendar' }) as { view?: CalendarView }
  const navigate = useNavigate({ from: '/admin/calendar' })
  const view: CalendarView = search.view ?? 'week'

  // 当前日期 — day/week/month 视图导航锚点. 默认本地今天. 不进 URL, 避免 ?date=
  // 在视图切换时杂乱; 用户切回 today 总是回当天.
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date())

  const setView = (v: CalendarView): void => {
    void navigate({ search: { view: v } })
  }

  return (
    <PageFrame ariaLabel="calendar">
      <div className="px-6 py-5 min-h-full">
        <CalendarToolbar
          view={view}
          onViewChange={setView}
          currentDate={currentDate}
          onDateChange={setCurrentDate}
        />
        <section className="rounded-md border border-ink-border bg-ink-2 overflow-hidden p-4">
          {view === 'today' && <DayView date={currentDate} />}
          {view === 'week' && <WeekView date={currentDate} />}
          {view === 'month' && <MonthView date={currentDate} />}
          {view === 'agenda' && <AgendaView />}
          {view === 'recurring' && <CalendarPage />}
        </section>
      </div>
    </PageFrame>
  )
}
