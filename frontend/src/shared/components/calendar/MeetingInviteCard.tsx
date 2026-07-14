// 阶段 2.2 (UX-P0①) — 邮件详情会议邀请卡片 (Outlook 邀请卡模板答案)。
//
// 挂在 EmailDetail meta 区下方: emailCalendarLink (2.1 ical_uid 数据桥) 命中才
// 渲染, null(非会议)/加载中/错误全部静默 —— 该反查是前端会议判定唯一来源。
// 信息架构: 头部 (邀请/已取消 + 周期/本次例外 badge + 当日冲突 chip) → 行区
// (时间/地点/组织者/与会人 +N 折叠) → 脚部 (RSVP 三键 D1 恒确认卡 + 在日历中查看)。
//
// method 语义: REQUEST/null=正常邀请; CANCEL=已取消态 (无 RSVP 键);
// link.recurrence_id 非空 = override 邀请 (标「本次例外」)。
// in_calendar=false → RSVP 三键禁用 + 「尚未同步到日历」提示。
// IS_WEB_BUILD → 隐藏 RSVP 三键 (HttpApi eventRsvp 是 stub), 信息区保留。
//
// 组件放 calendar/ 目录 (而非 email/): RSVP/冲突/能力门控/类型全是日历域,
// EmailDetail 只是挂载点; cal- 前缀样式与日历面同族, 便于后续与 drawer 收敛。

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  CalendarClock,
  CalendarX2,
  Check,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  MapPin,
  User,
  Users
} from 'lucide-react'

import { IS_WEB_BUILD } from './lib/capabilities'
import { pad } from './lib/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useCalendarFocus } from '@shared/state/calendar-focus'
import type { CalendarEventSource, EmailCalendarLink, RsvpResponse } from '@shared/api/types'

interface Props {
  internalId: number
}

/** 待收敛 — 与 EventDetailDrawer.narrowSource 同款 (drawer 未导出且属他 lane
 *  改动面, 阶段 2 收尾抽 shared helper)。未知 source → undefined 让 CLI
 *  SOURCES_TRY_ORDER 自动 fallback. */
const _VALID_SOURCES: ReadonlySet<string> = new Set(['caldav', 'email_ics', 'legacy_calendar_app'])
function narrowSource(s: string | null | undefined): CalendarEventSource | undefined {
  if (!s) return undefined
  if (_VALID_SOURCES.has(s)) return s as CalendarEventSource
  console.warn(`[calendar] unknown event source=${JSON.stringify(s)}, falling back`)
  return undefined
}

/** 待收敛 — 与 EventDetailDrawer.normalizeEmail 同款: 去 "mailto:" + lowercase. */
function normalizeEmail(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
}

interface OccWindow {
  startIso: string
  endIso: string
  isAllDay: boolean
}

/** 邀请指向的 occurrence 起止窗。override 邀请 (link.recurrence_id 非空):
 *  event 行本身就是 detached 行时直接用其时间; event 是 master (caldav 代表行
 *  优先) 时用 recurrence_id (目标次原始 dtstart) + master duration 推算。
 *  其余 (单次/整系列邀请) 用 master dtstart/dtend —— 周期系列显示首次。 */
function deriveOccWindow(link: EmailCalendarLink): OccWindow | null {
  const ev = link.event
  if (!ev?.dtstart_iso || !ev.dtend_iso) return null
  const base = { startIso: ev.dtstart_iso, endIso: ev.dtend_iso, isAllDay: ev.is_all_day }
  if (!link.recurrence_id || ev.recurrence_id === link.recurrence_id) return base
  const target = Date.parse(link.recurrence_id)
  const dur = Date.parse(ev.dtend_iso) - Date.parse(ev.dtstart_iso)
  if (!Number.isFinite(target) || !Number.isFinite(dur)) return base
  return {
    startIso: new Date(target).toISOString(),
    endIso: new Date(target + Math.max(dur, 0)).toISOString(),
    isAllDay: ev.is_all_day
  }
}

/** 时间行 — 复用 drawer formatRange 的全天/跨天语义 (drawer 未导出), 并补
 *  跨午夜 timed 事件的双日期显示 (drawer 场景 occurrence 已按日切分, 这里没有). */
