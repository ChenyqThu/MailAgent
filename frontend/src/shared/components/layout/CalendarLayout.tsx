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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CalendarErrorBoundary } from '../calendar/CalendarErrorBoundary'
import { qk } from '@shared/lib/queryKeys'
import { CalendarPage } from '../calendar/CalendarPage'
import { CalendarShortcutModal } from '../calendar/CalendarShortcutModal'
import { CalendarToolbar, type CalendarView } from '../calendar/CalendarToolbar'
import { EventDetailDrawer } from '../calendar/EventDetailDrawer'
import { UndoToastStack } from '../calendar/UndoToastStack'
import { useCalendarShortcuts } from '../calendar/hooks/useCalendarShortcuts'
import { useEventReschedule } from '../calendar/hooks/useEventReschedule'
import {
  pickSyncHead,
  relativeTime,
  stepViewDate,
  useCalendarEventsInWindow,
  useCalendarNames,
  useCalendarSyncStatus,
  useCalendarSyncTrigger,
  useNowTick
} from '../calendar/hooks/useCalendarEvents'
import { calendarCapabilities } from '../calendar/lib/capabilities'

const caps = calendarCapabilities()
import {
  buildKeyNavSequence,
  keyNavWindow,
  matchFocusTarget,
  occurrenceKey,
  stepAnchor
} from '../calendar/lib/key-nav'
import { useCalendarFocus, type CalendarFocusTarget } from '@shared/state/calendar-focus'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { AgendaView } from '../calendar/views/AgendaView'
import { DayView } from '../calendar/views/DayView'
import { MonthView } from '../calendar/views/MonthView'
import { WeekView } from '../calendar/views/WeekView'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { CALENDAR_VIEWS } from '@shared/router-instance'

import { PageFrame } from './PageFrame'

