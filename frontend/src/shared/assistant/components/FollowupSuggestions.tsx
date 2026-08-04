// chat UI 优化 W6 — follow-up suggestion chips, shared by BOTH chat surfaces.
//
// The suggestions come from the LAST assistant message's in-turn `suggest_followups` tool part
// (extraction single source: shared/assistant/followups.ts) — the old out-of-turn
// POST /api/ai/followups second generation is gone. Rendered as autoSend Suggestion chips above
// the composer (visual/interaction carried over verbatim from the former AgentThread chip row):
//   - hidden while the thread is running (stale chips never overlap a streaming reply);
//   - hidden when the model didn't call the tool, or the prompts cleaned to [] (graceful degrade —
//     no empty block, no error);
//   - autoSend routes through the thread runtime and honours the same sendDisabled fence as
//     Enter/Send (an approval decide → server resume holds the session's run lease; a send would
//     409) — codex r3 P2 rationale carried over.
//
// The null tool-part renderer (SuggestFollowupsHiddenPart) lives here too: registerToolUIs maps
// the suggest_followups tool part to it so the message stream shows NO tool card — the chip row
// is the tool's one visual manifestation.

import { useMemo } from 'react'
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { CornerDownRight } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { extractFollowupPrompts } from '../followups'
import { useChatComposerControls } from './composerControlsContext'

/** by_name renderer for the suggest_followups tool part — renders NOTHING (the chip row above the
 *  composer is the tool's UI; a silent no-op needs no trace card and never enters approval UI). */
export function SuggestFollowupsHiddenPart(): null {
  return null
}

/** The chip row. Renders null unless the thread is idle AND the last assistant message carries
 *  non-empty cleaned follow-up prompts. `className` styles the container when it renders (surface
 *  padding differs between the agent footer and the email panel). */
export function FollowupSuggestions({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const controls = useChatComposerControls()
  const sendDisabled = controls?.sendDisabled === true
  const isRunning = useAuiState((s) => s.thread.isRunning)
  // Select the LAST message only (stable reference between deltas of other state) and derive the
  // prompts via useMemo — extraction walks parts, so keep it out of the selector.
  const lastMessage = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1] ?? null)
  const prompts = useMemo(() => extractFollowupPrompts(lastMessage), [lastMessage])
  if (isRunning || prompts.length === 0) return null
  return (
    <div data-testid="followup-suggestions" className={cn('flex flex-wrap gap-2', className)}>
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
