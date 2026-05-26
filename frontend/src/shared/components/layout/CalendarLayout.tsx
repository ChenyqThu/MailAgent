// 视觉复刻 mockup-calendar.html (2026-05-23) +
// Phase 2.5 §11.5 (mockup-calendar-ops.html) — 副 status bar 重做.
//
// 结构: toolbar (外置) + cal-card (glass-2, 撑满剩余, 内含视图 + 内部
// .statusbar 用户向 metric + hover ℹ️ popover 运维详情).
// 加 <UndoToastStack /> 全局 mount 给 §11.2 删除撤销 toast 用.
//
// PageFrame 已经提供 TitleBar + Sidebar + StatusBar 三段; main override
// 成 flex-col overflow-hidden 让 cal-card own scroll, 避免双滚动条.

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CalendarErrorBoundary } from '../calendar/CalendarErrorBoundary'
import { CalendarPage } from '../calendar/CalendarPage'
import { CalendarShortcutModal } from '../calendar/CalendarShortcutModal'
import { CalendarToolbar, type CalendarView } from '../calendar/CalendarToolbar'
import { EventDetailDrawer } from '../calendar/EventDetailDrawer'
import { UndoToastStack } from '../calendar/UndoToastStack'
import { useCalendarShortcuts } from '../calendar/hooks/useCalendarShortcuts'
import {
  relativeTime,
  useCalendarEventsInWindow,
  useCalendarNames,
  useCalendarSyncStatus,
  useCalendarSyncTrigger,
  useNowTick
} from '../calendar/hooks/useCalendarEvents'
import { AgendaView } from '../calendar/views/AgendaView'
import { DayView } from '../calendar/views/DayView'
import { MonthView } from '../calendar/views/MonthView'
import { WeekView } from '../calendar/views/WeekView'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'

import { PageFrame } from './PageFrame'

function step(view: CalendarView, dir: 1 | -1, base: Date): Date {
  const d = new Date(base)
  if (view === 'today') d.setDate(d.getDate() + dir)
  else if (view === 'week') d.setDate(d.getDate() + dir * 7)
  else if (view === 'month') d.setMonth(d.getMonth() + dir)
  return d
}

/** YYYY-MM-DD (本地) → 该日 00:00 (UTC) ISO. 用于副 status bar 宽窗口 events 计数. */
function isoOffsetDays(daysFromToday: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + daysFromToday)
  return d.toISOString()
}

