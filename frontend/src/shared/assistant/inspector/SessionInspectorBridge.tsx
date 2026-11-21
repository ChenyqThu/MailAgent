import { useEffect, useMemo } from 'react'
import { useAuiState } from '@assistant-ui/react'

import { useChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import {
  buildContextUsageView,
  latestContextTokens,
  type ContextUsageRow
} from '@shared/assistant/components/contextUsage.lib'
import {
  deriveSessionWorkspace,
  type DeriveSessionWorkspaceInput
} from './deriveSessionWorkspace'
import { useSessionInspector } from './inspectorContext'

export interface SessionInspectorBridgeProps {
  readonly anchors?: DeriveSessionWorkspaceInput['anchors']
  readonly mentions?: DeriveSessionWorkspaceInput['mentions']
  readonly persistedRows?: readonly ContextUsageRow[]
  readonly sessionId?: number | null
}

/**
 * Zero-render bridge inside `<AiSdkRuntimeProvider>` that derives the live workspace snapshot from
 * `s.thread.messages` (referentially stable selector) plus anchors/mentions and publishes it up to
 * the enclosing `InspectorProvider`.
 */
export function SessionInspectorBridge({
  anchors,
  mentions,
  persistedRows,
  sessionId = null
}: SessionInspectorBridgeProps): null {
  const inspector = useSessionInspector()
  const controls = useChatComposerControls()
  const messages = useAuiState((s) => s.thread.messages)

  const snapshot = useMemo(
    () => deriveSessionWorkspace({ messages, anchors, mentions }),
    [messages, anchors, mentions]
  )

  const usedTokens = useMemo(() => latestContextTokens(persistedRows), [persistedRows])
  const modelLimit = useMemo(() => {
    if (!controls?.model) return null
    const found = controls.availableModels.find(
      (m) => m.ref === controls.model || m.modelId === controls.model
    )
    return found?.contextWindow ?? null
  }, [controls])

  const contextUsage = useMemo(
    () => buildContextUsageView(usedTokens, modelLimit),
    [usedTokens, modelLimit]
  )

  const publishSnapshot = inspector?.publishSnapshot
  const publishContextUsage = inspector?.publishContextUsage
  const publishSessionId = inspector?.publishSessionId

  useEffect(() => {
    publishSnapshot?.(snapshot)
  }, [publishSnapshot, snapshot])

  useEffect(() => {
    publishContextUsage?.(contextUsage)
  }, [publishContextUsage, contextUsage])

  useEffect(() => {
    publishSessionId?.(sessionId)
  }, [publishSessionId, sessionId])

  return null
}
