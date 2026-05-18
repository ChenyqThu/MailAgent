// Sprint 6 — /llm route shell.

import { PageFrame } from './PageFrame'
import { LlmDashboardPage } from '../llm/LlmDashboardPage'

export function LlmDashboardLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="llm-dashboard">
      <LlmDashboardPage />
    </PageFrame>
  )
}
