import { useEffect, useMemo } from 'react'
import { useAui } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Send, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { QueuedInput } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

export function QueuedInputBar({
  enabled,
  gatewayBaseUrl,
  sessionId,
  approvalPendingExists
}: {
  enabled: boolean
  gatewayBaseUrl: string | null
  sessionId: number | null
  approvalPendingExists: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const aui = useAui()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const queryKey = useMemo(() => qk.chat.queuedInput(sessionId), [sessionId])
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await fetch(
        `${gatewayBaseUrl}/api/ai/queued-input?sessionId=${encodeURIComponent(String(sessionId))}`,
        { credentials: 'include' }
      )
      if (!response.ok) throw new Error('queued input fetch failed')
      const body = (await response.json()) as { items?: QueuedInput[] }
      return body.items ?? []
    },
    enabled: enabled && gatewayBaseUrl != null && sessionId != null,
    retry: false
  })

  useEffect(() => {
    if (!enabled || sessionId == null) return undefined
    const invalidate = (payload: { sessionId: number }): void => {
      if (payload.sessionId === sessionId) void queryClient.invalidateQueries({ queryKey })
    }
    const disposeQueued = mailApi.chat.onQueuedInputChanged?.(invalidate)
    const disposeTurn = mailApi.chat.onTurnPersisted?.((payload) => invalidate(payload))
    return () => {
      disposeQueued?.()
      disposeTurn?.()
    }
  }, [enabled, mailApi, queryClient, queryKey, sessionId])

  const mutate = useMutation({
    mutationFn: async ({ path, id }: { path: 'cancel' | 'send'; id: number }) => {
      const response = await fetch(`${gatewayBaseUrl}/api/ai/queued-input/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      if (!response.ok) throw new Error('queued input mutation failed')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey })
  })

  const items = query.data ?? []
  if (!enabled || items.length === 0) return null

  const statusText = (item: QueuedInput): string => {
    if (item.status === 'claimed') return t('chat.queuedInput.claimed')
    if (item.status === 'restored') return t('chat.queuedInput.restored')
    if (approvalPendingExists) return t('chat.queuedInput.afterApproval')
    return t('chat.queuedInput.queued')
  }

  return (
    <div className="mx-3 mb-2 ml-auto flex max-w-[88%] flex-col gap-1.5" data-testid="queued-input-bar">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-lg border border-[var(--hairline)] bg-ink-2 px-2.5 py-2 text-xs shadow-sm"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-ink-fg">{item.content}</p>
              <p className="mt-0.5 text-ink-fg-3">{statusText(item)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {(item.status === 'queued' || item.status === 'restored') && (
                <button
                  type="button"
                  aria-label={t('chat.queuedInput.edit')}
                  onClick={() => {
                    mutate.mutate({ path: 'cancel', id: item.id })
                    aui.composer().setText(item.content)
                  }}
                  className="rounded p-1 text-ink-fg-2 hover:bg-ink-3"
                >
                  <Pencil size={13} />
                </button>
              )}
              {item.status === 'restored' && (
                <button
                  type="button"
                  aria-label={t('chat.queuedInput.send')}
                  onClick={() => mutate.mutate({ path: 'send', id: item.id })}
                  className="rounded p-1 text-ink-fg-2 hover:bg-ink-3"
                >
                  <Send size={13} />
                </button>
              )}
              {(item.status === 'queued' || item.status === 'restored') && (
                <button
                  type="button"
                  aria-label={t('chat.queuedInput.delete')}
                  onClick={() => mutate.mutate({ path: 'cancel', id: item.id })}
                  className="rounded p-1 text-ink-fg-2 hover:bg-ink-3"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
