// Phase 3 §3.2 — 周/日视图 timeline 的 event 块 (按时间长度 stretch 高度).

import { Video } from 'lucide-react'

import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

interface EventBlockProps {
  event: CalendarEventOccurrence
  /** 块顶部 px 偏移 (相对 timeline 起点). */
  topPx: number
  /** 块高度 px. */
  heightPx: number
  /** 左边偏移 (并发事件 column 索引 × col_width). */
  leftPx?: number
  /** 块宽度 (并发分列时缩窄). 默认 100%. */
  widthPct?: number
  onClick?: () => void
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function meetingLink(occ: CalendarEventOccurrence): boolean {
  if (occ.url) return true
  if (occ.location && occ.location.toLowerCase().includes('teams.microsoft.com')) return true
  return false
}

export function EventBlock({
  event,
  topPx,
  heightPx,
  leftPx = 0,
  widthPct = 100,
  onClick
}: EventBlockProps): React.ReactElement {
  const isCancelled = event.status.toUpperCase() === 'CANCELLED'
  const isDeclined = event.response_status.toUpperCase() === 'DECLINED'
  const isPast = new Date(event.occurrence_end_iso) < new Date()

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        top: `${topPx}px`,
        height: `${Math.max(heightPx, 24)}px`,  // 最小 24px 防文字溢出
        left: `${leftPx}px`,
        width: `calc(${widthPct}% - ${leftPx + 4}px)`
      }}
      className={cn(
        'absolute rounded px-2 py-1 text-left overflow-hidden',
        'border border-coral/40 bg-coral/15 hover:bg-coral/30',
        'transition-colors duration-fast',
        (isCancelled || isDeclined) && 'opacity-40 line-through',
        isPast && !isCancelled && !isDeclined && 'opacity-60'
      )}
      title={`${event.summary || '(无标题)'}\n${shortTime(event.occurrence_start_iso)} - ${shortTime(event.occurrence_end_iso)}`}
    >
      <div className="flex items-center gap-1 text-meta font-mono text-ink-fg-2 tabular-nums">
        <span>{shortTime(event.occurrence_start_iso)}</span>
        {meetingLink(event) && <Video size={10} strokeWidth={2} className="text-coral" />}
      </div>
      <div className="text-aux text-ink-fg truncate">{event.summary || '(无标题)'}</div>
      {event.location && heightPx > 50 && (
        <div className="text-meta text-ink-fg-2 truncate mt-0.5">{event.location}</div>
      )}
    </button>
  )
}
