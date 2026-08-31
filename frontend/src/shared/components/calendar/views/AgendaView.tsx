// task 08-27 P4d —— 日程视图接三源 (月/周/日之后补上的最后一个视图)。
//
// 之前它只读 mail 源, 切到「日程」事项截止与 agent 排程整体消失; 现在与
// 月/周/日同一份数据 (useCalendarAgenda) 同一套源色 (data-src → --src),
// 组级开关与成员排除集经 hook select 生效, 切勾选不重发请求。
//
// 形态: 按日成组 (组头 sticky) + 行 grid 110px/1fr (time / main)。跨天条目按
// overlap 展开到覆盖的每一天, 时间列显当日实际覆盖段 (首日 `10:00 →` / 中间
// 「全天」/ 末日 `→ 16:00`); 连续空日折叠成一行。分组与排序在 lib/agendaList。
//
// 点击分流复用 useAgendaEntryClick, 三源都开 EventDetailDrawer: mail → 同窗口
// events 缓存解析回 occurrence 上抛给 Layout (状态形态化 attr / 地点 / Join 也取自
// 这条解析链); matter / agent → 投影槽位, 抽屉里渲染投影形态并在那儿给「去源头」。

import { useRef } from 'react'
import { Calendar as CalendarIcon, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { addDays, todayStartLocal, useCalendarEventsInWindow } from '../hooks/useCalendarEvents'
import { useAgendaEntryClick } from '../hooks/useAgendaEntryClick'
import { useCalendarAgenda } from '../hooks/useCalendarAgenda'
import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import { CalendarQueryError } from '../CalendarQueryError'
import { extractMeetingLink, MEETING_PROVIDER_LABEL, openMeetingLink } from '../lib/meeting-link'
import { agendaSrc, resolveMailOccurrence } from '../lib/agendaLayout'
import { buildAgendaSections, type AgendaRow } from '../lib/agendaList'
import { shortTime } from '../lib/format'
import { isAgendaEntrySelected } from '../lib/monthGrid'
import { weekdayLong } from '../lib/weekdays'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useCalendarView } from '@shared/state/calendar-view'

interface Props {
  rangeDays?: number // default 14 天
  /** F5 — view 上提选中事件给 CalendarLayout (仅 mail 源)。 */
  onSelect: (occ: CalendarEventOccurrence) => void
  /** F4/Q13 — selected event key (= ``${id}-${occurrence_start_iso}``) 由
   *  Layout 传, 行比对高亮 drawer 当前 occurrence (跨天条目的每个日行同亮). */
  selectedKey?: string | null
}

function mdLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 组头: 今天 / 明天 / 周几 + M/D。 */
function headerLabels(
  t: TFunction,
  date: Date,
  today: Date
): { ahDay: string; ahDate: string; isToday: boolean } {
  const offset = Math.round((date.getTime() - today.getTime()) / 86_400_000)
  const ahDate = mdLabel(date)
  if (offset === 0) return { ahDay: t('calendar.view.agenda.today', '今天'), ahDate, isToday: true }
  if (offset === 1)
    return { ahDay: t('calendar.view.agenda.tomorrow', '明天'), ahDate, isToday: false }
  return { ahDay: weekdayLong(t, date.getDay()), ahDate, isToday: false }
}

/** 事项 / Agent 条目的来源标 —— 一眼认出它不是普通会议。mail 源不挂 (整屏
 *  多数是邮箱日程, 每行都标反而是噪音, 源色已经区分)。 */
function sourceTag(t: TFunction, entry: AgendaEntry): string | null {
  if (entry.source === 'matter') return t('calendar.view.agenda.tagMatter', '事项')
  if (entry.source === 'agent') return t('calendar.view.agenda.tagAgent', 'Agent')
  return null
}

function hasMeetingLink(occ: CalendarEventOccurrence): boolean {
  if (occ.url && occ.url.length > 0) return true
  if (occ.location && occ.location.toLowerCase().includes('teams.microsoft.com')) return true
  return false
}

