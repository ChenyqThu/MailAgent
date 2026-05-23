// Phase 3 §3.2 — 月视图单格 + agenda 行的 event chip 渲染.

import { Calendar as CalendarIcon, Video } from 'lucide-react'

import type { CalendarEventOccurrence } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

interface EventChipProps {
  event: CalendarEventOccurrence
  onClick?: () => void
  compact?: boolean
}

/** RESPONSE_STATUS → 视觉强度. */
function responseStyle(status: string): string {
  switch (status.toUpperCase()) {
    case 'DECLINED':
      return 'opacity-50 line-through'
    case 'TENTATIVE':
      return 'opacity-75'
    case 'NEEDS-ACTION':
      return 'ring-1 ring-coral/40'
    case 'ACCEPTED':
    case 'CONFIRMED':
    default:
      return ''
  }
}

/** STATUS=CANCELLED → 灰色 + 划线; 过期事件 → 灰度. */
function statusStyle(occ: CalendarEventOccurrence): string {
  if (occ.status.toUpperCase() === 'CANCELLED') {
    return 'opacity-40 line-through'
  }
  const end = new Date(occ.occurrence_end_iso)
  if (end < new Date()) return 'opacity-60'
  return ''
}

function localTimeShort(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function hasMeetingLink(occ: CalendarEventOccurrence): boolean {
  if (occ.url && occ.url.length > 0) return true
  if (occ.location && occ.location.toLowerCase().includes('teams.microsoft.com')) return true
  return false
}

export function EventChip({ event, onClick, compact = false }: EventChipProps): React.ReactElement {
  const startTxt = event.is_all_day ? '全天' : localTimeShort(event.occurrence_start_iso)
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1 rounded',
        'border border-coral/30 bg-coral/10 hover:bg-coral/20',
        'text-aux text-ink-fg transition-colors duration-fast text-left w-full',
        responseStyle(event.response_status),
        statusStyle(event)
      )}
      title={event.summary || '(无标题)'}
    >
      <CalendarIcon size={12} strokeWidth={2} className="text-coral shrink-0" />
      {!compact && (
        <span className="text-meta font-mono text-ink-fg-2 tabular-nums shrink-0">
          {startTxt}
        </span>
      )}
      <span className="truncate flex-1">{event.summary || '(无标题)'}</span>
      {hasMeetingLink(event) && <Video size={11} strokeWidth={2} className="text-coral shrink-0" />}
    </button>
  )
}
