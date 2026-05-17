// Sprint 1 shell: TitleBar + Sidebar + main panel + StatusBar. The main panel
// is a placeholder card in this sprint and gets replaced in Sprint 2 by the
// 3-pane inbox (EmailList + EmailDetail + AIChatPanel). The wrapping
// grid + flex composition is what later sprints inherit — only the middle
// slot changes.

import { useTranslation } from 'react-i18next'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function InboxLayout(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col h-full bg-ink-0 text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main
          aria-label="inbox-main"
          className="flex-1 min-w-0 bg-ink-2 flex items-center justify-center"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="text-micro font-mono uppercase tracking-widest text-ink-fg-2">
              MAILAGENT · SPRINT 1
            </div>
            <div className="text-subj text-ink-fg">{t('app.scaffold')}</div>
            <div className="text-meta font-mono text-ink-fg-2">
              Sprint 2: EmailList · EmailDetail · AIChatPanel
            </div>
          </div>
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