export function AgendaView({
  rangeDays = 14,
  onSelect,
  selectedKey = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const sources = useCalendarView((s) => s.sources)
  const excluded = useCalendarView((s) => s.excluded)
  const start = todayStartLocal()
  const fromIso = start.toISOString()
  const toIso = addDays(start, rangeDays).toISOString()

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

  const allDayLabel = t('calendar.shared.allDay', '全天')
  const untitled = t('calendar.shared.untitled', '未命名事件')

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

  const entries = data ?? []
  // F21 — query reject 不再伪装成空态; 仅在无可显示数据时换错误屏
  // (keepPreviousData 下后台 refetch 偶发失败, 已在屏的旧数据继续留屏).
  if (isError && entries.length === 0) {
    return (
      <div className="cal-agenda">
        <CalendarQueryError onRetry={refetch} />
      </div>
    )
  }

  if (entries.length === 0) {
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

  const sections = buildAgendaSections(entries, start, rangeDays)
  const occs = windowEvents ?? []

  /** 时间列 — 当日实际覆盖段: 全天恒「全天」; 跨天首日显开始 (14:00 →),
   *  中间日全天, 末日显结束 (→ 16:00); 单日显起止; 时间点 (matter 截止 /
   *  agent 排程) 只显时刻, 不撑出假的结束时间。 */
  function timeLabel(row: AgendaRow): string {
    const { entry } = row
    if (entry.allDay) return allDayLabel
    if (row.spansDays) {
      if (row.isFirstDay) return `${shortTime(entry.startIso)} →`
      if (row.isLastDay && entry.endIso) return `→ ${shortTime(entry.endIso)}`
      return allDayLabel
    }
    if (entry.endIso) return `${shortTime(entry.startIso)} – ${shortTime(entry.endIso)}`
    return shortTime(entry.startIso)
  }

  return (
    <div ref={agendaRef} className="cal-agenda scrollbar-thin">
      {sections.map((section) => {
        if (section.kind === 'gap') {
          return (
            <div key={section.key} className="ag-gap">
              {section.days === 1
                ? t('calendar.view.agenda.gapDay', '{d} 无日程', { d: mdLabel(section.from) })
                : t('calendar.view.agenda.gapRange', '{from} – {to} 无日程', {
                    from: mdLabel(section.from),
                    to: mdLabel(section.to)
                  })}
            </div>
          )
        }
        const lbl = headerLabels(t, section.date, start)
        return (
          <section key={section.key} className="ag-group">
            <div className={cn('ag-head', lbl.isToday && 'is-today')}>
              <span className="ah-day">{lbl.ahDay}</span>
              <span className="ah-date">{lbl.ahDate}</span>
            </div>
            {section.rows.map((row) => {
              const entry = row.entry
              // 状态形态化 / 地点 / Join 都只对邮箱日程成立 —— 它们是 occurrence
              // 上的字段, AgendaEntry 不带, 靠同窗口缓存解析回来。
              const occ = entry.source === 'mail' ? resolveMailOccurrence(entry, occs) : null
              const joinLink = occ
                ? extractMeetingLink({ url: occ.url, location: occ.location })
                : null
              const showLoc =
                occ?.location && !occ.location.toLowerCase().includes('teams.microsoft.com')
              const tag = sourceTag(t, entry)
              return (
                // 2.5 — 行根从 <button> 改 <div role="button"> (EmailRow 同款):
                // 行尾 Join 是真 <button>, 嵌套 button 非法.
                <div
                  key={`${entry.id}-${section.key}`}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'ag-row',
                    isAgendaEntrySelected(entry, selectedKey) && 'is-selected'
                  )}
                  data-src={agendaSrc(entry)}
                  data-resp={(occ?.response_status || '').toUpperCase() || undefined}
                  data-status={(occ?.status || '').toUpperCase() || undefined}
                  onClick={() => handleEntryClick(entry)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleEntryClick(entry)
                    }
                  }}
                  title={entry.title || untitled}
                >
                  <div className="ag-time">{timeLabel(row)}</div>
                  <div className="ag-main">
                    <span className="ag-bar" aria-hidden />
                    <span className={cn('ag-title', !entry.title && 'empty-field')}>
                      {entry.title || untitled}
                    </span>
                    {tag && <span className="ag-tag">{tag}</span>}
                    {occ && hasMeetingLink(occ) && (
                      <Video className="teams-i" size={11} strokeWidth={2} aria-hidden />
                    )}
                    {showLoc && <span className="ag-loc">{occ.location}</span>}
                    {joinLink && (
                      <button
                        type="button"
                        className="ag-join"
                        onClick={(e) => {
                          e.stopPropagation()
                          openMeetingLink(joinLink)
                        }}
                        title={t('calendar.join.title', '加入会议 — 在 {p} 中打开', {
                          p: MEETING_PROVIDER_LABEL[joinLink.provider]
                        })}
                      >
                        <Video size={10} strokeWidth={2.4} aria-hidden />
                        {t('calendar.join.short', 'Join')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
