// ---- Sprint 6 §2.2 — calendar (recurring meeting) surface -----------------

export interface RecurringInviteItem {
  /** Phase 2.4 — vEvent UID (RFC 5545). Replay 按钮调 eventReplay 用这个,
   *  跟 source 无关 (任何 source 都可 replay). 等于 series_uid. */
  ical_uid: string
  /** Source email (the meeting invite carrier). Phase 1.5 caldav-only events = 0. */
  internal_id: number
  subject: string | null
  organizer: string | null
  rrule: string | null
  notion_page_id: string | null
  first_occurrence: string | null
  last_occurrence: string | null
  occurrence_count: number | null
  date_received: string | null
}

export interface RecurringDiscoverOpts {
  /** ISO date (YYYY-MM-DD). Defaults to CLI's "last 30 days" if omitted. */
  since?: string
}

export interface RecurringReplayOpts {
  internalId?: number
  ids?: number[]
  dryRun?: boolean
}

export interface CalendarExpandOpts {
  horizonWeeks?: number
  dryRun?: boolean
}

// Phase 3 §3.1 (frontend-view-silly-knuth.md) — Calendar SSoT 类型 (前端直读 SQLite
// calendar_event 表 + npm rrule 展开 occurrences). source 三态对应灰度共存:
// 'caldav' (CalendarSyncWorker 拉的) / 'email_ics' (meeting_sync 派生) /
// 'legacy_calendar_app' (老 calendar_main.py 路径).

export type CalendarEventSource = 'caldav' | 'email_ics' | 'legacy_calendar_app'

export interface CalendarEventAttendee {
  email: string
  name?: string
  /** PARTSTAT — ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION */
  response?: string
  /** ROLE — CHAIR / REQ-PARTICIPANT / OPT-PARTICIPANT */
  role?: string
}

/** RRULE 展开后的单 occurrence (前端日历 timeline 渲染拿到的). */
export interface CalendarEventOccurrence {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  /** ISO UTC datetime — 前端 toLocaleString 转本地 TZ 展示. */
  occurrence_start_iso: string
  occurrence_end_iso: string
  /** True = 来自 RRULE 展开; False = 单次 event. */
  is_recurrence_instance: boolean
  is_all_day: boolean
  calendar_name: string
  organizer: string
  attendees: CalendarEventAttendee[]
  location: string
  url: string
  /** CONFIRMED / TENTATIVE / CANCELLED */
  status: string
  response_status: string
  source: CalendarEventSource
  notion_page_id: string | null
  related_email_internal_id: number | null
}

/** calendar_event 表完整 row (event-get 输出, 含 dtstart_iso / ics_raw 等). */
export interface CalendarEventDetail {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  description: string
  location: string
  organizer: string
  attendees: CalendarEventAttendee[]
  dtstart_iso: string | null
  dtend_iso: string | null
  is_all_day: boolean
  rrule: string
  exdates: string[]
  rdates: string[]
  /** v35（#10 tzid 半步）: DTSTART 的 TZID 归一 Olson 名；null = 裸 Z / floating / 全天。
   *
   *  🔴 issue #68: 桌面 IPC 生产者（`handlers/calendar-read.ts::CalendarEventRow`）一直发它，
   *  这个消费侧类型却漏声明 —— 于是前端结构性读不到（TS 说该字段不存在）。
   *  **optional 是如实的**，不是保守：web 那条腿（serve-api `/api/calendar/*` →
   *  `src/api/schemas/calendar.py`）至今不发这个字段，声明成必填就是对 web 端撒谎。
   *  与 `DavMailHealthData.login_fail_threshold` 同一处置。 */
  tzid?: string | null
  status: string
  response_status: string
  url: string
  calendar_name: string
  source: string
  notion_page_id: string | null
  related_email_internal_id: number | null
  ics_raw: string
}

export interface CalendarSyncStateItem {
  calendar_name: string
  ctag: string | null
  sync_token: string | null
  last_full_sync_at_iso: string | null
  last_incremental_sync_at_iso: string | null
  last_error: string | null
}

// 阶段 2.1 (P1-3) — 邮件 ↔ 日历 ical_uid 双向反查 (email_meeting 映射, DB v34).

/** 方向 A: 邮件 internal_id → .ics uid + 日历 master 行 (「查看日程」入口). */
export interface EmailCalendarLink {
  internal_id: number
  ical_uid: string
  /** REQUEST / CANCEL / REPLY; null = v34 回填行 (method 不可考). */
  method: string | null
  /** override 邀请的目标时间 ISO; null = master/单次. */
  recurrence_id: string | null
  sequence: number
  is_recurring: boolean
  /** calendar_event 里存在该 uid 的未删行? false = 邀请未进日历/已删. */
  in_calendar: boolean
  /** 代表 master 行 (caldav 优先); occurrence 展开由消费方走 eventsList. */
  event: CalendarEventDetail | null
}

/** 方向 B: ical_uid → 来源邀请邮件 (drawer「关联邮件」反查). */
export interface EventSourceEmail {
  ical_uid: string
  internal_id: number
  subject: string | null
  sender: string | null
  sender_name: string | null
  date_received: string | null
  mailbox: string | null
  method: string | null
  /** 携带该 uid 的映射邮件总数 (周期会议 update/cancel 各一封). */
  linked_email_count: number
}

