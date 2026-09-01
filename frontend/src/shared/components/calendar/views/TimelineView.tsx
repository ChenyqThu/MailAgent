// task 08-27 P5 —— 日/周时间轴的共用壳 (月视图确立的三源语言延展到 timeline)。
//
// 形态: wk-headrow (表头) + 置顶条区 (全天/跨天色带, 月视图 .m-band 同语言,
// lane 堆叠) + wk-body (56px 时刻槽 + N 日列 × 24h 网格)。日视图 = dayCount 1,
// 周视图 = dayCount 7, 除列数外零分叉。
//
// 数据: 三源聚合 useCalendarAgenda (窗口 = 本地日/周);
//   - mail 定时条目 → 同窗口 events 缓存解析成 occurrence (与 Layout j/k 巡航
//     同 queryKey, 零额外 IPC) 交给 EventBlock —— 拖拽改期 / Join / 状态形态化
//     (斜纹=暂定 / 空心=待回复 / 删除线=拒绝取消) 全部保留;
//   - matter/agent 时间点 (endIso=null) → .evt-mark 时刻标记 (不撑假时长,
//     月视图胶囊件语言), 点击分流走 useAgendaEntryClick;
//   - 全天/跨天 → 置顶色带, 点击同分流。
// 组级开关与成员级勾选 (calendar-view store: sources + excluded) 经 hook select
// 生效, 切勾选不重发请求。二级栏日历源树与工具条「按日历筛选」写的是同一份
// store, 所以这里只读 store, 不再收 selectedCalendars prop。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CalendarQueryError } from '../CalendarQueryError'
import { EventBlock, type EventRescheduleInput } from '../EventBlock'
import {
  agendaSrc,
  groupEntriesByLocalDay,
  layoutDayMoments,
  layoutTimelineBands,
  resolveMailOccurrence,
  splitTimelineEntries
} from '../lib/agendaLayout'
import { candidateFromEntry, detectConflicts } from '../lib/conflict'
import { isTodayLocal, pad, shortTime, ymd } from '../lib/format'
import { occurrenceKey } from '../lib/key-nav'
import { canRsvpFor } from '../lib/rsvp'
import { HOUR_PX } from '../lib/timeGrid'
import { DOW_EN_FULL } from '../lib/weekdays'
import { addDays, layoutDay, useCalendarEventsInWindow } from '../hooks/useCalendarEvents'
import { useAgendaEntryClick } from '../hooks/useAgendaEntryClick'
import { useCalendarAgenda } from '../hooks/useCalendarAgenda'
import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useCalendarTimeOverrides } from '@shared/state/calendar-time-override'
import { useCalendarView } from '@shared/state/calendar-view'

import { CalendarViewEmpty } from './CalendarViewEmpty'
import { TimelineSkeleton } from './TimelineSkeleton'

/** 色带条高 18 + 2 间距 (月视图 lane 步进同款)。 */
const BAND_STEP_PX = 20

interface Props {
  /** 区起点 (本地 00:00): 日视图 = 当日, 周视图 = 周一。 */
  gridStart: Date
  dayCount: 1 | 7
  emptyTitle: string
  /** F5 — Layout 持单一 active + Drawer, view 上提选中事件 (仅 mail 源)。 */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F5 — selected event key (= ``${id}-${occurrence_start_iso}``)。 */
  selectedKey?: string | null
  /** Lane C (#5) — 拖拽改期提交口 (Layout 持 mutation)。不传 = 只读。 */
  onReschedule?: (occ: CalendarEventOccurrence, next: EventRescheduleInput) => void
  /** 判组织者用 — 与 drawer 的编辑门控同一判据 (非组织者只能 RSVP, 不能改期)。 */
  userEmail?: string | null
}

