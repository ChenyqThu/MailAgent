// MailAgent agent-view message renderers — demo-fidelity layout (chat-panel demo parity).
//
// Demo paradigm, distinct from the email panel's bubble pair (assistant/components/message.tsx):
//   - Assistant: bubble-LESS, full-width prose centered in a 44rem column (reads better for long
//     agent replies + tool cards) with a hover Copy/Reload action bar in a height-reserved footer
//     (-mb / min-h prevents the layout jumping when the bar fades in). Parts reuse
//     getAssistantPartComponents() (text → Streamdown, reasoning → collapsible, tools → ToolTraceCard
//     + A2UI by_name) PLUS a working indicator on the Empty slot — a shimmer line while a streamed
//     reply has no content yet (the "thinking" moment before the first token).
//   - User: right-aligned subtle bubble (bg-ink-3), demo-neutral (not the accent fill).
// EditComposer / SystemMessage reuse the shared renderers (no demo-specific layout needed in Phase 7).
// Independent from the right pane: the runtime is provider-based (no singleton), so these render
// safely inside the same AssistantRuntimeProvider that AgentConversation mounts.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { MessagePrimitive } from '@assistant-ui/react'

import { ShimmerText } from '@shared/components/ShimmerText'
import { getAssistantPartComponents } from '@shared/assistant/tools/registerToolUIs'
import { AssistantActionBar, UserActionBar } from '@shared/assistant/components/action-bar'

// Reuse the shared edit/system renderers verbatim — no demo-specific treatment in Phase 7.
export { EditComposer, SystemMessage } from '@shared/assistant/components/message'

/** Working indicator — assistant-ui renders the Empty part slot while a (streaming) assistant message
 *  has no content yet. A shimmering "thinking" line covers the pre-first-token moment; once a part
 *  streams in, Empty is replaced by the real content. */
function AgentWorkingIndicator(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <ShimmerText text={t('agentView.thinking')} neutral className="text-meta" />
    </span>
  )
}

export function AgentUserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col items-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-body leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts />
      </div>
      <UserActionBar />
    </MessagePrimitive.Root>
  )
}

export function AgentAssistantMessage(): React.JSX.Element {
  // flag-aware part components (generic ToolTraceCard always; A2UI by_name when MAILAGENT_A2UI_TOOL_CARDS
  // is on) + a working-indicator Empty slot. Memoized once per mount so the reference stays stable.
  const partComponents = useMemo(
    () => ({ ...getAssistantPartComponents(), Empty: AgentWorkingIndicator }),
    []
  )
  return (
    <MessagePrimitive.Root className="group relative mx-auto w-full max-w-[var(--thread-max-width)]">
      <div className="min-w-0 px-1 text-body leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts components={partComponents} />
      </div>
      {/* Height-reserved footer so the hover action bar never shifts message spacing (demo idiom). */}
      <div className="-mb-7 ml-1 min-h-7 pt-1.5">
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  )
}
