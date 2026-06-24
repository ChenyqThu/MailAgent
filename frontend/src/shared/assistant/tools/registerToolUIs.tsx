// chat-panel P4 Phase 01 + 04a — message-part component registry for the assistant-ui shell.
// Single place that wires WHICH renderer handles WHICH assistant part:
//   text       → MarkdownText (Streamdown, reused from legacy)
//   reasoning  → ReasoningText (collapsible thinking, ChatMessage.thinking)
//   tool-call  → ToolTraceCard via the generic `tools.Fallback` slot (Phase 01), PLUS the
//                A2UI ComponentRegistry's per-tool cards via `tools.by_name` when
//                MAILAGENT_A2UI_TOOL_CARDS is on (Phase 04a). A tool with no registered card
//                still falls through to ToolTraceCard (registry miss never blocks).
//
// flag-off (default): `assistantPartComponents` is byte-identical to Phase 01 (generic
// fallback only). flag-on: getAssistantPartComponents() adds `tools.by_name` from the
// componentRegistry. No card component is DEFINED here (they live in their own files) so the
// module stays a thin config — react-refresh friendly.

import { isA2uiToolCardsEnabled } from '../runtime/flags'
import { MarkdownText, ReasoningText } from '../components/markdown-text'
import { ToolTraceCard } from './generic/ToolTraceCard'
import { componentRegistry } from './ComponentRegistry'

/** Phase 01 baseline — generic tool fallback only. Kept as the flag-off object (and for any
 *  importer that wants the legacy shape). Passed to MessagePrimitive.Parts `components`.
 *  Keys not listed fall through to assistant-ui defaults (file/image already covered). */
export const assistantPartComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningText,
  tools: { Fallback: ToolTraceCard }
}

/** Phase 04a — the flag-aware part components for MessagePrimitive.Parts. flag-off returns the
 *  Phase 01 object verbatim (byte-identical: generic fallback only). flag-on adds the A2UI
 *  registry's per-tool cards as `tools.by_name`, keeping ToolTraceCard as the fallback so any
 *  unregistered tool still renders (registry miss never blocks the conversation). Evaluated at
 *  call time so the renderer flag (build-time constant) and tests (vi.stubEnv) both work. */
export function getAssistantPartComponents() {
  if (!isA2uiToolCardsEnabled()) return assistantPartComponents
  return {
    Text: MarkdownText,
    Reasoning: ReasoningText,
    tools: { by_name: componentRegistry.byName, Fallback: ToolTraceCard }
  }
}
