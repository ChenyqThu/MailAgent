// 视觉复刻 mockup-calendar.html §month (2026-05-23) —
// 6×7 grid (周一首列), 每格显示日期 + 最多 3 个 EventChip, 超出弹 .more-pop
// fixed popover. is-other 灰底, today coral 圆角 .nday + "今天" tag.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EventChip } from '../EventChip'
import { isTodayLocal, ymd } from '../lib/format'
import {
  useCalendarEventsInWindow,
  startOfMonth,
  startOfWeek,
  addDays
} from '../hooks/useCalendarEvents'
import type { CalendarEventOccurrence } from '@shared/api/types'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { cn } from '@shared/lib/cn'

interface Props {
  date?: Date
  calendarName?: string
  /** Phase 4·#1 — 多 calendar 多选 (client-side filter). 空 = 全部. */
  selectedCalendars?: string[]
  /** F5 — view 上提选中事件给 CalendarLayout. */
  onSelect: (occ: CalendarEventOccurrence) => void
}

const DOW_EN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const MAX_VISIBLE = 3

// F32 — ymd/isTodayLocal 抽到 ../lib/format

interface PopState {
  top: number
  left: number
  items: CalendarEventOccurrence[]
  dayLabel: string
}

export function MonthView({
  date,
  calendarName,
  selectedCalendars,
  onSelect
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const [pop, setPop] = useState<PopState | null>(null)
  // F11 — popover click-outside 用 ref + capture phase mousedown 判断, 不靠
  // 内部元素 stopPropagation (脆弱: 漏一处就闪一下消失).
  const popRef = useRef<HTMLDivElement | null>(null)

  const monthStart = useMemo(() => startOfMonth(date ?? new Date()), [date])
  const gridStart = useMemo(() => startOfWeek(monthStart), [monthStart])
  const gridEnd = useMemo(() => addDays(gridStart, 42), [gridStart])
  const days = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    [gridStart]
  )
  const currentMonth = monthStart.getMonth()

  const { data, isLoading } = useCalendarEventsInWindow(
    {
      fromIso: gridStart.toISOString(),
      toIso: gridEnd.toISOString(),
      calendarName
    },
    selectedCalendars
  )

  // F11 — popover click-outside / Esc to close. 用 capture phase mousedown
  // + popRef.contains 判断点击在 popover 内, 比老 'click' bubble + 内部
  // stopPropagation 更稳 (后者漏一处就闪).
  useEffect(() => {
    if (!pop) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null)
    }
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as (Node & { closest?: (s: string) => Element | null }) | null
      if (!target) return
      if (popRef.current && popRef.current.contains(target)) return
      // F28 — 点击 drawer 内部 (含 backdrop) 时 drawer 自己负责关; popover
      // 不应抢着 close 后让 drawer 关闭多一帧延迟. 排除 .drawer + .drawer-backdrop
      // (内部 click 时 drawer.tsx 走 onClose, popover 自然下次 mousedown 关).
      if (typeof target.closest === 'function') {
        const inDrawer = target.closest('.drawer, .drawer-backdrop')
        if (inDrawer) return
      }
      setPop(null)
    }
    window.addEventListener('keydown', esc)
    document.addEventListener('mousedown', handleMouseDown, true)
    return () => {
      window.removeEventListener('keydown', esc)
      document.removeEventListener('mousedown', handleMouseDown, true)
    }
  }, [pop])

  // 首次加载 (无 keepPreviousData 旧数据) 才显网格骨架; 切月时旧月格留屏不闪.
  if (isLoading) {
    return (
      <div className="cal-month" aria-busy="true">
        <div className="m-dow">
          {DOW_EN.map((label) => (
            <div key={label}>{label}</div>
          ))}
        </div>
        <div className="m-grid">
          {Array.from({ length: 42 }, (_, i) => (
            <div key={`skel-cell-${i}`} className="m-cell">
              <div className="m-num">
                <span className="nday h-3.5 w-5 rounded bg-ink-3 animate-pulse motion-reduce:animate-none" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const events = data ?? []
  if (events.length === 0) {
    return (
      <div className="cal-month">
        <EmptyState
          icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
          title={t('calendar.empty.month', '本月无日程')}
          hint={t('calendar.empty.syncHint')}
        />
      </div>
    )
  }

  // group occurrences by local day; all-day events include跨天逻辑.
  const byDay = new Map<string, CalendarEventOccurrence[]>()
  for (const occ of events) {
    const s = new Date(occ.occurrence_start_iso)
    const e = new Date(occ.occurrence_end_iso)
    if (occ.is_all_day) {
      // 把跨天 all-day 事件展开到每一天
      const startDay = new Date(s.getFullYear(), s.getMonth(), s.getDate())
      const endDay = new Date(e.getFullYear(), e.getMonth(), e.getDate())
      let cur = startDay
      while (cur.getTime() <= endDay.getTime()) {
        const k = ymd(cur)
        const arr = byDay.get(k) ?? []
        arr.push(occ)
        byDay.set(k, arr)
        cur = addDays(cur, 1)
        if (cur.getTime() - startDay.getTime() > 14 * 86_400_000) break // safety
      }
    } else {
      const k = ymd(s)
      const arr = byDay.get(k) ?? []
      arr.push(occ)
      byDay.set(k, arr)
    }
  }

  return (
    <div className="cal-month">
      <div className="m-dow">
        {DOW_EN.map((label) => (
          <div key={label}>{label}</div>
        ))}
      </div>
      <div className="m-grid">
        {days.map((d, i) => {
          const isOther = d.getMonth() !== currentMonth
          const today = isTodayLocal(d)
          const dayEvents = byDay.get(ymd(d)) ?? []
          // sort: all-day first, then by start time
          const sorted = [...dayEvents].sort((a, b) => {
            if (a.is_all_day !== b.is_all_day) return a.is_all_day ? -1 : 1
            return Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
          })
          const visible = sorted.slice(0, MAX_VISIBLE)
          const moreCount = sorted.length - visible.length
          const monthN = d.getMonth() + 1
          return (
            <div key={i} className={cn('m-cell', isOther && 'is-other', today && 'is-today')}>
              <div className="m-num">
                <span className="nday">{d.getDate()}</span>
                {today && (
                  <span className="m-today-tag">{t('calendar.view.month.today', '今天')}</span>
                )}
              </div>
              {visible.map((occ) => (
                <EventChip
                  key={`${occ.id}-${occ.occurrence_start_iso}`}
                  event={occ}
                  onClick={() => onSelect(occ)}
                />
              ))}
              {moreCount > 0 && (
                <button
                  type="button"
                  className="more-btn"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                    setPop({
                      top: rect.bottom + 6,
                      left: Math.min(rect.left, window.innerWidth - 240),
                      items: sorted,
                      dayLabel: `${monthN} 月 ${d.getDate()} 日`
                    })
                  }}
                >
                  {t('calendar.view.month.moreBtn', '+{n} 更多', { n: moreCount })}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {pop && (
        <div ref={popRef} className="more-pop glass-pop" style={{ top: pop.top, left: pop.left }}>
          <div className="mp-head">
            <span>{pop.dayLabel}</span>
            <span className="mp-date">
              {t('calendar.view.month.popEventCount', '{n} 个事件', { n: pop.items.length })}
            </span>
          </div>
          <div className="space-y-1">
            {pop.items.map((occ, idx) => (
              <EventChip
                key={`${occ.id}-${occ.occurrence_start_iso}-${idx}`}
                event={occ}
                onClick={() => {
                  onSelect(occ)
                  setPop(null)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
