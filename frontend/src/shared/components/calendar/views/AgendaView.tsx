// 视觉复刻 mockup-calendar.html §agenda (2026-05-23) —
// 按日期 group, 每 group sticky ah-head, 行 grid 110px/1fr (time / main).
// Toolbar 已接管 "N 个日程 + 刷新", 这里专注内容呈现.

import { useRef } from 'react'
import { Calendar as CalendarIcon, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  useCalendarEventsInWindow,
  groupOccurrencesByLocalDay,
  todayStartLocal,
  addDays
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
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
  onSelect
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const start = todayStartLocal()
  const end = addDays(start, rangeDays)
  const { data, isLoading } = useCalendarEventsInWindow(
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

  if (!data || data.length === 0) {
    return (
      <div className="cal-agenda">
        <EmptyState
          icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
          title={t('calendar.empty.agenda', '未来 {n} 天无日程', { n: rangeDays })}
          hint="CalDAV worker 可能尚未启用 — 检查 CALENDAR_CALDAV_SYNC_ENABLED"
        />
      </div>
    )
  }

  const grouped = groupOccurrencesByLocalDay(data)
  const sortedKeys = Array.from(grouped.keys()).sort()

  return (
    <div ref={agendaRef} className="cal-agenda scrollbar-thin">
      {sortedKeys.map((key) => {
        const lbl = headerLabels(key)
        const items = (grouped.get(key) ?? []).slice().sort((a, b) => {
          if (a.is_all_day !== b.is_all_day) return a.is_all_day ? -1 : 1
          return Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
        })
        return (
          <section key={key} className="ag-group">
            <div className={cn('ag-head', lbl.isToday && 'is-today')}>
              <span className="ah-day">{lbl.ahDay}</span>
              <span className="ah-date">{lbl.ahDate}</span>
            </div>
            {items.map((occ) => {
              const allDay = occ.is_all_day
              const timeTxt = allDay
                ? t('calendar.shared.allDay', '全天')
                : `${shortTime(occ.occurrence_start_iso)} – ${shortTime(occ.occurrence_end_iso)}`
              const meeting = hasMeetingLink(occ)
              const showLoc =
                occ.location && !occ.location.toLowerCase().includes('teams.microsoft.com')
              const untitled = t('calendar.shared.untitled', '未命名事件')
              return (
                <button
                  key={`${occ.id}-${occ.occurrence_start_iso}`}
                  type="button"
                  className="ag-row"
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
