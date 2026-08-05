// chat UI 优化 W6 — follow-up suggestion chips, shared by BOTH chat surfaces.
// chat-ui W4 (0804 dogfood 1d) — relocated from a THREAD-level row (above the composer) into a
// PER-MESSAGE component mounted inside AssistantMessage / AgentAssistantMessage, right after
// AssistantActionBar. Mounting inside the message (instead of reading the thread's last message
// from the top) means "isLast" now comes from THIS message's own `useMessage().isLast` — the row
// naturally disappears the instant a new message becomes last (next turn / new user send), with
// no separate teardown logic needed.
//
// The suggestions come from THIS message's in-turn `suggest_followups` tool part (extraction
// single source: shared/assistant/followups.ts) — the old out-of-turn POST /api/ai/followups
// second generation is gone, and W6's thread-level extraction is gone too. Rendered as autoSend
// Suggestion chips (visual/interaction carried over verbatim from the former thread-level row):
//   - mounted only when: this is the LAST message, the thread is idle (not streaming), the
//     surface isn't readOnly (ThreadReadOnlyContext — record view / retired-backend history),
//     and the cleaned prompts are non-empty (graceful degrade — no empty block, no error);
//   - once mounted, fades in via the SAME 380ms reveal gate as AssistantActionBar
//     (useCompletionReveal, completionReveal.ts) — one shared animation, not a second one;
//   - autoSend routes through the thread runtime and honours the same sendDisabled fence as
//     Enter/Send (an approval decide → server resume holds the session's run lease; a send would
//     409) — codex r3 P2 rationale carried over.
//
// The null tool-part renderer (SuggestFollowupsHiddenPart) lives here too: registerToolUIs maps
// the suggest_followups tool part to it so the message stream shows NO tool card — the chip row
// is the tool's one visual manifestation.

import { useMemo } from 'react'
import { ThreadPrimitive, useAuiState, useMessage } from '@assistant-ui/react'
import { CornerDownRight } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { extractFollowupPrompts } from '../followups'
import { useChatComposerControls } from './composerControlsContext'
import { useCompletionReveal } from './completionReveal'
import { useThreadReadOnly } from './threadReadOnlyContext'

/** by_name renderer for the suggest_followups tool part — renders NOTHING (the chip row after the
 *  message's action bar is the tool's UI; a silent no-op needs no trace card and never enters
 *  approval UI). */
export function SuggestFollowupsHiddenPart(): null {
  return null
}

/** The chip row, mounted inside an assistant message (a sibling of AssistantActionBar). Renders
 *  null unless: the surface is writable (not readOnly), THIS message is the last one, the thread
 *  is idle, and this message's suggest_followups tool part cleans to a non-empty prompt list.
 *  `className` styles the container when it renders (layout differs between the agent footer row
 *  and the email bubble). */
export function FollowupSuggestions({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const controls = useChatComposerControls()
  const sendDisabled = controls?.sendDisabled === true
  const readOnly = useThreadReadOnly()
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const revealed = useCompletionReveal()
  const message = useMessage()
  const prompts = useMemo(() => extractFollowupPrompts(message), [message])
  if (readOnly || !message.isLast || isRunning || prompts.length === 0) return null
  return (
    <div
      data-testid="followup-suggestions"
      className={cn(
        'flex flex-wrap gap-2 transition-opacity duration-slow motion-reduce:transition-none',
        revealed ? 'opacity-100' : 'opacity-0 pointer-events-none',
        className
      )}
    >
      {prompts.map((fu, i) => (
        <ThreadPrimitive.Suggestion
          key={`${i}-${fu}`}
          prompt={fu}
          autoSend
          disabled={sendDisabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-ink-border-soft bg-ink-2 px-3 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3',
            sendDisabled && 'cursor-not-allowed opacity-50'
          )}
        >
          <CornerDownRight size={13} strokeWidth={1.75} className="shrink-0 text-coral" />
          {fu}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  )
}