function isoDateOnly(daysFromToday: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function CalendarLayout(): React.ReactElement {
  const { t } = useTranslation()
  const search = useSearch({ from: '/admin/calendar' }) as { view?: CalendarView }
  const navigate = useNavigate({ from: '/admin/calendar' })
  const view: CalendarView = search.view ?? 'week'

  const [currentDate, setCurrentDate] = useState<Date>(() => new Date())
  const [shortcutOpen, setShortcutOpen] = useState(false)
  // Phase 4·#1 — calendar 多选筛选 (空 = 全部). client-side filter 不重 fetch,
  // 传给 Toolbar (dropdown) + 各 view (useCalendarEventsInWindow select).
  const [selectedCalendars, setSelectedCalendars] = useState<string[]>([])
  const { data: calendarNames } = useCalendarNames()
  const calendars = calendarNames ?? []
  // F5 — 单一 active selected event, 4 view 通过 onSelect callback 上提.
  // Drawer 跟着挂在 Layout 层 (单 mount), 切 view 不丢, deleteMut hook 不
  // unmount → 修 Critical #4 deleteMut stale closure + 撤销可 reopen drawer.
  const [active, setActive] = useState<CalendarEventOccurrence | null>(null)
  const selectedKey = active ? `${active.id}-${active.occurrence_start_iso}` : null

  const setView = useCallback(
    (v: CalendarView): void => {
      // F26 — 切 view 时 reset active. 月选中事件切到周时 drawer 可能显示
      // 跨当前窗口外事件 (UX 怪), 切 view 时强制关闭让用户重新选.
      setActive(null)
      void navigate({ search: { view: v } })
    },
    [navigate]
  )

  const { trigger: triggerSync } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  useNowTick()

  // §11.5 — 副 status bar 数据.
  // events count: 宽窗口 [-30d, +180d] master events (不展开 RRULE) — 跟后端
  // worker sync 窗口对齐, 一次 SQLite 查询 ~5ms, 60s staleTime.
  const windowFromIso = useMemo(() => isoOffsetDays(-30), [])
  const windowToIso = useMemo(() => isoOffsetDays(180), [])
  const { data: windowEvents } = useCalendarEventsInWindow({
    fromIso: windowFromIso,
    toIso: windowToIso,
    expandRecurrences: false
  }, selectedCalendars)
  const eventsCount = windowEvents?.length ?? null

  // recurring count: 90d 内 RRULE-bearing series (5min cache, mount auto fetch)
  const mailApi = useMailApi()
  const recurringSince = useMemo(() => isoDateOnly(-90), [])
  const { data: recurringList } = useQuery({
    queryKey: ['calendar', 'recurring', 'status-90d', recurringSince],
    queryFn: () => mailApi.calendar.recurringDiscover({ since: recurringSince }),
    staleTime: 5 * 60_000
  })
  const recurringCount = recurringList?.length ?? null

  const head = syncStatus?.[0]
  const ctag = head?.ctag ?? null
  const lastIso =
    head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso ?? null
  const lastDate = lastIso ? new Date(lastIso) : null
  const lastSyncLabel = lastDate ? relativeTime(lastDate) : t('calendar.statusbar.noSync', '尚未同步')
  const lastError = head?.last_error ?? null
  const hasErr = !!lastError
  const calendarsLabel = head?.calendar_name ?? '日历'

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
        calendars={calendars}
        selectedCalendars={selectedCalendars}
        onSelectedCalendarsChange={setSelectedCalendars}
      />
      <div className="flex-1 min-h-0 px-5 pb-4">
        <div className="h-full glass-2 border border-ink-border/60 rounded-[10px] overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            {/* F7 — 每个 view 套 CalendarErrorBoundary, 任一 view crash
                (rrule 解析 / Date.parse NaN / IPC reject) 不冒到 PageFrame
                黑屏整页. 切 view 时 view + Boundary 都 unmount 自动 reset. */}
            {view === 'today' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewDay', '日')}>
                <DayView
                  date={currentDate}
                  onDateChange={setCurrentDate}
                  selectedCalendars={selectedCalendars}
                  onSelect={setActive}
                  selectedKey={selectedKey}
                />
              </CalendarErrorBoundary>
            )}
            {view === 'week' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewWeek', '周')}>
                <WeekView
                  date={currentDate}
                  selectedCalendars={selectedCalendars}
                  onSelect={setActive}
                  selectedKey={selectedKey}
                />
              </CalendarErrorBoundary>
            )}
            {view === 'month' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewMonth', '月')}>
                <MonthView date={currentDate} selectedCalendars={selectedCalendars} onSelect={setActive} />
              </CalendarErrorBoundary>
            )}
            {view === 'agenda' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewAgenda', 'Agenda')}>
                <AgendaView selectedCalendars={selectedCalendars} onSelect={setActive} />
              </CalendarErrorBoundary>
            )}
            {view === 'recurring' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewRecurring', '定期邀请')}>
                <CalendarPage />
              </CalendarErrorBoundary>
            )}
          </div>

          {/* §11.5 — 副 status bar: 用户向 metric + ml-auto ℹ️ hover popover */}
          <div className="statusbar" data-sync={hasErr ? 'err' : 'ok'}>
            <div className="sb-metric">
              <span className="sb-sync-dot" aria-hidden />
              <span>
                <span className="sb-num">{eventsCount ?? '—'}</span> events
              </span>
              <span className="sb-sep">·</span>
              <span>
                <span className="sb-num">{recurringCount ?? '—'}</span> recurring
              </span>
              <span className="sb-sep">·</span>
              <span>
                {t('calendar.statusbar.autoSync', '自动同步')} <span className="sb-num">{lastSyncLabel}</span>
              </span>
            </div>
            <button
              type="button"
              className="sb-info ml-auto"
              tabIndex={0}
              aria-label={t('calendar.statusbar.popoverAria', '同步与后台详情')}
            >
              <Info size={14} strokeWidth={2} />
              <div className="sb-pop glass-pop">
                <div className="sb-pop-h">
                  <Info size={12} strokeWidth={2} />
                  {t('calendar.statusbar.popoverTitle', '同步与后台')}
                </div>
                <div className="sb-pop-row">
                  <span className="k">bridge</span>
                  <span className="v">DavMail · :1080</span>
                </div>
                <div className="sb-pop-row">
                  <span className="k">last_full_sync</span>
                  <span className="v">
                    {head?.last_full_sync_at_iso
                      ? head.last_full_sync_at_iso.replace('T', ' ').slice(0, 19)
                      : '—'}
                  </span>
                </div>
                <div className="sb-pop-row">
                  <span className="k">ctag</span>
                  <span className="v">{ctag ? ctag.slice(0, 8) : '—'}</span>
                </div>
                <div className="sb-pop-row">
                  <span className="k">window</span>
                  <span className="v">−30d / +180d</span>
                </div>
                <div className="sb-pop-row">
                  <span className="k">schema</span>
                  <span className="v">calendar_event v15</span>
                </div>
                <div className="sb-pop-row">
                  <span className="k">calendar</span>
                  <span className="v">{calendarsLabel}</span>
                </div>
                {hasErr && (
                  <div className="sb-pop-row" style={{ marginTop: 6 }}>
                    <span className="k">error</span>
                    <span className="v" style={{ color: 'rgb(var(--c-fail))' }}>
                      {(lastError ?? '').slice(0, 40)}
                    </span>
                  </div>
                )}
              </div>
            </button>
          </div>
        </div>
      </div>

      <CalendarShortcutModal
        open={shortcutOpen}
        onClose={() => setShortcutOpen(false)}
      />

      {/* F5 — Drawer 单挂在 Layout 层, view 切换不卸载, deleteMut/rsvpMut
          hook 持久; undo 撤销可通过 onReopen 复活选中事件 */}
      <EventDetailDrawer
        occurrence={active}
        onClose={() => setActive(null)}
        onReopen={(occ) => setActive(occ)}
      />

      {/* §11.2 — undo toast stack: fixed 定位脱离 layout flow, 出现在底部居中 */}
      <UndoToastStack />
    </PageFrame>
  )
}