export function TimelineView({
  gridStart,
  dayCount,
  emptyTitle,
  onSelect,
  selectedKey = null,
  onReschedule,
  userEmail = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [now, setNow] = useState(() => new Date())
  // Lane C (#5) — 拖完 10s 内以本地 override 定位/显示 (服务端还没回填)。
  const timeOverrides = useCalendarTimeOverrides((s) => s.overrides)
  const sources = useCalendarView((s) => s.sources)
  const excluded = useCalendarView((s) => s.excluded)

  const gridStartMs = gridStart.getTime()
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => addDays(new Date(gridStartMs), i)),
    [gridStartMs, dayCount]
  )
  // 字符串按值进 queryKey — 不必 memo 引用。
  const fromIso = new Date(gridStartMs).toISOString()
  const toIso = addDays(new Date(gridStartMs), dayCount).toISOString()

  const { data, isLoading, isError, refetch } = useCalendarAgenda(
    { fromIso, toIso },
    sources,
    true,
    excluded
  )
  // mail 条目解析用的同窗口 occurrences — 与 Layout j/k 巡航同 queryKey,
  // react-query 缓存命中, 零额外 IPC。
  const { data: windowEvents } = useCalendarEventsInWindow({ fromIso, toIso })
  const handleEntryClick = useAgendaEntryClick(onSelect, windowEvents)

  // refresh now-line each minute
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // 默认 scroll 到 8AM (加载完 / 切日期都 reset)。
  useEffect(() => {
    if (!isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = 8 * HOUR_PX - 16
    }
  }, [isLoading, gridStartMs])

  const gridCols = `56px repeat(${dayCount}, 1fr)`

  // 首次加载 (无 keepPreviousData 旧数据可借) 才显骨架; 切窗口时旧数据留屏。
  if (isLoading) {
    return <TimelineSkeleton cols={dayCount} />
  }

  const entries = data ?? []
  // F21 — query reject 不伪装成空态; 仅在无可显示数据时换错误屏。
  if (isError && entries.length === 0) {
    return (
      <div className="cal-week">
        <CalendarQueryError onRetry={refetch} />
      </div>
    )
  }
  if (entries.length === 0) {
    // S7 — 空态三语义 (无事件/从未同步/同步失败) 由 CalendarViewEmpty 判定。
    return (
      <div className="cal-week">
        <CalendarViewEmpty emptyTitle={emptyTitle} />
      </div>
    )
  }

  const { bands: bandEntries, timed, moments } = splitTimelineEntries(entries)
  const { bands, laneCount } = layoutTimelineBands(bandEntries, new Date(gridStartMs), dayCount)
  const timedByDay = groupEntriesByLocalDay(timed)
  const momentsByDay = groupEntriesByLocalDay(moments)
  const occs = windowEvents ?? []

  // now line — 区内含今天才画
  const showNow = days.some(isTodayLocal)
  const nowTopPx = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX

  return (
    <div className="cal-week">
      {/* head row */}
      <div className="wk-headrow" style={{ gridTemplateColumns: gridCols }}>
        <div className="wk-corner" />
        {days.map((d) => (
          <div key={ymd(d)} className={cn('wk-dayhead', isTodayLocal(d) && 'is-today')}>
            <div className="wk-dow">{DOW_EN_FULL[d.getDay()]}</div>
            <div className="wk-dn">{d.getDate()}</div>
          </div>
        ))}
      </div>

      {/* 置顶条区 — 全天/跨天色带 (月视图 .m-band 同语言, lane 堆叠); mail 色带
          从缓存解析 occurrence 取状态形态化 attr, 无色带时整行不渲染 */}
      {laneCount > 0 && (
        <div className="wk-alldayrow" style={{ gridTemplateColumns: '56px 1fr' }}>
          <div className="allday-gutter">
            <span>{t('calendar.shared.allDay', '全天')}</span>
          </div>
          <div className="wk-bandarea" style={{ height: laneCount * BAND_STEP_PX + 4 }}>
            {bands.map((band) => {
              const occ =
                band.entry.source === 'mail' ? resolveMailOccurrence(band.entry, occs) : null
              return (
                <button
                  key={band.entry.id}
                  type="button"
                  className="m-band"
                  data-src={agendaSrc(band.entry)}
                  data-resp={(occ?.response_status || '').toUpperCase() || undefined}
                  data-status={(occ?.status || '').toUpperCase() || undefined}
                  style={{
                    left: `calc(${(band.startCol * 100) / dayCount}% + 4px)`,
                    width: `calc(${(band.span * 100) / dayCount}% - 8px)`,
                    top: 3 + band.lane * BAND_STEP_PX
                  }}
                  onClick={() => handleEntryClick(band.entry)}
                  title={band.entry.title}
                >
                  {band.entry.title}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* scrolling timeline body */}
      <div ref={scrollRef} className="wk-body scrollbar-thin">
        <div className="wk-grid" style={{ gridTemplateColumns: gridCols }}>
          {/* hour gutter */}
          <div className="hour-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="hour-label">
                <span>{h === 0 ? '' : `${pad(h)}:00`}</span>
              </div>
            ))}
          </div>

          {/* day columns */}
          {days.map((d) => {
            const dayKey = ymd(d)
            const dayMs = d.getTime()
            const resolved = (timedByDay.get(dayKey) ?? []).map((entry) => ({
              entry,
              occ: resolveMailOccurrence(entry, occs)
            }))
            const entryOf = new Map<CalendarEventOccurrence, AgendaEntry>(
              resolved.map((r) => [r.occ, r.entry])
            )
            // P5 — 时间冲突只在同一天的定时块之间成立 (跨天条目走置顶色带,
            // 不参与); 判据单源 lib/conflict.ts, 与议程行 / 抽屉同一把尺子。
            const conflicts = detectConflicts(
              resolved
                .map((r) => candidateFromEntry(r.entry, r.occ))
                .filter((c): c is NonNullable<typeof c> => c !== null)
            )
            const laid = layoutDay(resolved.map((r) => r.occ))
            const dayMoments = layoutDayMoments(momentsByDay.get(dayKey) ?? [], dayMs, HOUR_PX)
            return (
              <div key={dayKey} className={cn('day-col', isTodayLocal(d) && 'is-today')}>
                {/* 24 hour cells for visual grid */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="hour-cell" />
                ))}
                {/* mail 定时块 — EventBlock (拖拽/Join/形态化全保留), 按源着色 */}
                {laid.map(({ occ, col, totalCols }) => {
                  // 恒走 occurrenceKey: override 是 useEventReschedule 用它写进去的,
                  // 手抄一份就等于用两把尺子 — 形状一变 override 静默失配。
                  const key = occurrenceKey(occ)
                  const override = timeOverrides[key] ?? null
                  const startMs = Date.parse(override?.startIso ?? occ.occurrence_start_iso)
                  const endMs = Date.parse(override?.endIso ?? occ.occurrence_end_iso)
                  const topPx = ((startMs - dayMs) / 3_600_000) * HOUR_PX
                  const heightPx = ((endMs - startMs) / 3_600_000) * HOUR_PX
                  const entry = entryOf.get(occ)
                  // 非组织者改不动 (服务端也会拒), 不给必失败的拖拽手感。
                  const canDrag = !!onReschedule && !canRsvpFor(occ.organizer, userEmail)
                  return (
                    <EventBlock
                      key={`b-${key}`}
                      event={occ}
                      src={entry && agendaSrc(entry) === 'hot' ? 'hot' : 'mail'}
                      topPx={topPx}
                      heightPx={heightPx}
                      col={col}
                      totalCols={totalCols}
                      selected={selectedKey === key}
                      conflictCount={entry ? (conflicts.get(entry.id) ?? 0) : 0}
                      onClick={() => onSelect(occ)}
                      timeOverride={override}
                      onReschedule={canDrag ? (next) => onReschedule?.(occ, next) : undefined}
                    />
                  )
                })}
                {/* 时刻标记 — matter/agent 时间点, 不撑假时长 (月视图胶囊件语言) */}
                {dayMoments.map(({ entry, topPx }) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="evt-mark"
                    data-src={agendaSrc(entry)}
                    style={{ top: topPx }}
                    onClick={() => handleEntryClick(entry)}
                    title={entry.title}
                  >
                    <span className="m-evt-dot" aria-hidden />
                    <span className="m-evt-title">{entry.title}</span>
                    <span className="m-evt-time">{shortTime(entry.startIso)}</span>
                  </button>
                ))}
              </div>
            )
          })}

          {/* now line + bubble — 区内含今天才画 */}
          {showNow && (
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
  )
}
