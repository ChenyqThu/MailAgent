// Phase 3 §3.2 — 点击 event 后右侧 slide-in 抽屉, 显示完整 event detail +
// 关联邮件跳转 + Notion / Teams 链接外开.

import { X, ExternalLink, Mail, Video, MapPin, User, Users } from 'lucide-react'
import { useEffect } from 'react'

import { useCalendarEvent } from './hooks/useCalendarEvents'
import type { CalendarEventOccurrence, CalendarEventSource } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

interface Props {
  /** Null = 关闭抽屉. */
  occurrence: CalendarEventOccurrence | null
  onClose: () => void
}

function formatRange(startIso: string, endIso: string, isAllDay: boolean): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const dateStr = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`
  if (isAllDay) return `${dateStr} (全天)`
  const t1 = `${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}`
  const t2 = `${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`
  return `${dateStr}  ${t1} → ${t2}`
}

function responseLabel(s: string): string {
  switch (s.toUpperCase()) {
    case 'ACCEPTED':
      return '已接受'
    case 'TENTATIVE':
      return '暂定'
    case 'DECLINED':
      return '已拒绝'
    case 'NEEDS-ACTION':
      return '待回复'
    default:
      return s || '—'
  }
}

export function EventDetailDrawer({ occurrence, onClose }: Props): React.ReactElement | null {
  const opts = occurrence
    ? {
        icalUid: occurrence.ical_uid,
        recurrenceId: occurrence.recurrence_id,
        source: occurrence.source as CalendarEventSource
      }
    : null
  const { data: detail, isLoading } = useCalendarEvent(opts)

  // ESC closes
  useEffect(() => {
    if (!occurrence) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [occurrence, onClose])

  if (!occurrence) return null

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
        aria-hidden
      />
      {/* drawer */}
      <aside
        className={cn(
          'fixed right-0 top-0 h-full w-[420px] z-50',
          'bg-ink-1 border-l border-ink-border shadow-xl overflow-y-auto'
        )}
      >
        <header className="sticky top-0 bg-ink-1 z-10 px-5 py-4 border-b border-ink-border-soft flex items-center justify-between">
          <h2 className="text-display text-ink-fg font-semibold truncate">
            {occurrence.summary || '(无标题)'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-fg-2 hover:text-ink-fg p-1"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <Row label="时间">
            <span className="text-aux font-mono text-ink-fg-1 tabular-nums">
              {formatRange(
                occurrence.occurrence_start_iso,
                occurrence.occurrence_end_iso,
                occurrence.is_all_day
              )}
            </span>
          </Row>

          {occurrence.calendar_name && (
            <Row label="日历">
              <span className="text-aux text-ink-fg-1">{occurrence.calendar_name}</span>
            </Row>
          )}

          {occurrence.location && (
            <Row label="地点" icon={<MapPin size={14} strokeWidth={2} />}>
              <span className="text-aux text-ink-fg-1 break-all">
                {occurrence.location}
              </span>
            </Row>
          )}

          {occurrence.organizer && (
            <Row label="组织者" icon={<User size={14} strokeWidth={2} />}>
              <span className="text-aux text-ink-fg-1">{occurrence.organizer}</span>
            </Row>
          )}

          {occurrence.attendees && occurrence.attendees.length > 0 && (
            <Row
              label={`与会者 (${occurrence.attendees.length})`}
              icon={<Users size={14} strokeWidth={2} />}
            >
              <div className="space-y-1">
                {occurrence.attendees.slice(0, 10).map((a, i) => (
                  <div key={i} className="text-aux text-ink-fg-1">
                    {a.name ? `${a.name} <${a.email}>` : a.email}
                    {a.response && (
                      <span className="ml-2 text-meta text-ink-fg-2">
                        [{responseLabel(a.response)}]
                      </span>
                    )}
                  </div>
                ))}
                {occurrence.attendees.length > 10 && (
                  <div className="text-meta text-ink-fg-2">
                    ... 还有 {occurrence.attendees.length - 10} 位
                  </div>
                )}
              </div>
            </Row>
          )}

          {occurrence.response_status && (
            <Row label="我的回复">
              <span className="text-aux text-ink-fg-1">
                {responseLabel(occurrence.response_status)}
              </span>
            </Row>
          )}

          {occurrence.url && (
            <Row label="会议链接" icon={<Video size={14} strokeWidth={2} />}>
              <a
                href={occurrence.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-aux text-coral hover:underline inline-flex items-center gap-1 break-all"
              >
                {occurrence.url.length > 60
                  ? occurrence.url.slice(0, 60) + '…'
                  : occurrence.url}
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            </Row>
          )}

          {occurrence.related_email_internal_id && (
            <Row label="关联邮件" icon={<Mail size={14} strokeWidth={2} />}>
              <a
                href={`/?internal_id=${occurrence.related_email_internal_id}`}
                className="text-aux text-coral hover:underline inline-flex items-center gap-1"
              >
                #{occurrence.related_email_internal_id}
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            </Row>
          )}

          {/* 详情 (从 event-get 拉) — RRULE / 描述 / ICS 等 */}
          {isLoading ? (
            <div className="text-meta text-ink-fg-2">加载详情…</div>
          ) : detail ? (
            <>
              {detail.rrule && (
                <Row label="重复规则">
                  <code className="text-meta font-mono text-ink-fg-2 break-all">
                    {detail.rrule}
                  </code>
                </Row>
              )}
              {detail.description && (
                <Row label="描述">
                  <div className="text-aux text-ink-fg-1 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {detail.description}
                  </div>
                </Row>
              )}
            </>
          ) : null}

          <div className="pt-3 border-t border-ink-border-soft text-meta text-ink-fg-3 font-mono">
            UID: {occurrence.ical_uid}
            <br />
            源: {occurrence.source}
            {occurrence.is_recurrence_instance && '  (RRULE 实例)'}
          </div>
        </div>
      </aside>
    </>
  )
}

interface RowProps {
  label: string
  icon?: React.ReactElement
  children: React.ReactNode
}
function Row({ label, icon, children }: RowProps): React.ReactElement {
  return (
    <div className="flex gap-3">
      <div className="w-20 shrink-0 text-meta text-ink-fg-2 inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
