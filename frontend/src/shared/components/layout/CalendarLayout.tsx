// 视觉复刻 mockup-calendar.html (2026-05-23) —
// 结构: toolbar (外置) + cal-card (glass-2, 撑满剩余, 内含视图 + 内部 status bar).
// PageFrame 已经提供 TitleBar + Sidebar + StatusBar 三段; main override
// 成 flex-col overflow-hidden 让 cal-card own scroll, 避免双滚动条.
//
// 加键盘快捷键 hook + ? help modal + cal-card 内部底部副 status bar.

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'

import { CalendarPage } from '../calendar/CalendarPage'
import { CalendarShortcutModal } from '../calendar/CalendarShortcutModal'
import { CalendarToolbar, type CalendarView } from '../calendar/CalendarToolbar'
import { useCalendarShortcuts } from '../calendar/hooks/useCalendarShortcuts'
import {
  useCalendarSyncStatus,
  useCalendarSyncTrigger
} from '../calendar/hooks/useCalendarEvents'
import { AgendaView } from '../calendar/views/AgendaView'
import { DayView } from '../calendar/views/DayView'
import { MonthView } from '../calendar/views/MonthView'
import { WeekView } from '../calendar/views/WeekView'

import { PageFrame } from './PageFrame'

function step(view: CalendarView, dir: 1 | -1, base: Date): Date {
  const d = new Date(base)
  if (view === 'today') d.setDate(d.getDate() + dir)
  else if (view === 'week') d.setDate(d.getDate() + dir * 7)
  else if (view === 'month') d.setMonth(d.getMonth() + dir)
  return d
}

export function CalendarLayout(): React.ReactElement {
  const search = useSearch({ from: '/admin/calendar' }) as { view?: CalendarView }
  const navigate = useNavigate({ from: '/admin/calendar' })
  const view: CalendarView = search.view ?? 'week'

  const [currentDate, setCurrentDate] = useState<Date>(() => new Date())
  const [shortcutOpen, setShortcutOpen] = useState(false)

  const setView = (v: CalendarView): void => {
    void navigate({ search: { view: v } })
  }

  const { trigger: triggerSync } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()

  // 副 status bar 数据 — 主要 calendar 状态从 sync_state 拿
  const calendarCount = syncStatus?.length ?? 0
  const ctag = syncStatus?.[0]?.ctag ?? null

  useCalendarShortcuts({
    onView: setView,
    onToday: () => setCurrentDate(new Date()),
    onPrev: () => setCurrentDate((d) => step(view, -1, d)),
    onNext: () => setCurrentDate((d) => step(view, 1, d)),
    onSync: () => triggerSync({ full: true }),
    onHelp: () => setShortcutOpen((v) => !v),
    onEsc: () => setShortcutOpen(false)
  })

  return (
    <PageFrame
      ariaLabel="calendar"
      mainClassName="flex-1 min-w-0 flex flex-col overflow-hidden"
    >
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        currentDate={currentDate}
        onDateChange={setCurrentDate}
      />
      <div className="flex-1 min-h-0 px-5 pb-4">
        <div className="h-full glass-2 border border-ink-border/60 rounded-[10px] overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            {view === 'today' && (
              <DayView date={currentDate} onDateChange={setCurrentDate} />
            )}
            {view === 'week' && <WeekView date={currentDate} />}
            {view === 'month' && <MonthView date={currentDate} />}
            {view === 'agenda' && <AgendaView />}
            {view === 'recurring' && <CalendarPage />}
          </div>

          {/* cal-card 内部底部副 status bar — calendar-specific, 不跟全局
              StatusBar 抢位置 */}
          <div className="cal-statusbar">
            <span>{calendarCount} 日历</span>
            <span className="sep">·</span>
            <span>窗口 −30d / +180d</span>
            {ctag && (
              <>
                <span className="sep">·</span>
                <span>ctag {ctag.slice(0, 8)}</span>
              </>
            )}
            <span className="right">DavMail bridge · calendar_event v15</span>
          </div>
        </div>
      </div>

      <CalendarShortcutModal
        open={shortcutOpen}
        onClose={() => setShortcutOpen(false)}
      />
    </PageFrame>
  )
}
