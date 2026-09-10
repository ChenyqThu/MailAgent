import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, MoreHorizontal } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, useToastStore } from '@shared/state/toast'
import { Popmenu } from '@shared/components/ui/Popmenu'
import { TodaySectionRow } from './TodaySectionRow'
import type { TodaySectionItem } from './todaySections'

export function TodayReplyThreadRow({
  item,
  onOpen
}: {
  item: TodaySectionItem
  onOpen(item: TodaySectionItem): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const client = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const messages = item.reply?.messages ?? []
  const ids = item.reply?.internalIds ?? (item.link.kind === 'mail' ? [item.link.internalId] : [])
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: qk.today.all() })
  const dismiss = useMutation({
    mutationFn: (snapshot: number[]) => api.today.dismiss(snapshot),
    onSuccess: ({ operationId }) => {
      void refresh()
      useToastStore.getState().push({
        title: t('today.replyDismissed'),
        ttlMs: 10000,
        action: {
          label: t('today.replyUndo'),
          onClick: () => {
            void api.today
              .undo(operationId)
              .then(refresh)
              .catch((err: unknown) => {
                toastError(t('today.replyActionFailed'), errorMessage(err))
              })
          }
        }
      })
    },
    onError: (err) => toastError(t('today.replyActionFailed'), errorMessage(err))
  })
  return (
    <div data-testid="today-reply-thread" className="mb-2">
      <TodaySectionRow item={item} onOpen={onOpen} />
      <div className="relative -mt-1 flex items-center gap-2 px-3 pb-1 text-micro text-ink-fg-3">
        {messages.length > 1 && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 rounded px-1 py-1 hover:bg-ink-3"
          >
            <ChevronRight size={12} className={expanded ? 'rotate-90' : ''} />
            {t('today.replyMessageCount', { count: messages.length })}
          </button>
        )}
        <button
          ref={menuRef}
          type="button"
          aria-label={t('today.replyActions')}
          disabled={dismiss.isPending}
          onClick={() => setMenuOpen(!menuOpen)}
          className="ml-auto rounded px-1 py-1 hover:bg-ink-3"
        >
          <MoreHorizontal size={14} />
        </button>
        <Popmenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          ariaLabel={t('today.replyActions')}
          triggerRef={menuRef}
          portal
          align="end"
          items={[
            {
              kind: 'action',
              id: 'dismiss',
              label: t('today.replyDismiss', { count: ids.length }),
              disabled: dismiss.isPending,
              onSelect: () => dismiss.mutate([...ids])
            }
          ]}
        />
      </div>
      {expanded &&
        messages.map((message) => (
          <div
            key={message.id}
            className="ml-6 flex items-center gap-2 border-l border-ink-border px-3 py-1.5 text-meta"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-ink-fg-2"
              onClick={() =>
                onOpen({ ...item, id: message.id, title: message.title, link: message.link })
              }
            >
              {message.meta} · {message.title}
            </button>
            <button
              type="button"
              disabled={dismiss.isPending}
              className="shrink-0 text-micro text-ink-fg-3 hover:text-ink-fg"
              onClick={() => dismiss.mutate([message.link.internalId])}
            >
              {t('today.replyDismissOne')}
            </button>
          </div>
        ))}
    </div>
  )
}
