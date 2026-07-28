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
// RSVP 三键受 calendarCapabilities().rsvp 门控 (阶段 3 #11 起两端 true), 信息区恒渲染。
//
// 组件放 calendar/ 目录 (而非 email/): RSVP/冲突/能力门控/类型全是日历域,
// EmailDetail 只是挂载点; cal- 前缀样式与日历面同族, 便于后续与 drawer 收敛。

import { useMemo, useState } from 'react'
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

import { calendarCapabilities } from './lib/capabilities'

const caps = calendarCapabilities()
import { pad } from './lib/format'
import { canRsvpFor, normalizeEmail } from './lib/rsvp'
import { RsvpConfirmDialog } from './RsvpConfirmDialog'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useCalendarFocus } from '@shared/state/calendar-focus'
import type { EmailCalendarLink, RsvpResponse } from '@shared/api/types'
import { narrowCalendarSource } from '@shared/lib/calendarSource'

interface Props {
  internalId: number
}

interface OccWindow {
  startIso: string
  endIso: string
  isAllDay: boolean
}

/** 邀请指向的 occurrence 起止窗。override 邀请 (link.recurrence_id 非空):
 *  event 行本身就是 detached 行时直接用其时间; event 是 master (caldav 代表行
 *  优先) 时用 recurrence_id (目标次原始 dtstart) + master duration 推算。
 *  其余 (单次/整系列邀请) 用 master dtstart/dtend。
 *
 *  收尾批 (Lane G) — 「整系列邀请」(is_recurring 且无 recurrence_id) 用 master
 *  首次时间是错的 (老周期会议显示几个月前的日期); 调用方 (MeetingInviteCard)
 *  对这一分支改用 nextOccQ 查到的下一次 occurrence 覆盖此函数的返回值, 此函数
 *  本身只在「未查到下一次 occurrence / 查询未完成」时充当回退基线。 */
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

  // task 07-15 问题2 — userEmail 用于 RSVP 门控 (canRsvpFor 单源)。与 drawer /
  // Sidebar 同 query key, react-query 缓存共享, 不因卡片反复重拉。
  const { data: settings } = useQuery({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 5 * 60_000
  })
  const userEmail = settings?.userEmail ?? null
  const link = linkQ.data ?? null
  const event = link?.event ?? null
  const isCancelled =
    (link?.method ?? '').toUpperCase() === 'CANCEL' ||
    (event?.status ?? '').toUpperCase() === 'CANCELLED'

  // 收尾批 (Lane G) — 整系列邀请 (is_recurring 且无 recurrence_id): 查
  // [现在, +60d] 窗口该 uid 的下一次 occurrence 覆盖 master 首次时间。窗口
  // 边界只算一次 (session 内粗粒度 "现在" 足够), staleTime/无显式 retry 对齐
  // 组件内既有 conflictQ 同款 eventsList 查询。lazy useState 初始化 (同
  // useCalendarEvents.useNowTick 同款写法) — react-hooks/purity 禁止 render
  // 期间调 Date.now() 等 impure 函数, useState 的 lazy initializer 是例外。
  const seriesInvite = !!link && link.is_recurring && !link.recurrence_id
  const [seriesLookahead] = useState(() => ({
    fromIso: new Date().toISOString(),
    toIso: new Date(Date.now() + 60 * 86400_000).toISOString()
  }))
  const nextOccQ = useQuery({
    queryKey: qk.calendar.nextOccurrence(link?.ical_uid ?? ''),
    queryFn: () => mailApi.calendar.eventsList(seriesLookahead),
    enabled: seriesInvite,
    staleTime: 60_000
  })
  const nextOcc = useMemo(() => {
    if (!seriesInvite || !link || !nextOccQ.data) return null
    const hits = nextOccQ.data
      .filter((o) => o.ical_uid === link.ical_uid && (o.status || '').toUpperCase() !== 'CANCELLED')
      .sort((a, b) => Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso))
    return hits[0] ?? null
  }, [seriesInvite, link, nextOccQ.data])
  // 查询已完成但 60 天窗口内无命中 = 系列已结束/近期无场次 (区别于「查询还
  // 没跑完」, 避免加载中就先闪一下「系列已结束」提示).
  const seriesEnded = seriesInvite && nextOccQ.isSuccess && !nextOcc

  const occWindow = useMemo(() => {
    if (!link) return null
    if (seriesInvite && nextOcc) {
      return {
        startIso: nextOcc.occurrence_start_iso,
        endIso: nextOcc.occurrence_end_iso,
        isAllDay: nextOcc.is_all_day
      }
    }
    return deriveOccWindow(link)
  }, [link, seriesInvite, nextOcc])

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
        source: narrowCalendarSource(event?.source)
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

  // 收尾批 (Lane G) — RSVP 确认卡 (D1 拍板恒确认) 收敛进 RsvpConfirmDialog
  // 共享组件 (与 EventDetailDrawer 同款), 此处只留开合状态接线。
  const [pendingRsvp, setPendingRsvp] = useState<RsvpResponse | null>(null)
  const [rsvpDialogOpen, setRsvpDialogOpen] = useState(false)

  if (!link) return null

  const myResp = (event?.response_status || '').toUpperCase()
  // task 07-15 问题2 — event 行在库时按 organizer 门控 RSVP 区渲染 (canRsvpFor
  // 单源): 空 organizer / organizer=自己 → 整个三键区不渲染 (点击必失败)。
  // event=null (尚未同步到日历) 时 organizer 未知, 保留原禁用三键 + 提示。
  const rsvpEligible = !event || canRsvpFor(event.organizer, userEmail)
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
                {seriesEnded && (
                  <span className="cal-invite-note">
                    <Info size={11} strokeWidth={2} />
                    {t('calendar.invite.seriesEnded', '系列近期无场次, 显示首次时间')}
                  </span>
                )}
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
          {/* 阶段 3 (#11) — caps.rsvp 门控 (HttpApi eventRsvp 已接通, 两端 true);
              task 07-15 — 叠加 rsvpEligible (空/自身 organizer 不渲染三键) */}
          {!isCancelled && caps.rsvp && rsvpEligible && (
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

      {/* 收尾批 (Lane G) — RSVP 确认卡, 收敛进 RsvpConfirmDialog 共享组件
          (与 EventDetailDrawer 同款). titleId 保持原 "cal-invite-rsvp-confirm-title"
          不变. */}
      <RsvpConfirmDialog
        open={rsvpDialogOpen}
        pendingResponse={pendingRsvp}
        eventSummary={event?.summary}
        organizer={normalizeEmail(event?.organizer) || null}
        onCancel={() => setRsvpDialogOpen(false)}
        onConfirm={() => {
          if (!pendingRsvp) return
          setRsvpDialogOpen(false)
          rsvpMut.mutate(pendingRsvp)
        }}
        confirmPending={rsvpMut.isPending}
        titleId="cal-invite-rsvp-confirm-title"
      />
    </>
  )
}
