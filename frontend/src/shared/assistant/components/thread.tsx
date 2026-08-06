// chat-panel P4 Phase 01 — Thread shell (assistant-ui ThreadPrimitive).
//
// The viewport + message list + composer composition. Messages route to the
// MailAgent-token renderers (message.tsx). `pendingSlot` lets the panel inject
// the legacy ConfirmToolDialog fallback inside the scroll area, after the
// messages — exactly where the legacy MessageList renders it (bottom of stream,
// "the AI wants to run X, authorize"). `emptyState` shows when there are no
// messages. assistant-ui's Viewport owns auto-scroll, matching legacy behavior.

import { ThreadPrimitive } from '@assistant-ui/react'

import { ThreadComposer } from './composer'
import { ThreadReadOnlyContext } from './threadReadOnlyContext'
import { AssistantMessage, EditComposer, SystemMessage, UserMessage } from './message'

interface AssistantThreadProps {
  /** Rendered inside the viewport after the messages — the panel passes the
   *  pending-confirmation ConfirmToolDialog here so it scrolls with the stream. */
  pendingSlot?: React.ReactNode
  /** Shown by ThreadPrimitive.Empty when the thread has no messages. */
  emptyState?: React.ReactNode
  /** WP-14 — the composer-anchored run status bar (ThreadRunStatusBar). Rendered between the
   *  viewport and the composer, i.e. OUTSIDE the scroll area, so it stays put while the user
   *  scrolls the history. Self-gating (renders null when nothing is running) → omitting it is a
   *  byte-identical thread. */
  runStatusSlot?: React.ReactNode
  /** Phase 06a (cutover) — read-only mode for a retired-backend (notion-agent) session opened
   *  from history: render the prior messages but suppress the composer (no new turns on a
   *  retired agent). Default false keeps the live composer for the ai-sdk / custom-api paths. */
  readOnly?: boolean
}

const THREAD_MESSAGE_COMPONENTS = {
  UserMessage,
  AssistantMessage,
  EditComposer,
  SystemMessage
}

export function AssistantThread({
  pendingSlot,
  emptyState,
  runStatusSlot,
  readOnly = false
}: AssistantThreadProps): React.JSX.Element {
  return (
    // 0804 dogfood 1d — ThreadReadOnlyContext carries `readOnly` down to the per-message
    // FollowupSuggestions mounted inside AssistantMessage (message.tsx); the thread-level chip
    // row + its own `!readOnly &&` gate that used to live here are gone (see message.tsx).
    <ThreadReadOnlyContext.Provider value={readOnly}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col bg-ink-1 text-ink-fg">
        <ThreadPrimitive.Viewport className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Empty>{emptyState}</ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
          {pendingSlot}
          <ThreadPrimitive.If empty={false}>
            <div className="min-h-2 shrink-0" />
          </ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>
        {runStatusSlot}
        {!readOnly && <ThreadComposer />}
      </ThreadPrimitive.Root>
    </ThreadReadOnlyContext.Provider>
  )
}
