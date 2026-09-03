import { useEffect, useMemo } from 'react'
import { useAui } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Send, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { QueuedInput } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

/** Queued (not yet sent) follow-ups, rendered at the END of the message stream as user bubbles in a
 *  waiting state (task 09-02). Not real message rows — the dispatcher still merges them into one
 *  `<queued_followups>` envelope; once that envelope persists, the rows are `sent` and drop out of
 *  the list. `dispatchedRowIds` closes the reload window in between (messages reloaded before the
 *  queue refetched → the same text would show twice). "Insert now" stops the current run and sends
 *  exactly this row (`POST /api/ai/queued-input/interrupt`); it is disabled while an approval is
 *  pending — there is no run to abort, and queued text never stands in for a decision. */
export function QueuedInputBar({
  enabled,
  gatewayBaseUrl,
  sessionId,
  approvalPendingExists,
  dispatchedRowIds
}: {
  enabled: boolean
  gatewayBaseUrl: string | null
  sessionId: number | null
  approvalPendingExists: boolean
  /** Row ids already carried by a persisted `<queued_followups>` message (metadata rowIds). */
  dispatchedRowIds?: ReadonlySet<number>
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
    mutationFn: async ({ path, id }: { path: 'cancel' | 'send' | 'interrupt'; id: number }) => {
      const response = await fetch(`${gatewayBaseUrl}/api/ai/queued-input/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      if (!response.ok) throw new Error('queued input mutation failed')
    },
    onSuccess: (_result, { path }) => {
      void queryClient.invalidateQueries({ queryKey })
      // The interrupt run starts server-side (loopback) — re-probe /run/active the same way the
      // turn-persisted handler does so the background-run placeholder shows without waiting for
      // the poll. Prefix key: every nonce'd instance.
      if (path === 'interrupt') {
        void queryClient.invalidateQueries({
          queryKey: qk.aiGateway.runActive(gatewayBaseUrl, sessionId, 0).slice(0, 4)
        })
      }
    }
  })

  const items = (query.data ?? []).filter((item) => !dispatchedRowIds?.has(item.id))
  if (!enabled || items.length === 0) return null

  const statusText = (item: QueuedInput): string => {
    if (item.status === 'claimed') return t('chat.queuedInput.claimed')
    if (item.status === 'restored') return t('chat.queuedInput.restored')
    if (approvalPendingExists) return t('chat.queuedInput.afterApproval')
    return t('chat.queuedInput.queued')
  }

  return (
    <div className="flex w-full flex-col" data-testid="queued-input-bar">
      {items.map((item) => {
        const editable = item.status === 'queued' || item.status === 'restored'
        return (
          <div key={item.id} className="mb-4 flex w-full flex-col items-end">
            {/* Same bubble as message.tsx UserMessage — the row IS the user's message, just not sent yet. */}
            <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[rgb(var(--c-accent))] px-3.5 py-2 text-body leading-relaxed text-[rgb(var(--c-accent-fg))] shadow-sm [overflow-wrap:anywhere]">
              <p className="whitespace-pre-wrap">{item.content}</p>
            </div>
            <div className="mt-1 flex items-center gap-1 text-micro text-ink-fg-3">
              <span className="mr-1">{statusText(item)}</span>
              {editable && (
                <button
                  type="button"
                  disabled={approvalPendingExists}
                  title={approvalPendingExists ? t('chat.queuedInput.interruptBlocked') : undefined}
                  onClick={() => mutate.mutate({ path: 'interrupt', id: item.id })}
                  className="rounded px-1.5 py-0.5 text-ink-fg-2 hover:bg-ink-3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  {t('chat.queuedInput.interrupt')}
                </button>
              )}
              {editable && (
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
              {editable && (
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
        )
      })}
    </div>
  )
}
