import { useCallback, useMemo, useState } from 'react'

import type { ContextUsageView } from '@shared/assistant/components/contextUsage.lib'
import { useShortcut } from '@shared/hooks/useShortcut'
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type SessionWorkspaceSnapshot
} from './deriveSessionWorkspace'
import {
  SessionInspectorContext,
  type SessionInspectorContextValue
} from './inspectorContext'

export interface InspectorProviderProps {
  /** Session identity key resetting preview selection and published snapshot on switch. */
  readonly sessionKey: string
  /** Bind ⌘. toggle shortcut while this surface is active / unobscured. */
  readonly shortcutEnabled?: boolean
  /** Auto-open the right card on full-page surfaces once artifacts/skills/sources populate. */
  readonly autoOpenWhenPopulated?: boolean
  readonly children: React.ReactNode
}

function hasWorkspaceAutoOpenContent(snapshot: SessionWorkspaceSnapshot): boolean {
  return (
    snapshot.artifacts.length > 0 ||
    snapshot.skills.length > 0 ||
    snapshot.sources.consulted.length > 0 ||
    snapshot.links.length > 0 ||
    snapshot.connectorsUsed.length > 0
  )
}

/**
 * Host-level state container for the dual-mode right-side Session Workspace Inspector.
 * Lives OUTSIDE the inner AiSdkRuntimeProvider so the pane stays visible next to transitions.
 */
export function InspectorProvider({
  sessionKey,
  shortcutEnabled = true,
  autoOpenWhenPopulated = false,
  children
}: InspectorProviderProps): React.JSX.Element {
  const [userOverride, setUserOverride] = useState<'open' | 'closed' | null>(null)
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<SessionWorkspaceSnapshot>(EMPTY_WORKSPACE_SNAPSHOT)
  const [contextUsage, setContextUsage] = useState<ContextUsageView | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)

  // Adjust-on-prop-change (react.dev): reset session-scoped preview and per-session override when
  // switching tabs or conversations without synchronous setState inside useEffect.
  const [prevKey, setPrevKey] = useState(sessionKey)
  if (prevKey !== sessionKey) {
    setPrevKey(sessionKey)
    setUserOverride(null)
    setPreviewArtifactId(null)
    setSnapshot(EMPTY_WORKSPACE_SNAPSHOT)
    setContextUsage(null)
    setSessionId(null)
  }

  const defaultOpen = autoOpenWhenPopulated && hasWorkspaceAutoOpenContent(snapshot)
  const open =
    previewArtifactId !== null || (userOverride !== null ? userOverride === 'open' : defaultOpen)

  const setOpen = useCallback((next: boolean): void => {
    setUserOverride(next ? 'open' : 'closed')
    if (!next) setPreviewArtifactId(null)
  }, [])

  const toggle = useCallback((): void => {
    if (previewArtifactId !== null) {
      setPreviewArtifactId(null)
      setUserOverride('closed')
      return
    }
    setUserOverride((cur) => {
      const effectiveOpen = cur !== null ? cur === 'open' : defaultOpen
      return effectiveOpen ? 'closed' : 'open'
    })
  }, [previewArtifactId, defaultOpen])

  const openArtifactPreview = useCallback((id: string): void => {
    setUserOverride('open')
    setPreviewArtifactId(id)
  }, [])

  const closeArtifactPreview = useCallback((): void => {
    setPreviewArtifactId(null)
  }, [])

  const publishSnapshot = useCallback((next: SessionWorkspaceSnapshot): void => {
    setSnapshot(next)
  }, [])

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