function formatInviteRange(
  t: TFunction,
  startIso: string,
  endIso: string,
  isAllDay: boolean
): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const d1 = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`
  if (isAllDay) {
    const allDayLabel = t('calendar.shared.allDay', '全天')
    const days = Math.round((e.getTime() - s.getTime()) / 86400_000)
    const span = days > 1 ? ` ${t('calendar.drawer.spanDays', '· 跨 {n} 天', { n: days })}` : ''
    return `${d1} ${allDayLabel}${span}`
  }
  const t1 = `${pad(s.getHours())}:${pad(s.getMinutes())}`
  const t2 = `${pad(e.getHours())}:${pad(e.getMinutes())}`
  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate()
  if (sameDay) return `${d1}  ${t1} → ${t2}`
  const d2 = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`
  return `${d1} ${t1} → ${d2} ${t2}`
}

export function MeetingInviteCard({ internalId }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const navigate = useNavigate()

  // 会议判定 + 卡片数据 — null(非会议)/error 都不渲染 (retry:false 免非会议
  // 邮件反复打 IPC)。60s staleTime 对齐 calendar 族其余查询。
  const linkQ = useQuery({
    queryKey: qk.calendar.emailLink(internalId),
    queryFn: () => mailApi.calendar.emailCalendarLink(internalId),
    staleTime: 60_000,
    retry: false
  })
  const link = linkQ.data ?? null
  const event = link?.event ?? null
  const isCancelled =
    (link?.method ?? '').toUpperCase() === 'CANCEL' ||
    (event?.status ?? '').toUpperCase() === 'CANCELLED'

  const occWindow = useMemo(() => (link ? deriveOccWindow(link) : null), [link])

  // 当日冲突 chip — 以邀请起止窗查 occurrences (eventsList 返回窗口重叠项),
  // 排除自身 uid 与已取消事件, 前端再做一次严格 overlap 复核。
  const conflictQ = useQuery({
    queryKey: qk.calendar.inviteConflicts(occWindow?.startIso ?? '', occWindow?.endIso ?? ''),
    queryFn: () =>
      mailApi.calendar.eventsList({ fromIso: occWindow!.startIso, toIso: occWindow!.endIso }),
    enabled: !!occWindow && !isCancelled,
    staleTime: 60_000
  })
  const conflictCount = useMemo((): number | null => {
    if (!conflictQ.data || !link || !occWindow) return null
    const s = Date.parse(occWindow.startIso)
    const e = Date.parse(occWindow.endIso)
    return conflictQ.data.filter(
      (o) =>
        o.ical_uid !== link.ical_uid &&
        (o.status || '').toUpperCase() !== 'CANCELLED' &&
        Date.parse(o.occurrence_start_iso) < e &&
        Date.parse(o.occurrence_end_iso) > s
    ).length
  }, [conflictQ.data, link, occWindow])

  // RSVP — 与 drawer rsvpMut 同款: DavMail SMTP iTIP REPLY → organizer。
  // toast/确认卡文案复用 calendar.drawer.rsvp.* 单源, 保证双入口逐字一致。
  const rsvpMut = useMutation({
    mutationFn: (response: RsvpResponse) => {
      if (!link) throw new Error('no meeting link')
      return mailApi.calendar.eventRsvp({
        icalUid: link.ical_uid,
        response,
        recurrenceId: link.recurrence_id,
        source: narrowSource(event?.source)
      })
    },
    onSuccess: (_d, response) => {
      const toastMap: Record<RsvpResponse, string> = {
        accept: t('calendar.drawer.rsvp.toastAccepted', 'RSVP 已接受 已发送给组织者'),
        tentative: t('calendar.drawer.rsvp.toastTentative', 'RSVP 暂定 已发送给组织者'),
        decline: t('calendar.drawer.rsvp.toastDeclined', 'RSVP 已拒绝 已发送给组织者')
      }
      toastSuccess(toastMap[response])
      void qc.invalidateQueries({ queryKey: qk.calendar.events() })
      void qc.invalidateQueries({ queryKey: qk.calendar.event() })
      void qc.invalidateQueries({ queryKey: qk.calendar.emailLink(internalId) })
    },
    onError: (err: unknown, response) => {
      const e = err as Error
      toastError(
        t('calendar.drawer.rsvp.toastErr', '发送 RSVP ({response}) 失败', { response }),
        e.message || t('calendar.toolbar.syncTipUnknownErr', '未知错误')
      )
    }
  })

  // 待收敛 — RSVP 确认卡 (D1 拍板恒确认) 与 EventDetailDrawer 1.5 内嵌实现同款:
  // drawer 版是其文件内私有 JSX 且属他 lane 改动面, 抽共享组件留给主 session
  // 阶段 2 收尾; 此处内嵌同款 (开合 state + useExitAnimation + Esc capture)。
  const [pendingRsvp, setPendingRsvp] = useState<RsvpResponse | null>(null)
  const [rsvpDialogOpen, setRsvpDialogOpen] = useState(false)
  const { shouldRender: rsvpDlgRender, scopeRef: rsvpDlgRef } = useExitAnimation<HTMLDivElement>(
    rsvpDialogOpen,
    { card: '[data-anim-card]' }
  )
  const rsvpActionLabels: Record<RsvpResponse, string> = {
    accept: t('calendar.drawer.rsvp.accept', '接受'),
    tentative: t('calendar.drawer.rsvp.tentative', '暂定'),
    decline: t('calendar.drawer.rsvp.decline', '拒绝')
  }

  // 确认卡开着时 capture 期拦 Esc 只关卡 — 不让 EmailDetail 面的全局 keydown
  // 消费者 (快捷键/compose) 收到本次 Esc。
  useEffect(() => {
    if (!rsvpDialogOpen) return
    const handle = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setRsvpDialogOpen(false)
    }
    window.addEventListener('keydown', handle, true)
    return () => window.removeEventListener('keydown', handle, true)
  }, [rsvpDialogOpen])

  if (!link) return null

  const myResp = (event?.response_status || '').toUpperCase()
  const canRsvp = link.in_calendar && !!event
  const attNames = (event?.attendees ?? []).map((a) => a.name || a.email).filter(Boolean)

  const handleRsvp = (response: RsvpResponse): void => {
    setPendingRsvp(response)
    setRsvpDialogOpen(true)
  }

  // 「在日历中查看」— 应用内导航到日历面 (F13 教训: 禁 <a href> 真导航)。
  // 定位深度: pending focus (日期+uid) 写入 calendar-focus store, Layout 读侧
  // 接线后可达日期定位 + setActive; 未接线前达到"切到日历面 (day 视图)"。
  const handleViewInCalendar = (): void => {
    if (occWindow) {
      useCalendarFocus.getState().request({
        dateIso: occWindow.startIso,
        icalUid: link.ical_uid,
        recurrenceId: link.recurrence_id
      })
    }
    void navigate({ to: '/admin/calendar', search: { view: 'today' } })
  }

  return (
    <>
      <section
        className="cal-invite"
        data-cancelled={isCancelled || undefined}
        aria-label={t('calendar.invite.title', '会议邀请')}
      >
        <div className="cal-invite-head">
          {isCancelled ? (
            <CalendarX2 size={15} strokeWidth={2} />
          ) : (
            <CalendarClock size={15} strokeWidth={2} />
          )}
          <span className="cal-invite-title">
            {isCancelled
              ? t('calendar.invite.cancelled', '会议已取消')
              : t('calendar.invite.title', '会议邀请')}
          </span>
          {link.is_recurring && (
            <span className="cal-invite-badge">
              {t('calendar.invite.recurringBadge', '周期会议')}
            </span>
          )}
          {link.recurrence_id && (
            <span className="cal-invite-badge">
              {t('calendar.invite.exceptionBadge', '本次例外')}
            </span>
          )}
          {!isCancelled && conflictCount !== null && (
            <span className="cal-invite-chip" data-tone={conflictCount > 0 ? 'warn' : 'ok'}>
              {conflictCount > 0
                ? t('calendar.invite.conflictCount', '与 {n} 场日程重叠', { n: conflictCount })
                : t('calendar.invite.conflictNone', '无冲突')}
            </span>
          )}
        </div>

        {(occWindow || event) && (
          <div className="cal-invite-rows">
            {occWindow && (
              <div className="cal-invite-row">
                <Clock size={13} strokeWidth={2} />
                <span className="cal-invite-time">
                  {formatInviteRange(t, occWindow.startIso, occWindow.endIso, occWindow.isAllDay)}
                </span>
              </div>
            )}
            {event?.location && (
              <div className="cal-invite-row">
                <MapPin size={13} strokeWidth={2} />
                <span className="break-words">{event.location}</span>
              </div>
            )}
            {event?.organizer && (
              <div className="cal-invite-row">
                <User size={13} strokeWidth={2} />
                <span className="cal-invite-mono break-all">{normalizeEmail(event.organizer)}</span>
              </div>
            )}
            {attNames.length > 0 && (
              <div className="cal-invite-row">
                <Users size={13} strokeWidth={2} />
                <span>
                  {t('calendar.drawer.attendeeCount', '{n} 人', { n: attNames.length })}
                  <span className="cal-invite-attnames">
                    {' · '}
                    {attNames.slice(0, 3).join('、')}
                    {attNames.length > 3 ? ` +${attNames.length - 3}` : ''}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        <div className="cal-invite-foot">
          {/* F14/Q9 — 远程 web 隐藏 RSVP 三键 (HttpApi eventRsvp stub), 阶段 3 能力表替换 */}
          {!isCancelled && !IS_WEB_BUILD && (
            <>
              <div className="cal-invite-rsvp">
                <button
                  type="button"
                  className={cn('btn-rsvp', myResp === 'ACCEPTED' && 'sel')}
                  disabled={!canRsvp || rsvpMut.isPending}
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
                  disabled={!canRsvp || rsvpMut.isPending}
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
                  disabled={!canRsvp || rsvpMut.isPending}
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
              {!canRsvp && (
                <span className="cal-invite-note">
                  <Info size={11} strokeWidth={2} />
                  {t('calendar.invite.notInCalendar', '尚未同步到日历')}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            className="link-row cal-linkbtn cal-invite-view"
            onClick={handleViewInCalendar}
            title={t('calendar.invite.viewInCalendar', '在日历中查看')}
          >
            {t('calendar.invite.viewInCalendar', '在日历中查看')}
            <ExternalLink size={11} strokeWidth={2} />
          </button>
        </div>
      </section>

      {/* 待收敛 — RSVP 确认卡, 与 EventDetailDrawer 1.5 同款 (glass-pop + --r-pop);
          z-[70] 与 drawer 版对齐 (邮件面无 Drawer 竞争, 保持同层级习惯)。 */}
      {rsvpDlgRender && pendingRsvp && (
        <div
          ref={rsvpDlgRef}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cal-invite-rsvp-confirm-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRsvpDialogOpen(false)
          }}
        >
          <div data-anim-card className="glass-pop p-5 rounded-[var(--r-pop)] max-w-[360px] mx-4">
            <div
              id="cal-invite-rsvp-confirm-title"
              className="text-lead text-ink-fg font-medium mb-1"
            >
              {t('calendar.drawer.rsvp.confirmTitle', '发送 RSVP 回复')}
            </div>
            <div className="text-aux text-ink-fg-2 mb-3">
              {t(
                'calendar.drawer.rsvp.confirmBody',
                '将向组织者发送「{action}」回复邮件 (iTIP REPLY), 该操作不可撤回。',
                { action: rsvpActionLabels[pendingRsvp] }
              )}
            </div>
            <div className="text-aux text-ink-fg-2 mb-4 space-y-0.5">
              <div className="truncate">
                {t('calendar.drawer.rsvp.confirmEvent', '事件')}:{' '}
                {event?.summary || t('calendar.shared.untitled', '未命名事件')}
              </div>
              <div className="truncate font-mono text-[12px]">
                {t('calendar.drawer.meta.organizer', '组织者')}:{' '}
                {normalizeEmail(event?.organizer) || '—'}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setRsvpDialogOpen(false)}>
                {t('calendar.shared.cancel', '取消')}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={rsvpMut.isPending}
                onClick={() => {
                  setRsvpDialogOpen(false)
                  rsvpMut.mutate(pendingRsvp)
                }}
              >
                {t('calendar.drawer.rsvp.confirmSend', '发送回复')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