// Lane D — 视图切换 cue: fade + x:±16 方向位移 (subtle, 非 parallax).
// 方向按 CALENDAR_VIEWS 索引差符号推导: 前进 (索引增大) dir=+1 (新视图从右
// x:+16 进), 后退 dir=-1 (从左). 切 view 时内部 view 分支整段 remount, 外层
// 包裹 div (持 ref) key 不变 → 对包裹做新内容入场 fromTo (旧 DOM 已被 React
// 同步替换, 无法退场动画; 入场淡入替换符合 §4.5 内容区瞬切语义).

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
  // 主标签第二段 = 当前月份（design §三）。格式走 toolbar 期间标题的同一条 i18n
  // （`calendar.shared.yearMonth`），不为面包屑另造一份日期文案。
  useMainBreadcrumb(
    'calendar',
    t('calendar.shared.yearMonth', '{y} 年 {m} 月', {
      y: currentDate.getFullYear(),
      m: currentDate.getMonth() + 1
    })
  )
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
  // 2.7 (F18/UX-P0④) — j/k 巡航锚点, 与 active (drawer) 解耦: j/k 只动锚点
  // 不开抽屉, Enter 才把锚点提升为 active. 点击事件两者同落 (j/k 从点击处续航).
  const [anchor, setAnchor] = useState<CalendarEventOccurrence | null>(null)
  const selectedKey = anchor ? occurrenceKey(anchor) : active ? occurrenceKey(active) : null

  const handleSelect = useCallback((occ: CalendarEventOccurrence): void => {
    setAnchor(occ)
    setActive(occ)
  }, [])

  // 2.7 — Toolbar [+ 新建] modal 状态上提到 Layout, n 快捷键共用同一入口.
  const [createOpen, setCreateOpen] = useState(false)

  const setView = useCallback(
    (v: CalendarView): void => {
      // F26 — 切 view 时 reset active. 月选中事件切到周时 drawer 可能显示
      // 跨当前窗口外事件 (UX 怪), 切 view 时强制关闭让用户重新选.
      setActive(null)
      setAnchor(null)
      void navigate({ search: { view: v } })
    },
    [navigate]
  )

  // Lane D — 视图切换入场动画. 包裹 view 区的稳定容器 (key 不变, 内部 view
  // remount), prevView 记上一视图算方向. reduced-motion 整段短路 (无 set/无 tween).
  const viewScopeRef = useRef<HTMLDivElement>(null)
  const prevViewRef = useRef<CalendarView>(view)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      const el = viewScopeRef.current
      if (!el) return
      const prev = prevViewRef.current
      prevViewRef.current = view
      if (reduceMotion || prev === view) return
      const dir = Math.sign(CALENDAR_VIEWS.indexOf(view) - CALENDAR_VIEWS.indexOf(prev)) || 1
      gsap.fromTo(
        el,
        { autoAlpha: 0, x: dir * 16 },
        { autoAlpha: 1, x: 0, duration: DUR.base, overwrite: 'auto' }
      )
    },
    { dependencies: [view, reduceMotion], scope: viewScopeRef }
  )

  const { trigger: triggerSync } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  useNowTick()

  // §11.5 — 副 status bar 数据.
  // events count: 宽窗口 [-30d, +180d] master events (不展开 RRULE) — 跟后端
  // worker sync 窗口对齐, 一次 SQLite 查询 ~5ms, 60s staleTime.
  const windowFromIso = useMemo(() => isoOffsetDays(-30), [])
  const windowToIso = useMemo(() => isoOffsetDays(180), [])
  const { data: windowEvents } = useCalendarEventsInWindow(
    {
      fromIso: windowFromIso,
      toIso: windowToIso,
      expandRecurrences: false
    },
    selectedCalendars
  )
  const eventsCount = windowEvents?.length ?? null

  // recurring count: 90d 内 RRULE-bearing series (5min cache, mount auto fetch)
  const mailApi = useMailApi()
  const recurringSince = useMemo(() => isoDateOnly(-90), [])
  const { data: recurringList } = useQuery({
    queryKey: qk.calendar.recurringStatus90d(recurringSince),
    queryFn: () => mailApi.calendar.recurringDiscover({ since: recurringSince }),
    staleTime: 5 * 60_000
  })
  const recurringCount = recurringList?.length ?? null

  // Lane C (#5) — 拖拽改期: mutation 挂在 Layout (5s 撤销窗口内切视图不丢);
  // userEmail 判组织者 (与 drawer 编辑门控同判据), 与 drawer 共用 settings 缓存.
  const reschedule = useEventReschedule()
  const { data: settings } = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 5 * 60_000
  })
  const userEmail = settings?.userEmail ?? null
  const onReschedule = caps.write ? reschedule : undefined

  // F19/Q6 — 健康优先选行统一走 pickSyncHead (与 Toolbar sync-pill /
  // CalendarViewEmpty 同源, 孤儿行场景不再上绿下红同屏矛盾).
  const head = pickSyncHead(syncStatus)
  const ctag = head?.ctag ?? null
  const lastIso = head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso ?? null
  const lastDate = lastIso ? new Date(lastIso) : null
  const lastSyncLabel = lastDate
    ? relativeTime(lastDate)
    : t('calendar.statusbar.noSync', '尚未同步')
  const lastError = head?.last_error ?? null
  const hasErr = !!lastError
  const calendarsLabel = head?.calendar_name ?? t('calendar.statusbar.calendarFallback', '日历')

  // 2.7 — j/k 巡航序列: Layout 用与当前视图相同的窗口参数跑同一
  // useCalendarEventsInWindow (同 queryKey → react-query 缓存命中, 零额外
  // IPC); recurring 无时间轴, enabled=false 不发查询也不参与巡航.
  const navWindow = useMemo(() => keyNavWindow(view, currentDate), [view, currentDate])
  const { data: navEvents, isFetching: navFetching } = useCalendarEventsInWindow(
    { fromIso: navWindow?.fromIso ?? '', toIso: navWindow?.toIso ?? '' },
    selectedCalendars,
    navWindow !== null
  )
  const navSeq = useMemo(
    () => (navWindow && navEvents ? buildKeyNavSequence(view, navEvents) : []),
    [view, navWindow, navEvents]
  )
  // 序列/锚点走 ref — j/k handler 保持稳定引用, keydown listener 不随数据
  // refetch / 每次巡航 re-bind.
  const navSeqRef = useRef<CalendarEventOccurrence[]>([])
  useEffect(() => {
    navSeqRef.current = navSeq
  }, [navSeq])
  const anchorRef = useRef<CalendarEventOccurrence | null>(null)
  useEffect(() => {
    anchorRef.current = anchor
  }, [anchor])

  // 2.7 — j/k 选中变化把目标滚进视口. 四视图选中元素统一 .is-selected 标记
  // (EventBlock/EventChip/agenda 行/day rail), Layout 层 querySelector 即可
  // 不碰视图文件; agenda 跨天多命中取首个 (最早一天).
  useEffect(() => {
    if (!anchor) return
    viewScopeRef.current
      ?.querySelector('.is-selected')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [anchor])

  // 2.2↔2.7 —「在日历中查看」跨面定位读侧: MeetingInviteCard 写 pending
  // target (calendar-focus store) 后 navigate 过来; 此处 consume (单次消费)
  // → 日期跳转, 匹配交给下方 effect. 视图不切 — 写侧 navigate 已显式带
  // view ('today': 小时级 timeline 定位最准), 读侧不二次决策.
  const pendingFocus = useCalendarFocus((s) => s.pending)
  const [focusTarget, setFocusTarget] = useState<CalendarFocusTarget | null>(null)
  useEffect(() => {
    if (!pendingFocus) return
    const target = useCalendarFocus.getState().consume()
    if (!target) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 跨面 one-shot 信号消费 (照 AiChatPanel 先例): consume() 带清空 store 副作用, 只能在 effect 做, 消费结果落两个本地 state.
    setFocusTarget(target)
    setCurrentDate(new Date(target.dateIso))
  }, [pendingFocus])

  // 匹配: 等当前视图窗口覆盖目标日期且数据就位 (isFetching 排除
  // keepPreviousData 旧窗口留屏) 再按 uid/recurrence_id 找; 找到只设选中
  // 锚点 + 滚动跟随, 不强开抽屉 (「查看」语义是定位上下文, 详情已在邮件
  // 卡片看过; Enter 一键可开). 成败都清 target — uid 不在窗口 = 事件过期/
  // 被删, 静默放弃.
  useEffect(() => {
    if (!focusTarget || !navWindow || navFetching || !navEvents) return
    const targetMs = Date.parse(focusTarget.dateIso)
    if (targetMs < Date.parse(navWindow.fromIso) || targetMs >= Date.parse(navWindow.toIso)) return
    const match = matchFocusTarget(navSeq, focusTarget, Date.now())
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: 异步 query 数据到达后的单次匹配落锚 + 清 target, 非派生状态.
    if (match) setAnchor(match)
    setFocusTarget(null)
  }, [focusTarget, navWindow, navFetching, navEvents, navSeq])

  // useCallback 包 callback — 让 useCalendarShortcuts 的 keydown listener 不会
  // 每次 CalendarLayout re-render 都 unbind+re-bind (闭包问题 §4.5)
  // 2.7 — 日期步进/跳今天清巡航锚点 (窗口变了, 旧锚点大概率不在序列);
  // active (drawer) 沿用现语义不动.
  const handleToday = useCallback(() => {
    setAnchor(null)
    setCurrentDate(new Date())
  }, [])
  const handlePrev = useCallback(() => {
    setAnchor(null)
    setCurrentDate((d) => stepViewDate(view, -1, d))
  }, [view])
  const handleNext = useCallback(() => {
    setAnchor(null)
    setCurrentDate((d) => stepViewDate(view, 1, d))
  }, [view])
  const handleDateChange = useCallback((d: Date) => {
    setAnchor(null)
    setCurrentDate(d)
  }, [])
  const handleSync = useCallback(() => triggerSync({ full: true }), [triggerSync])
  const handleHelp = useCallback(() => setShortcutOpen((v) => !v), [])
  const handleEsc = useCallback(() => setShortcutOpen(false), [])
  const handleNewEvent = useCallback(() => setCreateOpen(true), [])
  const handleNextEvent = useCallback(() => {
    const cur = anchorRef.current
    const next = stepAnchor(navSeqRef.current, cur ? occurrenceKey(cur) : null, 1, Date.now())
    if (next) setAnchor(next)
  }, [])
  const handlePrevEvent = useCallback(() => {
    const cur = anchorRef.current
    const next = stepAnchor(navSeqRef.current, cur ? occurrenceKey(cur) : null, -1, Date.now())
    if (next) setAnchor(next)
  }, [])
  const handleOpenSelected = useCallback(() => {
    const cur = anchorRef.current
    if (cur) setActive(cur)
  }, [])

  useCalendarShortcuts({
    onView: setView,
    onToday: handleToday,
    onPrev: handlePrev,
    onNext: handleNext,
    onSync: handleSync,
    onHelp: handleHelp,
    onEsc: handleEsc,
    // 阶段 3 (#11) — caps.write 门控, 与 Toolbar [+ 新建] 按钮同一判定.
    onNew: caps.write ? handleNewEvent : undefined,
    onNextEvent: handleNextEvent,
    onPrevEvent: handlePrevEvent,
    onOpenSelected: handleOpenSelected
  })

  return (
    <PageFrame ariaLabel="calendar" mainClassName="flex-1 min-w-0 flex flex-col overflow-hidden">
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        currentDate={currentDate}
        onDateChange={handleDateChange}
        calendars={calendars}
        selectedCalendars={selectedCalendars}
        onSelectedCalendarsChange={setSelectedCalendars}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
      />
      {/* CALENDAR-02 — 窄屏收窄横向 padding 多给 grid 空间 (week/month 7 列)。 */}
      <div className="flex-1 min-h-0 px-2 sm:px-5 pb-4">
        <div className="h-full glass-2 border border-ink-border/60 rounded-[10px] overflow-hidden flex flex-col">
          <div ref={viewScopeRef} className="flex-1 min-h-0 overflow-hidden">
            {/* F7 — 每个 view 套 CalendarErrorBoundary, 任一 view crash
                (rrule 解析 / Date.parse NaN / IPC reject) 不冒到 PageFrame
                黑屏整页. 切 view 时 view + Boundary 都 unmount 自动 reset. */}
            {view === 'today' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewDay', '日')}>
                <DayView
                  date={currentDate}
                  onDateChange={handleDateChange}
                  selectedCalendars={selectedCalendars}
                  onSelect={handleSelect}
                  selectedKey={selectedKey}
                  onReschedule={onReschedule}
                  userEmail={userEmail}
                />
              </CalendarErrorBoundary>
            )}
            {view === 'week' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewWeek', '周')}>
                <WeekView
                  date={currentDate}
                  selectedCalendars={selectedCalendars}
                  onSelect={handleSelect}
                  selectedKey={selectedKey}
                  onReschedule={onReschedule}
                  userEmail={userEmail}
                />
              </CalendarErrorBoundary>
            )}
            {view === 'month' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewMonth', '月')}>
                <MonthView
                  date={currentDate}
                  selectedCalendars={selectedCalendars}
                  onSelect={handleSelect}
                  selectedKey={selectedKey}
                />
              </CalendarErrorBoundary>
            )}
            {view === 'agenda' && (
              <CalendarErrorBoundary viewName={t('calendar.toolbar.viewAgenda', 'Agenda')}>
                <AgendaView
                  selectedCalendars={selectedCalendars}
                  onSelect={handleSelect}
                  selectedKey={selectedKey}
                />
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
                {t('calendar.statusbar.autoSync', '自动同步')}{' '}
                <span className="sb-num">{lastSyncLabel}</span>
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

      <CalendarShortcutModal open={shortcutOpen} onClose={() => setShortcutOpen(false)} />

      {/* F5 — Drawer 单挂在 Layout 层, view 切换不卸载, deleteMut/rsvpMut
          hook 持久; undo 撤销可通过 onReopen 复活选中事件 */}
      <EventDetailDrawer
        occurrence={active}
        onClose={() => setActive(null)}
        onReopen={(occ) => handleSelect(occ)}
      />

      {/* §11.2 — undo toast stack: fixed 定位脱离 layout flow, 出现在底部居中 */}
      <UndoToastStack />
    </PageFrame>
  )
}
