// chat-panel P4 Phase 01 — assistant-ui message renderers (MailAgent token skin).
//
// Adopts the Phase 00 spike paradigm (headless MessagePrimitive + MailAgent
// tokens): user bubble on --c-accent, assistant bubble on bg-ink-3 + hairline.
// The assistant bubble renders parts through `assistantPartComponents`
// (text → Streamdown, reasoning → collapsible, tool-call → ToolTraceCard).
// User messages flip into the EditComposer on edit; assistant messages carry a
// hover Copy/Reload action bar. Theme three-state + 6 accents reskin for free —
// only CSS variables drive color.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ComposerPrimitive, MessagePrimitive } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'

import { getAssistantPartComponents } from '../tools/registerToolUIs'
import { AssistantActionBar, UserActionBar } from './action-bar'

export function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="group mb-4 flex w-full flex-col items-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[rgb(var(--c-accent))] px-3.5 py-2 text-body leading-relaxed text-[rgb(var(--c-accent-fg))] shadow-sm">
        <MessagePrimitive.Parts />
      </div>
      <UserActionBar />
    </MessagePrimitive.Root>
  )
}

export function AssistantMessage(): React.JSX.Element {
  // Phase 04a — flag-aware part components (generic ToolTraceCard fallback always; A2UI
  // per-tool cards added as tools.by_name — rich cards always on since S3). Memoized
  // once per mount so the object reference stays stable across re-renders. flag-off → the
  // Phase 01 object verbatim.
  const partComponents = useMemo(() => getAssistantPartComponents(), [])
  return (
    <MessagePrimitive.Root className="group mb-4 flex w-full justify-start">
      <div className="min-w-0 max-w-[85%] space-y-1.5 rounded-2xl rounded-bl-md border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-body leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts components={partComponents} />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  )
}

export function SystemMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-3 flex w-full items-center justify-center gap-2 px-3">
      <div className="h-px flex-1 bg-ink-border-soft" />
      <div className="shrink-0 text-micro font-mono uppercase tracking-wider text-ink-fg-3">
        <MessagePrimitive.Parts />
      </div>
      <div className="h-px flex-1 bg-ink-border-soft" />
    </MessagePrimitive.Root>
  )
}

/** Rendered by assistant-ui when a user message is being edited (ActionBar Edit).
 *  Re-stream is wired through the adapter `onEdit` (legacy editMessage). */
export function EditComposer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ComposerPrimitive.Root className="mb-4 flex w-full flex-col gap-2 self-end rounded-2xl border border-[var(--hairline)] bg-ink-2 px-3 py-2.5">
      <ComposerPrimitive.Input
        className="scrollbar-thin max-h-40 w-full resize-none bg-transparent text-body leading-snug text-ink-fg outline-none"
        rows={3}
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <ComposerPrimitive.Cancel
          className={cn(
            'h-7 rounded px-3 text-aux',
            'border border-ink-border-soft bg-ink-2 text-ink-fg',
            'transition-colors duration-fast hover:bg-ink-3'
          )}
        >
          {t('chat.message.cancel')}
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send
          className={cn(
            'h-7 rounded px-3 text-aux font-medium',
            'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
            'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
          )}
        >
          {t('chat.message.save')}
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}