export interface EventsListOpts {
  /** Window start (ISO datetime, UTC). Default = today 00:00 UTC. */
  fromIso?: string
  /** Window end. Default = fromIso + 7 days. */
  toIso?: string
  calendarName?: string
  source?: CalendarEventSource
  /** Default true. False = only return master events (skip RRULE expansion). */
  expandRecurrences?: boolean
  /** Cap on returned occurrences. Default 1000. */
  limit?: number
}

export interface EventGetOpts {
  icalUid: string
  recurrenceId?: string | null
  source?: CalendarEventSource
}

export interface SyncNowOpts {
  /** Default true. False = try sync-collection (DavMail 支持有限). */
  full?: boolean
  calendarName?: string
}

// Phase 2.4 — replay 单 calendar_event 行到 Notion mirror (任何 source).
export interface EventReplayOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** 非空 = replay 单次跳脱 occurrence; 留空 = 主事件. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = 按 caldav → email_ics → legacy 顺序自动查. */
  source?: CalendarEventSource
  /** 仅查 row 列 plan, 不写 Notion (无需 auth). */
  dryRun?: boolean
}

// Phase 2.1 — RSVP iTIP REPLY to organizer (drawer accept/tentative/decline button).
export type RsvpResponse = 'accept' | 'tentative' | 'decline'

export interface EventRsvpOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** accept / tentative / decline. */
  response: RsvpResponse
  /** 非空 = RSVP 单次跳脱 occurrence; 留空 = 整系列 REPLY. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = caldav → email_ics → legacy 自动查. */
  source?: CalendarEventSource
  /** True = 仅查 row + 拼 plan, 不发 SMTP (无需 auth). */
  dryRun?: boolean
}

// Phase 2.2/2.3 — calendar event CRUD via CalDAV PUT/DELETE.
export type EventStatusCode = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'

export interface EventAttendeeInput {
  email: string
  name?: string
}

export interface EventCreateOpts {
  summary: string
  /** ISO datetime with tz (必填); e.g. '2026-05-30T14:00:00+08:00' or 'Z' 结尾. */
  startIso: string
  endIso: string
  location?: string
  description?: string
  attendees?: EventAttendeeInput[]
  /** 目标 calendar 名; 留空 = 默认 (Outlook 主日历). */
  calendarName?: string
  status?: EventStatusCode
  /** Phase 4·#3 — RFC 5545 RRULE (不含 'RRULE:' 前缀); 留空 = 单次事件. */
  rrule?: string
  /** Phase 4·#2 — 全天事件; start/end 端到端用 UTC midnight Z + end exclusive. */
  isAllDay?: boolean
}

export interface EventUpdateOpts {
  icalUid: string
  /** All optional — 不传 = 保留原值. */
  summary?: string
  startIso?: string
  endIso?: string
  location?: string
  description?: string
  /** Phase 4·#4 — 替换与会者; 不传 = 保留原与会者 (含 partstat, 防退化). 清空用 clearAttendees. */
  attendees?: EventAttendeeInput[]
  /** Phase 4·#4 — 显式清空所有与会者 (前端删光 chips); 与 attendees 互斥. */
  clearAttendees?: boolean
  status?: EventStatusCode
  calendarName?: string
  /** Phase 4·#3 — 改整系列 RRULE: 不传=保留原值; 'FREQ=...' 覆盖; '' 删除(周期→单次). */
  rrule?: string
  /** Phase 4·#2 — 全天状态: 不传=保持原状态; true=改全天; false=改定时. */
  isAllDay?: boolean
  /** Phase 4·#3c — 改这一次 occurrence (ISO datetime = 该次原始 dtstart);
   *  留空 = 改整系列. 传了走 detached occurrence (RECURRENCE-ID override). */
  recurrenceId?: string
  /** Phase 4·#3d — 改未来: 配合 recurrenceId, 从该次起 split 成新 series. */
  splitFuture?: boolean
  /** 默认 SEQUENCE +1 (RFC 5545 标准). */
  noSequenceBump?: boolean
}

export interface EventDeleteOpts {
  icalUid: string
  calendarName?: string
}

export interface CalendarApi {
  recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]>
  recurringReplay(opts: RecurringReplayOpts): Promise<unknown>
  expand(opts?: CalendarExpandOpts): Promise<unknown>

  // Phase 3 §3.1 — Calendar SSoT 直读
  eventsList(opts?: EventsListOpts): Promise<CalendarEventOccurrence[]>
  eventGet(opts: EventGetOpts): Promise<CalendarEventDetail | null>
  syncStatus(): Promise<CalendarSyncStateItem[]>
  calendarNames(): Promise<string[]>
  syncTrigger(opts?: SyncNowOpts): Promise<unknown>

  // 阶段 2.1 (P1-3) — 邮件 ↔ 日历 ical_uid 双向反查 (null = 无映射/不是会议邀请)
  emailCalendarLink(internalId: number): Promise<EmailCalendarLink | null>
  eventSourceEmail(icalUid: string): Promise<EventSourceEmail | null>

  // Phase 2.4 — 重导出 calendar_event 行到 Notion (any source)
  eventReplay(opts: EventReplayOpts): Promise<unknown>

  // Phase 2.1 — 发 iTIP REPLY 给 organizer (accept/tentative/decline)
  eventRsvp(opts: EventRsvpOpts): Promise<unknown>

  // Phase 2.2/2.3 — CalDAV PUT/DELETE (create / update / delete event)
  eventCreate(opts: EventCreateOpts): Promise<unknown>
  eventUpdate(opts: EventUpdateOpts): Promise<unknown>
  eventDelete(opts: EventDeleteOpts): Promise<unknown>
}
