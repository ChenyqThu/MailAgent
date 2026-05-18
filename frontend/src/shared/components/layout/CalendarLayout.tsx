// Sprint 6 — /calendar route shell.

import { PageFrame } from './PageFrame'
import { CalendarPage } from '../calendar/CalendarPage'

export function CalendarLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="calendar">
      <CalendarPage />
    </PageFrame>
  )
}
