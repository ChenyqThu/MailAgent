// Sprint 2 shell: TitleBar / Sidebar / EmailList / EmailDetail / StatusBar.
// Layout per DESIGN.md §3: 240 (sidebar) + 340 (list) + flex-1 (detail) =
// min-width 940 (sidebar 240 + list 340 + detail floor 360 reserved for the
// future AI panel column). Sprint 4 inserts the AIChatPanel between the
// detail and the right edge; the grid here doesn't need to change — only
// EmailDetail's max width does.

import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useActiveEmail } from '@shared/state/active-email'
import { useShortcut } from '@shared/hooks/useShortcut'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'

export function InboxLayout(): React.ReactElement {
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const navigate = useNavigate()
  // ⌘K → /search. Sprint 4: AI chat ⌘L / ⌥A / ⌘N register inside the panel
  // itself; this layout-level binding stays focused on cross-cutting nav.
  const goSearch = useCallback(() => {
    navigate({ to: '/search' })
  }, [navigate])
  useShortcut('cmd+k', goSearch)
  return (
    <div className="flex flex-col h-full bg-ink-0 text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <EmailList />
        <EmailDetail internalId={activeId} />
      </div>
      <StatusBar />
    </div>
  )
}
