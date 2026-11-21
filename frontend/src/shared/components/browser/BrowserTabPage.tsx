import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { BROWSER_TAB_ID, useTabWorkspace } from '@shared/state/tab-workspace'
import { useManagedBrowserUi } from '@shared/state/managed-browser-ui'

import { ManagedBrowserPane } from './ManagedBrowserPane'

export function BrowserTabPage(): React.ReactElement {
  const navigate = useNavigate()

  const handleReturnToSidebar = useCallback((): void => {
    useManagedBrowserUi.getState().openSidebar()
    useTabWorkspace.getState().closeTab(BROWSER_TAB_ID)
    void navigate({ to: '/sessions' })
  }, [navigate])

  const handleActiveTitleChange = useCallback((title: string): void => {
    if (!title) return
    useTabWorkspace.getState().updateTab(BROWSER_TAB_ID, { title })
  }, [])

  const handleOpenConnectors = useCallback((): void => {
    void navigate({
      to: '/settings',
      search: { tab: 'connectors', item: 'connector:browser_use' }
    })
  }, [navigate])

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-0">
      <ManagedBrowserPane
        mode="tab"
        onReturnToSidebar={handleReturnToSidebar}
        onActiveTitleChange={handleActiveTitleChange}
        onOpenConnectors={handleOpenConnectors}
      />
    </div>
  )
}
