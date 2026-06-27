// Authored preview — EventBlock (absolute-positioned day/week grid block).
// Rendered inside a relative time-grid column so topPx/heightPx place it.
import { EventBlock } from 'mailagent-frontend'

const ev = (o: Record<string, unknown>) => ({
  id: 1,
  ical_uid: 'uid-1',
  recurrence_id: null,
  sequence: 0,
  summary: 'Standup',
  occurrence_start_iso: '2026-06-28T09:00:00+08:00',
  occurrence_end_iso: '2026-06-28T09:30:00+08:00',
  is_recurrence_instance: false,
  is_all_day: false,
  calendar_name: 'Work',
  organizer: 'me@omadanetworks.com',
  attendees: [],
  location: 'Teams',
  url: '',
  status: 'CONFIRMED',
  response_status: 'ACCEPTED',
  source: 'caldav',
  notion_page_id: null,
  related_email_internal_id: null,
  ...o
})

export const DayColumn = () => (
  <div style={{ padding: 16, background: 'rgb(var(--ink-1))' }}>
    <div style={{ position: 'relative', height: 260, width: 220, background: 'rgb(var(--ink-2))', borderRadius: 8, border: '1px solid rgb(var(--ink-border) / 0.4)' }}>
      <EventBlock event={ev({ summary: 'Standup' }) as never} topPx={12} heightPx={44} col={0} totalCols={1} onClick={() => {}} />
      <EventBlock event={ev({ summary: 'Design review', occurrence_end_iso: '2026-06-28T15:30:00+08:00' }) as never} topPx={72} heightPx={96} col={0} totalCols={1} selected onClick={() => {}} />
      <EventBlock event={ev({ summary: 'Roadmap sync' }) as never} topPx={184} heightPx={56} col={0} totalCols={1} onClick={() => {}} />
    </div>
  </div>
)
