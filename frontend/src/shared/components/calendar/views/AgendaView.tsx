// 视觉复刻 mockup-calendar.html §agenda (2026-05-23) —
// 按日期 group, 每 group sticky ah-head, 行 grid 110px/1fr (time / main).
// Toolbar 已接管 "N 个日程 + 刷新", 这里专注内容呈现.
//
// F22/S6 — 跨天事件按 overlap 展开: 与该日窗口重叠的每一天都出一行, 标
// 「第 n/m 天」; 时间列显示当日实际覆盖段 (首日=开始时间→, 中间日=全天,
// 末日=→结束时间).

import { useRef } from 'react'
import { Calendar as CalendarIcon, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  useCalendarEventsInWindow,
  expandOccurrencesByLocalDayOverlap,
  todayStartLocal,
  addDays,
  type AgendaDayEntry
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { CalendarQueryError } from '../CalendarQueryError'
import { shortTime, ymd } from '../lib/format'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

interface Props {
  rangeDays?: number // default 14 天
  calendarName?: string
  /** Phase 4·#1 — 多 calendar 多选 (client-side filter). 空 = 全部. */
  selectedCalendars?: string[]
  /** F5 — view 上提选中事件给 CalendarLayout. */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F4/Q13 — selected event key (= ``${id}-${occurrence_start_iso}``) 由
   *  Layout 传, 行比对高亮 drawer 当前 occurrence (跨天事件的每个日行同亮). */
  selectedKey?: string | null
}

// F32 — pad/ymd/shortTime 抽到 ../lib/format

interface HeaderLabels {
  ahDay: string
  ahDate: string
  isToday: boolean
}

function headerLabels(key: string): HeaderLabels {
  const [y, m, d] = key.split('-').map(Number)
  const target = new Date(y, m - 1, d)
  const today = todayStartLocal()
  const tomorrow = addDays(today, 1)
  const tKey = ymd(today)
  const tomKey = ymd(tomorrow)
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const wd = weekDays[target.getDay()]
  const ahDate = `${m}/${d} ${wd}`
  if (key === tKey) return { ahDay: '今天', ahDate, isToday: true }
  if (key === tomKey) return { ahDay: '明天', ahDate, isToday: false }
  return { ahDay: `${d}日`, ahDate, isToday: false }
}

function hasMeetingLink(occ: CalendarEventOccurrence): boolean {
  if (occ.url && occ.url.length > 0) return true
  if (occ.location && occ.location.toLowerCase().includes('teams.microsoft.com')) return true
  return false
}

export function AgendaView({
  rangeDays = 14,
  calendarName,
  selectedCalendars,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const start = todayStartLocal()
  const end = addDays(start, rangeDays)
  const { data, isLoading, isError, refetch } = useCalendarEventsInWindow(
    {
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
      calendarName
    },
    selectedCalendars
  )

  // 议程条目挂载/数据变化时逐条 autoAlpha 淡入 (克制 stagger)。stagger 总跨度封顶
  // 0.2s (amount), 条目再多总时长也 ≤ DUR.base+0.2 ≈ DUR.slow 量级。
  // reduced-motion no-op。useGSAP({scope}) 自动 cleanup。
  const agendaRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  useGSAP(
    () => {
      if (reduce || !agendaRef.current) return
      const items = agendaRef.current.querySelectorAll('.ag-row')
      if (items.length === 0) return
      gsap.from(items, {
        autoAlpha: 0,
        y: 6,
        duration: DUR.base,
        stagger: { each: 0.03, amount: 0.2 }
      })
    },
    { dependencies: [data, reduce], scope: agendaRef }
  )

  if (isLoading) {
    return (
      <div className="cal-agenda">
        <div className="ag-group">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </div>
    )
  }

  // F21 — query reject 不再伪装成空态; 仅在无可显示数据时换错误屏
  // (keepPreviousData 下后台 refetch 偶发失败, 已在屏的旧数据继续留屏).
  if (isError && (!data || data.length === 0)) {
    return (
      <div className="cal-agenda">
        <CalendarQueryError onRetry={refetch} />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className="cal-agenda">
        <EmptyState
          icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
          title={t('calendar.empty.agenda', '未来 {n} 天无日程', { n: rangeDays })}
          hint={t('calendar.empty.syncHint')}
        />
      </div>
    )
  }

  // F22/S6 — overlap 展开可能产出窗口外的 key (跨天事件起于窗口前/止于窗口
  // 后), 按 [start, end) 过滤; YYYY-MM-DD 字符串序即日期序.
  const grouped = expandOccurrencesByLocalDayOverlap(data)
  const startKey = ymd(start)
  const endKey = ymd(end)
  const sortedKeys = Array.from(grouped.keys())
    .filter((k) => k >= startKey && k < endKey)
    .sort()

  /** 时间列 — 当日实际覆盖段: all-day 恒「全天」; 跨天 timed 首日显开始
   *  (14:00 →), 中间日全天, 末日显结束 (→ 16:00); 单日 timed 显起止. */
  function timeLabel(entry: AgendaDayEntry): string {
    const { occ, dayIndex, totalDays } = entry
    const allDayLabel = t('calendar.shared.allDay', '全天')
    if (occ.is_all_day) return allDayLabel
    if (totalDays === 1)
      return `${shortTime(occ.occurrence_start_iso)} – ${shortTime(occ.occurrence_end_iso)}`
    if (dayIndex === 1) return `${shortTime(occ.occurrence_start_iso)} →`
    if (dayIndex === totalDays) return `→ ${shortTime(occ.occurrence_end_iso)}`
    return allDayLabel
  }

  return (
    <div ref={agendaRef} className="cal-agenda scrollbar-thin">
      {sortedKeys.map((key) => {
        const lbl = headerLabels(key)
        const items = (grouped.get(key) ?? []).slice().sort((a, b) => {
          if (a.occ.is_all_day !== b.occ.is_all_day) return a.occ.is_all_day ? -1 : 1
          // 当日覆盖段起点排序 — 跨午夜 continuation (00:00 起) 排当日最前.
          return a.segStartMs - b.segStartMs
        })
        return (
          <section key={key} className="ag-group">
            <div className={cn('ag-head', lbl.isToday && 'is-today')}>
              <span className="ah-day">{lbl.ahDay}</span>
              <span className="ah-date">{lbl.ahDate}</span>
            </div>
            {items.map((entry) => {
              const occ = entry.occ
              const timeTxt = timeLabel(entry)
              const meeting = hasMeetingLink(occ)
              const showLoc =
                occ.location && !occ.location.toLowerCase().includes('teams.microsoft.com')
              const untitled = t('calendar.shared.untitled', '未命名事件')
              const multiDay = entry.totalDays > 1
              return (
                <button
                  key={`${occ.id}-${occ.occurrence_start_iso}`}
                  type="button"
                  className={cn(
                    'ag-row',
                    selectedKey === `${occ.id}-${occ.occurrence_start_iso}` && 'is-selected'
                  )}
                  data-resp={(occ.response_status || '').toUpperCase()}
                  data-status={(occ.status || '').toUpperCase()}
                  onClick={() => onSelect(occ)}
                  title={occ.summary || untitled}
                >
                  <div className="ag-time">{timeTxt}</div>
                  <div className="ag-main">
                    <span className="ag-bar" aria-hidden />
                    <span className={cn('ag-title', !occ.summary && 'empty-field')}>
                      {occ.summary || untitled}
                    </span>
                    {multiDay && (
                      <span className="cal-day-badge">
                        {t('calendar.view.agenda.dayOfSpan', '第 {n}/{m} 天', {
                          n: entry.dayIndex,
                          m: entry.totalDays
                        })}
                      </span>
                    )}
                    {meeting && <Video className="teams-i" size={11} strokeWidth={2} aria-hidden />}
                    {showLoc && <span className="ag-loc">{occ.location}</span>}
                  </div>
                </button>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
