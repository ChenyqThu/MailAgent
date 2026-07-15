// 视觉复刻 mockup-calendar.html §.evt (2026-05-23) —
// 周/日 timeline 的事件块. 用 .evt + data-resp / data-status 利用 CSS
// 自动呈现 5 种 response 状态 + cancelled / past / selected.
//
// API change vs 旧版: 新增 col/totalCols (并发分列) 替代 leftPx/widthPct,
// 调用方传 col 索引 + 同时段总列数, 这里算 left/width %, 避免老代码 leftPx*6
// 的硬 px bug.

import { Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { shortTime } from './lib/format'
import { extractMeetingLink, openMeetingLink } from './lib/meeting-link'

interface EventBlockProps {
  event: CalendarEventOccurrence
  /** 块顶部 px 偏移 (相对 timeline 起点). */
  topPx: number
  /** 块高度 px (raw, 内部 min 24, 减 2 留 hour-cell 边). */
  heightPx: number
  /** 并发列索引 (0-based). 默认 0. */
  col?: number
  /** 同时段并发总列数 (≥1). 默认 1. */
  totalCols?: number
  selected?: boolean
  onClick?: () => void
}

// F32 — shortTime 抽到 ./lib/format

function hasMeetingLink(occ: CalendarEventOccurrence): boolean {
  if (occ.url && occ.url.length > 0) return true
  if (occ.location && occ.location.toLowerCase().includes('teams.microsoft.com')) return true
  return false
}

export function EventBlock({
  event,
  topPx,
  heightPx,
  col = 0,
  totalCols = 1,
  selected = false,
  onClick
}: EventBlockProps): React.ReactElement {
  const { t } = useTranslation()
  const untitled = t('calendar.shared.untitled', '未命名事件')
  const h = Math.max(heightPx - 2, 22)
  const widthPct = 100 / Math.max(totalCols, 1)
  const leftPct = col * widthPct
  const short = h <= 30
  const isPast = new Date(event.occurrence_end_iso) < new Date()
  const meeting = hasMeetingLink(event)
  // 阶段2·2.5 — hover 浮出 Join 小钮 (occurrence 无 description, 凭 url/location).
  const joinLink = extractMeetingLink({ url: event.url, location: event.location })
  const startTxt = shortTime(event.occurrence_start_iso)
  const endTxt = shortTime(event.occurrence_end_iso)
  const titleAttr = `${event.summary || untitled}\n${startTxt} – ${endTxt}${event.location ? '\n' + event.location : ''}`

  return (
    // 2.5 — 根从 <button> 改 <div role="button"> (EmailRow 同款): Join 需要
    // 内嵌真 <button>, 嵌套 button 非法. Enter/Space 激活语义手动补齐.
    <div
      role="button"
      tabIndex={0}
      className={cn('evt', selected && 'is-selected', isPast && 'is-past')}
      data-resp={(event.response_status || '').toUpperCase()}
      data-status={(event.status || '').toUpperCase()}
      style={{
        top: `${topPx}px`,
        height: `${h}px`,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      title={titleAttr}
    >
      <div className="e-time">
        <span>{startTxt}</span>
        {meeting && <Video className="teams-i" size={11} strokeWidth={2} aria-hidden />}
      </div>
      <div
        className={cn('e-title', !event.summary && 'empty-field')}
        style={short ? { fontSize: '11px' } : undefined}
      >
        {event.summary || untitled}
      </div>
      {!short && h > 52 && event.location && <div className="e-loc">{event.location}</div>}
      {joinLink && (
        <button
          type="button"
          className="evt-join"
          onClick={(e) => {
            e.stopPropagation()
            openMeetingLink(joinLink)
          }}
          title={t('calendar.join.button', '加入会议')}
          aria-label={t('calendar.join.button', '加入会议')}
        >
          <Video size={10} strokeWidth={2.4} aria-hidden />
          {t('calendar.join.short', 'Join')}
        </button>
      )}
    </div>
  )
}
