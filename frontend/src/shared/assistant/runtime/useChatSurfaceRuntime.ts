// Shared runtime surface hooks for AiChatPanel and AgentConversation:
// gateway /health probe + queued-input / pending-approval convergence.

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import type { QueuedInput } from '@shared/api/types'
import { fetchPendingApproval } from '@shared/assistant/approvalRecordClient'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import { type QueuedInputRowsState, useQueuedInputRows } from './useQueuedInputRows'

export interface GatewayHealthProbeState {
  healthQ: UseQueryResult<{ status?: string }>
  gatewayDegraded: boolean
}

export function useGatewayHealthProbe(opts: {
  gatewayBaseUrl: string | null
  aiSdkEnabled: boolean
}): GatewayHealthProbeState {
  const { gatewayBaseUrl, aiSdkEnabled } = opts
  const healthQ = useQuery({
    queryKey: qk.aiGateway.health(gatewayBaseUrl),
    queryFn: async () => {
      const res = await fetch(`${gatewayBaseUrl}/health`)
      if (!res.ok) throw new Error('ai-gateway unhealthy')
      const body = (await res.json()) as { status?: string }
      if (body.status !== 'ok') throw new Error('ai-gateway unhealthy')
      return body
    },
    enabled: gatewayBaseUrl !== null,
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  })
  return {
    healthQ,
    gatewayDegraded: aiSdkEnabled && healthQ.isError
  }
}

export interface ChatQueuedInputSurfaceState {
  approvalPendingExists: boolean
  queuedRows: QueuedInputRowsState
  queueModeActive: boolean
  onEnqueueQueuedInput: (content: string) => void
}

export function useChatQueuedInput(opts: {
  queuedInputEnabled: boolean
  gatewayBaseUrl: string | null
  sessionId: number | null
  aiSdkRunning: boolean
  backgroundActive: boolean
}): ChatQueuedInputSurfaceState {
  const { queuedInputEnabled, gatewayBaseUrl, sessionId, aiSdkRunning, backgroundActive } = opts
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const pendingApprovalTruth = useQuery({
    queryKey: qk.agentApprovalPending(sessionId),
    queryFn: () => (sessionId == null ? Promise.resolve(null) : fetchPendingApproval(sessionId)),
    enabled: queuedInputEnabled && sessionId != null,
    staleTime: 3_000,
    refetchOnWindowFocus: true
  })
  const approvalPendingExists = pendingApprovalTruth.data != null

  // Immediate truth before /run/active probe catches up on queued-input dispatch.
  const queuedRows = useQueuedInputRows({
    enabled: queuedInputEnabled,
    gatewayBaseUrl,
    sessionId
  })

  const queueModeActive =
    queuedInputEnabled &&
    sessionId != null &&
    (aiSdkRunning || backgroundActive || approvalPendingExists || queuedRows.dispatchInFlight)

  const onEnqueueQueuedInput = useCallback(
    (content: string): void => {
      if (gatewayBaseUrl == null || sessionId == null) return
      void fetch(`${gatewayBaseUrl}/api/ai/queued-input`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, content })
      })
        .then(async (response) => {
          const body = (await response.json()) as { error?: string; item?: QueuedInput }
          if (!response.ok) throw new Error(body?.error ?? 'enqueue failed')
          const queryKey = qk.chat.queuedInput(sessionId)
          if (body.item) {
            const item = body.item
            queryClient.setQueryData<QueuedInput[]>(queryKey, (old = []) =>
              old.some((row) => row.id === item.id) ? old : [...old, item]
            )
          }
          await queryClient.invalidateQueries({ queryKey })
        })
        .catch((error: unknown) =>
          toastError(t('chat.queuedInput.enqueueFailed'), errorMessage(error))
        )
    },
    [gatewayBaseUrl, queryClient, sessionId, t]
  )

  return {
    approvalPendingExists,
    queuedRows,
    queueModeActive,
    onEnqueueQueuedInput
  }
}
