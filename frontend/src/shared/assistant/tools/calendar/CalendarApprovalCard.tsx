// calendar epic 4.2 — CalendarApprovalCard (calendar_event_reschedule / calendar_event_rsvp /
// calendar_event_delete, edit tier + 恒 HITL).
//
// The rich approval card for the three calendar writes (v1.5.0 教训: an edit-tier HITL tool
// without a card renders as a buttonless permanent spinner in an islandless environment):
//   - reschedule: a before→after time diff. 🔴 "before" (current title + times) is fetched LIVE
//     from serve-api (GET /api/calendar/events/{uid} — SkillInstallConfirmCard /
//     CustomAgentApprovalCard precedent), never from the model's args, so a model lying about the
//     current schedule changes nothing the user reviews. "after" is the model's proposal (exactly
//     what will run — identity pinned, no editable fields).
//   - rsvp: the event title + organizer (server facts) + the "sends an IRREVOCABLE iTIP REPLY to
//     the organizer" warning.
//   - delete: the event title + time (server facts) + the irreversible warning.
// Facts unavailable (event not found / fetch error) → the card degrades to a warning line + the
// raw proposal; approve stays possible — the Python write authority re-validates existence and a
// stale approval just fails server-side (no silent success).

import { useEffect, useState } from 'react'
import { CalendarClock, CalendarX2, MailCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type CalendarApprovalCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

// Resolve serve-api base URL for direct fetch calls (mirrors CustomAgentApprovalCard —
// intentionally duplicated to avoid coupling a shared tool card to the settings module).
function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

/** The server-fact subset the card renders (routers/calendar.py eventGet detail row). */
interface EventFacts {
  summary: string | null
  dtstart_iso: string | null
  dtend_iso: string | null
  organizer: string | null
  is_all_day: boolean
  calendar_name: string | null
}

async function fetchEventFacts(eventId: string): Promise<EventFacts | null> {
  const resp = await fetch(
    `${resolveApiBaseUrl()}/calendar/events/${encodeURIComponent(eventId)}?source=caldav`,
    { credentials: 'include' }
  )
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as { status?: string; data?: Record<string, unknown> }
  if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
  const d = body.data
  const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  return {
    summary: s(d.summary),
    dtstart_iso: s(d.dtstart_iso),
    dtend_iso: s(d.dtend_iso),
    organizer: s(d.organizer),
    is_all_day: d.is_all_day === true || d.is_all_day === 1,
    calendar_name: s(d.calendar_name)
  }
}

/** Local wall-clock rendering of an ISO instant (or the raw string when unparseable — the model
 *  may propose 'YYYY-MM-DDTHH:mm' + timezone, which is already the user-facing wall time). */
function fmtTime(value: string | null | undefined, timezone?: string | null): string | null {
  if (value == null || value.length === 0) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timezone ? { timeZone: timezone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d)
  } catch {
    return value
  }
}

function propsOf(toolName: string, args: unknown, result: unknown): CalendarApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? { kind: 'delete', eventId: '' }) as unknown as CalendarApprovalCardProps
}

function iconFor(kind: CalendarApprovalCardProps['kind']): React.ReactNode {
  if (kind === 'rsvp') return <MailCheck size={13} strokeWidth={2} />
  if (kind === 'delete') return <CalendarX2 size={13} strokeWidth={2} />
  return <CalendarClock size={13} strokeWidth={2} />
}

function Row({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 text-aux">
      <span className="shrink-0 text-ink-fg-2">{label}</span>
      <span
        className={
          accent ? 'min-w-0 break-all font-medium text-ink-fg' : 'min-w-0 break-all text-ink-fg'
        }
      >
        {value}
      </span>
    </div>
  )
}

export function CalendarApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const [facts, setFacts] = useState<EventFacts | null>(null)
  const [factsState, setFactsState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')

  useEffect(() => {
    if (phase !== 'pending' || !data.eventId) return
    let cancelled = false
    fetchEventFacts(data.eventId)
      .then((row) => {
        if (cancelled) return
        setFacts(row)
        setFactsState(row ? 'ok' : 'missing')
      })
      .catch(() => {
        if (!cancelled) setFactsState('error')
      })
    return () => {
      cancelled = true
    }
  }, [phase, data.eventId])

  const title = t(`chat.calendarApprovalCard.${data.kind}.title`)
  const eventLabel = facts?.summary ?? data.eventId
  const beforeTime =
    facts?.dtstart_iso != null
      ? `${fmtTime(facts.dtstart_iso, data.timezone) ?? ''}${facts.dtend_iso ? ` → ${fmtTime(facts.dtend_iso, data.timezone)}` : ''}`
      : null
  const afterTime =
    data.newStart != null
      ? `${fmtTime(data.newStart, data.timezone) ?? ''}${data.newEnd ? ` → ${fmtTime(data.newEnd, data.timezone)}` : ''}`
      : null

  const onApprove = (): void => respondToApproval({ approved: true })
  const onReject = (): void => respondToApproval({ approved: false })

  const body = (
    <div className="space-y-1">
      <Row label={t('chat.calendarApprovalCard.event')} value={eventLabel} accent />
      {data.kind === 'reschedule' && (
        <>
          {beforeTime && <Row label={t('chat.calendarApprovalCard.before')} value={beforeTime} />}
          {afterTime && (
            <Row label={t('chat.calendarApprovalCard.after')} value={afterTime} accent />
          )}
          <Row
            label={t('chat.calendarApprovalCard.scope')}
            value={t(`chat.calendarApprovalCard.scopes.${data.scope ?? 'series'}`)}
          />
        </>
      )}
      {data.kind === 'rsvp' && (
        <>
          {facts?.organizer && (
            <Row label={t('chat.calendarApprovalCard.organizer')} value={facts.organizer} />
          )}
          <Row
            label={t('chat.calendarApprovalCard.response')}
            value={t(`chat.calendarApprovalCard.responses.${data.response ?? 'accept'}`)}
            accent
          />
        </>
      )}
      {data.kind === 'delete' && beforeTime && (
        <Row label={t('chat.calendarApprovalCard.time')} value={beforeTime} />
      )}
    </div>
  )

  const warningKey =
    data.kind === 'rsvp'
      ? 'chat.calendarApprovalCard.rsvpWarning'
      : data.kind === 'delete'
        ? 'chat.calendarApprovalCard.deleteWarning'
        : null

  return (
    <CardFrame icon={iconFor(data.kind)} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          {body}
          {(factsState === 'missing' || factsState === 'error') && (
            <div className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-meta text-warn">
              {t(
                factsState === 'missing'
                  ? 'chat.calendarApprovalCard.factsMissing'
                  : 'chat.calendarApprovalCard.factsError'
              )}
            </div>
          )}
          {warningKey && (
            <div className="mt-2 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
              {t(warningKey)}
            </div>
          )}
          <ApprovalActions onApprove={onApprove} onReject={onReject} />
        </>
      ) : phase === 'rejected' || phase === 'expired' ? (
        <>
          {body}
          <TerminalBanner phase={phase} />
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.calendarApprovalCard.error')}</div>
      ) : (
        // authorized (executing) / done — echo the reviewed proposal; the applied flag lands in
        // the result and the phase pill already reads done.
        body
      )}
    </CardFrame>
  )
}
