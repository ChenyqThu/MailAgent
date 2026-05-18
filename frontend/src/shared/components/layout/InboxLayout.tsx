// Sprint 2 shell: TitleBar / Sidebar / EmailList / EmailDetail / StatusBar.
// Layout per DESIGN.md §3: 240 (sidebar) + 340 (list) + flex-1 (detail) =
// min-width 940 (sidebar 240 + list 340 + detail floor 360 reserved for the
// future AI panel column). Sprint 4 inserts the AIChatPanel between the
// detail and the right edge; the grid here doesn't need to change — only
// EmailDetail's max width does.

import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'
import { AIChatPanel } from '../chat'
import { BatchActionBar } from '../batch/BatchActionBar'

export function InboxLayout(): React.ReactElement {
  const activeId = useActiveEmail((s) => s.activeInternalId)
  // Sprint 10 user-acceptance — AIChatPanel was forced-mounted in the
  // 1280px layout, leaving EmailDetail < 320px wide. Now it's an on-demand
  // overlay column toggled via the toolbar icon, ⌘L, or any AI Agents
  // sidebar entry.
  const aiPanelVisible = useAIChatPanel((s) => s.visible)
  // Sprint 7 review (opus Nit) — removed local `useShortcut('cmd+k', goSearch)`
  // because `GlobalShortcuts` (mounted in App.tsx) now owns ⌘K → command
  // palette. The palette includes a "Go · Search" navigation entry, so the
  // user can still reach /search from the same keystroke — without
  // double-firing two handlers (LIFO + non-consuming open() would have
  // navigated AND opened the palette on the same press).
  return (
    <div className="flex flex-col h-full bg-ink-0 text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <EmailList />
        <EmailDetail internalId={activeId} />
        {aiPanelVisible && <AIChatPanel />}
      </div>
      {/* Sprint 5 §2.2 / DESIGN.md §5.4 — 52px bar appears when ≥1 row is
          selected (useBatch.selectedIds.length > 0). Renders inline above
          StatusBar so the bar lives in the same chrome tier as the title
          bar. */}
      <BatchActionBar />
      <StatusBar />
    </div>
  )
}
