// 视觉复刻 mockup-calendar.html §EventDetailDrawer (2026-05-23) —
// 右侧 slide-in 抽屉 (.drawer + .drawer-backdrop). 接口不变 (occurrence /
// onClose). instant fields 从 occurrence 直读, lazy fields (description /
// rrule) 等 useCalendarEvent fetch — 加载时占位 .skel shimmer.
//
// dw-foot 的 [接受/暂定/拒绝] 按钮在 Phase 2 写能力上线前一律 disabled
// (cursor:not-allowed), 视觉上提示 "stub".

import { Check, ExternalLink, Mail, MapPin, User, Users, Video, X } from 'lucide-react'
import { useEffect } from 'react'

import { useCalendarEvent } from './hooks/useCalendarEvents'
import type {
  CalendarEventAttendee,
  CalendarEventOccurrence,
  CalendarEventSource
} from '@shared/api/types'
import { cn } from '@shared/lib/cn'

// 与会者头像 — mockup 同色, 6 色循环按 index.
const ATT_HUES = ['#6FA8DC', '#B58CDB', '#E89B4A', '#5DBA8C', '#E5634F', '#DB5B7C']

interface Props {
  /** Null = 关闭抽屉. 抽屉永远 mount 走 CSS transition, occurrence 控制 .open. */
  occurrence: CalendarEventOccurrence | null
  onClose: () => void
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatRange(startIso: string, endIso: string, isAllDay: boolean): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const dateStr = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`
  if (isAllDay) {
    const days = Math.round((e.getTime() - s.getTime()) / 86400_000)
    return `${dateStr} 全天${days > 1 ? ` · 跨 ${days} 天` : ''}`
  }
  const t1 = `${pad(s.getHours())}:${pad(s.getMinutes())}`
  const t2 = `${pad(e.getHours())}:${pad(e.getMinutes())}`
  return `${dateStr}  ${t1} → ${t2}`
}

const RESP_MAP: Record<string, { cls: string; label: string }> = {
  ACCEPTED: { cls: 'resp-accepted', label: '已接受' },
  TENTATIVE: { cls: 'resp-tentative', label: '暂定' },
  DECLINED: { cls: 'resp-declined', label: '已拒绝' },
  'NEEDS-ACTION': { cls: 'resp-needs', label: '待回复' }
}

function RespBadge({ status }: { status: string }): React.ReactElement {
  const s = (status || '').toUpperCase()
  const m = RESP_MAP[s] ?? { cls: 'resp-tentative', label: status || '—' }
  return <span className={`resp-badge ${m.cls}`}>{m.label}</span>
}

const ATT_RESP_CLS: Record<string, string> = {
  ACCEPTED: 'a',
  TENTATIVE: 't',
  DECLINED: 'd',
  'NEEDS-ACTION': 'n'
}
const ATT_RESP_TXT: Record<string, string> = {
  ACCEPTED: '已接受',
  TENTATIVE: '暂定',
  DECLINED: '已拒绝',
  'NEEDS-ACTION': '待回复'
}

function attRespCls(r?: string): string {
  return ATT_RESP_CLS[(r || '').toUpperCase()] ?? 't'
}
function attRespTxt(r?: string): string {
  if (!r) return ''
  return ATT_RESP_TXT[r.toUpperCase()] ?? r
}

function AttRow({
  attendee,
  hue
}: {
  attendee: CalendarEventAttendee
  hue: string
}): React.ReactElement {
  const name = attendee.name || attendee.email
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return (
    <div className="att-row">
      <span className="att-avatar" style={{ background: hue }} aria-hidden>
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="att-name truncate">{name}</div>
        {attendee.name && attendee.email !== attendee.name && (
          <div className="att-email truncate">{attendee.email}</div>
        )}
      </div>
      {attendee.response && (
        <span className={`att-resp ${attRespCls(attendee.response)}`}>
          {attRespTxt(attendee.response)}
        </span>
      )}
    </div>
  )
}

interface MetaRowProps {
  icon?: React.ReactNode
  label: string
  children: React.ReactNode
}
function MetaRow({ icon, label, children }: MetaRowProps): React.ReactElement {
  return (
    <div className="meta-row">
      <div className="meta-k">
        {icon && (
          <span className="text-ink-fg-3" aria-hidden>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className="meta-v">{children}</div>
    </div>
  )
}

export function EventDetailDrawer({ occurrence, onClose }: Props): React.ReactElement {
  const open = occurrence !== null
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
    if (!open) return
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  const hasMeeting = !!(
    occurrence?.url ||
    occurrence?.location?.toLowerCase().includes('teams.microsoft.com')
  )

  return (
    <>
      <div
        className={cn('drawer-backdrop', open && 'open')}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={cn('drawer', open && 'open')}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-label={occurrence?.summary || '事件详情'}
      >
        {occurrence && (
          <>
            <div className="dw-head">
              <span className="dw-accent" aria-hidden />
              <h2 className="dw-title">{occurrence.summary || '(无标题)'}</h2>
              <button
                type="button"
                className="dw-close"
                onClick={onClose}
                title="关闭 (Esc)"
                aria-label="关闭"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="dw-body scrollbar-thin">
              <MetaRow label="时间">
                <span className="meta-v mono">
                  {formatRange(
                    occurrence.occurrence_start_iso,
                    occurrence.occurrence_end_iso,
                    occurrence.is_all_day
                  )}
                </span>
              </MetaRow>

              {occurrence.calendar_name && (
                <MetaRow label="日历">
                  <span>{occurrence.calendar_name}</span>
                </MetaRow>
              )}

              <MetaRow icon={<MapPin size={13} strokeWidth={2} />} label="地点">
                {occurrence.location ? (
                  <span className="break-all">{occurrence.location}</span>
                ) : (
                  <span className="empty-field">—</span>
                )}
              </MetaRow>

              {occurrence.organizer && (
                <MetaRow icon={<User size={13} strokeWidth={2} />} label="组织者">
                  <span className="meta-v mono">{occurrence.organizer}</span>
                </MetaRow>
              )}

              {occurrence.attendees && occurrence.attendees.length > 0 && (
                <MetaRow icon={<Users size={13} strokeWidth={2} />} label="与会者">
                  <div>{occurrence.attendees.length} 人</div>
                  <div className="mt-1.5">
                    {occurrence.attendees.slice(0, 12).map((a, i) => (
                      <AttRow key={i} attendee={a} hue={ATT_HUES[i % ATT_HUES.length]} />
                    ))}
                    {occurrence.attendees.length > 12 && (
                      <div className="att-row text-[11px] text-ink-fg-2">
                        … 还有 {occurrence.attendees.length - 12} 位
                      </div>
                    )}
                  </div>
                </MetaRow>
              )}

              {occurrence.response_status && (
                <MetaRow label="我的回复">
                  <RespBadge status={occurrence.response_status} />
                </MetaRow>
              )}

              {hasMeeting && (
                <MetaRow icon={<Video size={13} strokeWidth={2} />} label="会议链接">
                  {occurrence.url ? (
                    <a
                      href={occurrence.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link-row"
                    >
                      <span className="font-mono text-[12px] break-all">
                        {occurrence.url.length > 60
                          ? occurrence.url.slice(0, 60) + '…'
                          : occurrence.url}
                      </span>
                      <ExternalLink size={11} strokeWidth={2} />
                    </a>
                  ) : (
                    <span className="link-row">
                      <Video size={11} strokeWidth={2} />
                      <span className="text-aux">Teams 会议</span>
                    </span>
                  )}
                </MetaRow>
              )}

              <MetaRow icon={<Mail size={13} strokeWidth={2} />} label="关联邮件">
                {occurrence.related_email_internal_id ? (
                  <a
                    className="link-row"
                    href={`/?internal_id=${occurrence.related_email_internal_id}`}
                    title="跳到 inbox 选中该邮件"
                  >
                    #{occurrence.related_email_internal_id}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                ) : (
                  <span className="empty-field">无关联邮件</span>
                )}
              </MetaRow>

              {/* lazy: RRULE — instant if occurrence is RRULE instance, but raw
                * rule 在 detail 里. 加载时 skel placeholder. */}
              {isLoading ? (
                <MetaRow label="重复规则">
                  <span className="skel" style={{ width: '70%' }} />
                </MetaRow>
              ) : detail?.rrule ? (
                <MetaRow label="重复规则">
                  <code className="rrule-code">{detail.rrule}</code>
                </MetaRow>
              ) : null}

              {/* lazy: 描述 */}
              {isLoading ? (
                <MetaRow label="描述">
                  <span className="skel" style={{ width: '88%' }} />
                  <span className="skel" style={{ width: '70%' }} />
                </MetaRow>
              ) : detail?.description ? (
                <MetaRow label="描述">
                  <div className="desc-box scrollbar-thin">{detail.description}</div>
                </MetaRow>
              ) : null}
            </div>

            <div className="dw-foot">
              <div className="dw-actions" title="Phase 2 — RSVP 写能力尚未上线">
                <span className="dw-act">
                  <Check size={13} strokeWidth={2} /> 接受
                </span>
                <span className="dw-act">暂定</span>
                <span className="dw-act">拒绝</span>
              </div>
              <div className="fm">
                UID: {occurrence.ical_uid}
                <br />
                源: {occurrence.source}
                {occurrence.is_recurrence_instance && ' · RRULE 实例'}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
