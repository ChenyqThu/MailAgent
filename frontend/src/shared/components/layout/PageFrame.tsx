// Sprint 6 §2.2 — shared wrapper for the secondary routes (/admin · /llm
// · /calendar · /settings). Same chrome as InboxLayout / SearchLayout
// (TitleBar 36px + Sidebar 240px + StatusBar 24px) but the content slot
// owns its own scroll container so dashboards can grow vertically without
// flexing siblings.

import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

interface PageFrameProps {
  children: React.ReactNode
  /** Optional accessible label for the <main> element. Falls back to the
   *  current route path; supplying it ensures VoiceOver reads the section
   *  name rather than a path. */
  ariaLabel?: string
}

export function PageFrame({ children, ariaLabel }: PageFrameProps): React.ReactElement {
  return (
    <div className="flex flex-col h-full bg-ink-0 text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main aria-label={ariaLabel} className="flex-1 overflow-y-auto min-w-0 scrollbar-thin">
          {children}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
