// chat-panel P4 Phase 01 — message action bars (assistant-ui ActionBarPrimitive).
//
// AssistantActionBar: Copy + Reload (regenerate). Copy rides the runtime's
// `unstable_capabilities.copy`; Reload calls the adapter `onReload` (legacy
// retryLast for the email surface). UserActionBar: Edit → flips the message into
// the EditComposer (message.tsx) which re-streams via the adapter `onEdit`.
// MailAgent tokens only; hover-revealed to stay quiet (legacy idiom).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookmarkPlus, Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { ActionBarPrimitive, MessagePrimitive, useMessage } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'

// composer-parity C1-③ — module-level kosAvailable cache: ONE IPC per session shared by every
// assistant message's KosSaveButton (parity with the legacy MessageList _kosAvailablePromise). Using
// a plain promise + useState (not react-query) keeps the action bar provider-free, so message-render
// tests don't need a QueryClientProvider. A failed probe resolves false (KOS-down hides the button).
let _kosAvailablePromise: Promise<boolean> | null = null
function fetchKosAvailable(mailApi: ReturnType<typeof useMailApi>): Promise<boolean> {
  if (!_kosAvailablePromise) {
    _kosAvailablePromise = mailApi.chat.kosAvailable().catch(() => false)
  }
  return _kosAvailablePromise
}
function useKosAvailable(mailApi: ReturnType<typeof useMailApi>): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void fetchKosAvailable(mailApi).then((v) => {
      if (!cancelled) setAvailable(v)
    })
    return (): void => {
      cancelled = true
    }
  }, [mailApi])
  return available
}

const ACTION_BTN = cn(
  'inline-flex h-6 w-6 items-center justify-center rounded p-1',
  'text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg',
  'disabled:opacity-40 disabled:hover:bg-transparent'
)

export function AssistantActionBar({
  className,
  inlineOnHover = false
}: {
  className?: string
  /** dogfood round-5 — agent view renders the bar INLINE on hover (the demo idiom): a non-last
   *  message's bar occupies a reserved row, hidden by default, revealed on hover with the SAME inline
   *  style as the last message's — NO floating pill (border + shadow). Setting this drops
   *  `autohideFloat`, so the non-last hover status resolves to "normal" (inline) instead of "floating".
   *  The email panel omits it → autohideFloat='single-branch' stays (byte-identical to before). */
  inlineOnHover?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      {...(inlineOnHover ? {} : { autohideFloat: 'single-branch' as const })}
      className={cn('flex items-center gap-1 pt-1 text-ink-fg-2', className)}
    >
      <ActionBarPrimitive.Copy
        className={ACTION_BTN}
        aria-label={t('chat.messageActions.copy', { defaultValue: 'Copy' })}
      >
        <MessagePrimitive.If copied>
          <Check size={13} strokeWidth={2} className="text-ok" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <Copy size={13} strokeWidth={2} />
        </MessagePrimitive.If>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload
        className={ACTION_BTN}
        aria-label={t('chat.draftReply.regenerate', { defaultValue: 'Regenerate' })}
      >
        <RotateCcw size={13} strokeWidth={2} />
      </ActionBarPrimitive.Reload>
      <KosSaveButton />
    </ActionBarPrimitive.Root>
  )
}

/** composer-parity C1-③ — "save this assistant reply to KOS" action (parity with the legacy
 *  AssistantMessageFooter). Visible only when (a) KOS is configured (kosAvailable) and (b) the
 *  message has a PERSISTED chat_db id — reload stamps String(row.id), so an existing/historical
 *  assistant message is saveable; a freshly streamed turn carries the ai-sdk 'asst-…' id (non-numeric)
 *  and becomes saveable only after the session reloads (its row id lands). saveToKos summarizes + writes
 *  a KOS page; failures surface as a toast (KOS-down is non-fatal, never auto-retries). Same button for
 *  the legacy ExternalStore path (its messages already carry the numeric chat_db id). */
function KosSaveButton(): React.JSX.Element | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const message = useMessage()
  const kosAvailable = useKosAvailable(mailApi)
  const numericId = /^\d+$/.test(message.id) ? Number.parseInt(message.id, 10) : null
  if (message.role !== 'assistant' || numericId === null || !kosAvailable) return null
  const onSave = async (): Promise<void> => {
    try {
      await mailApi.chat.saveToKos({ messageId: numericId })
      toastSuccess(t('chat.kos.saved', { defaultValue: 'Saved to KOS' }))
    } catch {
      toastError(t('chat.kos.saveFailed', { defaultValue: 'Save to KOS failed' }))
    }
  }
  return (
    <button
      type="button"
      onClick={() => void onSave()}
      className={ACTION_BTN}
      aria-label={t('chat.kos.save', { defaultValue: 'Save to KOS' })}
      title={t('chat.kos.save', { defaultValue: 'Save to KOS' })}
    >
      <BookmarkPlus size={13} strokeWidth={2} />
    </button>
  )
}

export function UserActionBar(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="mt-1 flex items-center justify-end"
    >
      <ActionBarPrimitive.Edit
        className={ACTION_BTN}
        aria-label={t('chat.message.edit', { defaultValue: 'Edit' })}
      >
        <Pencil size={13} strokeWidth={2} />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  )
}
