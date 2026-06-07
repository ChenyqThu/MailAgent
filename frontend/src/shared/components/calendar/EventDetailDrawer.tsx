// 视觉复刻 mockup-calendar.html §EventDetailDrawer +
// Phase 2.5 §11.6 (mockup-calendar-ops.html) — RSVP vs owner ops 视觉分流.
//
// dw-head 加 .dw-role badge (owner/attendee); dw-foot 按 isOwner 二分:
//   - owner (organizer === user.email): 单行 [编辑.btn-op.edit] [删除.btn-op.delete]
//   - attendee: .rsvp-label + 3 .btn-rsvp + 第二行 disabled [编辑][删除] + .ops-note 🔒
//
// userEmail 走 mailApi.settings.get().userEmail (跟 Sidebar 同款 query
// key='settings').  normalize = lowercase + strip "mailto:" 跟 organizer 比.
//
// Phase 2.5 §11.2 — 删除流程改 undo toast: 关 drawer + push 到 calendar-undo
// store, 5s 内点 [撤销] 取消, 否则真发 CalDAV DELETE. 不再 window.confirm.

import {
  Check,
  Crown,
  ExternalLink,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Pencil,
  Trash2,
  User,
  Users,
  Video,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { EventFormModal } from './EventFormModal'
import { CALENDAR_EVENTS_KEY, useCalendarEvent } from './hooks/useCalendarEvents'
import { useMailApi } from '@shared/hooks/useMailApi'
import type {
  CalendarEventAttendee,
  CalendarEventOccurrence,
  CalendarEventSource,
  RsvpResponse
} from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { pad } from './lib/format'
import { useUndoToastStore } from '@shared/state/calendar-undo'
import { toastError, toastSuccess } from '@shared/state/toast'

// 与会者头像 — mockup 同色, 6 色循环按 index. 数据驱动的头像底色循环表，本就该以
// hex 字面量定义（非 UI token 滥用），规则豁免。
// eslint-disable-next-line mailagent/no-raw-hex
const ATT_HUES = ['#6FA8DC', '#B58CDB', '#E89B4A', '#5DBA8C', '#E5634F', '#DB5B7C']

interface Props {
  /** Null = 关闭抽屉. 抽屉永远 mount 走 CSS transition, occurrence 控制 .open. */
  occurrence: CalendarEventOccurrence | null
  onClose: () => void
  /** F5 — 5s undo 撤销时 reopen drawer (传 setActive(target) 复活选中事件).
   *  可选, 不传则撤销只显示 toast 不 reopen. */
  onReopen?: (occ: CalendarEventOccurrence) => void
}

// F32 — pad 抽到 ./lib/format

function formatRange(
  startIso: string,
  endIso: string,
  isAllDay: boolean,
  allDayLabel: string
): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const dateStr = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`
  if (isAllDay) {
    const days = Math.round((e.getTime() - s.getTime()) / 86400_000)
    return `${dateStr} ${allDayLabel}${days > 1 ? ` · 跨 ${days} 天` : ''}`
  }
  const t1 = `${pad(s.getHours())}:${pad(s.getMinutes())}`
  const t2 = `${pad(e.getHours())}:${pad(e.getMinutes())}`
  return `${dateStr}  ${t1} → ${t2}`
}

/** Normalize organizer/userEmail for case-insensitive compare; strips
 *  "mailto:" prefix CalDAV ICS 出 organizer 时常带. */
function normalizeEmail(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
}

/** F27 — runtime narrow ``occurrence.source`` (string) → CalendarEventSource.
 *  DB legacy v14 row 可能含未知 source 值, ``as CalendarEventSource`` 强转
 *  silent mismatch. 走 helper 白名单校验, 未知值 → undefined + 一次 warn.
 *  调用方传 undefined 给 CLI 让 ``SOURCES_TRY_ORDER`` 自动 fallback. */
const _VALID_SOURCES: ReadonlySet<string> = new Set(['caldav', 'email_ics', 'legacy_calendar_app'])
function narrowSource(s: string | null | undefined): CalendarEventSource | undefined {
  if (!s) return undefined
  if (_VALID_SOURCES.has(s)) return s as CalendarEventSource
  // eslint-disable-next-line no-console
  console.warn(`[calendar] unknown event source=${JSON.stringify(s)}, falling back`)
  return undefined
}

function RespBadge({ status }: { status: string }): React.ReactElement {
  const { t } = useTranslation()
  const RESP_MAP: Record<string, { cls: string; label: string }> = {
    ACCEPTED: { cls: 'resp-accepted', label: t('calendar.drawer.resp.accepted', '已接受') },
    TENTATIVE: { cls: 'resp-tentative', label: t('calendar.drawer.resp.tentative', '暂定') },
    DECLINED: { cls: 'resp-declined', label: t('calendar.drawer.resp.declined', '已拒绝') },
    'NEEDS-ACTION': { cls: 'resp-needs', label: t('calendar.drawer.resp.needsAction', '待回复') }
  }
  const s = (status || '').toUpperCase()
  const m = RESP_MAP[s] ?? { cls: 'resp-tentative', label: status || '—' }
  return <span className={`resp-badge ${m.cls}`}>{m.label}</span>
}

function attRespCls(r?: string): string {
  const ATT_RESP_CLS: Record<string, string> = {
    ACCEPTED: 'a',
    TENTATIVE: 't',
    DECLINED: 'd',
    'NEEDS-ACTION': 'n'
  }
  return ATT_RESP_CLS[(r || '').toUpperCase()] ?? 't'
}

function AttRow({
  attendee,
  hue
}: {
  attendee: CalendarEventAttendee
  hue: string
}): React.ReactElement {
  const { t } = useTranslation()
  const ATT_RESP_TXT: Record<string, string> = {
    ACCEPTED: t('calendar.drawer.resp.accepted', '已接受'),
    TENTATIVE: t('calendar.drawer.resp.tentative', '暂定'),
    DECLINED: t('calendar.drawer.resp.declined', '已拒绝'),
    'NEEDS-ACTION': t('calendar.drawer.resp.needsAction', '待回复')
  }
  function attRespTxt(r?: string): string {
    if (!r) return ''
    return ATT_RESP_TXT[r.toUpperCase()] ?? r
  }

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

export function EventDetailDrawer({ occurrence, onClose, onReopen }: Props): React.ReactElement {
  const { t } = useTranslation()
  const open = occurrence !== null
  const opts = occurrence
    ? {
        icalUid: occurrence.ical_uid,
        recurrenceId: occurrence.recurrence_id,
        source: narrowSource(occurrence.source)
      }
    : null
  const { data: detail, isLoading } = useCalendarEvent(opts)

  const mailApi = useMailApi()
  const qc = useQueryClient()

  // Phase 2.5 §11.6 — userEmail 用于判 isOwner. 跟 Sidebar 同 query key,
  // react-query 缓存 share, settings 不会因 drawer 反复重拉.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    staleTime: 5 * 60_000
  })
  const userEmail = settings?.userEmail ?? null
  const isOwner = !!(
    occurrence &&
    userEmail &&
    normalizeEmail(occurrence.organizer) === normalizeEmail(userEmail)
  )

  // Phase 2.1 — RSVP mutation. 走 mailApi.calendar.eventRsvp → DavMail SMTP
  // submission → Outlook Calendar Assistant 异步更新 organizer 端 PARTSTAT.
  const rsvpMut = useMutation({
    mutationFn: (response: RsvpResponse) => {
      if (!occurrence) throw new Error('no occurrence selected')
      return mailApi.calendar.eventRsvp({
        icalUid: occurrence.ical_uid,
        response,
        recurrenceId: occurrence.recurrence_id,
        source: narrowSource(occurrence.source)
      })
    },
    onSuccess: (_d, response) => {
      const toastMap: Record<RsvpResponse, string> = {
        accept: t('calendar.drawer.rsvp.toastAccepted', 'RSVP 已接受 已发送给组织者'),
        tentative: t('calendar.drawer.rsvp.toastTentative', 'RSVP 暂定 已发送给组织者'),
        decline: t('calendar.drawer.rsvp.toastDeclined', 'RSVP 已拒绝 已发送给组织者')
      }
      toastSuccess(toastMap[response])
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: ['calendar', 'event'] })
    },
    onError: (err: unknown, response) => {
      const e = err as Error
      toastError(
        t('calendar.drawer.rsvp.toastErr', '发送 RSVP ({response}) 失败', { response }),
        e.message || t('calendar.toolbar.syncTipUnknownErr', '未知错误')
      )
    }
  })

  const handleRsvp = (response: RsvpResponse): void => {
    if (!occurrence) return
    const actionLabels: Record<RsvpResponse, string> = {
      accept: t('calendar.drawer.rsvp.accept', '接受'),
      tentative: t('calendar.drawer.rsvp.tentative', '暂定'),
      decline: t('calendar.drawer.rsvp.decline', '拒绝')
    }
    const organizer = normalizeEmail(occurrence.organizer)
    const ok = window.confirm(
      t(
        'calendar.drawer.rsvp.confirmBody',
        '此操作会通过 DavMail SMTP 立即发邮件给组织者, 不可撤销.\n\n事件: {summary}\n组织者: {organizer}',
        {
          summary: occurrence.summary || t('calendar.shared.untitled', '未命名事件'),
          organizer: organizer || '(未知)'
        }
      )
    )
    if (!ok) return
    rsvpMut.mutate(response)
    void actionLabels
  }

  // Phase 2.5 §11.2 — 删除流程: 关 drawer + push 到 calendar-undo store,
  // 5s 后真发 CalDAV DELETE. 不再 window.confirm.
  const pushUndo = useUndoToastStore((s) => s.push)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const deleteMut = useMutation({
    mutationFn: (icalUid: string) => mailApi.calendar.eventDelete({ icalUid }),
    onSuccess: () => {
      // toast 已经在 undo stack 走过 commit 流程, 这里只 invalidate
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: ['calendar', 'event'] })
    },
    onError: (err: unknown) => {
      const e = err as Error
      toastError(
        t('calendar.undo.deleteFailed', '删除事件失败'),
        e.message || t('calendar.toolbar.syncTipUnknownErr', '未知错误')
      )
    }
  })

  const handleDelete = (): void => {
    if (!occurrence) return
    // capture 当前 occurrence 到 closure, 避免后续 drawer 重选别的事件错改 UID
    const target = occurrence
    const summaryShort = (target.summary || t('calendar.shared.untitled', '未命名事件')).slice(
      0,
      30
    )
    onClose()
    pushUndo({
      title: t('calendar.undo.deleted', '已删除「{title}」', { title: summaryShort }),
      subtitle: t('calendar.undo.deletedSubtitle', '5 秒后同步到 CalDAV'),
      durationMs: 5000,
      onCommit: () => deleteMut.mutate(target.ical_uid),
      onUndo: () => {
        // F5 — drawer 已挂在 Layout 层 (单 mount), reopen 走 onReopen
        // callback 让 Layout setActive(target) 复活选中. 未传 onReopen
        // (CLI / 测试) 时降级仅 toast.
        if (onReopen) onReopen(target)
        toastSuccess(t('calendar.undo.restored', '已恢复 (未提交删除)'))
      }
    })
  }

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
    occurrence?.url || occurrence?.location?.toLowerCase().includes('teams.microsoft.com')
  )

  // 当前 response_status (用于 RSVP button .sel 高亮 + label "待回复" 提示)
  const myResp = (occurrence?.response_status || '').toUpperCase()
  const isNeedsAction = myResp === 'NEEDS-ACTION'

  const allDayLabel = t('calendar.shared.allDay', '全天')

  return (
    <>
      <div className={cn('drawer-backdrop', open && 'open')} onClick={onClose} aria-hidden />
      <aside
        className={cn('drawer', open && 'open')}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-label={occurrence?.summary || t('calendar.drawer.ariaFallback', '事件详情')}
      >
        {occurrence && (
          <>
            <div className="dw-head">
              <span className="dw-accent" aria-hidden />
              <div className="flex-1 min-w-0">
                {/* §11.6 — 角色 badge: 组织者 / 与会者 */}
                <span className={cn('dw-role', isOwner ? 'owner' : 'attendee')}>
                  {isOwner ? (
                    <>
                      <Crown size={10} strokeWidth={2.2} />
                      {t('calendar.drawer.role.owner', '组织者')}
                    </>
                  ) : (
                    <>
                      <User size={10} strokeWidth={2.2} />
                      {t('calendar.drawer.role.attendee', '与会者')}
                    </>
                  )}
                </span>
                <h2 className="dw-title">
                  {occurrence.summary || (
                    <span className="empty-field">
                      {t('calendar.shared.untitled', '未命名事件')}
                    </span>
                  )}
                </h2>
              </div>
              <button
                type="button"
                className="dw-close"
                onClick={onClose}
                title={t('calendar.drawer.closeTitle', '关闭 (Esc)')}
                aria-label={t('calendar.shared.closeAria', '关闭')}
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="dw-body scrollbar-thin">
              <MetaRow label={t('calendar.drawer.meta.time', '时间')}>
                <span className="meta-v mono">
                  {formatRange(
                    occurrence.occurrence_start_iso,
                    occurrence.occurrence_end_iso,
                    occurrence.is_all_day,
                    allDayLabel
                  )}
                </span>
              </MetaRow>

              {occurrence.calendar_name && (
                <MetaRow label={t('calendar.drawer.meta.calendar', '日历')}>
                  <span>{occurrence.calendar_name}</span>
                </MetaRow>
              )}

              <MetaRow
                icon={<MapPin size={13} strokeWidth={2} />}
                label={t('calendar.drawer.meta.location', '地点')}
              >
                {occurrence.location ? (
                  <span className="break-all">{occurrence.location}</span>
                ) : (
                  <span className="empty-field">—</span>
                )}
              </MetaRow>

              {occurrence.organizer && (
                <MetaRow
                  icon={<User size={13} strokeWidth={2} />}
                  label={t('calendar.drawer.meta.organizer', '组织者')}
                >
                  <span className="meta-v mono">
                    {occurrence.organizer}
                    {isOwner && (
                      <span className="empty-field" style={{ fontStyle: 'normal', marginLeft: 6 }}>
                        {t('calendar.drawer.me', '(我)')}
                      </span>
                    )}
                  </span>
                </MetaRow>
              )}

              {occurrence.attendees && occurrence.attendees.length > 0 && (
                <MetaRow
                  icon={<Users size={13} strokeWidth={2} />}
                  label={t('calendar.drawer.meta.attendees', '与会者')}
                >
                  <div>
                    {t('calendar.drawer.attendeeCount', '{n} 人', {
                      n: occurrence.attendees.length
                    })}
                  </div>
                  <div className="mt-1.5">
                    {occurrence.attendees.slice(0, 12).map((a, i) => (
                      <AttRow key={i} attendee={a} hue={ATT_HUES[i % ATT_HUES.length]} />
                    ))}
                    {occurrence.attendees.length > 12 && (
                      <div className="att-row text-[11px] text-ink-fg-2">
                        {t('calendar.drawer.moreAttendees', '… 还有 {n} 位', {
                          n: occurrence.attendees.length - 12
                        })}
                      </div>
                    )}
                  </div>
                </MetaRow>
              )}

              {occurrence.response_status && !isOwner && (
                <MetaRow label={t('calendar.drawer.meta.myResponse', '我的回复')}>
                  <RespBadge status={occurrence.response_status} />
                </MetaRow>
              )}

              {hasMeeting && (
                <MetaRow
                  icon={<Video size={13} strokeWidth={2} />}
                  label={t('calendar.drawer.meta.meetingLink', '会议链接')}
                >
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
                      <span className="text-aux">
                        {t('calendar.drawer.teamsMeeting', 'Teams 会议')}
                      </span>
                    </span>
                  )}
                </MetaRow>
              )}

              <MetaRow
                icon={<Mail size={13} strokeWidth={2} />}
                label={t('calendar.drawer.meta.relatedEmail', '关联邮件')}
              >
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
                  <span className="empty-field">
                    {t('calendar.drawer.noRelatedEmail', '无关联邮件')}
                  </span>
                )}
              </MetaRow>

              {isLoading ? (
                <MetaRow label={t('calendar.drawer.meta.rrule', '重复规则')}>
                  <span className="skel" style={{ width: '70%' }} />
                </MetaRow>
              ) : detail?.rrule ? (
                <MetaRow label={t('calendar.drawer.meta.rrule', '重复规则')}>
                  <code className="rrule-code">{detail.rrule}</code>
                </MetaRow>
              ) : null}

              {isLoading ? (
                <MetaRow label={t('calendar.drawer.meta.description', '描述')}>
                  <span className="skel" style={{ width: '88%' }} />
                  <span className="skel" style={{ width: '70%' }} />
                </MetaRow>
              ) : detail?.description ? (
                <MetaRow label={t('calendar.drawer.meta.description', '描述')}>
                  <div className="desc-box scrollbar-thin">{detail.description}</div>
                </MetaRow>
              ) : null}
            </div>

            {/* ═══ Phase 2.5 §11.6 — dw-foot RSVP vs owner 分流 ═══ */}
            <div className="dw-foot">
              {isOwner ? (
                /* owner: 单行 [编辑.btn-op.edit] [删除.btn-op.delete] */
                <div className="owner-ops-row">
                  <button
                    type="button"
                    className="btn-op edit"
                    onClick={() => setEditModalOpen(true)}
                    title={t(
                      'calendar.drawer.ops.editTitle',
                      '编辑事件 — 通过 CalDAV PUT 改 Exchange 端'
                    )}
                  >
                    <Pencil size={13} strokeWidth={2} />
                    {t('calendar.drawer.ops.edit', '编辑')}
                  </button>
                  <button
                    type="button"
                    className="btn-op delete"
                    onClick={handleDelete}
                    title={t(
                      'calendar.drawer.ops.deleteTitle',
                      '删除事件 — 5 秒撤销窗口后通过 CalDAV DELETE'
                    )}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    {t('calendar.drawer.ops.delete', '删除')}
                  </button>
                </div>
              ) : (
                /* attendee: RSVP 高亮 + 第二行 disabled owner ops + 🔒 note */
                <>
                  <div className="rsvp-label">
                    <Check size={11} strokeWidth={2} />
                    {t('calendar.drawer.rsvp.label', '我的回复')}
                    {isNeedsAction ? ' ' + t('calendar.drawer.rsvp.labelPending', '· 待回复') : ''}
                  </div>
                  <div className="rsvp-row">
                    <button
                      type="button"
                      className={cn('btn-rsvp', myResp === 'ACCEPTED' && 'sel')}
                      disabled={rsvpMut.isPending}
                      onClick={() => handleRsvp('accept')}
                      title={t(
                        'calendar.drawer.rsvp.acceptTitle',
                        '接受邀请 — 发 iTIP REPLY (PARTSTAT=ACCEPTED) 给组织者'
                      )}
                    >
                      {rsvpMut.isPending && rsvpMut.variables === 'accept' ? (
                        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                      ) : (
                        <Check size={13} strokeWidth={2} />
                      )}
                      {t('calendar.drawer.rsvp.accept', '接受')}
                    </button>
                    <button
                      type="button"
                      className={cn('btn-rsvp', myResp === 'TENTATIVE' && 'sel')}
                      disabled={rsvpMut.isPending}
                      onClick={() => handleRsvp('tentative')}
                      title={t(
                        'calendar.drawer.rsvp.tentativeTitle',
                        '暂定 — 发 iTIP REPLY (PARTSTAT=TENTATIVE) 给组织者'
                      )}
                    >
                      {rsvpMut.isPending && rsvpMut.variables === 'tentative' && (
                        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                      )}
                      {t('calendar.drawer.rsvp.tentative', '暂定')}
                    </button>
                    <button
                      type="button"
                      className={cn('btn-rsvp', myResp === 'DECLINED' && 'sel')}
                      disabled={rsvpMut.isPending}
                      onClick={() => handleRsvp('decline')}
                      title={t(
                        'calendar.drawer.rsvp.declineTitle',
                        '拒绝邀请 — 发 iTIP REPLY (PARTSTAT=DECLINED) 给组织者'
                      )}
                    >
                      {rsvpMut.isPending && rsvpMut.variables === 'decline' && (
                        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                      )}
                      {t('calendar.drawer.rsvp.decline', '拒绝')}
                    </button>
                  </div>
                  <div className="owner-ops-row secondary">
                    <button
                      type="button"
                      className="btn-op"
                      disabled
                      title={t('calendar.drawer.ops.ownerOnly', '只能由组织者修改')}
                    >
                      <Pencil size={13} strokeWidth={2} />
                      {t('calendar.drawer.ops.edit', '编辑')}
                    </button>
                    <button
                      type="button"
                      className="btn-op"
                      disabled
                      title={t('calendar.drawer.ops.ownerOnly', '只能由组织者修改')}
                    >
                      <Trash2 size={13} strokeWidth={2} />
                      {t('calendar.drawer.ops.delete', '删除')}
                    </button>
                  </div>
                  <div className="ops-note">
                    <Lock size={11} strokeWidth={2} />
                    {t('calendar.drawer.ops.ownerOnly', '只能由组织者修改')}
                  </div>
                </>
              )}

              <div className="fm">
                UID: {occurrence.ical_uid}
                <br />
                源: {occurrence.source}
                {occurrence.is_recurrence_instance &&
                  ' · ' + t('calendar.drawer.rruleInstance', 'RRULE 实例')}
              </div>
            </div>
          </>
        )}
      </aside>

      {/* Phase 2.3 — edit modal (occurrence 预填 = edit 语义) */}
      <EventFormModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        occurrence={editModalOpen ? occurrence : null}
      />
    </>
  )
}
