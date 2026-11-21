import { useCallback, useMemo, useState } from 'react'

import type { ContextUsageView } from '@shared/assistant/components/contextUsage.lib'
import { useShortcut } from '@shared/hooks/useShortcut'
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type SessionWorkspaceSnapshot
} from './deriveSessionWorkspace'
import {
  readInspectorAutoOpenPref,
  SessionInspectorContext,
  type SessionInspectorContextValue
} from './inspectorContext'

export interface InspectorProviderProps {
  /** Session identity key resetting preview selection and published snapshot on switch. */
  readonly sessionKey: string
  /** Bind ⌘. toggle shortcut while this surface is active / unobscured. */
  readonly shortcutEnabled?: boolean
  readonly children: React.ReactNode
}

/**
 * Host-level state container for the dual-mode right-side Session Workspace Inspector.
 * Lives OUTSIDE the inner AiSdkRuntimeProvider so the pane stays visible next to transitions.
 */
export function InspectorProvider({
  sessionKey,
  shortcutEnabled = true,
  children
}: InspectorProviderProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<SessionWorkspaceSnapshot>(EMPTY_WORKSPACE_SNAPSHOT)
  const [contextUsage, setContextUsage] = useState<ContextUsageView | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [autoOpenedOnce, setAutoOpenedOnce] = useState(false)

  // Adjust-on-prop-change (react.dev): reset session-scoped preview and auto-open latch when
  // switching tabs or conversations without synchronous setState inside useEffect.
  const [prevKey, setPrevKey] = useState(sessionKey)
  if (prevKey !== sessionKey) {
    setPrevKey(sessionKey)
    setPreviewArtifactId(null)
    setSnapshot(EMPTY_WORKSPACE_SNAPSHOT)
    setContextUsage(null)
    setSessionId(null)
    setAutoOpenedOnce(false)
  }

  const toggle = useCallback((): void => {
    setOpen((cur) => !cur)
  }, [])

  const openArtifactPreview = useCallback((id: string): void => {
    setOpen(true)
    setPreviewArtifactId(id)
  }, [])

  const closeArtifactPreview = useCallback((): void => {
    setPreviewArtifactId(null)
  }, [])

  const publishSnapshot = useCallback(
    (next: SessionWorkspaceSnapshot): void => {
      setSnapshot(next)
      if (!autoOpenedOnce && next.totalItems > 0 && readInspectorAutoOpenPref()) {
        setAutoOpenedOnce(true)
        setOpen(true)
      }
    },
    [autoOpenedOnce]
  )

  useShortcut('cmd+.', toggle, { enabled: shortcutEnabled })

  const value = useMemo<SessionInspectorContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      previewArtifactId,
      openArtifactPreview,
      closeArtifactPreview,
      snapshot,
      publishSnapshot,
      contextUsage,
      publishContextUsage: setContextUsage,
      sessionId,
      publishSessionId: setSessionId
    }),
    [
      open,
      toggle,
      previewArtifactId,
      openArtifactPreview,
      closeArtifactPreview,
      snapshot,
      publishSnapshot,
      contextUsage,
      sessionId
    ]
  )

  return (
    <SessionInspectorContext.Provider value={value}>{children}</SessionInspectorContext.Provider>
  )
}
