// /sessions route shell — the global "AI 会话历史" page. Same chrome as the
// other secondary routes (admin / llm / calendar): TitleBar + Sidebar +
// StatusBar via PageFrame. SessionsPage owns its own header + scroll, so we
// hand it a column-flex main slot (no outer scroll) like SettingsLayout does.

import { PageFrame } from './PageFrame'
import { SessionsPage } from '../chat/SessionsPage'

export function SessionsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="ai-sessions" mainClassName="flex flex-col overflow-hidden min-w-0">
      <SessionsPage />
    </PageFrame>
  )
}
