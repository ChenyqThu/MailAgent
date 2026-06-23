// chat-panel P4 Phase 01 — message action bars (assistant-ui ActionBarPrimitive).
//
// AssistantActionBar: Copy + Reload (regenerate). Copy rides the runtime's
// `unstable_capabilities.copy`; Reload calls the adapter `onReload` (legacy
// retryLast for the email surface). UserActionBar: Edit → flips the message into
// the EditComposer (message.tsx) which re-streams via the adapter `onEdit`.
// MailAgent tokens only; hover-revealed to stay quiet (legacy idiom).

import { useTranslation } from 'react-i18next'
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { ActionBarPrimitive, MessagePrimitive } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'

const ACTION_BTN = cn(
  'inline-flex h-6 w-6 items-center justify-center rounded p-1',
  'text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg',
  'disabled:opacity-40 disabled:hover:bg-transparent'
)

export function AssistantActionBar(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="flex items-center gap-1 pt-1 text-ink-fg-2"
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
    </ActionBarPrimitive.Root>
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
