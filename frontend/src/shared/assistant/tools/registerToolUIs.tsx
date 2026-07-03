// chat-panel P4 Phase 01 + 04a — message-part component registry for the assistant-ui shell.
// Single place that wires WHICH renderer handles WHICH assistant part:
//   text       → MarkdownText (Streamdown, reused from legacy)
//   reasoning  → ReasoningText (collapsible thinking, ChatMessage.thinking)
//   tool-call  → the A2UI ComponentRegistry's per-tool cards via `tools.by_name`, with
//                ToolTraceCard as the generic `tools.Fallback` — a tool with no registered
//                card still falls through to ToolTraceCard (registry miss never blocks).
//
// S3 — the MAILAGENT_A2UI_TOOL_CARDS flag was GA'd and removed: the rich cards are always
// mounted. No card component is DEFINED here (they live in their own files) so the module
// stays a thin config — react-refresh friendly.

import { MarkdownText, ReasoningText } from '../components/markdown-text'
import { SourcePart } from '../components/sources'
import { ToolTraceCard } from './generic/ToolTraceCard'
import { componentRegistry } from './ComponentRegistry'

/** The assistant message-part component map passed to MessagePrimitive.Parts `components`. */
type AssistantPartComponentMap = {
  Text: typeof MarkdownText
  Reasoning: typeof ReasoningText
  Source: typeof SourcePart
  tools: { Fallback: typeof ToolTraceCard; by_name: typeof componentRegistry.byName }
}

/** The part components: rich per-tool cards (by_name) + ToolTraceCard fallback. Keys not
 *  listed fall through to assistant-ui defaults (file/image already covered). */
export const assistantPartComponents: AssistantPartComponentMap = {
  Text: MarkdownText,
  Reasoning: ReasoningText,
  // dogfood-3 — render AI SDK source-url / source-document parts (web-search-style tools) as link pills.
  // Additive: a turn with no source parts renders nothing here (no visual change for the email surface).
  Source: SourcePart,
  tools: { by_name: componentRegistry.byName, Fallback: ToolTraceCard }
}

/** The part components for MessagePrimitive.Parts. Kept as a function for call-site
 *  stability (it was flag-aware pre-S3); now always returns the rich-card map. */
export function getAssistantPartComponents(): AssistantPartComponentMap {
  return assistantPartComponents
}
