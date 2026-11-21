import { createContext, useContext } from 'react'

import type { ContextUsageView } from '@shared/assistant/components/contextUsage.lib'
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type SessionWorkspaceSnapshot
} from './deriveSessionWorkspace'

export const INSPECTOR_AUTO_OPEN_PREF_KEY = 'mailagent.chat.inspectorAutoOpen'

export function readInspectorAutoOpenPref(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(INSPECTOR_AUTO_OPEN_PREF_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeInspectorAutoOpenPref(enabled: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(INSPECTOR_AUTO_OPEN_PREF_KEY, enabled ? 'true' : 'false')
  } catch {
    /* ignore storage quota / restricted env */
  }
}

export interface SessionInspectorContextValue {
  readonly open: boolean
  readonly setOpen: (next: boolean) => void
  readonly toggle: () => void
  readonly previewArtifactId: string | null
  readonly openArtifactPreview: (id: string) => void
  readonly closeArtifactPreview: () => void
  readonly snapshot: SessionWorkspaceSnapshot
  readonly publishSnapshot: (next: SessionWorkspaceSnapshot) => void
  readonly contextUsage: ContextUsageView | null
  readonly publishContextUsage: (view: ContextUsageView | null) => void
  readonly sessionId: number | null
  readonly publishSessionId: (id: number | null) => void
}

export const DEFAULT_INSPECTOR_SNAPSHOT = EMPTY_WORKSPACE_SNAPSHOT

export const SessionInspectorContext = createContext<SessionInspectorContextValue | null>(null)

/** Read the host-scoped session inspector controller, or null outside an InspectorProvider. */
export function useSessionInspector(): SessionInspectorContextValue | null {
  return useContext(SessionInspectorContext)
}
