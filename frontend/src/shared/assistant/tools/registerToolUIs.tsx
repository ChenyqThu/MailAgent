// chat-panel P4 Phase 01 — message-part component registry for the assistant-ui
// shell. Single place that wires WHICH renderer handles WHICH assistant part:
//   text       → MarkdownText (Streamdown, reused from legacy)
//   reasoning  → ReasoningText (collapsible thinking, ChatMessage.thinking)
//   tool-call  → ToolTraceCard via the generic `tools.Fallback` slot
//
// Phase 01 ships only the generic tool fallback; per-tool A2UI cards
// (makeAssistantToolUI / ComponentRegistry) arrive in phase-04. The object is
// passed verbatim to MessagePrimitive.Parts `components` in message.tsx. No
// component is DEFINED here (they live in their own files) so the module stays a
// pure config export — react-refresh friendly.

import { MarkdownText, ReasoningText } from '../components/markdown-text'
import { ToolTraceCard } from './generic/ToolTraceCard'

/** Passed to MessagePrimitive.Parts `components`. Keys not listed fall through to
 *  assistant-ui defaults (file/image already covered by defaults). */
export const assistantPartComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningText,
  tools: { Fallback: ToolTraceCard }
}
