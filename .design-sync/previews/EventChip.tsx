// Authored preview — EventChip (compact calendar event chip; data-resp /
// data-status drive the CSS render for response + cancelled states).
import { EventChip } from 'mailagent-frontend'

const ev = (o: Record<string, unknown>) => ({
  id: 1,
  ical_uid: 'uid-1',
  recurrence_id: null,
  sequence: 0,
  summary: 'Design review',
  occurrence_start_iso: '2026-06-28T14:00:00+08:00',
  occurrence_end_iso: '2026-06-28T15:00:00+08:00',
  is_recurrence_instance: false,
  is_all_day: false,
  calendar_name: 'Work',
  organizer: 'me@omadanetworks.com',
  attendees: [],
  location: 'Microsoft Teams',
  url: '',
  status: 'CONFIRMED',
  response_status: 'ACCEPTED',
  source: 'caldav',
  notion_page_id: null,
  related_email_internal_id: null,
  ...o
})

export const States = () => (
  <div style={{ padding: 24, background: 'rgb(var(--ink-1))', display: 'grid', gap: 8, width: 260 }}>
    <EventChip event={ev({ summary: 'Design review' }) as never} onClick={() => {}} />
    <EventChip event={ev({ summary: 'All-hands', is_all_day: true, response_status: 'TENTATIVE' }) as never} onClick={() => {}} />
    <EventChip event={ev({ summary: '1:1 with Sarah', response_status: 'DECLINED' }) as never} onClick={() => {}} />
    <EventChip event={ev({ summary: 'Cancelled sync', status: 'CANCELLED' }) as never} onClick={() => {}} />
  </div>
)
