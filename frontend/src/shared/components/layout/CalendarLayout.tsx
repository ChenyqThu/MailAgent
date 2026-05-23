// 视觉复刻 mockup-calendar.html (2026-05-23) —
// 结构: toolbar (外置) + cal-card (glass-2, 撑满剩余, 内含视图 + 内部 status bar).
// PageFrame 已经提供 TitleBar + Sidebar + StatusBar 三段; main override
// 成 flex-col overflow-hidden 让 cal-card own scroll, 避免双滚动条.
//
// 加键盘快捷键 hook + ? help modal + cal-card 内部底部副 status bar.

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import { CalendarPage } from '../calendar/CalendarPage'
import { CalendarShortcutModal } from '../calendar/CalendarShortcutModal'
import { CalendarToolbar, type CalendarView } from '../calendar/CalendarToolbar'
import { useCalendarShortcuts } from '../calendar/hooks/useCalendarShortcuts'
import {
  relativeTime,
  useCalendarSyncStatus,
  useCalendarSyncTrigger,
  useNowTick
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

  const setView = useCallback(
    (v: CalendarView): void => {
      void navigate({ search: { view: v } })
    },
    [navigate]
  )

  const { trigger: triggerSync } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  // 30s tick — 让副 status bar 的 "自动同步 N 秒前" 自然走时, 不等下次
  // useCalendarSyncStatus refetch (60s) 才有变化
  useNowTick()

  // 副 status bar 数据 — 主要 calendar 状态从 sync_state 拿
  const head = syncStatus?.[0]
  const calendarCount = syncStatus?.length ?? 0
  const ctag = head?.ctag ?? null
  const lastIso =
    head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso ?? null
  const lastDate = lastIso ? new Date(lastIso) : null
  const lastSyncLabel = lastDate ? relativeTime(lastDate) : '尚未同步'

  // useCallback 包 callback — 让 useCalendarShortcuts 的 keydown listener 不会
  // 每次 CalendarLayout re-render 都 unbind+re-bind (闭包问题 §4.5)
  const handleToday = useCallback(() => setCurrentDate(new Date()), [])
  const handlePrev = useCallback(
    () => setCurrentDate((d) => step(view, -1, d)),
    [view]
  )
  const handleNext = useCallback(
    () => setCurrentDate((d) => step(view, 1, d)),
    [view]
  )
  const handleSync = useCallback(() => triggerSync({ full: true }), [triggerSync])
  const handleHelp = useCallback(() => setShortcutOpen((v) => !v), [])
  const handleEsc = useCallback(() => setShortcutOpen(false), [])

  useCalendarShortcuts({
    onView: setView,
    onToday: handleToday,
    onPrev: handlePrev,
    onNext: handleNext,
    onSync: handleSync,
    onHelp: handleHelp,
    onEsc: handleEsc
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
            <span title="后端 CalendarSyncWorker 60s ctag 轮询 (ctag 不可用时 1h time-fallback)">
              自动同步 {lastSyncLabel}
            </span>
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
